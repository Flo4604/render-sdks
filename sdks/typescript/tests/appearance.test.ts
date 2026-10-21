import test from "node:test";
import assert from "node:assert/strict";
import { RenderClient, RenderError, type Appearance } from "../src/client.js";
import { RenderRequest } from "../src/protocol.js";

const id = "rnd_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const images = { front: "https://img.medalbot.cc/example.webp" };
const completed = { id, images };
const envelope = (data: unknown) => ({
  meta: { requestId: "req_fixture" },
  data,
});
const appearances: (Appearance | undefined)[] = [
  undefined,
  "default",
  "pattern",
];

test("render, create and batch preserve optional appearance on the wire", async () => {
  for (const appearance of appearances) {
    for (const method of ["render", "create", "batch"]) {
      let calls = 0;
      const client = new RenderClient({
        apiKey: "fixture",
        fetch: async (_url, init) => {
          calls++;
          assert.equal(typeof init?.body, "string");

          if (typeof init?.body !== "string") {
            throw new Error("Expected JSON request");
          }

          const expected = {
            inspectUrl: "fixture",
            views: ["front"],
            format: "webp",
            ...(appearance === undefined ? {} : { appearance }),
          };
          const body: unknown = JSON.parse(init.body);
          assert.deepEqual(
            body,
            method === "batch"
              ? { requests: [{ request: expected, idempotencyKey: "fixture" }] }
              : expected,
          );

          return Response.json(
            envelope(method === "batch" ? { renders: [completed] } : completed),
          );
        },
      });
      const input = RenderRequest.parse({
        inspectUrl: "fixture",
        views: ["front"],
        appearance,
      });

      if (method === "render") {
        assert.deepEqual(await client.render(input), images);
      } else if (method === "create") {
        assert.deepEqual(await client.renders.create(input), completed);
      } else {
        assert.deepEqual(
          await client.renders.batch([
            { request: input, idempotencyKey: "fixture" },
          ]),
          [completed],
        );
      }

      assert.equal(calls, 1);
    }
  }
});

test("appearance rejects unknown and non-string values", () => {
  for (const appearance of ["", "Pattern", "unknown", null, false, 1]) {
    assert.equal(
      RenderRequest.safeParse({ inspectUrl: "fixture", appearance }).success,
      false,
    );
  }
});

test("unsupported views retain the server error without retry or fallback", async () => {
  for (const views of [undefined, ["preview", "front", "back"]]) {
    let calls = 0;
    const client = new RenderClient({
      apiKey: "fixture",
      fetch: async (_url, init) => {
        calls++;

        if (typeof init?.body !== "string") {
          throw new Error("Expected JSON request");
        }

        const body: unknown = JSON.parse(init.body);
        assert.deepEqual(body, {
          inspectUrl: "fixture",
          views: ["preview", "front", "back"],
          format: "webp",
          appearance: "pattern",
        });

        return Response.json(
          {
            meta: { requestId: "req_fixture" },
            error: {
              code: "unsupported_appearance",
              detail: "No preset for the requested views",
            },
          },
          { status: 422 },
        );
      },
    });
    const input = RenderRequest.parse({
      inspectUrl: "fixture",
      views,
      appearance: "pattern",
    });
    await assert.rejects(
      client.render(input),
      (error) =>
        error instanceof RenderError &&
        error.code === "unsupported_appearance" &&
        error.requestId === "req_fixture",
    );
    assert.equal(calls, 1);
  }
});
