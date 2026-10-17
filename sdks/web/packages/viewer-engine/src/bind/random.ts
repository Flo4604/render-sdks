// The paint seed generator of the executor's request binder (native
// src/bind/random.cpp): Park-Miller minimal standard with the game's 32-entry
// Bays-Durham shuffle and float32 draws.

export type RandomDraw = (minimum: number, maximum: number) => number;

// `seed` must be 0..2147483647. Each call draws one value in [minimum, maximum),
// rounded as the original client rounds.
export function randomStream(seed: number): RandomDraw {
  if (!Number.isInteger(seed) || seed < 0 || seed > 2147483647) {
    throw new Error("Random seed must be a nonnegative signed 32-bit integer");
  }

  let state = Math.max(seed, 1);
  const shuffle = new Int32Array(32);
  const advance = (): void => {
    const quotient = Math.trunc(state / 127773);
    state = 16807 * (state - quotient * 127773) - 2836 * quotient;

    if (state < 0) {
      state += 2147483647;
    }
  };

  for (let index = 39; index >= 0; index--) {
    advance();

    if (index < 32) {
      shuffle[index] = state;
    }
  }

  let previous = shuffle[0] ?? 0;

  return (minimum, maximum) => {
    const index = Math.trunc(previous / 67108864);
    advance();
    previous = shuffle[index] ?? 0;
    shuffle[index] = state;
    const fraction = Math.min(
      Math.fround(Math.fround(previous) * 2 ** -31),
      Math.fround(1 - 1.2e-7),
    );
    const low = Math.fround(minimum);
    const range = Math.fround(Math.fround(maximum) - low);

    return Math.fround(low + Math.fround(fraction * range));
  };
}
