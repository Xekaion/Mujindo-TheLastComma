/**
 * Versioned, deterministic character conversion used by the stat panel and by
 * external build-comparison tools.  It deliberately has no renderer or DOM
 * dependency: theoretical projectiles and attacks are never reduced to an
 * on-screen rendering budget.
 */
export const BOSS_CONVERSION_VERSION = 1 as const;

export const STANDARD_BOSS_PROFILE = Object.freeze({
  durationSeconds: 60,
  distance: 260,
  radius: 52,
  defense: 0,
  lowHpUptime: 0.2,
  lowHpRatio: 0.35,
  model: "full-health-kill-cycle" as const,
});

export type CombatEvaluationInput = {
  sheetAttackPower: number;
  theoreticalFireRate: number;
  theoreticalProjectileCount: number;
  /** Actual lane count used by the renderer/collision model. */
  projectileGeometryCount?: number;
  critChance: number;
  critMultiplier: number;
  overchargeAverageMultiplier: number;
  /** Averaged HP- and uptime-dependent multiplier for the primary attack. */
  standardPrimaryDamageMultiplier?: number;
  /** Global final-damage multiplier applied once to every player damage source. */
  finalDamageMultiplier?: number;
  /** Total angle occupied by a volley, in degrees. */
  projectileSpread?: number;
  /** Explicit alias used by the live stat snapshot. Takes precedence. */
  projectileSpreadDegrees?: number;
  projectileRadius: number;
  projectileSpeed: number;
  projectileRange: number;
  /** Homing turn strength in radians per second; zero means no homing. */
  homing: number;
  bossMultiplier: number;
  executeThreshold: number;
  executeMultiplier: number;
  /** Extra primary-hit DPS as a fraction of primary DPS (0.2 = 20%). */
  timeEchoBonus: number;
  /** Dedicated echo-projectile accuracy; defaults to primary accuracy. */
  timeEchoHitRate?: number;
  /** Returning-projectile DPS as a fraction of primary DPS. */
  returnBonus: number;
  /** Expected applied poison DPS before boss and execution multipliers. */
  poisonDps: number;
  legendaryProcBonusDps: number;
  threeTargetDps: number;
  survivalBudget: number;
  moveSpeed: number;
  dashCooldown: number;
  dashDistance: number;
};

export type StandardBossBreakdown = {
  standardDistance: number;
  standardRadius: number;
  standardDefense: number;
  primaryDps: number;
  timeEchoDps: number;
  returnDps: number;
  poisonDps: number;
  legendaryProcDps: number;
  totalDps: number;
};

export type CombatEvaluationRatings = {
  sheetAttackPower: number;
  statAttackDps: number;
  standardBossDps: number;
  standardBossDamage60: number;
  combatPower: number;
  hitRate: number;
  executeFactor: number;
  bossBreakdown: StandardBossBreakdown;
  version: typeof BOSS_CONVERSION_VERSION;
};

const MAX_MAGNITUDE = 1_000_000_000;
const MAX_PROJECTILES_FOR_GEOMETRY = 1_000_000;

const clamp = (value: number, minimum: number, maximum: number) =>
  Math.min(maximum, Math.max(minimum, value));

const finiteNumber = (value: unknown, fallback = 0) =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

const finitePositive = (value: unknown, fallback = 0, maximum = MAX_MAGNITUDE) =>
  clamp(finiteNumber(value, fallback), 0, maximum);

const finiteMultiplier = (value: unknown, fallback = 1) =>
  clamp(finiteNumber(value, fallback), 0, 10_000);

/**
 * Counts the theoretical volley lanes intersecting the standard boss.  This is
 * an arithmetic count rather than a render loop, so a wide theoretical volley
 * is not silently capped to the number of sprites the client happens to draw.
 */
const geometricVolleyHitRate = (
  projectileCount: number,
  spreadRadians: number,
  hitHalfAngle: number,
) => {
  const lanes = clamp(
    Math.max(1, Math.round(projectileCount)),
    1,
    MAX_PROJECTILES_FOR_GEOMETRY,
  );
  if (lanes === 1 || spreadRadians <= Number.EPSILON) return 1;
  if (hitHalfAngle >= spreadRadians / 2) return 1;

  const step = spreadRadians / (lanes - 1);
  const firstLane = Math.max(
    0,
    Math.ceil((spreadRadians / 2 - hitHalfAngle) / step - 1e-12),
  );
  const lastLane = Math.min(
    lanes - 1,
    Math.floor((spreadRadians / 2 + hitHalfAngle) / step + 1e-12),
  );
  return lastLane < firstLane ? 0 : (lastLane - firstLane + 1) / lanes;
};

/**
 * Static-boss accuracy model. Size determines the physical collision angle;
 * homing can bend outer volley lanes inward; speed and range model whether a
 * geometrically valid projectile arrives reliably during the encounter.
 */
export const calculateStandardBossHitRate = (
  input: Pick<
    CombatEvaluationInput,
    | "theoreticalProjectileCount"
    | "projectileGeometryCount"
    | "projectileSpread"
    | "projectileSpreadDegrees"
    | "projectileRadius"
    | "projectileSpeed"
    | "projectileRange"
    | "homing"
  >,
) => {
  const projectileCount = finitePositive(
    input.projectileGeometryCount ?? input.theoreticalProjectileCount,
  );
  if (projectileCount <= 0) return 0;

  const spreadDegrees = finitePositive(
    input.projectileSpreadDegrees ?? input.projectileSpread,
    0,
    360,
  );
  const spreadRadians = (spreadDegrees * Math.PI) / 180;
  const radius = finitePositive(input.projectileRadius, 0, 10_000);
  const speed = finitePositive(input.projectileSpeed);
  const range = finitePositive(input.projectileRange);
  const homing = finitePositive(input.homing, 0, 100);

  const collisionRatio = clamp(
    (STANDARD_BOSS_PROFILE.radius + radius) / STANDARD_BOSS_PROFILE.distance,
    0,
    1,
  );
  const collisionHalfAngle = Math.asin(collisionRatio);
  const homingCompletion = 1 - Math.exp(-homing * 0.22);
  const homingCorrection = (spreadRadians / 2) * homingCompletion;
  const geometricRate = geometricVolleyHitRate(
    projectileCount,
    spreadRadians,
    collisionHalfAngle + homingCorrection,
  );

  // Strictly monotone while below its asymptote, without an arbitrary FPS or
  // sprite-count cap. At the live baseline speed (660 px/s) this is ~95.8%.
  const speedReliability =
    1 - Math.exp(-speed / (STANDARD_BOSS_PROFILE.distance * 0.8));
  const rangeReliability = clamp(
    range / STANDARD_BOSS_PROFILE.distance,
    0,
    1,
  );

  return clamp(geometricRate * speedReliability * rangeReliability, 0, 1);
};

export const calculateExecuteFactor = (
  executeThreshold: number,
  executeMultiplier: number,
) => {
  const threshold = clamp(finiteNumber(executeThreshold), 0, 1);
  const multiplier = Math.max(1, finiteMultiplier(executeMultiplier));
  return 1 / ((1 - threshold) + threshold / multiplier);
};

/** Calculate the version-1 full-health kill-cycle boss conversion rating. */
export const calculateCombatEvaluation = (
  input: CombatEvaluationInput,
): CombatEvaluationRatings => {
  const sheetAttackPower = finitePositive(input.sheetAttackPower);
  const fireRate = finitePositive(input.theoreticalFireRate, 0, 1_000_000);
  const projectileCount = finitePositive(
    input.theoreticalProjectileCount,
    0,
    1_000_000,
  );
  const critChance = clamp(finiteNumber(input.critChance), 0, 1);
  const critMultiplier = Math.max(1, finiteMultiplier(input.critMultiplier));
  const overchargeAverageMultiplier = finiteMultiplier(
    input.overchargeAverageMultiplier,
  );
  const standardPrimaryDamageMultiplier = finiteMultiplier(
    input.standardPrimaryDamageMultiplier ?? 1,
  );
  const finalDamageMultiplier = finiteMultiplier(
    input.finalDamageMultiplier ?? 1,
  );
  const expectedCriticalMultiplier =
    1 + critChance * (critMultiplier - 1);

  const preFinalStatAttackDps =
    sheetAttackPower *
    fireRate *
    projectileCount *
    expectedCriticalMultiplier *
    overchargeAverageMultiplier *
    standardPrimaryDamageMultiplier;
  const statAttackDps = preFinalStatAttackDps * finalDamageMultiplier;
  const hitRate = calculateStandardBossHitRate(input);
  const executeFactor = calculateExecuteFactor(
    input.executeThreshold,
    input.executeMultiplier,
  );
  const bossMultiplier = finiteMultiplier(input.bossMultiplier);
  const bossScale = bossMultiplier * executeFactor;
  const primaryDps = statAttackDps * hitRate * bossScale;
  const timeEchoHitRate =
    input.timeEchoHitRate === undefined
      ? hitRate
      : clamp(finiteNumber(input.timeEchoHitRate), 0, 1);
  const timeEchoDps =
    statAttackDps *
    timeEchoHitRate *
    bossScale *
    finitePositive(input.timeEchoBonus, 0, 100);
  const returnDps = primaryDps * finitePositive(input.returnBonus, 0, 100);
  const poisonDps =
    finitePositive(input.poisonDps) * finalDamageMultiplier * bossScale;
  const legendaryProcDps =
    finitePositive(input.legendaryProcBonusDps) * finalDamageMultiplier * bossScale;
  const standardBossDps =
    primaryDps + timeEchoDps + returnDps + poisonDps + legendaryProcDps;

  const threeTargetDps =
    finitePositive(input.threeTargetDps) * finalDamageMultiplier;
  const generalDps =
    0.35 * statAttackDps +
    0.45 * standardBossDps +
    0.2 * threeTargetDps;
  const survivalBudget = finitePositive(input.survivalBudget);
  const moveSpeed = finitePositive(input.moveSpeed);
  const dashCooldown = clamp(
    finiteNumber(input.dashCooldown, 1.35),
    0.05,
    MAX_MAGNITUDE,
  );
  const dashDistance = finitePositive(input.dashDistance);
  const mobility =
    Math.sqrt(moveSpeed / 245) *
    Math.pow(1.35 / dashCooldown, 0.18) *
    Math.pow(dashDistance / (900 * 0.17), 0.1);
  const combatPower = Math.round(
    1_000 *
      (0.65 * Math.pow(generalDps / 20.286, 0.72) +
        0.27 * Math.pow(survivalBudget / 100, 0.62) +
        0.08 * Math.pow(mobility, 0.45)),
  );

  const bossBreakdown: StandardBossBreakdown = {
    standardDistance: STANDARD_BOSS_PROFILE.distance,
    standardRadius: STANDARD_BOSS_PROFILE.radius,
    standardDefense: STANDARD_BOSS_PROFILE.defense,
    primaryDps,
    timeEchoDps,
    returnDps,
    poisonDps,
    legendaryProcDps,
    totalDps: standardBossDps,
  };

  return {
    sheetAttackPower,
    statAttackDps,
    standardBossDps,
    standardBossDamage60:
      standardBossDps * STANDARD_BOSS_PROFILE.durationSeconds,
    combatPower: Number.isFinite(combatPower) ? combatPower : 0,
    hitRate,
    executeFactor,
    bossBreakdown,
    version: BOSS_CONVERSION_VERSION,
  };
};

/** Descriptive aliases for integration call sites. */
export const calculateCombatEvaluationRatings = calculateCombatEvaluation;
export const evaluateCombatRatings = calculateCombatEvaluation;
