// The kit's component boundaries. One list names every replaceable piece: the
// React `components` overrides, the custom element's `part` names and its
// named slots all use these names, so a host learns them once. They follow
// the Paper "3D Viewer" components.

import type { ComponentType } from "react";

import type { Catalog, CharmEntry, FinishEntry, StickerEntry } from "./catalog.ts";
import type { ViewerActions, ViewerState } from "./use-viewer.ts";

export const regions = [
  // 01 Viewer surface and its states.
  "stage",
  "loading",
  "error",
  "unsupported",
  // 02 Item header, with the change-item button and the orbit hint.
  "header",
  "change-item",
  "orbit-hint",
  // 03 and 06: view presets inside the control bar.
  "presets",
  "control-bar",
  // 04, 05: paint controls.
  "wear-slider",
  "seed-input",
  // 07 to 10: attachments and lighting.
  "stickers",
  "stattrak",
  "charm",
  "lighting",
  // 11: export and fullscreen.
  "download",
  "fullscreen",
  // 12: transient results.
  "toasts",
  // 13: the item, sticker and charm picker.
  "picker",
  // 15: embed extras.
  "badge",
  "disclaimer",
  "shortcuts",
  // Layout containers: the side panel (A), the floating panels (B), the phone sheet.
  "panel",
] as const;

export type Region = (typeof regions)[number];

// The controls an embedder can show or hide. A hidden control is not rendered.
export const controlNames = [
  "presets",
  "wear",
  "seed",
  "stickers",
  "stattrak",
  "charm",
  "lighting",
  "download",
  "fullscreen",
  "header",
  "change-item",
  "badge",
  "disclaimer",
  "shortcuts",
] as const;

export type ControlName = (typeof controlNames)[number];

export type ControlsConfig = Partial<Record<ControlName, boolean>>;

// The attribution badge and the disclaimer are off unless the host turns them on.
const hiddenByDefault: ReadonlySet<ControlName> = new Set(["badge", "disclaimer"]);

// How much chrome the kit draws (data-density on the root): "full" is the
// header, controls and customise panels; "viewer" keeps the header and the
// view controls without the customise panels (listing pages); "host" draws
// the render, its states and the optional shortcuts, badge and disclaimer,
// for a host that owns the chrome.
export type Density = "full" | "viewer" | "host";

// Where the customise controls go: "floating" glass panels over a full-bleed
// render (layout B, the default) or a side panel beside an inset stage
// (layout A). Below 640 px the kit uses the phone layout either way.
export type Layout = "floating" | "panel";

export interface ResolvedControls {
  visible: Record<ControlName, boolean>;
  readOnly: boolean;
  density: Density;
  layout: Layout;
}

export function resolveControls(
  controls: ControlsConfig = {},
  options: { readOnly?: boolean; density?: Density; layout?: Layout } = {},
): ResolvedControls {
  const visible = Object.fromEntries(
    controlNames.map((name) => [name, controls[name] ?? !hiddenByDefault.has(name)]),
  ) as Record<ControlName, boolean>;

  return {
    visible,
    readOnly: options.readOnly ?? false,
    density: options.density ?? "full",
    layout: options.layout ?? "floating",
  };
}

// What the host tells the kit about the item; the closure carries indices only.
export interface ItemDisplay {
  weapon?: string;
  finish?: string;
  // The rarity's name and colour, as the item data gives them.
  rarity?: string;
  rarityColor?: string;
  // The finish's float range.
  wearRange?: { min: number; max: number };
  // A still image shown before the 3D view is ready and when WebGPU is missing.
  poster?: string;
  // The disclaimer line, when shown.
  disclaimer?: string;
  // How many sticker slots the weapon has.
  stickerSlots?: number;
}

export type PickerKind = "item" | "sticker" | "charm";

export interface ToastMessage {
  id: number;
  tone: "success" | "error" | "progress";
  title: string;
  body?: string;
  code?: string;
  progress?: { done: number; total: number };
}

// Kit state shared by the regions that is not engine state.
export interface ViewerUi {
  phone: boolean;
  fullscreen: boolean;
  toggleFullscreen(): void;
  catalog: Catalog | undefined;
  catalogStatus: "none" | "loading" | "ready" | "error";
  picker: { kind: PickerKind; slot?: number } | undefined;
  openPicker(kind: PickerKind, slot?: number): void;
  closePicker(): void;
  // What a pick does: load another finish or inspect link, add a sticker to
  // the slot that opened the picker, attach a charm.
  pickItem(choice: { finish?: FinishEntry; inspectLink?: string }): void;
  pickSticker(entry: StickerEntry): void;
  pickCharm(entry: CharmEntry): void;
  notify(toast: Omit<ToastMessage, "id">): void;
  dismiss(id: number): void;
  toasts: ToastMessage[];
  hideUi: boolean;
  // The lighting rig the viewer asks the engine for.
  rig: string;
  setRig(rig: string): void;
}

// What every stock component and every override receives.
export interface RegionProps {
  display: ItemDisplay;
  state: ViewerState;
  actions: ViewerActions;
  controls: ResolvedControls;
  ui: ViewerUi;
}

export type RegionComponent = ComponentType<RegionProps>;

export type ComponentOverrides = Partial<Record<Region, RegionComponent>>;
