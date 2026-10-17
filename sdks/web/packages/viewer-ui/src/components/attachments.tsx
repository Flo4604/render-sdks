// 07 Sticker slot editor, 08 StatTrak toggle, 09 charm picker row and 10 rig
// switch. Adding or removing an attachment loads another closure; placement
// and the counter value bind live.

import { type KeyboardEvent, useEffect, useState } from "react";

import type { StickerPlacement } from "../capabilities.ts";
import type { RegionProps } from "../regions.ts";
import { MiniSlider } from "./mini-slider.tsx";
import { PlusIcon } from "./icons.tsx";

function signed(value: number, digits: number, unit = ""): string {
  const text = value.toFixed(digits);

  return `${value > 0 ? "+" : ""}${text}${unit}`;
}

function stickerName(props: RegionProps, id: number): string {
  return props.ui.catalog?.stickers.find((entry) => entry.id === id)?.name ?? `Sticker ${id}`;
}

function stickerThumb(props: RegionProps, id: number): string | undefined {
  return props.ui.catalog?.stickers.find((entry) => entry.id === id)?.thumbnail;
}

export function StickerEditor(props: RegionProps & { helper?: string }) {
  const { state, actions, controls, ui, display } = props;
  const slots = display.stickerSlots ?? 5;
  const [selected, setSelected] = useState<number | undefined>(undefined);
  const bySlot = new Map(state.stickers.map((sticker) => [sticker.slot, sticker]));
  const current = selected === undefined ? undefined : bySlot.get(selected);
  const disabled = controls.readOnly || state.status !== "ready" || state.reloading;

  useEffect(() => {
    if (selected !== undefined && !bySlot.has(selected)) {
      setSelected(undefined);
    }
  }, [selected, state.stickers]);

  const choose = (slot: number) => {
    if (bySlot.has(slot)) {
      setSelected(selected === slot ? undefined : slot);

      return;
    }

    if (!disabled) {
      ui.openPicker("sticker", slot);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>, slot: number) => {
    const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;

    if (step !== 0) {
      event.preventDefault();
      const buttons =
        event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>("button.mv-slot");
      buttons?.[(slot + step + slots) % slots]?.focus();

      return;
    }

    if ((event.key === "Delete" || event.key === "Backspace") && bySlot.has(slot) && !disabled) {
      event.preventDefault();
      actions.removeSticker(slot);
    }
  };

  return (
    <div className="mv-stickers" part="stickers">
      <div className="mv-slots" role="listbox" aria-label="Sticker slots">
        {Array.from({ length: slots }, (_, slot) => {
          const sticker = bySlot.get(slot);
          const thumb = sticker === undefined ? undefined : stickerThumb(props, sticker.id);

          return (
            <button
              key={slot}
              type="button"
              role="option"
              className="mv-slot"
              data-filled={sticker !== undefined}
              aria-selected={selected === slot}
              aria-label={
                sticker === undefined
                  ? `Slot ${slot + 1}, empty`
                  : `Slot ${slot + 1}, ${stickerName(props, sticker.id)}`
              }
              disabled={sticker === undefined && disabled}
              onClick={() => choose(slot)}
              onKeyDown={(event) =>
                onKeyDown(event as unknown as KeyboardEvent<HTMLDivElement>, slot)
              }
            >
              {sticker === undefined ? (
                <PlusIcon />
              ) : thumb === undefined ? (
                <span className="mv-slot-id mv-mono">{sticker.id}</span>
              ) : (
                <img src={thumb} alt="" />
              )}
            </button>
          );
        })}
      </div>
      {current === undefined ? (
        <span className="mv-caption">
          {props.helper ?? "Select a sticker to adjust it, or an empty slot to add one."}
        </span>
      ) : (
        <StickerCard {...props} sticker={current} disabled={disabled} />
      )}
    </div>
  );
}

function StickerCard(props: RegionProps & { sticker: StickerPlacement; disabled: boolean }) {
  const { sticker, actions, disabled } = props;
  const offset = sticker.offset ?? [0, 0];

  return (
    <div className="mv-sticker-card">
      <div className="mv-sticker-card-head">
        <div className="mv-stack-2">
          <span className="mv-row-title">{stickerName(props, sticker.id)}</span>
          <span className="mv-row-sub">Slot {sticker.slot + 1}</span>
        </div>
        <button
          type="button"
          className="mv-text-button"
          data-tone="muted"
          disabled={disabled}
          onClick={() => actions.removeSticker(sticker.slot)}
        >
          Remove
        </button>
      </div>
      <MiniSlider
        label="Wear"
        value={sticker.wear ?? 0}
        min={0}
        max={1}
        step={0.01}
        format={(value) => value.toFixed(2)}
        disabled={disabled}
        onChange={(value) => actions.editSticker(sticker.slot, { wear: value })}
      />
      <MiniSlider
        label="Rotation"
        value={sticker.rotation ?? 0}
        min={-180}
        max={180}
        step={1}
        bipolar
        format={(value) => signed(value, 0, "°")}
        disabled={disabled}
        onChange={(value) => actions.editSticker(sticker.slot, { rotation: value })}
      />
      <MiniSlider
        label="Offset X"
        value={offset[0]}
        min={-1}
        max={1}
        step={0.001}
        bipolar
        format={(value) => signed(value, 3)}
        disabled={disabled}
        onChange={(value) => actions.editSticker(sticker.slot, { offset: [value, offset[1]] })}
      />
      <MiniSlider
        label="Offset Y"
        value={offset[1]}
        min={-1}
        max={1}
        step={0.001}
        bipolar
        format={(value) => signed(value, 3)}
        disabled={disabled}
        onChange={(value) => actions.editSticker(sticker.slot, { offset: [offset[0], value] })}
      />
    </div>
  );
}

export function Switch(props: {
  checked: boolean;
  label: string;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      className="mv-switch"
      aria-checked={props.checked}
      aria-label={props.label}
      disabled={props.disabled}
      onClick={() => props.onChange(!props.checked)}
    >
      <i />
    </button>
  );
}

const counterMax = 999999;

export function StatTrakToggle(props: RegionProps & { inline?: boolean }) {
  const { state, actions, controls } = props;
  const on = state.statTrak !== null;
  const [typed, setTyped] = useState<string | undefined>(undefined);
  const disabled = controls.readOnly || state.status !== "ready" || state.reloading;
  const counter = String(state.statTrak ?? 0).padStart(6, "0");
  const commit = () => {
    if (typed === undefined) {
      return;
    }

    const value = Number(typed);
    setTyped(undefined);

    if (Number.isInteger(value) && value >= 0 && value <= counterMax) {
      actions.setStatTrak(value);
    }
  };

  const field = on ? (
    <label className="mv-counter">
      <input
        className="mv-mono"
        inputMode="numeric"
        aria-label="Kill count"
        disabled={disabled}
        value={typed ?? counter}
        onChange={(event) => setTyped(event.target.value.replace(/\D/g, "").slice(0, 6))}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            commit();
          }
        }}
      />
      {props.inline === true ? null : <span>kills · max 999999</span>}
    </label>
  ) : null;

  return (
    <div className="mv-stattrak" part="stattrak" data-inline={props.inline === true}>
      <div className="mv-row">
        <div className="mv-stack-2">
          <span className="mv-stattrak-tag">StatTrak™</span>
          {props.inline === true ? null : (
            <span className="mv-row-sub">{on ? "Kill counter on the receiver" : "Off"}</span>
          )}
        </div>
        {props.inline === true ? field : null}
        <Switch
          checked={on}
          label="StatTrak"
          disabled={disabled}
          onChange={(checked) => actions.setStatTrak(checked ? 0 : null)}
        />
      </div>
      {props.inline === true ? null : field}
    </div>
  );
}

export function CharmRow(props: RegionProps) {
  const { state, actions, controls, ui } = props;
  const disabled = controls.readOnly || state.status !== "ready" || state.reloading;
  const charm = state.charm;

  if (charm === null) {
    return (
      <div className="mv-row mv-charm" part="charm">
        <div className="mv-stack-2">
          <span className="mv-row-title">Charm</span>
          <span className="mv-row-sub">No charm</span>
        </div>
        <button
          type="button"
          className="mv-small-button"
          data-control="add-charm"
          disabled={disabled || ui.catalog === undefined}
          onClick={() => ui.openPicker("charm")}
        >
          <PlusIcon size={14} />
          Add charm
        </button>
      </div>
    );
  }

  const entry = ui.catalog?.charms.find((candidate) => candidate.id === charm.id);

  return (
    <div className="mv-row mv-charm" part="charm">
      <div className="mv-charm-thumb">
        {entry?.thumbnail === undefined ? null : <img src={entry.thumbnail} alt="" />}
      </div>
      <div className="mv-stack-2 mv-grow">
        <span className="mv-row-title">{entry?.name ?? `Charm ${charm.id}`}</span>
        <span className="mv-row-sub mv-mono">Pattern {charm.pattern}</span>
      </div>
      <button
        type="button"
        className="mv-text-button"
        disabled={disabled || ui.catalog === undefined}
        onClick={() => ui.openPicker("charm")}
      >
        Change
      </button>
      <button
        type="button"
        className="mv-text-button"
        data-tone="muted"
        disabled={disabled}
        onClick={() => actions.setCharm(null)}
      >
        Remove
      </button>
    </div>
  );
}

const rigs = [
  {
    id: "production",
    label: "Production",
    helper: "Medalbot studio rig, as used for listing images.",
  },
  { id: "csfloat-fit", label: "CSFloat fit", helper: "Lighting fitted to CSFloat’s screenshots." },
] as const;

export function RigSwitch(props: RegionProps & { helper?: boolean }) {
  const current = rigs.find((rig) => rig.id === props.ui.rig) ?? rigs[0];

  return (
    <div className="mv-rig" part="lighting">
      <div className="mv-row">
        <span className="mv-label">Lighting</span>
        <div className="mv-segments" data-size="sm" role="radiogroup" aria-label="Lighting">
          {rigs.map((rig) => (
            <button
              key={rig.id}
              type="button"
              role="radio"
              className="mv-segment"
              aria-checked={rig.id === current.id}
              disabled={props.controls.readOnly}
              onClick={() => props.ui.setRig(rig.id)}
            >
              {rig.label}
            </button>
          ))}
        </div>
      </div>
      {props.helper === true ? <span className="mv-caption">{current.helper}</span> : null}
    </div>
  );
}

// Layout B's single-line StatTrak row.
export function InlineStatTrak(props: RegionProps) {
  return <StatTrakToggle {...props} inline />;
}

// Layout B's sticker panel, with its shorter helper line.
export function FloatingStickerEditor(props: RegionProps) {
  return <StickerEditor {...props} helper="Select a slot to edit wear, rotation and offset." />;
}
