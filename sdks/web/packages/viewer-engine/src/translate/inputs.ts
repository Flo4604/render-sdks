// The translation inputs of one draw: its SPIR-V stages and its descriptor
// layout, with the bytes of every immutable (file-backed, not request-time)
// buffer. Bindless indices are evaluated from them and their words become
// constants of the draw's WGSL. A request-time buffer with binding programs
// also passes its baseline and the ranges the programs write (`writes`, from
// mutableWrites), so bindless slots stored beside bound values resolve.

import { type CameraRole, cameraLiveRanges } from "../camera/live.ts";
import { type ClosureReader, type DrawRef, joinPath } from "../plan/walk.ts";
import type { DepthBiasInput, DescriptorInput } from "./lower.ts";

export interface DrawTranslationInput {
  stages: Array<{ stage: "vertex" | "fragment" | "compute"; spirv: Uint8Array }>;
  descriptors: DescriptorInput[];
  // Set for a shadow caster with a depth bias: the fragment stage applies it.
  depthBias?: DepthBiasInput;
}

// Shadow casters (depth-only draws) render into D16 atlases on both
// backends; r is 2^-16 for D16.
function shaderDepthBias(spec: DrawRef["spec"]): DepthBiasInput | undefined {
  const bias = spec.depthBias;

  if (
    bias === undefined ||
    spec.depthOnly !== true ||
    spec.fragmentShader === undefined ||
    bias.every((value) => value === 0)
  ) {
    return undefined;
  }

  return { constant: bias[0], clamp: bias[1], slope: bias[2], unit: 2 ** -16 };
}

export interface DrawTranslationOptions {
  // The input of the draw's camera translation: the words the free camera
  // rewrites for that role stay live (camera/live.ts).
  camera?: CameraRole | undefined;
  // The byte ranges the binding programs write per mutable key (mutableWrites).
  writes?: ReadonlyMap<string, Array<[number, number]>> | undefined;
}

export async function drawTranslationInput(
  reader: ClosureReader,
  draw: DrawRef,
  options: DrawTranslationOptions = {},
): Promise<DrawTranslationInput> {
  const { camera, writes } = options;
  const spec = draw.spec;
  const stages: DrawTranslationInput["stages"] = [];

  if (spec.computeShader !== undefined) {
    stages.push({
      stage: "compute",
      spirv: await reader.bytes(joinPath(draw.root, spec.computeShader)),
    });
  }

  if (spec.vertexShader !== undefined) {
    stages.push({
      stage: "vertex",
      spirv: await reader.bytes(joinPath(draw.root, spec.vertexShader)),
    });
  }

  if (spec.fragmentShader !== undefined) {
    stages.push({
      stage: "fragment",
      spirv: await reader.bytes(joinPath(draw.root, spec.fragmentShader)),
    });
  }

  const descriptors: DescriptorInput[] = [];

  for (const descriptor of spec.descriptors) {
    const isBuffer = descriptor.type === "uniform" || descriptor.type === "storage";
    const immutable =
      isBuffer && descriptor.path !== undefined && descriptor.mutableKey === undefined;
    let data: Uint8Array | undefined;
    let fixed: DescriptorInput["fixed"];
    let bytes = descriptor.bytes;
    let live: Array<[number, number]> | undefined;
    const written =
      descriptor.mutableKey === undefined ? undefined : writes?.get(descriptor.mutableKey);

    if (isBuffer && descriptor.path !== undefined) {
      const contents = await reader.bytes(joinPath(draw.root, descriptor.path));
      bytes = contents.length;
      const ranges =
        camera === undefined
          ? undefined
          : cameraLiveRanges(camera, { ...descriptor, bytes: contents.length });

      if (immutable && ranges !== "all") {
        data = contents;
        live = ranges;
      } else if (!immutable && written !== undefined) {
        fixed = { data: contents, live: written };
      }
    }

    descriptors.push({
      set: descriptor.set,
      binding: descriptor.binding,
      arrayElement: descriptor.arrayElement ?? 0,
      type: descriptor.type,
      data,
      bytes,
      ...(live === undefined ? {} : { live }),
      viewType: descriptor.viewType,
      format: descriptor.format,
      compare: descriptor.compare,
      ...(fixed === undefined ? {} : { fixed }),
      border:
        descriptor.type === "sampler"
          ? ([descriptor.addressU, descriptor.addressV, descriptor.addressW].map(
              (axis) => axis === "clampToBorder",
            ) as [boolean, boolean, boolean])
          : undefined,
    });
  }

  const depthBias = shaderDepthBias(spec);

  return depthBias === undefined ? { stages, descriptors } : { stages, descriptors, depthBias };
}
