import {
  SIMPLE_AUGMENT_BONUSES,
  clampAugmentStack,
  simpleAugmentMultiplier,
  simpleDefenseDamageMultiplier,
} from "./augment-balance";
import { BASE_PLAYER_ATTACK_DAMAGE } from "./combat-balance";
import {
  GEAR_DROP_BASE_CHANCE,
  GEAR_DROP_CHANCE_CAP,
  GEAR_DROP_SCAVENGER_CHANCE_CAP,
  GEAR_DROP_SCAVENGER_CHANCE_PER_RANK,
  aggregateEquipmentStats,
  calculateEquipmentCombatPowerBreakdown,
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
  resources: {
    hp: number;
    maxHp: number;
    shield: number;
    roomEntryShield: number;
    conquestShieldCap: number;
  };
  offense: {
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
  const rank = (id: string) =>
    effectiveAugmentRank(input.augments, input.profession, id);
  const synergyPower = input.synergies.reduce(
    (sum, synergy) => sum + Math.max(0, synergy.tier) * 0.06,
    0,
  );

  const splitRank = rank("split");
  const theoreticalProjectileCount = 1 + splitRank;
  const renderedProjectileCount = Math.min(9, theoreticalProjectileCount);
  const projectileOverflowFactor =
    theoreticalProjectileCount / renderedProjectileCount;
  const theoreticalFireRate =
    1.4 *
    Math.pow(1 + 0.14 * rank("haste"), 0.7) *
    Math.pow(1 + rank("frenzy") * missingHpRatio * 0.12, 0.65) *
    simpleAugmentMultiplier(
      rank("rapidfire"),
      SIMPLE_AUGMENT_BONUSES.rapidfireAttackSpeedPerRank,
    ) *
    (1 + equipmentStats.attackSpeedPercent / 100);
  const renderedFireRate = Math.min(12, theoreticalFireRate);
  const fireRateOverflowFactor = Math.max(
    1,
    theoreticalFireRate / renderedFireRate,
  );
  const bloodRank = rank("blood");
  const missingHealthBonus =
    bloodRank > 0 ? missingHpRatio * bloodRank * 0.2 : 0;
  const baseAttack = BASE_PLAYER_ATTACK_DAMAGE + equipmentStats.attackPowerFlat;
  const normalProjectileDamage =
    baseAttack *
    (1 + rank("fang") * 0.18) *
    (1 + bloodRank * 0.14 + missingHealthBonus) *
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
    (1 + equipmentStats.damagePercent / 100) *
    projectileOverflowFactor *
    fireRateOverflowFactor;
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
  const executionRank = rank("execution");
  const executeThreshold = Math.min(0.4, 0.12 + executionRank * 0.012);
  const executeMultiplier =
    executionRank > 0
      ? (1.28 + executionRank * 0.04) *
        (1 + synergyTier(input.synergies, "마지막 문장") * 0.12)
      : 1;

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
    );
  const projectileRadius =
    (5 + Math.min(5, rank("fang")) + Math.min(5, caliberRank * 0.55)) *
    (1 + Math.min(150, equipmentStats.projectileSizePercent) / 100) *
    simpleAugmentMultiplier(
      rank("expansion"),
      SIMPLE_AUGMENT_BONUSES.expansionProjectileSizePerRank,
    );
  const homingRank = rank("homing");

  const gearIncomingMultiplier =
    1 - Math.min(0.65, equipmentStats.damageReductionPercent / 100);
  const alwaysIncomingMultiplier =
    gearIncomingMultiplier *
    simpleDefenseDamageMultiplier(rank("defense")) /
    Math.pow(1 + rank("armor") * 0.1, 0.62);
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
  const roomEntryShield = 10 + rank("glass") * 9 + rank("ward") * 5;
  const conquestShieldCap = roomEntryShield + rank("conquest") * 4;

  const moonBeaconTier = synergyTier(input.synergies, "달빛 봉화");
  const bloodNeedleTier = synergyTier(input.synergies, "혈침 순환");
  const regenerationPerSecond = rank("regeneration") * 0.14;
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
      rank("recovery") * SIMPLE_AUGMENT_BONUSES.recoveryRoomHealPerRank) *
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
    (1 + equipmentStats.moveSpeedPercent / 100);
  const dashDuration = 0.17 + 0.075 * (1 - Math.exp(-0.12 * reflexRank));
  const dashSpeed = 900 * Math.pow(1 + reflexRank * 0.05, 0.4);
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

  const specials: PlayerSpecialStat[] = [];
  if (overchargePeriod) {
    specials.push({
      id: "overcharge",
      label: "심홍 과부하",
      value: `${overchargePeriod}번째 일제 사격 ×${overchargeMultiplier.toFixed(2)}`,
      condition: "기본 공격 횟수 기준",
    });
  }
  const timeRank = rank("time");
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
  if (executionRank > 0) {
    specials.push({
      id: "execution",
      label: "처형",
      value: `생명력 ${(executeThreshold * 100).toFixed(1)}% 이하 ×${executeMultiplier.toFixed(2)}`,
      condition: "적 현재 생명력 기준",
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
    resources: {
      hp,
      maxHp,
      shield,
      roomEntryShield,
      conquestShieldCap,
    },
    offense: {
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
      pierce: rank("pierce"),
      homing: homingRank > 0 ? Math.min(10, 1.8 + homingRank * 0.55) : 0,
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
