import {
  PLAZA_PLAYER_RADIUS,
  PLAZA_PORTALS,
  PLAZA_SPAWN_POINT,
  PLAZA_WORLD_HEIGHT,
  PLAZA_WORLD_WIDTH,
  type PlazaPortalDefinition,
  type PlazaPortalId,
} from "./plaza-world";
import {
  EQUIPMENT_SLOTS,
  GEAR_ICON_COLUMNS,
  GEAR_ICON_ROWS,
  GEAR_RARITIES,
  normalizeEquipment,
  normalizeGearItem,
  type EquipmentLoadout,
  type EquipmentSlot,
  type GearAffixStat,
  type GearItem,
  type GearRarity,
} from "./equipment";

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
export const HUB_DASH_DURATION_MS = 170;
export const HUB_DASH_SPEED = 900;
export const HUB_DASH_DISTANCE = HUB_DASH_SPEED * (HUB_DASH_DURATION_MS / 1_000);
export const HUB_DASH_BASE_COOLDOWN_MS = 1_350;
// The authority accepts the fastest supported equipment cadence without
// receiving or exposing any private legendary-power data.
export const HUB_DASH_COOLDOWN_MS = HUB_DASH_BASE_COOLDOWN_MS / 1.3;
export const HUB_DASH_SWEEP_STEP_PX = 16;
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
export type HubVisualRarities = Record<HubVisualGearSlot, GearRarity | null>;

export type HubAppearance = {
  spriteKey: HubSpriteKey;
  palette: HubPalette;
  gear: HubVisualGear;
  /** Cosmetic-only rarity summary. Never grants combat or economy authority. */
  rarities: HubVisualRarities;
};

/**
 * Strictly allowlisted equipment data that another plaza player may inspect.
 * Identity, derived power, trade state, and formatted copy never cross the
 * public-profile boundary.
 */
export type HubPublicGearAffix = {
  stat: GearAffixStat;
  value: number;
  rollPercent: number;
};

export type HubPublicGearItem = {
  slot: EquipmentSlot;
  rarity: GearRarity;
  level: number;
  baseName: string;
  enhancement: number;
  enhancementRanks: number[];
  affixes: HubPublicGearAffix[];
};

export type HubPublicEquipment = Record<EquipmentSlot, HubPublicGearItem | null>;

export type HubCharacterProfile = {
  characterId: string;
  displayName: string;
  level: number;
  dungeonFloor: number;
  publicEquipment: HubPublicEquipment;
  updatedAt: number;
};

export type HubStoredAppearanceEnvelope = {
  appearance: HubAppearance;
  publicEquipment: HubPublicEquipment;
};

export type HubMoveIntent = {
  sequence: number;
  moveX: number;
  moveY: number;
  facing: HubFacing;
  dash: boolean;
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
  publicEquipment: HubPublicEquipment;
  arrival: HubArrival;
};

export type HubAppearanceRequest = {
  appearance: HubAppearance;
  level: number;
  /** Null only for rolling-upgrade clients that predate the public claim. */
  dungeonFloor: number | null;
  /** Null means a rolling-upgrade client omitted the field; preserve storage. */
  publicEquipment: HubPublicEquipment | null;
};

export type HubCharacterProfileRequest = {
  characterId: string;
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

const emptyVisualRarities = (): HubVisualRarities => ({
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

export const createEmptyHubPublicEquipment = (): HubPublicEquipment =>
  Object.fromEntries(EQUIPMENT_SLOTS.map((slot) => [slot, null])) as HubPublicEquipment;

export const DEFAULT_HUB_APPEARANCE: Readonly<HubAppearance> = {
  spriteKey: "harin",
  palette: "scarlet",
  gear: emptyVisualGear(),
  rarities: emptyVisualRarities(),
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
  const rawRarities = isRecord(raw.rarities) ? raw.rarities : {};
  const gear = emptyVisualGear();
  const rarities = emptyVisualRarities();
  for (const slot of HUB_VISUAL_GEAR_SLOTS) {
    gear[slot] = normalizeGearVariant(rawGear[slot]);
    rarities[slot] = isOneOf(GEAR_RARITIES, rawRarities[slot])
      ? rawRarities[slot]
      : null;
  }
  return {
    spriteKey: isOneOf(HUB_SPRITE_KEYS, raw.spriteKey)
      ? raw.spriteKey
      : DEFAULT_HUB_APPEARANCE.spriteKey,
    palette: isOneOf(HUB_PALETTES, raw.palette)
      ? raw.palette
      : DEFAULT_HUB_APPEARANCE.palette,
    gear,
    rarities,
  };
}

/**
 * Produces the allowlisted visual summary used by both normal plaza entry and
 * storage-free QA characters. Canonical equipment remains the only input;
 * private item fields never reach the public appearance object.
 */
export function hubAppearanceFromLoadout(
  value: unknown,
  palette: HubPalette = DEFAULT_HUB_APPEARANCE.palette,
): HubAppearance {
  const loadout = normalizeEquipment(value);
  const gear = emptyVisualGear();
  const rarities = emptyVisualRarities();
  let equipped = false;
  for (const slot of HUB_VISUAL_GEAR_SLOTS) {
    const item = loadout[slot];
    if (!item) continue;
    equipped = true;
    gear[slot] = Math.max(
      0,
      Math.min(
        GEAR_ICON_ROWS - 1,
        Math.floor(item.iconIndex / GEAR_ICON_COLUMNS),
      ),
    );
    rarities[slot] = item.rarity;
  }
  return {
    spriteKey: equipped ? "harin-equipped" : "harin",
    palette,
    gear,
    rarities,
  };
}

function publicGearFromCanonical(item: GearItem): HubPublicGearItem {
  return {
    slot: item.slot,
    rarity: item.rarity,
    level: item.level,
    baseName: item.baseName,
    enhancement: item.enhancement,
    enhancementRanks: [...item.enhancementRanks],
    affixes: item.affixes.map(({ stat, value, rollPercent }) => ({
      stat,
      value,
      rollPercent,
    })),
  };
}

function canonicalGearFromPublic(
  value: unknown,
  expectedSlot: EquipmentSlot,
): GearItem | null {
  if (!isRecord(value) || value.slot !== expectedSlot) return null;
  // The canonical equipment normalizer validates slot/rarity/base, affix pool,
  // roll percentile, enhancement bounds, and level. All omitted derived fields
  // are regenerated, while every unknown public field is discarded.
  return normalizeGearItem({
    id: `hub-public-${expectedSlot}`,
    slot: value.slot,
    rarity: value.rarity,
    level: value.level,
    baseName: value.baseName,
    enhancement: value.enhancement,
    enhancementRanks: value.enhancementRanks,
    affixes: value.affixes,
  });
}

export function normalizeHubPublicGearItem(
  value: unknown,
  expectedSlot: EquipmentSlot,
): HubPublicGearItem | null {
  const canonical = canonicalGearFromPublic(value, expectedSlot);
  return canonical ? publicGearFromCanonical(canonical) : null;
}

/** Normalizes all ten slots and drops malformed, mismatched, or unknown data. */
export function normalizeHubPublicEquipment(value: unknown): HubPublicEquipment {
  const raw = isRecord(value) ? value : {};
  const equipment = createEmptyHubPublicEquipment();
  for (const slot of EQUIPMENT_SLOTS) {
    equipment[slot] = normalizeHubPublicGearItem(raw[slot], slot);
  }
  return equipment;
}

export function hubPublicEquipmentFromLoadout(value: unknown): HubPublicEquipment {
  const loadout = normalizeEquipment(value);
  const equipment = createEmptyHubPublicEquipment();
  for (const slot of EQUIPMENT_SLOTS) {
    const item = loadout[slot];
    equipment[slot] = item ? publicGearFromCanonical(item) : null;
  }
  return equipment;
}

export function hubPublicEquipmentToLoadout(value: unknown): EquipmentLoadout {
  const publicEquipment = normalizeHubPublicEquipment(value);
  const loadout = Object.fromEntries(
    EQUIPMENT_SLOTS.map((slot) => [
      slot,
      publicEquipment[slot]
        ? canonicalGearFromPublic(publicEquipment[slot], slot)
        : null,
    ]),
  ) as EquipmentLoadout;
  return normalizeEquipment(loadout);
}

/** Reads both the new envelope and the legacy raw HubAppearance JSON shape. */
export function normalizeHubStoredAppearanceEnvelope(
  value: unknown,
): HubStoredAppearanceEnvelope {
  if (isRecord(value) && "appearance" in value) {
    return {
      appearance: normalizeHubAppearance(value.appearance),
      publicEquipment: normalizeHubPublicEquipment(value.publicEquipment),
    };
  }
  return {
    appearance: normalizeHubAppearance(value),
    publicEquipment: createEmptyHubPublicEquipment(),
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

const HUB_CHARACTER_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isHubCharacterId(value: unknown): value is string {
  return typeof value === "string" && HUB_CHARACTER_ID_PATTERN.test(value);
}

export function parseHubCharacterProfileRequest(
  value: unknown,
): HubCharacterProfileRequest | null {
  if (!isRecord(value) || !isHubCharacterId(value.characterId)) return null;
  return { characterId: value.characterId.toLowerCase() };
}

export function parseHubCharacterProfile(value: unknown): HubCharacterProfile | null {
  if (
    !isRecord(value) ||
    !isHubCharacterId(value.characterId) ||
    typeof value.displayName !== "string" ||
    !isFiniteNumber(value.level) ||
    !isFiniteNumber(value.dungeonFloor) ||
    !isFiniteNumber(value.updatedAt)
  ) {
    return null;
  }
  return {
    characterId: value.characterId.toLowerCase(),
    displayName: normalizeHubDisplayName(value.displayName),
    level: normalizeHubLevel(value.level),
    dungeonFloor: normalizeHubDungeonFloor(value.dungeonFloor),
    publicEquipment: normalizeHubPublicEquipment(value.publicEquipment),
    updatedAt: Math.max(0, Math.floor(value.updatedAt)),
  };
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
    dash: value.dash === true,
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
    publicEquipment: normalizeHubPublicEquipment(value.publicEquipment),
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
    publicEquipment:
      value.publicEquipment === undefined
        ? null
        : normalizeHubPublicEquipment(value.publicEquipment),
  };
}
