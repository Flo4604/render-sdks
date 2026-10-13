import test from "node:test";
import assert from "node:assert/strict";
import { imageUrl } from "../src/client.js";

const hash = "A".repeat(43);
const original = `https://img.medalbot.cc/v1/${hash}.webp`;
test("media helpers preserve the origin and select fixed WebP recipes", () => {
  for (const origin of [
    "https://img.medalbot.cc",
    "http://localhost:8080",
    "https://images.example:8443",
    "http://[::1]:8080",
  ])
    for (const format of ["webp", "png"])
      for (const variant of ["small", "card", "zoom"] as const)
        assert.equal(
          imageUrl(`${origin}/v1/${hash}.${format}`, variant),
          `${origin}/d/v1/${hash}_${variant}.webp`,
        );
  assert.equal(original, `https://img.medalbot.cc/v1/${hash}.webp`);
});

test("media helpers reject arbitrary URLs and noncanonical hashes", () => {
  const invalid = [
    `/v1/${hash}.webp`,
    original + "?",
    original + "?w=20",
    original + "#",
    original + "#x",
    original.replace("https:", "file:"),
    original.replace("img.medalbot.cc", "user:pass@img.medalbot.cc"),
    original.replace("img.medalbot.cc", "@img.medalbot.cc"),
    original.replace("img.medalbot.cc", "img.medalbot.cc:65536"),
    original.replace("/v1/", "/x/../v1/"),
    original.replace("/v1/", "/v1%2F"),
    original.replace(hash, hash.slice(0, -1) + "B"),
    original.replace(hash, hash + "="),
    original.replace(".webp", ".jpg"),
    original.replace(".webp", ".webp.webp"),
    original + "\n",
    " " + original,
    original.replace("img.medalbot.cc", "img.\u0000medalbot.cc"),
    original.replace("img.medalbot.cc", "img.\u00a0medalbot.cc"),
    original.replace("/v1/", "\\v1/"),
    imageUrl(original, "card"),
  ];
  for (const value of invalid)
    assert.throws(() => imageUrl(value, "card"), { name: "TypeError" });
  // @ts-expect-error Runtime callers must also receive a variant validation error.
  assert.throws(() => imageUrl(original, "huge"), { name: "TypeError" });
});
