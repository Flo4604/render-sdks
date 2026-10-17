// The complete styled viewer from the Paper "3D Viewer" design: a full-bleed
// render with floating glass panels (layout B, the default), the side-panel
// layout A, the phone layout below 640 px, and the host-owns-the-chrome
// density. Every region goes through RegionHost, so hosts can hide, restyle
// or replace it.

import type { ItemRequest, LoadedItem, ViewerError } from "@medalbot/viewer-engine";
import { wearBits } from "@medalbot/viewer-engine";
import {
  type CSSProperties,
  type KeyboardEvent,
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import type { CatalogSource, CharmEntry, FinishEntry, StickerEntry } from "../catalog.ts";
import { useStageGestures } from "../gestures.ts";
import { isTextEntry, shortcutFor } from "../keyboard.ts";
import {
  type ComponentOverrides,
  type ControlsConfig,
  type Density,
  type ItemDisplay,
  type Layout,
  type PickerKind,
  type RegionProps,
  resolveControls,
  type ToastMessage,
  type ViewerUi,
} from "../regions.ts";
import { fetcherFor, type ViewerSource } from "../source.ts";
import { useCatalog } from "../use-catalog.ts";
import { useCanvasSize, useViewer, type ViewerActions, type ViewerState } from "../use-viewer.ts";
import { formatWear, wearTier } from "../wear.ts";
import { ControlBar, FullscreenButton, PresetControl } from "./control-bar.tsx";
import { IconDownload } from "./download.tsx";
import { Badge, Disclaimer, Shortcuts } from "./embed-extras.tsx";
import { SearchIcon } from "./icons.tsx";
import { ChangeItem, ItemHeader, OrbitHint } from "./item-header.tsx";
import { FloatingPanels, PhoneSheet, SidePanel } from "./layouts.tsx";
import { Picker } from "./picker.tsx";
import { RegionContext, RegionHost } from "./region.tsx";
import { Toasts } from "./toasts.tsx";
import { ErrorState, IdleState, LoadingState, UnsupportedState } from "./viewer-surface.tsx";

export type MedalbotViewerProps = ViewerSource & {
  item: ItemRequest;
  // What the host knows about the item; the closure carries indices only.
  weapon?: string;
  finish?: string;
  rarity?: string;
  rarityColor?: string;
  wearRange?: { min: number; max: number };
  poster?: string;
  disclaimer?: string;
  stickerSlots?: number;
  theme?: "dark" | "light";
  className?: string;
  style?: CSSProperties;
  // "click" shows the poster and a View in 3D button and downloads nothing until pressed.
  load?: "eager" | "click";
  // The catalog the item, sticker and charm pickers search.
  catalog?: CatalogSource;
  // Lever 1: which controls render, whether they can change the item, how
  // much chrome the kit draws and where the customise controls go.
  controls?: ControlsConfig;
  readOnly?: boolean;
  density?: Density;
  layout?: Layout;
  // Lever 3: replacements for named regions.
  components?: ComponentOverrides;
  // Set by <medalbot-viewer>: regions render inside named slots.
  slots?: boolean;
  onReady?: (item: LoadedItem) => void;
  onError?: (error: ViewerError) => void;
  onStateChange?: (state: ViewerState, actions: ViewerActions) => void;
  onItemChange?: (item: ItemRequest) => void;
};

const phoneWidth = 640;

function useWidth(element: RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const node = element.current;

    if (node === null) {
      return;
    }

    const observer = new ResizeObserver(([entry]) => {
      setWidth(entry?.contentRect.width ?? 0);
    });
    observer.observe(node);

    return () => observer.disconnect();
  }, [element]);

  return width;
}

function stageLabel(display: ItemDisplay, state: ViewerState): string {
  const name = [display.weapon, display.finish].filter(Boolean).join(" | ") || "Item";
  const wear =
    state.paint === undefined
      ? ""
      : `, ${wearTier(state.paint.wear).name} ${formatWear(state.paint.wear, 4)}`;
  const view = state.mode === "3d" ? "3D view" : `${state.mode} view`;

  return `${name}${wear}, ${view}`;
}

export function MedalbotViewer(props: MedalbotViewerProps) {
  const root = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const source =
    "fetcher" in props ? props.fetcher : "closureUrl" in props ? props.closureUrl : props.api;
  const apiKey = "apiKey" in props ? props.apiKey : undefined;
  // Rebuild the fetcher only when its inputs change.
  const fetcher = useMemo(() => fetcherFor(props), [source, apiKey]);
  const { state, actions, viewer } = useViewer({
    fetcher,
    item: props.item,
    canvas,
    load: props.load ?? "eager",
    ...(props.onReady === undefined ? {} : { onReady: props.onReady }),
    ...(props.onError === undefined ? {} : { onError: props.onError }),
  });
  useCanvasSize(viewer, canvas, state.status === "ready");
  const catalog = useCatalog(props.catalog);
  const width = useWidth(root);
  const phone = width > 0 && width < phoneWidth;
  const controls = resolveControls(props.controls, {
    ...(props.readOnly === undefined ? {} : { readOnly: props.readOnly }),
    ...(props.density === undefined ? {} : { density: props.density }),
    ...(props.layout === undefined ? {} : { layout: props.layout }),
  });
  const [picked, setPicked] = useState<ItemDisplay | undefined>(undefined);
  const display: ItemDisplay = picked ?? {
    ...(props.weapon === undefined ? {} : { weapon: props.weapon }),
    ...(props.finish === undefined ? {} : { finish: props.finish }),
    ...(props.rarity === undefined ? {} : { rarity: props.rarity }),
    ...(props.rarityColor === undefined ? {} : { rarityColor: props.rarityColor }),
    ...(props.wearRange === undefined ? {} : { wearRange: props.wearRange }),
    ...(props.poster === undefined ? {} : { poster: props.poster }),
    ...(props.disclaimer === undefined ? {} : { disclaimer: props.disclaimer }),
    ...(props.stickerSlots === undefined ? {} : { stickerSlots: props.stickerSlots }),
  };

  // Kit state that is not engine state.
  const [fullscreen, setFullscreen] = useState(false);
  const [picker, setPicker] = useState<ViewerUi["picker"]>(undefined);
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const [hideUi, setHideUi] = useState(false);
  const [rig, setRig] = useState("production");
  const [stageFocused, setStageFocused] = useState(false);
  const toastId = useRef(0);

  const notify = useCallback((toast: Omit<ToastMessage, "id">) => {
    toastId.current += 1;
    const id = toastId.current;
    setToasts((previous) => [...previous.slice(-2), { ...toast, id }]);

    if (toast.tone !== "error") {
      setTimeout(() => setToasts((previous) => previous.filter((entry) => entry.id !== id)), 4000);
    }
  }, []);

  const toggleFullscreen = useCallback(() => {
    const node = root.current;

    if (node === null) {
      return;
    }

    if (document.fullscreenElement === null) {
      void node.requestFullscreen?.().catch(() => {});

      return;
    }

    void document.exitFullscreen().catch(() => {});
  }, []);

  useEffect(() => {
    const update = () => setFullscreen(document.fullscreenElement !== null);
    document.addEventListener("fullscreenchange", update);

    return () => document.removeEventListener("fullscreenchange", update);
  }, []);

  // A refused change becomes an error toast with its code.
  useEffect(() => {
    const error = state.actionError;

    if (error === undefined) {
      return;
    }

    notify({
      tone: "error",
      title: "Couldn’t apply that change",
      body: error.message,
      code: error.code,
    });
    actions.dismissError();
  }, [state.actionError, actions, notify]);

  const pickItem = (choice: { finish?: FinishEntry; inspectLink?: string }) => {
    setPicker(undefined);

    if (choice.inspectLink !== undefined) {
      setPicked({});
      actions.load({ inspectLink: choice.inspectLink });
      props.onItemChange?.({ inspectLink: choice.inspectLink });

      return;
    }

    const entry = choice.finish;

    if (entry === undefined) {
      return;
    }

    const range = entry.wear ?? { min: 0, max: 1 };
    const wear = Math.min(range.max, Math.max(range.min, state.paint?.wear ?? range.min));
    const request: ItemRequest = {
      defindex: entry.defindex,
      paintindex: entry.paintindex,
      paintseed: state.paint?.paintseed ?? 0,
      paintwear: wearBits(wear),
    };
    setPicked({
      weapon: entry.weapon,
      finish: entry.finish,
      ...(entry.rarity === undefined ? {} : { rarity: entry.rarity }),
      ...(entry.rarityColor === undefined ? {} : { rarityColor: entry.rarityColor }),
      ...(entry.wear === undefined ? {} : { wearRange: entry.wear }),
      ...(entry.thumbnail === undefined ? {} : { poster: entry.thumbnail }),
      ...(display.disclaimer === undefined ? {} : { disclaimer: display.disclaimer }),
    });
    actions.load(request);
    props.onItemChange?.(request);
  };

  const pickSticker = (entry: StickerEntry) => {
    const slot = picker?.slot ?? 0;
    setPicker(undefined);
    actions.addSticker(slot, entry.id);
  };

  const pickCharm = (entry: CharmEntry) => {
    setPicker(undefined);
    actions.setCharm({ slot: 0, id: entry.id, pattern: state.charm?.pattern ?? 0 });
  };

  const ui: ViewerUi = {
    phone,
    fullscreen,
    toggleFullscreen,
    catalog: catalog.catalog,
    catalogStatus:
      props.catalog === undefined ? "none" : catalog.status === "idle" ? "loading" : catalog.status,
    picker,
    openPicker: (kind: PickerKind, slot?: number) =>
      setPicker(slot === undefined ? { kind } : { kind, slot }),
    closePicker: () => setPicker(undefined),
    pickItem,
    pickSticker,
    pickCharm,
    notify,
    dismiss: (id: number) => setToasts((previous) => previous.filter((entry) => entry.id !== id)),
    toasts,
    hideUi,
    rig,
    setRig,
  };
  const regionProps: RegionProps = { display, state, actions, controls, ui };
  const context = useMemo(
    () => ({ overrides: props.components ?? {}, slots: props.slots ?? false }),
    [props.components, props.slots],
  );
  const onStateChange = props.onStateChange;

  useEffect(() => {
    onStateChange?.(state, actions);
  }, [state, actions, onStateChange]);

  useStageGestures(
    stage,
    useMemo(
      () => ({ orbit: actions.orbit, zoom: actions.zoom, reset: actions.resetCamera }),
      [actions],
    ),
    state.status === "ready" && state.capabilities.camera,
  );

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (isTextEntry(event.target) || picker !== undefined) {
      return;
    }

    const action = shortcutFor(event, {
      onStage: event.target === stage.current,
      camera: state.capabilities.camera,
    });

    if (action === undefined || state.status !== "ready") {
      return;
    }

    const modes = state.capabilities.camera ? ["3d", ...state.views] : state.views;
    event.preventDefault();

    switch (action.kind) {
      case "view": {
        const mode = modes[action.index];

        if (mode !== undefined && controls.visible.presets) {
          actions.setMode(mode);
        }

        break;
      }

      case "next-view": {
        const index = modes.indexOf(state.mode);
        const mode = modes[(index + action.step + modes.length) % modes.length];

        if (mode !== undefined) {
          actions.setMode(mode);
        }

        break;
      }

      case "orbit":
        actions.orbit(action.yaw, action.pitch);
        break;
      case "zoom":
        actions.zoom(action.factor);
        break;
      case "reset":
        actions.resetCamera();
        break;
      case "fullscreen":
        if (controls.visible.fullscreen) {
          toggleFullscreen();
        }

        break;
      case "hide-ui":
        setHideUi((value) => !value);
        break;
      case "wear":
        if (controls.visible.wear && !controls.readOnly && state.paint !== undefined) {
          actions.setWear(Math.min(1, Math.max(0, state.paint.wear + action.step)));
        }

        break;
      default:
        break;
    }
  };

  const density = controls.density;
  const layout = phone ? "phone" : controls.layout;
  const chrome = density !== "host" && !hideUi;
  // The customise controls need a loaded item to show its values.
  const customise = density === "full" && chrome && state.item !== undefined;
  const visible = controls.visible;
  const showHeader = chrome && visible.header;
  const showChangeItem =
    chrome && visible["change-item"] && props.catalog !== undefined && !controls.readOnly;
  const poster = display.poster;
  const stageHint =
    state.status === "ready" && !state.reloading && (layout === "panel" || layout === "phone")
      ? stageFocused
        ? state.capabilities.camera
          ? "← → orbit · 1–3 views · R reset · F fullscreen"
          : "← → views · F fullscreen"
        : layout === "phone" && state.capabilities.camera
          ? "Drag to orbit · pinch to zoom"
          : undefined
      : undefined;

  const stageElement = (
    <div
      ref={stage}
      className="mv-stage"
      part="stage"
      tabIndex={0}
      role="application"
      aria-roledescription="3D item viewer"
      aria-label={stageLabel(display, state)}
      onFocus={(event) => setStageFocused(event.target === stage.current)}
      onBlur={() => setStageFocused(false)}
    >
      {poster === undefined ? null : <img className="mv-poster" src={poster} alt="" />}
      <canvas ref={canvas} className="mv-canvas" aria-hidden="true" />
      {state.status === "idle" ? (
        <RegionHost name="loading" stock={IdleState} {...regionProps} />
      ) : null}
      {state.status === "loading" || state.status === "checking" ? (
        <RegionHost name="loading" stock={LoadingState} {...regionProps} />
      ) : null}
      {state.status === "unsupported" ? (
        <RegionHost name="unsupported" stock={UnsupportedState} {...regionProps} />
      ) : null}
      {state.status === "error" ? (
        <RegionHost name="error" stock={ErrorState} {...regionProps} />
      ) : null}
      {state.reloading ? <RegionHost name="loading" stock={LoadingState} {...regionProps} /> : null}
      {stageHint === undefined ? null : <span className="mv-stage-hint">{stageHint}</span>}
    </div>
  );

  const pickerElement =
    picker === undefined ? null : (
      <RegionHost
        key={`${picker.kind}-${picker.slot ?? ""}`}
        name="picker"
        stock={Picker}
        {...regionProps}
      />
    );

  const extras = (
    <>
      {visible.disclaimer ? (
        <RegionHost name="disclaimer" stock={Disclaimer} {...regionProps} />
      ) : null}
      {visible.badge ? <RegionHost name="badge" stock={Badge} {...regionProps} /> : null}
    </>
  );

  return (
    <RegionContext value={context}>
      <div
        ref={root}
        className={["mv", props.className].filter(Boolean).join(" ")}
        style={props.style}
        data-theme={props.theme ?? "dark"}
        data-density={density}
        data-layout={layout}
        data-status={state.status}
        data-embedded={props.slots === true ? "true" : undefined}
        data-hide-ui={hideUi}
        onKeyDown={onKeyDown}
      >
        {layout === "phone" ? (
          <div className="mv-phone">
            {chrome ? (
              <div className="mv-phone-top">
                {showHeader ? (
                  <RegionHost name="header" stock={ItemHeader} {...regionProps} />
                ) : (
                  <span />
                )}
                <div className="mv-phone-actions">
                  {showChangeItem ? (
                    <button
                      type="button"
                      className="mv-icon-button"
                      aria-label="Change item"
                      onClick={() => ui.openPicker("item")}
                    >
                      <SearchIcon size={20} />
                    </button>
                  ) : null}
                  {visible.download ? (
                    <RegionHost name="download" stock={IconDownload} {...regionProps} />
                  ) : null}
                  {visible.fullscreen ? (
                    <RegionHost name="fullscreen" stock={FullscreenButton} {...regionProps} />
                  ) : null}
                </div>
              </div>
            ) : null}
            {stageElement}
            {chrome && visible.presets ? (
              <div className="mv-phone-presets">
                <RegionHost name="presets" stock={PresetControl} {...regionProps} />
              </div>
            ) : null}
            {customise ? <PhoneSheet {...regionProps} /> : null}
            {extras}
            <RegionHost name="toasts" stock={Toasts} {...regionProps} />
            {pickerElement}
          </div>
        ) : (
          <>
            <div className="mv-main">
              {stageElement}
              {showHeader || showChangeItem ? (
                <div className="mv-header-slot">
                  {showHeader ? (
                    <RegionHost name="header" stock={ItemHeader} {...regionProps} />
                  ) : null}
                  {showChangeItem ? (
                    <RegionHost name="change-item" stock={ChangeItem} {...regionProps} />
                  ) : null}
                </div>
              ) : null}
              {chrome && layout === "panel" ? (
                <RegionHost name="orbit-hint" stock={OrbitHint} {...regionProps} />
              ) : null}
              {chrome && state.status !== "idle" ? (
                <RegionHost name="control-bar" stock={ControlBar} {...regionProps} />
              ) : null}
              {customise && layout === "floating" ? <FloatingPanels {...regionProps} /> : null}
              {visible.shortcuts &&
              (layout === "floating" || density === "host") &&
              state.status === "ready" ? (
                <RegionHost name="shortcuts" stock={Shortcuts} {...regionProps} />
              ) : null}
              {extras}
              <RegionHost name="toasts" stock={Toasts} {...regionProps} />
              {pickerElement}
            </div>
            {customise && layout === "panel" ? <SidePanel {...regionProps} /> : null}
          </>
        )}
      </div>
    </RegionContext>
  );
}
