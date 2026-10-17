// Reads an item package and every fixture it names into the graph the
// executor builds (graph/item_model.cpp): paint passes with their BC7
// compressors, and per view the shadow atlas, the scene with its compute
// passes and snapshots, and the post graph. Paths are closure paths: posix,
// relative to the closure root, normalized.

import { type BindingSlice, bindingSlice } from "../bind/binding.ts";
import type {
  ComposedView,
  DescriptorSpec,
  DrawSpec,
  ItemPackage,
  MipFixture,
  PaintIdentity,
  PostGraphDocument,
  SceneFixture,
  ViewCamera,
  ViewItemPlacement,
  ViewManifest,
} from "./types.ts";

export interface ClosureReader {
  json<T>(path: string): Promise<T>;
  bytes(path: string): Promise<Uint8Array>;
}

export function joinPath(directory: string, relative: string): string {
  const parts = relative.startsWith("/") ? [] : directory.split("/").filter((part) => part !== "");

  for (const part of relative.split("/")) {
    if (part === "" || part === ".") {
      continue;
    }

    if (part === "..") {
      if (parts.length === 0) {
        throw new Error(`Path ${relative} leaves the closure`);
      }

      parts.pop();
      continue;
    }

    parts.push(part);
  }

  return parts.join("/");
}

export function directoryOf(path: string): string {
  const index = path.lastIndexOf("/");

  return index < 0 ? "" : path.slice(0, index);
}

// One pipeline with its descriptors: `root` resolves every relative path in
// `spec`. `id` names the draw in the closure manifest's translations.
export interface DrawRef {
  id: string;
  root: string;
  spec: DrawSpec;
}

export interface CompressorPlan {
  draw: DrawRef;
  mip: number;
  outputs: number;
  dispatch: [number, number];
}

export interface PaintPlan {
  name: string;
  identity: PaintIdentity | undefined;
  replacement: string | undefined;
  sampleSrgb: boolean;
  size: number;
  levels: number;
  srgbBlit: boolean;
  outputSrgb: boolean;
  draw: DrawRef;
  compressors: CompressorPlan[];
}

export interface ComputePlan {
  buffers: Array<{ name: string; bytes: number; clear: number }>;
  passes: Array<{ draw: DrawRef; dispatch: [number, number, number] }>;
}

export interface ShadowPlan {
  name: string;
  identity: { planSha256: string };
  width: number;
  height: number;
  compute: ComputePlan;
  draws: DrawRef[];
}

export interface PostPassPlan {
  name: string;
  width: number;
  height: number;
  final: boolean;
  outputSrgb: boolean;
  clearColor: [number, number, number, number];
  draw: DrawRef;
}

export interface ScenePlan {
  name: string;
  width: number;
  height: number;
  clearColor: [number, number, number, number];
  depthFormat: string;
  snapshots: Array<{ name: string; beforeDraw: number }>;
  compute: ComputePlan;
  draws: DrawRef[];
  post: PostPassPlan[];
}

export interface CapturePlan {
  name: string;
  shadows: ShadowPlan[];
  scene: ScenePlan;
  // The view's compiled camera and item placement, when the package records
  // them; the free camera starts from these.
  camera?: ViewCamera | undefined;
  item?: ViewItemPlacement | undefined;
}

export interface ItemPlan {
  packagePath: string;
  item: Record<string, unknown>;
  paints: PaintPlan[];
  captures: CapturePlan[];
  composed: Record<string, ComposedView>;
  // The package's binding programs (seed, wear, sticker placement, counter).
  binding: BindingSlice;
}

async function readDraw(reader: ClosureReader, path: string): Promise<DrawRef> {
  return { id: path, root: directoryOf(path), spec: await reader.json<DrawSpec>(path) };
}

function clearColor(spec: { clearColor?: number[] }): [number, number, number, number] {
  const color = spec.clearColor ?? [0, 0, 0, 0];

  return [color[0] ?? 0, color[1] ?? 0, color[2] ?? 0, color[3] ?? 0];
}

// The BC7 compressor descriptors the executor writes for each mip
// (graph/paint_graph.cpp compressionDescriptors).
export function compressionDescriptors(parameters: string, outputs: number): DescriptorSpec[] {
  const descriptors: DescriptorSpec[] = [
    { set: 0, binding: 0, type: "uniform", path: `/${parameters}` },
    { set: 0, binding: 14, type: "sampler", filter: "linear", mipFilter: "nearest", wrap: false },
    { set: 0, binding: 30, type: "texture", source: "sceneColor" },
  ];

  for (let index = 0; index < outputs; index++) {
    descriptors.push({ set: 0, binding: 158 + index, type: "outputImage", outputIndex: index });
  }

  return descriptors;
}

async function readPaint(
  reader: ClosureReader,
  root: string,
  paint: ItemPackage["paint"]["passes"][number],
): Promise<PaintPlan> {
  const drawPath = joinPath(root, paint.fixture);
  const mipPath = joinPath(root, paint.mipFixture);
  const draw = await readDraw(reader, drawPath);
  const mips = await reader.json<MipFixture>(mipPath);
  const size = mips.size;
  const levels = Math.floor(Math.log2(size)) + 1;
  const compressors: CompressorPlan[] = [];

  for (let mip = 0; mip < levels; mip++) {
    const dimension = Math.max(1, size >> mip);
    const tail = dimension === 4;
    const outputs = tail ? 3 : 1;
    const blocks = Math.max(1, Math.floor(dimension / 4));
    const parameters = paint.parameters[mip];

    if (parameters === undefined) {
      throw new Error(`Paint ${paint.name} has no compression parameters for mip ${mip}`);
    }

    const spec: DrawSpec = {
      computeShader: tail ? mips.tailShader : mips.compressionShader,
      descriptors: compressionDescriptors(joinPath(root, parameters), outputs),
    };

    compressors.push({
      draw: { id: `${mipPath}#${paint.name}:${mip}`, root: directoryOf(mipPath), spec },
      mip,
      outputs,
      dispatch: tail ? [3, 1] : [Math.ceil(blocks / 8), Math.ceil(blocks / 8)],
    });

    if (tail) {
      break;
    }
  }

  return {
    name: paint.name,
    identity: paint.generatedPaint,
    replacement: paint.replacePath === undefined ? undefined : joinPath(root, paint.replacePath),
    sampleSrgb: paint.sampleSrgb,
    size,
    levels,
    srgbBlit: mips.srgb ?? false,
    outputSrgb: draw.spec.outputSrgb ?? false,
    draw,
    compressors,
  };
}

async function readCompute(
  reader: ClosureReader,
  root: string,
  spec: SceneFixture,
): Promise<ComputePlan> {
  const passes: ComputePlan["passes"] = [];

  for (const pass of spec.computePasses ?? []) {
    passes.push({
      draw: await readDraw(reader, joinPath(root, pass.fixture)),
      dispatch: pass.dispatch,
    });
  }

  return { buffers: spec.computeBuffers ?? [], passes };
}

async function readPost(
  reader: ClosureReader,
  postPath: string,
  width: number,
  height: number,
): Promise<PostPassPlan[]> {
  const document = await reader.json<PostGraphDocument | DrawSpec>(postPath);
  const entries =
    "passes" in document
      ? document.passes
      : [{ name: "post", fixture: postPath.slice(directoryOf(postPath).length + 1) }];
  const passes: PostPassPlan[] = [];

  for (const [index, entry] of entries.entries()) {
    const draw = await readDraw(reader, joinPath(directoryOf(postPath), entry.fixture));
    passes.push({
      name: entry.name,
      width: draw.spec.width ?? width,
      height: draw.spec.height ?? height,
      final: index === entries.length - 1,
      outputSrgb: draw.spec.outputSrgb ?? false,
      clearColor: clearColor(draw.spec),
      draw,
    });
  }

  return passes;
}

async function readCapture(
  reader: ClosureReader,
  name: string,
  manifest: ViewManifest,
  root: string,
): Promise<CapturePlan> {
  const shadows: ShadowPlan[] = [];

  for (const shadow of manifest.shadows ?? []) {
    const path = joinPath(root, shadow.fixture);
    const fixture = await reader.json<SceneFixture>(path);
    const draws: DrawRef[] = [];

    for (const draw of fixture.draws ?? []) {
      draws.push(await readDraw(reader, joinPath(directoryOf(path), draw)));
    }

    shadows.push({
      name: shadow.name,
      identity: shadow.generatedShadow,
      width: fixture.width,
      height: fixture.height,
      compute: await readCompute(reader, directoryOf(path), fixture),
      draws,
    });
  }

  const sceneEntry = manifest.scenes[0];

  if (sceneEntry === undefined || manifest.scenes.length !== 1) {
    throw new Error(`View ${name} needs exactly one scene`);
  }

  const scenePath = joinPath(root, sceneEntry.fixture);
  const fixture = await reader.json<SceneFixture>(scenePath);
  const sceneRoot = directoryOf(scenePath);
  const draws: DrawRef[] = [];

  if (fixture.draws === undefined) {
    draws.push({ id: scenePath, root: sceneRoot, spec: fixture });
  } else {
    for (const draw of fixture.draws) {
      draws.push(await readDraw(reader, joinPath(sceneRoot, draw)));
    }
  }

  if (fixture.postProcess === undefined) {
    throw new Error(`Scene ${scenePath} has no post graph`);
  }

  const transforms = manifest.provenance?.scene?.requestTransforms;

  return {
    name,
    shadows,
    camera: transforms?.camera,
    item: transforms?.item,
    scene: {
      name: sceneEntry.name,
      width: fixture.width,
      height: fixture.height,
      clearColor: clearColor(fixture),
      depthFormat: fixture.depthFormat ?? "d32f",
      snapshots: fixture.snapshots ?? [],
      compute: await readCompute(reader, sceneRoot, fixture),
      draws,
      post: await readPost(
        reader,
        joinPath(sceneRoot, fixture.postProcess),
        fixture.width,
        fixture.height,
      ),
    },
  };
}

export async function readItemPlan(reader: ClosureReader, packagePath: string): Promise<ItemPlan> {
  const item = await reader.json<ItemPackage>(packagePath);

  if (item.version !== 2) {
    throw new Error("The viewer reads item packages version 2");
  }

  const root = directoryOf(packagePath);
  const paints: PaintPlan[] = [];

  for (const paint of item.paint.passes) {
    paints.push(await readPaint(reader, root, paint));
  }

  const captures: CapturePlan[] = [];
  const composed: Record<string, ComposedView> = {};

  for (const [name, view] of Object.entries(item.views)) {
    if (typeof view === "string") {
      const path = joinPath(root, view);
      captures.push(
        await readCapture(reader, name, await reader.json<ViewManifest>(path), directoryOf(path)),
      );
    } else if ("captures" in view) {
      composed[name] = view;
    } else {
      captures.push(await readCapture(reader, name, view, root));
    }
  }

  return {
    packagePath,
    item: item.item,
    paints,
    captures,
    composed,
    binding: bindingSlice(item),
  };
}

// Every draw of a plan, each once.
export function planDraws(plan: ItemPlan): DrawRef[] {
  const draws = new Map<string, DrawRef>();
  const add = (draw: DrawRef) => {
    draws.set(draw.id, draw);
  };

  for (const paint of plan.paints) {
    add(paint.draw);
    paint.compressors.forEach((compressor) => add(compressor.draw));
  }

  for (const capture of plan.captures) {
    for (const shadow of capture.shadows) {
      shadow.compute.passes.forEach((pass) => add(pass.draw));
      shadow.draws.forEach(add);
    }

    capture.scene.compute.passes.forEach((pass) => add(pass.draw));
    capture.scene.draws.forEach(add);
    capture.scene.post.forEach((pass) => add(pass.draw));
  }

  return [...draws.values()];
}

// The closure path of each file a draw reads.
export function drawFiles(draw: DrawRef): string[] {
  const files: string[] = [];
  const spec = draw.spec;

  for (const shader of [
    spec.vertexShader,
    spec.fragmentShader,
    spec.computeShader,
    spec.vertices,
  ]) {
    if (shader !== undefined) {
      files.push(joinPath(draw.root, shader));
    }
  }

  for (const descriptor of spec.descriptors) {
    if (descriptor.path !== undefined) {
      files.push(joinPath(draw.root, descriptor.path));
    }
  }

  return files;
}

// The draws the free camera renders with a camera translation, each once, with
// the role that decides its live words (camera/live.ts): every scene draw and
// every shadow draw of every capture.
export function planCameraDraws(
  plan: ItemPlan,
): Array<{ draw: DrawRef; role: "scene" | "shadow" }> {
  const draws = new Map<string, { draw: DrawRef; role: "scene" | "shadow" }>();

  for (const capture of plan.captures) {
    for (const shadow of capture.shadows) {
      shadow.draws.forEach((draw) => draws.set(draw.id, { draw, role: "shadow" }));
    }

    capture.scene.draws.forEach((draw) => draws.set(draw.id, { draw, role: "scene" }));
  }

  return [...draws.values()];
}

// Linked items. The executor writes a linked manifest (`links/<identity>/item.json`, kind
// `linked`) and its draws with absolute paths into its work directory, while item packages use
// paths relative to each file. A closure must not depend on the host directory, so the builder
// relocates those JSON files: every string that starts with the work directory becomes a path
// relative to the file that holds it. The result reads like any package and two hosts that link
// the same item publish the same bytes.

// The work directory a linked manifest was written in, from the item package path it records
// (`provenance.item.package`, `<work>/packages/items/<sha256>/item.json`). Undefined for a
// package that is not linked.
export function linkedSourceRoot(document: unknown): string | undefined {
  if (document === null || typeof document !== "object") {
    return undefined;
  }

  const manifest = document as { kind?: unknown; provenance?: { item?: { package?: unknown } } };

  if (manifest.kind !== "linked") {
    return undefined;
  }

  const itemPackage = manifest.provenance?.item?.package;

  if (typeof itemPackage !== "string") {
    throw new Error("The linked manifest does not record its item package path");
  }

  const match = /^(\/.*)\/packages\/items\/[^/]+\/item\.json$/.exec(itemPackage);

  if (match === null || match[1] === undefined) {
    throw new Error(`The linked item package ${itemPackage} is not inside a work directory`);
  }

  return match[1];
}

// The JSON text of the file at `closurePath` with every string under `sourceRoot` made relative
// to that file's directory. Text that names no such path is returned unchanged.
export function relocateJson(text: string, sourceRoot: string, closurePath: string): string {
  const needle = `"${sourceRoot.replace(/\/+$/, "")}/`;

  if (!text.includes(needle)) {
    return text;
  }

  const depth = directoryOf(closurePath)
    .split("/")
    .filter((part) => part !== "").length;

  return text.split(needle).join(`"${"../".repeat(depth)}`);
}
