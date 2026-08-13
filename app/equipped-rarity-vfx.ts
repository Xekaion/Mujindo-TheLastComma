import {
  EQUIPMENT_SLOTS,
  type EquipmentSlot,
  type GearRarity,
} from "./equipment";
import {
  PAPERDOLL_GROUND_ANCHOR_RATIO,
  normalizePaperdollDirection,
  normalizePaperdollFrame,
  type PaperdollLoadout,
} from "./character-paperdoll";

export const EQUIPPED_RARITY_VFX_FRAME_SIZE = 256;
export const EQUIPPED_RARITY_VFX_FRAME_COUNT = 4;
export const EQUIPPED_RARITY_VFX_PATHS = {
  mythic: "/assets/effects/equipped-mythic-flash-v3.png",
  cosmic: "/assets/effects/equipped-cosmic-aura-v2.png",
} as const;

export type EquippedRarityVfxTier = keyof typeof EQUIPPED_RARITY_VFX_PATHS;
export type EquippedRarityVfxContext = "combat" | "plaza-local" | "plaza-remote" | "portrait";

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

type DirectionAnchorRow = readonly [
  readonly [number, number],
  readonly [number, number],
  readonly [number, number],
  readonly [number, number],
  readonly [number, number],
  readonly [number, number],
  readonly [number, number],
  readonly [number, number],
];

/**
 * Median alpha-centres measured from every registered v2 wearable atlas.
 * Rows follow runtime S,SW,W,NW,N,NE,E,SE, so held and asymmetric pieces stay
 * physically attached instead of merely mirroring a generic front-facing pin.
 */
const SLOT_DIRECTION_ANCHORS: Readonly<Record<EquipmentSlot, DirectionAnchorRow>> = {
  helm: [[125, 36], [121, 51], [116, 43], [126, 36], [129, 36], [122, 36], [130, 39], [124, 39]],
  shoulders: [[115, 71], [142, 82], [124, 79], [121, 70], [126, 70], [126, 72], [126, 74], [122, 76]],
  armor: [[128, 87], [126, 96], [127, 98], [124, 88], [129, 88], [129, 93], [121, 94], [124, 95]],
  gloves: [[123, 111], [132, 118], [129, 116], [121, 110], [126, 111], [131, 112], [125, 113], [116, 114]],
  belt: [[112, 114], [152, 120], [144, 119], [112, 114], [115, 114], [149, 114], [126, 116], [107, 118]],
  legs: [[114, 132], [129, 138], [131, 144], [124, 132], [128, 134], [134, 137], [127, 142], [123, 136]],
  boots: [[126, 164], [124, 164], [124, 166], [123, 165], [126, 166], [130, 164], [132, 166], [132, 164]],
  weapon: [[97, 104], [109, 117], [105, 118], [146, 114], [150, 111], [155, 142], [103, 130], [97, 118]],
  offhand: [[151, 106], [155, 128], [146, 134], [96, 105], [100, 111], [111, 116], [152, 134], [143, 108]],
  relic: [[111, 86], [155, 97], [148, 94], [111, 86], [114, 88], [150, 88], [126, 88], [104, 93]],
};

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

const CONTEXT_CAP: Readonly<Record<EquippedRarityVfxContext, number>> = {
  combat: 4,
  "plaza-local": 3,
  "plaza-remote": 1,
  portrait: 5,
};

const CONTEXT_ALPHA: Readonly<Record<EquippedRarityVfxContext, number>> = {
  combat: 1,
  "plaza-local": 1,
  "plaza-remote": 1,
  portrait: 1,
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

function directionAnchor(
  slot: EquipmentSlot,
  directionValue: number,
  frameValue: number,
): readonly [number, number] {
  const direction = normalizePaperdollDirection(directionValue);
  const frame = normalizePaperdollFrame(frameValue);
  const [x, y] = SLOT_DIRECTION_ANCHORS[slot][direction];
  // The body atlas shifts only horizontally between gait poses; these audited
  // deltas keep shoulder/weapon effects attached to the same painted pixels.
  const gaitX = (
    [
      [0, -2, 1, 0],
      [-1, 0, 0, 1],
      [-3, 1, 1, 1],
      [-2, 2, -3, 2],
      [-2, 1, -1, 2],
      [2, -3, 3, -2],
      [3, -2, 0, -1],
      [1, -1, 0, 0],
    ] as const
  )[direction][frame];
  return [x + gaitX, y];
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
  const pieceCount = Math.min(options.plan.pieces.length, CONTEXT_CAP[context]);
  if (pieceCount === 0) return 0;
  const originX = options.x - options.width / 2;
  const originY = options.y - options.height * PAPERDOLL_GROUND_ANCHOR_RATIO;
  const alpha = Math.max(0, Math.min(1, options.alpha ?? 1));
  let draws = 0;

  canvas.save();
  // Nearest-neighbour scaling preserves the deliberately coarse pre-rendered
  // pixels at combat scale. Cosmic keeps its authored dark nebula via normal
  // compositing; the transparent mythic flash alone uses screen blending so
  // its short ivory peak reads against both dark armour and dungeon floors.
  canvas.imageSmoothingEnabled = false;
  for (let index = 0; index < pieceCount; index += 1) {
    const piece = options.plan.pieces[index];
    const source = options.images[piece.tier];
    if (!sourceReady(source)) continue;
    const [anchorX, anchorY] = directionAnchor(
      piece.slot,
      options.direction,
      options.frame,
    );
    const pulse = options.reducedMotion
      ? 1
      : 0.9 + 0.1 * Math.sin((options.timeMs + SLOT_PRIORITY[piece.slot] * 173) / 210);
    const enhancementBoost = 1 + piece.enhancement * 0.008;
    const size = options.height * SLOT_SCALE[piece.slot] * pulse * enhancementBoost;
    const x = originX + (anchorX / 256) * options.width;
    const y = originY + (anchorY / 192) * options.height;
    const sourceFrame = equippedRarityVfxFrame(
      options.timeMs,
      piece.slot,
      options.reducedMotion,
      piece.tier,
    );
    // Rarity never lowers authored opacity: mythic magenta and cosmic nebula
    // retain their original color density in every surface. Only an explicit
    // character-state alpha (death/stale/respawn) may fade the composite.
    canvas.globalAlpha = alpha * CONTEXT_ALPHA[context];
    canvas.globalCompositeOperation = piece.tier === "mythic" ? "screen" : "source-over";
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
