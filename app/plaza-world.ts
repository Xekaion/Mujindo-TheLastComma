export const PLAZA_WORLD_WIDTH = 2400;
export const PLAZA_WORLD_HEIGHT = 1350;
export const PLAZA_PLAYER_RADIUS = 31;
export const PLAZA_PORTAL_INTERACTION_RADIUS = 156;

export type PlazaPoint = {
  x: number;
  y: number;
};

export type PlazaPortalId = "expedition" | "duel" | "exchange" | "caravan";

export type PlazaPortalDefinition = {
  id: PlazaPortalId;
  name: string;
  englishName: string;
  description: string;
  href: string;
  x: number;
  y: number;
  approachX: number;
  approachY: number;
  hue: string;
  accent: string;
  hotkey: string;
};

export const PLAZA_SPAWN_POINT: Readonly<PlazaPoint> = {
  x: PLAZA_WORLD_WIDTH / 2,
  y: PLAZA_WORLD_HEIGHT / 2,
};

export const PLAZA_PORTALS: readonly PlazaPortalDefinition[] = [
  {
    id: "expedition",
    name: "원정",
    englishName: "THE ENDLESS EXPEDITION",
    description: "선택한 캐릭터로 무진도의 끝없는 방에 진입합니다.",
    href: "/?mode=expedition",
    x: 1200,
    y: 160,
    approachX: 1200,
    approachY: 260,
    hue: "#de5662",
    accent: "#ffd7a2",
    hotkey: "1",
  },
  {
    id: "duel",
    name: "기억결투",
    englishName: "MEMORY DUEL",
    description: "다른 기록자와 장비 전투력 그대로 겨루는 결투장입니다.",
    href: "/pvp",
    x: 250,
    y: 675,
    approachX: 270,
    approachY: 675,
    hue: "#8d5cff",
    accent: "#d6c2ff",
    hotkey: "2",
  },
  {
    id: "exchange",
    name: "기억거래소",
    englishName: "MEMORY EXCHANGE",
    description: "기록자들이 장비와 기억의 재를 거래하는 공동 시장입니다.",
    href: "/market",
    x: 2150,
    y: 675,
    approachX: 2130,
    approachY: 675,
    hue: "#42d8c5",
    accent: "#d1fff4",
    hotkey: "3",
  },
  {
    id: "caravan",
    name: "기억상단",
    englishName: "MEMORY CARAVAN",
    description: "가방 확장권과 지도 도약권 등 계정 상품을 확인합니다.",
    href: "/?shop=1",
    x: 1200,
    y: 1190,
    approachX: 1200,
    approachY: 1080,
    hue: "#e8ad48",
    accent: "#fff0bb",
    hotkey: "4",
  },
] as const;

type PlazaObstacle =
  | { kind: "circle"; x: number; y: number; radius: number }
  | { kind: "rect"; left: number; right: number; top: number; bottom: number };

// Only large, clearly visible landmarks are colliders. Small decoration remains
// non-blocking so the shared hub still feels comfortable when it is crowded.
export const PLAZA_OBSTACLES: readonly PlazaObstacle[] = [
  // North wall, split around the expedition arch.
  { kind: "rect", left: 92, right: 1_075, top: 82, bottom: 238 },
  { kind: "rect", left: 1_325, right: 2_308, top: 82, bottom: 238 },
  // West and east walls, split around their portal arches.
  { kind: "rect", left: 92, right: 220, top: 82, bottom: 548 },
  { kind: "rect", left: 92, right: 220, top: 802, bottom: 1_268 },
  { kind: "rect", left: 2_180, right: 2_308, top: 82, bottom: 548 },
  { kind: "rect", left: 2_180, right: 2_308, top: 802, bottom: 1_268 },
  // South wall, split around the caravan arch.
  { kind: "rect", left: 92, right: 1_055, top: 1_128, bottom: 1_268 },
  { kind: "rect", left: 1_345, right: 2_308, top: 1_128, bottom: 1_268 },
  // Large foreground desks and the north-west caravan stall are visibly solid.
  { kind: "rect", left: 155, right: 505, top: 118, bottom: 286 },
  { kind: "rect", left: 500, right: 850, top: 1_045, bottom: 1_268 },
  { kind: "rect", left: 1_565, right: 1_900, top: 1_040, bottom: 1_268 },
] as const;

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

function insideRoundedWorld(point: PlazaPoint, radius: number): boolean {
  const left = 92 + radius;
  const right = PLAZA_WORLD_WIDTH - 92 - radius;
  const top = 82 + radius;
  const bottom = PLAZA_WORLD_HEIGHT - 82 - radius;
  if (point.x < left || point.x > right || point.y < top || point.y > bottom) {
    return false;
  }

  // Chamfered corners echo the field-room silhouette and make the visible
  // balustrade an honest collision boundary.
  const cornerInset = 154;
  const cornerSlope = 0.72;
  if (point.x < left + cornerInset) {
    const minY = top + (left + cornerInset - point.x) * cornerSlope;
    const maxY = bottom - (left + cornerInset - point.x) * cornerSlope;
    if (point.y < minY || point.y > maxY) return false;
  }
  if (point.x > right - cornerInset) {
    const minY = top + (point.x - (right - cornerInset)) * cornerSlope;
    const maxY = bottom - (point.x - (right - cornerInset)) * cornerSlope;
    if (point.y < minY || point.y > maxY) return false;
  }
  return true;
}

export function isPlazaWalkable(
  point: PlazaPoint,
  radius = PLAZA_PLAYER_RADIUS,
): boolean {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return false;
  if (!Number.isFinite(radius) || radius < 0) return false;
  if (!insideRoundedWorld(point, radius)) return false;

  return PLAZA_OBSTACLES.every((obstacle) => {
    if (obstacle.kind === "circle") {
      return (
        Math.hypot(point.x - obstacle.x, point.y - obstacle.y) >=
        obstacle.radius + radius
      );
    }
    return !(
      point.x + radius > obstacle.left &&
      point.x - radius < obstacle.right &&
      point.y + radius > obstacle.top &&
      point.y - radius < obstacle.bottom
    );
  });
}

export function resolvePlazaMovement(
  start: PlazaPoint,
  delta: PlazaPoint,
  radius = PLAZA_PLAYER_RADIUS,
): PlazaPoint {
  if (!isPlazaWalkable(start, radius)) return { ...PLAZA_SPAWN_POINT };
  if (!Number.isFinite(delta.x) || !Number.isFinite(delta.y)) return { ...start };

  const target = { x: start.x + delta.x, y: start.y + delta.y };
  if (isPlazaWalkable(target, radius)) return target;

  // Axis-separated resolution gives the player a natural wall-slide instead
  // of stopping dead at a diagonal balustrade or landmark.
  const xOnly = { x: target.x, y: start.y };
  const yOnly = { x: start.x, y: target.y };
  const xWalkable = isPlazaWalkable(xOnly, radius);
  const yWalkable = isPlazaWalkable(yOnly, radius);
  if (xWalkable && yWalkable) {
    return Math.abs(delta.x) >= Math.abs(delta.y) ? xOnly : yOnly;
  }
  if (xWalkable) return xOnly;
  if (yWalkable) return yOnly;
  return { ...start };
}

/**
 * Resolves a long movement impulse as short collision-tested steps. Walking
 * already advances in tiny animation-frame deltas, but a plaza dash can cross
 * a whole wall in one update unless its path (not only its endpoint) is
 * checked. The same helper is shared by optimistic rendering and the hub
 * worker so both sides stop at the same visible boundary.
 */
export function resolvePlazaSweptMovement(
  start: PlazaPoint,
  delta: PlazaPoint,
  radius = PLAZA_PLAYER_RADIUS,
  maxStep = 16,
): PlazaPoint {
  if (!isPlazaWalkable(start, radius)) return { ...PLAZA_SPAWN_POINT };
  if (!Number.isFinite(delta.x) || !Number.isFinite(delta.y)) return { ...start };
  const safeStep = Number.isFinite(maxStep) ? Math.max(1, maxStep) : 16;
  const steps = Math.max(1, Math.ceil(Math.hypot(delta.x, delta.y) / safeStep));
  const step = { x: delta.x / steps, y: delta.y / steps };
  let position = { ...start };
  for (let index = 0; index < steps; index += 1) {
    const next = resolvePlazaMovement(position, step, radius);
    if (next.x === position.x && next.y === position.y) break;
    position = next;
  }
  return position;
}

export function sanitizePlazaPoint(point: PlazaPoint): PlazaPoint {
  const candidate = {
    x: clamp(Number.isFinite(point.x) ? point.x : PLAZA_SPAWN_POINT.x, 0, PLAZA_WORLD_WIDTH),
    y: clamp(Number.isFinite(point.y) ? point.y : PLAZA_SPAWN_POINT.y, 0, PLAZA_WORLD_HEIGHT),
  };
  return isPlazaWalkable(candidate) ? candidate : { ...PLAZA_SPAWN_POINT };
}

export function plazaPortalById(
  id: PlazaPortalId,
): PlazaPortalDefinition {
  const portal = PLAZA_PORTALS.find((entry) => entry.id === id);
  if (!portal) throw new RangeError(`Unknown plaza portal: ${id}`);
  return portal;
}

export function nearestPlazaPortal(
  point: PlazaPoint,
  maxDistance = PLAZA_PORTAL_INTERACTION_RADIUS,
): PlazaPortalDefinition | null {
  let nearest: PlazaPortalDefinition | null = null;
  let nearestDistance = maxDistance;
  for (const portal of PLAZA_PORTALS) {
    const distance = Math.hypot(point.x - portal.x, point.y - portal.y);
    if (distance <= nearestDistance) {
      nearest = portal;
      nearestDistance = distance;
    }
  }
  return nearest;
}

export function plazaFacingForVector(
  x: number,
  y: number,
  fallback = 0,
): number {
  if (Math.hypot(x, y) < 0.001) return fallback;
  const sector = ((Math.round(Math.atan2(y, x) / (Math.PI / 4)) % 8) + 8) % 8;
  return [6, 7, 0, 1, 2, 3, 4, 5][sector];
}

export function plazaSpriteRowForFacing(facing: number): number {
  const authoredRows = [0, 7, 6, 3, 4, 5, 2, 1] as const;
  const normalized = ((Math.floor(facing) % 8) + 8) % 8;
  return authoredRows[normalized];
}
