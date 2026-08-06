export const LEGACY_SAVE_KEY = "mujindo:last-comma:save-v1";
export const SAVE_SLOT_KEY_PREFIX = "mujindo:last-comma:save-v2:slot:";
export const SAVE_SLOT_IDS = [1, 2, 3] as const;

export type SaveSlotId = (typeof SAVE_SLOT_IDS)[number];

export type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

type JsonRecord = Record<string, unknown>;

export type SaveRunPayload = JsonRecord & {
  savedAt: number;
  player: JsonRecord & {
    level: number;
    rooms?: number;
    augments: Record<string, number>;
    profession?: string | null;
    inventory?: unknown[];
    equipment?: JsonRecord;
  };
  world?: JsonRecord & {
    rooms?: JsonRecord;
  };
  stableAugments?: Record<string, number>;
};

export type SaveSlotSummary = {
  slot: SaveSlotId;
  savedAt: number;
  level: number;
  roomsCleared: number;
  augmentStacks: number;
  profession: string | null;
  inventoryItems: number;
  equippedItems: number;
};

export type LegacyMigrationResult =
  | "copied"
  | "slot-occupied"
  | "legacy-empty"
  | "legacy-invalid"
  | "storage-unavailable"
  | "write-failed";

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isNonNegativeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

const isPositiveInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 1;

const isStackRecord = (value: unknown): value is Record<string, number> =>
  isRecord(value) && Object.values(value).every(isNonNegativeInteger);

const hasValidOptionalRooms = (value: JsonRecord) =>
  value.rooms === undefined || isNonNegativeInteger(value.rooms);

function browserStorage(): StorageLike | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function resolveStorage(storage?: StorageLike | null): StorageLike | null {
  return storage === undefined ? browserStorage() : storage;
}

export function isSaveSlotId(value: unknown): value is SaveSlotId {
  return SAVE_SLOT_IDS.some((slot) => slot === value);
}

export function saveSlotKey(slot: SaveSlotId): string {
  if (!isSaveSlotId(slot)) {
    throw new RangeError(`Invalid save slot: ${String(slot)}`);
  }
  return `${SAVE_SLOT_KEY_PREFIX}${slot}`;
}

export function isSaveRunPayload(value: unknown): value is SaveRunPayload {
  if (!isRecord(value) || !isNonNegativeInteger(value.savedAt)) return false;
  if (!isRecord(value.player)) return false;
  if (!isPositiveInteger(value.player.level)) return false;
  if (!isStackRecord(value.player.augments)) return false;
  if (!hasValidOptionalRooms(value.player)) return false;
  if (
    value.player.inventory !== undefined &&
    !Array.isArray(value.player.inventory)
  ) {
    return false;
  }
  if (
    value.player.equipment !== undefined &&
    !isRecord(value.player.equipment)
  ) {
    return false;
  }

  const profession = value.player.profession;
  if (
    profession !== undefined &&
    profession !== null &&
    typeof profession !== "string"
  ) {
    return false;
  }

  if (value.world !== undefined) {
    if (!isRecord(value.world)) return false;
    if (value.world.rooms !== undefined && !isRecord(value.world.rooms)) return false;
  }

  if (
    value.stableAugments !== undefined &&
    !isStackRecord(value.stableAugments)
  ) {
    return false;
  }

  return true;
}

export function parseSaveRun(raw: string | null): SaveRunPayload | null {
  if (raw === null) return null;
  try {
    const value: unknown = JSON.parse(raw);
    return isSaveRunPayload(value) ? value : null;
  } catch {
    return null;
  }
}

export function summarizeSaveSlot(
  slot: SaveSlotId,
  save: SaveRunPayload,
): SaveSlotSummary {
  const playerRooms = save.player.rooms;
  const profession = save.player.profession;

  return {
    slot,
    savedAt: save.savedAt,
    level: save.player.level,
    roomsCleared: typeof playerRooms === "number" ? playerRooms : 0,
    augmentStacks: Object.values(save.player.augments).reduce(
      (total, stacks) => total + stacks,
      0,
    ),
    profession:
      typeof profession === "string" && profession.trim().length > 0
        ? profession
        : null,
    inventoryItems: Array.isArray(save.player.inventory)
      ? save.player.inventory.length
      : 0,
    equippedItems: isRecord(save.player.equipment)
      ? Object.values(save.player.equipment).filter((item) => item !== null).length
      : 0,
  };
}

export function readSaveSlot(
  slot: SaveSlotId,
  storage?: StorageLike | null,
): SaveRunPayload | null {
  const target = resolveStorage(storage);
  if (!target) return null;
  try {
    return parseSaveRun(target.getItem(saveSlotKey(slot)));
  } catch {
    return null;
  }
}

export function writeSaveSlot(
  slot: SaveSlotId,
  save: unknown,
  storage?: StorageLike | null,
): boolean {
  if (!isSaveRunPayload(save)) return false;
  const target = resolveStorage(storage);
  if (!target) return false;

  try {
    target.setItem(saveSlotKey(slot), JSON.stringify(save));
    return true;
  } catch {
    return false;
  }
}

export function removeSaveSlot(
  slot: SaveSlotId,
  storage?: StorageLike | null,
): boolean {
  const target = resolveStorage(storage);
  if (!target) return false;
  try {
    target.removeItem(saveSlotKey(slot));
    return true;
  } catch {
    return false;
  }
}

export function readSaveSlotSummaries(
  storage?: StorageLike | null,
): Array<SaveSlotSummary | null> {
  return SAVE_SLOT_IDS.map((slot) => {
    const save = readSaveSlot(slot, storage);
    return save ? summarizeSaveSlot(slot, save) : null;
  });
}

export function migrateLegacySave(
  storage?: StorageLike | null,
): LegacyMigrationResult {
  const target = resolveStorage(storage);
  if (!target) return "storage-unavailable";

  try {
    // Any existing slot-1 value, even a corrupt one, is preserved rather than
    // overwritten. Recovery or deletion remains an explicit user action.
    if (target.getItem(saveSlotKey(1)) !== null) return "slot-occupied";

    const legacyRaw = target.getItem(LEGACY_SAVE_KEY);
    if (legacyRaw === null) return "legacy-empty";
    if (!parseSaveRun(legacyRaw)) return "legacy-invalid";

    target.setItem(saveSlotKey(1), legacyRaw);
    return target.getItem(saveSlotKey(1)) === legacyRaw
      ? "copied"
      : "write-failed";
  } catch {
    return "write-failed";
  }
}
