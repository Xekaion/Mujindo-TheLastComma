export type CollisionPoint = {
  x: number;
  y: number;
};

export const WALKABLE_FLOOR_POLYGON = [
  { x: 270, y: 142 },
  { x: 1010, y: 142 },
  { x: 1134, y: 224 },
  { x: 1134, y: 496 },
  { x: 1014, y: 582 },
  { x: 266, y: 582 },
  { x: 146, y: 496 },
  { x: 146, y: 224 },
] as const;

const COLLISION_EPSILON = 1e-7;

function polygonOrientation(polygon: readonly CollisionPoint[]): 1 | -1 {
  let signedAreaTwice = 0;
  for (let index = 0; index < polygon.length; index += 1) {
    const current = polygon[index];
    const next = polygon[(index + 1) % polygon.length];
    signedAreaTwice += current.x * next.y - next.x * current.y;
  }
  return signedAreaTwice >= 0 ? 1 : -1;
}

function normalizedClearance(clearance: number): number {
  return Number.isFinite(clearance) ? Math.max(0, clearance) : 0;
}

function inwardDistance(
  point: CollisionPoint,
  start: CollisionPoint,
  end: CollisionPoint,
  orientation: 1 | -1,
) {
  const edgeX = end.x - start.x;
  const edgeY = end.y - start.y;
  const edgeLength = Math.hypot(edgeX, edgeY);
  if (edgeLength <= COLLISION_EPSILON) return Number.POSITIVE_INFINITY;
  return (
    (orientation *
      (edgeX * (point.y - start.y) - edgeY * (point.x - start.x))) /
    edgeLength
  );
}

/**
 * Tests a point against every inward half-plane of a convex room polygon.
 * `clearance` keeps the point's collision footprint inside the painted floor.
 */
export function pointInsideConvexPolygon(
  point: CollisionPoint,
  polygon: readonly CollisionPoint[],
  clearance = 0,
): boolean {
  if (
    polygon.length < 3 ||
    !Number.isFinite(point.x) ||
    !Number.isFinite(point.y)
  ) {
    return false;
  }
  const inset = normalizedClearance(clearance);
  const orientation = polygonOrientation(polygon);
  for (let index = 0; index < polygon.length; index += 1) {
    if (
      inwardDistance(
        point,
        polygon[index],
        polygon[(index + 1) % polygon.length],
        orientation,
      ) <
      inset - COLLISION_EPSILON
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Mutates an actor/drop onto the nearest valid area of a convex room polygon.
 * The common inside-floor path is allocation-free; repeated calls are stable.
 */
export function constrainPointToConvexPolygon<T extends CollisionPoint>(
  point: T,
  polygon: readonly CollisionPoint[],
  clearance = 0,
): boolean {
  if (polygon.length < 3) return false;

  let changed = false;
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
    point.x =
      polygon.reduce((total, vertex) => total + vertex.x, 0) / polygon.length;
    point.y =
      polygon.reduce((total, vertex) => total + vertex.y, 0) / polygon.length;
    changed = true;
  }

  const inset = normalizedClearance(clearance);
  const orientation = polygonOrientation(polygon);
  const maximumPasses = polygon.length * 4;
  for (let pass = 0; pass < maximumPasses; pass += 1) {
    let adjustedThisPass = false;
    for (let index = 0; index < polygon.length; index += 1) {
      const start = polygon[index];
      const end = polygon[(index + 1) % polygon.length];
      const edgeX = end.x - start.x;
      const edgeY = end.y - start.y;
      const edgeLength = Math.hypot(edgeX, edgeY);
      if (edgeLength <= COLLISION_EPSILON) continue;

      const signedDistance = inwardDistance(point, start, end, orientation);
      const correction = inset - signedDistance;
      if (correction <= COLLISION_EPSILON) continue;

      point.x += (orientation * -edgeY * correction) / edgeLength;
      point.y += (orientation * edgeX * correction) / edgeLength;
      adjustedThisPass = true;
      changed = true;
    }
    if (!adjustedThisPass) break;
  }
  return changed;
}

export function projectPointToConvexPolygon(
  x: number,
  y: number,
  polygon: readonly CollisionPoint[],
  clearance = 0,
): CollisionPoint {
  const projected = { x, y };
  constrainPointToConvexPolygon(projected, polygon, clearance);
  return projected;
}
