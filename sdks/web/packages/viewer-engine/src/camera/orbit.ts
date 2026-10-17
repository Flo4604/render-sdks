// The orbit of the free camera as a turntable: the camera, its lights, the sun
// and the shadow cascades stay where the server fitted them for the preset,
// and the item turns about the preset's orbit centre by the inverse of the
// camera's orbit. That is the scene the executor renders for the same preset
// with `item.angle` and `item.position` set to `itemPose` (the item's skin
// matrices are item transform times source pose, compile/geometry
// sourceItemTransform), so every buffer the engine writes is one the executor
// writes from that request.

import type { Vec3 } from "./projection.ts";

const f32 = Math.fround;

// Row-major 3 x 3.
export type Matrix3 = [number, number, number, number, number, number, number, number, number];

export const identity3: Matrix3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

function normalize(vector: Vec3): Vec3 {
  const length = Math.hypot(vector[0], vector[1], vector[2]);

  return [vector[0] / length, vector[1] / length, vector[2] / length];
}

// A right-handed rotation by `degrees` about `axis`.
export function axisRotation(axis: Vec3, degrees: number): Matrix3 {
  const [x, y, z] = normalize(axis);
  const radians = (degrees * Math.PI) / 180;
  const c = Math.cos(radians);
  const s = Math.sin(radians);
  const t = 1 - c;

  return [
    t * x * x + c,
    t * x * y - s * z,
    t * x * z + s * y,
    t * x * y + s * z,
    t * y * y + c,
    t * y * z - s * x,
    t * x * z - s * y,
    t * y * z + s * x,
    t * z * z + c,
  ];
}

export function multiply3(a: Matrix3, b: Matrix3): Matrix3 {
  const result = new Array<number>(9).fill(0) as Matrix3;

  for (let row = 0; row < 3; row++) {
    for (let column = 0; column < 3; column++) {
      let sum = 0;

      for (let k = 0; k < 3; k++) {
        sum += a[row * 3 + k]! * b[k * 3 + column]!;
      }

      result[row * 3 + column] = sum;
    }
  }

  return result;
}

export function transpose3(m: Matrix3): Matrix3 {
  return [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];
}

export function apply3(m: Matrix3, v: Vec3): Vec3 {
  return [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
  ];
}

// The camera's orbit about the preset pose: `pitch` degrees about the preset
// camera's left axis (positive raises the eye, as a Source pitch looks down),
// then `yaw` degrees about its up axis (positive moves the eye to the right).
export function cameraOrbit(basis: { right: Vec3; up: Vec3 }, yaw: number, pitch: number): Matrix3 {
  const left: Vec3 = [-basis.right[0], -basis.right[1], -basis.right[2]];

  return multiply3(axisRotation(basis.up, yaw), axisRotation(left, pitch));
}

// Source angles (pitch, yaw, roll in degrees) of a rotation whose columns
// are forward, left and up (mathlib MatrixAngles).
export function matrixAngles(m: Matrix3): Vec3 {
  const degrees = (radians: number) => (radians * 180) / Math.PI;
  const xyDistance = Math.hypot(m[0], m[3]);

  if (xyDistance > 0.001) {
    return [
      degrees(Math.atan2(-m[6], xyDistance)),
      degrees(Math.atan2(m[3], m[0])),
      degrees(Math.atan2(m[7], m[8])),
    ];
  }

  return [degrees(Math.atan2(-m[6], xyDistance)), degrees(Math.atan2(-m[1], m[4])), 0];
}

// The rotation of Source angles, columns forward, left and up (mathlib
// AngleMatrix), in double precision.
export function angleMatrix(angles: Vec3): Matrix3 {
  const [pitch, yaw, roll] = angles.map((angle) => (angle * Math.PI) / 180) as Vec3;
  const sp = Math.sin(pitch);
  const cp = Math.cos(pitch);
  const sy = Math.sin(yaw);
  const cy = Math.cos(yaw);
  const sr = Math.sin(roll);
  const cr = Math.cos(roll);

  return [
    cp * cy,
    sr * sp * cy - cr * sy,
    cr * sp * cy + sr * sy,
    cp * sy,
    sr * sp * sy + cr * cy,
    cr * sp * sy - sr * cy,
    -sp,
    sr * cp,
    cr * cp,
  ];
}

export interface ItemPose {
  // Source angles of the item, degrees.
  angle: Vec3;
  position: Vec3;
}

// The item pose the executor renders for the turned item: its rotation is
// `turn` after the preset's item angle, about `centre`.
export function itemPose(preset: ItemPose, turn: Matrix3, centre: Vec3): ItemPose {
  const rotation = multiply3(turn, angleMatrix(preset.angle));
  const offset = apply3(turn, [
    preset.position[0] - centre[0],
    preset.position[1] - centre[1],
    preset.position[2] - centre[2],
  ]);

  return {
    angle: matrixAngles(rotation),
    position: [centre[0] + offset[0], centre[1] + offset[1], centre[2] + offset[2]],
  };
}

// Whether a 48-byte row-major 3 x 4 record is a rigid transform (an
// orthonormal 3 x 3 with determinant 1); the transform tables also hold
// unused and zero rows, which stay as they are.
function rigid(words: Float32Array, base: number): boolean {
  const m = Array.from(
    { length: 9 },
    (_, index) => words[base + Math.floor(index / 3) * 4 + (index % 3)]!,
  );
  const product = multiply3(transpose3(m as Matrix3), m as Matrix3);
  const tolerance = 1e-3;

  for (let index = 0; index < 9; index++) {
    const expected = index % 4 === 0 ? 1 : 0;

    if (Math.abs(product[index]! - expected) > tolerance) {
      return false;
    }
  }

  return true;
}

// The transform table (set 4 binding 30) with every rigid record turned by
// `turn` about `centre`: rotation turn * R and translation
// centre + turn * (t - centre), rounded to float32.
export function turnTransforms(original: Uint8Array, turn: Matrix3, centre: Vec3): Uint8Array {
  const result = original.slice();
  const words = new Float32Array(result.buffer, result.byteOffset, Math.floor(result.length / 4));

  for (let base = 0; base + 12 <= words.length; base += 12) {
    if (!rigid(words, base)) {
      continue;
    }

    const rotation = Array.from(
      { length: 9 },
      (_, index) => words[base + Math.floor(index / 3) * 4 + (index % 3)]!,
    ) as Matrix3;
    const translation: Vec3 = [words[base + 3]!, words[base + 7]!, words[base + 11]!];
    const turned = multiply3(turn, rotation);
    const offset = apply3(turn, [
      translation[0] - centre[0],
      translation[1] - centre[1],
      translation[2] - centre[2],
    ]);

    for (let row = 0; row < 3; row++) {
      for (let column = 0; column < 3; column++) {
        words[base + row * 4 + column] = f32(turned[row * 3 + column]!);
      }

      words[base + row * 4 + 3] = f32(centre[row]! + offset[row]!);
    }
  }

  return result;
}
