// The public engine: a headless viewer bound to a canvas (or none), which
// loads an item's compiled closure through a pluggable fetcher and renders its
// views with the item's own translated shaders.

import { BindError, bindRequest, wearBits, wearFromBits } from "./bind/binding.ts";
import { decodeBase64 } from "./bind/vfx.ts";
import type { ItemPose } from "./camera/orbit.ts";
import {
  cameraBufferBytes,
  type CameraPose,
  distanceRange,
  equivalentScene,
  pitchLimit,
  poseFov,
  presetCamera,
  type PresetCamera,
} from "./camera/rig.ts";
import {
  type AssetFetcher,
  type ClosureManifest,
  type ItemRequest,
  requestAttachments,
} from "./fetcher.ts";
import type { DrawContext } from "./gpu/draw.ts";
import { ItemModel, type StageImage } from "./gpu/item.ts";
import { ResourceCache } from "./gpu/resources.ts";
import { type ClosureReader, type ItemPlan, readItemPlan } from "./plan/walk.ts";
import type { TranslatedDraw } from "./translate/model.ts";

export type { StageImage } from "./gpu/item.ts";

export type SceneRig = "production" | "csfloat-fit";

export interface ViewerOptions {
  fetcher: AssetFetcher;
  canvas?: HTMLCanvasElement | OffscreenCanvas;
  // An existing device; the engine requests its own otherwise.
  device?: GPUDevice;
  rig?: SceneRig;
}

export type ViewerErrorCode =
  | "webgpu_unsupported"
  | "feature_missing"
  | "load_failed"
  | "unknown_view"
  | "device_lost"
  | "not_loaded"
  | "invalid_item_data"
  | "unsupported_binding"
  | "camera_unsupported"
  | "invalid_camera";

export class ViewerError extends Error {
  readonly code: ViewerErrorCode;

  constructor(code: ViewerErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ViewerError";
    this.code = code;
  }
}

export interface ViewerEvents {
  progress: {
    phase: "closure" | "files" | "pipelines";
    done: number;
    total: number;
    step?: string;
  };
  ready: { views: string[] };
  error: { error: ViewerError };
  frame: { view: string; milliseconds: number };
  camera: CameraState;
}

// The free camera of the current view. At a preset (`free` false) the view
// renders through its compiled draws; otherwise through its camera draws.
export interface CameraState {
  view: string;
  // Degrees the camera orbits right and up about the preset's orbit centre.
  yaw: number;
  pitch: number;
  // World units from the eye to the orbit centre, as the zoom shows it.
  distance: number;
  presetDistance: number;
  // The horizontal field of view in degrees.
  fov: number;
  free: boolean;
  // The scene the executor renders the same image from: the preset with this
  // item placement and, when zoomed, this horizontal field of view.
  scene: { item: ItemPose; fovHorizontal: number | undefined };
}

export interface LoadedItem {
  item: Record<string, unknown>;
  views: string[];
  // Request-time uniform keys the compile output exposes (seed, wear, ...).
  uniformKeys: string[];
  // Places where the WebGPU backend differs from the Vulkan executor.
  deviations: Record<string, number>;
  // The package's inspect attributes (paintseed, paintwear as float32 bits).
  attributes: Record<string, unknown>;
  // Attributes the package's binding programs can change live.
  bindable: string[];
}

// The paint attributes a loaded item renders with now.
export interface PaintAttributes {
  paintseed: number;
  // The float32 wear as its uint32 bits, as inspect data carries it.
  paintwear: number;
  // The same wear as a number.
  wear: number;
}

// The live placement of one applied sticker. Omitted fields keep their current value; `id`, when
// given, must be the kit the closure links in that slot.
export interface StickerPlacement {
  slot: number;
  id?: number;
  wear?: number;
  // Degrees, as inspect data carries it.
  rotation?: number;
  scale?: number;
  offset?: [number, number];
}

export interface Pixels {
  width: number;
  height: number;
  data: Uint8Array;
}

// Features the compiled CS2 shaders need on the device.
export const requiredFeatures: GPUFeatureName[] = [
  "texture-compression-bc",
  "texture-compression-bc-sliced-3d",
  "float32-filterable",
  "subgroups",
];

const limitNames = [
  "maxSampledTexturesPerShaderStage",
  "maxSamplersPerShaderStage",
  "maxStorageBuffersPerShaderStage",
  "maxUniformBuffersPerShaderStage",
  "maxStorageBufferBindingSize",
  "maxBufferSize",
  "maxTextureDimension2D",
  "maxInterStageShaderVariables",
] as const;

// Whether this browser can run the engine, without creating a device.
export async function detectSupport(): Promise<{ supported: boolean; missing: string[] }> {
  if (typeof navigator === "undefined" || navigator.gpu === undefined) {
    return { supported: false, missing: ["webgpu"] };
  }

  const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });

  if (adapter === null) {
    return { supported: false, missing: ["adapter"] };
  }

  const missing = requiredFeatures.filter((feature) => !adapter.features.has(feature));

  return { supported: missing.length === 0, missing };
}

async function requestDevice(): Promise<GPUDevice> {
  if (typeof navigator === "undefined" || navigator.gpu === undefined) {
    throw new ViewerError("webgpu_unsupported", "This browser has no WebGPU");
  }

  const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });

  if (adapter === null) {
    throw new ViewerError("webgpu_unsupported", "No WebGPU adapter is available");
  }

  const missing = requiredFeatures.filter((feature) => !adapter.features.has(feature));

  if (missing.length > 0) {
    throw new ViewerError("feature_missing", `The GPU lacks ${missing.join(", ")}`);
  }

  const requiredLimits: Record<string, number> = {};

  for (const name of limitNames) {
    requiredLimits[name] = adapter.limits[name];
  }

  return adapter.requestDevice({ requiredFeatures, requiredLimits });
}

type ItemPlanBinding = ItemPlan["binding"];

type Listener<K extends keyof ViewerEvents> = (event: ViewerEvents[K]) => void;

export class Viewer {
  readonly device: GPUDevice;

  private readonly fetcher: AssetFetcher;

  private readonly canvas: GPUCanvasContext | undefined;

  private readonly format: GPUTextureFormat;

  private readonly listeners = new Map<keyof ViewerEvents, Set<Listener<keyof ViewerEvents>>>();

  private model: ItemModel | undefined;

  private resources: ResourceCache | undefined;

  private current: string | undefined;

  // The package's attributes and the request attributes bound on top of them.
  private baseline: Record<string, unknown> = {};

  private requested: Record<string, unknown> = {};

  private lost = false;

  // Per view: its compiled pose and the free camera's pose now.
  private presets = new Map<string, PresetCamera>();

  private poses = new Map<string, CameraPose>();

  constructor(device: GPUDevice, options: ViewerOptions) {
    this.device = device;
    this.fetcher = options.fetcher;
    this.format = navigator.gpu.getPreferredCanvasFormat();

    if (options.canvas !== undefined) {
      const context = options.canvas.getContext("webgpu");

      if (context === null) {
        throw new ViewerError("webgpu_unsupported", "The canvas has no WebGPU context");
      }

      context.configure({ device, format: this.format, alphaMode: "premultiplied" });
      this.canvas = context;
    }

    void device.lost.then((info) => {
      this.lost = true;
      this.emit("error", { error: new ViewerError("device_lost", info.message) });
    });
  }

  on<K extends keyof ViewerEvents>(event: K, listener: Listener<K>): () => void {
    const set = this.listeners.get(event) ?? new Set();
    set.add(listener as Listener<keyof ViewerEvents>);
    this.listeners.set(event, set);

    return () => set.delete(listener as Listener<keyof ViewerEvents>);
  }

  private emit<K extends keyof ViewerEvents>(event: K, payload: ViewerEvents[K]): void {
    for (const listener of this.listeners.get(event) ?? []) {
      (listener as Listener<K>)(payload);
    }
  }

  get views(): string[] {
    return this.model === undefined ? [] : [...this.model.captures.keys()];
  }

  get view(): string | undefined {
    return this.current;
  }

  async load(request: ItemRequest, options: { signal?: AbortSignal } = {}): Promise<LoadedItem> {
    try {
      this.emit("progress", { phase: "closure", done: 0, total: 1 });
      const manifest = await this.fetcher.closure(request, options.signal);
      this.emit("progress", { phase: "closure", done: 1, total: 1 });
      const reader = this.reader(manifest, options.signal);
      const plan = await readItemPlan(reader, manifest.package);
      const resources = new ResourceCache(this.device, reader);
      const modules = new Map<string, Promise<GPUShaderModule>>();
      const translations = new Map<string, Promise<TranslatedDraw>>();
      const context: DrawContext = {
        device: this.device,
        resources,
        bytes: (path) => reader.bytes(path),
        ...(manifest.cameraTranslations === undefined
          ? {}
          : {
              cameraTranslation: (id: string) => {
                const path = manifest.cameraTranslations?.[id];

                if (path === undefined) {
                  return Promise.reject(
                    new Error(`The closure has no camera translation for ${id}`),
                  );
                }

                const existing = translations.get(path) ?? reader.json<TranslatedDraw>(path);
                translations.set(path, existing);

                return existing;
              },
            }),
        translation: (id) => {
          const path = manifest.translations[id];

          if (path === undefined) {
            return Promise.reject(new Error(`The closure has no translation for ${id}`));
          }

          const existing = translations.get(path) ?? reader.json<TranslatedDraw>(path);
          translations.set(path, existing);

          return existing;
        },
        shaderModule: (code) => {
          const existing = modules.get(code);

          if (existing !== undefined) {
            return existing;
          }

          const module = this.device.createShaderModule({ code });
          const checked = module.getCompilationInfo().then((info) => {
            const errors = info.messages.filter((message) => message.type === "error");

            if (errors.length > 0) {
              const lines = code.split("\n");
              const detail = errors
                .slice(0, 4)
                .map(
                  (message) =>
                    `${message.lineNum}:${message.linePos} ${message.message} | ${lines[message.lineNum - 1]?.trim() ?? ""}`,
                )
                .join("\n");

              throw new Error(`A translated shader does not compile:\n${detail}`);
            }

            return module;
          });
          modules.set(code, checked);

          return checked;
        },
      };
      this.device.pushErrorScope("validation");
      const model = await ItemModel.build(context, plan, (done, total, step) => {
        this.emit("progress", { phase: "pipelines", done, total, step });
      });
      const error = await this.device.popErrorScope();

      if (error !== null) {
        throw new Error(`WebGPU validation failed while building the item: ${error.message}`);
      }

      this.model = model;
      this.resources = resources;
      this.presets = new Map();
      this.poses = new Map();

      if (manifest.cameraTranslations !== undefined) {
        for (const capture of plan.captures) {
          const preset = presetCamera(capture.camera, capture.item);

          if (preset !== undefined) {
            this.presets.set(capture.name, preset);
          }
        }
      }

      const attributes = plan.item.attributes;
      this.baseline =
        attributes !== null && typeof attributes === "object"
          ? { ...(attributes as Record<string, unknown>) }
          : {};
      this.requested = { ...this.baseline };
      this.bindLoaded(manifest, request);
      this.current = model.captures.has("front") ? "front" : [...model.captures.keys()][0];
      const views = [...model.captures.keys()];
      this.emit("ready", { views });

      return {
        item: plan.item,
        views,
        uniformKeys: [...model.mutable.keys()],
        deviations: Object.fromEntries(resources.deviations),
        attributes: { ...this.baseline },
        bindable: bindableAttributes(plan.binding),
      };
    } catch (cause) {
      const error =
        cause instanceof ViewerError
          ? cause
          : new ViewerError("load_failed", String((cause as Error).message ?? cause), { cause });
      this.emit("error", { error });

      throw error;
    }
  }

  // A linked closure is shared by every placement of its stickers and every counter value, so
  // the request's own placement and counter are bound after loading: from the manifest's
  // `itemData` (the API adds it for an inspect link) and then from the request itself.
  private bindLoaded(manifest: ClosureManifest, request: ItemRequest): void {
    const change: Record<string, unknown> = {};

    for (const source of [manifest.itemData, requestAttachments(request)]) {
      if (source === undefined) {
        continue;
      }

      if (Array.isArray(source.stickers) && source.stickers.length > 0) {
        change.stickers = source.stickers;
      }

      if (source.killeatervalue !== undefined && source.killeatervalue !== null) {
        change.killeatervalue = source.killeatervalue;
      }
    }

    if (Object.keys(change).length > 0) {
      this.bindAttributes(change);
    }
  }

  private reader(manifest: ClosureManifest, signal: AbortSignal | undefined): ClosureReader {
    const cache = new Map<string, Promise<Uint8Array>>();
    const total = Object.keys(manifest.files).length;
    let done = 0;
    const bytes = (path: string): Promise<Uint8Array> => {
      const existing = cache.get(path);

      if (existing !== undefined) {
        return existing;
      }

      const entry = manifest.files[path];

      if (entry === undefined) {
        return Promise.reject(new Error(`The closure has no file ${path}`));
      }

      const loaded = this.fetcher.file(path, entry, signal).then((value) => {
        done++;
        this.emit("progress", { phase: "files", done, total });

        return value;
      });
      cache.set(path, loaded);

      return loaded;
    };

    return {
      bytes,
      json: async <T>(path: string) => JSON.parse(new TextDecoder().decode(await bytes(path))) as T,
    };
  }

  private loaded(): ItemModel {
    if (this.lost) {
      throw new ViewerError("device_lost", "The GPU device was lost");
    }

    if (this.model === undefined) {
      throw new ViewerError("not_loaded", "Load an item first");
    }

    return this.model;
  }

  setView(name: string): void {
    if (!this.loaded().captures.has(name)) {
      throw new ViewerError("unknown_view", `The item has no view ${name}`);
    }

    this.current = name;
  }

  // Switches to a compiled view at its compiled pose: the view renders
  // through its preset draws, so its pixels are the preset's exactly.
  setPreset(name: string): void {
    this.setView(name);
    this.loaded().setCameraActive(name, false);
    this.poses.delete(name);
    this.emit("camera", this.getCamera());
  }

  // Returns the current view to its compiled pose.
  resetCamera(): void {
    const view = this.current;

    if (view === undefined) {
      throw new ViewerError("not_loaded", "Load an item first");
    }

    this.setPreset(view);
  }

  // The free camera of the current view.
  getCamera(): CameraState {
    this.loaded();
    const view = this.current ?? "";
    const preset = this.presets.get(view);

    if (preset === undefined) {
      throw new ViewerError("camera_unsupported", `The view ${view} has no free camera`);
    }

    const pose = this.poses.get(view);
    const current = pose ?? { yaw: 0, pitch: 0, distance: preset.distance };

    return {
      view,
      yaw: current.yaw,
      pitch: current.pitch,
      distance: current.distance,
      presetDistance: preset.distance,
      fov: poseFov(preset, current),
      free: pose !== undefined,
      scene: equivalentScene(preset, current),
    };
  }

  // Moves the free camera of the current view: an orbit of `yaw` degrees to
  // the right and `pitch` degrees up about the preset's orbit centre, and a
  // zoom to `distance` world units. Omitted fields keep their value. The
  // first call on a view builds its camera pipelines. Pitch is clamped to
  // ±89 degrees and distance to 0.3 to 2 times the preset's. Throws
  // ViewerError camera_unsupported when the closure has no camera
  // translations, and invalid_camera for a value that is not finite.
  async setCamera(change: Partial<CameraPose>): Promise<CameraState> {
    const model = this.loaded();
    const view = this.current ?? "";
    const preset = this.presets.get(view);

    if (preset === undefined) {
      throw new ViewerError("camera_unsupported", `The view ${view} has no free camera`);
    }

    for (const [name, value] of Object.entries(change)) {
      if (value !== undefined && !Number.isFinite(value)) {
        throw new ViewerError("invalid_camera", `Camera ${name} must be a finite number`);
      }
    }

    const before = this.poses.get(view) ?? { yaw: 0, pitch: 0, distance: preset.distance };
    const [nearest, farthest] = distanceRange;
    const pose: CameraPose = {
      yaw: change.yaw ?? before.yaw,
      pitch: Math.min(pitchLimit, Math.max(-pitchLimit, change.pitch ?? before.pitch)),
      distance: Math.min(
        preset.distance * farthest,
        Math.max(preset.distance * nearest, change.distance ?? before.distance),
      ),
    };
    let camera;

    try {
      camera = await model.camera(view);
    } catch (cause) {
      throw new ViewerError("camera_unsupported", String((cause as Error).message ?? cause), {
        cause,
      });
    }

    for (const [path, buffer] of camera.buffers) {
      model.writeCameraBuffer(
        view,
        path,
        cameraBufferBytes(preset, pose, buffer.kind, buffer.original),
      );
    }

    model.setCameraActive(view, true);
    this.poses.set(view, pose);
    const state = this.getCamera();
    this.emit("camera", state);

    return state;
  }

  // Writes the bytes of a request-time uniform (the executor's uniformUpdates).
  setUniform(key: string, bytes: Uint8Array): void {
    this.loaded().setUniform(key, bytes);
  }

  // The seed and wear the next render uses.
  get paint(): PaintAttributes {
    this.loaded();
    const paintwear = Number(this.requested.paintwear);

    return {
      paintseed: Number(this.requested.paintseed),
      paintwear,
      wear: wearFromBits(paintwear),
    };
  }

  // Changes the paint seed of the loaded item. The package's binding programs
  // turn it into paint uniforms here, as the executor does for a request's
  // itemData, and the next render reruns the paint passes. Throws ViewerError
  // invalid_item_data or unsupported_binding without changing anything.
  setSeed(seed: number): void {
    this.bindAttributes({ paintseed: seed });
  }

  // Changes the wear (a float in [0, 1], rounded to float32 like the inspect
  // value) of the loaded item. See setSeed.
  setWear(wear: number): void {
    if (!Number.isFinite(wear)) {
      throw new ViewerError("invalid_item_data", `Wear must be a finite number, not ${wear}`);
    }

    this.bindAttributes({ paintwear: wearBits(wear) });
  }

  // The applied stickers in inspect form, with the placement the next render uses.
  get stickers(): Array<Record<string, unknown>> {
    this.loaded();
    const stickers = this.requested.stickers;

    return Array.isArray(stickers)
      ? stickers.map((sticker) => ({ ...(sticker as Record<string, unknown>) }))
      : [];
  }

  // Moves, turns, scales or wears applied stickers live, through the closure's sticker binding
  // program, as the executor binds a request's sticker placement. Another kit or slot needs
  // another closure: it throws ViewerError unsupported_binding and changes nothing, as does an
  // item without stickers. A value outside the executor's range throws invalid_item_data.
  setStickers(placements: StickerPlacement[]): void {
    const stickers = this.stickers;

    for (const placement of placements) {
      const sticker = stickers.find((entry) => entry.slot === placement.slot);

      if (sticker === undefined) {
        throw new ViewerError(
          "unsupported_binding",
          `The loaded closure has no sticker in slot ${placement.slot}; another sticker is another closure`,
        );
      }

      if (placement.id !== undefined && placement.id !== sticker.sticker_id) {
        throw new ViewerError(
          "unsupported_binding",
          `Slot ${placement.slot} holds sticker ${String(sticker.sticker_id)}; another kit is another closure`,
        );
      }

      if (placement.wear !== undefined) {
        sticker.wear = placement.wear;
      }

      if (placement.rotation !== undefined) {
        sticker.rotation = placement.rotation;
      }

      if (placement.scale !== undefined) {
        sticker.scale = placement.scale;
      }

      if (placement.offset !== undefined) {
        sticker.offset_x = placement.offset[0];
        sticker.offset_y = placement.offset[1];
      }
    }

    this.bindAttributes({ stickers });
  }

  // The StatTrak counter the next render shows, or null for an item without a counter module.
  get statTrak(): number | null {
    this.loaded();
    const value = this.requested.killeatervalue;

    return typeof value === "number" ? value : null;
  }

  // Sets the StatTrak counter (an integer from 0 to 999999) through the closure's counter
  // binding program. Adding or removing the counter module needs another closure, so null on a
  // StatTrak item and a number on an item without one throw unsupported_binding.
  setStatTrak(count: number | null): void {
    this.bindAttributes({ killeatervalue: count ?? undefined });
  }

  // Binds request attributes (paintseed, paintwear bits) on top of the
  // package's own and writes the resulting uniforms.
  private bindAttributes(change: Record<string, unknown>): void {
    const model = this.loaded();
    const requested = { ...this.requested, ...change };
    let updates;

    try {
      updates = bindRequest(model.plan.binding, requested);
    } catch (cause) {
      if (cause instanceof BindError) {
        throw new ViewerError(cause.code, cause.message, { cause });
      }

      throw cause;
    }

    model.applyUniforms(new Map(updates.map((update) => [update.key, decodeBase64(update.bytes)])));
    this.requested = requested;
  }

  // Renders the current view onto the canvas.
  render(): void {
    const model = this.loaded();

    if (this.canvas === undefined || this.current === undefined) {
      throw new ViewerError("not_loaded", "The viewer has no canvas");
    }

    const started = performance.now();
    model.present(this.current, this.canvas, this.format);
    this.emit("frame", { view: this.current, milliseconds: performance.now() - started });
  }

  // Renders a view at its compiled resolution and returns its RGBA8.
  async renderToPixels(view = this.current): Promise<Pixels> {
    const model = this.loaded();

    if (view === undefined || !model.captures.has(view)) {
      throw new ViewerError("unknown_view", `The item has no view ${String(view)}`);
    }

    const started = performance.now();
    this.device.pushErrorScope("validation");
    const pixels = await model.readPixels(view);
    const error = await this.device.popErrorScope();

    if (error !== null) {
      throw new Error(`WebGPU validation failed while rendering: ${error.message}`);
    }

    this.emit("frame", { view, milliseconds: performance.now() - started });

    return pixels;
  }

  // Renders a view and encodes it with the browser's image encoder. A 2D
  // canvas stores premultiplied alpha, so semi-transparent pixels can lose a
  // level; renderToPixels returns the exact bytes.
  async renderToBlob(view = this.current, type = "image/png"): Promise<Blob> {
    const pixels = await this.renderToPixels(view);
    const canvas = new OffscreenCanvas(pixels.width, pixels.height);
    const context = canvas.getContext("2d");

    if (context === null) {
      throw new Error("No 2D canvas for encoding");
    }

    context.putImageData(
      new ImageData(new Uint8ClampedArray(pixels.data), pixels.width, pixels.height),
      0,
      0,
    );

    return canvas.convertToBlob({ type });
  }

  // Read-only debug hooks: the intermediate stages of a view (paint draw,
  // paint mip chain, BC7 blocks, shadow atlas, HDR scene, each post pass) as
  // the backend computed them, for stage-by-stage comparison with the
  // executor. Reading renders the view; it changes no state.
  stages(view = this.current): string[] {
    const model = this.loaded();

    if (view === undefined || !model.captures.has(view)) {
      throw new ViewerError("unknown_view", `The item has no view ${String(view)}`);
    }

    return model.stageSources(view).map((source) => source.stage);
  }

  async readStages(stages: string[], view = this.current): Promise<StageImage[]> {
    const model = this.loaded();

    if (view === undefined || !model.captures.has(view)) {
      throw new ViewerError("unknown_view", `The item has no view ${String(view)}`);
    }

    this.device.pushErrorScope("validation");
    const images = await model.readStages(view, stages);
    const error = await this.device.popErrorScope();

    if (error !== null) {
      throw new Error(`WebGPU validation failed while reading stages: ${error.message}`);
    }

    return images;
  }

  deviations(): Record<string, number> {
    return Object.fromEntries(this.resources?.deviations ?? []);
  }

  destroy(): void {
    this.model = undefined;
    this.device.destroy();
  }
}

function bindableAttributes(binding: ItemPlanBinding): string[] {
  const names: string[] = [];

  for (const block of [binding.paint, binding.surface, binding.stattrak]) {
    const attributes = (block?.binding as { attributes?: Record<string, unknown> } | undefined)
      ?.attributes;

    for (const [name, support] of Object.entries(attributes ?? {})) {
      if (support === "bound") {
        names.push(name);
      }
    }
  }

  return names;
}

export async function createViewer(options: ViewerOptions): Promise<Viewer> {
  const device = options.device ?? (await requestDevice());

  return new Viewer(device, options);
}
