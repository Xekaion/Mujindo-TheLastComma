/**
 * Allocation-conscious helpers used by the expedition's 60 FPS hot path.
 * Keep this module free of React/DOM state so the budgets remain testable.
 */

export type PositionedAliveEntity = Readonly<{
  id: number;
  x: number;
  y: number;
  hp: number;
}>;

/**
 * Continuous canvas work above 100 Hz costs more than it improves motion.
 * A 10 ms gate naturally keeps a stable display divisor: 120/144/165 Hz
 * process every second callback while 240 Hz processes every third callback.
 */
export const CONTINUOUS_FRAME_MIN_INTERVAL_MS = 10;
const CONTINUOUS_FRAME_INTERVAL_EPSILON_MS = 0.001;

/**
 * Returns whether one requestAnimationFrame callback should perform continuous
 * simulation/render work. Callers must update `lastProcessedAtMs` only when
 * this returns true; skipped callbacks therefore preserve a display divisor.
 */
export function shouldProcessContinuousFrame(
  lastProcessedAtMs: number,
  nowMs: number,
): boolean {
  if (!Number.isFinite(nowMs)) return false;
  if (!Number.isFinite(lastProcessedAtMs) || nowMs < lastProcessedAtMs) return true;
  return (
    nowMs - lastProcessedAtMs + CONTINUOUS_FRAME_INTERVAL_EPSILON_MS >=
    CONTINUOUS_FRAME_MIN_INTERVAL_MS
  );
}

/** Removes rejected entries without allocating a replacement array. */
export function compactArrayInPlace<T>(
  values: T[],
  keep: (value: T) => boolean,
): void {
  let writeIndex = 0;
  for (let readIndex = 0; readIndex < values.length; readIndex += 1) {
    const value = values[readIndex];
    if (!keep(value)) continue;
    if (writeIndex !== readIndex) values[writeIndex] = value;
    writeIndex += 1;
  }
  values.length = writeIndex;
}

/** Hot-path variant for the common numeric-expiry field; avoids closures. */
export function compactPositiveFieldInPlace<T extends Record<K, number>, K extends keyof T>(
  values: T[],
  field: K,
): void {
  let writeIndex = 0;
  for (let readIndex = 0; readIndex < values.length; readIndex += 1) {
    const value = values[readIndex];
    if (value[field] <= 0) continue;
    if (writeIndex !== readIndex) values[writeIndex] = value;
    writeIndex += 1;
  }
  values.length = writeIndex;
}

/**
 * Finds the nearest live target in one scan. Squared distance preserves the
 * exact nearest-target choice without filter/sort arrays or square roots.
 */
export function findNearestAliveEntity<T extends PositionedAliveEntity>(
  values: readonly T[],
  originX: number,
  originY: number,
  excludedId: number,
  maximumDistance = Number.POSITIVE_INFINITY,
): T | undefined {
  let nearest: T | undefined;
  let nearestDistanceSquared = maximumDistance * maximumDistance;
  for (const value of values) {
    if (value.id === excludedId || value.hp <= 0) continue;
    const deltaX = value.x - originX;
    const deltaY = value.y - originY;
    const distanceSquared = deltaX * deltaX + deltaY * deltaY;
    if (distanceSquared >= nearestDistanceSquared) continue;
    nearest = value;
    nearestDistanceSquared = distanceSquared;
  }
  return nearest;
}

/** Nearest-target scan for homing projectiles that have already hit a set. */
export function findNearestUnhitAliveEntity<T extends PositionedAliveEntity>(
  values: readonly T[],
  originX: number,
  originY: number,
  hitIds: ReadonlySet<number>,
): T | undefined {
  let nearest: T | undefined;
  let nearestDistanceSquared = Number.POSITIVE_INFINITY;
  for (const value of values) {
    if (value.hp <= 0 || hitIds.has(value.id)) continue;
    const deltaX = value.x - originX;
    const deltaY = value.y - originY;
    const distanceSquared = deltaX * deltaX + deltaY * deltaY;
    if (distanceSquared >= nearestDistanceSquared) continue;
    nearest = value;
    nearestDistanceSquared = distanceSquared;
  }
  return nearest;
}

/**
 * Collision and projectile cores always render. Only decorative friendly
 * trails are sampled once crowded; hostile warnings remain fully visible.
 */
export function shouldDrawProjectileTrail(
  projectileId: number,
  hostile: boolean,
  projectileCount: number,
): boolean {
  if (hostile || projectileCount <= 120) return true;
  // A late-game volley can exceed 480 friendly projectiles. At that density a
  // sixth of the decorative trails stays under the ~96-gradient frame budget;
  // projectile cores, hostile warnings, simulation and collision remain whole.
  const stride = projectileCount > 220 ? 6 : 2;
  return Math.abs(Math.trunc(projectileId)) % stride === 0;
}

export type ProjectileMotionInterpolationSample = Readonly<{
  x: number;
  y: number;
  alpha: number;
}>;

/**
 * Allocation-free interpolation budget for the projectile render hot path.
 * Callers that only need to draw samples can calculate their positions inline
 * without creating a temporary sample array or per-sample objects.
 */
export function projectileMotionInterpolationCount(
  previousX: number,
  previousY: number,
  currentX: number,
  currentY: number,
  radius: number,
  projectileCount: number,
  hostile: boolean,
): number {
  if (
    !Number.isFinite(previousX) ||
    !Number.isFinite(previousY) ||
    !Number.isFinite(currentX) ||
    !Number.isFinite(currentY)
  ) {
    return 0;
  }
  const deltaX = currentX - previousX;
  const deltaY = currentY - previousY;
  const travelDistance = Math.hypot(deltaX, deltaY);
  if (travelDistance < 1) return 0;

  const safeProjectileCount = Number.isFinite(projectileCount)
    ? Math.max(0, projectileCount)
    : Number.POSITIVE_INFINITY;
  if (hostile ? safeProjectileCount > 160 : safeProjectileCount > 96) return 0;

  const sampleBudget = hostile ? 2 : 1;
  const sampleSpacing = Math.max(16, Math.min(24, Math.max(1, radius) * 1.35));
  return Math.min(
    sampleBudget,
    Math.max(0, Math.ceil(travelDistance / sampleSpacing) - 1),
  );
}

/**
 * Produces a tiny, bounded set of sub-frame positions between the last physics
 * location and the current one. These bridge the visual gap left by a delayed
 * animation frame without changing collision or projectile travel distance.
 */
export function projectileMotionInterpolationSamples(
  previousX: number,
  previousY: number,
  currentX: number,
  currentY: number,
  radius: number,
  projectileCount: number,
  hostile: boolean,
): readonly ProjectileMotionInterpolationSample[] {
  if (
    !Number.isFinite(previousX) ||
    !Number.isFinite(previousY) ||
    !Number.isFinite(currentX) ||
    !Number.isFinite(currentY)
  ) {
    return [];
  }
  const deltaX = currentX - previousX;
  const deltaY = currentY - previousY;
  const sampleCount = projectileMotionInterpolationCount(
    previousX,
    previousY,
    currentX,
    currentY,
    radius,
    projectileCount,
    hostile,
  );
  if (sampleCount === 0) return [];

  const samples: ProjectileMotionInterpolationSample[] = [];
  for (let index = 1; index <= sampleCount; index += 1) {
    const progress = index / (sampleCount + 1);
    samples.push({
      x: previousX + deltaX * progress,
      y: previousY + deltaY * progress,
      alpha: 0.1 + progress * 0.12,
    });
  }
  return samples;
}

/**
 * Cheap conservative broad phase for swept projectile collision. A true result
 * still needs the exact segment-distance test; false safely rejects the common
 * far-away enemy without hypot/square-root work.
 */
export function sweptCircleMayOverlap(
  startX: number,
  startY: number,
  endX: number,
  endY: number,
  targetX: number,
  targetY: number,
  combinedRadius: number,
): boolean {
  const radius = Math.max(0, combinedRadius);
  return !(
    targetX < Math.min(startX, endX) - radius ||
    targetX > Math.max(startX, endX) + radius ||
    targetY < Math.min(startY, endY) - radius ||
    targetY > Math.max(startY, endY) + radius
  );
}
