import assert from "node:assert/strict";
import test from "node:test";

import { controlNames, regions, resolveControls } from "../src/regions.ts";

test("controls are visible unless hidden", () => {
  const resolved = resolveControls({ seed: false, badge: false }, { readOnly: true });
  assert.equal(resolved.visible.seed, false);
  assert.equal(resolved.visible.badge, false);
  assert.equal(resolved.visible.wear, true);
  assert.equal(resolved.readOnly, true);
  assert.equal(resolved.density, "full");
  assert.equal(Object.keys(resolved.visible).length, controlNames.length);
});

test("region names are unique part and slot names", () => {
  assert.equal(new Set(regions).size, regions.length);

  for (const name of regions) {
    assert.match(name, /^[a-z]+(-[a-z]+)*$/);
  }
});
