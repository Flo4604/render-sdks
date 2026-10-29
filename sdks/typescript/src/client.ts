import { z } from "zod";
import {
  RenderEnvelope,
  RenderBatchEnvelope,
  type RenderData,
  RenderId,
  RenderRequest,
  type RenderInput,
  ImageUrls as Images,
} from "./protocol.js";
import {
  Call,
  identity,
  Reporter,
  sampleRate,
  type Op,
  type TelemetryOption,
} from "./telemetry.js";
export class RenderError extends Error {
  constructor(
    readonly code: string,
    detail: string,
    readonly renderId?: string,
    readonly requestId?: string,
    readonly idempotencyKey?: string,
  ) {
    super(detail);
  }
}
export type WaitOptions = { signal?: AbortSignal; timeoutMs?: number };
export type RenderOptions = WaitOptions & { idempotencyKey?: string };
// `links: true` sends `Prefer: links`, so pending and completed render data carry a
// `links` map. Once the API returns links by default, the option changes nothing.
export type LinkOptions = { links?: boolean };
const prefer = (wait: boolean, links: boolean | undefined) => {
  const values = [...(wait ? ["wait=10"] : []), ...(links ? ["links"] : [])];
  return values.length > 0 ? { Prefer: values.join(", ") } : {};
};
const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const finish = () => {
      signal?.removeEventListener("abort", abort);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
export type ClientOptions = {
  baseUrl?: string;
  apiKey: string;
  fetch?: typeof fetch;
  // Call timings sent to the API; on by default. `false` turns them off, and
  // `{ sampleRate }` sets the share of fast, successful calls reported (default 0.25).
  telemetry?: TelemetryOption;
};
export class RenderClient {
  readonly renders;
  private readonly fetcher: typeof fetch;
  private readonly baseUrl: string;
  private readonly reporter: Reporter | undefined;
  private inflight = 0;
  constructor(private readonly options: ClientOptions) {
    this.fetcher = options.fetch ?? fetch;
    this.baseUrl = (options.baseUrl ?? "https://render.medalbot.cc").replace(
      /\/$/,
      "",
    );
    const rate = sampleRate(options.telemetry);
    this.reporter =
      rate === undefined
        ? undefined
        : new Reporter(
            (body) =>
              this.fetcher(`${this.baseUrl}/v1/telemetry/sdk`, {
                method: "POST",
                body,
                headers: {
                  ...identity,
                  Authorization: `Bearer ${options.apiKey}`,
                  "Content-Type": "application/json",
                },
                signal: AbortSignal.timeout(5000),
              }),
            rate,
          );
    this.renders = {
      create: (input: RenderInput, options: RenderOptions & LinkOptions = {}) =>
        this.observe("create", (call) =>
          this.submit(input, options, false, call),
        ),
      get: (id: string, options: WaitOptions & LinkOptions = {}) =>
        this.observe("get", (call) =>
          this.get(id, options.links, options.signal, call),
        ),
      wait: (id: string, options: WaitOptions = {}) =>
        this.observe("wait", (call) => this.wait(id, options, call)),
      batch: (
        requests: { request: RenderInput; idempotencyKey: string }[],
        options: WaitOptions & LinkOptions = {},
      ) =>
        this.observe("batch", async (call) =>
          RenderBatchEnvelope.parse(
            await this.request(
              "/v1/renders/batch",
              {
                method: "POST",
                headers: prefer(false, options.links),
                body: JSON.stringify({
                  requests: requests.map(({ request, idempotencyKey }) => ({
                    request: RenderRequest.parse(request),
                    idempotencyKey,
                  })),
                }),
                ...(options.signal ? { signal: options.signal } : {}),
              },
              call,
            ),
          ).data.renders.map((render) => {
            if (!render)
              throw new RenderError(
                "invalid_response",
                "An admitted render is missing",
              );
            return render;
          }),
        ),
      lookup: (ids: string[], options: WaitOptions & LinkOptions = {}) =>
        this.observe(
          "lookup",
          async (call) =>
            RenderBatchEnvelope.parse(
              await this.request(
                "/v1/renders/lookup",
                {
                  method: "POST",
                  headers: prefer(false, options.links),
                  body: JSON.stringify({ ids }),
                  ...(options.signal ? { signal: options.signal } : {}),
                },
                call,
              ),
            ).data.renders,
        ),
    };
  }
  // Sends buffered call timings now. Short-lived processes that exit without an empty event
  // loop, such as serverless handlers, can await it before returning.
  async flushTelemetry(): Promise<void> {
    await this.reporter?.flush();
  }
  private async observe<T>(
    op: Op,
    run: (call: Call) => Promise<T>,
    views?: number,
  ): Promise<T> {
    const call = new Call(op, this.inflight++, views);
    try {
      const result = await run(call);
      this.reporter?.record(call, undefined);
      return result;
    } catch (error) {
      this.reporter?.record(call, error);
      throw error;
    } finally {
      this.inflight--;
    }
  }
  private async get(
    id: string,
    links: boolean | undefined,
    signal: AbortSignal | undefined,
    call: Call,
  ) {
    return RenderEnvelope.parse(
      await this.request(
        `/v1/renders/${RenderId.parse(id)}`,
        {
          headers: prefer(false, links),
          ...(signal ? { signal } : {}),
        },
        call,
      ),
    ).data;
  }
  private async submit(
    input: RenderInput,
    options: RenderOptions & LinkOptions,
    wait: boolean,
    call: Call,
  ) {
    const data = RenderEnvelope.parse(
      await this.request(
        "/v1/renders",
        {
          method: "POST",
          body: JSON.stringify(RenderRequest.parse(input)),
          headers: {
            "Idempotency-Key": options.idempotencyKey ?? crypto.randomUUID(),
            ...prefer(wait, options.links),
          },
          ...(options.signal ? { signal: options.signal } : {}),
        },
        call,
      ),
    ).data;
    call.renderId = data.id;
    return data;
  }
  private async request(
    path: string,
    init: RequestInit,
    call: Call,
  ): Promise<unknown> {
    for (let attempt = 0; attempt < 4; attempt++) {
      let response: Response;
      const startedAt = performance.now();
      try {
        response = await this.fetcher(this.baseUrl + path, {
          ...init,
          headers: {
            ...identity,
            traceparent: call.traceparent(),
            Authorization: `Bearer ${this.options.apiKey}`,
            "Content-Type": "application/json",
            ...init.headers,
          },
        });
      } catch (error) {
        call.failure(startedAt);
        if (init.signal?.aborted || attempt === 3) throw error;
        await this.backoff(
          call,
          200 * 2 ** attempt + Math.random() * 100,
          init.signal ?? undefined,
        );
        continue;
      }
      const headersAt = performance.now();
      if ([429, 502, 503, 504].includes(response.status) && attempt < 3) {
        await response.body?.cancel();
        call.response(response, startedAt, headersAt);
        await this.backoff(
          call,
          Math.min(
            10000,
            Math.max(
              200,
              Number(response.headers.get("Retry-After") ?? 0) * 1000,
              200 * 2 ** attempt,
            ),
          ) +
            Math.random() * 100,
          init.signal ?? undefined,
        );
        continue;
      }
      const body: unknown = await response.json().catch(() => null);
      call.response(response, startedAt, headersAt);
      if (!response.ok) {
        const parsed = z
          .object({
            meta: z.object({ requestId: z.string() }).optional(),
            error: z.object({
              code: z.string().optional(),
              detail: z.string().optional(),
              message: z.string().optional(),
              type: z.string().optional(),
            }),
          })
          .safeParse(body);
        throw new RenderError(
          parsed.success
            ? (parsed.data.error.code ??
                parsed.data.error.type ??
                `http_${response.status}`)
            : `http_${response.status}`,
          parsed.success
            ? (parsed.data.error.detail ??
                parsed.data.error.message ??
                `API returned HTTP ${response.status}`)
            : `API returned HTTP ${response.status}`,
          undefined,
          parsed.success ? parsed.data.meta?.requestId : undefined,
        );
      }
      return body;
    }
    throw new Error("Unreachable retry state");
  }
  private async backoff(call: Call, ms: number, signal?: AbortSignal) {
    call.fields.retries++;
    const started = performance.now();
    try {
      await sleep(ms, signal);
    } finally {
      call.fields.backoff_ms += performance.now() - started;
    }
  }
  private async wait(
    id: string,
    options: WaitOptions,
    call: Call,
  ): Promise<z.infer<typeof Images>> {
    const timeout = AbortSignal.timeout(options.timeoutMs ?? 120000);
    const signal = options.signal
      ? AbortSignal.any([options.signal, timeout])
      : timeout;
    try {
      return await this.poll(id, signal, call);
    } catch (error) {
      if (timeout.aborted && !options.signal?.aborted)
        throw new RenderError(
          "wait_timeout",
          "Render continues; resume with renders.wait(renderId)",
          id,
        );
      throw error;
    }
  }
  private async poll(
    id: string,
    signal: AbortSignal,
    call: Call,
    initial?: RenderData,
  ) {
    call.renderId ??= id;
    let result = initial ?? (await this.get(id, undefined, signal, call));
    let interval = 500;
    for (;;) {
      signal.throwIfAborted();
      if ("images" in result) return result.images;
      if (result.status === "failed")
        throw new RenderError(result.error.code, result.error.detail, id);
      const waited = performance.now();
      try {
        await sleep(interval, signal);
      } finally {
        call.fields.poll_wait_ms += performance.now() - waited;
      }
      call.fields.polls++;
      result = await this.get(id, undefined, signal, call);
      interval = Math.min(2000, interval * 1.5);
    }
  }
  async render(
    input: RenderInput & { views?: undefined },
    options?: RenderOptions,
  ): Promise<Required<z.infer<typeof Images>>>;
  async render(
    input: RenderInput,
    options?: RenderOptions,
  ): Promise<z.infer<typeof Images>>;
  async render(
    input: RenderInput,
    options: RenderOptions = {},
  ): Promise<z.infer<typeof Images>> {
    return this.observe(
      "render",
      (call) => this.awaitRender(input, options, call),
      input.views?.length ?? 3,
    );
  }
  private async awaitRender(
    input: RenderInput,
    options: RenderOptions,
    call: Call,
  ): Promise<z.infer<typeof Images>> {
    const timeout = AbortSignal.timeout(options.timeoutMs ?? 120000);
    const signal = options.signal
      ? AbortSignal.any([options.signal, timeout])
      : timeout;
    let renderId: string | undefined;
    const idempotencyKey = options.idempotencyKey ?? crypto.randomUUID();
    try {
      signal.throwIfAborted();
      const request = await this.submit(
        input,
        { ...options, signal, idempotencyKey },
        true,
        call,
      );
      renderId = request.id;
      const images = await this.poll(request.id, signal, call, request);
      for (const view of input.views ?? ["preview", "front", "back"])
        if (!images[view])
          throw new RenderError(
            "invalid_response",
            `Completed render is missing ${view}`,
            request.id,
          );
      return images;
    } catch (error) {
      if (timeout.aborted && !options.signal?.aborted)
        throw new RenderError(
          "wait_timeout",
          renderId
            ? "Render continues; resume with renders.wait(renderId)"
            : "Submission timed out; retry with the same idempotency key",
          renderId,
          undefined,
          idempotencyKey,
        );
      throw error;
    }
  }
}

export type {
  Appearance,
  RenderInput,
  RenderData,
  ImageLinks,
  ImageUrls,
  View,
} from "./protocol.js";
export { imageUrl, type ImageVariant } from "./media.js";
export type { TelemetryOption } from "./telemetry.js";
