// The kit's only integration point with the engine. Everything here uses the
// public @medalbot/viewer-engine API (createViewer, load, on, setView,
// setSeed, setWear, setStickers, setStatTrak, the camera methods, render and
// renderToPixels), so a bring-your-own UI can do exactly what the styled
// components do.

import {
  type AssetFetcher,
  createViewer,
  detectSupport,
  type ItemRequest,
  type ItemSpec,
  type LoadedItem,
  type PaintAttributes,
  type Viewer,
  ViewerError,
  wearBits,
  wearFromBits,
} from "@medalbot/viewer-engine";
import { type RefObject, useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  attachmentsOf,
  cameraOf,
  type CameraState,
  type Capabilities,
  capabilities,
  type CharmPlacement,
  editSticker,
  inspectCharm,
  inspectSticker,
  loadedStickers,
  type StickerEdit,
  type StickerPlacement,
} from "./capabilities.ts";
import { renderPng, saveBlob } from "./download.ts";

// "3d" while the free camera is in use, or the preset it last snapped to.
// Without a free camera there is no 3D mode and this is the view.
export type ViewerMode = "3d" | (string & {});

export type ViewerStatus = "idle" | "checking" | "unsupported" | "loading" | "ready" | "error";

export interface LoadProgress {
  phase: "closure" | "files" | "pipelines";
  done: number;
  total: number;
  // Overall progress in [0, 1], weighted by phase.
  fraction: number;
}

export interface ActionError {
  message: string;
  code: string;
}

export interface ViewerState {
  status: ViewerStatus;
  // True while a loaded item reloads for a change that needs another closure
  // (adding a sticker or charm, StatTrak on or off, another item).
  reloading: boolean;
  progress: LoadProgress | undefined;
  // The error that stopped the viewer (status "error" or "unsupported").
  error: ViewerError | undefined;
  // The last change the engine refused; the item keeps rendering.
  actionError: ActionError | undefined;
  // Missing WebGPU pieces when status is "unsupported".
  missing: string[];
  // The request the viewer renders, with the attachments it selects.
  request: ItemRequest;
  item: LoadedItem | undefined;
  views: string[];
  view: string | undefined;
  mode: ViewerMode;
  camera: CameraState | undefined;
  paint: PaintAttributes | undefined;
  // Attributes the loaded package binds live (paintseed, paintwear, ...).
  bindable: string[];
  stickers: StickerPlacement[];
  // The attached charm, or null for none. There is no on/off switch.
  charm: CharmPlacement | null;
  // The StatTrak counter, or null when the item has no StatTrak.
  statTrak: number | null;
  capabilities: Capabilities;
  // The compiled size of the current view, once known.
  exportSize: { width: number; height: number } | undefined;
}

export interface ViewerActions {
  // Starts loading when the viewer was created with load "click".
  start(): void;
  // Loads another item.
  load(request: ItemRequest): void;
  // Snaps to a compiled preset's exact pose; any orbit or zoom afterwards
  // returns the mode to "3d". "3d" itself changes nothing.
  setMode(mode: ViewerMode): void;
  setSeed(seed: number): void;
  setWear(wear: number): void;
  // Adds or replaces the sticker in a slot (another closure).
  addSticker(slot: number, id: number): void;
  removeSticker(slot: number): void;
  // Edits one slot's wear, rotation or offset live; scale is never editable.
  editSticker(slot: number, edit: StickerEdit): void;
  // A count sets the counter; null removes StatTrak. Turning it on or off
  // loads another closure, changing the count binds live.
  setStatTrak(count: number | null): void;
  // A charm adds or replaces the charm; null removes it (another closure).
  setCharm(charm: CharmPlacement | null): void;
  // Degrees, relative to the current pose.
  orbit(yaw: number, pitch: number): void;
  // Factor above 1 moves closer.
  zoom(factor: number): void;
  // Back to the front pose; stays in "3d" when there is a camera.
  resetCamera(): void;
  // Seed, wear and attachments back to the inspected item.
  resetToInspected(): void;
  renderPng(scale: number): Promise<Blob | undefined>;
  download(scale: number, filename?: string): Promise<Blob | undefined>;
  // Learns the compiled size of the current view (one readback).
  measure(): Promise<void>;
  retry(): void;
  dismissError(): void;
}

export interface UseViewerOptions {
  fetcher: AssetFetcher;
  item: ItemRequest;
  canvas: RefObject<HTMLCanvasElement | null>;
  // "click" waits for actions.start(), so a page with many embeds downloads
  // nothing until the viewer asks for it.
  load?: "eager" | "click";
  onReady?: (item: LoadedItem) => void;
  onError?: (error: ViewerError) => void;
}

// A request with its attachments (stickers, keychains, killeatervalue).
type AttachmentRequest = ItemSpec;

const noCapabilities: Capabilities = {
  stickers: false,
  statTrak: false,
  attachments: false,
  camera: false,
  lighting: false,
};

function initialState(request: ItemRequest, status: ViewerStatus): ViewerState {
  return {
    status,
    reloading: false,
    progress: undefined,
    error: undefined,
    actionError: undefined,
    missing: [],
    request,
    item: undefined,
    views: [],
    view: undefined,
    mode: "3d",
    camera: undefined,
    paint: undefined,
    bindable: [],
    stickers: [],
    charm: null,
    statTrak: null,
    capabilities: noCapabilities,
    exportSize: undefined,
  };
}

// Share of the bar each load phase fills: the manifest is one request, the
// files are most of the bytes, and pipelines compile after them.
const phaseWeights = { closure: [0, 0.04], files: [0.04, 0.8], pipelines: [0.8, 1] } as const;

function progressOf(event: { phase: LoadProgress["phase"]; done: number; total: number }) {
  const [start, end] = phaseWeights[event.phase];
  const share = event.total === 0 ? 1 : event.done / event.total;

  return { ...event, fraction: start + (end - start) * share };
}

function asViewerError(cause: unknown): ViewerError {
  if (cause instanceof ViewerError) {
    return cause;
  }

  return new ViewerError("load_failed", String((cause as Error).message ?? cause), { cause });
}

function asActionError(cause: unknown): ActionError {
  const error = asViewerError(cause);

  return { message: error.message, code: error.code };
}

export function itemKey(item: ItemRequest): string {
  return JSON.stringify(item);
}

function charmOf(request: ItemRequest): CharmPlacement | null {
  const keychain = (request as AttachmentRequest).keychains?.[0];

  if (keychain === undefined) {
    return null;
  }

  return {
    slot: Number(keychain.slot ?? 0),
    id: Number(keychain.sticker_id),
    pattern: Number(keychain.pattern ?? 0),
  };
}

export function useViewer(options: UseViewerOptions): {
  state: ViewerState;
  actions: ViewerActions;
  viewer: Viewer | undefined;
} {
  const eager = (options.load ?? "eager") === "eager";
  const [request, setRequest] = useState<ItemRequest>(options.item);
  const [started, setStarted] = useState(eager);
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<ViewerState>(() =>
    initialState(options.item, eager ? "checking" : "idle"),
  );
  const [viewer, setViewer] = useState<Viewer | undefined>(undefined);
  const viewerRef = useRef<Viewer | undefined>(undefined);
  const inspected = useRef<ItemRequest>(options.item);
  const callbacks = useRef({ onReady: options.onReady, onError: options.onError });
  callbacks.current = { onReady: options.onReady, onError: options.onError };
  const { fetcher, canvas } = options;
  const propKey = itemKey(options.item);

  // A new item from the host replaces whatever the viewer changed.
  useEffect(() => {
    inspected.current = options.item;
    setRequest(options.item);
    // The item is identified by its key, so a new object for the same item does not reload.
  }, [propKey]);

  // One engine instance (one GPU device) per fetcher and canvas.
  useEffect(() => {
    if (!started) {
      return;
    }

    let cancelled = false;
    let created: Viewer | undefined;
    const unsubscribe: Array<() => void> = [];

    const start = async () => {
      setState((previous) => ({ ...previous, status: "checking", error: undefined }));
      const support = await detectSupport();

      if (cancelled) {
        return;
      }

      if (!support.supported) {
        setState((previous) => ({ ...previous, status: "unsupported", missing: support.missing }));

        return;
      }

      const element = canvas.current;

      if (element === null) {
        return;
      }

      created = await createViewer({ canvas: element, fetcher });

      if (cancelled) {
        created.destroy();

        return;
      }

      const engine = created;
      unsubscribe.push(
        engine.on("progress", (event) => {
          setState((previous) => ({ ...previous, progress: progressOf(event) }));
        }),
        engine.on("error", ({ error }) => {
          if (error.code !== "device_lost") {
            return;
          }

          setState((previous) => ({ ...previous, status: "error", error }));
          callbacks.current.onError?.(error);
        }),
      );
      viewerRef.current = engine;
      setViewer(engine);
    };

    start().catch((cause: unknown) => {
      if (cancelled) {
        return;
      }

      const error = asViewerError(cause);
      const unsupported = error.code === "webgpu_unsupported" || error.code === "feature_missing";
      setState((previous) => ({
        ...previous,
        status: unsupported ? "unsupported" : "error",
        error,
        missing: unsupported ? [error.message] : previous.missing,
      }));
      callbacks.current.onError?.(error);
    });

    return () => {
      cancelled = true;

      for (const stop of unsubscribe) {
        stop();
      }

      created?.destroy();
      viewerRef.current = undefined;
      setViewer(undefined);
    };
  }, [fetcher, canvas, started, attempt]);

  // Each request loads into the same engine.
  const requestKey = itemKey(request);

  useEffect(() => {
    if (viewer === undefined) {
      return;
    }

    let cancelled = false;
    const abort = new AbortController();
    setState((previous) => ({
      ...previous,
      status: previous.status === "ready" ? "ready" : "loading",
      reloading: previous.status === "ready",
      progress: undefined,
      request,
    }));

    const run = async () => {
      const loaded = await viewer.load(request, { signal: abort.signal });

      if (cancelled) {
        return;
      }

      const camera = cameraOf(viewer);
      const found = capabilities(viewer);

      if (found.camera && camera !== undefined && loaded.views.includes("front")) {
        camera.setPreset("front");
      }

      viewer.render();
      const statTrak = attachmentsOf(viewer)?.statTrak ?? null;
      setState((previous) => ({
        ...previous,
        status: "ready",
        reloading: false,
        progress: undefined,
        error: undefined,
        item: loaded,
        views: loaded.views,
        view: viewer.view,
        mode: found.camera ? "3d" : (viewer.view ?? "3d"),
        camera: found.camera ? camera?.getCamera() : undefined,
        paint: viewer.paint,
        bindable: loaded.bindable,
        stickers: loadedStickers(viewer),
        charm: charmOf(request),
        statTrak,
        capabilities: found,
      }));
      callbacks.current.onReady?.(loaded);
    };

    run().catch((cause: unknown) => {
      if (cancelled) {
        return;
      }

      const error = asViewerError(cause);
      setState((previous) => {
        // A failed reload keeps the item that was loaded and reports the change.
        if (previous.reloading && previous.item !== undefined) {
          return { ...previous, reloading: false, actionError: asActionError(error) };
        }

        return { ...previous, status: "error", reloading: false, error };
      });
      callbacks.current.onError?.(error);
    });

    return () => {
      cancelled = true;
      abort.abort();
    };
    // The request is identified by its key.
  }, [viewer, requestKey]);

  // Runs a live change and presents the next frame. A refused change keeps
  // the current render and is reported as actionError.
  const change = useCallback((apply: (engine: Viewer) => Partial<ViewerState> | void) => {
    const engine = viewerRef.current;

    if (engine === undefined) {
      return;
    }

    try {
      const patch = apply(engine) ?? {};
      engine.render();
      setState((previous) => ({
        ...previous,
        view: engine.view,
        paint: engine.paint,
        actionError: undefined,
        ...patch,
      }));
    } catch (cause) {
      setState((previous) => ({ ...previous, actionError: asActionError(cause) }));
    }
  }, []);

  // The free camera is asynchronous; orbit and zoom accumulate into a target
  // pose that one loop at a time applies.
  const cameraTarget = useRef<{ yaw: number; pitch: number; distance: number } | undefined>(
    undefined,
  );
  const cameraBusy = useRef(false);

  const driveCamera = useCallback(async () => {
    const engine = viewerRef.current;
    const camera = engine === undefined ? undefined : cameraOf(engine);

    if (engine === undefined || camera === undefined || cameraBusy.current) {
      return;
    }

    cameraBusy.current = true;

    try {
      while (cameraTarget.current !== undefined) {
        const target = cameraTarget.current;
        cameraTarget.current = undefined;
        const next = await camera.setCamera(target);
        engine.render();
        setState((previous) => ({ ...previous, camera: next, mode: "3d" }));
      }
    } catch (cause) {
      setState((previous) => ({ ...previous, actionError: asActionError(cause) }));
    } finally {
      cameraBusy.current = false;
    }
  }, []);

  const moveCamera = useCallback(
    (update: (pose: CameraState) => { yaw: number; pitch: number; distance: number }) => {
      const engine = viewerRef.current;
      const camera = engine === undefined ? undefined : cameraOf(engine);

      if (camera === undefined) {
        return;
      }

      let current: CameraState;

      try {
        current = camera.getCamera();
      } catch {
        return;
      }

      const base = cameraTarget.current ?? current;
      const next = update({ ...current, ...base });
      // setCamera takes the pose fields only.
      cameraTarget.current = { yaw: next.yaw, pitch: next.pitch, distance: next.distance };
      void driveCamera();
    },
    [driveCamera],
  );

  // Changes that need another closure become a new request.
  const reload = useCallback((update: (previous: AttachmentRequest) => AttachmentRequest) => {
    setRequest((previous) => {
      if ("inspectLink" in previous) {
        return previous;
      }

      const engine = viewerRef.current;
      const base: AttachmentRequest = { ...(previous as AttachmentRequest) };

      // Carry the live seed, wear, sticker placement and counter into the new closure's request.
      if (engine !== undefined) {
        try {
          base.paintseed = engine.paint.paintseed;
          base.paintwear = engine.paint.paintwear;
          const methods = attachmentsOf(engine);
          const live = loadedStickers(engine);

          if (live.length > 0) {
            base.stickers = live.map(inspectSticker);
          }

          if (methods !== undefined && methods.statTrak !== null) {
            base.killeatervalue = methods.statTrak;
          }
        } catch {
          // Nothing loaded yet; keep the request's own values.
        }
      }

      return update(base);
    });
  }, []);

  const actions = useMemo<ViewerActions>(
    () => ({
      start: () => setStarted(true),
      load: (next) => {
        inspected.current = next;
        setRequest(next);
      },
      setMode: (mode) => {
        if (mode === "3d") {
          setState((previous) => ({ ...previous, mode: "3d" }));

          return;
        }

        change((engine) => {
          const camera = cameraOf(engine);

          if (camera !== undefined && capabilities(engine).camera) {
            camera.setPreset(mode);

            return { mode, camera: camera.getCamera() };
          }

          engine.setView(mode);

          return { mode };
        });
      },
      setSeed: (seed) => change((engine) => engine.setSeed(seed)),
      setWear: (wear) => change((engine) => engine.setWear(wear)),
      addSticker: (slot, id) =>
        reload((previous) => {
          const stickers = (previous.stickers ?? []).filter((entry) => entry.slot !== slot);
          stickers.push(inspectSticker({ slot, id }));

          return {
            ...previous,
            stickers: stickers.sort((a, b) => Number(a.slot) - Number(b.slot)),
          };
        }),
      removeSticker: (slot) =>
        reload((previous) => {
          const stickers = (previous.stickers ?? []).filter((entry) => entry.slot !== slot);
          const next: AttachmentRequest = { ...previous, stickers };

          if (stickers.length === 0) {
            delete next.stickers;
          }

          return next;
        }),
      editSticker: (slot, edit) =>
        change((engine) => {
          const methods = attachmentsOf(engine);

          if (methods === undefined) {
            return;
          }

          const current = loadedStickers(engine).find((entry) => entry.slot === slot);

          if (current === undefined) {
            return;
          }

          const next = editSticker([current], slot, edit)[0] as StickerPlacement;
          methods.setStickers([
            {
              slot,
              ...(next.wear === undefined ? {} : { wear: next.wear }),
              ...(next.rotation === undefined ? {} : { rotation: next.rotation }),
              ...(next.offset === undefined ? {} : { offset: next.offset }),
            },
          ]);

          return { stickers: loadedStickers(engine) };
        }),
      setStatTrak: (count) => {
        const engine = viewerRef.current;
        const methods = engine === undefined ? undefined : attachmentsOf(engine);
        const present = methods?.statTrak !== null && methods?.statTrak !== undefined;

        if (count !== null && present) {
          change((live) => {
            attachmentsOf(live)?.setStatTrak(count);

            return { statTrak: count };
          });

          return;
        }

        reload((previous) => {
          const next: AttachmentRequest = { ...previous };

          if (count === null) {
            delete next.killeatervalue;
          } else {
            next.killeatervalue = count;
          }

          return next;
        });
      },
      setCharm: (charm) =>
        reload((previous) => {
          const next: AttachmentRequest = { ...previous };

          if (charm === null) {
            delete next.keychains;
          } else {
            next.keychains = [inspectCharm(charm)];
          }

          return next;
        }),
      orbit: (yaw, pitch) =>
        moveCamera((pose) => ({ ...pose, yaw: pose.yaw + yaw, pitch: pose.pitch + pitch })),
      zoom: (factor) => moveCamera((pose) => ({ ...pose, distance: pose.distance / factor })),
      resetCamera: () =>
        change((engine) => {
          const camera = cameraOf(engine);

          if (camera === undefined || !capabilities(engine).camera) {
            return;
          }

          cameraTarget.current = undefined;
          camera.setPreset(engine.views.includes("front") ? "front" : (engine.view ?? ""));

          return { mode: "3d", camera: camera.getCamera() };
        }),
      resetToInspected: () => {
        const original = inspected.current;

        if (itemKey(original) !== requestKey) {
          setRequest(original);

          return;
        }

        change((engine) => {
          const attributes = (engine as unknown as { paint: PaintAttributes }).paint;
          const seed = "inspectLink" in original ? undefined : original.paintseed;
          const wear = "inspectLink" in original ? undefined : original.paintwear;

          if (seed !== undefined && seed !== attributes.paintseed) {
            engine.setSeed(seed);
          }

          if (wear !== undefined && wear !== attributes.paintwear) {
            engine.setWear(wearFromBits(wear));
          }
        });
      },
      renderPng: async (scale) => {
        const engine = viewerRef.current;

        if (engine === undefined) {
          return undefined;
        }

        const blob = await renderPng(engine, scale, (size) => {
          setState((previous) => ({ ...previous, exportSize: size }));
        });

        return blob;
      },
      download: async (scale, filename) => {
        const engine = viewerRef.current;

        if (engine === undefined) {
          return undefined;
        }

        const blob = await renderPng(engine, scale, (size) => {
          setState((previous) => ({ ...previous, exportSize: size }));
        });
        saveBlob(blob, filename ?? `${engine.view ?? "view"}.png`);

        return blob;
      },
      measure: async () => {
        const engine = viewerRef.current;

        if (engine === undefined) {
          return;
        }

        const pixels = await engine.renderToPixels();
        setState((previous) => ({
          ...previous,
          exportSize: { width: pixels.width, height: pixels.height },
        }));
      },
      retry: () => {
        setState((previous) => ({ ...previous, status: "checking", error: undefined }));
        setAttempt((value) => value + 1);
      },
      dismissError: () => setState((previous) => ({ ...previous, actionError: undefined })),
    }),
    [change, moveCamera, reload, requestKey],
  );

  return { state, actions, viewer };
}

// The float32 bits of a wear, for requests built from a float.
export function wearToBits(wear: number): number {
  return wearBits(wear);
}

// Keeps the canvas at its CSS size times the device pixel ratio and presents
// the current view again when that size changes.
export function useCanvasSize(
  viewer: Viewer | undefined,
  canvas: RefObject<HTMLCanvasElement | null>,
  ready: boolean,
): void {
  useEffect(() => {
    const element = canvas.current;

    if (element === null) {
      return;
    }

    let frame = 0;
    const present = () => {
      if (!ready || viewer === undefined) {
        return;
      }

      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => viewer.render());
    };

    const observer = new ResizeObserver(([entry]) => {
      if (entry === undefined) {
        return;
      }

      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      const width = Math.round(entry.contentRect.width * ratio);
      const height = Math.round(entry.contentRect.height * ratio);

      if (width === 0 || height === 0 || (element.width === width && element.height === height)) {
        return;
      }

      element.width = width;
      element.height = height;
      present();
    });
    observer.observe(element);
    present();

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [viewer, canvas, ready]);
}
