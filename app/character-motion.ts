/** Shared eight-direction movement and four-frame walk-cycle rules. */

export const CHARACTER_FACINGS = [0, 1, 2, 3, 4, 5, 6, 7] as const;
export type CharacterFacing = (typeof CHARACTER_FACINGS)[number];

export const CHARACTER_FACING_NAMES = [
  "south",
  "south-west",
  "west",
  "north-west",
  "north",
  "north-east",
  "east",
  "south-east",
] as const;
export type CharacterFacingName = (typeof CHARACTER_FACING_NAMES)[number];

/** Harin atlas rows were authored as S, SE, E, NW, N, NE, W, SW. */
export const HARIN_WALK_ROW_BY_FACING = [0, 7, 6, 3, 4, 5, 2, 1] as const;

export const CHARACTER_WALK_FRAME_COUNT = 4;
// The generated cycle's contact poses are columns 0 and 2. Column 1 is a
// passing pose with a lifted foot, so settling there made Harin freeze mid-step.
export const CHARACTER_IDLE_FRAME = 0;
/** World-space distance covered by one complete four-pose gait. */
export const CHARACTER_WALK_CYCLE_DISTANCE = 96;
/**
 * Upper gait cadence for the player atlas. Distance still drives the cycle at
 * ordinary speed, while temporary movement-speed spikes can no longer make the
 * four authored poses strobe faster than they can be read.
 */
export const CHARACTER_MAX_WALK_CYCLES_PER_SECOND = 3.2;
export const CHARACTER_MOTION_EPSILON = 0.001;

const VECTOR_SECTOR_TO_FACING = [6, 7, 0, 1, 2, 3, 4, 5] as const;

const positiveModulo = (value: number, divisor: number) =>
  ((value % divisor) + divisor) % divisor;

export function normalizeCharacterFacing(facing: number): CharacterFacing {
  const safeFacing = Number.isFinite(facing) ? Math.floor(facing) : 0;
  return positiveModulo(safeFacing, CHARACTER_FACINGS.length) as CharacterFacing;
}

/** Converts a canvas-space vector (positive Y is south) to canonical facing. */
export function characterFacingForVector(
  dx: number,
  dy: number,
  fallbackFacing: number = 0,
  movementEpsilon: number = CHARACTER_MOTION_EPSILON,
): CharacterFacing {
  const safeDx = Number.isFinite(dx) ? dx : 0;
  const safeDy = Number.isFinite(dy) ? dy : 0;
  const safeEpsilon = Number.isFinite(movementEpsilon)
    ? Math.max(0, movementEpsilon)
    : CHARACTER_MOTION_EPSILON;

  if (Math.hypot(safeDx, safeDy) <= safeEpsilon) {
    return normalizeCharacterFacing(fallbackFacing);
  }

  const sector = positiveModulo(
    Math.round(Math.atan2(safeDy, safeDx) / (Math.PI / 4)),
    CHARACTER_FACINGS.length,
  );
  return VECTOR_SECTOR_TO_FACING[sector];
}

export function characterSpriteRowForFacing(facing: number): number {
  return HARIN_WALK_ROW_BY_FACING[normalizeCharacterFacing(facing)];
}

export type CharacterMotionSample = Readonly<{
  dx: number;
  dy: number;
  distance: number;
  moving: boolean;
  facing: CharacterFacing;
}>;

/**
 * Resolves animation state from the displacement that survived collision.
 * Pass `nextX - previousX` and `nextY - previousY`, not raw input intent.
 */
export function resolveCharacterMotion(
  actualDx: number,
  actualDy: number,
  fallbackFacing: number = 0,
  movementEpsilon: number = CHARACTER_MOTION_EPSILON,
): CharacterMotionSample {
  const dx = Number.isFinite(actualDx) ? actualDx : 0;
  const dy = Number.isFinite(actualDy) ? actualDy : 0;
  const distance = Math.hypot(dx, dy);
  const safeEpsilon = Number.isFinite(movementEpsilon)
    ? Math.max(0, movementEpsilon)
    : CHARACTER_MOTION_EPSILON;
  const moving = distance > safeEpsilon;

  return {
    dx,
    dy,
    distance,
    moving,
    facing: moving
      ? characterFacingForVector(dx, dy, fallbackFacing, safeEpsilon)
      : normalizeCharacterFacing(fallbackFacing),
  };
}

/**
 * Advances the fractional frame cursor using actual travelled distance.
 *
 * `elapsedSeconds` is optional to preserve the original distance-only contract
 * for simulations and callers that do not own a frame delta. Runtime render
 * loops should pass it so extreme movement speed is cadence-limited.
 */
export function advanceCharacterWalkCycle(
  currentCycle: number,
  actualDistance: number,
  cycleDistance: number = CHARACTER_WALK_CYCLE_DISTANCE,
  elapsedSeconds?: number,
): number {
  const safeCycle = Number.isFinite(currentCycle)
    ? currentCycle
    : CHARACTER_IDLE_FRAME;
  const safeDistance = Number.isFinite(actualDistance)
    ? Math.max(0, actualDistance)
    : 0;
  const safeCycleDistance =
    Number.isFinite(cycleDistance) && cycleDistance > CHARACTER_MOTION_EPSILON
      ? cycleDistance
      : CHARACTER_WALK_CYCLE_DISTANCE;
  const distanceFrameAdvance =
    (safeDistance / safeCycleDistance) * CHARACTER_WALK_FRAME_COUNT;
  const hasElapsedSample = elapsedSeconds !== undefined;
  const safeElapsedSeconds = Number.isFinite(elapsedSeconds)
    ? Math.max(0, elapsedSeconds ?? 0)
    : 0;
  const maxTimedFrameAdvance =
    CHARACTER_MAX_WALK_CYCLES_PER_SECOND *
    CHARACTER_WALK_FRAME_COUNT *
    safeElapsedSeconds;
  const frameAdvance = hasElapsedSample
    ? Math.min(distanceFrameAdvance, maxTimedFrameAdvance)
    : distanceFrameAdvance;

  return positiveModulo(
    safeCycle + frameAdvance,
    CHARACTER_WALK_FRAME_COUNT,
  );
}

/** Settles a halted gait on the nearest authored foot-contact pose (0 or 2). */
export function settleCharacterWalkCycle(walkCycle: number): number {
  if (!Number.isFinite(walkCycle)) return CHARACTER_IDLE_FRAME;
  const normalizedCycle = positiveModulo(
    walkCycle,
    CHARACTER_WALK_FRAME_COUNT,
  );
  return positiveModulo(
    Math.round(normalizedCycle / 2) * 2,
    CHARACTER_WALK_FRAME_COUNT,
  );
}

export function characterWalkFrameIndex(
  walkCycle: number,
  moving: boolean,
): number {
  if (!Number.isFinite(walkCycle)) return CHARACTER_IDLE_FRAME;
  if (!moving) return settleCharacterWalkCycle(walkCycle);
  return positiveModulo(
    Math.floor(walkCycle),
    CHARACTER_WALK_FRAME_COUNT,
  );
}
