import assert from "node:assert/strict";
import test from "node:test";

import { clampSeed, formatWear, wearTier } from "../src/wear.ts";

test("wear tiers follow the game's bounds", () => {
  assert.equal(wearTier(0).short, "FN");
  assert.equal(wearTier(0.0699).short, "FN");
  assert.equal(wearTier(0.07).short, "MW");
  assert.equal(wearTier(0.1).name, "Minimal Wear");
  assert.equal(wearTier(0.38).short, "WW");
  assert.equal(wearTier(0.45).short, "BS");
  assert.equal(wearTier(1).short, "BS");
});

test("seed and wear format for display", () => {
  assert.equal(clampSeed(1200), 1000);
  assert.equal(clampSeed(-3), 0);
  assert.equal(clampSeed(41.6), 42);
  assert.equal(formatWear(0.1), "0.100000");
});
