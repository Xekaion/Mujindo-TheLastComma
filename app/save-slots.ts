export const LEGACY_SAVE_KEY = "mujindo:last-comma:save-v1";
export const SAVE_SLOT_KEY_PREFIX = "mujindo:last-comma:save-v2:slot:";
export const SAVE_RECOVERY_KEY_PREFIX =
  "mujindo:last-comma:save-recovery-v1:slot:";
export const ACTIVE_SAVE_SLOT_KEY = "mujindo:last-comma:active-save-slot-v1";
export const SAVE_SLOT_IDS = [1, 2, 3] as const;
export const SAVE_RECOVERY_GENERATIONS = [1, 2, 3] as const;
export const SAVE_AUGMENT_STACK_CAP = 20;
export const DEFAULT_DUNGEON_FLOOR = 1;

export type SaveSlotId = (typeof SAVE_SLOT_IDS)[number];
export type SaveRecoveryGeneration =
  (typeof SAVE_RECOVERY_GENERATIONS)[number];

export type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

type JsonRecord = Record<string, unknown>;

export type SaveRunPayload = JsonRecord & {
  savedAt: number;
  expeditionPowerRatingVersion?: number;
  player: JsonRecord & {
    level: number;
    rooms?: number;
    augments: Record<string, number>;
    endingSeen?: boolean;
    endingVersion?: number;
    bossesCleared?: number;
    profession?: string | null;
    inventory?: unknown[];
    equipment?: JsonRecord;
  };
  world?: JsonRecord & {
    rooms?: JsonRecord;
    dungeonFloor?: number;
  };
  stableAugments?: Record<string, number>;
};

export type SaveSlotSummary = {
  slot: SaveSlotId;
  savedAt: number;
  level: number;
  roomsCleared: number;
  dungeonFloor: number;
  augmentStacks: number;
  profession: string | null;
  inventoryItems: number;
  equippedItems: number;
};

export type SaveRecoveryCandidate = {
  slot: SaveSlotId;
  generation: SaveRecoveryGeneration;
  raw: string;
  save: SaveRunPayload;
  summary: SaveSlotSummary;
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

function normalizeSavedAugmentStacks(
  stacks: Record<string, number>,
): Record<string, number> {
  return Object.fromEntries(
    Object.entries(stacks)
      .map(([id, value]) => [
        id,
        Math.min(SAVE_AUGMENT_STACK_CAP, Math.max(0, Math.floor(value))),
      ] as const)
      .filter(([, value]) => value > 0),
  );
}

/** Mirrors the runtime floor rule while keeping standalone save parsing dependency-free. */
export function normalizeDungeonFloor(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1
    ? value
    : DEFAULT_DUNGEON_FLOOR;
}

function normalizeSaveRunPayload(save: SaveRunPayload): SaveRunPayload {
  return {
    ...save,
    player: {
      ...save.player,
      augments: normalizeSavedAugmentStacks(save.player.augments),
    },
    ...(save.stableAugments
      ? { stableAugments: normalizeSavedAugmentStacks(save.stableAugments) }
      : {}),
    ...(save.world
      ? {
          world: {
            ...save.world,
            dungeonFloor: normalizeDungeonFloor(save.world.dungeonFloor),
          },
        }
      : {}),
  };
}

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

export function saveRecoveryKey(
  slot: SaveSlotId,
  generation: SaveRecoveryGeneration = 1,
): string {
  if (!isSaveSlotId(slot)) {
    throw new RangeError(`Invalid save slot: ${String(slot)}`);
  }
  if (!SAVE_RECOVERY_GENERATIONS.includes(generation)) {
    throw new RangeError(`Invalid save recovery generation: ${String(generation)}`);
  }
  return `${SAVE_RECOVERY_KEY_PREFIX}${slot}:${generation}`;
}

export function hasSaveSlotData(
  slot: SaveSlotId,
  storage?: StorageLike | null,
): boolean {
  const target = resolveStorage(storage);
  if (!target) return false;
  try {
    return target.getItem(saveSlotKey(slot)) !== null;
  } catch {
    return false;
  }
}

export function readActiveSaveSlot(
  storage?: StorageLike | null,
): SaveSlotId {
  const target = resolveStorage(storage);
  if (!target) return 1;
  try {
    const parsed = Number(target.getItem(ACTIVE_SAVE_SLOT_KEY));
    return isSaveSlotId(parsed) ? parsed : 1;
  } catch {
    return 1;
  }
}

export function writeActiveSaveSlot(
  slot: SaveSlotId,
  storage?: StorageLike | null,
): boolean {
  if (!isSaveSlotId(slot)) return false;
  const target = resolveStorage(storage);
  if (!target) return false;
  try {
    target.setItem(ACTIVE_SAVE_SLOT_KEY, String(slot));
    return true;
  } catch {
    return false;
  }
}

export function isSaveRunPayload(value: unknown): value is SaveRunPayload {
  if (!isRecord(value) || !isNonNegativeInteger(value.savedAt)) return false;
  if (!isRecord(value.player)) return false;
  if (
    value.expeditionPowerRatingVersion !== undefined &&
    !isPositiveInteger(value.expeditionPowerRatingVersion)
  ) {
    return false;
  }
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

  if (
    value.player.endingSeen !== undefined &&
    typeof value.player.endingSeen !== "boolean"
  ) {
    return false;
  }

  if (
    value.player.endingVersion !== undefined &&
    !isNonNegativeInteger(value.player.endingVersion)
  ) {
    return false;
  }
  if (
    value.player.bossesCleared !== undefined &&
    !isNonNegativeInteger(value.player.bossesCleared)
  ) {
    return false;
  }

  if (value.world !== undefined) {
    if (!isRecord(value.world)) return false;
    if (value.world.rooms !== undefined && !isRecord(value.world.rooms)) return false;
    if (
      value.world.dungeonFloor !== undefined &&
      !isPositiveInteger(value.world.dungeonFloor)
    ) {
      return false;
    }
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
    return isSaveRunPayload(value) ? normalizeSaveRunPayload(value) : null;
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
    dungeonFloor: normalizeDungeonFloor(save.world?.dungeonFloor),
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
    const key = saveSlotKey(slot);
    const previousRaw = target.getItem(key);
    const nextRaw = JSON.stringify(normalizeSaveRunPayload(save));
    if (previousRaw === nextRaw) return true;
    if (
      previousRaw !== null &&
      !preserveSaveSlotRaw(slot, previousRaw, target)
    ) {
      return false;
    }

    target.setItem(key, nextRaw);
    if (target.getItem(key) === nextRaw) return true;

    if (previousRaw === null) target.removeItem(key);
    else target.setItem(key, previousRaw);
    return false;
  } catch {
    return false;
  }
}

export function markSaveSlotEndingSeen(
  slot: SaveSlotId,
  endingVersion: number,
  storage?: StorageLike | null,
): boolean {
  if (!Number.isSafeInteger(endingVersion) || endingVersion < 0) return false;
  const save = readSaveSlot(slot, storage);
  if (!save) return false;

  return writeSaveSlot(
    slot,
    {
      ...save,
      player: {
        ...save.player,
        endingSeen: true,
        endingVersion,
      },
    },
    storage,
  );
}

export function removeSaveSlot(
  slot: SaveSlotId,
  storage?: StorageLike | null,
): boolean {
  const target = resolveStorage(storage);
  if (!target) return false;
  try {
    const key = saveSlotKey(slot);
    const previousRaw = target.getItem(key);
    if (previousRaw === null) return true;
    if (!preserveSaveSlotRaw(slot, previousRaw, target)) return false;
    target.removeItem(key);
    return target.getItem(key) === null;
  } catch {
    return false;
  }
}

function preserveSaveSlotRaw(
  slot: SaveSlotId,
  raw: string,
  storage: StorageLike,
): boolean {
  try {
    const newestKey = saveRecoveryKey(slot, 1);
    if (storage.getItem(newestKey) === raw) return true;

    for (let index = SAVE_RECOVERY_GENERATIONS.length - 1; index >= 1; index -= 1) {
      const destinationGeneration = SAVE_RECOVERY_GENERATIONS[index];
      const sourceGeneration = SAVE_RECOVERY_GENERATIONS[index - 1];
      const sourceRaw = storage.getItem(saveRecoveryKey(slot, sourceGeneration));
      if (sourceRaw === null) continue;
      const destinationKey = saveRecoveryKey(slot, destinationGeneration);
      storage.setItem(destinationKey, sourceRaw);
      if (storage.getItem(destinationKey) !== sourceRaw) return false;
    }

    storage.setItem(newestKey, raw);
    return storage.getItem(newestKey) === raw;
  } catch {
    return false;
  }
}

export function readSaveRecoveryCandidates(
  storage?: StorageLike | null,
): SaveRecoveryCandidate[] {
  const target = resolveStorage(storage);
  if (!target) return [];

  const candidates: SaveRecoveryCandidate[] = [];
  try {
    for (const slot of SAVE_SLOT_IDS) {
      for (const generation of SAVE_RECOVERY_GENERATIONS) {
        const raw = target.getItem(saveRecoveryKey(slot, generation));
        const save = parseSaveRun(raw);
        if (raw === null || !save) continue;
        candidates.push({
          slot,
          generation,
          raw,
          save,
          summary: summarizeSaveSlot(slot, save),
        });
      }
    }
  } catch {
    return [];
  }
  return candidates;
}

export function restoreSaveRecoveryCandidate(
  sourceSlot: SaveSlotId,
  generation: SaveRecoveryGeneration,
  destinationSlot: SaveSlotId = sourceSlot,
  storage?: StorageLike | null,
): boolean {
  const target = resolveStorage(storage);
  if (!target) return false;

  try {
    const destinationKey = saveSlotKey(destinationSlot);
    if (target.getItem(destinationKey) !== null) return false;
    const raw = target.getItem(saveRecoveryKey(sourceSlot, generation));
    if (raw === null || !parseSaveRun(raw)) return false;

    target.setItem(destinationKey, raw);
    if (
      target.getItem(destinationKey) === raw &&
      readSaveSlot(destinationSlot, target) !== null
    ) {
      return true;
    }
    target.removeItem(destinationKey);
    return false;
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
    const normalized = parseSaveRun(legacyRaw);
    if (!normalized) return "legacy-invalid";

    const normalizedRaw = JSON.stringify(normalized);
    target.setItem(saveSlotKey(1), normalizedRaw);
    return target.getItem(saveSlotKey(1)) === normalizedRaw
      ? "copied"
      : "write-failed";
  } catch {
    return "write-failed";
  }
}
