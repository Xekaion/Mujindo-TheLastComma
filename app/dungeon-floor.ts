export const DUNGEON_LAYOUT_VERSION = 2;
export const DUNGEON_GRID_SIZE = 99;
export const DUNGEON_MIN_COORDINATE = -49;
export const DUNGEON_MAX_COORDINATE = 49;
export const DUNGEON_CENTER_COORDINATE = 0;
export const DOWN_STAIR_ROOM_COUNT = 40;

export type DungeonDoorAccess = Readonly<{
  west: boolean;
  east: boolean;
  north: boolean;
  south: boolean;
}>;

const TOTAL_DUNGEON_ROOMS = DUNGEON_GRID_SIZE * DUNGEON_GRID_SIZE;
const CENTER_LINEAR_INDEX =
  (DUNGEON_CENTER_COORDINATE - DUNGEON_MIN_COORDINATE) * DUNGEON_GRID_SIZE +
  (DUNGEON_CENTER_COORDINATE - DUNGEON_MIN_COORDINATE);

export function normalizeDungeonFloor(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1
    ? value
    : 1;
}

export function isDungeonCoordinate(x: number, y: number): boolean {
  return (
    Number.isSafeInteger(x) &&
    Number.isSafeInteger(y) &&
    x >= DUNGEON_MIN_COORDINATE &&
    x <= DUNGEON_MAX_COORDINATE &&
    y >= DUNGEON_MIN_COORDINATE &&
    y <= DUNGEON_MAX_COORDINATE
  );
}

export function dungeonCoordinateKey(x: number, y: number): string {
  return `${x},${y}`;
}

export function parseDungeonCoordinateKey(
  key: string,
): { x: number; y: number } | null {
  const parts = key.split(",");
  if (parts.length !== 2) return null;
  const x = Number(parts[0]);
  const y = Number(parts[1]);
  if (!isDungeonCoordinate(x, y) || dungeonCoordinateKey(x, y) !== key) return null;
  return { x, y };
}

function layoutRandom(seed: number, dungeonFloor: number) {
  let state =
    (Math.trunc(seed) ^ Math.imul(normalizeDungeonFloor(dungeonFloor), 0x45d9f3b)) |
    0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Selects exactly forty unique rooms from the 9,800 non-central rooms.
 * Partial Fisher-Yates keeps the result deterministic without allocating or
 * shuffling the entire 99x99 floor.
 */
export function createDownStairRoomKeys(
  seed: number,
  dungeonFloor: number,
): readonly string[] {
  const candidateCount = TOTAL_DUNGEON_ROOMS - 1;
  const random = layoutRandom(seed, dungeonFloor);
  const swaps = new Map<number, number>();
  const selected: string[] = [];

  for (let index = 0; index < DOWN_STAIR_ROOM_COUNT; index += 1) {
    const drawIndex = index + Math.floor(random() * (candidateCount - index));
    const valueAtIndex = swaps.get(index) ?? index;
    const valueAtDraw = swaps.get(drawIndex) ?? drawIndex;
    swaps.set(index, valueAtDraw);
    swaps.set(drawIndex, valueAtIndex);

    const linearIndex =
      valueAtDraw >= CENTER_LINEAR_INDEX ? valueAtDraw + 1 : valueAtDraw;
    const x = DUNGEON_MIN_COORDINATE + (linearIndex % DUNGEON_GRID_SIZE);
    const y =
      DUNGEON_MIN_COORDINATE + Math.floor(linearIndex / DUNGEON_GRID_SIZE);
    selected.push(dungeonCoordinateKey(x, y));
  }

  return selected;
}

export function createDownStairRoomLookup(
  seed: number,
  dungeonFloor: number,
): Record<string, true> {
  return Object.fromEntries(
    createDownStairRoomKeys(seed, dungeonFloor).map((key) => [key, true] as const),
  );
}

export function dungeonDoorAccess(
  x: number,
  y: number,
  roomCleared: boolean,
): DungeonDoorAccess {
  return {
    west: roomCleared && isDungeonCoordinate(x - 1, y),
    east: roomCleared && isDungeonCoordinate(x + 1, y),
    north: roomCleared && isDungeonCoordinate(x, y - 1),
    south: roomCleared && isDungeonCoordinate(x, y + 1),
  };
}

export function dungeonDisplayCoordinate(value: number): number {
  return value - DUNGEON_MIN_COORDINATE + 1;
}
