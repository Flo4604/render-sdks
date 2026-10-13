import test from "node:test";
import assert from "node:assert/strict";
import { RenderClient, RenderError } from "../src/client.js";

const id = "rnd_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const image = "https://img.medalbot.cc/example.webp";
const envelope = (data: unknown) => ({
  meta: { requestId: "req_fixture" },
  data,
});
const images = { preview: image, front: image, back: image };
const completed = {
  id,
  images,
};
const queued = {
  id,
  status: "queued",
};
const config = { baseUrl: "https://render.medalbot.cc", apiKey: "fixture" };

test("StatTrak serializes explicit zero and omits an unspecified counter", async () => {
  for (const statTrak of [undefined, 0, 1337, 999999]) {
    const client = new RenderClient({
      ...config,
      fetch: async (_url, init) => {
        assert.equal(typeof init?.body, "string");
        if (typeof init?.body !== "string")
          throw new Error("Expected JSON request");
        const body = JSON.parse(init.body);
        assert.equal(Object.hasOwn(body, "statTrak"), statTrak !== undefined);
        assert.equal(body.statTrak, statTrak);
        return Response.json(envelope(completed));
      },
    });
    assert.deepEqual(
      await client.render({ inspectUrl: "fixture", statTrak }),
      images,
    );
  }
});

test("invalid StatTrak counts fail before HTTP submission", async () => {
  let calls = 0;
  const client = new RenderClient({
    ...config,
    fetch: async () => {
      calls++;
      return Response.json(envelope(completed));
    },
  });
  for (const statTrak of [-1, 1.5, 1000000, NaN, Infinity]) {
    await assert.rejects(client.render({ inspectUrl: "fixture", statTrak }));
  }
  assert.equal(calls, 0);
});

test("gateway and API error envelopes preserve request IDs", async () => {
  for (const error of [
    {
      code: "unauthorized",
      detail: "Invalid key",
      status: 401,
      title: "Unauthorized",
      type: "urn:skinicon:error:unauthorized",
    },
    { code: "unauthorized", message: "Invalid key" },
  ]) {
    const client = new RenderClient({
      ...config,
      fetch: async () =>
        Response.json(
          { meta: { requestId: "req_fixture" }, error },
          { status: 401 },
        ),
    });
    await assert.rejects(
      client.render({ inspectUrl: "fixture" }),
      (e) =>
        e instanceof RenderError &&
        e.code === "unauthorized" &&
        e.requestId === "req_fixture" &&
        e.message === "Invalid key",
    );
  }
});

test("await render returns the same images for cached and queued work", async () => {
  const calls: { method: string; prefer: string | null }[] = [];
  let submitted = false;
  const client = new RenderClient({
    ...config,
    fetch: async (_url, init) => {
      calls.push({
        method: init?.method ?? "GET",
        prefer: new Headers(init?.headers).get("Prefer"),
      });
      if (!submitted) {
        submitted = true;
        return Response.json(envelope(queued), { status: 202 });
      }
      return Response.json(envelope(completed));
    },
  });
  assert.deepEqual(await client.render({ inspectUrl: "fixture" }), images);
  assert.deepEqual(await client.render({ inspectUrl: "fixture" }), images);
  assert.deepEqual(calls, [
    { method: "POST", prefer: "wait=10" },
    { method: "GET", prefer: null },
    { method: "POST", prefer: "wait=10" },
  ]);
});

test("render timeout bounds the initial submission", async () => {
  const client = new RenderClient({
    ...config,
    fetch: (_url, init) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => resolve(Response.json(envelope(completed))),
          100,
        );
        init?.signal?.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            reject(init.signal?.reason);
          },
          { once: true },
        );
      }),
  });
  await assert.rejects(
    client.render({ inspectUrl: "fixture" }, { timeoutMs: 10 }),
    (error) => error instanceof RenderError && error.code === "wait_timeout",
  );
});

test("a timeout after admission preserves the render ID", async () => {
  const client = new RenderClient({
    ...config,
    fetch: async () => Response.json(envelope(queued), { status: 202 }),
  });
  await assert.rejects(
    client.render({ inspectUrl: "fixture" }, { timeoutMs: 10 }),
    (error) =>
      error instanceof RenderError &&
      error.code === "wait_timeout" &&
      error.renderId === id,
  );
});

test("terminal render failure rejects without another request", async () => {
  let calls = 0;
  const client = new RenderClient({
    ...config,
    fetch: async () => {
      calls++;
      return Response.json(
        envelope({
          ...queued,
          status: "failed",
          error: { code: "render_failed", detail: "fixture" },
        }),
      );
    },
  });
  await assert.rejects(
    client.render({ inspectUrl: "fixture" }),
    (error) =>
      error instanceof RenderError &&
      error.code === "render_failed" &&
      error.renderId === id,
  );
  assert.equal(calls, 1);
});

test("a cancelled call does not submit work", async () => {
  let calls = 0;
  const reason = new Error("Caller stopped waiting");
  const client = new RenderClient({
    ...config,
    fetch: async () => {
      calls++;
      return Response.json(envelope(completed));
    },
  });
  await assert.rejects(
    client.render(
      { inspectUrl: "fixture" },
      { signal: AbortSignal.abort(reason) },
    ),
    (error) => error === reason,
  );
  assert.equal(calls, 0);
});
