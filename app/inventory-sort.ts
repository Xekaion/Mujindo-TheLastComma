import type { GearItem } from "./equipment";

export const INVENTORY_SLOT_ORDER = [
  "weapon",
  "offhand",
  "helm",
  "shoulders",
  "armor",
  "gloves",
  "belt",
  "legs",
  "boots",
  "relic",
] as const satisfies ReadonlyArray<GearItem["slot"]>;

export const INVENTORY_RARITY_ORDER = [
  "common",
  "magic",
  "superior",
  "rare",
  "epic",
  "legendary",
  "mythic",
  "cosmic",
] as const satisfies ReadonlyArray<GearItem["rarity"]>;

export type InventorySortMode = "power" | "rarity" | "level" | "slot";

export const INVENTORY_SORT_OPTIONS: ReadonlyArray<{
  id: InventorySortMode;
  label: string;
  title: string;
}> = [
  { id: "power", label: "보스 화력", title: "아이템 보스 화력이 높은 장비부터 정렬" },
  { id: "rarity", label: "등급", title: "높은 등급 장비부터 정렬" },
  { id: "level", label: "레벨", title: "아이템 레벨이 높은 장비부터 정렬" },
  { id: "slot", label: "부위", title: "장비 부위 순서로 묶어서 정렬" },
];

const comparePower = (left: GearItem, right: GearItem) =>
  right.powerScore - left.powerScore;

const compareRarity = (left: GearItem, right: GearItem) =>
  INVENTORY_RARITY_ORDER.indexOf(right.rarity) -
  INVENTORY_RARITY_ORDER.indexOf(left.rarity);

const compareLevel = (left: GearItem, right: GearItem) =>
  right.level - left.level;

const compareSlot = (left: GearItem, right: GearItem) =>
  INVENTORY_SLOT_ORDER.indexOf(left.slot) -
  INVENTORY_SLOT_ORDER.indexOf(right.slot);

function compareInventoryItems(
  left: GearItem,
  right: GearItem,
  mode: InventorySortMode,
): number {
  if (mode === "power") {
    return (
      comparePower(left, right) ||
      compareRarity(left, right) ||
      compareLevel(left, right)
    );
  }
  if (mode === "rarity") {
    return (
      compareRarity(left, right) ||
      compareLevel(left, right) ||
      comparePower(left, right)
    );
  }
  if (mode === "level") {
    return (
      compareLevel(left, right) ||
      compareRarity(left, right) ||
      comparePower(left, right)
    );
  }
  return (
    compareSlot(left, right) ||
    compareRarity(left, right) ||
    compareLevel(left, right) ||
    comparePower(left, right)
  );
}

/**
 * Returns a stable display-only projection. The persisted acquisition order is
 * never mutated, so sorting cannot change save data or salvage identity.
 */
export function sortInventoryItems(
  inventory: ReadonlyArray<GearItem>,
  mode: InventorySortMode,
): GearItem[] {
  return inventory
    .map((item, acquisitionIndex) => ({ item, acquisitionIndex }))
    .sort(
      (left, right) =>
        compareInventoryItems(left.item, right.item, mode) ||
        left.acquisitionIndex - right.acquisitionIndex,
    )
    .map(({ item }) => item);
}
