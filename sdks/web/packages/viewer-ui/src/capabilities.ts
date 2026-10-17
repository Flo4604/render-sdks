// What the loaded engine can do beyond seed and wear. The attachment (W61)
// and camera (W62) methods are public engine API; the kit detects them on the
// viewer instance, so a bring-your-own UI can make the same checks, and the
// kit keeps working against an engine that predates them.

import type { InspectAttachment, Viewer } from "@medalbot/viewer-engine";

// A sticker in the kit's state: the kit (`id`) and slot pick the linked
// closure; wear, rotation and offset are bound live. `scale` comes only from a
// loaded inspect link (the wire format carries it); the game cannot scale a
// sticker, so the kit never edits it.
export interface StickerPlacement {
  slot: number;
  id: number;
  wear?: number;
  // Degrees.
  rotation?: number;
  scale?: number;
  offset?: [number, number];
}

// What the sticker editor changes: wear, rotation and the X and Y offsets.
export interface StickerEdit {
  wear?: number;
  rotation?: number;
  offset?: [number, number];
}

export interface CharmPlacement {
  slot: number;
  id: number;
  pattern: number;
  offset?: [number, number, number];
}

// Applies an edit to one slot and keeps everything the edit does not name,
// including a loaded scale.
export function editSticker(
  stickers: readonly StickerPlacement[],
  slot: number,
  edit: StickerEdit,
): StickerPlacement[] {
  return stickers.map((sticker) => (sticker.slot === slot ? { ...sticker, ...edit } : sticker));
}

export interface CameraPose {
  // Degrees about the preset's up axis.
  yaw: number;
  // Degrees about the preset's left axis.
  pitch: number;
  // Scene units from the target.
  distance: number;
}

export interface CameraState extends CameraPose {
  view: string;
  presetDistance: number;
  fov: number;
  // False at the preset's exact fitted pose.
  free: boolean;
}

interface CameraMethods {
  getCamera(): CameraState;
  setCamera(change: Partial<CameraPose>): Promise<CameraState>;
  setPreset(name: string): void;
  resetCamera(): void;
}

interface AttachmentMethods {
  readonly stickers: Array<Record<string, unknown>>;
  readonly statTrak: number | null;
  setStickers(placements: Array<Omit<StickerPlacement, "id"> & { id?: number }>): void;
  setStatTrak(count: number | null): void;
}

export interface Capabilities {
  // Live sticker placement on a linked closure.
  stickers: boolean;
  // A live StatTrak counter.
  statTrak: boolean;
  // Attachments in a load request (stickers, charms, StatTrak select a linked closure).
  attachments: boolean;
  // A free camera for the current item.
  camera: boolean;
  // Named lighting rigs through viewer.setRig.
  lighting: boolean;
}

export function cameraOf(viewer: Viewer): CameraMethods | undefined {
  const candidate = viewer as unknown as Partial<CameraMethods>;

  if (
    typeof candidate.getCamera !== "function" ||
    typeof candidate.setCamera !== "function" ||
    typeof candidate.setPreset !== "function" ||
    typeof candidate.resetCamera !== "function"
  ) {
    return undefined;
  }

  return candidate as CameraMethods;
}

export function attachmentsOf(viewer: Viewer): AttachmentMethods | undefined {
  const candidate = viewer as unknown as Partial<AttachmentMethods>;

  if (typeof candidate.setStickers !== "function" || typeof candidate.setStatTrak !== "function") {
    return undefined;
  }

  return candidate as AttachmentMethods;
}

// Whether the loaded item has a free camera: the engine has the methods and
// the closure carries the camera translations for the current view.
function hasCamera(viewer: Viewer): boolean {
  const camera = cameraOf(viewer);

  if (camera === undefined) {
    return false;
  }

  try {
    camera.getCamera();

    return true;
  } catch {
    return false;
  }
}

export function capabilities(viewer: Viewer): Capabilities {
  const attachments = attachmentsOf(viewer) !== undefined;
  let stickers = false;
  let statTrak = false;

  if (attachments) {
    const methods = attachmentsOf(viewer) as AttachmentMethods;
    stickers = methods.stickers.length > 0;
    statTrak = methods.statTrak !== null;
  }

  return {
    stickers,
    statTrak,
    attachments,
    camera: hasCamera(viewer),
    lighting: typeof (viewer as unknown as { setRig?: unknown }).setRig === "function",
  };
}

// The loaded stickers in the kit's form.
export function loadedStickers(viewer: Viewer): StickerPlacement[] {
  const methods = attachmentsOf(viewer);

  if (methods === undefined) {
    return [];
  }

  return methods.stickers.map((sticker) => {
    const placement: StickerPlacement = {
      slot: Number(sticker.slot),
      id: Number(sticker.sticker_id),
    };

    if (typeof sticker.wear === "number") {
      placement.wear = sticker.wear;
    }

    if (typeof sticker.rotation === "number") {
      placement.rotation = sticker.rotation;
    }

    if (typeof sticker.scale === "number") {
      placement.scale = sticker.scale;
    }

    if (typeof sticker.offset_x === "number" || typeof sticker.offset_y === "number") {
      placement.offset = [Number(sticker.offset_x ?? 0), Number(sticker.offset_y ?? 0)];
    }

    return placement;
  });
}

// A sticker in the inspect form a load request carries.
export function inspectSticker(sticker: StickerPlacement): InspectAttachment {
  return {
    slot: sticker.slot,
    sticker_id: sticker.id,
    ...(sticker.wear === undefined ? {} : { wear: sticker.wear }),
    ...(sticker.rotation === undefined ? {} : { rotation: sticker.rotation }),
    ...(sticker.scale === undefined ? {} : { scale: sticker.scale }),
    ...(sticker.offset === undefined
      ? {}
      : { offset_x: sticker.offset[0], offset_y: sticker.offset[1] }),
  };
}

export function inspectCharm(charm: CharmPlacement): InspectAttachment {
  return {
    slot: charm.slot,
    sticker_id: charm.id,
    pattern: charm.pattern,
    ...(charm.offset === undefined
      ? {}
      : { offset_x: charm.offset[0], offset_y: charm.offset[1], offset_z: charm.offset[2] }),
  };
}
