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
  /** Coordinate semantic: feet stay on the floor, body follows the rig centre. */
  layer: "body" | "ground";
  /** Explicit painter's pass inside the local actor's depth-sorted stack. */
  renderPass: "ground" | "body" | "foreground";
  /** Peak authored opacity. All ten powers fire without hiding the character. */
  maxAlpha: number;
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
    renderPass: "foreground",
    maxAlpha: 0.82,
    delaySeconds: 0,
    durationSeconds: 0.34,
    size: 74,
    forwardOffset: 20,
    lateralOffset: -13,
    angleOffset: -0.2,
  },
  mirrorAegis: {
    layer: "body",
    renderPass: "body",
    maxAlpha: 0.62,
    delaySeconds: 0.12,
    durationSeconds: 0.46,
    size: 94,
    forwardOffset: 0,
    lateralOffset: 0,
    angleOffset: 0,
  },
  hunterSigil: {
    layer: "body",
    renderPass: "body",
    maxAlpha: 0.68,
    delaySeconds: 0.24,
    durationSeconds: 0.38,
    size: 78,
    forwardOffset: 4,
    lateralOffset: 0,
    angleOffset: 0,
  },
  starfallMantle: {
    layer: "body",
    renderPass: "body",
    maxAlpha: 0.58,
    delaySeconds: 0.36,
    durationSeconds: 0.42,
    size: 92,
    forwardOffset: 0,
    lateralOffset: 0,
    angleOffset: 0,
  },
  lastMemory: {
    layer: "body",
    renderPass: "body",
    maxAlpha: 0.56,
    delaySeconds: 0.48,
    durationSeconds: 0.5,
    size: 100,
    forwardOffset: -4,
    lateralOffset: 0,
    angleOffset: 0,
  },
  bloodwovenGrip: {
    layer: "body",
    renderPass: "foreground",
    maxAlpha: 0.8,
    delaySeconds: 0.6,
    durationSeconds: 0.34,
    size: 76,
    forwardOffset: 20,
    lateralOffset: 13,
    angleOffset: 0.2,
  },
  ashboundGirdle: {
    layer: "body",
    renderPass: "body",
    maxAlpha: 0.62,
    delaySeconds: 0.72,
    durationSeconds: 0.46,
    size: 88,
    forwardOffset: -2,
    lateralOffset: 0,
    angleOffset: 0,
  },
  phantomMarch: {
    layer: "ground",
    renderPass: "ground",
    maxAlpha: 0.56,
    delaySeconds: 0.84,
    durationSeconds: 0.5,
    size: 64,
    forwardOffset: -30,
    lateralOffset: -10,
    angleOffset: 0,
  },
  riftStride: {
    layer: "ground",
    renderPass: "ground",
    maxAlpha: 0.62,
    delaySeconds: 0.96,
    durationSeconds: 0.28,
    size: 46,
    forwardOffset: -16,
    lateralOffset: 10,
    angleOffset: 0,
  },
  commaResonance: {
    layer: "body",
    renderPass: "foreground",
    maxAlpha: 0.76,
    delaySeconds: 1.08,
    durationSeconds: 0.26,
    size: 70,
    forwardOffset: 16,
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
 * Every slot power is represented across legendary, mythic, and cosmic gear.
 */
export function createPlazaSkillShowcaseEquipment(): EquipmentLoadout {
  const equipment = createEmptyEquipment();
  const showcaseRarities = ["legendary", "mythic", "cosmic"] as const;
  for (const [index, slot] of EQUIPMENT_SLOTS.entries()) {
    equipment[slot] = rollGear(`plaza-skill-showcase-${slot}-v2`, {
      slot,
      rarity: showcaseRarities[index % showcaseRarities.length],
      level: 100,
    });
  }
  return equipment;
}
