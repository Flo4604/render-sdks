// 13 Picker: one component in three configurations (item, sticker, charm).
// A popover on desktop and a bottom sheet on the phone. Arrow keys move the
// highlight, Enter picks and Esc closes and returns focus to the opener.

import {
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  type Catalog,
  categories,
  type FinishEntry,
  inspectLinkIn,
  searchCharms,
  searchFinishes,
  searchStickers,
  stickerGroups,
  type StickerEffect,
} from "../catalog.ts";
import type { PickerKind, RegionProps } from "../regions.ts";
import { CloseIcon, SearchIcon } from "./icons.tsx";

interface Row {
  key: string;
  rarity: string | undefined;
  thumbnail: string | undefined;
  over: string;
  title: string;
  aside: ReactNode;
  pick: () => void;
}

interface Filter {
  label: string;
  apply: { category?: string; tournament?: string; collection?: string; effect?: StickerEffect };
}

const shownLimit = 30;

function range(entry: FinishEntry): string {
  if (entry.wear === undefined) {
    return "";
  }

  return `${entry.wear.min.toFixed(2)}–${entry.wear.max.toFixed(2)}`;
}

function filtersFor(kind: PickerKind, catalog: Catalog | undefined): Filter[] {
  if (catalog === undefined || kind === "charm") {
    return [];
  }

  if (kind === "item") {
    return categories(catalog).map((category) => ({ label: category, apply: { category } }));
  }

  const groups = stickerGroups(catalog);
  const effects = [...new Set(catalog.stickers.map((entry) => entry.effect))].filter(
    (effect): effect is StickerEffect => effect !== undefined && effect !== "paper",
  );

  return [
    ...groups.tournaments
      .slice(0, 2)
      .map((tournament) => ({ label: tournament, apply: { tournament } })),
    ...groups.collections
      .slice(0, 1)
      .map((collection) => ({ label: collection, apply: { collection } })),
    ...effects.slice(0, 2).map((effect) => ({
      label: effect.charAt(0).toUpperCase() + effect.slice(1),
      apply: { effect },
    })),
  ];
}

export function Picker(props: RegionProps) {
  const { ui } = props;
  const kind: PickerKind = ui.picker?.kind ?? "item";
  const catalog = ui.catalog;
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter | undefined>(undefined);
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const opener = useRef<Element | null>(null);
  const listId = useId();
  const filters = useMemo(() => filtersFor(kind, catalog), [kind, catalog]);
  const link = kind === "item" ? inspectLinkIn(query) : undefined;

  useEffect(() => {
    const root = input.current?.getRootNode() as Document | ShadowRoot | undefined;
    opener.current = root?.activeElement ?? null;
    input.current?.focus();

    return () => {
      (opener.current as HTMLElement | null)?.focus?.();
    };
  }, []);

  useEffect(() => {
    setActive(0);
  }, [query, filter]);

  const rows: Row[] = [];
  let total = 0;

  if (link !== undefined) {
    rows.push({
      key: "link",
      rarity: undefined,
      thumbnail: undefined,
      over: "Load from link",
      title: link.length > 48 ? `${link.slice(0, 48)}…` : link,
      aside: <span className="mv-picker-enter">Enter ↵</span>,
      pick: () => ui.pickItem({ inspectLink: link }),
    });
    total = 1;
  } else if (catalog !== undefined && kind === "item") {
    const found = searchFinishes(catalog, query, { ...filter?.apply, limit: Infinity });
    total = found.length;

    for (const entry of found.slice(0, shownLimit)) {
      rows.push({
        key: `${entry.defindex}-${entry.paintindex}`,
        rarity: entry.rarityColor,
        thumbnail: entry.thumbnail,
        over: entry.weapon,
        title: entry.finish,
        aside: <span className="mv-picker-range mv-mono">{range(entry)}</span>,
        pick: () => ui.pickItem({ finish: entry }),
      });
    }
  } else if (catalog !== undefined && kind === "sticker") {
    const found = searchStickers(catalog, query, { ...filter?.apply, limit: Infinity });
    total = found.length;

    for (const entry of found.slice(0, shownLimit)) {
      rows.push({
        key: String(entry.id),
        rarity: entry.rarityColor,
        thumbnail: entry.thumbnail,
        over: entry.tournament ?? entry.collection ?? "",
        title: entry.name,
        aside:
          entry.effect === undefined ? null : (
            <span className="mv-picker-badge">{entry.effect}</span>
          ),
        pick: () => ui.pickSticker(entry),
      });
    }
  } else if (catalog !== undefined) {
    const found = searchCharms(catalog, query, { limit: Infinity });
    total = found.length;

    for (const entry of found.slice(0, shownLimit)) {
      rows.push({
        key: String(entry.id),
        rarity: entry.rarityColor,
        thumbnail: entry.thumbnail,
        over: entry.collection ?? "",
        title: entry.name,
        aside: null,
        pick: () => ui.pickCharm(entry),
      });
    }
  }

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      ui.closePicker();

      return;
    }

    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActive((value) => (rows.length === 0 ? 0 : (value + step + rows.length) % rows.length));

      return;
    }

    if (event.key === "Enter") {
      event.preventDefault();
      rows[active]?.pick();
    }
  };

  const titles = { item: "Change item", sticker: "Add sticker", charm: "Add charm" } as const;
  const placeholders = {
    item: "Search weapon and finish, or paste a link",
    sticker: "Search stickers",
    charm: "Search charms",
  } as const;
  let section: string;

  if (link !== undefined) {
    section = "Inspect link";
  } else if (catalog === undefined) {
    section = ui.catalogStatus === "error" ? "The catalog didn’t load" : "Searching…";
  } else if (query.trim() === "") {
    section = kind === "sticker" ? "Popular" : "Suggested";
  } else {
    section =
      total > rows.length
        ? `${query.trim()} · ${rows.length} shown of ${total}`
        : `${total} ${total === 1 ? "match" : "matches"}`;
  }

  const empty = catalog !== undefined && rows.length === 0;
  const loading = catalog === undefined && ui.catalogStatus !== "error";

  return (
    <div className="mv-picker-layer" data-phone={ui.phone}>
      {ui.phone ? (
        <button type="button" className="mv-scrim" aria-label="Close" onClick={ui.closePicker} />
      ) : null}
      <div
        className="mv-picker"
        part="picker"
        role="dialog"
        aria-modal={ui.phone}
        aria-label={titles[kind]}
        data-kind={kind}
        onKeyDown={onKeyDown}
      >
        {ui.phone ? (
          <div className="mv-picker-title">
            <i className="mv-sheet-handle" />
            <h3>{titles[kind]}</h3>
            <button
              type="button"
              className="mv-icon-button"
              aria-label="Close"
              onClick={ui.closePicker}
            >
              <CloseIcon />
            </button>
          </div>
        ) : null}
        <div className="mv-picker-search" data-link={link !== undefined}>
          <SearchIcon />
          <input
            ref={input}
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-activedescendant={rows[active] === undefined ? undefined : `${listId}-${active}`}
            aria-autocomplete="list"
            placeholder={placeholders[kind]}
            value={query}
            data-link={link !== undefined}
            onChange={(event) => setQuery(event.target.value)}
          />
          {ui.phone ? null : <kbd>Esc</kbd>}
        </div>
        {filters.length === 0 || link !== undefined ? null : (
          <div className="mv-chips" role="group" aria-label="Filters">
            <button
              type="button"
              className="mv-chip"
              aria-pressed={filter === undefined}
              onClick={() => setFilter(undefined)}
            >
              All
            </button>
            {filters.map((entry) => (
              <button
                key={entry.label}
                type="button"
                className="mv-chip"
                aria-pressed={filter?.label === entry.label}
                onClick={() => setFilter(filter?.label === entry.label ? undefined : entry)}
              >
                {entry.label}
              </button>
            ))}
          </div>
        )}
        <div className="mv-picker-list" id={listId} role="listbox" aria-label={titles[kind]}>
          {empty ? (
            <p className="mv-picker-empty">
              {kind === "item"
                ? `Nothing matches “${query.trim()}”. Try fewer letters, another weapon type, or paste an inspect link.`
                : kind === "sticker"
                  ? `No stickers match “${query.trim()}”. Clear the filters or try a team or player name.`
                  : `No charms match “${query.trim()}”.`}
            </p>
          ) : (
            <span className="mv-picker-section">{section}</span>
          )}
          {loading
            ? [0, 1, 2].map((index) => (
                <div key={index} className="mv-picker-row" data-skeleton="true" aria-hidden="true">
                  <i className="mv-picker-rarity" />
                  <i className="mv-picker-thumb" />
                </div>
              ))
            : rows.map((row, index) => (
                <div
                  key={row.key}
                  id={`${listId}-${index}`}
                  role="option"
                  aria-selected={index === active}
                  className="mv-picker-row"
                  onPointerMove={() => setActive(index)}
                  onClick={row.pick}
                >
                  <i
                    className="mv-picker-rarity"
                    style={
                      row.rarity === undefined
                        ? undefined
                        : ({ "--mv-row-rarity": row.rarity } as CSSProperties)
                    }
                  />
                  <span className="mv-picker-thumb">
                    {row.thumbnail === undefined ? null : <img src={row.thumbnail} alt="" />}
                  </span>
                  <span className="mv-picker-text">
                    <span className="mv-picker-over">{row.over}</span>
                    <span className="mv-picker-name">{row.title}</span>
                  </span>
                  {row.aside}
                </div>
              ))}
        </div>
        {ui.phone ? null : (
          <div className="mv-picker-foot">
            <span>↑↓ move</span>
            <span>Enter pick</span>
            <span>{kind === "item" ? "Paste an inspect link to load it" : "Esc close"}</span>
          </div>
        )}
      </div>
    </div>
  );
}
