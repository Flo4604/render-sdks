// The free camera of one view: an orbit (yaw, pitch) and a distance about
// the preset's compiled pose, turned into the bytes of the buffers the
// camera draws read (camera/live.ts):
//
// - the orbit turns the item about the preset's orbit centre (orbit.ts), so
//   the transform tables change and nothing the server fitted to the camera
//   does;
// - the distance becomes the field of view that shows the orbit centre at
//   that distance's size, so only the projection words of the PerView and
//   CSGO view change; the eye, the light rig and the shadow cascades stay.
//
// At the preset's own distance the PerView and CSGO view keep their compiled
// bytes, and at zero yaw and pitch the transform tables do.

import type { ViewCamera, ViewItemPlacement } from "../plan/types.ts";
import { cameraOrbit, itemPose, type ItemPose, transpose3, turnTransforms } from "./orbit.ts";
import {
  cableClampOf,
  horizontalFov,
  projectCamera,
  projectionWords,
  type ProjectedCamera,
  type Vec3,
  zoomedFov,
} from "./projection.ts";

export interface CameraPose {
  // Degrees: the camera orbits right about the preset's up axis.
  yaw: number;
  // Degrees: the camera orbits up about the preset's left axis.
  pitch: number;
  // World units from the eye to the orbit centre the zoom shows.
  distance: number;
}

export interface PresetCamera {
  camera: ViewCamera;
  item: ItemPose;
  // The orbit centre: target plus nudge, in float32 as the compiler sums it.
  centre: Vec3;
  distance: number;
  horizontalFov: number;
  projected: ProjectedCamera;
}

export const pitchLimit = 89;

// The zoom range, as factors of the preset distance.
export const distanceRange: [number, number] = [0.3, 2];

const f32 = Math.fround;

function vector(value: { x?: number; y?: number; z?: number } | undefined): Vec3 {
  return [value?.x ?? 0, value?.y ?? 0, value?.z ?? 0];
}

export function presetCamera(
  camera: ViewCamera | undefined,
  item: ViewItemPlacement | undefined,
): PresetCamera | undefined {
  if (camera === undefined || item === undefined) {
    return undefined;
  }

  const centre: Vec3 = [
    f32(camera.target[0] + camera.nudge[0]),
    f32(camera.target[1] + camera.nudge[1]),
    f32(camera.target[2] + camera.nudge[2]),
  ];
  const distance = Math.hypot(
    camera.eye[0] - centre[0],
    camera.eye[1] - centre[1],
    camera.eye[2] - centre[2],
  );
  const fov = horizontalFov(camera.xScale);

  return {
    camera,
    item: { angle: vector(item.angle), position: vector(item.position) },
    centre,
    distance,
    horizontalFov: fov,
    projected: projectWithFov(camera, distance, fov),
  };
}

function projectWithFov(camera: ViewCamera, distance: number, fov: number): ProjectedCamera {
  return projectCamera(
    {
      angle: camera.angle,
      target: camera.target,
      nudge: camera.nudge,
      orbitDistance: distance,
      near: camera.near,
      far: camera.far,
      fovHorizontal: fov,
      eye: camera.eye,
    },
    camera.width,
    camera.height,
  );
}

// The horizontal field of view in degrees a pose renders with.
export function poseFov(preset: PresetCamera, pose: CameraPose): number {
  if (pose.distance === preset.distance) {
    return preset.horizontalFov;
  }

  return zoomedFov(preset.horizontalFov, preset.distance, pose.distance);
}

// The item's turn of a pose: the inverse of the camera's orbit.
export function poseTurn(preset: PresetCamera, pose: CameraPose) {
  return transpose3(cameraOrbit(preset.camera, pose.yaw, pose.pitch));
}

// The scene changes the executor renders the same image from: the preset with
// `item.angle`, `item.position` and, when zoomed, `camera.fov_h`.
export function equivalentScene(
  preset: PresetCamera,
  pose: CameraPose,
): { item: ItemPose; fovHorizontal: number | undefined } {
  return {
    item: itemPose(preset.item, poseTurn(preset, pose), preset.centre),
    fovHorizontal: pose.distance === preset.distance ? undefined : poseFov(preset, pose),
  };
}

function writeFloats(bytes: Uint8Array, offset: number, values: number[]): void {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  values.forEach((value, index) => {
    view.setFloat32(offset + index * 4, value, true);
  });
}

// The bytes of one camera buffer for a pose.
export function cameraBufferBytes(
  preset: PresetCamera,
  pose: CameraPose,
  kind: "transforms" | "perView" | "csgoView",
  original: Uint8Array,
): Uint8Array {
  if (kind === "transforms") {
    if (pose.yaw === 0 && pose.pitch === 0) {
      return original;
    }

    return turnTransforms(original, poseTurn(preset, pose), preset.centre);
  }

  if (pose.distance === preset.distance) {
    return original;
  }

  const view = new DataView(original.buffer, original.byteOffset, original.byteLength);
  const clamp =
    kind === "csgoView" ? cableClampOf(view.getFloat32(628, true), preset.projected) : 0;
  const zoomed = projectWithFov(preset.camera, preset.distance, poseFov(preset, pose));
  const words = projectionWords(zoomed, clamp);
  const bytes = original.slice();

  for (const { offset, values } of kind === "perView" ? words.perView : words.csgoView) {
    writeFloats(bytes, offset, values);
  }

  return bytes;
}
