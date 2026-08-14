import {
  LEGENDARY_POWERS,
  aggregateEquipmentStats,
  createEmptyEquipment,
  equippedLegendaryPowers,
  rollGear,
  type EquipmentLoadout,
} from "./equipment";

/** Expedition-compatible plaza dash timing and velocity. */
export const PLAZA_DASH_DURATION_SECONDS = 0.17;
export const PLAZA_DASH_BASE_SPEED = 900;
export const PLAZA_DASH_BASE_COOLDOWN_SECONDS = 1.35;

/** Legendary mobility-power tuning shared with the equipment domain. */
export const PLAZA_STARFALL_SECONDS =
  LEGENDARY_POWERS.starfallMantle.parameters.durationSeconds;
export const PLAZA_PHANTOM_ACTIVATION_SECONDS =
  LEGENDARY_POWERS.phantomMarch.parameters.activationSeconds;
export const PLAZA_PHANTOM_MOVE_MULTIPLIER =
  1 + LEGENDARY_POWERS.phantomMarch.parameters.moveSpeedPercent / 100;
export const PLAZA_RIFT_COOLDOWN_EFFICIENCY_PERCENT =
  LEGENDARY_POWERS.riftStride.parameters.dashCooldownPercent;

/**
 * The normalized save pipeline keeps legitimate values far below this ceiling.
 * The cap only prevents malformed in-memory objects from producing Infinity or
 * an unbounded plaza movement step before the next authoritative correction.
 */
const PLAZA_MOBILITY_PERCENT_CAP = 500;

const finitePercent = (value: number): number =>
  Number.isFinite(value)
    ? Math.min(PLAZA_MOBILITY_PERCENT_CAP, Math.max(0, value))
    : 0;

export type PlazaMobilityProfile = {
  moveSpeedPercent: number;
  cosmicActionSpeedPercent: number;
  dashSpeedPercent: number;
  dashCooldownPercent: number;
  /** Includes both equipment movement speed and cosmic action speed. */
  moveSpeedMultiplier: number;
  dashSpeed: number;
  dashCooldownSeconds: number;
  hasStarfallMantle: boolean;
  hasRiftStride: boolean;
  hasPhantomMarch: boolean;
};

const BASE_PLAZA_MOBILITY_PROFILE: PlazaMobilityProfile = {
  moveSpeedPercent: 0,
  cosmicActionSpeedPercent: 0,
  dashSpeedPercent: 0,
  dashCooldownPercent: 0,
  moveSpeedMultiplier: 1,
  dashSpeed: PLAZA_DASH_BASE_SPEED,
  dashCooldownSeconds: PLAZA_DASH_BASE_COOLDOWN_SECONDS,
  hasStarfallMantle: false,
  hasRiftStride: false,
  hasPhantomMarch: false,
};

/**
 * Resolves the plaza-safe subset of equipped stats and legendary powers.
 * `null` is the explicit no-equipment state used by storage-free QA routes.
 */
export function resolvePlazaMobilityProfile(
  equipment: EquipmentLoadout | null,
): PlazaMobilityProfile {
  if (!equipment) return { ...BASE_PLAZA_MOBILITY_PROFILE };

  try {
    const stats = aggregateEquipmentStats(equipment);
    const powers = new Set(equippedLegendaryPowers(equipment));
    const moveSpeedPercent = finitePercent(stats.moveSpeedPercent);
    const cosmicActionSpeedPercent = finitePercent(
      stats.cosmicActionSpeedPercent,
    );
    const dashSpeedPercent = finitePercent(stats.dashSpeedPercent);
    const dashCooldownPercent = finitePercent(stats.dashCooldownPercent);
    const hasRiftStride = powers.has("riftStride");
    const riftCooldownMultiplier = hasRiftStride
      ? 1 + finitePercent(PLAZA_RIFT_COOLDOWN_EFFICIENCY_PERCENT) / 100
      : 1;
    const dashCooldownEfficiency =
      (1 + dashCooldownPercent / 100) * riftCooldownMultiplier;

    return {
      moveSpeedPercent,
      cosmicActionSpeedPercent,
      dashSpeedPercent,
      dashCooldownPercent,
      moveSpeedMultiplier:
        (1 + moveSpeedPercent / 100) *
        (1 + cosmicActionSpeedPercent / 100),
      dashSpeed: PLAZA_DASH_BASE_SPEED * (1 + dashSpeedPercent / 100),
      dashCooldownSeconds:
        PLAZA_DASH_BASE_COOLDOWN_SECONDS / dashCooldownEfficiency,
      hasStarfallMantle: powers.has("starfallMantle"),
      hasRiftStride,
      hasPhantomMarch: powers.has("phantomMarch"),
    };
  } catch {
    // Normalized saves never reach this branch. It keeps a malformed transient
    // loadout from breaking plaza input/rendering before reconciliation.
    return { ...BASE_PLAZA_MOBILITY_PROFILE };
  }
}

export type PlazaDirection = Readonly<{ x: number; y: number }>;

const DIAGONAL_COMPONENT = Math.SQRT1_2;
const PLAZA_FACING_DIRECTIONS: readonly PlazaDirection[] = [
  { x: 0, y: 1 },
  { x: -DIAGONAL_COMPONENT, y: DIAGONAL_COMPONENT },
  { x: -1, y: 0 },
  { x: -DIAGONAL_COMPONENT, y: -DIAGONAL_COMPONENT },
  { x: 0, y: -1 },
  { x: DIAGONAL_COMPONENT, y: -DIAGONAL_COMPONENT },
  { x: 1, y: 0 },
  { x: DIAGONAL_COMPONENT, y: DIAGONAL_COMPONENT },
];

const directionFromFacing = (facing: number): PlazaDirection => {
  const safeFacing = Number.isFinite(facing)
    ? Math.min(7, Math.max(0, Math.round(facing)))
    : 0;
  return { ...PLAZA_FACING_DIRECTIONS[safeFacing] };
};

/**
 * Uses current movement input first, then the character's canonical 0..7
 * facing. Scaling by the largest component keeps normalization finite even for
 * abnormally large (but finite) input values.
 */
export function plazaDashDirection(
  moveX: number,
  moveY: number,
  facing: number,
): PlazaDirection {
  const x = Number.isFinite(moveX) ? moveX : 0;
  const y = Number.isFinite(moveY) ? moveY : 0;
  const scale = Math.max(Math.abs(x), Math.abs(y));
  if (scale <= 0.000001) return directionFromFacing(facing);

  const scaledX = x / scale;
  const scaledY = y / scale;
  const magnitude = Math.hypot(scaledX, scaledY);
  if (!Number.isFinite(magnitude) || magnitude <= 0.000001) {
    return directionFromFacing(facing);
  }
  return { x: scaledX / magnitude, y: scaledY / magnitude };
}

/**
 * Deterministic, storage-free equipment for the localhost plaza skill QA route.
 * Exactly the three plaza-observable legendary powers are present.
 */
export function createPlazaSkillShowcaseEquipment(): EquipmentLoadout {
  const equipment = createEmptyEquipment();
  equipment.shoulders = rollGear("plaza-skill-showcase-starfall-v1", {
    slot: "shoulders",
    rarity: "legendary",
    level: 100,
  });
  equipment.legs = rollGear("plaza-skill-showcase-phantom-v1", {
    slot: "legs",
    rarity: "legendary",
    level: 100,
  });
  equipment.boots = rollGear("plaza-skill-showcase-rift-v1", {
    slot: "boots",
    rarity: "legendary",
    level: 100,
  });
  return equipment;
}
