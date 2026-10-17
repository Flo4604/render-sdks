/*
 * Float sine/cosine adapted from Arm optimized-routines math/{sinf.c,cosf.c,
 * sincosf.h,sincosf_data.c}, commit 97362b2eab91d35d30c4ac2c8c79dcd4dae4331b.
 * https://github.com/ARM-software/optimized-routines
 * Copyright (c) 2017-2026, Arm Limited.
 * SPDX-License-Identifier: MIT
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

// Float32 kernels of the executor's request binder (native src/bind/float_math.cpp,
// ported from lib/float-math.mjs): each double-precision step of the reference
// is kept, so the results equal the C++ and the pinned Linux libm bit for bit.
//
// The pinned Linux libm uses this polynomial family. Math.sin/cos rounded to
// float32 can differ by one ULP, which changes original VFX material inputs.
const sign = [1, -1, -1, 1] as const;
const halfPi = 0x1921fb54442d18 * 2 ** -52;
const inverseHalfPiScaled = 0x145f306dc9c883 * 2 ** -29;
const cosine = [
  1,
  -0x1ffffffd0c621c * 2 ** -54,
  0x155553e1068f19 * 2 ** -57,
  -0x16c087e89a359d * 2 ** -62,
  0x199343027bf8c3 * 2 ** -68,
] as const;
const sine = [
  -0x1555545995a603 * 2 ** -55,
  0x11107605230bc4 * 2 ** -59,
  -0x1994eb3774cf24 * 2 ** -65,
] as const;
const inverseQuarterPi = [
  0xa2, 0xa2f9, 0xa2f983, 0xa2f9836e, 0xf9836e4e, 0x836e4e44, 0x6e4e4415, 0x4e441529, 0x441529fc,
  0x1529fc27, 0x29fc2757, 0xfc2757d1, 0x2757d1f5, 0x57d1f534, 0xd1f534dd, 0xf534ddc0, 0x34ddc0db,
  0xddc0db62, 0xc0db6295, 0xdb629599, 0x6295993c, 0x95993c43, 0x993c4390, 0x3c439041,
];
const bits = new DataView(new ArrayBuffer(4));

function entry<T>(values: readonly T[], index: number): T {
  const value = values[index];

  if (value === undefined) {
    throw new Error(`Float kernel table index ${index} is out of range`);
  }

  return value;
}

function polynomial(x: number, square: number, quadrant: number, negativeCosine: boolean): number {
  if ((quadrant & 1) === 0) {
    const cube = x * square;
    const tail = sine[1] + square * sine[2];
    const head = x + cube * sine[0];

    return Math.fround(head + cube * square * tail);
  }

  const fourth = square * square;
  const tail = cosine[3] + square * cosine[4];
  const head = cosine[0] + square * cosine[1];
  const value = head + fourth * cosine[2] + fourth * square * tail;

  return Math.fround(negativeCosine ? -value : value);
}

function trig(value: number, isCosine: boolean): number {
  const input = Math.fround(value);
  bits.setFloat32(0, input, true);
  const word = bits.getUint32(0, true);
  const magnitude = (word >>> 20) & 0x7ff;

  if (magnitude < 0x3f4) {
    if (magnitude < 0x398) {
      return isCosine ? 1 : input;
    }

    return polynomial(input, input * input, isCosine ? 1 : 0, false);
  }

  if (!Number.isFinite(input)) {
    return NaN;
  }

  let reduced: number;
  let quadrant: number;
  let signQuadrant: number;

  if (magnitude < 0x42f) {
    quadrant = (Math.trunc(input * inverseHalfPiScaled) + 0x800000) >> 24;
    reduced = input - quadrant * halfPi;
    signQuadrant = quadrant;
  } else {
    const table = (word >>> 26) & 15;
    const shift = (word >>> 23) & 7;
    const significand = BigInt((((word & 0xffffff) | 0x800000) << shift) >>> 0);
    const low = significand * BigInt(entry(inverseQuarterPi, table + 8));
    const high = significand * BigInt(entry(inverseQuarterPi, table));
    const middle = significand * BigInt(entry(inverseQuarterPi, table + 4));
    const product = BigInt.asUintN(64, (low >> 32n) | (high << 32n));
    const fraction = BigInt.asUintN(64, product + middle);
    const nearest = BigInt.asUintN(64, fraction + (1n << 61n)) >> 62n;
    const remainder = BigInt.asIntN(64, fraction - (nearest << 62n));
    reduced = Number(remainder) * (0x1921fb54442d18 * 2 ** -114);
    quadrant = Number(nearest);
    signQuadrant = quadrant + (word >>> 31);
  }

  return polynomial(
    reduced * entry(sign, signQuadrant & 3),
    reduced * reduced,
    quadrant ^ (isCosine ? 1 : 0),
    (signQuadrant & 2) !== 0,
  );
}

export function sinf(value: number): number {
  return trig(value, false);
}

export function cosf(value: number): number {
  return trig(value, true);
}

// Positive, normal-input powf follows Arm powf.c, powf_log2_data.c and
// exp2f_data.c at the same revision and license as the trigonometric routines.
// Preserve each double-precision operation; Math.pow rounded to float differs.
const powerLogTable: Array<readonly [number, number]> = [
  [0x1661ec79f8f3be * 2 ** -52, -0x1efec65b963019 * 2 ** -54],
  [0x1571ed4aaf883d * 2 ** -52, -0x1b0b6832d4fca4 * 2 ** -54],
  [0x149539f0f010b * 2 ** -48, -0x17418b0a1fb77b * 2 ** -54],
  [0x13c995b0b80385 * 2 ** -52, -0x139de91a6dcf7b * 2 ** -54],
  [0x130d190c8864a5 * 2 ** -52, -0x101d9bf3f2b631 * 2 ** -54],
  [0x125e227b0b8ea * 2 ** -48, -0x197c1d1b3b7af * 2 ** -51],
  [0x11bb4a4a1a343f * 2 ** -52, -0x12f9e393af3c9f * 2 ** -55],
  [0x112358f08ae5ba * 2 ** -52, -0x1960cbbf788d5c * 2 ** -56],
  [0x10953f419900a7 * 2 ** -52, -0x1a6f9db6475fce * 2 ** -57],
  [0x1 * 2 ** 0, 0x0 * 2 ** 0],
  [0x1e608cfd9a47ac * 2 ** -53, 0x1338ca9f24f53d * 2 ** -56],
  [0x1ca4b31f026aa * 2 ** -49, 0x1476a9543891ba * 2 ** -55],
  [0x1b2036576afce6 * 2 ** -53, 0x1e840b4ac4e4d2 * 2 ** -55],
  [0x19c2d163a1aa2d * 2 ** -53, 0x140645f0c6651c * 2 ** -54],
  [0x1886e6037841ed * 2 ** -53, 0x188e9c2c1b9ff8 * 2 ** -54],
  [0x1767dcf5534862 * 2 ** -53, 0x1ce0a44eb17bcc * 2 ** -54],
];
const powerLogPolynomial = [
  0x127616c9496e0b * 2 ** -54,
  -0x171969a075c67a * 2 ** -54,
  0x1ec70a6ca7badd * 2 ** -54,
  -0x17154748bef6c8 * 2 ** -53,
  0x171547652ab82b * 2 ** -52,
] as const;
const powerExpTable = [
  0x3ff0000000000000n,
  0x3fefd9b0d3158574n,
  0x3fefb5586cf9890fn,
  0x3fef9301d0125b51n,
  0x3fef72b83c7d517bn,
  0x3fef54873168b9aan,
  0x3fef387a6e756238n,
  0x3fef1e9df51fdee1n,
  0x3fef06fe0a31b715n,
  0x3feef1a7373aa9cbn,
  0x3feedea64c123422n,
  0x3feece086061892dn,
  0x3feebfdad5362a27n,
  0x3feeb42b569d4f82n,
  0x3feeab07dd485429n,
  0x3feea47eb03a5585n,
  0x3feea09e667f3bcdn,
  0x3fee9f75e8ec5f74n,
  0x3feea11473eb0187n,
  0x3feea589994cce13n,
  0x3feeace5422aa0dbn,
  0x3feeb737b0cdc5e5n,
  0x3feec49182a3f090n,
  0x3feed503b23e255dn,
  0x3feee89f995ad3adn,
  0x3feeff76f2fb5e47n,
  0x3fef199bdd85529cn,
  0x3fef3720dcef9069n,
  0x3fef5818dcfba487n,
  0x3fef7c97337b9b5fn,
  0x3fefa4afa2a490dan,
  0x3fefd0765b6e4540n,
];
const powerExpPolynomial = [
  0x1c6af84b912394 * 2 ** -57,
  0x1ebfce50fac4f3 * 2 ** -55,
  0x162e42ff0c52d6 * 2 ** -53,
] as const;
const powerBits = new DataView(new ArrayBuffer(8));

export function powfPositive(value: number, exponent: number): number {
  const x = Math.fround(value);
  const y = Math.fround(exponent);

  if (!(x >= 2 ** -126) || !Number.isFinite(x) || !Number.isFinite(y)) {
    throw new Error("powfPositive requires a finite normal positive base and finite exponent");
  }

  powerBits.setFloat32(0, x, true);
  const word = powerBits.getUint32(0, true);
  const temporary = (word - 0x3f330000) >>> 0;
  const index = (temporary >>> 19) % 16;
  const top = temporary & 0xff800000;
  powerBits.setUint32(0, (word - top) >>> 0, true);
  const normalized = powerBits.getFloat32(0, true);
  const [inverse, logarithm] = entry(powerLogTable, index);
  const r = normalized * inverse - 1;
  const square = r * r;
  const fourth = square * square;
  const a = powerLogPolynomial;
  const head = a[0] * r + a[1];
  const middle = a[2] * r + a[3];
  const tail = a[4] * r + (logarithm + (top >> 23));
  const log = head * fourth + (middle * square + tail);
  const scaled = y * log;

  if (scaled < -126 || scaled > 126) {
    throw new Error("powfPositive result is outside the verified normal exponent range");
  }

  const shift = 1.5 * 2 ** 47;
  const rounded = scaled + shift;
  powerBits.setFloat64(0, rounded, true);
  const integer = powerBits.getBigUint64(0, true);
  const delta = scaled - (rounded - shift);
  const scaleWord = BigInt.asUintN(
    64,
    entry(powerExpTable, Number(integer % 32n)) + (integer << 47n),
  );
  powerBits.setBigUint64(0, scaleWord, true);
  const scale = powerBits.getFloat64(0, true);
  const c = powerExpPolynomial;
  const z = c[0] * delta + c[1];
  const exp = z * (delta * delta) + (c[2] * delta + 1);

  return Math.fround(exp * scale);
}
