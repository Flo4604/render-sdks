import test from "node:test";
import assert from "node:assert/strict";
import { RenderClient, type Framing } from "../src/client.js";
import { RenderRequest, type RenderInput } from "../src/protocol.js";

const id = "rnd_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const images = { front: "https://img.medalbot.cc/example.webp" };
const completed = { id, images };
const envelope = (data: unknown) => ({
  meta: { requestId: "req_fixture" },
  data,
});
const framings: (Framing | undefined)[] = [
  undefined,
  "auto",
  "charm",
  "standard",
];

test("render, create and batch preserve optional framing on the wire", async () => {
  for (const framing of framings) {
    for (const method of ["render", "create", "batch"]) {
      let calls = 0;
      const client = new RenderClient({
        apiKey: "fixture",
        telemetry: false,
        fetch: async (_url, init) => {
          calls++;

          if (typeof init?.body !== "string") {
            throw new Error("Expected JSON request");
          }

          const expected = {
            inspectUrl: "fixture",
            views: ["front"],
            format: "webp",
            ...(framing === undefined ? {} : { framing }),
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
      const input: RenderInput = {
        inspectUrl: "fixture",
        views: ["front"],
        ...(framing === undefined ? {} : { framing }),
      };

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

test("unknown framing values fail before any request", async () => {
  let calls = 0;
  const client = new RenderClient({
    apiKey: "fixture",
    telemetry: false,
    fetch: async () => {
      calls++;
      throw new Error("Must not send");
    },
  });

  for (const framing of ["", "Charm", "unknown", null, false, 1]) {
    const input = { inspectUrl: "fixture", framing } as unknown as RenderInput;
    assert.equal(RenderRequest.safeParse(input).success, false);
    await assert.rejects(client.render(input));
    await assert.rejects(client.renders.create(input));
    await assert.rejects(
      client.renders.batch([{ request: input, idempotencyKey: "fixture" }]),
    );
  }

  assert.equal(calls, 0);
});
