// The VFX expression evaluator of the executor's request binder (native
// src/bind/vfx.cpp, ported from lib/vfx-expression.mjs and lib/vfx-matrix.mjs):
// the original VCS 72 paint expression subset as a stack machine of float32
// 4-vectors and 4x4 matrices, MurmurHash2 name tokens, and the
// MatrixColorTint2 and MatrixColorCorrect2 intrinsics with their DPPS
// summation order. Unsupported operations fail; this is not an evaluator for
// arbitrary material families.

import { cosf, powfPositive, sinf } from "./float-math.ts";

const f = Math.fround;

export function decodeBase64(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes;
}

export function encodeBase64(bytes: Uint8Array): string {
  let binary = "";

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary);
}

// Source 2 string tokens: case-folded UTF-8 MurmurHash2 with seed 0x31415926.
export function vfxToken(name: string): number {
  const bytes = new TextEncoder().encode(name.replace(/[A-Z]/g, (letter) => letter.toLowerCase()));

  if (bytes.length === 0) {
    return 0;
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let hash = 0x31415926 ^ bytes.length;
  let offset = 0;

  for (; offset + 4 <= bytes.length; offset += 4) {
    let block = Math.imul(view.getUint32(offset, true), 0x5bd1e995);
    block ^= block >>> 24;
    block = Math.imul(block, 0x5bd1e995);
    hash = Math.imul(hash, 0x5bd1e995) ^ block;
  }

  if (offset < bytes.length) {
    let tail = 0;

    for (let index = bytes.length - 1; index >= offset; index--) {
      tail = (tail << 8) | (bytes[index] ?? 0);
    }

    hash = Math.imul(hash ^ tail, 0x5bd1e995);
  }

  hash ^= hash >>> 13;
  hash = Math.imul(hash, 0x5bd1e995);

  return (hash ^ (hash >>> 15)) >>> 0;
}

const component = (values: readonly number[], index: number): number => values[index] ?? NaN;

// Original libmaterialsystem2.so 0x17e970 uses DPPS, whose sum is
// (x+y)+(z+w), with a float32 rounding after each product and addition.
export function multiplyVfxMatrices(left: readonly number[], right: readonly number[]): number[] {
  return Array.from({ length: 16 }, (_, index) => {
    const row = index & ~3;
    const column = index & 3;
    const products = Array.from({ length: 4 }, (_unused, inner) =>
      f(component(left, row + inner) * component(right, inner * 4 + column)),
    );

    return f(
      f(component(products, 0) + component(products, 1)) +
        f(component(products, 2) + component(products, 3)),
    );
  });
}

const scale = (x: number, y: number, z: number): number[] => [
  x,
  0,
  0,
  0,
  0,
  y,
  0,
  0,
  0,
  0,
  z,
  0,
  0,
  0,
  0,
  1,
];
const translate = (x: number, y: number, z: number): number[] => [
  1,
  0,
  0,
  x,
  0,
  1,
  0,
  y,
  0,
  0,
  1,
  z,
  0,
  0,
  0,
  1,
];

// The original intrinsic's constant tables, not material inputs. The compiled
// green coefficient keeps its one-ULP difference from the rotation.
const luminance = scale(0.2834210693836212, 0.9541620016098022, 0.09616310149431229);
const inverseLuminance = scale(3.5283191204071045, 1.0480400323867798, 10.398999214172363);
const rotation = [
  0.9267194867134094, -0.24670566618442535, -0.2834210693836212, 0, -0.24670566618442535,
  0.16944372653961182, -0.954162061214447, 0, 0.2834210693836212, 0.954162061214447,
  0.09616310149431229, 0, 0, 0, 0, 1,
];
const inverseRotation = Array.from({ length: 16 }, (_, index) =>
  component(rotation, (index % 4) * 4 + Math.floor(index / 4)),
);

// Original MatrixColorTint2, numerical body 0x17f250. Its matrix-vector
// transform uses scalar left-associated adds; its matrix products use DPPS.
export function matrixColorTint2(rgb: readonly number[], strength: number): number[] {
  const color = rgb.slice(0, 3).map(f);
  const maximum = Math.max(...color);
  const saturation = maximum === 0 ? 0 : f(f(maximum - Math.min(...color)) / maximum);
  const rotated = multiplyVfxMatrices(rotation, luminance);
  const gray = Array.from({ length: 3 }, (_, index) => {
    const offset = index * 4;

    return f(
      f(
        f(
          f(component(rotated, offset) * component(color, 0)) +
            f(component(rotated, offset + 1) * component(color, 1)),
        ) + f(component(rotated, offset + 2) * component(color, 2)),
      ) + component(rotated, offset + 3),
    );
  });
  const [grayX, grayY, grayZ] = [component(gray, 0), component(gray, 1), component(gray, 2)];
  const xy = f(1 - saturation);
  const z = f(1 - f(f(saturation * saturation) * f(strength)));
  let result = multiplyVfxMatrices(inverseLuminance, inverseRotation);
  result = multiplyVfxMatrices(result, translate(grayX, grayY, f(f(1 - z) * grayZ)));
  result = multiplyVfxMatrices(result, scale(xy, xy, z));
  result = multiplyVfxMatrices(result, translate(-grayX, -grayY, 0));
  result = multiplyVfxMatrices(result, rotation);

  return multiplyVfxMatrices(result, luminance);
}

// Original MatrixColorCorrect2, numerical body 0x17eb50. Matrix order and
// intermediate rounding matter even for neutral artist defaults.
export function matrixColorCorrect2(csb: readonly number[], offset: readonly number[]): number[] {
  const contrast = f(component(csb, 0));
  const saturation = f(component(csb, 1));
  const brightness = f(component(csb, 2));
  const pivot = [f(component(offset, 0)), f(component(offset, 1)), f(component(offset, 2))];
  const [pivotX, pivotY, pivotZ] = [component(pivot, 0), component(pivot, 1), component(pivot, 2)];
  let contrastMatrix = multiplyVfxMatrices(
    translate(pivotX, pivotY, pivotZ),
    scale(contrast, contrast, contrast),
  );
  contrastMatrix = multiplyVfxMatrices(contrastMatrix, translate(-pivotX, -pivotY, -pivotZ));
  let result = multiplyVfxMatrices(inverseLuminance, inverseRotation);
  result = multiplyVfxMatrices(result, scale(saturation, saturation, 1));
  result = multiplyVfxMatrices(result, rotation);
  result = multiplyVfxMatrices(result, luminance);
  result = multiplyVfxMatrices(result, scale(brightness, brightness, brightness));

  return multiplyVfxMatrices(result, contrastMatrix);
}

// A generated paint texture by pass index, or an original one by name.
export type TextureSource = string | { generatedTexture: number };

export type VfxValue = number | number[] | TextureSource | null | undefined;

export interface VfxContext {
  parameters?: Record<string, unknown>;
  features?: readonly number[];
  attributes?: Record<string, unknown>;
  // Reflectivity [r, g, b, a] of a texture, or undefined.
  textureReflectivity?: (source: TextureSource) => readonly number[] | undefined;
  shaderTimeSeconds?: number | undefined;
}

type Register = number[] | { texture: TextureSource };

function vector(value: unknown): number[] {
  if (typeof value === "number") {
    return Array<number>(4).fill(f(value));
  }

  if (!Array.isArray(value) || value.length < 1 || value.length > 4) {
    throw new Error("VFX input must be a scalar or a vector with one to four components");
  }

  const numbers = value as unknown[];

  if (numbers.length === 1) {
    return Array<number>(4).fill(f(Number(numbers[0])));
  }

  return Array.from({ length: 4 }, (_, index) => f(Number(numbers[index] ?? 0)));
}

function isTextureReference(value: unknown): value is TextureSource {
  if (typeof value === "string") {
    return true;
  }

  if (value === null || typeof value !== "object") {
    return false;
  }

  const generated = (value as { generatedTexture?: unknown }).generatedTexture;

  return Number.isSafeInteger(generated) && (generated as number) >= 0;
}

export function srgbLinearToGamma(value: number): number {
  const input = f(value);

  if (input < 0) {
    return 0;
  }

  const linear = Math.min(1, input);

  if (linear <= f(0.0031308)) {
    return f(linear * f(12.92));
  }

  return f(f(powfPositive(linear, f(1 / 2.4)) * f(1.055)) - f(0.055));
}

const unaryFunctions = new Map<number, (value: number) => number>([
  [0x00, sinf],
  [0x01, cosf],
  [0x03, (value) => f(value - Math.floor(value))],
  [0x04, Math.floor],
  [0x0c, Math.log],
  [0x14, Math.abs],
  [0x34, (value) => f(value * f(Math.PI / 180))],
  [
    0x1f,
    (value) => {
      // The native intrinsic rounds each operation to float32. Rounding only
      // the result changes captured paint colors by up to three ULPs.
      if (value <= f(0.04045)) {
        return f(value / f(12.92));
      }

      const base = f(f(value + f(0.055)) / f(1.055));

      return f(base ** f(2.4));
    },
  ],
]);

const binaryOperators = new Map<number, (left: number, right: number) => number>([
  [0x0d, (left, right) => Number(left === right)],
  [0x0e, (left, right) => Number(left !== right)],
  [0x0f, (left, right) => Number(left > right)],
  [0x10, (left, right) => Number(left >= right)],
  [0x11, (left, right) => Number(left < right)],
  [0x12, (left, right) => Number(left <= right)],
  [0x13, (left, right) => left + right],
  [0x14, (left, right) => left - right],
  [0x15, (left, right) => left * right],
  [0x16, (left, right) => left / right],
]);

function tokenMap(
  values: Record<string, unknown>,
  kind: string,
  convert: (value: unknown) => Register,
): Map<number, Register> {
  const map = new Map<number, Register>();

  for (const [name, value] of Object.entries(values)) {
    const token = vfxToken(name);

    if (map.has(token)) {
      throw new Error(`Duplicate VFX ${kind} token: ${name}`);
    }

    map.set(token, convert(value));
  }

  return map;
}

// Evaluates base64 bytecode and returns 4 or 16 components.
export function evaluateVfxExpression(base64: string, context: VfxContext = {}): number[] {
  const code = decodeBase64(base64);
  const view = new DataView(code.buffer, code.byteOffset, code.byteLength);
  const features = context.features ?? [];
  const parameters = tokenMap(context.parameters ?? {}, "parameter", (value) =>
    isTextureReference(value) ? { texture: value } : vector(value),
  );
  const attributes = tokenMap(context.attributes ?? {}, "attribute", vector);
  const stack: Register[] = [];
  const locals = new Map<number, Register>();
  let offset = 0;
  let instructions = 0;

  const popValue = (): Register => {
    const value = stack.pop();

    if (value === undefined) {
      throw new Error(`VFX stack underflow at byte ${offset}`);
    }

    return value;
  };

  const pop = (): number[] => {
    const value = popValue();

    if (!Array.isArray(value) || value.length !== 4) {
      throw new Error("VFX vector operation received a matrix");
    }

    return value;
  };

  const popMatrix = (): number[] => {
    const value = popValue();

    if (!Array.isArray(value) || value.length !== 16) {
      throw new Error("VFX matrix operation requires four registers");
    }

    return value;
  };

  const jump = (target: number): void => {
    if (target < offset || target >= code.length) {
      throw new Error(`Unsupported VFX jump from ${offset} to ${target}`);
    }

    offset = target;
  };

  const byte = (): number => {
    const value = view.getUint8(offset);
    offset += 1;

    return value;
  };

  const word = (): number => {
    const value = view.getUint32(offset, true);
    offset += 4;

    return value;
  };

  while (offset < code.length && instructions++ < code.length) {
    const opcode = byte();
    const binary = binaryOperators.get(opcode);

    if (opcode === 0x00) {
      if (offset !== code.length || stack.length !== 1) {
        throw new Error(`Invalid VFX return at byte ${offset}`);
      }

      const result = popValue();

      if (!Array.isArray(result)) {
        throw new Error("VFX return requires a numeric result");
      }

      return result;
    }

    if (opcode === 0x02) {
      const target = view.getUint16(offset, true);
      offset += 2;
      jump(target);
    } else if (opcode === 0x04) {
      const whenTrue = view.getUint16(offset, true);
      const whenFalse = view.getUint16(offset + 2, true);
      offset += 4;
      jump(component(pop(), 0) !== 0 ? whenTrue : whenFalse);
    } else if (opcode === 0x06) {
      callFunction(byte(), byte());
    } else if (opcode === 0x07) {
      stack.push(vector(view.getFloat32(offset, true)));
      offset += 4;
    } else if (opcode === 0x08) {
      locals.set(byte(), pop());
    } else if (opcode === 0x09) {
      const local = byte();
      const value = locals.get(local);

      if (value === undefined) {
        throw new Error(`Undefined VFX local ${local}`);
      }

      stack.push(value);
    } else if (opcode === 0x18) {
      stack.push(pop().map((value) => -value));
    } else if (binary !== undefined) {
      const right = pop();
      stack.push(pop().map((value, index) => f(binary(value, component(right, index)))));
    } else if (opcode === 0x1a) {
      const feature = byte();
      const value = features[feature];

      if (value === undefined) {
        throw new Error(`Missing VFX feature ${feature}`);
      }

      stack.push(vector(value));
    } else if (opcode === 0x19 || opcode === 0x1f) {
      const token = word();

      if (opcode === 0x1f) {
        stack.push(vector(Number(attributes.has(token))));
      } else {
        const value = attributes.get(token);

        if (value === undefined) {
          throw new Error(`Missing VFX attribute 0x${token.toString(16)}`);
        }

        stack.push(value);
      }
    } else if (opcode === 0x1d) {
      const token = word();
      const value = parameters.get(token);

      if (value === undefined) {
        throw new Error(`Missing VFX parameter 0x${token.toString(16)}`);
      }

      stack.push(value);
    } else if (opcode === 0x1e) {
      const packed = byte();
      const value = pop();
      stack.push(
        Array.from({ length: 4 }, (_, index) => component(value, (packed >> (index * 2)) & 3)),
      );
    } else {
      throw new Error(`Unsupported VFX opcode 0x${opcode.toString(16)} at byte ${offset - 1}`);
    }
  }

  throw new Error("VFX expression has no valid return");

  function callFunction(identifier: number, encoding: number): void {
    if (encoding !== 0) {
      throw new Error("Unsupported VFX function encoding");
    }

    const unary = unaryFunctions.get(identifier);

    if (unary !== undefined) {
      stack.push(pop().map((value) => f(unary(value))));

      return;
    }

    if (identifier === 0x1b) {
      const time = context.shaderTimeSeconds;

      if (time === undefined || !Number.isFinite(time) || !Number.isFinite(f(time))) {
        throw new Error("VFX time() requires explicit finite shaderTimeSeconds");
      }

      stack.push(vector(f(time)));

      return;
    }

    if (identifier === 0x1e) {
      // The original wrapper converts RGB only and preserves alpha.
      stack.push(pop().map((value, index) => (index < 3 ? srgbLinearToGamma(value) : value)));

      return;
    }

    if (identifier === 0x28) {
      const value = popValue();

      if (Array.isArray(value)) {
        throw new Error("TextureAverageColor requires an original texture resource");
      }

      const reflectivity = context.textureReflectivity?.(value.texture);
      const valid =
        reflectivity !== undefined &&
        reflectivity.length === 4 &&
        reflectivity.every((entry) => Number.isFinite(entry));

      if (!valid) {
        throw new Error(
          `Missing original texture reflectivity metadata: ${JSON.stringify(value.texture)}`,
        );
      }

      // Original VTEX1 DATA+4 is copied unchanged into texture metadata. VFX
      // 0x15da50 returns its RGB and sets alpha to one.
      stack.push([
        f(component(reflectivity, 0)),
        f(component(reflectivity, 1)),
        f(component(reflectivity, 2)),
        1,
      ]);

      return;
    }

    if (identifier === 0x36) {
      const strength = component(pop(), 0);
      stack.push(matrixColorTint2(pop(), strength));

      return;
    }

    if (identifier === 0x30) {
      const pivot = pop();
      stack.push(matrixColorCorrect2(pop(), pivot));

      return;
    }

    if (identifier === 0x2e) {
      const right = popMatrix();
      stack.push(multiplyVfxMatrices(popMatrix(), right));

      return;
    }

    if (identifier === 0x07) {
      const maximum = pop();
      const minimum = pop();
      stack.push(
        pop().map((value, index) =>
          Math.max(component(minimum, index), Math.min(component(maximum, index), value)),
        ),
      );

      return;
    }

    if (identifier === 0x08) {
      const weight = pop();
      const right = pop();
      stack.push(
        pop().map((value, index) =>
          f(
            f(value * f(1 - component(weight, index))) +
              f(component(right, index) * component(weight, index)),
          ),
        ),
      );

      return;
    }

    if (identifier === 0x15) {
      const exponent = pop();
      stack.push(pop().map((value, index) => f(value ** component(exponent, index))));

      return;
    }

    if (identifier === 0x1d) {
      const right = pop();
      stack.push(pop().map((value, index) => Math.max(value, component(right, index))));

      return;
    }

    if (identifier >= 0x18 && identifier <= 0x1a) {
      const count = 0x1c - identifier;
      const values = Array<number>(4).fill(0);

      for (let index = count - 1; index >= 0; index--) {
        values[index] = component(pop(), 0);
      }

      stack.push(values);

      return;
    }

    throw new Error(`Unsupported VFX function 0x${identifier.toString(16)}`);
  }
}
