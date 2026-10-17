import assert from "node:assert/strict";
import test from "node:test";

import {
  type Catalog,
  inspectLinkIn,
  searchCharms,
  searchFinishes,
  searchStickers,
  stickerGroups,
  weapons,
} from "../src/catalog.ts";

const catalog: Catalog = {
  version: 1,
  finishes: [
    { defindex: 7, paintindex: 801, weapon: "AK-47", finish: "Asiimov" },
    { defindex: 9, paintindex: 279, weapon: "AWP", finish: "Asiimov" },
    { defindex: 7, paintindex: 282, weapon: "AK-47", finish: "Redline" },
  ],
  stickers: [
    { id: 1, name: "Team A (Holo) | Event 2026", effect: "holo", tournament: "Event 2026" },
    { id: 2, name: "Team A | Event 2026", effect: "paper", tournament: "Event 2026" },
    { id: 3, name: "Smile", collection: "Community" },
  ],
  charms: [{ id: 1, name: "Lil' Squirt" }],
};

test("finish search matches weapon and finish words, filtered by weapon", () => {
  assert.deepEqual(
    searchFinishes(catalog, "asii").map((entry) => entry.weapon),
    ["AWP", "AK-47"],
  );
  assert.deepEqual(
    searchFinishes(catalog, "ak red").map((entry) => entry.paintindex),
    [282],
  );
  assert.equal(searchFinishes(catalog, "asiimov", { weapon: "AWP" }).length, 1);
  assert.deepEqual(weapons(catalog), ["AK-47", "AWP"]);
});

test("sticker and charm search use names and filters", () => {
  assert.deepEqual(
    searchStickers(catalog, "holo").map((entry) => entry.id),
    [1],
  );
  assert.equal(searchStickers(catalog, "", { tournament: "Event 2026" }).length, 2);
  assert.deepEqual(stickerGroups(catalog), {
    tournaments: ["Event 2026"],
    collections: ["Community"],
  });
  assert.equal(searchCharms(catalog, "squirt").length, 1);
});

test("a pasted inspect link is detected", () => {
  const link = "steam://rungame/730/76561202255233023/+csgo_econ_action_preview%20A123D456";
  assert.equal(inspectLinkIn(`  ${link} `), link);
  assert.equal(inspectLinkIn("ak asiimov"), undefined);
});
