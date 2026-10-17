import assert from "node:assert/strict";
import test from "node:test";

import { parseItem } from "../src/source.ts";

test("an item attribute parses like the API's item path", () => {
  assert.deepEqual(parseItem("7-801-661-1036831949"), {
    defindex: 7,
    paintindex: 801,
    paintseed: 661,
    paintwear: 1036831949,
  });
  assert.deepEqual(parseItem("7-801"), { defindex: 7, paintindex: 801 });
  assert.equal(parseItem("7"), undefined);
  assert.equal(parseItem("7-x-1"), undefined);
});
