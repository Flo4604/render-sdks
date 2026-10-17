// 04 Wear slider: the CSFloat float bar made interactive. The track is split
// at the real tier bounds, the current tier lights up, and the exact float is
// typed in the field. setWear runs on release or commit.

import {
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";

import type { RegionProps } from "../regions.ts";
import { formatWear, wearTier, wearTiers } from "../wear.ts";
import { tierColor } from "./item-header.tsx";

const gap = 2;

function tierIndex(wear: number): number {
  return wearTiers.indexOf(wearTier(wear));
}

// The x position of a float on the gapped track, as a CSS length.
function trackX(wear: number): string {
  return `calc((100% - ${gap * (wearTiers.length - 1)}px) * ${wear} + ${gap * tierIndex(wear)}px)`;
}

function wearAt(x: number, width: number): number {
  const usable = width - gap * (wearTiers.length - 1);

  for (let index = wearTiers.length - 1; index >= 0; index--) {
    const wear = (x - gap * index) / usable;

    if (tierIndex(Math.min(Math.max(wear, 0), 0.999999)) === index) {
      return wear;
    }
  }

  return x / usable;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function WearSlider({ state, actions, controls, display }: RegionProps) {
  const committed = state.paint?.wear ?? 0;
  const [draft, setDraft] = useState<number | undefined>(undefined);
  const [typed, setTyped] = useState<string | undefined>(undefined);
  const [dragging, setDragging] = useState(false);
  const track = useRef<HTMLDivElement>(null);
  const labelId = useId();
  const range = display.wearRange ?? { min: 0, max: 1 };
  const bindable = state.bindable.includes("paintwear");
  const disabled = controls.readOnly || !bindable || state.status !== "ready";
  const wear = draft ?? committed;
  const tier = wearTier(wear);
  const typedValue = typed === undefined ? undefined : Number(typed);
  const typedInvalid =
    typedValue !== undefined &&
    (!Number.isFinite(typedValue) || typedValue < range.min || typedValue > range.max);

  useEffect(() => {
    setDraft(undefined);
  }, [committed]);

  const commit = (value: number) => {
    const next = clamp(value, range.min, range.max);
    setDraft(next);
    actions.setWear(next);
  };

  const fromPointer = (event: PointerEvent<HTMLDivElement>) => {
    const rect = track.current?.getBoundingClientRect();

    if (rect === undefined) {
      return committed;
    }

    return clamp(wearAt(event.clientX - rect.left, rect.width), range.min, range.max);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 0.01 : 0.001;
    const moves: Record<string, number> = {
      ArrowRight: step,
      ArrowUp: step,
      ArrowLeft: -step,
      ArrowDown: -step,
    };
    const move = moves[event.key];

    if (event.key === "Home") {
      event.preventDefault();
      commit(range.min);

      return;
    }

    if (event.key === "End") {
      event.preventDefault();
      commit(range.max);

      return;
    }

    if (move === undefined) {
      return;
    }

    event.preventDefault();
    commit(wear + move);
  };

  let caption = `This finish ranges ${range.min.toFixed(2)} to ${range.max.toFixed(2)}`;
  let tone: string | undefined;

  if (!bindable && state.status === "ready") {
    caption = "This item’s look doesn’t change with wear";
    tone = "muted";
  } else if (typedInvalid && typedValue !== undefined && typedValue < range.min) {
    caption = `Below this finish’s minimum of ${range.min.toFixed(2)}`;
    tone = "danger";
  } else if (typedInvalid) {
    caption =
      typedValue !== undefined && typedValue > range.max
        ? `Above this finish’s maximum of ${range.max.toFixed(2)}`
        : "Wear goes from 0 to 1";
    tone = "danger";
  }

  const showCaption = display.wearRange !== undefined || tone !== undefined;

  return (
    <div
      className="mv-wear"
      part="wear-slider"
      data-disabled={disabled && state.status === "ready"}
    >
      <div className="mv-field-head">
        <div className="mv-wear-title">
          <span className="mv-label" id={labelId}>
            Wear
          </span>
          <span className="mv-wear-tier">{tier.name}</span>
        </div>
        <input
          className="mv-input mv-wear-input"
          aria-label="Wear float"
          inputMode="decimal"
          aria-invalid={typedInvalid}
          disabled={disabled}
          value={typed ?? formatWear(wear, 8)}
          onChange={(event) => setTyped(event.target.value)}
          onBlur={() => {
            if (typedValue !== undefined && !typedInvalid) {
              commit(typedValue);
            }

            setTyped(undefined);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && typedValue !== undefined && !typedInvalid) {
              commit(typedValue);
              setTyped(undefined);
            }

            if (event.key === "Escape") {
              setTyped(undefined);
            }
          }}
        />
      </div>
      <div
        ref={track}
        className="mv-track"
        role="slider"
        tabIndex={disabled ? -1 : 0}
        aria-labelledby={labelId}
        aria-valuemin={range.min}
        aria-valuemax={range.max}
        aria-valuenow={Number(wear.toFixed(6))}
        aria-valuetext={`${wear.toFixed(4)}, ${tier.name}`}
        aria-disabled={disabled}
        data-dragging={dragging}
        style={{ "--mv-thumb-x": trackX(wear) } as CSSProperties}
        onKeyDown={disabled ? undefined : onKeyDown}
        onPointerDown={(event) => {
          if (disabled) {
            return;
          }

          event.currentTarget.setPointerCapture(event.pointerId);
          setDragging(true);
          setDraft(fromPointer(event));
        }}
        onPointerMove={(event) => {
          if (dragging) {
            setDraft(fromPointer(event));
          }
        }}
        onPointerUp={(event) => {
          if (!dragging) {
            return;
          }

          setDragging(false);
          commit(fromPointer(event));
        }}
        onPointerCancel={() => {
          setDragging(false);
          setDraft(undefined);
        }}
      >
        <div className="mv-track-segments">
          {wearTiers.map((entry, index) => (
            <i
              key={entry.short}
              data-current={entry === tier}
              style={
                {
                  flexGrow: entry.max - (wearTiers[index - 1]?.max ?? 0),
                  "--mv-segment-color": tierColor(entry.short),
                } as CSSProperties
              }
            />
          ))}
        </div>
        {range.min > 0 ? (
          <i
            className="mv-track-floor"
            style={{ "--mv-floor-x": trackX(range.min) } as CSSProperties}
          />
        ) : null}
        {range.max < 1 ? (
          <i
            className="mv-track-ceiling"
            style={
              {
                "--mv-ceiling-x": `calc(100% - ${trackX(range.max)})`,
              } as CSSProperties
            }
          />
        ) : null}
        <i className="mv-thumb" />
      </div>
      <div className="mv-ticks" aria-hidden="true">
        {wearTiers.map((entry, index) => (
          <span
            key={entry.short}
            data-current={entry === tier}
            style={{ flexGrow: entry.max - (wearTiers[index - 1]?.max ?? 0), flexBasis: 0 }}
          >
            {entry.short}
          </span>
        ))}
      </div>
      {showCaption ? (
        <span className="mv-caption" data-tone={tone}>
          {caption}
        </span>
      ) : null}
    </div>
  );
}
