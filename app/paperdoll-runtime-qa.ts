import {
  EQUIPMENT_SLOTS,
  GEAR_BASE_NAMES,
  GEAR_ICON_COLUMNS,
  createEmptyEquipment,
  normalizeGearItem,
  rollGear,
  type EquipmentLoadout,
  type EquipmentSlot,
} from "./equipment";
import paperdollRigManifest from "./paperdoll-rig-manifest.json";

export const PAPERDOLL_RUNTIME_QA_VARIANT_COUNT = 10;
export const PAPERDOLL_RUNTIME_QA_DIRECTION_COUNT = 8;
export const PAPERDOLL_RUNTIME_QA_FRAME_COUNT = 4;
export const PAPERDOLL_RUNTIME_QA_ITEM_COUNT =
  EQUIPMENT_SLOTS.length * PAPERDOLL_RUNTIME_QA_VARIANT_COUNT;
export const PAPERDOLL_RUNTIME_QA_TOTAL =
  PAPERDOLL_RUNTIME_QA_ITEM_COUNT *
  PAPERDOLL_RUNTIME_QA_DIRECTION_COUNT *
  PAPERDOLL_RUNTIME_QA_FRAME_COUNT;

export const PAPERDOLL_RUNTIME_QA_COMPOSITE_BUILDS = Object.freeze(
  paperdollRigManifest.qaCompositeBuilds.map((build) =>
    Object.freeze({
      label: build.label,
      variants: Object.freeze([...build.variants]),
    }),
  ),
);
export const PAPERDOLL_RUNTIME_QA_COMPOSITE_TOTAL =
  PAPERDOLL_RUNTIME_QA_COMPOSITE_BUILDS.length *
  PAPERDOLL_RUNTIME_QA_DIRECTION_COUNT *
  PAPERDOLL_RUNTIME_QA_FRAME_COUNT;

export type PaperdollRuntimeQaMode = "single" | "composite";

export type PaperdollRuntimeQaFrame = 0 | 1 | 2 | 3;
export type PaperdollRuntimeQaDirection = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;

export type PaperdollRuntimeQaState = Readonly<{
  index: number;
  itemIndex: number;
  slot: EquipmentSlot;
  slotIndex: number;
  variant: number;
  baseName: string;
  direction: PaperdollRuntimeQaDirection;
  frame: PaperdollRuntimeQaFrame;
  key: string;
}>;

export type PaperdollRuntimeQaCompositeState = Readonly<{
  index: number;
  itemIndex: number;
  buildIndex: number;
  label: string;
  variants: readonly number[];
  direction: PaperdollRuntimeQaDirection;
  frame: PaperdollRuntimeQaFrame;
  key: string;
}>;

type PaperdollRuntimeQaQuery = Readonly<
  Record<string, string | readonly string[] | undefined>
>;

const clampInteger = (value: number, minimum: number, maximum: number) =>
  Math.min(maximum, Math.max(minimum, Math.floor(value)));

export function normalizePaperdollRuntimeQaIndex(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return clampInteger(value, 0, PAPERDOLL_RUNTIME_QA_TOTAL - 1);
  }
  if (typeof value === "string" && /^\d+$/.test(value)) {
    return clampInteger(Number(value), 0, PAPERDOLL_RUNTIME_QA_TOTAL - 1);
  }
  return 0;
}

export function normalizePaperdollRuntimeQaCompositeIndex(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return clampInteger(value, 0, PAPERDOLL_RUNTIME_QA_COMPOSITE_TOTAL - 1);
  }
  if (typeof value === "string" && /^\d+$/.test(value)) {
    return clampInteger(
      Number(value),
      0,
      PAPERDOLL_RUNTIME_QA_COMPOSITE_TOTAL - 1,
    );
  }
  return 0;
}

function queryScalar(
  query: PaperdollRuntimeQaQuery,
  key: string,
): string | undefined {
  const value = query[key];
  return typeof value === "string" ? value : value?.[0];
}

export function paperdollRuntimeQaIndexFor(
  slot: EquipmentSlot,
  variant: number,
  direction: number,
  frame: number,
): number {
  const slotIndex = EQUIPMENT_SLOTS.indexOf(slot);
  if (slotIndex < 0) return 0;
  const safeVariant = clampInteger(
    Number.isFinite(variant) ? variant : 0,
    0,
    PAPERDOLL_RUNTIME_QA_VARIANT_COUNT - 1,
  );
  const safeDirection = clampInteger(
    Number.isFinite(direction) ? direction : 0,
    0,
    PAPERDOLL_RUNTIME_QA_DIRECTION_COUNT - 1,
  );
  const safeFrame = clampInteger(
    Number.isFinite(frame) ? frame : 0,
    0,
    PAPERDOLL_RUNTIME_QA_FRAME_COUNT - 1,
  );
  return (
    ((slotIndex * PAPERDOLL_RUNTIME_QA_VARIANT_COUNT + safeVariant) *
      PAPERDOLL_RUNTIME_QA_DIRECTION_COUNT +
      safeDirection) *
      PAPERDOLL_RUNTIME_QA_FRAME_COUNT +
    safeFrame
  );
}

export function paperdollRuntimeQaStateAt(
  requestedIndex: unknown,
): PaperdollRuntimeQaState {
  const index = normalizePaperdollRuntimeQaIndex(requestedIndex);
  const frame = (index % PAPERDOLL_RUNTIME_QA_FRAME_COUNT) as PaperdollRuntimeQaFrame;
  const direction = (Math.floor(index / PAPERDOLL_RUNTIME_QA_FRAME_COUNT) %
    PAPERDOLL_RUNTIME_QA_DIRECTION_COUNT) as PaperdollRuntimeQaDirection;
  const itemIndex = Math.floor(
    index /
      (PAPERDOLL_RUNTIME_QA_DIRECTION_COUNT * PAPERDOLL_RUNTIME_QA_FRAME_COUNT),
  );
  const variant = itemIndex % PAPERDOLL_RUNTIME_QA_VARIANT_COUNT;
  const slotIndex = Math.floor(itemIndex / PAPERDOLL_RUNTIME_QA_VARIANT_COUNT);
  const slot = EQUIPMENT_SLOTS[slotIndex];
  const baseName = GEAR_BASE_NAMES[slot][variant];
  const variantLabel = String(variant).padStart(2, "0");
  return {
    index,
    itemIndex,
    slot,
    slotIndex,
    variant,
    baseName,
    direction,
    frame,
    key: `${slot}/${variantLabel}/${direction}/${frame}`,
  };
}

/** Strict 0 -> 3199 traversal used by the browser autorun state machine. */
export function nextPaperdollRuntimeQaIndex(
  currentIndex: unknown,
): number | null {
  const index = normalizePaperdollRuntimeQaIndex(currentIndex);
  return index >= PAPERDOLL_RUNTIME_QA_TOTAL - 1 ? null : index + 1;
}

export function paperdollRuntimeQaCompositeIndexFor(
  buildIndex: number,
  direction: number,
  frame: number,
): number {
  const safeBuild = clampInteger(
    Number.isFinite(buildIndex) ? buildIndex : 0,
    0,
    PAPERDOLL_RUNTIME_QA_COMPOSITE_BUILDS.length - 1,
  );
  const safeDirection = clampInteger(
    Number.isFinite(direction) ? direction : 0,
    0,
    PAPERDOLL_RUNTIME_QA_DIRECTION_COUNT - 1,
  );
  const safeFrame = clampInteger(
    Number.isFinite(frame) ? frame : 0,
    0,
    PAPERDOLL_RUNTIME_QA_FRAME_COUNT - 1,
  );
  return (
    (safeBuild * PAPERDOLL_RUNTIME_QA_DIRECTION_COUNT + safeDirection) *
      PAPERDOLL_RUNTIME_QA_FRAME_COUNT +
    safeFrame
  );
}

export function paperdollRuntimeQaCompositeStateAt(
  requestedIndex: unknown,
): PaperdollRuntimeQaCompositeState {
  const index = normalizePaperdollRuntimeQaCompositeIndex(requestedIndex);
  const frame = (index % PAPERDOLL_RUNTIME_QA_FRAME_COUNT) as PaperdollRuntimeQaFrame;
  const direction = (Math.floor(index / PAPERDOLL_RUNTIME_QA_FRAME_COUNT) %
    PAPERDOLL_RUNTIME_QA_DIRECTION_COUNT) as PaperdollRuntimeQaDirection;
  const buildIndex = Math.floor(
    index /
      (PAPERDOLL_RUNTIME_QA_DIRECTION_COUNT * PAPERDOLL_RUNTIME_QA_FRAME_COUNT),
  );
  const build = PAPERDOLL_RUNTIME_QA_COMPOSITE_BUILDS[buildIndex];
  const variantSignature = build.variants
    .map((variant) => String(variant).padStart(2, "0"))
    .join("-");
  return {
    index,
    itemIndex: buildIndex,
    buildIndex,
    label: build.label,
    variants: build.variants,
    direction,
    frame,
    key: `full/${variantSignature}/${direction}/${frame}`,
  };
}

export function nextPaperdollRuntimeQaCompositeIndex(
  currentIndex: unknown,
): number | null {
  const index = normalizePaperdollRuntimeQaCompositeIndex(currentIndex);
  return index >= PAPERDOLL_RUNTIME_QA_COMPOSITE_TOTAL - 1 ? null : index + 1;
}

export function resolvePaperdollRuntimeQaInitialIndex(
  query: PaperdollRuntimeQaQuery,
): number {
  const explicitIndex = queryScalar(query, "index");
  if (explicitIndex !== undefined) {
    return normalizePaperdollRuntimeQaIndex(explicitIndex);
  }

  const requestedSlot = queryScalar(query, "slot");
  const slot = EQUIPMENT_SLOTS.find((candidate) => candidate === requestedSlot);
  if (!slot) return 0;
  const variant = Number(queryScalar(query, "variant") ?? 0);
  const direction = Number(queryScalar(query, "direction") ?? 0);
  const frame = Number(queryScalar(query, "frame") ?? 0);
  return paperdollRuntimeQaIndexFor(slot, variant, direction, frame);
}

export function resolvePaperdollRuntimeQaCompositeInitialIndex(
  query: PaperdollRuntimeQaQuery,
): number {
  const explicitIndex = queryScalar(query, "index");
  if (explicitIndex !== undefined) {
    return normalizePaperdollRuntimeQaCompositeIndex(explicitIndex);
  }
  return paperdollRuntimeQaCompositeIndexFor(
    Number(queryScalar(query, "build") ?? 0),
    Number(queryScalar(query, "direction") ?? 0),
    Number(queryScalar(query, "frame") ?? 0),
  );
}

export function resolvePaperdollRuntimeQaAutorun(
  query: PaperdollRuntimeQaQuery,
): boolean {
  return queryScalar(query, "autorun") === "1";
}

export function resolvePaperdollRuntimeQaMode(
  query: PaperdollRuntimeQaQuery,
): PaperdollRuntimeQaMode {
  return queryScalar(query, "mode") === "composite" ? "composite" : "single";
}

export function isLocalPaperdollRuntimeQaHost(
  value: string | null | undefined,
): boolean {
  const host = (value ?? "").split(",", 1)[0]?.trim().toLowerCase() ?? "";
  if (!host) return false;
  if (host === "::1" || host === "[::1]") return true;
  const hostname = host.startsWith("[")
    ? host.slice(1, host.indexOf("]"))
    : host.replace(/:\d+$/, "");
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

/**
 * Creates one canonical common/+0 item and leaves the other nine slots empty.
 * `normalizeGearItem` repairs every derived field after selecting the exact
 * visual base row, so the QA route exercises the same equipment contract as a
 * real save instead of passing a visual-only paperdoll description.
 */
export function createPaperdollRuntimeQaEquipment(
  slot: EquipmentSlot,
  variant: number,
): EquipmentLoadout {
  const safeVariant = clampInteger(
    Number.isFinite(variant) ? variant : 0,
    0,
    PAPERDOLL_RUNTIME_QA_VARIANT_COUNT - 1,
  );
  const baseName = GEAR_BASE_NAMES[slot][safeVariant];
  const template = rollGear(`paperdoll-runtime-qa:${slot}:${safeVariant}`, {
    slot,
    rarity: "common",
    level: 100,
  });
  const item = normalizeGearItem({
    ...template,
    id: `paperdoll-runtime-qa-${slot}-${safeVariant}`,
    baseName,
  });
  if (!item) {
    throw new Error(`Could not build paperdoll runtime QA item ${slot}/${safeVariant}`);
  }
  const expectedIconIndex =
    safeVariant * GEAR_ICON_COLUMNS + EQUIPMENT_SLOTS.indexOf(slot);
  if (item.iconIndex !== expectedIconIndex) {
    throw new Error(`Paperdoll runtime QA item resolved the wrong atlas row: ${slot}`);
  }
  const equipment = createEmptyEquipment();
  equipment[slot] = item;
  return equipment;
}

export function createPaperdollRuntimeQaCompositeEquipment(
  variants: readonly number[],
): EquipmentLoadout {
  const equipment = createEmptyEquipment();
  EQUIPMENT_SLOTS.forEach((slot, slotIndex) => {
    const single = createPaperdollRuntimeQaEquipment(
      slot,
      variants[slotIndex] ?? 0,
    );
    equipment[slot] = single[slot] ?? null;
  });
  return equipment;
}
