export type PlazaInspectionPoint = Readonly<{
  x: number;
  y: number;
}>;

export type PlazaCanvasRect = Readonly<{
  left: number;
  top: number;
  width: number;
  height: number;
}>;

export type PlazaInspectionViewport = Readonly<{
  width: number;
  height: number;
}>;

const PLAYER_HIT_HALF_WIDTH = 52;
const PLAYER_HIT_TOP = 112;
const PLAYER_HIT_BOTTOM = 36;

const isFinitePoint = (point: PlazaInspectionPoint): boolean =>
  Number.isFinite(point.x) && Number.isFinite(point.y);

const safeCameraPoint = (camera: PlazaInspectionPoint): PlazaInspectionPoint => ({
  x: Number.isFinite(camera.x) ? camera.x : 0,
  y: Number.isFinite(camera.y) ? camera.y : 0,
});

/**
 * Converts a pointer's CSS client coordinates to the plaza's logical world
 * coordinates. The canvas backing-store/DPR does not enter this calculation:
 * `rect` describes the displayed CSS box and `viewport` describes the logical
 * dimensions centered on `camera`.
 */
export function canvasClientPointToWorld(
  clientX: number,
  clientY: number,
  rect: PlazaCanvasRect,
  viewport: PlazaInspectionViewport,
  camera: PlazaInspectionPoint,
): PlazaInspectionPoint {
  const fallback = safeCameraPoint(camera);
  if (
    !Number.isFinite(clientX) ||
    !Number.isFinite(clientY) ||
    !Number.isFinite(rect.left) ||
    !Number.isFinite(rect.top) ||
    !Number.isFinite(rect.width) ||
    !Number.isFinite(rect.height) ||
    rect.width <= 0 ||
    rect.height <= 0 ||
    !Number.isFinite(viewport.width) ||
    !Number.isFinite(viewport.height) ||
    viewport.width <= 0 ||
    viewport.height <= 0 ||
    !isFinitePoint(camera)
  ) {
    return fallback;
  }

  return {
    x:
      camera.x +
      ((clientX - rect.left) / rect.width) * viewport.width -
      viewport.width / 2,
    y:
      camera.y +
      ((clientY - rect.top) / rect.height) * viewport.height -
      viewport.height / 2,
  };
}

/**
 * Picks the inspectable character under a world point using the same visual
 * stacking rule as the plaza: characters with a larger ground Y are drawn
 * later. At an equal Y, the pointer-nearest character center wins. Exact ties
 * prefer the later input entry, matching a pre-sorted render list.
 */
export function pickPlazaInspectablePlayer<T extends { x: number; y: number }>(
  players: readonly T[],
  point: PlazaInspectionPoint,
): T | null {
  if (!Array.isArray(players) || !isFinitePoint(point)) return null;

  let picked: T | null = null;
  let pickedDistanceSquared = Number.POSITIVE_INFINITY;

  for (const player of players) {
    if (!player || !Number.isFinite(player.x) || !Number.isFinite(player.y)) {
      continue;
    }
    if (
      point.x < player.x - PLAYER_HIT_HALF_WIDTH ||
      point.x > player.x + PLAYER_HIT_HALF_WIDTH ||
      point.y < player.y - PLAYER_HIT_TOP ||
      point.y > player.y + PLAYER_HIT_BOTTOM
    ) {
      continue;
    }

    const distanceSquared =
      (point.x - player.x) ** 2 + (point.y - player.y) ** 2;
    if (
      picked === null ||
      player.y > picked.y ||
      (player.y === picked.y && distanceSquared <= pickedDistanceSquared)
    ) {
      picked = player;
      pickedDistanceSquared = distanceSquared;
    }
  }

  return picked;
}
