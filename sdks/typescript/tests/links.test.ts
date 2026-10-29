import test from "node:test";
import assert from "node:assert/strict";
import { RenderClient, RenderError } from "../src/client.js";
import { Call } from "../src/telemetry.js";

const id = "rnd_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const image = "https://img.medalbot.cc/v1/example.webp";
const link =
  "https://img.medalbot.cc/r/v1/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const config = {
  baseUrl: "https://render.medalbot.cc",
  apiKey: "fixture",
  telemetry: false,
} as const;
const envelope = (data: unknown) => ({
  meta: { requestId: "req_fixture", region: "future" },
  data,
  future: true,
});
const pending = {
  id,
  status: "queued",
  links: { front: link },
  position: 3,
};
const completed = {
  id,
  images: { front: image },
  links: { front: image },
  cache: "hit",
};

function recording(responses: (() => Response)[]) {
  const prefers: (string | null)[] = [];
  const fetch: typeof globalThis.fetch = async (_url, init) => {
    prefers.push(new Headers(init?.headers).get("Prefer"));
    const next = responses.shift();
    if (!next) {
      throw new Error("Unexpected request");
    }
    return next();
  };
  return { prefers, fetch };
}

test("a 202 with links and unknown fields parses", async () => {
  const { fetch } = recording([
    () => Response.json(envelope(pending), { status: 202 }),
  ]);
  const client = new RenderClient({ ...config, fetch });
  const render = await client.renders.create({
    inspectUrl: "fixture",
    views: ["front"],
  });
  assert.ok(!("images" in render));
  assert.ok("status" in render && render.status === "queued");
  assert.deepEqual("links" in render ? render.links : undefined, {
    front: link,
  });
});

test("a completed render carries links equal to its images", async () => {
  const { fetch } = recording([() => Response.json(envelope(completed))]);
  const client = new RenderClient({ ...config, fetch });
  const render = await client.renders.get(id, { links: true });
  assert.ok("images" in render);
  assert.deepEqual(render.links, render.images);
});

test("render() completes on images and ignores links on pending data", async () => {
  const { fetch } = recording([
    () => Response.json(envelope(pending), { status: 202 }),
    () => Response.json(envelope(completed)),
  ]);
  const client = new RenderClient({ ...config, fetch });
  assert.deepEqual(
    await client.render({ inspectUrl: "fixture", views: ["front"] }),
    {
      front: image,
    },
  );
});

test("links: true sends Prefer: links on create, get, batch and lookup", async () => {
  const batch = () => Response.json(envelope({ renders: [pending] }));
  const { prefers, fetch } = recording([
    () => Response.json(envelope(pending), { status: 202 }),
    () => Response.json(envelope(pending)),
    batch,
    batch,
    () => Response.json(envelope(pending), { status: 202 }),
    () => Response.json(envelope(pending)),
    batch,
    batch,
  ]);
  const client = new RenderClient({ ...config, fetch });
  const requests = [
    { request: { inspectUrl: "fixture" }, idempotencyKey: "fixture-1" },
  ];
  await client.renders.create({ inspectUrl: "fixture" }, { links: true });
  await client.renders.get(id, { links: true });
  const [batched] = await client.renders.batch(requests, { links: true });
  const [looked] = await client.renders.lookup([id], { links: true });
  assert.deepEqual(batched && "links" in batched ? batched.links : undefined, {
    front: link,
  });
  assert.deepEqual(looked && "links" in looked ? looked.links : undefined, {
    front: link,
  });
  await client.renders.create({ inspectUrl: "fixture" });
  await client.renders.get(id);
  await client.renders.batch(requests);
  await client.renders.lookup([id]);
  assert.deepEqual(prefers, [
    "links",
    "links",
    "links",
    "links",
    null,
    null,
    null,
    null,
  ]);
});

test("the links preference composes with the wait preference", async () => {
  const { prefers, fetch } = recording([
    () => Response.json(envelope(completed)),
  ]);
  const client = new RenderClient({ ...config, fetch });
  // render() does not expose links; submit composes both values for callers that need it.
  const submit = (
    client as unknown as {
      submit: (
        input: unknown,
        options: unknown,
        wait: boolean,
        call: Call,
      ) => Promise<unknown>;
    }
  ).submit.bind(client);
  await submit(
    { inspectUrl: "fixture" },
    { links: true },
    true,
    new Call("create", 0),
  );
  assert.deepEqual(prefers, ["wait=10, links"]);
});

test("503 render_links_unavailable retries with the same idempotency key", async () => {
  const keys: (string | null)[] = [];
  let calls = 0;
  const client = new RenderClient({
    ...config,
    fetch: async (_url, init) => {
      keys.push(new Headers(init?.headers).get("Idempotency-Key"));
      calls++;
      if (calls === 1) {
        return Response.json(
          {
            meta: { requestId: "req_fixture" },
            error: {
              code: "render_links_unavailable",
              detail: "Render links are unavailable",
              status: 503,
              title: "Service Unavailable",
              type: "urn:skinicon:error:render_links_unavailable",
            },
          },
          { status: 503, headers: { "Retry-After": "0" } },
        );
      }
      return Response.json(envelope(pending), { status: 202 });
    },
  });
  const render = await client.renders.create(
    { inspectUrl: "fixture" },
    { links: true, idempotencyKey: "fixture-key" },
  );
  assert.equal(render.id, id);
  assert.equal(calls, 2);
  assert.deepEqual(keys, ["fixture-key", "fixture-key"]);
});

test("a persistent 503 render_links_unavailable surfaces its code", async () => {
  let calls = 0;
  const client = new RenderClient({
    ...config,
    fetch: async () => {
      calls++;
      return Response.json(
        {
          meta: { requestId: "req_fixture" },
          error: {
            code: "render_links_unavailable",
            detail: "Render links are unavailable",
          },
        },
        { status: 503, headers: { "Retry-After": "0" } },
      );
    },
  });
  await assert.rejects(
    client.renders.create({ inspectUrl: "fixture" }, { links: true }),
    (error) =>
      error instanceof RenderError && error.code === "render_links_unavailable",
  );
  assert.equal(calls, 4);
});
