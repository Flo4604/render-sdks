// Asset delivery. The engine reads an item's closure: a manifest naming the
// compile output files (by closure path and SHA-256) and the derived WGSL
// translations, and the files themselves addressed by their hash, so any
// HTTP cache or mirror can serve them forever.

// One applied sticker or charm as inspect data carries it. The kit (`sticker_id`) and slot pick
// the linked closure; a sticker's placement fields (`wear`, `rotation`, `scale`, `offset_x`,
// `offset_y`) are bound live. A charm's fields, its pattern and offsets included, are all
// closure identity, because its pose is solved by the server.
export interface InspectAttachment {
  slot: number;
  sticker_id: number;
  wear?: number;
  rotation?: number;
  scale?: number;
  offset_x?: number;
  offset_y?: number;
  offset_z?: number;
  pattern?: number;
  [field: string]: unknown;
}

export interface ItemSpec {
  defindex: number;
  paintindex: number;
  paintseed?: number;
  // The float32 wear as its uint32 bits, as the inspect data carries it.
  paintwear?: number;
  // Attachments select a linked closure (W61). Omitted means none.
  stickers?: InspectAttachment[];
  keychains?: InspectAttachment[];
  // The StatTrak counter (0 to 999999); present means the item has a counter module.
  killeatervalue?: number;
}

export type ItemRequest = ItemSpec | { inspectLink: string };

const placementFields = new Set(["wear", "rotation", "scale", "offset_x", "offset_y"]);

// The attachments that make up a linked closure's identity, as the executor's linker computes
// it (link/linker.cpp linkSpec): stickers without placement, charms as given and whether a
// counter is present. Undefined for an item without attachments.
export function closureLink(
  item: Pick<ItemSpec, "stickers" | "keychains" | "killeatervalue">,
): { stickers: unknown[]; keychains: unknown[]; stattrak: boolean } | undefined {
  const stickers = (item.stickers ?? []).map((sticker) =>
    Object.fromEntries(Object.entries(sticker).filter(([name]) => !placementFields.has(name))),
  );
  const keychains = item.keychains ?? [];
  const stattrak = item.killeatervalue !== undefined && item.killeatervalue !== null;

  if (stickers.length === 0 && keychains.length === 0 && !stattrak) {
    return undefined;
  }

  return { stickers, keychains, stattrak };
}

// The attachment fields of a request, or undefined without any.
export function requestAttachments(
  request: ItemRequest,
): Pick<ItemSpec, "stickers" | "keychains" | "killeatervalue"> | undefined {
  if ("inspectLink" in request || closureLink(request) === undefined) {
    return undefined;
  }

  return {
    ...(request.stickers === undefined ? {} : { stickers: request.stickers }),
    ...(request.keychains === undefined ? {} : { keychains: request.keychains }),
    ...(request.killeatervalue === undefined ? {} : { killeatervalue: request.killeatervalue }),
  };
}

export interface ClosureFile {
  sha256: string;
  bytes: number;
}

export interface ClosureManifest {
  version: 1;
  // Closure path of the item package (item.json).
  package: string;
  item: Record<string, unknown>;
  // Every file the package reads, by closure path.
  files: Record<string, ClosureFile>;
  // Draw id -> closure path of its translation (a TranslatedDraw JSON).
  translations: Record<string, string>;
  // Draw id -> closure path of its camera translation, for the free camera
  // (camera/live.ts). Optional; without it the viewer renders presets only.
  cameraTranslations?: Record<string, string>;
  // Identity of the translator that produced the translations.
  translator: string;
  // The inspect attributes the closure was requested with (the API adds them for an inspect
  // link): the engine binds their sticker placement and counter value after loading.
  itemData?: Record<string, unknown>;
}

export interface AssetFetcher {
  closure(request: ItemRequest, signal?: AbortSignal): Promise<ClosureManifest>;
  file(path: string, entry: ClosureFile, signal?: AbortSignal): Promise<Uint8Array>;
}

export interface HttpFetcherOptions {
  // Base URL of the closure service, for example https://api.example.com/v1/viewer.
  baseUrl: string;
  headers?: Record<string, string>;
  fetch?: typeof fetch;
}

const query = (request: ItemRequest): string => {
  if ("inspectLink" in request) {
    return `inspect=${encodeURIComponent(request.inspectLink)}`;
  }

  const parts = [`defindex=${request.defindex}`, `paintindex=${request.paintindex}`];

  if (request.paintseed !== undefined) {
    parts.push(`paintseed=${request.paintseed}`);
  }

  if (request.paintwear !== undefined) {
    parts.push(`paintwear=${request.paintwear}`);
  }

  const attachments = requestAttachments(request);

  if (attachments !== undefined) {
    parts.push(`attachments=${encodeURIComponent(JSON.stringify(attachments))}`);
  }

  return parts.join("&");
};

// GET {base}/closure?... for the manifest and GET {base}/files/{sha256} for
// each file. Files are immutable, so the fetcher lets the browser cache them.
export function httpFetcher(options: HttpFetcherOptions): AssetFetcher {
  const base = options.baseUrl.replace(/\/+$/, "");
  const get = options.fetch ?? globalThis.fetch.bind(globalThis);
  const headers = options.headers ?? {};

  return {
    async closure(request, signal) {
      const response = await get(`${base}/closure?${query(request)}`, {
        headers,
        ...(signal === undefined ? {} : { signal }),
      });

      if (!response.ok) {
        throw new Error(`Closure request failed with ${response.status}`);
      }

      return (await response.json()) as ClosureManifest;
    },

    async file(path, entry, signal) {
      const response = await get(`${base}/files/${entry.sha256}`, {
        headers,
        ...(signal === undefined ? {} : { signal }),
      });

      if (!response.ok) {
        throw new Error(`File ${path} failed with ${response.status}`);
      }

      const bytes = new Uint8Array(await response.arrayBuffer());

      if (bytes.length !== entry.bytes) {
        throw new Error(`File ${path} has ${bytes.length} bytes, expected ${entry.bytes}`);
      }

      return bytes;
    },
  };
}
