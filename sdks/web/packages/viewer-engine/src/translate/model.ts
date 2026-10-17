// The translation product of one draw, as the engine reads it: WGSL per stage
// and the binding map that says which compile-output descriptor stands behind
// each WGSL binding (all in group 0).

import type { ShaderResource } from "./lower.ts";

export type StageName = "vertex" | "fragment" | "compute";

export interface BindingEntry extends ShaderResource {
  // Binding number in group 0.
  wgslBinding: number;
  stages: StageName[];
}

export interface TranslatedStage {
  stage: StageName;
  wgsl: string;
  entryPoint: string;
  spirvSha256: string;
}

export interface TranslatedDraw {
  translator: string;
  stages: TranslatedStage[];
  bindings: BindingEntry[];
  rewrites: Record<string, number>;
  // "shader" when the fragment stage writes the biased depth itself; the
  // pipeline then sets no rasterizer bias. Absent in older translations.
  depthBias?: "shader";
}

export type { ShaderResource } from "./lower.ts";
