// Textures, samplers and buffers from compile-output descriptors, following
// the executor's assets/texture_loader.cpp and graph/draw.cpp. Texture words
// reach the GPU unchanged: vtex_c mips are LZ4-decoded and uploaded in their
// stored block format (BC1-BC7), so desktop GPUs sample Valve's own blocks.

import { decodeVtexMips } from "../lz4.ts";
import type { DescriptorSpec } from "../plan/types.ts";
import type { ClosureReader } from "../plan/walk.ts";
import { joinPath } from "../plan/walk.ts";

export type TextureDimension = "2d" | "2d-array" | "cube" | "cube-array" | "3d";

interface FormatInfo {
  format: GPUTextureFormat;
  blockBytes: number;
  block: number;
  depth: boolean;
}

function formatInfo(spec: DescriptorSpec): FormatInfo {
  const name = spec.format ?? "rgba8";
  const srgb = spec.srgb ?? false;
  const block = (format: GPUTextureFormat, bytes: number): FormatInfo => ({
    format,
    blockBytes: bytes,
    block: 4,
    depth: false,
  });
  const plain = (format: GPUTextureFormat, bytes: number, depth = false): FormatInfo => ({
    format,
    blockBytes: bytes,
    block: 1,
    depth,
  });

  switch (name) {
    case "rgba8": {
      return plain(srgb ? "rgba8unorm-srgb" : "rgba8unorm", 4);
    }

    case "r8": {
      return plain("r8unorm", 1);
    }

    case "rgba16f": {
      return plain("rgba16float", 8);
    }

    case "rgba32f": {
      return plain("rgba32float", 16);
    }

    case "d16": {
      return plain("depth16unorm", 2, true);
    }

    case "d32f": {
      return plain("depth32float", 4, true);
    }

    case "bc1": {
      return block(srgb ? "bc1-rgba-unorm-srgb" : "bc1-rgba-unorm", 8);
    }

    case "bc3": {
      return block(srgb ? "bc3-rgba-unorm-srgb" : "bc3-rgba-unorm", 16);
    }

    case "bc4": {
      return block("bc4-r-unorm", 8);
    }

    case "bc5": {
      return block("bc5-rg-unorm", 16);
    }

    case "bc6h": {
      return block("bc6h-rgb-ufloat", 16);
    }

    case "bc7": {
      return block(srgb ? "bc7-rgba-unorm-srgb" : "bc7-rgba-unorm", 16);
    }

    default: {
      throw new Error(`Unsupported texture format ${name}`);
    }
  }
}

export function descriptorDimension(spec: DescriptorSpec): TextureDimension {
  switch (spec.viewType ?? "2d") {
    case "2dArray": {
      return "2d-array";
    }

    case "cube": {
      return "cube";
    }

    case "cubeArray": {
      return "cube-array";
    }

    case "3d": {
      return "3d";
    }

    default: {
      return "2d";
    }
  }
}

export class ResourceCache {
  private readonly device: GPUDevice;

  private readonly reader: ClosureReader;

  private readonly textures = new Map<string, Promise<GPUTexture>>();

  private readonly samplers = new Map<string, GPUSampler>();

  private readonly dummies = new Map<string, GPUTexture>();

  readonly deviations = new Map<string, number>();

  constructor(device: GPUDevice, reader: ClosureReader) {
    this.device = device;
    this.reader = reader;
  }

  note(deviation: string): void {
    this.deviations.set(deviation, (this.deviations.get(deviation) ?? 0) + 1);
  }

  async buffer(
    root: string,
    spec: DescriptorSpec,
    usage: GPUBufferUsageFlags,
    minimum: number,
  ): Promise<{ buffer: GPUBuffer; bytes: Uint8Array }> {
    const bytes = await this.reader.bytes(joinPath(root, spec.path ?? ""));
    const size = Math.max(minimum, Math.ceil(bytes.length / 16) * 16, 16);
    const buffer = this.device.createBuffer({ size, usage: usage | GPUBufferUsage.COPY_DST });
    const padded = new Uint8Array(Math.ceil(bytes.length / 4) * 4);
    padded.set(bytes);
    this.device.queue.writeBuffer(buffer, 0, padded);

    return { buffer, bytes };
  }

  // A static texture, shared by every draw that names the same file with the
  // same interpretation. `asFloat` turns a depth file into r32float for a
  // float binding (WebGPU cannot filter-sample a depth format).
  texture(root: string, spec: DescriptorSpec, asFloat: boolean): Promise<GPUTexture> {
    const {
      set: _set,
      binding: _binding,
      arrayElement: _element,
      type: _type,
      path,
      ...interpretation
    } = spec;
    const resolved = path === undefined ? "" : joinPath(root, path);
    const key = `${resolved}|${JSON.stringify(interpretation)}|${asFloat}`;
    const cached = this.textures.get(key);

    if (cached !== undefined) {
      return cached;
    }

    const created = this.createTexture(resolved, spec, asFloat);
    this.textures.set(key, created);

    return created;
  }

  private async createTexture(
    path: string,
    spec: DescriptorSpec,
    asFloat: boolean,
  ): Promise<GPUTexture> {
    let info = formatInfo(spec);
    const dimension = descriptorDimension(spec);
    const width = spec.width ?? 1;
    const height = spec.height ?? 1;
    const cube = dimension === "cube" || dimension === "cube-array";
    const layers = spec.layers ?? (cube ? 6 : 1);
    const depth = spec.depth ?? 1;
    const mipLevels = spec.mipLevels ?? 1;
    const raw =
      info.block > 1 ||
      (info.format !== "rgba8unorm" && info.format !== "rgba8unorm-srgb") ||
      spec.raw === true;
    let words: Uint8Array;

    if (path !== "" && spec.vtex !== undefined) {
      words = decodeVtexMips(await this.reader.bytes(path), spec.vtex.mips);
    } else if (path !== "" && raw) {
      words = await this.reader.bytes(path);
    } else if (path === "" && spec.rgba !== undefined) {
      const texel = new Uint8Array(spec.rgba);
      words = new Uint8Array(4 * layers);

      for (let layer = 0; layer < layers; layer++) {
        words.set(texel, layer * 4);
      }
    } else {
      throw new Error(`Texture ${path} is a PNG fixture, which the viewer does not decode yet`);
    }

    if (info.depth && asFloat) {
      const source =
        info.format === "depth16unorm"
          ? new Uint16Array(words.buffer, words.byteOffset, words.length / 2)
          : new Float32Array(words.buffer, words.byteOffset, words.length / 4);
      const values = new Float32Array(source.length);

      source.forEach((value, index) => {
        values[index] = info.format === "depth16unorm" ? value / 65535 : value;
      });
      words = new Uint8Array(values.buffer);
      info = { format: "r32float", blockBytes: 4, block: 1, depth: false };
      this.note("depth_file_as_r32float");
    }

    const texture = this.device.createTexture({
      size: { width, height, depthOrArrayLayers: dimension === "3d" ? depth : layers },
      format: info.format,
      dimension: dimension === "3d" ? "3d" : "2d",
      mipLevelCount: mipLevels,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    let offset = 0;

    for (let mip = 0; mip < mipLevels; mip++) {
      const mipWidth = Math.max(1, width >> mip);
      const mipHeight = Math.max(1, height >> mip);
      const mipDepth = dimension === "3d" ? Math.max(1, depth >> mip) : layers;
      const blocksWide = Math.ceil(mipWidth / info.block);
      const blocksHigh = Math.ceil(mipHeight / info.block);
      const bytesPerRow = blocksWide * info.blockBytes;
      const bytes = bytesPerRow * blocksHigh * mipDepth;

      if (offset + bytes > words.length) {
        throw new Error(
          `Texture ${path} has ${words.length} bytes, mip ${mip} needs ${offset + bytes}`,
        );
      }

      this.device.queue.writeTexture(
        { texture, mipLevel: mip },
        words.subarray(offset, offset + bytes),
        { bytesPerRow, rowsPerImage: blocksHigh },
        {
          width: blocksWide * info.block,
          height: blocksHigh * info.block,
          depthOrArrayLayers: mipDepth,
        },
      );
      offset += bytes;
    }

    if (offset !== words.length) {
      throw new Error(`Texture ${path} has ${words.length} bytes, its mips cover ${offset}`);
    }

    return texture;
  }

  // A zero texture for a binding with no matching descriptor. The executor's
  // partially bound descriptor reads undefined values there.
  dummy(dimension: TextureDimension, depth: boolean): GPUTexture {
    const key = `${dimension}:${depth}`;
    const existing = this.dummies.get(key);

    if (existing !== undefined) {
      return existing;
    }

    const cube = dimension === "cube" || dimension === "cube-array";
    const texture = this.device.createTexture({
      size: { width: 1, height: 1, depthOrArrayLayers: cube ? 6 : 1 },
      format: depth ? "depth16unorm" : "rgba8unorm",
      dimension: dimension === "3d" ? "3d" : "2d",
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        (depth ? GPUTextureUsage.RENDER_ATTACHMENT : GPUTextureUsage.COPY_DST),
    });
    this.dummies.set(key, texture);

    return texture;
  }

  sampler(spec: DescriptorSpec | undefined, comparison: boolean): GPUSampler {
    const descriptor = spec ?? ({ set: 0, binding: 0, type: "sampler" } as DescriptorSpec);
    const key = JSON.stringify([
      descriptor.filter,
      descriptor.mipFilter,
      descriptor.wrap,
      descriptor.wrapU,
      descriptor.wrapV,
      descriptor.wrapW,
      descriptor.addressU,
      descriptor.addressV,
      descriptor.addressW,
      descriptor.maxAnisotropy,
      descriptor.compare,
      descriptor.maxLod,
      comparison,
    ]);
    const existing = this.samplers.get(key);

    if (existing !== undefined) {
      return existing;
    }

    const wrap = descriptor.wrap ?? false;
    const axis = (flag: boolean | undefined, address: string | undefined): GPUAddressMode => {
      if (address !== undefined) {
        if (address === "repeat") {
          return "repeat";
        }

        if (address === "mirroredRepeat") {
          return "mirror-repeat";
        }

        if (address === "clampToBorder") {
          // WebGPU has no border colour; the executor's is transparent black.
          this.note("clamp_to_border_as_clamp_to_edge");
        }

        return "clamp-to-edge";
      }

      return (flag ?? wrap) ? "repeat" : "clamp-to-edge";
    };

    const filter: GPUFilterMode = descriptor.filter === "nearest" ? "nearest" : "linear";
    const mipFilter: GPUMipmapFilterMode =
      descriptor.mipFilter === "nearest" ? "nearest" : "linear";
    const anisotropic =
      descriptor.maxAnisotropy !== undefined && filter === "linear" && mipFilter === "linear";
    const compare =
      descriptor.compare === undefined
        ? comparison
          ? "less-equal"
          : undefined
        : ((
            {
              never: "never",
              less: "less",
              equal: "equal",
              lessOrEqual: "less-equal",
              greater: "greater",
              notEqual: "not-equal",
              greaterOrEqual: "greater-equal",
              always: "always",
            } as Record<string, GPUCompareFunction>
          )[descriptor.compare] ?? "less-equal");
    const sampler = this.device.createSampler({
      addressModeU: axis(descriptor.wrapU, descriptor.addressU),
      addressModeV: axis(descriptor.wrapV, descriptor.addressV),
      addressModeW: axis(descriptor.wrapW, descriptor.addressW),
      magFilter: filter,
      minFilter: filter,
      mipmapFilter: mipFilter,
      lodMaxClamp: Math.min(descriptor.maxLod ?? 32, 32),
      ...(anisotropic
        ? { maxAnisotropy: Math.min(16, Math.max(1, Math.floor(descriptor.maxAnisotropy ?? 1))) }
        : {}),
      ...(comparison && compare !== undefined ? { compare } : {}),
    });
    this.samplers.set(key, sampler);

    return sampler;
  }
}
