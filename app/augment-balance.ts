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
  return 1 + Math.max(0, rank) * bonusPerRank;
}

export function simpleDefenseDamageMultiplier(rank: number): number {
  return Math.pow(
    1 - SIMPLE_AUGMENT_BONUSES.defenseDamageReductionPerRank,
    Math.max(0, rank),
  );
}
