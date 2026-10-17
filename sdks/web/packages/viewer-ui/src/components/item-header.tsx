// 02 Item header: weapon and rarity, the finish, then wear tier, float and
// pattern in the order traders scan them. The rarity colour comes from the
// item data the host passes.

import type { CSSProperties } from "react";

import type { RegionProps } from "../regions.ts";
import { formatWear, wearTier } from "../wear.ts";
import { OrbitIcon, SearchIcon } from "./icons.tsx";

export function tierColor(short: string): string {
  return `var(--mv-color-wear-${short.toLowerCase()})`;
}

export function ItemHeader({ display, state, ui }: RegionProps) {
  const paint = state.paint;

  if (state.item === undefined && display.finish === undefined) {
    return (
      <div className="mv-skeleton" part="header" aria-hidden="true">
        <i />
        <i />
        <i />
      </div>
    );
  }

  const tier = paint === undefined ? undefined : wearTier(paint.wear);
  const rarityStyle =
    display.rarityColor === undefined
      ? undefined
      : ({ "--mv-color-rarity": display.rarityColor } as CSSProperties);
  const weaponLine = [display.weapon, display.rarity].filter(Boolean).join(" · ");
  const statTrak = state.statTrak !== null;

  if (ui.phone) {
    return (
      <div className="mv-header" data-compact="true" part="header" style={rarityStyle}>
        <span className="mv-weapon">{display.weapon ?? "Item"}</span>
        <h2 className="mv-finish">{display.finish ?? ""}</h2>
        {tier === undefined || paint === undefined ? null : (
          <div className="mv-meta">
            <span className="mv-tier">
              <i
                className="mv-tier-dot"
                style={{ "--mv-tier-color": tierColor(tier.short) } as CSSProperties}
              />
              {tier.short}
            </span>
            <span className="mv-meta-value mv-mono">
              {formatWear(paint.wear, 4)} · #{paint.paintseed}
            </span>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="mv-header" part="header" style={rarityStyle}>
      <div className="mv-header-line">
        <i className="mv-rarity" />
        {statTrak ? <span className="mv-stattrak-tag">StatTrak™</span> : null}
        <span className="mv-weapon">{weaponLine === "" ? "Item" : weaponLine}</span>
      </div>
      {display.finish === undefined ? null : <h2 className="mv-finish">{display.finish}</h2>}
      {tier === undefined || paint === undefined ? null : (
        <div className="mv-meta">
          <span className="mv-tier">
            <i
              className="mv-tier-dot"
              style={{ "--mv-tier-color": tierColor(tier.short) } as CSSProperties}
            />
            {tier.name}
          </span>
          <i className="mv-meta-rule" />
          <span className="mv-meta-value mv-mono">{formatWear(paint.wear, 8)}</span>
          <i className="mv-meta-rule" />
          <span className="mv-meta-value mv-mono">Pattern {paint.paintseed}</span>
        </div>
      )}
    </div>
  );
}

export function ChangeItem({ ui }: RegionProps) {
  const open = ui.picker?.kind === "item";

  return (
    <button
      type="button"
      className="mv-change-item"
      part="change-item"
      aria-haspopup="dialog"
      aria-expanded={open}
      onClick={() => (open ? ui.closePicker() : ui.openPicker("item"))}
    >
      <SearchIcon size={14} />
      Change item
    </button>
  );
}

export function OrbitHint({ state, ui }: RegionProps) {
  if (!state.capabilities.camera) {
    return null;
  }

  return (
    <div className="mv-orbit-hint" part="orbit-hint">
      <OrbitIcon />
      {ui.phone ? "Drag to orbit · pinch to zoom" : "Drag to orbit · scroll to zoom"}
    </div>
  );
}
