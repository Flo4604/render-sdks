// One compile-output draw as a WebGPU pipeline and bind group: the graph/
// draw.cpp of the browser. Shaders come from the draw's translation; every
// WGSL binding is filled from the descriptor its binding map names.

import { type CameraRole, cameraLiveRanges } from "../camera/live.ts";
import type { DescriptorSpec, PaintIdentity } from "../plan/types.ts";
import { type DrawRef, joinPath } from "../plan/walk.ts";
import type { BindingEntry, TranslatedDraw } from "../translate/model.ts";
import { descriptorDimension, type ResourceCache } from "./resources.ts";

export interface PaintOutput {
  identity: PaintIdentity | undefined;
  replacement: string | undefined;
  size: number;
  levels: number;
  // The view in the descriptor's colour space.
  view(srgb: boolean): GPUTextureView;
}

export interface LiveInputs {
  images?: Map<string, GPUTextureView>;
  buffers?: Map<string, GPUBuffer>;
  storageOutputs?: GPUTextureView[];
  paints?: PaintOutput[];
  // A camera draw: the buffers whose words the free camera rewrites
  // (camera/live.ts) bind the capture's own camera copies instead.
  camera?: CameraBuffers;
}

export interface CameraBuffers {
  role: CameraRole;
  // The capture's writable copy of a closure file, created on first use.
  buffer(
    path: string,
    contents: Uint8Array,
    minimum: number,
    descriptor: DescriptorSpec,
  ): GPUBuffer;
}

export interface PassTarget {
  color: GPUTextureFormat | undefined;
  depth: GPUTextureFormat | undefined;
  width: number;
  height: number;
}

export interface MutableUniform {
  key: string;
  buffer: GPUBuffer;
  baseline: Uint8Array;
}

export interface GraphicsDraw {
  kind: "graphics";
  id: string;
  pipeline: GPURenderPipeline;
  bindGroup: GPUBindGroup;
  vertices: GPUBuffer;
  vertexCount: number;
  viewport: [number, number, number, number, number, number];
  scissor: [number, number, number, number];
  mutable: MutableUniform[];
}

export interface ComputeDraw {
  kind: "compute";
  id: string;
  pipeline: GPUComputePipeline;
  bindGroup: GPUBindGroup;
  mutable: MutableUniform[];
}

export interface DrawContext {
  device: GPUDevice;
  resources: ResourceCache;
  translation(id: string): Promise<TranslatedDraw>;
  // The draw's camera translation (the closure's cameraTranslations).
  cameraTranslation?(id: string): Promise<TranslatedDraw>;
  bytes(path: string): Promise<Uint8Array>;
  shaderModule(code: string): Promise<GPUShaderModule>;
}

const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, inner: unknown) =>
    inner !== null && typeof inner === "object" && !Array.isArray(inner)
      ? Object.fromEntries(
          Object.entries(inner as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)),
        )
      : inner,
  );

const vertexFormats: Record<string, GPUVertexFormat> = {
  R32_FLOAT: "float32",
  R32G32_FLOAT: "float32x2",
  R32G32B32_FLOAT: "float32x3",
  R32G32B32A32_FLOAT: "float32x4",
  R32_UINT: "uint32",
  R16G16_SNORM: "snorm16x2",
  R16G16_FLOAT: "float16x2",
  R8G8B8A8_UINT: "uint8x4",
  R8G8B8A8_UNORM: "unorm8x4",
};

function vertexFormat(attribute: {
  format?: string;
  components?: number;
  integer?: boolean;
}): GPUVertexFormat {
  if (attribute.format !== undefined) {
    const format = vertexFormats[attribute.format];

    if (format === undefined) {
      throw new Error(`Unsupported vertex format ${attribute.format}`);
    }

    return format;
  }

  const components = attribute.components ?? 4;
  const base = attribute.integer === true ? "uint32" : "float32";

  return (components === 1 ? base : `${base}x${components}`) as GPUVertexFormat;
}

function findDescriptor(draw: DrawRef, entry: BindingEntry): DescriptorSpec | undefined {
  return draw.spec.descriptors.find(
    (descriptor) =>
      descriptor.set === entry.set &&
      descriptor.binding === entry.binding &&
      (descriptor.arrayElement ?? 0) === entry.element,
  );
}

function layoutEntry(entry: BindingEntry): GPUBindGroupLayoutEntry {
  let visibility = 0;

  for (const stage of entry.stages) {
    visibility |=
      stage === "vertex"
        ? GPUShaderStage.VERTEX
        : stage === "fragment"
          ? GPUShaderStage.FRAGMENT
          : GPUShaderStage.COMPUTE;
  }

  const base = { binding: entry.wgslBinding, visibility };

  switch (entry.kind) {
    case "uniform": {
      return { ...base, buffer: { type: "uniform" } };
    }

    case "storage": {
      return {
        ...base,
        buffer: { type: entry.readOnly === true ? "read-only-storage" : "storage" },
      };
    }

    case "texture": {
      return {
        ...base,
        texture: {
          sampleType: entry.depth === true ? "depth" : "float",
          viewDimension: entry.dimension ?? "2d",
        },
      };
    }

    case "sampler": {
      return { ...base, sampler: { type: entry.comparison === true ? "comparison" : "filtering" } };
    }

    case "storageTexture": {
      return {
        ...base,
        storageTexture: { access: "write-only", format: "rgba32uint", viewDimension: "2d" },
      };
    }
  }
}

async function bindingResource(
  context: DrawContext,
  draw: DrawRef,
  entry: BindingEntry,
  live: LiveInputs,
  mutable: MutableUniform[],
): Promise<GPUBindingResource> {
  const descriptor = findDescriptor(draw, entry);
  const resources = context.resources;

  switch (entry.kind) {
    case "uniform":
    case "storage": {
      if (descriptor?.source !== undefined) {
        const buffer = live.buffers?.get(descriptor.source);

        if (buffer === undefined) {
          throw new Error(`Draw ${draw.id} names an unknown live buffer ${descriptor.source}`);
        }

        return { buffer };
      }

      if (descriptor?.path === undefined) {
        throw new Error(`Draw ${draw.id} has no buffer for ${entry.key}`);
      }

      if (live.camera !== undefined) {
        const path = joinPath(draw.root, descriptor.path);
        const contents = await context.bytes(path);
        const ranges = cameraLiveRanges(live.camera.role, {
          ...descriptor,
          bytes: contents.length,
        });

        if (ranges !== undefined) {
          return { buffer: live.camera.buffer(path, contents, entry.size ?? 16, descriptor) };
        }
      }

      const usage = entry.kind === "uniform" ? GPUBufferUsage.UNIFORM : GPUBufferUsage.STORAGE;
      const { buffer, bytes } = await resources.buffer(
        draw.root,
        descriptor,
        usage,
        entry.size ?? 16,
      );

      if (descriptor.mutableKey !== undefined) {
        mutable.push({ key: descriptor.mutableKey, buffer, baseline: bytes });
      }

      return { buffer };
    }

    case "sampler": {
      return resources.sampler(descriptor, entry.comparison === true);
    }

    case "storageTexture": {
      const view = live.storageOutputs?.[descriptor?.outputIndex ?? 0];

      if (view === undefined) {
        throw new Error(`Draw ${draw.id} has no storage output ${entry.key}`);
      }

      return view;
    }

    case "texture": {
      const dimension = entry.dimension ?? "2d";

      if (descriptor === undefined) {
        resources.note("unbound_element_as_zero");

        return resources.dummy(dimension, entry.depth === true).createView({ dimension });
      }

      if (descriptor.generatedPaint !== undefined) {
        const identity = canonical(descriptor.generatedPaint);
        const paint = live.paints?.find((candidate) => canonical(candidate.identity) === identity);

        if (paint === undefined) {
          throw new Error(`Draw ${draw.id} names an unknown paint`);
        }

        return paint.view(descriptor.srgb ?? false);
      }

      if (descriptor.source !== undefined) {
        const view = live.images?.get(descriptor.source);

        if (view === undefined) {
          throw new Error(`Draw ${draw.id} names an unknown live image ${descriptor.source}`);
        }

        return view;
      }

      if (descriptor.path !== undefined) {
        const path = joinPath(draw.root, descriptor.path);
        const replaced = live.paints?.find(
          (paint) => paint.identity === undefined && paint.replacement === path,
        );

        if (replaced !== undefined) {
          return replaced.view(descriptor.srgb ?? false);
        }
      }

      const isDepthFile = descriptor.format === "d16" || descriptor.format === "d32f";

      if (
        descriptorDimension(descriptor) !== dimension ||
        (isDepthFile !== (entry.depth === true) && entry.depth === true)
      ) {
        resources.note("element_type_mismatch_as_zero");

        return resources.dummy(dimension, entry.depth === true).createView({ dimension });
      }

      const texture = await resources.texture(
        draw.root,
        descriptor,
        isDepthFile && entry.depth !== true,
      );

      return texture.createView({ dimension });
    }
  }
}

export async function createDraw(
  context: DrawContext,
  draw: DrawRef,
  target: PassTarget | undefined,
  live: LiveInputs,
): Promise<GraphicsDraw | ComputeDraw> {
  const device = context.device;
  let translation: TranslatedDraw;

  if (live.camera === undefined) {
    translation = await context.translation(draw.id);
  } else if (context.cameraTranslation === undefined) {
    throw new Error("The closure has no camera translations");
  } else {
    translation = await context.cameraTranslation(draw.id);
  }

  const layout = device.createBindGroupLayout({ entries: translation.bindings.map(layoutEntry) });
  const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [layout] });
  const mutable: MutableUniform[] = [];
  const entries: GPUBindGroupEntry[] = [];

  for (const entry of translation.bindings) {
    entries.push({
      binding: entry.wgslBinding,
      resource: await bindingResource(context, draw, entry, live, mutable),
    });
  }

  const bindGroup = device.createBindGroup({ layout, entries });
  const stage = async (name: string) => {
    const found = translation.stages.find((candidate) => candidate.stage === name);

    return found === undefined
      ? undefined
      : { module: await context.shaderModule(found.wgsl), entryPoint: found.entryPoint };
  };

  const compute = await stage("compute");

  if (compute !== undefined) {
    const pipeline = await device.createComputePipelineAsync({ layout: pipelineLayout, compute });

    return { kind: "compute", id: draw.id, pipeline, bindGroup, mutable };
  }

  const spec = draw.spec;
  const vertex = await stage("vertex");
  let fragment = await stage("fragment");

  // A vertex-only depth draw inside a colour scene (the charm's depth pre-pass): WebGPU needs
  // its pipeline to name the pass's colour target, so it gets a fragment stage that writes
  // nothing, and the target's write mask stays 0 as the executor disables colour writes.
  if (fragment === undefined && (spec.depthOnly ?? false) && target?.color !== undefined) {
    fragment = {
      module: await context.shaderModule("@fragment fn main() {}\n"),
      entryPoint: "main",
    };
  }

  if (vertex === undefined || target === undefined) {
    throw new Error(`Draw ${draw.id} has no vertex stage or target`);
  }

  const vertexBytes = await context.bytes(joinPath(draw.root, spec.vertices ?? ""));
  const vertices = device.createBuffer({
    size: Math.max(4, Math.ceil(vertexBytes.length / 4) * 4),
    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
  });
  const padded = new Uint8Array(Math.ceil(vertexBytes.length / 4) * 4);
  padded.set(vertexBytes);
  device.queue.writeBuffer(vertices, 0, padded);

  const depthTest = spec.depthTest ?? false;
  const depthWrite = depthTest && (spec.depthWrite ?? depthTest);
  const blend = spec.blend ?? "disabled";
  const colorBlend: GPUBlendState | undefined =
    blend === "disabled"
      ? undefined
      : {
          color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha", operation: "add" },
          alpha: {
            srcFactor: blend === "sourceAlpha" ? "src-alpha" : "one",
            dstFactor: "one-minus-src-alpha",
            operation: "add",
          },
        };
  const depthOnly = spec.depthOnly ?? false;
  // A translation that applies the bias in its fragment stage needs none
  // from the rasterizer.
  const bias = translation.depthBias === "shader" ? undefined : spec.depthBias;
  const pipeline = await device.createRenderPipelineAsync({
    layout: pipelineLayout,
    vertex: {
      ...vertex,
      buffers: [
        {
          arrayStride: spec.stride ?? 0,
          attributes: (spec.attributes ?? []).map((attribute) => ({
            shaderLocation: attribute.location,
            offset: attribute.offset,
            format: vertexFormat(attribute),
          })),
        },
      ],
    },
    ...(fragment === undefined || (target.color === undefined && !depthOnly)
      ? {}
      : {
          fragment: {
            ...fragment,
            targets:
              target.color === undefined
                ? []
                : [
                    {
                      format: target.color,
                      writeMask: depthOnly ? 0 : GPUColorWrite.ALL,
                      ...(colorBlend === undefined ? {} : { blend: colorBlend }),
                    },
                  ],
          },
        }),
    primitive: {
      topology: "triangle-list",
      cullMode: spec.cullMode ?? "none",
      frontFace: "ccw",
    },
    ...(target.depth === undefined
      ? {}
      : {
          depthStencil: {
            format: target.depth,
            depthWriteEnabled: depthWrite,
            depthCompare: depthTest ? "less-equal" : "always",
            ...(bias === undefined
              ? {}
              : { depthBias: bias[0], depthBiasClamp: bias[1], depthBiasSlopeScale: bias[2] }),
          },
        }),
  });
  const viewport = spec.viewport ?? [0, 0, target.width, target.height, 0, 1];
  const scissor = spec.scissor ?? [0, 0, target.width, target.height];

  return {
    kind: "graphics",
    id: draw.id,
    pipeline,
    bindGroup,
    vertices,
    vertexCount: spec.vertexCount ?? 0,
    viewport,
    scissor,
    mutable,
  };
}

export function recordGraphics(pass: GPURenderPassEncoder, draw: GraphicsDraw): void {
  pass.setPipeline(draw.pipeline);
  pass.setBindGroup(0, draw.bindGroup);
  pass.setVertexBuffer(0, draw.vertices);
  const [x, y, width, height, minDepth, maxDepth] = draw.viewport;
  pass.setViewport(x, y, width, height, minDepth, maxDepth);
  const [sx, sy, sw, sh] = draw.scissor;
  pass.setScissorRect(sx, sy, sw, sh);
  pass.draw(draw.vertexCount);
}
