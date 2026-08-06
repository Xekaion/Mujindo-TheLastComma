export const SIMPLE_AUGMENT_IDS = [
  "strength",
  "rapidfire",
  "range",
  "velocity",
  "expansion",
  "sprint",
  "defense",
  "recovery",
  "learning",
  "collection",
] as const;

/** Every augmentation has one universal, persisted rank ceiling. */
export const MAX_AUGMENT_STACKS = 20;

export function clampAugmentStack(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.min(MAX_AUGMENT_STACKS, Math.max(0, Math.floor(value)));
}

export function normalizeAugmentStacks(
  value: unknown,
): Record<string, number> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value)
      .map(([id, stacks]) => [id, clampAugmentStack(stacks)] as const)
      .filter(([, stacks]) => stacks > 0),
  );
}

export function totalAugmentStacks(value: unknown): number {
  return Object.values(normalizeAugmentStacks(value)).reduce(
    (total, stacks) => total + stacks,
    0,
  );
}

export const SIMPLE_AUGMENT_BONUSES = {
  strengthDamagePerRank: 0.1,
  rapidfireAttackSpeedPerRank: 0.08,
  rangeProjectileLifePerRank: 0.12,
  velocityProjectileSpeedPerRank: 0.1,
  expansionProjectileSizePerRank: 0.08,
  sprintMoveSpeedPerRank: 0.05,
  defenseDamageReductionPerRank: 0.03,
  recoveryRoomHealPerRank: 5,
  learningXpGainPerRank: 0.1,
  collectionPickupRangePerRank: 0.15,
} as const;

export function simpleAugmentMultiplier(rank: number, bonusPerRank: number): number {
  return 1 + clampAugmentStack(rank) * bonusPerRank;
}

export function simpleDefenseDamageMultiplier(rank: number): number {
  return Math.pow(
    1 - SIMPLE_AUGMENT_BONUSES.defenseDamageReductionPerRank,
    clampAugmentStack(rank),
  );
}
