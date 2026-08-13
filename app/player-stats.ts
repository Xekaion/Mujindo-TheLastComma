import {
  SIMPLE_AUGMENT_BONUSES,
  clampAugmentStack,
  simpleAugmentMultiplier,
  simpleDefenseDamageMultiplier,
} from "./augment-balance";
import { BASE_PLAYER_ATTACK_DAMAGE } from "./combat-balance";
import {
  BOSS_CONVERSION_VERSION,
  STANDARD_BOSS_PROFILE,
  calculateCombatEvaluation,
  type CombatEvaluationRatings,
} from "./combat-evaluation";
import {
  GEAR_DROP_BASE_CHANCE,
  GEAR_DROP_CHANCE_CAP,
  GEAR_DROP_SCAVENGER_CHANCE_CAP,
  GEAR_DROP_SCAVENGER_CHANCE_PER_RANK,
  LEGENDARY_POWERS,
  aggregateEquipmentStats,
  calculateEquipmentCombatPowerBreakdown,
  EQUIPMENT_POWER_REFERENCE_BOSS_HITS_PER_SECOND,
  EQUIPMENT_POWER_REFERENCE_PICKUPS_PER_SECOND,
  equippedLegendaryPowers,
  type EquipmentCombatPowerBreakdown,
  type EquipmentLoadout,
  type GearStatTotals,
  type LegendaryPowerId,
} from "./equipment";
import { effectiveAugmentRank } from "./professions";

export type ActivePlayerSynergy = {
  name: string;
  tier: number;
};

export type PlayerStatsInput = {
  level: number;
  hp: number;
  maxHp: number;
  shield: number;
  shotCounter: number;
  augments: Readonly<Record<string, number>>;
  profession: string | null;
  equipment: EquipmentLoadout;
  synergies: readonly ActivePlayerSynergy[];
  legendaryArmorReady: boolean;
  mirrorAegisHitCount: number;
  mirrorAegisBarrierTime: number;
  starfallMantleTime: number;
  bloodwovenCriticalHits: number;
  bloodwovenBurstReady: boolean;
  ashboundPickupCount: number;
  ashboundShieldRemaining: number;
  ashboundShieldTime: number;
  phantomMarchMoveTime: number;
};

export type PlayerSpecialStat = {
  id: string;
  label: string;
  value: string;
  condition: string;
};

export type PlayerStatSnapshot = {
  context: {
    level: number;
    hpRatio: number;
    missingHpRatio: number;
    lowHp: boolean;
    shielded: boolean;
    rawAugmentStacks: number;
    activeAugmentCount: number;
    activeSynergyCount: number;
    synergyPower: number;
    equippedCount: number;
  };
  equipment: {
    stats: GearStatTotals;
    powers: LegendaryPowerId[];
    power: EquipmentCombatPowerBreakdown;
  };
  ratings: CombatEvaluationRatings & {
    survivalBudget: number;
    threeTargetDps: number;
    conversionLabel: string;
  };
  resources: {
    hp: number;
    maxHp: number;
    shield: number;
    roomEntryShield: number;
    conquestShieldCap: number;
    ashboundPickupCount: number;
    ashboundShieldRemaining: number;
    ashboundShieldTime: number;
  };
  offense: {
    sheetAttackPower: number;
    baseAttack: number;
    normalProjectileDamage: number;
    criticalProjectileDamage: number;
    expectedProjectileDamage: number;
    expectedVolleyDamage: number;
    expectedPrimaryDps: number;
    theoreticalProjectileCount: number;
    renderedProjectileCount: number;
    projectileOverflowFactor: number;
    theoreticalFireRate: number;
    renderedFireRate: number;
    fireRateOverflowFactor: number;
    critChance: number;
    critMultiplier: number;
    eliteMultiplier: number;
    bossMultiplier: number;
    executeThreshold: number;
    executeMultiplier: number;
    overchargePeriod: number | null;
    overchargeMultiplier: number;
    shotsUntilOvercharge: number | null;
  };
  projectile: {
    speed: number;
    lifetime: number;
    approximateRange: number;
    radius: number;
    diameter: number;
    spreadDegrees: number;
    pierce: number;
    homing: number;
    returnDelay: number | null;
    returnDamageMultiplier: number | null;
  };
  defense: {
    rawHitCap: number;
    gearDamageReduction: number;
    alwaysDamageReduction: number;
    lowHpDamageReduction: number;
    shieldDamageReduction: number;
    currentDamageReduction: number;
    currentIncomingMultiplier: number;
    currentEffectiveHp: number;
    fullEffectiveHp: number;
    lowHpActive: boolean;
    shieldDefenseActive: boolean;
    lastMemoryEquipped: boolean;
    lastMemoryReady: boolean;
  };
  sustain: {
    regenerationPerSecond: number;
    equipmentHealPerHit: number;
    leechHealPerHit: number;
    roomClearHeal: number;
    conquestShieldGain: number;
    predatorKillInterval: number | null;
    predatorHeal: number;
  };
  mobility: {
    moveSpeed: number;
    baseMoveSpeed: number;
    moveSpeedIncrease: number;
    dashSpeed: number;
    dashDuration: number;
    dashDistance: number;
    dashCooldown: number;
  };
  utility: {
    xpMultiplier: number;
    memoryFragmentValueMultiplier: number;
    memoryPickupRadius: number;
    memoryAttractionRadius: number;
    gearPickupRadius: number;
    effectiveGearFindPercent: number;
    normalGearDropChance: number;
    eliteGearDropChance: number;
    bossGearDropChance: number;
    bossGearRolls: number;
  };
  specials: PlayerSpecialStat[];
};

const clamp = (value: number, min: number, max: number) =>
  Math.max(min, Math.min(max, value));

const safePositive = (value: number) =>
  Number.isFinite(value) ? Math.max(0, value) : 0;

const synergyTier = (
  synergies: readonly ActivePlayerSynergy[],
  name: string,
) => synergies.find((synergy) => synergy.name === name)?.tier ?? 0;

/**
 * Projects the exact live combat formula into one immutable character record.
 * The combat loop and this projection deliberately share the same caps and
 * nonlinear curves; values that depend on current HP or shield are marked by
 * the snapshot context instead of being presented as permanent sheet stats.
 */
export function calculatePlayerStatSnapshot(
  input: PlayerStatsInput,
): PlayerStatSnapshot {
  const maxHp = Math.max(1, safePositive(input.maxHp));
  const hp = clamp(safePositive(input.hp), 0, maxHp);
  const shield = safePositive(input.shield);
  const hpRatio = hp / maxHp;
  const missingHpRatio = 1 - hpRatio;
  const equipmentStats = aggregateEquipmentStats(input.equipment);
  const equipmentPowers = equippedLegendaryPowers(input.equipment);
  const equipmentPower = calculateEquipmentCombatPowerBreakdown(input.equipment);
  const powerSet = new Set(equipmentPowers);
  const starfallMantleTime = safePositive(input.starfallMantleTime);
  const starfallMantleActive =
    powerSet.has("starfallMantle") && starfallMantleTime > 0;
  const phantomMarchMoveTime = safePositive(input.phantomMarchMoveTime);
  const phantomMarchActive =
    powerSet.has("phantomMarch") &&
    phantomMarchMoveTime >=
      LEGENDARY_POWERS.phantomMarch.parameters.activationSeconds;
  const rank = (id: string) =>
    effectiveAugmentRank(input.augments, input.profession, id);
  const synergyPower = input.synergies.reduce(
    (sum, synergy) => sum + Math.max(0, synergy.tier) * 0.06,
    0,
  );

  const splitRank = rank("split");
  const theoreticalProjectileCount =
    1 + splitRank + Math.max(0, Math.floor(equipmentStats.projectileCountFlat));
  const renderedProjectileCount = Math.min(9, theoreticalProjectileCount);
  const projectileOverflowFactor =
    theoreticalProjectileCount / renderedProjectileCount;
  const unconditionalFireRate =
    1.4 *
    Math.pow(1 + 0.14 * rank("haste"), 0.7) *
    simpleAugmentMultiplier(
      rank("rapidfire"),
      SIMPLE_AUGMENT_BONUSES.rapidfireAttackSpeedPerRank,
    ) *
    (1 + equipmentStats.attackSpeedPercent / 100) *
    (1 + equipmentStats.cosmicActionSpeedPercent / 100);
  const theoreticalFireRate =
    unconditionalFireRate *
    Math.pow(1 + rank("frenzy") * missingHpRatio * 0.12, 0.65);
  const standardBossFireRate =
    unconditionalFireRate *
    (1 - STANDARD_BOSS_PROFILE.lowHpUptime +
      STANDARD_BOSS_PROFILE.lowHpUptime *
        Math.pow(
          1 +
            rank("frenzy") *
              (1 - STANDARD_BOSS_PROFILE.lowHpRatio) *
              0.12,
          0.65,
        ));
  const renderedFireRate = Math.min(12, theoreticalFireRate);
  const fireRateOverflowFactor = Math.max(
    1,
    theoreticalFireRate / renderedFireRate,
  );
  const bloodRank = rank("blood");
  const missingHealthBonus =
    bloodRank > 0 ? missingHpRatio * bloodRank * 0.2 : 0;
  const baseAttack = BASE_PLAYER_ATTACK_DAMAGE + equipmentStats.attackPowerFlat;
  const finalDamageMultiplier =
    1 + equipmentStats.cosmicFinalDamagePercent / 100;
  const sheetAttackPower =
    baseAttack *
    (1 + rank("fang") * 0.18) *
    (1 + bloodRank * 0.14) *
    (1 + rank("ember") * 0.08) *
    (1 + rank("poison") * 0.06) *
    (1 + rank("time") * 0.07) *
    (1 + rank("return") * 0.04) *
    (1 + rank("map") * 0.06) *
    (1 + rank("focus") * 0.025) *
    (1 + rank("caliber") * 0.045) *
    simpleAugmentMultiplier(
      rank("strength"),
      SIMPLE_AUGMENT_BONUSES.strengthDamagePerRank,
    ) *
    (1 + synergyPower) *
    (1 + equipmentStats.damagePercent / 100);
  const normalProjectileDamage =
    sheetAttackPower *
    ((1 + bloodRank * 0.14 + missingHealthBonus) /
      Math.max(0.01, 1 + bloodRank * 0.14)) *
    (starfallMantleActive
      ? 1 + LEGENDARY_POWERS.starfallMantle.parameters.damagePercent / 100
      : 1) *
    projectileOverflowFactor *
    fireRateOverflowFactor *
    finalDamageMultiplier;
  const eyeRank = rank("eye");
  const critChance = clamp(
    0.05 +
      0.45 * (1 - Math.exp(-0.18 * eyeRank)) +
      equipmentStats.critChancePercent / 100,
    0,
    0.75,
  );
  const critMultiplier =
    1.7 + eyeRank * 0.1 + equipmentStats.critDamagePercent / 100;
  const expectedProjectileDamage =
    normalProjectileDamage * (1 + critChance * (critMultiplier - 1));
  const overchargeRank = rank("overcharge");
  const overchargePeriod =
    overchargeRank > 0 ? Math.max(3, 8 - Math.min(5, overchargeRank)) : null;
  const overchargeMultiplier =
    overchargeRank > 0 ? 1.35 + overchargeRank * 0.045 : 1;
  const averageOverchargeMultiplier = overchargePeriod
    ? 1 + (overchargeMultiplier - 1) / overchargePeriod
    : 1;
  const expectedVolleyDamage =
    expectedProjectileDamage *
    renderedProjectileCount *
    averageOverchargeMultiplier;
  const expectedPrimaryDps = expectedVolleyDamage * renderedFireRate;
  const eliteMultiplier =
    Math.pow(1 + rank("giantbane") * 0.15, 0.65) *
    (1 + equipmentStats.eliteDamagePercent / 100) *
    (powerSet.has("hunterSigil") ? 1.18 : 1);
  const bossMultiplier =
    eliteMultiplier * (1 + equipmentStats.bossDamagePercent / 100);
  const executionRank = rank("execution");
  const executeThreshold =
    executionRank > 0
      ? Math.min(0.4, 0.12 + executionRank * 0.012)
      : equipmentStats.executeDamagePercent > 0
        ? 0.2
        : 0;
  const executeMultiplier =
    (executionRank > 0
      ? (1.28 + executionRank * 0.04) *
        (1 + synergyTier(input.synergies, "마지막 문장") * 0.12)
      : 1) *
    (1 + equipmentStats.executeDamagePercent / 100);

  const focusRank = rank("focus");
  const returnRank = rank("return");
  const rangeRank = rank("range");
  const velocityRank = rank("velocity");
  const caliberRank = rank("caliber");
  const projectileSpeed =
    660 *
    Math.pow(1 + focusRank * 0.06, 0.55) *
    simpleAugmentMultiplier(
      velocityRank,
      SIMPLE_AUGMENT_BONUSES.velocityProjectileSpeedPerRank,
    ) *
    (1 + equipmentStats.projectileSpeedPercent / 100);
  const projectileLifetime =
    (1.15 + returnRank * 0.14) *
    Math.pow(1 + focusRank * 0.035, 0.5) *
    simpleAugmentMultiplier(
      rangeRank,
      SIMPLE_AUGMENT_BONUSES.rangeProjectileLifePerRank,
    ) *
    (1 + equipmentStats.projectileLifetimePercent / 100);
  const projectileSizeMultiplier =
    (1 + Math.min(150, equipmentStats.projectileSizePercent) / 100) *
    simpleAugmentMultiplier(
      rank("expansion"),
      SIMPLE_AUGMENT_BONUSES.expansionProjectileSizePerRank,
    );
  const projectileRadius =
    (5 + Math.min(5, rank("fang")) + Math.min(5, caliberRank * 0.55)) *
    projectileSizeMultiplier;
  const homingRank = rank("homing");
  const homingStrength =
    (homingRank > 0 ? Math.min(10, 1.8 + homingRank * 0.55) : 0) +
    equipmentStats.homingStrengthFlat;

  const gearIncomingMultiplier =
    1 - Math.min(0.65, equipmentStats.damageReductionPercent / 100);
  const stableAlwaysIncomingMultiplier =
    gearIncomingMultiplier *
    (1 - Math.min(0.3, equipmentStats.cosmicAegisPercent / 100)) *
    simpleDefenseDamageMultiplier(rank("defense")) /
    Math.pow(1 + rank("armor") * 0.1, 0.62);
  const alwaysIncomingMultiplier =
    stableAlwaysIncomingMultiplier *
    (starfallMantleActive
      ? 1 -
        LEGENDARY_POWERS.starfallMantle.parameters.damageReductionPercent / 100
      : 1);
  const lowHpIncomingMultiplier =
    alwaysIncomingMultiplier /
    Math.pow(1 + rank("resolve") * 0.14, 0.6);
  const shieldIncomingMultiplier =
    alwaysIncomingMultiplier /
    Math.pow(1 + rank("bulwark") * 0.12, 0.55);
  let currentIncomingMultiplier = alwaysIncomingMultiplier;
  if (hpRatio < 0.4) {
    currentIncomingMultiplier /= Math.pow(1 + rank("resolve") * 0.14, 0.6);
  }
  if (shield > 0) {
    currentIncomingMultiplier /= Math.pow(1 + rank("bulwark") * 0.12, 0.55);
  }
  currentIncomingMultiplier = Math.max(0.01, currentIncomingMultiplier);
  const roomEntryShield =
    10 +
    rank("glass") * 9 +
    rank("ward") * 5 +
    equipmentStats.roomEntryShieldFlat;
  const conquestShieldCap = roomEntryShield + rank("conquest") * 4;

  const moonBeaconTier = synergyTier(input.synergies, "달빛 봉화");
  const bloodNeedleTier = synergyTier(input.synergies, "혈침 순환");
  const regenerationPerSecond =
    rank("regeneration") * 0.14 + equipmentStats.hpRegenPerSecondFlat;
  const equipmentHealPerHit = Math.min(
    1.5,
    equipmentStats.lifeOnHitFlat * 0.08,
  );
  const leechRank = rank("leech");
  const leechHealPerHit =
    leechRank > 0
      ? Math.min(0.65, 0.1 + leechRank * 0.03) *
        (1 + bloodNeedleTier * 0.08)
      : 0;
  const roomClearHeal =
    (4 +
      rank("map") * 2 +
      rank("conquest") * 1.2 +
      rank("recovery") * SIMPLE_AUGMENT_BONUSES.recoveryRoomHealPerRank +
      equipmentStats.roomClearHealFlat) *
    (1 + moonBeaconTier * 0.08);
  const conquestShieldGain =
    rank("conquest") * 1.8 * (1 + moonBeaconTier * 0.08);
  const predatorRank = rank("predator");

  const bootsRank = rank("boots");
  const reflexRank = rank("reflex");
  const moveSpeed =
    245 *
    Math.pow(1 + bootsRank * 0.07, 0.55) *
    Math.pow(1 + rank("momentum") * 0.065, 0.55) *
    simpleAugmentMultiplier(
      rank("sprint"),
      SIMPLE_AUGMENT_BONUSES.sprintMoveSpeedPerRank,
    ) *
    (1 + equipmentStats.moveSpeedPercent / 100) *
    (1 + equipmentStats.cosmicActionSpeedPercent / 100) *
    (phantomMarchActive
      ? 1 + LEGENDARY_POWERS.phantomMarch.parameters.moveSpeedPercent / 100
      : 1);
  const dashDuration = 0.17 + 0.075 * (1 - Math.exp(-0.12 * reflexRank));
  const dashSpeed =
    900 *
    Math.pow(1 + reflexRank * 0.05, 0.4) *
    (1 + equipmentStats.dashSpeedPercent / 100);
  const dashCooldown =
    1.35 /
    (Math.pow(1 + bootsRank * 0.08, 0.6) *
      Math.pow(1 + reflexRank * 0.11, 0.55) *
      (1 + equipmentStats.dashCooldownPercent / 100) *
      (powerSet.has("riftStride") ? 1.3 : 1));

  const collectionRangeMultiplier = simpleAugmentMultiplier(
    rank("collection"),
    SIMPLE_AUGMENT_BONUSES.collectionPickupRangePerRank,
  );
  const memoryPickupRadius =
    (38 + rank("magnet") * 42) *
    (1 + equipmentStats.pickupRadiusPercent / 100) *
    collectionRangeMultiplier;
  const gearPickupRadius =
    44 *
    (1 + equipmentStats.pickupRadiusPercent / 100) *
    collectionRangeMultiplier;
  const xpMultiplier =
    (1 + rank("magnet") * 0.08) *
    Math.pow(1 + rank("scholar") * 0.09, 0.7) *
    simpleAugmentMultiplier(
      rank("learning"),
      SIMPLE_AUGMENT_BONUSES.learningXpGainPerRank,
    ) *
    (1 + equipmentStats.xpGainPercent / 100);
  const effectiveGearFindPercent = clamp(
    equipmentStats.gearFindPercent,
    0,
    200,
  );
  const normalDropSourceChance = Math.min(
    GEAR_DROP_SCAVENGER_CHANCE_CAP,
    GEAR_DROP_BASE_CHANCE.normal +
      rank("scavenger") * GEAR_DROP_SCAVENGER_CHANCE_PER_RANK,
  );
  const normalGearDropChance = Math.min(
    GEAR_DROP_CHANCE_CAP.normal,
    normalDropSourceChance * (1 + effectiveGearFindPercent / 100),
  );
  const eliteGearDropChance = Math.min(
    GEAR_DROP_CHANCE_CAP.elite,
    GEAR_DROP_BASE_CHANCE.elite * (1 + effectiveGearFindPercent / 100),
  );

  const timeRank = rank("time");
  const poisonRank = rank("poison");
  const orbitRank = rank("orbit");
  const voidRank = rank("void");
  const starfallUptime = powerSet.has("starfallMantle")
    ? Math.min(
        1,
        LEGENDARY_POWERS.starfallMantle.parameters.durationSeconds /
          Math.max(0.05, dashCooldown),
      )
    : 0;
  const standardStarfallMultiplier =
    1 +
    starfallUptime *
      (LEGENDARY_POWERS.starfallMantle.parameters.damagePercent / 100);
  const standardBloodMultiplier =
    1 +
    STANDARD_BOSS_PROFILE.lowHpUptime *
      (((1 - STANDARD_BOSS_PROFILE.lowHpRatio) * bloodRank * 0.2) /
        Math.max(0.01, 1 + bloodRank * 0.14));
  const standardPrimaryDamageMultiplier =
    standardBloodMultiplier * standardStarfallMultiplier;
  const projectileSpreadDegrees =
    (Math.min(0.62, renderedProjectileCount * 0.07) * 180) / Math.PI;
  // Combat power uses a perfect-execution boss parse: every player projectile
  // is credited as a hit, independent of visual lane count or projectile shape.
  const standardBossHitRate = 1;
  const standardPrimaryHitEventsPerSecond =
    Math.min(12, standardBossFireRate) *
    renderedProjectileCount *
    standardBossHitRate;
  const expectedCriticalMultiplier = 1 + critChance * (critMultiplier - 1);
  const theoreticalStatDps =
    sheetAttackPower *
    standardBossFireRate *
    theoreticalProjectileCount *
    expectedCriticalMultiplier *
    averageOverchargeMultiplier *
    standardPrimaryDamageMultiplier;
  const legendaryBaseDamage =
    baseAttack * (1 + equipmentStats.damagePercent / 100);
  let legendaryProcBonusDps = 0;
  if (powerSet.has("crescentEcho")) {
    legendaryProcBonusDps +=
      sheetAttackPower *
      (standardBossFireRate / LEGENDARY_POWERS.crescentEcho.parameters.everyShots) *
      projectileOverflowFactor *
      LEGENDARY_POWERS.crescentEcho.parameters.projectileCount *
      LEGENDARY_POWERS.crescentEcho.parameters.damageMultiplier *
      expectedCriticalMultiplier *
      averageOverchargeMultiplier *
      standardPrimaryDamageMultiplier;
  }
  if (powerSet.has("bloodwovenGrip")) {
    const power = LEGENDARY_POWERS.bloodwovenGrip.parameters;
    const criticalVolleyHitChance =
      critChance;
    legendaryProcBonusDps +=
      (standardBossFireRate * criticalVolleyHitChance /
        Math.max(1, power.everyCriticalHits)) *
      sheetAttackPower *
      projectileOverflowFactor *
      power.projectileCount *
      power.damageMultiplier *
      expectedCriticalMultiplier *
      averageOverchargeMultiplier *
      standardPrimaryDamageMultiplier;
  }
  if (powerSet.has("phantomMarch")) {
    legendaryProcBonusDps +=
      (legendaryBaseDamage *
        LEGENDARY_POWERS.phantomMarch.parameters.trailDamageMultiplier /
        0.4) *
      standardStarfallMultiplier;
  }
  if (powerSet.has("riftStride")) {
    const dashTriggeredStarfallMultiplier = powerSet.has("starfallMantle")
      ? 1 + LEGENDARY_POWERS.starfallMantle.parameters.damagePercent / 100
      : 1;
    legendaryProcBonusDps +=
      (legendaryBaseDamage *
        0.4 *
        Math.max(1, dashDuration / 0.055) /
        Math.max(0.05, dashCooldown)) *
      dashTriggeredStarfallMultiplier;
  }
  if (powerSet.has("mirrorAegis")) {
    legendaryProcBonusDps +=
      (legendaryBaseDamage *
        LEGENDARY_POWERS.mirrorAegis.parameters.damageMultiplier) /
      (LEGENDARY_POWERS.mirrorAegis.parameters.everyHits /
        EQUIPMENT_POWER_REFERENCE_BOSS_HITS_PER_SECOND) *
      standardStarfallMultiplier;
  }
  if (powerSet.has("commaResonance")) {
    const power = LEGENDARY_POWERS.commaResonance.parameters;
    legendaryProcBonusDps +=
      (legendaryBaseDamage *
        power.projectileCount *
        power.damageMultiplier /
        (Math.max(1, power.everyPickups) /
          EQUIPMENT_POWER_REFERENCE_PICKUPS_PER_SECOND)) *
      standardStarfallMultiplier;
  }
  if (orbitRank > 0) {
    // Orbitals require close positioning; the v1 conversion grants a fixed
    // 25% contact window instead of pretending they hit a 260px target always.
    legendaryProcBonusDps +=
      ((7 + orbitRank * 3) / 0.24) *
      0.25 *
      standardStarfallMultiplier;
  }
  if (voidRank > 0) {
    const cometTier = synergyTier(input.synergies, "혜성 자국");
    const dashTriggeredStarfallMultiplier = powerSet.has("starfallMantle")
      ? 1 + LEGENDARY_POWERS.starfallMantle.parameters.damagePercent / 100
      : 1;
    legendaryProcBonusDps +=
      ((8 + voidRank * 5) *
        (1 + cometTier * 0.28) /
        Math.max(0.05, dashCooldown)) *
      0.65 *
      dashTriggeredStarfallMultiplier;
  }

  const timeEchoBonus =
    timeRank > 0
      ? (0.45 + timeRank * 0.07) /
        Math.max(2, 6 - Math.min(4, timeRank))
      : 0;
  const timeEchoHitRate = timeRank > 0 ? 1 : 0;
  const returnBonus =
    returnRank > 0
      ? 0.45 + returnRank * 0.1
      : 0;
  const poisonApplicationRate =
    poisonRank > 0
      ? 1 - Math.exp(-standardPrimaryHitEventsPerSecond * 5)
      : 0;
  const poisonDps =
    poisonRank > 0
      ? (2 + poisonRank * 1.2) *
        poisonApplicationRate *
        standardStarfallMultiplier
      : 0;
  const stormMultiTarget = 1 - Math.pow(0.8, rank("storm"));
  const ricochetMultiTarget = 1 - Math.pow(0.88, rank("ricochet"));
  const totalPierce = rank("pierce") + Math.max(0, Math.floor(equipmentStats.pierceFlat));
  const threeTargetFactor =
    1 +
    Math.min(
      2,
      totalPierce * 0.32 +
        stormMultiTarget * 0.42 +
        ricochetMultiTarget * 0.32 +
        Math.min(0.35, rank("oil") * 0.035),
    );
  const threeTargetDps = theoreticalStatDps * threeTargetFactor;

  const standardIncomingMultiplier = Math.max(
    0.01,
    stableAlwaysIncomingMultiplier *
      (1 -
        starfallUptime *
          (LEGENDARY_POWERS.starfallMantle.parameters.damageReductionPercent /
            100)) *
      (0.8 +
        0.2 /
          Math.pow(1 + rank("resolve") * 0.14, 0.6)) *
      (roomEntryShield > 0
        ? 0.7 + 0.3 / Math.pow(1 + rank("bulwark") * 0.12, 0.55)
        : 1),
  );
  const lastMemoryReserve = powerSet.has("lastMemory")
    ? maxHp * LEGENDARY_POWERS.lastMemory.parameters.restoreMaxHpRatio
    : 0;
  const ashboundReserve = powerSet.has("ashboundGirdle")
    ? maxHp * LEGENDARY_POWERS.ashboundGirdle.parameters.shieldMaxHpRatio * 0.4
    : 0;
  const baseSurvivalBudget =
    (maxHp + roomEntryShield + lastMemoryReserve + ashboundReserve) /
    standardIncomingMultiplier;
  const standardHealingPerSecond =
    regenerationPerSecond +
    (equipmentHealPerHit + leechHealPerHit) *
      standardPrimaryHitEventsPerSecond +
    roomClearHeal / 30;
  const survivalBudget =
    baseSurvivalBudget +
    Math.min(
      baseSurvivalBudget * 0.5,
      (standardHealingPerSecond * 60) / standardIncomingMultiplier,
    );
  const combatEvaluation = calculateCombatEvaluation({
    sheetAttackPower,
    theoreticalFireRate: standardBossFireRate,
    theoreticalProjectileCount,
    projectileGeometryCount: renderedProjectileCount,
    critChance,
    critMultiplier,
    overchargeAverageMultiplier: averageOverchargeMultiplier,
    standardPrimaryDamageMultiplier,
    finalDamageMultiplier,
    projectileSpreadDegrees,
    projectileRadius,
    projectileSpeed,
    projectileRange: projectileSpeed * projectileLifetime,
    homing: homingStrength,
    bossMultiplier,
    executeThreshold,
    executeMultiplier,
    timeEchoBonus,
    timeEchoHitRate,
    returnBonus,
    poisonDps,
    legendaryProcBonusDps,
    threeTargetDps,
    survivalBudget,
    moveSpeed,
    dashCooldown,
    dashDistance: dashSpeed * dashDuration,
  });
  const ratings: PlayerStatSnapshot["ratings"] = {
    ...combatEvaluation,
    survivalBudget,
    threeTargetDps: threeTargetDps * finalDamageMultiplier,
    conversionLabel: `표준 보스 v${BOSS_CONVERSION_VERSION} · 전탄 적중 지속 DPS`,
  };

  const specials: PlayerSpecialStat[] = [];
  for (const stat of [
    ["cosmicFinalDamagePercent", "우주 최종 피해"],
    ["cosmicAegisPercent", "사건의 지평선 피해 감쇄"],
    ["cosmicActionSpeedPercent", "시공 초월 속도"],
  ] as const) {
    const value = equipmentStats[stat[0]];
    if (value <= 0) continue;
    specials.push({
      id: stat[0],
      label: stat[1],
      value: `+${value.toFixed(2)}%`,
      condition: "우주 장비 전용 추가옵션",
    });
  }
  if (overchargePeriod) {
    specials.push({
      id: "overcharge",
      label: "심홍 과부하",
      value: `${overchargePeriod}번째 일제 사격 ×${overchargeMultiplier.toFixed(2)}`,
      condition: "기본 공격 횟수 기준",
    });
  }
  if (timeRank > 0) {
    specials.push({
      id: "time-echo",
      label: "시간 메아리",
      value: `${Math.max(2, 6 - Math.min(4, timeRank))}번째 공격 · 피해 ${(0.45 + timeRank * 0.07) * 100}%`,
      condition: "추가 투사체",
    });
  }
  if (returnRank > 0) {
    specials.push({
      id: "return",
      label: "귀환",
      value: `0.58초 후 · 피해 ${(0.45 + returnRank * 0.1) * 100}%`,
      condition: "되돌아오는 투사체",
    });
  }
  if (executeThreshold > 0) {
    specials.push({
      id: "execution",
      label: "처형",
      value: `생명력 ${(executeThreshold * 100).toFixed(1)}% 이하 ×${executeMultiplier.toFixed(2)}`,
      condition:
        executionRank > 0 ? "처형 증강·장비 반영" : "장비 처형 추가옵션",
    });
  }
  if (powerSet.has("crescentEcho")) {
    specials.push({
      id: "crescentEcho",
      label: "반월의 메아리",
      value: "5번째 공격마다 피해 65% × 2발",
      condition: "전설 무기",
    });
  }
  if (powerSet.has("mirrorAegis")) {
    const power = LEGENDARY_POWERS.mirrorAegis;
    const barrierTime = safePositive(input.mirrorAegisBarrierTime);
    const hitCount =
      Math.floor(safePositive(input.mirrorAegisHitCount)) %
      power.parameters.everyHits;
    specials.push({
      id: power.id,
      label: power.name,
      value:
        barrierTime > 0
          ? `방벽 ${barrierTime.toFixed(2)}초 · 반사파 ${Math.round(power.parameters.damageMultiplier * 100)}%`
          : `피격 ${hitCount}/${power.parameters.everyHits}`,
      condition:
        barrierTime > 0
          ? "적 투사체 차단 중"
          : `${power.parameters.everyHits - hitCount}회 피격 후 발동`,
    });
  }
  if (powerSet.has("starfallMantle")) {
    const power = LEGENDARY_POWERS.starfallMantle;
    specials.push({
      id: power.id,
      label: power.name,
      value: starfallMantleActive
        ? `주는 피해 +${power.parameters.damagePercent}% · 받는 피해 -${power.parameters.damageReductionPercent}% · ${starfallMantleTime.toFixed(2)}초`
        : `주는 피해 +${power.parameters.damagePercent}% · 받는 피해 -${power.parameters.damageReductionPercent}%`,
      condition: starfallMantleActive ? "별무리 활성" : "회피 직후 발동",
    });
  }
  if (powerSet.has("bloodwovenGrip")) {
    const power = LEGENDARY_POWERS.bloodwovenGrip;
    const criticalHits =
      Math.floor(safePositive(input.bloodwovenCriticalHits)) %
      power.parameters.everyCriticalHits;
    specials.push({
      id: power.id,
      label: power.name,
      value: input.bloodwovenBurstReady
        ? `다음 기본 공격: ${power.parameters.projectileCount}발 × ${Math.round(power.parameters.damageMultiplier * 100)}%`
        : `치명타 ${criticalHits}/${power.parameters.everyCriticalHits}`,
      condition: input.bloodwovenBurstReady
        ? "혈직조 탄환 준비 완료"
        : `${power.parameters.everyCriticalHits - criticalHits}회 치명타 후 준비`,
    });
  }
  if (powerSet.has("ashboundGirdle")) {
    const power = LEGENDARY_POWERS.ashboundGirdle;
    const pickupCount =
      Math.floor(safePositive(input.ashboundPickupCount)) %
      power.parameters.everyPickups;
    const shieldRemaining = safePositive(input.ashboundShieldRemaining);
    const shieldTime = safePositive(input.ashboundShieldTime);
    specials.push({
      id: power.id,
      label: power.name,
      value:
        shieldRemaining > 0 && shieldTime > 0
          ? `보호막 ${shieldRemaining.toFixed(2)} · ${shieldTime.toFixed(2)}초`
          : `기억 조각 ${pickupCount}/${power.parameters.everyPickups}`,
      condition:
        shieldRemaining > 0 && shieldTime > 0
          ? `최대 생명력의 ${Math.round(power.parameters.shieldMaxHpRatio * 100)}% 보호막 활성`
          : `${power.parameters.everyPickups - pickupCount}개 획득 후 발동`,
    });
  }
  if (powerSet.has("phantomMarch")) {
    const power = LEGENDARY_POWERS.phantomMarch;
    specials.push({
      id: power.id,
      label: power.name,
      value: phantomMarchActive
        ? `이동 +${power.parameters.moveSpeedPercent}% · 잔영 피해 ${Math.round(power.parameters.trailDamageMultiplier * 100)}%`
        : `연속 이동 ${Math.min(phantomMarchMoveTime, power.parameters.activationSeconds).toFixed(2)}/${power.parameters.activationSeconds.toFixed(2)}초`,
      condition: phantomMarchActive ? "망각의 행진 활성" : "계속 이동하면 발동",
    });
  }
  if (powerSet.has("commaResonance")) {
    specials.push({
      id: "commaResonance",
      label: "끝나지 않은 쉼표",
      value: "기억 8개마다 피해 75% × 8발",
      condition: "전설 유물",
    });
  }
  if (powerSet.has("riftStride")) {
    specials.push({
      id: "riftStride",
      label: "균열을 밟는 자",
      value: "회피 재사용 효율 ×1.30 · 피해 균열",
      condition: "전설 장화",
    });
  }

  return {
    context: {
      level: Math.max(1, Math.floor(input.level)),
      hpRatio,
      missingHpRatio,
      lowHp: hpRatio < 0.4,
      shielded: shield > 0,
      rawAugmentStacks: Object.values(input.augments).reduce(
        (sum, value) => sum + clampAugmentStack(value),
        0,
      ),
      activeAugmentCount: Object.values(input.augments).filter(
        (value) => clampAugmentStack(value) > 0,
      ).length,
      activeSynergyCount: input.synergies.length,
      synergyPower,
      equippedCount: Object.values(input.equipment).filter(Boolean).length,
    },
    equipment: {
      stats: equipmentStats,
      powers: equipmentPowers,
      power: equipmentPower,
    },
    ratings,
    resources: {
      hp,
      maxHp,
      shield,
      roomEntryShield,
      conquestShieldCap,
      ashboundPickupCount: Math.floor(
        safePositive(input.ashboundPickupCount),
      ),
      ashboundShieldRemaining: safePositive(input.ashboundShieldRemaining),
      ashboundShieldTime: safePositive(input.ashboundShieldTime),
    },
    offense: {
      sheetAttackPower,
      baseAttack,
      normalProjectileDamage,
      criticalProjectileDamage: normalProjectileDamage * critMultiplier,
      expectedProjectileDamage,
      expectedVolleyDamage,
      expectedPrimaryDps,
      theoreticalProjectileCount,
      renderedProjectileCount,
      projectileOverflowFactor,
      theoreticalFireRate,
      renderedFireRate,
      fireRateOverflowFactor,
      critChance,
      critMultiplier,
      eliteMultiplier,
      bossMultiplier,
      executeThreshold,
      executeMultiplier,
      overchargePeriod,
      overchargeMultiplier,
      shotsUntilOvercharge: overchargePeriod
        ? overchargePeriod -
          (Math.max(0, Math.floor(input.shotCounter)) % overchargePeriod)
        : null,
    },
    projectile: {
      speed: projectileSpeed,
      lifetime: projectileLifetime,
      approximateRange: projectileSpeed * projectileLifetime,
      radius: projectileRadius,
      diameter: projectileRadius * 2,
      spreadDegrees:
        (Math.min(0.62, renderedProjectileCount * 0.07) * 180) / Math.PI,
      pierce:
        rank("pierce") + Math.max(0, Math.floor(equipmentStats.pierceFlat)),
      homing: Math.min(14, homingStrength),
      returnDelay: returnRank > 0 ? 0.58 : null,
      returnDamageMultiplier: returnRank > 0 ? 0.45 + returnRank * 0.1 : null,
    },
    defense: {
      rawHitCap: maxHp * 0.4,
      gearDamageReduction: 1 - gearIncomingMultiplier,
      alwaysDamageReduction: 1 - alwaysIncomingMultiplier,
      lowHpDamageReduction: 1 - lowHpIncomingMultiplier,
      shieldDamageReduction: 1 - shieldIncomingMultiplier,
      currentDamageReduction: 1 - currentIncomingMultiplier,
      currentIncomingMultiplier,
      currentEffectiveHp: (hp + shield) / currentIncomingMultiplier,
      fullEffectiveHp: maxHp / currentIncomingMultiplier,
      lowHpActive: hpRatio < 0.4,
      shieldDefenseActive: shield > 0,
      lastMemoryEquipped: powerSet.has("lastMemory"),
      lastMemoryReady:
        powerSet.has("lastMemory") && Boolean(input.legendaryArmorReady),
    },
    sustain: {
      regenerationPerSecond,
      equipmentHealPerHit,
      leechHealPerHit,
      roomClearHeal,
      conquestShieldGain,
      predatorKillInterval:
        predatorRank > 0 ? Math.max(5, 18 - predatorRank) : null,
      predatorHeal: predatorRank > 0 ? 2 + predatorRank * 1.2 : 0,
    },
    mobility: {
      moveSpeed,
      baseMoveSpeed: 245,
      moveSpeedIncrease: moveSpeed / 245 - 1,
      dashSpeed,
      dashDuration,
      dashDistance: dashSpeed * dashDuration,
      dashCooldown,
    },
    utility: {
      xpMultiplier,
      memoryFragmentValueMultiplier: Math.pow(1 + rank("scavenger") * 0.1, 0.75),
      memoryPickupRadius,
      memoryAttractionRadius: memoryPickupRadius * 2.4,
      gearPickupRadius,
      effectiveGearFindPercent,
      normalGearDropChance,
      eliteGearDropChance,
      bossGearDropChance: GEAR_DROP_BASE_CHANCE.boss,
      bossGearRolls: 2,
    },
    specials,
  };
}
