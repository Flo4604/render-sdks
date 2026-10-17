// The translation driver for Node: SPIR-V words -> lowered SPIR-V text ->
// SPIR-V words -> WGSL, through SPIRV-Tools (`spirv-dis`, `spirv-as`,
// `spirv-val`) and naga's CLI. A draw is translated as a unit because its
// stages share one WebGPU bind group, so every resource gets one binding.
//
// The output is a derived build product of the compile output, like a
// pipeline cache: the same SPIR-V and descriptor layout give the same WGSL.

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import type { BindingEntry, StageName, TranslatedDraw, TranslatedStage } from "./model.ts";
import {
  assignBindings,
  type DepthBiasInput,
  type DescriptorInput,
  type LoweredStage,
  lowerStage,
  type ShaderResource,
} from "./lower.ts";

const run = promisify(execFile);

export interface StageInput {
  stage: StageName;
  spirv: Uint8Array;
}

export interface Tools {
  naga: string;
  spirvDis: string;
  spirvAs: string;
  spirvVal: string;
  spirvOpt: string;
}

export const defaultTools: Tools = {
  naga: process.env.NAGA ?? "naga",
  spirvDis: process.env.SPIRV_DIS ?? "spirv-dis",
  spirvAs: process.env.SPIRV_AS ?? "spirv-as",
  spirvVal: process.env.SPIRV_VAL ?? "spirv-val",
  spirvOpt: process.env.SPIRV_OPT ?? "spirv-opt",
};

// Bumped whenever lowering or post-processing changes the output.
export const translatorVersion = "w52-lower-8";

const order = (a: ShaderResource, b: ShaderResource): number =>
  a.set - b.set || a.binding - b.binding || a.element - b.element || a.key.localeCompare(b.key);

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function entryPointName(text: string): string {
  const match = /OpEntryPoint \w+ %\S+ "([^"]+)"/.exec(text);

  if (match?.[1] === undefined) {
    throw new Error("Module has no entry point");
  }

  return match[1];
}

// naga writes a module that WebGPU rejects in a few known ways; fix those.
function finishWgsl(wgsl: string): string {
  let text = wgsl;

  // Derivatives and implicit-LOD samples in branches on uniform-buffer values
  // are uniform at run time, but WGSL's static analysis cannot prove it.
  if (!text.includes("diagnostic(off, derivative_uniformity)")) {
    text = `diagnostic(off, derivative_uniformity);\n${text}`;
  }

  // naga declares storage images read_write when SPIR-V lacks NonReadable.
  // lowerStage rejects OpImageRead, so every storage image is write-only.
  text = text.replace(/texture_storage_2d<(\w+),\s*read_write>/g, "texture_storage_2d<$1, write>");

  // The scene shaders OR light masks across the subgroup in branches that
  // are uniform on the executor's hardware, so the same analysis is off.
  if (/\bsubgroup[A-Z]\w*\(/.test(text) && !/enable subgroups/.test(text)) {
    text = `enable subgroups;\ndiagnostic(off, subgroup_uniformity);\n${text}`;
  }

  return text;
}

// Options that change the translation; pass the same to translationKey.
export interface TranslateOptions {
  // A shadow caster's depth bias, from drawTranslationInput.
  depthBias?: DepthBiasInput | undefined;
}

export async function translateDraw(
  stages: StageInput[],
  descriptors: DescriptorInput[],
  tools: Tools = defaultTools,
  options: TranslateOptions = {},
): Promise<TranslatedDraw> {
  const directory = await mkdtemp(join(tmpdir(), "viewer-translate-"));

  try {
    const lowered: Array<{ input: StageInput; stage: LoweredStage }> = [];

    for (const [index, input] of stages.entries()) {
      const spv = join(directory, `${index}.spv`);
      await writeFile(spv, input.spirv);
      const { stdout } = await run(tools.spirvDis, ["--raw-id", spv], {
        maxBuffer: 256 * 1024 * 1024,
      });
      lowered.push({
        input,
        stage: lowerStage({
          spirvText: stdout,
          descriptors,
          depthBias: input.stage === "fragment" ? options.depthBias : undefined,
        }),
      });
    }

    const resources = new Map<string, BindingEntry>();

    for (const { input, stage } of lowered) {
      for (const resource of stage.resources) {
        const existing = resources.get(resource.key);

        if (existing === undefined) {
          resources.set(resource.key, { ...resource, wgslBinding: 0, stages: [input.stage] });
          continue;
        }

        existing.stages.push(input.stage);

        if (resource.size !== undefined) {
          existing.size = Math.max(existing.size ?? 0, resource.size);
        }
      }
    }

    const bindings = [...resources.values()].sort(order);
    bindings.forEach((entry, index) => {
      entry.wgslBinding = index;
    });
    const numbers = new Map(bindings.map((entry) => [entry.key, entry.wgslBinding]));
    const rewrites: Record<string, number> = {};
    const translated: TranslatedStage[] = [];

    for (const [index, { input, stage }] of lowered.entries()) {
      // A uniform's declared size must agree across stages.
      for (const resource of stage.resources) {
        const shared = resources.get(resource.key);

        if (shared?.size !== undefined && resource.size !== shared.size) {
          throw new Error(`Stages declare ${resource.key} with different sizes`);
        }
      }

      for (const [name, amount] of Object.entries(stage.rewrites)) {
        rewrites[name] = (rewrites[name] ?? 0) + amount;
      }

      const text = assignBindings(stage, numbers);
      const assembly = join(directory, `${index}.lowered.spvasm`);
      const binary = join(directory, `${index}.lowered.spv`);
      const wgslPath = join(directory, `${index}.wgsl`);
      await writeFile(assembly, text);
      await run(tools.spirvAs, ["--target-env", "spv1.5", assembly, "-o", binary], {
        maxBuffer: 64 * 1024 * 1024,
      });
      await run(tools.spirvVal, ["--target-env", "vulkan1.2", "--scalar-block-layout", binary], {
        maxBuffer: 64 * 1024 * 1024,
      });
      // Folds the constant words and removes the branches they decide, so
      // the browser's shader compiler sees only this draw's material path.
      const optimized = join(directory, `${index}.optimized.spv`);
      await run(
        tools.spirvOpt,
        ["-O", "--target-env=vulkan1.2", "--scalar-block-layout", binary, "-o", optimized],
        {
          maxBuffer: 64 * 1024 * 1024,
        },
      );
      await run(tools.naga, ["--capabilities", "all", optimized, wgslPath], {
        maxBuffer: 64 * 1024 * 1024,
      });
      translated.push({
        stage: input.stage,
        wgsl: finishWgsl(await readFile(wgslPath, "utf8")),
        entryPoint: entryPointName(text),
        spirvSha256: sha256(input.spirv),
      });
    }

    const shaderBias = (rewrites.depth_bias_in_shader ?? 0) > 0;

    return {
      translator: translatorVersion,
      stages: translated,
      bindings,
      rewrites,
      ...(shaderBias ? { depthBias: "shader" as const } : {}),
    };
  } finally {
    if (process.env.VIEWER_TRANSLATE_KEEP === undefined) {
      await rm(directory, { recursive: true, force: true });
    } else {
      process.stderr.write(`translation work kept in ${directory}\n`);
    }
  }
}

export function translationKey(
  stages: StageInput[],
  descriptors: DescriptorInput[],
  options: TranslateOptions = {},
): string {
  const hash = createHash("sha256");
  hash.update(translatorVersion);

  // Only a biased shadow caster's key changes, so other cached
  // translations stay valid.
  if (options.depthBias !== undefined) {
    hash.update(`depthBias:${JSON.stringify(options.depthBias)}`);
  }

  for (const stage of stages) {
    hash.update(stage.stage);
    hash.update(sha256(stage.spirv));
  }

  for (const descriptor of descriptors) {
    const { data, fixed, ...shape } = descriptor;
    hash.update(JSON.stringify(shape));
    hash.update(data === undefined ? "-" : sha256(data));

    // Absent for every buffer without binding programs, so those keys are unchanged.
    if (fixed !== undefined) {
      hash.update(`fixed:${sha256(fixed.data)}:${JSON.stringify(fixed.live)}`);
    }
  }

  return hash.digest("hex");
}

export type { DescriptorInput } from "./lower.ts";

export type { BindingEntry, StageName, TranslatedDraw, TranslatedStage } from "./model.ts";

export {
  drawTranslationInput,
  type DrawTranslationInput,
  type DrawTranslationOptions,
} from "./inputs.ts";

export type { CameraRole } from "../camera/live.ts";

export { mutableWrites } from "../bind/binding.ts";
