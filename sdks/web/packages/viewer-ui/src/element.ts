// <medalbot-viewer>: the styled viewer as a custom element, for pages without
// React. It renders into a shadow root with the kit's stylesheet. Hosts style
// it through the --mv-* variables (they inherit into the shadow root) and
// ::part(<region>), and replace a region with a light-DOM child in the slot of
// the same name. The element exposes `state` and `actions` and dispatches
// `statechange`, so a slotted replacement can drive the viewer.
//
//   <medalbot-viewer closure-url="/v1/viewer" item="7-801-661-1036831949"></medalbot-viewer>
//   <medalbot-viewer api="https://api.medalbot.cc" api-key="..." inspect-link="steam://..."></medalbot-viewer>

import type { ItemRequest } from "@medalbot/viewer-engine";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";

import { MedalbotViewer, type MedalbotViewerProps } from "./components/medalbot-viewer.tsx";
import { type CatalogSource, urlCatalog } from "./catalog.ts";
import { controlNames, type ControlsConfig } from "./regions.ts";
import { parseItem, type ViewerSource } from "./source.ts";
import { styles } from "./styles-text.generated.ts";
import type { ViewerActions, ViewerState } from "./use-viewer.ts";

const attributes = [
  "api",
  "api-key",
  "closure-url",
  "item",
  "inspect-link",
  "weapon",
  "finish",
  "rarity",
  "rarity-color",
  "wear-min",
  "wear-max",
  "poster",
  "disclaimer",
  "sticker-slots",
  "catalog-url",
  "theme",
  "controls",
  "hide",
  "read-only",
  "density",
  "layout",
  "load",
] as const;

// "presets wear seed" shows only those; hide="seed badge" hides those.
function controlsFrom(show: string | null, hide: string | null): ControlsConfig {
  const config: ControlsConfig = {};
  const listed = (value: string | null) => new Set((value ?? "").split(/[\s,]+/).filter(Boolean));
  const shown = listed(show);
  const hidden = listed(hide);

  for (const name of controlNames) {
    if (shown.size > 0) {
      config[name] = shown.has(name);
    }

    if (hidden.has(name)) {
      config[name] = false;
    }
  }

  return config;
}

export class MedalbotViewerElement extends HTMLElement {
  static readonly observedAttributes = attributes;

  private root: Root | undefined;

  private current: { state: ViewerState; actions: ViewerActions } | undefined;

  private catalogUrl: string | undefined;

  private catalog: CatalogSource | undefined;

  get state(): ViewerState | undefined {
    return this.current?.state;
  }

  get actions(): ViewerActions | undefined {
    return this.current?.actions;
  }

  connectedCallback(): void {
    if (this.root === undefined) {
      const shadow = this.shadowRoot ?? this.attachShadow({ mode: "open" });
      const sheet = document.createElement("style");
      sheet.textContent = styles;
      const container = document.createElement("div");
      container.style.display = "contents";
      shadow.replaceChildren(sheet, container);
      this.root = createRoot(container);
    }

    this.update();
  }

  disconnectedCallback(): void {
    this.root?.unmount();
    this.root = undefined;
  }

  attributeChangedCallback(): void {
    this.update();
  }

  private source(): ViewerSource | undefined {
    const closureUrl = this.getAttribute("closure-url");
    const api = this.getAttribute("api");
    const apiKey = this.getAttribute("api-key");

    if (closureUrl !== null) {
      return { closureUrl };
    }

    if (api !== null) {
      return apiKey === null ? { api } : { api, apiKey };
    }

    return undefined;
  }

  private item(): ItemRequest | undefined {
    const inspectLink = this.getAttribute("inspect-link");

    if (inspectLink !== null) {
      return { inspectLink };
    }

    return parseItem(this.getAttribute("item") ?? "");
  }

  private update(): void {
    const source = this.source();
    const item = this.item();

    if (this.root === undefined || source === undefined || item === undefined) {
      return;
    }

    const text = (name: string) => this.getAttribute(name) ?? undefined;
    const number = (name: string) => {
      const value = this.getAttribute(name);

      return value === null || !Number.isFinite(Number(value)) ? undefined : Number(value);
    };

    const theme = text("theme");
    const density = text("density");
    const layout = text("layout");
    const load = text("load");
    const wearMin = number("wear-min");
    const wearMax = number("wear-max");
    const slots = number("sticker-slots");
    const catalogUrl = text("catalog-url");

    if (catalogUrl !== this.catalogUrl) {
      this.catalogUrl = catalogUrl;
      this.catalog = catalogUrl === undefined ? undefined : urlCatalog(catalogUrl);
    }

    const optional: Record<string, unknown> = {
      weapon: text("weapon"),
      finish: text("finish"),
      rarity: text("rarity"),
      rarityColor: text("rarity-color"),
      poster: text("poster"),
      disclaimer: text("disclaimer"),
      stickerSlots: slots,
      wearRange:
        wearMin === undefined && wearMax === undefined
          ? undefined
          : { min: wearMin ?? 0, max: wearMax ?? 1 },
      catalog: this.catalog,
      theme: theme === "light" || theme === "dark" ? theme : undefined,
      density:
        density === "full" || density === "viewer" || density === "host" ? density : undefined,
      layout: layout === "floating" || layout === "panel" ? layout : undefined,
      load: load === "click" || load === "eager" ? load : undefined,
    };
    const defined = Object.fromEntries(
      Object.entries(optional).filter(([, value]) => value !== undefined),
    ) as Partial<MedalbotViewerProps>;
    const props: MedalbotViewerProps = {
      ...source,
      item,
      ...defined,
      controls: controlsFrom(this.getAttribute("controls"), this.getAttribute("hide")),
      readOnly: this.hasAttribute("read-only"),
      slots: true,
      onReady: (loaded) => {
        this.dispatchEvent(new CustomEvent("ready", { detail: loaded }));
      },
      onError: (error) => {
        this.dispatchEvent(new CustomEvent("error", { detail: error }));
      },
      onStateChange: (state, actions) => {
        this.current = { state, actions };
        this.dispatchEvent(new CustomEvent("statechange", { detail: state }));
      },
    };
    this.root.render(createElement(MedalbotViewer, props));
  }
}

if (typeof customElements !== "undefined" && customElements.get("medalbot-viewer") === undefined) {
  customElements.define("medalbot-viewer", MedalbotViewerElement);
}

declare global {
  interface HTMLElementTagNameMap {
    "medalbot-viewer": MedalbotViewerElement;
  }
}
