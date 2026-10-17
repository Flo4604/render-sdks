import assert from "node:assert/strict";
import test from "node:test";

import { shortcutFor } from "../src/keyboard.ts";

const key = (value: string, shiftKey = false) => ({
  key: value,
  shiftKey,
  altKey: false,
  ctrlKey: false,
  metaKey: false,
});

test("number keys pick views and letters run actions", () => {
  const context = { onStage: false, camera: false };
  assert.deepEqual(shortcutFor(key("2"), context), { kind: "view", index: 1 });
  assert.equal(shortcutFor(key("0"), context), undefined);
  assert.deepEqual(shortcutFor(key("0"), { onStage: false, camera: true }), {
    kind: "view",
    index: 0,
  });
  assert.deepEqual(shortcutFor(key("h"), context), { kind: "hide-ui" });
  assert.deepEqual(shortcutFor(key("f"), context), { kind: "fullscreen" });
  assert.deepEqual(shortcutFor(key("]", true), context), { kind: "wear", step: 0.1 });
  assert.equal(shortcutFor(key("ArrowLeft"), context), undefined);
});

test("arrow keys orbit with a camera and step views without one", () => {
  assert.deepEqual(shortcutFor(key("ArrowRight"), { onStage: true, camera: false }), {
    kind: "next-view",
    step: 1,
  });
  assert.deepEqual(shortcutFor(key("ArrowUp"), { onStage: true, camera: true }), {
    kind: "orbit",
    yaw: 0,
    pitch: -5,
  });
  assert.equal(
    shortcutFor({ ...key("f"), metaKey: true }, { onStage: true, camera: true }),
    undefined,
  );
});
