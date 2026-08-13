/**
 * Serializable, deterministic equipment domain for Mujindo.
 *
 * This module deliberately has no DOM, React, storage, or rendering dependency.
 * Gear produced by `rollGear` can be persisted with plain JSON.stringify and
 * restored through `normalizeEquipment` without trusting derived save fields.
 */

export const EQUIPMENT_SLOTS = [
  "weapon",
  "offhand",
  "helm",
  "shoulders",
  "armor",
  "gloves",
  "belt",
  "legs",
  "boots",
  "relic",
] as const;

export type EquipmentSlot = (typeof EQUIPMENT_SLOTS)[number];

export const GEAR_RARITIES = [
  "common",
  "magic",
  "superior",
  "rare",
  "epic",
  "legendary",
  "mythic",
  "cosmic",
] as const;

export type GearRarity = (typeof GEAR_RARITIES)[number];

const gearRarityAtLeast = (
  rarity: GearRarity,
  minimum: GearRarity,
): boolean => GEAR_RARITIES.indexOf(rarity) >= GEAR_RARITIES.indexOf(minimum);

export type GearRarityMeta = {
  label: string;
  color: string;
  affixCount: number;
  powerBonus: number;
};

/** One item level is worth eight normalized equipment-power points. */
export const GEAR_POWER_PER_LEVEL = 8;

/**
 * Item-level headroom granted by rarity at +0 enhancement. The balance anchor
 * is common 100 ≈ magic 95 ≈ superior 90 ≈ rare 85 ≈ epic 80 ≈ legendary 70
 * ≈ mythic 55 ≈ cosmic 40 at comparable roll quality. Extra affix slots and
 * legendary powers are priced into this single premium, so the displayed
 * power score does not count them a second time.
 */
export const GEAR_RARITY_LEVEL_EQUIVALENT: Readonly<Record<GearRarity, number>> = {
  common: 0,
  magic: 5,
  superior: 10,
  rare: 15,
  epic: 20,
  legendary: 30,
  mythic: 45,
  cosmic: 60,
};

/** Fresh drops roll uniformly inside the player's level ± this radius. */
export const GEAR_DROP_LEVEL_RADIUS = 5;

/** Boss loot is always five to ten levels above the player at the kill. */
export const GEAR_BOSS_DROP_LEVEL_MIN_BONUS = 5;
export const GEAR_BOSS_DROP_LEVEL_MAX_BONUS = 10;

export const GEAR_RARITY_META: Readonly<Record<GearRarity, GearRarityMeta>> = {
  common: {
    label: "일반",
    color: "#c7c2b5",
    affixCount: 1,
    powerBonus: GEAR_RARITY_LEVEL_EQUIVALENT.common * GEAR_POWER_PER_LEVEL,
  },
  magic: {
    label: "마법",
    color: "#63a6ff",
    affixCount: 2,
    powerBonus: GEAR_RARITY_LEVEL_EQUIVALENT.magic * GEAR_POWER_PER_LEVEL,
  },
  superior: {
    label: "고급",
    color: "#4ed29b",
    affixCount: 3,
    powerBonus: GEAR_RARITY_LEVEL_EQUIVALENT.superior * GEAR_POWER_PER_LEVEL,
  },
  rare: {
    label: "희귀",
    color: "#e7c65b",
    affixCount: 4,
    powerBonus: GEAR_RARITY_LEVEL_EQUIVALENT.rare * GEAR_POWER_PER_LEVEL,
  },
  epic: {
    label: "영웅",
    color: "#bc70ff",
    affixCount: 5,
    powerBonus: GEAR_RARITY_LEVEL_EQUIVALENT.epic * GEAR_POWER_PER_LEVEL,
  },
  legendary: {
    label: "전설",
    color: "#e58a3d",
    affixCount: 6,
    powerBonus: GEAR_RARITY_LEVEL_EQUIVALENT.legendary * GEAR_POWER_PER_LEVEL,
  },
  mythic: {
    label: "신화",
    color: "#ff3f63",
    affixCount: 7,
    powerBonus: GEAR_RARITY_LEVEL_EQUIVALENT.mythic * GEAR_POWER_PER_LEVEL,
  },
  cosmic: {
    label: "우주",
    color: "#65f4ff",
    affixCount: 8,
    powerBonus: GEAR_RARITY_LEVEL_EQUIVALENT.cosmic * GEAR_POWER_PER_LEVEL,
  },
};

export type GearDropSource = "normal" | "elite" | "boss";

export const GEAR_DROP_BASE_CHANCE: Readonly<Record<GearDropSource, number>> = {
  normal: 0.19,
  elite: 0.68,
  boss: 1,
};

export const GEAR_DROP_CHANCE_CAP: Readonly<Record<GearDropSource, number>> = {
  normal: 0.72,
  elite: 0.95,
  boss: 1,
};

/** Normal-enemy chance before gear-find multiplication cannot exceed 42%. */
export const GEAR_DROP_SCAVENGER_CHANCE_CAP = 0.42;

/** Each Scavenger rank adds 0.8 percentage points before the 42% cap. */
export const GEAR_DROP_SCAVENGER_CHANCE_PER_RANK = 0.008;

/** Character levels below this value use the onboarding rarity table. */
export const GEAR_EARLY_RARITY_LEVEL_CUTOFF = 20;

/**
 * Exact conditional rarity distribution for character levels 1 through 19.
 * Integer weights preserve the requested 0.0001% cosmic chance without
 * floating-point boundary drift. The row sums to exactly 1,000,000.
 */
export const GEAR_EARLY_LEVEL_RARITY_WEIGHTS: Readonly<
  Record<GearRarity, number>
> = {
  common: 250_000,
  magic: 250_000,
  superior: 200_000,
  rare: 150_000,
  epic: 100_000,
  legendary: 40_000,
  mythic: 9_999,
  cosmic: 1,
};

/**
 * Exact rarity table for equipment created in the expedition's starting room.
 * The integer denominator is 100,000, preserving the requested 0.002% cosmic
 * chance without allowing common or magic gear into the guaranteed reward.
 */
export const FIRST_ROOM_GUARANTEED_RARITY_WEIGHTS: Readonly<
  Record<GearRarity, number>
> = {
  common: 0,
  magic: 0,
  superior: 40_000,
  rare: 35_000,
  epic: 22_000,
  legendary: 2_000,
  mythic: 998,
  cosmic: 2,
};

type FirstRoomGearDropContext = {
  clearedRoomCount: number;
  roomX: number;
  roomY: number;
  roomHasDroppedGear: boolean;
  survivingEnemyCount: number;
};

export function isExpeditionStartingRoom({
  clearedRoomCount,
  roomX,
  roomY,
}: Pick<
  FirstRoomGearDropContext,
  "clearedRoomCount" | "roomX" | "roomY"
>): boolean {
  return clearedRoomCount === 0 && roomX === 0 && roomY === 0;
}

/**
 * Forces exactly one fallback drop when the final living enemy of the first
 * room dies before that room has produced any equipment.
 */
export function shouldForceFirstRoomGearDrop(
  context: FirstRoomGearDropContext,
): boolean {
  return (
    isExpeditionStartingRoom(context) &&
    !context.roomHasDroppedGear &&
    context.survivingEnemyCount === 0
  );
}

/**
 * Conditional rarity weights after an equipment drop has already occurred.
 * All rows sum to 95,000,000. With the unmodified 19% normal-enemy drop
 * chance, the shared top-end weights produce exact per-kill odds of 1/500
 * legendary, 1/5,000 mythic, and 1/250,000 cosmic. Elite and boss rows keep
 * those same conditional top-end odds; their advantage comes from more drops.
 * Normal epic gear lands at 1/100 kills, creating a clear fivefold rarity
 * cliff at legendary without lowering the restored overall item-drop rate.
 */
export const GEAR_DROP_RARITY_WEIGHTS: Readonly<
  Record<GearDropSource, Readonly<Record<GearRarity, number>>>
> = {
  normal: {
    common: 43_000_000,
    magic: 26_000_000,
    superior: 13_000_000,
    rare: 6_898_000,
    epic: 5_000_000,
    legendary: 1_000_000,
    mythic: 100_000,
    cosmic: 2_000,
  },
  elite: {
    common: 31_000_000,
    magic: 26_000_000,
    superior: 18_000_000,
    rare: 12_000_000,
    epic: 6_898_000,
    legendary: 1_000_000,
    mythic: 100_000,
    cosmic: 2_000,
  },
  boss: {
    common: 0,
    magic: 0,
    superior: 0,
    rare: 51_300_000,
    epic: 42_598_000,
    legendary: 1_000_000,
    mythic: 100_000,
    cosmic: 2_000,
  },
};

export const EQUIPMENT_SLOT_LABELS: Readonly<Record<EquipmentSlot, string>> = {
  weapon: "무기",
  offhand: "보조 장비",
  helm: "투구",
  shoulders: "어깨",
  armor: "갑옷",
  gloves: "장갑",
  belt: "허리띠",
  legs: "각반",
  boots: "장화",
  relic: "유물",
};

/**
 * Ten visual bases per slot (100 total). The shared array index is also the
 * equipment-atlas row, so every base can have its own silhouette independent
 * of rarity. Selection is deterministic for a given roll seed.
 */
export const GEAR_BASE_NAMES: Readonly<Record<EquipmentSlot, readonly string[]>> = {
  weapon: [
    "순례자의 월도",
    "균열 철검",
    "기억의 장창",
    "월식 파쇄검",
    "심홍 서약검",
    "성좌 절단창",
    "백골 대낫",
    "공허 송곳검",
    "종언의 제본침",
    "성운 절단검",
  ],
  offhand: [
    "순례자의 원형 방패",
    "균열 수호방패",
    "기억의 경전",
    "월식 뿔방패",
    "심홍 맹세방패",
    "성좌 수정구",
    "백골 해골방패",
    "공허 거울방패",
    "봉인된 최종장",
    "별무덤 천구의",
  ],
  helm: [
    "봉인 투구",
    "추적자의 두건",
    "월식 면갑",
    "기억술사의 관",
    "심홍 집행관의 가면",
    "성좌 관측자의 두건",
    "백골 왕관",
    "공허의 무면투구",
    "무문장의 가면",
    "무진성 관측면갑",
  ],
  shoulders: [
    "방랑자의 견갑",
    "균열 파수견갑",
    "기억술사의 어깨장식",
    "월식 가시견갑",
    "심홍 집행관의 견갑",
    "성좌 운철어깨",
    "백골 군주견갑",
    "공허 포식자의 어깨",
    "교정쇄 견갑",
    "혜성흔 견갑",
  ],
  armor: [
    "방랑자의 흉갑",
    "심연 사슬옷",
    "파수꾼 판금",
    "기억 봉합의",
    "심홍 맹약 흉갑",
    "성좌 수놓은 예복",
    "백골 성채갑",
    "공허 포식자의 외투",
    "종언 편집자의 법의",
    "성운 방랑갑",
  ],
  gloves: [
    "순례자의 손싸개",
    "균열 철장갑",
    "기억직조 장갑",
    "월식 발톱장갑",
    "심홍 집행자의 건틀릿",
    "성좌 별실장갑",
    "백골 갈퀴손",
    "공허 장악장갑",
    "문장 봉합장갑",
    "유성 파지장갑",
  ],
  belt: [
    "방랑자의 허리끈",
    "균열 고리띠",
    "기억 봉인대",
    "월식 사슬허리띠",
    "심홍 맹약대",
    "성좌 천구허리띠",
    "백골 척추띠",
    "공허 포식자의 요대",
    "제본사의 사슬띠",
    "항성고리 요대",
  ],
  legs: [
    "순례자의 다리싸개",
    "균열 판금각반",
    "기억지기의 바지",
    "월식 추적각반",
    "심홍 집행관의 각반",
    "성좌 유성바지",
    "백골 보행각",
    "공허 유랑자의 하의",
    "마지막 장의 각반",
    "은하 답파각",
  ],
  boots: [
    "먼지길 장화",
    "균열 디딤쇠",
    "밤걸음 각반",
    "무진의 답파화",
    "심홍 추적화",
    "성좌 유성각반",
    "백골 행군화",
    "공허 도약장화",
    "여백 순례화",
    "별틈 도약화",
  ],
  relic: [
    "금 간 쉼표",
    "기억 나침반",
    "월륜 부적",
    "무진도 파편",
    "심홍 심장석",
    "성좌 별읽기 성반",
    "백골 성배",
    "공허의 검은 쉼표",
    "종언의 쉼표",
    "궤도 밖의 쉼표",
  ],
};

export const GEAR_AFFIX_STATS = [
  "damagePercent",
  "attackSpeedPercent",
  "projectileSpeedPercent",
  "maxHpFlat",
  "damageReductionPercent",
  "moveSpeedPercent",
  "dashCooldownPercent",
  "pickupRadiusPercent",
  "xpGainPercent",
  "critChancePercent",
  "critDamagePercent",
  "projectileSizePercent",
  "eliteDamagePercent",
  "lifeOnHitFlat",
  "gearFindPercent",
  "projectileCountFlat",
  "pierceFlat",
  "projectileLifetimePercent",
  "homingStrengthFlat",
  "hpRegenPerSecondFlat",
  "roomClearHealFlat",
  "roomEntryShieldFlat",
  "dashSpeedPercent",
  "bossDamagePercent",
  "executeDamagePercent",
  "cosmicFinalDamagePercent",
  "cosmicAegisPercent",
  "cosmicActionSpeedPercent",
] as const;

export type GearAffixStat = (typeof GEAR_AFFIX_STATS)[number];

/** All live equipment stats, including implicit-only weapon attack power. */
export const GEAR_STAT_KEYS = ["attackPowerFlat", ...GEAR_AFFIX_STATS] as const;

export type GearStat = (typeof GEAR_STAT_KEYS)[number];

export type GearAffix = {
  stat: GearAffixStat;
  /** Positive magnitude. Reduction stats describe their subtraction in label. */
  value: number;
  /** Position inside this affix's level-adjusted roll range (1 = low, 100 = perfect). */
  rollPercent: number;
  /** Fully formatted Korean display label, e.g. `공격력 +12%`. */
  label: string;
};

export type GearAffixDefinition = {
  name: string;
  unit: "percent" | "flat";
  sign: "+" | "-";
  minValue: number;
  maxValue: number;
  perLevel: number;
  cap: number;
  powerWeight: number;
  /** Relative chance when choosing an eligible affix, before duplicate removal. */
  rollWeight: number;
  /** Slots that may roll this option on newly generated equipment. */
  dropSlots: readonly EquipmentSlot[];
  /** Slots accepted when normalizing saves, including the pre-pool rules. */
  legacySlots: readonly EquipmentSlot[];
  /** Lowest rarity allowed to receive this option on a newly generated drop. */
  minimumDropRarity?: GearRarity;
  /**
   * Lowest rarity accepted from persisted gear. This is intentionally lower
   * than `minimumDropRarity` only for options that existed before a rarity gate
   * was introduced, so an old item is preserved without reopening new rolls.
   */
  minimumSaveRarity?: GearRarity;
  /** Count-like stats roll and render as whole numbers. */
  integerRoll?: boolean;
};

/**
 * New drops use exactly twenty distinct, runtime-backed option types per slot.
 * The explicit pools make slot identity auditable and keep future edits from
 * silently changing a slot merely because a definition's compatibility list
 * was widened. Attack speed intentionally appears only on weapons here.
 */
export const GEAR_AFFIX_DROP_POOL_BY_SLOT: Readonly<
  Record<EquipmentSlot, readonly GearAffixStat[]>
> = {
  weapon: [
    "damagePercent",
    "attackSpeedPercent",
    "projectileSpeedPercent",
    "moveSpeedPercent",
    "dashCooldownPercent",
    "pickupRadiusPercent",
    "critChancePercent",
    "critDamagePercent",
    "projectileSizePercent",
    "eliteDamagePercent",
    "lifeOnHitFlat",
    "projectileCountFlat",
    "pierceFlat",
    "projectileLifetimePercent",
    "homingStrengthFlat",
    "hpRegenPerSecondFlat",
    "roomClearHealFlat",
    "dashSpeedPercent",
    "bossDamagePercent",
    "executeDamagePercent",
  ],
  offhand: [
    "damagePercent",
    "projectileSpeedPercent",
    "maxHpFlat",
    "damageReductionPercent",
    "dashCooldownPercent",
    "pickupRadiusPercent",
    "critChancePercent",
    "critDamagePercent",
    "projectileSizePercent",
    "eliteDamagePercent",
    "lifeOnHitFlat",
    "gearFindPercent",
    "projectileCountFlat",
    "pierceFlat",
    "projectileLifetimePercent",
    "homingStrengthFlat",
    "hpRegenPerSecondFlat",
    "roomClearHealFlat",
    "roomEntryShieldFlat",
    "bossDamagePercent",
  ],
  helm: [
    "projectileSpeedPercent",
    "maxHpFlat",
    "damageReductionPercent",
    "moveSpeedPercent",
    "dashCooldownPercent",
    "pickupRadiusPercent",
    "xpGainPercent",
    "critChancePercent",
    "critDamagePercent",
    "projectileSizePercent",
    "eliteDamagePercent",
    "gearFindPercent",
    "projectileLifetimePercent",
    "homingStrengthFlat",
    "hpRegenPerSecondFlat",
    "roomClearHealFlat",
    "roomEntryShieldFlat",
    "bossDamagePercent",
    "executeDamagePercent",
    "lifeOnHitFlat",
  ],
  shoulders: [
    "damagePercent",
    "projectileSpeedPercent",
    "maxHpFlat",
    "damageReductionPercent",
    "moveSpeedPercent",
    "dashCooldownPercent",
    "pickupRadiusPercent",
    "xpGainPercent",
    "critChancePercent",
    "critDamagePercent",
    "projectileSizePercent",
    "eliteDamagePercent",
    "gearFindPercent",
    "projectileCountFlat",
    "pierceFlat",
    "projectileLifetimePercent",
    "homingStrengthFlat",
    "dashSpeedPercent",
    "bossDamagePercent",
    "executeDamagePercent",
  ],
  armor: [
    "damagePercent",
    "maxHpFlat",
    "damageReductionPercent",
    "moveSpeedPercent",
    "dashCooldownPercent",
    "pickupRadiusPercent",
    "xpGainPercent",
    "critChancePercent",
    "critDamagePercent",
    "projectileSizePercent",
    "eliteDamagePercent",
    "lifeOnHitFlat",
    "gearFindPercent",
    "projectileLifetimePercent",
    "hpRegenPerSecondFlat",
    "roomClearHealFlat",
    "roomEntryShieldFlat",
    "dashSpeedPercent",
    "bossDamagePercent",
    "executeDamagePercent",
  ],
  gloves: [
    "damagePercent",
    "projectileSpeedPercent",
    "moveSpeedPercent",
    "dashCooldownPercent",
    "pickupRadiusPercent",
    "xpGainPercent",
    "critChancePercent",
    "critDamagePercent",
    "projectileSizePercent",
    "eliteDamagePercent",
    "lifeOnHitFlat",
    "gearFindPercent",
    "projectileCountFlat",
    "pierceFlat",
    "projectileLifetimePercent",
    "homingStrengthFlat",
    "roomClearHealFlat",
    "dashSpeedPercent",
    "bossDamagePercent",
    "executeDamagePercent",
  ],
  belt: [
    "damagePercent",
    "maxHpFlat",
    "damageReductionPercent",
    "moveSpeedPercent",
    "dashCooldownPercent",
    "pickupRadiusPercent",
    "xpGainPercent",
    "critDamagePercent",
    "projectileSizePercent",
    "eliteDamagePercent",
    "lifeOnHitFlat",
    "gearFindPercent",
    "pierceFlat",
    "projectileLifetimePercent",
    "hpRegenPerSecondFlat",
    "roomClearHealFlat",
    "roomEntryShieldFlat",
    "dashSpeedPercent",
    "bossDamagePercent",
    "executeDamagePercent",
  ],
  legs: [
    "maxHpFlat",
    "damageReductionPercent",
    "moveSpeedPercent",
    "dashCooldownPercent",
    "pickupRadiusPercent",
    "xpGainPercent",
    "critChancePercent",
    "critDamagePercent",
    "projectileSizePercent",
    "eliteDamagePercent",
    "lifeOnHitFlat",
    "gearFindPercent",
    "pierceFlat",
    "projectileLifetimePercent",
    "hpRegenPerSecondFlat",
    "roomClearHealFlat",
    "roomEntryShieldFlat",
    "dashSpeedPercent",
    "bossDamagePercent",
    "executeDamagePercent",
  ],
  boots: [
    "projectileSpeedPercent",
    "maxHpFlat",
    "damageReductionPercent",
    "moveSpeedPercent",
    "dashCooldownPercent",
    "pickupRadiusPercent",
    "xpGainPercent",
    "projectileSizePercent",
    "eliteDamagePercent",
    "lifeOnHitFlat",
    "gearFindPercent",
    "pierceFlat",
    "projectileLifetimePercent",
    "homingStrengthFlat",
    "hpRegenPerSecondFlat",
    "roomClearHealFlat",
    "roomEntryShieldFlat",
    "dashSpeedPercent",
    "bossDamagePercent",
    "executeDamagePercent",
  ],
  relic: [
    "damagePercent",
    "projectileSpeedPercent",
    "maxHpFlat",
    "pickupRadiusPercent",
    "xpGainPercent",
    "critChancePercent",
    "critDamagePercent",
    "projectileSizePercent",
    "eliteDamagePercent",
    "lifeOnHitFlat",
    "gearFindPercent",
    "projectileCountFlat",
    "pierceFlat",
    "projectileLifetimePercent",
    "homingStrengthFlat",
    "hpRegenPerSecondFlat",
    "roomClearHealFlat",
    "roomEntryShieldFlat",
    "bossDamagePercent",
    "executeDamagePercent",
  ],
};

/**
 * Cosmic drops keep the established twenty-option slot pools, then replace
 * one regular roll with one guaranteed pinnacle option from this pool. This
 * makes the 1-in-250,000 tier materially special without diluting every lower
 * rarity's slot identity or silently expanding its roll pool.
 */
export const GEAR_COSMIC_AFFIX_STATS = [
  "cosmicFinalDamagePercent",
  "cosmicAegisPercent",
  "cosmicActionSpeedPercent",
] as const satisfies readonly GearAffixStat[];

export const GEAR_COSMIC_AFFIX_DROP_POOL_BY_SLOT: Readonly<
  Record<EquipmentSlot, readonly GearAffixStat[]>
> = {
  weapon: GEAR_COSMIC_AFFIX_STATS,
  offhand: GEAR_COSMIC_AFFIX_STATS,
  helm: GEAR_COSMIC_AFFIX_STATS,
  shoulders: GEAR_COSMIC_AFFIX_STATS,
  armor: GEAR_COSMIC_AFFIX_STATS,
  gloves: GEAR_COSMIC_AFFIX_STATS,
  belt: GEAR_COSMIC_AFFIX_STATS,
  legs: GEAR_COSMIC_AFFIX_STATS,
  boots: GEAR_COSMIC_AFFIX_STATS,
  relic: GEAR_COSMIC_AFFIX_STATS,
};

/** True only for stats in a slot's ordinary twenty-option drop pool. */
export function isGearAffixInRegularDropPool(
  slot: EquipmentSlot,
  stat: GearAffixStat,
): boolean {
  return GEAR_AFFIX_DROP_POOL_BY_SLOT[slot].includes(stat);
}

export function isGearAffixRollableForSlot(
  slot: EquipmentSlot,
  stat: GearAffixStat,
): boolean {
  return (
    GEAR_AFFIX_DROP_POOL_BY_SLOT[slot].includes(stat) ||
    GEAR_COSMIC_AFFIX_DROP_POOL_BY_SLOT[slot].includes(stat)
  );
}

const dropSlotsFor = (stat: GearAffixStat): readonly EquipmentSlot[] =>
  EQUIPMENT_SLOTS.filter((slot) => isGearAffixRollableForSlot(slot, stat));

/**
 * Affixes cover core offense/defense/mobility, projectile shaping, critical and
 * elite damage, sustain, progression, and loot discovery. Slot restrictions,
 * level scaling, hard caps, and selection weights keep the pool farmable while
 * preventing every slot from rolling every effect.
 */
export const GEAR_AFFIX_DEFINITIONS: Readonly<
  Record<GearAffixStat, GearAffixDefinition>
> = {
  damagePercent: {
    name: "공격력",
    unit: "percent",
    sign: "+",
    minValue: 5,
    maxValue: 9,
    perLevel: 0.16,
    cap: 80,
    powerWeight: 1.25,
    rollWeight: 100,
    dropSlots: dropSlotsFor("damagePercent"),
    legacySlots: ["weapon", "offhand", "shoulders", "armor", "gloves", "belt", "relic"],
  },
  attackSpeedPercent: {
    name: "공격 속도",
    unit: "percent",
    sign: "+",
    minValue: 4,
    maxValue: 8,
    perLevel: 0.11,
    cap: 55,
    powerWeight: 1.2,
    rollWeight: 85,
    dropSlots: dropSlotsFor("attackSpeedPercent"),
    legacySlots: ["weapon", "offhand", "helm", "gloves", "belt", "boots", "relic"],
  },
  projectileSpeedPercent: {
    name: "투사체 속도",
    unit: "percent",
    sign: "+",
    minValue: 6,
    maxValue: 12,
    perLevel: 0.14,
    cap: 90,
    powerWeight: 0.55,
    rollWeight: 65,
    dropSlots: dropSlotsFor("projectileSpeedPercent"),
    legacySlots: ["weapon", "offhand", "helm", "shoulders", "gloves", "relic"],
  },
  maxHpFlat: {
    name: "최대 생명력",
    unit: "flat",
    sign: "+",
    minValue: 14,
    maxValue: 26,
    perLevel: 2.6,
    cap: 3000,
    powerWeight: 0.12,
    rollWeight: 100,
    dropSlots: dropSlotsFor("maxHpFlat"),
    legacySlots: ["offhand", "helm", "shoulders", "armor", "belt", "legs", "boots", "relic"],
  },
  damageReductionPercent: {
    name: "받는 피해",
    unit: "percent",
    sign: "-",
    minValue: 2,
    maxValue: 4,
    perLevel: 0.035,
    cap: 24,
    powerWeight: 2.4,
    rollWeight: 55,
    dropSlots: dropSlotsFor("damageReductionPercent"),
    legacySlots: ["offhand", "helm", "shoulders", "armor", "belt", "legs", "boots", "relic"],
  },
  moveSpeedPercent: {
    name: "이동 속도",
    unit: "percent",
    sign: "+",
    minValue: 3,
    maxValue: 7,
    perLevel: 0.085,
    cap: 50,
    powerWeight: 1,
    rollWeight: 75,
    dropSlots: dropSlotsFor("moveSpeedPercent"),
    legacySlots: ["weapon", "shoulders", "armor", "gloves", "belt", "legs", "boots", "relic"],
  },
  dashCooldownPercent: {
    name: "회피 재사용 대기시간",
    unit: "percent",
    sign: "-",
    minValue: 4,
    maxValue: 8,
    perLevel: 0.075,
    cap: 42,
    powerWeight: 1.15,
    rollWeight: 60,
    dropSlots: dropSlotsFor("dashCooldownPercent"),
    legacySlots: ["weapon", "offhand", "helm", "gloves", "belt", "legs", "boots", "relic"],
  },
  pickupRadiusPercent: {
    name: "기억 흡수 범위",
    unit: "percent",
    sign: "+",
    minValue: 8,
    maxValue: 14,
    perLevel: 0.16,
    cap: 120,
    powerWeight: 0.35,
    rollWeight: 55,
    dropSlots: dropSlotsFor("pickupRadiusPercent"),
    legacySlots: ["weapon", "offhand", "armor", "gloves", "belt", "legs", "boots", "relic"],
  },
  xpGainPercent: {
    name: "기억 획득량",
    unit: "percent",
    sign: "+",
    minValue: 4,
    maxValue: 8,
    perLevel: 0.1,
    cap: 65,
    powerWeight: 0.7,
    rollWeight: 65,
    dropSlots: dropSlotsFor("xpGainPercent"),
    legacySlots: ["helm", "shoulders", "armor", "gloves", "belt", "legs", "boots", "relic"],
  },
  critChancePercent: {
    name: "치명타 확률",
    unit: "percent",
    sign: "+",
    minValue: 2,
    maxValue: 5,
    perLevel: 0.035,
    cap: 25,
    powerWeight: 2.3,
    rollWeight: 50,
    dropSlots: dropSlotsFor("critChancePercent"),
    legacySlots: ["weapon", "offhand", "helm", "shoulders", "gloves", "belt", "relic"],
  },
  critDamagePercent: {
    name: "치명타 피해",
    unit: "percent",
    sign: "+",
    minValue: 8,
    maxValue: 15,
    perLevel: 0.16,
    cap: 100,
    powerWeight: 0.65,
    rollWeight: 50,
    dropSlots: dropSlotsFor("critDamagePercent"),
    legacySlots: ["weapon", "offhand", "helm", "shoulders", "gloves", "belt", "relic"],
  },
  projectileSizePercent: {
    name: "투사체 크기",
    unit: "percent",
    sign: "+",
    minValue: 6,
    maxValue: 12,
    perLevel: 0.12,
    cap: 80,
    powerWeight: 0.55,
    rollWeight: 55,
    dropSlots: dropSlotsFor("projectileSizePercent"),
    legacySlots: ["weapon", "offhand", "shoulders", "armor", "gloves", "relic"],
  },
  eliteDamagePercent: {
    name: "정예·보스 피해",
    unit: "percent",
    sign: "+",
    minValue: 5,
    maxValue: 10,
    perLevel: 0.1,
    cap: 70,
    powerWeight: 1,
    rollWeight: 45,
    dropSlots: dropSlotsFor("eliteDamagePercent"),
    legacySlots: ["weapon", "offhand", "helm", "shoulders", "armor", "gloves", "belt", "legs", "relic"],
  },
  lifeOnHitFlat: {
    name: "적중 회복 효율",
    unit: "flat",
    sign: "+",
    minValue: 1,
    maxValue: 2,
    perLevel: 0.025,
    cap: 16,
    powerWeight: 4,
    rollWeight: 30,
    dropSlots: dropSlotsFor("lifeOnHitFlat"),
    legacySlots: ["weapon", "offhand", "armor", "gloves", "belt", "legs", "relic"],
  },
  gearFindPercent: {
    name: "장비 발견률",
    unit: "percent",
    sign: "+",
    minValue: 4,
    maxValue: 8,
    perLevel: 0.075,
    cap: 60,
    powerWeight: 0.5,
    rollWeight: 40,
    dropSlots: dropSlotsFor("gearFindPercent"),
    legacySlots: ["offhand", "helm", "shoulders", "gloves", "belt", "legs", "boots", "relic"],
  },
  projectileCountFlat: {
    name: "추가 투사체",
    unit: "flat",
    sign: "+",
    minValue: 0.6,
    maxValue: 1.1,
    perLevel: 0.002,
    cap: 3,
    powerWeight: 30,
    rollWeight: 18,
    dropSlots: dropSlotsFor("projectileCountFlat"),
    legacySlots: dropSlotsFor("projectileCountFlat"),
    minimumDropRarity: "mythic",
    minimumSaveRarity: "mythic",
    integerRoll: true,
  },
  pierceFlat: {
    name: "관통 횟수",
    unit: "flat",
    sign: "+",
    minValue: 0.55,
    maxValue: 1.15,
    perLevel: 0.0025,
    cap: 4,
    powerWeight: 12,
    rollWeight: 22,
    dropSlots: dropSlotsFor("pierceFlat"),
    legacySlots: dropSlotsFor("pierceFlat"),
    integerRoll: true,
  },
  projectileLifetimePercent: {
    name: "투사체 지속시간",
    unit: "percent",
    sign: "+",
    minValue: 6,
    maxValue: 12,
    perLevel: 0.12,
    cap: 90,
    powerWeight: 0.5,
    rollWeight: 55,
    dropSlots: dropSlotsFor("projectileLifetimePercent"),
    legacySlots: dropSlotsFor("projectileLifetimePercent"),
  },
  homingStrengthFlat: {
    name: "유도 성능",
    unit: "flat",
    sign: "+",
    minValue: 1,
    maxValue: 2,
    perLevel: 0.02,
    cap: 14,
    powerWeight: 3.2,
    rollWeight: 32,
    dropSlots: dropSlotsFor("homingStrengthFlat"),
    legacySlots: dropSlotsFor("homingStrengthFlat"),
  },
  hpRegenPerSecondFlat: {
    name: "초당 체력 재생",
    unit: "flat",
    sign: "+",
    minValue: 1,
    maxValue: 2,
    perLevel: 0.025,
    cap: 24,
    powerWeight: 3.5,
    rollWeight: 30,
    dropSlots: dropSlotsFor("hpRegenPerSecondFlat"),
    legacySlots: dropSlotsFor("hpRegenPerSecondFlat"),
  },
  roomClearHealFlat: {
    name: "방 클리어 회복",
    unit: "flat",
    sign: "+",
    minValue: 2,
    maxValue: 5,
    perLevel: 0.1,
    cap: 120,
    powerWeight: 0.65,
    rollWeight: 38,
    dropSlots: dropSlotsFor("roomClearHealFlat"),
    legacySlots: dropSlotsFor("roomClearHealFlat"),
  },
  roomEntryShieldFlat: {
    name: "방 입장 보호막",
    unit: "flat",
    sign: "+",
    minValue: 5,
    maxValue: 10,
    perLevel: 0.35,
    cap: 450,
    powerWeight: 0.2,
    rollWeight: 35,
    dropSlots: dropSlotsFor("roomEntryShieldFlat"),
    legacySlots: dropSlotsFor("roomEntryShieldFlat"),
  },
  dashSpeedPercent: {
    name: "대시 속도",
    unit: "percent",
    sign: "+",
    minValue: 4,
    maxValue: 8,
    perLevel: 0.08,
    cap: 55,
    powerWeight: 0.85,
    rollWeight: 55,
    dropSlots: dropSlotsFor("dashSpeedPercent"),
    legacySlots: dropSlotsFor("dashSpeedPercent"),
  },
  bossDamagePercent: {
    name: "보스 피해",
    unit: "percent",
    sign: "+",
    minValue: 5,
    maxValue: 10,
    perLevel: 0.11,
    cap: 75,
    powerWeight: 0.9,
    rollWeight: 40,
    dropSlots: dropSlotsFor("bossDamagePercent"),
    legacySlots: dropSlotsFor("bossDamagePercent"),
  },
  executeDamagePercent: {
    name: "처형 피해",
    unit: "percent",
    sign: "+",
    minValue: 6,
    maxValue: 12,
    perLevel: 0.12,
    cap: 90,
    powerWeight: 0.75,
    rollWeight: 35,
    dropSlots: dropSlotsFor("executeDamagePercent"),
    legacySlots: dropSlotsFor("executeDamagePercent"),
  },
  cosmicFinalDamagePercent: {
    name: "우주 최종 피해",
    unit: "percent",
    sign: "+",
    minValue: 8,
    maxValue: 12,
    perLevel: 0.04,
    cap: 30,
    powerWeight: 3.4,
    rollWeight: 100,
    dropSlots: dropSlotsFor("cosmicFinalDamagePercent"),
    legacySlots: dropSlotsFor("cosmicFinalDamagePercent"),
    minimumDropRarity: "cosmic",
    minimumSaveRarity: "cosmic",
  },
  cosmicAegisPercent: {
    name: "사건의 지평선 피해 감쇄",
    unit: "percent",
    sign: "-",
    minValue: 5,
    maxValue: 8,
    perLevel: 0.025,
    cap: 20,
    powerWeight: 4,
    rollWeight: 100,
    dropSlots: dropSlotsFor("cosmicAegisPercent"),
    legacySlots: dropSlotsFor("cosmicAegisPercent"),
    minimumDropRarity: "cosmic",
    minimumSaveRarity: "cosmic",
  },
  cosmicActionSpeedPercent: {
    name: "시공 초월 속도",
    unit: "percent",
    sign: "+",
    minValue: 6,
    maxValue: 10,
    perLevel: 0.03,
    cap: 22,
    powerWeight: 2.8,
    rollWeight: 100,
    dropSlots: dropSlotsFor("cosmicActionSpeedPercent"),
    legacySlots: dropSlotsFor("cosmicActionSpeedPercent"),
    minimumDropRarity: "cosmic",
    minimumSaveRarity: "cosmic",
  },
};

export type GearImplicitOptionDefinition = {
  stat: GearStat;
  label: string;
  /** Canonical +0 magnitude when item level + rarity premium equals 100. */
  valueAtTier100: number;
};

/**
 * Every slot owns exactly one deterministic implicit option. These values are
 * derived from slot/level/rarity rather than stored in saves, so legacy gear
 * and normalized local/PVP profiles automatically use the current model.
 */
export const GEAR_IMPLICIT_OPTION_BY_SLOT: Readonly<
  Record<EquipmentSlot, GearImplicitOptionDefinition>
> = {
  weapon: { stat: "attackPowerFlat", label: "기본 공격력", valueAtTier100: 4 },
  offhand: { stat: "projectileSizePercent", label: "투사체 크기", valueAtTier100: 10 },
  helm: { stat: "maxHpFlat", label: "최대 생명력", valueAtTier100: 30 },
  shoulders: { stat: "projectileSpeedPercent", label: "투사체 속도", valueAtTier100: 12 },
  armor: { stat: "damageReductionPercent", label: "받는 피해 감소", valueAtTier100: 4 },
  gloves: { stat: "attackSpeedPercent", label: "공격 속도", valueAtTier100: 8 },
  belt: { stat: "lifeOnHitFlat", label: "적중 회복", valueAtTier100: 1.5 },
  legs: { stat: "dashCooldownPercent", label: "회피 재사용 효율", valueAtTier100: 8 },
  boots: { stat: "moveSpeedPercent", label: "이동 속도", valueAtTier100: 8 },
  relic: { stat: "critChancePercent", label: "치명타 확률", valueAtTier100: 4 },
};

export const LEGENDARY_POWER_IDS = [
  "crescentEcho",
  "mirrorAegis",
  "hunterSigil",
  "starfallMantle",
  "lastMemory",
  "bloodwovenGrip",
  "ashboundGirdle",
  "phantomMarch",
  "riftStride",
  "commaResonance",
] as const;

export type LegendaryPowerId = (typeof LEGENDARY_POWER_IDS)[number];

export type LegendaryPower = {
  id: LegendaryPowerId;
  slot: EquipmentSlot;
  name: string;
  description: string;
  /** Numeric tuning data kept serializable and renderer-independent. */
  parameters: Readonly<Record<string, number>>;
};

export const LEGENDARY_POWERS: Readonly<
  Record<LegendaryPowerId, LegendaryPower>
> = {
  crescentEcho: {
    id: "crescentEcho",
    slot: "weapon",
    name: "반월의 메아리",
    description: "다섯 번째 기본 공격마다 좌우로 피해 65%의 메아리 투사체를 2발 발사합니다.",
    parameters: { everyShots: 5, projectileCount: 2, damageMultiplier: 0.65 },
  },
  mirrorAegis: {
    id: "mirrorAegis",
    slot: "offhand",
    name: "거울 심장의 방벽",
    description: "피해를 12회 받을 때마다 2초 동안 적 투사체를 막고 공격력 140%의 반사 파동을 방출합니다.",
    parameters: { everyHits: 12, barrierDurationSeconds: 2, damageMultiplier: 1.4 },
  },
  hunterSigil: {
    id: "hunterSigil",
    slot: "helm",
    name: "붉은 사냥의 문장",
    description: "정예와 보스에게 주는 피해가 18% 증가하고, 그들이 가까울수록 붉은 윤곽이 드러납니다.",
    parameters: { eliteDamagePercent: 18, revealRadius: 520 },
  },
  starfallMantle: {
    id: "starfallMantle",
    slot: "shoulders",
    name: "별무리의 추락",
    description: "회피 직후 4초 동안 주는 피해가 20% 증가하고 받는 피해가 10% 감소합니다.",
    parameters: { durationSeconds: 4, damagePercent: 20, damageReductionPercent: 10 },
  },
  lastMemory: {
    id: "lastMemory",
    slot: "armor",
    name: "마지막으로 남은 기억",
    description: "방마다 한 번 치명적인 피해를 무효화하고 최대 생명력의 40%를 회복합니다.",
    parameters: { usesPerRoom: 1, restoreMaxHpRatio: 0.4 },
  },
  bloodwovenGrip: {
    id: "bloodwovenGrip",
    slot: "gloves",
    name: "피로 짠 손아귀",
    description: "치명타를 6회 적중할 때마다 다음 기본 공격이 피해 55%의 투사체를 3발 추가 발사합니다.",
    parameters: { everyCriticalHits: 6, projectileCount: 3, damageMultiplier: 0.55 },
  },
  ashboundGirdle: {
    id: "ashboundGirdle",
    slot: "belt",
    name: "재를 묶는 허리띠",
    description: "기억 조각을 12개 흡수할 때마다 6초 동안 최대 생명력 8%의 보호막을 얻습니다.",
    parameters: { everyPickups: 12, shieldMaxHpRatio: 0.08, durationSeconds: 6 },
  },
  phantomMarch: {
    id: "phantomMarch",
    slot: "legs",
    name: "망각을 걷는 행진",
    description: "3초 이상 계속 이동하면 이동 속도가 12% 증가하고 지나간 자리에 피해 70%의 잔영을 남깁니다.",
    parameters: { activationSeconds: 3, moveSpeedPercent: 12, trailDamageMultiplier: 0.7 },
  },
  riftStride: {
    id: "riftStride",
    slot: "boots",
    name: "균열을 밟는 자",
    description: "회피 재사용 대기시간이 30% 감소하며, 이동 경로에 공격력 120%의 균열을 남깁니다.",
    parameters: { dashCooldownPercent: 30, trailDamageMultiplier: 1.2 },
  },
  commaResonance: {
    id: "commaResonance",
    slot: "relic",
    name: "끝나지 않은 쉼표",
    description: "기억 조각을 8개 흡수할 때마다 사방으로 피해 75%의 투사체를 8발 방출합니다.",
    parameters: { everyPickups: 8, projectileCount: 8, damageMultiplier: 0.75 },
  },
};

export const LEGENDARY_POWER_BY_SLOT: Readonly<
  Record<EquipmentSlot, LegendaryPowerId>
> = {
  weapon: "crescentEcho",
  offhand: "mirrorAegis",
  helm: "hunterSigil",
  shoulders: "starfallMantle",
  armor: "lastMemory",
  gloves: "bloodwovenGrip",
  belt: "ashboundGirdle",
  legs: "phantomMarch",
  boots: "riftStride",
  relic: "commaResonance",
};

export type GearItem = {
  /** Deterministic stable identifier derived from the seed and rolled contents. */
  id: string;
  slot: EquipmentSlot;
  rarity: GearRarity;
  level: number;
  baseName: string;
  displayName: string;
  /** Atlas cell index: base-item row × 10 slots + slot column (0–99). */
  iconIndex: number;
  affixes: GearAffix[];
  legendaryPowerId: LegendaryPowerId | null;
  /** Current memory-ash enhancement stage. Canonical range: +0 through +10. */
  enhancement: number;
  /** Mean affix percentile, recomputed from canonical affixes (1–100). */
  qualityScore: number;
  powerScore: number;
};

export type EquipmentLoadout = Record<EquipmentSlot, GearItem | null>;

export type GearStatTotals = Record<GearStat, number>;

export type GearSeed = number | string;

export type RollGearOptions = {
  /** Item level. Values are normalized to the safe range 1–999. */
  level?: number;
  /** Force a slot, otherwise the seed chooses one. */
  slot?: EquipmentSlot;
  /** Force a rarity, otherwise level-adjusted rarity weights are used. */
  rarity?: GearRarity;
};

export const GEAR_ICON_COLUMNS = 10;
export const GEAR_ICON_ROWS = 10;

export const MAX_GEAR_ENHANCEMENT = 10;

/** Equipment can be worn twenty levels before its item level. */
export const GEAR_EQUIP_LEVEL_OFFSET = 20;

const GEAR_ENHANCEMENT_SUCCESS_PERCENT = [
  100, 95, 88, 78, 68, 58, 48, 38, 28, 18,
] as const;

const GEAR_ENHANCEMENT_DESTROY_PERCENT = [
  0, 0, 0, 0, 0, 2, 5, 10, 18, 25,
] as const;

/**
 * Per-stage implicit-option growth. Random additional options never change.
 * Legendary receives exactly twice the common per-stage efficiency, while
 * cosmic receives three times as much, making risky high-tier upgrades matter.
 */
export const GEAR_ENHANCEMENT_EFFECT_PER_STAGE: Readonly<
  Record<GearRarity, number>
> = {
  common: 0.07,
  magic: 0.08,
  superior: 0.09,
  rare: 0.1,
  epic: 0.12,
  legendary: 0.14,
  mythic: 0.17,
  cosmic: 0.21,
};

/**
 * Shared rarity economy curve. Salvage yield and enhancement cost scale by
 * the same factor so a dismantled item funds a consistent share of an upgrade
 * at every rarity instead of flattening to a fixed six-ash step.
 */
export const GEAR_RARITY_ECONOMY_MULTIPLIER: Readonly<
  Record<GearRarity, number>
> = {
  common: 1,
  magic: 1.25,
  superior: 1.4,
  rare: 1.6,
  epic: 1.9,
  legendary: 2.2,
  mythic: 3,
  cosmic: 4,
};

export type GearEnhancementRule = {
  target: number;
  successPercent: number;
  failurePercent: number;
  destroyPercent: number;
  ashCost: number;
};

/** Returns the deterministic rule for the next attempt, or null at +10. */
export function getGearEnhancementRule(
  item: Pick<GearItem, "enhancement" | "rarity" | "level">,
): GearEnhancementRule | null {
  const current = item.enhancement;
  if (
    !Number.isSafeInteger(current) ||
    current < 0 ||
    current >= MAX_GEAR_ENHANCEMENT ||
    !isGearRarity(item.rarity) ||
    !Number.isSafeInteger(item.level) ||
    item.level < 1 ||
    item.level > 999
  ) {
    return null;
  }

  const successPercent = GEAR_ENHANCEMENT_SUCCESS_PERCENT[current];
  const destroyPercent = GEAR_ENHANCEMENT_DESTROY_PERCENT[current];
  const levelCost = 18 + item.level * 3.2;
  const stageCost = 1 + current * 0.6 + current * current * 0.1;
  const ashCost = Math.max(
    1,
    Math.round(
      levelCost * GEAR_RARITY_ECONOMY_MULTIPLIER[item.rarity] * stageCost,
    ),
  );

  return {
    target: current + 1,
    successPercent,
    failurePercent: 100 - successPercent - destroyPercent,
    destroyPercent,
    ashCost,
  };
}

/**
 * Returns the exact ash required to reach the item's current enhancement when
 * every stage succeeds on its first attempt. Failure odds and destroyed copies
 * are deliberately excluded: salvage refunds the deterministic success path.
 */
export function getGearEnhancementAshRefund(
  item: Pick<GearItem, "enhancement" | "rarity" | "level">,
): number {
  if (
    !Number.isSafeInteger(item.enhancement) ||
    item.enhancement < 0 ||
    item.enhancement > MAX_GEAR_ENHANCEMENT
  ) {
    return 0;
  }

  let refund = 0;
  for (let enhancement = 0; enhancement < item.enhancement; enhancement += 1) {
    const rule = getGearEnhancementRule({ ...item, enhancement });
    if (!rule) return 0;
    refund += rule.ashCost;
  }
  return refund;
}

export type GearSalvageAshBreakdown = {
  baseYield: number;
  enhancementRefund: number;
  total: number;
};

/** One shared salvage valuation for runtime awards and inventory previews. */
export function getGearSalvageAshBreakdown(
  item: Pick<GearItem, "enhancement" | "rarity" | "level">,
): GearSalvageAshBreakdown {
  const levelBaseYield = 11 + normalizedLevel(item.level) * 1.4;
  const baseYield = Math.max(
    1,
    Math.round(levelBaseYield * GEAR_RARITY_ECONOMY_MULTIPLIER[item.rarity]),
  );
  const enhancementRefund = getGearEnhancementAshRefund(item);

  return {
    baseYield,
    enhancementRefund,
    total: baseYield + enhancementRefund,
  };
}

const RARITY_NAME_PREFIX: Readonly<Record<GearRarity, string>> = {
  common: "",
  magic: "각인된",
  superior: "정련된",
  rare: "심홍의",
  epic: "영웅의",
  legendary: "",
  mythic: "",
  cosmic: "",
};

const RARITY_AFFIX_MULTIPLIER: Readonly<Record<GearRarity, number>> = {
  // Existing-tier multipliers are intentionally preserved so pre-expansion
  // save values remain normalizable without silently rerolling their affixes.
  common: 0.9,
  magic: 1,
  superior: 1.06,
  rare: 1.12,
  epic: 1.2,
  legendary: 1.25,
  mythic: 1.45,
  cosmic: 1.7,
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isOneOf = <T extends string>(
  values: readonly T[],
  value: unknown,
): value is T => typeof value === "string" && values.some((item) => item === value);

export const isEquipmentSlot = (value: unknown): value is EquipmentSlot =>
  isOneOf(EQUIPMENT_SLOTS, value);

export const isGearRarity = (value: unknown): value is GearRarity =>
  isOneOf(GEAR_RARITIES, value);

export const isGearAffixStat = (value: unknown): value is GearAffixStat =>
  isOneOf(GEAR_AFFIX_STATS, value);

export const isLegendaryPowerId = (value: unknown): value is LegendaryPowerId =>
  isOneOf(LEGENDARY_POWER_IDS, value);

const clamp = (value: number, min: number, max: number) =>
  Math.max(min, Math.min(max, value));

const normalizedLevel = (level: unknown): number =>
  typeof level === "number" && Number.isFinite(level)
    ? clamp(Math.floor(level), 1, 999)
    : 1;

/**
 * Required character level is derived instead of persisted so legacy saves and
 * server-vault items can never carry a stale or forged requirement.
 */
export function getGearRequiredLevel(
  itemOrLevel: number | Pick<GearItem, "level">,
): number {
  const itemLevel = typeof itemOrLevel === "number"
    ? itemOrLevel
    : itemOrLevel.level;
  return Math.max(1, normalizedLevel(itemLevel) - GEAR_EQUIP_LEVEL_OFFSET);
}

export function canEquipGearAtLevel(
  playerLevel: number,
  itemOrLevel: number | Pick<GearItem, "level">,
): boolean {
  const normalizedPlayerLevel = Number.isFinite(playerLevel)
    ? Math.max(1, Math.floor(playerLevel))
    : 1;
  return normalizedPlayerLevel >= getGearRequiredLevel(itemOrLevel);
}

export type EquipmentLevelReconciliation = Readonly<{
  /** Canonical items that remain equipped after applying the shared -20 rule. */
  equipment: EquipmentLoadout;
  /** Canonical backpack items followed by any level-locked equipped items. */
  inventory: GearItem[];
  /** Items moved out of equipment, in stable equipment-slot order. */
  unequipped: readonly GearItem[];
  /** True when invalid or duplicate saved gear was discarded while repairing. */
  repaired: boolean;
}>;

/**
 * Canonical save/vault boundary for the equip-level contract.
 *
 * The runtime equip button is not the only way equipment enters a character:
 * old local saves, plaza/PVP projections, and eventually server-vault restores
 * all hydrate parsed JSON.  This helper therefore normalizes both collections,
 * removes duplicate identities, and moves every item that the character can no
 * longer wear back to the backpack.  No item is deleted merely because the
 * current paid capacity is smaller than the recovered inventory.
 */
export function reconcileEquipmentLevelRequirements(
  playerLevel: unknown,
  equipmentValue: unknown,
  inventoryValue: unknown,
): EquipmentLevelReconciliation {
  const normalizedEquipment = normalizeEquipment(equipmentValue);
  const equipment = createEmptyEquipment();
  const inventory: GearItem[] = [];
  const unequipped: GearItem[] = [];
  const seenIds = new Set<string>();
  let repaired = false;

  for (const slot of EQUIPMENT_SLOTS) {
    const item = normalizedEquipment[slot];
    if (!item) {
      if (isRecord(equipmentValue) && equipmentValue[slot] != null) repaired = true;
      continue;
    }
    if (isRecord(equipmentValue) && !isGearItem(equipmentValue[slot])) {
      repaired = true;
    }
    if (seenIds.has(item.id)) {
      repaired = true;
      continue;
    }
    seenIds.add(item.id);
    if (canEquipGearAtLevel(
      typeof playerLevel === "number" ? playerLevel : Number.NaN,
      item,
    )) {
      equipment[slot] = item;
    } else {
      unequipped.push(item);
      repaired = true;
    }
  }

  if (Array.isArray(inventoryValue)) {
    for (const value of inventoryValue) {
      const item = normalizeGearItem(value);
      if (!item || seenIds.has(item.id)) {
        repaired = true;
        continue;
      }
      if (!isGearItem(value)) repaired = true;
      seenIds.add(item.id);
      inventory.push(item);
    }
  } else if (inventoryValue !== undefined && inventoryValue !== null) {
    repaired = true;
  }

  inventory.push(...unequipped);
  return { equipment, inventory, unequipped, repaired };
}

function rarityFromWeights(
  roll: number,
  weights: Readonly<Record<GearRarity, number>>,
): GearRarity {
  const totalWeight = GEAR_RARITIES.reduce(
    (total, rarity) => total + weights[rarity],
    0,
  );
  let weightedRoll =
    clamp(Number.isFinite(roll) ? roll : 0, 0, 0.999999999) * totalWeight;
  for (const rarity of GEAR_RARITIES) {
    weightedRoll -= weights[rarity];
    if (weightedRoll < 0) return rarity;
  }
  return "cosmic";
}

export function rollFirstRoomGuaranteedRarity(roll: number): GearRarity {
  return rarityFromWeights(roll, FIRST_ROOM_GUARANTEED_RARITY_WEIGHTS);
}

/** One shared rarity-aware multiplier for displayed power and live affixes. */
export function getGearEnhancementMultiplier(
  rarity: GearRarity,
  enhancement: number,
): number {
  const normalizedEnhancement = clamp(
    Number.isFinite(enhancement) ? Math.floor(enhancement) : 0,
    0,
    MAX_GEAR_ENHANCEMENT,
  );
  return 1 + normalizedEnhancement * GEAR_ENHANCEMENT_EFFECT_PER_STAGE[rarity];
}

/**
 * Resolves a drop rarity from a normalized roll. Loot discovery is capped at
 * 100% and only moves at most eight percentage points out of common gear into
 * magic through epic. It deliberately never inflates legendary, mythic, or
 * cosmic odds. Levels 1 through 19 bypass source and loot-discovery modifiers
 * so their onboarding distribution remains exact; level 20 restores them.
 */
export function rollGearDropRarity(
  roll: number,
  source: GearDropSource,
  gearFindPercent = 0,
  playerLevel = GEAR_EARLY_RARITY_LEVEL_CUTOFF,
): GearRarity {
  if (normalizedLevel(playerLevel) < GEAR_EARLY_RARITY_LEVEL_CUTOFF) {
    return rarityFromWeights(roll, GEAR_EARLY_LEVEL_RARITY_WEIGHTS);
  }
  const base = GEAR_DROP_RARITY_WEIGHTS[source];
  const weights: Record<GearRarity, number> = { ...base };
  const totalWeight = GEAR_RARITIES.reduce(
    (total, rarity) => total + weights[rarity],
    0,
  );
  const cappedGearFind = clamp(
    Number.isFinite(gearFindPercent) ? gearFindPercent : 0,
    0,
    100,
  );
  const upgradeBudget = Math.min(
    weights.common,
    cappedGearFind * totalWeight * 0.0008,
  );
  weights.common -= upgradeBudget;
  weights.magic += upgradeBudget * 0.25;
  weights.superior += upgradeBudget * 0.35;
  weights.rare += upgradeBudget * 0.3;
  weights.epic += upgradeBudget * 0.1;

  return rarityFromWeights(roll, weights);
}

const hashString = (value: string): number => {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  hash ^= hash >>> 16;
  return hash >>> 0;
};

export const seedToUint32 = (seed: GearSeed): number =>
  hashString(`${typeof seed}:${String(seed)}`);

/** Mulberry32: compact, platform-stable, and sufficient for deterministic loot. */
export function createSeededRng(seed: GearSeed): () => number {
  let state = seedToUint32(seed);
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

const randomIndex = (rng: () => number, length: number) =>
  Math.min(length - 1, Math.floor(rng() * length));

/**
 * Deterministically rolls a fresh drop level from character level, independent
 * of room count. Normal and elite loot retain the symmetric ±5 band. Boss loot
 * rolls an inclusive +5 through +10 bonus, then respects the level-999 ceiling.
 */
export function rollGearDropLevel(
  seed: GearSeed,
  playerLevel: number,
  source: GearDropSource = "normal",
): number {
  const centerLevel = normalizedLevel(playerLevel);
  const rng = createSeededRng(`${String(seed)}|drop-level|${centerLevel}`);

  if (source === "boss") {
    const bonus =
      GEAR_BOSS_DROP_LEVEL_MIN_BONUS +
      randomIndex(
        rng,
        GEAR_BOSS_DROP_LEVEL_MAX_BONUS -
          GEAR_BOSS_DROP_LEVEL_MIN_BONUS +
          1,
      );
    return Math.min(999, centerLevel + bonus);
  }

  const minimumLevel = Math.max(1, centerLevel - GEAR_DROP_LEVEL_RADIUS);
  const maximumLevel = Math.min(999, centerLevel + GEAR_DROP_LEVEL_RADIUS);
  return minimumLevel + randomIndex(rng, maximumLevel - minimumLevel + 1);
}

const roundValue = (value: number) => Math.max(1, Math.round(value));

export function gearIconIndex(slot: EquipmentSlot, baseName: string): number {
  const baseRow = GEAR_BASE_NAMES[slot].indexOf(baseName);
  const safeRow = baseRow >= 0 ? baseRow : 0;
  return safeRow * GEAR_ICON_COLUMNS + EQUIPMENT_SLOTS.indexOf(slot);
}

export function gearIconCell(iconIndex: number): { column: number; row: number } {
  const safeIndex = Number.isFinite(iconIndex)
    ? clamp(Math.floor(iconIndex), 0, GEAR_ICON_COLUMNS * GEAR_ICON_ROWS - 1)
    : 0;
  return {
    column: safeIndex % GEAR_ICON_COLUMNS,
    row: Math.floor(safeIndex / GEAR_ICON_COLUMNS),
  };
}

function formatGearAffixMagnitude(
  stat: GearAffixStat,
  value: number,
): string {
  const numericValue = Number.isFinite(value) ? Math.abs(value) : 0;
  return GEAR_AFFIX_DEFINITIONS[stat].integerRoll
    ? Math.round(numericValue).toLocaleString("ko-KR")
    : formatGearNumericValue(numericValue);
}

export function formatGearAffix(stat: GearAffixStat, value: number): string {
  const definition = GEAR_AFFIX_DEFINITIONS[stat];
  const numericValue = Number.isFinite(value) ? Math.abs(value) : 0;
  const amount = formatGearAffixMagnitude(stat, numericValue);
  const sign = numericValue < 0.005 ? "+" : definition.sign;
  return `${definition.name} ${sign}${amount}${definition.unit === "percent" ? "%" : ""}`;
}

/**
 * Stable two-decimal formatter shared by every equipment surface. It also
 * normalizes `-0` so tiny floating-point residue never appears as `-0.00`.
 */
export function formatGearNumericValue(value: number): string {
  const finiteValue = Number.isFinite(value) ? value : 0;
  const normalizedValue = Math.abs(finiteValue) < 0.005 ? 0 : finiteValue;
  return normalizedValue.toLocaleString("ko-KR", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
    useGrouping: true,
  });
}

/**
 * Keeps equipment copy compact while preserving up to two decimal places.
 * Domain values remain two-decimal strings for calculations and tests; only
 * redundant trailing zeroes are removed from player-facing option lines.
 */
export function formatCompactGearLabel(label: string): string {
  return label
    .replace(/(\d[\d,]*)\.00(?=%p?|$)/g, "$1")
    .replace(/(\d[\d,]*\.\d)0(?=%p?|$)/g, "$1");
}

export function normalizeGearEnhancement(value: number): number {
  return Number.isSafeInteger(value)
    ? clamp(value, 0, MAX_GEAR_ENHANCEMENT)
    : 0;
}

/** Enhancement belongs to presentation, never the canonical rolled name. */
export function formatGearDisplayName(
  item: Pick<GearItem, "displayName" | "enhancement">,
  options: { includeZero?: boolean } = {},
): string {
  const enhancement = normalizeGearEnhancement(item.enhancement);
  return enhancement > 0 || options.includeZero
    ? `${item.displayName} +${enhancement}`
    : item.displayName;
}

/**
 * Additional options are fate-locked when the item drops. Keep this helper for
 * callers and legacy integrations, but enhancement deliberately never changes
 * the rolled value.
 */
export function getEnhancedGearAffixValue(
  _item: Pick<GearItem, "rarity" | "enhancement">,
  affix: Pick<GearAffix, "value">,
): number {
  void _item;
  return affix.value;
}

/** Formats the fixed additional-option value that combat formulas consume. */
export function formatEnhancedGearAffix(
  item: Pick<GearItem, "rarity" | "enhancement">,
  affix: Pick<GearAffix, "stat" | "value">,
): string {
  return formatGearAffix(
    affix.stat,
    getEnhancedGearAffixValue(item, affix),
  );
}

export type GearAffixDisplay = {
  /** Current fixed magnitude. */
  totalValue: number;
  /** Rolled magnitude stored in the save. */
  baseValue: number;
  /** Always zero because additional options never enhance. */
  enhancementValue: number;
  /** Always zero because additional options never enhance. */
  nextStageGainValue: number;
  totalLabel: string;
  baseLabel: string;
  enhancementLabel: string;
  nextStageGainLabel: string;
};

const roundGearDisplayValue = (value: number): number => {
  const rounded = Math.round((Number.isFinite(value) ? value : 0) * 100) / 100;
  return Object.is(rounded, -0) ? 0 : rounded;
};

const formatGearAffixContribution = (
  stat: GearStat,
  value: number,
  percentPoint = false,
): string => {
  const definition =
    stat === "attackPowerFlat"
      ? ({ unit: "flat", sign: "+" } as const)
      : GEAR_AFFIX_DEFINITIONS[stat];
  const unit = definition.unit === "percent" ? (percentPoint ? "%p" : "%") : "";
  const numericValue = Number.isFinite(value) ? Math.abs(value) : 0;
  const sign = numericValue < 0.005 ? "+" : definition.sign;
  const amount =
    stat !== "attackPowerFlat" && GEAR_AFFIX_DEFINITIONS[stat].integerRoll
      ? formatGearAffixMagnitude(stat, numericValue)
      : formatGearNumericValue(numericValue);
  return `${sign}${amount}${unit}`;
};

/**
 * Gives every tooltip one canonical view of the fate-locked additional roll.
 */
export function getGearAffixDisplay(
  affix: Pick<GearAffix, "stat" | "value">,
  _item: Pick<GearItem, "rarity" | "enhancement">,
): GearAffixDisplay {
  void _item;
  const baseValue = roundGearDisplayValue(Math.abs(affix.value));
  const totalValue = baseValue;
  const enhancementValue = 0;
  const nextStageGainValue = 0;

  return {
    totalValue,
    baseValue,
    enhancementValue,
    nextStageGainValue,
    totalLabel: formatGearAffix(affix.stat, totalValue),
    baseLabel: `획득 수치 ${formatGearAffixContribution(affix.stat, baseValue)}`,
    enhancementLabel: "강화 영향 없음",
    nextStageGainLabel: "고정",
  };
}

export function gearDisplayName(
  slot: EquipmentSlot,
  rarity: GearRarity,
  baseName: string,
): string {
  if (rarity === "legendary") {
    return `${LEGENDARY_POWERS[LEGENDARY_POWER_BY_SLOT[slot]].name} · ${baseName}`;
  }
  if (rarity === "mythic") {
    return `태초의 ${LEGENDARY_POWERS[LEGENDARY_POWER_BY_SLOT[slot]].name} · ${baseName}`;
  }
  if (rarity === "cosmic") {
    return `우주의 ${LEGENDARY_POWERS[LEGENDARY_POWER_BY_SLOT[slot]].name} · ${baseName}`;
  }
  const prefix = RARITY_NAME_PREFIX[rarity];
  return prefix ? `${prefix} ${baseName}` : baseName;
}

function chooseRarity(rng: () => number, level: number): GearRarity {
  if (level < GEAR_EARLY_RARITY_LEVEL_CUTOFF) {
    return rarityFromWeights(rng(), GEAR_EARLY_LEVEL_RARITY_WEIGHTS);
  }
  const progress = Math.min(1, Math.max(0, level - 1) / 150);
  const weights: Record<GearRarity, number> = {
    ...GEAR_DROP_RARITY_WEIGHTS.normal,
  };
  const total = GEAR_RARITIES.reduce((sum, rarity) => sum + weights[rarity], 0);
  const upgradeBudget = Math.min(weights.common, progress * total * 0.08);
  weights.common -= upgradeBudget;
  weights.magic += upgradeBudget * 0.25;
  weights.superior += upgradeBudget * 0.35;
  weights.rare += upgradeBudget * 0.3;
  weights.epic += upgradeBudget * 0.1;
  let roll = rng() * total;
  for (const rarity of GEAR_RARITIES) {
    roll -= weights[rarity];
    if (roll <= 0) return rarity;
  }
  return "cosmic";
}

/**
 * Direct boss-DPS options shared by legendary, mythic, and cosmic gear use
 * non-overlapping rarity bands. A perfect legendary roll can therefore never
 * tie or beat even the lowest mythic roll at the same item level, and the same
 * invariant holds between mythic and cosmic.
 */
const THREE_TIER_DIRECT_DPS_AFFIX_STATS = new Set<GearAffixStat>([
  "damagePercent",
  "attackSpeedPercent",
  "critChancePercent",
  "critDamagePercent",
  "eliteDamagePercent",
  "bossDamagePercent",
  "executeDamagePercent",
]);

/** Exact pre-band curve retained solely for persisted-item migration. */
function legacyAffixValueForRollPercent(
  stat: GearAffixStat,
  level: number,
  rarity: GearRarity,
  rollPercent: number,
): number {
  const definition = GEAR_AFFIX_DEFINITIONS[stat];
  const levelBonus = Math.max(0, level - 1) * definition.perLevel;
  const percentile = (clamp(Math.round(rollPercent), 1, 100) - 1) / 99;
  const raw =
    definition.minValue +
    (definition.maxValue - definition.minValue) * percentile +
    levelBonus;
  return roundValue(
    Math.min(definition.cap, raw * RARITY_AFFIX_MULTIPLIER[rarity]),
  );
}

export function affixValueForRollPercent(
  stat: GearAffixStat,
  level: number,
  rarity: GearRarity,
  rollPercent: number,
): number {
  const normalizedRoll = clamp(Math.round(rollPercent), 1, 100);
  const percentile = (normalizedRoll - 1) / 99;

  if (
    THREE_TIER_DIRECT_DPS_AFFIX_STATS.has(stat) &&
    (rarity === "mythic" || rarity === "cosmic")
  ) {
    const definition = GEAR_AFFIX_DEFINITIONS[stat];
    const legendaryMinimum = legacyAffixValueForRollPercent(
      stat,
      level,
      "legendary",
      1,
    );
    const legendaryMaximum = legacyAffixValueForRollPercent(
      stat,
      level,
      "legendary",
      100,
    );
    // Keep percentile quality meaningful even after the old shared hard cap
    // collapses the legendary range at very high item levels.
    const uncappedWidth = Math.max(
      1,
      Math.round(
        (definition.maxValue - definition.minValue) *
          RARITY_AFFIX_MULTIPLIER.legendary,
      ) + 1,
    );
    const bandWidth = Math.max(
      uncappedWidth,
      legendaryMaximum - legendaryMinimum + 1,
    );
    const rarityBand = rarity === "mythic" ? 1 : 2;
    const bandMinimum =
      legendaryMaximum + 1 + (rarityBand - 1) * bandWidth;
    return roundValue(
      bandMinimum + Math.round(percentile * Math.max(0, bandWidth - 1)),
    );
  }

  // Additional projectiles begin at mythic. Cosmic rolls receive their own
  // band above the complete mythic range instead of tying after integer
  // rounding or the legacy shared cap.
  if (stat === "projectileCountFlat" && rarity === "cosmic") {
    const mythicMinimum = legacyAffixValueForRollPercent(
      stat,
      level,
      "mythic",
      1,
    );
    const mythicMaximum = legacyAffixValueForRollPercent(
      stat,
      level,
      "mythic",
      100,
    );
    const bandWidth = Math.max(1, mythicMaximum - mythicMinimum);
    return roundValue(
      mythicMaximum + 1 +
        Math.round(percentile * Math.max(0, bandWidth - 1)),
    );
  }

  return legacyAffixValueForRollPercent(stat, level, rarity, normalizedRoll);
}

export type GearImplicitInput = Pick<
  GearItem,
  "slot" | "level" | "rarity" | "enhancement"
>;

export type GearImplicitDisplay = {
  stat: GearStat;
  label: string;
  totalValue: number;
  baseValue: number;
  enhancementValue: number;
  nextStageGainValue: number;
  totalLabel: string;
  baseLabel: string;
  enhancementLabel: string;
  nextStageGainLabel: string;
};

/**
 * Rarity is expressed once as equivalent item levels. This makes common 100,
 * magic 95, superior 90, rare 85, epic 80, legendary 70, mythic 55, and
 * cosmic 40 share the exact same +0 implicit value.
 */
function gearImplicitTierGrowth(level: number, rarity: GearRarity): number {
  const effectiveTier =
    normalizedLevel(level) + GEAR_RARITY_LEVEL_EQUIVALENT[rarity];
  return 0.25 + 0.75 * Math.pow(effectiveTier / 100, 0.72);
}

/** Deterministic +0 implicit value; never trusted from save or network data. */
export function getGearImplicitBaseValue(item: GearImplicitInput): number {
  const definition = GEAR_IMPLICIT_OPTION_BY_SLOT[item.slot];
  return roundGearDisplayValue(
    definition.valueAtTier100 * gearImplicitTierGrowth(item.level, item.rarity),
  );
}

/** Exact live implicit value after the item's completed enhancement stages. */
export function getEnhancedGearImplicitValue(item: GearImplicitInput): number {
  return roundGearDisplayValue(
    getGearImplicitBaseValue(item) *
      getGearEnhancementMultiplier(item.rarity, item.enhancement),
  );
}

/** Canonical implicit-option presentation shared by every equipment surface. */
export function getGearImplicitDisplay(
  item: GearImplicitInput,
): GearImplicitDisplay {
  const definition = GEAR_IMPLICIT_OPTION_BY_SLOT[item.slot];
  const baseValue = getGearImplicitBaseValue(item);
  const totalValue = getEnhancedGearImplicitValue(item);
  const enhancementValue = roundGearDisplayValue(
    Math.max(0, totalValue - baseValue),
  );
  const normalizedEnhancement = clamp(
    Number.isFinite(item.enhancement) ? Math.floor(item.enhancement) : 0,
    0,
    MAX_GEAR_ENHANCEMENT,
  );
  const nextStageTotal =
    normalizedEnhancement < MAX_GEAR_ENHANCEMENT
      ? getEnhancedGearImplicitValue({
          ...item,
          enhancement: normalizedEnhancement + 1,
        })
      : totalValue;
  const nextStageGainValue = roundGearDisplayValue(
    Math.max(0, nextStageTotal - totalValue),
  );
  const percentPoint =
    definition.stat !== "attackPowerFlat" &&
    GEAR_AFFIX_DEFINITIONS[definition.stat].unit === "percent";
  const formatContribution = (value: number, asPoint = false) =>
    formatGearAffixContribution(definition.stat, value, asPoint);

  return {
    stat: definition.stat,
    label: definition.label,
    totalValue,
    baseValue,
    enhancementValue,
    nextStageGainValue,
    totalLabel: `${definition.label} ${formatContribution(totalValue)}`,
    baseLabel: `+0 ${formatContribution(baseValue)}`,
    enhancementLabel: `강화 ${formatContribution(enhancementValue, percentPoint)}`,
    nextStageGainLabel:
      normalizedEnhancement < MAX_GEAR_ENHANCEMENT
        ? formatContribution(nextStageGainValue, percentPoint)
        : "최대 강화",
  };
}

function rollAffixValue(
  rng: () => number,
  stat: GearAffixStat,
  level: number,
  rarity: GearRarity,
): Pick<GearAffix, "value" | "rollPercent"> {
  const rollPercent = 1 + Math.floor(rng() * 100);
  return {
    value: affixValueForRollPercent(stat, level, rarity, rollPercent),
    rollPercent,
  };
}

function weightedAffixIndex(
  rng: () => number,
  candidates: readonly GearAffixStat[],
): number {
  const totalWeight = candidates.reduce(
    (total, stat) => total + GEAR_AFFIX_DEFINITIONS[stat].rollWeight,
    0,
  );
  let roll = rng() * totalWeight;
  for (let index = 0; index < candidates.length; index += 1) {
    roll -= GEAR_AFFIX_DEFINITIONS[candidates[index]].rollWeight;
    if (roll <= 0) return index;
  }
  return candidates.length - 1;
}

function rollAffixes(
  rng: () => number,
  slot: EquipmentSlot,
  rarity: GearRarity,
  level: number,
): GearAffix[] {
  const candidates = GEAR_AFFIX_DROP_POOL_BY_SLOT[slot].filter((stat) => {
    const minimum = GEAR_AFFIX_DEFINITIONS[stat].minimumDropRarity;
    return minimum === undefined || gearRarityAtLeast(rarity, minimum);
  });
  const affixes: GearAffix[] = [];
  const count = Math.min(GEAR_RARITY_META[rarity].affixCount, candidates.length);

  // Every cosmic item is guaranteed exactly one of the tier's signature
  // options. It consumes an existing affix slot, so save shape and the
  // eight-option cosmic contract remain stable.
  if (rarity === "cosmic" && count > 0) {
    const cosmicCandidates = GEAR_COSMIC_AFFIX_DROP_POOL_BY_SLOT[slot].filter(
      (stat) => {
        const minimum = GEAR_AFFIX_DEFINITIONS[stat].minimumDropRarity;
        return minimum === undefined || gearRarityAtLeast(rarity, minimum);
      },
    );
    const cosmicIndex = weightedAffixIndex(rng, cosmicCandidates);
    const stat = cosmicCandidates[cosmicIndex];
    const { value, rollPercent } = rollAffixValue(rng, stat, level, rarity);
    affixes.push({
      stat,
      value,
      rollPercent,
      label: formatGearAffix(stat, value),
    });
    const regularDuplicateIndex = candidates.indexOf(stat);
    if (regularDuplicateIndex >= 0) candidates.splice(regularDuplicateIndex, 1);
  }

  for (let index = affixes.length; index < count; index += 1) {
    const candidateIndex = weightedAffixIndex(rng, candidates);
    const [stat] = candidates.splice(candidateIndex, 1);
    const { value, rollPercent } = rollAffixValue(rng, stat, level, rarity);
    affixes.push({
      stat,
      value,
      rollPercent,
      label: formatGearAffix(stat, value),
    });
  }

  return affixes;
}

export type PowerScoreInput = Pick<
  GearItem,
  | "slot"
  | "rarity"
  | "level"
  | "affixes"
  | "legendaryPowerId"
  | "enhancement"
>;

/** Recomputes an item's displayed affix quality without trusting save data. */
export function calculateGearQualityScore(
  affixes: readonly Pick<GearAffix, "rollPercent">[],
): number {
  if (affixes.length === 0) return 1;
  const average =
    affixes.reduce((total, affix) => total + affix.rollPercent, 0) /
    affixes.length;
  return clamp(Math.round(average), 1, 100);
}

/**
 * Legacy rarity/level comparison anchor kept separate from combat power.
 * This preserves the requested common 100 = magic 95 = ... = cosmic 40
 * progression without pretending rarity or item level is itself a stat.
 */
export function calculateGearTierRating(
  item: Pick<GearItem, "level" | "rarity">,
): number {
  return (
    normalizedLevel(item.level) + GEAR_RARITY_LEVEL_EQUIVALENT[item.rarity]
  ) * GEAR_POWER_PER_LEVEL;
}

export const BASE_EQUIPMENT_COMBAT_POWER = 1000;

/**
 * Mirrors combat-balance.ts without importing it so this deterministic domain
 * remains standalone for save workers and secure data-URL validation tests.
 */
export const EQUIPMENT_POWER_BASE_ATTACK_DAMAGE = 14;

export type EquipmentCombatPowerBreakdown = {
  total: number;
  offense: number;
  defense: number;
  sustain: number;
  mobility: number;
  utility: number;
  offenseIndex: number;
  defenseIndex: number;
  sustainIndex: number;
  mobilityIndex: number;
  utilityIndex: number;
};

const BASE_CRIT_CHANCE = 0.05;
const BASE_CRIT_MULTIPLIER = 1.7;
const BASE_CRIT_EXPECTATION =
  1 + BASE_CRIT_CHANCE * (BASE_CRIT_MULTIPLIER - 1);
const EQUIPMENT_POWER_BASE_ATTACKS_PER_SECOND = 1.4;
const EQUIPMENT_POWER_EXECUTE_HEALTH_SHARE = 0.2;
export const EQUIPMENT_POWER_REFERENCE_BOSS_HITS_PER_SECOND = 1;
export const EQUIPMENT_POWER_REFERENCE_PICKUPS_PER_SECOND = 1;
const EQUIPMENT_POWER_REFERENCE_DASH_COOLDOWN_SECONDS = 1.35;
const EQUIPMENT_POWER_REFERENCE_DASH_DURATION_SECONDS = 0.17;
const EQUIPMENT_POWER_RIFT_TRAIL_INTERVAL_SECONDS = 0.055;
const EQUIPMENT_POWER_RIFT_TRAIL_TICK_DAMAGE_MULTIPLIER = 0.4;
const EQUIPMENT_POWER_PHANTOM_TRAIL_INTERVAL_SECONDS = 0.4;

const hasPower = (
  powers: ReadonlySet<LegendaryPowerId>,
  powerId: LegendaryPowerId,
): boolean => powers.has(powerId);

/**
 * Equipment power is one deliberately narrow benchmark: sustained damage to
 * one standard boss while every emitted projectile connects. The empty
 * loadout's expected DPS is exactly `BASE_EQUIPMENT_COMBAT_POWER`.
 *
 * This is not an EHP, clear-speed, farming, or handling score. Health,
 * mitigation, recovery, movement, dash utility, pickup/XP/gear find,
 * projectile speed/size/lifetime/homing, and pierce therefore contribute
 * exactly zero. Public breakdown fields remain for save/UI compatibility, but
 * every non-offense component and index is intentionally zero.
 *
 * Triggered offensive legendary powers use stable sustained-fight reference
 * cadences: the boss lands one hit per second, one memory pickup is credited
 * per second, movement trails connect on cooldown, and dash powers are used on
 * cooldown. These assumptions value damage procs without smuggling their
 * defensive, mobility, or utility portions back into the score.
 */
export function calculateCombatPowerFromEquipmentStats(
  stats: Readonly<GearStatTotals>,
  legendaryPowerIds: readonly LegendaryPowerId[] = [],
): EquipmentCombatPowerBreakdown {
  const powers = new Set(legendaryPowerIds);
  const positive = (value: number) =>
    Number.isFinite(value) ? Math.max(0, value) : 0;

  const baseHitDamage =
    (EQUIPMENT_POWER_BASE_ATTACK_DAMAGE + positive(stats.attackPowerFlat)) *
    (1 + positive(stats.damagePercent) / 100);
  const attackRate =
    EQUIPMENT_POWER_BASE_ATTACKS_PER_SECOND *
    (1 + positive(stats.attackSpeedPercent) / 100) *
    (1 + positive(stats.cosmicActionSpeedPercent) / 100);
  const critChance = clamp(
    BASE_CRIT_CHANCE + positive(stats.critChancePercent) / 100,
    0,
    0.75,
  );
  const critMultiplier =
    BASE_CRIT_MULTIPLIER + positive(stats.critDamagePercent) / 100;
  const criticalExpectation = 1 + critChance * (critMultiplier - 1);
  // Runtime converts this count-like stat with Math.floor before firing. Under
  // the all-hit assumption each real extra projectile contributes full DPS.
  const projectilesPerAttack =
    1 + Math.floor(positive(stats.projectileCountFlat));

  let rawSustainedDps =
    baseHitDamage * attackRate * projectilesPerAttack * criticalExpectation;

  if (hasPower(powers, "crescentEcho")) {
    const power = LEGENDARY_POWERS.crescentEcho.parameters;
    rawSustainedDps +=
      baseHitDamage *
      criticalExpectation *
      attackRate *
      ((power.projectileCount * power.damageMultiplier) /
        Math.max(1, power.everyShots));
  }
  if (hasPower(powers, "bloodwovenGrip")) {
    const power = LEGENDARY_POWERS.bloodwovenGrip.parameters;
    const procsPerSecond =
      (attackRate * critChance) / Math.max(1, power.everyCriticalHits);
    rawSustainedDps +=
      baseHitDamage *
      criticalExpectation *
      procsPerSecond *
      power.projectileCount *
      power.damageMultiplier;
  }
  if (hasPower(powers, "mirrorAegis")) {
    const power = LEGENDARY_POWERS.mirrorAegis.parameters;
    rawSustainedDps +=
      baseHitDamage *
      power.damageMultiplier *
      (EQUIPMENT_POWER_REFERENCE_BOSS_HITS_PER_SECOND /
        Math.max(1, power.everyHits));
  }
  if (hasPower(powers, "phantomMarch")) {
    const power = LEGENDARY_POWERS.phantomMarch.parameters;
    rawSustainedDps +=
      (baseHitDamage * power.trailDamageMultiplier) /
      EQUIPMENT_POWER_PHANTOM_TRAIL_INTERVAL_SECONDS;
  }
  if (hasPower(powers, "riftStride")) {
    const power = LEGENDARY_POWERS.riftStride.parameters;
    const dashCooldown =
      EQUIPMENT_POWER_REFERENCE_DASH_COOLDOWN_SECONDS /
      ((1 + positive(stats.dashCooldownPercent) / 100) *
        (1 + positive(power.dashCooldownPercent) / 100));
    rawSustainedDps +=
      (baseHitDamage *
        EQUIPMENT_POWER_RIFT_TRAIL_TICK_DAMAGE_MULTIPLIER *
        Math.max(
          1,
          EQUIPMENT_POWER_REFERENCE_DASH_DURATION_SECONDS /
            EQUIPMENT_POWER_RIFT_TRAIL_INTERVAL_SECONDS,
        )) /
      dashCooldown;
  }
  if (hasPower(powers, "commaResonance")) {
    const power = LEGENDARY_POWERS.commaResonance.parameters;
    const procsPerSecond =
      EQUIPMENT_POWER_REFERENCE_PICKUPS_PER_SECOND /
      Math.max(1, power.everyPickups);
    rawSustainedDps +=
      baseHitDamage *
      power.projectileCount *
      power.damageMultiplier *
      procsPerSecond;
  }

  // Starfall's four-second offensive window exceeds the 1.35-second reference
  // dash cooldown, so sustained on-cooldown play keeps its damage buff active.
  if (hasPower(powers, "starfallMantle")) {
    rawSustainedDps *=
      1 + LEGENDARY_POWERS.starfallMantle.parameters.damagePercent / 100;
  }

  // A standard boss is also an elite-class target in the live resolver.
  rawSustainedDps *= 1 + positive(stats.eliteDamagePercent) / 100;
  if (hasPower(powers, "hunterSigil")) {
    rawSustainedDps *=
      1 + LEGENDARY_POWERS.hunterSigil.parameters.eliteDamagePercent / 100;
  }
  rawSustainedDps *= 1 + positive(stats.bossDamagePercent) / 100;
  rawSustainedDps *= 1 + positive(stats.cosmicFinalDamagePercent) / 100;

  const executeMultiplier =
    1 + positive(stats.executeDamagePercent) / 100;
  const executeFactor =
    executeMultiplier > 1
      ? 1 /
        (1 -
          EQUIPMENT_POWER_EXECUTE_HEALTH_SHARE +
          EQUIPMENT_POWER_EXECUTE_HEALTH_SHARE / executeMultiplier)
      : 1;
  const standardBossDps = rawSustainedDps * executeFactor;
  const emptyLoadoutDps =
    EQUIPMENT_POWER_BASE_ATTACK_DAMAGE *
    EQUIPMENT_POWER_BASE_ATTACKS_PER_SECOND *
    BASE_CRIT_EXPECTATION;
  const offenseIndex = standardBossDps / emptyLoadoutDps;
  const offense = Math.round(BASE_EQUIPMENT_COMBAT_POWER * offenseIndex);

  return {
    total: offense,
    offense,
    defense: 0,
    sustain: 0,
    mobility: 0,
    utility: 0,
    offenseIndex,
    defenseIndex: 0,
    sustainIndex: 0,
    mobilityIndex: 0,
    utilityIndex: 0,
  };
}

/**
 * Single source of truth for both inventory power and live combat. The slot's
 * implicit option receives enhancement; every rolled additional option stays
 * at its original drop value forever.
 */
export function resolveGearItemStats(item: PowerScoreInput): GearStatTotals {
  const totals = createEmptyGearStatTotals();
  const implicit = GEAR_IMPLICIT_OPTION_BY_SLOT[item.slot];
  totals[implicit.stat] += getEnhancedGearImplicitValue(item);
  for (const affix of item.affixes) {
    totals[affix.stat] += affix.value;
  }
  for (const stat of GEAR_STAT_KEYS) {
    totals[stat] = roundGearDisplayValue(totals[stat]);
  }
  return totals;
}

const powerStatsForItem = (item: PowerScoreInput): GearStatTotals =>
  resolveGearItemStats(item);

/**
 * Context-free inventory rating: the item's marginal contribution over an
 * empty equipment baseline. In-slot comparisons use the full-loadout delta
 * functions below instead, so interactions with currently equipped gear count.
 */
export function calculateGearPowerScore(item: PowerScoreInput): number {
  const power = calculateCombatPowerFromEquipmentStats(
    powerStatsForItem(item),
    item.legendaryPowerId ? [item.legendaryPowerId] : [],
  ).total;
  return Math.max(0, power - BASE_EQUIPMENT_COMBAT_POWER);
}

/**
 * Deterministically rolls one complete JSON-safe item. The same seed and
 * normalized options always return structurally equal gear, including base,
 * affix identities, values, and their 1–100 roll percentiles.
 */
export function rollGear(seed: GearSeed, options: RollGearOptions = {}): GearItem {
  const level = normalizedLevel(options.level);
  const forcedSlot = isEquipmentSlot(options.slot) ? options.slot : undefined;
  const forcedRarity = isGearRarity(options.rarity) ? options.rarity : undefined;
  const rng = createSeededRng(
    `${String(seed)}|${level}|${forcedSlot ?? "*"}|${forcedRarity ?? "*"}`,
  );
  const slot = forcedSlot ?? EQUIPMENT_SLOTS[randomIndex(rng, EQUIPMENT_SLOTS.length)];
  const rarity = forcedRarity ?? chooseRarity(rng, level);
  const baseNames = GEAR_BASE_NAMES[slot];
  const baseName = baseNames[randomIndex(rng, baseNames.length)];
  const affixes = rollAffixes(rng, slot, rarity, level);
  const legendaryPowerId =
    rarity === "legendary" || rarity === "mythic" || rarity === "cosmic"
      ? LEGENDARY_POWER_BY_SLOT[slot]
      : null;
  const displayName = gearDisplayName(slot, rarity, baseName);
  const fingerprint = [
    seedToUint32(seed),
    slot,
    rarity,
    level,
    baseName,
    ...affixes.map(
      (affix) => `${affix.stat}:${affix.value}:${affix.rollPercent}`,
    ),
  ].join("|");
  const partial: Omit<GearItem, "id" | "powerScore" | "qualityScore"> = {
    slot,
    rarity,
    level,
    baseName,
    displayName,
    iconIndex: gearIconIndex(slot, baseName),
    affixes,
    legendaryPowerId,
    enhancement: 0,
  };
  return {
    id: `gear-${hashString(fingerprint).toString(36)}`,
    ...partial,
    qualityScore: calculateGearQualityScore(affixes),
    powerScore: calculateGearPowerScore(partial),
  };
}

type AffixValueCurve = (
  stat: GearAffixStat,
  level: number,
  rarity: GearRarity,
  rollPercent: number,
) => number;

function inferAffixRollPercentWithCurve(
  stat: GearAffixStat,
  level: number,
  rarity: GearRarity,
  value: number,
  curve: AffixValueCurve,
): number {
  let bestDelta = Number.POSITIVE_INFINITY;
  const bestRolls: number[] = [];
  for (let rollPercent = 1; rollPercent <= 100; rollPercent += 1) {
    const delta = Math.abs(
      curve(stat, level, rarity, rollPercent) - value,
    );
    if (delta < bestDelta) {
      bestDelta = delta;
      bestRolls.length = 0;
      bestRolls.push(rollPercent);
    } else if (delta === bestDelta) {
      bestRolls.push(rollPercent);
    }
  }
  return clamp(
    Math.round((bestRolls[0] + bestRolls[bestRolls.length - 1]) / 2),
    1,
    100,
  );
}

function inferAffixRollPercent(
  stat: GearAffixStat,
  level: number,
  rarity: GearRarity,
  value: number,
): number {
  return inferAffixRollPercentWithCurve(
    stat,
    level,
    rarity,
    value,
    affixValueForRollPercent,
  );
}

/**
 * Attack speed was accepted on boots by an early save format even though new
 * drops have always treated it as a weapon-only option. Preserve the item and
 * its rolled percentile, but move that obsolete roll to the first available
 * boots mobility option instead of leaving hidden weapon DPS on footwear.
 */
function repairLegacySlotIdentityAffixes(
  affixes: readonly GearAffix[],
  slot: EquipmentSlot,
  rarity: GearRarity,
  level: number,
): GearAffix[] {
  if (
    slot !== "boots" ||
    !affixes.some((affix) => affix.stat === "attackSpeedPercent")
  ) {
    return [...affixes];
  }

  const replacementOrder: readonly GearAffixStat[] = [
    "moveSpeedPercent",
    "dashSpeedPercent",
    "dashCooldownPercent",
    "pickupRadiusPercent",
    "projectileSpeedPercent",
    "damageReductionPercent",
    "maxHpFlat",
    "roomEntryShieldFlat",
  ];
  const usedStats = new Set(affixes.map((affix) => affix.stat));
  usedStats.delete("attackSpeedPercent");

  return affixes.map((affix) => {
    if (affix.stat !== "attackSpeedPercent") return affix;
    const replacementStat = replacementOrder.find(
      (candidate) =>
        GEAR_AFFIX_DROP_POOL_BY_SLOT.boots.includes(candidate) &&
        !usedStats.has(candidate),
    );
    if (!replacementStat) return affix;
    usedStats.add(replacementStat);
    const value = affixValueForRollPercent(
      replacementStat,
      level,
      rarity,
      affix.rollPercent,
    );
    return {
      stat: replacementStat,
      value,
      rollPercent: affix.rollPercent,
      label: formatGearAffix(replacementStat, value),
    };
  });
}

const cosmicAffixStats = new Set<GearAffixStat>(GEAR_COSMIC_AFFIX_STATS);

function makeDeterministicRepairAffix(
  rng: () => number,
  candidates: GearAffixStat[],
  level: number,
  rarity: GearRarity,
): GearAffix | null {
  if (candidates.length === 0) return null;
  const candidateIndex = weightedAffixIndex(rng, candidates);
  const [stat] = candidates.splice(candidateIndex, 1);
  const { value, rollPercent } = rollAffixValue(rng, stat, level, rarity);
  return {
    stat,
    value,
    rollPercent,
    label: formatGearAffix(stat, value),
  };
}

/**
 * Rarity gates were tightened after early local saves already existed. Invalid
 * gated affixes are therefore repaired, never trusted and never allowed to
 * delete the containing item. The item identity makes the replacement stable
 * across every load while the current slot/rarity pools keep it legal.
 */
function repairRarityGatedAffixes(
  affixes: readonly GearAffix[],
  itemId: string,
  slot: EquipmentSlot,
  rarity: GearRarity,
  level: number,
  targetCount: number,
): GearAffix[] | null {
  const rng = createSeededRng(
    `affix-save-repair-v1|${itemId}|${slot}|${rarity}|${level}`,
  );
  const regularCandidates = GEAR_AFFIX_DROP_POOL_BY_SLOT[slot].filter((stat) => {
    const minimum = GEAR_AFFIX_DEFINITIONS[stat].minimumDropRarity;
    return minimum === undefined || gearRarityAtLeast(rarity, minimum);
  });
  const validRegular = affixes.filter(
    (affix) =>
      !cosmicAffixStats.has(affix.stat) &&
      (() => {
        const definition = GEAR_AFFIX_DEFINITIONS[affix.stat];
        const minimum = definition.minimumSaveRarity ?? definition.minimumDropRarity;
        return minimum === undefined || gearRarityAtLeast(rarity, minimum);
      })(),
  );
  const repaired: GearAffix[] = [...validRegular];
  const usedStats = new Set(repaired.map((affix) => affix.stat));

  if (rarity === "cosmic" && targetCount > 0) {
    const existingCosmic = affixes.find((affix) => cosmicAffixStats.has(affix.stat));
    if (existingCosmic) {
      repaired.unshift(existingCosmic);
      usedStats.add(existingCosmic.stat);
    } else {
      const candidates = [...GEAR_COSMIC_AFFIX_DROP_POOL_BY_SLOT[slot]];
      const replacement = makeDeterministicRepairAffix(
        rng,
        candidates,
        level,
        rarity,
      );
      if (!replacement) return null;
      repaired.unshift(replacement);
      usedStats.add(replacement.stat);
    }
  }

  const candidates = regularCandidates.filter((stat) => !usedStats.has(stat));
  while (repaired.length < targetCount) {
    const replacement = makeDeterministicRepairAffix(
      rng,
      candidates,
      level,
      rarity,
    );
    if (!replacement) return null;
    repaired.push(replacement);
    usedStats.add(replacement.stat);
  }
  return repaired.slice(0, targetCount);
}

function normalizeAffixes(
  value: unknown,
  itemId: string,
  slot: EquipmentSlot,
  rarity: GearRarity,
  level: number,
): GearAffix[] | null {
  if (!Array.isArray(value)) return null;
  const expectedCount = GEAR_RARITY_META[rarity].affixCount;
  const legacyCount = rarity === "rare" ? 3 : rarity === "legendary" ? 4 : null;
  if (value.length !== expectedCount && value.length !== legacyCount) return null;

  const usedStats = new Set<GearAffixStat>();
  const parsed: GearAffix[] = [];
  for (const candidate of value) {
    if (!isRecord(candidate) || !isGearAffixStat(candidate.stat)) return null;
    const definition = GEAR_AFFIX_DEFINITIONS[candidate.stat];
    if (
      (!isGearAffixRollableForSlot(slot, candidate.stat) &&
        !definition.legacySlots.includes(slot)) ||
      usedStats.has(candidate.stat)
    ) {
      return null;
    }
    if (
      typeof candidate.value !== "number" ||
      !Number.isSafeInteger(candidate.value) ||
      candidate.value <= 0
    ) {
      return null;
    }
    const stat = candidate.stat;
    const amount = candidate.value;
    const currentMinimum = affixValueForRollPercent(stat, level, rarity, 1);
    const currentMaximum = affixValueForRollPercent(stat, level, rarity, 100);
    const legacyMinimum = legacyAffixValueForRollPercent(stat, level, rarity, 1);
    const legacyMaximum = legacyAffixValueForRollPercent(stat, level, rarity, 100);
    if (
      amount >
      Math.max(definition.cap, currentMaximum, legacyMaximum)
    ) {
      return null;
    }
    const minimumSaveRarity =
      definition.minimumSaveRarity ?? definition.minimumDropRarity;
    const rarityAllowed =
      minimumSaveRarity === undefined ||
      gearRarityAtLeast(rarity, minimumSaveRarity);

    if (!rarityAllowed) {
      // The option is about to be replaced by the deterministic repair pass.
      // Do not evaluate its old value against the new rarity curve: doing so
      // would discard an otherwise healthy legacy item before it can migrate.
      const repairRollPercent =
        typeof candidate.rollPercent === "number" &&
        Number.isSafeInteger(candidate.rollPercent) &&
        candidate.rollPercent >= 1 &&
        candidate.rollPercent <= 100
          ? candidate.rollPercent
          : 1;
      usedStats.add(stat);
      parsed.push({
        stat,
        value: amount,
        rollPercent: repairRollPercent,
        label: formatGearAffix(stat, amount),
      });
      continue;
    }

    let rollPercent: number;
    let normalizedAmount: number;
    if (candidate.rollPercent === undefined) {
      // Legacy saves stored only the rounded value. Use the midpoint of every
      // percentile that can produce it, which avoids pretending a low roll is
      // perfect when several percentiles collapse to the same integer.
      // A missing percentile is itself a legacy-save signature. Prefer the
      // legacy curve when both integer ranges happen to share an endpoint, so
      // an old perfect roll is not misread as a new low roll during migration.
      if (amount >= legacyMinimum && amount <= legacyMaximum) {
        rollPercent = inferAffixRollPercentWithCurve(
          stat,
          level,
          rarity,
          amount,
          legacyAffixValueForRollPercent,
        );
      } else if (amount >= currentMinimum && amount <= currentMaximum) {
        rollPercent = inferAffixRollPercent(stat, level, rarity, amount);
      } else {
        return null;
      }
      normalizedAmount = affixValueForRollPercent(
        stat,
        level,
        rarity,
        rollPercent,
      );
    } else {
      if (
        typeof candidate.rollPercent !== "number" ||
        !Number.isSafeInteger(candidate.rollPercent) ||
        candidate.rollPercent < 1 ||
        candidate.rollPercent > 100
      ) {
        return null;
      }
      const currentAmount = affixValueForRollPercent(
        stat,
        level,
        rarity,
        candidate.rollPercent,
      );
      const legacyAmount = legacyAffixValueForRollPercent(
        stat,
        level,
        rarity,
        candidate.rollPercent,
      );
      if (
        (currentAmount !== amount && legacyAmount !== amount)
      ) {
        return null;
      }
      rollPercent = candidate.rollPercent;
      normalizedAmount = currentAmount;
    }

    usedStats.add(stat);
    parsed.push({
      stat,
      value: normalizedAmount,
      rollPercent,
      label: formatGearAffix(stat, normalizedAmount),
    });
  }
  const slotRepaired = repairLegacySlotIdentityAffixes(
    parsed,
    slot,
    rarity,
    level,
  );
  return repairRarityGatedAffixes(
    slotRepaired,
    itemId,
    slot,
    rarity,
    level,
    value.length,
  );
}

/**
 * Repairs safe derived fields (labels, icon, name, power, quality) while
 * rejecting malformed identity, slot, rarity, base name, or implausible affix
 * data. Legacy affixes without `rollPercent` receive a range-based estimate.
 */
export function normalizeGearItem(value: unknown): GearItem | null {
  if (!isRecord(value)) return null;
  if (typeof value.id !== "string" || value.id.length < 1 || value.id.length > 128) {
    return null;
  }
  if (!isEquipmentSlot(value.slot) || !isGearRarity(value.rarity)) return null;
  if (
    typeof value.level !== "number" ||
    !Number.isSafeInteger(value.level) ||
    value.level < 1 ||
    value.level > 999
  ) {
    return null;
  }
  if (
    typeof value.baseName !== "string" ||
    !GEAR_BASE_NAMES[value.slot].includes(value.baseName)
  ) {
    return null;
  }

  const enhancement = value.enhancement === undefined ? 0 : value.enhancement;
  if (
    typeof enhancement !== "number" ||
    !Number.isSafeInteger(enhancement) ||
    enhancement < 0 ||
    enhancement > MAX_GEAR_ENHANCEMENT
  ) {
    return null;
  }

  const affixes = normalizeAffixes(
    value.affixes,
    value.id,
    value.slot,
    value.rarity,
    value.level,
  );
  if (!affixes) return null;
  const legendaryPowerId =
    value.rarity === "legendary" ||
    value.rarity === "mythic" ||
    value.rarity === "cosmic"
      ? LEGENDARY_POWER_BY_SLOT[value.slot]
      : null;
  const partial: Omit<GearItem, "id" | "powerScore" | "qualityScore"> = {
    slot: value.slot,
    rarity: value.rarity,
    level: value.level,
    baseName: value.baseName,
    displayName: gearDisplayName(value.slot, value.rarity, value.baseName),
    iconIndex: gearIconIndex(value.slot, value.baseName),
    affixes,
    legendaryPowerId,
    enhancement,
  };
  return {
    id: value.id,
    ...partial,
    qualityScore: calculateGearQualityScore(affixes),
    powerScore: calculateGearPowerScore(partial),
  };
}

/** Strict guard for already-canonical gear. Use normalizeGearItem for save data. */
export function isGearItem(value: unknown): value is GearItem {
  if (!isRecord(value)) return false;
  const normalized = normalizeGearItem(value);
  if (!normalized) return false;
  const originalAffixes = value.affixes;
  if (
    value.displayName !== normalized.displayName ||
    value.iconIndex !== normalized.iconIndex ||
    value.legendaryPowerId !== normalized.legendaryPowerId ||
    value.enhancement !== normalized.enhancement ||
    value.qualityScore !== normalized.qualityScore ||
    value.powerScore !== normalized.powerScore ||
    !Array.isArray(originalAffixes) ||
    originalAffixes.length !== normalized.affixes.length
  ) {
    return false;
  }
  return normalized.affixes.every((affix, index) => {
    const original = originalAffixes[index];
    return (
      isRecord(original) &&
      original.stat === affix.stat &&
      original.value === affix.value &&
      original.rollPercent === affix.rollPercent &&
      original.label === affix.label
    );
  });
}

export function createEmptyEquipment(): EquipmentLoadout {
  return {
    weapon: null,
    offhand: null,
    helm: null,
    shoulders: null,
    armor: null,
    gloves: null,
    belt: null,
    legs: null,
    boots: null,
    relic: null,
  };
}

/**
 * Normalizes arbitrary parsed JSON into a complete ten-slot loadout. Invalid
 * or slot-mismatched entries become null; derived item values are recalculated.
 * Legacy five-slot saves retain their existing gear and receive null entries
 * for every newly introduced slot.
 */
export function normalizeEquipment(value: unknown): EquipmentLoadout {
  const equipment = createEmptyEquipment();
  if (!isRecord(value)) return equipment;
  for (const slot of EQUIPMENT_SLOTS) {
    const candidate = normalizeGearItem(value[slot]);
    if (candidate?.slot === slot) equipment[slot] = candidate;
  }
  return equipment;
}

export function createEmptyGearStatTotals(): GearStatTotals {
  return {
    attackPowerFlat: 0,
    damagePercent: 0,
    attackSpeedPercent: 0,
    projectileSpeedPercent: 0,
    maxHpFlat: 0,
    damageReductionPercent: 0,
    moveSpeedPercent: 0,
    dashCooldownPercent: 0,
    pickupRadiusPercent: 0,
    xpGainPercent: 0,
    critChancePercent: 0,
    critDamagePercent: 0,
    projectileSizePercent: 0,
    eliteDamagePercent: 0,
    lifeOnHitFlat: 0,
    gearFindPercent: 0,
    projectileCountFlat: 0,
    pierceFlat: 0,
    projectileLifetimePercent: 0,
    homingStrengthFlat: 0,
    hpRegenPerSecondFlat: 0,
    roomClearHealFlat: 0,
    roomEntryShieldFlat: 0,
    dashSpeedPercent: 0,
    bossDamagePercent: 0,
    executeDamagePercent: 0,
    cosmicFinalDamagePercent: 0,
    cosmicAegisPercent: 0,
    cosmicActionSpeedPercent: 0,
  };
}

/** Aggregates enhanced implicits and fixed additional options for live combat. */
export function aggregateEquipmentStats(
  equipment: EquipmentLoadout,
): GearStatTotals {
  const totals = createEmptyGearStatTotals();
  for (const slot of EQUIPMENT_SLOTS) {
    const item = equipment[slot];
    if (!item) continue;
    const itemStats = resolveGearItemStats(item);
    for (const stat of GEAR_STAT_KEYS) {
      totals[stat] += itemStats[stat];
    }
  }
  for (const stat of GEAR_STAT_KEYS) {
    // Two decimals are enough for combat formulas and keep repeated HUD/save
    // projections stable without allowing floating-point drift to accumulate.
    totals[stat] = Math.round(totals[stat] * 100) / 100;
  }
  return totals;
}

/** Returns the absolute, synergy-aware standard-boss DPS rating of the build. */
export function calculateEquipmentCombatPowerBreakdown(
  equipment: EquipmentLoadout,
): EquipmentCombatPowerBreakdown {
  return calculateCombatPowerFromEquipmentStats(
    aggregateEquipmentStats(equipment),
    equippedLegendaryPowers(equipment),
  );
}

export function calculateEquipmentCombatPower(
  equipment: EquipmentLoadout,
): number {
  return calculateEquipmentCombatPowerBreakdown(equipment).total;
}

/**
 * Exact contextual standard-boss DPS comparison for inventory cards and
 * tooltips. The candidate replaces its own slot before the complete build is
 * rescored, so offensive multiplicative and legendary interactions survive;
 * defensive, sustain, mobility, handling, and utility stats remain zero.
 */
export function calculateEquipmentPowerDelta(
  equipment: EquipmentLoadout,
  candidate: GearItem,
): number {
  const before = calculateEquipmentCombatPower(equipment);
  const afterEquipment: EquipmentLoadout = {
    ...equipment,
    [candidate.slot]: candidate,
  };
  return calculateEquipmentCombatPower(afterEquipment) - before;
}

export function equippedLegendaryPowers(
  equipment: EquipmentLoadout,
): LegendaryPowerId[] {
  return EQUIPMENT_SLOTS.flatMap((slot) => {
    const powerId = equipment[slot]?.legendaryPowerId;
    return powerId ? [powerId] : [];
  });
}
