// Which buffer words the free camera rewrites, per draw role. The camera
// translation of a draw keeps exactly these words as loads; every other
// immutable word is folded as in the preset translation, so bindless indices
// and material branches specialize the same way.
//
// - The transform table (set 4 binding 30) of scene and shadow draws: the
//   orbit turns the item's skin matrices (see orbit.ts).
// - The PerView (sets 0 and 1, binding 1, 640 bytes) and CSGO view (binding
//   3, 656 bytes) of the scene draws: the zoom rewrites their projection
//   words (projection.ts projectionWords). Shadow draws render from the
//   server-fitted cascade and spot cameras, which the free camera keeps.

export type CameraRole = "scene" | "shadow";

export interface LiveDescriptor {
  set: number;
  binding: number;
  type: string;
  bytes?: number | undefined;
}

// Byte ranges [begin, end) of the PerView the zoom rewrites.
export const perViewLiveRanges: Array<[number, number]> = [
  [0, 128],
  [192, 256],
  [560, 624],
];

// Byte ranges of the CSGO view the zoom rewrites.
export const csgoViewLiveRanges: Array<[number, number]> = [
  [192, 256],
  [628, 632],
];

// "all" when the whole buffer is live, the live byte ranges, or undefined
// when the camera never writes the buffer.
export function cameraLiveRanges(
  role: CameraRole,
  descriptor: LiveDescriptor,
): "all" | Array<[number, number]> | undefined {
  if (descriptor.type === "storage" && descriptor.set === 4 && descriptor.binding === 30) {
    return "all";
  }

  if (role !== "scene" || descriptor.type !== "uniform") {
    return undefined;
  }

  const view = descriptor.set === 0 || descriptor.set === 1;

  if (view && descriptor.binding === 1 && descriptor.bytes === 640) {
    return perViewLiveRanges;
  }

  if (view && descriptor.binding === 3 && descriptor.bytes === 656) {
    return csgoViewLiveRanges;
  }

  return undefined;
}
