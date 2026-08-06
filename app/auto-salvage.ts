import type { GearItem, GearRarity } from "./equipment";
import type { SaveSlotId, StorageLike } from "./save-slots";

/**
 * Automatic salvage deliberately stops below legendary. The irreversible
 * convenience setting can never consume the game's chase rarities.
 */
export const AUTO_SALVAGE_RARITIES = [
  "common",
  "magic",
  "superior",
  "rare",
  "epic",
] as const satisfies readonly GearRarity[];

export type AutoSalvageThreshold =
  | (typeof AUTO_SALVAGE_RARITIES)[number]
  | null;

export const AUTO_SALVAGE_PREFERENCE_KEY_PREFIX =
  "mujindo:last-comma:auto-salvage-v1:slot:";

const AUTO_SALVAGE_OFF_VALUE = "off";
const SAVE_SLOT_IDS = [1, 2, 3] as const;

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

function assertSaveSlot(slot: SaveSlotId) {
  if (!SAVE_SLOT_IDS.some((candidate) => candidate === slot)) {
    throw new RangeError(`Invalid save slot: ${String(slot)}`);
  }
}

export function autoSalvagePreferenceKey(slot: SaveSlotId): string {
  assertSaveSlot(slot);
  return `${AUTO_SALVAGE_PREFERENCE_KEY_PREFIX}${slot}`;
}

export function normalizeAutoSalvageThreshold(
  value: unknown,
): AutoSalvageThreshold {
  return AUTO_SALVAGE_RARITIES.some((rarity) => rarity === value)
    ? (value as Exclude<AutoSalvageThreshold, null>)
    : null;
}

export function shouldAutoSalvageRarity(
  rarity: GearRarity,
  threshold: AutoSalvageThreshold,
): boolean {
  if (threshold === null) return false;
  const rarityIndex = AUTO_SALVAGE_RARITIES.indexOf(
    rarity as (typeof AUTO_SALVAGE_RARITIES)[number],
  );
  const thresholdIndex = AUTO_SALVAGE_RARITIES.indexOf(threshold);
  return rarityIndex >= 0 && rarityIndex <= thresholdIndex;
}

/**
 * `undefined` means no preference has ever been written for the slot. `null`
 * is an explicit off setting and is therefore distinct during save hydration.
 */
export function readAutoSalvagePreference(
  slot: SaveSlotId,
  storage?: StorageLike | null,
): AutoSalvageThreshold | undefined {
  const resolved = resolveStorage(storage);
  if (!resolved) return undefined;
  try {
    const raw = resolved.getItem(autoSalvagePreferenceKey(slot));
    if (raw === null) return undefined;
    if (raw === AUTO_SALVAGE_OFF_VALUE) return null;
    const normalized = normalizeAutoSalvageThreshold(raw);
    return normalized === null ? undefined : normalized;
  } catch {
    return undefined;
  }
}

export function writeAutoSalvagePreference(
  slot: SaveSlotId,
  threshold: AutoSalvageThreshold,
  storage?: StorageLike | null,
): boolean {
  const resolved = resolveStorage(storage);
  if (!resolved) return false;
  const value = threshold ?? AUTO_SALVAGE_OFF_VALUE;
  try {
    const key = autoSalvagePreferenceKey(slot);
    resolved.setItem(key, value);
    return resolved.getItem(key) === value;
  } catch {
    return false;
  }
}

/**
 * A rarity filter behaves like one tri-state toggle: all selected -> clear
 * that rarity, otherwise select every item of that rarity. Other grades stay
 * untouched, including partially built manual selections.
 */
export function toggleRaritySalvageSelection(
  inventory: readonly Pick<GearItem, "id" | "rarity">[],
  current: ReadonlySet<string>,
  rarity: GearRarity,
): Set<string> {
  const targetIds = inventory
    .filter((item) => item.rarity === rarity)
    .map((item) => item.id);
  const next = new Set(current);
  if (targetIds.length === 0) return next;

  if (targetIds.every((id) => next.has(id))) {
    targetIds.forEach((id) => next.delete(id));
  } else {
    targetIds.forEach((id) => next.add(id));
  }
  return next;
}
