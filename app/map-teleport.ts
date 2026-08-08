export type MapTeleportStatus =
  | "available"
  | "current"
  | "locked-product"
  | "combat-locked"
  | "unknown"
  | "unvisited"
  | "uncleared";

export const MAP_TELEPORT_STATUS_LABELS: Record<MapTeleportStatus, string> = {
  available: "순간이동 가능",
  current: "현재 위치",
  "locked-product": "무진도의 길잡이 필요",
  "combat-locked": "현재 방 정복 후 사용 가능",
  unknown: "확인하지 않은 좌표",
  unvisited: "직접 방문한 좌표만 이동 가능",
  uncleared: "정복 완료 후 이동 가능",
};

export function isSafeMapCoordinate(x: number, y: number): boolean {
  return isDungeonCoordinate(x, y);
}

export function parseMapCoordinateKey(key: string): { x: number; y: number } | null {
  const parts = key.split(",");
  if (parts.length !== 2) return null;
  const x = Number(parts[0]);
  const y = Number(parts[1]);
  if (!isSafeMapCoordinate(x, y) || `${x},${y}` !== key) return null;
  return { x, y };
}

export function isMapTeleportDepartureSafe({
  roomCleared,
  enemyCount,
  transition,
}: {
  roomCleared: boolean;
  enemyCount: number;
  transition: number;
}): boolean {
  return (
    roomCleared &&
    Number.isSafeInteger(enemyCount) &&
    enemyCount === 0 &&
    Number.isFinite(transition) &&
    transition <= 0
  );
}

export function getMapTeleportStatus({
  hasEntitlement,
  departureSafe,
  current,
  known,
  visited,
  cleared,
}: {
  hasEntitlement: boolean;
  departureSafe: boolean;
  current: boolean;
  known: boolean;
  visited: boolean;
  cleared: boolean;
}): MapTeleportStatus {
  if (current) return "current";
  if (!hasEntitlement) return "locked-product";
  if (!departureSafe) return "combat-locked";
  if (!known) return "unknown";
  if (!visited) return "unvisited";
  if (!cleared) return "uncleared";
  return "available";
}
import { isDungeonCoordinate } from "./dungeon-floor";
