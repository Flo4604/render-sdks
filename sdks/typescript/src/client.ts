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
export class RenderClient {
  readonly renders;
  private readonly fetcher: typeof fetch;
  constructor(
    private readonly options: {
      baseUrl?: string;
      apiKey: string;
      fetch?: typeof fetch;
    },
  ) {
    this.fetcher = options.fetch ?? fetch;
    this.renders = {
      create: (input: RenderInput, options: RenderOptions & LinkOptions = {}) =>
        this.submit(input, options, false),
      get: async (id: string, options: WaitOptions & LinkOptions = {}) =>
        RenderEnvelope.parse(
          await this.request(`/v1/renders/${RenderId.parse(id)}`, {
            headers: prefer(false, options.links),
            ...(options.signal ? { signal: options.signal } : {}),
          }),
        ).data,
      wait: (id: string, options: WaitOptions = {}) => this.wait(id, options),
      batch: async (
        requests: { request: RenderInput; idempotencyKey: string }[],
        options: WaitOptions & LinkOptions = {},
      ) =>
        RenderBatchEnvelope.parse(
          await this.request("/v1/renders/batch", {
            method: "POST",
            headers: prefer(false, options.links),
            body: JSON.stringify({
              requests: requests.map(({ request, idempotencyKey }) => ({
                request: RenderRequest.parse(request),
                idempotencyKey,
              })),
            }),
            ...(options.signal ? { signal: options.signal } : {}),
          }),
        ).data.renders.map((render) => {
          if (!render)
            throw new RenderError(
              "invalid_response",
              "An admitted render is missing",
            );
          return render;
        }),
      lookup: async (ids: string[], options: WaitOptions & LinkOptions = {}) =>
        RenderBatchEnvelope.parse(
          await this.request("/v1/renders/lookup", {
            method: "POST",
            headers: prefer(false, options.links),
            body: JSON.stringify({ ids }),
            ...(options.signal ? { signal: options.signal } : {}),
          }),
        ).data.renders,
    };
  }
  private async submit(
    input: RenderInput,
    options: RenderOptions & LinkOptions,
    wait: boolean,
  ) {
    return RenderEnvelope.parse(
      await this.request("/v1/renders", {
        method: "POST",
        body: JSON.stringify(RenderRequest.parse(input)),
        headers: {
          "Idempotency-Key": options.idempotencyKey ?? crypto.randomUUID(),
          ...prefer(wait, options.links),
        },
        ...(options.signal ? { signal: options.signal } : {}),
      }),
    ).data;
  }
  private async request(path: string, init: RequestInit): Promise<unknown> {
    for (let attempt = 0; attempt < 4; attempt++) {
      let response: Response;
      try {
        response = await this.fetcher(
          (this.options.baseUrl ?? "https://render.medalbot.cc").replace(
            /\/$/,
            "",
          ) + path,
          {
            ...init,
            headers: {
              Authorization: `Bearer ${this.options.apiKey}`,
              "Content-Type": "application/json",
              ...init.headers,
            },
          },
        );
      } catch (error) {
        if (init.signal?.aborted || attempt === 3) throw error;
        await sleep(
          200 * 2 ** attempt + Math.random() * 100,
          init.signal ?? undefined,
        );
        continue;
      }
      if ([429, 502, 503, 504].includes(response.status) && attempt < 3) {
        await response.body?.cancel();
        await sleep(
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
  private async wait(
    id: string,
    options: WaitOptions,
  ): Promise<z.infer<typeof Images>> {
    const timeout = AbortSignal.timeout(options.timeoutMs ?? 120000);
    const signal = options.signal
      ? AbortSignal.any([options.signal, timeout])
      : timeout;
    try {
      return await this.poll(id, signal);
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
  private async poll(id: string, signal: AbortSignal, initial?: RenderData) {
    let result = initial ?? (await this.renders.get(id, { signal }));
    let interval = 500;
    for (;;) {
      signal.throwIfAborted();
      if ("images" in result) return result.images;
      if (result.status === "failed")
        throw new RenderError(result.error.code, result.error.detail, id);
      await sleep(interval, signal);
      result = await this.renders.get(id, { signal });
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
      );
      renderId = request.id;
      const images = await this.poll(request.id, signal, request);
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
