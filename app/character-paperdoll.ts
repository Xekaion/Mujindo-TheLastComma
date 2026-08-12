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
export const PAPERDOLL_LAYER_ATLAS_WIDTH = PAPERDOLL_BODY_ATLAS_WIDTH;
export const PAPERDOLL_LAYER_ATLAS_HEIGHT = PAPERDOLL_BODY_ATLAS_HEIGHT;
export const PAPERDOLL_CACHE_LIMIT = 256;
export const PAPERDOLL_GROUND_BASELINE = 184;
export const PAPERDOLL_GROUND_ANCHOR_RATIO =
  PAPERDOLL_GROUND_BASELINE / PAPERDOLL_FRAME_HEIGHT;
export const PAPERDOLL_BODY_PATH = "/assets/walk/harin-mannequin-v1.png";
export const PAPERDOLL_LAYER_ROOT = "/assets/paperdoll/v1";

/** Runtime S,SW,W,NW,N,NE,E,SE -> authored S,SE,E,NW,N,NE,W,SW. */
export const PAPERDOLL_DIRECTION_ROWS = [0, 7, 6, 3, 4, 5, 2, 1] as const;

export const PAPERDOLL_VARIANT_NAMES = [
  "iron",
  "frost",
  "jade",
  "blood",
  "arcane",
  "waraxe",
  "celestial",
  "void",
  "sealed",
  "cosmic",
] as const;
export const PAPERDOLL_VARIANT_COUNT = PAPERDOLL_VARIANT_NAMES.length;
export const PAPERDOLL_LAYER_PASSES = ["rear", "body", "front"] as const;

export type PaperdollDirection = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;
export type PaperdollFrame = 0 | 1 | 2 | 3;
export type PaperdollLayer = (typeof PAPERDOLL_LAYER_PASSES)[number];
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
export type PaperdollImageSourceMap =
  | ReadonlyMap<string, CanvasImageSource | null | undefined>
  | Readonly<Record<string, CanvasImageSource | null | undefined>>;

type PaperdollSurface = HTMLCanvasElement | OffscreenCanvas;
type Paperdoll2dContext =
  | CanvasRenderingContext2D
  | OffscreenCanvasRenderingContext2D;
type ResolvedPaperdollLayer = Readonly<{
  piece: PaperdollGearMeta;
  pass: PaperdollLayer;
  path: string;
  source: CanvasImageSource | null | undefined;
}>;
type PaperdollFrameRenderResult = Readonly<{
  drawn: boolean;
  complete: boolean;
}>;

const EQUIPMENT_SLOT_SET = new Set<string>(EQUIPMENT_SLOTS);
const GEAR_RARITY_SET = new Set<string>(GEAR_RARITIES);
const sourceIds = new WeakMap<object, number>();
let nextSourceId = 1;

const SLOT_DRAW_ORDER: Readonly<Record<EquipmentSlot, number>> = {
  relic: 0,
  offhand: 1,
  weapon: 2,
  legs: 3,
  boots: 4,
  armor: 5,
  belt: 6,
  shoulders: 7,
  gloves: 8,
  helm: 9,
};

function createLayerPathList(slot: EquipmentSlot): readonly string[] {
  return Object.freeze(
    PAPERDOLL_VARIANT_NAMES.map(
      (name, variant) =>
        `${PAPERDOLL_LAYER_ROOT}/${slot}/${String(variant).padStart(2, "0")}-${name}.png`,
    ),
  );
}

/** Canonical source paths for ten independently wearable layer atlases per slot. */
export const PAPERDOLL_LAYER_PATHS: Readonly<
  Record<EquipmentSlot, readonly string[]>
> = Object.freeze({
  weapon: createLayerPathList("weapon"),
  offhand: createLayerPathList("offhand"),
  helm: createLayerPathList("helm"),
  shoulders: createLayerPathList("shoulders"),
  armor: createLayerPathList("armor"),
  gloves: createLayerPathList("gloves"),
  belt: createLayerPathList("belt"),
  legs: createLayerPathList("legs"),
  boots: createLayerPathList("boots"),
  relic: createLayerPathList("relic"),
});

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

/** Only renderer-safe fields cross this allowlist. */
export function normalizePaperdollGearMeta(
  value: unknown,
  expectedSlot?: EquipmentSlot,
): PaperdollGearMeta | null {
  if (!isRecord(value) || !isEquipmentSlot(value.slot)) return null;
  if (expectedSlot !== undefined && value.slot !== expectedSlot) return null;
  if (!isGearRarity(value.rarity)) return null;
  const variant = finiteInteger(value.variant, 0, PAPERDOLL_VARIANT_COUNT - 1);
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
  const variant = Math.floor(iconIndex / GEAR_ICON_COLUMNS);
  if (variant >= PAPERDOLL_VARIANT_COUNT) return null;
  return { slot: item.slot, variant, rarity: item.rarity, enhancement };
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
    const variant = finiteInteger(variants[slot], 0, PAPERDOLL_VARIANT_COUNT - 1);
    if (variant === null) continue;
    result[slot] = { slot, variant, rarity, enhancement: safeEnhancement };
  }
  return result;
}

/** Named bridge for HubAppearance.gear; separate from canonical GearItem. */
export const paperdollLoadoutFromVisualGear = paperdollLoadoutFromVariants;

/** Returns the registered 1024x1536 atlas for one wearable slot and variant. */
export function getPaperdollLayerPath(
  slot: EquipmentSlot,
  variant: number,
): string | null {
  if (!isEquipmentSlot(slot)) return null;
  const safeVariant = finiteInteger(variant, 0, PAPERDOLL_VARIANT_COUNT - 1);
  return safeVariant === null ? null : PAPERDOLL_LAYER_PATHS[slot][safeVariant] ?? null;
}

/** Paths needed to render a loadout, in stable canonical slot order. */
export function pathsForLoadout(loadoutValue: unknown): readonly string[] {
  const loadout = normalizePaperdollLoadout(loadoutValue);
  const paths: string[] = [];
  for (const slot of EQUIPMENT_SLOTS) {
    const piece = loadout[slot];
    if (!piece) continue;
    const path = getPaperdollLayerPath(slot, piece.variant);
    if (path) paths.push(path);
  }
  return paths;
}

export const paperdollLayerPathsForLoadout = pathsForLoadout;

/** The source cell is identical for the mannequin and every wearable atlas. */
export function paperdollFrameCell(
  directionValue: number,
  frameValue: number,
): PaperdollAtlasCell {
  const direction = normalizePaperdollDirection(directionValue);
  const frame = normalizePaperdollFrame(frameValue);
  return {
    x: frame * PAPERDOLL_FRAME_WIDTH,
    y: PAPERDOLL_DIRECTION_ROWS[direction] * PAPERDOLL_FRAME_HEIGHT,
    width: PAPERDOLL_FRAME_WIDTH,
    height: PAPERDOLL_FRAME_HEIGHT,
  };
}

export function resolvePaperdollLayer(
  slot: EquipmentSlot,
  directionValue: number,
): PaperdollLayer {
  const direction = normalizePaperdollDirection(directionValue);
  const backFacing = direction === 3 || direction === 4 || direction === 5;
  if (slot === "relic") return backFacing ? "rear" : "front";
  if (slot === "weapon") {
    return direction >= 2 && direction <= 5 ? "rear" : "front";
  }
  if (slot === "offhand") {
    return direction >= 4 && direction <= 7 ? "rear" : "front";
  }
  return "body";
}

export function sortPaperdollPieces(
  loadout: PaperdollLoadout,
  directionValue: number,
): readonly PaperdollGearMeta[] {
  const direction = normalizePaperdollDirection(directionValue);
  const layerOrder: Readonly<Record<PaperdollLayer, number>> = {
    rear: 0,
    body: 1,
    front: 2,
  };
  return EQUIPMENT_SLOTS.flatMap((slot) => (loadout[slot] ? [loadout[slot]] : []))
    .filter((piece): piece is PaperdollGearMeta => piece !== undefined)
    .sort((left, right) => {
      const leftLayer = resolvePaperdollLayer(left.slot, direction);
      const rightLayer = resolvePaperdollLayer(right.slot, direction);
      return (
        layerOrder[leftLayer] - layerOrder[rightLayer] ||
        SLOT_DRAW_ORDER[left.slot] - SLOT_DRAW_ORDER[right.slot]
      );
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

/** Stable dependency key for canonical equipment without cloning HUD state. */
export function createPaperdollEquipmentSignature(
  equipment: Readonly<Partial<Record<EquipmentSlot, GearItem | null>>>,
): string {
  return createPaperdollGearSignature(paperdollLoadoutFromEquipment(equipment));
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

export function isPaperdollBodyAtlasReady(
  source: CanvasImageSource | null | undefined,
): source is CanvasImageSource {
  if (!source) return false;
  const { width, height } = imageSourceDimensions(source);
  return width === PAPERDOLL_BODY_ATLAS_WIDTH && height === PAPERDOLL_BODY_ATLAS_HEIGHT;
}

export function isPaperdollLayerAtlasReady(
  source: CanvasImageSource | null | undefined,
): source is CanvasImageSource {
  if (!source) return false;
  const { width, height } = imageSourceDimensions(source);
  return width === PAPERDOLL_LAYER_ATLAS_WIDTH && height === PAPERDOLL_LAYER_ATLAS_HEIGHT;
}

function isReadonlyImageSourceMap(
  sources: PaperdollImageSourceMap,
): sources is ReadonlyMap<string, CanvasImageSource | null | undefined> {
  return typeof (sources as ReadonlyMap<string, CanvasImageSource>).get === "function";
}

export function getPaperdollImageSource(
  sources: PaperdollImageSourceMap | null | undefined,
  path: string,
): CanvasImageSource | null | undefined {
  if (!sources) return undefined;
  return isReadonlyImageSourceMap(sources)
    ? sources.get(path)
    : sources[path];
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

function resolvePaperdollLayers(
  loadout: PaperdollLoadout,
  direction: PaperdollDirection,
  sources: PaperdollImageSourceMap | null | undefined,
): readonly ResolvedPaperdollLayer[] {
  return sortPaperdollPieces(loadout, direction).flatMap((piece) => {
    const path = getPaperdollLayerPath(piece.slot, piece.variant);
    if (!path) return [];
    return [{
      piece,
      pass: resolvePaperdollLayer(piece.slot, direction),
      path,
      source: getPaperdollImageSource(sources, path),
    }];
  });
}

export type PaperdollResolvedLayerInfo = Readonly<{
  slot: EquipmentSlot;
  pass: PaperdollLayer;
  path: string;
  ready: boolean;
}>;

/** Inspection surface used by asset QA and runtime diagnostics. */
export function resolvePaperdollLayerInfo(
  loadoutValue: unknown,
  directionValue: number,
  sources?: PaperdollImageSourceMap | null,
): readonly PaperdollResolvedLayerInfo[] {
  const direction = normalizePaperdollDirection(directionValue);
  const loadout = normalizePaperdollLoadout(loadoutValue);
  return resolvePaperdollLayers(loadout, direction, sources).map((layer) => ({
    slot: layer.piece.slot,
    pass: layer.pass,
    path: layer.path,
    ready: isPaperdollLayerAtlasReady(layer.source),
  }));
}

function drawRegisteredAtlasFrame(
  context: Paperdoll2dContext,
  atlas: CanvasImageSource,
  cell: PaperdollAtlasCell,
): void {
  context.drawImage(
    atlas,
    cell.x,
    cell.y,
    cell.width,
    cell.height,
    0,
    0,
    PAPERDOLL_FRAME_WIDTH,
    PAPERDOLL_FRAME_HEIGHT,
  );
}

function drawPaperdollFrameContents(
  context: Paperdoll2dContext,
  bodyAtlas: CanvasImageSource,
  layers: readonly ResolvedPaperdollLayer[],
  direction: PaperdollDirection,
  frame: PaperdollFrame,
): PaperdollFrameRenderResult {
  if (!isPaperdollBodyAtlasReady(bodyAtlas)) {
    return { drawn: false, complete: false };
  }
  const cell = paperdollFrameCell(direction, frame);
  let complete = true;

  const drawPass = (pass: PaperdollLayer) => {
    for (const layer of layers) {
      if (layer.pass !== pass) continue;
      if (!isPaperdollLayerAtlasReady(layer.source)) {
        complete = false;
        continue;
      }
      try {
        drawRegisteredAtlasFrame(context, layer.source, cell);
      } catch {
        complete = false;
      }
    }
  };

  drawPass("rear");
  try {
    drawRegisteredAtlasFrame(context, bodyAtlas, cell);
  } catch {
    return { drawn: false, complete: false };
  }
  drawPass("body");
  drawPass("front");
  return { drawn: true, complete };
}

function frameCacheKey(
  bodyAtlas: CanvasImageSource,
  layers: readonly ResolvedPaperdollLayer[],
  loadout: PaperdollLoadout,
  direction: PaperdollDirection,
  frame: PaperdollFrame,
): string {
  const layerSources = layers
    .map((layer) => `${layer.path}@${sourceIdentity(layer.source)}`)
    .join(",");
  return [
    sourceIdentity(bodyAtlas),
    direction,
    frame,
    createPaperdollGearSignature(loadout),
    layerSources,
  ].join("/");
}

export type ComposePaperdollFrameOptions = Readonly<{
  bodyAtlas: CanvasImageSource;
  layerSources?: PaperdollImageSourceMap | null;
  loadout?: unknown;
  direction: number;
  frame: number;
  cache?: PaperdollLruCache<string, PaperdollSurface>;
}>;

/** Creates or retrieves one exact-coordinate rear/body/front composite frame. */
export function composePaperdollFrame(
  options: ComposePaperdollFrameOptions,
): CanvasImageSource | null {
  const direction = normalizePaperdollDirection(options.direction);
  const frame = normalizePaperdollFrame(options.frame);
  const loadout = normalizePaperdollLoadout(options.loadout ?? {});
  const layers = resolvePaperdollLayers(loadout, direction, options.layerSources);
  const cache = options.cache ?? paperdollFrameCache;
  const key = frameCacheKey(options.bodyAtlas, layers, loadout, direction, frame);
  const cached = cache.get(key);
  if (cached) return cached;

  const surface = createSurface(PAPERDOLL_FRAME_WIDTH, PAPERDOLL_FRAME_HEIGHT);
  const context = surface ? surfaceContext(surface) : null;
  if (!surface || !context) return null;
  context.clearRect(0, 0, PAPERDOLL_FRAME_WIDTH, PAPERDOLL_FRAME_HEIGHT);
  const result = drawPaperdollFrameContents(
    context,
    options.bodyAtlas,
    layers,
    direction,
    frame,
  );
  if (!result.drawn) return null;
  // Never cache an incomplete frame: the same HTMLImageElement identity is
  // retained while its asynchronous atlas finishes decoding.
  if (result.complete) cache.set(key, surface);
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
  layerSources?: PaperdollImageSourceMap | null;
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

/** Draws rear layers -> mannequin -> fitted body/front layers at one baseline. */
export function drawPaperdollCharacter(
  context: CanvasRenderingContext2D,
  options: DrawPaperdollCharacterOptions,
): boolean {
  if (
    !Number.isFinite(options.x) ||
    !Number.isFinite(options.y) ||
    !Number.isFinite(options.width) ||
    !Number.isFinite(options.height) ||
    options.width <= 0 ||
    options.height <= 0
  ) return false;

  const direction = normalizePaperdollDirection(options.direction);
  const frame = normalizePaperdollFrame(options.frame);
  const loadout = normalizePaperdollLoadout(options.loadout ?? {});
  const cache = options.cache ?? paperdollFrameCache;
  const composed = composePaperdollFrame({
    bodyAtlas: options.bodyAtlas,
    layerSources: options.layerSources,
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

  // Non-DOM render hosts draw directly without populating the offscreen LRU.
  context.translate(
    options.x - options.width / 2,
    options.y - options.height * groundAnchorRatio,
  );
  context.scale(
    options.width / PAPERDOLL_FRAME_WIDTH,
    options.height / PAPERDOLL_FRAME_HEIGHT,
  );
  const layers = resolvePaperdollLayers(loadout, direction, options.layerSources);
  const result = drawPaperdollFrameContents(
    context,
    options.bodyAtlas,
    layers,
    direction,
    frame,
  );
  context.restore();
  return result.drawn;
}

export type DrawPaperdollCharacterDirectOptions = Omit<
  DrawPaperdollCharacterOptions,
  "cache"
>;

/**
 * Multiplayer renderer: draws registered layers straight to the destination
 * canvas. This deliberately bypasses the shared composite-frame LRU so a busy
 * plaza never creates and immediately evicts one OffscreenCanvas per player.
 */
export function drawPaperdollCharacterDirect(
  context: CanvasRenderingContext2D,
  options: DrawPaperdollCharacterDirectOptions,
): boolean {
  if (
    !Number.isFinite(options.x) ||
    !Number.isFinite(options.y) ||
    !Number.isFinite(options.width) ||
    !Number.isFinite(options.height) ||
    options.width <= 0 ||
    options.height <= 0
  ) return false;

  const direction = normalizePaperdollDirection(options.direction);
  const frame = normalizePaperdollFrame(options.frame);
  const loadout = normalizePaperdollLoadout(options.loadout ?? {});
  const layers = resolvePaperdollLayers(loadout, direction, options.layerSources);
  const alpha = Math.max(0, Math.min(1, options.alpha ?? 1));
  const groundAnchorRatio = Math.max(
    0,
    Math.min(1, options.groundAnchorRatio ?? PAPERDOLL_GROUND_ANCHOR_RATIO),
  );

  context.save();
  context.globalAlpha *= alpha;
  context.imageSmoothingEnabled = true;
  context.translate(
    options.x - options.width / 2,
    options.y - options.height * groundAnchorRatio,
  );
  context.scale(
    options.width / PAPERDOLL_FRAME_WIDTH,
    options.height / PAPERDOLL_FRAME_HEIGHT,
  );
  const result = drawPaperdollFrameContents(
    context,
    options.bodyAtlas,
    layers,
    direction,
    frame,
  );
  context.restore();
  return result.drawn;
}

export function clearPaperdollCaches(): void {
  paperdollFrameCache.clear();
}
