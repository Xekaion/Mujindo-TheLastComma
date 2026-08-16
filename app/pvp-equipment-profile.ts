import {
  aggregateEquipmentStats,
  calculateEquipmentCombatPower,
  equippedLegendaryPowers,
  LEGENDARY_POWERS,
  type EquipmentLoadout,
} from "./equipment";
import {
  PVP_BASE_ATTACK_RATE,
  PVP_BASE_CRIT_CHANCE,
  PVP_BASE_CRIT_MULTIPLIER,
  PVP_BASE_DASH_COOLDOWN_MS,
  PVP_BASE_DASH_SPEED,
  PVP_BASE_MOVE_SPEED,
  PVP_BASE_PROJECTILE_COUNT,
  PVP_BASE_PROJECTILE_LIFE_MS,
  PVP_BASE_PROJECTILE_RADIUS,
  PVP_BASE_PROJECTILE_SPEED,
  type PvpBuildProfile,
} from "./pvp-protocol";

const PVP_PROFILE_DECIMAL_PLACES = 4;

const roundTo = (value: number, places = PVP_PROFILE_DECIMAL_PLACES) => {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
};

const clamp = (value: number, minimum: number, maximum: number) =>
  Math.max(minimum, Math.min(maximum, value));

/**
 * Projects one canonical loadout onto the equipment-only combat values used by
 * memory duels. These formulas intentionally mirror the expedition runtime:
 * level, augments, professions, and adaptive PVP correction never participate.
 */
export function createPvpEquipmentProfile(
  equipment: EquipmentLoadout,
): PvpBuildProfile {
  const stats = aggregateEquipmentStats(equipment);
  const legendaryPowers = equippedLegendaryPowers(equipment);
  const hasRiftStride = legendaryPowers.includes("riftStride");
  const hasPhantomMarch = legendaryPowers.includes("phantomMarch");

  const moveSpeed =
    PVP_BASE_MOVE_SPEED *
    (1 + stats.moveSpeedPercent / 100) *
    (1 + stats.cosmicActionSpeedPercent / 100);
  const continuousMoveMultiplier = hasPhantomMarch
    ? 1 + LEGENDARY_POWERS.phantomMarch.parameters.moveSpeedPercent / 100
    : 1;
  const dashSpeed =
    PVP_BASE_DASH_SPEED * (1 + stats.dashSpeedPercent / 100);
  const dashCooldownMs =
    PVP_BASE_DASH_COOLDOWN_MS /
    ((1 + stats.dashCooldownPercent / 100) *
      (hasRiftStride
        ? 1 + LEGENDARY_POWERS.riftStride.parameters.dashCooldownPercent / 100
        : 1));
  const attackRate = Math.min(
    12,
    PVP_BASE_ATTACK_RATE *
      (1 + stats.attackSpeedPercent / 100) *
      (1 + stats.cosmicActionSpeedPercent / 100),
  );
  const projectileCount = Math.min(
    9,
    PVP_BASE_PROJECTILE_COUNT +
      Math.max(0, Math.floor(stats.projectileCountFlat)),
  );
  const projectileSpeed =
    PVP_BASE_PROJECTILE_SPEED *
    (1 + stats.projectileSpeedPercent / 100);
  const projectileLifeMs =
    PVP_BASE_PROJECTILE_LIFE_MS *
    (1 + stats.projectileLifetimePercent / 100);
  const projectileRadius =
    PVP_BASE_PROJECTILE_RADIUS *
    (1 + Math.min(150, stats.projectileSizePercent) / 100);
  const critChance = clamp(
    PVP_BASE_CRIT_CHANCE + stats.critChancePercent / 100,
    0,
    0.75,
  );
  const critMultiplier =
    PVP_BASE_CRIT_MULTIPLIER + stats.critDamagePercent / 100;
  const homingStrength = Math.min(
    14,
    Math.max(0, stats.homingStrengthFlat),
  );
  const pierce = Math.max(0, Math.floor(stats.pierceFlat));

  return {
    equipmentPower: Math.round(calculateEquipmentCombatPower(equipment)),
    moveSpeed: roundTo(moveSpeed),
    dashSpeed: roundTo(dashSpeed),
    dashCooldownMs: Math.round(dashCooldownMs),
    attackRate: roundTo(attackRate),
    projectileCount,
    projectileSpeed: roundTo(projectileSpeed),
    projectileLifeMs: Math.round(projectileLifeMs),
    projectileRadius: roundTo(projectileRadius),
    critChance: roundTo(critChance),
    critMultiplier: roundTo(critMultiplier),
    homingStrength: roundTo(homingStrength),
    pierce,
    continuousMoveMultiplier: roundTo(continuousMoveMultiplier),
  };
}
