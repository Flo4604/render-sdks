// The icon camera of the scene compiler (native compile/scene/camera.cpp
// projectCamera) in float32, and the projection words of the PerView and CSGO
// view buffers that change when only the field of view changes. Every float32
// rounding of the C++ is a Math.fround here, in the same order.
//
// The compiler copies the PerView and CSGO view words from the client's own
// CCamera object, built by the pinned libscenesystem.so. This port rebuilds the
// words a field-of-view change moves from the same inputs; it is checked
// against the compiled words of each preset (tests/camera.test.ts), and the
// engine writes the compiled words unchanged whenever the field of view is the
// preset's.

const f32 = Math.fround;

export type Vec3 = [number, number, number];

export interface CameraSettings {
  angle: Vec3;
  target: Vec3;
  nudge: Vec3;
  orbitDistance: number;
  near: number;
  far: number;
  fovHorizontal?: number | undefined;
  fovVertical?: number | undefined;
  // The compiled eye, when the caller has it; it replaces the eye computed
  // from the orbit distance.
  eye?: Vec3 | undefined;
}

export interface ProjectedCamera {
  width: number;
  height: number;
  near: number;
  far: number;
  angle: Vec3;
  target: Vec3;
  nudge: Vec3;
  eye: Vec3;
  forward: Vec3;
  right: Vec3;
  up: Vec3;
  // Row-major 4 x 4 over world axes: rows x, y, z, then translation.
  worldToProjection: number[];
  xScale: number;
  yScale: number;
  horizontalFov: number;
}

export interface AngleBasis {
  forward: Vec3;
  right: Vec3;
  up: Vec3;
}

// The Source forward/right/up basis of pitch, yaw and roll in degrees, each
// trigonometric result rounded to float32 (camera.cpp angleBasis).
export function angleBasis(angles: Vec3): AngleBasis {
  const radians = angles.map((angle) => f32(f32(angle) * f32(Math.PI / 180)));
  const [pitch, yaw, roll] = radians as Vec3;
  const sp = f32(Math.sin(pitch));
  const sy = f32(Math.sin(yaw));
  const sr = f32(Math.sin(roll));
  const cp = f32(Math.cos(pitch));
  const cy = f32(Math.cos(yaw));
  const cr = f32(Math.cos(roll));

  return {
    forward: [f32(cp * cy), f32(cp * sy), -sp],
    right: [
      f32(f32(f32(-sr * sp) * cy) + f32(cr * sy)),
      f32(f32(f32(-sr * sp) * sy) - f32(cr * cy)),
      f32(-sr * cp),
    ],
    up: [
      f32(f32(f32(cr * sp) * cy) + f32(sr * sy)),
      f32(f32(f32(cr * sp) * sy) - f32(sr * cy)),
      f32(cr * cp),
    ],
  };
}

// The horizontal field of view in degrees of a projection's x scale.
export function horizontalFov(xScale: number): number {
  return f32((Math.atan(1 / xScale) * 360) / Math.PI);
}

const halfTangent = (degrees: number) => f32(Math.tan(f32(f32(degrees) * f32(Math.PI / 360))));

// The client's icon camera for a viewport (camera.cpp projectCamera).
export function projectCamera(
  settings: CameraSettings,
  width: number,
  height: number,
): ProjectedCamera {
  const rounded = (value: Vec3): Vec3 => [f32(value[0]), f32(value[1]), f32(value[2])];
  const angle = rounded(settings.angle);
  const target = rounded(settings.target);
  const nudge = rounded(settings.nudge);
  const near = f32(settings.near);
  const far = f32(settings.far);
  const distance = f32(settings.orbitDistance);
  const aspect = f32(width / height);
  let verticalHorizontal = 0;

  if (settings.fovVertical !== undefined) {
    verticalHorizontal = f32(
      f32(Math.atan(f32(halfTangent(settings.fovVertical) * aspect))) * f32(360 / f32(Math.PI)),
    );
  }

  const resolvedHorizontal = Math.max(f32(settings.fovHorizontal ?? 0), verticalHorizontal);
  const tangentX = halfTangent(resolvedHorizontal);
  const xScale = f32(1 / tangentX);
  const yScale = f32(1 / f32(tangentX / aspect));
  const basis = angleBasis(angle);
  const eye: Vec3 = [0, 0, 0];

  for (let axis = 0; axis < 3; axis++) {
    eye[axis] = f32(
      f32((target[axis] ?? 0) + (nudge[axis] ?? 0)) - f32((basis.forward[axis] ?? 0) * distance),
    );
  }

  if (settings.eye !== undefined) {
    eye[0] = f32(settings.eye[0]);
    eye[1] = f32(settings.eye[1]);
    eye[2] = f32(settings.eye[2]);
  }

  const dot = (a: Vec3, b: Vec3) =>
    f32(f32(f32(a[0] * b[0]) + f32(a[1] * b[1])) + f32(a[2] * b[2]));
  const zScale = f32(far / f32(far - near));
  const worldToProjection: number[] = [];

  for (let index = 0; index < 3; index++) {
    worldToProjection.push(
      f32(basis.right[index]! * xScale),
      f32(basis.up[index]! * yScale),
      f32(basis.forward[index]! * zScale),
      basis.forward[index]!,
    );
  }

  worldToProjection.push(
    f32(-dot(eye, basis.right) * xScale),
    f32(-dot(eye, basis.up) * yScale),
    f32(f32(-dot(eye, basis.forward) * zScale) - f32(near * zScale)),
    -dot(eye, basis.forward),
  );

  return {
    width,
    height,
    near,
    far,
    angle,
    target,
    nudge,
    eye,
    forward: basis.forward,
    right: basis.right,
    up: basis.up,
    worldToProjection,
    xScale,
    yScale,
    horizontalFov: resolvedHorizontal,
  };
}

// The field of view, in degrees, that shows the orbit centre at the size a
// camera `distance` away would: tan(fov' / 2) = tan(fov / 2) * distance / d0.
export function zoomedFov(fov: number, presetDistance: number, distance: number): number {
  const tangent = Math.tan((fov * Math.PI) / 360) * (distance / presetDistance);

  return (Math.atan(tangent) * 360) / Math.PI;
}

// The inverse of a 4 x 4 matrix in double precision (row-major), or undefined
// when it is singular.
function invert(m: number[]): number[] | undefined {
  const a = [...m];
  const inverse: number[] = Array.from({ length: 16 }, (_, index) => (index % 5 === 0 ? 1 : 0));

  for (let column = 0; column < 4; column++) {
    let pivot = column;

    for (let row = column + 1; row < 4; row++) {
      if (Math.abs(a[row * 4 + column]!) > Math.abs(a[pivot * 4 + column]!)) {
        pivot = row;
      }
    }

    if (a[pivot * 4 + column] === 0) {
      return undefined;
    }

    if (pivot !== column) {
      for (let index = 0; index < 4; index++) {
        [a[column * 4 + index], a[pivot * 4 + index]] = [
          a[pivot * 4 + index]!,
          a[column * 4 + index]!,
        ];
        [inverse[column * 4 + index], inverse[pivot * 4 + index]] = [
          inverse[pivot * 4 + index]!,
          inverse[column * 4 + index]!,
        ];
      }
    }

    const scale = a[column * 4 + column]!;

    for (let index = 0; index < 4; index++) {
      a[column * 4 + index] = a[column * 4 + index]! / scale;
      inverse[column * 4 + index] = inverse[column * 4 + index]! / scale;
    }

    for (let row = 0; row < 4; row++) {
      if (row === column) {
        continue;
      }

      const factor = a[row * 4 + column]!;

      for (let index = 0; index < 4; index++) {
        a[row * 4 + index] = a[row * 4 + index]! - factor * a[column * 4 + index]!;
        inverse[row * 4 + index] =
          inverse[row * 4 + index]! - factor * inverse[column * 4 + index]!;
      }
    }
  }

  return inverse;
}

export interface ProjectionWords {
  // Byte offset -> float32 values, for the PerView (640 bytes).
  perView: Array<{ offset: number; values: number[] }>;
  // The same for the CSGO view (656 bytes).
  csgoView: Array<{ offset: number; values: number[] }>;
}

// The PerView and CSGO view words a projection change moves (views.cpp
// packPerViewCamera and csgoViewBuffer): the camera-relative view-projection
// at 0 and its previous-frame copy at 560, the absolute inverse at 64 and the
// projection at 192 of the PerView; the absolute view-projection at 192 and
// the cable pixel radius at 628 of the CSGO view. `cableClamp` is
// r_csgo_cable_pixel_radius_clamp.
export function projectionWords(camera: ProjectedCamera, cableClamp: number): ProjectionWords {
  const w = camera.worldToProjection;
  const zScale = f32(camera.far / f32(camera.far - camera.near));
  // projection[3], [7], [11], [15]: the last column of the row-major
  // projection, which replaces the relative matrix's translation row.
  const projectionColumn = [0, 0, f32(-f32(camera.near * zScale)), 0];
  const relative = [...w.slice(0, 12), ...projectionColumn];
  const absolute = w.map((value) => value);
  // The absolute row-major matrix maps row vectors [x y z 1]; its inverse is
  // stored transposed like every other PerView matrix.
  const inverse = invert(absolute) ?? Array.from({ length: 16 }, () => 0);
  const projection = [
    camera.xScale,
    0,
    0,
    0,
    0,
    camera.yScale,
    0,
    0,
    0,
    0,
    -zScale,
    projectionColumn[2]!,
    0,
    0,
    -1,
    0,
  ];
  const pixelAngle = f32(
    f32(horizontalFov(camera.xScale) * f32(Math.PI / 180)) / f32(camera.width),
  );

  return {
    perView: [
      { offset: 0, values: relative.map(f32) },
      { offset: 64, values: inverse.map(f32) },
      { offset: 192, values: projection.map(f32) },
      { offset: 560, values: relative.map(f32) },
    ],
    csgoView: [
      { offset: 192, values: absolute.map(f32) },
      { offset: 628, values: [f32(f32(Math.tan(pixelAngle)) * f32(cableClamp))] },
    ],
  };
}

// r_csgo_cable_pixel_radius_clamp recovered from a compiled CSGO view word at
// 628 and the camera it was compiled for.
export function cableClampOf(word: number, camera: ProjectedCamera): number {
  const pixelAngle = f32(
    f32(horizontalFov(camera.xScale) * f32(Math.PI / 180)) / f32(camera.width),
  );

  return f32(word / f32(Math.tan(pixelAngle)));
}
