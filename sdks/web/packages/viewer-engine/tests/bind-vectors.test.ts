// The engine's request binder against the executor's acceptance vectors
// (tools/standalone-renderer/native/tests/data/bind-vectors.json): every case
// must return the listed updates, keys in order with identical bytes, or fail
// with the listed code and attribute, as bind_vectors_test requires of the C++.

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  BindError,
  bindingSlice,
  bindRequest,
  wearBits,
  wearFromBits,
} from "../src/bind/binding.ts";
import { cosf, powfPositive, sinf } from "../src/bind/float-math.ts";
import { randomStream } from "../src/bind/random.ts";

interface Vector {
  name: string;
  item_data: Record<string, unknown>;
  updates?: Array<{ key: string; bytes: string }>;
  error?: { code: string; attribute: string };
}

interface VectorFile {
  version: number;
  items: Array<{ name: string; package: unknown; vectors: Vector[] }>;
}

// From the package directory, in source and in dist.
const candidates = [
  "../../../tools/standalone-renderer/native/tests/data/bind-vectors.json",
  "../../../../tools/standalone-renderer/native/tests/data/bind-vectors.json",
].map((relative) => join(fileURLToPath(new URL(".", import.meta.url)), "..", relative));
const vectorPath = candidates.find((path) => existsSync(path));

test("binds every case of bind-vectors.json like the executor", (t) => {
  if (vectorPath === undefined) {
    t.skip("bind-vectors.json is not in this checkout");

    return;
  }

  const vectors = JSON.parse(readFileSync(vectorPath, "utf8")) as VectorFile;
  assert.equal(vectors.version, 2);
  let passed = 0;
  let rejected = 0;
  let updates = 0;

  for (const item of vectors.items) {
    const slice = bindingSlice(item.package);

    for (const vector of item.vectors) {
      const label = `${item.name}: ${vector.name}`;

      if (vector.error !== undefined) {
        assert.throws(
          () => bindRequest(slice, vector.item_data),
          (error: unknown) =>
            error instanceof BindError &&
            error.code === vector.error?.code &&
            error.attribute === vector.error.attribute,
          label,
        );
        rejected++;
        continue;
      }

      const result = bindRequest(slice, vector.item_data);
      assert.deepEqual(result, vector.updates, label);
      passed++;
      updates += result.length;
    }
  }

  t.diagnostic(`${passed} cases with ${updates} identical updates, ${rejected} rejected`);
  assert.equal(passed + rejected, 118);
});

test("keeps the float kernels and the generator on fixed values", () => {
  const draw = randomStream(661);
  const first = draw(0, 1);
  assert.ok(first >= 0 && first < 1);
  assert.equal(Math.fround(first), first);
  assert.equal(sinf(0), 0);
  assert.equal(cosf(0), 1);
  assert.equal(powfPositive(4, 0.5), 2);
  assert.equal(wearFromBits(wearBits(0.1)), Math.fround(0.1));
  assert.equal(wearBits(0.1), 1036831949);
});
