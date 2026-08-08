import {
  PLAZA_PLAYER_RADIUS,
  PLAZA_PORTALS,
  PLAZA_SPAWN_POINT,
  PLAZA_WORLD_HEIGHT,
  PLAZA_WORLD_WIDTH,
  type PlazaPortalDefinition,
  type PlazaPortalId,
} from "./plaza-world";

/**
 * Shared protocol for the multiplayer Memory Plaza.
 *
 * The browser is allowed to send only movement intent and a small, allowlisted
 * visual description. Position, velocity, identity, and proximity are always
 * derived by the server.
 */

export const HUB_ZONE_ID = "memory-plaza-v1";
export const HUB_MAP_VERSION = 1;
export const HUB_MAP_WIDTH = PLAZA_WORLD_WIDTH;
export const HUB_MAP_HEIGHT = PLAZA_WORLD_HEIGHT;
export const HUB_PLAYER_RADIUS = PLAZA_PLAYER_RADIUS;
export const HUB_PLAYER_SPEED = 250;
export const HUB_NEARBY_RADIUS = 920;
export const HUB_HEARTBEAT_INTERVAL_MS = 4_000;
export const HUB_ONLINE_WINDOW_MS = 12_000;
export const HUB_SESSION_TTL_MS = 12 * 60 * 60 * 1_000;
export const HUB_MAX_LEVEL = 999;
export const HUB_MIN_DUNGEON_FLOOR = 1;
export const HUB_MAX_DUNGEON_FLOOR = 999_999;

export const HUB_CHARACTER_SLOTS = [1, 2, 3] as const;
export type HubCharacterSlot = (typeof HUB_CHARACTER_SLOTS)[number];

/** Matches GameCanvas' canonical rows: S, SW, W, NW, N, NE, E, SE. */
export const HUB_FACINGS = [0, 1, 2, 3, 4, 5, 6, 7] as const;
export type HubFacing = (typeof HUB_FACINGS)[number];

export const HUB_SPRITE_KEYS = ["harin", "harin-equipped"] as const;
export type HubSpriteKey = (typeof HUB_SPRITE_KEYS)[number];

export const HUB_PALETTES = [
  "scarlet",
  "azure",
  "jade",
  "violet",
  "gold",
] as const;
export type HubPalette = (typeof HUB_PALETTES)[number];

export const HUB_VISUAL_GEAR_SLOTS = [
  "helm",
  "shoulders",
  "armor",
  "gloves",
  "belt",
  "legs",
  "boots",
  "weapon",
  "offhand",
  "relic",
] as const;
export type HubVisualGearSlot = (typeof HUB_VISUAL_GEAR_SLOTS)[number];

export type HubVisualGear = Record<HubVisualGearSlot, number | null>;

export type HubAppearance = {
  spriteKey: HubSpriteKey;
  palette: HubPalette;
  gear: HubVisualGear;
};

export type HubMoveIntent = {
  sequence: number;
  moveX: number;
  moveY: number;
  facing: HubFacing;
};

export type HubPlayerSnapshot = {
  playerId: string;
  characterId: string;
  displayName: string;
  characterSlot: HubCharacterSlot;
  level: number;
  /** Display-only client claim. It is not authoritative PvE progression. */
  dungeonFloor: number;
  x: number;
  y: number;
  facing: HubFacing;
  moving: boolean;
  appearance: HubAppearance;
  updatedAt: number;
};

export type HubSnapshot = {
  serverTime: number;
  zone: typeof HUB_ZONE_ID;
  mapVersion: number;
  online: number;
  self: HubPlayerSnapshot;
  nearbyPlayers: HubPlayerSnapshot[];
  portals: readonly HubPortalDefinition[];
  heartbeatIntervalMs: number;
};

export type HubSessionSnapshot = HubSnapshot & {
  token: string;
};

export type HubPortalId = PlazaPortalId;
export type HubPortalDefinition = PlazaPortalDefinition;
export const HUB_PORTALS: readonly HubPortalDefinition[] = PLAZA_PORTALS;

export const HUB_SPAWN_POINTS = {
  center: { ...PLAZA_SPAWN_POINT, facing: 4 as HubFacing },
  expedition: {
    x: PLAZA_PORTALS[0].approachX,
    y: PLAZA_PORTALS[0].approachY,
    facing: 4 as HubFacing,
  },
  duel: {
    x: PLAZA_PORTALS[1].approachX,
    y: PLAZA_PORTALS[1].approachY,
    facing: 2 as HubFacing,
  },
  exchange: {
    x: PLAZA_PORTALS[2].approachX,
    y: PLAZA_PORTALS[2].approachY,
    facing: 6 as HubFacing,
  },
  caravan: {
    x: PLAZA_PORTALS[3].approachX,
    y: PLAZA_PORTALS[3].approachY,
    facing: 0 as HubFacing,
  },
} as const;

export type HubArrival = keyof typeof HUB_SPAWN_POINTS;

export type HubSessionRequest = {
  characterSlot: HubCharacterSlot;
  displayName: string;
  level: number;
  /** Allowlisted public profile claim; the plaza server only clamps it. */
  dungeonFloor: number;
  appearance: HubAppearance;
  arrival: HubArrival;
};

export type HubAppearanceRequest = {
  appearance: HubAppearance;
  level: number;
  /** Null only for rolling-upgrade clients that predate the public claim. */
  dungeonFloor: number | null;
};

type UnknownRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is UnknownRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

function isOneOf<const T extends readonly unknown[]>(
  choices: T,
  value: unknown,
): value is T[number] {
  return choices.some((choice) => choice === value);
}

const emptyVisualGear = (): HubVisualGear => ({
  helm: null,
  shoulders: null,
  armor: null,
  gloves: null,
  belt: null,
  legs: null,
  boots: null,
  weapon: null,
  offhand: null,
  relic: null,
});

export const DEFAULT_HUB_APPEARANCE: Readonly<HubAppearance> = {
  spriteKey: "harin",
  palette: "scarlet",
  gear: emptyVisualGear(),
};

function normalizeGearVariant(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (!Number.isSafeInteger(value)) return null;
  return Math.max(0, Math.min(9, value as number));
}

/** Removes URLs, CSS, unknown keys, and out-of-atlas equipment indices. */
export function normalizeHubAppearance(value: unknown): HubAppearance {
  const raw = isRecord(value) ? value : {};
  const rawGear = isRecord(raw.gear) ? raw.gear : {};
  const gear = emptyVisualGear();
  for (const slot of HUB_VISUAL_GEAR_SLOTS) {
    gear[slot] = normalizeGearVariant(rawGear[slot]);
  }
  return {
    spriteKey: isOneOf(HUB_SPRITE_KEYS, raw.spriteKey)
      ? raw.spriteKey
      : DEFAULT_HUB_APPEARANCE.spriteKey,
    palette: isOneOf(HUB_PALETTES, raw.palette)
      ? raw.palette
      : DEFAULT_HUB_APPEARANCE.palette,
    gear,
  };
}

export function normalizeHubLevel(value: unknown): number {
  if (!isFiniteNumber(value)) return 1;
  return Math.max(1, Math.min(HUB_MAX_LEVEL, Math.floor(value)));
}

export function normalizeHubDungeonFloor(value: unknown): number {
  if (!isFiniteNumber(value)) return HUB_MIN_DUNGEON_FLOOR;
  return Math.max(
    HUB_MIN_DUNGEON_FLOOR,
    Math.min(HUB_MAX_DUNGEON_FLOOR, Math.floor(value)),
  );
}

export function normalizeHubDisplayName(value: unknown): string {
  if (typeof value !== "string") return "방랑자";
  const normalized = value
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 18);
  return normalized || "방랑자";
}

export function isHubCharacterSlot(value: unknown): value is HubCharacterSlot {
  return Number.isSafeInteger(value) && isOneOf(HUB_CHARACTER_SLOTS, value);
}

export function isHubFacing(value: unknown): value is HubFacing {
  return Number.isSafeInteger(value) && isOneOf(HUB_FACINGS, value);
}

export function resolveHubFacing(
  moveX: number,
  moveY: number,
  fallback: HubFacing,
): HubFacing {
  if (Math.hypot(moveX, moveY) < 0.05) return fallback;
  const octant = Math.round(Math.atan2(moveY, moveX) / (Math.PI / 4));
  // atan2 octants are E, SE, S, SW, W, NW, N, NE. Translate to the
  // game's row convention S, SW, W, NW, N, NE, E, SE.
  return ([6, 7, 0, 1, 2, 3, 4, 5][(octant + 8) % 8] ?? fallback) as HubFacing;
}

/** Movement intent deliberately has no x/y/speed/teleport authority fields. */
export function parseHubMoveIntent(value: unknown): HubMoveIntent | null {
  if (!isRecord(value)) return null;
  if (!Number.isSafeInteger(value.sequence) || (value.sequence as number) < 1) return null;
  if (!isFiniteNumber(value.moveX) || !isFiniteNumber(value.moveY)) return null;
  const magnitude = Math.hypot(value.moveX, value.moveY);
  const moveX = magnitude > 1 ? value.moveX / magnitude : value.moveX;
  const moveY = magnitude > 1 ? value.moveY / magnitude : value.moveY;
  const requestedFacing = isHubFacing(value.facing) ? value.facing : 0;
  return {
    sequence: value.sequence as number,
    moveX,
    moveY,
    facing: resolveHubFacing(moveX, moveY, requestedFacing),
  };
}

export function parseHubSessionRequest(value: unknown): HubSessionRequest | null {
  if (!isRecord(value) || !isHubCharacterSlot(value.characterSlot)) return null;
  const arrival: HubArrival =
    typeof value.arrival === "string" && value.arrival in HUB_SPAWN_POINTS
      ? (value.arrival as HubArrival)
      : "center";
  return {
    characterSlot: value.characterSlot,
    displayName: normalizeHubDisplayName(value.displayName),
    level: normalizeHubLevel(value.level),
    dungeonFloor: normalizeHubDungeonFloor(value.dungeonFloor),
    appearance: normalizeHubAppearance(value.appearance),
    arrival,
  };
}

export function parseHubAppearanceRequest(value: unknown): HubAppearanceRequest | null {
  if (!isRecord(value)) return null;
  return {
    appearance: normalizeHubAppearance(value.appearance),
    level: normalizeHubLevel(value.level),
    dungeonFloor:
      value.dungeonFloor === undefined
        ? null
        : normalizeHubDungeonFloor(value.dungeonFloor),
  };
}
