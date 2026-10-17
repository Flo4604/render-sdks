// One resident item on a WebGPU device, built from the compiled plan the way
// graph/item_model.cpp builds it for Vulkan: the generated paints (paint draw,
// sRGB mip chain, the original BC7 compressor per mip, blocks copied into a
// sampled BC7 image) and per capture the shadow atlas, the scene with its
// compute passes and snapshots, and the post graph ending in RGBA8.

import type { CapturePlan, ComputePlan, ItemPlan, PaintPlan } from "../plan/walk.ts";
import { Blitter } from "./blit.ts";
import {
  type CameraBuffers,
  type ComputeDraw,
  createDraw,
  type DrawContext,
  type GraphicsDraw,
  type LiveInputs,
  type MutableUniform,
  type PaintOutput,
  recordGraphics,
} from "./draw.ts";

const align = (value: number, to: number) => Math.ceil(value / to) * to;

function sameBytes(left: Uint8Array | undefined, right: Uint8Array | undefined): boolean {
  if (left === undefined || right === undefined || left.length !== right.length) {
    return false;
  }

  return left.every((value, index) => value === right[index]);
}

interface PaintModel {
  plan: PaintPlan;
  target: GPUTexture;
  draw: GraphicsDraw;
  chain: GPUTexture;
  compressed: GPUTexture;
  blocks: GPUTexture[];
  transfer: GPUBuffer;
  transferOffsets: number[];
  compressors: Array<{ draw: ComputeDraw; dispatch: [number, number] }>;
  output: PaintOutput;
}

interface ComputeModel {
  buffers: Array<{ buffer: GPUBuffer; clear: number; bytes: number }>;
  passes: Array<{ draw: ComputeDraw; dispatch: [number, number, number] }>;
}

interface ShadowModel {
  name: string;
  target: GPUTexture;
  compute: ComputeModel;
  draws: GraphicsDraw[];
}

interface PostModel {
  name: string;
  target: GPUTexture;
  clearColor: [number, number, number, number];
  draw: GraphicsDraw;
}

// A capture's free-camera draws: the scene and shadow draws again, with their
// camera translations and the capture's own copies of the buffers the camera
// rewrites. Built on first use; the preset draws stay as they are.
export interface CameraBuffer {
  buffer: GPUBuffer;
  original: Uint8Array;
  kind: "transforms" | "perView" | "csgoView";
}

export interface CameraModel {
  // Closure path -> the capture's copy, the file's bytes and what it holds.
  buffers: Map<string, CameraBuffer>;
  shadows: GraphicsDraw[][];
  draws: GraphicsDraw[];
}

export interface CaptureModel {
  name: string;
  width: number;
  height: number;
  shadows: ShadowModel[];
  compute: ComputeModel;
  color: GPUTexture;
  depth: GPUTexture;
  clearColor: [number, number, number, number];
  snapshots: Array<{ beforeDraw: number; texture: GPUTexture }>;
  draws: GraphicsDraw[];
  post: PostModel[];
  output: GPUTexture;
  // Set while the capture renders through its camera draws.
  camera: CameraModel | undefined;
  cameraActive: boolean;
  buildCamera(): Promise<CameraModel>;
}

// One intermediate image of a view: a texture mip, or a paint pass's BC7
// block images.
export interface StageSource {
  stage: string;
  texture?: GPUTexture;
  mipLevel?: number;
  blocks?: GPUTexture[];
}

export interface StageImage {
  stage: string;
  // The WebGPU texture format, or "bc7" for raw BC7 blocks.
  format: string;
  width: number;
  height: number;
  data: Uint8Array;
}

function texelBytes(format: GPUTextureFormat): number {
  switch (format) {
    case "rgba32uint": {
      return 16;
    }

    case "rgba16float": {
      return 8;
    }

    case "depth16unorm": {
      return 2;
    }

    default: {
      return 4;
    }
  }
}

export interface BuildProgress {
  (done: number, total: number, step: string): void;
}

const depthFormats: Record<string, GPUTextureFormat> = {
  d32f: "depth32float",
  d24s8: "depth24plus-stencil8",
};

export class ItemModel {
  readonly plan: ItemPlan;

  readonly captures = new Map<string, CaptureModel>();

  readonly mutable = new Map<string, MutableUniform[]>();

  private readonly device: GPUDevice;

  private readonly blitter: Blitter;

  private paints: PaintModel[] = [];

  // Mutable keys the paint passes read; a change to one reruns paint.
  private readonly paintKeys = new Set<string>();

  // The bytes each mutable key holds on the device now.
  private readonly written = new Map<string, Uint8Array>();

  // The paint keys' bytes the current paint result was rendered with, or
  // undefined before the first paint.
  private paintBytes: Map<string, Uint8Array> | undefined;

  private constructor(context: DrawContext, plan: ItemPlan) {
    this.device = context.device;
    this.plan = plan;
    this.blitter = new Blitter(context.device);
  }

  static async build(
    context: DrawContext,
    plan: ItemPlan,
    progress?: BuildProgress,
  ): Promise<ItemModel> {
    const model = new ItemModel(context, plan);
    const total =
      plan.paints.reduce((sum, paint) => sum + 1 + paint.compressors.length, 0) +
      plan.captures.reduce(
        (sum, capture) =>
          sum +
          capture.shadows.reduce(
            (inner, shadow) => inner + shadow.draws.length + shadow.compute.passes.length,
            0,
          ) +
          capture.scene.draws.length +
          capture.scene.compute.passes.length +
          capture.scene.post.length,
        0,
      );
    let done = 0;
    const step = (name: string) => {
      done++;
      progress?.(done, total, name);
    };

    for (const paint of plan.paints) {
      model.paints.push(await model.buildPaint(context, paint, step));
    }

    for (const capture of plan.captures) {
      model.captures.set(capture.name, await model.buildCapture(context, capture, step));
    }

    return model;
  }

  private remember(draw: GraphicsDraw | ComputeDraw, paint = false): void {
    for (const uniform of draw.mutable) {
      const list = this.mutable.get(uniform.key) ?? [];
      list.push(uniform);
      this.mutable.set(uniform.key, list);

      if (!this.written.has(uniform.key)) {
        this.written.set(uniform.key, uniform.baseline);
      }

      if (paint) {
        this.paintKeys.add(uniform.key);
      }
    }
  }

  private async buildPaint(
    context: DrawContext,
    plan: PaintPlan,
    step: (name: string) => void,
  ): Promise<PaintModel> {
    const device = this.device;
    const size = plan.size;
    const targetFormat: GPUTextureFormat = plan.outputSrgb ? "rgba8unorm-srgb" : "rgba8unorm";
    const target = device.createTexture({
      size: [size, size],
      format: targetFormat,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    });
    const draw = (await createDraw(
      context,
      plan.draw,
      { color: targetFormat, depth: undefined, width: size, height: size },
      {},
    )) as GraphicsDraw;
    this.remember(draw, true);
    step(`paint ${plan.name}`);

    const chainFormat: GPUTextureFormat = plan.srgbBlit ? "rgba8unorm-srgb" : "rgba8unorm";
    const chain = device.createTexture({
      size: [size, size],
      format: chainFormat,
      mipLevelCount: plan.levels,
      usage:
        GPUTextureUsage.COPY_DST |
        GPUTextureUsage.COPY_SRC |
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.RENDER_ATTACHMENT,
      viewFormats: plan.srgbBlit ? ["rgba8unorm"] : [],
    });
    const compressedFormat: GPUTextureFormat = plan.sampleSrgb
      ? "bc7-rgba-unorm-srgb"
      : "bc7-rgba-unorm";
    const alternate: GPUTextureFormat = plan.sampleSrgb ? "bc7-rgba-unorm" : "bc7-rgba-unorm-srgb";
    const compressed = device.createTexture({
      size: [size, size],
      format: compressedFormat,
      mipLevelCount: plan.levels,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      viewFormats: [alternate],
    });
    const blocks: GPUTexture[] = [];
    const transferOffsets: number[] = [];
    let transferBytes = 0;

    for (let mip = 0; mip < plan.levels; mip++) {
      const blockSize = Math.max(1, Math.floor(Math.max(1, size >> mip) / 4));
      blocks.push(
        device.createTexture({
          size: [blockSize, blockSize],
          format: "rgba32uint",
          usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC,
        }),
      );
      transferOffsets.push(transferBytes);
      transferBytes += align(blockSize * 16, 256) * blockSize;
    }

    const transfer = device.createBuffer({
      size: transferBytes,
      usage: GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
    });
    const encodedView = chain.createView({ format: "rgba8unorm" });
    const compressors: PaintModel["compressors"] = [];

    for (const compressor of plan.compressors) {
      const live: LiveInputs = {
        images: new Map([["sceneColor", encodedView]]),
        storageOutputs: blocks
          .slice(compressor.mip, compressor.mip + compressor.outputs)
          .map((block) => block.createView()),
      };
      const compute = (await createDraw(context, compressor.draw, undefined, live)) as ComputeDraw;
      this.remember(compute, true);
      compressors.push({ draw: compute, dispatch: compressor.dispatch });
      step(`compress ${plan.name} mip ${compressor.mip}`);
    }

    const views = new Map<boolean, GPUTextureView>([
      [plan.sampleSrgb, compressed.createView()],
      [!plan.sampleSrgb, compressed.createView({ format: alternate })],
    ]);

    return {
      plan,
      target,
      draw,
      chain,
      compressed,
      blocks,
      transfer,
      transferOffsets,
      compressors,
      output: {
        identity: plan.identity,
        replacement: plan.replacement,
        size,
        levels: plan.levels,
        view: (srgb) => views.get(srgb) ?? compressed.createView(),
      },
    };
  }

  private async buildCompute(
    context: DrawContext,
    plan: ComputePlan,
    step: (name: string) => void,
  ): Promise<{ model: ComputeModel; buffers: Map<string, GPUBuffer> }> {
    const buffers = new Map<string, GPUBuffer>();
    const model: ComputeModel = { buffers: [], passes: [] };

    for (const entry of plan.buffers) {
      const buffer = this.device.createBuffer({
        size: entry.bytes,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
      });
      buffers.set(`buffer:${entry.name}`, buffer);
      model.buffers.push({ buffer, clear: entry.clear, bytes: entry.bytes });
    }

    for (const pass of plan.passes) {
      const draw = (await createDraw(context, pass.draw, undefined, { buffers })) as ComputeDraw;
      this.remember(draw);
      model.passes.push({ draw, dispatch: pass.dispatch });
      step("compute");
    }

    return { model, buffers };
  }

  private async buildCapture(
    context: DrawContext,
    plan: CapturePlan,
    step: (name: string) => void,
  ): Promise<CaptureModel> {
    const device = this.device;
    const paints = this.paints.map((paint) => paint.output);
    const shadows: ShadowModel[] = [];
    const shadowBuffers: Array<Map<string, GPUBuffer>> = [];
    const images = new Map<string, GPUTextureView>();

    for (const shadow of plan.shadows) {
      const target = device.createTexture({
        size: [shadow.width, shadow.height],
        format: "depth16unorm",
        usage:
          GPUTextureUsage.RENDER_ATTACHMENT |
          GPUTextureUsage.TEXTURE_BINDING |
          GPUTextureUsage.COPY_SRC,
      });
      const compute = await this.buildCompute(context, shadow.compute, step);
      const draws: GraphicsDraw[] = [];

      for (const draw of shadow.draws) {
        const prepared = (await createDraw(
          context,
          draw,
          { color: undefined, depth: "depth16unorm", width: shadow.width, height: shadow.height },
          { buffers: compute.buffers, paints },
        )) as GraphicsDraw;
        this.remember(prepared);
        draws.push(prepared);
        step(`shadow ${plan.name}`);
      }

      shadows.push({ name: shadow.name, target, compute: compute.model, draws });
      shadowBuffers.push(compute.buffers);
      images.set(`shadow:${shadow.name}`, target.createView());
    }

    const scene = plan.scene;
    const depthFormat = depthFormats[scene.depthFormat] ?? "depth32float";
    const color = device.createTexture({
      size: [scene.width, scene.height],
      format: "rgba16float",
      usage:
        GPUTextureUsage.RENDER_ATTACHMENT |
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_SRC,
    });
    const depth = device.createTexture({
      size: [scene.width, scene.height],
      format: depthFormat,
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
    const compute = await this.buildCompute(context, scene.compute, step);
    const snapshots = scene.snapshots
      .map((snapshot) => ({
        name: snapshot.name,
        beforeDraw: snapshot.beforeDraw,
        texture: device.createTexture({
          size: [scene.width, scene.height],
          format: "rgba16float",
          usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING,
        }),
      }))
      .sort((a, b) => a.beforeDraw - b.beforeDraw);
    const draws: GraphicsDraw[] = [];

    const drawImagesAt = (index: number) => {
      const drawImages = new Map(images);

      for (const snapshot of snapshots) {
        if (snapshot.beforeDraw <= index) {
          drawImages.set(`snapshot:${snapshot.name}`, snapshot.texture.createView());
        }
      }

      return drawImages;
    };

    for (const [index, draw] of scene.draws.entries()) {
      const drawImages = drawImagesAt(index);
      const prepared = (await createDraw(
        context,
        draw,
        { color: "rgba16float", depth: depthFormat, width: scene.width, height: scene.height },
        { images: drawImages, buffers: compute.buffers, paints },
      )) as GraphicsDraw;
      this.remember(prepared);
      draws.push(prepared);
      step(`scene ${plan.name}`);
    }

    const buildCamera = async (): Promise<CameraModel> => {
      const buffers: CameraModel["buffers"] = new Map();
      const cameraBuffers = (role: "scene" | "shadow"): CameraBuffers => ({
        role,
        buffer: (path, contents, minimum, descriptor) => {
          const existing = buffers.get(path);

          if (existing !== undefined) {
            return existing.buffer;
          }

          const buffer = device.createBuffer({
            size: Math.max(minimum, Math.ceil(contents.length / 16) * 16, 16),
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
          });
          const padded = new Uint8Array(Math.ceil(contents.length / 4) * 4);
          padded.set(contents);
          device.queue.writeBuffer(buffer, 0, padded);
          const kind =
            descriptor.binding === 30
              ? "transforms"
              : descriptor.binding === 1
                ? "perView"
                : "csgoView";
          buffers.set(path, { buffer, original: contents, kind });

          return buffer;
        },
      });
      const cameraShadows: GraphicsDraw[][] = [];

      for (const [index, shadow] of plan.shadows.entries()) {
        const list: GraphicsDraw[] = [];

        for (const draw of shadow.draws) {
          list.push(
            (await createDraw(
              context,
              draw,
              {
                color: undefined,
                depth: "depth16unorm",
                width: shadow.width,
                height: shadow.height,
              },
              {
                buffers: shadowBuffers[index] ?? new Map(),
                paints,
                camera: cameraBuffers("shadow"),
              },
            )) as GraphicsDraw,
          );
        }

        cameraShadows.push(list);
      }

      const cameraDraws: GraphicsDraw[] = [];

      for (const [index, draw] of scene.draws.entries()) {
        cameraDraws.push(
          (await createDraw(
            context,
            draw,
            { color: "rgba16float", depth: depthFormat, width: scene.width, height: scene.height },
            {
              images: drawImagesAt(index),
              buffers: compute.buffers,
              paints,
              camera: cameraBuffers("scene"),
            },
          )) as GraphicsDraw,
        );
      }

      return { buffers, shadows: cameraShadows, draws: cameraDraws };
    };

    const post: PostModel[] = [];
    const postImages = new Map<string, GPUTextureView>([["sceneColor", color.createView()]]);

    for (const pass of scene.post) {
      const format: GPUTextureFormat = pass.final
        ? pass.outputSrgb
          ? "rgba8unorm-srgb"
          : "rgba8unorm"
        : "rgba16float";
      const target = device.createTexture({
        size: [pass.width, pass.height],
        format,
        usage:
          GPUTextureUsage.RENDER_ATTACHMENT |
          GPUTextureUsage.TEXTURE_BINDING |
          GPUTextureUsage.COPY_SRC,
      });

      if ((pass.draw.spec.depthTest ?? false) || (pass.draw.spec.depthWrite ?? false)) {
        throw new Error(`Post pass ${pass.name} uses depth, which the viewer does not support yet`);
      }

      const prepared = (await createDraw(
        context,
        pass.draw,
        { color: format, depth: undefined, width: pass.width, height: pass.height },
        { images: postImages },
      )) as GraphicsDraw;
      this.remember(prepared);
      post.push({ name: pass.name, target, clearColor: pass.clearColor, draw: prepared });
      postImages.set(`pass:${pass.name}`, target.createView());
      step(`post ${pass.name}`);
    }

    const output = post.at(-1)?.target;

    if (output === undefined) {
      throw new Error(`Capture ${plan.name} has no post output`);
    }

    return {
      name: plan.name,
      width: scene.width,
      height: scene.height,
      shadows,
      compute: compute.model,
      color,
      depth,
      clearColor: scene.clearColor,
      snapshots,
      draws,
      post,
      output,
      camera: undefined,
      cameraActive: false,
      buildCamera,
    };
  }

  // The capture's camera draws, built on first use.
  async camera(name: string): Promise<CameraModel> {
    const capture = this.captures.get(name);

    if (capture === undefined) {
      throw new Error(`Unknown view ${name}`);
    }

    if (capture.camera === undefined) {
      this.device.pushErrorScope("validation");
      const built = await capture.buildCamera();
      const error = await this.device.popErrorScope();

      if (error !== null) {
        throw new Error(`WebGPU validation failed while building the camera: ${error.message}`);
      }

      capture.camera = built;
    }

    return capture.camera;
  }

  // Renders the capture through its camera draws (`active`) or its preset
  // draws. The camera must be built.
  setCameraActive(name: string, active: boolean): void {
    const capture = this.captures.get(name);

    if (capture === undefined) {
      throw new Error(`Unknown view ${name}`);
    }

    if (active && capture.camera === undefined) {
      throw new Error(`The camera of ${name} is not built`);
    }

    capture.cameraActive = active;
  }

  // Writes bytes into the capture's camera copy of a closure file.
  writeCameraBuffer(name: string, path: string, bytes: Uint8Array): void {
    const camera = this.captures.get(name)?.camera;
    const entry = camera?.buffers.get(path);

    if (entry === undefined) {
      throw new Error(`The camera of ${name} has no buffer ${path}`);
    }

    const padded = new Uint8Array(Math.ceil(bytes.length / 4) * 4);
    padded.set(bytes);
    this.device.queue.writeBuffer(entry.buffer, 0, padded);
  }

  // Writes request-time uniform bytes (the executor's uniformUpdates). Paint
  // reruns at the next render when a paint key's bytes differ from the ones
  // the current paint result was rendered with.
  setUniform(key: string, bytes: Uint8Array): void {
    const targets = this.mutable.get(key);

    if (targets === undefined) {
      throw new Error(`Unknown mutable uniform ${key}`);
    }

    for (const target of targets) {
      if (bytes.length !== target.baseline.length) {
        throw new Error(`Uniform ${key} takes ${target.baseline.length} bytes`);
      }
    }

    if (sameBytes(this.written.get(key), bytes)) {
      return;
    }

    const padded = new Uint8Array(Math.ceil(bytes.length / 4) * 4);
    padded.set(bytes);

    for (const target of targets) {
      this.device.queue.writeBuffer(target.buffer, 0, padded);
    }

    this.written.set(key, bytes.slice());
  }

  // Applies one request's uniform updates the way the executor does: every
  // key the updates omit returns to its package baseline, and only bytes that
  // differ from what the device holds are written.
  applyUniforms(updates: ReadonlyMap<string, Uint8Array>): void {
    for (const key of updates.keys()) {
      if (!this.mutable.has(key)) {
        throw new Error(`Unknown mutable uniform ${key}`);
      }
    }

    for (const [key, targets] of this.mutable) {
      const baseline = targets[0]?.baseline;
      const bytes = updates.get(key) ?? baseline;

      if (bytes !== undefined) {
        this.setUniform(key, bytes);
      }
    }
  }

  // Whether the next render reruns the paint passes.
  get paintPending(): boolean {
    const painted = this.paintBytes;

    if (painted === undefined) {
      return true;
    }

    for (const key of this.paintKeys) {
      if (!sameBytes(painted.get(key), this.written.get(key))) {
        return true;
      }
    }

    return false;
  }

  private recordCompute(encoder: GPUCommandEncoder, compute: ComputeModel): void {
    if (compute.passes.length === 0) {
      return;
    }

    for (const buffer of compute.buffers) {
      if (buffer.clear === 0) {
        encoder.clearBuffer(buffer.buffer);
      } else {
        const words = new Uint32Array(buffer.bytes / 4).fill(buffer.clear);
        this.device.queue.writeBuffer(buffer.buffer, 0, words);
      }
    }

    for (const pass of compute.passes) {
      const computePass = encoder.beginComputePass();
      computePass.setPipeline(pass.draw.pipeline);
      computePass.setBindGroup(0, pass.draw.bindGroup);
      computePass.dispatchWorkgroups(...pass.dispatch);
      computePass.end();
    }
  }

  private recordPaint(encoder: GPUCommandEncoder, paint: PaintModel): void {
    const size = paint.plan.size;
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: paint.target.createView(),
          loadOp: "clear",
          storeOp: "store",
          clearValue: [0, 0, 0, 0],
        },
      ],
    });
    recordGraphics(pass, paint.draw);
    pass.end();
    encoder.copyTextureToTexture({ texture: paint.target }, { texture: paint.chain, mipLevel: 0 }, [
      size,
      size,
    ]);

    for (let mip = 1; mip < paint.plan.levels; mip++) {
      this.blitter.downsample(
        encoder,
        paint.chain.createView({ format: "rgba8unorm", baseMipLevel: mip - 1, mipLevelCount: 1 }),
        paint.chain.createView({ format: "rgba8unorm", baseMipLevel: mip, mipLevelCount: 1 }),
        paint.plan.srgbBlit,
      );
    }

    for (const compressor of paint.compressors) {
      const computePass = encoder.beginComputePass();
      computePass.setPipeline(compressor.draw.pipeline);
      computePass.setBindGroup(0, compressor.draw.bindGroup);
      computePass.dispatchWorkgroups(compressor.dispatch[0], compressor.dispatch[1], 1);
      computePass.end();
    }

    for (let mip = 0; mip < paint.plan.levels; mip++) {
      const block = paint.blocks[mip] as GPUTexture;
      const bytesPerRow = align(block.width * 16, 256);
      const offset = paint.transferOffsets[mip] ?? 0;
      encoder.copyTextureToBuffer(
        { texture: block },
        { buffer: paint.transfer, offset, bytesPerRow, rowsPerImage: block.height },
        [block.width, block.height],
      );
      const physical = Math.max(4, align(Math.max(1, size >> mip), 4));
      encoder.copyBufferToTexture(
        { buffer: paint.transfer, offset, bytesPerRow, rowsPerImage: block.height },
        { texture: paint.compressed, mipLevel: mip },
        [physical, physical],
      );
    }
  }

  // Records paint (when its uniforms changed) and one capture into `encoder`.
  record(encoder: GPUCommandEncoder, name: string): CaptureModel {
    const capture = this.captures.get(name);

    if (capture === undefined) {
      throw new Error(`Unknown view ${name}`);
    }

    if (this.paintPending) {
      this.paints.forEach((paint) => this.recordPaint(encoder, paint));
      this.paintBytes = new Map(
        [...this.paintKeys].map((key) => [key, this.written.get(key) ?? new Uint8Array()]),
      );
    }

    const camera = capture.cameraActive ? capture.camera : undefined;

    for (const [index, shadow] of capture.shadows.entries()) {
      this.recordCompute(encoder, shadow.compute);
      const pass = encoder.beginRenderPass({
        colorAttachments: [],
        depthStencilAttachment: {
          view: shadow.target.createView(),
          depthLoadOp: "clear",
          depthStoreOp: "store",
          depthClearValue: 1,
        },
      });
      (camera?.shadows[index] ?? shadow.draws).forEach((draw) => recordGraphics(pass, draw));
      pass.end();
    }

    this.recordCompute(encoder, capture.compute);
    const stencil = capture.depth.format === "depth24plus-stencil8";
    const begin = (load: GPULoadOp) =>
      encoder.beginRenderPass({
        colorAttachments: [
          {
            view: capture.color.createView(),
            loadOp: load,
            storeOp: "store",
            clearValue: capture.clearColor,
          },
        ],
        depthStencilAttachment: {
          view: capture.depth.createView(),
          depthLoadOp: load,
          depthStoreOp: "store",
          depthClearValue: 1,
          ...(stencil
            ? { stencilLoadOp: load, stencilStoreOp: "store" as const, stencilClearValue: 0 }
            : {}),
        },
      });
    let pass = begin("clear");
    let snapshot = 0;

    (camera?.draws ?? capture.draws).forEach((draw, index) => {
      if (capture.snapshots[snapshot]?.beforeDraw === index) {
        pass.end();

        while (capture.snapshots[snapshot]?.beforeDraw === index) {
          const target = capture.snapshots[snapshot]?.texture as GPUTexture;
          encoder.copyTextureToTexture({ texture: capture.color }, { texture: target }, [
            capture.width,
            capture.height,
          ]);
          snapshot++;
        }

        pass = begin("load");
      }

      recordGraphics(pass, draw);
    });
    pass.end();

    for (const post of capture.post) {
      const postPass = encoder.beginRenderPass({
        colorAttachments: [
          {
            view: post.target.createView(),
            loadOp: "clear",
            storeOp: "store",
            clearValue: post.clearColor,
          },
        ],
      });
      recordGraphics(postPass, post.draw);
      postPass.end();
    }

    return capture;
  }

  // Renders one view and reads back its RGBA8, tightly packed.
  async readPixels(name: string): Promise<{ width: number; height: number; data: Uint8Array }> {
    const encoder = this.device.createCommandEncoder();
    const capture = this.record(encoder, name);
    const bytesPerRow = align(capture.width * 4, 256);
    const readback = this.device.createBuffer({
      size: bytesPerRow * capture.height,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    encoder.copyTextureToBuffer({ texture: capture.output }, { buffer: readback, bytesPerRow }, [
      capture.width,
      capture.height,
    ]);
    this.device.queue.submit([encoder.finish()]);
    await readback.mapAsync(GPUMapMode.READ);
    const mapped = new Uint8Array(readback.getMappedRange());
    const data = new Uint8Array(capture.width * capture.height * 4);

    for (let row = 0; row < capture.height; row++) {
      data.set(
        mapped.subarray(row * bytesPerRow, row * bytesPerRow + capture.width * 4),
        row * capture.width * 4,
      );
    }

    readback.unmap();
    readback.destroy();

    return { width: capture.width, height: capture.height, data };
  }

  // The intermediate images of one view, by stage name, for read-only
  // fidelity checks against the executor's stages.
  stageSources(name: string): StageSource[] {
    const capture = this.captures.get(name);

    if (capture === undefined) {
      throw new Error(`Unknown view ${name}`);
    }

    const sources: StageSource[] = [];

    for (const paint of this.paints) {
      const base = `paint/${paint.plan.name}`;
      sources.push({ stage: `${base}/draw`, texture: paint.target, mipLevel: 0 });

      for (let mip = 0; mip < paint.plan.levels; mip++) {
        sources.push({ stage: `${base}/chain/${mip}`, texture: paint.chain, mipLevel: mip });
      }

      sources.push({ stage: `${base}/bc7`, blocks: paint.blocks });
    }

    for (const shadow of capture.shadows) {
      sources.push({ stage: `shadow/${shadow.name}`, texture: shadow.target, mipLevel: 0 });
    }

    sources.push({ stage: "scene", texture: capture.color, mipLevel: 0 });

    for (const post of capture.post) {
      sources.push({ stage: `post/${post.name}`, texture: post.target, mipLevel: 0 });
    }

    return sources;
  }

  // Renders one view and reads back the named stages. Texels are tightly
  // packed rows; `bc7` stages are the compressor's blocks, mip 0 first, in
  // the layout of a raw BC7 texture file.
  async readStages(name: string, stages: string[]): Promise<StageImage[]> {
    const sources = this.stageSources(name);
    const wanted = stages.map((stage) => {
      const source = sources.find((candidate) => candidate.stage === stage);

      if (source === undefined) {
        throw new Error(`View ${name} has no stage ${stage}`);
      }

      return source;
    });
    const encoder = this.device.createCommandEncoder();
    this.record(encoder, name);
    const reads: Array<{
      stage: string;
      format: string;
      width: number;
      height: number;
      parts: Array<{ buffer: GPUBuffer; bytesPerRow: number; rowBytes: number; rows: number }>;
    }> = [];

    for (const source of wanted) {
      const textures =
        source.blocks === undefined
          ? [{ texture: source.texture as GPUTexture, mipLevel: source.mipLevel ?? 0 }]
          : source.blocks.map((texture) => ({ texture, mipLevel: 0 }));
      const parts = textures.map(({ texture, mipLevel }) => {
        const width = Math.max(1, texture.width >> mipLevel);
        const height = Math.max(1, texture.height >> mipLevel);
        const rowBytes = width * texelBytes(texture.format);
        const bytesPerRow = align(rowBytes, 256);
        const buffer = this.device.createBuffer({
          size: bytesPerRow * height,
          usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
        });
        const depth = texture.format === "depth16unorm";
        encoder.copyTextureToBuffer(
          { texture, mipLevel, ...(depth ? { aspect: "depth-only" as const } : {}) },
          { buffer, bytesPerRow },
          [width, height],
        );

        return { buffer, bytesPerRow, rowBytes, rows: height };
      });
      const first = textures[0]?.texture as GPUTexture;
      const mipLevel = textures[0]?.mipLevel ?? 0;
      reads.push({
        stage: source.stage,
        format: source.blocks === undefined ? first.format : "bc7",
        width: source.blocks === undefined ? Math.max(1, first.width >> mipLevel) : first.width * 4,
        height:
          source.blocks === undefined ? Math.max(1, first.height >> mipLevel) : first.height * 4,
        parts,
      });
    }

    this.device.queue.submit([encoder.finish()]);
    const images: StageImage[] = [];

    for (const read of reads) {
      await Promise.all(read.parts.map((part) => part.buffer.mapAsync(GPUMapMode.READ)));
      const total = read.parts.reduce((sum, part) => sum + part.rowBytes * part.rows, 0);
      const data = new Uint8Array(total);
      let offset = 0;

      for (const part of read.parts) {
        const mapped = new Uint8Array(part.buffer.getMappedRange());

        for (let row = 0; row < part.rows; row++) {
          data.set(
            mapped.subarray(row * part.bytesPerRow, row * part.bytesPerRow + part.rowBytes),
            offset,
          );
          offset += part.rowBytes;
        }

        part.buffer.unmap();
        part.buffer.destroy();
      }

      images.push({
        stage: read.stage,
        format: read.format,
        width: read.width,
        height: read.height,
        data,
      });
    }

    return images;
  }

  // Renders one view onto a canvas context, scaled to the canvas.
  present(name: string, context: GPUCanvasContext, format: GPUTextureFormat): void {
    const encoder = this.device.createCommandEncoder();
    const capture = this.record(encoder, name);
    this.blitter.present(
      encoder,
      capture.output.createView(),
      context.getCurrentTexture().createView(),
      format,
    );
    this.device.queue.submit([encoder.finish()]);
  }
}
