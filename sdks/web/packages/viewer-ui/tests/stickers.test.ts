import assert from "node:assert/strict";
import test from "node:test";

import { editSticker } from "../src/capabilities.ts";

test("a sticker edit keeps the loaded scale and the other slots", () => {
  const loaded = [
    { slot: 0, id: 1, wear: 0, rotation: 0, scale: 1.2, offset: [0, 0] as [number, number] },
    { slot: 1, id: 2 },
  ];
  const edited = editSticker(loaded, 0, { rotation: 45, offset: [0.1, -0.2] });
  assert.deepEqual(edited[0], {
    slot: 0,
    id: 1,
    wear: 0,
    rotation: 45,
    scale: 1.2,
    offset: [0.1, -0.2],
  });
  assert.equal(edited[1], loaded[1]);
});
