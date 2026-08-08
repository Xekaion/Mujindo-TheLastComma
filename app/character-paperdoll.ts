import {
  EQUIPMENT_SLOTS,
  GEAR_ICON_COLUMNS,
  GEAR_ICON_ROWS,
  GEAR_RARITIES,
  MAX_GEAR_ENHANCEMENT,
  type EquipmentSlot,
  type GearItem,
  type GearRarity,
} from "./equipment";

export const PAPERDOLL_FRAME_WIDTH = 256;
export const PAPERDOLL_FRAME_HEIGHT = 192;
export const PAPERDOLL_FRAME_COLUMNS = 4;
export const PAPERDOLL_DIRECTION_COUNT = 8;
export const PAPERDOLL_BODY_ATLAS_WIDTH = 1_024;
export const PAPERDOLL_BODY_ATLAS_HEIGHT = 1_536;
export const PAPERDOLL_EQUIPMENT_ATLAS_SIZE = 2_800;
export const PAPERDOLL_EQUIPMENT_CELL_SIZE = 280;
export const PAPERDOLL_CACHE_LIMIT = 256;
export const PAPERDOLL_GROUND_ANCHOR_RATIO = 0.78;

/** Runtime S,SW,W,NW,N,NE,E,SE -> authored S,SE,E,NW,N,NE,W,SW. */
export const PAPERDOLL_DIRECTION_ROWS = [0, 7, 6, 3, 4, 5, 2, 1] as const;

export type PaperdollDirection = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;
export type PaperdollFrame = 0 | 1 | 2 | 3;
export type PaperdollLayer = "back" | "body" | "front";
export type PaperdollGearMeta = Readonly<{
  slot: EquipmentSlot;
  variant: number;
  rarity: GearRarity;
  enhancement: number;
}>;
export type PaperdollLoadout = Readonly<
  Partial<Record<EquipmentSlot, PaperdollGearMeta>>
>;

export type PaperdollAtlasCell = Readonly<{
  x: number;
  y: number;
  width: number;
  height: number;
}>;
export type PaperdollOpaqueBounds = PaperdollAtlasCell;
export type PaperdollPartPlacement = Readonly<{
  slot: EquipmentSlot;
  layer: PaperdollLayer;
  anchorX: number;
  anchorY: number;
  maxWidth: number;
  maxHeight: number;
  pivotX: number;
  pivotY: number;
  scaleX: number;
  scaleY: number;
  rotation: number;
  flipX: boolean;
  opacity: number;
}>;

type PaperdollSurface = HTMLCanvasElement | OffscreenCanvas;
type Paperdoll2dContext =
  | CanvasRenderingContext2D
  | OffscreenCanvasRenderingContext2D;
type DirectionPose = Readonly<{
  dx: number;
  dy: number;
  centerX: number;
  widthScale: number;
  bodyRotation: number;
}>;
type SlotVisual = Readonly<{
  anchorY: number;
  maxWidth: number;
  maxHeight: number;
  sideOffset: number;
  pivotX: number;
  pivotY: number;
  perspectiveInfluence: number;
  rotationInfluence: number;
}>;

const DIRECTION_POSES: readonly DirectionPose[] = [
  { dx: 0, dy: 1, centerX: 128, widthScale: 1, bodyRotation: 0 },
  { dx: -0.707, dy: 0.707, centerX: 127, widthScale: 0.86, bodyRotation: -0.035 },
  { dx: -1, dy: 0, centerX: 126, widthScale: 0.58, bodyRotation: -0.055 },
  { dx: -0.707, dy: -0.707, centerX: 127, widthScale: 0.86, bodyRotation: -0.035 },
  { dx: 0, dy: -1, centerX: 128, widthScale: 1, bodyRotation: 0 },
  { dx: 0.707, dy: -0.707, centerX: 129, widthScale: 0.86, bodyRotation: 0.035 },
  { dx: 1, dy: 0, centerX: 130, widthScale: 0.58, bodyRotation: 0.055 },
  { dx: 0.707, dy: 0.707, centerX: 129, widthScale: 0.86, bodyRotation: 0.035 },
] as const;

const SLOT_VISUALS: Readonly<Record<EquipmentSlot, SlotVisual>> = {
  weapon: {
    anchorY: 101, maxWidth: 74, maxHeight: 108, sideOffset: 17,
    pivotX: 0.26, pivotY: 0.8, perspectiveInfluence: 0.22, rotationInfluence: 1,
  },
  offhand: {
    anchorY: 91, maxWidth: 50, maxHeight: 61, sideOffset: -18,
    pivotX: 0.5, pivotY: 0.54, perspectiveInfluence: 0.72, rotationInfluence: 0.18,
  },
  helm: {
    anchorY: 40, maxWidth: 43, maxHeight: 49, sideOffset: 0,
    pivotX: 0.5, pivotY: 0.5, perspectiveInfluence: 0.92, rotationInfluence: 1,
  },
  shoulders: {
    anchorY: 72, maxWidth: 67, maxHeight: 40, sideOffset: 0,
    pivotX: 0.5, pivotY: 0.5, perspectiveInfluence: 0.94, rotationInfluence: 1,
  },
  armor: {
    anchorY: 92, maxWidth: 61, maxHeight: 72, sideOffset: 0,
    pivotX: 0.5, pivotY: 0.5, perspectiveInfluence: 0.96, rotationInfluence: 1,
  },
  gloves: {
    anchorY: 101, maxWidth: 57, maxHeight: 38, sideOffset: 0,
    pivotX: 0.5, pivotY: 0.5, perspectiveInfluence: 0.86, rotationInfluence: 0.8,
  },
  belt: {
    anchorY: 112, maxWidth: 52, maxHeight: 23, sideOffset: 0,
    pivotX: 0.5, pivotY: 0.5, perspectiveInfluence: 0.98, rotationInfluence: 0.7,
  },
  legs: {
    anchorY: 139, maxWidth: 43, maxHeight: 59, sideOffset: 0,
    pivotX: 0.5, pivotY: 0.5, perspectiveInfluence: 0.94, rotationInfluence: 0.55,
  },
  boots: {
    anchorY: 165, maxWidth: 43, maxHeight: 41, sideOffset: 0,
    pivotX: 0.5, pivotY: 0.5, perspectiveInfluence: 0.88, rotationInfluence: 0.35,
  },
  relic: {
    anchorY: 80, maxWidth: 29, maxHeight: 37, sideOffset: 31,
    pivotX: 0.5, pivotY: 0.5, perspectiveInfluence: 0, rotationInfluence: 0,
  },
};

const SLOT_DRAW_ORDER: Readonly<Record<EquipmentSlot, number>> = {
  relic: 0, offhand: 1, weapon: 2, legs: 3, boots: 4,
  armor: 5, belt: 6, shoulders: 7, gloves: 8, helm: 9,
};

const RARITY_GLOW: Readonly<Record<GearRarity, number>> = {
  common: 0, magic: 0, superior: 0, rare: 1,
  epic: 2, legendary: 4, mythic: 6, cosmic: 8,
};
const RARITY_COLOR: Readonly<Record<GearRarity, string>> = {
  common: "#c7c2b5", magic: "#63a6ff", superior: "#4ed29b", rare: "#e7c65b",
  epic: "#bc70ff", legendary: "#e58a3d", mythic: "#ff3f63", cosmic: "#65f4ff",
};
const FRAME_SWAY = [-1, 0, 1, 0] as const;
const FRAME_BOB = [0, -1.25, 0, -1.25] as const;
// Held gear keeps a believable upright grip while the body turns. Rotating a
// front-authored sword by the full 45-degree facing sector put blades at the
// character's feet on NW/E rows and made the equipment look pasted on.
const HANDHELD_ROTATION_BY_DIRECTION = [
  0,
  -0.18,
  -0.28,
  -0.12,
  0,
  0.12,
  0.28,
  0.18,
] as const;
const PAIRED_PAPERDOLL_SLOTS = new Set<EquipmentSlot>([
  "shoulders",
  "gloves",
  "legs",
  "boots",
]);
const PAIRED_PART_SPREAD: Readonly<
  Partial<Record<EquipmentSlot, { x: number; gaitY: number; rotation: number }>>
> = {
  shoulders: { x: 18, gaitY: 0.35, rotation: 0.045 },
  gloves: { x: 24, gaitY: 2.8, rotation: 0.08 },
  legs: { x: 10.5, gaitY: 3.6, rotation: 0.055 },
  boots: { x: 12.5, gaitY: 4.8, rotation: 0.08 },
};
const EQUIPMENT_SLOT_SET = new Set<string>(EQUIPMENT_SLOTS);
const GEAR_RARITY_SET = new Set<string>(GEAR_RARITIES);
let atlasTrimCache = new WeakMap<object, Map<number, PaperdollOpaqueBounds>>();
const sourceIds = new WeakMap<object, number>();
let nextSourceId = 1;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isEquipmentSlot(value: unknown): value is EquipmentSlot {
  return typeof value === "string" && EQUIPMENT_SLOT_SET.has(value);
}

function isGearRarity(value: unknown): value is GearRarity {
  return typeof value === "string" && GEAR_RARITY_SET.has(value);
}

function finiteInteger(value: unknown, minimum: number, maximum: number) {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) return null;
  return value >= minimum && value <= maximum ? value : null;
}

export function normalizePaperdollDirection(value: number): PaperdollDirection {
  const integer = Number.isFinite(value) ? Math.floor(value) : 0;
  return (((integer % PAPERDOLL_DIRECTION_COUNT) + PAPERDOLL_DIRECTION_COUNT) %
    PAPERDOLL_DIRECTION_COUNT) as PaperdollDirection;
}

export function normalizePaperdollFrame(value: number): PaperdollFrame {
  const integer = Number.isFinite(value) ? Math.floor(value) : 0;
  return (((integer % PAPERDOLL_FRAME_COLUMNS) + PAPERDOLL_FRAME_COLUMNS) %
    PAPERDOLL_FRAME_COLUMNS) as PaperdollFrame;
}

/** Only the four renderer fields cross this allowlist. */
export function normalizePaperdollGearMeta(
  value: unknown,
  expectedSlot?: EquipmentSlot,
): PaperdollGearMeta | null {
  if (!isRecord(value) || !isEquipmentSlot(value.slot)) return null;
  if (expectedSlot !== undefined && value.slot !== expectedSlot) return null;
  if (!isGearRarity(value.rarity)) return null;
  const variant = finiteInteger(value.variant, 0, GEAR_ICON_ROWS - 1);
  const enhancement = finiteInteger(value.enhancement, 0, MAX_GEAR_ENHANCEMENT);
  if (variant === null || enhancement === null) return null;
  return { slot: value.slot, variant, rarity: value.rarity, enhancement };
}

export function normalizePaperdollLoadout(value: unknown): PaperdollLoadout {
  if (!isRecord(value)) return {};
  const result: Partial<Record<EquipmentSlot, PaperdollGearMeta>> = {};
  for (const slot of EQUIPMENT_SLOTS) {
    const piece = normalizePaperdollGearMeta(value[slot], slot);
    if (piece) result[slot] = piece;
  }
  return result;
}

/** Converts canonical gear without exposing combat affixes to the renderer. */
export function paperdollGearMetaFromItem(
  item: Pick<GearItem, "slot" | "rarity" | "enhancement" | "iconIndex">,
): PaperdollGearMeta | null {
  if (!isEquipmentSlot(item.slot) || !isGearRarity(item.rarity)) return null;
  const iconIndex = finiteInteger(
    item.iconIndex,
    0,
    GEAR_ICON_COLUMNS * GEAR_ICON_ROWS - 1,
  );
  const enhancement = finiteInteger(item.enhancement, 0, MAX_GEAR_ENHANCEMENT);
  if (iconIndex === null || enhancement === null) return null;
  const expectedColumn = EQUIPMENT_SLOTS.indexOf(item.slot);
  if (iconIndex % GEAR_ICON_COLUMNS !== expectedColumn) return null;
  return {
    slot: item.slot,
    variant: Math.floor(iconIndex / GEAR_ICON_COLUMNS),
    rarity: item.rarity,
    enhancement,
  };
}

export function paperdollLoadoutFromEquipment(
  equipment: Readonly<Partial<Record<EquipmentSlot, GearItem | null>>>,
): PaperdollLoadout {
  const result: Partial<Record<EquipmentSlot, PaperdollGearMeta>> = {};
  for (const slot of EQUIPMENT_SLOTS) {
    const item = equipment[slot];
    if (!item) continue;
    const piece = paperdollGearMetaFromItem(item);
    if (piece) result[slot] = piece;
  }
  return result;
}

/** Promotes the plaza's privacy-safe slot -> variant map to render metadata. */
export function paperdollLoadoutFromVariants(
  variants: unknown,
  rarity: GearRarity = "common",
  enhancement = 0,
): PaperdollLoadout {
  if (!isRecord(variants) || !isGearRarity(rarity)) return {};
  const safeEnhancement = finiteInteger(enhancement, 0, MAX_GEAR_ENHANCEMENT);
  if (safeEnhancement === null) return {};
  const result: Partial<Record<EquipmentSlot, PaperdollGearMeta>> = {};
  for (const slot of EQUIPMENT_SLOTS) {
    const variant = finiteInteger(variants[slot], 0, GEAR_ICON_ROWS - 1);
    if (variant === null) continue;
    result[slot] = { slot, variant, rarity, enhancement: safeEnhancement };
  }
  return result;
}

/** Named bridge for HubAppearance.gear; kept separate from canonical GearItem. */
export const paperdollLoadoutFromVisualGear = paperdollLoadoutFromVariants;

export function paperdollAtlasCell(
  slot: EquipmentSlot,
  variant: number,
): PaperdollAtlasCell {
  const safeVariant = Math.max(0, Math.min(GEAR_ICON_ROWS - 1, Math.floor(variant)));
  return {
    x: EQUIPMENT_SLOTS.indexOf(slot) * PAPERDOLL_EQUIPMENT_CELL_SIZE,
    y: safeVariant * PAPERDOLL_EQUIPMENT_CELL_SIZE,
    width: PAPERDOLL_EQUIPMENT_CELL_SIZE,
    height: PAPERDOLL_EQUIPMENT_CELL_SIZE,
  };
}

/** Pure alpha scan used by both runtime trimming and asset tests. */
export function computePaperdollOpaqueBounds(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  alphaThreshold = 8,
): PaperdollOpaqueBounds | null {
  if (
    width <= 0 || height <= 0 || rgba.length < width * height * 4 ||
    !Number.isFinite(alphaThreshold)
  ) return null;
  const threshold = Math.max(0, Math.min(255, alphaThreshold));
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (rgba[(y * width + x) * 4 + 3] <= threshold) continue;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  return maxX < minX || maxY < minY
    ? null
    : { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

export function containPaperdollPart(
  sourceWidth: number,
  sourceHeight: number,
  maxWidth: number,
  maxHeight: number,
): Readonly<{ width: number; height: number }> {
  if (sourceWidth <= 0 || sourceHeight <= 0 || maxWidth <= 0 || maxHeight <= 0) {
    return { width: 0, height: 0 };
  }
  const scale = Math.min(maxWidth / sourceWidth, maxHeight / sourceHeight);
  return { width: sourceWidth * scale, height: sourceHeight * scale };
}

function resolveLayer(slot: EquipmentSlot, direction: PaperdollDirection): PaperdollLayer {
  const backFacing = direction === 3 || direction === 4 || direction === 5;
  if (slot === "relic") return backFacing ? "back" : "front";
  if (slot === "weapon") {
    return direction >= 2 && direction <= 5 ? "back" : "front";
  }
  if (slot === "offhand") {
    return direction >= 4 && direction <= 7 ? "back" : "front";
  }
  // Worn armor stays attached over the body even on the north row. Placing
  // the full armor stack behind Harin made it read as a second character
  // walking beside him; only truly held/orbiting pieces change depth.
  return "body";
}

/** Slot-specific anatomical anchor with facing and gait correction. */
export function resolvePaperdollPartPlacement(
  slot: EquipmentSlot,
  directionValue: number,
  frameValue: number,
): PaperdollPartPlacement {
  const direction = normalizePaperdollDirection(directionValue);
  const frame = normalizePaperdollFrame(frameValue);
  const pose = DIRECTION_POSES[direction];
  const visual = SLOT_VISUALS[slot];
  const sway = FRAME_SWAY[frame];
  const bob = FRAME_BOB[frame];
  const isHandheld = slot === "weapon" || slot === "offhand";
  const isRelic = slot === "relic";
  const sideDirection = pose.dx === 0 ? 1 : Math.sign(pose.dx);
  const perspectiveScale =
    1 - (1 - pose.widthScale) * visual.perspectiveInfluence;
  const handStride = isHandheld ? sway * 1.55 : sway * 0.55;
  const legStride = slot === "boots" || slot === "legs" ? Math.abs(sway) * 0.8 : 0;
  const handheldRotation = isHandheld
    ? HANDHELD_ROTATION_BY_DIRECTION[direction] * visual.rotationInfluence
    : 0;
  const relicFloat = isRelic ? FRAME_BOB[(frame + 1) % PAPERDOLL_FRAME_COLUMNS] : 0;

  return {
    slot,
    layer: resolveLayer(slot, direction),
    anchorX:
      pose.centerX +
      visual.sideOffset * sideDirection * (0.72 + Math.abs(pose.dy) * 0.28) +
      handStride,
    anchorY: visual.anchorY + bob + legStride + relicFloat,
    maxWidth: visual.maxWidth,
    maxHeight: visual.maxHeight,
    pivotX: visual.pivotX,
    pivotY: visual.pivotY,
    scaleX: perspectiveScale,
    scaleY: 1,
    rotation: pose.bodyRotation * visual.rotationInfluence + handheldRotation,
    flipX: pose.dx < 0,
    opacity: 1,
  };
}

export function sortPaperdollPieces(
  loadout: PaperdollLoadout,
  directionValue: number,
): readonly PaperdollGearMeta[] {
  const direction = normalizePaperdollDirection(directionValue);
  const layerOrder: Readonly<Record<PaperdollLayer, number>> = {
    back: 0, body: 1, front: 2,
  };
  return EQUIPMENT_SLOTS.flatMap((slot) => (loadout[slot] ? [loadout[slot]] : []))
    .filter((piece): piece is PaperdollGearMeta => piece !== undefined)
    .sort((left, right) => {
      const leftLayer = resolveLayer(left.slot, direction);
      const rightLayer = resolveLayer(right.slot, direction);
      return layerOrder[leftLayer] - layerOrder[rightLayer] ||
        SLOT_DRAW_ORDER[left.slot] - SLOT_DRAW_ORDER[right.slot];
    });
}

export function createPaperdollGearSignature(loadout: PaperdollLoadout): string {
  return EQUIPMENT_SLOTS.map((slot) => {
    const piece = loadout[slot];
    return piece
      ? `${slot}:${piece.variant}:${piece.rarity}:${piece.enhancement}`
      : `${slot}:-`;
  }).join("|");
}

/** Deterministic LRU constrained to the 256-frame runtime budget. */
export class PaperdollLruCache<K, V> {
  readonly capacity: number;
  private readonly entries = new Map<K, V>();

  constructor(capacity = PAPERDOLL_CACHE_LIMIT) {
    const safeCapacity = Number.isFinite(capacity) ? Math.floor(capacity) : 1;
    this.capacity = Math.max(1, Math.min(PAPERDOLL_CACHE_LIMIT, safeCapacity));
  }

  get size() {
    return this.entries.size;
  }

  get(key: K): V | undefined {
    const value = this.entries.get(key);
    if (value === undefined) return undefined;
    this.entries.delete(key);
    this.entries.set(key, value);
    return value;
  }

  peek(key: K): V | undefined {
    return this.entries.get(key);
  }

  set(key: K, value: V): void {
    this.entries.delete(key);
    this.entries.set(key, value);
    while (this.entries.size > this.capacity) {
      const oldestKey = this.entries.keys().next().value as K | undefined;
      if (oldestKey === undefined) break;
      this.entries.delete(oldestKey);
    }
  }

  delete(key: K): boolean {
    return this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }

  keys(): readonly K[] {
    return [...this.entries.keys()];
  }
}

export const paperdollFrameCache = new PaperdollLruCache<
  string,
  PaperdollSurface
>();

function imageSourceDimensions(source: CanvasImageSource) {
  const image = source as CanvasImageSource & {
    naturalWidth?: number;
    naturalHeight?: number;
    videoWidth?: number;
    videoHeight?: number;
    width?: number;
    height?: number;
  };
  const width = image.naturalWidth ?? image.videoWidth ?? image.width ?? 0;
  const height = image.naturalHeight ?? image.videoHeight ?? image.height ?? 0;
  return {
    width: typeof width === "number" ? width : 0,
    height: typeof height === "number" ? height : 0,
  };
}

export function isPaperdollBodyAtlasReady(source: CanvasImageSource): boolean {
  const { width, height } = imageSourceDimensions(source);
  return width === PAPERDOLL_BODY_ATLAS_WIDTH && height === PAPERDOLL_BODY_ATLAS_HEIGHT;
}

export function isPaperdollEquipmentAtlasReady(source: CanvasImageSource): boolean {
  const { width, height } = imageSourceDimensions(source);
  return width === PAPERDOLL_EQUIPMENT_ATLAS_SIZE &&
    height === PAPERDOLL_EQUIPMENT_ATLAS_SIZE;
}

function createSurface(width: number, height: number): PaperdollSurface | null {
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(width, height);
  if (typeof document === "undefined") return null;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function surfaceContext(surface: PaperdollSurface): Paperdoll2dContext | null {
  return surface.getContext("2d") as Paperdoll2dContext | null;
}

function sourceIdentity(source: CanvasImageSource | null | undefined): number {
  if (!source || (typeof source !== "object" && typeof source !== "function")) return 0;
  const objectSource = source as object;
  const existing = sourceIds.get(objectSource);
  if (existing !== undefined) return existing;
  const id = nextSourceId;
  nextSourceId += 1;
  sourceIds.set(objectSource, id);
  return id;
}

function equipmentTrimBounds(
  atlas: CanvasImageSource,
  piece: PaperdollGearMeta,
): PaperdollOpaqueBounds {
  const atlasObject = atlas as object;
  let cache = atlasTrimCache.get(atlasObject);
  if (!cache) {
    cache = new Map<number, PaperdollOpaqueBounds>();
    atlasTrimCache.set(atlasObject, cache);
  }
  const column = EQUIPMENT_SLOTS.indexOf(piece.slot);
  const cacheKey = piece.variant * GEAR_ICON_COLUMNS + column;
  const cached = cache.get(cacheKey);
  if (cached) return cached;
  const cell = paperdollAtlasCell(piece.slot, piece.variant);
  const fallback = { x: 0, y: 0, width: cell.width, height: cell.height };
  const surface = createSurface(cell.width, cell.height);
  const context = surface ? surfaceContext(surface) : null;
  if (!context) return fallback;
  try {
    context.clearRect(0, 0, cell.width, cell.height);
    context.drawImage(
      atlas,
      cell.x, cell.y, cell.width, cell.height,
      0, 0, cell.width, cell.height,
    );
    const rgba = context.getImageData(0, 0, cell.width, cell.height).data;
    const bounds = computePaperdollOpaqueBounds(rgba, cell.width, cell.height) ?? fallback;
    cache.set(cacheKey, bounds);
    return bounds;
  } catch {
    // A tainted/not-yet-decodable atlas still draws from its transparent cell.
    return fallback;
  }
}

function drawEquipmentPiece(
  context: Paperdoll2dContext,
  atlas: CanvasImageSource,
  piece: PaperdollGearMeta,
  direction: PaperdollDirection,
  frame: PaperdollFrame,
): void {
  const cell = paperdollAtlasCell(piece.slot, piece.variant);
  const trim = equipmentTrimBounds(atlas, piece);
  const placement = resolvePaperdollPartPlacement(piece.slot, direction, frame);
  const fitted = containPaperdollPart(
    trim.width, trim.height, placement.maxWidth, placement.maxHeight,
  );
  if (fitted.width <= 0 || fitted.height <= 0) return;
  const glow = RARITY_GLOW[piece.rarity] + piece.enhancement * 0.18;

  if (PAIRED_PAPERDOLL_SLOTS.has(piece.slot)) {
    const pairMotion = PAIRED_PART_SPREAD[piece.slot];
    if (!pairMotion) return;
    const leftWidth = Math.ceil(trim.width / 2);
    const sourceWidths = [leftWidth, trim.width - leftWidth] as const;
    for (let index = 0; index < 2; index += 1) {
      const sourceWidth = sourceWidths[index];
      if (sourceWidth <= 0) continue;
      const sourceX = index === 0 ? trim.x : trim.x + leftWidth;
      const side = index === 0 ? -1 : 1;
      const visibleSide = placement.flipX ? -side : side;
      const fragment = containPaperdollPart(
        sourceWidth,
        trim.height,
        placement.maxWidth * 0.56,
        placement.maxHeight,
      );
      const gait = FRAME_SWAY[frame] * side;
      context.save();
      context.translate(
        placement.anchorX + visibleSide * pairMotion.x * placement.scaleX,
        placement.anchorY + gait * pairMotion.gaitY,
      );
      context.rotate(
        placement.rotation + visibleSide * pairMotion.rotation * FRAME_SWAY[frame],
      );
      context.scale(placement.flipX ? -placement.scaleX : placement.scaleX, 1);
      context.globalAlpha *= placement.opacity;
      if (glow > 0) {
        context.shadowColor = RARITY_COLOR[piece.rarity];
        context.shadowBlur = glow;
      }
      context.drawImage(
        atlas,
        cell.x + sourceX,
        cell.y + trim.y,
        sourceWidth,
        trim.height,
        -fragment.width / 2,
        -fragment.height / 2,
        fragment.width,
        fragment.height,
      );
      context.restore();
    }
    return;
  }

  context.save();
  context.translate(placement.anchorX, placement.anchorY);
  context.rotate(placement.rotation);
  context.scale(placement.flipX ? -placement.scaleX : placement.scaleX, placement.scaleY);
  context.globalAlpha *= placement.opacity;
  if (glow > 0) {
    context.shadowColor = RARITY_COLOR[piece.rarity];
    context.shadowBlur = glow;
  }
  context.drawImage(
    atlas,
    cell.x + trim.x,
    cell.y + trim.y,
    trim.width,
    trim.height,
    -fitted.width * placement.pivotX,
    -fitted.height * placement.pivotY,
    fitted.width,
    fitted.height,
  );
  context.restore();
}

function drawPaperdollFrameContents(
  context: Paperdoll2dContext,
  bodyAtlas: CanvasImageSource,
  equipmentAtlas: CanvasImageSource | null | undefined,
  loadout: PaperdollLoadout,
  direction: PaperdollDirection,
  frame: PaperdollFrame,
): boolean {
  if (!isPaperdollBodyAtlasReady(bodyAtlas)) return false;
  const pieces = equipmentAtlas
    ? sortPaperdollPieces(loadout, direction)
    : ([] as readonly PaperdollGearMeta[]);
  const canDrawEquipment = Boolean(
    equipmentAtlas && isPaperdollEquipmentAtlasReady(equipmentAtlas),
  );
  try {
    if (canDrawEquipment && equipmentAtlas) {
      for (const piece of pieces) {
        if (resolveLayer(piece.slot, direction) === "back") {
          drawEquipmentPiece(context, equipmentAtlas, piece, direction, frame);
        }
      }
    }

    const row = PAPERDOLL_DIRECTION_ROWS[direction];
    context.drawImage(
      bodyAtlas,
      frame * PAPERDOLL_FRAME_WIDTH,
      row * PAPERDOLL_FRAME_HEIGHT,
      PAPERDOLL_FRAME_WIDTH,
      PAPERDOLL_FRAME_HEIGHT,
      0,
      0,
      PAPERDOLL_FRAME_WIDTH,
      PAPERDOLL_FRAME_HEIGHT,
    );

    if (canDrawEquipment && equipmentAtlas) {
      for (const layer of ["body", "front"] as const) {
        for (const piece of pieces) {
          if (resolveLayer(piece.slot, direction) === layer) {
            drawEquipmentPiece(context, equipmentAtlas, piece, direction, frame);
          }
        }
      }
    }
    return true;
  } catch {
    return false;
  }
}

function frameCacheKey(
  bodyAtlas: CanvasImageSource,
  equipmentAtlas: CanvasImageSource | null | undefined,
  loadout: PaperdollLoadout,
  direction: PaperdollDirection,
  frame: PaperdollFrame,
): string {
  return [
    sourceIdentity(bodyAtlas),
    sourceIdentity(equipmentAtlas),
    direction,
    frame,
    createPaperdollGearSignature(loadout),
  ].join("/");
}

export type ComposePaperdollFrameOptions = Readonly<{
  bodyAtlas: CanvasImageSource;
  equipmentAtlas?: CanvasImageSource | null;
  loadout?: unknown;
  direction: number;
  frame: number;
  cache?: PaperdollLruCache<string, PaperdollSurface>;
}>;

/** Creates or retrieves one source-resolution composite frame. */
export function composePaperdollFrame(
  options: ComposePaperdollFrameOptions,
): CanvasImageSource | null {
  const direction = normalizePaperdollDirection(options.direction);
  const frame = normalizePaperdollFrame(options.frame);
  const loadout = normalizePaperdollLoadout(options.loadout ?? {});
  const cache = options.cache ?? paperdollFrameCache;
  const key = frameCacheKey(
    options.bodyAtlas, options.equipmentAtlas, loadout, direction, frame,
  );
  const cached = cache.get(key);
  if (cached) return cached;
  const surface = createSurface(PAPERDOLL_FRAME_WIDTH, PAPERDOLL_FRAME_HEIGHT);
  const context = surface ? surfaceContext(surface) : null;
  if (!surface || !context) return null;
  context.clearRect(0, 0, PAPERDOLL_FRAME_WIDTH, PAPERDOLL_FRAME_HEIGHT);
  if (!drawPaperdollFrameContents(
    context,
    options.bodyAtlas,
    options.equipmentAtlas,
    loadout,
    direction,
    frame,
  )) return null;
  cache.set(key, surface);
  return surface;
}

/** Warms all 8 directions x 4 gait phases for one equipment signature. */
export function prewarmPaperdollLoadout(
  options: Omit<ComposePaperdollFrameOptions, "direction" | "frame">,
): number {
  let composedCount = 0;
  for (let direction = 0; direction < PAPERDOLL_DIRECTION_COUNT; direction += 1) {
    for (let frame = 0; frame < PAPERDOLL_FRAME_COLUMNS; frame += 1) {
      if (composePaperdollFrame({ ...options, direction, frame })) composedCount += 1;
    }
  }
  return composedCount;
}

export type DrawPaperdollCharacterOptions = Readonly<{
  bodyAtlas: CanvasImageSource;
  equipmentAtlas?: CanvasImageSource | null;
  loadout?: unknown;
  direction: number;
  frame: number;
  x: number;
  y: number;
  width: number;
  height: number;
  alpha?: number;
  groundAnchorRatio?: number;
  cache?: PaperdollLruCache<string, PaperdollSurface>;
}>;

/**
 * Draw one frame composed as back equipment -> neutral body -> body/front
 * equipment. Atlas cells are alpha-trimmed, so inventory-card squares can
 * never be pasted over the character.
 */
export function drawPaperdollCharacter(
  context: CanvasRenderingContext2D,
  options: DrawPaperdollCharacterOptions,
): boolean {
  const direction = normalizePaperdollDirection(options.direction);
  const frame = normalizePaperdollFrame(options.frame);
  const loadout = normalizePaperdollLoadout(options.loadout ?? {});
  const cache = options.cache ?? paperdollFrameCache;
  const composed = composePaperdollFrame({
    bodyAtlas: options.bodyAtlas,
    equipmentAtlas: options.equipmentAtlas,
    loadout,
    direction,
    frame,
    cache,
  });

  const alpha = Math.max(0, Math.min(1, options.alpha ?? 1));
  const groundAnchorRatio = Math.max(
    0,
    Math.min(1, options.groundAnchorRatio ?? PAPERDOLL_GROUND_ANCHOR_RATIO),
  );
  context.save();
  context.globalAlpha *= alpha;
  context.imageSmoothingEnabled = true;
  if (composed) {
    context.drawImage(
      composed,
      options.x - options.width / 2,
      options.y - options.height * groundAnchorRatio,
      options.width,
      options.height,
    );
    context.restore();
    return true;
  }

  // Non-DOM render hosts can still draw without populating the offscreen LRU.
  context.translate(
    options.x - options.width / 2,
    options.y - options.height * groundAnchorRatio,
  );
  context.scale(
    options.width / PAPERDOLL_FRAME_WIDTH,
    options.height / PAPERDOLL_FRAME_HEIGHT,
  );
  const drawn = drawPaperdollFrameContents(
    context,
    options.bodyAtlas,
    options.equipmentAtlas,
    loadout,
    direction,
    frame,
  );
  context.restore();
  return drawn;
}

export function clearPaperdollCaches(): void {
  paperdollFrameCache.clear();
  atlasTrimCache = new WeakMap<object, Map<number, PaperdollOpaqueBounds>>();
}
