import test from "node:test";
import assert from "node:assert/strict";
import {
  RenderClient,
  RenderError,
  RenderExpiredError,
} from "../src/client.js";

const id = "rnd_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const image = "https://img.medalbot.cc/v1/example.webp";
const retainUntil = "2026-11-23T13:00:00.000Z";
const config = {
  baseUrl: "https://render.medalbot.cc",
  apiKey: "fixture",
  telemetry: false,
} as const;
const envelope = (data: unknown) => ({ meta: { requestId: "req_fixture" }, data });
const expired = () =>
  Response.json(
    {
      meta: { requestId: "req_expired" },
      error: {
        status: 410,
        code: "render_expired",
        title: "Gone",
        detail: "The render's retention ended",
        type: "urn:skinicon:error:render_expired",
      },
    },
    { status: 410 },
  );

function recording(responses: (() => Response)[]) {
  const requests: { method: string; url: string; body: unknown }[] = [];
  const fetch: typeof globalThis.fetch = async (url, init) => {
    requests.push({
      method: init?.method ?? "GET",
      url: String(url),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    const next = responses.shift();
    if (!next) {
      throw new Error("Unexpected request");
    }
    return next();
  };
  return { requests, fetch };
}

test("retentionSeconds is sent as given, null included, and omitted otherwise", async () => {
  const completed = () =>
    Response.json(envelope({ id, images: { front: image }, retainUntil }));
  const { requests, fetch } = recording([completed, completed, completed]);
  const client = new RenderClient({ ...config, fetch });

  const kept = await client.renders.create({
    inspectUrl: "fixture",
    views: ["front"],
    retentionSeconds: 3600,
  });
  await client.renders.create({
    inspectUrl: "fixture",
    views: ["front"],
    retentionSeconds: null,
  });
  await client.renders.create({ inspectUrl: "fixture", views: ["front"] });

  assert.equal(
    (requests[0]?.body as { retentionSeconds?: unknown }).retentionSeconds,
    3600,
  );
  assert.equal(
    (requests[1]?.body as { retentionSeconds?: unknown }).retentionSeconds,
    null,
  );
  assert.ok(!("retentionSeconds" in (requests[2]?.body as object)));
  assert.ok("images" in kept);
  assert.equal(kept.retainUntil, retainUntil);
});

test("retentionSeconds outside one hour to 30 days is rejected before sending", async () => {
  const { requests, fetch } = recording([]);
  const client = new RenderClient({ ...config, fetch });

  for (const retentionSeconds of [3599, 2592001, 3600.5]) {
    await assert.rejects(
      client.renders.create({ inspectUrl: "fixture", retentionSeconds }),
    );
  }
  assert.equal(requests.length, 0);
});

test("delete sends DELETE and accepts an empty 204", async () => {
  const { requests, fetch } = recording([
    () => new Response(null, { status: 204 }),
  ]);
  const client = new RenderClient({ ...config, fetch });

  assert.equal(await client.renders.delete(id), undefined);
  assert.deepEqual(
    requests.map(({ method, url }) => [method, url]),
    [["DELETE", `https://render.medalbot.cc/v1/renders/${id}`]],
  );
});

test("a 410 render_expired throws RenderExpiredError once, without a retry", async () => {
  const { requests, fetch } = recording([expired]);
  const client = new RenderClient({ ...config, fetch });

  const error = await client.renders.get(id).catch((caught: unknown) => caught);

  assert.ok(error instanceof RenderExpiredError);
  assert.ok(error instanceof RenderError);
  assert.equal(error.code, "render_expired");
  assert.equal(error.requestId, "req_expired");
  assert.equal(requests.length, 1);
});

test("an expired batch entry fails alone and wait() throws RenderExpiredError", async () => {
  const failed = {
    id,
    status: "failed",
    error: { code: "render_expired", detail: "The render's retention ended" },
  };
  const { fetch } = recording([
    () =>
      Response.json(envelope({ renders: [failed, { id, images: { front: image } }] })),
    () => Response.json(envelope(failed)),
  ]);
  const client = new RenderClient({ ...config, fetch });

  const [first, second] = await client.renders.lookup([id, id]);
  assert.ok(first && "status" in first && first.status === "failed");
  assert.equal(first.error.code, "render_expired");
  assert.ok(second && "images" in second);

  const error = await client.renders.wait(id).catch((caught: unknown) => caught);
  assert.ok(error instanceof RenderExpiredError);
  assert.equal(error.renderId, id);
});
