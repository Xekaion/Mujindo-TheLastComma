import {
  EQUIPMENT_SLOTS,
  type EquipmentSlot,
  type GearRarity,
} from "./equipment";
import {
  PAPERDOLL_ACTIVE_RIG_VERSION,
  PAPERDOLL_DIRECTION_COUNT,
  PAPERDOLL_FRAME_COLUMNS,
  PAPERDOLL_FRAME_HEIGHT,
  PAPERDOLL_FRAME_WIDTH,
  PAPERDOLL_GROUND_BASELINE,
  PAPERDOLL_RIG_MANIFEST,
  normalizePaperdollDirection,
  normalizePaperdollFrame,
  type PaperdollLoadout,
} from "./character-paperdoll";
import paperdollRigRuntimeAnchors from "./paperdoll-rig-anchors.runtime.generated.json";

export const EQUIPPED_RARITY_VFX_FRAME_SIZE = 256;
export const EQUIPPED_RARITY_VFX_FRAME_COUNT = 4;
export const EQUIPPED_RARITY_VFX_PATHS = {
  mythic: "/assets/effects/equipped-mythic-flash-v3.png",
  cosmic: "/assets/effects/equipped-cosmic-flash-v3.png",
} as const;

export type EquippedRarityVfxTier = keyof typeof EQUIPPED_RARITY_VFX_PATHS;
export type EquippedRarityVfxContext =
  | "combat"
  | "plaza-local"
  | "plaza-remote"
  | "portrait"
  | "pvp-back"
  | "pvp-front";

export type EquippedRarityVfxPiece = Readonly<{
  slot: EquipmentSlot;
  tier: EquippedRarityVfxTier;
  enhancement: number;
}>;

export type EquippedRarityVfxPlan = Readonly<{
  pieces: readonly EquippedRarityVfxPiece[];
  mythicCount: number;
  cosmicCount: number;
  saturation: number;
}>;

export type EquippedRarityVfxImageMap = Readonly<
  Partial<Record<EquippedRarityVfxTier, CanvasImageSource | null | undefined>>
>;

export type DrawEquippedRarityVfxOptions = Readonly<{
  plan: EquippedRarityVfxPlan;
  images: EquippedRarityVfxImageMap;
  direction: number;
  frame: number;
  timeMs: number;
  x: number;
  y: number;
  width: number;
  height: number;
  context?: EquippedRarityVfxContext;
  alpha?: number;
  reducedMotion?: boolean;
}>;

const SLOT_PRIORITY: Readonly<Record<EquipmentSlot, number>> = {
  weapon: 0,
  relic: 1,
  helm: 2,
  shoulders: 3,
  armor: 4,
  offhand: 5,
  gloves: 6,
  boots: 7,
  belt: 8,
  legs: 9,
};

export type PaperdollRigVisualAnchor = readonly [number, number];

export type PaperdollRigRuntimeAnchors = Readonly<{
  schemaVersion: number;
  algorithmVersion: string;
  rigVersion: string;
  frame: Readonly<{
    width: number;
    height: number;
    columns: number;
    directionRows: readonly number[];
    groundBaseline: number;
    footPivot: readonly [number, number];
  }>;
  slots: Readonly<
    Record<
      EquipmentSlot,
      readonly (readonly PaperdollRigVisualAnchor[])[]
    >
  >;
  sourceReportIntegrity: Readonly<{
    inputSha256: string;
    geometrySha256: string;
    payloadSha256: string;
  }>;
}>;

/** Compact runtime projection of the full 101-atlas geometry audit. */
export const PAPERDOLL_RIG_RUNTIME_ANCHORS =
  paperdollRigRuntimeAnchors as unknown as PaperdollRigRuntimeAnchors;

function assertActivePaperdollRuntimeAnchors(): void {
  const report = PAPERDOLL_RIG_RUNTIME_ANCHORS;
  const expected = PAPERDOLL_RIG_MANIFEST.anchorReport;
  const [footX, footY] = report.frame.footPivot;
  const sha256Pattern = /^[a-f0-9]{64}$/;
  if (
    report.schemaVersion !== expected.schemaVersion ||
    report.algorithmVersion !== expected.algorithmVersion ||
    report.rigVersion !== PAPERDOLL_ACTIVE_RIG_VERSION ||
    report.frame.width !== PAPERDOLL_FRAME_WIDTH ||
    report.frame.height !== PAPERDOLL_FRAME_HEIGHT ||
    report.frame.columns !== PAPERDOLL_FRAME_COLUMNS ||
    report.frame.groundBaseline !== PAPERDOLL_GROUND_BASELINE ||
    report.frame.directionRows.length !== PAPERDOLL_DIRECTION_COUNT ||
    report.frame.directionRows.some(
      (row, index) => row !== PAPERDOLL_RIG_MANIFEST.frame.directionRows[index],
    ) ||
    PAPERDOLL_RIG_MANIFEST.slots.length !== EQUIPMENT_SLOTS.length ||
    PAPERDOLL_RIG_MANIFEST.slots.some(
      (slot, index) => slot !== EQUIPMENT_SLOTS[index],
    ) ||
    Object.keys(report.slots).length !== EQUIPMENT_SLOTS.length ||
    footX !== PAPERDOLL_FRAME_WIDTH / 2 ||
    footY !== PAPERDOLL_GROUND_BASELINE ||
    !sha256Pattern.test(report.sourceReportIntegrity.inputSha256) ||
    !sha256Pattern.test(report.sourceReportIntegrity.geometrySha256) ||
    !sha256Pattern.test(report.sourceReportIntegrity.payloadSha256) ||
    EQUIPMENT_SLOTS.some(
      (slot) =>
        report.slots[slot]?.length !== PAPERDOLL_DIRECTION_COUNT ||
        report.slots[slot].some(
          (directionCells) =>
            directionCells.length !== PAPERDOLL_FRAME_COLUMNS ||
            directionCells.some(
              (visualAnchor) =>
                visualAnchor.length !== 2 ||
                visualAnchor.some((value) => !Number.isFinite(value)),
            ),
        ),
    )
  ) {
    throw new Error("active paperdoll runtime anchors are stale or malformed");
  }
}

assertActivePaperdollRuntimeAnchors();

const SLOT_SCALE: Readonly<Record<EquipmentSlot, number>> = {
  helm: 0.31,
  shoulders: 0.46,
  armor: 0.53,
  gloves: 0.38,
  belt: 0.36,
  legs: 0.46,
  boots: 0.43,
  weapon: 0.43,
  offhand: 0.42,
  relic: 0.38,
};

const CONTEXT_ALPHA: Readonly<Record<EquippedRarityVfxContext, number>> = {
  combat: 1,
  "plaza-local": 1,
  "plaza-remote": 1,
  portrait: 1,
  // A duel can place two fully chase-tier loadouts in the same tight focal
  // area. Most of their light is therefore painted behind the paperdoll and
  // only a restrained glint is allowed over the armour silhouette.
  "pvp-back": 0.32,
  "pvp-front": 0.08,
};

const CONTEXT_SCALE: Readonly<Record<EquippedRarityVfxContext, number>> = {
  combat: 1,
  "plaza-local": 1,
  "plaza-remote": 1,
  portrait: 1,
  "pvp-back": 0.92,
  "pvp-front": 0.68,
};

const CONTEXT_PIECE_LIMIT: Readonly<Record<EquippedRarityVfxContext, number>> = {
  combat: EQUIPMENT_SLOTS.length,
  "plaza-local": EQUIPMENT_SLOTS.length,
  "plaza-remote": EQUIPMENT_SLOTS.length,
  portrait: EQUIPMENT_SLOTS.length,
  "pvp-back": 4,
  "pvp-front": 2,
};

function vfxTier(rarity: GearRarity): EquippedRarityVfxTier | null {
  if (rarity === "cosmic") return "cosmic";
  if (rarity === "mythic") return "mythic";
  return null;
}

export function resolveEquippedRarityVfxPlan(
  loadout: PaperdollLoadout,
): EquippedRarityVfxPlan {
  const pieces = EQUIPMENT_SLOTS.flatMap((slot) => {
    const piece = loadout[slot];
    const tier = piece ? vfxTier(piece.rarity) : null;
    return piece && tier
      ? [{ slot, tier, enhancement: Math.max(0, Math.min(10, piece.enhancement)) }]
      : [];
  }).sort((left, right) => {
    const tierDelta = Number(right.tier === "cosmic") - Number(left.tier === "cosmic");
    return tierDelta || SLOT_PRIORITY[left.slot] - SLOT_PRIORITY[right.slot];
  });
  const mythicCount = pieces.filter((piece) => piece.tier === "mythic").length;
  const cosmicCount = pieces.length - mythicCount;
  const energy = mythicCount + cosmicCount * 2;
  return {
    pieces,
    mythicCount,
    cosmicCount,
    saturation: energy === 0 ? 0 : energy / (energy + 4),
  };
}

export function equippedRarityVfxAnchor(
  slot: EquipmentSlot,
  directionValue: number,
  frameValue: number,
): readonly [number, number] {
  const direction = normalizePaperdollDirection(directionValue);
  const frame = normalizePaperdollFrame(frameValue);
  return PAPERDOLL_RIG_RUNTIME_ANCHORS.slots[slot][direction][frame];
}

function sourceReady(source: CanvasImageSource | null | undefined): source is CanvasImageSource {
  if (!source) return false;
  const dimensions = source as CanvasImageSource & {
    naturalWidth?: number;
    naturalHeight?: number;
    width?: number;
    height?: number;
  };
  const width = dimensions.naturalWidth ?? dimensions.width ?? 0;
  const height = dimensions.naturalHeight ?? dimensions.height ?? 0;
  return width === EQUIPPED_RARITY_VFX_FRAME_SIZE * EQUIPPED_RARITY_VFX_FRAME_COUNT &&
    height === EQUIPPED_RARITY_VFX_FRAME_SIZE;
}

export function equippedRarityVfxFrame(
  timeMs: number,
  slot: EquipmentSlot,
  reducedMotion = false,
  tier: EquippedRarityVfxTier = "cosmic",
): number {
  if (reducedMotion || !Number.isFinite(timeMs)) return 1;
  const phase = SLOT_PRIORITY[slot] * 137;
  const frameDurationMs = tier === "mythic" ? 145 : 110;
  return Math.floor((Math.max(0, timeMs) + phase) / frameDurationMs) %
    EQUIPPED_RARITY_VFX_FRAME_COUNT;
}

export function drawEquippedRarityVfx(
  canvas: CanvasRenderingContext2D,
  options: DrawEquippedRarityVfxOptions,
): number {
  if (
    !Number.isFinite(options.x) ||
    !Number.isFinite(options.y) ||
    !Number.isFinite(options.width) ||
    !Number.isFinite(options.height) ||
    options.width <= 0 ||
    options.height <= 0
  ) return 0;
  const context = options.context ?? "combat";
  const pieces = options.plan.pieces.slice(0, CONTEXT_PIECE_LIMIT[context]);
  const pieceCount = pieces.length;
  if (pieceCount === 0) return 0;
  const [footPivotX, footPivotY] = PAPERDOLL_RIG_RUNTIME_ANCHORS.frame.footPivot;
  const originX = options.x - (footPivotX / PAPERDOLL_FRAME_WIDTH) * options.width;
  const originY = options.y - (footPivotY / PAPERDOLL_FRAME_HEIGHT) * options.height;
  const alpha = Math.max(0, Math.min(1, options.alpha ?? 1));
  let draws = 0;

  canvas.save();
  // Nearest-neighbour scaling preserves the deliberately coarse pre-rendered
  // pixels at combat scale. Both transparent flash atlases use screen blending:
  // mythic keeps its ivory-magenta peak while cosmic's cyan, white, and violet
  // galaxy sparks stay luminous against dark armour and dungeon floors.
  canvas.imageSmoothingEnabled = false;
  for (let index = 0; index < pieceCount; index += 1) {
    const piece = pieces[index];
    const source = options.images[piece.tier];
    if (!sourceReady(source)) continue;
    const [anchorX, anchorY] = equippedRarityVfxAnchor(
      piece.slot,
      options.direction,
      options.frame,
    );
    const pulse = options.reducedMotion
      ? 1
      : 0.9 + 0.1 * Math.sin((options.timeMs + SLOT_PRIORITY[piece.slot] * 173) / 210);
    const enhancementBoost = 1 + piece.enhancement * 0.008;
    const size =
      options.height *
      SLOT_SCALE[piece.slot] *
      pulse *
      enhancementBoost *
      CONTEXT_SCALE[context];
    const x = originX + (anchorX / PAPERDOLL_FRAME_WIDTH) * options.width;
    const y = originY + (anchorY / PAPERDOLL_FRAME_HEIGHT) * options.height;
    const sourceFrame = equippedRarityVfxFrame(
      options.timeMs,
      piece.slot,
      options.reducedMotion,
      piece.tier,
    );
    // Expedition, plaza, and portrait surfaces retain authored opacity. PvP
    // deliberately uses its two-pass context profile so equipment remains the
    // foreground read even when both players wear ten chase-tier pieces.
    canvas.globalAlpha = alpha * CONTEXT_ALPHA[context];
    canvas.globalCompositeOperation = "screen";
    canvas.drawImage(
      source,
      sourceFrame * EQUIPPED_RARITY_VFX_FRAME_SIZE,
      0,
      EQUIPPED_RARITY_VFX_FRAME_SIZE,
      EQUIPPED_RARITY_VFX_FRAME_SIZE,
      x - size / 2,
      y - size / 2,
      size,
      size,
    );
    draws += 1;
  }
  canvas.restore();
  return draws;
}
