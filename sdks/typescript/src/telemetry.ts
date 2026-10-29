// Identification headers and call timings. Every request names the SDK and carries a W3C
// traceparent whose trace id is fixed for one call. Unless the caller opts out, each finished
// call becomes one `sdk_call` event; events go to `POST /v1/telemetry/sdk` in batches, and a
// failed send is dropped. Nothing here throws into the caller or delays a render.

export const version = "0.1.6";

export type TelemetryOption = boolean | { sampleRate?: number };

const runtime = (() => {
  const versions = (
    globalThis as { process?: { versions?: Record<string, string> } }
  ).process?.versions;
  if (versions?.["bun"]) return `bun/${versions["bun"]}`;
  if (versions?.["deno"]) return `deno/${versions["deno"]}`;
  if (versions?.["node"]) return `node/${versions["node"]}`;
  return "browser/unknown";
})();
const os =
  (globalThis as { process?: { platform?: string } }).process?.platform ??
  "unknown";

export const identity = {
  "User-Agent": `medalbot-render-typescript/${version} (${runtime}; ${os})`,
  "X-Medalbot-SDK": `typescript/${version}`,
};

const hex = (bytes: number) =>
  Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");

export type Op = "render" | "wait" | "create" | "get" | "batch" | "lookup";

// What one call observed. HTTP time covers each attempt from send to the end of the body; the
// sleeps between polls and between retries are counted apart from it. `server_ms` sums the API's
// own `Server-Timing` over every response, so network and gateway time is `http_ms - server_ms`.
export class Call {
  readonly traceId = hex(16);
  readonly started = performance.now();
  readonly fields = {
    http_ms: 0,
    server_ms: 0,
    requests: 0,
    retries: 0,
    backoff_ms: 0,
    polls: 0,
    poll_wait_ms: 0,
  };
  ttfbMs: number | undefined;
  status = 0;
  requestId: string | undefined;
  serverTraceId: string | undefined;
  cache: string | undefined;
  renderId: string | undefined;

  constructor(
    readonly op: Op,
    readonly inflight: number,
    readonly views?: number,
  ) {}

  traceparent() {
    return `00-${this.traceId}-${hex(8)}-01`;
  }

  // One HTTP attempt that produced a response.
  response(response: Response, startedAt: number, headersAt: number) {
    this.fields.requests++;
    this.status = response.status;
    this.ttfbMs ??= headersAt - startedAt;
    this.fields.http_ms += performance.now() - startedAt;
    const timing = /(?:^|,)\s*app;dur=([\d.]+)/.exec(
      response.headers.get("Server-Timing") ?? "",
    );
    if (timing) this.fields.server_ms += Number(timing[1]);
    this.requestId ??= response.headers.get("X-Request-Id") ?? undefined;
    this.serverTraceId ??= response.headers.get("X-Trace-Id") ?? undefined;
    this.cache ??= response.headers.get("X-Render-Cache") ?? undefined;
  }

  // One HTTP attempt that failed before a response.
  failure(startedAt: number) {
    this.fields.requests++;
    this.fields.http_ms += performance.now() - startedAt;
  }

  event(error: unknown) {
    const fields: Record<string, string | number> = {
      op: this.op,
      outcome: error === undefined ? "ok" : "error",
      total_ms: Math.round(performance.now() - this.started),
      inflight: this.inflight,
      status: this.status,
      trace_id: this.traceId,
    };
    for (const [name, value] of Object.entries(this.fields))
      fields[name] = Math.round(value);
    if (error !== undefined) fields["code"] = errorCode(error);
    if (this.ttfbMs !== undefined) fields["ttfb_ms"] = Math.round(this.ttfbMs);
    if (this.views !== undefined) fields["views"] = this.views;
    if (this.requestId) fields["request_id"] = this.requestId.slice(0, 64);
    if (this.serverTraceId)
      fields["server_trace_id"] = this.serverTraceId.slice(0, 64);
    if (this.cache) fields["cache"] = this.cache.slice(0, 16);
    if (this.renderId) fields["render_id"] = this.renderId;
    return fields;
  }
}

const stableCode = (code: string) => {
  const lower = code.toLowerCase();
  return /^[a-z0-9_]{1,64}$/.test(lower) ? lower : "other";
};

function errorCode(error: unknown): string {
  if (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string"
  )
    return stableCode(error.code);
  const cause =
    error instanceof TypeError
      ? (error.cause as { code?: unknown })
      : undefined;
  if (typeof cause?.code === "string")
    return stableCode(`network_${cause.code}`);
  if (error instanceof Error && error.name === "AbortError") return "aborted";
  if (error instanceof Error && error.name === "TimeoutError") return "aborted";
  if (error instanceof Error && error.name === "ZodError")
    return "invalid_input";
  if (error instanceof TypeError) return "network_error";
  return "client_error";
}

// Calls at least this slow, and every failed call, are always reported, so the sample never
// hides the calls a customer complains about. The rest are reported at the sample rate.
const slowMs = 3000;
const maxBatch = 100;
const maxBuffered = 1000;
const flushMs = 10_000;

type Event = {
  name: "sdk_call";
  t: number;
  sample_rate: number;
  fields: Record<string, string | number>;
};

const live = new Set<Reporter>();
let exitHook = false;

export class Reporter {
  private buffer: Event[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private sending: Promise<void> = Promise.resolve();
  private stopped = false;
  private readonly session = hex(8);

  constructor(
    private readonly send: (body: string) => Promise<Response>,
    private readonly sampleRate: number,
    private readonly random: () => number = Math.random,
  ) {
    live.add(this);
    const proc = (
      globalThis as { process?: { once?: (e: string, f: () => void) => void } }
    ).process;
    if (!exitHook && typeof proc?.once === "function") {
      exitHook = true;
      proc.once("beforeExit", () => {
        for (const reporter of live) void reporter.flush();
      });
    }
  }

  record(call: Call, error: unknown) {
    if (this.stopped) return;
    try {
      const fields = call.event(error);
      const always =
        error !== undefined || Number(fields["total_ms"]) >= slowMs;
      if (!always && this.random() >= this.sampleRate) return;
      if (this.buffer.length >= maxBuffered) return;
      this.buffer.push({
        name: "sdk_call",
        t: Date.now(),
        sample_rate: always ? 1 : this.sampleRate,
        fields,
      });
      if (this.buffer.length >= maxBatch) void this.flush();
      else if (this.timer === undefined) {
        this.timer = setTimeout(() => void this.flush(), flushMs);
        (this.timer as { unref?: () => void }).unref?.();
      }
    } catch {
      // Telemetry never reaches the caller.
    }
  }

  // Sends every buffered event. Resolves when the sends finish, failed or not.
  flush(): Promise<void> {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    while (this.buffer.length > 0 && !this.stopped) {
      const events = this.buffer.splice(0, maxBatch);
      const body = JSON.stringify({
        schema: 1,
        session: this.session,
        sdk: {
          name: "typescript",
          version,
          runtime: runtime.slice(0, 57),
          os: os
            .toLowerCase()
            .replace(/[^a-z0-9_]/g, "_")
            .slice(0, 24),
        },
        events,
      });
      this.sending = this.sending.then(() =>
        this.send(body).then(
          (response) => {
            void response.body?.cancel().catch(() => undefined);
            // No route, or a key the route refuses: stop reporting for this client.
            if ([401, 403, 404, 410].includes(response.status)) this.stop();
          },
          () => undefined,
        ),
      );
    }
    return this.sending;
  }

  private stop() {
    this.stopped = true;
    this.buffer = [];
    live.delete(this);
  }
}

// The sample rate the options name, or undefined when telemetry is off. The client option
// decides; MEDALBOT_TELEMETRY=0 (or false, off) turns it off for every client in the process.
export function sampleRate(
  option: TelemetryOption | undefined,
): number | undefined {
  const env = (
    globalThis as { process?: { env?: Record<string, string | undefined> } }
  ).process?.env?.["MEDALBOT_TELEMETRY"];
  if (option === false) return undefined;
  if (
    env !== undefined &&
    ["0", "false", "off"].includes(env.trim().toLowerCase())
  )
    return undefined;
  const rate = typeof option === "object" ? (option.sampleRate ?? 0.25) : 0.25;
  if (!(rate > 0)) return undefined;
  return Math.min(1, rate);
}
