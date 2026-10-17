import assert from "node:assert/strict";
import test from "node:test";

import { decodeLz4Block, decodeVtexMips } from "../src/lz4.ts";
import { joinPath } from "../src/plan/walk.ts";

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

test("decodes an LZ4 block with an overlapping match", () => {
  // "abc", then a 9-byte match at distance 3, then the literal "x".
  const block = new Uint8Array([0x35, 97, 98, 99, 3, 0, 0x10, 120]);
  const output = new Uint8Array(13);
  decodeLz4Block(block, output);
  assert.equal(text(output), "abcabcabcabcx");
});

test("rejects a match before the start of the output", () => {
  assert.throws(() => decodeLz4Block(new Uint8Array([0x14, 97, 2, 0]), new Uint8Array(6)));
});

test("concatenates vtex mips from level 0 down", () => {
  // Stored smallest first: mip 1 ("z") at offset 0, mip 0 ("abcabcabcabcx") after it.
  const resource = new Uint8Array([122, 0x35, 97, 98, 99, 3, 0, 0x10, 120]);
  const words = decodeVtexMips(resource, [
    { offset: 1, storedBytes: 8, bytes: 13, compression: "lz4" },
    { offset: 0, storedBytes: 1, bytes: 1, compression: "none" },
  ]);
  assert.equal(text(words), "abcabcabcabcxz");
});

test("joins closure paths and refuses to leave the closure", () => {
  assert.equal(joinPath("items/abc", "../../blobs/x.json"), "blobs/x.json");
  assert.equal(joinPath("blobs", "/blobs/y.bin"), "blobs/y.bin");
  assert.throws(() => joinPath("items", "../../x"));
});
