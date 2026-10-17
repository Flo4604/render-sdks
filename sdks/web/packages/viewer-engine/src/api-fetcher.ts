// The asset fetcher for the Medalbot render API's closure contract:
//
//   GET {api}/v1/items/{item}/closure     the manifest, with the API key; revalidated by ETag
//   GET {fileBaseUrl}/{sha256}            each file, public, immutable and cacheable forever
//
// `{item}` is `{defindex}-{paintindex}-{paintseed}-{paintwear}` or a percent-encoded inspect
// link. A spec with stickers, charms or a counter adds `?attachments=<JSON>`, which selects the
// linked closure. The manifest names where its files are served; without that field the fetcher uses the
// API's redirect, `GET {api}/v1/closure-files/{sha256}`. Files are deduplicated by hash, checked
// against their length and SHA-256, and fetched with `cache: "force-cache"` because a
// content-addressed URL never changes.
//
// The key goes in `Authorization: Bearer`, the header the Unkey gateway reads. The API's CORS
// preflight for both closure routes allows it, so a browser page on another origin can send it.
// A public page should use a `closure:read` key, which reaches only these two routes and can be
// limited to the page's origins, or call through its own proxy and pass no key here.

import {
  type AssetFetcher,
  type ClosureFile,
  type ClosureManifest,
  type ItemRequest,
  requestAttachments,
} from "./fetcher.ts";

export interface ApiFetchProgress {
  // Distinct files (by hash) of the current closure, and the bytes they hold.
  files: number;
  bytes: number;
  filesDone: number;
  bytesDone: number;
}

export interface ApiFetcherOptions {
  // The API origin, for example https://api.medalbot.cc.
  baseUrl: string;
  apiKey?: string;
  headers?: Record<string, string>;
  fetch?: typeof fetch;
  // Check every file's SHA-256 after download (default true).
  verify?: boolean;
  // The request cache mode for content-addressed files (default "force-cache").
  fileCache?: RequestCache;
  onProgress?: (progress: ApiFetchProgress) => void;
}

// The manifest as the API returns it: the engine's manifest plus the closure's identity and the
// base URL of its files.
export interface ApiClosureManifest extends ClosureManifest {
  id: string;
  fileBaseUrl?: string;
  captureRevision?: string;
  viewPresetsSha256?: string;
  files: Record<string, ClosureFile & { mediaType?: string }>;
}

export class ApiFetchError extends Error {
  readonly status: number;

  readonly code: string;

  constructor(message: string, status: number, code: string) {
    super(message);
    this.name = "ApiFetchError";
    this.status = status;
    this.code = code;
  }
}

export function closureItemSegment(request: ItemRequest): string {
  if ("inspectLink" in request) {
    return encodeURIComponent(request.inspectLink);
  }

  return [
    request.defindex,
    request.paintindex,
    request.paintseed ?? 0,
    request.paintwear ?? 0,
  ].join("-");
}

// The manifest path of a request, relative to the API origin.
export function closurePath(request: ItemRequest): string {
  const attachments = requestAttachments(request);
  const path = `/v1/items/${closureItemSegment(request)}/closure`;

  if (attachments === undefined) {
    return path;
  }

  return `${path}?attachments=${encodeURIComponent(JSON.stringify(attachments))}`;
}

const hex = (bytes: ArrayBuffer) =>
  [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");

async function failure(response: Response, what: string): Promise<ApiFetchError> {
  let code = "http_error";
  let detail = `${what} failed with ${response.status}`;

  try {
    const body = (await response.json()) as { error?: { code?: string; detail?: string } };

    if (body.error?.code !== undefined) {
      code = body.error.code;
    }

    if (body.error?.detail !== undefined) {
      detail = `${what} failed with ${response.status}: ${body.error.detail}`;
    }
  } catch {
    // Not a problem document; keep the status line.
  }

  return new ApiFetchError(detail, response.status, code);
}

export class ApiAssetFetcher implements AssetFetcher {
  private readonly options: ApiFetcherOptions;

  private readonly base: string;

  private readonly get: typeof fetch;

  private readonly headers: Record<string, string>;

  private readonly files = new Map<string, Promise<Uint8Array>>();

  private readonly manifests = new Map<string, ApiClosureManifest>();

  private fileBase: string | undefined;

  private state: ApiFetchProgress = { files: 0, bytes: 0, filesDone: 0, bytesDone: 0 };

  constructor(options: ApiFetcherOptions) {
    this.options = options;
    this.base = options.baseUrl.replace(/\/+$/, "");
    this.get = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.headers = { ...options.headers };

    if (options.apiKey !== undefined) {
      this.headers.Authorization = `Bearer ${options.apiKey}`;
    }
  }

  progress(): ApiFetchProgress {
    return { ...this.state };
  }

  async closure(request: ItemRequest, signal?: AbortSignal): Promise<ApiClosureManifest> {
    const segment = closurePath(request);
    const cached = this.manifests.get(segment);
    const headers: Record<string, string> = { ...this.headers };

    if (cached !== undefined) {
      headers["If-None-Match"] = `"${cached.id}"`;
    }

    const response = await this.get(`${this.base}${segment}`, {
      headers,
      ...(signal === undefined ? {} : { signal }),
    });
    let manifest: ApiClosureManifest;

    if (response.status === 304 && cached !== undefined) {
      manifest = cached;
    } else if (response.ok) {
      const body = (await response.json()) as { data?: ApiClosureManifest };

      if (body.data?.version !== 1) {
        throw new ApiFetchError("The API returned an unknown closure version", 502, "bad_closure");
      }

      manifest = body.data;
      this.manifests.set(segment, manifest);
    } else {
      throw await failure(response, "Closure request");
    }

    this.fileBase = manifest.fileBaseUrl?.replace(/\/+$/, "");
    const unique = new Map(Object.values(manifest.files).map((file) => [file.sha256, file.bytes]));
    this.state = {
      files: unique.size,
      bytes: [...unique.values()].reduce((total, bytes) => total + bytes, 0),
      filesDone: 0,
      bytesDone: 0,
    };
    this.options.onProgress?.(this.progress());

    return manifest;
  }

  file(path: string, entry: ClosureFile, signal?: AbortSignal): Promise<Uint8Array> {
    const existing = this.files.get(entry.sha256);

    if (existing !== undefined) {
      return existing;
    }

    const loaded = this.download(path, entry, signal);
    this.files.set(entry.sha256, loaded);
    loaded.catch(() => this.files.delete(entry.sha256));

    return loaded;
  }

  private async download(
    path: string,
    entry: ClosureFile,
    signal: AbortSignal | undefined,
  ): Promise<Uint8Array> {
    // Public storage gets no credentials; the API's redirect route needs the key.
    const direct = this.fileBase !== undefined;
    const url = direct
      ? `${this.fileBase}/${entry.sha256}`
      : `${this.base}/v1/closure-files/${entry.sha256}`;
    const response = await this.get(url, {
      cache: this.options.fileCache ?? "force-cache",
      ...(direct ? {} : { headers: this.headers }),
      ...(signal === undefined ? {} : { signal }),
    });

    if (!response.ok) {
      throw await failure(response, `File ${path}`);
    }

    const bytes = await this.read(response, entry.bytes);

    if (bytes.length !== entry.bytes) {
      throw new ApiFetchError(
        `File ${path} has ${bytes.length} bytes, expected ${entry.bytes}`,
        502,
        "bad_file",
      );
    }

    if (this.options.verify !== false) {
      const digest = hex(await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>));

      if (digest !== entry.sha256) {
        throw new ApiFetchError(`File ${path} does not match its SHA-256`, 502, "bad_file");
      }
    }

    this.state.filesDone++;
    this.options.onProgress?.(this.progress());

    return bytes;
  }

  // Reads the body in chunks so byte progress moves during large downloads.
  private async read(response: Response, expected: number): Promise<Uint8Array> {
    if (response.body === null) {
      return new Uint8Array(0);
    }

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;

    for (;;) {
      const { done, value } = await reader.read();

      if (done) {
        break;
      }

      chunks.push(value);
      length += value.length;
      this.state.bytesDone += value.length;
      this.options.onProgress?.(this.progress());

      if (length > expected) {
        await reader.cancel();
        break;
      }
    }

    if (chunks.length === 1 && chunks[0] !== undefined) {
      return chunks[0];
    }

    const bytes = new Uint8Array(length);
    let offset = 0;

    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }

    return bytes;
  }
}

export function apiFetcher(options: ApiFetcherOptions): ApiAssetFetcher {
  return new ApiAssetFetcher(options);
}
