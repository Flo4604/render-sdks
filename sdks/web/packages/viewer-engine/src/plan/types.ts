// The executor's compile output as JSON: an item package version 2 and the
// fixtures it names (pipeline.md "Item packages", graph/*.cpp). Field names
// are the executor's; the viewer reads them and never writes them.

export interface DescriptorSpec {
  set: number;
  binding: number;
  arrayElement?: number;
  count?: number;
  type: "uniform" | "storage" | "texture" | "sampler" | "outputImage";
  path?: string;
  source?: string;
  mutableKey?: string;
  bytes?: number;
  sha256?: string;
  // Textures.
  format?: string;
  srgb?: boolean;
  raw?: boolean;
  width?: number;
  height?: number;
  depth?: number;
  layers?: number;
  mipLevels?: number;
  viewType?: string;
  rgba?: number[];
  vtex?: {
    mips: Array<{
      offset: number;
      storedBytes: number;
      bytes: number;
      compression: "lz4" | "none";
    }>;
  };
  generatedPaint?: PaintIdentity;
  generatedShadow?: { planSha256: string };
  outputIndex?: number;
  // Samplers.
  filter?: "linear" | "nearest";
  mipFilter?: "linear" | "nearest";
  wrap?: boolean;
  wrapU?: boolean;
  wrapV?: boolean;
  wrapW?: boolean;
  addressU?: string;
  addressV?: string;
  addressW?: string;
  maxAnisotropy?: number;
  compare?: string;
  maxLod?: number;
}

export interface AttributeSpec {
  location: number;
  offset: number;
  format?: string;
  components?: number;
  integer?: boolean;
}

export interface DrawSpec {
  width?: number;
  height?: number;
  outputFormat?: string;
  outputSrgb?: boolean;
  vertexShader?: string;
  fragmentShader?: string;
  computeShader?: string;
  vertices?: string;
  stride?: number;
  vertexCount?: number;
  attributes?: AttributeSpec[];
  descriptors: DescriptorSpec[];
  depthTest?: boolean;
  depthWrite?: boolean;
  depthOnly?: boolean;
  depthFormat?: string;
  blend?: "disabled" | "alpha" | "sourceAlpha";
  cullMode?: "none" | "back" | "front";
  depthBias?: [number, number, number];
  viewport?: [number, number, number, number, number, number];
  scissor?: [number, number, number, number];
  clearColor?: [number, number, number, number];
  pushConstants?: number[];
}

export interface PaintIdentity {
  targetIndex: number;
  passIndex: number;
  target: string;
  preparedSha256: string;
}

export interface PaintPassSpec {
  name: string;
  generatedPaint?: PaintIdentity;
  replacePath?: string;
  fixture: string;
  mipFixture: string;
  parameters: string[];
  sampleSrgb: boolean;
}

export interface MipFixture {
  size: number;
  srgb?: boolean;
  compressionShader: string;
  tailShader: string;
}

export interface ShadowEntry {
  name: string;
  fixture: string;
  generatedShadow: { planSha256: string };
}

// The resolved camera of a view as the scene compiler records it
// (provenance.scene.requestTransforms.camera, compile/scene/camera.cpp toJson).
export interface ViewCamera {
  width: number;
  height: number;
  near: number;
  far: number;
  angle: [number, number, number];
  target: [number, number, number];
  nudge: [number, number, number];
  eye: [number, number, number];
  forward: [number, number, number];
  right: [number, number, number];
  up: [number, number, number];
  xScale: number;
  yScale: number;
}

export interface ViewItemPlacement {
  position: { x?: number; y?: number; z?: number };
  angle: { x?: number; y?: number; z?: number };
}

export interface ViewManifest {
  shadows?: ShadowEntry[];
  scenes: Array<{ name: string; fixture: string }>;
  provenance?: {
    scene?: {
      requestTransforms?: { camera?: ViewCamera; item?: ViewItemPlacement };
    };
  };
}

export interface ComposedView {
  captures: string[];
  compose: { recipe: string };
}

export interface ItemPackage {
  version: 2;
  kind?: string;
  item: Record<string, unknown>;
  paint: { passes: PaintPassSpec[] };
  views: Record<string, ViewManifest | ComposedView | string>;
}

export interface SceneFixture extends DrawSpec {
  width: number;
  height: number;
  draws?: string[];
  computeBuffers?: Array<{ name: string; bytes: number; clear: number }>;
  computePasses?: Array<{ fixture: string; dispatch: [number, number, number] }>;
  postProcess?: string;
  snapshots?: Array<{ name: string; beforeDraw: number }>;
}

export interface PostGraphDocument {
  version: 1;
  passes: Array<{ name: string; fixture: string; staticInputs?: boolean }>;
}
