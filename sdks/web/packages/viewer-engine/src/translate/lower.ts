// Lowers a CS2 SPIR-V variant to the subset that naga translates to WGSL and
// WebGPU accepts. Each pass rewrites a construct the Vulkan executor uses and
// WebGPU lacks; the rewrites are listed in the translation record so a
// deviation is never silent:
//
// - bindless arrays: an index that evaluates to a constant from the draw's
//   immutable uniforms becomes a direct binding of that one element;
// - images declared with unknown depth get depth 0 or 1 from their use;
// - explicitly laid out uniform and read-only storage blocks become arrays of
//   32-bit words, so CS2's relaxed member offsets keep their bytes;
// - OpIsNan and OpIsInf become exponent bit tests (WGSL may fold x != x);
// - vector OpLogicalAnd and OpLogicalOr become OpSelect;
// - OpImageQueryLod becomes the derivative formula (an approximation of the
//   hardware LOD: no anisotropy, no sampler clamps beyond the mip count);
// - a fragment stage of a draw with a depth bias writes its biased depth
//   itself (Vulkan's formula, below), because Metal's rasterizer bias puts a
//   D16 shadow atlas one unit deeper than the executor's.

import { idOf, type Instruction, SpirvModule } from "./spirv-text.ts";
import { type SpirvType, TypeTable } from "./types.ts";

export interface DescriptorInput {
  set: number;
  binding: number;
  arrayElement: number;
  type: "uniform" | "storage" | "texture" | "sampler" | "outputImage";
  // Uniform contents known at translation time (file-backed and not mutable).
  data?: Uint8Array | undefined;
  bytes?: number | undefined;
  viewType?: string | undefined;
  format?: string | undefined;
  compare?: string | undefined;
  // Sampler axes (u, v, w) that clamp to the transparent black border.
  border?: [boolean, boolean, boolean] | undefined;
  // Byte ranges [begin, end) of `data` the engine rewrites at run time (the
  // free camera's words): they stay loads and never decide a bindless index.
  live?: Array<[number, number]> | undefined;
  // A request-time buffer whose binding programs write only `live` byte ranges: its baseline
  // bytes outside them never change, so bindless indices may be evaluated from them (sticker
  // texture slots live in the sticker block). Its words are still loaded, never folded.
  fixed?: { data: Uint8Array; live: Array<[number, number]> } | undefined;
}

// The bytes of a buffer the evaluator may read, and the ranges it must treat as unknown.
interface IndexSource {
  data: Uint8Array;
  live: Array<[number, number]>;
}

export type ResourceKind = "uniform" | "storage" | "texture" | "sampler" | "storageTexture";

export interface ShaderResource {
  key: string;
  kind: ResourceKind;
  set: number;
  binding: number;
  element: number;
  // uniform and storage: the byte size the WGSL type declares.
  size?: number;
  readOnly?: boolean;
  // texture: WGSL view dimension and whether it is a depth texture.
  dimension?: "2d" | "2d-array" | "cube" | "cube-array" | "3d";
  depth?: boolean;
  // storageTexture: its texel format.
  format?: string;
  comparison?: boolean;
}

export interface LoweredStage {
  module: SpirvModule;
  resources: ShaderResource[];
  // The variable ids of each resource key in this stage.
  variables: Map<string, string[]>;
  rewrites: Record<string, number>;
}

const glslImport = (module: SpirvModule): string => {
  const found = module.instructions.find(
    (instruction) =>
      instruction.op === "OpExtInstImport" && instruction.operands[0] === '"GLSL.std.450"',
  );

  if (found?.result !== undefined) {
    return found.result;
  }

  const result = module.fresh("glsl");
  const index = module.instructions.findIndex((instruction) => instruction.op === "OpMemoryModel");

  module.instructions.splice(index, 0, {
    result,
    op: "OpExtInstImport",
    operands: ['"GLSL.std.450"'],
  });

  return result;
};

class Builder {
  readonly module: SpirvModule;

  constructor(module: SpirvModule) {
    this.module = module;
  }

  type(op: string, ...operands: string[]): string {
    return this.module.declare(op, operands);
  }

  uint(): string {
    return this.type("OpTypeInt", "32", "0");
  }

  int(): string {
    return this.type("OpTypeInt", "32", "1");
  }

  float(): string {
    return this.type("OpTypeFloat", "32");
  }

  bool(): string {
    return this.type("OpTypeBool");
  }

  vector(component: string, count: number): string {
    return this.type("OpTypeVector", `%${component}`, String(count));
  }

  pointer(storage: string, pointee: string): string {
    return this.type("OpTypePointer", storage, `%${pointee}`);
  }

  constant(type: string, value: number): string {
    return this.module.declare("OpConstant", [`%${type}`, String(value)]);
  }

  uintConstant(value: number): string {
    return this.constant(this.uint(), value >>> 0);
  }

  // A constant of a scalar or vector type with every component `value`.
  splat(type: string, scalar: string, count: number, value: number): string {
    const component = this.constant(scalar, value);

    if (count === 1) {
      return component;
    }

    return this.module.declare("OpConstantComposite", [
      `%${type}`,
      ...Array.from({ length: count }, () => `%${component}`),
    ]);
  }
}

function storageOf(types: TypeTable, variable: Instruction): string {
  const pointer = types.type(idOf(variable.operands[0]));

  return pointer.kind === "pointer" ? pointer.storage : "";
}

// Where a pointer into an explicitly laid out block points.
interface BlockPointer {
  variable: string;
  type: string;
  offset: number;
  dynamic: Array<{ index: string; stride: number; count?: number | undefined }>;
  // Byte distance between vector components (a row-major matrix column).
  componentStride: number;
  matrix: { stride: number; rowMajor: boolean } | undefined;
}

class BlockPointers {
  private readonly types: TypeTable;

  private readonly blocks: Set<string>;

  private readonly cache = new Map<string, BlockPointer | null>();

  // The declared block type of each variable, kept when a pass retypes it.
  private readonly roots = new Map<string, string>();

  constructor(types: TypeTable, blocks: Set<string>) {
    this.types = types;
    this.blocks = blocks;

    for (const block of blocks) {
      const definition = types.definition(block);
      const pointer =
        definition === undefined ? undefined : types.type(idOf(definition.operands[0]));

      if (pointer?.kind === "pointer") {
        this.roots.set(block, pointer.pointee);
      }
    }
  }

  resolve(pointer: string): BlockPointer | undefined {
    if (this.cache.has(pointer)) {
      return this.cache.get(pointer) ?? undefined;
    }

    const resolved = this.compute(pointer);
    this.cache.set(pointer, resolved ?? null);

    return resolved;
  }

  private compute(pointer: string): BlockPointer | undefined {
    const definition = this.types.definition(pointer);

    if (definition === undefined) {
      return undefined;
    }

    if (definition.op === "OpVariable") {
      const root = this.roots.get(pointer);

      if (!this.blocks.has(pointer) || root === undefined) {
        return undefined;
      }

      return {
        variable: pointer,
        type: root,
        offset: 0,
        dynamic: [],
        componentStride: 4,
        matrix: undefined,
      };
    }

    if (definition.op !== "OpAccessChain" && definition.op !== "OpInBoundsAccessChain") {
      return undefined;
    }

    const base = this.resolve(idOf(definition.operands[1]));

    if (base === undefined) {
      return undefined;
    }

    let current: BlockPointer = { ...base, dynamic: [...base.dynamic] };

    for (const operand of definition.operands.slice(2)) {
      current = this.step(current, idOf(operand));
    }

    return current;
  }

  private step(pointer: BlockPointer, index: string): BlockPointer {
    const type = this.types.type(pointer.type);
    const constant = this.types.constantValue(index);
    const next = { ...pointer, dynamic: [...pointer.dynamic] };
    const advance = (stride: number, count?: number) => {
      if (constant !== undefined) {
        next.offset += constant * stride;
      } else {
        next.dynamic.push({ index, stride, count });
      }
    };

    switch (type.kind) {
      case "struct": {
        if (constant === undefined) {
          throw new Error("A struct member index must be constant");
        }

        next.offset += this.types.memberOffset(pointer.type, constant);
        next.type = type.members[constant] ?? "";
        next.matrix = this.types.matrixLayout(pointer.type, constant);

        return next;
      }

      case "array":
      case "runtimeArray": {
        const stride = type.stride ?? this.types.byteSize(type.element);
        advance(stride, type.kind === "array" ? type.length : undefined);
        next.type = type.element;

        return next;
      }

      case "matrix": {
        const layout = pointer.matrix ?? { stride: 16, rowMajor: false };

        if (layout.rowMajor) {
          advance(4);
          next.componentStride = layout.stride;
        } else {
          advance(layout.stride);
          next.componentStride = 4;
        }

        next.type = type.column;

        return next;
      }

      case "vector": {
        advance(pointer.componentStride);
        next.type = type.component;

        return next;
      }

      default: {
        throw new Error(`Cannot index into ${type.kind}`);
      }
    }
  }
}

// The live byte ranges of the immutable contents lowerStage copied for one
// translation; a word inside one is not known at translation time.
const liveWords = new WeakMap<Uint8Array, Array<[number, number]>>();

function readWord(data: Uint8Array, offset: number): number | undefined {
  if (offset < 0 || offset + 4 > data.length) {
    return undefined;
  }

  const live = liveWords.get(data);

  if (live?.some(([begin, end]) => offset < end && offset + 4 > begin) === true) {
    return undefined;
  }

  return (
    ((data[offset] ?? 0) |
      ((data[offset + 1] ?? 0) << 8) |
      ((data[offset + 2] ?? 0) << 16) |
      ((data[offset + 3] ?? 0) << 24)) >>>
    0
  );
}

// Evaluates integer expressions whose inputs are constants or loads from
// uniforms with known contents. A load through a dynamic array index yields
// every value the array holds at that field, so an index that selects a light
// record gives the set of texture slots any light can name.
const valueLimit = 256;

class IndexEvaluator {
  private readonly types: TypeTable;

  private readonly pointers: BlockPointers;

  private readonly data: Map<string, IndexSource>;

  private readonly cache = new Map<string, number[][] | null>();

  constructor(types: TypeTable, pointers: BlockPointers, data: Map<string, IndexSource>) {
    this.types = types;
    this.pointers = pointers;
    this.data = data;
  }

  // The possible values of a scalar, or undefined when they are not known.
  values(id: string): number[] | undefined {
    const values = this.evaluate(id, 0);

    if (values === undefined || values.some((value) => value.length !== 1)) {
      return undefined;
    }

    return [...new Set(values.map((value) => value[0] ?? 0))].sort((a, b) => a - b);
  }

  private evaluate(id: string, depth: number): number[][] | undefined {
    const cached = this.cache.get(id);

    if (cached !== undefined) {
      return cached ?? undefined;
    }

    const result = depth > 48 ? undefined : this.compute(id, depth);
    this.cache.set(id, result ?? null);

    return result;
  }

  private compute(id: string, depth: number): number[][] | undefined {
    const definition = this.types.definition(id);

    if (definition === undefined) {
      return undefined;
    }

    const operand = (index: number) => this.evaluate(idOf(definition.operands[index]), depth + 1);
    const binary = (operation: (a: number, b: number) => number) => {
      const left = operand(1);
      const right = operand(2);

      if (left === undefined || right === undefined || left.length * right.length > valueLimit) {
        return undefined;
      }

      const results: number[][] = [];

      for (const a of left) {
        for (const b of right) {
          if (a.length !== b.length) {
            return undefined;
          }

          results.push(a.map((value, index) => operation(value, b[index] ?? 0) >>> 0));
        }
      }

      return results;
    };

    switch (definition.op) {
      case "OpConstant": {
        return [[Number(definition.operands[1]) >>> 0]];
      }

      case "OpConstantNull": {
        return [[0]];
      }

      case "OpBitcast":
      case "OpCopyObject":
      case "OpUConvert":
      case "OpSConvert": {
        return operand(1);
      }

      case "OpIAdd": {
        return binary((a, b) => a + b);
      }

      case "OpISub": {
        return binary((a, b) => a - b);
      }

      case "OpIMul": {
        return binary((a, b) => Math.imul(a, b));
      }

      case "OpBitwiseAnd": {
        return binary((a, b) => a & b);
      }

      case "OpBitwiseOr": {
        return binary((a, b) => a | b);
      }

      case "OpBitwiseXor": {
        return binary((a, b) => a ^ b);
      }

      case "OpShiftLeftLogical": {
        return binary((a, b) => a << b);
      }

      case "OpShiftRightLogical": {
        return binary((a, b) => a >>> b);
      }

      case "OpShiftRightArithmetic": {
        return binary((a, b) => (a | 0) >> b);
      }

      case "OpCompositeExtract": {
        const composite = operand(1);

        if (composite === undefined || definition.operands.length !== 3) {
          return undefined;
        }

        const index = Number(definition.operands[2]);
        const values = composite.map((value) => value[index]);

        if (values.some((value) => value === undefined)) {
          return undefined;
        }

        return values.map((value) => [value ?? 0]);
      }

      case "OpLoad": {
        return this.load(idOf(definition.operands[0]), idOf(definition.operands[1]), depth);
      }

      default: {
        return undefined;
      }
    }
  }

  private load(type: string, pointer: string, depth: number): number[][] | undefined {
    const resolved = this.pointers.resolve(pointer);

    if (resolved === undefined) {
      return undefined;
    }

    const source = this.data.get(resolved.variable);

    if (source === undefined) {
      return undefined;
    }

    const data = source.data;

    // Every offset the dynamic indices can reach: a known index takes its
    // values, an unknown one every element of its array.
    let offsets = [resolved.offset];

    for (const term of resolved.dynamic) {
      let indices = this.values(term.index);

      if (indices === undefined && depth < 48) {
        const count = term.count ?? Math.floor((data.length - resolved.offset) / term.stride);
        indices = Array.from({ length: Math.max(0, count) }, (_, index) => index);
      }

      if (indices === undefined || offsets.length * indices.length > valueLimit * 4) {
        return undefined;
      }

      const next: number[] = [];

      for (const offset of offsets) {
        for (const index of indices) {
          next.push(offset + index * term.stride);
        }
      }

      offsets = next;
    }

    const shape = this.types.type(type);
    const lanes =
      shape.kind === "int"
        ? 1
        : shape.kind === "vector" && this.types.type(shape.component).kind === "int"
          ? shape.count
          : 0;

    if (lanes === 0) {
      return undefined;
    }

    const results: number[][] = [];
    const seen = new Set<string>();

    for (const offset of offsets) {
      const words: number[] = [];

      for (let component = 0; component < lanes; component++) {
        const at = offset + component * resolved.componentStride;
        const live = source.live.some(([start, end]) => at < end && at + 4 > start);
        const word = live ? undefined : readWord(data, at);

        if (word === undefined) {
          return undefined;
        }

        words.push(word);
      }

      const key = words.join(",");

      if (!seen.has(key)) {
        seen.add(key);
        results.push(words);
      }
    }

    return results.length > valueLimit ? undefined : results;
  }
}

interface Variable {
  id: string;
  set: number;
  binding: number;
  storage: string;
  pointee: string;
}

function variables(module: SpirvModule, types: TypeTable): Variable[] {
  const result: Variable[] = [];

  for (const instruction of module.instructions) {
    if (instruction.op !== "OpVariable" || instruction.result === undefined) {
      continue;
    }

    const storage = storageOf(types, instruction);

    if (!["Uniform", "StorageBuffer", "UniformConstant", "PushConstant"].includes(storage)) {
      continue;
    }

    const pointer = types.type(idOf(instruction.operands[0]));

    result.push({
      id: instruction.result,
      set: Number(module.decoration(instruction.result, "DescriptorSet") ?? -1),
      binding: Number(module.decoration(instruction.result, "Binding") ?? -1),
      storage,
      pointee: pointer.kind === "pointer" ? pointer.pointee : "",
    });
  }

  return result;
}

// Sets a pass's rewritten instructions, keeping the declarations the pass
// added to the module while it ran.
function replaceInstructions(
  module: SpirvModule,
  snapshot: Instruction[],
  output: Instruction[],
): void {
  const original = new Set(snapshot);
  const added = module.instructions.filter((instruction) => !original.has(instruction));
  const isDecoration = (instruction: Instruction) =>
    instruction.op.startsWith("OpDecorate") || instruction.op.startsWith("OpMemberDecorate");
  module.instructions = output;
  module.insertGlobals(added.filter((instruction) => !isDecoration(instruction)));
  module.insertDecorations(added.filter(isDecoration));
}

function traceDefinition(types: TypeTable, id: string, depth: number): string {
  const definition = types.definition(id);

  if (definition === undefined || depth > 6) {
    return `%${id}`;
  }

  const inner = definition.operands
    .slice(1)
    .map((operand) =>
      operand.startsWith("%") ? traceDefinition(types, operand.slice(1), depth + 1) : operand,
    );

  return `${definition.op}(${inner.join(", ")})`;
}

function count(rewrites: Record<string, number>, name: string, amount = 1): void {
  rewrites[name] = (rewrites[name] ?? 0) + amount;
}

// OpIsNan/OpIsInf as exponent bit tests and vector logical ops as selects.
function lowerArithmetic(module: SpirvModule, rewrites: Record<string, number>): void {
  const types = new TypeTable(module);
  const build = new Builder(module);
  const output: Instruction[] = [];

  const snapshot = [...module.instructions];

  for (const instruction of snapshot) {
    const result = instruction.result;

    if ((instruction.op === "OpIsNan" || instruction.op === "OpIsInf") && result !== undefined) {
      const boolType = idOf(instruction.operands[0]);
      const value = idOf(instruction.operands[1]);
      const boolShape = types.type(boolType);
      const lanes = boolShape.kind === "vector" ? boolShape.count : 1;
      const uint = build.uint();
      const uintType = lanes === 1 ? uint : build.vector(uint, lanes);
      const bits = module.fresh();
      const magnitude = module.fresh();
      const mask = build.splat(uintType, uint, lanes, 0x7fffffff);
      const infinity = build.splat(uintType, uint, lanes, 0x7f800000);

      output.push(
        { result: bits, op: "OpBitcast", operands: [`%${uintType}`, `%${value}`] },
        {
          result: magnitude,
          op: "OpBitwiseAnd",
          operands: [`%${uintType}`, `%${bits}`, `%${mask}`],
        },
        {
          result,
          op: instruction.op === "OpIsNan" ? "OpUGreaterThan" : "OpIEqual",
          operands: [`%${boolType}`, `%${magnitude}`, `%${infinity}`],
        },
      );
      count(rewrites, instruction.op === "OpIsNan" ? "isnan_bits" : "isinf_bits");
      continue;
    }

    const logical = instruction.op === "OpLogicalAnd" || instruction.op === "OpLogicalOr";

    if (logical && result !== undefined) {
      const type = idOf(instruction.operands[0]);
      const shape = types.type(type);

      if (shape.kind === "vector") {
        const isAnd = instruction.op === "OpLogicalAnd";
        const scalar = module.declare(isAnd ? "OpConstantFalse" : "OpConstantTrue", [
          `%${build.bool()}`,
        ]);
        const constant = module.declare("OpConstantComposite", [
          `%${type}`,
          ...Array.from({ length: shape.count }, () => `%${scalar}`),
        ]);
        const left = instruction.operands[1] ?? "";
        const right = instruction.operands[2] ?? "";

        output.push({
          result,
          op: "OpSelect",
          operands: isAnd
            ? [`%${type}`, left, right, `%${constant}`]
            : [`%${type}`, left, `%${constant}`, right],
        });
        count(rewrites, "vector_logical_select");
        continue;
      }
    }

    output.push(instruction);
  }

  replaceInstructions(module, snapshot, output);
}

const terminators = new Set([
  "OpBranch",
  "OpBranchConditional",
  "OpSwitch",
  "OpReturn",
  "OpReturnValue",
  "OpKill",
  "OpUnreachable",
  "OpTerminateInvocation",
]);

const viewTypeOf = (image: Instruction): string => {
  const dim = image.operands[1];
  const arrayed = image.operands[3] === "1";

  if (dim === "2D") {
    return arrayed ? "2dArray" : "2d";
  }

  if (dim === "Cube") {
    return arrayed ? "cubeArray" : "cube";
  }

  return dim === "3D" ? "3d" : String(dim);
};

interface Choice {
  selector: string;
  signed: boolean;
  // Each bound candidate element and the pointer to its variable.
  candidates: Array<{ value: number; pointer: string }>;
}

// Replaces bindless element accesses by variables of single elements. An index
// that evaluates to one constant becomes a direct access; an index with a
// known set of values becomes an OpSwitch over the bound candidates at every
// image operation that uses it (an unbound candidate reads zero, where the
// executor's partially bound descriptor is undefined). Returns the element of
// each new variable.
function specializeBindless(
  module: SpirvModule,
  data: Map<string, Uint8Array>,
  fixed: Map<string, IndexSource>,
  descriptors: DescriptorInput[],
  rewrites: Record<string, number>,
): Map<string, { source: string; element: number }> {
  const types = new TypeTable(module);
  const all = variables(module, types);
  const blocks = new Set(
    all.filter((v) => v.storage === "Uniform" || v.storage === "StorageBuffer").map((v) => v.id),
  );
  const pointers = new BlockPointers(types, blocks);
  const sources = new Map<string, IndexSource>();

  for (const [variable, bytes] of data) {
    sources.set(variable, { data: bytes, live: [] });
  }

  for (const [variable, source] of fixed) {
    if (!sources.has(variable)) {
      sources.set(variable, source);
    }
  }

  const evaluator = new IndexEvaluator(types, pointers, sources);
  const arrays = new Map<string, Variable>();

  for (const variable of all) {
    if (variable.storage === "UniformConstant" && types.type(variable.pointee).kind === "array") {
      arrays.set(variable.id, variable);
    }
  }

  if (arrays.size === 0) {
    return new Map();
  }

  const elementVariables = new Map<string, string>();
  const elements = new Map<string, { source: string; element: number }>();
  const globals: Instruction[] = [];
  const decorations: Instruction[] = [];

  const elementVariable = (base: string, element: number, pointerType: string): string => {
    const key = `${base}:${element}`;
    const existing = elementVariables.get(key);

    if (existing !== undefined) {
      return existing;
    }

    const array = arrays.get(base);
    const variable = module.fresh("element");
    elementVariables.set(key, variable);
    elements.set(variable, { source: base, element });
    globals.push({
      result: variable,
      op: "OpVariable",
      operands: [pointerType, "UniformConstant"],
    });
    decorations.push(
      {
        result: undefined,
        op: "OpDecorate",
        operands: [`%${variable}`, "DescriptorSet", String(array?.set ?? 0)],
      },
      {
        result: undefined,
        op: "OpDecorate",
        operands: [`%${variable}`, "Binding", String(array?.binding ?? 0)],
      },
    );

    return variable;
  };

  // Whether a descriptor of the draw can stand behind this element of the array.
  const bound = (array: Variable, element: number): boolean => {
    const descriptor = descriptors.find(
      (entry) =>
        entry.set === array.set &&
        entry.binding === array.binding &&
        entry.arrayElement === element,
    );

    if (descriptor === undefined) {
      return false;
    }

    const arrayType = types.type(array.pointee);
    const elementType = arrayType.kind === "array" ? types.type(arrayType.element) : arrayType;

    if (elementType.kind === "image") {
      return (
        descriptor.type === "texture" &&
        (descriptor.viewType ?? "2d") === viewTypeOf(elementType.instruction)
      );
    }

    return descriptor.type === "sampler";
  };

  const substitutions = new Map<string, string>();
  const dynamicChains = new Map<string, Choice>();
  const output: Instruction[] = [];
  const snapshot = [...module.instructions];

  for (const instruction of snapshot) {
    const isChain =
      instruction.op === "OpAccessChain" || instruction.op === "OpInBoundsAccessChain";
    const base = isChain ? idOf(instruction.operands[1]) : "";
    const array = arrays.get(base);

    if (!isChain || array === undefined || instruction.result === undefined) {
      output.push(instruction);
      continue;
    }

    if (instruction.operands.length !== 3) {
      throw new Error("A bindless access chain has more than one index");
    }

    const index = idOf(instruction.operands[2]);
    const values = evaluator.values(index);
    const pointerType = instruction.operands[0] ?? "";

    if (values === undefined) {
      const trace =
        process.env.VIEWER_TRANSLATE_TRACE === undefined
          ? ""
          : `: ${traceDefinition(types, index, 0)}`;

      throw new Error(`A bindless index has no translation-time value set${trace}`);
    }

    if (values.length === 1) {
      substitutions.set(instruction.result, elementVariable(base, values[0] ?? 0, pointerType));
      count(rewrites, "bindless_constant_element");
      continue;
    }

    const indexDefinition = types.definition(index);
    const indexType = indexDefinition === undefined ? undefined : types.resultType(indexDefinition);
    const indexShape = indexType === undefined ? undefined : types.type(indexType);
    dynamicChains.set(instruction.result, {
      selector: index,
      signed: indexShape?.kind === "int" && indexShape.signed,
      candidates: values
        .filter((value) => bound(array, value))
        .map((value) => ({ value, pointer: elementVariable(base, value, pointerType) })),
    });
    output.push(instruction);
  }

  replaceInstructions(module, snapshot, output);
  module.substitute(substitutions);

  if (dynamicChains.size > 0) {
    dispatchDynamic(module, dynamicChains, rewrites);
  }

  module.insertGlobals(globals);
  module.insertDecorations(decorations);

  const removed = new Set(arrays.keys());

  module.instructions = module.instructions.filter((instruction) => {
    if (instruction.result !== undefined && removed.has(instruction.result)) {
      return false;
    }

    return !(instruction.op === "OpDecorate" && removed.has(idOf(instruction.operands[0])));
  });

  for (const instruction of module.instructions) {
    if (instruction.op === "OpEntryPoint") {
      instruction.operands = instruction.operands.filter(
        (operand) => !(operand.startsWith("%") && removed.has(operand.slice(1))),
      );
      instruction.operands.push(...[...elements.keys()].map((id) => `%${id}`));
    }
  }

  return elements;
}

// Wraps every image operation whose image or sampler comes through a dynamic
// bindless index in nested OpSwitch constructs, one level per dynamic operand.
function dispatchDynamic(
  module: SpirvModule,
  chains: Map<string, Choice>,
  rewrites: Record<string, number>,
): void {
  const lookup = () => module.definitions();
  let definitions = lookup();
  const dynamicLoad = (id: string): Choice | undefined => {
    const definition = definitions.get(id);

    if (definition?.op !== "OpLoad") {
      return undefined;
    }

    return chains.get(idOf(definition.operands[1]));
  };

  const usesDynamic = (instruction: Instruction): number => {
    if (
      instruction.op === "OpLoad" ||
      instruction.op === "OpSampledImage" ||
      (instruction.result === undefined && instruction.op !== "OpImageWrite")
    ) {
      return -1;
    }

    return instruction.operands.findIndex((operand) => {
      if (!operand.startsWith("%")) {
        return false;
      }

      const id = operand.slice(1);

      if (dynamicLoad(id) !== undefined) {
        return true;
      }

      const definition = definitions.get(id);

      return (
        definition?.op === "OpSampledImage" &&
        (dynamicLoad(idOf(definition.operands[1])) !== undefined ||
          dynamicLoad(idOf(definition.operands[2])) !== undefined)
      );
    });
  };

  for (;;) {
    definitions = lookup();
    const position = module.instructions.findIndex((instruction) => usesDynamic(instruction) >= 0);

    if (position < 0) {
      break;
    }

    const operation = module.instructions[position] as Instruction;
    const operandIndex = usesDynamic(operation);
    const operandId = idOf(operation.operands[operandIndex]);
    const sampled = definitions.get(operandId);
    const viaSampler = sampled?.op === "OpSampledImage";
    const imageLoad = viaSampler ? definitions.get(idOf(sampled.operands[1])) : sampled;
    const samplerLoad = viaSampler ? definitions.get(idOf(sampled.operands[2])) : undefined;

    if (imageLoad?.op !== "OpLoad") {
      throw new Error("A dynamic bindless image is not loaded directly");
    }

    // The operands each case rebuilds: [image pointer, sampler pointer?].
    const sources: Array<{ load: Instruction; choice: Choice | undefined }> = [
      { load: imageLoad, choice: chains.get(idOf(imageLoad.operands[1])) },
    ];

    if (samplerLoad !== undefined) {
      if (samplerLoad.op !== "OpLoad") {
        throw new Error("A dynamic bindless sampler is not loaded directly");
      }

      sources.push({ load: samplerLoad, choice: chains.get(idOf(samplerLoad.operands[1])) });
    }

    let start = position;

    while (start > 0 && module.instructions[start]?.op !== "OpLabel") {
      start--;
    }

    let end = position;

    while (
      end < module.instructions.length &&
      !terminators.has(module.instructions[end]?.op ?? "")
    ) {
      end++;
    }

    const block = module.instructions.slice(start, end + 1);

    if (block.some((instruction) => instruction.op === "OpLoopMerge")) {
      throw new Error("A dynamic bindless operation sits in a loop header");
    }

    const originalLabel = module.instructions[start]?.result ?? "";
    const before = module.instructions.slice(start, position);
    const after = module.instructions.slice(position + 1, end + 1);
    const resultType = operation.result === undefined ? undefined : operation.operands[0];
    const generated: Instruction[] = [];
    const levels = sources.filter((source) => source.choice !== undefined);

    // Emits the blocks for one level. `chosen` holds a pointer per source.
    const emitLevel = (
      level: number,
      chosen: string[],
      exit: string,
      header: string | undefined,
    ): { exitFrom: string; value: string | undefined; instructions: Instruction[] } => {
      const instructions: Instruction[] = [];

      if (level === levels.length) {
        const label = header ?? module.fresh("case");
        instructions.push({ result: label, op: "OpLabel", operands: [] });
        const values = sources.map((source, index) => {
          const value = module.fresh("v");
          instructions.push({
            result: value,
            op: "OpLoad",
            operands: [source.load.operands[0] ?? "", `%${chosen[index] ?? ""}`],
          });

          return value;
        });
        let operand = values[0] ?? "";

        if (viaSampler) {
          operand = module.fresh("v");
          instructions.push({
            result: operand,
            op: "OpSampledImage",
            operands: [sampled.operands[0] ?? "", `%${values[0] ?? ""}`, `%${values[1] ?? ""}`],
          });
        }

        const value = operation.result === undefined ? undefined : module.fresh("v");
        const operands = [...operation.operands];
        operands[operandIndex] = `%${operand}`;
        instructions.push({ result: value, op: operation.op, operands });
        instructions.push({ result: undefined, op: "OpBranch", operands: [`%${exit}`] });

        return { exitFrom: label, value, instructions };
      }

      const levelSource = levels[level];
      const choice = levelSource?.choice as Choice;
      const sourceIndex = sources.indexOf(levelSource as (typeof sources)[number]);
      const merge = module.fresh("merge");
      const fallback = module.fresh("default");

      if (header !== undefined) {
        instructions.push({ result: header, op: "OpLabel", operands: [] });
      }

      const cases = choice.candidates.map((candidate) => {
        const next = [...chosen];
        next[sourceIndex] = candidate.pointer;

        return { candidate, emitted: emitLevel(level + 1, next, merge, module.fresh("case")) };
      });
      const literal = (value: number) => String(choice.signed ? value | 0 : value >>> 0);
      instructions.push(
        { result: undefined, op: "OpSelectionMerge", operands: [`%${merge}`, "None"] },
        {
          result: undefined,
          op: "OpSwitch",
          operands: [
            `%${choice.selector}`,
            `%${fallback}`,
            ...cases.flatMap(({ candidate, emitted }) => [
              literal(candidate.value),
              `%${emitted.instructions[0]?.result ?? ""}`,
            ]),
          ],
        },
      );

      for (const { emitted } of cases) {
        instructions.push(...emitted.instructions);
      }

      instructions.push(
        { result: fallback, op: "OpLabel", operands: [] },
        { result: undefined, op: "OpBranch", operands: [`%${merge}`] },
        { result: merge, op: "OpLabel", operands: [] },
      );

      let value: string | undefined;

      if (resultType !== undefined) {
        value = level === 0 ? operation.result : module.fresh("v");
        const zero = module.declare("OpConstantNull", [resultType]);
        instructions.push({
          result: value,
          op: "OpPhi",
          operands: [
            resultType,
            ...cases.flatMap(({ emitted }) => [`%${emitted.value ?? ""}`, `%${emitted.exitFrom}`]),
            `%${zero}`,
            `%${fallback}`,
          ],
        });
      }

      if (level > 0) {
        instructions.push({ result: undefined, op: "OpBranch", operands: [`%${exit}`] });
      }

      return { exitFrom: merge, value, instructions };
    };

    const staticPointers = sources.map((source) =>
      source.choice === undefined ? idOf(source.load.operands[1]) : "",
    );
    const top = emitLevel(0, staticPointers, "", undefined);
    generated.push(...before, ...top.instructions, ...after);
    module.instructions.splice(start, end + 1 - start, ...generated);

    // Successor phis now see the final merge block as their predecessor.
    const finalMerge = top.exitFrom;
    const generatedSet = new Set(generated);

    for (const instruction of module.instructions) {
      if (instruction.op !== "OpPhi" || generatedSet.has(instruction)) {
        continue;
      }

      for (let index = 2; index < instruction.operands.length; index += 2) {
        if (instruction.operands[index] === `%${originalLabel}`) {
          instruction.operands[index] = `%${finalMerge}`;
        }
      }
    }

    count(rewrites, "bindless_switch_dispatch");
  }

  // The dynamic chains and the loads and sampled images through them are dead.
  definitions = lookup();
  const dead = new Set(chains.keys());
  let changed = true;

  while (changed) {
    changed = false;

    for (const instruction of module.instructions) {
      const result = instruction.result;

      if (result === undefined || dead.has(result)) {
        continue;
      }

      const readsDead = instruction.operands.some(
        (operand) => operand.startsWith("%") && dead.has(operand.slice(1)),
      );

      if (readsDead && (instruction.op === "OpLoad" || instruction.op === "OpSampledImage")) {
        dead.add(result);
        changed = true;
      }
    }
  }

  module.instructions = module.instructions.filter(
    (instruction) => instruction.result === undefined || !dead.has(instruction.result),
  );
}

const drefOps = new Set([
  "OpImageSampleDrefImplicitLod",
  "OpImageSampleDrefExplicitLod",
  "OpImageSampleProjDrefImplicitLod",
  "OpImageSampleProjDrefExplicitLod",
  "OpImageDrefGather",
]);

// Gives every image whose depth is unknown (2) depth 1 when a comparison uses
// it and depth 0 otherwise, splitting a variable used both ways.
function resolveImageDepth(module: SpirvModule, rewrites: Record<string, number>): void {
  const types = new TypeTable(module);
  const build = new Builder(module);
  const users = new Map<string, Instruction[]>();

  for (const instruction of module.instructions) {
    for (const operand of instruction.operands) {
      if (operand.startsWith("%")) {
        const id = operand.slice(1);
        const list = users.get(id) ?? [];
        list.push(instruction);
        users.set(id, list);
      }
    }
  }

  const comparedLoads = (load: string): boolean =>
    (users.get(load) ?? []).some((user) => {
      if (drefOps.has(user.op)) {
        return true;
      }

      if (user.op === "OpSampledImage" && user.result !== undefined) {
        return (users.get(user.result) ?? []).some((use) => drefOps.has(use.op));
      }

      return false;
    });

  const variants = new Map<string, Map<number, Instruction[]>>();

  for (const instruction of module.instructions) {
    if (instruction.op !== "OpLoad" || instruction.result === undefined) {
      continue;
    }

    const type = types.type(idOf(instruction.operands[0]));

    if (type.kind !== "image" || type.instruction.operands[2] !== "2") {
      continue;
    }

    const depth = comparedLoads(instruction.result) ? 1 : 0;
    const variable = idOf(instruction.operands[1]);
    const byDepth = variants.get(variable) ?? new Map<number, Instruction[]>();
    const list = byDepth.get(depth) ?? [];
    list.push(instruction);
    byDepth.set(depth, list);
    variants.set(variable, byDepth);
  }

  const globals: Instruction[] = [];
  const decorations: Instruction[] = [];
  const entryAdditions: string[] = [];

  for (const [variable, byDepth] of variants) {
    const definition = types.definition(variable);

    if (definition === undefined) {
      continue;
    }

    let first = true;

    for (const [depth, loads] of byDepth) {
      const imageType = types.type(idOf(loads[0]?.operands[0]));

      if (imageType.kind !== "image") {
        continue;
      }

      const operands = [...imageType.instruction.operands];
      operands[2] = String(depth);
      const resolvedImage = module.declare("OpTypeImage", operands);
      const pointerType = build.pointer("UniformConstant", resolvedImage);
      const sampledType = () => module.declare("OpTypeSampledImage", [`%${resolvedImage}`]);
      let target = variable;

      if (first) {
        definition.operands[0] = `%${pointerType}`;
        first = false;
      } else {
        target = module.fresh("depth_variant");
        globals.push({
          result: target,
          op: "OpVariable",
          operands: [`%${pointerType}`, "UniformConstant"],
        });

        for (const decoration of module.decorations(variable)) {
          decorations.push({
            ...decoration,
            operands: [`%${target}`, ...decoration.operands.slice(1)],
          });
        }

        entryAdditions.push(`%${target}`);
      }

      for (const load of loads) {
        load.operands[0] = `%${resolvedImage}`;
        load.operands[1] = `%${target}`;

        for (const user of users.get(load.result ?? "") ?? []) {
          if (user.op === "OpSampledImage") {
            user.operands[0] = `%${sampledType()}`;
          }
        }
      }

      count(rewrites, depth === 1 ? "image_depth_compare" : "image_depth_float");
    }
  }

  module.insertGlobals(globals);
  module.insertDecorations(decorations);

  for (const instruction of module.instructions) {
    if (instruction.op === "OpEntryPoint") {
      instruction.operands.push(...entryAdditions);
    }
  }
}

// OpImageQueryLod as clamp(log2(max(|ddx(uv * size)|, |ddy(uv * size)|))).
function emulateQueryLod(module: SpirvModule, rewrites: Record<string, number>): void {
  const types = new TypeTable(module);
  const build = new Builder(module);
  const glsl = glslImport(module);
  const output: Instruction[] = [];

  const snapshot = [...module.instructions];

  for (const instruction of snapshot) {
    if (instruction.op !== "OpImageQueryLod" || instruction.result === undefined) {
      output.push(instruction);
      continue;
    }

    const resultType = idOf(instruction.operands[0]);
    const sampled = types.definition(idOf(instruction.operands[1]));
    const sampledType = types.type(idOf(sampled?.operands[0]));

    if (sampledType.kind !== "sampledImage") {
      throw new Error("OpImageQueryLod needs a sampled image");
    }

    const image = types.type(sampledType.image);

    if (image.kind !== "image" || image.instruction.operands[1] !== "2D") {
      throw new Error("OpImageQueryLod emulation supports 2D images only");
    }

    const arrayed = image.instruction.operands[3] === "1";
    const int = build.int();
    const float = build.float();
    const v2float = build.vector(float, 2);
    const sizeType = build.vector(int, arrayed ? 3 : 2);
    const zero = build.constant(int, 0);
    const one = build.constant(int, 1);
    const floatZero = build.constant(float, 0);
    const id = () => module.fresh("lod");
    const imageValue = id();
    const size = id();
    const size2 = id();
    const levels = id();
    const sizeFloat = id();
    const scaled = id();
    const dx = id();
    const dy = id();
    const lengthX = id();
    const lengthY = id();
    const maximum = id();
    const lambda = id();
    const lastLevel = id();
    const lastLevelFloat = id();
    const clamped = id();
    const sizeOperands = arrayed
      ? {
          result: size2,
          op: "OpVectorShuffle",
          operands: [`%${build.vector(int, 2)}`, `%${size}`, `%${size}`, "0", "1"],
        }
      : { result: size2, op: "OpCopyObject", operands: [`%${sizeType}`, `%${size}`] };

    output.push(
      {
        result: imageValue,
        op: "OpImage",
        operands: [`%${sampledType.image}`, `%${sampled?.result ?? ""}`],
      },
      {
        result: size,
        op: "OpImageQuerySizeLod",
        operands: [`%${sizeType}`, `%${imageValue}`, `%${zero}`],
      },
      sizeOperands,
      { result: levels, op: "OpImageQueryLevels", operands: [`%${int}`, `%${imageValue}`] },
      { result: sizeFloat, op: "OpConvertSToF", operands: [`%${v2float}`, `%${size2}`] },
      {
        result: scaled,
        op: "OpFMul",
        operands: [`%${v2float}`, instruction.operands[2] ?? "", `%${sizeFloat}`],
      },
      { result: dx, op: "OpDPdx", operands: [`%${v2float}`, `%${scaled}`] },
      { result: dy, op: "OpDPdy", operands: [`%${v2float}`, `%${scaled}`] },
      { result: lengthX, op: "OpExtInst", operands: [`%${float}`, `%${glsl}`, "Length", `%${dx}`] },
      { result: lengthY, op: "OpExtInst", operands: [`%${float}`, `%${glsl}`, "Length", `%${dy}`] },
      {
        result: maximum,
        op: "OpExtInst",
        operands: [`%${float}`, `%${glsl}`, "FMax", `%${lengthX}`, `%${lengthY}`],
      },
      {
        result: lambda,
        op: "OpExtInst",
        operands: [`%${float}`, `%${glsl}`, "Log2", `%${maximum}`],
      },
      { result: lastLevel, op: "OpISub", operands: [`%${int}`, `%${levels}`, `%${one}`] },
      { result: lastLevelFloat, op: "OpConvertSToF", operands: [`%${float}`, `%${lastLevel}`] },
      {
        result: clamped,
        op: "OpExtInst",
        operands: [
          `%${float}`,
          `%${glsl}`,
          "FClamp",
          `%${lambda}`,
          `%${floatZero}`,
          `%${lastLevelFloat}`,
        ],
      },
      {
        result: instruction.result,
        op: "OpCompositeConstruct",
        operands: [`%${resultType}`, `%${clamped}`, `%${lambda}`],
      },
    );
    count(rewrites, "query_lod_derivatives");
  }

  replaceInstructions(module, snapshot, output);
}

// Vulkan's depth bias, o = m * slope + r * constant with m = max(|dz/dx|,
// |dz/dy|), clamped by `clamp` when it is non-zero, written as the fragment's
// depth. The derivatives of FragCoord.z are the triangle's exact depth slopes,
// and the sum is converted to the target format like rasterized depth, so a
// D16 atlas gets the executor's texels (W56 measured it against NVIDIA's).
// It is computed at the top of the entry point, before any discard.
function emulateDepthBias(
  module: SpirvModule,
  bias: DepthBiasInput,
  rewrites: Record<string, number>,
): void {
  const entry = module.instructions.find(
    (instruction) => instruction.op === "OpEntryPoint" && instruction.operands[0] === "Fragment",
  );

  if (entry === undefined) {
    return;
  }

  const main = idOf(entry.operands[1]);
  const build = new Builder(module);
  const glsl = glslImport(module);
  const float = build.float();
  const v4float = build.vector(float, 4);
  const zero = build.constant(float, 0);
  const one = build.constant(float, 1);
  const slope = build.constant(float, bias.slope);
  const offset = build.constant(float, bias.unit * bias.constant);
  let coord = module.instructions.find(
    (instruction) =>
      instruction.op === "OpDecorate" &&
      instruction.operands[1] === "BuiltIn" &&
      instruction.operands[2] === "FragCoord",
  )?.operands[0];

  if (coord === undefined) {
    const variable = module.fresh("bias");
    module.insertGlobals([
      {
        result: variable,
        op: "OpVariable",
        operands: [`%${build.pointer("Input", v4float)}`, "Input"],
      },
    ]);
    module.insertDecorations([
      { result: undefined, op: "OpDecorate", operands: [`%${variable}`, "BuiltIn", "FragCoord"] },
    ]);
    entry.operands.push(`%${variable}`);
    coord = `%${variable}`;
  }

  const depth = module.fresh("bias");
  module.insertGlobals([
    {
      result: depth,
      op: "OpVariable",
      operands: [`%${build.pointer("Output", float)}`, "Output"],
    },
  ]);
  module.insertDecorations([
    { result: undefined, op: "OpDecorate", operands: [`%${depth}`, "BuiltIn", "FragDepth"] },
  ]);
  entry.operands.push(`%${depth}`);
  const modeIndex = module.instructions.findIndex(
    (instruction) => instruction.op === "OpExecutionMode",
  );
  module.instructions.splice(modeIndex < 0 ? module.firstFunction() : modeIndex + 1, 0, {
    result: undefined,
    op: "OpExecutionMode",
    operands: [`%${main}`, "DepthReplacing"],
  });

  const start = module.instructions.findIndex(
    (instruction) => instruction.op === "OpFunction" && instruction.result === main,
  );
  let at = start + 1;

  while (
    module.instructions[at] !== undefined &&
    (module.instructions[at]?.op === "OpFunctionParameter" ||
      module.instructions[at]?.op === "OpLabel" ||
      module.instructions[at]?.op === "OpVariable")
  ) {
    at++;
  }

  const id = () => module.fresh("bias");
  const position = id();
  const z = id();
  const dx = id();
  const dy = id();
  const absX = id();
  const absY = id();
  const steepest = id();
  const scaled = id();
  const summed = id();
  let total = summed;
  const code: Instruction[] = [
    { result: position, op: "OpLoad", operands: [`%${v4float}`, coord] },
    { result: z, op: "OpCompositeExtract", operands: [`%${float}`, `%${position}`, "2"] },
    { result: dx, op: "OpDPdx", operands: [`%${float}`, `%${z}`] },
    { result: dy, op: "OpDPdy", operands: [`%${float}`, `%${z}`] },
    { result: absX, op: "OpExtInst", operands: [`%${float}`, `%${glsl}`, "FAbs", `%${dx}`] },
    { result: absY, op: "OpExtInst", operands: [`%${float}`, `%${glsl}`, "FAbs", `%${dy}`] },
    {
      result: steepest,
      op: "OpExtInst",
      operands: [`%${float}`, `%${glsl}`, "FMax", `%${absX}`, `%${absY}`],
    },
    { result: scaled, op: "OpFMul", operands: [`%${float}`, `%${steepest}`, `%${slope}`] },
    { result: summed, op: "OpFAdd", operands: [`%${float}`, `%${scaled}`, `%${offset}`] },
  ];

  if (bias.clamp !== 0) {
    total = id();
    code.push({
      result: total,
      op: "OpExtInst",
      operands: [
        `%${float}`,
        `%${glsl}`,
        bias.clamp > 0 ? "FMin" : "FMax",
        `%${summed}`,
        `%${build.constant(float, bias.clamp)}`,
      ],
    });
  }

  const biased = id();
  const clamped = id();
  code.push(
    { result: biased, op: "OpFAdd", operands: [`%${float}`, `%${z}`, `%${total}`] },
    {
      result: clamped,
      op: "OpExtInst",
      operands: [`%${float}`, `%${glsl}`, "FClamp", `%${biased}`, `%${zero}`, `%${one}`],
    },
    { result: undefined, op: "OpStore", operands: [`%${depth}`, `%${clamped}`] },
  );
  module.instructions.splice(at, 0, ...code);
  count(rewrites, "depth_bias_in_shader");
}

const sampleOps = new Set([
  "OpImageSampleImplicitLod",
  "OpImageSampleExplicitLod",
  "OpImageSampleDrefImplicitLod",
  "OpImageSampleDrefExplicitLod",
]);

// WebGPU has no border colour. A sample through a sampler that clamps to the
// executor's transparent black border reads zero when its coordinate leaves
// [0, 1] on a border axis. Linear filtering inside the last half texel still
// blends the edge texel instead of the border: an approximation.
function emulateBorder(
  module: SpirvModule,
  elements: Map<string, { source: string; element: number }>,
  descriptors: DescriptorInput[],
  rewrites: Record<string, number>,
): void {
  const types = new TypeTable(module);
  const build = new Builder(module);
  const snapshot = [...module.instructions];
  const output: Instruction[] = [];
  const borderOf = (variable: string): [boolean, boolean, boolean] | undefined => {
    const element = elements.get(variable)?.element ?? 0;
    const set = Number(module.decoration(variable, "DescriptorSet") ?? -1);
    const binding = Number(module.decoration(variable, "Binding") ?? -1);
    const descriptor = descriptors.find(
      (entry) => entry.set === set && entry.binding === binding && entry.arrayElement === element,
    );

    return descriptor?.border;
  };

  for (const instruction of snapshot) {
    const result = instruction.result;
    const sampled = sampleOps.has(instruction.op)
      ? types.definition(idOf(instruction.operands[1]))
      : undefined;
    const samplerLoad =
      sampled?.op === "OpSampledImage" ? types.definition(idOf(sampled.operands[2])) : undefined;
    const border =
      samplerLoad?.op === "OpLoad" ? borderOf(idOf(samplerLoad.operands[1])) : undefined;

    if (result === undefined || border === undefined || !border.some((axis) => axis)) {
      output.push(instruction);
      continue;
    }

    const coordinate = idOf(instruction.operands[2]);
    const coordinateDefinition = types.definition(coordinate);
    const coordinateType =
      coordinateDefinition === undefined ? undefined : types.resultType(coordinateDefinition);
    const shape = coordinateType === undefined ? undefined : types.type(coordinateType);
    const lanes = shape?.kind === "vector" ? shape.count : 1;
    const image = types.type(idOf(sampled?.operands[0]));
    const imageShape = image.kind === "sampledImage" ? types.type(image.image) : undefined;
    const dimension = imageShape?.kind === "image" ? imageShape.instruction.operands[1] : "2D";
    const spatial = Math.min(lanes, dimension === "3D" || dimension === "Cube" ? 3 : 2);
    const axes = [0, 1, 2].filter((axis) => axis < spatial && border[axis] === true);
    const float = build.float();
    const bool = build.bool();
    const zero = build.constant(float, 0);
    const one = build.constant(float, 1);
    const raw = module.fresh("border");
    output.push({ ...instruction, result: raw });
    let inside: string | undefined;

    for (const axis of axes) {
      const component = module.fresh("border");
      const low = module.fresh("border");
      const high = module.fresh("border");
      const both = module.fresh("border");
      output.push(
        lanes === 1
          ? { result: component, op: "OpCopyObject", operands: [`%${float}`, `%${coordinate}`] }
          : {
              result: component,
              op: "OpCompositeExtract",
              operands: [`%${float}`, `%${coordinate}`, String(axis)],
            },
        {
          result: low,
          op: "OpFOrdGreaterThanEqual",
          operands: [`%${bool}`, `%${component}`, `%${zero}`],
        },
        {
          result: high,
          op: "OpFOrdLessThanEqual",
          operands: [`%${bool}`, `%${component}`, `%${one}`],
        },
        { result: both, op: "OpLogicalAnd", operands: [`%${bool}`, `%${low}`, `%${high}`] },
      );

      if (inside === undefined) {
        inside = both;
      } else {
        const next = module.fresh("border");
        output.push({
          result: next,
          op: "OpLogicalAnd",
          operands: [`%${bool}`, `%${inside}`, `%${both}`],
        });
        inside = next;
      }
    }

    const resultType = instruction.operands[0] ?? "";
    const nothing = module.declare("OpConstantNull", [resultType]);
    const resultShape = types.type(idOf(resultType));
    let condition = inside ?? "";

    if (resultShape.kind === "vector") {
      condition = module.fresh("border");
      output.push({
        result: condition,
        op: "OpCompositeConstruct",
        operands: [
          `%${build.vector(bool, resultShape.count)}`,
          ...Array.from({ length: resultShape.count }, () => `%${inside ?? ""}`),
        ],
      });
    }

    output.push({
      result,
      op: "OpSelect",
      operands: [resultType, `%${condition}`, `%${raw}`, `%${nothing}`],
    });
    count(rewrites, "border_sample_select");
  }

  replaceInstructions(module, snapshot, output);
}

// Uniform and read-only storage blocks become word arrays; loads through them
// become word loads with bitcasts, so every member keeps its declared offset.
function flattenBlocks(
  module: SpirvModule,
  sizes: Map<string, number>,
  known: Map<string, Uint8Array>,
  rewrites: Record<string, number>,
): Map<string, number> {
  const types = new TypeTable(module);
  const build = new Builder(module);
  const all = variables(module, types);
  const written = new Set<string>();
  const blockIds = new Set(
    all.filter((v) => v.storage === "Uniform" || v.storage === "StorageBuffer").map((v) => v.id),
  );
  const pointers = new BlockPointers(types, blockIds);

  for (const instruction of module.instructions) {
    const writes =
      instruction.op === "OpStore" ||
      instruction.op.startsWith("OpAtomic") ||
      instruction.op === "OpCopyMemory";

    if (!writes) {
      continue;
    }

    const target =
      instruction.op === "OpStore" || instruction.op === "OpCopyMemory"
        ? instruction.operands[0]
        : instruction.operands[1];
    const resolved = target === undefined ? undefined : pointers.resolve(idOf(target));

    if (resolved !== undefined) {
      written.add(resolved.variable);
    }
  }

  const flattened = new Map<string, { storage: string; pointer: string }>();
  const declaredSizes = new Map<string, number>();
  const uint = build.uint();
  const v4uint = build.vector(uint, 4);
  const zero = build.uintConstant(0);

  for (const variable of all) {
    const isUniform = variable.storage === "Uniform";
    const isReadStorage = variable.storage === "StorageBuffer" && !written.has(variable.id);

    if (!isUniform && !isReadStorage) {
      continue;
    }

    const natural = types.byteSize(variable.pointee);
    const declared = Math.max(natural, sizes.get(variable.id) ?? 0);
    const definition = types.definition(variable.id);

    if (definition === undefined) {
      continue;
    }

    if (isUniform) {
      const vectors = Math.max(1, Math.ceil(declared / 16));
      const length = build.uintConstant(vectors);
      const array = module.fresh("words");
      const struct = module.fresh("block");
      module.insertGlobals([
        { result: array, op: "OpTypeArray", operands: [`%${v4uint}`, `%${length}`] },
        { result: struct, op: "OpTypeStruct", operands: [`%${array}`] },
      ]);
      module.insertDecorations([
        { result: undefined, op: "OpDecorate", operands: [`%${array}`, "ArrayStride", "16"] },
        { result: undefined, op: "OpDecorate", operands: [`%${struct}`, "Block"] },
        { result: undefined, op: "OpMemberDecorate", operands: [`%${struct}`, "0", "Offset", "0"] },
      ]);
      definition.operands[0] = `%${build.pointer("Uniform", struct)}`;
      flattened.set(variable.id, { storage: "Uniform", pointer: build.pointer("Uniform", uint) });
      declaredSizes.set(variable.id, vectors * 16);
    } else {
      const array = module.fresh("words");
      const struct = module.fresh("block");
      // Runtime-sized: a live buffer's size is known only to the executor.
      const words = Math.max(1, Math.ceil(declared / 4));
      module.insertGlobals([
        { result: array, op: "OpTypeRuntimeArray", operands: [`%${uint}`] },
        { result: struct, op: "OpTypeStruct", operands: [`%${array}`] },
      ]);
      module.insertDecorations([
        { result: undefined, op: "OpDecorate", operands: [`%${array}`, "ArrayStride", "4"] },
        { result: undefined, op: "OpDecorate", operands: [`%${struct}`, "Block"] },
        { result: undefined, op: "OpMemberDecorate", operands: [`%${struct}`, "0", "Offset", "0"] },
        { result: undefined, op: "OpMemberDecorate", operands: [`%${struct}`, "0", "NonWritable"] },
      ]);
      definition.operands[0] = `%${build.pointer("StorageBuffer", struct)}`;
      flattened.set(variable.id, {
        storage: "StorageBuffer",
        pointer: build.pointer("StorageBuffer", uint),
      });
      declaredSizes.set(variable.id, words * 4);
    }

    count(rewrites, isUniform ? "uniform_block_words" : "storage_block_words");
  }

  const output: Instruction[] = [];

  const emitOffset = (
    resolved: BlockPointer,
    extra: number,
  ): { constant?: number; id?: string } => {
    if (resolved.dynamic.length === 0) {
      return { constant: resolved.offset + extra };
    }

    let accumulator = build.uintConstant(resolved.offset + extra);

    for (const term of resolved.dynamic) {
      const indexDefinition = types.definition(term.index);
      const indexType =
        indexDefinition === undefined ? undefined : types.resultType(indexDefinition);
      const indexShape = indexType === undefined ? undefined : types.type(indexType);
      let index = term.index;

      if (indexShape?.kind === "int" && indexShape.signed) {
        const cast = module.fresh();
        output.push({ result: cast, op: "OpBitcast", operands: [`%${uint}`, `%${index}`] });
        index = cast;
      }

      const product = module.fresh();
      const sum = module.fresh();
      output.push(
        {
          result: product,
          op: "OpIMul",
          operands: [`%${uint}`, `%${index}`, `%${build.uintConstant(term.stride)}`],
        },
        { result: sum, op: "OpIAdd", operands: [`%${uint}`, `%${accumulator}`, `%${product}`] },
      );
      accumulator = sum;
    }

    return { id: accumulator };
  };

  const loadWord = (variable: string, resolved: BlockPointer, extra: number): string => {
    const target = flattened.get(variable);

    if (target === undefined) {
      throw new Error("Word load from a block that was not flattened");
    }

    const offset = emitOffset(resolved, extra);
    const pointer = module.fresh();
    const word = module.fresh();

    if (target.storage === "Uniform") {
      let vector: string;
      let component: string;

      if (offset.constant !== undefined) {
        vector = build.uintConstant(Math.floor(offset.constant / 16));
        component = build.uintConstant(Math.floor(offset.constant / 4) % 4);
      } else {
        vector = module.fresh();
        const words = module.fresh();
        component = module.fresh();
        output.push(
          {
            result: vector,
            op: "OpShiftRightLogical",
            operands: [`%${uint}`, `%${offset.id ?? ""}`, `%${build.uintConstant(4)}`],
          },
          {
            result: words,
            op: "OpShiftRightLogical",
            operands: [`%${uint}`, `%${offset.id ?? ""}`, `%${build.uintConstant(2)}`],
          },
          {
            result: component,
            op: "OpBitwiseAnd",
            operands: [`%${uint}`, `%${words}`, `%${build.uintConstant(3)}`],
          },
        );
      }

      output.push({
        result: pointer,
        op: "OpAccessChain",
        operands: [`%${target.pointer}`, `%${variable}`, `%${zero}`, `%${vector}`, `%${component}`],
      });
    } else {
      let index: string;

      if (offset.constant !== undefined) {
        index = build.uintConstant(Math.floor(offset.constant / 4));
      } else {
        index = module.fresh();
        output.push({
          result: index,
          op: "OpShiftRightLogical",
          operands: [`%${uint}`, `%${offset.id ?? ""}`, `%${build.uintConstant(2)}`],
        });
      }

      output.push({
        result: pointer,
        op: "OpAccessChain",
        operands: [`%${target.pointer}`, `%${variable}`, `%${zero}`, `%${index}`],
      });
    }

    output.push({ result: word, op: "OpLoad", operands: [`%${uint}`, `%${pointer}`] });

    return word;
  };

  const emitValue = (
    resolved: BlockPointer,
    type: string,
    extra: number,
    componentStride: number,
    matrix: { stride: number; rowMajor: boolean } | undefined,
    result?: string,
  ): string => {
    const shape: SpirvType = types.type(type);
    const target = result ?? module.fresh();

    switch (shape.kind) {
      case "int":
      case "float": {
        if (shape.width !== 32) {
          throw new Error("Only 32-bit block members are supported");
        }

        // A word of an immutable buffer at a constant offset is a constant:
        // the draw's specialization, as a driver would fold it.
        const contents = known.get(resolved.variable);
        let folded =
          contents !== undefined && resolved.dynamic.length === 0
            ? readWord(contents, resolved.offset + extra)
            : undefined;

        // WGSL rejects infinite and NaN constants, so those words stay loads.
        if (
          folded !== undefined &&
          shape.kind === "float" &&
          (folded & 0x7f800000) === 0x7f800000
        ) {
          folded = undefined;
        }

        let word: string;

        if (folded === undefined) {
          word = loadWord(resolved.variable, resolved, extra);
        } else {
          word = build.uintConstant(folded);
          count(rewrites, "immutable_word_folded");
        }

        if (shape.kind === "int" && !shape.signed) {
          output.push({ result: target, op: "OpCopyObject", operands: [`%${type}`, `%${word}`] });
        } else {
          output.push({ result: target, op: "OpBitcast", operands: [`%${type}`, `%${word}`] });
        }

        return target;
      }

      case "vector": {
        const parts = Array.from({ length: shape.count }, (_, component) =>
          emitValue(resolved, shape.component, extra + component * componentStride, 4, undefined),
        );
        output.push({
          result: target,
          op: "OpCompositeConstruct",
          operands: [`%${type}`, ...parts.map((part) => `%${part}`)],
        });

        return target;
      }

      case "matrix": {
        const layout = matrix ?? { stride: 16, rowMajor: false };
        const parts = Array.from({ length: shape.count }, (_, column) =>
          layout.rowMajor
            ? emitValue(resolved, shape.column, extra + column * 4, layout.stride, undefined)
            : emitValue(resolved, shape.column, extra + column * layout.stride, 4, undefined),
        );
        output.push({
          result: target,
          op: "OpCompositeConstruct",
          operands: [`%${type}`, ...parts.map((part) => `%${part}`)],
        });

        return target;
      }

      case "array": {
        const stride = shape.stride ?? types.byteSize(shape.element);
        const parts = Array.from({ length: shape.length }, (_, element) =>
          emitValue(resolved, shape.element, extra + element * stride, 4, matrix),
        );
        output.push({
          result: target,
          op: "OpCompositeConstruct",
          operands: [`%${type}`, ...parts.map((part) => `%${part}`)],
        });

        return target;
      }

      case "struct": {
        const parts = shape.members.map((member, index) =>
          emitValue(
            resolved,
            member,
            extra + types.memberOffset(type, index),
            4,
            types.matrixLayout(type, index),
          ),
        );
        output.push({
          result: target,
          op: "OpCompositeConstruct",
          operands: [`%${type}`, ...parts.map((part) => `%${part}`)],
        });

        return target;
      }

      default: {
        throw new Error(`Cannot load ${shape.kind} from a block`);
      }
    }
  };

  const snapshot = [...module.instructions];

  for (const instruction of snapshot) {
    const isChain =
      instruction.op === "OpAccessChain" || instruction.op === "OpInBoundsAccessChain";

    if (isChain && instruction.result !== undefined) {
      const resolved = pointers.resolve(instruction.result);

      if (resolved !== undefined && flattened.has(resolved.variable)) {
        continue;
      }
    }

    if (instruction.op === "OpLoad" && instruction.result !== undefined) {
      const resolved = pointers.resolve(idOf(instruction.operands[1]));

      if (resolved !== undefined && flattened.has(resolved.variable)) {
        emitValue(
          resolved,
          idOf(instruction.operands[0]),
          0,
          resolved.componentStride,
          resolved.matrix,
          instruction.result,
        );
        continue;
      }
    }

    for (const operand of instruction.operands) {
      if (
        !operand.startsWith("%") ||
        instruction.op === "OpEntryPoint" ||
        instruction.op.startsWith("OpDecorate")
      ) {
        continue;
      }

      const resolved = pointers.resolve(operand.slice(1));

      if (
        resolved !== undefined &&
        flattened.has(resolved.variable) &&
        instruction.op !== "OpVariable"
      ) {
        const isVariableItself =
          resolved.variable === operand.slice(1) && instruction.op === "OpName";

        if (!isVariableItself) {
          throw new Error(`${instruction.op} uses a pointer into a flattened block`);
        }
      }
    }

    output.push(instruction);
  }

  replaceInstructions(module, snapshot, output);

  return declaredSizes;
}

// The draw's rasterizer depth bias, applied in the fragment stage.
export interface DepthBiasInput {
  constant: number;
  clamp: number;
  slope: number;
  // The minimum resolvable difference r of the depth format (2^-16 for D16).
  unit: number;
}

export interface LowerInput {
  spirvText: string;
  descriptors: DescriptorInput[];
  depthBias?: DepthBiasInput | undefined;
}

const dimensionOf = (image: Instruction): NonNullable<ShaderResource["dimension"]> => {
  const dim = image.operands[1];
  const arrayed = image.operands[3] === "1";

  if (dim === "2D") {
    return arrayed ? "2d-array" : "2d";
  }

  if (dim === "Cube") {
    return arrayed ? "cube-array" : "cube";
  }

  if (dim === "3D") {
    return "3d";
  }

  throw new Error(`Unsupported image dimension ${String(dim)}`);
};

export function lowerStage(input: LowerInput): LoweredStage {
  const module = new SpirvModule(input.spirvText);
  const rewrites: Record<string, number> = {};
  const findDescriptor = (set: number, binding: number, element: number) =>
    input.descriptors.find(
      (descriptor) =>
        descriptor.set === set &&
        descriptor.binding === binding &&
        descriptor.arrayElement === element,
    );

  if (module.instructions.some((instruction) => storageIs(instruction, "PushConstant"))) {
    throw new Error("Push constants are not lowered yet");
  }

  if (module.instructions.some((instruction) => instruction.op === "OpImageRead")) {
    throw new Error("Storage image reads are not lowered yet");
  }

  lowerArithmetic(module, rewrites);

  let types = new TypeTable(module);
  const data = new Map<string, Uint8Array>();
  const fixed = new Map<string, IndexSource>();
  const sizes = new Map<string, number>();

  for (const variable of variables(module, types)) {
    const descriptor = findDescriptor(variable.set, variable.binding, 0);

    const buffer = variable.storage === "Uniform" || variable.storage === "StorageBuffer";

    if (descriptor?.data !== undefined && buffer) {
      if (descriptor.live === undefined || descriptor.live.length === 0) {
        data.set(variable.id, descriptor.data);
      } else {
        const contents = descriptor.data.slice();
        liveWords.set(contents, descriptor.live);
        data.set(variable.id, contents);
        count(rewrites, "camera_live_buffer");
      }
    }

    if (descriptor?.fixed !== undefined && buffer) {
      fixed.set(variable.id, descriptor.fixed);
    }

    if (descriptor?.bytes !== undefined) {
      sizes.set(variable.id, descriptor.bytes);
    }
  }

  const elements = specializeBindless(module, data, fixed, input.descriptors, rewrites);
  resolveImageDepth(module, rewrites);
  emulateQueryLod(module, rewrites);
  emulateBorder(module, elements, input.descriptors, rewrites);

  if (input.depthBias !== undefined) {
    emulateDepthBias(module, input.depthBias, rewrites);
  }

  const declaredSizes = flattenBlocks(module, sizes, data, rewrites);

  types = new TypeTable(module);
  const resources: ShaderResource[] = [];
  const keyed = new Map<string, string[]>();

  for (const variable of variables(module, types)) {
    const element = elements.get(variable.id)?.element ?? 0;
    const pointee = types.type(variable.pointee);
    let resource: ShaderResource;

    if (variable.storage === "Uniform" || variable.storage === "StorageBuffer") {
      const size = declaredSizes.get(variable.id);
      const kind = variable.storage === "Uniform" ? "uniform" : "storage";
      const readOnly = kind === "uniform" || size !== undefined;
      resource = {
        key: `buffer:${variable.set}:${variable.binding}`,
        kind,
        set: variable.set,
        binding: variable.binding,
        element: 0,
        readOnly,
        ...(size === undefined ? {} : { size }),
      };
    } else if (pointee.kind === "image") {
      const storage = pointee.instruction.operands[5] === "2";

      if (storage) {
        resource = {
          key: `storage-texture:${variable.set}:${variable.binding}:${element}`,
          kind: "storageTexture",
          set: variable.set,
          binding: variable.binding,
          element,
          dimension: dimensionOf(pointee.instruction),
          format: pointee.instruction.operands[6] ?? "",
        };
      } else {
        const depth = pointee.instruction.operands[2] === "1";
        resource = {
          key: `texture:${variable.set}:${variable.binding}:${element}:${dimensionOf(pointee.instruction) ?? ""}:${depth ? "depth" : "float"}`,
          kind: "texture",
          set: variable.set,
          binding: variable.binding,
          element,
          dimension: dimensionOf(pointee.instruction),
          depth,
        };
      }
    } else if (pointee.kind === "sampler") {
      const descriptor = findDescriptor(variable.set, variable.binding, element);
      resource = {
        key: `sampler:${variable.set}:${variable.binding}:${element}`,
        kind: "sampler",
        set: variable.set,
        binding: variable.binding,
        element,
        comparison: descriptor?.compare !== undefined,
      };
    } else {
      throw new Error(`Unsupported resource variable %${variable.id} (${pointee.kind})`);
    }

    const ids = keyed.get(resource.key) ?? [];

    if (ids.length === 0) {
      resources.push(resource);
    }

    ids.push(variable.id);
    keyed.set(resource.key, ids);
  }

  // Two variables of one resource (aliases of the same element) share the
  // first one's variable when their types agree.
  const merges = new Map<string, string>();

  for (const ids of keyed.values()) {
    const [first, ...rest] = ids;

    for (const id of rest) {
      const a = types.definition(first ?? "")?.operands[0];
      const b = types.definition(id)?.operands[0];

      if (a !== b) {
        throw new Error("Aliased variables of one resource have different types");
      }

      merges.set(id, first ?? "");
    }
  }

  if (merges.size > 0) {
    module.instructions = module.instructions.filter(
      (instruction) =>
        !(instruction.result !== undefined && merges.has(instruction.result)) &&
        !(instruction.op === "OpDecorate" && merges.has(idOf(instruction.operands[0]))),
    );
    module.substitute(merges);

    for (const instruction of module.instructions) {
      if (instruction.op === "OpEntryPoint") {
        instruction.operands = [...new Set(instruction.operands)];
      }
    }

    for (const [key, ids] of keyed) {
      keyed.set(key, [ids[0] ?? ""]);
    }
  }

  return { module, resources, variables: keyed, rewrites };
}

function storageIs(instruction: Instruction, storage: string): boolean {
  return instruction.op === "OpVariable" && instruction.operands[1] === storage;
}

// Rewrites every resource to group 0 at the binding the draw's layout gives
// its key, so both stages of a draw agree on one bind group.
export function assignBindings(stage: LoweredStage, bindings: Map<string, number>): string {
  const module = stage.module;
  const targets = new Map<string, number>();

  for (const [key, ids] of stage.variables) {
    const binding = bindings.get(key);

    if (binding === undefined) {
      throw new Error(`No binding for ${key}`);
    }

    for (const id of ids) {
      targets.set(id, binding);
    }
  }

  module.instructions = module.instructions.filter((instruction) => {
    if (instruction.op !== "OpDecorate") {
      return true;
    }

    const id = idOf(instruction.operands[0]);
    const decoration = instruction.operands[1];

    return !(targets.has(id) && (decoration === "DescriptorSet" || decoration === "Binding"));
  });

  const decorations: Instruction[] = [];

  for (const [id, binding] of targets) {
    decorations.push(
      { result: undefined, op: "OpDecorate", operands: [`%${id}`, "DescriptorSet", "0"] },
      { result: undefined, op: "OpDecorate", operands: [`%${id}`, "Binding", String(binding)] },
    );
  }

  module.insertDecorations(decorations);
  module.removeUnusedGlobals();
  module.sortGlobals();

  return module.text();
}
