// Where an embed gets its closure from, and how an item is written in an
// attribute.

import {
  type AssetFetcher,
  apiFetcher,
  httpFetcher,
  type ItemRequest,
} from "@medalbot/viewer-engine";

export type ViewerSource =
  // The render API's closure routes, with a scoped `closure:read` key.
  | { api: string; apiKey?: string }
  // A closure service with the dev server's contract (/closure, /files/{sha256}).
  | { closureUrl: string }
  // Any fetcher, including the embedder's own.
  | { fetcher: AssetFetcher };

export function fetcherFor(source: ViewerSource): AssetFetcher {
  if ("fetcher" in source) {
    return source.fetcher;
  }

  if ("closureUrl" in source) {
    return httpFetcher({ baseUrl: source.closureUrl });
  }

  return apiFetcher({
    baseUrl: source.api,
    ...(source.apiKey === undefined ? {} : { apiKey: source.apiKey }),
  });
}

// "7-801-661-1036831949": defindex, paintindex, then the optional paint seed
// and wear bits, as the API's item path writes them.
export function parseItem(value: string): ItemRequest | undefined {
  const parts = value.trim().split("-");

  if (parts.length < 2 || parts.length > 4 || parts.some((part) => !/^\d+$/.test(part))) {
    return undefined;
  }

  const [defindex, paintindex, paintseed, paintwear] = parts.map(Number);

  return {
    defindex: defindex as number,
    paintindex: paintindex as number,
    ...(paintseed === undefined ? {} : { paintseed }),
    ...(paintwear === undefined ? {} : { paintwear }),
  };
}
