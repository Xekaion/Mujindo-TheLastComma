import {
  EQUIPMENT_SLOT_LABELS,
  EQUIPMENT_SLOTS,
  GEAR_ICON_COLUMNS,
  GEAR_ICON_ROWS,
  GEAR_RARITIES,
  gearIconCell,
  type EquipmentLoadout,
  type EquipmentSlot,
  type GearItem,
  type GearRarity,
} from "./equipment";

export const INVENTORY_PORTRAIT_BASE_PATH =
  "/assets/ui/inventory-portrait/mannequin-base-v1.png";
export const INVENTORY_PORTRAIT_FITTED_ARMOR_PATH =
  "/assets/ui/inventory-portrait/fitted-armor-v1.png";
export const INVENTORY_PORTRAIT_GEAR_ATLAS_PATH =
  "/assets/equipment/equipment-types-v4.png";

export const INVENTORY_PORTRAIT_FITTED_SLOTS = [
  "helm",
  "shoulders",
  "armor",
  "gloves",
  "belt",
  "legs",
  "boots",
] as const satisfies readonly EquipmentSlot[];

const INVENTORY_PORTRAIT_FITTED_SLOT_SET: ReadonlySet<EquipmentSlot> =
  new Set(INVENTORY_PORTRAIT_FITTED_SLOTS);

const INVENTORY_PORTRAIT_VARIANT_HUES = [
  0,
  190,
  145,
  -12,
  260,
  20,
  175,
  225,
  -20,
  250,
] as const;

export function isInventoryPortraitFittedSlot(
  slot: EquipmentSlot,
): boolean {
  return INVENTORY_PORTRAIT_FITTED_SLOT_SET.has(slot);
}

export function inventoryPortraitVariantHue(row: number): number {
  const safeRow = Math.max(
    0,
    Math.min(INVENTORY_PORTRAIT_VARIANT_HUES.length - 1, Math.floor(row)),
  );
  return INVENTORY_PORTRAIT_VARIANT_HUES[safeRow];
}

export type InventoryPortraitSlotGeometry = Readonly<{
  left: number;
  top: number;
  width: number;
  rotation: number;
  zIndex: number;
}>;

/**
 * Back-to-front order for the dedicated inventory illustration.
 *
 * Percentages are authored against a 2:3 portrait stage. Square atlas cells
 * therefore consume two thirds of their CSS width in stage-height percentage.
 * The small outer overhang is intentional for held weapons, never body armour.
 */
export const INVENTORY_PORTRAIT_SLOT_ORDER = [
  "legs",
  "boots",
  "armor",
  "belt",
  "shoulders",
  "gloves",
  "helm",
  "relic",
  "weapon",
  "offhand",
] as const satisfies readonly EquipmentSlot[];

export const INVENTORY_PORTRAIT_SLOT_GEOMETRY: Readonly<
  Record<EquipmentSlot, InventoryPortraitSlotGeometry>
> = {
  legs: { left: 25, top: 47, width: 50, rotation: 0, zIndex: 2 },
  boots: { left: 26, top: 67, width: 48, rotation: 0, zIndex: 4 },
  armor: { left: 26, top: 16, width: 48, rotation: 0, zIndex: 5 },
  belt: { left: 27, top: 32, width: 46, rotation: 0, zIndex: 8 },
  shoulders: { left: 20, top: 5, width: 60, rotation: 0, zIndex: 6 },
  gloves: { left: 12, top: 14, width: 76, rotation: 0, zIndex: 7 },
  helm: { left: 36, top: 0, width: 28, rotation: 0, zIndex: 10 },
  relic: { left: 42, top: 19, width: 16, rotation: 0, zIndex: 11 },
  weapon: { left: 2, top: 29, width: 44, rotation: -8, zIndex: 12 },
  offhand: { left: 54, top: 27, width: 44, rotation: 3, zIndex: 13 },
};

export type InventoryPortraitPiece = Readonly<{
  slot: EquipmentSlot;
  item: GearItem;
  column: number;
  row: number;
  backgroundX: number;
  backgroundY: number;
  geometry: InventoryPortraitSlotGeometry;
}>;

export function resolveInventoryPortraitPiece(
  slot: EquipmentSlot,
  item: GearItem,
): InventoryPortraitPiece {
  const { column, row } = gearIconCell(item.iconIndex);
  return {
    slot,
    item,
    column,
    row,
    backgroundX:
      GEAR_ICON_COLUMNS > 1 ? (column / (GEAR_ICON_COLUMNS - 1)) * 100 : 0,
    backgroundY:
      GEAR_ICON_ROWS > 1 ? (row / (GEAR_ICON_ROWS - 1)) * 100 : 0,
    geometry: INVENTORY_PORTRAIT_SLOT_GEOMETRY[slot],
  };
}

export function inventoryPortraitPieces(
  equipment: EquipmentLoadout,
): readonly InventoryPortraitPiece[] {
  return INVENTORY_PORTRAIT_SLOT_ORDER.flatMap((slot) => {
    const item = equipment[slot];
    return item ? [resolveInventoryPortraitPiece(slot, item)] : [];
  });
}

export function createInventoryPortraitSignature(
  equipment: EquipmentLoadout,
): string {
  return EQUIPMENT_SLOTS.map((slot) => {
    const item = equipment[slot];
    return item
      ? `${slot}:${item.iconIndex}:${item.rarity}:${item.enhancement}`
      : `${slot}:-`;
  }).join("|");
}

export function strongestInventoryPortraitRarity(
  equipment: EquipmentLoadout,
): GearRarity {
  let strongest: GearRarity = "common";
  let strongestIndex = 0;
  for (const slot of EQUIPMENT_SLOTS) {
    const rarity = equipment[slot]?.rarity;
    if (!rarity) continue;
    const rarityIndex = GEAR_RARITIES.indexOf(rarity);
    if (rarityIndex > strongestIndex) {
      strongest = rarity;
      strongestIndex = rarityIndex;
    }
  }
  return strongest;
}

export function inventoryPortraitAppearanceLabel(
  equipment: EquipmentLoadout,
): string {
  const equippedSlots = EQUIPMENT_SLOTS.filter((slot) => equipment[slot]);
  if (equippedSlots.length === 0) {
    return "장비를 착용하지 않은 정면 인체 일러스트";
  }
  return `정면 장비 일러스트. ${equippedSlots
    .map((slot) => EQUIPMENT_SLOT_LABELS[slot])
    .join(", ")} 장착 반영`;
}
