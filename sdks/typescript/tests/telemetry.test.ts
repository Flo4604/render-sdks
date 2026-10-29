import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { RenderClient, RenderError } from "../src/client.js";
import { version } from "../src/telemetry.js";

const id = "rnd_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const image = "https://img.medalbot.cc/example.webp";
const images = { preview: image, front: image, back: image };
const envelope = (data: unknown) => ({
  meta: { requestId: "req_fixture" },
  data,
});
const base = { baseUrl: "https://render.medalbot.cc", apiKey: "fixture" };

type Sent = { url: string; headers: Headers; body: string | undefined };

// A server that queues the render once, then completes it, and records every request.
function server(
  options: { telemetryStatus?: number; failRenders?: boolean } = {},
) {
  const sent: Sent[] = [];
  const fetch = async (url: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    sent.push({
      url: String(url),
      headers,
      body: typeof init?.body === "string" ? init.body : undefined,
    });
    if (String(url).endsWith("/v1/telemetry/sdk"))
      return new Response(null, { status: options.telemetryStatus ?? 202 });
    if (options.failRenders)
      return Response.json(
        {
          meta: { requestId: "req_failed" },
          error: { code: "unsupported_item", detail: "x" },
        },
        { status: 422, headers: { "X-Request-Id": "req_failed" } },
      );
    if (init?.method === "POST")
      return Response.json(envelope({ id, status: "queued" }), {
        status: 202,
        headers: {
          "X-Request-Id": "req_submit",
          "X-Trace-Id": "a".repeat(32),
          "X-Render-Cache": "miss",
          "Server-Timing": "app;dur=1890.25",
        },
      });
    return Response.json(envelope({ id, images }), {
      headers: { "X-Request-Id": "req_poll", "Server-Timing": "app;dur=3.5" },
    });
  };
  const telemetry = () =>
    sent
      .filter((request) => request.url.endsWith("/v1/telemetry/sdk"))
      .map((request) => JSON.parse(request.body ?? "{}"));
  return { sent, fetch, telemetry };
}

test("every request names the SDK and carries one trace per call", async () => {
  const { sent, fetch } = server();
  const client = new RenderClient({ ...base, fetch, telemetry: false });
  await client.render({ inspectUrl: "fixture" });
  await client.render({ inspectUrl: "fixture" });

  const traceparents = sent.map(
    (request) => request.headers.get("traceparent") ?? "",
  );
  for (const request of sent) {
    assert.match(
      request.headers.get("User-Agent") ?? "",
      new RegExp(
        `^medalbot-render-typescript/${version} \\(node/[\\d.]+; [a-z0-9]+\\)$`,
      ),
    );
    assert.equal(
      request.headers.get("X-Medalbot-SDK"),
      `typescript/${version}`,
    );
  }
  for (const value of traceparents)
    assert.match(value, /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
  const traceOf = (value: string) => value.split("-")[1];
  assert.equal(
    traceOf(traceparents[0]!),
    traceOf(traceparents[1]!),
    "submit and poll share a trace",
  );
  assert.notEqual(
    traceparents[0],
    traceparents[1],
    "each request has its own span",
  );
  assert.notEqual(
    traceOf(traceparents[0]!),
    traceOf(traceparents[2]!),
    "calls have their own trace",
  );
});

test("a render call reports its timings, server ids and request counts", async () => {
  const { sent, fetch, telemetry } = server();
  const client = new RenderClient({
    ...base,
    fetch,
    telemetry: { sampleRate: 1 },
  });
  assert.deepEqual(
    await client.render({ inspectUrl: "fixture", views: ["front"] }),
    images,
  );
  await client.flushTelemetry();

  const [batch] = telemetry();
  assert.equal(batch.schema, 1);
  assert.match(batch.session, /^[0-9a-f]{16}$/);
  assert.equal(batch.sdk.name, "typescript");
  assert.equal(batch.sdk.version, version);
  const [event] = batch.events;
  assert.equal(event.name, "sdk_call");
  assert.equal(event.sample_rate, 1);
  const fields = event.fields;
  assert.equal(fields.op, "render");
  assert.equal(fields.outcome, "ok");
  assert.equal(fields.views, 1);
  assert.equal(fields.requests, 2);
  assert.equal(fields.polls, 1);
  assert.equal(fields.retries, 0);
  assert.equal(fields.server_ms, 1894);
  assert.ok(fields.poll_wait_ms >= 450, `poll wait ${fields.poll_wait_ms}`);
  assert.ok(fields.total_ms >= fields.poll_wait_ms);
  assert.equal(typeof fields.ttfb_ms, "number");
  assert.equal(fields.request_id, "req_submit");
  assert.equal(fields.server_trace_id, "a".repeat(32));
  assert.equal(fields.cache, "miss");
  assert.equal(fields.render_id, id);
  assert.equal(
    fields.trace_id,
    sent[0]!.headers.get("traceparent")!.split("-")[1],
  );
  assert.equal(fields.inflight, 0);
  const report = sent.find((request) =>
    request.url.endsWith("/v1/telemetry/sdk"),
  )!;
  assert.equal(report.headers.get("Authorization"), "Bearer fixture");
  assert.ok(
    !report.body?.includes("fixture"),
    "neither the key nor the inspect link is reported",
  );
});

test("a failed call is always reported with its code, whatever the sample rate", async () => {
  const { fetch, telemetry } = server({ failRenders: true });
  const client = new RenderClient({
    ...base,
    fetch,
    telemetry: { sampleRate: 0.000001 },
  });
  await assert.rejects(
    client.render({ inspectUrl: "fixture" }),
    (error) =>
      error instanceof RenderError && error.code === "unsupported_item",
  );
  await client.flushTelemetry();

  const [event] = telemetry()[0].events;
  assert.equal(event.sample_rate, 1);
  assert.equal(event.fields.outcome, "error");
  assert.equal(event.fields.code, "unsupported_item");
  assert.equal(event.fields.status, 422);
  assert.equal(event.fields.request_id, "req_failed");
});

test("telemetry off sends nothing, from the option or the environment", async () => {
  for (const options of [{ telemetry: false }, {}] as const) {
    const previous = process.env["MEDALBOT_TELEMETRY"];
    if (!("telemetry" in options)) process.env["MEDALBOT_TELEMETRY"] = "0";
    try {
      const { telemetry, fetch } = server();
      const client = new RenderClient({ ...base, fetch, ...options });
      await client.render({ inspectUrl: "fixture" });
      await client.flushTelemetry();
      assert.deepEqual(telemetry(), []);
    } finally {
      if (previous === undefined) delete process.env["MEDALBOT_TELEMETRY"];
      else process.env["MEDALBOT_TELEMETRY"] = previous;
    }
  }
});

test("a refused or failing report never reaches the caller, and a 404 stops reports", async () => {
  const { fetch, telemetry } = server({ telemetryStatus: 404 });
  const client = new RenderClient({
    ...base,
    fetch,
    telemetry: { sampleRate: 1 },
  });
  await client.render({ inspectUrl: "fixture" });
  await client.flushTelemetry();
  await client.render({ inspectUrl: "fixture" });
  await client.flushTelemetry();
  assert.equal(telemetry().length, 1);

  const throwing = new RenderClient({
    ...base,
    telemetry: { sampleRate: 1 },
    fetch: async (url, init) => {
      if (String(url).endsWith("/v1/telemetry/sdk"))
        throw new TypeError("fetch failed");
      return fetch(url, init);
    },
  });
  await throwing.render({ inspectUrl: "fixture" });
  await throwing.flushTelemetry();
});

test("the reported version is the package version", () => {
  const manifest = JSON.parse(
    readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
  );
  assert.equal(version, manifest.version);
});
