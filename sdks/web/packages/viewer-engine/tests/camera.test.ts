// The free camera's math: the orbit as an item turn, the Source angle
// conversions, the live word ranges, and, with the proof item's compile output
// (VIEWER_CLOSURE_ROOT, VIEWER_PACKAGE), the projection port against the
// compiled PerView and CSGO view words of every preset.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { cameraLiveRanges } from "../src/camera/live.ts";
import {
  angleMatrix,
  apply3,
  cameraOrbit,
  identity3,
  matrixAngles,
  multiply3,
  transpose3,
  turnTransforms,
} from "../src/camera/orbit.ts";
import { cableClampOf, projectionWords } from "../src/camera/projection.ts";
import { cameraBufferBytes, presetCamera } from "../src/camera/rig.ts";
import type { DrawSpec, ItemPackage, SceneFixture, ViewManifest } from "../src/plan/types.ts";

const close = (a: number[], b: number[], tolerance = 1e-9) =>
  a.every((value, index) => Math.abs(value - (b[index] ?? Number.NaN)) <= tolerance);

test("Source angles survive a matrix round trip", () => {
  for (const angles of [
    [0, 0, 0],
    [10, -30, 5],
    [-45, 120, -80],
    [80, 179, 30],
  ] as Array<[number, number, number]>) {
    assert.ok(close(matrixAngles(angleMatrix(angles)), angles, 1e-9), String(angles));
  }
});

test("the camera orbit moves the eye right with yaw and up with pitch", () => {
  // The front preset of a firearm looks along -y (yaw -90).
  const basis = {
    right: [-1, 0, 0] as [number, number, number],
    up: [0, 0, 1] as [number, number, number],
  };
  const towardEye: [number, number, number] = [0, 1, 0];
  const yawed = apply3(cameraOrbit(basis, 30, 0), towardEye);
  const pitched = apply3(cameraOrbit(basis, 0, 30), towardEye);

  assert.ok(yawed[0] < 0, "positive yaw moves the eye toward the camera's right (-x)");
  assert.ok(pitched[2] > 0, "positive pitch raises the eye");
  assert.ok(
    close(
      multiply3(cameraOrbit(basis, 30, 20), transpose3(cameraOrbit(basis, 30, 20))),
      identity3,
      1e-12,
    ),
  );
});

test("turning a transform table changes only its rigid records", () => {
  const table = new Float32Array(36);
  table.set([0, 0, 1, 0], 0);
  table.set([1, 0, 0, 5, 0, 1, 0, -44, 0, 0, 1, 1], 12);
  table.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0], 24);
  const bytes = new Uint8Array(table.buffer);

  assert.deepEqual(turnTransforms(bytes, identity3, [0, -44, 0]), bytes);

  const turned = new Float32Array(
    turnTransforms(bytes, angleMatrix([0, 90, 0]), [0, -44, 0]).buffer,
  );

  assert.deepEqual([...turned.slice(0, 12)], [...table.slice(0, 12)], "the non-rigid record stays");
  // Rotating (5, 0, 1) about z by 90 degrees around the centre gives (0, 5, 1).
  assert.ok(close([turned[15]!, turned[19]!, turned[23]!], [0, -39, 1], 1e-5));
});

test("only the camera's words are live", () => {
  assert.equal(cameraLiveRanges("shadow", { set: 4, binding: 30, type: "storage" }), "all");
  assert.equal(
    cameraLiveRanges("shadow", { set: 0, binding: 1, type: "uniform", bytes: 640 }),
    undefined,
  );
  assert.ok(
    Array.isArray(cameraLiveRanges("scene", { set: 1, binding: 3, type: "uniform", bytes: 656 })),
  );
  assert.equal(
    cameraLiveRanges("scene", { set: 3, binding: 0, type: "uniform", bytes: 32768 }),
    undefined,
  );
});

test("the projection port reproduces the compiled preset words", (t) => {
  const root = process.env.VIEWER_CLOSURE_ROOT;
  const packagePath = process.env.VIEWER_PACKAGE;

  if (root === undefined || packagePath === undefined) {
    t.skip("VIEWER_CLOSURE_ROOT and VIEWER_PACKAGE are not set, so there are no compiled presets");

    return;
  }

  const packageDirectory = join(root, packagePath, "..");
  const item = JSON.parse(readFileSync(join(root, packagePath), "utf8")) as ItemPackage;

  for (const [view, value] of Object.entries(item.views)) {
    const manifest = value as ViewManifest;
    const transforms = manifest.provenance?.scene?.requestTransforms;
    const preset = presetCamera(transforms?.camera, transforms?.item);
    assert.ok(preset !== undefined, `${view} records its camera`);
    const scenePath = join(packageDirectory, manifest.scenes[0]!.fixture);
    const scene = JSON.parse(readFileSync(scenePath, "utf8")) as SceneFixture;
    const draw = JSON.parse(
      readFileSync(join(scenePath, "..", scene.draws![0]!), "utf8"),
    ) as DrawSpec;
    const file = (binding: number) => {
      const path = draw.descriptors.find(
        (entry) => entry.set === 0 && entry.binding === binding,
      )!.path!;

      return new Uint8Array(readFileSync(join(scenePath, "..", path)));
    };

    const perView = file(1);
    const csgo = file(3);
    const csgoFloats = new Float32Array(csgo.buffer, csgo.byteOffset, csgo.length / 4);
    const words = projectionWords(
      preset.projected,
      cableClampOf(csgoFloats[157]!, preset.projected),
    );
    const floats = new Float32Array(perView.buffer, perView.byteOffset, perView.length / 4);
    let exact = 0;
    let total = 0;
    let inverseError = 0;

    for (const [list, compiled] of [
      [words.perView, floats],
      [words.csgoView, csgoFloats],
    ] as const) {
      for (const { offset, values } of list) {
        values.forEach((value, index) => {
          const word = compiled[offset / 4 + index]!;
          total++;

          if (Math.fround(value) === word) {
            exact++;
          } else if (list === words.perView && offset === 64) {
            inverseError = Math.max(
              inverseError,
              Math.abs(value - word) / Math.max(1e-6, Math.abs(word)),
            );
          } else {
            assert.fail(`${view} word ${offset + index * 4}: ${value} is not ${word}`);
          }
        });
      }
    }

    t.diagnostic(
      `${view}: ${exact} of ${total} projection words exact; inverse relative error ${inverseError.toExponential(2)}`,
    );
    // The inverse is the one product the client computes numerically; the
    // rest is exact, and at the preset distance the engine writes the
    // compiled bytes themselves.
    assert.ok(inverseError < 1e-4);
    assert.deepEqual(
      cameraBufferBytes(
        preset,
        { yaw: 0, pitch: 0, distance: preset.distance },
        "perView",
        perView,
      ),
      perView,
    );
  }
});
