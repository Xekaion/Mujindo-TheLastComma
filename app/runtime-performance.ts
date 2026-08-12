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
