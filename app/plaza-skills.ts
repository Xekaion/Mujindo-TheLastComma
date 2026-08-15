import {
  EQUIPMENT_SLOTS,
  LEGENDARY_POWERS,
  aggregateEquipmentStats,
  createEmptyEquipment,
  equippedLegendaryPowers,
  rollGear,
  type EquipmentLoadout,
  type LegendaryPowerId,
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
  /** Every equipped high-tier slot power in canonical equipment-slot order. */
  equippedPowerIds: readonly LegendaryPowerId[];
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
  equippedPowerIds: [],
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
    const equippedPowerIds = equippedLegendaryPowers(equipment);
    const powers = new Set(equippedPowerIds);
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
      equippedPowerIds,
    };
  } catch {
    // Normalized saves never reach this branch. It keeps a malformed transient
    // loadout from breaking plaza input/rendering before reconciliation.
    return { ...BASE_PLAZA_MOBILITY_PROFILE };
  }
}

export type PlazaDashPowerVfxSpec = Readonly<{
  powerId: LegendaryPowerId;
  layer: "body" | "ground";
  /** Delay after dash activation, allowing a full ten-piece loadout to read. */
  delaySeconds: number;
  durationSeconds: number;
  size: number;
  /** Signed distance along the normalized dash direction. */
  forwardOffset: number;
  /** Signed distance along the dash direction's right-hand normal. */
  lateralOffset: number;
  /** Radians added to the dash direction when drawing directional artwork. */
  angleOffset: number;
}>;

type PlazaDashPowerVfxTuning = Omit<PlazaDashPowerVfxSpec, "powerId">;

/**
 * Peaceful-plaza presentation for every slot power shared by legendary,
 * mythic, and cosmic equipment. These values contain no damage, shields,
 * counters, projectiles, or save mutations: PlazaHub may render them without
 * accidentally running expedition combat rules.
 */
export const PLAZA_DASH_POWER_VFX_CONFIG = {
  crescentEcho: {
    layer: "body",
    delaySeconds: 0,
    durationSeconds: 0.44,
    size: 86,
    forwardOffset: 24,
    lateralOffset: -16,
    angleOffset: -0.2,
  },
  mirrorAegis: {
    layer: "body",
    delaySeconds: 0.03,
    durationSeconds: 0.62,
    size: 112,
    forwardOffset: 0,
    lateralOffset: 0,
    angleOffset: 0,
  },
  hunterSigil: {
    layer: "body",
    delaySeconds: 0.06,
    durationSeconds: 0.56,
    size: 96,
    forwardOffset: 4,
    lateralOffset: 0,
    angleOffset: 0,
  },
  starfallMantle: {
    layer: "body",
    delaySeconds: 0.09,
    durationSeconds: 0.54,
    size: 118,
    forwardOffset: 0,
    lateralOffset: 0,
    angleOffset: 0,
  },
  lastMemory: {
    layer: "body",
    delaySeconds: 0.12,
    durationSeconds: 0.84,
    size: 132,
    forwardOffset: -4,
    lateralOffset: 0,
    angleOffset: 0,
  },
  bloodwovenGrip: {
    layer: "body",
    delaySeconds: 0.15,
    durationSeconds: 0.46,
    size: 88,
    forwardOffset: 24,
    lateralOffset: 16,
    angleOffset: 0.2,
  },
  ashboundGirdle: {
    layer: "body",
    delaySeconds: 0.18,
    durationSeconds: 0.72,
    size: 112,
    forwardOffset: -2,
    lateralOffset: 0,
    angleOffset: 0,
  },
  phantomMarch: {
    layer: "ground",
    delaySeconds: 0.21,
    durationSeconds: 0.95,
    size: 74,
    forwardOffset: -34,
    lateralOffset: -12,
    angleOffset: 0,
  },
  riftStride: {
    layer: "ground",
    delaySeconds: 0.24,
    durationSeconds: 0.3,
    size: 52,
    forwardOffset: -18,
    lateralOffset: 12,
    angleOffset: 0,
  },
  commaResonance: {
    layer: "body",
    delaySeconds: 0.27,
    durationSeconds: 0.52,
    size: 82,
    forwardOffset: 18,
    lateralOffset: 0,
    angleOffset: 0,
  },
} as const satisfies Readonly<
  Record<LegendaryPowerId, PlazaDashPowerVfxTuning>
>;

/**
 * Resolves every requested power without a render-count cap. Canonical
 * equipment already supplies unique IDs in slot order; keeping this mapper
 * order-preserving also makes its stagger deterministic for partial loadouts.
 */
export function resolvePlazaDashPowerVfxSpecs(
  powerIds: readonly LegendaryPowerId[],
): PlazaDashPowerVfxSpec[] {
  return powerIds.flatMap((powerId) => {
    const tuning = PLAZA_DASH_POWER_VFX_CONFIG[powerId];
    return tuning ? [{ powerId, ...tuning }] : [];
  });
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
 * Every slot power is represented, split between legendary and mythic gear.
 */
export function createPlazaSkillShowcaseEquipment(): EquipmentLoadout {
  const equipment = createEmptyEquipment();
  for (const [index, slot] of EQUIPMENT_SLOTS.entries()) {
    equipment[slot] = rollGear(`plaza-skill-showcase-${slot}-v2`, {
      slot,
      rarity: index % 2 === 0 ? "legendary" : "mythic",
      level: 100,
    });
  }
  return equipment;
}
