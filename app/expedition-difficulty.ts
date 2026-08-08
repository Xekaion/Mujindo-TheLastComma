export const EXPEDITION_BASELINE_COMBAT_POWER = 1_000;
export const EXPEDITION_POWER_SCALING_START_ROOM = 8;
export const EXPEDITION_POWER_SCALING_FULL_ROOM = 40;
export const EXPEDITION_MAX_POWER_RATIO = 32;
export const EXPEDITION_MAX_NORMAL_HP_MULTIPLIER = 6;
export const EXPEDITION_MAX_ELITE_HP_MULTIPLIER = 7;
export const EXPEDITION_MAX_BOSS_HP_MULTIPLIER = 8;
export const EXPEDITION_MAX_ENEMY_COUNT_BONUS = 8;
export const EXPEDITION_MAX_NORMAL_ENEMIES = 24;
export const EXPEDITION_MAX_HORDE_ENEMIES = 32;

export type ExpeditionRoomKind =
  | "battle"
  | "horde"
  | "elite"
  | "memory"
  | "shelter"
  | "boss";

export type ExpeditionDifficulty = {
  combatPower: number;
  expectedCombatPower: number;
  powerRatio: number;
  lateGameRamp: number;
  normalHpMultiplier: number;
  eliteHpMultiplier: number;
  bossHpMultiplier: number;
  enemyCountBonus: number;
};

export const BASE_EXPEDITION_DIFFICULTY: Readonly<ExpeditionDifficulty> =
  Object.freeze({
    combatPower: EXPEDITION_BASELINE_COMBAT_POWER,
    expectedCombatPower: EXPEDITION_BASELINE_COMBAT_POWER,
    powerRatio: 1,
    lateGameRamp: 0,
    normalHpMultiplier: 1,
    eliteHpMultiplier: 1,
    bossHpMultiplier: 1,
    enemyCountBonus: 0,
  });

const clamp = (value: number, minimum: number, maximum: number) =>
  Math.min(maximum, Math.max(minimum, value));

const finiteNonNegative = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;

const smoothstep = (value: number) => value * value * (3 - 2 * value);

/**
 * Smooths gear spikes and makes unequipping before a doorway ineffective.
 * Upgrades are adopted over several newly entered combat rooms; power loss is
 * acknowledged much more slowly so a single weak loadout cannot reroll a room.
 */
export function updateExpeditionPowerRating({
  previousRating,
  currentCombatPower,
}: {
  previousRating: number;
  currentCombatPower: number;
}): number {
  const previous = Math.max(
    EXPEDITION_BASELINE_COMBAT_POWER,
    finiteNonNegative(previousRating),
  );
  const current = Math.max(
    EXPEDITION_BASELINE_COMBAT_POWER,
    finiteNonNegative(currentCombatPower),
  );
  const adoptionRate = current >= previous ? 0.22 : 0.04;
  const smoothed = previous + (current - previous) * adoptionRate;
  return Math.round(clamp(smoothed, previous * 0.92, previous * 1.18));
}

/** Expected build growth implied by the expedition's original depth curves. */
export function expectedExpeditionCombatPower(roomsCleared: number): number {
  const safeRooms = Math.floor(finiteNonNegative(roomsCleared));
  const healthDepthScale = Math.pow(1 + 0.075 * safeRooms, 1.28);
  const damageDepthScale = Math.pow(1 + 0.035 * safeRooms, 1.16);
  return Math.round(
    EXPEDITION_BASELINE_COMBAT_POWER *
      (0.65 * Math.pow(healthDepthScale, 0.72) +
        0.27 * Math.pow(damageDepthScale, 0.62) +
        0.08),
  );
}

/**
 * Captures one room's power-linked difficulty. The first boss and early rooms
 * retain their authored balance; later rooms gradually converge on the power
 * target. HP deliberately scales slower than raw damage throughput so an
 * upgrade still feels like an upgrade instead of being cancelled immediately.
 */
export function calculateExpeditionDifficulty({
  roomsCleared,
  combatPower,
  suppressPowerScaling = false,
}: {
  roomsCleared: number;
  combatPower: number;
  suppressPowerScaling?: boolean;
}): ExpeditionDifficulty {
  const safeRooms = Math.floor(finiteNonNegative(roomsCleared));
  const safeCombatPower = Math.max(
    EXPEDITION_BASELINE_COMBAT_POWER,
    Math.floor(finiteNonNegative(combatPower)),
  );
  const expectedCombatPower = expectedExpeditionCombatPower(safeRooms);
  const rampProgress = suppressPowerScaling
    ? 0
    : clamp(
        (safeRooms - EXPEDITION_POWER_SCALING_START_ROOM) /
          (EXPEDITION_POWER_SCALING_FULL_ROOM -
            EXPEDITION_POWER_SCALING_START_ROOM),
        0,
        1,
      );
  const lateGameRamp = smoothstep(rampProgress);
  const powerRatio = clamp(
    safeCombatPower / expectedCombatPower,
    1,
    EXPEDITION_MAX_POWER_RATIO,
  );
  const normalHpMultiplier = Math.min(
    EXPEDITION_MAX_NORMAL_HP_MULTIPLIER,
    Math.pow(powerRatio, 0.58 * lateGameRamp),
  );
  const eliteHpMultiplier = Math.min(
    EXPEDITION_MAX_ELITE_HP_MULTIPLIER,
    Math.pow(powerRatio, 0.68 * lateGameRamp),
  );
  const bossHpMultiplier = Math.min(
    EXPEDITION_MAX_BOSS_HP_MULTIPLIER,
    Math.pow(powerRatio, 0.75 * lateGameRamp),
  );
  const enemyCountBonus = clamp(
    Math.floor(lateGameRamp * Math.log2(powerRatio) * 1.6 + 1e-9),
    0,
    EXPEDITION_MAX_ENEMY_COUNT_BONUS,
  );

  return {
    combatPower: safeCombatPower,
    expectedCombatPower,
    powerRatio,
    lateGameRamp,
    normalHpMultiplier,
    eliteHpMultiplier,
    bossHpMultiplier,
    enemyCountBonus,
  };
}

/** Preserve the original depth curve, then add a bounded late-game power wave. */
export function calculateExpeditionEnemyCount({
  roomsCleared,
  roomKind,
  difficulty,
}: {
  roomsCleared: number;
  roomKind: ExpeditionRoomKind;
  difficulty: Readonly<ExpeditionDifficulty>;
}): number {
  if (roomKind === "shelter") return 0;
  if (roomKind === "boss") return 1;

  const safeRooms = Math.floor(finiteNonNegative(roomsCleared));
  const baseCount = clamp(
    4 + Math.floor(2.15 * Math.sqrt(safeRooms + 1)),
    4,
    16,
  );
  const countBonus = clamp(
    Math.floor(finiteNonNegative(difficulty.enemyCountBonus)),
    0,
    EXPEDITION_MAX_ENEMY_COUNT_BONUS,
  );

  if (roomKind === "horde") {
    return Math.min(
      EXPEDITION_MAX_HORDE_ENEMIES,
      Math.ceil(baseCount * 1.55) + countBonus,
    );
  }
  return Math.min(EXPEDITION_MAX_NORMAL_ENEMIES, baseCount + countBonus);
}

export function expeditionEnemyHpMultiplier(
  difficulty: Readonly<ExpeditionDifficulty>,
  tier: "normal" | "elite" | "boss",
): number {
  const candidate =
    tier === "boss"
      ? difficulty.bossHpMultiplier
      : tier === "elite"
        ? difficulty.eliteHpMultiplier
        : difficulty.normalHpMultiplier;
  const maximum =
    tier === "boss"
      ? EXPEDITION_MAX_BOSS_HP_MULTIPLIER
      : tier === "elite"
        ? EXPEDITION_MAX_ELITE_HP_MULTIPLIER
        : EXPEDITION_MAX_NORMAL_HP_MULTIPLIER;
  return clamp(finiteNonNegative(candidate) || 1, 1, maximum);
}
