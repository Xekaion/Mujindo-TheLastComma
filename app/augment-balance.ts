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

export const EARLY_SPLIT_AUGMENT_ID = "split";
export const EARLY_SPLIT_MAX_LEVEL = 10;
export const EARLY_SPLIT_APPEARANCE_CHANCE = 0.5;

type AugmentChoiceCandidate = {
  id: string;
};

type SelectAugmentChoicesInput<T extends AugmentChoiceCandidate> = {
  available: readonly T[];
  playerLevel: number;
  getRank: (augment: T) => number;
  random?: () => number;
  choiceCount?: number;
};

export function usesEarlySplitAppearanceRule(playerLevel: number): boolean {
  return (
    Number.isFinite(playerLevel) &&
    playerLevel >= 1 &&
    playerLevel <= EARLY_SPLIT_MAX_LEVEL
  );
}

/**
 * Builds a unique augment-card set while preserving the existing preference
 * for already-owned augments. During levels 1-10, the split augment gets one
 * exact 50% appearance roll: a failed feature roll also removes it from the
 * ordinary pool so its real appearance rate cannot creep above 50%.
 */
export function selectAugmentChoices<T extends AugmentChoiceCandidate>({
  available,
  playerLevel,
  getRank,
  random = Math.random,
  choiceCount = 3,
}: SelectAugmentChoicesInput<T>): T[] {
  const maximumChoices = Math.max(0, Math.floor(choiceCount));
  if (maximumChoices === 0 || available.length === 0) return [];

  const split = available.find(
    (augment) => augment.id === EARLY_SPLIT_AUGMENT_ID,
  );
  const usesEarlyRule = usesEarlySplitAppearanceRule(playerLevel) && split !== undefined;
  const featureSplit = usesEarlyRule && random() < EARLY_SPLIT_APPEARANCE_CHANCE;
  const eligible = usesEarlyRule
    ? available.filter((augment) => augment.id !== EARLY_SPLIT_AUGMENT_ID)
    : [...available];
  const picked: T[] = featureSplit && split ? [split] : [];

  // A corrupted or heavily edited early save can leave split as the only
  // uncapped augment. Never open an empty choice modal in that exceptional
  // state, even when the 50% roll fails.
  if (usesEarlyRule && !featureSplit && eligible.length === 0 && split) {
    return [split];
  }

  const owned = eligible.filter((augment) => getRank(augment) > 0);
  const unowned = eligible.filter((augment) => getRank(augment) === 0);
  const pool = [...owned, ...owned, ...unowned]
    .map((augment) => ({
      augment,
      roll: random() + (getRank(augment) > 0 ? 0.15 : 0),
    }))
    .sort((a, b) => b.roll - a.roll);

  if (owned.length > 0 && !picked.some((augment) => getRank(augment) > 0)) {
    picked.push(
      owned
        .map((augment) => ({ augment, roll: random() }))
        .sort((a, b) => b.roll - a.roll)[0].augment,
    );
  }

  for (const item of pool) {
    if (!picked.some((augment) => augment.id === item.augment.id)) {
      picked.push(item.augment);
    }
    if (picked.length === maximumChoices) break;
  }

  return picked.slice(0, maximumChoices);
}

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
