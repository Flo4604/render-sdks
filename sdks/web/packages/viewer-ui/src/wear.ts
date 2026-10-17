// Wear tiers as the game names them, by the float's upper bound.

export interface WearTier {
  name: string;
  short: string;
  // Exclusive upper bound of the float.
  max: number;
}

export const wearTiers: readonly WearTier[] = [
  { name: "Factory New", short: "FN", max: 0.07 },
  { name: "Minimal Wear", short: "MW", max: 0.15 },
  { name: "Field-Tested", short: "FT", max: 0.38 },
  { name: "Well-Worn", short: "WW", max: 0.45 },
  { name: "Battle-Scarred", short: "BS", max: 1 },
];

export function wearTier(wear: number): WearTier {
  for (const tier of wearTiers) {
    if (wear < tier.max) {
      return tier;
    }
  }

  return wearTiers[wearTiers.length - 1] as WearTier;
}

// The float as traders write it: enough digits to tell neighbours apart.
export function formatWear(wear: number, digits = 6): string {
  return wear.toFixed(digits);
}

export const seedRange = { min: 0, max: 1000 } as const;

export function clampSeed(seed: number): number {
  return Math.min(seedRange.max, Math.max(seedRange.min, Math.round(seed)));
}
