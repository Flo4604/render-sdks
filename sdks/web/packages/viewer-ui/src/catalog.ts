// The item catalog the pickers search: every weapon and finish combination,
// stickers and charms, with names and thumbnails. It is one content-addressed
// JSON file served like a closure file, fetched once and searched in the
// browser. The API endpoint that publishes it is a separate task; the
// showcase reads a local file through the same interface.

export interface FinishEntry {
  defindex: number;
  paintindex: number;
  weapon: string;
  finish: string;
  thumbnail?: string;
  // Weapon category for the picker's filters, for example "Rifles" or "Knives".
  category?: string;
  rarity?: string;
  rarityColor?: string;
  // The finish's float range, when the game limits it.
  wear?: { min: number; max: number };
}

export type StickerEffect = "paper" | "glitter" | "holo" | "foil" | "gold" | "lenticular";

export interface StickerEntry {
  id: number;
  name: string;
  thumbnail?: string;
  rarityColor?: string;
  effect?: StickerEffect;
  tournament?: string;
  collection?: string;
}

export interface CharmEntry {
  id: number;
  name: string;
  thumbnail?: string;
  collection?: string;
  rarityColor?: string;
}

export interface Catalog {
  version: 1;
  finishes: FinishEntry[];
  stickers: StickerEntry[];
  charms: CharmEntry[];
}

export interface CatalogSource {
  load(signal?: AbortSignal): Promise<Catalog>;
}

function checked(value: unknown): Catalog {
  const catalog = value as Partial<Catalog>;

  if (
    catalog.version !== 1 ||
    !Array.isArray(catalog.finishes) ||
    !Array.isArray(catalog.stickers) ||
    !Array.isArray(catalog.charms)
  ) {
    throw new Error("The catalog is not a version 1 catalog");
  }

  return catalog as Catalog;
}

// A catalog JSON at a URL, for development and self-hosting.
export function urlCatalog(url: string, init: RequestInit = {}): CatalogSource {
  return {
    async load(signal) {
      const response = await fetch(url, { ...init, ...(signal === undefined ? {} : { signal }) });

      if (!response.ok) {
        throw new Error(`The catalog request failed with ${response.status}`);
      }

      return checked(await response.json());
    },
  };
}

// The published catalog: a closure file named by its SHA-256, served
// immutably from the file host. The bytes are checked against the hash.
export function closureCatalog(options: { fileBaseUrl: string; sha256: string }): CatalogSource {
  const url = `${options.fileBaseUrl.replace(/\/+$/, "")}/${options.sha256}`;

  return {
    async load(signal) {
      const response = await fetch(url, {
        cache: "force-cache",
        ...(signal === undefined ? {} : { signal }),
      });

      if (!response.ok) {
        throw new Error(`The catalog file failed with ${response.status}`);
      }

      const bytes = new Uint8Array(await response.arrayBuffer());
      const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
      const hex = [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");

      if (hex !== options.sha256) {
        throw new Error("The catalog file does not match its hash");
      }

      return checked(JSON.parse(new TextDecoder().decode(bytes)));
    },
  };
}

// A pasted CS2 inspect link, in any of the forms Steam writes.
export function inspectLinkIn(text: string): string | undefined {
  const match = /(steam:\/\/rungame\/730\/\S+|csgo_econ_action_preview\s*\S+)/i.exec(text.trim());

  return match?.[1];
}

function tokens(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[\s|]+/)
    .filter((token) => token.length > 0);
}

// Scores a name against query tokens: every token must occur; names whose
// words start with the tokens rank first, then shorter names.
function score(name: string, queryTokens: string[]): number | undefined {
  const lower = name.toLowerCase();
  let total = 0;

  for (const token of queryTokens) {
    const at = lower.indexOf(token);

    if (at < 0) {
      return undefined;
    }

    const wordStart = at === 0 || /[\s\-|(]/.test(lower[at - 1] ?? "");
    total += wordStart ? 0 : 10;
  }

  return total + lower.length / 100;
}

function ranked<T>(
  entries: readonly T[],
  query: string,
  name: (entry: T) => string,
  limit: number,
) {
  const queryTokens = tokens(query);

  if (queryTokens.length === 0) {
    return entries.slice(0, limit);
  }

  const scored: Array<{ entry: T; value: number }> = [];

  for (const entry of entries) {
    const value = score(name(entry), queryTokens);

    if (value !== undefined) {
      scored.push({ entry, value });
    }
  }

  scored.sort((a, b) => a.value - b.value);

  return scored.slice(0, limit).map(({ entry }) => entry);
}

export function searchFinishes(
  catalog: Catalog,
  query: string,
  options: { weapon?: string; category?: string; limit?: number } = {},
): FinishEntry[] {
  const pool = catalog.finishes.filter(
    (entry) =>
      (options.weapon === undefined || entry.weapon === options.weapon) &&
      (options.category === undefined || entry.category === options.category),
  );

  return ranked(pool, query, (entry) => `${entry.weapon} | ${entry.finish}`, options.limit ?? 50);
}

export function searchStickers(
  catalog: Catalog,
  query: string,
  options: {
    tournament?: string;
    collection?: string;
    effect?: StickerEffect;
    limit?: number;
  } = {},
): StickerEntry[] {
  const pool = catalog.stickers.filter(
    (entry) =>
      (options.tournament === undefined || entry.tournament === options.tournament) &&
      (options.collection === undefined || entry.collection === options.collection) &&
      (options.effect === undefined || entry.effect === options.effect),
  );

  return ranked(
    pool,
    query,
    (entry) => `${entry.name} ${entry.tournament ?? entry.collection ?? ""}`,
    options.limit ?? 50,
  );
}

export function searchCharms(
  catalog: Catalog,
  query: string,
  options: { limit?: number } = {},
): CharmEntry[] {
  return ranked(catalog.charms, query, (entry) => entry.name, options.limit ?? 50);
}

// The weapon categories with at least one finish, for the item picker's chips.
export function categories(catalog: Catalog): string[] {
  const order = ["Rifles", "Pistols", "SMGs", "Heavy", "Knives", "Gloves"];
  const found = new Set<string>();

  for (const entry of catalog.finishes) {
    if (entry.category !== undefined) {
      found.add(entry.category);
    }
  }

  return [...found].sort((a, b) => {
    const left = order.indexOf(a);
    const right = order.indexOf(b);

    return (
      (left < 0 ? order.length : left) - (right < 0 ? order.length : right) || a.localeCompare(b)
    );
  });
}

// The weapons with at least one finish.
export function weapons(catalog: Catalog): string[] {
  return [...new Set(catalog.finishes.map((entry) => entry.weapon))].sort();
}

// The tournaments and collections stickers belong to, for the sticker filters.
export function stickerGroups(catalog: Catalog): { tournaments: string[]; collections: string[] } {
  const tournaments = new Set<string>();
  const collections = new Set<string>();

  for (const entry of catalog.stickers) {
    if (entry.tournament !== undefined) {
      tournaments.add(entry.tournament);
    }

    if (entry.collection !== undefined) {
      collections.add(entry.collection);
    }
  }

  return { tournaments: [...tournaments].sort(), collections: [...collections].sort() };
}
