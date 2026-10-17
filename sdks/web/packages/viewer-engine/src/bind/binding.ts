// Request binding: an item package's binding programs plus a request's inspect
// attributes give the uniform updates of that request. This is the executor's
// binder (native src/bind/binding.cpp, ported from materials/bind.mjs) in
// TypeScript, so the engine changes seed, wear, sticker placement and the
// StatTrak counter of a loaded item without the server. The program format is
// in tools/standalone-renderer/writeups/BINDING-CATALOG-2026-10-15.md and the
// acceptance vectors in tools/standalone-renderer/native/tests/data/bind-vectors.json.

import { randomStream } from "./random.ts";
import { decodeBase64, encodeBase64, evaluateVfxExpression, type TextureSource } from "./vfx.ts";

export type BindErrorCode = "invalid_item_data" | "unsupported_binding";

// A rejected request, with the attribute that caused it.
export class BindError extends Error {
  readonly code: BindErrorCode;

  readonly attribute: string;

  constructor(code: BindErrorCode, attribute: string, message: string) {
    super(message);
    this.name = "BindError";
    this.code = code;
    this.attribute = attribute;
  }
}

export interface UniformUpdate {
  key: string;
  // Base64 of the buffer's bytes, as the executor's uniformUpdates carry them.
  bytes: string;
}

// The part of an item package manifest the binder reads.
export interface BindingSlice {
  version?: unknown;
  item?: unknown;
  paint?: { binding?: unknown };
  surface?: { binding?: unknown };
  stattrak?: { binding?: unknown };
}

// The inspect fields that change pixels; every other field is identity only.
const boundAttributes = ["paintseed", "paintwear", "stickers", "keychains", "killeatervalue"];
const placementFields = ["offset_x", "offset_y", "rotation", "wear", "scale"];
const f = Math.fround;

type Json = unknown;

function member(value: Json, key: string): Json {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  return (value as Record<string, Json>)[key];
}

function array(value: Json): Json[] {
  return Array.isArray(value) ? (value as Json[]) : [];
}

function numberAt(value: Json, index: number): number {
  return Number(array(value)[index]);
}

function isObject(value: Json): value is Record<string, Json> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Sorted-key JSON, identical to the executor's canonical() and identity.ts.
export function canonical(value: Json): string {
  if (Array.isArray(value)) {
    return `[${(value as Json[]).map(canonical).join(",")}]`;
  }

  if (isObject(value)) {
    const fields = Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key] ?? null)}`);

    return `{${fields.join(",")}}`;
  }

  return JSON.stringify(value ?? null);
}

function normalized(value: Json): Json {
  if (value === undefined || value === null) {
    return null;
  }

  if (Array.isArray(value) && value.length === 0) {
    return null;
  }

  return value;
}

function sameAttribute(left: Json, right: Json): boolean {
  return canonical(normalized(left)) === canonical(normalized(right));
}

const wearView = new DataView(new ArrayBuffer(4));

// The float32 bit pattern of a wear value, as inspect data carries it.
export function wearBits(wear: number): number {
  wearView.setFloat32(0, wear, true);

  return wearView.getUint32(0, true);
}

// paintwear is the float32 bit pattern as an unsigned integer, never a float.
export function wearFromBits(bits: Json): number {
  const valid = Number.isInteger(bits) && (bits as number) >= 0 && (bits as number) <= 0xffffffff;

  if (!valid) {
    throw new BindError(
      "invalid_item_data",
      "paintwear",
      `paintwear must be the uint32 bit pattern of a float32, not ${canonical(bits)}`,
    );
  }

  wearView.setUint32(0, bits as number, true);
  const wear = wearView.getFloat32(0, true);

  if (!Number.isFinite(wear) || wear < 0 || wear > 1) {
    throw new BindError(
      "invalid_item_data",
      "paintwear",
      `paintwear bits ${String(bits)} decode to ${wear}, outside the finite range [0, 1]`,
    );
  }

  return wear;
}

// The alternate stream seeds with paintseed + 1, which must stay a valid seed.
function validateSeed(seed: Json): number {
  const valid = Number.isInteger(seed) && (seed as number) >= 0 && (seed as number) <= 2147483646;

  if (!valid) {
    throw new BindError(
      "invalid_item_data",
      "paintseed",
      `paintseed must be an integer from 0 to 2147483646, not ${canonical(seed)}`,
    );
  }

  return seed as number;
}

class PlacementError extends Error {}

function stickerFloat(source: Json, name: string, fallback: number): number {
  const given = member(source, name);

  if (given === undefined || given === null) {
    return f(fallback);
  }

  const valid = typeof given === "number" && Number.isFinite(given) && Number.isFinite(f(given));

  if (!valid) {
    throw new PlacementError(`Invalid sticker ${name}: ${canonical(given)}`);
  }

  return f(given);
}

// The per-slot material attributes the original weapon shader reads for one
// inspect sticker. Model Rotation is already in turns; the client rounds the
// inspect degree conversion before adding the authored base rotation. Scale is
// checked but the pinned icon path ignores it.
function placementAttributes(sticker: Json, anchor: Json, index: number): Record<string, Json> {
  const wear = stickerFloat(sticker, "wear", 0);

  if (wear < 0 || wear > 1) {
    throw new PlacementError(`Sticker wear must be in [0, 1]: ${wear}`);
  }

  stickerFloat(sticker, "scale", 1);
  const offset = member(anchor, "Offset");
  const offsetX = f(f(numberAt(offset, 0)) + stickerFloat(sticker, "offset_x", 0));
  const offsetY = f(f(numberAt(offset, 1)) + stickerFloat(sticker, "offset_y", 0));
  const inspectRotation = f(stickerFloat(sticker, "rotation", 0) * f(1 / 360));
  const anchorScale = f(Number(member(anchor, "Scale")));

  return {
    [`Sticker${index}Offset`]: [offsetX, offsetY],
    [`Sticker${index}Scale`]: [anchorScale, anchorScale],
    [`Sticker${index}Rotation`]: f(inspectRotation + stickerFloat(anchor, "Rotation", 0)),
    [`Sticker${index}Wear`]: wear,
  };
}

// The kill counter: an integer from 0 to 999999 with score type 0.
function validateCounter(value: Json): number {
  const valid = Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 999999;

  if (!valid) {
    throw new BindError(
      "invalid_item_data",
      "killeatervalue",
      "killeatervalue must be an integer from 0 to 999999",
    );
  }

  return value as number;
}

function present(value: Json): boolean {
  return value !== undefined && value !== null;
}

function validateItemData(itemData: Json): void {
  if (!isObject(itemData)) {
    throw new BindError("invalid_item_data", "item_data", "item_data must be an object");
  }

  if (present(itemData.killeatervalue)) {
    validateCounter(itemData.killeatervalue);
    const type = itemData.killeaterscoretype;

    if (present(type) && type !== 0) {
      throw new BindError(
        "invalid_item_data",
        "killeaterscoretype",
        "killeaterscoretype must be 0 (kills)",
      );
    }
  }

  if (present(itemData.paintwear)) {
    wearFromBits(itemData.paintwear);
  }

  if (present(itemData.paintseed)) {
    validateSeed(itemData.paintseed);
  }

  const stickers = itemData.stickers;

  if (!present(stickers)) {
    return;
  }

  if (!Array.isArray(stickers)) {
    throw new BindError("invalid_item_data", "stickers", "stickers must be an array");
  }

  const anchor = { Offset: [0, 0], Scale: 1, Rotation: 0 };

  for (const sticker of stickers as Json[]) {
    if (!isObject(sticker)) {
      throw new BindError("invalid_item_data", "stickers", "every sticker must be an object");
    }

    try {
      placementAttributes(sticker, anchor, 0);
    } catch (error) {
      if (error instanceof PlacementError) {
        throw new BindError("invalid_item_data", "stickers", error.message);
      }

      throw error;
    }
  }
}

function stickerIdentity(sticker: Json): string {
  if (!isObject(sticker)) {
    return canonical(sticker);
  }

  const identity = { ...sticker };

  for (const field of placementFields) {
    delete identity[field];
  }

  return canonical(identity);
}

// Kits, inspect slots and every non-placement field are package identity;
// only offset_x, offset_y, rotation, wear and scale may differ.
function sameStickerIdentity(left: Json, right: Json): boolean {
  const leftList = normalized(left) ?? [];
  const rightList = normalized(right) ?? [];

  if (!Array.isArray(leftList) || !Array.isArray(rightList)) {
    return false;
  }

  if (leftList.length !== rightList.length) {
    return false;
  }

  return (leftList as Json[]).every(
    (sticker, index) => stickerIdentity(sticker) === stickerIdentity((rightList as Json[])[index]),
  );
}

interface PaintContext {
  seed: number;
  wear: number;
  rolls: number[][];
}

function sourceValue(source: Json, context: PaintContext): number {
  const kind = member(source, "kind");

  if (kind === "roll") {
    const stream = Number(member(source, "stream"));
    const roll = Number(member(source, "roll"));
    const value = context.rolls[stream]?.[roll];

    if (value === undefined) {
      throw new Error(`Binding names a missing roll ${stream}/${roll}`);
    }

    return value;
  }

  if (kind === "wear") {
    return context.wear;
  }

  if (kind === "seed") {
    return context.seed;
  }

  if (kind === "seedAlt") {
    return (context.seed + 1) | 0;
  }

  throw new Error(`Unsupported binding source: ${canonical(kind)}`);
}

function rollStreams(streams: Json, seed: number): number[][] {
  return array(streams).map((stream) => {
    const random = randomStream(member(stream, "seedInput") === "seedAlt" ? (seed + 1) | 0 : seed);

    // Discarded variables still consume their roll, so every bound is replayed.
    return array(member(stream, "rolls")).map((roll) =>
      random(numberAt(roll, 0), numberAt(roll, 1)),
    );
  });
}

function boundedInput(parameter: Json, context: PaintContext): Json {
  const value = member(parameter, "value");
  const scalar = !Array.isArray(value);
  const components: Json[] = scalar ? [value] : [...(value as Json[])];

  for (const entry of array(member(parameter, "components"))) {
    const index = member(entry, "index");
    const position = index === undefined || index === null ? 0 : Number(index);

    while (components.length <= position) {
      components.push(null);
    }

    components[position] = sourceValue(member(entry, "source"), context);
  }

  const bounds = member(parameter, "bounds");
  const values = isObject(bounds)
    ? components.map((raw, index) => {
        const numeric = bounds.float === true ? f(Number(raw)) : Number(raw);

        return Math.max(
          numberAt(bounds.minimum, index),
          Math.min(numberAt(bounds.maximum, index), numeric),
        );
      })
    : components;

  return scalar ? values[0] : values;
}

function componentsOf(value: Json): number[] {
  if (Array.isArray(value)) {
    return (value as Json[]).map((entry) => (typeof entry === "number" ? entry : NaN));
  }

  return [Number(value ?? 0)];
}

function writeVariable(bytes: Uint8Array, write: Json, components: number[]): void {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = Number(member(write, "count"));
  const matrix = member(write, "matrix") === true;
  const offset = Number(member(write, "offset"));
  const name = String(member(write, "name") ?? "");

  for (let index = 0; index < count; index++) {
    // Float4x4 values are column-major; the Vulkan block is RowMajor.
    const source = matrix ? (index % 4) * 4 + Math.floor(index / 4) : index;
    const component = components[source] ?? NaN;
    const target = offset + index * 4;

    if (!Number.isFinite(component)) {
      throw new Error(`Bound uniform ${name}[${index}] is not finite`);
    }

    if (target + 4 > bytes.length) {
      throw new Error(`Bound uniform ${name} is outside its buffer`);
    }

    if (member(write, "register") === "Float4") {
      view.setFloat32(target, component, true);
      continue;
    }

    if (!Number.isInteger(component)) {
      throw new Error(`Bound uniform ${name} requires an integer`);
    }

    if (component < -2147483648 || component > 2147483647) {
      throw new Error(`Bound uniform ${name} is outside int32`);
    }

    view.setInt32(target, component, true);
  }
}

function features(program: Json): number[] {
  return array(member(program, "features")).map(Number);
}

function textureKey(source: TextureSource): string {
  return typeof source === "string" ? source : `generated:${canonical(source.generatedTexture)}`;
}

function objectOf(value: Json): Record<string, Json> {
  return isObject(value) ? { ...value } : {};
}

function readsOf(write: Json, from: Record<string, Json>): Record<string, Json> {
  const parameters: Record<string, Json> = {};

  for (const name of array(member(write, "reads"))) {
    parameters[String(name)] = from[String(name)];
  }

  return parameters;
}

function expressionOf(write: Json): string | undefined {
  const expression = member(write, "expression");

  return typeof expression === "string" && expression !== "" ? expression : undefined;
}

function shaderTime(source: Json): number | undefined {
  const time = member(source, "shaderTimeSeconds");

  return typeof time === "number" ? time : undefined;
}

function bindPaintProgram(program: Json, context: PaintContext): Uint8Array {
  const inputs = objectOf(member(program, "inputs"));

  for (const parameter of array(member(program, "parameters"))) {
    inputs[String(member(parameter, "name"))] = boundedInput(parameter, context);
  }

  const bytes = decodeBase64(String(member(program, "baseline")));
  const textures = member(program, "textures");

  for (const write of array(member(program, "writes"))) {
    const expression = expressionOf(write);

    if (expression === undefined) {
      writeVariable(bytes, write, componentsOf(inputs[String(member(write, "name"))]));
      continue;
    }

    const result = evaluateVfxExpression(expression, {
      parameters: readsOf(write, inputs),
      features: features(program),
      textureReflectivity: (source) => {
        const reflectivity = member(textures, textureKey(source));

        return reflectivity === undefined || reflectivity === null
          ? undefined
          : componentsOf(reflectivity);
      },
    });
    writeVariable(bytes, write, result);
  }

  return bytes;
}

function bindStickerProgram(program: Json, placement: Record<string, Json>): Uint8Array {
  const attributes = { ...objectOf(member(program, "attributes")), ...placement };
  const bytes = decodeBase64(String(member(program, "baseline")));

  for (const write of array(member(program, "writes"))) {
    const expression = expressionOf(write);

    if (expression === undefined) {
      const attribute = member(write, "attribute");
      writeVariable(
        bytes,
        write,
        componentsOf(attributes[typeof attribute === "string" ? attribute : ""]),
      );
      continue;
    }

    const result = evaluateVfxExpression(expression, {
      parameters: readsOf(write, objectOf(member(program, "inputs"))),
      features: features(program),
      attributes,
      shaderTimeSeconds: shaderTime(program),
    });
    writeVariable(bytes, write, result);
  }

  return bytes;
}

function bindCounterProgram(program: Json, counter: number): Uint8Array {
  const bytes = decodeBase64(String(member(program, "baseline")));

  for (const write of array(member(program, "writes"))) {
    const attributes = objectOf(member(write, "attributes"));
    attributes.$ent_stattrak = counter;
    const expression = expressionOf(write);

    if (expression === undefined) {
      const attribute = member(write, "attribute");
      writeVariable(
        bytes,
        write,
        componentsOf(attributes[typeof attribute === "string" ? attribute : ""]),
      );
      continue;
    }

    const result = evaluateVfxExpression(expression, {
      parameters: objectOf(member(write, "parameters")),
      features: features(write),
      attributes,
      shaderTimeSeconds: shaderTime(write),
    });
    writeVariable(bytes, write, result);
  }

  return bytes;
}

function requireSupport(binding: Json, name: string, noProgram: string, prefix: string): void {
  const support = member(member(binding, "attributes"), name);

  if (support !== "bound") {
    const reason = typeof support === "string" ? support : noProgram;

    throw new BindError("unsupported_binding", name, `${prefix}${reason}`);
  }
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function changed(program: Json, bytes: Uint8Array, updates: UniformUpdate[]): void {
  if (!sameBytes(bytes, decodeBase64(String(member(program, "baseline"))))) {
    updates.push({ key: String(member(program, "key")), bytes: encodeBase64(bytes) });
  }
}

// The part of a package manifest binding reads.
export function bindingSlice(manifest: Json): BindingSlice {
  const slice: BindingSlice = {};

  if (!isObject(manifest)) {
    return slice;
  }

  slice.version = manifest.version;
  slice.item = manifest.item;

  for (const key of ["paint", "surface", "stattrak"] as const) {
    if (isObject(manifest[key])) {
      slice[key] = { binding: member(manifest[key], "binding") };
    }
  }

  return slice;
}

// bindRequest(package, itemData): the uniform updates of a request, paint keys
// in program order, then sticker keys, then counter keys, each only when its
// bytes differ from the package baseline. Throws BindError for a rejected
// request and Error for a malformed package.
export function bindRequest(
  slice: BindingSlice,
  itemData: Record<string, unknown>,
): UniformUpdate[] {
  validateItemData(itemData);

  if (slice.version !== 2 || !present(slice.item)) {
    throw new Error("Request binding requires an item package version 2 manifest");
  }

  const baseline = member(slice.item, "attributes");
  const differing = boundAttributes.filter(
    (name) => !sameAttribute(itemData[name], member(baseline, name)),
  );

  if (differing.length === 0) {
    return [];
  }

  const paintBinding = slice.paint?.binding;
  const surfaceBinding = slice.surface?.binding;
  const counterBinding = slice.stattrak?.binding;
  let paintDiffers = false;
  let counterDiffers = false;

  for (const name of differing) {
    if (name === "stickers") {
      if (!sameStickerIdentity(itemData.stickers, member(baseline, "stickers"))) {
        throw new BindError(
          "unsupported_binding",
          name,
          "Item package cannot bind stickers: a different sticker kit, slot or count is a different package",
        );
      }

      requireSupport(
        surfaceBinding,
        name,
        "the package has no sticker binding program",
        "Item package cannot bind sticker placement: ",
      );
      continue;
    }

    const counterBound =
      name === "killeatervalue" &&
      member(member(counterBinding, "attributes"), "killeatervalue") === "bound";

    if (counterBound) {
      if (!present(itemData.killeatervalue)) {
        throw new BindError(
          "unsupported_binding",
          name,
          "Item package cannot bind killeatervalue: the linked item has a StatTrak module and the request has no counter",
        );
      }

      counterDiffers = true;
      continue;
    }

    if (name !== "paintseed" && name !== "paintwear") {
      throw new BindError(
        "unsupported_binding",
        name,
        `Item package cannot bind ${name}: it changes geometry or materials baked into the package; publish a package with these attributes`,
      );
    }

    requireSupport(
      paintBinding,
      name,
      "the package has no binding program",
      `Item package cannot bind ${name}: `,
    );
    paintDiffers = true;
  }

  const updates: UniformUpdate[] = [];

  if (paintDiffers) {
    const seed = validateSeed(itemData.paintseed ?? member(baseline, "paintseed"));
    const context: PaintContext = {
      seed,
      wear: wearFromBits(itemData.paintwear ?? member(baseline, "paintwear")),
      rolls: rollStreams(member(paintBinding, "streams"), seed),
    };

    for (const program of array(member(paintBinding, "programs"))) {
      changed(program, bindPaintProgram(program, context), updates);
    }
  }

  if (differing.includes("stickers")) {
    const stickers = itemData.stickers;
    const placement: Record<string, Json> = {};

    for (const slot of array(member(surfaceBinding, "slots"))) {
      const index = Number(member(slot, "index"));
      const sticker = Array.isArray(stickers) ? (stickers as Json[])[index] : undefined;

      try {
        Object.assign(placement, placementAttributes(sticker, member(slot, "markup"), index));
      } catch (error) {
        throw new Error((error as Error).message);
      }
    }

    for (const program of array(member(surfaceBinding, "programs"))) {
      changed(program, bindStickerProgram(program, placement), updates);
    }
  }

  if (counterDiffers) {
    const counter = validateCounter(itemData.killeatervalue);

    for (const program of array(member(counterBinding, "programs"))) {
      changed(program, bindCounterProgram(program, counter), updates);
    }
  }

  return updates;
}

// The byte ranges request binding can write in each mutable buffer: the union of every paint,
// sticker and counter program's writes by key. Bytes outside them keep the package baseline
// whatever the request, which lets the translator resolve the bindless texture slots that the
// sticker block holds next to the placement values.
export function mutableWrites(slice: BindingSlice): Map<string, Array<[number, number]>> {
  const ranges = new Map<string, Array<[number, number]>>();

  for (const block of [slice.paint, slice.surface, slice.stattrak]) {
    for (const program of array(member(block?.binding, "programs"))) {
      const key = String(member(program, "key"));
      const list = ranges.get(key) ?? [];

      for (const write of array(member(program, "writes"))) {
        const offset = Number(member(write, "offset"));
        const count = Number(member(write, "count"));
        list.push([offset, offset + count * 4]);
      }

      ranges.set(key, list);
    }
  }

  for (const [key, list] of ranges) {
    ranges.set(
      key,
      [...list].sort((left, right) => left[0] - right[0] || left[1] - right[1]),
    );
  }

  return ranges;
}
