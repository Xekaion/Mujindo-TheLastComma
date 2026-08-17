import { normalizeGearItem, type GearItem } from "../equipment";
import {
  SAVE_SLOT_IDS,
  isSaveSlotId,
  readActiveSaveSlot,
  readSaveSlot,
  writeSaveSlot,
  type SaveSlotId,
  type StorageLike,
} from "../save-slots";

export type CharacterMarketInventory = {
  slot: SaveSlotId;
  items: GearItem[];
  equippedCount: number;
  invalidCount: number;
};

export type CharacterItemRemovalResult =
  | "removed"
  | "missing"
  | "save-unavailable"
  | "write-failed";

export type CharacterImportReconciliation = {
  removedItemIds: string[];
  failedSlots: SaveSlotId[];
};

function browserStorage(): StorageLike | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function resolveCharacterMarketSlot(
  search: string,
  storage: StorageLike | null = browserStorage(),
): SaveSlotId {
  const requested = Number(new URLSearchParams(search).get("slot"));
  return isSaveSlotId(requested) ? requested : readActiveSaveSlot(storage);
}

export function readCharacterMarketInventory(
  slot: SaveSlotId,
  storage: StorageLike | null = browserStorage(),
): CharacterMarketInventory {
  const save = readSaveSlot(slot, storage);
  if (!save) {
    return { slot, items: [], equippedCount: 0, invalidCount: 0 };
  }

  const rawInventory = Array.isArray(save.player.inventory)
    ? save.player.inventory
    : [];
  const seenIds = new Set<string>();
  const items: GearItem[] = [];
  let invalidCount = 0;
  for (const value of rawInventory) {
    const item = normalizeGearItem(value);
    if (!item || seenIds.has(item.id)) {
      invalidCount += 1;
      continue;
    }
    seenIds.add(item.id);
    items.push(item);
  }

  const equippedCount = save.player.equipment
    ? Object.values(save.player.equipment).filter(
        (value) => normalizeGearItem(value) !== null,
      ).length
    : 0;

  return { slot, items, equippedCount, invalidCount };
}

export function gearItemToEconomyPayload(
  item: GearItem,
): Record<string, unknown> {
  return {
    ...item,
    enhancementRanks: [...item.enhancementRanks],
    affixes: item.affixes.map((affix) => ({ ...affix })),
  };
}

export function removeCharacterMarketItem(
  slot: SaveSlotId,
  itemId: string,
  storage: StorageLike | null = browserStorage(),
): CharacterItemRemovalResult {
  const save = readSaveSlot(slot, storage);
  if (!save) return "save-unavailable";
  const inventory = Array.isArray(save.player.inventory)
    ? save.player.inventory
    : [];
  const nextInventory = inventory.filter(
    (value) => normalizeGearItem(value)?.id !== itemId,
  );
  if (nextInventory.length === inventory.length) return "missing";

  const written = writeSaveSlot(
    slot,
    {
      ...save,
      savedAt: Date.now(),
      player: {
        ...save.player,
        inventory: nextInventory,
      },
    },
    storage,
  );
  return written ? "removed" : "write-failed";
}

/**
 * Completes the local half of a server-authoritative ownership transfer after
 * a timeout, reload, or tab close. The server's import ledger is the source of
 * truth, so every matching local copy is removed before it can be listed twice.
 */
export function reconcileImportedCharacterItems(
  importedItemIds: readonly string[],
  storage: StorageLike | null = browserStorage(),
): CharacterImportReconciliation {
  const imported = new Set(
    importedItemIds.filter(
      (itemId): itemId is string =>
        typeof itemId === "string" && itemId.length >= 1 && itemId.length <= 128,
    ),
  );
  const removedItemIds = new Set<string>();
  const failedSlots: SaveSlotId[] = [];
  if (imported.size === 0) return { removedItemIds: [], failedSlots };

  for (const slot of SAVE_SLOT_IDS) {
    const save = readSaveSlot(slot, storage);
    if (!save) continue;
    const inventory = Array.isArray(save.player.inventory)
      ? save.player.inventory
      : [];
    const slotRemovedItemIds: string[] = [];
    const nextInventory = inventory.filter((value) => {
      const itemId = normalizeGearItem(value)?.id;
      if (!itemId || !imported.has(itemId)) return true;
      slotRemovedItemIds.push(itemId);
      return false;
    });
    const nextEquipment = save.player.equipment
      ? Object.fromEntries(
          Object.entries(save.player.equipment).map(([equipmentSlot, value]) => {
            const itemId = normalizeGearItem(value)?.id;
            if (!itemId || !imported.has(itemId)) return [equipmentSlot, value];
            slotRemovedItemIds.push(itemId);
            return [equipmentSlot, null];
          }),
        )
      : save.player.equipment;
    if (slotRemovedItemIds.length === 0) continue;
    const written = writeSaveSlot(
      slot,
      {
        ...save,
        savedAt: Date.now(),
        player: {
          ...save.player,
          inventory: nextInventory,
          ...(nextEquipment ? { equipment: nextEquipment } : {}),
        },
      },
      storage,
    );
    if (!written) failedSlots.push(slot);
    else slotRemovedItemIds.forEach((itemId) => removedItemIds.add(itemId));
  }

  return { removedItemIds: [...removedItemIds], failedSlots };
}
