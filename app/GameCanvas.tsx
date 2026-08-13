"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";
import "./game.css";
import InventoryOverlay from "./InventoryOverlay";
import ShopOverlay from "./ShopOverlay";
import StatsOverlay from "./StatsOverlay";
import { playGameSfx, playGearRaritySfx } from "./game-audio";
import { calculatePlayerStatSnapshot } from "./player-stats";
import {
  MAX_AUGMENT_STACKS,
  SIMPLE_AUGMENT_BONUSES,
  clampAugmentStack,
  normalizeAugmentStacks,
  selectAugmentChoices,
  simpleAugmentMultiplier,
  simpleDefenseDamageMultiplier,
} from "./augment-balance";
import { BASE_PLAYER_ATTACK_DAMAGE } from "./combat-balance";
import {
  GAMEPLAY_VFX_MANIFEST,
  augmentIconAssetPath,
  augmentVfxId,
  drawGameplayVfxFrame,
  gameplayVfxImageEntries,
  gameplayVfxImageKey,
  legendaryVfxId,
  projectileVfxId,
  type GameplayVfxId,
} from "./augment-vfx";
import {
  CHARACTER_IDLE_FRAME,
  advanceCharacterWalkCycle,
  characterSpriteRowForFacing,
  characterRenderFrameIndex,
  resolveCharacterMotion,
  settleCharacterWalkCycle,
} from "./character-motion";
import {
  PAPERDOLL_BODY_PATH,
  PAPERDOLL_WORLD_RENDER_HEIGHT,
  PAPERDOLL_WORLD_RENDER_WIDTH,
  createPaperdollEquipmentSignature,
  createPaperdollGearSignature,
  drawPaperdollCharacter,
  paperdollLayerPathsForLoadout,
  paperdollLoadoutFromEquipment,
  clearPaperdollCaches,
} from "./character-paperdoll";
import { createBrowserPaperdollImageStore } from "./paperdoll-image-store";
import {
  EQUIPPED_RARITY_VFX_PATHS,
  drawEquippedRarityVfx,
  resolveEquippedRarityVfxPlan,
} from "./equipped-rarity-vfx";
import {
  compactArrayInPlace,
  compactPositiveFieldInPlace,
  findNearestAliveEntity,
  findNearestUnhitAliveEntity,
  shouldDrawProjectileTrail,
  sweptCircleMayOverlap,
} from "./runtime-performance";
import {
  BASE_EXPEDITION_DIFFICULTY,
  calculateExpeditionDifficulty,
  calculateExpeditionEnemyCount,
  expeditionEnemyHpMultiplier,
  updateExpeditionPowerRating,
  type ExpeditionDifficulty,
} from "./expedition-difficulty";
import {
  absorbTrackedShield,
  advanceContinuousMovement,
  advanceLegendaryCounter,
  refreshTrackedShield,
  removeTrackedShield,
} from "./legendary-runtime";
import {
  MARGIN_SEVERER_ACTIVE_SECONDS,
  MARGIN_SEVERER_DAMAGE_MULTIPLIER,
  MARGIN_SEVERER_HIT_HALF_WIDTH,
  MARGIN_SEVERER_KIND,
  MARGIN_SEVERER_MAX_PER_ROOM,
  MARGIN_SEVERER_RECOVERY_SECONDS,
  MARGIN_SEVERER_TELEGRAPH_SECONDS,
  MARGIN_SEVERER_UNLOCK_DEPTH,
  MARGIN_SEVERER_WALK_ROW_CROPS,
  marginSeverLine,
} from "./enemy-balance";
import {
  SILENT_LIBRARIAN_DAMAGE_MULTIPLIER,
  SILENT_LIBRARIAN_KIND,
  SILENT_LIBRARIAN_MAX_PER_ROOM,
  SILENT_LIBRARIAN_RECOVERY_SECONDS,
  SILENT_LIBRARIAN_TELEGRAPH_SECONDS,
  SILENT_LIBRARIAN_UNLOCK_DEPTH,
  SILENT_LIBRARIAN_WAVE_SECONDS,
  silentLibrarianWaveProgress,
  silentLibrarianWaveRadius,
  sweptEchoRingHits,
} from "./silent-librarian";
import { experienceRequiredForLevel } from "./progression";
import {
  BASE_INVENTORY_CAPACITY,
  MAP_TELEPORT_PRODUCT_ID,
  completeLocalShopPurchase,
  inventoryCapacityFor,
  hasMapTeleportEntitlement,
  readShopEntitlements,
  shopCheckoutMode,
  type ShopCheckoutMode,
  type ShopEntitlements,
  type ShopProductId,
  type ShopReceipt,
} from "./shop";
import {
  MAP_TELEPORT_STATUS_LABELS,
  getMapTeleportStatus,
  isMapTeleportDepartureSafe,
  isSafeMapCoordinate,
} from "./map-teleport";
import {
  DUNGEON_CENTER_COORDINATE,
  DUNGEON_GRID_SIZE,
  DUNGEON_LAYOUT_VERSION,
  DUNGEON_MAX_COORDINATE,
  DUNGEON_MIN_COORDINATE,
  createDownStairRoomLookup,
  dungeonDisplayCoordinate,
  dungeonDoorAccess,
  isDungeonCoordinate,
  normalizeDungeonFloor,
  parseDungeonCoordinateKey,
  type DungeonDoorAccess,
} from "./dungeon-floor";
import {
  WALKABLE_FLOOR_POLYGON,
  constrainPointToConvexPolygon,
  projectPointToConvexPolygon,
} from "./room-collision";
import {
  advanceRoomDoorMotion,
  beginRoomDoorOpening,
  createClosedRoomDoorMotion,
  createRoomDoorMotion,
  roomDoorFrame,
  roomDoorsPassable,
  type RoomDoorMotion,
} from "./room-doors";
import {
  ROOM_ART_NAMES,
  ROOM_ART_PATHS,
  ROOM_STAIR_ART_PATHS,
  ROOM_STAIR_ASSET_ANCHOR,
  resolveRoomArtKey,
  resolveStairRoomArtKey,
  type RoomStairArtKey,
} from "./room-visuals";
import {
  SAVE_SLOT_IDS,
  markSaveSlotEndingSeen,
  migrateLegacySave,
  readSaveSlot,
  readSaveSlotSummaries,
  removeSaveSlot,
  writeActiveSaveSlot,
  writeSaveSlot,
  type SaveSlotId,
  type SaveSlotSummary,
} from "./save-slots";
import {
  BLANK_CARTOGRAPHER_KIND,
  ENDING_CONTINUE_LABEL,
  FIRST_BOSS_ENDING_CHAPTERS,
  FIRST_BOSS_ENDING_VERSION,
  normalizeEndingVersion,
  shouldRevealFirstBossEnding,
} from "./ending";
import {
  BLANK_CARTOGRAPHER_BASE_HP,
  BLANK_CARTOGRAPHER_PATTERN_LABELS,
  BLANK_CARTOGRAPHER_RECOVERY_SECONDS,
  BLANK_CARTOGRAPHER_RIFT_COUNT,
  BLANK_CARTOGRAPHER_SUMMON_COUNT,
  BLANK_CARTOGRAPHER_TELEGRAPH_SECONDS,
  blankCartographerPatternAt,
  type BlankCartographerPattern,
} from "./boss-balance";
import {
  FINAL_BINDER_BASE_DAMAGE,
  FINAL_BINDER_BASE_HP,
  FINAL_BINDER_BASE_SPEED,
  FINAL_BINDER_CHAPTER_BURST_SECONDS,
  FINAL_BINDER_CHAPTER_INNER_RADIUS,
  FINAL_BINDER_CHAPTER_OUTER_RADIUS,
  FINAL_BINDER_CHAPTER_PULSES,
  FINAL_BINDER_CHAPTER_SAFE_HALF_ANGLE,
  FINAL_BINDER_KIND,
  FINAL_BINDER_PAGE_WALL_HALF_WIDTH,
  FINAL_BINDER_PAGE_WALL_SECONDS,
  FINAL_BINDER_PATTERN_LABELS,
  FINAL_BINDER_PHASE_LABELS,
  FINAL_BINDER_RADIUS,
  FINAL_BINDER_RECOVERY_SECONDS,
  FINAL_BINDER_TELEGRAPH_SECONDS,
  FINAL_BINDER_THREAD_HALF_WIDTH,
  FINAL_BINDER_THREAD_SWEEP_ARC,
  FINAL_BINDER_THREAD_SWEEP_SECONDS,
  finalBinderChapterHits,
  finalBinderChapterSafeSector,
  finalBinderPageWallSegments,
  finalBinderPatternAt,
  finalBinderThreadSweepSegment,
  type FinalBinderAxis,
  type FinalBinderPattern,
  type FinalBinderPhase,
} from "./final-binder-balance";
import {
  PALIMPSEST_ARCHIVIST_BASE_DAMAGE,
  PALIMPSEST_ARCHIVIST_BASE_HP,
  PALIMPSEST_ARCHIVIST_BASE_SPEED,
  PALIMPSEST_ARCHIVIST_KIND,
  PALIMPSEST_ARCHIVIST_PATTERN_LABELS,
  PALIMPSEST_ARCHIVIST_PHASE_LABELS,
  PALIMPSEST_ARCHIVIST_RADIUS,
  PALIMPSEST_TRACE_EXECUTE_SECONDS,
  advancePalimpsestArchivist,
  createPalimpsestState,
  tracePointAtArcProgress,
  type PalimpsestArchivistPattern,
  type PalimpsestArchivistPhase,
  type PalimpsestArchivistRuntimeState,
} from "./palimpsest-archivist";
import {
  bossKindForProgress,
  isBossKind,
  type BossKind,
} from "./boss-roster";
import {
  normalizeAutoSalvageThreshold,
  readAutoSalvagePreference,
  shouldAutoSalvageRarity,
  writeAutoSalvagePreference,
  type AutoSalvageThreshold,
} from "./auto-salvage";
import { SPENT_SHELTER_MESSAGE, isFirstShelterRest } from "./shelter-memory";
import { getRealtimeClient, getRealtimeDeviceId } from "./realtime-client";
import {
  PROFESSION_BONUS_PERCENT,
  PROFESSION_THRESHOLD,
  PROFESSION_TITLES,
  effectiveAugmentRank,
  isProfessionEligible,
} from "./professions";
import {
  EQUIPMENT_SLOTS,
  EQUIPMENT_SLOT_LABELS,
  GEAR_DROP_BASE_CHANCE,
  GEAR_DROP_CHANCE_CAP,
  GEAR_DROP_SCAVENGER_CHANCE_CAP,
  GEAR_DROP_SCAVENGER_CHANCE_PER_RANK,
  GEAR_ICON_COLUMNS,
  GEAR_ICON_ROWS,
  GEAR_RARITIES,
  GEAR_RARITY_META,
  LEGENDARY_POWERS,
  aggregateEquipmentStats,
  canEquipGearAtLevel,
  calculateEquipmentCombatPower,
  calculateEquipmentPowerDelta,
  calculateGearPowerScore,
  createEmptyEquipment,
  formatCompactGearLabel,
  formatGearDisplayName,
  formatGearNumericValue,
  gearIconCell,
  getGearAffixDisplay,
  getGearImplicitDisplay,
  getGearRequiredLevel,
  getGearSalvageAshBreakdown,
  getGearEnhancementRule,
  isExpeditionStartingRoom,
  reconcileEquipmentLevelRequirements,
  rollGear,
  rollGearDropLevel,
  rollGearDropRarity,
  rollFirstRoomGuaranteedRarity,
  shouldForceFirstRoomGearDrop,
  type EquipmentLoadout,
  type EquipmentSlot,
  type GearItem,
  type GearStatTotals,
} from "./equipment";

const WIDTH = 1280;
const HEIGHT = 720;
const LOCAL_RARITY_SHOWCASE_SLOTS = [
  "boots",
  "gloves",
  "belt",
  "helm",
  "shoulders",
  "weapon",
  "armor",
  "relic",
] as const satisfies readonly EquipmentSlot[];
const TIME_RIFT_WARNING_SECONDS = 0.9;
const TIME_RIFT_SEQUENCE_GAP = 0.34;
const TIME_RIFT_RADIUS = 74;
const TIME_RIFT_SPRITE_GRID = 2;
const TIME_RIFT_SOURCE_INSET_RATIO = 0.025;
const STAIRCASE_X =
  (WIDTH * ROOM_STAIR_ASSET_ANCHOR.x) /
  ROOM_STAIR_ASSET_ANCHOR.sourceWidth;
const STAIRCASE_Y =
  (HEIGHT * ROOM_STAIR_ASSET_ANCHOR.y) /
  ROOM_STAIR_ASSET_ANCHOR.sourceHeight;
const STAIRCASE_INTERACTION_RADIUS = 74;
const MEMORY_DROP_WALL_CLEARANCE = 30;
const GEAR_DROP_WALL_CLEARANCE = 40;
const SUMMON_WALL_CLEARANCE = 28;
const ROOM_GEOMETRY = {
  left: 74,
  right: WIDTH - 74,
  top: 70,
  bottom: HEIGHT - 70,
  horizontalDoorTop: HEIGHT / 2 - 64,
  horizontalDoorBottom: HEIGHT / 2 + 64,
  verticalDoorLeft: WIDTH / 2 - 74,
  verticalDoorRight: WIDTH / 2 + 74,
  transitionInsetX: 48,
  transitionInsetY: 46,
  openInsetX: 24,
  openInsetY: 24,
} as const;
const ROOM_DOOR_ATLAS_CELL_SIZE = 256;
const ROOM_DOOR_DRAW_WIDTH = 224;
const ROOM_DOOR_DRAW_HEIGHT = 148;
const ROOM_DOOR_CLOSE_REVEAL_TRANSITION = 0.24;
const ROOM_DOOR_ASSET_PATH = "/assets/effects/room-portcullis-v1.png";
const EMPTY_EQUIPMENT_RUNTIME_STATS = aggregateEquipmentStats(
  createEmptyEquipment(),
);
type DoorSide = "west" | "east" | "north" | "south";
const ROOM_DOOR_PLACEMENTS: ReadonlyArray<{
  side: DoorSide;
  x: number;
  y: number;
  angle: number;
}> = [
  { side: "north", x: WIDTH / 2, y: WALKABLE_FLOOR_POLYGON[0].y, angle: 0 },
  { side: "east", x: WALKABLE_FLOOR_POLYGON[2].x, y: HEIGHT / 2, angle: Math.PI / 2 },
  { side: "south", x: WIDTH / 2, y: WALKABLE_FLOOR_POLYGON[4].y, angle: Math.PI },
  { side: "west", x: WALKABLE_FLOOR_POLYGON[6].x, y: HEIGHT / 2, angle: -Math.PI / 2 },
];
type GameMode =
  | "menu"
  | "playing"
  | "augment"
  | "profession"
  | "story"
  | "shelter"
  | "map"
  | "dead"
  | "ending"
  | "paused";
type RoomKind = "battle" | "horde" | "elite" | "memory" | "shelter" | "boss";
type EnemyKind = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11;
type ProjectileAffinity =
  | "arcane"
  | "blood"
  | "ember"
  | "storm"
  | "frost"
  | "poison"
  | "echo"
  | "enemy"
  | "witch"
  | "boss";

type Augment = {
  id: string;
  name: string;
  description: string;
  flavor: string;
  color: string;
  icon: number;
  /** New augments may provide authored art; the legacy 20 keep atlas indices. */
  iconAsset?: string;
  tags: string[];
};

type ProfessionCeremony = {
  augment: Augment;
  title: string;
  rawRank: number;
};

const PROFESSION_CEREMONY_DURATION_MS = 3_900;
const PROFESSION_CEREMONY_REDUCED_MOTION_MS = 950;
const PROFESSION_CEREMONY_PARTICLES = Array.from({ length: 24 }, (_, index) => ({
  angle: `${index * 137.508}deg`,
  distance: `${38 + (index % 8) * 7}vmin`,
  delay: `${(index % 9) * 31}ms`,
  scale: `${0.58 + (index % 5) * 0.16}`,
}));

type GameConfirmation = {
  eyebrow: string;
  title: string;
  body: string;
  confirmLabel: string;
  tone?: "warning" | "danger";
};

type Enemy = {
  id: number;
  kind: EnemyKind;
  x: number;
  y: number;
  radius: number;
  hp: number;
  maxHp: number;
  speed: number;
  damage: number;
  shootCooldown: number;
  slow: number;
  orbitalCooldown: number;
  poisonDamage: number;
  poisonTime: number;
  facing: number;
  walkCycle: number;
  moving: boolean;
  elite?: boolean;
  patternPhase?:
    | "stalk"
    | "windup"
    | "charge"
    | "recover"
    | "orbit"
    | "riftWindup"
    | "inscribe"
    | "sever"
    | "echoWindup"
    | "echoWave";
  patternTimer?: number;
  patternX?: number;
  patternY?: number;
  patternHit?: boolean;
  strafeDirection?: 1 | -1;
  bossPattern?: BlankCartographerPattern;
  bossPatternIndex?: number;
  bossPhase?: "pursuit" | "telegraph" | "charge" | "timeRifts" | "recovery";
  patternTargetX?: number;
  patternTargetY?: number;
  bossSummonTargets?: Array<{ x: number; y: number }>;
  binderPattern?: FinalBinderPattern;
  binderPatternIndex?: number;
  binderPhase?: FinalBinderPhase;
  binderAxis?: FinalBinderAxis;
  binderDirection?: 1 | -1;
  binderSafeCenter?: number;
  binderStartAngle?: number;
  binderPulseIndex?: number;
  binderInitialSafeSector?: number;
  archivist?: PalimpsestArchivistRuntimeState;
  timeRifts?: Array<{
    x: number;
    y: number;
    delay: number;
    timer: number;
    telegraphed: boolean;
    triggered: boolean;
  }>;
};

const BOSS_PHASE_LABELS: Readonly<
  Record<NonNullable<Enemy["bossPhase"]>, string>
> = {
  pursuit: "다음 문장을 고르는 중",
  telegraph: "위험 예고",
  charge: "돌진",
  timeRifts: "좌표 고정",
  recovery: "문장 재구성",
};

type Projectile = {
  id: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
  damage: number;
  life: number;
  pierce: number;
  hostile: boolean;
  color: string;
  affinity: ProjectileAffinity;
  /** Identifies the authored projectile sheet without changing combat affinity. */
  vfxId?: GameplayVfxId;
  age: number;
  maxLife: number;
  previousX: number;
  previousY: number;
  hit: Set<number>;
  returnAfter?: number;
  returning?: boolean;
  /** Outbound hit is spent, but the projectile remains alive for its return. */
  outboundSpent?: boolean;
  returnMultiplier?: number;
  homing?: number;
  /** One id shared by every primary projectile in a single basic-attack volley. */
  criticalVolleyId?: number;
  /** Only primary critical volleys may advance 피로 짠 손아귀. */
  bloodwovenEligible?: boolean;
};

type MemoryOrb = {
  id: number;
  x: number;
  y: number;
  value: number;
};

type GearDrop = {
  id: number;
  x: number;
  y: number;
  item: GearItem;
  pickupDelay: number;
  appearanceAge: number;
};

type BehaviorEffectKind = "summon" | "teleport";
type LootEffectKind = "lootAwakening";
type CombatEffectKind =
  | "muzzle"
  | "playerImpact"
  | "hostileImpact"
  | "chainArc"
  | "mirrorBlock"
  | "mirrorWave"
  | "starfallBurst"
  | "bloodwovenBurst"
  | "ashboundShield"
  | "phantomTrail"
  | "timeRiftTelegraph"
  | "timeRiftBurst";
type EffectKind = BehaviorEffectKind | LootEffectKind | CombatEffectKind;

type VisualEffect = {
  id: number;
  kind: EffectKind;
  x: number;
  y: number;
  life: number;
  duration: number;
  size: number;
  color?: string;
  rarity?: GearItem["rarity"];
  angle?: number;
  endX?: number;
  endY?: number;
  /** Stable gameplay identity used to resolve an authored four-frame sheet. */
  vfxId?: GameplayVfxId;
};

const EQUIPMENT_RARITY_TIER: Readonly<Record<GearItem["rarity"], number>> = {
  common: 0,
  magic: 1,
  superior: 2,
  rare: 3,
  epic: 4,
  legendary: 5,
  mythic: 6,
  cosmic: 7,
};

type EquipmentRarityVfxConfig = {
  imageKey: string;
  imagePath: string;
  arrivalPattern:
    | "dustSeal"
    | "arcaneTriangle"
    | "thornBloom"
    | "compassBloom"
    | "reverseVortex"
    | "solarCoronation"
    | "mythicCoronation"
    | "nebulaCollapse";
  beamHeight: number;
  beamWidth: number;
  awakeningDuration: number;
  awakeningSize: number;
  itemRevealAt: number;
  beamRevealAt: number;
  itemRisePx: number;
  rayCount: number;
  moteCount: number;
  accentSides: number;
  spinDirection: 1 | -1;
};

const EQUIPMENT_RARITY_VFX: Readonly<
  Record<GearItem["rarity"], EquipmentRarityVfxConfig>
> = {
  common: {
    imageKey: "lootAwakeningCommon",
    imagePath: "/assets/effects/loot-awakening-common-v5.png",
    arrivalPattern: "dustSeal",
    beamHeight: 68,
    beamWidth: 7,
    awakeningDuration: 0.7,
    awakeningSize: 104,
    itemRevealAt: 0.52,
    beamRevealAt: 0.76,
    itemRisePx: 8,
    rayCount: 4,
    moteCount: 4,
    accentSides: 4,
    spinDirection: 1,
  },
  magic: {
    imageKey: "lootAwakeningMagic",
    imagePath: "/assets/effects/loot-awakening-magic-v5.png",
    arrivalPattern: "arcaneTriangle",
    beamHeight: 78,
    beamWidth: 8,
    awakeningDuration: 0.76,
    awakeningSize: 118,
    itemRevealAt: 0.58,
    beamRevealAt: 0.78,
    itemRisePx: 10,
    rayCount: 6,
    moteCount: 6,
    accentSides: 3,
    spinDirection: 1,
  },
  superior: {
    imageKey: "lootAwakeningSuperior",
    imagePath: "/assets/effects/loot-awakening-superior-v5.png",
    arrivalPattern: "thornBloom",
    beamHeight: 90,
    beamWidth: 10,
    awakeningDuration: 0.82,
    awakeningSize: 132,
    itemRevealAt: 0.62,
    beamRevealAt: 0.8,
    itemRisePx: 12,
    rayCount: 7,
    moteCount: 7,
    accentSides: 6,
    spinDirection: -1,
  },
  rare: {
    imageKey: "lootAwakeningRare",
    imagePath: "/assets/effects/loot-awakening-rare-v5.png",
    arrivalPattern: "compassBloom",
    beamHeight: 108,
    beamWidth: 12,
    awakeningDuration: 0.9,
    awakeningSize: 150,
    itemRevealAt: 0.64,
    beamRevealAt: 0.82,
    itemRisePx: 15,
    rayCount: 8,
    moteCount: 9,
    accentSides: 8,
    spinDirection: 1,
  },
  epic: {
    imageKey: "lootAwakeningEpic",
    imagePath: "/assets/effects/loot-awakening-epic-v5.png",
    arrivalPattern: "reverseVortex",
    beamHeight: 132,
    beamWidth: 16,
    awakeningDuration: 0.98,
    awakeningSize: 172,
    itemRevealAt: 0.66,
    beamRevealAt: 0.84,
    itemRisePx: 18,
    rayCount: 10,
    moteCount: 11,
    accentSides: 5,
    spinDirection: -1,
  },
  legendary: {
    imageKey: "lootAwakeningLegendary",
    imagePath: "/assets/effects/loot-awakening-legendary-v5.png",
    arrivalPattern: "solarCoronation",
    beamHeight: 174,
    beamWidth: 22,
    awakeningDuration: 1.12,
    awakeningSize: 204,
    itemRevealAt: 0.66,
    beamRevealAt: 0.86,
    itemRisePx: 23,
    rayCount: 12,
    moteCount: 14,
    accentSides: 12,
    spinDirection: 1,
  },
  mythic: {
    imageKey: "lootAwakeningMythic",
    imagePath: "/assets/effects/loot-awakening-mythic-v5.png",
    arrivalPattern: "mythicCoronation",
    beamHeight: 228,
    beamWidth: 30,
    awakeningDuration: 1.28,
    awakeningSize: 242,
    itemRevealAt: 0.7,
    beamRevealAt: 0.88,
    itemRisePx: 28,
    rayCount: 14,
    moteCount: 17,
    accentSides: 7,
    spinDirection: -1,
  },
  cosmic: {
    imageKey: "lootAwakeningCosmic",
    imagePath: "/assets/effects/loot-awakening-cosmic-v5.png",
    arrivalPattern: "nebulaCollapse",
    beamHeight: 296,
    beamWidth: 42,
    awakeningDuration: 1.5,
    awakeningSize: 276,
    itemRevealAt: 0.72,
    beamRevealAt: 0.9,
    itemRisePx: 36,
    rayCount: 16,
    moteCount: 20,
    accentSides: 16,
    spinDirection: -1,
  },
};

const EQUIPMENT_RARITIES: readonly GearItem["rarity"][] = [
  "common",
  "magic",
  "superior",
  "rare",
  "epic",
  "legendary",
  "mythic",
  "cosmic",
];

type RoomRecord = {
  kind: RoomKind;
  cleared: boolean;
};

type Player = {
  x: number;
  y: number;
  radius: number;
  hp: number;
  maxHp: number;
  shield: number;
  xp: number;
  nextXp: number;
  level: number;
  rooms: number;
  bossesCleared: number;
  kills: number;
  expeditionPowerRating: number;
  augments: Record<string, number>;
  fireCooldown: number;
  invulnerable: number;
  dashCooldown: number;
  dashTime: number;
  dashX: number;
  dashY: number;
  shotCounter: number;
  endingSeen: boolean;
  endingVersion: number;
  profession: string | null;
  facing: number;
  walkCycle: number;
  moving: boolean;
  equipment: EquipmentLoadout;
  inventory: GearItem[];
  autoSalvageMaxRarity: AutoSalvageThreshold;
  memoryAsh: number;
  memoryPickupCounter: number;
  legendaryArmorReady: boolean;
  riftTrailCooldown: number;
  mirrorAegisHitCount: number;
  mirrorAegisBarrierTime: number;
  starfallMantleTime: number;
  bloodwovenCriticalHits: number;
  bloodwovenBurstReady: boolean;
  bloodwovenLastCountedVolley: number;
  ashboundPickupCount: number;
  ashboundShieldRemaining: number;
  ashboundShieldTime: number;
  phantomMarchMoveTime: number;
  phantomMarchTrailCooldown: number;
  /** Cosmetic throttle for the elite/boss outline from 붉은 사냥의 문장. */
  hunterSigilPulseCooldown?: number;
};

function pointInsideWalkableFloor(x: number, y: number) {
  let inside = false;
  for (
    let index = 0, previous = WALKABLE_FLOOR_POLYGON.length - 1;
    index < WALKABLE_FLOOR_POLYGON.length;
    previous = index, index += 1
  ) {
    const a = WALKABLE_FLOOR_POLYGON[index];
    const b = WALKABLE_FLOOR_POLYGON[previous];
    const crosses =
      a.y > y !== b.y > y &&
      x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y || Number.EPSILON) + a.x;
    if (crosses) inside = !inside;
  }
  return inside;
}

function constrainPlayerToWalkableFloor(
  player: Pick<Player, "x" | "y">,
  doors: DungeonDoorAccess,
) {
  const inHorizontalDoor =
    player.y > ROOM_GEOMETRY.horizontalDoorTop &&
    player.y < ROOM_GEOMETRY.horizontalDoorBottom;
  const inVerticalDoor =
    player.x > ROOM_GEOMETRY.verticalDoorLeft &&
    player.x < ROOM_GEOMETRY.verticalDoorRight;

  const canUseHorizontalDoor =
    inHorizontalDoor &&
    ((player.x < WIDTH / 2 && doors.west) ||
      (player.x >= WIDTH / 2 && doors.east));
  const canUseVerticalDoor =
    inVerticalDoor &&
    ((player.y < HEIGHT / 2 && doors.north) ||
      (player.y >= HEIGHT / 2 && doors.south));

  if (canUseHorizontalDoor) {
    player.x = clamp(player.x, ROOM_GEOMETRY.openInsetX, WIDTH - ROOM_GEOMETRY.openInsetX);
    return;
  }
  if (canUseVerticalDoor) {
    player.y = clamp(player.y, ROOM_GEOMETRY.openInsetY, HEIGHT - ROOM_GEOMETRY.openInsetY);
    return;
  }
  if (pointInsideWalkableFloor(player.x, player.y)) return;

  let closestX = player.x;
  let closestY = player.y;
  let closestDistanceSquared = Number.POSITIVE_INFINITY;
  for (let index = 0; index < WALKABLE_FLOOR_POLYGON.length; index += 1) {
    const start = WALKABLE_FLOOR_POLYGON[index];
    const end = WALKABLE_FLOOR_POLYGON[(index + 1) % WALKABLE_FLOOR_POLYGON.length];
    const deltaX = end.x - start.x;
    const deltaY = end.y - start.y;
    const segmentLengthSquared = deltaX * deltaX + deltaY * deltaY;
    const projection = clamp(
      ((player.x - start.x) * deltaX + (player.y - start.y) * deltaY) /
        segmentLengthSquared,
      0,
      1,
    );

    const candidateX = start.x + deltaX * projection;
    const candidateY = start.y + deltaY * projection;
    const distanceSquared =
      (player.x - candidateX) ** 2 + (player.y - candidateY) ** 2;
    if (distanceSquared < closestDistanceSquared) {
      closestDistanceSquared = distanceSquared;
      closestX = candidateX;
      closestY = candidateY;
    }
  }
  player.x = closestX;
  player.y = closestY;
}

function constrainEnemyToWalkableFloor(enemy: Enemy) {
  return constrainPointToConvexPolygon(
    enemy,
    WALKABLE_FLOOR_POLYGON,
    enemy.radius,
  );
}

function safeWalkableFloorPoint(x: number, y: number, clearance: number) {
  return projectPointToConvexPolygon(
    x,
    y,
    WALKABLE_FLOOR_POLYGON,
    clearance,
  );
}

const isLocalRarityShowcaseHost = () =>
  typeof window !== "undefined" &&
  ["localhost", "127.0.0.1", "::1", "[::1]"].includes(window.location.hostname);

type World = {
  seed: number;
  layoutVersion: number;
  dungeonFloor: number;
  roomX: number;
  roomY: number;
  roomKind: RoomKind;
  roomCleared: boolean;
  rooms: Record<string, RoomRecord>;
  visited: string[];
  visitedLookup: Record<string, true>;
  stairRoomLookup: Record<string, true>;
  knownRoomCount: number;
  clearedRoomCount: number;
  enemies: Enemy[];
  projectiles: Projectile[];
  orbs: MemoryOrb[];
  gearDrops: GearDrop[];
  doorEffects: VisualEffect[];
  effects: VisualEffect[];
  effectCounts: Record<BehaviorEffectKind, number>;
  transition: number;
  doorMotion: RoomDoorMotion;
  clearHandled: boolean;
  activeBossKind: BossKind | null;
  expeditionDifficulty: ExpeditionDifficulty;
};

type CartographyWorld = Pick<
  World,
  | "seed"
  | "dungeonFloor"
  | "roomX"
  | "roomY"
  | "rooms"
  | "visited"
  | "stairRoomLookup"
>;

type SaveData = {
  player: Player;
  world: Pick<
    World,
    "seed" | "roomX" | "roomY" | "rooms" | "visited"
  > &
    Partial<Pick<World, "layoutVersion" | "dungeonFloor">>;
  stableAugments: Record<string, number>;
  savedAt: number;
};

const ROOM_KIND_VALUES = new Set<RoomKind>([
  "battle",
  "horde",
  "elite",
  "memory",
  "shelter",
  "boss",
]);

function isHydratableSaveData(value: unknown): value is SaveData {
  if (typeof value !== "object" || value === null) return false;
  const data = value as Partial<SaveData>;
  const world = data.world as SaveData["world"] | undefined;
  if (!data.player || !world || !Number.isFinite(world.seed)) return false;
  if (
    world.dungeonFloor !== undefined &&
    (!Number.isSafeInteger(world.dungeonFloor) || world.dungeonFloor < 1)
  ) {
    return false;
  }
  if (!Number.isInteger(world.roomX) || !Number.isInteger(world.roomY)) return false;
  if (!world.rooms || typeof world.rooms !== "object") return false;
  if (!Array.isArray(world.visited) || !world.visited.every((key) => typeof key === "string")) {
    return false;
  }
  return Object.values(world.rooms).every(
    (room) =>
      typeof room === "object" &&
      room !== null &&
      ROOM_KIND_VALUES.has(room.kind) &&
      typeof room.cleared === "boolean",
  );
}

function normalizeSavedDungeonWorld(world: SaveData["world"]): {
  dungeonFloor: number;
  roomX: number;
  roomY: number;
  rooms: Record<string, RoomRecord>;
  visited: string[];
} {
  if (world.layoutVersion !== DUNGEON_LAYOUT_VERSION) {
    return {
      dungeonFloor: 1,
      roomX: DUNGEON_CENTER_COORDINATE,
      roomY: DUNGEON_CENTER_COORDINATE,
      rooms: {},
      visited: [],
    };
  }

  const rooms = Object.fromEntries(
    Object.entries(world.rooms)
      .filter(([key]) => parseDungeonCoordinateKey(key) !== null)
      .slice(0, DUNGEON_GRID_SIZE * DUNGEON_GRID_SIZE)
      .map(([key, room]) => [key, { ...room }] as const),
  );
  const visited = Array.from(
    new Set(
      world.visited.filter(
        (key) => parseDungeonCoordinateKey(key) !== null && rooms[key] !== undefined,
      ),
    ),
  );
  const currentInBounds = isDungeonCoordinate(world.roomX, world.roomY);
  return {
    dungeonFloor: normalizeDungeonFloor(world.dungeonFloor),
    roomX: currentInBounds ? world.roomX : DUNGEON_CENTER_COORDINATE,
    roomY: currentInBounds ? world.roomY : DUNGEON_CENTER_COORDINATE,
    rooms,
    visited,
  };
}

const AUGMENT_DEFINITIONS: Augment[] = [
  {
    id: "fang",
    name: "거인의 송곳니",
    description: "모든 피해 +18%. 랭크 제한 없음.",
    flavor: "지도 바깥의 거인이 남긴 마지막 이빨.",
    color: "#d76b4a",
    icon: 14,
    tags: ["물리", "공격"],
  },
  {
    id: "haste",
    name: "가속 심장",
    description: "공격 속도가 소프트캡 방식으로 계속 상승.",
    flavor: "멈추면 잊힌다. 그러니 더 빨리 뛴다.",
    color: "#ef5b4c",
    icon: 1,
    tags: ["속도", "공격"],
  },
  {
    id: "split",
    name: "갈라진 별",
    description: "측면 투사체 +1. 9개 초과분은 피해로 전환.",
    flavor: "별 하나가 부서져도 밤은 더 밝아졌다.",
    color: "#d8d0b8",
    icon: 2,
    tags: ["투사체", "성좌"],
  },
  {
    id: "pierce",
    name: "관통 맹세",
    description: "관통 +1, 관통할수록 피해 증가.",
    flavor: "길이 막혔다면 길을 뚫는다.",
    color: "#d8c37b",
    icon: 10,
    tags: ["투사체", "물리"],
  },
  {
    id: "eye",
    name: "사냥꾼의 눈",
    description: "치명타 확률과 치명 피해 증가.",
    flavor: "먹잇감의 다음 발자국까지 보인다.",
    color: "#b98cd9",
    icon: 12,
    tags: ["치명", "공격"],
  },
  {
    id: "return",
    name: "되감긴 칼날",
    description: "투사체의 체공 시간과 되감기 피해 증가.",
    flavor: "떠난 칼날은 반드시 기억을 안고 돌아온다.",
    color: "#c9c4b6",
    icon: 0,
    tags: ["투사체", "시간"],
  },
  {
    id: "ember",
    name: "잿불 씨앗",
    description: "명중 시 화염 추가 피해. 랭크마다 증폭.",
    flavor: "꺼진 세계에도 재 속에는 불이 남는다.",
    color: "#ef6549",
    icon: 1,
    tags: ["화염", "원소"],
  },
  {
    id: "oil",
    name: "기름 문장",
    description: "적 처치 시 주변으로 화염 폭발.",
    flavor: "한 번 번진 기억은 스스로 길을 찾는다.",
    color: "#b33a31",
    icon: 5,
    tags: ["화염", "폭발"],
  },
  {
    id: "frost",
    name: "서리못",
    description: "명중한 적을 둔화. 중첩될수록 강해짐.",
    flavor: "차갑게 박힌 못은 시간까지 붙든다.",
    color: "#8fc7da",
    icon: 11,
    tags: ["냉기", "제어"],
  },
  {
    id: "storm",
    name: "폭풍 이빨",
    description: "확률적으로 가까운 적에게 연쇄 번개.",
    flavor: "번개는 가장 짧은 길을 기억한다.",
    color: "#a991ff",
    icon: 6,
    tags: ["번개", "원소"],
  },
  {
    id: "poison",
    name: "독성 꽃",
    description: "적중 피해에 지속 독성 피해를 합산.",
    flavor: "아름다운 기억일수록 오래 썩는다.",
    color: "#6bbf86",
    icon: 13,
    tags: ["독", "원소"],
  },
  {
    id: "blood",
    name: "피의 계약",
    description: "최대 체력 -15%, 랭크당 피해 +14%.",
    flavor: "지도는 피로 쓴 약속만 지운 적이 없다.",
    color: "#d04743",
    icon: 5,
    tags: ["피", "공격"],
  },
  {
    id: "predator",
    name: "포식자의 위장",
    description: "처치가 쌓일 때마다 체력 회복.",
    flavor: "살아남은 자는 패배까지 먹어 치운다.",
    color: "#99886c",
    icon: 17,
    tags: ["회복", "피"],
  },
  {
    id: "glass",
    name: "유리 고치",
    description: "방 입장 시 랭크에 비례한 보호막.",
    flavor: "깨질 때 가장 날카로운 방어.",
    color: "#b9d3d3",
    icon: 3,
    tags: ["방어", "보호막"],
  },
  {
    id: "boots",
    name: "방랑자의 장화",
    description: "이동 속도 증가, 회피 재사용 감소.",
    flavor: "끝없는 지도에는 닳지 않는 발이 필요하다.",
    color: "#d0a65e",
    icon: 4,
    tags: ["이동", "회피"],
  },
  {
    id: "void",
    name: "공허 걸음",
    description: "회피가 주변 적에게 공허 피해를 남김.",
    flavor: "발이 닿지 않은 곳에도 상처는 남는다.",
    color: "#8b5ecc",
    icon: 18,
    tags: ["공허", "회피"],
  },
  {
    id: "orbit",
    name: "궤도의 달",
    description: "주위를 도는 달 칼날 +1, 최대 8개 표시.",
    flavor: "달은 길을 잃어도 하린을 돈다.",
    color: "#d8d4c9",
    icon: 11,
    tags: ["성좌", "근접"],
  },
  {
    id: "time",
    name: "시간의 흉터",
    description: "일정 공격마다 과거의 공격이 겹쳐짐.",
    flavor: "이미 지나간 상처가 다시 열린다.",
    color: "#aa88d5",
    icon: 9,
    tags: ["시간", "공격"],
  },
  {
    id: "magnet",
    name: "기억 나침반",
    description: "기억 조각 획득 범위와 경험치 증가.",
    flavor: "라온의 목소리는 늘 조각이 많은 쪽을 가리킨다.",
    color: "#63c6b2",
    icon: 19,
    tags: ["기억", "성장"],
  },
  {
    id: "map",
    name: "빈 지도",
    description: "방 클리어 보너스 피해와 회복 증가.",
    flavor: "아무것도 적히지 않았기에 무엇이든 될 수 있다.",
    color: "#c7a760",
    icon: 16,
    tags: ["지도", "성장"],
  },
  {
    id: "focus",
    name: "길잡이 렌즈",
    description: "투사체 피해·속도·사거리가 함께 증가.",
    flavor: "끝을 보지 못해도 나아갈 방향은 선명하다.",
    color: "#81c8d5",
    icon: 12,
    tags: ["투사체", "정밀"],
  },
  {
    id: "caliber",
    name: "별철 탄심",
    description: "투사체의 크기와 충돌 피해 증가.",
    flavor: "추락한 별의 무게는 작은 탄환에도 남아 있다.",
    color: "#d9b86c",
    icon: 10,
    tags: ["투사체", "충격"],
  },
  {
    id: "homing",
    name: "추적의 실",
    description: "투사체가 아직 맞지 않은 적을 향해 선회.",
    flavor: "한 번 묶인 운명은 벽 너머에서도 서로를 찾는다.",
    color: "#82d1b4",
    icon: 19,
    tags: ["투사체", "추적"],
  },
  {
    id: "ricochet",
    name: "메아리 돌",
    description: "명중 시 확률적으로 가까운 적에게 물리 메아리.",
    flavor: "한 번의 타격이 빈 회랑에서 두 번 죽음을 부른다.",
    color: "#c5b99b",
    icon: 17,
    tags: ["연쇄", "물리"],
  },
  {
    id: "execution",
    name: "종언 낙인",
    description: "체력이 낮은 적에게 강한 마무리 피해.",
    flavor: "마침표가 찍힌 이름은 지도에서 먼저 사라진다.",
    color: "#e06a5c",
    icon: 14,
    tags: ["처형", "공격"],
  },
  {
    id: "giantbane",
    name: "거인 먹물",
    description: "정예와 보스에게 주는 피해가 크게 증가.",
    flavor: "가장 큰 이름일수록 지우는 데 더 짙은 먹물이 든다.",
    color: "#b58d62",
    icon: 16,
    tags: ["보스", "공격"],
  },
  {
    id: "overcharge",
    name: "심홍 태엽",
    description: "일정 사격마다 과충전 탄막을 발사.",
    flavor: "태엽은 부서지기 직전에 가장 빠르게 돈다.",
    color: "#ec6459",
    icon: 1,
    tags: ["과충전", "공격"],
  },
  {
    id: "shrapnel",
    name: "뼈꽃 탄환",
    description: "적 처치 시 사방으로 아군 파편을 방출.",
    flavor: "쓰러진 뼈에서 다음 사냥의 꽃잎이 핀다.",
    color: "#ddd4b9",
    icon: 2,
    tags: ["처치", "폭발"],
  },
  {
    id: "leech",
    name: "피바늘",
    description: "투사체가 적중할 때마다 체력을 조금 회복.",
    flavor: "바늘 끝의 한 방울이면 길을 한 걸음 더 잇는다.",
    color: "#c94f58",
    icon: 5,
    tags: ["흡혈", "회복"],
  },
  {
    id: "armor",
    name: "철의 기도",
    description: "받는 모든 피해가 완만하게 감소.",
    flavor: "기도가 닿지 않는 곳에는 철을 겹쳐 두었다.",
    color: "#aeb5b4",
    icon: 3,
    tags: ["방어", "피해감소"],
  },
  {
    id: "resolve",
    name: "마지막 맹세",
    description: "체력이 40% 아래일 때 추가 피해 감소.",
    flavor: "마지막 한 줄은 누구도 대신 지워 줄 수 없다.",
    color: "#d78972",
    icon: 14,
    tags: ["생존", "피해감소"],
  },
  {
    id: "regeneration",
    name: "달샘 잔향",
    description: "전투 중에도 체력이 지속적으로 재생.",
    flavor: "말라붙은 우물은 달빛만으로 다시 차올랐다.",
    color: "#8bcab7",
    icon: 13,
    tags: ["재생", "회복"],
  },
  {
    id: "ward",
    name: "봉인 방패",
    description: "방에 들어설 때 추가 보호막 획득.",
    flavor: "문이 닫히는 소리는 방패가 잠기는 소리이기도 했다.",
    color: "#8faec2",
    icon: 3,
    tags: ["보호막", "방어"],
  },
  {
    id: "bulwark",
    name: "수호석",
    description: "보호막이 남아 있는 동안 받는 피해 추가 감소.",
    flavor: "작은 돌 하나가 무너질 세계의 첫 벽이 되었다.",
    color: "#95a69c",
    icon: 18,
    tags: ["보호막", "피해감소"],
  },
  {
    id: "momentum",
    name: "바람매듭",
    description: "이동 속도가 중첩에 따라 계속 증가.",
    flavor: "붙잡아 맨 바람은 발끝에서만 풀린다.",
    color: "#d3b867",
    icon: 4,
    tags: ["이동", "속도"],
  },
  {
    id: "reflex",
    name: "두 번째 발걸음",
    description: "회피가 더 빠르고 길어지며 재사용 대기시간 감소.",
    flavor: "첫 발은 몸이, 두 번째 발은 기억이 내디딘다.",
    color: "#a99ee0",
    icon: 4,
    tags: ["회피", "기동"],
  },
  {
    id: "scholar",
    name: "기록자의 먼지",
    description: "모든 경로에서 얻는 경험치 증가.",
    flavor: "지워진 문장도 먼지 속에서는 다시 읽힌다.",
    color: "#c8a967",
    icon: 16,
    tags: ["경험치", "성장"],
  },
  {
    id: "scavenger",
    name: "기억 갈고리",
    description: "쓰러진 적이 남기는 기억 조각의 가치 증가.",
    flavor: "버려진 기억일수록 깊은 곳에 단단히 걸려 있다.",
    color: "#67c4aa",
    icon: 19,
    tags: ["기억", "수집"],
  },
  {
    id: "conquest",
    name: "승리의 등불",
    description: "방 정복 시 체력을 회복하고 보호막 충전.",
    flavor: "닫힌 문 넷을 열 때마다 작은 불 하나가 살아났다.",
    color: "#e0a85e",
    icon: 6,
    tags: ["정복", "회복"],
  },
  {
    id: "frenzy",
    name: "붉은 박자",
    description: "잃은 체력에 비례해 공격 속도 증가.",
    flavor: "상처가 늘수록 심장은 더 정확한 박자를 새겼다.",
    color: "#df5557",
    icon: 9,
    tags: ["공격속도", "피"],
  },
  {
    id: "strength",
    name: "공격력 증가",
    description: "스택당 기본 공격 피해 +10%.",
    flavor: "가장 단순한 힘은 언제나 가장 확실한 답이 된다.",
    color: "#e27759",
    icon: 14,
    tags: ["공격", "피해"],
  },
  {
    id: "rapidfire",
    name: "속사",
    description: "스택당 공격 속도 +8%.",
    flavor: "망설임을 버리자 다음 탄환이 먼저 길을 찾았다.",
    color: "#f09a62",
    icon: 9,
    tags: ["공격", "속도"],
  },
  {
    id: "range",
    name: "사거리 증가",
    description: "스택당 투사체 사거리 +12%.",
    flavor: "닿지 않던 적도 이제 기억의 끝 안에 들어온다.",
    color: "#78c8d8",
    icon: 12,
    tags: ["투사체", "사거리"],
  },
  {
    id: "velocity",
    name: "탄속 증가",
    description: "스택당 투사체 속도 +10%.",
    flavor: "보이는 순간에는 이미 명중한 뒤다.",
    color: "#8ed7c2",
    icon: 6,
    tags: ["투사체", "속도"],
  },
  {
    id: "expansion",
    name: "탄환 확대",
    description: "스택당 투사체 크기 +8%.",
    flavor: "작은 문장 하나가 전장을 덮는 획으로 번진다.",
    color: "#d8b86f",
    icon: 10,
    tags: ["투사체", "크기"],
  },
  {
    id: "sprint",
    name: "이동 속도 증가",
    description: "스택당 이동 속도 +5%.",
    flavor: "가벼워진 발걸음은 닫히는 문보다 빠르다.",
    color: "#d9c16d",
    icon: 4,
    tags: ["이동", "속도"],
  },
  {
    id: "defense",
    name: "방어력 증가",
    description: "스택당 받는 피해 -3%.",
    flavor: "겹쳐진 기억이 단단한 갑옷이 된다.",
    color: "#aeb9b6",
    icon: 3,
    tags: ["방어", "피해감소"],
  },
  {
    id: "recovery",
    name: "전투 회복",
    description: "스택당 방 클리어 시 체력 5 회복.",
    flavor: "조용해진 방에서 한 번 더 숨을 고른다.",
    color: "#82c9a7",
    icon: 13,
    tags: ["회복", "정복"],
  },
  {
    id: "learning",
    name: "빠른 성장",
    description: "스택당 경험치 획득량 +10%.",
    flavor: "같은 상처에서도 더 많은 답을 읽어 낸다.",
    color: "#c9aa6b",
    icon: 16,
    tags: ["경험치", "성장"],
  },
  {
    id: "collection",
    name: "수집 범위 증가",
    description: "스택당 기억 조각과 장비 획득 범위 +15%.",
    flavor: "흩어진 기억들이 먼저 주인을 알아보고 모여든다.",
    color: "#69c7b5",
    icon: 19,
    tags: ["수집", "범위"],
  },
];

// The first 20 definitions are the shipped atlas set and must remain pixel-for-
// pixel compatible with saved icon indices. Only the 30 later additions opt in
// to individual authored icons; the atlas remains their load-failure fallback.
const LEGACY_AUGMENT_ICON_COUNT = 20;
const AUGMENTS: Augment[] = AUGMENT_DEFINITIONS.map((augment, index) =>
  index < LEGACY_AUGMENT_ICON_COUNT
    ? augment
    : { ...augment, iconAsset: augmentIconAssetPath(augment.id) },
);

const SYNERGIES = [
  { name: "대화재", needs: ["ember", "oil"], color: "#ef6549" },
  { name: "열충격", needs: ["ember", "frost"], color: "#d7a56a" },
  { name: "역병 폭풍", needs: ["poison", "storm"], color: "#9cbf75" },
  { name: "귀환 성좌", needs: ["split", "pierce", "return"], color: "#d8d0b8" },
  { name: "핏빛 번데기", needs: ["blood", "predator", "glass"], color: "#d04743" },
  { name: "월식 기관", needs: ["haste", "orbit", "time"], color: "#b79ce5" },
  { name: "혜성 자국", needs: ["boots", "void", "frost"], color: "#8fc7da" },
  { name: "참수자의 눈", needs: ["fang", "eye"], color: "#d8c37b" },
  { name: "유도 성좌", needs: ["focus", "homing", "pierce"], color: "#81c8d5" },
  { name: "백골 메아리", needs: ["shrapnel", "ricochet"], color: "#ddd4b9" },
  { name: "마지막 문장", needs: ["execution", "giantbane", "eye"], color: "#e06a5c" },
  { name: "혈침 순환", needs: ["leech", "blood", "predator"], color: "#c94f58" },
  { name: "철의 성소", needs: ["armor", "ward", "bulwark"], color: "#aeb5b4" },
  { name: "달빛 봉화", needs: ["regeneration", "conquest", "map"], color: "#e0a85e" },
  { name: "질풍 박동", needs: ["momentum", "reflex", "frenzy"], color: "#d3b867" },
  { name: "기억 채굴자", needs: ["scholar", "scavenger", "magnet"], color: "#67c4aa" },
  { name: "별철 과부하", needs: ["caliber", "overcharge", "ember"], color: "#ec6459" },
];

const ROOM_NAMES: Record<RoomKind, string> = {
  battle: "잿빛 회랑",
  horde: "메마른 자들의 뜰",
  elite: "붉은 봉인의 방",
  memory: "흐릿한 기억",
  shelter: "마지막 쉼표",
  boss: "지도의 심장",
};

const ROOM_COLOR_GRADE: Record<
  RoomKind,
  { tint: string; mote: string }
> = {
  battle: { tint: "#8b775f", mote: "#c6aa78" },
  horde: { tint: "#74684c", mote: "#c7b47a" },
  elite: { tint: "#7e2527", mote: "#da7764" },
  memory: { tint: "#506b83", mote: "#9fd3dc" },
  shelter: { tint: "#9a6636", mote: "#f0c477" },
  boss: { tint: "#6f3035", mote: "#d8c7a2" },
};

const ENEMY_NAMES = [
  "메마른 자",
  "실꿰미",
  "껍질 문지기",
  "울음 둥지",
  "복사 마녀",
  "백지의 지도사",
  "붉은 교정자",
  "시간의 추적자",
  "여백 절단사",
  "종언의 제본사",
  "침묵의 사서",
  "덧쓴 기록관",
];

const spriteCrops = [
  [0, 0, 384, 512],
  [384, 0, 384, 512],
  [768, 0, 384, 512],
  [1152, 0, 384, 512],
  [0, 512, 384, 512],
  [384, 512, 384, 512],
  [768, 420, 768, 604],
] as const;

const WALK_IMAGE_KEYS = [
  "walkWithered",
  "walkThreader",
  "walkGuardian",
  "walkNest",
  "walkWitch",
  "walkBoss",
  "walkProofreader",
  "walkTimeStalker",
  "walkMarginSeverer",
  "walkFinalBinder",
  "walkSilentLibrarian",
  "walkPalimpsestArchivist",
] as const;
type DirectionFrame = { row: number; flipX?: boolean };
const makeDirectionFrames = (
  rows: readonly number[],
  flips: readonly boolean[] = [],
): readonly DirectionFrame[] =>
  rows.map((row, index) => ({ row, flipX: flips[index] ?? false }));
const TIME_STALKER_DIRECTION_FRAMES = makeDirectionFrames([0, 1, 2, 3, 4, 5, 6, 7]);
const MARGIN_SEVERER_DIRECTION_FRAMES = makeDirectionFrames(
  [0, 1, 2, 3, 4, 5, 6, 1],
  [false, false, false, false, false, false, false, true],
);

// Each generated enemy sheet has its own authored row order. Missing left-facing
// poses are synthesized from the matching right-facing pose instead of showing
// an enemy walking backwards.
const ENEMY_DIRECTION_FRAMES: readonly (readonly DirectionFrame[])[] = [
  makeDirectionFrames([0, 1, 6, 5, 4, 3, 2, 1], [false, true]),
  makeDirectionFrames([0, 1, 6, 3, 4, 5, 2, 1], [false, true]),
  makeDirectionFrames([0, 1, 2, 5, 4, 3, 2, 1], [false, true, true]),
  makeDirectionFrames([0, 7, 6, 5, 4, 3, 2, 1]),
  makeDirectionFrames([0, 1, 2, 3, 4, 5, 6, 7]),
  makeDirectionFrames([0, 1, 2, 5, 3, 5, 4, 7], [false, false, false, true]),
  makeDirectionFrames([0, 1, 2, 3, 4, 5, 6, 7]),
  // The Time Stalker sheet authors every facing; never synthesize one by mirroring.
  TIME_STALKER_DIRECTION_FRAMES,
  // The generated sheet supplies S through E; SE is the exact horizontal
  // counterpart of its authored SW pose, so only that final diagonal is mirrored.
  MARGIN_SEVERER_DIRECTION_FRAMES,
  // The generated boss sheet authors all eight rows after synthesizing SE from
  // the exact horizontal mirror of SW while preserving animation-frame order.
  makeDirectionFrames([0, 1, 2, 3, 4, 5, 6, 7]),
  // The Silent Librarian atlas is normalized to the runtime's canonical order:
  // S, SW, W, NW, N, NE, E, SE. No runtime mirroring is needed.
  makeDirectionFrames([0, 1, 2, 3, 4, 5, 6, 7]),
  // The Palimpsest Archivist owns all eight canonical facing rows.
  makeDirectionFrames([0, 1, 2, 3, 4, 5, 6, 7]),
];
const DIRECTION_NAMES = ["남", "남서", "서", "북서", "북", "북동", "동", "남동"];
const ROOM_DIRECTIONS = [
  [0, -1],
  [1, 0],
  [0, 1],
  [-1, 0],
] as const;

const keyOf = (x: number, y: number) => `${x},${y}`;
const rankOf = (player: Player, id: string) =>
  clampAugmentStack(player.augments[id]);
const powerRankOf = (player: Player, id: string) =>
  effectiveAugmentRank(player.augments, player.profession, id);
const xpThreshold = experienceRequiredForLevel;
const distance = (ax: number, ay: number, bx: number, by: number) =>
  Math.hypot(ax - bx, ay - by);
const distanceToSegment = (
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
) => {
  const segmentX = bx - ax;
  const segmentY = by - ay;
  const segmentLengthSquared = segmentX * segmentX + segmentY * segmentY;
  if (segmentLengthSquared <= 0.0001) return distance(px, py, ax, ay);
  const projection = clamp(
    ((px - ax) * segmentX + (py - ay) * segmentY) / segmentLengthSquared,
    0,
    1,
  );
  return distance(px, py, ax + segmentX * projection, ay + segmentY * projection);
};
const clamp = (value: number, min: number, max: number) =>
  Math.max(min, Math.min(max, value));
const colorWithAlpha = (color: string, alpha: number) => {
  const normalized = color.startsWith("#") ? color.slice(1) : color;
  if (!/^[0-9a-f]{6}$/i.test(normalized)) return color;
  const value = Number.parseInt(normalized, 16);
  return `rgba(${(value >> 16) & 255},${(value >> 8) & 255},${value & 255},${clamp(alpha, 0, 1)})`;
};
const positiveModulo = (value: number, divisor: number) =>
  ((value % divisor) + divisor) % divisor;
const formatSavedAt = (timestamp: number) => {
  try {
    return new Intl.DateTimeFormat("ko-KR", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }).format(timestamp);
  } catch {
    return "저장 시각 미상";
  }
};

const cloneGearItem = (item: GearItem): GearItem => ({
  ...item,
  affixes: item.affixes.map((affix) => ({ ...affix })),
});

const cloneEquipment = (equipment: EquipmentLoadout): EquipmentLoadout =>
  Object.fromEntries(
    EQUIPMENT_SLOTS.map((slot) => [
      slot,
      equipment[slot] ? cloneGearItem(equipment[slot]) : null,
    ]),
  ) as EquipmentLoadout;

const gearRarityClass = (item: GearItem) => `gear-rarity-${item.rarity}`;

const hasLegendaryPower = (player: Player, powerId: keyof typeof LEGENDARY_POWERS) =>
  EQUIPMENT_SLOTS.some(
    (slot) => player.equipment[slot]?.legendaryPowerId === powerId,
  );

const LEGENDARY_RUNTIME = {
  mirrorHits: LEGENDARY_POWERS.mirrorAegis.parameters.everyHits,
  mirrorBarrierSeconds:
    LEGENDARY_POWERS.mirrorAegis.parameters.barrierDurationSeconds,
  mirrorDamageMultiplier: LEGENDARY_POWERS.mirrorAegis.parameters.damageMultiplier,
  starfallSeconds: LEGENDARY_POWERS.starfallMantle.parameters.durationSeconds,
  starfallDamageMultiplier:
    1 + LEGENDARY_POWERS.starfallMantle.parameters.damagePercent / 100,
  starfallIncomingMultiplier:
    1 - LEGENDARY_POWERS.starfallMantle.parameters.damageReductionPercent / 100,
  bloodwovenCriticalHits:
    LEGENDARY_POWERS.bloodwovenGrip.parameters.everyCriticalHits,
  bloodwovenProjectileCount:
    LEGENDARY_POWERS.bloodwovenGrip.parameters.projectileCount,
  bloodwovenDamageMultiplier:
    LEGENDARY_POWERS.bloodwovenGrip.parameters.damageMultiplier,
  ashboundPickups: LEGENDARY_POWERS.ashboundGirdle.parameters.everyPickups,
  ashboundShieldRatio:
    LEGENDARY_POWERS.ashboundGirdle.parameters.shieldMaxHpRatio,
  ashboundSeconds: LEGENDARY_POWERS.ashboundGirdle.parameters.durationSeconds,
  phantomActivationSeconds:
    LEGENDARY_POWERS.phantomMarch.parameters.activationSeconds,
  phantomMoveMultiplier:
    1 + LEGENDARY_POWERS.phantomMarch.parameters.moveSpeedPercent / 100,
  phantomTrailDamageMultiplier:
    LEGENDARY_POWERS.phantomMarch.parameters.trailDamageMultiplier,
} as const;

const legendaryAttackMultiplier = (player: Player) =>
  hasLegendaryPower(player, "starfallMantle") && player.starfallMantleTime > 0
    ? LEGENDARY_RUNTIME.starfallDamageMultiplier
    : 1;

const clearAshboundShield = (player: Player) => {
  const next = removeTrackedShield(player.shield, player.ashboundShieldRemaining);
  player.shield = next.shield;
  player.ashboundShieldRemaining = next.trackedShield;
  player.ashboundShieldTime = 0;
};

const reconcileLegendaryRuntime = (player: Player) => {
  if (!hasLegendaryPower(player, "mirrorAegis")) {
    player.mirrorAegisHitCount = 0;
    player.mirrorAegisBarrierTime = 0;
  }
  if (!hasLegendaryPower(player, "starfallMantle")) player.starfallMantleTime = 0;
  if (!hasLegendaryPower(player, "bloodwovenGrip")) {
    player.bloodwovenCriticalHits = 0;
    player.bloodwovenBurstReady = false;
    player.bloodwovenLastCountedVolley = -1;
  }
  if (!hasLegendaryPower(player, "ashboundGirdle")) {
    clearAshboundShield(player);
    player.ashboundPickupCount = 0;
  }
  if (!hasLegendaryPower(player, "phantomMarch")) {
    player.phantomMarchMoveTime = 0;
    player.phantomMarchTrailCooldown = 0;
  }
};

function directionRow(dx: number, dy: number, fallback = 0) {
  if (Math.hypot(dx, dy) < 0.001) return fallback;
  const sector = positiveModulo(Math.round(Math.atan2(dy, dx) / (Math.PI / 4)), 8);
  return [6, 7, 0, 1, 2, 3, 4, 5][sector];
}
function hash(seed: number, x: number, y: number, salt = 0) {
  let n =
    (seed ^ Math.imul(x + 1013, 374761393) ^ Math.imul(y - 977, 668265263) ^ salt) |
    0;
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967295;
}

function makePlayer(): Player {
  return {
    x: WIDTH / 2,
    y: HEIGHT / 2,
    radius: 20,
    hp: 100,
    maxHp: 100,
    shield: 0,
    xp: 0,
    nextXp: xpThreshold(1),
    level: 1,
    rooms: 0,
    bossesCleared: 0,
    kills: 0,
    expeditionPowerRating: 1_000,
    augments: {},
    fireCooldown: 0,
    invulnerable: 0,
    dashCooldown: 0,
    dashTime: 0,
    dashX: 0,
    dashY: 0,
    shotCounter: 0,
    endingSeen: false,
    endingVersion: 0,
    profession: null,
    facing: 6,
    walkCycle: CHARACTER_IDLE_FRAME,
    moving: false,
    equipment: createEmptyEquipment(),
    inventory: [],
    autoSalvageMaxRarity: null,
    memoryAsh: 0,
    memoryPickupCounter: 0,
    legendaryArmorReady: true,
    riftTrailCooldown: 0,
    mirrorAegisHitCount: 0,
    mirrorAegisBarrierTime: 0,
    starfallMantleTime: 0,
    bloodwovenCriticalHits: 0,
    bloodwovenBurstReady: false,
    bloodwovenLastCountedVolley: -1,
    ashboundPickupCount: 0,
    ashboundShieldRemaining: 0,
    ashboundShieldTime: 0,
    phantomMarchMoveTime: 0,
    phantomMarchTrailCooldown: 0,
  };
}

function normalizeLegendaryRuntimeFromSave(
  saved: Partial<Player>,
): Pick<
  Player,
  | "mirrorAegisHitCount"
  | "mirrorAegisBarrierTime"
  | "starfallMantleTime"
  | "bloodwovenCriticalHits"
  | "bloodwovenBurstReady"
  | "bloodwovenLastCountedVolley"
  | "ashboundPickupCount"
  | "ashboundShieldRemaining"
  | "ashboundShieldTime"
  | "phantomMarchMoveTime"
  | "phantomMarchTrailCooldown"
> {
  const normalizedCounter = (value: number | undefined, threshold: number) =>
    Number.isFinite(value)
      ? clamp(Math.floor(value ?? 0), 0, Math.max(0, threshold - 1))
      : 0;
  return {
    mirrorAegisHitCount: normalizedCounter(
      saved.mirrorAegisHitCount,
      LEGENDARY_RUNTIME.mirrorHits,
    ),
    mirrorAegisBarrierTime: 0,
    starfallMantleTime: 0,
    bloodwovenCriticalHits: normalizedCounter(
      saved.bloodwovenCriticalHits,
      LEGENDARY_RUNTIME.bloodwovenCriticalHits,
    ),
    bloodwovenBurstReady: saved.bloodwovenBurstReady === true,
    bloodwovenLastCountedVolley: -1,
    ashboundPickupCount: normalizedCounter(
      saved.ashboundPickupCount,
      LEGENDARY_RUNTIME.ashboundPickups,
    ),
    ashboundShieldRemaining: 0,
    ashboundShieldTime: 0,
    phantomMarchMoveTime: 0,
    phantomMarchTrailCooldown: 0,
  };
}

function makeWorld(seed: number, dungeonFloor = 1): World {
  const normalizedFloor = normalizeDungeonFloor(dungeonFloor);
  return {
    seed,
    layoutVersion: DUNGEON_LAYOUT_VERSION,
    dungeonFloor: normalizedFloor,
    roomX: DUNGEON_CENTER_COORDINATE,
    roomY: DUNGEON_CENTER_COORDINATE,
    roomKind: "battle",
    roomCleared: false,
    rooms: {},
    visited: [],
    visitedLookup: {},
    stairRoomLookup: createDownStairRoomLookup(seed, normalizedFloor),
    knownRoomCount: 0,
    clearedRoomCount: 0,
    enemies: [],
    projectiles: [],
    orbs: [],
    gearDrops: [],
    doorEffects: [],
    effects: [],
    effectCounts: { summon: 0, teleport: 0 },
    transition: 0,
    doorMotion: createClosedRoomDoorMotion(),
    clearHandled: false,
    activeBossKind: null,
    expeditionDifficulty: { ...BASE_EXPEDITION_DIFFICULTY },
  };
}

function augmentTier(player: Player, ids: string[]) {
  const total = ids.reduce((sum, id) => sum + rankOf(player, id), 0);
  return 1 + Math.floor(Math.max(0, total - ids.length) / 5);
}

function activeSynergies(player: Player) {
  return SYNERGIES.filter((synergy) =>
    synergy.needs.every((id) => rankOf(player, id) > 0),
  ).map((synergy) => ({
    ...synergy,
    tier: augmentTier(player, synergy.needs),
  }));
}

function calculatePlayerStatsForRuntime(player: Player) {
  return calculatePlayerStatSnapshot({
    level: player.level,
    hp: player.hp,
    maxHp: player.maxHp,
    shield: player.shield,
    shotCounter: player.shotCounter,
    augments: player.augments,
    profession: player.profession,
    equipment: player.equipment,
    synergies: activeSynergies(player),
    legendaryArmorReady: player.legendaryArmorReady,
    mirrorAegisHitCount: player.mirrorAegisHitCount,
    mirrorAegisBarrierTime: player.mirrorAegisBarrierTime,
    starfallMantleTime: player.starfallMantleTime,
    bloodwovenCriticalHits: player.bloodwovenCriticalHits,
    bloodwovenBurstReady: player.bloodwovenBurstReady,
    ashboundPickupCount: player.ashboundPickupCount,
    ashboundShieldRemaining: player.ashboundShieldRemaining,
    ashboundShieldTime: player.ashboundShieldTime,
    phantomMarchMoveTime: player.phantomMarchMoveTime,
  });
}

/**
 * One target-aware resolver for every player-owned damage source. Keeping
 * elite, boss, and execution multipliers here prevents basic projectiles from
 * receiving bonuses that poison, orbitals, dashes, and legendary effects do
 * not receive.
 */
function applyPlayerDamage(
  player: Player,
  enemy: Enemy,
  rawDamage: number,
  equipmentStats: GearStatTotals,
) {
  let multiplier = 1;
  const boss = isBossKind(enemy.kind);
  if (enemy.elite || boss) {
    multiplier *= Math.pow(1 + powerRankOf(player, "giantbane") * 0.15, 0.65);
    multiplier *= 1 + equipmentStats.eliteDamagePercent / 100;
    if (hasLegendaryPower(player, "hunterSigil")) {
      multiplier *=
        1 + LEGENDARY_POWERS.hunterSigil.parameters.eliteDamagePercent / 100;
      player.hunterSigilPulseCooldown = 0.18;
    }
  }
  if (boss) multiplier *= 1 + equipmentStats.bossDamagePercent / 100;

  const executionRank = powerRankOf(player, "execution");
  const gearExecutionPercent = Math.max(0, equipmentStats.executeDamagePercent);
  const executionThreshold =
    executionRank > 0
      ? Math.min(0.4, 0.12 + executionRank * 0.012)
      : gearExecutionPercent > 0
        ? 0.2
        : 0;
  if (
    executionThreshold > 0 &&
    enemy.maxHp > 0 &&
    enemy.hp / enemy.maxHp <= executionThreshold
  ) {
    if (executionRank > 0) {
      const finalSentence = activeSynergies(player).find(
        (synergy) => synergy.name === "마지막 문장",
      );
      multiplier *=
        (1.28 + executionRank * 0.04) *
        (1 + (finalSentence?.tier ?? 0) * 0.12);
    }
    multiplier *= 1 + gearExecutionPercent / 100;
  }

  const dealt = Math.max(0, Number.isFinite(rawDamage) ? rawDamage : 0) * multiplier;
  const finalDealt =
    dealt * (1 + Math.max(0, equipmentStats.cosmicFinalDamagePercent) / 100);
  enemy.hp -= finalDealt;
  return finalDealt;
}

function AugmentIcon({
  icon,
  iconAsset,
  size = 76,
}: {
  icon: number;
  iconAsset?: string;
  size?: number;
}) {
  const atlasIcon = (
    <span
      className="augment-icon"
      style={{
        width: size,
        height: size,
        backgroundSize: `${size * 5}px ${size * 4}px`,
        backgroundPosition: `${-(icon % 5) * size}px ${-Math.floor(icon / 5) * size}px`,
      }}
      aria-hidden="true"
    />
  );
  if (iconAsset) {
    return (
      <span className="augment-icon-asset-wrap" style={{ width: size, height: size }}>
        {atlasIcon}
        {/* eslint-disable-next-line @next/next/no-img-element -- asset failure must reveal the atlas fallback beneath */}
        <img
          className="augment-icon-asset"
          src={iconAsset}
          width={size}
          height={size}
          alt=""
          aria-hidden="true"
          onError={(event) => {
            event.currentTarget.hidden = true;
          }}
        />
      </span>
    );
  }
  return atlasIcon;
}

function GearIcon({ item, size = 64 }: { item: GearItem; size?: number }) {
  const { column, row } = gearIconCell(item.iconIndex);
  return (
    <span
      className={`gear-icon ${gearRarityClass(item)}`}
      style={{
        width: size,
        height: size,
        backgroundSize: `${size * GEAR_ICON_COLUMNS}px ${size * GEAR_ICON_ROWS}px`,
        backgroundPosition: `${-column * size}px ${-row * size}px`,
        "--gear-color": GEAR_RARITY_META[item.rarity].color,
      } as CSSProperties}
      aria-hidden="true"
    />
  );
}

function MapGrid({
  world,
  radius = 3,
  large = false,
  teleportUnlocked = false,
  teleportDepartureSafe = false,
  onTeleport,
}: {
  world: CartographyWorld;
  radius?: number;
  large?: boolean;
  teleportUnlocked?: boolean;
  teleportDepartureSafe?: boolean;
  onTeleport?: (x: number, y: number) => void;
}) {
  const visited = new Set(world.visited);
  const currentKey = keyOf(world.roomX, world.roomY);
  const knownCoordinates = Object.keys(world.rooms)
    .map((key) => {
      const coordinate = parseDungeonCoordinateKey(key);
      return coordinate ? { key, ...coordinate } : null;
    })
    .filter((coordinate): coordinate is { key: string; x: number; y: number } =>
      Boolean(coordinate),
    );

  if (!knownCoordinates.some(({ key }) => key === currentKey)) {
    knownCoordinates.push({ key: currentKey, x: world.roomX, y: world.roomY });
  }

  const minimumX = large
    ? DUNGEON_MIN_COORDINATE
    : Math.max(DUNGEON_MIN_COORDINATE, world.roomX - radius);
  const maximumX = large
    ? DUNGEON_MAX_COORDINATE
    : Math.min(DUNGEON_MAX_COORDINATE, world.roomX + radius);
  const minimumY = large
    ? DUNGEON_MIN_COORDINATE
    : Math.max(DUNGEON_MIN_COORDINATE, world.roomY - radius);
  const maximumY = large
    ? DUNGEON_MAX_COORDINATE
    : Math.min(DUNGEON_MAX_COORDINATE, world.roomY + radius);
  const columns = maximumX - minimumX + 1;
  const rows = maximumY - minimumY + 1;

  const makeCell = (x: number, y: number) => {
    const key = keyOf(x, y);
    const room = world.rooms[key];
    const wasVisited = visited.has(key);
    const current = x === world.roomX && y === world.roomY;
    const stairsRevealed =
      wasVisited && Boolean(room?.cleared) && world.stairRoomLookup[key] === true;
    const status = room?.cleared ? "정복 완료" : wasVisited ? "탐사 중" : "정찰됨";
    const teleportStatus = getMapTeleportStatus({
      hasEntitlement: teleportUnlocked,
      departureSafe: teleportDepartureSafe,
      current,
      known: Boolean(room),
      visited: wasVisited,
      cleared: Boolean(room?.cleared),
    });
    const teleportLabel = MAP_TELEPORT_STATUS_LABELS[teleportStatus];
    const className = [
      "map-cell",
      room ? "is-known" : "",
      room ? `is-${room.kind}` : "",
      wasVisited ? "is-visited" : "",
      room?.cleared ? "is-cleared" : "",
      stairsRevealed ? "is-stairs" : "",
      current ? "is-current" : "",
      large && teleportStatus === "available" ? "is-teleportable" : "",
      large && teleportStatus !== "available" ? "is-teleport-locked" : "",
    ]
      .filter(Boolean)
      .join(" ");
    const cellStyle = large
      ? {
          gridColumn: x - minimumX + 1,
          gridRow: y - minimumY + 1,
        }
      : undefined;
    const floorCoordinate = `${dungeonDisplayCoordinate(x)},${dungeonDisplayCoordinate(y)}`;
    const baseTitle = room
      ? `${ROOM_NAMES[room.kind]} · ${status} · ${floorCoordinate}${stairsRevealed ? " · 하행 계단 발견" : ""}`
      : `미지의 방 · ${floorCoordinate}`;

    if (large && onTeleport) {
      return (
        <button
          type="button"
          key={key}
          data-coordinate={key}
          data-room-kind={room?.kind ?? "unknown"}
          data-cleared={Boolean(room?.cleared)}
          data-visited={wasVisited}
          data-current={current}
          data-stairs-revealed={stairsRevealed}
          data-teleport-status={teleportStatus}
          className={className}
          style={cellStyle}
          title={`${baseTitle} · ${teleportLabel}`}
          aria-label={`${baseTitle} · ${teleportLabel}`}
          disabled={teleportStatus !== "available"}
          onClick={() => onTeleport(x, y)}
        >
          {room?.kind === "boss" ? (
            <span
              className="map-room-emblem map-room-emblem--boss"
              aria-hidden="true"
            />
          ) : null}
          {stairsRevealed ? <span className="map-room-emblem map-room-emblem--stairs" aria-hidden="true" /> : null}
          {current ? <i /> : null}
        </button>
      );
    }

    return (
      <span
        key={key}
        data-coordinate={key}
        data-room-kind={room?.kind ?? "unknown"}
        data-cleared={Boolean(room?.cleared)}
        data-visited={wasVisited}
        data-current={current}
        data-stairs-revealed={stairsRevealed}
        className={className}
        style={cellStyle}
        title={baseTitle}
      >
        {room?.kind === "boss" ? (
          <span
            className="map-room-emblem map-room-emblem--boss"
            aria-hidden="true"
          />
        ) : null}
        {stairsRevealed ? <span className="map-room-emblem map-room-emblem--stairs" aria-hidden="true" /> : null}
        {current ? <i /> : null}
      </span>
    );
  };

  const cells = large
    ? knownCoordinates.map(({ x, y }) => makeCell(x, y))
    : Array.from({ length: rows * columns }, (_, index) => {
        const x = minimumX + (index % columns);
        const y = minimumY + Math.floor(index / columns);
        return makeCell(x, y);
      });

  return (
    <div
      className={`minimap-grid ${large ? "is-large" : ""}`}
      data-map-min-x={minimumX}
      data-map-max-x={maximumX}
      data-map-min-y={minimumY}
      data-map-max-y={maximumY}
      data-map-columns={columns}
      data-map-rows={rows}
      style={{
        "--map-side": radius * 2 + 1,
        "--map-columns": columns,
        "--map-rows": rows,
      } as CSSProperties}
      role={large && onTeleport ? "group" : "img"}
      aria-label={
        large
          ? `지하 ${world.dungeonFloor}층 전체 지도. 현재 위치 ${dungeonDisplayCoordinate(world.roomX)},${dungeonDisplayCoordinate(world.roomY)}, 확인한 방 ${knownCoordinates.length}개`
          : `지하 ${world.dungeonFloor}층 주변 지도. 현재 위치 ${dungeonDisplayCoordinate(world.roomX)},${dungeonDisplayCoordinate(world.roomY)}`
      }
    >
      {cells}
    </div>
  );
}

type GameCanvasProps = {
  initialSaveSlot?: SaveSlotId;
  onReturnToPlaza?: () => void;
};

export default function GameCanvas({
  initialSaveSlot,
  onReturnToPlaza,
}: GameCanvasProps = {}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const mapBoardRef = useRef<HTMLDivElement | null>(null);
  const playerRef = useRef<Player>(makePlayer());
  const worldRef = useRef<World>(makeWorld(1));
  const stableAugmentsRef = useRef<Record<string, number>>({});
  const checkpointRef = useRef<{
    dungeonFloor: number;
    x: number;
    y: number;
  } | null>(null);
  const activeSaveSlotRef = useRef<SaveSlotId>(1);
  const idRef = useRef(1);
  const keysRef = useRef(new Set<string>());
  const inputRef = useRef({
    aimX: WIDTH / 2,
    aimY: HEIGHT / 2,
    lastAim: 0,
    dashQueued: false,
    moveTargetX: WIDTH / 2,
    moveTargetY: HEIGHT / 2,
    hasMoveTarget: false,
  });
  const imagesRef = useRef<Record<string, HTMLImageElement>>({});
  const decodedStairRoomArtRef = useRef(new Set<RoomStairArtKey>());
  const stairRoomArtRetryRef = useRef<
    Partial<Record<RoomStairArtKey, { attempts: number; retryAt: number }>>
  >({});
  const stairRoomArtLastUsedRef = useRef(new Map<RoomStairArtKey, number>());
  const paperdollImagesRef = useRef(createBrowserPaperdollImageStore());
  const equipmentRuntimeCacheRef = useRef<{
    equipment: EquipmentLoadout | null;
    equipmentItems: readonly (GearItem | null)[];
    signature: string;
    stats: GearStatTotals;
    loadout: ReturnType<typeof paperdollLoadoutFromEquipment>;
  }>({
    equipment: null,
    equipmentItems: [],
    signature: "",
    stats: EMPTY_EQUIPMENT_RUNTIME_STATS,
    loadout: {},
  });
  const hudGearSnapshotRef = useRef<{
    equipment: EquipmentLoadout | null;
    inventory: GearItem[] | null;
    equipmentItems: readonly (GearItem | null)[];
    inventoryItems: readonly GearItem[];
    equipmentSnapshot: EquipmentLoadout;
    inventorySnapshot: GearItem[];
  }>({
    equipment: null,
    inventory: null,
    equipmentItems: [],
    inventoryItems: [],
    equipmentSnapshot: createEmptyEquipment(),
    inventorySnapshot: [],
  });
  const equippedRarityVfxPlanRef = useRef<{
    signature: string;
    plan: ReturnType<typeof resolveEquippedRarityVfxPlan>;
  }>({ signature: "", plan: resolveEquippedRarityVfxPlan({}) });
  const modeRef = useRef<GameMode>("menu");
  const storyActionRef = useRef<() => void>(() => undefined);
  const lastHudUpdateRef = useRef(0);
  const roomEnterRef = useRef<
    (
      x: number,
      y: number,
      entry?: "left" | "right" | "top" | "bottom" | "center",
    ) => void
  >(() => undefined);
  const pendingStoryRef = useRef<{
    eyebrow: string;
    title: string;
    body: string;
  } | null>(null);
  const pendingEndingRef = useRef(false);
  const professionResumeRef = useRef<() => void>(() => undefined);
  const professionCeremonyActiveRef = useRef(false);
  const professionCeremonyDialogRef = useRef<HTMLDivElement | null>(null);
  const buildOpenRef = useRef(false);
  const inventoryOpenRef = useRef(false);
  const statsOpenRef = useRef(false);
  const shopOpenRef = useRef(false);
  const shopReturnInventoryRef = useRef(false);
  const inventoryCapacityRef = useRef(BASE_INVENTORY_CAPACITY);
  const gameConfirmationOpenRef = useRef(false);
  const gameConfirmationActionRef = useRef<() => void>(() => undefined);
  const inventoryFullToastRef = useRef(0);
  const lootVfxShowcaseSpawnedRef = useRef(false);
  const initialSaveSlotHandledRef = useRef(false);
  const firstRoomGearDroppedRef = useRef(false);

  const getEquipmentRuntimeCache = useCallback((equipment: EquipmentLoadout) => {
    const cached = equipmentRuntimeCacheRef.current;
    if (cached.equipment === equipment) {
      let unchanged = cached.equipmentItems.length === EQUIPMENT_SLOTS.length;
      for (let index = 0; unchanged && index < EQUIPMENT_SLOTS.length; index += 1) {
        unchanged =
          cached.equipmentItems[index] === equipment[EQUIPMENT_SLOTS[index]];
      }
      if (unchanged) return cached;
    }
    const equipmentItems = EQUIPMENT_SLOTS.map((slot) => equipment[slot]);
    const loadout = paperdollLoadoutFromEquipment(equipment);
    const next = {
      equipment,
      equipmentItems,
      signature: createPaperdollGearSignature(loadout),
      stats: aggregateEquipmentStats(equipment),
      loadout,
    };
    equipmentRuntimeCacheRef.current = next;
    return next;
  }, []);

  const [mode, setMode] = useState<GameMode>("menu");
  const [started, setStarted] = useState(false);
  const [activeSaveSlot, setActiveSaveSlot] = useState<SaveSlotId>(1);
  const [saveSlots, setSaveSlots] = useState<Array<SaveSlotSummary | null>>(() =>
    SAVE_SLOT_IDS.map(() => null),
  );
  const [choices, setChoices] = useState<Augment[]>([]);
  const [professionCandidate, setProfessionCandidate] = useState<Augment | null>(null);
  const [professionCeremony, setProfessionCeremony] =
    useState<ProfessionCeremony | null>(null);
  const [professionCeremonyReady, setProfessionCeremonyReady] = useState(false);
  const [story, setStory] = useState({
    eyebrow: "서장",
    title: "끝을 찾는 자",
    body: "하린은 사라진 동생 라온의 목소리를 따라, 끝이 없다는 지도 안으로 발을 내디뎠다.",
  });
  const [endingChapterIndex, setEndingChapterIndex] = useState(0);
  const [toast, setToast] = useState("WASD로 움직이세요. 공격은 자동입니다.");
  const [buildOpen, setBuildOpen] = useState(false);
  const [buildTab, setBuildTab] = useState<"build" | "gear">("build");
  const [inventoryOpen, setInventoryOpen] = useState(false);
  const [statsOpen, setStatsOpen] = useState(false);
  const [shopOpen, setShopOpen] = useState(false);
  const [shopEntitlements, setShopEntitlements] = useState<ShopEntitlements>(() =>
    readShopEntitlements(null),
  );
  const [shopMode, setShopMode] = useState<ShopCheckoutMode>("unconfigured");
  const [lastShopReceipt, setLastShopReceipt] = useState<ShopReceipt | null>(null);
  const [shopNotice, setShopNotice] = useState<{
    tone: "info" | "success" | "error";
    message: string;
  } | null>(null);
  const [shopPreferredProductId, setShopPreferredProductId] =
    useState<ShopProductId | null>(null);
  const [selectedGearId, setSelectedGearId] = useState<string | null>(null);
  const [menuStage, setMenuStage] = useState<"landing" | "archive">("landing");
  const [lootNotice, setLootNotice] = useState<GearItem | null>(null);
  const [gameConfirmation, setGameConfirmation] = useState<GameConfirmation | null>(null);
  const [hud, setHud] = useState(() => ({
    player: { ...makePlayer(), augments: {} as Record<string, number> },
    stableAugments: {} as Record<string, number>,
    world: {
      seed: 1,
      dungeonFloor: 1,
      roomX: DUNGEON_CENTER_COORDINATE,
      roomY: DUNGEON_CENTER_COORDINATE,
      roomKind: "battle" as RoomKind,
      roomCleared: false,
      rooms: {} as Record<string, RoomRecord>,
      visited: [] as string[],
      stairRoomLookup: {} as Record<string, true>,
      knownRoomCount: 0,
      visitedCount: 0,
      clearedRoomCount: 0,
      enemies: 0,
      bossHp: 0,
      bossMaxHp: 0,
      bossKind: null as BossKind | null,
      bossPattern: null as BlankCartographerPattern | null,
      bossPhase: null as Enemy["bossPhase"] | null,
      binderPattern: null as FinalBinderPattern | null,
      binderPhase: null as FinalBinderPhase | null,
      archivistPattern: null as PalimpsestArchivistPattern | null,
      archivistPhase: null as PalimpsestArchivistPhase | null,
      activeEffects: 0,
      playerProjectiles: 0,
      hostileProjectiles: 0,
      combatEffects: 0,
      summonEffects: 0,
      teleportEffects: 0,
      gearDrops: 0,
      proofreaderEnemies: 0,
      proofreaderWindups: 0,
      staircaseRevealed: false,
      staircaseNearby: false,
    },
  }));
  const paperdollEquipmentSignature = useMemo(
    () => createPaperdollEquipmentSignature(hud.player.equipment),
    [hud.player.equipment],
  );
  const [mapSnapshot, setMapSnapshot] = useState<CartographyWorld>(() => ({
    seed: 1,
    dungeonFloor: 1,
    roomX: DUNGEON_CENTER_COORDINATE,
    roomY: DUNGEON_CENTER_COORDINATE,
    rooms: {},
    visited: [],
    stairRoomLookup: {},
  }));
  const [mapTeleportDepartureSafe, setMapTeleportDepartureSafe] = useState(false);
  const inventoryCapacity = useMemo(
    () => inventoryCapacityFor(shopEntitlements),
    [shopEntitlements],
  );
  const mapTeleportUnlocked = useMemo(
    () => hasMapTeleportEntitlement(shopEntitlements),
    [shopEntitlements],
  );

  const setGameMode = useCallback((next: GameMode) => {
    modeRef.current = next;
    setMode(next);
  }, []);

  const setBuildPanelOpen = useCallback((next: boolean) => {
    buildOpenRef.current = next;
    if (next) {
      keysRef.current.clear();
      inputRef.current.dashQueued = false;
    }
    setBuildOpen(next);
  }, []);

  const setInventoryScreenOpen = useCallback((next: boolean) => {
    inventoryOpenRef.current = next;
    if (next) {
      keysRef.current.clear();
      inputRef.current.dashQueued = false;
      inputRef.current.hasMoveTarget = false;
    }
    setInventoryOpen(next);
  }, []);

  const setStatsScreenOpen = useCallback((next: boolean) => {
    statsOpenRef.current = next;
    if (next) {
      keysRef.current.clear();
      inputRef.current.dashQueued = false;
      inputRef.current.hasMoveTarget = false;
    }
    setStatsOpen(next);
  }, []);

  const setShopScreenOpen = useCallback((next: boolean) => {
    shopOpenRef.current = next;
    if (next) {
      keysRef.current.clear();
      inputRef.current.dashQueued = false;
      inputRef.current.hasMoveTarget = false;
    }
    setShopOpen(next);
  }, []);

  const closeGameConfirmation = useCallback(() => {
    gameConfirmationOpenRef.current = false;
    gameConfirmationActionRef.current = () => undefined;
    setGameConfirmation(null);
  }, []);

  const requestGameConfirmation = useCallback(
    (confirmation: GameConfirmation, action: () => void) => {
      keysRef.current.clear();
      inputRef.current.dashQueued = false;
      inputRef.current.hasMoveTarget = false;
      gameConfirmationActionRef.current = action;
      gameConfirmationOpenRef.current = true;
      setGameConfirmation(confirmation);
    },
    [],
  );

  const acceptGameConfirmation = useCallback(() => {
    const action = gameConfirmationActionRef.current;
    gameConfirmationOpenRef.current = false;
    gameConfirmationActionRef.current = () => undefined;
    setGameConfirmation(null);
    action();
  }, []);

  const isSimulationRunning = useCallback(
    () =>
      modeRef.current === "playing" &&
      !buildOpenRef.current &&
      !inventoryOpenRef.current &&
      !statsOpenRef.current &&
      !shopOpenRef.current &&
      !gameConfirmationOpenRef.current,
    [],
  );

  const activateSaveSlot = useCallback((slot: SaveSlotId) => {
    activeSaveSlotRef.current = slot;
    setActiveSaveSlot(slot);
    writeActiveSaveSlot(slot);
  }, []);

  const refreshSaveSlots = useCallback(() => {
    setSaveSlots(readSaveSlotSummaries());
  }, []);

  const applyShopEntitlements = useCallback((next: ShopEntitlements) => {
    inventoryCapacityRef.current = inventoryCapacityFor(next);
    setShopEntitlements(next);
    setLastShopReceipt(next.receipts.at(-1) ?? null);
  }, []);

  const restoreShopPurchases = useCallback(() => {
    const restored = readShopEntitlements();
    applyShopEntitlements(restored);
    setShopNotice({
      tone: "info",
      message:
        restored.purchasedProductIds.length > 0
          ? `이 기기의 영구 상품 ${restored.purchasedProductIds.length}개를 복구했습니다.`
          : "이 기기에 저장된 구매 기록이 없습니다.",
    });
  }, [applyShopEntitlements]);

  const purchaseShopProduct = useCallback(
    (productId: ShopProductId) => {
      if (shopMode !== "local-test") {
        setShopNotice({
          tone: "error",
          message: "결제사와 서버 영수증 검증이 연결되지 않아 구매가 차단되어 있습니다.",
        });
        return;
      }
      const result = completeLocalShopPurchase(productId);
      if (result.status === "purchased") {
        applyShopEntitlements(result.entitlements);
        if (result.product.kind === "map-teleport") {
          setShopNotice({
            tone: "success",
            message: "무진도의 길잡이 계약 완료 · 탐사도 좌표 도약이 영구 해금되었습니다.",
          });
          setToast("무진도의 길잡이 해금 · M 탐사도에서 방문 좌표를 선택하세요.");
        } else {
          const nextCapacity = inventoryCapacityFor(result.entitlements);
          setShopNotice({
            tone: "success",
            message: `${result.product.shortName} 해방 완료 · 가방이 ${nextCapacity}칸으로 확장되었습니다.`,
          });
          setToast(`가방 확장 완료 · ${nextCapacity}칸 사용 가능`);
        }
        return;
      }
      if (result.status === "already-owned") {
        applyShopEntitlements(result.entitlements);
        setShopNotice({ tone: "info", message: "이미 보유 중인 영구 상품입니다." });
        return;
      }
      if (result.status === "locked") {
        setShopNotice({
          tone: "error",
          message: "이전 봉인을 먼저 해방해야 다음 확장을 구매할 수 있습니다.",
        });
        return;
      }
      setShopNotice({
        tone: "error",
        message:
          result.status === "write-failed"
            ? "구매 기록을 안전하게 저장하지 못했습니다. 상품은 지급되지 않았습니다."
            : "존재하지 않는 상품입니다.",
      });
    },
    [applyShopEntitlements, shopMode],
  );

  const openShop = useCallback(() => {
    shopReturnInventoryRef.current = false;
    setShopPreferredProductId(null);
    setBuildPanelOpen(false);
    setInventoryScreenOpen(false);
    setStatsScreenOpen(false);
    setShopScreenOpen(true);
  }, [
    setBuildPanelOpen,
    setInventoryScreenOpen,
    setShopScreenOpen,
    setStatsScreenOpen,
  ]);

  const openShopFromInventory = useCallback(() => {
    shopReturnInventoryRef.current = true;
    setShopPreferredProductId(null);
    setInventoryScreenOpen(false);
    setStatsScreenOpen(false);
    setShopScreenOpen(true);
  }, [setInventoryScreenOpen, setShopScreenOpen, setStatsScreenOpen]);

  const openWayfinderShop = useCallback(() => {
    shopReturnInventoryRef.current = false;
    setBuildPanelOpen(false);
    setInventoryScreenOpen(false);
    setStatsScreenOpen(false);
    setShopPreferredProductId(MAP_TELEPORT_PRODUCT_ID);
    setShopScreenOpen(true);
  }, [
    setBuildPanelOpen,
    setInventoryScreenOpen,
    setShopScreenOpen,
    setStatsScreenOpen,
  ]);

  const closeShop = useCallback(() => {
    const shouldReturnToInventory =
      shopReturnInventoryRef.current && modeRef.current === "playing";
    shopReturnInventoryRef.current = false;
    setShopPreferredProductId(null);
    setShopScreenOpen(false);
    if (shouldReturnToInventory) setInventoryScreenOpen(true);
  }, [setInventoryScreenOpen, setShopScreenOpen]);

  const syncHud = useCallback(() => {
    const player = playerRef.current;
    const world = worldRef.current;
    const gearSnapshotCache = hudGearSnapshotRef.current;
    let equipmentChanged = gearSnapshotCache.equipment !== player.equipment;
    for (
      let index = 0;
      !equipmentChanged && index < EQUIPMENT_SLOTS.length;
      index += 1
    ) {
      equipmentChanged =
        gearSnapshotCache.equipmentItems[index] !==
        player.equipment[EQUIPMENT_SLOTS[index]];
    }
    if (equipmentChanged) {
      const currentEquipmentItems = EQUIPMENT_SLOTS.map(
        (slot) => player.equipment[slot],
      );
      gearSnapshotCache.equipment = player.equipment;
      gearSnapshotCache.equipmentItems = currentEquipmentItems;
      gearSnapshotCache.equipmentSnapshot = cloneEquipment(player.equipment);
    }
    if (
      gearSnapshotCache.inventory !== player.inventory ||
      player.inventory.length !== gearSnapshotCache.inventoryItems.length ||
      !player.inventory.every(
        (item, index) => gearSnapshotCache.inventoryItems[index] === item,
      )
    ) {
      gearSnapshotCache.inventory = player.inventory;
      gearSnapshotCache.inventoryItems = [...player.inventory];
      gearSnapshotCache.inventorySnapshot = player.inventory.map(cloneGearItem);
    }
    const nearbyRooms: Record<string, RoomRecord> = {};
    const nearbyVisited: string[] = [];
    for (let y = world.roomY - 5; y <= world.roomY + 5; y += 1) {
      for (let x = world.roomX - 5; x <= world.roomX + 5; x += 1) {
        const key = keyOf(x, y);
        if (world.rooms[key]) nearbyRooms[key] = world.rooms[key];
        if (world.visitedLookup[key]) nearbyVisited.push(key);
      }
    }
    let boss: Enemy | undefined;
    let playerProjectileCount = 0;
    let hostileProjectileCount = 0;
    let proofreaderEnemyCount = 0;
    let proofreaderWindupCount = 0;
    for (const enemy of world.enemies) {
      if (!boss && isBossKind(enemy.kind)) boss = enemy;
      if (enemy.kind !== 6) continue;
      proofreaderEnemyCount += 1;
      if (enemy.patternPhase === "windup") proofreaderWindupCount += 1;
    }
    for (const projectile of world.projectiles) {
      if (projectile.hostile) hostileProjectileCount += 1;
      else playerProjectileCount += 1;
    }
    let combatEffectCount = 0;
    for (const effect of world.effects) {
      if (
        effect.kind !== "summon" &&
        effect.kind !== "teleport" &&
        effect.kind !== "lootAwakening"
      ) {
        combatEffectCount += 1;
      }
    }
    setHud({
      player: {
        ...player,
        augments: { ...player.augments },
        equipment: gearSnapshotCache.equipmentSnapshot,
        inventory: gearSnapshotCache.inventorySnapshot,
      },
      stableAugments: { ...stableAugmentsRef.current },
      world: {
        seed: world.seed,
        dungeonFloor: world.dungeonFloor,
        roomX: world.roomX,
        roomY: world.roomY,
        roomKind: world.roomKind,
        roomCleared: world.roomCleared,
        rooms: nearbyRooms,
        visited: nearbyVisited,
        stairRoomLookup: world.stairRoomLookup,
        knownRoomCount: world.knownRoomCount,
        visitedCount: world.visited.length,
        clearedRoomCount: world.clearedRoomCount,
        enemies: world.enemies.length,
        bossHp: boss?.hp ?? 0,
        bossMaxHp: boss?.maxHp ?? 0,
        bossKind: boss && isBossKind(boss.kind) ? boss.kind : null,
        bossPattern: boss?.bossPattern ?? null,
        bossPhase: boss?.bossPhase ?? null,
        binderPattern: boss?.binderPattern ?? null,
        binderPhase: boss?.binderPhase ?? null,
        archivistPattern: boss?.archivist?.pattern ?? null,
        archivistPhase: boss?.archivist?.phase ?? null,
        activeEffects: world.effects.length,
        playerProjectiles: playerProjectileCount,
        hostileProjectiles: hostileProjectileCount,
        combatEffects: combatEffectCount,
        summonEffects: world.effectCounts.summon,
        teleportEffects: world.effectCounts.teleport,
        gearDrops: world.gearDrops.length,
        proofreaderEnemies: proofreaderEnemyCount,
        proofreaderWindups: proofreaderWindupCount,
        staircaseRevealed:
          world.roomCleared &&
          world.visitedLookup[keyOf(world.roomX, world.roomY)] === true &&
          world.stairRoomLookup[keyOf(world.roomX, world.roomY)] === true,
        staircaseNearby:
          world.roomCleared &&
          world.stairRoomLookup[keyOf(world.roomX, world.roomY)] === true &&
          distance(player.x, player.y, STAIRCASE_X, STAIRCASE_Y) <=
            STAIRCASE_INTERACTION_RADIUS,
      },
    });
  }, []);

  const openStats = useCallback(() => {
    setBuildPanelOpen(false);
    setInventoryScreenOpen(false);
    setShopScreenOpen(false);
    syncHud();
    setStatsScreenOpen(true);
  }, [
    setBuildPanelOpen,
    setInventoryScreenOpen,
    setShopScreenOpen,
    setStatsScreenOpen,
    syncHud,
  ]);

  const continueAfterEnding = useCallback(() => {
    pendingEndingRef.current = false;
    playerRef.current.endingSeen = true;
    playerRef.current.endingVersion = FIRST_BOSS_ENDING_VERSION;
    markSaveSlotEndingSeen(
      activeSaveSlotRef.current,
      FIRST_BOSS_ENDING_VERSION,
    );
    setEndingChapterIndex(0);
    setToast("끝은 사라졌습니다. 최초의 문장을 지우기 위한 무한 원정이 시작됩니다.");
    setGameMode("playing");
    syncHud();
  }, [setGameMode, syncHud]);

  const openMap = useCallback(() => {
    const world = worldRef.current;
    setMapSnapshot({
      seed: world.seed,
      dungeonFloor: world.dungeonFloor,
      roomX: world.roomX,
      roomY: world.roomY,
      rooms: Object.fromEntries(
        Object.entries(world.rooms).map(([key, room]) => [key, { ...room }]),
      ),
      visited: [...world.visited],
      stairRoomLookup: { ...world.stairRoomLookup },
    });
    setMapTeleportDepartureSafe(
      isMapTeleportDepartureSafe({
        roomCleared: world.roomCleared,
        enemyCount: world.enemies.length,
        transition: world.transition,
      }),
    );
    setBuildPanelOpen(false);
    setInventoryScreenOpen(false);
    setStatsScreenOpen(false);
    setGameMode("map");
  }, [
    setBuildPanelOpen,
    setGameMode,
    setInventoryScreenOpen,
    setStatsScreenOpen,
  ]);

  const showStory = useCallback(
    (
      eyebrow: string,
      title: string,
      body: string,
      action: () => void = () => setGameMode("playing"),
    ) => {
      setStory({ eyebrow, title, body });
      storyActionRef.current = action;
      setGameMode("story");
    },
    [setGameMode],
  );

  const saveAtShelter = useCallback(() => {
    const player = playerRef.current;
    const world = worldRef.current;
    const equipmentStats = aggregateEquipmentStats(player.equipment);
    player.hp = player.maxHp;
    clearAshboundShield(player);
    player.mirrorAegisBarrierTime = 0;
    player.starfallMantleTime = 0;
    player.phantomMarchMoveTime = 0;
    player.phantomMarchTrailCooldown = 0;
    player.shield =
      10 +
      powerRankOf(player, "glass") * 9 +
      powerRankOf(player, "ward") * 5 +
      equipmentStats.roomEntryShieldFlat;
    stableAugmentsRef.current = normalizeAugmentStacks(player.augments);
    checkpointRef.current = {
      dungeonFloor: world.dungeonFloor,
      x: world.roomX,
      y: world.roomY,
    };
    const data: SaveData = {
      player: {
        ...player,
        augments: normalizeAugmentStacks(player.augments),
        equipment: cloneEquipment(player.equipment),
        inventory: player.inventory.map(cloneGearItem),
        x: WIDTH / 2,
        y: HEIGHT / 2,
      },
      world: {
        seed: world.seed,
        layoutVersion: world.layoutVersion,
        dungeonFloor: world.dungeonFloor,
        roomX: world.roomX,
        roomY: world.roomY,
        rooms: world.rooms,
        visited: world.visited,
      },
      stableAugments: stableAugmentsRef.current,
      savedAt: Date.now(),
    };
    if (writeSaveSlot(activeSaveSlotRef.current, data)) {
      playGameSfx("shelterRest");
      refreshSaveSlots();
      setToast(`${activeSaveSlotRef.current}번 슬롯 · 쉼터에 기억이 고정되었습니다.`);
    } else {
      setToast("이 기기에서 저장이 차단되었습니다. 탐험은 계속할 수 있습니다.");
    }
    syncHud();
  }, [refreshSaveSlots, syncHud]);

  const makeEnemy = useCallback(
    (kind: EnemyKind, x: number, y: number, depth: number, elite = false): Enemy => {
      const hpBases = [
        28,
        24,
        64,
        80,
        45,
        BLANK_CARTOGRAPHER_BASE_HP,
        58,
        92,
        68,
        FINAL_BINDER_BASE_HP,
        82,
        PALIMPSEST_ARCHIVIST_BASE_HP,
      ];
      const speedBases = [
        76, 50, 43, 26, 62, 38, 72, 66, 58,
        FINAL_BINDER_BASE_SPEED, 54, PALIMPSEST_ARCHIVIST_BASE_SPEED,
      ];
      const damageBases = [
        8, 10, 14, 7, 12, 16, 15, 13, 11,
        FINAL_BINDER_BASE_DAMAGE, 14, PALIMPSEST_ARCHIVIST_BASE_DAMAGE,
      ];
      const radii = [
        21, 20, 28, 32, 22, 62, 24, 26, 23,
        FINAL_BINDER_RADIUS, 25, PALIMPSEST_ARCHIVIST_RADIUS,
      ];
      const radius = radii[kind];
      const spawnPoint = safeWalkableFloorPoint(x, y, radius);
      const scale = Math.pow(1 + 0.075 * depth, 1.28);
      const eliteScale = elite ? 2.25 : 1;
      const difficultyTier = isBossKind(kind) ? "boss" : elite ? "elite" : "normal";
      const combatHpScale = expeditionEnemyHpMultiplier(
        worldRef.current.expeditionDifficulty,
        difficultyTier,
      );
      const hp = hpBases[kind] * scale * eliteScale * combatHpScale;
      return {
        id: idRef.current++,
        kind,
        x: spawnPoint.x,
        y: spawnPoint.y,
        radius,
        hp,
        maxHp: hp,
        speed: speedBases[kind] * (elite ? 1.12 : 1),
        damage:
          damageBases[kind] *
          Math.pow(1 + 0.035 * depth, 1.16) *
          (elite ? 1.28 : 1),
        shootCooldown: 0.8 + hash(worldRef.current.seed, x | 0, y | 0, kind) * 1.4,
        slow: 0,
        orbitalCooldown: 0,
        poisonDamage: 0,
        poisonTime: 0,
        facing: 0,
        walkCycle: hash(worldRef.current.seed, x | 0, y | 0, kind + 31) * 4,
        moving: true,
        elite,
        patternPhase:
          kind === 6
            ? "stalk"
            : kind === 7 || kind === MARGIN_SEVERER_KIND || kind === SILENT_LIBRARIAN_KIND
              ? "orbit"
              : undefined,
        patternTimer:
          kind === BLANK_CARTOGRAPHER_KIND
            ? 1.15
            : kind === FINAL_BINDER_KIND
              ? 1.05
            : kind === 6
            ? 1.15 + hash(worldRef.current.seed, x | 0, y | 0, 607) * 1.1
            : kind === 7
              ? 1.4 + hash(worldRef.current.seed, x | 0, y | 0, 707) * 1.2
              : kind === MARGIN_SEVERER_KIND
                ? 1.65 + hash(worldRef.current.seed, x | 0, y | 0, 807) * 1.1
                : kind === SILENT_LIBRARIAN_KIND
                  ? 1.8 + hash(worldRef.current.seed, x | 0, y | 0, 1007) * 1.2
                : undefined,
        patternX:
          kind === 6
            ? 0
            : kind === 7
              ? hash(worldRef.current.seed, x | 0, y | 0, 717) < 0.5
                ? -1
                : 1
              : undefined,
        patternY: kind === 6 ? 1 : undefined,
        patternHit: false,
        strafeDirection:
          kind === MARGIN_SEVERER_KIND || kind === SILENT_LIBRARIAN_KIND
            ? hash(worldRef.current.seed, x | 0, y | 0, 817) < 0.5
              ? -1
              : 1
            : undefined,
        bossPattern: undefined,
        bossPatternIndex: kind === BLANK_CARTOGRAPHER_KIND ? 0 : undefined,
        bossPhase:
          kind === BLANK_CARTOGRAPHER_KIND ? "pursuit" : undefined,
        bossSummonTargets:
          kind === BLANK_CARTOGRAPHER_KIND ? [] : undefined,
        binderPattern: undefined,
        binderPatternIndex: kind === FINAL_BINDER_KIND ? 0 : undefined,
        binderPhase: kind === FINAL_BINDER_KIND ? "pursuit" : undefined,
        binderAxis: kind === FINAL_BINDER_KIND ? "horizontal" : undefined,
        binderDirection:
          kind === FINAL_BINDER_KIND
            ? hash(worldRef.current.seed, x | 0, y | 0, 9917) < 0.5
              ? -1
              : 1
            : undefined,
        binderPulseIndex: kind === FINAL_BINDER_KIND ? 0 : undefined,
        archivist:
          kind === PALIMPSEST_ARCHIVIST_KIND
            ? createPalimpsestState()
            : undefined,
        timeRifts:
          kind === 7 || kind === BLANK_CARTOGRAPHER_KIND ? [] : undefined,
      };
    },
    [],
  );

  const spawnRoom = useCallback(
    (kind: RoomKind) => {
      const world = worldRef.current;
      const player = playerRef.current;
      const depth = player.rooms;
      const enemies: Enemy[] = [];
      const seedSalt =
        world.roomX * 41 +
        world.roomY * 73 +
        depth * 97 +
        world.dungeonFloor * 131;
      let marginSevererCount = 0;
      let silentLibrarianCount = 0;

      if (kind !== "boss") world.activeBossKind = null;

      if (kind === "shelter") {
        world.expeditionDifficulty = { ...BASE_EXPEDITION_DIFFICULTY };
        world.enemies = [];
        return;
      }

      const bossKind =
        kind === "boss"
          ? bossKindForProgress(player.endingVersion, player.bossesCleared)
          : null;
      const currentCombatPower = calculatePlayerStatsForRuntime(player).ratings.combatPower;
      player.expeditionPowerRating = updateExpeditionPowerRating({
        previousRating: player.expeditionPowerRating,
        currentCombatPower,
      });
      world.expeditionDifficulty = calculateExpeditionDifficulty({
        roomsCleared: depth,
        playerLevel: player.level,
        combatPower: player.expeditionPowerRating,
        suppressPowerScaling:
          bossKind === BLANK_CARTOGRAPHER_KIND &&
          player.endingVersion < FIRST_BOSS_ENDING_VERSION,
      });
      const count = calculateExpeditionEnemyCount({
        roomsCleared: depth,
        roomKind: kind,
        difficulty: world.expeditionDifficulty,
      });

      if (kind === "boss") {
        if (bossKind === null) return;
        world.activeBossKind = bossKind;
        enemies.push(makeEnemy(bossKind, WIDTH / 2, 210, depth, true));
        world.enemies = enemies;
        playGameSfx("bossAppear", { priority: 10 });
        return;
      }

      for (let i = 0; i < count; i += 1) {
        const rx = hash(world.seed, world.roomX, world.roomY, seedSalt + i * 19);
        const ry = hash(world.seed, world.roomY, world.roomX, seedSalt + i * 31);
        const unlockedKinds: EnemyKind[] =
          depth < 2
            ? [0, 1]
            : depth < MARGIN_SEVERER_UNLOCK_DEPTH
              ? [0, 1, 2, 6]
              : depth < 6
                ? [0, 1, 2, 3, 4, 6, MARGIN_SEVERER_KIND]
                : depth < SILENT_LIBRARIAN_UNLOCK_DEPTH
                  ? [0, 1, 2, 3, 4, 6, 7, MARGIN_SEVERER_KIND]
                  : [0, 1, 2, 3, 4, 6, 7, MARGIN_SEVERER_KIND, SILENT_LIBRARIAN_KIND];
        let enemyKind =
          unlockedKinds[
            Math.floor(
              hash(world.seed, world.roomX + i, world.roomY - i, 911) *
                unlockedKinds.length,
            )
          ];
        if (kind === "horde") enemyKind = 0;
        if (kind === "memory" && i % 2 === 0) enemyKind = 4;
        if (enemyKind === MARGIN_SEVERER_KIND) {
          if (marginSevererCount >= MARGIN_SEVERER_MAX_PER_ROOM) {
            enemyKind =
              hash(world.seed, world.roomX + i, world.roomY, 819) < 0.5 ? 2 : 4;
          } else {
            marginSevererCount += 1;
          }
        }
        if (enemyKind === SILENT_LIBRARIAN_KIND) {
          if (silentLibrarianCount >= SILENT_LIBRARIAN_MAX_PER_ROOM) {
            enemyKind =
              hash(world.seed, world.roomX + i, world.roomY, 1019) < 0.5 ? 2 : 7;
          } else {
            silentLibrarianCount += 1;
          }
        }
        const elite = kind === "elite" && i === 0;
        enemies.push(
          makeEnemy(
            enemyKind,
            130 + rx * (WIDTH - 260),
            120 + ry * (HEIGHT - 240),
            depth,
            elite,
          ),
        );
      }
      world.enemies = enemies;
    },
    [makeEnemy],
  );

  const determineRoomKind = useCallback((x: number, y: number): RoomKind => {
    const world = worldRef.current;
    const existing = world.rooms[keyOf(x, y)];
    if (existing) return existing.kind;
    if (x === DUNGEON_CENTER_COORDINATE && y === DUNGEON_CENTER_COORDINATE) {
      return "battle";
    }

    const layoutSeed = world.seed ^ Math.imul(world.dungeonFloor, 0x45d9f3b);

    const radialDistance = Math.abs(x) + Math.abs(y);
    const onCardinalRoute = x === 0 || y === 0;
    if (onCardinalRoute && radialDistance >= 9 && radialDistance % 9 === 0) {
      return "boss";
    }
    if (onCardinalRoute && radialDistance >= 5 && radialDistance % 5 === 0) {
      return "shelter";
    }

    // Floor landmarks are coordinate deterministic. Every 9×9 sector has one
    // boss and every 5×5 sector has one shelter, so a saved seed cannot reshuffle
    // this floor when the player explores branches in a different order.
    const bossSectorX = Math.floor(x / 9);
    const bossSectorY = Math.floor(y / 9);
    const bossX =
      bossSectorX * 9 +
      Math.min(8, Math.floor(hash(layoutSeed, bossSectorX, bossSectorY, 901) * 9));
    const bossY =
      bossSectorY * 9 +
      Math.min(8, Math.floor(hash(layoutSeed, bossSectorY, bossSectorX, 977) * 9));
    if (Math.abs(x) + Math.abs(y) >= 6 && x === bossX && y === bossY) return "boss";

    const shelterSectorX = Math.floor(x / 5);
    const shelterSectorY = Math.floor(y / 5);
    const shelterX =
      shelterSectorX * 5 +
      Math.min(4, Math.floor(hash(layoutSeed, shelterSectorX, shelterSectorY, 503) * 5));
    const shelterY =
      shelterSectorY * 5 +
      Math.min(4, Math.floor(hash(layoutSeed, shelterSectorY, shelterSectorX, 557) * 5));
    if (Math.abs(x) + Math.abs(y) >= 3 && x === shelterX && y === shelterY) {
      return "shelter";
    }

    const roll = hash(layoutSeed, x, y, 173);
    if (roll < 0.49) return "battle";
    if (roll < 0.67) return "horde";
    if (roll < 0.81) return "elite";
    return "memory";
  }, []);

  const enterRoom = useCallback(
    (
      x: number,
      y: number,
      entry: "left" | "right" | "top" | "bottom" | "center" = "left",
    ) => {
      if (!isDungeonCoordinate(x, y)) return;
      const world = worldRef.current;
      const player = playerRef.current;
      const key = keyOf(x, y);
      const kind = determineRoomKind(x, y);
      if (!world.rooms[key]) {
        const cleared = kind === "shelter";
        world.rooms[key] = { kind, cleared };
        world.knownRoomCount += 1;
        if (cleared) world.clearedRoomCount += 1;
      }
      const shelterActivated =
        isFirstShelterRest(kind, world.visitedLookup[key] === true);
      for (const [offsetX, offsetY] of ROOM_DIRECTIONS) {
        const neighborX = x + offsetX;
        const neighborY = y + offsetY;
        if (!isDungeonCoordinate(neighborX, neighborY)) continue;
        const neighborKey = keyOf(neighborX, neighborY);
        if (!world.rooms[neighborKey]) {
          const neighborKind = determineRoomKind(neighborX, neighborY);
          const neighborCleared = neighborKind === "shelter";
          world.rooms[neighborKey] = {
            kind: neighborKind,
            cleared: neighborCleared,
          };
          world.knownRoomCount += 1;
          if (neighborCleared) world.clearedRoomCount += 1;
        }
      }
      if (!world.visitedLookup[key]) {
        world.visited.push(key);
        world.visitedLookup[key] = true;
      }
      world.roomX = x;
      world.roomY = y;
      world.roomKind = kind;
      world.roomCleared = world.rooms[key].cleared;
      world.doorMotion = createRoomDoorMotion(world.roomCleared);
      world.doorEffects = [];
      if (!world.roomCleared) {
        for (const placement of ROOM_DOOR_PLACEMENTS) {
          world.doorEffects.push({
            id: idRef.current++,
            kind: "playerImpact",
            x: placement.x,
            y: placement.y,
            life: 0.28,
            duration: 0.28,
            size: 46,
            color: "#9d342f",
          });
        }
      }
      world.clearHandled = world.roomCleared;
      world.projectiles = [];
      world.orbs = [];
      world.gearDrops = [];
      world.effects = [];
      world.transition = 0.55;
      if (
        isExpeditionStartingRoom({
          clearedRoomCount: player.rooms,
          roomX: x,
          roomY: y,
        })
      ) {
        firstRoomGearDroppedRef.current = false;
      }
      inputRef.current.hasMoveTarget = false;
      player.moving = false;
      player.walkCycle = settleCharacterWalkCycle(player.walkCycle);
      player.shotCounter = 0;
      player.legendaryArmorReady = true;
      player.x =
        entry === "center"
          ? WIDTH / 2
          : entry === "left"
            ? 116
            : entry === "right"
              ? WIDTH - 116
              : WIDTH / 2;
      player.y =
        entry === "center"
          ? HEIGHT / 2
          : entry === "top"
            ? HEIGHT - 112
            : entry === "bottom"
              ? 112
              : HEIGHT / 2;
      player.shield = Math.max(
        player.shield,
        10 +
          powerRankOf(player, "glass") * 9 +
          powerRankOf(player, "ward") * 5 +
          aggregateEquipmentStats(player.equipment).roomEntryShieldFlat,
      );
      world.activeBossKind = null;
      if (world.roomCleared) world.enemies = [];
      else spawnRoom(kind);
      if (kind === "shelter") {
        if (shelterActivated) {
          saveAtShelter();
          setGameMode("shelter");
        } else {
          setToast(SPENT_SHELTER_MESSAGE);
        }
      } else {
        const bossKind = world.activeBossKind;
        if (kind === "boss" && bossKind === PALIMPSEST_ARCHIVIST_KIND) {
          setToast(
            "당신이 지나온 발자취 위로 새 문장이 번집니다. 덧쓴 기록관이 기록을 재생합니다.",
          );
        } else if (kind === "boss" && bossKind === FINAL_BINDER_KIND) {
          setToast(
            "찢긴 장들이 닫히며 종언의 제본사가 정본을 만들기 시작합니다.",
          );
        } else {
          setToast(
            kind === "boss"
              ? "지도 자체가 당신의 빌드를 되그리기 시작합니다."
              : `${ROOM_NAMES[kind]} — 문이 봉쇄되었습니다.`,
          );
        }
      }
      syncHud();
    },
    [determineRoomKind, saveAtShelter, setGameMode, spawnRoom, syncHud],
  );

  useEffect(() => {
    roomEnterRef.current = enterRoom;
  }, [enterRoom]);

  const descendToNextFloor = useCallback(() => {
    const world = worldRef.current;
    const player = playerRef.current;
    const currentKey = keyOf(world.roomX, world.roomY);
    const currentRoom = world.rooms[currentKey];
    if (
      world.stairRoomLookup[currentKey] !== true ||
      !currentRoom?.cleared ||
      !world.visitedLookup[currentKey]
    ) {
      setToast("이 방에는 아래로 이어지는 계단이 없습니다.");
      return;
    }
    if (world.enemies.length > 0 || world.transition > 0) {
      setToast("방의 기억이 가라앉을 때까지 계단을 이용할 수 없습니다.");
      return;
    }
    if (world.dungeonFloor >= Number.MAX_SAFE_INTEGER) {
      setToast("기록 가능한 가장 깊은 층에 도달했습니다.");
      return;
    }
    if (
      distance(player.x, player.y, STAIRCASE_X, STAIRCASE_Y) >
      STAIRCASE_INTERACTION_RADIUS
    ) {
      inputRef.current.moveTargetX = STAIRCASE_X;
      inputRef.current.moveTargetY = STAIRCASE_Y;
      inputRef.current.hasMoveTarget = true;
      setToast("하행 계단 앞으로 이동합니다. 도착하면 E를 다시 누르세요.");
      return;
    }

    const nextFloor = world.dungeonFloor + 1;
    worldRef.current = makeWorld(world.seed, nextFloor);
    setMapSnapshot({
      seed: world.seed,
      dungeonFloor: nextFloor,
      roomX: DUNGEON_CENTER_COORDINATE,
      roomY: DUNGEON_CENTER_COORDINATE,
      rooms: {},
      visited: [],
      stairRoomLookup: { ...worldRef.current.stairRoomLookup },
    });
    setMapTeleportDepartureSafe(false);
    enterRoom(
      DUNGEON_CENTER_COORDINATE,
      DUNGEON_CENTER_COORDINATE,
      "center",
    );
    playGameSfx("enemyTeleport", { priority: 7, playbackRate: 0.74 });
    setGameMode("playing");
    setToast(`지하 ${nextFloor}층. 새로운 99×99 구조가 기억을 다시 배열합니다.`);
  }, [enterRoom, setGameMode]);

  const teleportToVisitedRoom = useCallback(
    (x: number, y: number) => {
      if (!isSafeMapCoordinate(x, y)) return;
      const targetKey = keyOf(x, y);
      const world = worldRef.current;
      const targetRoom = world.rooms[targetKey];
      const status = getMapTeleportStatus({
        hasEntitlement: mapTeleportUnlocked,
        departureSafe: isMapTeleportDepartureSafe({
          roomCleared: world.roomCleared,
          enemyCount: world.enemies.length,
          transition: world.transition,
        }),
        current: world.roomX === x && world.roomY === y,
        known: Boolean(targetRoom),
        visited: world.visitedLookup[targetKey] === true,
        cleared: Boolean(targetRoom?.cleared),
      });
      if (status !== "available") {
        setToast(MAP_TELEPORT_STATUS_LABELS[status]);
        return;
      }
      if (!targetRoom) {
        setToast(MAP_TELEPORT_STATUS_LABELS.unknown);
        return;
      }

      requestGameConfirmation(
        {
          eyebrow: "MUJINDO WAYFINDER",
          title: `${targetKey} 좌표로 도약할까요?`,
          body: `${ROOM_NAMES[targetRoom.kind]}에 공간 문장을 새깁니다. 현재 방의 바닥 전리품은 회수되지 않습니다.`,
          confirmLabel: "좌표 도약",
          tone: "warning",
        },
        () => {
          const liveWorld = worldRef.current;
          const liveTarget = liveWorld.rooms[targetKey];
          const liveStatus = getMapTeleportStatus({
            hasEntitlement: hasMapTeleportEntitlement(readShopEntitlements()),
            departureSafe: isMapTeleportDepartureSafe({
              roomCleared: liveWorld.roomCleared,
              enemyCount: liveWorld.enemies.length,
              transition: liveWorld.transition,
            }),
            current: liveWorld.roomX === x && liveWorld.roomY === y,
            known: Boolean(liveTarget),
            visited: liveWorld.visitedLookup[targetKey] === true,
            cleared: Boolean(liveTarget?.cleared),
          });
          if (liveStatus !== "available") {
            setToast(MAP_TELEPORT_STATUS_LABELS[liveStatus]);
            return;
          }

          keysRef.current.clear();
          inputRef.current.dashQueued = false;
          inputRef.current.hasMoveTarget = false;
          enterRoom(x, y, "center");
          const arrivalWorld = worldRef.current;
          const arrivalPlayer = playerRef.current;
          arrivalWorld.effects.push({
            id: idRef.current++,
            kind: "teleport",
            x: arrivalPlayer.x,
            y: arrivalPlayer.y + 8,
            life: 0.82,
            duration: 0.82,
            size: 190,
          });
          arrivalWorld.effectCounts.teleport += 1;
          playGameSfx("enemyTeleport", { gain: 0.8 });
          setGameMode("playing");
          setToast(`무진도의 길잡이 · ${targetKey} 좌표로 도약했습니다.`);
          syncHud();
        },
      );
    },
    [enterRoom, mapTeleportUnlocked, requestGameConfirmation, setGameMode, syncHud],
  );

  const openAugmentChoice = useCallback(() => {
    const player = playerRef.current;
    const available = AUGMENTS.filter(
      (augment) => rankOf(player, augment.id) < MAX_AUGMENT_STACKS,
    );
    if (available.length === 0) {
      setChoices([]);
      setToast(`모든 증강이 ${MAX_AUGMENT_STACKS}스택에 도달했습니다. 더 이상 기억이 과잉 중첩되지 않습니다.`);
      syncHud();
      return;
    }
    const picked = selectAugmentChoices({
      available,
      getRank: (augment) => rankOf(player, augment.id),
    });
    setChoices(picked);
    setGameMode("augment");
  }, [setGameMode, syncHud]);

  const gainXp = useCallback(
    (amount: number) => {
      const player = playerRef.current;
      const scholarRank = powerRankOf(player, "scholar");
      const learningRank = powerRankOf(player, "learning");
      const boosted =
        amount *
        (1 + powerRankOf(player, "magnet") * 0.08) *
        Math.pow(1 + scholarRank * 0.09, 0.7) *
        simpleAugmentMultiplier(
          learningRank,
          SIMPLE_AUGMENT_BONUSES.learningXpGainPerRank,
        ) *
        (1 + aggregateEquipmentStats(player.equipment).xpGainPercent / 100);
      player.xp += boosted;
      if (player.xp >= player.nextXp && modeRef.current === "playing") {
        player.xp -= player.nextXp;
        player.level += 1;
        player.nextXp = xpThreshold(player.level);
        playGameSfx("lootRare", { playbackRate: 1.16, gain: 0.82 });
        openAugmentChoice();
      }
    },
    [openAugmentChoice],
  );

  const resumeAfterAugmentChoice = useCallback(() => {
    if (pendingEndingRef.current) {
      pendingEndingRef.current = false;
      setEndingChapterIndex(0);
      setGameMode("ending");
    } else if (pendingStoryRef.current) {
      const pending = pendingStoryRef.current;
      pendingStoryRef.current = null;
      showStory(pending.eyebrow, pending.title, pending.body, () =>
        setGameMode("playing"),
      );
    } else {
      setGameMode("playing");
    }
  }, [setGameMode, showStory]);

  const openProfessionChoice = useCallback(
    (augment: Augment, resume: () => void = () => setGameMode("playing")) => {
      if (
        professionCeremonyActiveRef.current ||
        !isProfessionEligible(playerRef.current.augments, augment.id)
      ) {
        return;
      }
      setProfessionCeremonyReady(false);
      let ceremonyImage = imagesRef.current.professionAscension;
      if (!ceremonyImage || (ceremonyImage.complete && ceremonyImage.naturalWidth === 0)) {
        ceremonyImage = new Image();
        imagesRef.current.professionAscension = ceremonyImage;
      }
      const markCeremonyReady = () => setProfessionCeremonyReady(true);
      const canDecodeCeremonyImage = typeof ceremonyImage.decode === "function";
      if (!canDecodeCeremonyImage) {
        ceremonyImage.addEventListener("load", markCeremonyReady, { once: true });
      }
      ceremonyImage.addEventListener(
        "error",
        () => {
          setProfessionCeremonyReady(true);
          setToast("전직 문장을 불러오지 못해 광휘 연출로 진행합니다.");
        },
        { once: true },
      );
      if (!ceremonyImage.src) {
        ceremonyImage.src = "/assets/effects/profession-ascension-sigil-v1.png";
      }
      if (canDecodeCeremonyImage) {
        void ceremonyImage.decode().then(markCeremonyReady).catch(() => {
          if (ceremonyImage.complete && ceremonyImage.naturalWidth > 0) {
            markCeremonyReady();
          }
        });
      } else if (ceremonyImage.complete && ceremonyImage.naturalWidth > 0) {
        markCeremonyReady();
      }
      setBuildPanelOpen(false);
      setProfessionCandidate(augment);
      professionResumeRef.current = resume;
      setGameMode("profession");
    },
    [setBuildPanelOpen, setGameMode],
  );

  const closeProfessionChoice = useCallback(() => {
    if (professionCeremonyActiveRef.current) return;
    setProfessionCandidate(null);
    const resume = professionResumeRef.current;
    professionResumeRef.current = () => undefined;
    resume();
  }, []);

  const confirmProfession = useCallback(() => {
    if (
      !professionCandidate ||
      !professionCeremonyReady ||
      professionCeremonyActiveRef.current
    ) {
      return;
    }
    professionCeremonyActiveRef.current = true;
    const player = playerRef.current;
    player.profession = professionCandidate.id;
    const rawRank = rankOf(player, professionCandidate.id);
    setProfessionCeremony({
      augment: professionCandidate,
      title: PROFESSION_TITLES[professionCandidate.id],
      rawRank,
    });
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    playGameSfx(reducedMotion ? "enhanceSuccess" : "professionAscend", {
      priority: 10,
      gain: reducedMotion ? 0.82 : 1,
    });
    setToast(
      `${PROFESSION_TITLES[professionCandidate.id]} 전직 완료 · ${professionCandidate.name} ${rawRank}스택 효과가 ${100 + PROFESSION_BONUS_PERCENT}%로 증폭됩니다.`,
    );
    syncHud();
  }, [professionCandidate, professionCeremonyReady, syncHud]);

  useEffect(() => {
    if (!professionCeremony) return;
    professionCeremonyActiveRef.current = true;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const completionDelay = reducedMotion
      ? PROFESSION_CEREMONY_REDUCED_MOTION_MS
      : PROFESSION_CEREMONY_DURATION_MS;
    const focusFrame = window.requestAnimationFrame(() => {
      professionCeremonyDialogRef.current?.focus({ preventScroll: true });
    });
    const impactTimer = reducedMotion
      ? null
      : window.setTimeout(() => {
          playGameSfx("lootLegendary", {
            playbackRate: 1.14,
            gain: 0.76,
            priority: 10,
          });
        }, 1_520);
    const completionTimer = window.setTimeout(() => {
      professionCeremonyActiveRef.current = false;
      setProfessionCeremony(null);
      setProfessionCandidate(null);
      const resume = professionResumeRef.current;
      professionResumeRef.current = () => undefined;
      resume();
    }, completionDelay);

    return () => {
      window.cancelAnimationFrame(focusFrame);
      if (impactTimer !== null) window.clearTimeout(impactTimer);
      window.clearTimeout(completionTimer);
    };
  }, [professionCeremony]);

  const chooseAugment = useCallback(
    (augment: Augment) => {
      const player = playerRef.current;
      const previous = rankOf(player, augment.id);
      if (previous >= MAX_AUGMENT_STACKS) {
        setToast(`${augment.name}은 이미 최대 ${MAX_AUGMENT_STACKS}스택입니다.`);
        resumeAfterAugmentChoice();
        return;
      }
      const nextRank = Math.min(MAX_AUGMENT_STACKS, previous + 1);
      player.augments[augment.id] = nextRank;
      playGameSfx("lootRare", { playbackRate: 1.04 + Math.min(0.12, nextRank * 0.005) });
      if (augment.id === "blood" && previous === 0) {
        player.maxHp = 85 + aggregateEquipmentStats(player.equipment).maxHpFlat;
        player.hp = Math.min(player.hp, player.maxHp);
      }
      if (augment.id === "glass") {
        const previousPower =
          player.profession === "glass" ? previous + Math.floor(previous / 2) : previous;
        player.shield += 9 * Math.max(1, powerRankOf(player, "glass") - previousPower);
      }
      const synergies = activeSynergies(player);
      setToast(
        synergies.length
          ? `${augment.name} ${nextRank}/${MAX_AUGMENT_STACKS}랭크 · 시너지 ${synergies.at(-1)?.name} 활성`
          : `${augment.name} ${nextRank}/${MAX_AUGMENT_STACKS}랭크 — 기억이 빌드에 합쳐졌습니다.`,
      );
      syncHud();
      if (nextRank >= PROFESSION_THRESHOLD && player.profession !== augment.id) {
        openProfessionChoice(augment, resumeAfterAugmentChoice);
      } else {
        resumeAfterAugmentChoice();
      }
    },
    [openProfessionChoice, resumeAfterAugmentChoice, syncHud],
  );

  const loadSave = useCallback(
    (slot: SaveSlotId = activeSaveSlotRef.current) => {
      // Refresh the account-wide entitlement before hydrating a run. Inventory
      // items are never truncated when capacity changes or a receipt is delayed.
      applyShopEntitlements(readShopEntitlements());
      const candidate = readSaveSlot(slot);
      if (!candidate || !isHydratableSaveData(candidate)) {
        setToast(`${slot}번 슬롯의 저장 데이터를 읽을 수 없습니다.`);
        refreshSaveSlots();
        return false;
      }
      const data = candidate;
      activateSaveSlot(slot);
      pendingStoryRef.current = null;
      pendingEndingRef.current = false;
      setEndingChapterIndex(0);
      const storedAutoSalvagePreference = readAutoSalvagePreference(slot);
      const gearReconciliation = reconcileEquipmentLevelRequirements(
        data.player.level,
        data.player.equipment,
        data.player.inventory,
      );
      const normalizedEquipment = gearReconciliation.equipment;
      const normalizedInventory = gearReconciliation.inventory;
      const savedMaxHp = Number.isFinite(data.player.maxHp)
        ? Math.max(1, data.player.maxHp)
        : 100;
      const savedHp = Number.isFinite(data.player.hp)
        ? clamp(data.player.hp, 0, savedMaxHp)
        : savedMaxHp;
      const savedHpRatio = savedHp / savedMaxHp;
      const savedEndingVersion = normalizeEndingVersion(
        data.player.endingVersion,
        data.player.endingSeen,
      );
      playerRef.current = {
        ...makePlayer(),
        ...data.player,
        profession:
          typeof data.player.profession === "string" ? data.player.profession : null,
        endingSeen: savedEndingVersion >= FIRST_BOSS_ENDING_VERSION,
        endingVersion: savedEndingVersion,
        bossesCleared: Math.max(
          savedEndingVersion >= FIRST_BOSS_ENDING_VERSION ? 1 : 0,
          Number.isSafeInteger(data.player.bossesCleared) &&
            data.player.bossesCleared >= 0
            ? data.player.bossesCleared
            : 0,
        ),
        x: WIDTH / 2,
        y: HEIGHT / 2,
        augments: normalizeAugmentStacks(data.player.augments),
        equipment: normalizedEquipment,
        inventory: normalizedInventory,
        autoSalvageMaxRarity:
          storedAutoSalvagePreference === undefined
            ? normalizeAutoSalvageThreshold(data.player.autoSalvageMaxRarity)
            : storedAutoSalvagePreference,
        memoryAsh: Number.isFinite(data.player.memoryAsh)
          ? Math.max(0, Math.floor(data.player.memoryAsh))
          : 0,
        memoryPickupCounter: Number.isFinite(data.player.memoryPickupCounter)
          ? Math.max(0, Math.floor(data.player.memoryPickupCounter))
          : 0,
        legendaryArmorReady: true,
        ...normalizeLegendaryRuntimeFromSave(data.player),
      };
      reconcileLegendaryRuntime(playerRef.current);
      const hydratedPlayer = playerRef.current;
      const baseMaxHp = rankOf(hydratedPlayer, "blood") > 0 ? 85 : 100;
      hydratedPlayer.maxHp = Math.max(
        1,
        baseMaxHp + aggregateEquipmentStats(normalizedEquipment).maxHpFlat,
      );
      hydratedPlayer.hp = clamp(
        hydratedPlayer.maxHp * savedHpRatio,
        1,
        hydratedPlayer.maxHp,
      );
      playerRef.current.nextXp = Math.min(
        playerRef.current.nextXp,
        xpThreshold(playerRef.current.level),
      );
      hydratedPlayer.expeditionPowerRating =
        Number.isFinite(data.player.expeditionPowerRating) &&
        data.player.expeditionPowerRating >= 1_000
          ? Math.floor(data.player.expeditionPowerRating)
          : calculatePlayerStatsForRuntime(hydratedPlayer).ratings.combatPower;
      const savedDungeon = normalizeSavedDungeonWorld(data.world);
      const world = makeWorld(data.world.seed, savedDungeon.dungeonFloor);
      world.rooms = savedDungeon.rooms;
      world.visited = savedDungeon.visited;
      world.visitedLookup = Object.fromEntries(
        savedDungeon.visited.map((key) => [key, true] as const),
      );
      world.knownRoomCount = Object.keys(savedDungeon.rooms).length;
      world.clearedRoomCount = Object.values(savedDungeon.rooms).filter(
        (room) => room.cleared,
      ).length;
      worldRef.current = world;
      stableAugmentsRef.current = normalizeAugmentStacks(
        data.stableAugments ?? {},
      );
      checkpointRef.current = {
        dungeonFloor: savedDungeon.dungeonFloor,
        x: savedDungeon.roomX,
        y: savedDungeon.roomY,
      };
      setBuildPanelOpen(false);
      setInventoryScreenOpen(false);
      setStatsScreenOpen(false);
      setStarted(true);
      enterRoom(savedDungeon.roomX, savedDungeon.roomY, "left");
      setGameMode("playing");
      if (gearReconciliation.repaired) {
        // Persist canonical collections immediately so a crash before the next
        // shelter save cannot resurrect malformed or level-locked equipment.
        writeSaveSlot(slot, {
          ...data,
          player: {
            ...data.player,
            equipment: cloneEquipment(normalizedEquipment),
            inventory: normalizedInventory.map(cloneGearItem),
          },
        });
        refreshSaveSlots();
      }
      if (gearReconciliation.unequipped.length > 0) {
        setToast(
          `세이브 복원 · 요구 레벨 미달 장비 ${gearReconciliation.unequipped.length}개를 가방으로 이동했습니다.`,
        );
        return true;
      }
      setToast(`${slot}번 슬롯 · 고정된 기억에서 원정을 재개했습니다.`);
      return true;
    },
    [
      activateSaveSlot,
      applyShopEntitlements,
      enterRoom,
      refreshSaveSlots,
      setBuildPanelOpen,
      setGameMode,
      setInventoryScreenOpen,
      setStatsScreenOpen,
    ],
  );

  const startNewRun = useCallback((slot: SaveSlotId = activeSaveSlotRef.current) => {
    activateSaveSlot(slot);
    const storedAutoSalvagePreference = readAutoSalvagePreference(slot);
    removeSaveSlot(slot);
    refreshSaveSlots();
    keysRef.current.clear();
    pendingStoryRef.current = null;
    pendingEndingRef.current = false;
    setEndingChapterIndex(0);
    setLootNotice(null);
    const seed = (Date.now() ^ Math.floor(Math.random() * 0x7fffffff)) & 0x7fffffff;
    playerRef.current = {
      ...makePlayer(),
      autoSalvageMaxRarity:
        storedAutoSalvagePreference === undefined
          ? null
          : storedAutoSalvagePreference,
    };
    worldRef.current = makeWorld(seed);
    stableAugmentsRef.current = {};
    checkpointRef.current = null;
    setBuildPanelOpen(false);
    setInventoryScreenOpen(false);
    setStatsScreenOpen(false);
    setStarted(true);
    enterRoom(DUNGEON_CENTER_COORDINATE, DUNGEON_CENTER_COORDINATE, "center");
    showStory(
      "서장 · 끝을 찾는 자",
      "라온의 목소리",
      "“누나, 지도 끝에서 기다릴게.” 하린은 그 목소리가 진짜인지 묻지 않았다. 무진도에서 질문은 늘 또 하나의 방이 되었으니까.",
      () => setGameMode("playing"),
    );
  }, [
    activateSaveSlot,
    enterRoom,
    refreshSaveSlots,
    setBuildPanelOpen,
    setGameMode,
    setInventoryScreenOpen,
    setStatsScreenOpen,
    showStory,
  ]);

  useEffect(() => {
    if (initialSaveSlot === undefined || initialSaveSlotHandledRef.current) return;
    initialSaveSlotHandledRef.current = true;
    if (!loadSave(initialSaveSlot)) startNewRun(initialSaveSlot);
  }, [initialSaveSlot, loadSave, startNewRun]);

  const retryFromShelter = useCallback(() => {
    if (!loadSave()) startNewRun();
  }, [loadSave, startNewRun]);

  const deleteSaveSlot = useCallback(
    (slot: SaveSlotId) => {
      requestGameConfirmation(
        {
          eyebrow: "RECORD ERASURE",
          title: `${slot}번 기록을 지울까요?`,
          body: "이 슬롯에 고정된 원정 기록은 되돌릴 수 없습니다.",
          confirmLabel: "기록 삭제",
          tone: "danger",
        },
        () => {
          removeSaveSlot(slot);
          refreshSaveSlots();
          setToast(`${slot}번 슬롯을 비웠습니다.`);
        },
      );
    },
    [refreshSaveSlots, requestGameConfirmation],
  );

  const equipInventoryItem = useCallback(
    (itemId: string) => {
      const player = playerRef.current;
      const itemIndex = player.inventory.findIndex((item) => item.id === itemId);
      if (itemIndex < 0) return;
      const item = player.inventory[itemIndex];
      const requiredLevel = getGearRequiredLevel(item);
      if (!canEquipGearAtLevel(player.level, item)) {
        setSelectedGearId(item.id);
        setToast(
          `장착 레벨 부족 · LV.${item.level} 장비는 캐릭터 LV.${requiredLevel}부터 장착할 수 있습니다.`,
        );
        return;
      }
      const previousMaxHp = aggregateEquipmentStats(player.equipment).maxHpFlat;
      const replaced = player.equipment[item.slot];
      player.equipment[item.slot] = item;
      clearPaperdollCaches();
      player.inventory.splice(itemIndex, 1);
      if (replaced) player.inventory.push(replaced);
      reconcileLegendaryRuntime(player);
      playGameSfx("lootDrop", { playbackRate: 1.12, gain: 0.84 });
      const nextMaxHp = aggregateEquipmentStats(player.equipment).maxHpFlat;
      const maxHpDelta = nextMaxHp - previousMaxHp;
      player.maxHp = Math.max(1, player.maxHp + maxHpDelta);
      player.hp = clamp(player.hp + Math.max(0, maxHpDelta), 1, player.maxHp);
      setSelectedGearId(replaced?.id ?? null);
      setToast(
        `${GEAR_RARITY_META[item.rarity].label} ${EQUIPMENT_SLOT_LABELS[item.slot]} 장착 · 전투력 ${item.powerScore}`,
      );
      syncHud();
    },
    [syncHud],
  );

  const unequipInventoryItem = useCallback(
    (slot: EquipmentSlot) => {
      const player = playerRef.current;
      const item = player.equipment[slot];
      if (!item) return;
      if (player.inventory.length >= inventoryCapacityRef.current) {
        setToast(
          `가방 ${inventoryCapacityRef.current}칸이 가득 차 장비를 해제할 수 없습니다.`,
        );
        return;
      }

      const previousMaxHp = aggregateEquipmentStats(player.equipment).maxHpFlat;
      player.equipment[slot] = null;
      clearPaperdollCaches();
      player.inventory.push(item);
      reconcileLegendaryRuntime(player);
      playGameSfx("uiBack", { gain: 0.9 });
      const nextMaxHp = aggregateEquipmentStats(player.equipment).maxHpFlat;
      const maxHpDelta = nextMaxHp - previousMaxHp;
      player.maxHp = Math.max(1, player.maxHp + maxHpDelta);
      player.hp = clamp(player.hp + Math.max(0, maxHpDelta), 1, player.maxHp);
      setSelectedGearId(item.id);
      setToast(`${formatGearDisplayName(item)} 장착 해제 · 가방으로 이동`);
      syncHud();
    },
    [syncHud],
  );

  const salvageInventoryItem = useCallback(
    (itemId: string) => {
      const player = playerRef.current;
      const index = player.inventory.findIndex((item) => item.id === itemId);
      if (index < 0) return;
      const item = player.inventory[index];
      player.inventory.splice(index, 1);
      const ashBreakdown = getGearSalvageAshBreakdown(item);
      player.memoryAsh += ashBreakdown.total;
      playGameSfx("salvage");
      setSelectedGearId(null);
      setToast(
        `${formatGearDisplayName(item)}을 분해해 기억의 재 ${ashBreakdown.total.toLocaleString("ko-KR")}개를 얻었습니다.${ashBreakdown.enhancementRefund > 0 ? ` · 강화 비용 ${ashBreakdown.enhancementRefund.toLocaleString("ko-KR")}개 전액 환급(100% 성공 기준)` : ""}`,
      );
      syncHud();
    },
    [syncHud],
  );

  const salvageInventoryItems = useCallback(
    (itemIds: string[]) => {
      const player = playerRef.current;
      const requestedIds = new Set(itemIds);
      const items = player.inventory.filter((item) => requestedIds.has(item.id));
      if (items.length === 0) return;

      const ashBreakdown = items.reduce(
        (total, item) => {
          const itemBreakdown = getGearSalvageAshBreakdown(item);
          return {
            total: total.total + itemBreakdown.total,
            enhancementRefund:
              total.enhancementRefund + itemBreakdown.enhancementRefund,
          };
        },
        { total: 0, enhancementRefund: 0 },
      );

      player.inventory = player.inventory.filter(
        (item) => !requestedIds.has(item.id),
      );
      player.memoryAsh += ashBreakdown.total;
      playGameSfx("salvage", {
        playbackRate: Math.min(1.22, 0.96 + items.length * 0.012),
        gain: Math.min(1.18, 0.88 + items.length * 0.015),
      });
      if (selectedGearId && requestedIds.has(selectedGearId)) {
        setSelectedGearId(null);
      }
      setToast(
        `장비 ${items.length}개 일괄 분해 · 기억의 재 ${ashBreakdown.total.toLocaleString("ko-KR")}개 획득${ashBreakdown.enhancementRefund > 0 ? ` · 강화 비용 ${ashBreakdown.enhancementRefund.toLocaleString("ko-KR")}개 전액 환급(100% 성공 기준)` : ""}`,
      );
      syncHud();
    },
    [selectedGearId, syncHud],
  );

  const changeAutoSalvageMaxRarity = useCallback(
    (threshold: AutoSalvageThreshold) => {
      const normalized = normalizeAutoSalvageThreshold(threshold);
      const player = playerRef.current;
      player.autoSalvageMaxRarity = normalized;
      const persisted = writeAutoSalvagePreference(
        activeSaveSlotRef.current,
        normalized,
      );

      if (normalized === null) {
        setToast(
          persisted
            ? "장비 자동 분해를 해제했습니다."
            : "장비 자동 분해를 해제했습니다 · 저장소 오류로 이번 플레이에만 적용됩니다.",
        );
      } else {
        const rarityLabel = GEAR_RARITY_META[normalized].label;
        setToast(
          persisted
            ? `${rarityLabel} 이하 자동 분해 활성화 · 새 장비만 변환 · 전설 이상 보호`
            : `${rarityLabel} 이하 자동 분해 활성화 · 저장소 오류로 이번 플레이에만 적용 · 전설 이상 보호`,
        );
      }
      syncHud();
    },
    [syncHud],
  );

  const grantLocalRarityShowcase = useCallback(() => {
    const player = playerRef.current;
    const showcaseItems = GEAR_RARITIES.map((rarity, index) => ({
      ...rollGear(
        `local-rarity-showcase:${activeSaveSlotRef.current}:${rarity}`,
        {
          level: Math.max(1, player.level),
          rarity,
          slot: LOCAL_RARITY_SHOWCASE_SLOTS[index],
        },
      ),
      id: `local-rarity-showcase-${activeSaveSlotRef.current}-${rarity}`,
    }));
    const ownedIds = new Set([
      ...player.inventory.map((item) => item.id),
      ...EQUIPMENT_SLOTS.flatMap((slot) =>
        player.equipment[slot] ? [player.equipment[slot].id] : [],
      ),
    ]);
    const missingItems = showcaseItems.filter((item) => !ownedIds.has(item.id));
    const requiredSlots = missingItems.length;
    const openSlots = inventoryCapacityRef.current - player.inventory.length;
    if (requiredSlots === 0) {
      setSelectedGearId(showcaseItems[0].id);
      setToast("8등급 견본이 이미 모두 지급되어 있습니다.");
      return;
    }
    if (openSlots < requiredSlots) {
      setToast(`남은 견본 지급에는 빈 가방 ${requiredSlots}칸이 필요합니다.`);
      return;
    }

    player.inventory.unshift(...missingItems);
    setSelectedGearId(missingItems[0].id);
    setLootNotice(missingItems[missingItems.length - 1]);
    setToast("로컬 검수용 일반·마법·고급·희귀·영웅·전설·신화·우주 견본을 지급했습니다.");
    syncHud();
  }, [syncHud]);

  const performGearEnhancement = useCallback(
    (itemId: string) => {
      const player = playerRef.current;
      const inventoryIndex = player.inventory.findIndex((item) => item.id === itemId);
      const equippedSlot = EQUIPMENT_SLOTS.find(
        (slot) => player.equipment[slot]?.id === itemId,
      );
      const item =
        inventoryIndex >= 0
          ? player.inventory[inventoryIndex]
          : equippedSlot
            ? player.equipment[equippedSlot]
            : null;
      if (!item) return;
      const rule = getGearEnhancementRule(item);
      if (!rule) {
        setToast(`${formatGearDisplayName(item)}은 이미 최대 +10 강화입니다.`);
        return;
      }
      if (player.memoryAsh < rule.ashCost) {
        setToast(`기억의 재가 ${rule.ashCost - player.memoryAsh}개 부족합니다.`);
        return;
      }

      const previousMaxHp = aggregateEquipmentStats(player.equipment).maxHpFlat;
      const previousEquipmentPower = calculateEquipmentCombatPower(player.equipment);
      const implicitDisplay = getGearImplicitDisplay(item);
      const optionGainSummary = `${implicitDisplay.label} ${formatCompactGearLabel(implicitDisplay.nextStageGainLabel)}`;
      player.memoryAsh -= rule.ashCost;
      const roll = Math.random() * 100;
      if (roll < rule.successPercent) {
        playGameSfx("enhanceSuccess");
        const enhancedItem: GearItem = {
          ...item,
          enhancement: rule.target,
          powerScore: calculateGearPowerScore({ ...item, enhancement: rule.target }),
        };
        if (inventoryIndex >= 0) player.inventory[inventoryIndex] = enhancedItem;
        else if (equippedSlot) player.equipment[equippedSlot] = enhancedItem;
        setSelectedGearId(enhancedItem.id);
        const powerGain = equippedSlot
          ? calculateEquipmentCombatPower(player.equipment) - previousEquipmentPower
          : enhancedItem.powerScore - item.powerScore;
        const powerGainLabel = equippedSlot ? "장착 전투력" : "아이템 전투력";
        setToast(
          `강화 성공 · ${formatGearDisplayName(enhancedItem)} · ${powerGainLabel} ${powerGain >= 0 ? "+" : ""}${powerGain} · ${optionGainSummary}`,
        );
      } else if (roll < rule.successPercent + rule.destroyPercent) {
        playGameSfx("enhanceDestroy", { priority: 9 });
        if (inventoryIndex >= 0) player.inventory.splice(inventoryIndex, 1);
        else if (equippedSlot) {
          player.equipment[equippedSlot] = null;
          reconcileLegendaryRuntime(player);
        }
        setSelectedGearId(null);
        setToast(`강화 파괴 · ${formatGearDisplayName(item)}이 기억의 재로 흩어졌습니다.`);
      } else {
        playGameSfx("enhanceFail");
        setToast(
          `강화 실패 · ${formatGearDisplayName(item)} 유지 · 기억의 재 ${rule.ashCost} 소모`,
        );
      }

      if (equippedSlot) {
        const nextMaxHp = aggregateEquipmentStats(player.equipment).maxHpFlat;
        const maxHpDelta = nextMaxHp - previousMaxHp;
        player.maxHp = Math.max(1, player.maxHp + maxHpDelta);
        player.hp = clamp(player.hp + Math.max(0, maxHpDelta), 1, player.maxHp);
      }
      syncHud();
    },
    [syncHud],
  );

  const enhanceGearItem = useCallback(
    (itemId: string) => {
      const player = playerRef.current;
      const item =
        player.inventory.find((candidate) => candidate.id === itemId) ??
        EQUIPMENT_SLOTS.map((slot) => player.equipment[slot]).find(
          (candidate) => candidate?.id === itemId,
        ) ??
        null;
      if (!item) return;
      const rule = getGearEnhancementRule(item);
      if (!rule) {
        setToast(`${formatGearDisplayName(item)}은 이미 최대 +10 강화입니다.`);
        return;
      }
      if (player.memoryAsh < rule.ashCost) {
        setToast(`기억의 재가 ${rule.ashCost - player.memoryAsh}개 부족합니다.`);
        return;
      }
      const previewItem: GearItem = {
        ...item,
        enhancement: rule.target,
        powerScore: calculateGearPowerScore({ ...item, enhancement: rule.target }),
      };
      const equippedSlot = EQUIPMENT_SLOTS.find(
        (slot) => player.equipment[slot]?.id === item.id,
      );
      const powerGain = equippedSlot
        ? calculateEquipmentPowerDelta(player.equipment, previewItem)
        : previewItem.powerScore - item.powerScore;
      const powerGainLabel = equippedSlot ? "장착 종합 전투력" : "아이템 전투력";
      const implicitDisplay = getGearImplicitDisplay(item);
      const optionGainSummary = `${implicitDisplay.label} ${formatCompactGearLabel(implicitDisplay.nextStageGainLabel)}`;
      if (rule.destroyPercent <= 0) {
        performGearEnhancement(itemId);
        return;
      }

      requestGameConfirmation(
        {
          eyebrow: "FORGE WARNING",
          title: `${formatGearDisplayName(item)} → +${rule.target}`,
          body: `이번 강화 증가분: ${optionGainSummary} · ${powerGainLabel} ${powerGain >= 0 ? "+" : ""}${powerGain}. 실패 시 파괴될 확률이 ${rule.destroyPercent}%입니다. 강화를 진행할까요?`,
          confirmLabel: "강화 시도",
          tone: "danger",
        },
        () => performGearEnhancement(itemId),
      );
    },
    [performGearEnhancement, requestGameConfirmation],
  );

  const returnToMenu = useCallback(() => {
    keysRef.current.clear();
    inputRef.current.hasMoveTarget = false;
    setStarted(false);
    setLootNotice(null);
    setGameMode("menu");
    setBuildPanelOpen(false);
    setInventoryScreenOpen(false);
    setStatsScreenOpen(false);
    shopReturnInventoryRef.current = false;
    setShopPreferredProductId(null);
    setShopScreenOpen(false);
    setMenuStage("landing");
    refreshSaveSlots();
    onReturnToPlaza?.();
  }, [
    onReturnToPlaza,
    refreshSaveSlots,
    setBuildPanelOpen,
    setGameMode,
    setInventoryScreenOpen,
    setShopScreenOpen,
    setStatsScreenOpen,
  ]);

  useEffect(() => {
    const restoreTimer = window.setTimeout(() => {
      const restored = readShopEntitlements();
      applyShopEntitlements(restored);
      setShopMode(shopCheckoutMode());
    }, 0);
    return () => window.clearTimeout(restoreTimer);
  }, [applyShopEntitlements]);

  useEffect(() => {
    migrateLegacySave();
    const saveCheck = window.setTimeout(refreshSaveSlots, 0);
    const imagePaths: Record<string, string> = {
      sprites: "/assets/characters-sprite-atlas.png",
      walkHarinLegacy: "/assets/walk/harin-walk.png",
      walkWithered: "/assets/walk/withered-walk-v2.png",
      walkThreader: "/assets/walk/threader-walk.png",
      walkGuardian: "/assets/walk/guardian-walk.png",
      walkNest: "/assets/walk/nest-walk.png",
      walkWitch: "/assets/walk/witch-walk.png",
      walkBoss: "/assets/walk/cartographer-boss-walk.png",
      walkProofreader: "/assets/walk/proofreader-walk-v2.png",
      walkTimeStalker: "/assets/walk/time-stalker-walk.png",
      walkMarginSeverer: "/assets/walk/margin-severer-walk-v1.png",
      walkFinalBinder: "/assets/walk/final-binder-walk-v1.png",
      walkSilentLibrarian: "/assets/walk/silent-librarian-walk-v1.png",
      walkPalimpsestArchivist: "/assets/walk/palimpsest-archivist-walk-v1.png",
      proofreaderTelegraph: "/assets/effects/proofreader-telegraph.png",
      timeRiftWarning: "/assets/effects/time-stalker-rift-warning-v1.png",
      timeRiftBurst: "/assets/effects/time-stalker-rift-burst-v1.png",
      marginSeverLine: "/assets/effects/margin-sever-line-v1.png",
      finalBinderPatterns: "/assets/effects/final-binder-patterns-v1.png",
      silentLibrarianEcho: "/assets/effects/silent-librarian-echo-v1.png",
      palimpsestArchivistPatterns:
        "/assets/effects/palimpsest-archivist-patterns-v1.png",
      roomPortcullis: ROOM_DOOR_ASSET_PATH,
      equippedMythicAura: EQUIPPED_RARITY_VFX_PATHS.mythic,
      equippedCosmicAura: EQUIPPED_RARITY_VFX_PATHS.cosmic,
      summonEffect: "/assets/effects/summon-rift.png",
      teleportEffect: "/assets/effects/teleport-rift.png",
      memoryFragments: "/assets/pickups/memory-fragments.png",
      equipmentIcons: "/assets/equipment/equipment-types-v4.png",
      ...ROOM_ART_PATHS,
      ui: "/assets/augment-ui-atlas.png",
      menu: "/assets/menu-title-background.png",
    };
    for (const [name, source] of gameplayVfxImageEntries()) {
      imagePaths[name] = source;
    }
    for (const config of Object.values(EQUIPMENT_RARITY_VFX)) {
      imagePaths[config.imageKey] = config.imagePath;
    }
    for (const [name, source] of Object.entries(imagePaths)) {
      const image = new Image();
      image.src = source;
      imagesRef.current[name] = image;
    }
    return () => window.clearTimeout(saveCheck);
  }, [refreshSaveSlots]);

  useEffect(() => {
    const loadout = paperdollLoadoutFromEquipment(hud.player.equipment);
    const paths = [PAPERDOLL_BODY_PATH, ...paperdollLayerPathsForLoadout(loadout)];
    paperdollImagesRef.current.reconcile(paths);
    // Equipment is cloned for HUD snapshots; the signature suppresses those
    // identity-only updates while still reacting to slot/variant changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paperdollEquipmentSignature]);

  useEffect(() => {
    if (!lootNotice) return;
    const timeout = window.setTimeout(() => setLootNotice(null), 3200);
    return () => window.clearTimeout(timeout);
  }, [lootNotice]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (professionCeremonyActiveRef.current) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      const key = event.key.toLowerCase();
      const target = event.target as HTMLElement | null;
      const isInteractive = Boolean(
        target?.closest(
          "button, a, input, select, textarea, [contenteditable='true'], [tabindex]:not([tabindex='-1'])",
        ),
      );
      if (statsOpenRef.current) {
        if ((key === "escape" || key === "c") && !event.repeat) {
          setStatsScreenOpen(false);
        } else if (key === "b" && !event.repeat) {
          setStatsScreenOpen(false);
          setBuildTab("build");
          setBuildPanelOpen(true);
        } else if (key === "i" && !event.repeat) {
          setStatsScreenOpen(false);
          setInventoryScreenOpen(true);
        } else if (key === "p" && !event.repeat) {
          openShop();
        } else if (key === "m" && !event.repeat) {
          setStatsScreenOpen(false);
          openMap();
        }
        return;
      }
      if (isInteractive && key !== "escape") return;
      if (gameConfirmationOpenRef.current) {
        if (key === "escape" && !event.repeat) closeGameConfirmation();
        return;
      }
      if (shopOpenRef.current) {
        if ((key === "escape" || key === "p") && !event.repeat) closeShop();
        return;
      }
      if (!started) {
        if (key === "p" && !event.repeat) {
          openShop();
          return;
        }
        if (key === "escape" && menuStage === "archive" && !event.repeat) {
          setMenuStage("landing");
        }
        return;
      }
      if (modeRef.current === "augment" && !event.repeat && ["1", "2", "3"].includes(key)) {
        const choice = choices[Number(key) - 1];
        if (choice) chooseAugment(choice);
        return;
      }
      if (isSimulationRunning()) {
        keysRef.current.add(key);
      }
      if (["w", "a", "s", "d", "arrowup", "arrowdown", "arrowleft", "arrowright"].includes(key)) {
        inputRef.current.hasMoveTarget = false;
      }
      if ([" ", "arrowup", "arrowdown", "arrowleft", "arrowright"].includes(key)) {
        event.preventDefault();
      }
      if (key === " " && isSimulationRunning()) {
        inputRef.current.dashQueued = true;
      }
      if (
        (key === "e" || key === "enter") &&
        modeRef.current === "playing" &&
        !event.repeat
      ) {
        event.preventDefault();
        descendToNextFloor();
      }
      if (key === "b" && modeRef.current === "playing" && !event.repeat) {
        const shouldOpen = !(buildOpenRef.current && buildTab === "build");
        setInventoryScreenOpen(false);
        setStatsScreenOpen(false);
        setBuildTab("build");
        setBuildPanelOpen(shouldOpen);
      }
      if (key === "i" && modeRef.current === "playing" && !event.repeat) {
        const shouldOpen = !inventoryOpenRef.current;
        setBuildPanelOpen(false);
        setStatsScreenOpen(false);
        setInventoryScreenOpen(shouldOpen);
      }
      if (key === "c" && modeRef.current === "playing" && !event.repeat) {
        openStats();
      }
      if (key === "p" && modeRef.current === "playing" && !event.repeat) {
        openShop();
        return;
      }
      if (key === "m" && started && !event.repeat) {
        if (modeRef.current === "playing") openMap();
        else if (modeRef.current === "map") setGameMode("playing");
      }
      if (key === "escape" && started && !event.repeat) {
        if (shopOpenRef.current) closeShop();
        else if (statsOpenRef.current) setStatsScreenOpen(false);
        else if (inventoryOpenRef.current) setInventoryScreenOpen(false);
        else if (buildOpenRef.current) setBuildPanelOpen(false);
        else if (modeRef.current === "playing") setGameMode("paused");
        else if (modeRef.current === "paused" || modeRef.current === "map") {
          setGameMode("playing");
        }
      }
    };
    const onKeyUp = (event: KeyboardEvent) =>
      keysRef.current.delete(event.key.toLowerCase());
    const clearInputs = () => {
      keysRef.current.clear();
      inputRef.current.dashQueued = false;
    };
    window.addEventListener("keydown", onKeyDown, { passive: false });
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", clearInputs);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", clearInputs);
    };
  }, [
    buildTab,
    choices,
    chooseAugment,
    closeShop,
    closeGameConfirmation,
    descendToNextFloor,
    menuStage,
    openMap,
    openShop,
    openStats,
    isSimulationRunning,
    setBuildPanelOpen,
    setGameMode,
    setInventoryScreenOpen,
    setStatsScreenOpen,
    started,
  ]);

  useEffect(() => {
    if (mode !== "map") return;
    const frame = window.requestAnimationFrame(() => {
      const board = mapBoardRef.current;
      const current = board?.querySelector<HTMLElement>(".map-cell.is-current");
      if (!board || !current) return;
      const boardRect = board.getBoundingClientRect();
      const currentRect = current.getBoundingClientRect();
      board.scrollLeft +=
        currentRect.left - boardRect.left - board.clientWidth / 2 + currentRect.width / 2;
      board.scrollTop +=
        currentRect.top - boardRect.top - board.clientHeight / 2 + currentRect.height / 2;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [mapSnapshot, mode]);

  useEffect(() => {
    if (!started) return;
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    const roomVignette = context.createRadialGradient(
      WIDTH / 2,
      HEIGHT / 2,
      180,
      WIDTH / 2,
      HEIGHT / 2,
      735,
    );
    roomVignette.addColorStop(0, "rgba(0,0,0,0)");
    roomVignette.addColorStop(0.68, "rgba(0,0,0,.04)");
    roomVignette.addColorStop(1, "rgba(0,0,0,.54)");
    let frame = 0;
    let last = performance.now();
    let canvasCssScale = 1;
    const cacheCanvasCssScale = (renderedWidth: number, renderedHeight: number) => {
      if (renderedWidth <= 0 || renderedHeight <= 0) return;
      canvasCssScale = Math.max(
        0.01,
        Math.min(renderedWidth / WIDTH, renderedHeight / HEIGHT),
      );
    };
    const initialCanvasRect = canvas.getBoundingClientRect();
    cacheCanvasCssScale(initialCanvasRect.width, initialCanvasRect.height);
    const canvasResizeObserver = new ResizeObserver(([entry]) => {
      if (!entry) return;
      cacheCanvasCssScale(entry.contentRect.width, entry.contentRect.height);
    });
    canvasResizeObserver.observe(canvas);
    const readableCanvasFontSize = (basePx: number, minimumCssPx: number) =>
      Math.max(basePx, minimumCssPx / canvasCssScale);
    const lootVfxShowcaseMode = isLocalRarityShowcaseHost()
      ? new URLSearchParams(window.location.search).get("lootVfxShowcase")
      : null;
    const requestedLootVfxRarity = EQUIPMENT_RARITIES.find(
      (rarity) => rarity === lootVfxShowcaseMode,
    );
    const lootVfxShowcaseRarities =
      lootVfxShowcaseMode === "all"
        ? EQUIPMENT_RARITIES
        : requestedLootVfxRarity
          ? [requestedLootVfxRarity]
          : [];

    const spawnLegendaryEffect = (
      kind:
        | "mirrorBlock"
        | "mirrorWave"
        | "starfallBurst"
        | "bloodwovenBurst"
        | "ashboundShield"
        | "phantomTrail",
      x: number,
      y: number,
      duration: number,
      size: number,
      color: string,
      angle = 0,
      vfxId?: GameplayVfxId,
    ) => {
      const world = worldRef.current;
      const activeLegendaryEffects = world.effects.reduce(
        (count, effect) =>
          count +
          (effect.kind === "mirrorBlock" ||
          effect.kind === "mirrorWave" ||
          effect.kind === "starfallBurst" ||
          effect.kind === "bloodwovenBurst" ||
          effect.kind === "ashboundShield" ||
          effect.kind === "phantomTrail"
            ? 1
            : 0),
        0,
      );
      if (activeLegendaryEffects >= 28) return;
      world.effects.push({
        id: idRef.current++,
        kind,
        x,
        y,
        life: duration,
        duration,
        size,
        color,
        angle,
        vfxId,
      });
    };

    const damagePlayer = (amount: number) => {
      const player = playerRef.current;
      if (player.invulnerable > 0 || player.dashTime > 0) return;
      let mitigated = Math.min(amount, player.maxHp * 0.4);
      const equipmentStats = getEquipmentRuntimeCache(player.equipment).stats;
      mitigated *= 1 - Math.min(0.65, equipmentStats.damageReductionPercent / 100);
      mitigated *= 1 - Math.min(0.3, equipmentStats.cosmicAegisPercent / 100);
      if (hasLegendaryPower(player, "starfallMantle") && player.starfallMantleTime > 0) {
        mitigated *= LEGENDARY_RUNTIME.starfallIncomingMultiplier;
      }
      mitigated *= simpleDefenseDamageMultiplier(powerRankOf(player, "defense"));
      const armorRank = powerRankOf(player, "armor");
      mitigated /= Math.pow(1 + armorRank * 0.1, 0.62);
      if (player.hp / player.maxHp < 0.4) {
        const resolveRank = powerRankOf(player, "resolve");
        mitigated /= Math.pow(1 + resolveRank * 0.14, 0.6);
      }
      if (player.shield > 0) {
        const bulwarkRank = powerRankOf(player, "bulwark");
        mitigated /= Math.pow(1 + bulwarkRank * 0.12, 0.55);
      }
      const impact = mitigated;
      if (player.shield > 0) {
        const shieldHit = absorbTrackedShield(
          player.shield,
          player.ashboundShieldRemaining,
          mitigated,
        );
        player.shield = shieldHit.shield;
        player.ashboundShieldRemaining = shieldHit.trackedShield;
        amount = shieldHit.damageAfterShield;
      } else {
        amount = mitigated;
      }
      if (hasLegendaryPower(player, "mirrorAegis")) {
        const mirrorCounter = advanceLegendaryCounter(
          player.mirrorAegisHitCount,
          LEGENDARY_RUNTIME.mirrorHits,
        );
        player.mirrorAegisHitCount = mirrorCounter.count;
        if (mirrorCounter.triggered) {
          player.mirrorAegisBarrierTime = LEGENDARY_RUNTIME.mirrorBarrierSeconds;
          const waveDamage =
            (BASE_PLAYER_ATTACK_DAMAGE + equipmentStats.attackPowerFlat) *
            (1 + equipmentStats.damagePercent / 100) *
            LEGENDARY_RUNTIME.mirrorDamageMultiplier *
            legendaryAttackMultiplier(player);
          for (const enemy of worldRef.current.enemies) {
            if (distance(player.x, player.y, enemy.x, enemy.y) <= 190 + enemy.radius) {
              applyPlayerDamage(player, enemy, waveDamage, equipmentStats);
            }
          }
          spawnLegendaryEffect(
            "mirrorWave",
            player.x,
            player.y,
            0.62,
            210,
            "#8df7ff",
            0,
            legendaryVfxId("mirrorAegis"),
          );
          playGameSfx("playerCrit", { playbackRate: 0.78, gain: 1.08 });
          setToast("전설 · 거울 심장이 열려 2초간 적 투사체를 반사합니다.");
        }
      }
      if (
        player.hp - amount <= 0 &&
        player.legendaryArmorReady &&
        hasLegendaryPower(player, "lastMemory")
      ) {
        player.legendaryArmorReady = false;
        player.hp = Math.max(1, player.maxHp * 0.4);
        player.shield += player.maxHp * 0.12;
        player.invulnerable = 1.1;
        spawnLegendaryEffect(
          "ashboundShield",
          player.x,
          player.y,
          0.84,
          132,
          "#f4e5bb",
          0,
          legendaryVfxId("lastMemory"),
        );
        setToast("전설 · 마지막으로 남은 기억이 치명상을 되감았습니다.");
        return;
      }
      player.hp -= amount;
      playGameSfx("playerHit", {
        gain: impact > player.maxHp * 0.22 ? 1.12 : 0.9,
      });
      player.invulnerable = 0.6;
      setToast(`기억이 ${Math.ceil(impact)}만큼 찢겼습니다.`);
      if (player.hp <= 0) {
        player.hp = 0;
        setGameMode("dead");
      }
    };

    const spawnHostileProjectile = (
      x: number,
      y: number,
      angle: number,
      speed: number,
      damage: number,
      radius = 6,
      affinity: ProjectileAffinity = "enemy",
    ) => {
      const life = affinity === "boss" ? 5 : 4;
      const muzzleOffset = radius + (affinity === "boss" ? 18 : 12);
      const startX = x + Math.cos(angle) * muzzleOffset;
      const startY = y + Math.sin(angle) * muzzleOffset;
      playGameSfx("enemyShot", {
        pan: clamp((x - WIDTH / 2) / (WIDTH * 0.55), -0.75, 0.75),
        gain: affinity === "boss" ? 1.18 : affinity === "witch" ? 1.04 : 0.84,
        playbackRate: affinity === "boss" ? 0.86 : affinity === "witch" ? 1.12 : 1,
        priority: affinity === "boss" ? 6 : 2,
      });
      worldRef.current.projectiles.push({
        id: idRef.current++,
        x: startX,
        y: startY,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        radius,
        damage,
        life,
        pierce: 0,
        hostile: true,
        color: affinity === "boss" ? "#ff5961" : affinity === "witch" ? "#d66cff" : "#e14f55",
        affinity,
        vfxId: projectileVfxId(affinity),
        age: 0,
        maxLife: life,
        previousX: startX,
        previousY: startY,
        hit: new Set<number>(),
      });
    };

    const spawnVisualEffect = (
      kind: BehaviorEffectKind,
      x: number,
      y: number,
      duration: number,
      size: number,
    ) => {
      const world = worldRef.current;
      world.effects.push({
        id: idRef.current++,
        kind,
        x,
        y,
        life: duration,
        duration,
        size,
      });
      world.effectCounts[kind] += 1;
      if (kind === "summon") {
        playGameSfx("enemySummon", {
          pan: clamp((x - WIDTH / 2) / (WIDTH * 0.55), -0.7, 0.7),
        });
      } else if (kind === "teleport") {
        playGameSfx("enemyTeleport", {
          pan: clamp((x - WIDTH / 2) / (WIDTH * 0.55), -0.7, 0.7),
        });
      }
    };

    const spawnLootAwakening = (
      x: number,
      y: number,
      rarity: GearItem["rarity"],
    ) => {
      const world = worldRef.current;
      const activeLootEffects = world.effects.filter(
        (effect) => effect.kind === "lootAwakening",
      );
      if (activeLootEffects.length >= 18) {
        const incomingTier = EQUIPMENT_RARITY_TIER[rarity];
        const lowestPriorityEffect = activeLootEffects.reduce((lowest, effect) => {
          const lowestTier = EQUIPMENT_RARITY_TIER[lowest.rarity ?? "common"];
          const effectTier = EQUIPMENT_RARITY_TIER[effect.rarity ?? "common"];
          if (effectTier < lowestTier) return effect;
          if (effectTier === lowestTier && effect.life < lowest.life) return effect;
          return lowest;
        });
        const lowestTier = EQUIPMENT_RARITY_TIER[lowestPriorityEffect.rarity ?? "common"];
        if (incomingTier <= lowestTier) return;
        world.effects = world.effects.filter(
          (effect) => effect.id !== lowestPriorityEffect.id,
        );
      }
      const config = EQUIPMENT_RARITY_VFX[rarity];
      const duration = config.awakeningDuration;
      world.effects.push({
        id: idRef.current++,
        kind: "lootAwakening",
        x,
        y,
        life: duration,
        duration,
        size: config.awakeningSize,
        color: GEAR_RARITY_META[rarity].color,
        rarity,
      });
      playGearRaritySfx(rarity);
    };

    const spawnLocalLootVfxShowcase = () => {
      if (
        lootVfxShowcaseSpawnedRef.current ||
        lootVfxShowcaseRarities.length === 0 ||
        modeRef.current !== "playing"
      ) {
        return;
      }
      lootVfxShowcaseSpawnedRef.current = true;
      const showcasePositions = [
        { x: 220, y: 230 },
        { x: 500, y: 230 },
        { x: 780, y: 230 },
        { x: 1060, y: 230 },
        { x: 220, y: 500 },
        { x: 500, y: 500 },
        { x: 780, y: 500 },
        { x: 1060, y: 500 },
      ];
      const world = worldRef.current;
      world.enemies = [];
      world.projectiles = [];
      world.roomCleared = true;
      world.clearHandled = true;
      for (const [index, rarity] of lootVfxShowcaseRarities.entries()) {
        const position =
          lootVfxShowcaseRarities.length === 1
            ? { x: WIDTH / 2, y: HEIGHT / 2 + 70 }
            : showcasePositions[index];
        const safePosition = safeWalkableFloorPoint(
          position.x,
          position.y,
          GEAR_DROP_WALL_CLEARANCE,
        );
        const item = rollGear(`local-loot-vfx-${rarity}`, {
          level: Math.max(1, playerRef.current.level),
          rarity,
        });
        world.gearDrops.push({
          id: idRef.current++,
          x: safePosition.x,
          y: safePosition.y,
          item,
          pickupDelay: 30,
          appearanceAge: 0,
        });
        spawnLootAwakening(safePosition.x, safePosition.y, rarity);
      }
    };

    const spawnCombatEffect = (
      kind: CombatEffectKind,
      x: number,
      y: number,
      duration: number,
      size: number,
      color: string,
      angle = 0,
      endX?: number,
      endY?: number,
      vfxId?: GameplayVfxId,
    ) => {
      const world = worldRef.current;
      const combatEffectCount = world.effects.reduce(
        (count, effect) =>
          count +
          (effect.kind === "summon" ||
          effect.kind === "teleport" ||
          effect.kind === "lootAwakening"
            ? 0
            : 1),
        0,
      );
      if (
        combatEffectCount >= 120 &&
        kind !== "timeRiftTelegraph" &&
        kind !== "timeRiftBurst"
      ) {
        return;
      }
      world.effects.push({
        id: idRef.current++,
        kind,
        x,
        y,
        life: duration,
        duration,
        size,
        color,
        angle,
        endX,
        endY,
        vfxId,
      });
      if (kind === "timeRiftTelegraph" || kind === "timeRiftBurst") {
        playGameSfx("timeRift", {
          pan: clamp((x - WIDTH / 2) / (WIDTH * 0.55), -0.72, 0.72),
          playbackRate: kind === "timeRiftBurst" ? 0.88 : 1.08,
          gain: kind === "timeRiftBurst" ? 1.08 : 0.78,
        });
      }
    };

    const killEnemy = (enemy: Enemy) => {
      const player = playerRef.current;
      const world = worldRef.current;
      reconcileLegendaryRuntime(player);
      const equipmentStats = getEquipmentRuntimeCache(player.equipment).stats;
      const projectileSizeMultiplier =
        (1 + Math.min(150, equipmentStats.projectileSizePercent) / 100) *
        simpleAugmentMultiplier(
          powerRankOf(player, "expansion"),
          SIMPLE_AUGMENT_BONUSES.expansionProjectileSizePerRank,
        );
      player.kills += 1;
      playGameSfx(
        isBossKind(enemy.kind) || enemy.elite ? "enemyDeathHeavy" : "enemyDeath",
        {
          pan: clamp((enemy.x - WIDTH / 2) / (WIDTH * 0.55), -0.76, 0.76),
          gain: isBossKind(enemy.kind) ? 1.28 : enemy.elite ? 1.05 : 0.82,
          playbackRate: isBossKind(enemy.kind) ? 0.82 : enemy.elite ? 0.92 : 1,
          priority: isBossKind(enemy.kind) ? 10 : enemy.elite ? 6 : 2,
        },
      );
      const baseValue =
        isBossKind(enemy.kind)
          ? 80
          : enemy.elite
            ? 20
            : 7 + enemy.kind * 2;
      const scavengerRank = powerRankOf(player, "scavenger");
      const value = baseValue * Math.pow(1 + scavengerRank * 0.1, 0.75);
      const memoryDropPoint = safeWalkableFloorPoint(
        enemy.x,
        enemy.y,
        MEMORY_DROP_WALL_CLEARANCE,
      );
      world.orbs.push({
        id: idRef.current++,
        x: memoryDropPoint.x,
        y: memoryDropPoint.y,
        value,
      });
      const lootRoll = hash(
        world.seed,
        world.roomX + enemy.id,
        world.roomY - player.kills,
        2401,
      );
      const gearFindPercent = Math.max(
        0,
        Math.min(200, equipmentStats.gearFindPercent),
      );
      const dropSource =
        isBossKind(enemy.kind)
          ? "boss"
          : enemy.elite
            ? "elite"
            : "normal";
      const sourceChance =
        dropSource === "normal"
          ? Math.min(
              GEAR_DROP_SCAVENGER_CHANCE_CAP,
              GEAR_DROP_BASE_CHANCE.normal +
                scavengerRank * GEAR_DROP_SCAVENGER_CHANCE_PER_RANK,
            )
          : GEAR_DROP_BASE_CHANCE[dropSource];
      const gearDropChance =
        dropSource === "boss"
          ? 1
          : Math.min(
              GEAR_DROP_CHANCE_CAP[dropSource],
              sourceChance * (1 + gearFindPercent / 100),
            );
      const firstRoomDrop = isExpeditionStartingRoom({
        clearedRoomCount: player.rooms,
        roomX: world.roomX,
        roomY: world.roomY,
      });
      const survivingEnemyCount = world.enemies.reduce(
        (count, candidate) => count + (candidate.hp > 0 ? 1 : 0),
        0,
      );
      const forcedFirstRoomDrop = shouldForceFirstRoomGearDrop({
        clearedRoomCount: player.rooms,
        roomX: world.roomX,
        roomY: world.roomY,
        roomHasDroppedGear: firstRoomGearDroppedRef.current,
        survivingEnemyCount,
      });
      if (lootRoll < gearDropChance || forcedFirstRoomDrop) {
        const dropCount = isBossKind(enemy.kind) ? 2 : 1;
        for (let dropIndex = 0; dropIndex < dropCount; dropIndex += 1) {
          const rarityRoll = hash(world.seed, enemy.id, dropIndex, player.rooms + 331);
          const regularRarity = rollGearDropRarity(
            rarityRoll,
            dropSource,
            gearFindPercent,
            player.level,
          );
          const forcedRarity = firstRoomDrop
            ? rollFirstRoomGuaranteedRarity(rarityRoll)
            : regularRarity;
          const dropSeed = `${world.seed}:${world.roomX}:${world.roomY}:${enemy.id}:${dropIndex}`;
          const dropLevel = rollGearDropLevel(
            dropSeed,
            player.level,
            dropSource,
          );
          const item = rollGear(dropSeed, {
            level: dropLevel,
            rarity: forcedRarity,
          });
          const gearDropPoint = safeWalkableFloorPoint(
            enemy.x + (dropIndex - (dropCount - 1) / 2) * 52,
            enemy.y + 12,
            GEAR_DROP_WALL_CLEARANCE,
          );
          world.gearDrops.push({
            id: idRef.current++,
            x: gearDropPoint.x,
            y: gearDropPoint.y,
            item,
            pickupDelay: EQUIPMENT_RARITY_VFX[item.rarity].awakeningDuration + 0.18,
            appearanceAge: 0,
          });
          spawnLootAwakening(gearDropPoint.x, gearDropPoint.y, item.rarity);
          if (firstRoomDrop) firstRoomGearDroppedRef.current = true;
          if (item.rarity === "cosmic") {
            setToast(`${GEAR_RARITY_META[item.rarity].label} · ${formatGearDisplayName(item)}`);
          } else if (item.rarity === "mythic") {
            setToast(`신화 장비 강림 · ${formatGearDisplayName(item)}`);
          } else if (item.rarity === "legendary") {
            setToast(`전설 장비 발견 · ${formatGearDisplayName(item)}`);
          } else if (item.rarity === "epic") {
            setToast(
              `${GEAR_RARITY_META[item.rarity].label} 장비 발견 · ${formatGearDisplayName(item)}`,
            );
          }
        }
      }
      const predator = powerRankOf(player, "predator");
      if (predator > 0 && player.kills % Math.max(5, 18 - predator) === 0) {
        const heal = 2 + predator * 1.2;
        const cocoon = activeSynergies(player).find(
          (synergy) => synergy.name === "핏빛 번데기",
        );
        const missing = player.maxHp - player.hp;
        player.hp = Math.min(player.maxHp, player.hp + heal);
        if (cocoon && heal > missing) {
          player.shield += (heal - missing) * (1 + cocoon.tier * 0.25);
        }
      }
      const oil = powerRankOf(player, "oil");
      if (oil > 0) {
        const conflagration = activeSynergies(player).find(
          (synergy) => synergy.name === "대화재",
        );
        const burst =
          (12 + oil * 7 + powerRankOf(player, "ember") * 4) *
          (1 + (conflagration?.tier ?? 0) * 0.25) *
          legendaryAttackMultiplier(player);
        spawnCombatEffect(
          "playerImpact",
          enemy.x,
          enemy.y,
          0.38,
          58 + Math.min(62, oil * 7),
          "#ff7047",
          0,
          undefined,
          undefined,
          augmentVfxId("oil"),
        );
        for (const other of world.enemies) {
          if (other.id !== enemy.id && distance(enemy.x, enemy.y, other.x, other.y) < 118) {
            applyPlayerDamage(player, other, burst, equipmentStats);
          }
        }
      }
      const shrapnelRank = powerRankOf(player, "shrapnel");
      if (shrapnelRank > 0) {
        const shardCount = 2 + Math.min(6, shrapnelRank);
        const focusRank = powerRankOf(player, "focus");
        const homingRank = powerRankOf(player, "homing");
        const shardSpeed =
          430 *
          Math.pow(1 + focusRank * 0.06, 0.55) *
          simpleAugmentMultiplier(
            powerRankOf(player, "velocity"),
            SIMPLE_AUGMENT_BONUSES.velocityProjectileSpeedPerRank,
          ) *
          (1 + equipmentStats.projectileSpeedPercent / 100);
        const shardLife =
          (0.62 + focusRank * 0.025) *
          simpleAugmentMultiplier(
            powerRankOf(player, "range"),
            SIMPLE_AUGMENT_BONUSES.rangeProjectileLifePerRank,
          ) *
          (1 + equipmentStats.projectileLifetimePercent / 100);
        for (let i = 0; i < shardCount; i += 1) {
          const angle = (Math.PI * 2 * i) / shardCount + enemy.id * 0.73;
          world.projectiles.push({
            id: idRef.current++,
            x: enemy.x,
            y: enemy.y,
            vx: Math.cos(angle) * shardSpeed,
            vy: Math.sin(angle) * shardSpeed,
            radius: (3.5 + Math.min(3, shrapnelRank * 0.25)) * projectileSizeMultiplier,
            damage: (5 + shrapnelRank * 2.4) * legendaryAttackMultiplier(player),
            life: shardLife,
            pierce:
              Math.floor(shrapnelRank / 5) +
              Math.max(0, Math.floor(equipmentStats.pierceFlat)),
            hostile: false,
            color: "#ead9b8",
            affinity: "arcane",
            vfxId: augmentVfxId("shrapnel"),
            age: 0,
            maxLife: shardLife,
            previousX: enemy.x,
            previousY: enemy.y,
            hit: new Set<number>([enemy.id]),
            homing:
              homingRank > 0 || equipmentStats.homingStrengthFlat > 0
                ? Math.min(
                    14,
                    (homingRank > 0 ? 1.8 + homingRank * 0.55 : 0) +
                      equipmentStats.homingStrengthFlat,
                  )
                : undefined,
          });
        }
      }
    };

    const firePlayerWeapon = () => {
      const player = playerRef.current;
      const world = worldRef.current;
      const aimRecently = performance.now() - inputRef.current.lastAim < 850;
      let target: Enemy | undefined;
      let best = Infinity;
      for (const enemy of world.enemies) {
        if (enemy.hp <= 0) continue;
        const d = distance(player.x, player.y, enemy.x, enemy.y);
        if (aimRecently) {
          const aimAngle = Math.atan2(
            inputRef.current.aimY - player.y,
            inputRef.current.aimX - player.x,
          );
          const enemyAngle = Math.atan2(enemy.y - player.y, enemy.x - player.x);
          const delta = Math.abs(
            Math.atan2(Math.sin(enemyAngle - aimAngle), Math.cos(enemyAngle - aimAngle)),
          );
          const score = d + delta * 290;
          if (delta < 0.72 && score < best) {
            best = score;
            target = enemy;
          }
        } else if (d < best) {
          best = d;
          target = enemy;
        }
      }
      if (!target) return false;
      const baseAngle = Math.atan2(target.y - player.y, target.x - player.x);
      const bloodwovenBurst =
        hasLegendaryPower(player, "bloodwovenGrip") && player.bloodwovenBurstReady;
      if (bloodwovenBurst) player.bloodwovenBurstReady = false;
      const equipmentStats = getEquipmentRuntimeCache(player.equipment).stats;
      const projectileSizeMultiplier =
        (1 + Math.min(150, equipmentStats.projectileSizePercent) / 100) *
        simpleAugmentMultiplier(
          powerRankOf(player, "expansion"),
          SIMPLE_AUGMENT_BONUSES.expansionProjectileSizePerRank,
        );
      const splitRank = powerRankOf(player, "split");
      const gearProjectileCount = Math.max(
        0,
        Math.floor(equipmentStats.projectileCountFlat),
      );
      const gearPierce = Math.max(0, Math.floor(equipmentStats.pierceFlat));
      const theoreticalCount = 1 + splitRank + gearProjectileCount;
      const visibleCount = Math.min(9, theoreticalCount);
      const overflowCount = theoreticalCount / visibleCount;
      const hasteRank = powerRankOf(player, "haste");
      const missingHealthRatio = 1 - player.hp / player.maxHp;
      const frenzyRank = powerRankOf(player, "frenzy");
      const theoreticalRate =
        1.4 *
        Math.pow(1 + 0.14 * hasteRank, 0.7) *
        Math.pow(1 + frenzyRank * missingHealthRatio * 0.12, 0.65) *
        simpleAugmentMultiplier(
          powerRankOf(player, "rapidfire"),
          SIMPLE_AUGMENT_BONUSES.rapidfireAttackSpeedPerRank,
        ) *
        (1 + equipmentStats.attackSpeedPercent / 100) *
        (1 + equipmentStats.cosmicActionSpeedPercent / 100);
      const visibleRate = Math.min(12, theoreticalRate);
      const overflowRate = Math.max(1, theoreticalRate / visibleRate);
      const bloodRank = powerRankOf(player, "blood");
      const missingHealthBonus =
        bloodRank > 0 ? missingHealthRatio * bloodRank * 0.2 : 0;
      const synergyPower = activeSynergies(player).reduce(
        (sum, synergy) => sum + synergy.tier * 0.06,
        0,
      );
      const returnRank = powerRankOf(player, "return");
      const timeRank = powerRankOf(player, "time");
      const focusRank = powerRankOf(player, "focus");
      const caliberRank = powerRankOf(player, "caliber");
      const homingRank = powerRankOf(player, "homing");
      const rangeRank = powerRankOf(player, "range");
      const velocityRank = powerRankOf(player, "velocity");
      const overchargeRank = powerRankOf(player, "overcharge");
      const chargePeriod = Math.max(3, 8 - Math.min(5, overchargeRank));
      const overcharged =
        overchargeRank > 0 && (player.shotCounter + 1) % chargePeriod === 0;
      const stormRank = powerRankOf(player, "storm");
      const emberRank = powerRankOf(player, "ember");
      const frostRank = powerRankOf(player, "frost");
      const poisonRank = powerRankOf(player, "poison");
      const projectileAffinity: ProjectileAffinity =
        stormRank > 0
          ? "storm"
          : emberRank > 0
            ? "ember"
            : frostRank > 0
              ? "frost"
              : poisonRank > 0
                ? "poison"
                : "arcane";
      const attackVfxId: GameplayVfxId = overcharged
        ? augmentVfxId("overcharge")
        : stormRank > 0
          ? augmentVfxId("storm")
          : emberRank > 0
            ? augmentVfxId("ember")
            : frostRank > 0
              ? augmentVfxId("frost")
              : poisonRank > 0
                ? augmentVfxId("poison")
                : projectileVfxId("arcane");
      const projectileColor =
        projectileAffinity === "storm"
          ? "#b59aff"
          : projectileAffinity === "ember"
            ? "#ff744f"
            : projectileAffinity === "frost"
              ? "#8ee8ff"
              : projectileAffinity === "poison"
                ? "#7ee48d"
                : "#72ead0";
      const echoShot =
        timeRank > 0 &&
        (player.shotCounter + 1) % Math.max(2, 6 - Math.min(4, timeRank)) === 0;
      let damage =
        (BASE_PLAYER_ATTACK_DAMAGE + equipmentStats.attackPowerFlat) *
        (1 + powerRankOf(player, "fang") * 0.18) *
        (1 + bloodRank * 0.14 + missingHealthBonus) *
        (1 + powerRankOf(player, "ember") * 0.08) *
        (1 + powerRankOf(player, "poison") * 0.06) *
        (1 + timeRank * 0.07) *
        (1 + returnRank * 0.04) *
        (1 + powerRankOf(player, "map") * 0.06) *
        (1 + focusRank * 0.025) *
        (1 + caliberRank * 0.045) *
        simpleAugmentMultiplier(
          powerRankOf(player, "strength"),
          SIMPLE_AUGMENT_BONUSES.strengthDamagePerRank,
        ) *
        (overcharged ? 1.35 + overchargeRank * 0.045 : 1) *
        (1 + synergyPower) *
        (1 + equipmentStats.damagePercent / 100) *
        overflowCount *
        overflowRate *
        legendaryAttackMultiplier(player);
      const eyeRank = powerRankOf(player, "eye");
      const critChance = clamp(
        0.05 +
          0.45 * (1 - Math.exp(-0.18 * eyeRank)) +
          equipmentStats.critChancePercent / 100,
        0,
        0.75,
      );
      const isCritical = Math.random() < critChance;
      if (isCritical) {
        damage *= 1.7 + eyeRank * 0.1 + equipmentStats.critDamagePercent / 100;
        playGameSfx("playerCrit", { playbackRate: overcharged ? 0.92 : 1 });
      }
      const criticalVolleyId = isCritical ? idRef.current++ : undefined;
      const spread = Math.min(0.62, visibleCount * 0.07);
      const projectileSpeed =
        660 *
        Math.pow(1 + focusRank * 0.06, 0.55) *
        simpleAugmentMultiplier(
          velocityRank,
          SIMPLE_AUGMENT_BONUSES.velocityProjectileSpeedPerRank,
        ) *
        (1 + equipmentStats.projectileSpeedPercent / 100);
      const projectileLife =
        (1.15 + returnRank * 0.14) *
        Math.pow(1 + focusRank * 0.035, 0.5) *
        simpleAugmentMultiplier(
          rangeRank,
          SIMPLE_AUGMENT_BONUSES.rangeProjectileLifePerRank,
        ) *
        (1 + equipmentStats.projectileLifetimePercent / 100);
      const homingStrength =
        (homingRank > 0 ? Math.min(10, 1.8 + homingRank * 0.55) : 0) +
        equipmentStats.homingStrengthFlat;
      const chargedColor = overcharged ? "#ff7764" : projectileColor;
      playGameSfx("playerShot", {
        gain: overcharged ? 1.15 : 0.88,
        playbackRate: overcharged ? 0.88 : 1 + Math.min(0.12, visibleRate / 100),
      });
      spawnCombatEffect(
        "muzzle",
        player.x,
        player.y - 8,
        0.2,
        28 + Math.min(18, visibleCount * 2),
        chargedColor,
        baseAngle,
        undefined,
        undefined,
        attackVfxId,
      );
      for (let i = 0; i < visibleCount; i += 1) {
        const angle =
          baseAngle +
          (visibleCount === 1 ? 0 : -spread / 2 + (spread * i) / (visibleCount - 1));
        world.projectiles.push({
          id: idRef.current++,
          x: player.x,
          y: player.y - 8,
          vx: Math.cos(angle) * projectileSpeed,
          vy: Math.sin(angle) * projectileSpeed,
          radius:
            (5 +
              Math.min(5, powerRankOf(player, "fang")) +
              Math.min(5, caliberRank * 0.55)) *
            projectileSizeMultiplier,
          damage,
          life: projectileLife,
          pierce: powerRankOf(player, "pierce") + gearPierce,
          hostile: false,
          color: chargedColor,
          affinity: projectileAffinity,
          vfxId: attackVfxId,
          age: 0,
          maxLife: projectileLife,
          previousX: player.x,
          previousY: player.y - 8,
          hit: new Set<number>(),
          returnAfter: returnRank > 0 ? 0.58 : undefined,
          returning: false,
          returnMultiplier: 0.45 + returnRank * 0.1,
          homing: homingStrength > 0 ? Math.min(14, homingStrength) : undefined,
          criticalVolleyId,
          bloodwovenEligible:
            isCritical && hasLegendaryPower(player, "bloodwovenGrip"),
        });
        if (echoShot) {
          const echoProjectileLife =
            1.05 *
            simpleAugmentMultiplier(
              rangeRank,
              SIMPLE_AUGMENT_BONUSES.rangeProjectileLifePerRank,
            ) *
            (1 + equipmentStats.projectileLifetimePercent / 100);
          world.projectiles.push({
            id: idRef.current++,
            x: player.x,
            y: player.y - 8,
            vx: Math.cos(angle) * projectileSpeed * 0.92,
            vy: Math.sin(angle) * projectileSpeed * 0.92,
            radius: (4 + Math.min(4, timeRank)) * projectileSizeMultiplier,
            damage: damage * (0.45 + timeRank * 0.07),
            life: echoProjectileLife,
            pierce: powerRankOf(player, "pierce") + gearPierce,
            hostile: false,
            color: "#d0a9ee",
            affinity: "echo",
            vfxId: augmentVfxId("time"),
            age: 0,
            maxLife: echoProjectileLife,
            previousX: player.x,
            previousY: player.y - 8,
            hit: new Set<number>(),
            homing: homingStrength > 0 ? Math.min(14, homingStrength) : undefined,
          });
        }
      }
      if (bloodwovenBurst) {
        const burstCount = LEGENDARY_RUNTIME.bloodwovenProjectileCount;
        const burstSpread = 0.34;
        for (let index = 0; index < burstCount; index += 1) {
          const angle =
            baseAngle +
            (burstCount === 1
              ? 0
              : -burstSpread / 2 + (burstSpread * index) / (burstCount - 1));
          world.projectiles.push({
            id: idRef.current++,
            x: player.x,
            y: player.y - 8,
            vx: Math.cos(angle) * projectileSpeed * 1.04,
            vy: Math.sin(angle) * projectileSpeed * 1.04,
            radius: 5.5 * projectileSizeMultiplier,
            damage: damage * LEGENDARY_RUNTIME.bloodwovenDamageMultiplier,
            life: projectileLife,
            pierce:
              Math.max(0, Math.floor(powerRankOf(player, "pierce") / 2)) +
              gearPierce,
            hostile: false,
            color: "#ff5f8f",
            affinity: "blood",
            vfxId: legendaryVfxId("bloodwovenGrip"),
            age: 0,
            maxLife: projectileLife,
            previousX: player.x,
            previousY: player.y - 8,
            hit: new Set<number>(),
            homing: homingStrength > 0 ? Math.min(13, homingStrength) : undefined,
          });
        }
        spawnLegendaryEffect(
          "bloodwovenBurst",
          player.x,
          player.y - 8,
          0.42,
          82,
          "#ff477f",
          baseAngle,
          legendaryVfxId("bloodwovenGrip"),
        );
        playGameSfx("playerCrit", { playbackRate: 0.72, gain: 1.12 });
      }
      if (
        hasLegendaryPower(player, "crescentEcho") &&
        (player.shotCounter + 1) % 5 === 0
      ) {
        for (const offset of [-0.34, 0.34]) {
          const angle = baseAngle + offset;
          world.projectiles.push({
            id: idRef.current++,
            x: player.x,
            y: player.y - 8,
            vx: Math.cos(angle) * projectileSpeed * 0.94,
            vy: Math.sin(angle) * projectileSpeed * 0.94,
            radius: 6 * projectileSizeMultiplier,
            damage: damage * 0.65,
            life: projectileLife,
            pierce: 1 + Math.floor(powerRankOf(player, "pierce") / 2) + gearPierce,
            hostile: false,
            color: "#f0b86e",
            affinity: "echo",
            vfxId: legendaryVfxId("crescentEcho"),
            age: 0,
            maxLife: projectileLife,
            previousX: player.x,
            previousY: player.y - 8,
            hit: new Set<number>(),
            homing: homingStrength > 0 ? Math.min(12, homingStrength) : undefined,
          });
        }
      }
      player.shotCounter += 1;
      player.fireCooldown += 1 / visibleRate;
      return true;
    };

    const completeRoom = () => {
      const world = worldRef.current;
      const player = playerRef.current;
      if (world.clearHandled) return;
      const equipmentStats = aggregateEquipmentStats(player.equipment);
      world.clearHandled = true;
      world.roomCleared = true;
      world.doorMotion = beginRoomDoorOpening(world.doorMotion);
      world.doorEffects = [];
      playGameSfx("roomClear", { priority: 7 });
      world.rooms[keyOf(world.roomX, world.roomY)].cleared = true;
      world.clearedRoomCount += 1;
      player.rooms += 1;
      const conquestRank = powerRankOf(player, "conquest");
      const moonBeacon = activeSynergies(player).find(
        (synergy) => synergy.name === "달빛 봉화",
      );
      const heal =
        (4 +
          powerRankOf(player, "map") * 2 +
          conquestRank * 1.2 +
          powerRankOf(player, "recovery") *
            SIMPLE_AUGMENT_BONUSES.recoveryRoomHealPerRank +
          equipmentStats.roomClearHealFlat) *
        (1 + (moonBeacon?.tier ?? 0) * 0.08);
      player.hp = Math.min(player.maxHp, player.hp + heal);
      if (conquestRank > 0) {
        const shieldCap =
          10 +
          powerRankOf(player, "glass") * 9 +
          powerRankOf(player, "ward") * 5 +
          conquestRank * 4 +
          equipmentStats.roomEntryShieldFlat;
        player.shield = Math.min(
          shieldCap,
          player.shield +
            conquestRank * 1.8 * (1 + (moonBeacon?.tier ?? 0) * 0.08),
        );
      }
      gainXp(14 + player.rooms * 1.5);
      setToast(`방 정복 · 기억 ${Math.round(14 + player.rooms * 1.5)} · 문이 열렸습니다.`);

      if (world.roomKind === "boss") {
        player.bossesCleared += 1;
        if (
          shouldRevealFirstBossEnding(
            world.roomKind,
            world.activeBossKind,
            player.endingVersion,
          )
        ) {
          setEndingChapterIndex(0);
          pendingEndingRef.current = true;
          if (modeRef.current === "playing") {
            pendingEndingRef.current = false;
            setGameMode("ending");
          }
        }
        return;
      }
      const beats: Record<number, [string, string, string]> = {
        3: [
          "1막 · 끝을 찾는 자",
          "다른 탐험가의 기억",
          "쓰러진 적에게서 흘러나온 증강은 이상할 만큼 하린의 손에 익숙했다. 마치 이미 수백 번 골라 본 것처럼.",
        ],
        6: [
          "2막 · 길을 먹는 자",
          "쉼터지기의 고백",
          "“그 기억들은 다른 사람 것이 아니야. 전부 여기서 길을 잃었던 너희들이지.” 지도는 하린이 강해질수록 더 빠르게 그녀를 배웠다.",
        ],
      };
      const beat = beats[player.rooms];
      if (beat) {
        pendingStoryRef.current = {
          eyebrow: beat[0],
          title: beat[1],
          body: beat[2],
        };
        if (modeRef.current === "playing") {
          pendingStoryRef.current = null;
          showStory(beat[0], beat[1], beat[2], () => setGameMode("playing"));
        }
      }
    };

    const update = (dt: number) => {
      if (!isSimulationRunning()) return;
      const player = playerRef.current;
      const world = worldRef.current;
      // Equipment changes only on explicit inventory/forge actions. Keep the
      // aggregate and cosmetic loadout stable across the 60 FPS loop.
      const equipmentStats = getEquipmentRuntimeCache(player.equipment).stats;
      world.transition = Math.max(0, world.transition - dt);
      // Keep the raised gate behind the first half of the room-crossfade, then
      // visibly slam it down as the new room is revealed. Collision is already
      // locked while the motion is in `closing`, so visuals and traversal stay honest.
      if (
        world.doorMotion.phase !== "closing" ||
        world.transition <= ROOM_DOOR_CLOSE_REVEAL_TRANSITION
      ) {
        world.doorMotion = advanceRoomDoorMotion(world.doorMotion, dt);
      }
      for (const effect of world.doorEffects) effect.life -= dt;
      compactPositiveFieldInPlace(world.doorEffects, "life");
      for (const effect of world.effects) effect.life -= dt;
      compactPositiveFieldInPlace(world.effects, "life");
      for (const drop of world.gearDrops) {
        drop.pickupDelay = Math.max(0, drop.pickupDelay - dt);
        const revealDuration = EQUIPMENT_RARITY_VFX[drop.item.rarity].awakeningDuration;
        drop.appearanceAge = Math.min(
          revealDuration + 1,
          (drop.appearanceAge ?? 0) + dt,
        );
      }
      player.fireCooldown -= dt;
      if (world.enemies.length === 0) {
        player.fireCooldown = Math.max(0, player.fireCooldown);
      }
      player.invulnerable = Math.max(0, player.invulnerable - dt);
      player.dashCooldown = Math.max(0, player.dashCooldown - dt);
      player.dashTime = Math.max(0, player.dashTime - dt);
      player.riftTrailCooldown = Math.max(0, player.riftTrailCooldown - dt);
      player.mirrorAegisBarrierTime = Math.max(0, player.mirrorAegisBarrierTime - dt);
      player.starfallMantleTime = Math.max(0, player.starfallMantleTime - dt);
      player.hunterSigilPulseCooldown = Math.max(
        0,
        (player.hunterSigilPulseCooldown ?? 0) - dt,
      );
      player.phantomMarchTrailCooldown = Math.max(
        0,
        player.phantomMarchTrailCooldown - dt,
      );
      if (player.ashboundShieldTime > 0) {
        player.ashboundShieldTime = Math.max(0, player.ashboundShieldTime - dt);
        if (player.ashboundShieldTime === 0) clearAshboundShield(player);
      }
      const regenerationRank = powerRankOf(player, "regeneration");
      const regenerationPerSecond =
        regenerationRank * 0.14 + equipmentStats.hpRegenPerSecondFlat;
      if (regenerationPerSecond > 0 && player.hp > 0) {
        player.hp = Math.min(
          player.maxHp,
          player.hp + regenerationPerSecond * dt,
        );
      }
      const keys = keysRef.current;
      let moveX =
        (keys.has("d") || keys.has("arrowright") ? 1 : 0) -
        (keys.has("a") || keys.has("arrowleft") ? 1 : 0);
      let moveY =
        (keys.has("s") || keys.has("arrowdown") ? 1 : 0) -
        (keys.has("w") || keys.has("arrowup") ? 1 : 0);
      let rawMoveLength = Math.hypot(moveX, moveY);
      if (rawMoveLength === 0 && inputRef.current.hasMoveTarget) {
        const targetDx = inputRef.current.moveTargetX - player.x;
        const targetDy = inputRef.current.moveTargetY - player.y;
        const targetDistance = Math.hypot(targetDx, targetDy);
        if (targetDistance > 12) {
          moveX = targetDx / targetDistance;
          moveY = targetDy / targetDistance;
          rawMoveLength = 1;
        } else {
          inputRef.current.hasMoveTarget = false;
        }
      }
      const moveLength = rawMoveLength || 1;
      moveX /= moveLength;
      moveY /= moveLength;
      const phantomMarchActive =
        hasLegendaryPower(player, "phantomMarch") &&
        player.phantomMarchMoveTime >= LEGENDARY_RUNTIME.phantomActivationSeconds;
      const boots = powerRankOf(player, "boots");
      const momentumRank = powerRankOf(player, "momentum");
      const reflexRank = powerRankOf(player, "reflex");
      const moveSpeed =
        245 *
        Math.pow(1 + boots * 0.07, 0.55) *
        Math.pow(1 + momentumRank * 0.065, 0.55) *
        simpleAugmentMultiplier(
          powerRankOf(player, "sprint"),
          SIMPLE_AUGMENT_BONUSES.sprintMoveSpeedPerRank,
        ) *
        (1 + equipmentStats.moveSpeedPercent / 100) *
        (1 + equipmentStats.cosmicActionSpeedPercent / 100) *
        (phantomMarchActive ? LEGENDARY_RUNTIME.phantomMoveMultiplier : 1);

      if (inputRef.current.dashQueued && player.dashCooldown <= 0) {
        inputRef.current.dashQueued = false;
        player.dashX = moveX || Math.cos(Math.atan2(inputRef.current.aimY - player.y, inputRef.current.aimX - player.x));
        player.dashY = moveY || Math.sin(Math.atan2(inputRef.current.aimY - player.y, inputRef.current.aimX - player.x));
        player.dashTime = 0.17 + 0.075 * (1 - Math.exp(-0.12 * reflexRank));
        playGameSfx("playerDash", {
          pan: clamp(player.dashX * 0.45, -0.45, 0.45),
          playbackRate: 1 + Math.min(0.12, reflexRank * 0.008),
        });
        player.invulnerable = player.dashTime + 0.03;
        player.dashCooldown =
          1.35 /
          (Math.pow(1 + boots * 0.08, 0.6) *
            Math.pow(1 + reflexRank * 0.11, 0.55) *
            (1 + equipmentStats.dashCooldownPercent / 100) *
            (hasLegendaryPower(player, "riftStride") ? 1.3 : 1));
        if (hasLegendaryPower(player, "riftStride")) player.riftTrailCooldown = 0;
        if (hasLegendaryPower(player, "starfallMantle")) {
          player.starfallMantleTime = LEGENDARY_RUNTIME.starfallSeconds;
          spawnLegendaryEffect(
            "starfallBurst",
            player.x,
            player.y,
            0.54,
            118,
            "#f8d98a",
            0,
            legendaryVfxId("starfallMantle"),
          );
          playGameSfx("playerDash", { playbackRate: 1.28, gain: 0.7 });
        }
        const voidRank = powerRankOf(player, "void");
        if (voidRank > 0) {
          spawnCombatEffect(
            "playerImpact",
            player.x,
            player.y,
            0.42,
            126,
            "#8b5ecc",
            0,
            undefined,
            undefined,
            augmentVfxId("void"),
          );
          const comet = activeSynergies(player).find(
            (synergy) => synergy.name === "혜성 자국",
          );
          for (const enemy of world.enemies) {
            if (distance(player.x, player.y, enemy.x, enemy.y) < 125) {
              applyPlayerDamage(
                player,
                enemy,
                (8 + voidRank * 5) *
                (1 + (comet?.tier ?? 0) * 0.28) *
                legendaryAttackMultiplier(player),
                equipmentStats,
              );
              if (comet) enemy.slow = Math.max(enemy.slow, 0.8);
            }
          }
        }
      } else {
        inputRef.current.dashQueued = false;
      }

      const speed =
        player.dashTime > 0
          ? 900 *
            Math.pow(1 + reflexRank * 0.05, 0.4) *
            (1 + equipmentStats.dashSpeedPercent / 100)
          : moveSpeed;
      const dx = player.dashTime > 0 ? player.dashX : moveX;
      const dy = player.dashTime > 0 ? player.dashY : moveY;
      const previousPlayerX = player.x;
      const previousPlayerY = player.y;
      player.x += dx * speed * dt;
      player.y += dy * speed * dt;
      if (
        player.dashTime > 0 &&
        player.riftTrailCooldown <= 0 &&
        hasLegendaryPower(player, "riftStride")
      ) {
        player.riftTrailCooldown = 0.055;
        const riftDamage =
          (BASE_PLAYER_ATTACK_DAMAGE + equipmentStats.attackPowerFlat) *
          (1 + equipmentStats.damagePercent / 100) *
          0.4 *
          legendaryAttackMultiplier(player);
        spawnCombatEffect(
          "playerImpact",
          player.x,
          player.y + 8,
          0.3,
          52,
          "#bd6cff",
          0,
          undefined,
          undefined,
          legendaryVfxId("riftStride"),
        );
        for (const enemy of world.enemies) {
          if (distance(player.x, player.y, enemy.x, enemy.y) < 72) {
            applyPlayerDamage(player, enemy, riftDamage, equipmentStats);
          }
        }
      }
      const doors = dungeonDoorAccess(
        world.roomX,
        world.roomY,
        roomDoorsPassable(world.doorMotion),
      );
      const inHorizontalDoor =
        player.y > ROOM_GEOMETRY.horizontalDoorTop &&
        player.y < ROOM_GEOMETRY.horizontalDoorBottom;
      const inVerticalDoor =
        player.x > ROOM_GEOMETRY.verticalDoorLeft &&
        player.x < ROOM_GEOMETRY.verticalDoorRight;
      if (roomDoorsPassable(world.doorMotion) && world.transition <= 0) {
        if (
          doors.west &&
          player.x < ROOM_GEOMETRY.transitionInsetX &&
          inHorizontalDoor
        ) {
          roomEnterRef.current(world.roomX - 1, world.roomY, "right");
          return;
        }
        if (
          doors.east &&
          player.x > WIDTH - ROOM_GEOMETRY.transitionInsetX &&
          inHorizontalDoor
        ) {
          roomEnterRef.current(world.roomX + 1, world.roomY, "left");
          return;
        }
        if (
          doors.north &&
          player.y < ROOM_GEOMETRY.transitionInsetY &&
          inVerticalDoor
        ) {
          roomEnterRef.current(world.roomX, world.roomY - 1, "top");
          return;
        }
        if (
          doors.south &&
          player.y > HEIGHT - ROOM_GEOMETRY.transitionInsetY &&
          inVerticalDoor
        ) {
          roomEnterRef.current(world.roomX, world.roomY + 1, "bottom");
          return;
        }
      }
      constrainPlayerToWalkableFloor(player, doors);
      const actualMoveX = player.x - previousPlayerX;
      const actualMoveY = player.y - previousPlayerY;
      const playerMotion = resolveCharacterMotion(
        actualMoveX,
        actualMoveY,
        player.facing,
        0.05,
      );
      player.moving = playerMotion.moving;
      player.facing = playerMotion.facing;
      player.walkCycle = playerMotion.moving
        ? advanceCharacterWalkCycle(
            player.walkCycle,
            playerMotion.distance,
            player.dashTime > 0 ? 220 : undefined,
            dt,
          )
        : settleCharacterWalkCycle(player.walkCycle);
      const actuallyMoved = playerMotion.moving;
      player.phantomMarchMoveTime = advanceContinuousMovement(
        player.phantomMarchMoveTime,
        dt,
        hasLegendaryPower(player, "phantomMarch") && actuallyMoved,
        LEGENDARY_RUNTIME.phantomActivationSeconds,
      );
      const phantomMarchNowActive =
        hasLegendaryPower(player, "phantomMarch") &&
        player.phantomMarchMoveTime >= LEGENDARY_RUNTIME.phantomActivationSeconds;
      if (
        phantomMarchNowActive &&
        actuallyMoved &&
        player.phantomMarchTrailCooldown <= 0
      ) {
        player.phantomMarchTrailCooldown = 0.4;
        const trailDamage =
          (BASE_PLAYER_ATTACK_DAMAGE + equipmentStats.attackPowerFlat) *
          (1 + equipmentStats.damagePercent / 100) *
          LEGENDARY_RUNTIME.phantomTrailDamageMultiplier *
          legendaryAttackMultiplier(player);
        spawnLegendaryEffect(
          "phantomTrail",
          previousPlayerX,
          previousPlayerY + 8,
          0.95,
          74,
          "#a68cff",
          Math.atan2(actualMoveY, actualMoveX),
          legendaryVfxId("phantomMarch"),
        );
        for (const enemy of world.enemies) {
          if (distance(previousPlayerX, previousPlayerY, enemy.x, enemy.y) < 54) {
            applyPlayerDamage(player, enemy, trailDamage, equipmentStats);
          }
        }
      }

      let catchUpShots = 0;
      while (player.fireCooldown <= 0 && catchUpShots < 4) {
        if (!firePlayerWeapon()) {
          player.fireCooldown = 0;
          break;
        }
        catchUpShots += 1;
      }

      const now = performance.now();
      for (const enemy of world.enemies) {
        enemy.slow = Math.max(0, enemy.slow - dt);
        enemy.orbitalCooldown = Math.max(0, enemy.orbitalCooldown - dt);
        enemy.shootCooldown -= dt;
        if (enemy.patternTimer !== undefined) enemy.patternTimer -= dt;
        if (enemy.poisonTime > 0) {
          enemy.poisonTime -= dt;
          applyPlayerDamage(
            player,
            enemy,
            enemy.poisonDamage * dt * legendaryAttackMultiplier(player),
            equipmentStats,
          );
        }
        const angle = Math.atan2(player.y - enemy.y, player.x - enemy.x);
        const d = distance(player.x, player.y, enemy.x, enemy.y);
        if (enemy.kind === BLANK_CARTOGRAPHER_KIND) {
          // The boss serializes every inherited attack through one FSM. No
          // projectile, teleport, summon, rift burst, or charge hit is emitted
          // until its authored telegraph phase has completed.
          const bossPhase = enemy.bossPhase ?? "pursuit";
          const healthRatio = clamp(enemy.hp / enemy.maxHp, 0, 1);
          const recoveryMultiplier =
            healthRatio > 0.66 ? 1 : healthRatio > 0.33 ? 0.9 : 0.8;
          const beginRecovery = (duration = BLANK_CARTOGRAPHER_RECOVERY_SECONDS) => {
            enemy.bossPhase = "recovery";
            enemy.patternTimer = duration * recoveryMultiplier;
            enemy.patternHit = false;
            enemy.timeRifts = [];
            enemy.bossSummonTargets = [];
          };
          const moveBoss = (speedMultiplier: number) => {
            const preferredDistance = 305;
            const radialCorrection = clamp(
              (d - preferredDistance) / 165,
              -0.48,
              0.68,
            );
            const strafeDirection =
              (enemy.bossPatternIndex ?? 0) % 2 === 0 ? 1 : -1;
            const strafeStrength = 0.38 * strafeDirection;
            let enemyMoveX =
              Math.cos(angle) * radialCorrection +
              Math.cos(angle + Math.PI / 2) * strafeStrength;
            let enemyMoveY =
              Math.sin(angle) * radialCorrection +
              Math.sin(angle + Math.PI / 2) * strafeStrength;
            const moveMagnitude = Math.hypot(enemyMoveX, enemyMoveY) || 1;
            enemyMoveX /= moveMagnitude;
            enemyMoveY /= moveMagnitude;
            const slowMultiplier = enemy.slow > 0 ? 0.58 : 1;
            enemy.x +=
              enemyMoveX * enemy.speed * speedMultiplier * slowMultiplier * dt;
            enemy.y +=
              enemyMoveY * enemy.speed * speedMultiplier * slowMultiplier * dt;
            enemy.moving = true;
            enemy.facing = directionRow(enemyMoveX, enemyMoveY, enemy.facing);
            enemy.walkCycle =
              (enemy.walkCycle +
                dt * (5.2 + enemy.speed / 44) * speedMultiplier * slowMultiplier) %
              4;
          };

          if (bossPhase === "pursuit") {
            moveBoss(0.9);
            if ((enemy.patternTimer ?? 0) <= 0) {
              const patternIndex = enemy.bossPatternIndex ?? 0;
              const nextPattern = blankCartographerPatternAt(patternIndex);
              const telegraphSeconds =
                BLANK_CARTOGRAPHER_TELEGRAPH_SECONDS[nextPattern];
              enemy.bossPattern = nextPattern;
              enemy.bossPatternIndex = patternIndex + 1;
              enemy.patternHit = false;
              enemy.moving = false;
              playGameSfx(
                nextPattern === "timeRifts"
                  ? "timeRift"
                  : nextPattern === "teleport"
                    ? "enemyTeleport"
                    : nextPattern === "charge"
                      ? "enemyCharge"
                      : "enemyShot",
                { gain: 1.12, priority: 7 },
              );

              if (nextPattern === "timeRifts") {
                enemy.timeRifts = Array.from(
                  { length: BLANK_CARTOGRAPHER_RIFT_COUNT },
                  (_, index) => {
                    const delay = index * TIME_RIFT_SEQUENCE_GAP * 0.82;
                    const predictionDistance =
                      rawMoveLength > 0 || player.dashTime > 0
                        ? Math.min(245, speed * (0.38 + index * 0.17))
                        : index === 0
                          ? 0
                          : 58 + index * 24;
                    const spreadAngle = angle + (index - 1.5) * 0.24;
                    return {
                      x: clamp(
                        player.x + Math.cos(spreadAngle) * predictionDistance,
                        96,
                        WIDTH - 96,
                      ),
                      y: clamp(
                        player.y + Math.sin(spreadAngle) * predictionDistance,
                        92,
                        HEIGHT - 92,
                      ),
                      delay,
                      timer: telegraphSeconds,
                      telegraphed: false,
                      triggered: false,
                    };
                  },
                );
                enemy.bossPhase = "timeRifts";
                enemy.patternTimer =
                  telegraphSeconds +
                  TIME_RIFT_SEQUENCE_GAP * 0.82 *
                    (BLANK_CARTOGRAPHER_RIFT_COUNT - 1);
              } else {
                enemy.bossPhase = "telegraph";
                enemy.patternTimer = telegraphSeconds;

                if (nextPattern === "teleport") {
                  let bestTargetX = enemy.x;
                  let bestTargetY = enemy.y;
                  let bestTargetDistance = 0;
                  for (let targetIndex = 0; targetIndex < 8; targetIndex += 1) {
                    const targetAngle =
                      hash(
                        world.seed,
                        enemy.id,
                        patternIndex * 17 + targetIndex,
                        player.rooms + 5401,
                      ) *
                      Math.PI *
                      2;
                    const targetRadius =
                      250 +
                      hash(
                        world.seed,
                        targetIndex,
                        enemy.id,
                        patternIndex + 5419,
                      ) *
                        105;
                    const candidate = safeWalkableFloorPoint(
                      clamp(
                        player.x + Math.cos(targetAngle) * targetRadius,
                        108,
                        WIDTH - 108,
                      ),
                      clamp(
                        player.y + Math.sin(targetAngle) * targetRadius,
                        104,
                        HEIGHT - 104,
                      ),
                      enemy.radius,
                    );
                    const candidateX = candidate.x;
                    const candidateY = candidate.y;
                    const candidateDistance = distance(
                      player.x,
                      player.y,
                      candidateX,
                      candidateY,
                    );
                    if (candidateDistance > bestTargetDistance) {
                      bestTargetDistance = candidateDistance;
                      bestTargetX = candidateX;
                      bestTargetY = candidateY;
                    }
                  }
                  enemy.patternTargetX = bestTargetX;
                  enemy.patternTargetY = bestTargetY;
                  spawnVisualEffect(
                    "teleport",
                    enemy.x,
                    enemy.y + 8,
                    telegraphSeconds,
                    188,
                  );
                  spawnVisualEffect(
                    "teleport",
                    bestTargetX,
                    bestTargetY + 8,
                    telegraphSeconds,
                    202,
                  );
                } else if (nextPattern === "summon") {
                  const activeAdds = world.enemies.filter(
                    (candidate) =>
                      !isBossKind(candidate.kind) &&
                      candidate.hp > 0,
                  ).length;
                  const summonCount = Math.max(
                    0,
                    Math.min(
                      BLANK_CARTOGRAPHER_SUMMON_COUNT,
                      4 - activeAdds,
                    ),
                  );
                  enemy.bossSummonTargets = Array.from(
                    { length: summonCount },
                    (_, index) => {
                      const summonAngle =
                        angle + Math.PI / 2 + index * Math.PI;
                      const target = safeWalkableFloorPoint(
                        clamp(
                          enemy.x + Math.cos(summonAngle) * 132,
                          104,
                          WIDTH - 104,
                        ),
                        clamp(
                          enemy.y + Math.sin(summonAngle) * 106,
                          100,
                          HEIGHT - 100,
                        ),
                        SUMMON_WALL_CLEARANCE,
                      );
                      spawnVisualEffect(
                        "summon",
                        target.x,
                        target.y + 8,
                        telegraphSeconds,
                        168,
                      );
                      return target;
                    },
                  );
                } else if (nextPattern === "charge") {
                  const prediction =
                    player.dashTime > 0 ? 210 : rawMoveLength > 0 ? 145 : 36;
                  const predictedX = clamp(
                    player.x + dx * prediction,
                    96,
                    WIDTH - 96,
                  );
                  const predictedY = clamp(
                    player.y + dy * prediction,
                    92,
                    HEIGHT - 92,
                  );
                  const chargeAngle = Math.atan2(
                    predictedY - enemy.y,
                    predictedX - enemy.x,
                  );
                  enemy.patternX = Math.cos(chargeAngle);
                  enemy.patternY = Math.sin(chargeAngle);
                  enemy.facing = directionRow(
                    enemy.patternX,
                    enemy.patternY,
                    enemy.facing,
                  );
                } else {
                  spawnCombatEffect(
                    "timeRiftTelegraph",
                    enemy.x,
                    enemy.y + 14,
                    telegraphSeconds,
                    nextPattern === "radialVolley" ? 226 : 176,
                    nextPattern === "radialVolley" ? "#ff5961" : "#e6bc75",
                  );
                }
              }
            }
          } else if (bossPhase === "telegraph") {
            enemy.moving = false;
            enemy.walkCycle = 1;
            if ((enemy.patternTimer ?? 0) <= 0) {
              const pattern = enemy.bossPattern;
              if (pattern === "aimedVolley") {
                const aimedAngle = Math.atan2(
                  player.y - enemy.y,
                  player.x - enemy.x,
                );
                for (let shotIndex = -1; shotIndex <= 1; shotIndex += 1) {
                  spawnHostileProjectile(
                    enemy.x,
                    enemy.y,
                    aimedAngle + shotIndex * 0.13,
                    315,
                    enemy.damage * 0.9,
                    8,
                    "boss",
                  );
                }
                beginRecovery(0.95);
              } else if (pattern === "teleport") {
                enemy.x = enemy.patternTargetX ?? enemy.x;
                enemy.y = enemy.patternTargetY ?? enemy.y;
                spawnVisualEffect("teleport", enemy.x, enemy.y + 8, 0.72, 214);
                const teleportAngle = Math.atan2(
                  player.y - enemy.y,
                  player.x - enemy.x,
                );
                for (let shotIndex = -1; shotIndex <= 1; shotIndex += 1) {
                  spawnHostileProjectile(
                    enemy.x,
                    enemy.y,
                    teleportAngle + shotIndex * 0.12,
                    365,
                    enemy.damage * 0.82,
                    9,
                    "boss",
                  );
                }
                beginRecovery(1.05);
              } else if (pattern === "summon") {
                const activeAdds = world.enemies.filter(
                  (candidate) =>
                    !isBossKind(candidate.kind) &&
                    candidate.hp > 0,
                ).length;
                const allowedSummons = Math.max(
                  0,
                  Math.min(
                    BLANK_CARTOGRAPHER_SUMMON_COUNT,
                    4 - activeAdds,
                  ),
                );
                for (const [summonIndex, target] of (
                  enemy.bossSummonTargets ?? []
                )
                  .slice(0, allowedSummons)
                  .entries()) {
                  world.enemies.push(
                    makeEnemy(
                      summonIndex % 2 === 0 ? 0 : 1,
                      target.x,
                      target.y,
                      player.rooms,
                    ),
                  );
                }
                beginRecovery(1.12);
              } else if (pattern === "radialVolley") {
                const projectileCount =
                  healthRatio > 0.66 ? 8 : healthRatio > 0.33 ? 12 : 16;
                for (let shotIndex = 0; shotIndex < projectileCount; shotIndex += 1) {
                  spawnHostileProjectile(
                    enemy.x,
                    enemy.y,
                    (Math.PI * 2 * shotIndex) / projectileCount + now / 1800,
                    215 + (1 - healthRatio) * 82,
                    enemy.damage * 0.78,
                    7,
                    "boss",
                  );
                }
                beginRecovery(1.42);
              } else if (pattern === "charge") {
                enemy.bossPhase = "charge";
                enemy.patternTimer = 0.48;
                enemy.patternHit = false;
              } else {
                beginRecovery();
              }
            }
          } else if (bossPhase === "charge") {
            const previousEnemyX = enemy.x;
            const previousEnemyY = enemy.y;
            const chargeSpeed = 650;
            enemy.x += (enemy.patternX ?? 0) * chargeSpeed * dt;
            enemy.y += (enemy.patternY ?? 1) * chargeSpeed * dt;
            const chargeHitWall = constrainEnemyToWalkableFloor(enemy);
            enemy.moving = true;
            enemy.walkCycle = (enemy.walkCycle + dt * 14) % 4;
            enemy.facing = directionRow(
              enemy.patternX ?? 0,
              enemy.patternY ?? 1,
              enemy.facing,
            );
            if (
              !enemy.patternHit &&
              distanceToSegment(
                player.x,
                player.y,
                previousEnemyX,
                previousEnemyY,
                enemy.x,
                enemy.y,
              ) <
                player.radius + enemy.radius * 0.68
            ) {
              enemy.patternHit = true;
              damagePlayer(enemy.damage * 1.35);
            }
            if (chargeHitWall || (enemy.patternTimer ?? 0) <= 0) beginRecovery(0.92);
          } else if (bossPhase === "timeRifts") {
            moveBoss(0.38);
            const timeRifts = enemy.timeRifts ?? [];
            for (const rift of timeRifts) {
              if (rift.triggered) continue;
              rift.delay = Math.max(0, rift.delay - dt);
              if (!rift.telegraphed && rift.delay <= 0) {
                rift.telegraphed = true;
                spawnCombatEffect(
                  "timeRiftTelegraph",
                  rift.x,
                  rift.y,
                  BLANK_CARTOGRAPHER_TELEGRAPH_SECONDS.timeRifts,
                  TIME_RIFT_RADIUS * 2.18,
                  "#ff6b87",
                );
              } else if (rift.telegraphed) {
                rift.timer -= dt;
                if (rift.timer <= 0) {
                  rift.triggered = true;
                  spawnCombatEffect(
                    "timeRiftBurst",
                    rift.x,
                    rift.y,
                    0.56,
                    TIME_RIFT_RADIUS * 2.9,
                    "#ff3e69",
                  );
                  if (
                    distance(player.x, player.y, rift.x, rift.y) <
                    TIME_RIFT_RADIUS + player.radius
                  ) {
                    damagePlayer(enemy.damage * 1.14);
                  }
                  for (let missileIndex = 0; missileIndex < 6; missileIndex += 1) {
                    spawnHostileProjectile(
                      rift.x,
                      rift.y,
                      (Math.PI * 2 * missileIndex) / 6 + now / 2100,
                      238,
                      enemy.damage * 0.48,
                      6,
                      "boss",
                    );
                  }
                }
              }
            }
            if (
              timeRifts.length === BLANK_CARTOGRAPHER_RIFT_COUNT &&
              timeRifts.every((rift) => rift.triggered)
            ) {
              beginRecovery(1.08);
            }
          } else {
            moveBoss(0.48);
            if ((enemy.patternTimer ?? 0) <= 0) {
              enemy.bossPhase = "pursuit";
              enemy.bossPattern = undefined;
              enemy.patternTimer = 0.92 * recoveryMultiplier;
            }
          }
        } else if (enemy.kind === FINAL_BINDER_KIND) {
          // The post-ending boss attacks the arena itself. Every damaging
          // geometry is derived from the same pure helper used by the floor VFX.
          const binderPhase = enemy.binderPhase ?? "pursuit";
          const healthRatio = clamp(enemy.hp / enemy.maxHp, 0, 1);
          const tempoMultiplier = healthRatio > 0.4 ? 1 : 0.82;
          const moveBinder = (speedMultiplier: number) => {
            const preferredDistance = 318;
            const radialCorrection = clamp(
              (d - preferredDistance) / 170,
              -0.46,
              0.62,
            );
            const strafeDirection = enemy.binderDirection ?? 1;
            let enemyMoveX =
              Math.cos(angle) * radialCorrection +
              Math.cos(angle + Math.PI / 2) * strafeDirection * 0.34;
            let enemyMoveY =
              Math.sin(angle) * radialCorrection +
              Math.sin(angle + Math.PI / 2) * strafeDirection * 0.34;
            const moveMagnitude = Math.hypot(enemyMoveX, enemyMoveY) || 1;
            enemyMoveX /= moveMagnitude;
            enemyMoveY /= moveMagnitude;
            const slowMultiplier = enemy.slow > 0 ? 0.58 : 1;
            enemy.x +=
              enemyMoveX * enemy.speed * speedMultiplier * slowMultiplier * dt;
            enemy.y +=
              enemyMoveY * enemy.speed * speedMultiplier * slowMultiplier * dt;
            enemy.moving = true;
            enemy.facing = directionRow(enemyMoveX, enemyMoveY, enemy.facing);
            enemy.walkCycle =
              (enemy.walkCycle +
                dt * (5 + enemy.speed / 46) * speedMultiplier * slowMultiplier) %
              4;
          };
          const beginBinderRecovery = () => {
            enemy.binderPhase = "recovery";
            enemy.patternTimer = FINAL_BINDER_RECOVERY_SECONDS * tempoMultiplier;
            enemy.patternHit = false;
          };

          if (binderPhase === "pursuit") {
            moveBinder(0.92);
            if ((enemy.patternTimer ?? 0) <= 0) {
              const patternIndex = enemy.binderPatternIndex ?? 0;
              const nextPattern = finalBinderPatternAt(patternIndex);
              const direction = enemy.binderDirection ?? 1;
              enemy.binderPattern = nextPattern;
              enemy.binderPatternIndex = patternIndex + 1;
              enemy.binderPhase = "telegraph";
              enemy.patternTimer = FINAL_BINDER_TELEGRAPH_SECONDS[nextPattern];
              enemy.patternHit = false;
              enemy.moving = false;
              playGameSfx(
                nextPattern === "chapterTurn" ? "timeRift" : "enemyCharge",
                { playbackRate: 0.86, gain: 1.16, priority: 8 },
              );

              if (nextPattern === "pageWall") {
                const wallCastIndex = Math.floor(patternIndex / 3);
                const axis: FinalBinderAxis =
                  wallCastIndex % 2 === 0 ? "horizontal" : "vertical";
                enemy.binderAxis = axis;
                enemy.binderSafeCenter =
                  axis === "horizontal"
                    ? clamp(player.x + (WIDTH / 2 - player.x) * 0.42, 196, WIDTH - 196)
                    : clamp(player.y + (HEIGHT / 2 - player.y) * 0.42, 166, HEIGHT - 166);
              } else if (nextPattern === "threadSweep") {
                enemy.binderStartAngle =
                  angle - direction * FINAL_BINDER_THREAD_SWEEP_ARC * 0.52;
              } else {
                enemy.binderPulseIndex = 0;
                enemy.binderInitialSafeSector = positiveModulo(
                  Math.round(angle / (Math.PI / 2)),
                  4,
                );
              }
            }
          } else if (binderPhase === "telegraph") {
            enemy.moving = false;
            enemy.walkCycle = 1;
            if ((enemy.patternTimer ?? 0) <= 0) {
              if (enemy.binderPattern === "pageWall") {
                enemy.binderPhase = "pageWall";
                enemy.patternTimer = FINAL_BINDER_PAGE_WALL_SECONDS;
              } else if (enemy.binderPattern === "threadSweep") {
                enemy.binderPhase = "threadSweep";
                enemy.patternTimer = FINAL_BINDER_THREAD_SWEEP_SECONDS;
              } else {
                enemy.binderPhase = "chapterBurst";
                enemy.patternTimer = FINAL_BINDER_CHAPTER_BURST_SECONDS;
              }
              enemy.patternHit = false;
            }
          } else if (binderPhase === "pageWall") {
            enemy.moving = false;
            enemy.walkCycle = 1;
            const wallProgress = clamp(
              1 - (enemy.patternTimer ?? 0) / FINAL_BINDER_PAGE_WALL_SECONDS,
              0,
              1,
            );
            const wallSegments = finalBinderPageWallSegments(
              enemy.binderAxis ?? "horizontal",
              enemy.binderDirection ?? 1,
              wallProgress,
              enemy.binderSafeCenter ?? (enemy.binderAxis === "vertical" ? player.y : player.x),
              WIDTH,
              HEIGHT,
            );
            if (
              !enemy.patternHit &&
              wallSegments.some(
                (segment) =>
                  distanceToSegment(
                    player.x,
                    player.y,
                    segment.startX,
                    segment.startY,
                    segment.endX,
                    segment.endY,
                  ) <
                  player.radius + FINAL_BINDER_PAGE_WALL_HALF_WIDTH,
              )
            ) {
              enemy.patternHit = true;
              damagePlayer(enemy.damage);
            }
            if ((enemy.patternTimer ?? 0) <= 0) beginBinderRecovery();
          } else if (binderPhase === "threadSweep") {
            enemy.moving = false;
            enemy.walkCycle = 1;
            const sweepProgress = clamp(
              1 - (enemy.patternTimer ?? 0) / FINAL_BINDER_THREAD_SWEEP_SECONDS,
              0,
              1,
            );
            const sweep = finalBinderThreadSweepSegment(
              enemy.x,
              enemy.y,
              enemy.binderStartAngle ?? angle,
              enemy.binderDirection ?? 1,
              sweepProgress,
            );
            if (
              !enemy.patternHit &&
              distanceToSegment(
                player.x,
                player.y,
                sweep.startX,
                sweep.startY,
                sweep.endX,
                sweep.endY,
              ) <
                player.radius + FINAL_BINDER_THREAD_HALF_WIDTH
            ) {
              enemy.patternHit = true;
              damagePlayer(enemy.damage * 1.12);
            }
            if ((enemy.patternTimer ?? 0) <= 0) beginBinderRecovery();
          } else if (binderPhase === "chapterBurst") {
            enemy.moving = false;
            enemy.walkCycle = 1;
            const pulseIndex = enemy.binderPulseIndex ?? 0;
            const safeSector = finalBinderChapterSafeSector(
              enemy.binderInitialSafeSector ?? 0,
              enemy.binderDirection ?? 1,
              pulseIndex,
            );
            if (
              !enemy.patternHit &&
              finalBinderChapterHits(
                player.x,
                player.y,
                enemy.x,
                enemy.y,
                safeSector,
              )
            ) {
              enemy.patternHit = true;
              damagePlayer(enemy.damage * 0.55);
            }
            if ((enemy.patternTimer ?? 0) <= 0) {
              const nextPulse = pulseIndex + 1;
              if (nextPulse < FINAL_BINDER_CHAPTER_PULSES) {
                enemy.binderPulseIndex = nextPulse;
                enemy.binderPhase = "telegraph";
                enemy.patternTimer = FINAL_BINDER_TELEGRAPH_SECONDS.chapterTurn;
                enemy.patternHit = false;
              } else {
                beginBinderRecovery();
              }
            }
          } else {
            moveBinder(0.42);
            if ((enemy.patternTimer ?? 0) <= 0) {
              enemy.binderPhase = "pursuit";
              enemy.binderPattern = undefined;
              enemy.patternTimer = 0.94 * tempoMultiplier;
              enemy.binderDirection = enemy.binderDirection === -1 ? 1 : -1;
            }
          }
        } else if (enemy.kind === PALIMPSEST_ARCHIVIST_KIND) {
          const currentArchivist = enemy.archivist ?? createPalimpsestState();
          if (currentArchivist.phase === "pursuit") {
            const preferredDistance = 286;
            const radialCorrection = clamp(
              (d - preferredDistance) / 155,
              -0.46,
              0.64,
            );
            const strafeDirection = currentArchivist.patternIndex % 2 === 0 ? 1 : -1;
            let enemyMoveX =
              Math.cos(angle) * radialCorrection +
              Math.cos(angle + Math.PI / 2) * strafeDirection * 0.42;
            let enemyMoveY =
              Math.sin(angle) * radialCorrection +
              Math.sin(angle + Math.PI / 2) * strafeDirection * 0.42;
            const moveMagnitude = Math.hypot(enemyMoveX, enemyMoveY) || 1;
            enemyMoveX /= moveMagnitude;
            enemyMoveY /= moveMagnitude;
            const slowMultiplier = enemy.slow > 0 ? 0.58 : 1;
            enemy.x += enemyMoveX * enemy.speed * slowMultiplier * dt;
            enemy.y += enemyMoveY * enemy.speed * slowMultiplier * dt;
            enemy.moving = true;
            enemy.facing = directionRow(enemyMoveX, enemyMoveY, enemy.facing);
            enemy.walkCycle =
              (enemy.walkCycle + dt * (5.1 + enemy.speed / 44) * slowMultiplier) % 4;
          } else {
            enemy.moving = false;
            enemy.walkCycle = 1;
            enemy.facing = directionRow(
              player.x - enemy.x,
              player.y - enemy.y,
              enemy.facing,
            );
          }

          const safeAnchors = [
            safeWalkableFloorPoint(WIDTH * 0.28, HEIGHT * 0.31, 40),
            safeWalkableFloorPoint(WIDTH * 0.72, HEIGHT * 0.31, 40),
            safeWalkableFloorPoint(WIDTH * 0.72, HEIGHT * 0.69, 40),
            safeWalkableFloorPoint(WIDTH * 0.28, HEIGHT * 0.69, 40),
          ];
          const archivistStep = advancePalimpsestArchivist(currentArchivist, {
            dt,
            seed: world.seed ^ enemy.id,
            castIndex: currentArchivist.castIndex,
            hpRatio: clamp(enemy.hp / enemy.maxHp, 0, 1),
            previousPlayerPosition: { x: previousPlayerX, y: previousPlayerY },
            playerPosition: { x: player.x, y: player.y },
            bossPosition: { x: enemy.x, y: enemy.y },
            playerRadius: player.radius,
            safeAnchors,
          });
          enemy.archivist = archivistStep.state;
          for (const command of archivistStep.commands) {
            if (command.type === "damage") {
              damagePlayer(enemy.damage * command.multiplier);
              continue;
            }
            if (command.kind === "warning") {
              const patternLabel =
                PALIMPSEST_ARCHIVIST_PATTERN_LABELS[archivistStep.state.pattern];
              setToast(`덧쓴 기록관 · ${patternLabel} — 빛나는 기록선을 확인하세요.`);
              playGameSfx("timeRift", {
                pan: clamp((enemy.x - WIDTH / 2) / (WIDTH * 0.55), -0.7, 0.7),
                playbackRate: 0.76,
                gain: 1.12,
                priority: 8,
              });
            } else if (command.kind === "traceRecord") {
              playGameSfx("enemyCharge", { playbackRate: 0.72, gain: 0.9 });
            } else if (command.kind === "traceStrike") {
              playGameSfx("playerImpact", { playbackRate: 0.68, gain: 1.15 });
            } else if (command.kind === "proofRoute") {
              setToast("교정 경로 — 숫자가 새겨진 룬을 1번부터 차례대로 밟으세요.");
              playGameSfx("timeRift", { playbackRate: 1.18, gain: 1.04 });
            } else if (command.kind === "proofSuccess") {
              setToast("교정 완료 — 기록관의 잉크가 오래 멎습니다.");
              playGameSfx("uiConfirm", { playbackRate: 0.82, gain: 0.9 });
            } else if (command.kind === "proofFailure") {
              setToast("교정 실패 — 잘못된 순서가 공격으로 덧씌워졌습니다.");
              playGameSfx("enemyCharge", { playbackRate: 0.62, gain: 1.12 });
            }
          }
        } else if (enemy.kind === 6) {
          const phase = enemy.patternPhase ?? "stalk";
          if (phase === "stalk") {
            const approach = d > 355 ? 0.72 : d < 235 ? -0.42 : 0.08;
            const strafe = Math.sin(now / 620 + enemy.id) * 0.34;
            let enemyMoveX = Math.cos(angle) * approach + Math.cos(angle + Math.PI / 2) * strafe;
            let enemyMoveY = Math.sin(angle) * approach + Math.sin(angle + Math.PI / 2) * strafe;
            const moveMagnitude = Math.hypot(enemyMoveX, enemyMoveY) || 1;
            enemyMoveX /= moveMagnitude;
            enemyMoveY /= moveMagnitude;
            const slowMultiplier = enemy.slow > 0 ? 0.58 : 1;
            enemy.x += enemyMoveX * enemy.speed * slowMultiplier * dt;
            enemy.y += enemyMoveY * enemy.speed * slowMultiplier * dt;
            enemy.moving = true;
            enemy.facing = directionRow(enemyMoveX, enemyMoveY, enemy.facing);
            enemy.walkCycle =
              (enemy.walkCycle + dt * (5.8 + enemy.speed / 42) * slowMultiplier) % 4;
            if ((enemy.patternTimer ?? 0) <= 0) {
              const prediction = player.dashTime > 0 ? 190 : rawMoveLength > 0 ? 125 : 24;
              const predictedX = clamp(player.x + dx * prediction, 96, WIDTH - 96);
              const predictedY = clamp(player.y + dy * prediction, 92, HEIGHT - 92);
              const chargeAngle = Math.atan2(predictedY - enemy.y, predictedX - enemy.x);
              enemy.patternX = Math.cos(chargeAngle);
              enemy.patternY = Math.sin(chargeAngle);
              enemy.patternPhase = "windup";
              playGameSfx("enemyCharge", {
                pan: clamp((enemy.x - WIDTH / 2) / (WIDTH * 0.55), -0.7, 0.7),
              });
              enemy.patternTimer = 0.82;
              enemy.patternHit = false;
              enemy.facing = directionRow(enemy.patternX, enemy.patternY, enemy.facing);
            }
          } else if (phase === "windup") {
            enemy.moving = false;
            enemy.walkCycle = 1;
            if ((enemy.patternTimer ?? 0) <= 0) {
              enemy.patternPhase = "charge";
              enemy.patternTimer = 0.48;
            }
          } else if (phase === "charge") {
            const previousEnemyX = enemy.x;
            const previousEnemyY = enemy.y;
            const chargeSpeed = enemy.elite ? 760 : 680;
            enemy.x += (enemy.patternX ?? 0) * chargeSpeed * dt;
            enemy.y += (enemy.patternY ?? 1) * chargeSpeed * dt;
            const chargeHitWall = constrainEnemyToWalkableFloor(enemy);
            enemy.moving = true;
            enemy.walkCycle = (enemy.walkCycle + dt * 15) % 4;
            enemy.facing = directionRow(
              enemy.patternX ?? 0,
              enemy.patternY ?? 1,
              enemy.facing,
            );
            if (
              !enemy.patternHit &&
              distanceToSegment(
                player.x,
                player.y,
                previousEnemyX,
                previousEnemyY,
                enemy.x,
                enemy.y,
              ) <
                player.radius + enemy.radius * 0.75
            ) {
              enemy.patternHit = true;
              damagePlayer(enemy.damage * 1.45);
            }
            if (chargeHitWall || (enemy.patternTimer ?? 0) <= 0) {
              enemy.patternPhase = "recover";
              enemy.patternTimer = 0.88;
            }
          } else {
            enemy.moving = false;
            enemy.walkCycle = 1;
            if ((enemy.patternTimer ?? 0) <= 0) {
              enemy.patternPhase = "stalk";
              enemy.patternTimer = 1.35 + hash(world.seed, enemy.id, player.rooms, 6607) * 0.9;
              enemy.patternHit = false;
            }
          }
        } else if (enemy.kind === 7) {
          const phase = enemy.patternPhase ?? "orbit";
          const preferredDistance = 320;
          const radialCorrection = clamp((d - preferredDistance) / 135, -0.62, 0.62);
          const strafeDirection = enemy.patternX ?? 1;
          const strafeStrength = phase === "riftWindup" ? 0.58 : 0.78;
          let enemyMoveX =
            Math.cos(angle) * radialCorrection +
            Math.cos(angle + Math.PI / 2) * strafeDirection * strafeStrength;
          let enemyMoveY =
            Math.sin(angle) * radialCorrection +
            Math.sin(angle + Math.PI / 2) * strafeDirection * strafeStrength;
          const moveMagnitude = Math.hypot(enemyMoveX, enemyMoveY) || 1;
          enemyMoveX /= moveMagnitude;
          enemyMoveY /= moveMagnitude;
          const slowMultiplier = enemy.slow > 0 ? 0.58 : 1;
          enemy.x += enemyMoveX * enemy.speed * slowMultiplier * dt;
          enemy.y += enemyMoveY * enemy.speed * slowMultiplier * dt;
          enemy.moving = true;
          enemy.facing = directionRow(enemyMoveX, enemyMoveY, enemy.facing);
          enemy.walkCycle =
            (enemy.walkCycle + dt * (5.6 + enemy.speed / 40) * slowMultiplier) % 4;

          if (phase === "orbit" && (enemy.patternTimer ?? 0) <= 0) {
            playGameSfx("timeRift", {
              pan: clamp((enemy.x - WIDTH / 2) / (WIDTH * 0.55), -0.7, 0.7),
              playbackRate: 1.08,
            });
            enemy.timeRifts = Array.from({ length: 3 }, (_, index) => {
              const delay = index * TIME_RIFT_SEQUENCE_GAP;
              const predictionDistance =
                rawMoveLength > 0 || player.dashTime > 0
                  ? Math.min(225, speed * (0.42 + index * 0.2))
                  : 0;
              return {
                x: clamp(player.x + dx * predictionDistance, 96, WIDTH - 96),
                y: clamp(player.y + dy * predictionDistance, 92, HEIGHT - 92),
                delay,
                timer: TIME_RIFT_WARNING_SECONDS,
                telegraphed: false,
                triggered: false,
              };
            });
            enemy.patternPhase = "riftWindup";
            enemy.patternTimer =
              TIME_RIFT_WARNING_SECONDS + TIME_RIFT_SEQUENCE_GAP * 2;
          }

          const timeRifts = enemy.timeRifts ?? [];
          for (const rift of timeRifts) {
            if (rift.triggered) continue;
            rift.delay = Math.max(0, rift.delay - dt);
            if (!rift.telegraphed && rift.delay <= 0) {
              rift.telegraphed = true;
              spawnCombatEffect(
                "timeRiftTelegraph",
                rift.x,
                rift.y,
                TIME_RIFT_WARNING_SECONDS,
                TIME_RIFT_RADIUS * 2,
                "#63f7ff",
              );
            } else if (rift.telegraphed) {
              rift.timer -= dt;
              if (rift.timer <= 0) {
                rift.triggered = true;
                spawnCombatEffect(
                  "timeRiftBurst",
                  rift.x,
                  rift.y,
                  0.52,
                  TIME_RIFT_RADIUS * 2.7,
                  "#f05bff",
                );
                if (
                  distance(player.x, player.y, rift.x, rift.y) <
                  TIME_RIFT_RADIUS + player.radius
                ) {
                  damagePlayer(enemy.damage * (enemy.elite ? 1.42 : 1.24));
                }
              }
            }
          }
          if (timeRifts.length === 3 && timeRifts.every((rift) => rift.triggered)) {
            enemy.timeRifts = [];
            enemy.patternPhase = "orbit";
            enemy.patternTimer =
              2.25 + hash(world.seed, enemy.id, player.rooms, player.kills + 7707) * 1.35;
            enemy.patternX = -(enemy.patternX ?? 1);
          }
        } else if (enemy.kind === MARGIN_SEVERER_KIND) {
          const phase = enemy.patternPhase ?? "orbit";
          if (phase === "orbit") {
            const preferredDistance = 305;
            const radialCorrection = clamp(
              (d - preferredDistance) / 145,
              -0.58,
              0.66,
            );
            const strafeDirection = enemy.strafeDirection ?? 1;
            const strafeStrength = 0.72 * strafeDirection;
            let enemyMoveX =
              Math.cos(angle) * radialCorrection +
              Math.cos(angle + Math.PI / 2) * strafeStrength;
            let enemyMoveY =
              Math.sin(angle) * radialCorrection +
              Math.sin(angle + Math.PI / 2) * strafeStrength;
            const moveMagnitude = Math.hypot(enemyMoveX, enemyMoveY) || 1;
            enemyMoveX /= moveMagnitude;
            enemyMoveY /= moveMagnitude;
            const slowMultiplier = enemy.slow > 0 ? 0.58 : 1;
            enemy.x += enemyMoveX * enemy.speed * slowMultiplier * dt;
            enemy.y += enemyMoveY * enemy.speed * slowMultiplier * dt;
            enemy.moving = true;
            enemy.facing = directionRow(enemyMoveX, enemyMoveY, enemy.facing);
            enemy.walkCycle =
              (enemy.walkCycle + dt * (5.5 + enemy.speed / 42) * slowMultiplier) % 4;

            if ((enemy.patternTimer ?? 0) <= 0) {
              const playerIsMoving = rawMoveLength > 0 || player.dashTime > 0;
              const predictionDistance =
                playerIsMoving
                  ? Math.min(155, speed * (player.dashTime > 0 ? 0.2 : 0.34))
                  : 0;
              enemy.patternTargetX = clamp(
                player.x + dx * predictionDistance,
                96,
                WIDTH - 96,
              );
              enemy.patternTargetY = clamp(
                player.y + dy * predictionDistance,
                92,
                HEIGHT - 92,
              );
              enemy.patternX = playerIsMoving ? -dy : -Math.sin(angle);
              enemy.patternY = playerIsMoving ? dx : Math.cos(angle);
              enemy.patternPhase = "inscribe";
              enemy.patternTimer = MARGIN_SEVERER_TELEGRAPH_SECONDS;
              playGameSfx("enemyCharge", {
                pan: clamp((enemy.x - WIDTH / 2) / (WIDTH * 0.55), -0.7, 0.7),
                playbackRate: 0.9,
              });
              enemy.patternHit = false;
              enemy.moving = false;
              enemy.facing = directionRow(
                Math.cos(angle),
                Math.sin(angle),
                enemy.facing,
              );
            }
          } else if (phase === "inscribe") {
            enemy.moving = false;
            enemy.walkCycle = 1;
            if ((enemy.patternTimer ?? 0) <= 0) {
              enemy.patternPhase = "sever";
              enemy.patternTimer = MARGIN_SEVERER_ACTIVE_SECONDS;
              enemy.patternHit = false;
            }
          } else if (phase === "sever") {
            enemy.moving = false;
            enemy.walkCycle = 1;
            if ((enemy.patternTimer ?? 0) <= 0) {
              enemy.patternPhase = "recover";
              enemy.patternTimer = MARGIN_SEVERER_RECOVERY_SECONDS;
            } else {
              const severLine = marginSeverLine(
                enemy.patternTargetX ?? player.x,
                enemy.patternTargetY ?? player.y,
                enemy.patternX ?? 1,
                enemy.patternY ?? 0,
              );
              if (
                !enemy.patternHit &&
                distanceToSegment(
                  player.x,
                  player.y,
                  severLine.startX,
                  severLine.startY,
                  severLine.endX,
                  severLine.endY,
                ) <
                  player.radius + MARGIN_SEVERER_HIT_HALF_WIDTH
              ) {
                enemy.patternHit = true;
                damagePlayer(enemy.damage * MARGIN_SEVERER_DAMAGE_MULTIPLIER);
              }
            }
          } else {
            enemy.moving = false;
            enemy.walkCycle = 1;
            if ((enemy.patternTimer ?? 0) <= 0) {
              enemy.patternPhase = "orbit";
              enemy.patternTimer =
                2.6 +
                hash(world.seed, enemy.id, player.rooms, player.kills + 8807) * 0.8;
              enemy.strafeDirection = enemy.strafeDirection === -1 ? 1 : -1;
              enemy.patternHit = false;
              enemy.patternTargetX = undefined;
              enemy.patternTargetY = undefined;
            }
          }
        } else if (enemy.kind === SILENT_LIBRARIAN_KIND) {
          const phase = enemy.patternPhase ?? "orbit";
          if (phase === "orbit") {
            const preferredDistance = 285;
            const radialCorrection = clamp((d - preferredDistance) / 140, -0.62, 0.66);
            const strafeStrength = 0.68 * (enemy.strafeDirection ?? 1);
            let enemyMoveX =
              Math.cos(angle) * radialCorrection +
              Math.cos(angle + Math.PI / 2) * strafeStrength;
            let enemyMoveY =
              Math.sin(angle) * radialCorrection +
              Math.sin(angle + Math.PI / 2) * strafeStrength;
            const moveMagnitude = Math.hypot(enemyMoveX, enemyMoveY) || 1;
            enemyMoveX /= moveMagnitude;
            enemyMoveY /= moveMagnitude;
            const slowMultiplier = enemy.slow > 0 ? 0.58 : 1;
            enemy.x += enemyMoveX * enemy.speed * slowMultiplier * dt;
            enemy.y += enemyMoveY * enemy.speed * slowMultiplier * dt;
            enemy.moving = true;
            enemy.facing = directionRow(enemyMoveX, enemyMoveY, enemy.facing);
            enemy.walkCycle =
              (enemy.walkCycle + dt * (5.35 + enemy.speed / 42) * slowMultiplier) % 4;

            if ((enemy.patternTimer ?? 0) <= 0) {
              enemy.patternPhase = "echoWindup";
              enemy.patternTimer = SILENT_LIBRARIAN_TELEGRAPH_SECONDS;
              enemy.patternHit = false;
              enemy.moving = false;
              enemy.facing = directionRow(
                Math.cos(angle),
                Math.sin(angle),
                enemy.facing,
              );
              playGameSfx("timeRift", {
                pan: clamp((enemy.x - WIDTH / 2) / (WIDTH * 0.55), -0.7, 0.7),
                playbackRate: 0.82,
              });
            }
          } else if (phase === "echoWindup") {
            enemy.moving = false;
            enemy.walkCycle = 1;
            if ((enemy.patternTimer ?? 0) <= 0) {
              enemy.patternPhase = "echoWave";
              enemy.patternTimer = SILENT_LIBRARIAN_WAVE_SECONDS;
              enemy.patternHit = false;
            }
          } else if (phase === "echoWave") {
            enemy.moving = false;
            enemy.walkCycle = 1;
            const currentRadius = silentLibrarianWaveRadius(enemy.patternTimer ?? 0);
            const previousRadius = silentLibrarianWaveRadius(
              Math.min(SILENT_LIBRARIAN_WAVE_SECONDS, (enemy.patternTimer ?? 0) + dt),
            );
            if (
              !enemy.patternHit &&
              sweptEchoRingHits({
                previousRadius,
                currentRadius,
                targetDistance: distance(player.x, player.y, enemy.x, enemy.y),
                targetRadius: player.radius,
              })
            ) {
              enemy.patternHit = true;
              damagePlayer(enemy.damage * SILENT_LIBRARIAN_DAMAGE_MULTIPLIER);
            }
            if ((enemy.patternTimer ?? 0) <= 0) {
              enemy.patternPhase = "recover";
              enemy.patternTimer = SILENT_LIBRARIAN_RECOVERY_SECONDS;
            }
          } else {
            enemy.moving = false;
            enemy.walkCycle = 1;
            if ((enemy.patternTimer ?? 0) <= 0) {
              enemy.patternPhase = "orbit";
              enemy.patternTimer =
                2.8 + hash(world.seed, enemy.id, player.rooms, player.kills + 10007) * 0.8;
              enemy.patternHit = false;
              enemy.strafeDirection = enemy.strafeDirection === -1 ? 1 : -1;
            }
          }
        } else {
          let movement = 1;
          if (enemy.kind === 1 && d < 280) movement = -0.32;
          if (enemy.kind === 3) movement = 0.22;
          if (enemy.slow > 0) movement *= 0.58;
          const enemyMoveX = Math.cos(angle) * movement;
          const enemyMoveY = Math.sin(angle) * movement;
          enemy.x += enemyMoveX * enemy.speed * dt;
          enemy.y += enemyMoveY * enemy.speed * dt;
          enemy.moving = Math.abs(movement) > 0.01;
          if (enemy.moving) {
            enemy.facing = directionRow(enemyMoveX, enemyMoveY, enemy.facing);
            enemy.walkCycle =
              (enemy.walkCycle + dt * (5.4 + enemy.speed / 38) * Math.abs(movement)) % 4;
          }
        }
        constrainEnemyToWalkableFloor(enemy);

        if (enemy.kind === 1 && enemy.shootCooldown <= 0) {
          for (let i = -1; i <= 1; i += 1) {
            spawnHostileProjectile(enemy.x, enemy.y, angle + i * 0.13, 285, enemy.damage);
          }
          enemy.shootCooldown = 2.2;
        }
        if (enemy.kind === 3 && enemy.shootCooldown <= 0 && world.enemies.length < 28) {
          const summonedEnemy = makeEnemy(
            0,
            enemy.x + Math.cos(angle + 1) * 58,
            enemy.y + Math.sin(angle + 1) * 58,
            player.rooms,
          );
          world.enemies.push(summonedEnemy);
          spawnVisualEffect("summon", summonedEnemy.x, summonedEnemy.y + 8, 0.72, 154);
          enemy.shootCooldown = 4.6;
        }
        if (enemy.kind === 4 && enemy.shootCooldown <= 0) {
          spawnVisualEffect("teleport", enemy.x, enemy.y + 8, 0.58, 146);
          const teleportTarget = safeWalkableFloorPoint(
            120 + hash(world.seed, enemy.id, player.rooms, now | 0) * (WIDTH - 240),
            110 +
              hash(world.seed, player.rooms, enemy.id, (now / 7) | 0) *
                (HEIGHT - 220),
            enemy.radius,
          );
          enemy.x = teleportTarget.x;
          enemy.y = teleportTarget.y;
          spawnVisualEffect("teleport", enemy.x, enemy.y + 8, 0.68, 162);
          const teleportAngle = Math.atan2(player.y - enemy.y, player.x - enemy.x);
          spawnHostileProjectile(enemy.x, enemy.y, teleportAngle, 350, enemy.damage, 9, "witch");
          enemy.shootCooldown = 3.4;
        }
        const bossCanDealContactDamage =
          enemy.kind === BLANK_CARTOGRAPHER_KIND
            ? enemy.bossPhase === "pursuit"
            : enemy.kind === FINAL_BINDER_KIND
              ? enemy.binderPhase === "pursuit"
              : enemy.kind === PALIMPSEST_ARCHIVIST_KIND
                ? enemy.archivist?.phase === "pursuit"
              : true;
        if (
          enemy.kind !== 6 &&
          enemy.kind !== 7 &&
          enemy.kind !== MARGIN_SEVERER_KIND &&
          enemy.kind !== SILENT_LIBRARIAN_KIND &&
          bossCanDealContactDamage &&
          distance(player.x, player.y, enemy.x, enemy.y) <
            player.radius + enemy.radius * 0.72
        ) {
          damagePlayer(enemy.damage);
        }
      }

      const orbitRank = powerRankOf(player, "orbit");
      const orbitCount = Math.min(8, orbitRank);
      if (orbitCount > 0) {
        for (const enemy of world.enemies) {
          if (enemy.orbitalCooldown > 0) continue;
          for (let i = 0; i < orbitCount; i += 1) {
            const angle = now / 620 + (Math.PI * 2 * i) / orbitCount;
            const ox = player.x + Math.cos(angle) * (62 + orbitRank * 2);
            const oy = player.y + Math.sin(angle) * (44 + orbitRank * 1.4);
            if (distance(ox, oy, enemy.x, enemy.y) < enemy.radius + 13) {
              applyPlayerDamage(
                player,
                enemy,
                (7 + orbitRank * 3) * legendaryAttackMultiplier(player),
                equipmentStats,
              );
              enemy.orbitalCooldown = 0.24;
              break;
            }
          }
        }
      }

      for (const projectile of world.projectiles) {
        projectile.life -= dt;
        projectile.age += dt;
        if (projectile.life <= 0) continue;
        if (
          !projectile.hostile &&
          !projectile.returning &&
          projectile.returnAfter !== undefined
        ) {
          projectile.returnAfter -= dt;
          if (projectile.returnAfter <= 0) {
            projectile.returning = true;
            projectile.outboundSpent = false;
            const returnAngle = Math.atan2(
              player.y - projectile.y,
              player.x - projectile.x,
            );
            projectile.vx = Math.cos(returnAngle) * 720;
            projectile.vy = Math.sin(returnAngle) * 720;
            projectile.damage *= projectile.returnMultiplier ?? 1;
            projectile.life = Math.max(projectile.life, 0.72);
            projectile.hit.clear();
            spawnCombatEffect(
              "muzzle",
              projectile.x,
              projectile.y,
              0.22,
              projectile.radius * 4.5,
              "#d9b5ff",
              returnAngle,
              undefined,
              undefined,
              augmentVfxId("return"),
            );
          }
        }
        if (!projectile.hostile && !projectile.returning && projectile.homing) {
          const homingTarget = findNearestUnhitAliveEntity(
            world.enemies,
            projectile.x,
            projectile.y,
            projectile.hit,
          );
          if (homingTarget) {
            const speed = Math.hypot(projectile.vx, projectile.vy);
            const currentAngle = Math.atan2(projectile.vy, projectile.vx);
            const targetAngle = Math.atan2(
              homingTarget.y - projectile.y,
              homingTarget.x - projectile.x,
            );
            const angleDelta = Math.atan2(
              Math.sin(targetAngle - currentAngle),
              Math.cos(targetAngle - currentAngle),
            );
            const steeredAngle =
              currentAngle +
              clamp(angleDelta, -projectile.homing * dt, projectile.homing * dt);
            projectile.vx = Math.cos(steeredAngle) * speed;
            projectile.vy = Math.sin(steeredAngle) * speed;
          }
        }
        projectile.previousX = projectile.x;
        projectile.previousY = projectile.y;
        projectile.x += projectile.vx * dt;
        projectile.y += projectile.vy * dt;
        const hitRoomWall =
          projectile.x < ROOM_GEOMETRY.left ||
          projectile.x > ROOM_GEOMETRY.right ||
          projectile.y < ROOM_GEOMETRY.top ||
          projectile.y > ROOM_GEOMETRY.bottom;
        if (hitRoomWall) {
          projectile.life = 0;
          spawnCombatEffect(
            projectile.hostile ? "hostileImpact" : "playerImpact",
            clamp(projectile.x, ROOM_GEOMETRY.left, ROOM_GEOMETRY.right),
            clamp(projectile.y, ROOM_GEOMETRY.top, ROOM_GEOMETRY.bottom),
            0.22,
            projectile.radius * 4.4,
            projectile.color,
            Math.atan2(projectile.vy, projectile.vx),
            undefined,
            undefined,
            projectile.vfxId,
          );
          continue;
        }
        if (projectile.hostile) {
          const mirrorBarrierActive =
            hasLegendaryPower(player, "mirrorAegis") &&
            player.mirrorAegisBarrierTime > 0;
          if (
            distanceToSegment(
              player.x,
              player.y,
              projectile.previousX,
              projectile.previousY,
              projectile.x,
              projectile.y,
            ) <
            projectile.radius + player.radius + (mirrorBarrierActive ? 24 : 0)
          ) {
            projectile.life = 0;
            if (mirrorBarrierActive) {
              spawnLegendaryEffect(
                "mirrorBlock",
                projectile.x,
                projectile.y,
                0.3,
                Math.max(42, projectile.radius * 7),
                "#aefaff",
                Math.atan2(projectile.vy, projectile.vx),
                legendaryVfxId("mirrorAegis"),
              );
              playGameSfx("playerImpact", { playbackRate: 1.42, gain: 0.48 });
            } else {
              spawnCombatEffect(
                "hostileImpact",
                projectile.x,
                projectile.y,
                0.34,
                projectile.radius * 6,
                projectile.color,
                Math.atan2(projectile.vy, projectile.vx),
              );
              damagePlayer(projectile.damage);
            }
          }
          continue;
        }
        if (!projectile.returning && projectile.outboundSpent) continue;
        for (const enemy of world.enemies) {
          if (enemy.hp <= 0 || projectile.hit.has(enemy.id)) continue;
          const collisionRadius = projectile.radius + enemy.radius * 0.72;
          if (
            !sweptCircleMayOverlap(
              projectile.previousX,
              projectile.previousY,
              projectile.x,
              projectile.y,
              enemy.x,
              enemy.y,
              collisionRadius,
            )
          ) {
            continue;
          }
          if (
            distanceToSegment(
              enemy.x,
              enemy.y,
              projectile.previousX,
              projectile.previousY,
              projectile.x,
              projectile.y,
            ) <
            collisionRadius
          ) {
            projectile.hit.add(enemy.id);
            if (
              projectile.bloodwovenEligible &&
              projectile.criticalVolleyId !== undefined &&
              projectile.criticalVolleyId !== player.bloodwovenLastCountedVolley &&
              hasLegendaryPower(player, "bloodwovenGrip")
            ) {
              player.bloodwovenLastCountedVolley = projectile.criticalVolleyId;
              for (const sibling of world.projectiles) {
                if (sibling.criticalVolleyId === projectile.criticalVolleyId) {
                  sibling.bloodwovenEligible = false;
                }
              }
              const bloodwovenCounter = advanceLegendaryCounter(
                player.bloodwovenCriticalHits,
                LEGENDARY_RUNTIME.bloodwovenCriticalHits,
              );
              player.bloodwovenCriticalHits = bloodwovenCounter.count;
              if (bloodwovenCounter.triggered) {
                player.bloodwovenBurstReady = true;
                spawnLegendaryEffect(
                  "bloodwovenBurst",
                  enemy.x,
                  enemy.y,
                  0.46,
                  88,
                  "#ff477f",
                  0,
                  legendaryVfxId("bloodwovenGrip"),
                );
                playGameSfx("playerCrit", { playbackRate: 0.82, gain: 1.04 });
                setToast("전설 · 피로 짠 손아귀가 충전되어 다음 기본 공격이 증식합니다.");
              }
            }
            applyPlayerDamage(
              player,
              enemy,
              projectile.damage,
              equipmentStats,
            );
            playGameSfx("playerImpact", {
              pan: clamp((enemy.x - WIDTH / 2) / (WIDTH * 0.55), -0.76, 0.76),
              gain: projectile.pierce > 0 ? 0.86 : 1,
            });
            if (equipmentStats.lifeOnHitFlat > 0 && player.hp < player.maxHp) {
              const lifeOnHit = Math.min(1.5, equipmentStats.lifeOnHitFlat * 0.08);
              player.hp = Math.min(player.maxHp, player.hp + lifeOnHit);
            }
            spawnCombatEffect(
              "playerImpact",
              projectile.x,
              projectile.y,
              0.26,
              projectile.radius * (projectile.pierce > 0 ? 4.4 : 6.2),
              projectile.color,
              Math.atan2(projectile.vy, projectile.vx),
              undefined,
              undefined,
              projectile.vfxId,
            );
            const frost = powerRankOf(player, "frost");
            if (frost > 0) enemy.slow = 0.45 + frost * 0.08;
            const poison = powerRankOf(player, "poison");
            if (poison > 0) {
              enemy.poisonDamage = Math.max(enemy.poisonDamage, 2 + poison * 1.2);
              enemy.poisonTime = Math.max(enemy.poisonTime, 5);
            }
            const leechRank = powerRankOf(player, "leech");
            if (leechRank > 0 && player.hp < player.maxHp) {
              const bloodNeedle = activeSynergies(player).find(
                (synergy) => synergy.name === "혈침 순환",
              );
              const heal =
                Math.min(0.65, 0.1 + leechRank * 0.03) *
                (1 + (bloodNeedle?.tier ?? 0) * 0.08);
              player.hp = Math.min(player.maxHp, player.hp + heal);
            }
            const storm = powerRankOf(player, "storm");
            if (storm > 0 && Math.random() < 1 - Math.pow(0.8, storm)) {
              const next = findNearestAliveEntity(
                world.enemies,
                enemy.x,
                enemy.y,
                enemy.id,
                260,
              );
              if (next) {
                const plagueStorm = activeSynergies(player).find(
                  (synergy) => synergy.name === "역병 폭풍",
                );
                applyPlayerDamage(
                  player,
                  next,
                  projectile.damage *
                    0.55 *
                    (1 + (plagueStorm?.tier ?? 0) * 0.24),
                  equipmentStats,
                );
                spawnCombatEffect(
                  "chainArc",
                  enemy.x,
                  enemy.y,
                  0.2,
                  9 + Math.min(12, storm * 1.5),
                  "#c5b0ff",
                  0,
                  next.x,
                  next.y,
                  augmentVfxId("storm"),
                );
                if (plagueStorm && enemy.poisonTime > 0) {
                  next.poisonDamage = Math.max(
                    next.poisonDamage,
                    enemy.poisonDamage * 0.5,
                  );
                  next.poisonTime = Math.max(next.poisonTime, enemy.poisonTime * 0.5);
                }
              }
            }
            const ricochetRank = powerRankOf(player, "ricochet");
            if (ricochetRank > 0 && Math.random() < 1 - Math.pow(0.88, ricochetRank)) {
              const next = findNearestAliveEntity(
                world.enemies,
                enemy.x,
                enemy.y,
                enemy.id,
                230,
              );
              if (next) {
                const boneEcho = activeSynergies(player).find(
                  (synergy) => synergy.name === "백골 메아리",
                );
                const echoDamage =
                  projectile.damage *
                  Math.min(0.72, 0.22 + ricochetRank * 0.025) *
                  (1 + (boneEcho?.tier ?? 0) * 0.14);
                applyPlayerDamage(player, next, echoDamage, equipmentStats);
                spawnCombatEffect(
                  "chainArc",
                  enemy.x,
                  enemy.y,
                  0.16,
                  7 + Math.min(10, ricochetRank),
                  "#e4d5b6",
                  0,
                  next.x,
                  next.y,
                  augmentVfxId("ricochet"),
                );
              }
            }
            if (projectile.pierce <= 0) {
              if (!projectile.returning && projectile.returnAfter !== undefined) {
                projectile.outboundSpent = true;
                projectile.vx = 0;
                projectile.vy = 0;
              } else {
                projectile.life = 0;
              }
            } else {
              projectile.pierce -= 1;
            }
            break;
          }
        }
      }
      compactArrayInPlace(
        world.projectiles,
        (projectile) =>
          projectile.life > 0 &&
          projectile.x > -80 &&
          projectile.x < WIDTH + 80 &&
          projectile.y > -80 &&
          projectile.y < HEIGHT + 80,
      );

      // Snapshot first: kill callbacks can splash damage, and newly killed
      // enemies must remain for the next tick just as in the original logic.
      const dead = world.enemies.filter((enemy) => enemy.hp <= 0);
      for (const enemy of dead) killEnemy(enemy);
      compactArrayInPlace(world.enemies, (enemy) => enemy.hp > 0);

      const collectionRangeMultiplier = simpleAugmentMultiplier(
        powerRankOf(player, "collection"),
        SIMPLE_AUGMENT_BONUSES.collectionPickupRangePerRank,
      );
      const pickupRange =
        (38 + powerRankOf(player, "magnet") * 42) *
        (1 + equipmentStats.pickupRadiusPercent / 100) *
        collectionRangeMultiplier;
      for (const orb of world.orbs) {
        const d = distance(orb.x, orb.y, player.x, player.y);
        if (d < pickupRange * 2.4) {
          const speed = 190 + Math.max(0, pickupRange * 2.4 - d) * 2.8;
          const angle = Math.atan2(player.y - orb.y, player.x - orb.x);
          orb.x += Math.cos(angle) * speed * dt;
          orb.y += Math.sin(angle) * speed * dt;
        }
        if (d < player.radius + 15) {
          orb.value *= -1;
          playGameSfx("memoryPickup", {
            playbackRate: 0.96 + Math.min(0.2, player.memoryPickupCounter * 0.004),
            gain: 0.82,
          });
          gainXp(Math.abs(orb.value));
          player.memoryPickupCounter += 1;
          if (hasLegendaryPower(player, "ashboundGirdle")) {
            const ashboundCounter = advanceLegendaryCounter(
              player.ashboundPickupCount,
              LEGENDARY_RUNTIME.ashboundPickups,
            );
            player.ashboundPickupCount = ashboundCounter.count;
            if (ashboundCounter.triggered) {
              const refreshedShield = refreshTrackedShield(
                player.shield,
                player.ashboundShieldRemaining,
                player.maxHp,
                LEGENDARY_RUNTIME.ashboundShieldRatio,
              );
              player.shield = refreshedShield.shield;
              player.ashboundShieldRemaining = refreshedShield.trackedShield;
              player.ashboundShieldTime = LEGENDARY_RUNTIME.ashboundSeconds;
              spawnLegendaryEffect(
                "ashboundShield",
                player.x,
                player.y,
                0.72,
                112,
                "#e7b268",
                0,
                legendaryVfxId("ashboundGirdle"),
              );
              playGameSfx("memoryPickup", { playbackRate: 0.7, gain: 1.12 });
              setToast("전설 · 기억의 재가 엮여 최대 생명력 8%의 방벽이 생성됩니다.");
            }
          }
          if (
            hasLegendaryPower(player, "commaResonance") &&
            player.memoryPickupCounter % 8 === 0
          ) {
            const resonanceDamage =
              (BASE_PLAYER_ATTACK_DAMAGE + equipmentStats.attackPowerFlat) *
              (1 + equipmentStats.damagePercent / 100) *
              0.75 *
              legendaryAttackMultiplier(player);
            spawnCombatEffect(
              "muzzle",
              player.x,
              player.y,
              0.46,
              78,
              "#f0b86e",
              0,
              undefined,
              undefined,
              legendaryVfxId("commaResonance"),
            );
            const resonanceSpeed =
              520 *
              simpleAugmentMultiplier(
                powerRankOf(player, "velocity"),
                SIMPLE_AUGMENT_BONUSES.velocityProjectileSpeedPerRank,
              ) *
              (1 + equipmentStats.projectileSpeedPercent / 100);
            const resonanceLife =
              1.05 *
              simpleAugmentMultiplier(
                powerRankOf(player, "range"),
                SIMPLE_AUGMENT_BONUSES.rangeProjectileLifePerRank,
              ) *
              (1 + equipmentStats.projectileLifetimePercent / 100);
            const resonanceSize =
              6 *
              (1 + Math.min(150, equipmentStats.projectileSizePercent) / 100) *
              simpleAugmentMultiplier(
                powerRankOf(player, "expansion"),
                SIMPLE_AUGMENT_BONUSES.expansionProjectileSizePerRank,
              );
            for (let index = 0; index < 8; index += 1) {
              const angle = (Math.PI * 2 * index) / 8;
              world.projectiles.push({
                id: idRef.current++,
                x: player.x,
                y: player.y,
                vx: Math.cos(angle) * resonanceSpeed,
                vy: Math.sin(angle) * resonanceSpeed,
                radius: resonanceSize,
                damage: resonanceDamage,
                life: resonanceLife,
                pierce:
                  1 + Math.max(0, Math.floor(equipmentStats.pierceFlat)),
                hostile: false,
                color: "#f0b86e",
                affinity: "echo",
                vfxId: legendaryVfxId("commaResonance"),
                age: 0,
                maxLife: resonanceLife,
                previousX: player.x,
                previousY: player.y,
                hit: new Set<number>(),
                homing:
                  equipmentStats.homingStrengthFlat > 0
                    ? Math.min(14, equipmentStats.homingStrengthFlat)
                    : undefined,
              });
            }
          }
        }
      }
      world.orbs = world.orbs.filter((orb) => orb.value > 0);
      const collectedGear = new Set<number>();
      let autoSalvagedGearCount = 0;
      let autoSalvagedGearAsh = 0;
      let lastKeptGear: GearItem | null = null;
      const gearPickupRange =
        44 *
        (1 + equipmentStats.pickupRadiusPercent / 100) *
        collectionRangeMultiplier;
      for (const drop of world.gearDrops) {
        if (drop.pickupDelay > 0) continue;
        if (distance(drop.x, drop.y, player.x, player.y) > gearPickupRange) continue;
        if (
          shouldAutoSalvageRarity(
            drop.item.rarity,
            player.autoSalvageMaxRarity,
          )
        ) {
          const ashBreakdown = getGearSalvageAshBreakdown(drop.item);
          player.memoryAsh += ashBreakdown.total;
          autoSalvagedGearCount += 1;
          autoSalvagedGearAsh += ashBreakdown.total;
          collectedGear.add(drop.id);
          continue;
        }
        if (player.inventory.length >= inventoryCapacityRef.current) {
          if (performance.now() - inventoryFullToastRef.current > 2200) {
            inventoryFullToastRef.current = performance.now();
            setToast("가방이 가득 찼습니다 · I에서 장비를 장착하거나 분해하세요.");
          }
          continue;
        }
        player.inventory.push(cloneGearItem(drop.item));
        playGearRaritySfx(drop.item.rarity);
        collectedGear.add(drop.id);
        if (drop.item.rarity === "mythic" || drop.item.rarity === "cosmic") {
          getRealtimeClient().announceLoot({
            acquisitionId: `${getRealtimeDeviceId()}:${Date.now()}:${drop.id}:${crypto.randomUUID()}`,
            itemName: drop.item.displayName,
            rarity: drop.item.rarity,
            itemLevel: drop.item.level,
            enhancement: drop.item.enhancement,
          });
        }
        lastKeptGear = drop.item;
        setSelectedGearId(drop.item.id);
        setLootNotice(cloneGearItem(drop.item));
        setToast(
          `${GEAR_RARITY_META[drop.item.rarity].label} 획득 · ${formatGearDisplayName(drop.item)} (I 장비)`,
        );
      }
      if (collectedGear.size > 0) {
        world.gearDrops = world.gearDrops.filter((drop) => !collectedGear.has(drop.id));
      }
      if (autoSalvagedGearCount > 0) {
        const keptPrefix = lastKeptGear
          ? `${GEAR_RARITY_META[lastKeptGear.rarity].label} 장비 획득 · `
          : "";
        setToast(
          `${keptPrefix}자동 분해 ${autoSalvagedGearCount}개 → 기억의 재 ${autoSalvagedGearAsh.toLocaleString("ko-KR")}개`,
        );
      }
      if (!world.roomCleared && world.enemies.length === 0) completeRoom();
    };

    const drawSprite = (
      image: HTMLImageElement | undefined,
      cropIndex: number,
      x: number,
      y: number,
      width: number,
      height: number,
      alpha = 1,
    ) => {
      if (!image?.complete || !image.naturalWidth) return false;
      const crop = spriteCrops[cropIndex];
      context.save();
      context.globalAlpha = alpha;
      context.drawImage(
        image,
        crop[0],
        crop[1],
        crop[2],
        crop[3],
        x - width / 2,
        y - height * 0.78,
        width,
        height,
      );
      context.restore();
      return true;
    };

    const drawWalkSprite = (
      image: HTMLImageElement | undefined,
      facing: number,
      frameIndex: number,
      x: number,
      y: number,
      width: number,
      height: number,
      alpha = 1,
      flipX = false,
      sourceRowCrop?: { y: number; height: number },
    ) => {
      if (!image?.complete || !image.naturalWidth || !image.naturalHeight) return false;
      const sourceWidth = image.naturalWidth / 4;
      const sourceHeight = sourceRowCrop?.height ?? image.naturalHeight / 8;
      const sourceY = sourceRowCrop?.y ?? clamp(Math.floor(facing), 0, 7) * sourceHeight;
      const column = positiveModulo(Math.floor(frameIndex), 4);
      context.save();
      context.globalAlpha = alpha;
      context.imageSmoothingEnabled = true;
      if (flipX) {
        context.translate(x, 0);
        context.scale(-1, 1);
      }
      context.drawImage(
        image,
        column * sourceWidth,
        sourceY,
        sourceWidth,
        sourceHeight,
        flipX ? -width / 2 : x - width / 2,
        y - height * 0.78,
        width,
        height,
      );
      context.restore();
      return true;
    };

    const drawEffectSprite = (
      image: HTMLImageElement | undefined,
      effect: VisualEffect,
    ) => {
      if (!image?.complete || !image.naturalWidth || !image.naturalHeight) return false;
      const progress = clamp(1 - effect.life / effect.duration, 0, 0.999);
      const frameIndex = clamp(Math.floor(progress * 4), 0, 3);
      const sourceWidth = image.naturalWidth / 2;
      const sourceHeight = image.naturalHeight / 2;
      const column = frameIndex % 2;
      const row = Math.floor(frameIndex / 2);
      context.save();
      context.globalAlpha = clamp(effect.life / Math.min(0.18, effect.duration), 0, 1);
      context.imageSmoothingEnabled = true;
      context.drawImage(
        image,
        column * sourceWidth,
        row * sourceHeight,
        sourceWidth,
        sourceHeight,
        effect.x - effect.size / 2,
        effect.y - effect.size * 0.66,
        effect.size,
        effect.size,
      );
      context.restore();
      return true;
    };

    const drawLootAwakening = (
      image: HTMLImageElement | undefined,
      effect: VisualEffect,
      clock: number,
    ) => {
      if (
        effect.kind !== "lootAwakening" ||
        !image?.complete ||
        !image.naturalWidth ||
        !image.naturalHeight
      ) {
        return false;
      }
      const progress = clamp(1 - effect.life / effect.duration, 0, 0.999);
      const frameIndex = clamp(Math.floor(progress * 8), 0, 7);
      const sourceWidth = image.naturalWidth / 4;
      const sourceHeight = image.naturalHeight / 2;
      const column = frameIndex % 4;
      const row = Math.floor(frameIndex / 4);
      const color = effect.color ?? "#e7c65b";
      const rarity = effect.rarity ?? "common";
      const tier = EQUIPMENT_RARITY_TIER[rarity];
      const config = EQUIPMENT_RARITY_VFX[rarity];
      const fadeIn = clamp(progress / 0.1, 0, 1);
      const fadeOut = clamp((1 - progress) / 0.28, 0, 1);
      const alpha = fadeIn * fadeOut;
      const shockwaveRadius = effect.size * (0.12 + progress * 0.52);

      context.save();
      context.globalCompositeOperation = "lighter";
      context.translate(effect.x, effect.y + 5);
      context.globalAlpha = alpha * (0.34 + tier * 0.08);
      context.strokeStyle = color;
      context.shadowColor = color;
      context.shadowBlur = 16 + tier * 5;
      context.lineWidth = Math.max(1.5, 4.2 - progress * 2.5 + tier * 0.45);
      context.beginPath();
      context.ellipse(0, 0, shockwaveRadius, shockwaveRadius * 0.36, 0, 0, Math.PI * 2);
      context.stroke();

      context.save();
      context.globalAlpha = alpha * (0.2 + tier * 0.035);
      context.rotate(
        config.spinDirection * (progress * 0.82 + clock * 0.08) + effect.id * 0.07,
      );
      context.beginPath();
      const spiralPattern =
        config.arrivalPattern === "reverseVortex" ||
        config.arrivalPattern === "nebulaCollapse";
      const starPattern =
        config.arrivalPattern === "compassBloom" ||
        config.arrivalPattern === "solarCoronation" ||
        config.arrivalPattern === "mythicCoronation" ||
        config.arrivalPattern === "nebulaCollapse";
      const accentPointCount = spiralPattern
        ? config.accentSides * 2
        : config.accentSides;
      for (let point = 0; point < accentPointCount; point += 1) {
        const pointProgress = point / Math.max(1, accentPointCount - 1);
        const angle = (Math.PI * 2 * point) / config.accentSides - Math.PI / 2;
        const radius = spiralPattern
          ? shockwaveRadius * (0.28 + pointProgress * 0.72)
          : shockwaveRadius * (starPattern && point % 2 ? 0.58 : 0.94);
        const pointX = Math.cos(angle) * radius;
        const pointY = Math.sin(angle) * radius * 0.36;
        if (point === 0) context.moveTo(pointX, pointY);
        else context.lineTo(pointX, pointY);
      }
      if (!spiralPattern) context.closePath();
      context.stroke();
      context.restore();

      const rayCount = config.rayCount;
      context.globalAlpha = alpha * 0.68;
      context.fillStyle = colorWithAlpha("#fff8dc", 0.92);
      for (let ray = 0; ray < rayCount; ray += 1) {
        const angle =
          (Math.PI * 2 * ray) / rayCount +
          effect.id * 0.31 +
          progress * config.spinDirection * 0.54;
        const length = effect.size * (0.24 + progress * (0.3 + (ray % 3) * 0.035));
        context.save();
        context.rotate(angle);
        context.beginPath();
        context.moveTo(effect.size * 0.09, 0);
        context.lineTo(length, 1.4 + tier * 0.3);
        context.lineTo(length * 0.76, -1.4 - tier * 0.3);
        context.closePath();
        context.fill();
        context.restore();
      }

      const moteCount = config.moteCount;
      for (let mote = 0; mote < moteCount; mote += 1) {
        const phase = positiveModulo(progress * (1.3 + (mote % 3) * 0.12) + mote * 0.173, 1);
        const orbitOffset =
          spiralPattern
            ? Math.sin(phase * Math.PI * 2 + mote) *
              effect.size *
              0.13 *
              config.spinDirection
            : 0;
        const spread =
          (hash(effect.id, mote, tier, 771) - 0.5) * effect.size * 0.54 +
          orbitOffset;
        const rise = phase * effect.size * (0.55 + tier * 0.06);
        const moteSize = 1.8 + (mote % 3) * 0.8 + tier * 0.25;
        context.globalAlpha = (1 - phase) * alpha * 0.86;
        context.save();
        context.translate(spread, -rise);
        context.rotate(clock * 1.8 + mote);
        context.fillRect(-moteSize / 2, -moteSize / 2, moteSize, moteSize);
        context.restore();
      }
      context.restore();

      context.save();
      context.globalAlpha = alpha;
      context.globalCompositeOperation = "lighter";
      context.imageSmoothingEnabled = true;
      context.drawImage(
        image,
        column * sourceWidth,
        row * sourceHeight,
        sourceWidth,
        sourceHeight,
        effect.x - effect.size / 2,
        effect.y - effect.size * 0.72,
        effect.size,
        effect.size,
      );
      context.restore();
      return true;
    };

    const drawProofreaderTelegraph = (
      image: HTMLImageElement | undefined,
      enemy: Enemy,
      charge: number,
    ) => {
      if (!image?.complete || !image.naturalWidth || !image.naturalHeight) {
        return false;
      }
      const directionX = enemy.patternX ?? 0;
      const directionY = enemy.patternY ?? 1;
      const frameIndex = clamp(Math.floor(clamp(charge, 0, 0.999) * 6), 0, 5);
      const sourceWidth = image.naturalWidth / 3;
      const sourceHeight = image.naturalHeight / 2;
      const column = frameIndex % 3;
      const row = Math.floor(frameIndex / 3);
      const telegraphScale =
        enemy.kind === BLANK_CARTOGRAPHER_KIND ? 1.26 : 1;
      context.save();
      context.translate(enemy.x, enemy.y + 8);
      context.rotate(Math.atan2(directionY, directionX));
      context.globalCompositeOperation = "lighter";
      context.globalAlpha = 0.52 + charge * 0.4;
      context.shadowColor = "#e62633";
      context.shadowBlur = 7 + charge * 12;
      context.imageSmoothingEnabled = true;
      context.drawImage(
        image,
        column * sourceWidth,
        row * sourceHeight,
        sourceWidth,
        sourceHeight,
        -112 * telegraphScale,
        -72 * telegraphScale,
        920 * telegraphScale,
        144 * telegraphScale,
      );
      context.restore();
      return true;
    };

    const drawMarginSeverLine = (
      image: HTMLImageElement | undefined,
      enemy: Enemy,
    ) => {
      const phase = enemy.patternPhase;
      if (phase !== "inscribe" && phase !== "sever") return false;
      const duration =
        phase === "inscribe"
          ? MARGIN_SEVERER_TELEGRAPH_SECONDS
          : MARGIN_SEVERER_ACTIVE_SECONDS;
      const progress = clamp(1 - (enemy.patternTimer ?? 0) / duration, 0, 0.999);
      const frameIndex =
        phase === "inscribe"
          ? Math.min(1, Math.floor(progress * 2))
          : progress < 0.88
            ? 2
            : 3;
      const centerX = enemy.patternTargetX ?? enemy.x;
      const centerY = enemy.patternTargetY ?? enemy.y;
      const severLine = marginSeverLine(
        centerX,
        centerY,
        enemy.patternX ?? 1,
        enemy.patternY ?? 0,
      );
      const lineAngle = Math.atan2(
        severLine.endY - severLine.startY,
        severLine.endX - severLine.startX,
      );
      const lineLength = distance(
        severLine.startX,
        severLine.startY,
        severLine.endX,
        severLine.endY,
      );
      // The authored cells reserve roughly 13% horizontal alpha gutter. Expand
      // only the transparent atlas rectangle so the painted endpoint seals land
      // on the exact collision-segment endpoints instead of ending short.
      const atlasDrawWidth = lineLength / 0.87;
      const lineHeight = phase === "inscribe" ? 104 : 118;
      const alpha =
        phase === "inscribe"
          ? 0.45 + progress * 0.42
          : frameIndex === 3
            ? 0.72
            : 1;

      context.save();
      context.beginPath();
      context.rect(
        ROOM_GEOMETRY.left,
        ROOM_GEOMETRY.top,
        ROOM_GEOMETRY.right - ROOM_GEOMETRY.left,
        ROOM_GEOMETRY.bottom - ROOM_GEOMETRY.top,
      );
      context.clip();
      context.translate(centerX, centerY);
      context.rotate(lineAngle);
      context.globalAlpha = alpha;
      context.globalCompositeOperation =
        phase === "sever" ? "lighter" : "source-over";
      context.shadowColor = phase === "sever" ? "#8df7ff" : "#b72d3f";
      context.shadowBlur = phase === "sever" ? 18 : 8 + progress * 7;
      context.imageSmoothingEnabled = true;

      if (image?.complete && image.naturalWidth && image.naturalHeight) {
        const sourceWidth = image.naturalWidth / 2;
        const sourceHeight = image.naturalHeight / 2;
        const column = frameIndex % 2;
        const row = Math.floor(frameIndex / 2);
        context.drawImage(
          image,
          column * sourceWidth,
          row * sourceHeight,
          sourceWidth,
          sourceHeight,
          -atlasDrawWidth / 2,
          -lineHeight / 2,
          atlasDrawWidth,
          lineHeight,
        );
      } else {
        context.strokeStyle = phase === "sever" ? "#c8fbff" : "#cf4b59";
        context.lineWidth = phase === "sever" ? 5 : 2;
        context.beginPath();
        context.moveTo(-lineLength / 2, 0);
        context.lineTo(lineLength / 2, 0);
        context.stroke();
      }
      context.restore();
      return true;
    };

    const drawSilentLibrarianEcho = (
      image: HTMLImageElement | undefined,
      enemy: Enemy,
    ) => {
      const phase = enemy.patternPhase;
      if (phase !== "echoWindup" && phase !== "echoWave") return false;
      const isWave = phase === "echoWave";
      const progress = isWave
        ? silentLibrarianWaveProgress(enemy.patternTimer ?? 0)
        : clamp(
            1 - (enemy.patternTimer ?? 0) / SILENT_LIBRARIAN_TELEGRAPH_SECONDS,
            0,
            0.999,
          );
      const radius = isWave
        ? silentLibrarianWaveRadius(enemy.patternTimer ?? 0)
        : 48 + progress * 28;
      const frameIndex = isWave ? (progress < 0.82 ? 2 : 3) : progress < 0.56 ? 0 : 1;
      const drawSize = isWave ? Math.max(128, radius * 2.18) : 150 + progress * 68;

      context.save();
      context.beginPath();
      context.rect(
        ROOM_GEOMETRY.left,
        ROOM_GEOMETRY.top,
        ROOM_GEOMETRY.right - ROOM_GEOMETRY.left,
        ROOM_GEOMETRY.bottom - ROOM_GEOMETRY.top,
      );
      context.clip();
      context.globalCompositeOperation = "lighter";
      context.globalAlpha = isWave ? (frameIndex === 3 ? 0.72 : 0.94) : 0.58 + progress * 0.3;
      context.shadowColor = "#84f5ff";
      context.shadowBlur = isWave ? 18 : 9 + progress * 10;
      if (image?.complete && image.naturalWidth && image.naturalHeight) {
        const sourceWidth = image.naturalWidth / 2;
        const sourceHeight = image.naturalHeight / 2;
        context.drawImage(
          image,
          (frameIndex % 2) * sourceWidth,
          Math.floor(frameIndex / 2) * sourceHeight,
          sourceWidth,
          sourceHeight,
          enemy.x - drawSize / 2,
          enemy.y - drawSize / 2,
          drawSize,
          drawSize,
        );
      }
      context.strokeStyle = isWave ? "#c8fbff" : "#b89155";
      context.lineWidth = isWave ? 3.5 : 2;
      context.beginPath();
      // This ring is the exact world-space collision boundary. Keep it circular;
      // a perspective ellipse would teach a different dodge timing than the hit test.
      context.arc(enemy.x, enemy.y, radius, 0, Math.PI * 2);
      context.stroke();
      context.restore();
      return true;
    };

    const drawFinalBinderPattern = (
      image: HTMLImageElement | undefined,
      enemy: Enemy,
    ) => {
      const pattern = enemy.binderPattern;
      const phase = enemy.binderPhase;
      if (!pattern || !phase || phase === "pursuit" || phase === "recovery") {
        return false;
      }

      const sourceWidth = (image?.naturalWidth ?? 0) / 2;
      const sourceHeight = (image?.naturalHeight ?? 0) / 2;
      const canDrawImage = Boolean(
        image?.complete && image.naturalWidth && image.naturalHeight,
      );
      const drawBindingLine = (
        segment: { startX: number; startY: number; endX: number; endY: number },
        active: boolean,
        alpha: number,
      ) => {
        const lineLength = distance(
          segment.startX,
          segment.startY,
          segment.endX,
          segment.endY,
        );
        if (lineLength < 4) return;
        const centerX = (segment.startX + segment.endX) / 2;
        const centerY = (segment.startY + segment.endY) / 2;
        const lineAngle = Math.atan2(
          segment.endY - segment.startY,
          segment.endX - segment.startX,
        );
        context.save();
        context.translate(centerX, centerY);
        context.rotate(lineAngle);
        context.globalAlpha = alpha;
        context.globalCompositeOperation = active ? "lighter" : "source-over";
        context.shadowColor = active ? "#ff4e38" : "#c59643";
        context.shadowBlur = active ? 20 : 9;
        context.imageSmoothingEnabled = true;
        if (canDrawImage && image) {
          context.drawImage(
            image,
            active ? sourceWidth : 0,
            0,
            sourceWidth,
            sourceHeight,
            -(lineLength / 0.9) / 2,
            active ? -47 : -40,
            lineLength / 0.9,
            active ? 94 : 80,
          );
        } else {
          context.strokeStyle = active ? "#fff0b0" : "#b98a45";
          context.lineWidth = active ? 6 : 3;
          context.beginPath();
          context.moveTo(-lineLength / 2, 0);
          context.lineTo(lineLength / 2, 0);
          context.stroke();
        }
        context.restore();
      };

      context.save();
      context.beginPath();
      context.rect(
        ROOM_GEOMETRY.left,
        ROOM_GEOMETRY.top,
        ROOM_GEOMETRY.right - ROOM_GEOMETRY.left,
        ROOM_GEOMETRY.bottom - ROOM_GEOMETRY.top,
      );
      context.clip();

      if (pattern === "pageWall") {
        const isActive = phase === "pageWall";
        const duration = isActive
          ? FINAL_BINDER_PAGE_WALL_SECONDS
          : FINAL_BINDER_TELEGRAPH_SECONDS.pageWall;
        const progress = clamp(1 - (enemy.patternTimer ?? 0) / duration, 0, 1);
        const segments = finalBinderPageWallSegments(
          enemy.binderAxis ?? "horizontal",
          enemy.binderDirection ?? 1,
          isActive ? progress : 0,
          enemy.binderSafeCenter ?? (enemy.binderAxis === "vertical" ? enemy.y : enemy.x),
          WIDTH,
          HEIGHT,
        );
        for (const segment of segments) {
          drawBindingLine(
            segment,
            isActive,
            isActive ? 0.96 : 0.42 + progress * 0.42,
          );
        }
      } else if (pattern === "threadSweep") {
        const isActive = phase === "threadSweep";
        const duration = isActive
          ? FINAL_BINDER_THREAD_SWEEP_SECONDS
          : FINAL_BINDER_TELEGRAPH_SECONDS.threadSweep;
        const progress = clamp(1 - (enemy.patternTimer ?? 0) / duration, 0, 1);
        const sweep = finalBinderThreadSweepSegment(
          enemy.x,
          enemy.y,
          enemy.binderStartAngle ?? 0,
          enemy.binderDirection ?? 1,
          isActive ? progress : 0,
        );
        if (!isActive) {
          context.save();
          context.strokeStyle = colorWithAlpha("#d4a85f", 0.18 + progress * 0.28);
          context.lineWidth = 10;
          context.lineCap = "round";
          context.beginPath();
          context.arc(
            enemy.x,
            enemy.y,
            278,
            enemy.binderStartAngle ?? 0,
            (enemy.binderStartAngle ?? 0) +
              (enemy.binderDirection ?? 1) * FINAL_BINDER_THREAD_SWEEP_ARC,
            (enemy.binderDirection ?? 1) < 0,
          );
          context.stroke();
          context.restore();
        }
        drawBindingLine(sweep, isActive, isActive ? 1 : 0.5 + progress * 0.4);
      } else {
        const pulseIndex = enemy.binderPulseIndex ?? 0;
        const safeSector = finalBinderChapterSafeSector(
          enemy.binderInitialSafeSector ?? 0,
          enemy.binderDirection ?? 1,
          pulseIndex,
        );
        const safeAngle = safeSector * (Math.PI / 2);
        const isBurst = phase === "chapterBurst";
        const duration = isBurst
          ? FINAL_BINDER_CHAPTER_BURST_SECONDS
          : FINAL_BINDER_TELEGRAPH_SECONDS.chapterTurn;
        const progress = clamp(1 - (enemy.patternTimer ?? 0) / duration, 0, 1);
        const dangerStart = safeAngle + FINAL_BINDER_CHAPTER_SAFE_HALF_ANGLE;
        const dangerEnd = safeAngle + Math.PI * 2 - FINAL_BINDER_CHAPTER_SAFE_HALF_ANGLE;

        context.save();
        context.translate(enemy.x, enemy.y);
        context.globalCompositeOperation = isBurst ? "lighter" : "source-over";
        context.fillStyle = colorWithAlpha(
          isBurst ? "#ff3f35" : "#8d2631",
          isBurst ? 0.42 : 0.1 + progress * 0.18,
        );
        context.beginPath();
        context.arc(0, 0, FINAL_BINDER_CHAPTER_OUTER_RADIUS, dangerStart, dangerEnd);
        context.arc(
          0,
          0,
          FINAL_BINDER_CHAPTER_INNER_RADIUS,
          dangerEnd,
          dangerStart,
          true,
        );
        context.closePath();
        context.fill();

        if (canDrawImage && image) {
          context.save();
          context.beginPath();
          context.arc(0, 0, FINAL_BINDER_CHAPTER_OUTER_RADIUS, dangerStart, dangerEnd);
          context.arc(
            0,
            0,
            FINAL_BINDER_CHAPTER_INNER_RADIUS,
            dangerEnd,
            dangerStart,
            true,
          );
          context.closePath();
          context.clip();
          const sealSize = FINAL_BINDER_CHAPTER_OUTER_RADIUS * 2.08;
          context.globalAlpha = isBurst ? 0.88 : 0.28 + progress * 0.34;
          context.shadowColor = isBurst ? "#ff5b43" : "#c79b52";
          context.shadowBlur = isBurst ? 26 : 12;
          context.drawImage(
            image,
            sourceWidth,
            sourceHeight,
            sourceWidth,
            sourceHeight,
            -sealSize / 2,
            -sealSize / 2,
            sealSize,
            sealSize,
          );
          context.restore();
        }

        context.globalCompositeOperation = "lighter";
        context.strokeStyle = colorWithAlpha("#8ff5d6", isBurst ? 0.92 : 0.62);
        context.lineWidth = isBurst ? 5 : 3;
        context.shadowColor = "#71e8c9";
        context.shadowBlur = 14;
        for (const boundary of [
          safeAngle - FINAL_BINDER_CHAPTER_SAFE_HALF_ANGLE,
          safeAngle + FINAL_BINDER_CHAPTER_SAFE_HALF_ANGLE,
        ]) {
          context.beginPath();
          context.moveTo(
            Math.cos(boundary) * FINAL_BINDER_CHAPTER_INNER_RADIUS,
            Math.sin(boundary) * FINAL_BINDER_CHAPTER_INNER_RADIUS,
          );
          context.lineTo(
            Math.cos(boundary) * FINAL_BINDER_CHAPTER_OUTER_RADIUS,
            Math.sin(boundary) * FINAL_BINDER_CHAPTER_OUTER_RADIUS,
          );
          context.stroke();
        }
        context.restore();
      }

      context.restore();
      return true;
    };

    const drawPalimpsestPattern = (
      image: HTMLImageElement | undefined,
      enemy: Enemy,
    ) => {
      const state = enemy.archivist;
      if (!state || state.phase === "pursuit" || state.phase === "recovery") {
        return false;
      }

      const canDrawImage = Boolean(
        image?.complete && image.naturalWidth && image.naturalHeight,
      );
      const sourceWidth = (image?.naturalWidth ?? 0) / 4;
      const sourceHeight = (image?.naturalHeight ?? 0) / 2;
      const drawAtlasCell = (
        column: number,
        row: number,
        x: number,
        y: number,
        size: number,
        alpha = 1,
      ) => {
        if (!canDrawImage || !image) return false;
        context.save();
        context.globalCompositeOperation = "lighter";
        context.globalAlpha = alpha;
        context.shadowColor = row === 0 ? "#ff4267" : "#70f7e8";
        context.shadowBlur = row === 0 ? 22 : 16;
        context.drawImage(
          image,
          column * sourceWidth,
          row * sourceHeight,
          sourceWidth,
          sourceHeight,
          x - size / 2,
          y - size / 2,
          size,
          size,
        );
        context.restore();
        return true;
      };

      context.save();
      context.beginPath();
      context.rect(
        ROOM_GEOMETRY.left,
        ROOM_GEOMETRY.top,
        ROOM_GEOMETRY.right - ROOM_GEOMETRY.left,
        ROOM_GEOMETRY.bottom - ROOM_GEOMETRY.top,
      );
      context.clip();

      if (state.pattern === "proofRoute") {
        if (state.phase === "warning") {
          drawAtlasCell(0, 1, enemy.x, enemy.y + 8, 174, 0.82);
        }
        for (let index = 0; index < state.runes.length; index += 1) {
          const rune = state.runes[index];
          const completed = index < state.runeIndex;
          const current = index === state.runeIndex;
          const pulse = 1 + Math.sin(performance.now() / 170 + index) * 0.07;
          drawAtlasCell(
            completed ? 3 : current ? 2 : 1,
            1,
            rune.x,
            rune.y,
            (completed ? 82 : current ? 108 : 88) * pulse,
            completed ? 0.42 : current ? 1 : 0.7,
          );
          context.save();
          context.font = `800 ${readableCanvasFontSize(18, 14)}px serif`;
          context.textAlign = "center";
          context.textBaseline = "middle";
          context.fillStyle = completed ? "#79c9b8" : "#fff4c8";
          context.shadowColor = current ? "#6dfff0" : "#000000";
          context.shadowBlur = current ? 12 : 4;
          context.fillText(String(index + 1), rune.x, rune.y + 1);
          context.restore();
        }
      } else {
        const trace = state.trace;
        if (trace.length > 0) {
          const active = state.phase === "execute";
          context.save();
          context.globalCompositeOperation = active ? "lighter" : "source-over";
          context.lineCap = "round";
          context.lineJoin = "round";
          context.strokeStyle =
            state.pattern === "restoreTrace"
              ? active
                ? "rgba(126,255,231,.98)"
                : "rgba(104,223,205,.64)"
              : active
                ? "rgba(255,66,103,.98)"
                : "rgba(236,83,105,.62)";
          context.lineWidth = active ? 18 : state.phase === "record" ? 10 : 6;
          context.shadowColor =
            state.pattern === "restoreTrace" ? "#65ffe7" : "#ff315f";
          context.shadowBlur = active ? 24 : 12;
          context.beginPath();
          context.moveTo(trace[0].x, trace[0].y);
          for (let index = 1; index < trace.length; index += 1) {
            context.lineTo(trace[index].x, trace[index].y);
          }
          context.stroke();
          context.restore();

          if (active) {
            const head = tracePointAtArcProgress(trace, state.previousHeadProgress);
            const frame = Math.min(
              3,
              Math.floor(
                clamp(
                  1 - state.phaseTimer / PALIMPSEST_TRACE_EXECUTE_SECONDS,
                  0,
                  0.999,
                ) * 4,
              ),
            );
            drawAtlasCell(
              frame,
              state.pattern === "restoreTrace" ? 1 : 0,
              head.x,
              head.y,
              state.pattern === "restoreTrace" ? 112 : 132,
            );
          } else {
            const tail = trace[trace.length - 1];
            drawAtlasCell(
              state.phase === "record" ? 1 : 0,
              state.pattern === "restoreTrace" ? 1 : 0,
              tail.x,
              tail.y,
              state.phase === "record" ? 86 : 104,
              0.82,
            );
          }
        } else if (state.phase === "warning") {
          drawAtlasCell(
            0,
            state.pattern === "restoreTrace" ? 1 : 0,
            enemy.x,
            enemy.y + 10,
            158,
            0.76,
          );
        }
      }

      context.restore();
      return true;
    };

    const drawTimeRiftSprite = (
      image: HTMLImageElement | undefined,
      effect: VisualEffect,
      variant: "warning" | "burst",
    ) => {
      if (!image?.complete || !image.naturalWidth || !image.naturalHeight) {
        return false;
      }
      const progress = clamp(1 - effect.life / effect.duration, 0, 0.999);
      const frameIndex = clamp(Math.floor(progress * 4), 0, 3);
      const sourceCellWidth = image.naturalWidth / TIME_RIFT_SPRITE_GRID;
      const sourceCellHeight = image.naturalHeight / TIME_RIFT_SPRITE_GRID;
      const column = frameIndex % TIME_RIFT_SPRITE_GRID;
      const row = Math.floor(frameIndex / TIME_RIFT_SPRITE_GRID);
      const sourceInset = Math.ceil(
        Math.min(sourceCellWidth, sourceCellHeight) * TIME_RIFT_SOURCE_INSET_RATIO,
      );

      // The generated peak burst deliberately extends its vertical tear across the
      // atlas seam. Pull that tip back into frame 3 while every other frame uses a
      // guarded crop, so adjacent animation cells can never leak into one another.
      const restoresPeakBurst = variant === "burst" && frameIndex === 2;
      const sourceX = column * sourceCellWidth + sourceInset;
      const sourceY =
        row === 0
          ? row * sourceCellHeight + sourceInset
          : row * sourceCellHeight - sourceInset;
      const sourceWidth = sourceCellWidth - sourceInset * 2;
      const sourceHeight = restoresPeakBurst
        ? sourceCellHeight
        : sourceCellHeight - sourceInset * 2;
      const drawSize =
        variant === "warning" ? effect.size * 1.22 : effect.size * 1.16;
      const fadeOut =
        variant === "warning" ? 1 : clamp((1 - progress) / 0.18, 0, 1);

      context.save();
      context.globalCompositeOperation = variant === "warning" ? "source-over" : "screen";
      context.globalAlpha =
        (variant === "warning" ? 0.56 + progress * 0.42 : 0.96) * fadeOut;
      context.shadowColor = variant === "warning" ? "#63f7ff" : "#f05bff";
      context.shadowBlur =
        variant === "warning" ? 7 + progress * 9 : 14 + (1 - progress) * 14;
      context.imageSmoothingEnabled = true;
      context.drawImage(
        image,
        sourceX,
        sourceY,
        sourceWidth,
        sourceHeight,
        effect.x - drawSize / 2,
        effect.y - drawSize / 2,
        drawSize,
        drawSize,
      );
      context.restore();
      return true;
    };

    const drawCombatEffect = (effect: VisualEffect, clock: number) => {
      if (
        effect.kind === "summon" ||
        effect.kind === "teleport" ||
        effect.kind === "lootAwakening"
      ) {
        return false;
      }
      const progress = clamp(1 - effect.life / effect.duration, 0, 1);
      const fade = Math.sin(progress * Math.PI);
      const color = effect.color ?? "#ffffff";
      if (effect.vfxId) {
        const definition = GAMEPLAY_VFX_MANIFEST[effect.vfxId];
        const authoredDrawn = drawGameplayVfxFrame(
          context,
          imagesRef.current[gameplayVfxImageKey(effect.vfxId)],
          definition,
          {
            x: effect.x,
            y: effect.y,
            size: effect.size,
            progress,
            angle: effect.angle,
            alpha: Math.min(1, fade * 1.38),
            endX: effect.endX,
            endY: effect.endY,
          },
        );
        // Authored artwork replaces the former primitive path. A missing or
        // undecodable asset safely falls through to the legacy renderer.
        if (authoredDrawn) return true;
      }
      context.save();
      context.globalCompositeOperation = "lighter";
      context.lineCap = "round";

      if (effect.kind === "chainArc" && effect.endX !== undefined && effect.endY !== undefined) {
        const segments = 7;
        const deltaX = effect.endX - effect.x;
        const deltaY = effect.endY - effect.y;
        const length = Math.max(1, Math.hypot(deltaX, deltaY));
        const normalX = -deltaY / length;
        const normalY = deltaX / length;
        const traceArc = (width: number, stroke: string, jitterScale: number) => {
          context.beginPath();
          context.moveTo(effect.x, effect.y);
          for (let index = 1; index < segments; index += 1) {
            const ratio = index / segments;
            const jitter =
              Math.sin(effect.id * 2.17 + index * 5.43 + clock * 38) * effect.size * jitterScale;
            context.lineTo(
              effect.x + deltaX * ratio + normalX * jitter,
              effect.y + deltaY * ratio + normalY * jitter,
            );
          }
          context.lineTo(effect.endX!, effect.endY!);
          context.lineWidth = width;
          context.strokeStyle = stroke;
          context.stroke();
        };
        context.globalAlpha = fade * 0.38;
        traceArc(effect.size * 0.75, colorWithAlpha(color, 0.72), 0.72);
        context.globalAlpha = fade;
        traceArc(Math.max(1.2, effect.size * 0.16), "rgba(245,242,255,.96)", 0.62);
        context.restore();
        return true;
      }

      if (effect.kind === "timeRiftTelegraph") {
        const warningRadius = effect.size / 2;
        const urgency = clamp(progress, 0, 1);
        const pulse = 1 + Math.sin(clock * 12 + effect.id) * (0.02 + urgency * 0.035);
        const spriteDrawn = drawTimeRiftSprite(
          imagesRef.current.timeRiftWarning,
          effect,
          "warning",
        );
        context.translate(effect.x, effect.y);
        context.globalCompositeOperation = "source-over";
        context.fillStyle = `rgba(16, 8, 38, ${spriteDrawn ? 0.08 + urgency * 0.06 : 0.2 + urgency * 0.14})`;
        context.beginPath();
        context.arc(0, 0, spriteDrawn ? warningRadius : warningRadius * pulse, 0, Math.PI * 2);
        context.fill();
        context.globalCompositeOperation = "lighter";
        context.shadowColor = "#63f7ff";
        context.shadowBlur = 8 + urgency * 12;
        context.strokeStyle = `rgba(99, 247, 255, ${0.66 + urgency * 0.3})`;
        context.lineWidth = spriteDrawn ? 1.6 + urgency * 1.4 : 2.2 + urgency * 1.8;
        context.beginPath();
        context.arc(0, 0, spriteDrawn ? warningRadius : warningRadius * pulse, 0, Math.PI * 2);
        context.stroke();
        if (spriteDrawn) {
          context.restore();
          return true;
        }
        context.strokeStyle = `rgba(240, 91, 255, ${0.5 + urgency * 0.42})`;
        context.lineWidth = 1.4 + urgency;
        context.beginPath();
        context.arc(
          0,
          0,
          warningRadius * (0.64 + urgency * 0.12),
          clock * 0.9,
          clock * 0.9 + Math.PI * 1.45,
        );
        context.stroke();
        for (let rune = 0; rune < 8; rune += 1) {
          const runeAngle = (Math.PI * 2 * rune) / 8 - clock * 0.34;
          const runeDistance = warningRadius * 0.79;
          const runeSize = 4 + urgency * 2.2;
          context.save();
          context.translate(
            Math.cos(runeAngle) * runeDistance,
            Math.sin(runeAngle) * runeDistance,
          );
          context.rotate(runeAngle + Math.PI / 4);
          context.strokeRect(-runeSize / 2, -runeSize / 2, runeSize, runeSize);
          context.restore();
        }
        context.restore();
        return true;
      }

      if (effect.kind === "timeRiftBurst") {
        if (
          drawTimeRiftSprite(imagesRef.current.timeRiftBurst, effect, "burst")
        ) {
          context.restore();
          return true;
        }
        const burstAlpha = Math.pow(1 - progress, 1.25);
        const burstRadius = effect.size * (0.18 + progress * 0.5);
        context.translate(effect.x, effect.y);
        context.globalCompositeOperation = "lighter";
        const burst = context.createRadialGradient(0, 0, 0, 0, 0, burstRadius);
        burst.addColorStop(0, `rgba(255, 255, 255, ${burstAlpha})`);
        burst.addColorStop(0.22, `rgba(99, 247, 255, ${burstAlpha * 0.94})`);
        burst.addColorStop(0.58, `rgba(240, 91, 255, ${burstAlpha * 0.68})`);
        burst.addColorStop(1, "rgba(240, 91, 255, 0)");
        context.fillStyle = burst;
        context.beginPath();
        context.arc(0, 0, burstRadius, 0, Math.PI * 2);
        context.fill();
        context.globalAlpha = burstAlpha;
        context.shadowColor = "#f05bff";
        context.shadowBlur = 24;
        for (let ray = 0; ray < 12; ray += 1) {
          const rayAngle = (Math.PI * 2 * ray) / 12 + effect.id * 0.41;
          context.save();
          context.rotate(rayAngle);
          context.strokeStyle = ray % 2 === 0 ? "#63f7ff" : "#f05bff";
          context.lineWidth = ray % 2 === 0 ? 3 : 2;
          context.beginPath();
          context.moveTo(burstRadius * 0.18, 0);
          context.lineTo(burstRadius * (0.82 + (ray % 3) * 0.09), 0);
          context.stroke();
          context.restore();
        }
        context.restore();
        return true;
      }

      if (effect.kind === "phantomTrail") {
        const trailFade = Math.pow(1 - progress, 1.65) * 0.7;
        context.translate(effect.x, effect.y);
        context.rotate((effect.angle ?? 0) + Math.PI / 2);
        context.globalAlpha = trailFade;
        context.shadowColor = color;
        context.shadowBlur = 22;
        const trailGradient = context.createRadialGradient(0, 0, 2, 0, 0, effect.size * 0.5);
        trailGradient.addColorStop(0, colorWithAlpha(color, 0.6));
        trailGradient.addColorStop(0.45, colorWithAlpha(color, 0.22));
        trailGradient.addColorStop(1, colorWithAlpha(color, 0));
        context.fillStyle = trailGradient;
        context.beginPath();
        context.ellipse(0, 0, effect.size * 0.34, effect.size * 0.58, 0, 0, Math.PI * 2);
        context.fill();
        context.strokeStyle = colorWithAlpha("#eee7ff", 0.72);
        context.lineWidth = 1.6;
        for (const side of [-1, 1]) {
          context.beginPath();
          context.moveTo(side * effect.size * 0.12, -effect.size * 0.34);
          context.quadraticCurveTo(
            side * effect.size * 0.3,
            0,
            side * effect.size * 0.08,
            effect.size * 0.42,
          );
          context.stroke();
        }
        context.restore();
        return true;
      }

      if (effect.kind === "mirrorWave" || effect.kind === "mirrorBlock") {
        const waveRadius =
          effect.kind === "mirrorWave"
            ? effect.size * (0.12 + progress * 0.48)
            : effect.size * (0.22 + progress * 0.24);
        context.translate(effect.x, effect.y);
        context.rotate(effect.angle ?? 0);
        context.globalAlpha = fade;
        context.shadowColor = color;
        context.shadowBlur = effect.kind === "mirrorWave" ? 28 : 16;
        for (let ring = 0; ring < (effect.kind === "mirrorWave" ? 3 : 2); ring += 1) {
          context.strokeStyle =
            ring === 0 ? "rgba(245,255,255,.96)" : colorWithAlpha(color, 0.82 - ring * 0.18);
          context.lineWidth = Math.max(1.4, 4.4 - ring * 1.25);
          context.beginPath();
          context.arc(0, 0, waveRadius * (1 - ring * 0.13), 0, Math.PI * 2);
          context.stroke();
        }
        const shardCount = effect.kind === "mirrorWave" ? 12 : 6;
        context.fillStyle = "rgba(235,255,255,.92)";
        for (let shard = 0; shard < shardCount; shard += 1) {
          context.save();
          context.rotate((Math.PI * 2 * shard) / shardCount + clock * 0.7);
          context.beginPath();
          context.moveTo(waveRadius * 0.82, 0);
          context.lineTo(waveRadius * 1.12, 3);
          context.lineTo(waveRadius * 1.03, -3);
          context.closePath();
          context.fill();
          context.restore();
        }
        context.restore();
        return true;
      }

      if (effect.kind === "starfallBurst") {
        context.translate(effect.x, effect.y);
        context.globalAlpha = fade;
        context.shadowColor = color;
        context.shadowBlur = 24;
        const starRadius = effect.size * (0.18 + progress * 0.38);
        for (let star = 0; star < 10; star += 1) {
          const angle = (Math.PI * 2 * star) / 10 - clock * 0.8;
          const x = Math.cos(angle) * starRadius;
          const y = Math.sin(angle) * starRadius * 0.72;
          const size = 3 + (star % 3) * 1.7;
          context.save();
          context.translate(x, y);
          context.rotate(angle + progress * 1.5);
          context.fillStyle = star % 2 === 0 ? "#fff8d6" : color;
          context.beginPath();
          context.moveTo(0, -size * 1.8);
          context.lineTo(size * 0.42, -size * 0.42);
          context.lineTo(size * 1.8, 0);
          context.lineTo(size * 0.42, size * 0.42);
          context.lineTo(0, size * 1.8);
          context.lineTo(-size * 0.42, size * 0.42);
          context.lineTo(-size * 1.8, 0);
          context.lineTo(-size * 0.42, -size * 0.42);
          context.closePath();
          context.fill();
          context.restore();
        }
        context.restore();
        return true;
      }

      if (effect.kind === "bloodwovenBurst") {
        context.translate(effect.x, effect.y);
        context.rotate(effect.angle ?? 0);
        context.globalAlpha = fade;
        context.shadowColor = color;
        context.shadowBlur = 24;
        context.strokeStyle = color;
        context.lineWidth = 3.2;
        for (const offset of [-0.22, 0, 0.22]) {
          context.save();
          context.rotate(offset);
          context.beginPath();
          context.moveTo(-effect.size * 0.22, 0);
          context.quadraticCurveTo(
            effect.size * 0.12,
            -effect.size * 0.2,
            effect.size * (0.44 + progress * 0.32),
            0,
          );
          context.stroke();
          context.restore();
        }
        context.restore();
        return true;
      }

      if (effect.kind === "ashboundShield") {
        context.translate(effect.x, effect.y);
        context.globalAlpha = fade;
        context.shadowColor = color;
        context.shadowBlur = 22;
        const ashRadius = effect.size * (0.2 + progress * 0.32);
        context.strokeStyle = color;
        context.lineWidth = 3;
        context.beginPath();
        context.arc(0, 0, ashRadius, clock * 0.55, clock * 0.55 + Math.PI * 1.48);
        context.stroke();
        context.strokeStyle = "rgba(255,229,178,.72)";
        context.lineWidth = 1.5;
        context.beginPath();
        context.arc(0, 0, ashRadius * 0.82, -clock * 0.7, -clock * 0.7 + Math.PI * 1.32);
        context.stroke();
        for (let mote = 0; mote < 9; mote += 1) {
          const angle = (Math.PI * 2 * mote) / 9 + clock * (mote % 2 ? -0.7 : 0.5);
          const distanceFromCenter = ashRadius * (0.74 + (mote % 3) * 0.12);
          context.fillStyle = mote % 2 ? "#6f5a4a" : "#f2ca83";
          context.fillRect(
            Math.cos(angle) * distanceFromCenter - 1.5,
            Math.sin(angle) * distanceFromCenter - 1.5,
            3,
            3,
          );
        }
        context.restore();
        return true;
      }

      context.translate(effect.x, effect.y);
      context.rotate(effect.angle ?? 0);
      const radius = effect.size * (0.28 + progress * 0.72);
      context.shadowColor = color;
      context.shadowBlur = Math.min(28, effect.size * 0.8);

      if (effect.kind === "muzzle") {
        context.globalAlpha = fade * 0.75;
        context.fillStyle = colorWithAlpha(color, 0.52);
        context.beginPath();
        context.moveTo(effect.size * (0.5 + progress * 0.35), 0);
        context.lineTo(-effect.size * 0.25, effect.size * 0.24 * (1 - progress * 0.5));
        context.lineTo(-effect.size * 0.08, 0);
        context.lineTo(-effect.size * 0.25, -effect.size * 0.24 * (1 - progress * 0.5));
        context.closePath();
        context.fill();
      }

      context.globalAlpha = fade * (effect.kind === "hostileImpact" ? 0.88 : 0.72);
      context.strokeStyle = color;
      context.lineWidth = Math.max(1.3, effect.size * 0.08 * (1 - progress));
      context.beginPath();
      context.arc(0, 0, radius, 0, Math.PI * 2);
      context.stroke();

      const rayCount = effect.kind === "hostileImpact" ? 9 : 7;
      context.fillStyle = effect.kind === "hostileImpact" ? "#ffd1c9" : "#f5ffff";
      context.globalAlpha = fade * 0.82;
      for (let ray = 0; ray < rayCount; ray += 1) {
        const rayAngle = (Math.PI * 2 * ray) / rayCount + effect.id * 0.37;
        const inner = effect.size * (0.12 + progress * 0.18);
        const outer = effect.size * (0.4 + progress * (0.48 + (ray % 3) * 0.08));
        context.save();
        context.rotate(rayAngle);
        context.beginPath();
        context.moveTo(inner, 0);
        context.lineTo(outer, effect.size * 0.035);
        context.lineTo(outer * 0.76, -effect.size * 0.035);
        context.closePath();
        context.fill();
        context.restore();
      }
      context.restore();
      return true;
    };

    const drawProjectileVfx = (
      projectile: Projectile,
      clock: number,
      projectileCount: number,
      layer: "trail" | "core",
    ) => {
      const speed = Math.max(1, Math.hypot(projectile.vx, projectile.vy));
      const angle = Math.atan2(projectile.vy, projectile.vx);
      const radius = projectile.radius;
      const fadeIn = clamp(projectile.age / 0.07, 0, 1);
      const fadeOut = clamp(projectile.life / 0.14, 0, 1);
      const alpha = fadeIn * fadeOut;
      const dense = projectileCount > 120;
      const overloaded = projectileCount > 220;
      const speedScale = clamp(speed / 660, 0.65, 1.18);
      const tailLength =
        (projectile.hostile ? 24 + radius * 2.2 : 36 + radius * 3.4) *
        (projectile.returning ? 1.22 : 1) *
        (dense ? 0.76 : 1) *
        speedScale;
      const pulse = 0.82 + Math.sin(clock * 12 + projectile.id * 1.71) * 0.18;

      if (layer === "core" && projectile.vfxId) {
        const definition = GAMEPLAY_VFX_MANIFEST[projectile.vfxId];
        const authoredDrawn = drawGameplayVfxFrame(
          context,
          imagesRef.current[gameplayVfxImageKey(projectile.vfxId)],
          definition,
          {
            x: projectile.x,
            y: projectile.y,
            size: projectile.radius,
            progress: positiveModulo(projectile.age * 8, 1),
            angle,
            alpha,
            frameOffset: projectile.id,
          },
        );
        // Do not paint the old circle/diamond core behind loaded authored art.
        if (authoredDrawn) return;
      }

      context.save();
      context.translate(projectile.x, projectile.y);
      context.rotate(angle);
      context.lineCap = "round";

      if (layer === "trail") {
        context.globalCompositeOperation = "lighter";
        const trail = context.createLinearGradient(-tailLength, 0, radius, 0);
        trail.addColorStop(0, colorWithAlpha(projectile.color, 0));
        trail.addColorStop(0.46, colorWithAlpha(projectile.color, alpha * 0.18));
        trail.addColorStop(1, colorWithAlpha(projectile.color, alpha * 0.86));
        context.strokeStyle = trail;
        context.lineWidth = radius * (projectile.hostile ? 1.1 : 1.35);
        context.beginPath();
        context.moveTo(-tailLength, 0);
        context.lineTo(radius * 0.5, 0);
        context.stroke();

        if (projectile.affinity === "storm" && !overloaded) {
          context.strokeStyle = colorWithAlpha("#eee9ff", alpha * 0.76);
          context.lineWidth = 1.2;
          context.beginPath();
          context.moveTo(-tailLength * 0.82, 0);
          for (let segment = 1; segment <= 5; segment += 1) {
            const ratio = segment / 5;
            context.lineTo(
              -tailLength * (0.82 - ratio * 0.86),
              Math.sin(projectile.id * 2.3 + segment * 4.7 + clock * 31) * radius * 0.75,
            );
          }
          context.stroke();
        } else if (projectile.affinity === "ember" && !overloaded) {
          context.fillStyle = colorWithAlpha("#ffc06f", alpha * 0.72);
          for (let spark = 0; spark < 3; spark += 1) {
            const sparkX = -tailLength * (0.25 + spark * 0.22);
            const sparkY = Math.sin(projectile.id + spark * 2.8 + clock * 17) * radius * 1.3;
            context.beginPath();
            context.arc(sparkX, sparkY, Math.max(1, radius * (0.22 - spark * 0.035)), 0, Math.PI * 2);
            context.fill();
          }
        } else if (projectile.affinity === "blood" && !dense) {
          context.fillStyle = colorWithAlpha("#ffb0c8", alpha * 0.8);
          for (let drop = 0; drop < 3; drop += 1) {
            const dropX = -tailLength * (0.2 + drop * 0.24);
            const dropY = Math.sin(clock * 12 + projectile.id + drop * 2.4) * radius;
            context.beginPath();
            context.arc(dropX, dropY, Math.max(1, radius * (0.25 - drop * 0.035)), 0, Math.PI * 2);
            context.fill();
          }
        } else if (projectile.affinity === "poison" && !dense) {
          context.fillStyle = colorWithAlpha("#c8ff9a", alpha * 0.48);
          for (let bubble = 0; bubble < 2; bubble += 1) {
            context.beginPath();
            context.arc(
              -tailLength * (0.3 + bubble * 0.3),
              Math.sin(clock * 5 + projectile.id + bubble * 3) * radius * 1.5,
              radius * (0.28 + bubble * 0.12),
              0,
              Math.PI * 2,
            );
            context.fill();
          }
        }
        context.restore();
        return;
      }

      context.globalAlpha = alpha;
      if (projectile.hostile) {
        context.globalCompositeOperation = "source-over";
        context.fillStyle = "rgba(5,2,7,.9)";
        context.strokeStyle = projectile.color;
        context.lineWidth = Math.max(1.5, radius * 0.28);
        context.shadowColor = projectile.color;
        context.shadowBlur = overloaded ? 7 : 15;
        context.beginPath();
        context.arc(0, 0, radius * 1.45, 0, Math.PI * 2);
        context.fill();
        context.stroke();

        context.globalCompositeOperation = "lighter";
        context.fillStyle = projectile.affinity === "boss" ? "#ffe2a3" : "#fff0ed";
        context.beginPath();
        context.arc(radius * 0.16, 0, radius * 0.54 * pulse, 0, Math.PI * 2);
        context.fill();

        if (!dense && (projectile.affinity === "witch" || projectile.affinity === "boss")) {
          const satellites = projectile.affinity === "boss" ? 4 : 3;
          context.strokeStyle = projectile.affinity === "boss" ? "#d8b56a" : "#e29aff";
          context.lineWidth = 1.2;
          context.beginPath();
          context.arc(0, 0, radius * 2.15, 0, Math.PI * 2);
          context.stroke();
          context.fillStyle = context.strokeStyle;
          for (let index = 0; index < satellites; index += 1) {
            const orbitAngle = clock * (projectile.affinity === "boss" ? -3 : 5) +
              (Math.PI * 2 * index) / satellites + projectile.id;
            context.beginPath();
            context.arc(
              Math.cos(orbitAngle) * radius * 2.15,
              Math.sin(orbitAngle) * radius * 2.15,
              Math.max(1.2, radius * 0.22),
              0,
              Math.PI * 2,
            );
            context.fill();
          }
        }
      } else {
        context.globalCompositeOperation = "lighter";
        context.shadowColor = projectile.color;
        context.shadowBlur = overloaded ? 8 : 18;
        context.fillStyle = projectile.color;
        context.beginPath();
        if (projectile.affinity === "blood") {
          context.moveTo(radius * 2.15, 0);
          context.lineTo(-radius * 0.2, radius * 1.2);
          context.lineTo(-radius * 1.55, radius * 0.5);
          context.lineTo(-radius * 0.82, 0);
          context.lineTo(-radius * 1.55, -radius * 0.5);
          context.lineTo(-radius * 0.2, -radius * 1.2);
          context.closePath();
        } else if (projectile.affinity === "poison") {
          context.arc(0, 0, radius * 1.08 * pulse, 0, Math.PI * 2);
        } else if (projectile.affinity === "ember") {
          context.moveTo(radius * 2.1, 0);
          context.quadraticCurveTo(-radius * 0.3, radius * 1.22, -radius * 1.45, 0);
          context.quadraticCurveTo(-radius * 0.28, -radius * 1.22, radius * 2.1, 0);
        } else {
          context.moveTo(radius * 2, 0);
          context.lineTo(-radius * 0.55, radius * 1.05);
          context.lineTo(-radius * 1.45, 0);
          context.lineTo(-radius * 0.55, -radius * 1.05);
          context.closePath();
        }
        context.fill();
        context.fillStyle = "rgba(244,255,255,.96)";
        context.beginPath();
        context.arc(radius * 0.42, 0, Math.max(1.4, radius * 0.42), 0, Math.PI * 2);
        context.fill();

        if (projectile.affinity === "frost" && !dense) {
          context.strokeStyle = "rgba(224,251,255,.82)";
          context.lineWidth = 1.2;
          for (let shard = -1; shard <= 1; shard += 2) {
            context.beginPath();
            context.moveTo(-radius * 0.3, shard * radius * 0.5);
            context.lineTo(-radius * 1.5, shard * radius * 1.45);
            context.stroke();
          }
        }
        if (projectile.affinity === "blood" && !dense) {
          context.strokeStyle = colorWithAlpha("#ffd4e1", 0.86 * alpha);
          context.lineWidth = 1.3;
          context.beginPath();
          context.arc(-radius * 0.35, 0, radius * 1.55 * pulse, -0.92, 0.92);
          context.stroke();
        }
        if (projectile.affinity === "echo" || projectile.returning) {
          context.strokeStyle = colorWithAlpha("#e2c7ff", 0.72 * alpha);
          context.lineWidth = 1.4;
          context.beginPath();
          context.arc(-radius * 0.6, 0, radius * 1.7 * pulse, 0, Math.PI * 2);
          context.stroke();
        }
      }
      context.restore();
    };

    const draw = () => {
      const player = playerRef.current;
      const world = worldRef.current;
      const images = imagesRef.current;
      context.clearRect(0, 0, WIDTH, HEIGHT);
      context.fillStyle = "#0a0b0d";
      context.fillRect(0, 0, WIDTH, HEIGHT);

      const roomArtKey = resolveRoomArtKey({
        seed: world.seed,
        dungeonFloor: world.dungeonFloor,
        roomX: world.roomX,
        roomY: world.roomY,
        roomKind: world.roomKind,
      });
      const currentRoomKey = keyOf(world.roomX, world.roomY);
      const isStairRoom = world.stairRoomLookup[currentRoomKey] === true;
      const roomArt = images[roomArtKey];
      let stairRoomArt: HTMLImageElement | undefined;
      let stairRoomArtReady = false;

      if (isStairRoom) {
        const stairRoomArtKey = resolveStairRoomArtKey(roomArtKey);
        const retryState = stairRoomArtRetryRef.current[stairRoomArtKey];
        stairRoomArt = images[stairRoomArtKey];
        if (
          !stairRoomArt &&
          (!retryState ||
            (retryState.attempts < 2 && performance.now() >= retryState.retryAt))
        ) {
          const attempts = (retryState?.attempts ?? 0) + 1;
          stairRoomArt = new Image();
          stairRoomArt.decoding = "async";
          stairRoomArt.onload = async () => {
            try {
              await stairRoomArt?.decode();
            } catch {
              // A loaded image can still be drawn when decode() is unavailable.
            }
            if (stairRoomArt?.naturalWidth && stairRoomArt.naturalHeight) {
              decodedStairRoomArtRef.current.add(stairRoomArtKey);
              delete stairRoomArtRetryRef.current[stairRoomArtKey];
              stairRoomArtLastUsedRef.current.set(
                stairRoomArtKey,
                performance.now(),
              );

              const activeWorld = worldRef.current;
              const activeRoomKey = keyOf(
                activeWorld.roomX,
                activeWorld.roomY,
              );
              const activeStairRoomArtKey =
                activeWorld.stairRoomLookup[activeRoomKey] === true
                  ? resolveStairRoomArtKey(
                      resolveRoomArtKey({
                        seed: activeWorld.seed,
                        dungeonFloor: activeWorld.dungeonFloor,
                        roomX: activeWorld.roomX,
                        roomY: activeWorld.roomY,
                        roomKind: activeWorld.roomKind,
                      }),
                    )
                  : null;
              const retainedKeys = new Set<RoomStairArtKey>();
              if (activeStairRoomArtKey) {
                retainedKeys.add(activeStairRoomArtKey);
              }
              for (const [recentKey] of [
                ...stairRoomArtLastUsedRef.current.entries(),
              ]
                .filter(([key]) => key !== activeStairRoomArtKey)
                .sort((left, right) => right[1] - left[1])
                .slice(0, activeStairRoomArtKey ? 1 : 2)) {
                retainedKeys.add(recentKey);
              }
              for (const decodedKey of decodedStairRoomArtRef.current) {
                if (retainedKeys.has(decodedKey)) continue;
                delete imagesRef.current[decodedKey];
                decodedStairRoomArtRef.current.delete(decodedKey);
                stairRoomArtLastUsedRef.current.delete(decodedKey);
              }
            }
          };
          stairRoomArt.onerror = () => {
            if (imagesRef.current[stairRoomArtKey] === stairRoomArt) {
              delete imagesRef.current[stairRoomArtKey];
            }
            decodedStairRoomArtRef.current.delete(stairRoomArtKey);
            stairRoomArtRetryRef.current[stairRoomArtKey] = {
              attempts,
              retryAt: performance.now() + 1500,
            };
          };
          stairRoomArt.src = ROOM_STAIR_ART_PATHS[stairRoomArtKey];
          images[stairRoomArtKey] = stairRoomArt;
        }
        stairRoomArtReady = Boolean(
          stairRoomArt.complete &&
            stairRoomArt.naturalWidth &&
            stairRoomArt.naturalHeight &&
            decodedStairRoomArtRef.current.has(stairRoomArtKey),
        );
      }

      const roomGrade = ROOM_COLOR_GRADE[world.roomKind];
      const mirrorRoom =
        !["shelter", "boss"].includes(world.roomKind) &&
        hash(world.seed, world.roomX, world.roomY, 9041) > 0.5;
      const drawRoomBackplate = (
        image: HTMLImageElement,
        alpha = 1,
      ) => {
        context.save();
        context.globalAlpha = alpha;
        context.imageSmoothingEnabled = true;
        context.imageSmoothingQuality = "high";
        if (mirrorRoom) {
          context.translate(WIDTH, 0);
          context.scale(-1, 1);
        }
        context.drawImage(image, 0, 0, WIDTH, HEIGHT);
        context.restore();
      };
      if (
        stairRoomArtReady &&
        stairRoomArt?.complete &&
        stairRoomArt.naturalWidth &&
        stairRoomArt.naturalHeight
      ) {
        drawRoomBackplate(stairRoomArt);
      } else if (
        roomArt?.complete &&
        roomArt.naturalWidth &&
        roomArt.naturalHeight
      ) {
        drawRoomBackplate(roomArt);
      } else {
        const fallback = context.createRadialGradient(
          WIDTH / 2,
          HEIGHT / 2,
          90,
          WIDTH / 2,
          HEIGHT / 2,
          720,
        );
        fallback.addColorStop(0, roomGrade.tint);
        fallback.addColorStop(1, "#06080b");
        context.globalAlpha = 0.36;
        context.fillStyle = fallback;
        context.fillRect(0, 0, WIDTH, HEIGHT);
        context.globalAlpha = 1;
      }
      context.save();
      context.globalCompositeOperation = "soft-light";
      context.globalAlpha = world.roomKind === "shelter" ? 0.12 : 0.07;
      context.fillStyle = roomGrade.tint;
      context.fillRect(0, 0, WIDTH, HEIGHT);
      context.restore();

      context.fillStyle = roomVignette;
      context.fillRect(0, 0, WIDTH, HEIGHT);

      const ambientTime = performance.now() / 1000;
      const existingDoorways = dungeonDoorAccess(
        world.roomX,
        world.roomY,
        true,
      );
      context.save();
      context.fillStyle = roomGrade.mote;
      for (let index = 0; index < 18; index += 1) {
        const baseX = hash(world.seed, world.roomX, world.roomY, 1200 + index) * WIDTH;
        const baseY = hash(world.seed, world.roomX, world.roomY, 2200 + index) * HEIGHT;
        const drift = ambientTime * (5 + hash(world.seed, index, world.roomX, 3200) * 7);
        const x = positiveModulo(baseX + Math.sin(ambientTime * 0.43 + index) * 10, WIDTH);
        const y = positiveModulo(baseY - drift, HEIGHT);
        const edgeWeight = clamp(Math.abs(x - WIDTH / 2) / (WIDTH / 2), 0.18, 1);
        context.globalAlpha = (0.04 + 0.12 * Math.sin(ambientTime * 0.8 + index) ** 2) * edgeWeight;
        context.beginPath();
        context.arc(x, y, 0.8 + (index % 3) * 0.55, 0, Math.PI * 2);
        context.fill();
      }
      context.restore();

      const doorImage = images.roomPortcullis;
      const animatedDoorFrame = roomDoorFrame(world.doorMotion);
      const drawRoomDoor = ({ side, x, y, angle }: (typeof ROOM_DOOR_PLACEMENTS)[number]) => {
        // The 99x99 perimeter has no neighboring room. Keep that authored gate
        // fully lowered even after the current encounter is cleared.
        const frame = existingDoorways[side] ? animatedDoorFrame : 0;
        context.save();
        context.translate(x, y);
        context.rotate(angle);
        if (doorImage?.complete && doorImage.naturalWidth && doorImage.naturalHeight) {
          context.imageSmoothingEnabled = true;
          context.imageSmoothingQuality = "high";
          context.drawImage(
            doorImage,
            frame * ROOM_DOOR_ATLAS_CELL_SIZE,
            0,
            ROOM_DOOR_ATLAS_CELL_SIZE,
            ROOM_DOOR_ATLAS_CELL_SIZE,
            -ROOM_DOOR_DRAW_WIDTH / 2,
            -ROOM_DOOR_DRAW_HEIGHT,
            ROOM_DOOR_DRAW_WIDTH,
            ROOM_DOOR_DRAW_HEIGHT,
          );
        } else {
          // Asset loading failure stays physically honest: an opaque emergency
          // shutter is safer than showing an open corridor that is still solid.
          context.fillStyle = "rgba(12,14,16,.96)";
          context.fillRect(
            -ROOM_DOOR_DRAW_WIDTH / 2,
            -ROOM_DOOR_DRAW_HEIGHT,
            ROOM_DOOR_DRAW_WIDTH,
            ROOM_DOOR_DRAW_HEIGHT,
          );
        }
        context.restore();
      };

      ROOM_DOOR_PLACEMENTS.forEach(drawRoomDoor);

      if (inputRef.current.hasMoveTarget) {
        const pulse = 12 + Math.sin(performance.now() / 140) * 3;
        context.beginPath();
        context.strokeStyle = "rgba(113,212,193,.72)";
        context.lineWidth = 2;
        context.arc(
          inputRef.current.moveTargetX,
          inputRef.current.moveTargetY,
          pulse,
          0,
          Math.PI * 2,
        );
        context.stroke();
        context.beginPath();
        context.fillStyle = "rgba(113,212,193,.7)";
        context.arc(
          inputRef.current.moveTargetX,
          inputRef.current.moveTargetY,
          3,
          0,
          Math.PI * 2,
        );
        context.fill();
      }

      for (const effect of world.effects) {
        if (effect.kind === "lootAwakening") {
          const config = EQUIPMENT_RARITY_VFX[effect.rarity ?? "common"];
          drawLootAwakening(
            images[config.imageKey],
            effect,
            ambientTime,
          );
        }
      }

      for (const drop of world.gearDrops) {
        const rarity = GEAR_RARITY_META[drop.item.rarity];
        const rarityTier = EQUIPMENT_RARITY_TIER[drop.item.rarity];
        const rarityVfx = EQUIPMENT_RARITY_VFX[drop.item.rarity];
        const bob = Math.sin(ambientTime * 2.8 + drop.id * 0.61) * 3;
        const appearanceProgress = clamp(
          (drop.appearanceAge ?? rarityVfx.awakeningDuration) /
            rarityVfx.awakeningDuration,
          0,
          1,
        );
        const beamRevealRaw = clamp(
          (appearanceProgress - rarityVfx.beamRevealAt) /
            Math.max(0.08, 1 - rarityVfx.beamRevealAt),
          0,
          1,
        );
        const itemRevealRaw = clamp(
          (appearanceProgress - rarityVfx.itemRevealAt) / 0.2,
          0,
          1,
        );
        const beamReveal =
          beamRevealRaw * beamRevealRaw * (3 - 2 * beamRevealRaw);
        const itemReveal =
          itemRevealRaw * itemRevealRaw * (3 - 2 * itemRevealRaw);
        context.save();
        if (beamReveal > 0.001) {
          const { beamHeight, beamWidth } = rarityVfx;
          const beam = context.createLinearGradient(
            drop.x,
            drop.y - beamHeight,
            drop.x,
            drop.y + 12,
          );
          beam.addColorStop(0, colorWithAlpha(rarity.color, 0));
          beam.addColorStop(
            0.5,
            colorWithAlpha(rarity.color, 0.13 + rarityTier * 0.035),
          );
          beam.addColorStop(
            0.82,
            colorWithAlpha(rarity.color, 0.3 + rarityTier * 0.06),
          );
          beam.addColorStop(1, colorWithAlpha(rarity.color, 0.72));
          context.globalAlpha = beamReveal;
          context.globalCompositeOperation = "lighter";
          context.fillStyle = beam;
          context.beginPath();
          context.moveTo(drop.x - beamWidth, drop.y + 10);
          context.lineTo(drop.x - beamWidth * 0.18, drop.y - beamHeight);
          context.lineTo(drop.x + beamWidth * 0.18, drop.y - beamHeight);
          context.lineTo(drop.x + beamWidth, drop.y + 10);
          context.closePath();
          context.fill();

          const core = context.createLinearGradient(
            drop.x,
            drop.y - beamHeight,
            drop.x,
            drop.y + 8,
          );
          core.addColorStop(0, "rgba(255,255,255,0)");
          core.addColorStop(
            0.72,
            colorWithAlpha("#fffdf2", 0.12 + rarityTier * 0.045),
          );
          core.addColorStop(1, colorWithAlpha("#fffdf2", 0.64));
          context.fillStyle = core;
          context.fillRect(
            drop.x - Math.max(1, beamWidth * 0.13),
            drop.y - beamHeight,
            Math.max(2, beamWidth * 0.26),
            beamHeight + 8,
          );

          context.beginPath();
          context.fillStyle = colorWithAlpha(rarity.color, 0.18);
          context.ellipse(
            drop.x,
            drop.y + 8,
            26 + rarityTier * 5,
            11 + rarityTier * 2,
            0,
            0,
            Math.PI * 2,
          );
          context.fill();

          if (rarityTier >= 2) {
            context.strokeStyle = colorWithAlpha(rarity.color, 0.58);
            context.lineWidth = 1.2 + rarityTier * 0.35;
            context.shadowColor = rarity.color;
            context.shadowBlur = 10 + rarityTier * 3;
            const runePulse =
              1 + Math.sin(ambientTime * 2.4 + drop.id) * 0.08;
            context.beginPath();
            context.ellipse(
              drop.x,
              drop.y + 9,
              (32 + rarityTier * 5) * runePulse,
              (13 + rarityTier * 2) * runePulse,
              0,
              0,
              Math.PI * 2,
            );
            context.stroke();
            if (rarityTier >= 5) {
              context.beginPath();
              context.ellipse(
                drop.x,
                drop.y + 9,
                (43 + Math.sin(ambientTime * 3.2 + drop.id) * 3) *
                  runePulse,
                18 * runePulse,
                0,
                0,
                Math.PI * 2,
              );
              context.stroke();
              if (rarityTier >= 6) {
                context.save();
                context.globalAlpha =
                  beamReveal *
                  (0.72 + Math.sin(ambientTime * 4 + drop.id) * 0.18);
                context.translate(drop.x, drop.y + 9);
                context.rotate(ambientTime * 0.45);
                context.beginPath();
                context.moveTo(0, -16);
                context.lineTo(34, 0);
                context.lineTo(0, 16);
                context.lineTo(-34, 0);
                context.closePath();
                context.stroke();
                if (rarityTier === EQUIPMENT_RARITY_TIER.cosmic) {
                  context.rotate(-ambientTime * 1.08);
                  context.beginPath();
                  for (let point = 0; point < 16; point += 1) {
                    const angle = (Math.PI * point) / 8 - Math.PI / 2;
                    const radius = point % 2 === 0 ? 52 : 34;
                    const pointX = Math.cos(angle) * radius;
                    const pointY = Math.sin(angle) * radius * 0.42;
                    if (point === 0) context.moveTo(pointX, pointY);
                    else context.lineTo(pointX, pointY);
                  }
                  context.closePath();
                  context.stroke();
                }
                context.restore();
              }
            }
          }

          context.fillStyle = colorWithAlpha("#fff8db", 0.88);
          const beamMotes = 3 + rarityTier * 2;
          for (let mote = 0; mote < beamMotes; mote += 1) {
            const phase = positiveModulo(
              ambientTime * (0.42 + (mote % 3) * 0.08) +
                drop.id * 0.07 +
                mote * 0.19,
              1,
            );
            const moteX =
              drop.x +
              (hash(drop.id, mote, rarityTier, 981) - 0.5) *
                (24 + rarityTier * 7);
            const moteY = drop.y - phase * beamHeight * 0.88;
            const moteSize = 1.4 + (mote % 3) * 0.7 + rarityTier * 0.2;
            context.globalAlpha =
              beamReveal *
              (1 - phase) *
              Math.min(0.96, 0.48 + rarityTier * 0.08);
            context.save();
            context.translate(moteX, moteY);
            context.rotate(ambientTime * 1.2 + mote);
            context.fillRect(
              -moteSize / 2,
              -moteSize / 2,
              moteSize,
              moteSize,
            );
            context.restore();
          }
        }
        if (itemReveal > 0.001) {
          context.globalAlpha = itemReveal;
          const equipmentIcons = images.equipmentIcons;
          if (equipmentIcons?.complete && equipmentIcons.naturalWidth) {
            const { column, row } = gearIconCell(drop.item.iconIndex);
            const sourceWidth = equipmentIcons.naturalWidth / GEAR_ICON_COLUMNS;
            const sourceHeight = equipmentIcons.naturalHeight / GEAR_ICON_ROWS;
            const baseDrawSize =
              [46, 48, 50, 52, 55, 60, 66, 72][rarityTier];
            const revealBounce =
              Math.sin(itemReveal * Math.PI) * (0.07 + rarityTier * 0.006);
            const drawSize =
              baseDrawSize * (0.58 + itemReveal * 0.42 + revealBounce);
            const riseOffset = rarityVfx.itemRisePx * (1 - itemReveal);
            context.shadowColor = rarity.color;
            context.shadowBlur =
              [8, 10, 12, 15, 19, 28, 38, 52][rarityTier];
            context.drawImage(
              equipmentIcons,
              column * sourceWidth,
              row * sourceHeight,
              sourceWidth,
              sourceHeight,
              drop.x - drawSize / 2,
              drop.y - drawSize * 0.68 + bob + riseOffset,
              drawSize,
              drawSize,
            );
          }
          context.globalAlpha = clamp((itemReveal - 0.35) / 0.65, 0, 1);
          context.shadowBlur = 5;
          context.font = `700 ${readableCanvasFontSize(10, 11)}px sans-serif`;
          context.textAlign = "center";
          context.fillStyle = rarity.color;
          const itemDisplayName = formatGearDisplayName(drop.item);
          const groundLabel =
            itemDisplayName.length > 19
            ? `${itemDisplayName.slice(0, 18)}…`
            : itemDisplayName;
          context.fillText(groundLabel, drop.x, drop.y + 28);
        }
        context.restore();
      }

      for (const orb of world.orbs) {
        const memoryFragments = images.memoryFragments;
        if (memoryFragments?.complete && memoryFragments.naturalWidth && memoryFragments.naturalHeight) {
          const rare = orb.value >= 45;
          const valuable = orb.value >= 18;
          const variant = rare ? 3 : valuable ? 2 : positiveModulo(orb.id, 2);
          const sourceWidth = memoryFragments.naturalWidth / 2;
          const sourceHeight = memoryFragments.naturalHeight / 2;
          const drawSize = rare ? 58 : valuable ? 49 : 39;
          const bob = Math.sin(ambientTime * 3.1 + orb.id) * 3;
          context.save();
          context.translate(orb.x, orb.y + bob);
          context.rotate(Math.sin(ambientTime * 1.2 + orb.id * 0.5) * 0.06);
          context.shadowColor = rare ? "#e5c675" : "#71e4d3";
          context.shadowBlur = rare ? 22 : 14;
          context.drawImage(
            memoryFragments,
            (variant % 2) * sourceWidth,
            Math.floor(variant / 2) * sourceHeight,
            sourceWidth,
            sourceHeight,
            -drawSize / 2,
            -drawSize * 0.58,
            drawSize,
            drawSize,
          );
          context.restore();
        }
      }

      for (const effect of world.effects) {
        if (effect.kind === "summon" || effect.kind === "teleport") {
          drawEffectSprite(
            effect.kind === "summon" ? images.summonEffect : images.teleportEffect,
            effect,
          );
        }
      }

      // Predictive danger zones belong to the floor plane. Rendering them before
      // enemies keeps silhouettes, health bars, and names readable at all times.
      for (const effect of world.effects) {
        if (effect.kind === "timeRiftTelegraph") {
          drawCombatEffect(effect, ambientTime);
        }
      }

      // The visible seam and its collision segment share the same stored center
      // and direction. Keeping this floor pass ahead of actors prevents the VFX
      // from obscuring silhouettes while still making the danger unmistakable.
      for (const enemy of world.enemies) {
        if (enemy.kind === MARGIN_SEVERER_KIND) {
          drawMarginSeverLine(images.marginSeverLine, enemy);
        } else if (enemy.kind === FINAL_BINDER_KIND) {
          drawFinalBinderPattern(images.finalBinderPatterns, enemy);
        } else if (PALIMPSEST_ARCHIVIST_KIND === enemy.kind) {
          drawPalimpsestPattern(images.palimpsestArchivistPatterns, enemy);
        } else if (enemy.kind === SILENT_LIBRARIAN_KIND) {
          drawSilentLibrarianEcho(images.silentLibrarianEcho, enemy);
        }
      }

      const projectileCount = world.projectiles.length;
      for (const projectile of world.projectiles) {
        if (
          shouldDrawProjectileTrail(
            projectile.id,
            projectile.hostile,
            projectileCount,
          )
        ) {
          drawProjectileVfx(projectile, ambientTime, projectileCount, "trail");
        }
      }

      for (const enemy of world.enemies) {
        const proofreaderWindup =
          enemy.kind === 6 && enemy.patternPhase === "windup";
        const proofreaderCharge =
          enemy.kind === 6 && enemy.patternPhase === "charge";
        const bossWindup =
          enemy.kind === BLANK_CARTOGRAPHER_KIND &&
          enemy.bossPattern === "charge" &&
          enemy.bossPhase === "telegraph";
        const bossCharge =
          enemy.kind === BLANK_CARTOGRAPHER_KIND &&
          enemy.bossPattern === "charge" &&
          enemy.bossPhase === "charge";
        if (
          !proofreaderWindup &&
          !proofreaderCharge &&
          !bossWindup &&
          !bossCharge
        ) {
          continue;
        }
        const directionX = enemy.patternX ?? 0;
        const directionY = enemy.patternY ?? 1;
        if (proofreaderWindup || bossWindup) {
          const telegraphSeconds = bossWindup
            ? BLANK_CARTOGRAPHER_TELEGRAPH_SECONDS.charge
            : 0.82;
          const charge =
            1 - clamp((enemy.patternTimer ?? 0) / telegraphSeconds, 0, 1);
          drawProofreaderTelegraph(images.proofreaderTelegraph, enemy, charge);
        } else {
          const trail = context.createLinearGradient(
            enemy.x - directionX * 130,
            enemy.y - directionY * 130,
            enemy.x,
            enemy.y,
          );
          trail.addColorStop(0, "rgba(136,10,20,0)");
          trail.addColorStop(1, "rgba(255,53,58,.75)");
          context.save();
          context.strokeStyle = trail;
          context.lineWidth = 26;
          context.lineCap = "round";
          context.shadowColor = "#ff2637";
          context.shadowBlur = 20;
          context.beginPath();
          context.moveTo(enemy.x - directionX * 130, enemy.y - directionY * 130);
          context.lineTo(enemy.x, enemy.y);
          context.stroke();
          context.restore();
        }
      }

      const sortedEnemies = [...world.enemies].sort((a, b) => a.y - b.y);
      for (const enemy of sortedEnemies) {
        context.beginPath();
        context.fillStyle = "rgba(0,0,0,.52)";
        context.ellipse(enemy.x, enemy.y + enemy.radius * 0.7, enemy.radius, enemy.radius * 0.42, 0, 0, Math.PI * 2);
        context.fill();
        const size =
          enemy.kind === BLANK_CARTOGRAPHER_KIND
            ? 185
            : enemy.kind === FINAL_BINDER_KIND
              ? 190
              : enemy.kind === PALIMPSEST_ARCHIVIST_KIND
                ? 192
            : enemy.kind === 6
              ? 112
              : enemy.kind === 7
                ? 118
                : enemy.kind === MARGIN_SEVERER_KIND
                  ? 116
                  : enemy.kind === SILENT_LIBRARIAN_KIND
                    ? 122
                : 72 + enemy.radius;
        const spriteAlpha = enemy.slow > 0 ? 0.78 : 1;
        const walkWidth =
          enemy.kind === BLANK_CARTOGRAPHER_KIND
            ? 250
            : enemy.kind === FINAL_BINDER_KIND
              ? 270
              : enemy.kind === PALIMPSEST_ARCHIVIST_KIND
                ? 272
            : enemy.kind === 6
              ? 192
              : enemy.kind === 7
                ? 132
                : enemy.kind === MARGIN_SEVERER_KIND
                  ? 140
                  : enemy.kind === SILENT_LIBRARIAN_KIND
                    ? 136
                : size * 1.2;
        const walkHeight =
          enemy.kind === BLANK_CARTOGRAPHER_KIND
            ? 225
            : enemy.kind === FINAL_BINDER_KIND
              ? 240
              : enemy.kind === PALIMPSEST_ARCHIVIST_KIND
                ? 244
            : enemy.kind === 6
              ? 144
              : enemy.kind === 7
                ? 152
                : enemy.kind === MARGIN_SEVERER_KIND
                  ? 154
                  : enemy.kind === SILENT_LIBRARIAN_KIND
                    ? 158
                : size * 1.25;
        const directionFrame =
          ENEMY_DIRECTION_FRAMES[enemy.kind][enemy.facing] ??
          ({ row: enemy.facing, flipX: false } satisfies DirectionFrame);
        const drawn =
          drawWalkSprite(
            images[WALK_IMAGE_KEYS[enemy.kind]],
            directionFrame.row,
            enemy.moving ? enemy.walkCycle : 1,
            enemy.x,
            enemy.y + 12,
            walkWidth,
            walkHeight,
            spriteAlpha,
            enemy.kind === 7 || enemy.kind === SILENT_LIBRARIAN_KIND
              ? false
              : directionFrame.flipX,
            enemy.kind === MARGIN_SEVERER_KIND
              ? MARGIN_SEVERER_WALK_ROW_CROPS[directionFrame.row]
              : undefined,
          ) ||
          (enemy.kind <= 5
            ? drawSprite(
                images.sprites,
                enemy.kind + 1,
                enemy.x,
                enemy.y + 12,
                enemy.kind === BLANK_CARTOGRAPHER_KIND ? 205 : size,
                enemy.kind === BLANK_CARTOGRAPHER_KIND ? 190 : size * 1.12,
                spriteAlpha,
              )
            : false);
        if (!drawn) {
          context.beginPath();
          context.fillStyle =
            enemy.kind === BLANK_CARTOGRAPHER_KIND
              ? "#812f36"
              : enemy.kind === FINAL_BINDER_KIND
                ? "#9d7438"
                : enemy.kind === PALIMPSEST_ARCHIVIST_KIND
                  ? "#662a53"
              : enemy.kind === 6
                ? "#a72531"
                : enemy.kind === 7
                  ? "#394a72"
                  : enemy.kind === MARGIN_SEVERER_KIND
                    ? "#75454b"
                    : enemy.kind === SILENT_LIBRARIAN_KIND
                      ? "#34545d"
                  : enemy.elite
                    ? "#b55a3e"
                    : "#746554";
          context.arc(enemy.x, enemy.y, enemy.radius, 0, Math.PI * 2);
          context.fill();
        }
        if (
          (enemy.elite || isBossKind(enemy.kind)) &&
          hasLegendaryPower(player, "hunterSigil")
        ) {
          const hunterSigilVfxId = legendaryVfxId("hunterSigil");
          drawGameplayVfxFrame(
            context,
            images[gameplayVfxImageKey(hunterSigilVfxId)],
            GAMEPLAY_VFX_MANIFEST[hunterSigilVfxId],
            {
              x: enemy.x,
              y: enemy.y,
              size: Math.max(84, walkWidth * 0.72),
              progress: positiveModulo(ambientTime * 0.78 + enemy.id * 0.17, 1),
              alpha:
                (player.hunterSigilPulseCooldown ?? 0) > 0
                  ? 1
                  : 0.58 + Math.sin(ambientTime * 3.2 + enemy.id) * 0.12,
              frameOffset: enemy.id,
            },
          );
        }
        const barWidth =
          isBossKind(enemy.kind) ? 180 : enemy.radius * 2;
        context.fillStyle = "rgba(0,0,0,.75)";
        context.fillRect(enemy.x - barWidth / 2, enemy.y - enemy.radius - 38, barWidth, 6);
        context.fillStyle =
          enemy.kind === BLANK_CARTOGRAPHER_KIND
            ? "#d14f55"
            : enemy.kind === FINAL_BINDER_KIND
              ? "#e1b45b"
              : enemy.kind === PALIMPSEST_ARCHIVIST_KIND
                ? "#f05f9e"
            : enemy.kind === 7
              ? "#63dbe8"
              : enemy.kind === MARGIN_SEVERER_KIND
                ? "#8deaf0"
                : enemy.kind === SILENT_LIBRARIAN_KIND
                  ? "#a7f4f5"
              : "#b96649";
        context.fillRect(
          enemy.x - barWidth / 2,
          enemy.y - enemy.radius - 38,
          barWidth * clamp(enemy.hp / enemy.maxHp, 0, 1),
          6,
        );
        if (
          enemy.elite ||
          isBossKind(enemy.kind) ||
          enemy.kind === 6 ||
          enemy.kind === 7 ||
          enemy.kind === MARGIN_SEVERER_KIND ||
          enemy.kind === SILENT_LIBRARIAN_KIND
        ) {
          context.font = isBossKind(enemy.kind)
            ? `700 ${readableCanvasFontSize(15, 11)}px serif`
            : `600 ${readableCanvasFontSize(11, 11)}px sans-serif`;
          context.textAlign = "center";
          context.fillStyle = "#e8dfc8";
          context.fillText(ENEMY_NAMES[enemy.kind], enemy.x, enemy.y - enemy.radius - 46);
        }
      }

      for (const projectile of world.projectiles) {
        drawProjectileVfx(projectile, ambientTime, projectileCount, "core");
      }
      for (const effect of world.doorEffects) {
        if (effect.kind !== "timeRiftTelegraph") {
          drawCombatEffect(effect, ambientTime);
        }
      }
      for (const effect of world.effects) {
        if (effect.kind !== "timeRiftTelegraph") {
          drawCombatEffect(effect, ambientTime);
        }
      }

      const orbitPower = powerRankOf(player, "orbit");
      const orbitCount = Math.min(8, orbitPower);
      for (let i = 0; i < orbitCount; i += 1) {
        const angle = performance.now() / 620 + (Math.PI * 2 * i) / orbitCount;
        const ox = player.x + Math.cos(angle) * (62 + orbitPower * 2);
        const oy = player.y + Math.sin(angle) * (44 + orbitPower * 1.4);
        const orbitVfxId = augmentVfxId("orbit");
        if (
          drawGameplayVfxFrame(
            context,
            images[gameplayVfxImageKey(orbitVfxId)],
            GAMEPLAY_VFX_MANIFEST[orbitVfxId],
            {
              x: ox,
              y: oy,
              size: 13,
              progress: positiveModulo(ambientTime * 2.4, 1),
              angle: angle + Math.PI / 2,
              frameOffset: i,
            },
          )
        ) {
          continue;
        }
        context.save();
        context.translate(ox, oy);
        context.rotate(angle + Math.PI / 2);
        context.fillStyle = "#d8d4c9";
        context.shadowColor = "#8fc7da";
        context.shadowBlur = 10;
        context.beginPath();
        context.moveTo(0, -16);
        context.lineTo(7, 10);
        context.lineTo(0, 6);
        context.lineTo(-7, 10);
        context.closePath();
        context.fill();
        context.restore();
      }

      context.beginPath();
      context.fillStyle = "rgba(0,0,0,.55)";
      context.ellipse(player.x, player.y + 18, 28, 12, 0, 0, Math.PI * 2);
      context.fill();
      const playerAlpha =
        player.invulnerable > 0 && Math.floor(performance.now() / 70) % 2 ? 0.35 : 1;
      const playerWalkFrame = characterRenderFrameIndex(
        player.facing,
        player.walkCycle,
        player.moving,
      );
      const playerSpriteY = player.y + 8;
      // Preserve 4:3 without scaling the transparent atlas cell as though all
      // of it were character mass. This keeps Harin at common-enemy scale.
      const playerSpriteWidth = PAPERDOLL_WORLD_RENDER_WIDTH;
      const playerSpriteHeight = PAPERDOLL_WORLD_RENDER_HEIGHT;
      const equipmentRuntime = getEquipmentRuntimeCache(player.equipment);
      const playerPaperdollLoadout = equipmentRuntime.loadout;
      const playerPaperdollSignature = equipmentRuntime.signature;
      if (equippedRarityVfxPlanRef.current.signature !== playerPaperdollSignature) {
        equippedRarityVfxPlanRef.current = {
          signature: playerPaperdollSignature,
          plan: resolveEquippedRarityVfxPlan(playerPaperdollLoadout),
        };
      }
      const playerRarityVfxPlan = equippedRarityVfxPlanRef.current.plan;
      const equippedRarityVfxImages = {
        mythic: images.equippedMythicAura,
        cosmic: images.equippedCosmicAura,
      };
      const playerDrawn =
        (paperdollImagesRef.current.get(PAPERDOLL_BODY_PATH) &&
          drawPaperdollCharacter(context, {
            bodyAtlas: paperdollImagesRef.current.get(PAPERDOLL_BODY_PATH)!,
            layerSources: paperdollImagesRef.current.imageMap(),
            loadout: playerPaperdollLoadout,
            direction: player.facing,
            frame: playerWalkFrame,
            x: player.x,
            y: playerSpriteY,
            width: playerSpriteWidth,
            height: playerSpriteHeight,
            alpha: playerAlpha,
          })) ||
        drawWalkSprite(
          images.walkHarinLegacy,
          characterSpriteRowForFacing(player.facing),
          playerWalkFrame,
          player.x,
          playerSpriteY,
          playerSpriteWidth,
          playerSpriteHeight,
          playerAlpha,
        ) ||
        drawSprite(
          images.sprites,
          0,
          player.x,
          player.y + 8,
          86,
          112,
          playerAlpha,
        );
      drawEquippedRarityVfx(context, {
        plan: playerRarityVfxPlan,
        images: equippedRarityVfxImages,
        direction: player.facing,
        frame: playerWalkFrame,
        timeMs: ambientTime * 1000,
        x: player.x,
        y: playerSpriteY,
        width: playerSpriteWidth,
        height: playerSpriteHeight,
        context: "combat",
        alpha: playerAlpha,
      });
      if (!playerDrawn) {
        context.beginPath();
        context.fillStyle = player.invulnerable > 0 ? "#f0cf88" : "#9a4038";
        context.arc(player.x, player.y, player.radius, 0, Math.PI * 2);
        context.fill();
      }
      if (player.mirrorAegisBarrierTime > 0) {
        const barrierVfxId = legendaryVfxId("mirrorAegis");
        const barrierDrawn = drawGameplayVfxFrame(
          context,
          images[gameplayVfxImageKey(barrierVfxId)],
          GAMEPLAY_VFX_MANIFEST[barrierVfxId],
          {
            x: player.x,
            y: player.y,
            size: 112,
            progress: positiveModulo(ambientTime * 1.65, 1),
            alpha: 0.94,
          },
        );
        if (!barrierDrawn) {
          context.save();
          context.globalCompositeOperation = "lighter";
          context.strokeStyle = "rgba(174,250,255,.94)";
          context.shadowColor = "#8df7ff";
          context.shadowBlur = 18;
          context.lineWidth = 2.4;
          context.beginPath();
          context.arc(player.x, player.y, 46, ambientTime * 0.8, ambientTime * 0.8 + Math.PI * 1.55);
          context.stroke();
          context.restore();
        }
      } else if (player.shield > 0) {
        const shieldVfxId =
          player.ashboundShieldTime > 0
            ? legendaryVfxId("ashboundGirdle")
            : augmentVfxId("ward");
        const shieldDrawn = drawGameplayVfxFrame(
          context,
          images[gameplayVfxImageKey(shieldVfxId)],
          GAMEPLAY_VFX_MANIFEST[shieldVfxId],
          {
            x: player.x,
            y: player.y,
            size: 106,
            progress: positiveModulo(ambientTime * 1.25, 1),
            alpha: 0.9,
          },
        );
        if (!shieldDrawn) {
          context.save();
          context.strokeStyle = "rgba(174,250,255,.72)";
          context.lineWidth = 2;
          context.beginPath();
          context.arc(player.x, player.y, 44, 0, Math.PI * 2);
          context.stroke();
          context.restore();
        }
      }
      if (player.starfallMantleTime > 0) {
        const mantleVfxId = legendaryVfxId("starfallMantle");
        const mantleDrawn = drawGameplayVfxFrame(
          context,
          images[gameplayVfxImageKey(mantleVfxId)],
          GAMEPLAY_VFX_MANIFEST[mantleVfxId],
          {
            x: player.x,
            y: player.y,
            size: 108,
            progress: positiveModulo(ambientTime * 1.4, 1),
            alpha: 0.92,
          },
        );
        if (!mantleDrawn) {
          context.save();
          context.fillStyle = "#ffeaa6";
          context.shadowColor = "#f8d98a";
          context.shadowBlur = 12;
          context.fillRect(player.x - 2, player.y - 48, 4, 4);
          context.restore();
        }
      }

      if (!world.roomCleared && world.enemies.length) {
        context.font = `700 ${readableCanvasFontSize(12, 11)}px sans-serif`;
        context.textAlign = "center";
        context.fillStyle = "rgba(232,223,200,.68)";
        context.fillText(`${world.enemies.length}개의 기억이 문을 붙들고 있다`, WIDTH / 2, HEIGHT - 22);
      }

      if (world.transition > 0) {
        const transitionOpacity = clamp(world.transition / 0.55, 0, 1);
        context.fillStyle = `rgba(2,3,5,${transitionOpacity})`;
        context.fillRect(0, 0, WIDTH, HEIGHT);
      }
    };

    const loop = (now: number) => {
      const dt = Math.min(0.034, (now - last) / 1000);
      last = now;
      if (!professionCeremonyActiveRef.current) {
        spawnLocalLootVfxShowcase();
        if (isSimulationRunning()) update(dt);
        draw();
        if (now - lastHudUpdateRef.current > 110) {
          lastHudUpdateRef.current = now;
          syncHud();
        }
      }
      frame = requestAnimationFrame(loop);
    };
    frame = requestAnimationFrame(loop);
    return () => {
      canvasResizeObserver.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [
    gainXp,
    getEquipmentRuntimeCache,
    isSimulationRunning,
    makeEnemy,
    setGameMode,
    showStory,
    started,
    syncHud,
  ]);

  const handleAim = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!isSimulationRunning()) return;
    const rect = event.currentTarget.getBoundingClientRect();
    inputRef.current.aimX = ((event.clientX - rect.left) / rect.width) * WIDTH;
    inputRef.current.aimY = ((event.clientY - rect.top) / rect.height) * HEIGHT;
    inputRef.current.lastAim = performance.now();
  };

  const handleMoveTarget = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!isSimulationRunning()) return;
    handleAim(event);
    const rect = event.currentTarget.getBoundingClientRect();
    inputRef.current.moveTargetX = ((event.clientX - rect.left) / rect.width) * WIDTH;
    inputRef.current.moveTargetY = ((event.clientY - rect.top) / rect.height) * HEIGHT;
    inputRef.current.hasMoveTarget = true;
  };

  const pressControl = (key: string, active: boolean) => {
    if (active && isSimulationRunning()) keysRef.current.add(key);
    else keysRef.current.delete(key);
  };

  const ownedAugments = useMemo(
    () =>
      AUGMENTS.filter((augment) => rankOf(hud.player, augment.id) > 0).sort(
        (a, b) =>
          rankOf(hud.player, b.id) - rankOf(hud.player, a.id),
      ),
    [hud.player],
  );
  const endingChapter =
    FIRST_BOSS_ENDING_CHAPTERS[
      Math.min(endingChapterIndex, FIRST_BOSS_ENDING_CHAPTERS.length - 1)
    ];
  const endingIsFinal =
    endingChapterIndex === FIRST_BOSS_ENDING_CHAPTERS.length - 1;
  const synergies = useMemo(() => activeSynergies(hud.player), [hud.player]);
  const currentProfession = useMemo(
    () => AUGMENTS.find((augment) => augment.id === hud.player.profession) ?? null,
    [hud.player.profession],
  );
  const playerStats = useMemo(
    () => calculatePlayerStatsForRuntime(hud.player),
    [hud.player],
  );
  const equippedPower = playerStats.equipment.power.total;
  const selectedGear = useMemo(
    () => hud.player.inventory.find((item) => item.id === selectedGearId) ?? null,
    [hud.player.inventory, selectedGearId],
  );
  const selectedGearComparison = selectedGear
    ? hud.player.equipment[selectedGear.slot]
    : null;
  const selectedGearImplicit = selectedGear
    ? getGearImplicitDisplay(selectedGear)
    : null;
  const selectedPowerDelta = selectedGear
    ? calculateEquipmentPowerDelta(hud.player.equipment, selectedGear)
    : 0;
  const buildMetrics = useMemo(() => {
    return [
      {
        label: "스탯 공격력",
        value: formatGearNumericValue(playerStats.ratings.sheetAttackPower),
      },
      {
        label: "종합 전투력",
        value: playerStats.ratings.combatPower.toLocaleString("ko-KR"),
      },
      {
        label: "환산 보스 DPS",
        value: formatGearNumericValue(playerStats.ratings.standardBossDps),
      },
      {
        label: "발사 속도",
        value: `${formatGearNumericValue(playerStats.offense.renderedFireRate)}/초`,
      },
      {
        label: "투사체",
        value: `${playerStats.offense.renderedProjectileCount}발 · 지름 ${formatGearNumericValue(playerStats.projectile.diameter)}`,
      },
      {
        label: "치명타",
        value: `${formatGearNumericValue(playerStats.offense.critChance * 100)}% · ×${formatGearNumericValue(playerStats.offense.critMultiplier)}`,
      },
      { label: "장비 기여도", value: equippedPower.toLocaleString("ko-KR") },
      {
        label: "현재 피해 감소",
        value: `${formatGearNumericValue(playerStats.defense.currentDamageReduction * 100)}%`,
      },
      {
        label: "보스 피해",
        value: `×${formatGearNumericValue(playerStats.offense.bossMultiplier)}`,
      },
      {
        label: "장비 발견",
        value: `+${formatGearNumericValue(playerStats.utility.effectiveGearFindPercent)}%`,
      },
    ];
  }, [equippedPower, playerStats]);
  const nearestLandmark = useMemo(() => {
    const landmarks = Object.entries(hud.world.rooms)
      .filter(([, room]) => room.kind === "shelter" || room.kind === "boss")
      .map(([key, room]) => {
        const [x, y] = key.split(",").map(Number);
        return {
          key,
          x,
          y,
          room,
          distance: Math.abs(x - hud.world.roomX) + Math.abs(y - hud.world.roomY),
        };
      })
      .filter((item) => item.distance > 0)
      .sort((a, b) => a.distance - b.distance);
    return landmarks[0] ?? null;
  }, [hud.world.roomX, hud.world.roomY, hud.world.rooms]);
  const mapNearestLandmark = useMemo(() => {
    const landmarks = Object.entries(mapSnapshot.rooms)
      .filter(([, room]) => room.kind === "shelter" || room.kind === "boss")
      .map(([key, room]) => {
        const [x, y] = key.split(",").map(Number);
        return {
          key,
          x,
          y,
          room,
          distance: Math.abs(x - mapSnapshot.roomX) + Math.abs(y - mapSnapshot.roomY),
        };
      })
      .filter((item) => item.distance > 0)
      .sort((a, b) => a.distance - b.distance);
    return landmarks[0] ?? null;
  }, [mapSnapshot]);
  const mapCounts = useMemo(
    () => ({
      known: Object.keys(mapSnapshot.rooms).length,
      visited: new Set(mapSnapshot.visited).size,
      cleared: Object.values(mapSnapshot.rooms).filter((room) => room.cleared).length,
    }),
    [mapSnapshot],
  );
  const gameConfirmationOverlay = gameConfirmation ? (
    <div className="game-confirmation-backdrop">
      <section
        className={`game-confirmation-dialog is-${gameConfirmation.tone ?? "warning"}`}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="game-confirmation-title"
        aria-describedby="game-confirmation-body"
      >
        <span className="game-confirmation-sigil" aria-hidden="true">⌁</span>
        <small>{gameConfirmation.eyebrow}</small>
        <h2 id="game-confirmation-title">{gameConfirmation.title}</h2>
        <p id="game-confirmation-body">{gameConfirmation.body}</p>
        <div className="game-confirmation-actions">
          <button type="button" onClick={closeGameConfirmation} autoFocus>
            취소
          </button>
          <button type="button" className="is-confirm" onClick={acceptGameConfirmation}>
            {gameConfirmation.confirmLabel}
          </button>
        </div>
        <span className="game-confirmation-hint">ESC 취소</span>
      </section>
    </div>
  ) : null;

  if (!started) {
    const occupiedSaveCount = saveSlots.filter(Boolean).length;
    return (
      <main className="menu-screen" data-menu-stage={menuStage}>
        <div className="menu-backdrop" />
        <div className="menu-grain" />
        {menuStage === "landing" ? (
          <section className="menu-copy menu-stage-shell">
            <span className="menu-stage-mark">THE LAST COMMA · 기록 00</span>
            <p className="menu-kicker">끝이 없는 지도는 강해지는 자를 기억한다</p>
            <h1>
              <span>무진도</span>
              <small>마지막 쉼표</small>
            </h1>
            <p className="menu-lead">
              쓰러진 적의 기억과 장비를 거두고, 증강마다 20단계까지 쌓아 하나의
              문장으로 완성하라. 지도는 무한하지만 당신의 빌드는 그보다 오래 남는다.
            </p>
            <button
              type="button"
              className="menu-primary-action"
              onClick={() => setMenuStage("archive")}
            >
              <span>
                <strong>{occupiedSaveCount > 0 ? "기억을 잇는다" : "첫 문장을 쓴다"}</strong>
                <small>{occupiedSaveCount > 0 ? `${occupiedSaveCount}개의 원정 기록 확인` : "비어 있는 기록에서 원정 시작"}</small>
              </span>
            </button>
            <a className="menu-pvp-action" href="/pvp">
              <span>
                <strong>기억 결투</strong>
                <small>온라인 1대1 · 빌드 연동 적응형 결투</small>
              </span>
              <b>LIVE</b>
            </a>
            <a className="menu-market-action" href="/market">
              <span>
                <strong>기억 거래소</strong>
                <small>장비 경매 · 금괴 교환 · 서버 보안 원장</small>
              </span>
              <b>MARKET</b>
            </a>
            <button type="button" className="menu-shop-action" onClick={openShop}>
              <span>
                <strong>기억 상단</strong>
                <small>가방 확장 · 지도 순간이동 · 영구 상품</small>
              </span>
              <b>영구</b>
            </button>
            <div className="menu-meta-strip" aria-label="무진도 기록 규모">
              <span><strong>{AUGMENTS.length}</strong> 증강 · 각 {MAX_AUGMENT_STACKS}단계</span>
              <span><strong>{SYNERGIES.length}</strong> 조합 시너지</span>
              <span><strong>{ENEMY_NAMES.length}</strong> 적 계보</span>
              <span><strong>{GEAR_ICON_COLUMNS * GEAR_ICON_ROWS}</strong> 장비 원형 · {EQUIPMENT_SLOTS.length}부위 · {Object.keys(GEAR_RARITY_META).length}등급</span>
            </div>
          </section>
        ) : (
          <section className="menu-copy menu-stage-shell">
            <button type="button" className="archive-back" onClick={() => setMenuStage("landing")}>
              ← 표지로 돌아가기 · ESC
            </button>
            <span className="menu-stage-mark">EXPEDITION ARCHIVE</span>
            <div className="save-slot-heading">
              <strong>고정된 기억</strong>
              <small>새 쉼터에 처음 닿을 때만 장비와 빌드가 함께 저장됩니다.</small>
            </div>
            <div className="save-slot-grid" aria-label="저장 파일 슬롯">
              {SAVE_SLOT_IDS.map((slot, index) => {
                const summary = saveSlots[index];
                const professionTitle = summary?.profession
                  ? PROFESSION_TITLES[summary.profession]
                  : null;
                return (
                  <article
                    key={slot}
                    className={`save-slot-card ${summary ? "is-occupied" : "is-empty"}`}
                    data-save-slot={slot}
                    data-save-state={summary ? "occupied" : "empty"}
                  >
                    <header>
                      <small>RECORD 0{slot}</small>
                      <span>{summary ? formatSavedAt(summary.savedAt) : "UNWRITTEN"}</span>
                    </header>
                    {summary ? (
                      <>
                        <h3>LV.{summary.level} · 지하 {summary.dungeonFloor}층</h3>
                        <p>{professionTitle ?? "미전직 방랑자"}</p>
                        <dl>
                          <div><dt>증강</dt><dd>{summary.augmentStacks}</dd></div>
                          <div><dt>장비</dt><dd>{summary.equippedItems}착용 · {summary.inventoryItems}보관</dd></div>
                        </dl>
                        <div className="save-slot-actions">
                          <button className="slot-continue" onClick={() => loadSave(slot)}>
                            이어가기
                          </button>
                          <button
                            onClick={() =>
                              requestGameConfirmation(
                                {
                                  eyebrow: "NEW EXPEDITION",
                                  title: `${slot}번 기록을 덮어쓸까요?`,
                                  body: "기존 원정 기록을 지우고 새로운 지도를 시작합니다.",
                                  confirmLabel: "새 원정 시작",
                                  tone: "danger",
                                },
                                () => startNewRun(slot),
                              )
                            }
                          >
                            새 원정
                          </button>
                          <button
                            className="slot-delete"
                            aria-label={`${slot}번 저장 삭제`}
                            onClick={() => deleteSaveSlot(slot)}
                          >
                            ×
                          </button>
                        </div>
                      </>
                    ) : (
                      <button className="empty-slot-button" onClick={() => startNewRun(slot)}>
                        <span>새 원정</span>
                        <small>이 기록에 첫 쉼표 남기기</small>
                      </button>
                    )}
                  </article>
                );
              })}
            </div>
          </section>
        )}
        {menuStage === "landing" && (
          <aside className="menu-features" aria-label="게임 특징">
            <span>MAX 모든 증강 20스택</span>
            <span>⚔ 접사와 전설 장비</span>
            <span>⌘ 층마다 99×99방 · 숨은 계단 40개</span>
            <span>✦ 새 쉼터마다 1회 기록</span>
          </aside>
        )}
        <p className="menu-controls">WASD / 바닥 클릭 이동 · 자동 공격 · SPACE 회피 · M 지도 · B 빌드 · I 장비 · P 상점</p>
        <ShopOverlay
          key={`menu-shop-${shopPreferredProductId ?? "default"}`}
          open={shopOpen}
          inventoryCount={hud.player.inventory.length}
          inventoryCapacity={inventoryCapacity}
          entitlements={shopEntitlements}
          checkoutMode={shopMode}
          lastReceipt={lastShopReceipt}
          notice={shopNotice}
          preferredProductId={shopPreferredProductId}
          onClose={closeShop}
          onPurchase={purchaseShopProduct}
          onRestore={restoreShopPurchases}
        />
        {gameConfirmationOverlay}
      </main>
    );
  }

  const currentRoomArtKey = resolveRoomArtKey({
    seed: hud.world.seed,
    dungeonFloor: hud.world.dungeonFloor,
    roomX: hud.world.roomX,
    roomY: hud.world.roomY,
    roomKind: hud.world.roomKind,
  });

  return (
    <main
      className={`game-screen ${hud.player.hp / hud.player.maxHp < 0.3 ? "is-low-health" : ""}`}
      data-game-mode={mode}
      data-dungeon-floor={hud.world.dungeonFloor}
      data-dungeon-grid={`${DUNGEON_GRID_SIZE}x${DUNGEON_GRID_SIZE}`}
      data-room-x={hud.world.roomX}
      data-room-y={hud.world.roomY}
      data-room-kind={hud.world.roomKind}
      data-room-art={currentRoomArtKey}
      data-room-theme={ROOM_ART_NAMES[currentRoomArtKey]}
      data-room-cleared={hud.world.roomCleared}
      data-known-rooms={hud.world.knownRoomCount}
      data-visited-rooms={hud.world.visitedCount}
      data-cleared-rooms={hud.world.clearedRoomCount}
      data-facing={DIRECTION_NAMES[hud.player.facing] ?? "남"}
      data-harin-sprite-row={characterSpriteRowForFacing(hud.player.facing)}
      data-player-x={Math.round(hud.player.x)}
      data-player-y={Math.round(hud.player.y)}
      data-player-moving={hud.player.moving}
      data-walk-frame={characterRenderFrameIndex(
        hud.player.facing,
        hud.player.walkCycle,
        hud.player.moving,
      )}
      data-active-save-slot={activeSaveSlot}
      data-profession={hud.player.profession ?? "none"}
      data-active-effects={hud.world.activeEffects}
      data-player-projectiles={hud.world.playerProjectiles}
      data-hostile-projectiles={hud.world.hostileProjectiles}
      data-combat-effects={hud.world.combatEffects}
      data-summon-effects={hud.world.summonEffects}
      data-teleport-effects={hud.world.teleportEffects}
      data-ground-gear={hud.world.gearDrops}
      data-inventory-count={hud.player.inventory.length}
      data-inventory-capacity={inventoryCapacity}
      data-inventory-open={inventoryOpen}
      data-stats-open={statsOpen}
      data-auto-salvage={hud.player.autoSalvageMaxRarity ?? "off"}
      data-shop-open={shopOpen}
      data-memory-ash={hud.player.memoryAsh}
      data-equipped-count={EQUIPMENT_SLOTS.filter((slot) => hud.player.equipment[slot]).length}
      data-equipment-power={equippedPower}
      data-boss-kind={hud.world.bossKind ?? "none"}
      data-boss-pattern={hud.world.bossPattern ?? hud.world.binderPattern ?? hud.world.archivistPattern ?? "none"}
      data-boss-phase={hud.world.bossPhase ?? hud.world.binderPhase ?? hud.world.archivistPhase ?? "none"}
      data-proofreader-enemies={hud.world.proofreaderEnemies}
      data-proofreader-windups={hud.world.proofreaderWindups}
    >
      <canvas
        ref={canvasRef}
        width={WIDTH}
        height={HEIGHT}
        className="game-canvas"
        onPointerMove={handleAim}
        onPointerDown={handleMoveTarget}
        aria-label="무진도 전투 화면"
      />

      <header className="top-hud">
        <section className="vitals hud-panel">
          <div className="portrait">
            <span>하린</span>
          </div>
          <div className="bars">
            <div className="bar health-bar">
              <i
                style={{
                  width: `${clamp((hud.player.hp / hud.player.maxHp) * 100, 0, 100)}%`,
                }}
              />
              <span>
                {Math.ceil(hud.player.hp)} / {Math.ceil(hud.player.maxHp)}
                {hud.player.shield > 0 ? ` +${Math.ceil(hud.player.shield)}` : ""}
              </span>
            </div>
            <div className="bar xp-bar">
              <i
                style={{
                  width: `${clamp((hud.player.xp / hud.player.nextXp) * 100, 0, 100)}%`,
                }}
              />
              <span>
                기억 {Math.floor(hud.player.xp)} / {hud.player.nextXp}
              </span>
            </div>
            <div className="vital-readouts">
              <span>방벽 {Math.ceil(hud.player.shield)}</span>
              <span className={hud.player.dashCooldown <= 0 ? "is-ready" : ""}>
                회피 {hud.player.dashCooldown <= 0 ? "READY" : `${hud.player.dashCooldown.toFixed(1)}s`}
              </span>
            </div>
          </div>
          <strong>LV.{hud.player.level}</strong>
        </section>

        <section className="room-heading">
          <small>
            지하 {hud.world.dungeonFloor}층 · 방 {dungeonDisplayCoordinate(hud.world.roomX)} : {dungeonDisplayCoordinate(hud.world.roomY)}
          </small>
          <h2>{ROOM_NAMES[hud.world.roomKind]}</h2>
          <small className="room-theme-name">{ROOM_ART_NAMES[currentRoomArtKey]}</small>
          <span className={hud.world.roomCleared ? "is-clear" : "is-locked"}>
            {hud.world.roomCleared
              ? `탐색 가능 · ${Object.values(
                  dungeonDoorAccess(hud.world.roomX, hud.world.roomY, true),
                ).filter(Boolean).length}방향 개방`
              : `봉쇄 중 · 남은 기억 ${hud.world.enemies}`}
          </span>
        </section>

        <button
          type="button"
          className="minimap hud-panel"
          aria-label="전체 지도 열기 (M)"
          onClick={openMap}
        >
          <div>
            <small>무진도 단편</small>
            <strong>지하 {hud.world.dungeonFloor}층</strong>
            <span>M · 전체 지도</span>
          </div>
          <MapGrid world={hud.world} />
        </button>
      </header>

      {hud.world.staircaseRevealed && mode === "playing" && (
        <button
          type="button"
          className={`staircase-action ${hud.world.staircaseNearby ? "is-nearby" : ""}`}
          aria-label={
            hud.world.staircaseNearby
              ? `지하 ${hud.world.dungeonFloor + 1}층으로 내려가기`
              : "하행 계단 앞으로 이동"
          }
          onClick={descendToNextFloor}
        >
          <span aria-hidden="true">⌄</span>
          <small>{hud.world.staircaseNearby ? "E · 하행 계단" : "계단 발견"}</small>
          <strong>
            {hud.world.staircaseNearby
              ? `지하 ${hud.world.dungeonFloor + 1}층으로 내려가기`
              : "계단 앞으로 이동"}
          </strong>
        </button>
      )}

      {hud.world.bossMaxHp > 0 && (
        <section className="boss-hud" aria-label="보스 체력">
          <div>
            <small>
              {hud.world.bossKind === FINAL_BINDER_KIND
                ? "종언의 정본"
                : hud.world.bossKind === PALIMPSEST_ARCHIVIST_KIND
                  ? "덧쓴 기록"
                : "백지의 권역"}
            </small>
            <strong>
              {hud.world.bossKind !== null
                ? ENEMY_NAMES[hud.world.bossKind]
                : "이름 없는 보스"}
            </strong>
            {hud.world.bossKind === BLANK_CARTOGRAPHER_KIND &&
              hud.world.bossPattern &&
              hud.world.bossPhase && (
              <em>
                {BLANK_CARTOGRAPHER_PATTERN_LABELS[hud.world.bossPattern]}
                {" · "}
                {BOSS_PHASE_LABELS[hud.world.bossPhase]}
              </em>
            )}
            {hud.world.bossKind === FINAL_BINDER_KIND &&
              hud.world.binderPattern &&
              hud.world.binderPhase && (
                <em>
                  {FINAL_BINDER_PATTERN_LABELS[hud.world.binderPattern]}
                  {" · "}
                  {FINAL_BINDER_PHASE_LABELS[hud.world.binderPhase]}
                </em>
              )}
            {hud.world.bossKind === PALIMPSEST_ARCHIVIST_KIND &&
              hud.world.archivistPattern &&
              hud.world.archivistPhase && (
                <em>
                  {PALIMPSEST_ARCHIVIST_PATTERN_LABELS[hud.world.archivistPattern]}
                  {" · "}
                  {PALIMPSEST_ARCHIVIST_PHASE_LABELS[hud.world.archivistPhase]}
                </em>
              )}
          </div>
          <span>
            <i
              style={{
                width: `${clamp((hud.world.bossHp / hud.world.bossMaxHp) * 100, 0, 100)}%`,
              }}
            />
          </span>
          <b>{Math.ceil((hud.world.bossHp / hud.world.bossMaxHp) * 100)}%</b>
        </section>
      )}

      <aside className={`build-rail ${buildOpen ? "is-open" : ""}`}>
        <button
          className="build-toggle"
          onClick={() => {
            setBuildTab("build");
            setBuildPanelOpen(!(buildOpen && buildTab === "build"));
          }}
          aria-expanded={buildOpen}
        >
          <span>{buildTab === "gear" ? "장비" : "빌드"}</span>
          <strong>
            {buildTab === "gear"
              ? hud.player.inventory.length
              : ownedAugments.reduce((sum, item) => sum + rankOf(hud.player, item.id), 0)}
          </strong>
          <small>B</small>
        </button>
        {buildOpen && <div className="build-content" role="dialog" aria-modal="true" aria-label="빌드와 장비">
          <header>
            <div>
              <small>{buildTab === "build" ? "현재 기억 조합" : "무진도 전리품 기록"}</small>
              <h3>{buildTab === "build" ? "하린의 20단계 빌드" : `장비고 · ${equippedPower.toLocaleString("ko-KR")}`}</h3>
            </div>
            <button onClick={() => setBuildPanelOpen(false)} aria-label="패널 닫기">
              ×
            </button>
          </header>
          <div className="build-tabs" role="tablist" aria-label="빌드 패널 보기">
            <button
              type="button"
              role="tab"
              className={`build-tab ${buildTab === "build" ? "is-active" : ""}`}
              aria-selected={buildTab === "build"}
              onClick={() => setBuildTab("build")}
            >
              증강 빌드 · B
            </button>
            <button
              type="button"
              className="build-tab"
              onClick={() => {
                setBuildPanelOpen(false);
                setInventoryScreenOpen(true);
              }}
            >
              중앙 장비고 {hud.player.inventory.length}/{inventoryCapacity} · I
            </button>
          </div>

          {buildTab === "build" ? (
            <>
              <section className={`profession-summary ${currentProfession ? "is-active" : ""}`}>
                <div>
                  <small>{currentProfession ? "현재 전문 직업" : "전직 조건"}</small>
                  <strong>
                    {currentProfession
                      ? PROFESSION_TITLES[currentProfession.id]
                      : "하나의 증강을 20스택"}
                  </strong>
                </div>
                <span>
                  {currentProfession
                    ? `${currentProfession.name} 전투 효율 +${PROFESSION_BONUS_PERCENT}%`
                    : "조건을 달성하면 해당 증강의 전문가가 됩니다."}
                </span>
              </section>
              <section className="build-metrics" aria-label="현재 전투 능력치">
                {buildMetrics.map((metric) => (
                  <div key={metric.label}>
                    <small>{metric.label}</small>
                    <strong>{metric.value}</strong>
                  </div>
                ))}
              </section>
              {synergies.length > 0 && (
                <section className="synergy-list">
                  <small>발현된 시너지</small>
                  {synergies.map((synergy) => (
                    <span key={synergy.name} style={{ borderColor: synergy.color }}>
                      {synergy.name} <b>Ⅱ{synergy.tier}</b>
                    </span>
                  ))}
                </section>
              )}
              <section className="augment-stack-list">
                {ownedAugments.length === 0 ? (
                  <p>첫 기억 조각을 모으면 증강이 여기에 쌓입니다.</p>
                ) : (
                  ownedAugments.map((augment) => {
                    const level = rankOf(hud.player, augment.id);
                    const stable = level <= (hud.stableAugments[augment.id] ?? 0);
                    return (
                      <article
                        key={augment.id}
                        style={{ "--augment-color": augment.color } as CSSProperties}
                      >
                        <AugmentIcon icon={augment.icon} iconAsset={augment.iconAsset} size={52} />
                        <div>
                          <strong>{augment.name}</strong>
                          <small>
                            {hud.player.profession === augment.id
                              ? `${PROFESSION_TITLES[augment.id]} · 전문 효율 +${PROFESSION_BONUS_PERCENT}%`
                              : stable
                                ? "고정된 기억"
                                : "불안정한 기억"}
                          </small>
                          <span className="mastery-track" aria-label={`전직 진행 ${Math.min(level, PROFESSION_THRESHOLD)} / ${PROFESSION_THRESHOLD}`}>
                            <i style={{ width: `${Math.min(100, (level / PROFESSION_THRESHOLD) * 100)}%` }} />
                          </span>
                          {level >= PROFESSION_THRESHOLD && hud.player.profession !== augment.id && (
                            <button
                              className="profession-inline-button"
                              onClick={() => openProfessionChoice(augment)}
                            >
                              {hud.player.profession ? "전향 가능" : "전직 가능"}
                            </button>
                          )}
                        </div>
                        <b>×{level}/{MAX_AUGMENT_STACKS}</b>
                      </article>
                    );
                  })
                )}
              </section>
            </>
          ) : (
            <section className="gear-panel" aria-label="장비 및 인벤토리">
              <div className="equipment-slots">
                {EQUIPMENT_SLOTS.map((slot) => {
                  const item = hud.player.equipment[slot];
                  return (
                    <article
                      key={slot}
                      className={`equipment-slot-card ${item ? gearRarityClass(item) : ""}`}
                    >
                      {item ? <GearIcon item={item} size={43} /> : <span className="gear-empty-icon">＋</span>}
                      <div>
                        <small>{EQUIPMENT_SLOT_LABELS[slot]}</small>
                        <strong>{item ? formatGearDisplayName(item) : "비어 있음"}</strong>
                        <span>
                          {item
                            ? `전투력 ${item.powerScore} · 품질 ${item.qualityScore}%`
                            : "전리품을 장착하세요"}
                        </span>
                      </div>
                    </article>
                  );
                })}
              </div>
              <div className="inventory-toolbar">
                <span>가방 <strong>{hud.player.inventory.length}</strong> / {inventoryCapacity}</span>
                <span>장착 전투력 <b>{equippedPower.toLocaleString("ko-KR")}</b></span>
              </div>
              <div className="inventory-grid">
                {hud.player.inventory.length === 0 ? (
                  <p className="inventory-empty">적이 남긴 장비를 가까이에서 회수하면 이곳에 기록됩니다.</p>
                ) : (
                  hud.player.inventory.map((item) => (
                    <button
                      type="button"
                      key={item.id}
                      className={`gear-item-card ${gearRarityClass(item)} ${selectedGearId === item.id ? "is-selected" : ""}`}
                      aria-pressed={selectedGearId === item.id}
                      onClick={() => setSelectedGearId(item.id)}
                      onDoubleClick={() => equipInventoryItem(item.id)}
                    >
                      <GearIcon item={item} size={42} />
                      <div>
                        <strong>{formatGearDisplayName(item)}</strong>
                        <small>아이템 LV.{item.level} · 착용 LV.{getGearRequiredLevel(item)} · {EQUIPMENT_SLOT_LABELS[item.slot]}</small>
                        <span>전투력 {item.powerScore} · 품질 {item.qualityScore}%</span>
                      </div>
                    </button>
                  ))
                )}
              </div>
              {selectedGear && selectedGearImplicit && (
                <section className={`gear-comparison ${gearRarityClass(selectedGear)}`}>
                  <div className="gear-comparison-heading">
                    <div>
                      <small>{GEAR_RARITY_META[selectedGear.rarity].label} · {EQUIPMENT_SLOT_LABELS[selectedGear.slot]}</small>
                      <h4>{formatGearDisplayName(selectedGear)}</h4>
                    </div>
                    <span
                      className={`gear-power-delta ${selectedPowerDelta < 0 ? "is-negative" : ""}`}
                      data-negative={selectedPowerDelta < 0}
                    >
                      {selectedPowerDelta >= 0 ? "+" : ""}{selectedPowerDelta} 전투력
                    </span>
                  </div>
                  <p>
                    현재 장착: {selectedGearComparison ? formatGearDisplayName(selectedGearComparison) : "없음"}
                  </p>
                  <div className="gear-implicit-line">
                    <b>{formatCompactGearLabel(selectedGearImplicit.totalLabel)}</b>
                  </div>
                  <div className="gear-quality-line" aria-label={`장비 품질 ${selectedGear.qualityScore}%`}>
                    <span>품질</span>
                    <span className="gear-quality-meter" aria-hidden="true">
                      <i
                        className="gear-quality-fill"
                        style={{ "--gear-quality": `${selectedGear.qualityScore}%` } as CSSProperties}
                      />
                    </span>
                    <b className="gear-quality-value">{selectedGear.qualityScore}%</b>
                  </div>
                  <div className="gear-item-affixes">
                    {selectedGear.affixes.map((affix) => {
                      const display = getGearAffixDisplay(affix, selectedGear);
                      return (
                        <span key={affix.stat}>
                          <b>{formatCompactGearLabel(display.totalLabel)}</b>
                        </span>
                      );
                    })}
                    {selectedGear.legendaryPowerId && (
                      <strong>{LEGENDARY_POWERS[selectedGear.legendaryPowerId].name} · {LEGENDARY_POWERS[selectedGear.legendaryPowerId].description}</strong>
                    )}
                  </div>
                  <div className="gear-actions">
                    <button
                      className="primary-button compact"
                      onClick={() => equipInventoryItem(selectedGear.id)}
                      disabled={!canEquipGearAtLevel(hud.player.level, selectedGear)}
                      title={!canEquipGearAtLevel(hud.player.level, selectedGear) ? `캐릭터 LV.${getGearRequiredLevel(selectedGear)}부터 장착할 수 있습니다.` : undefined}
                    >
                      {canEquipGearAtLevel(hud.player.level, selectedGear)
                        ? "장착하고 비교 교체"
                        : `LV.${getGearRequiredLevel(selectedGear)}부터 장착`}
                    </button>
                    <button
                      className="text-button"
                      onClick={() => {
                        setBuildPanelOpen(false);
                        setInventoryScreenOpen(true);
                      }}
                    >
                      장비고에서 분해
                    </button>
                  </div>
                </section>
              )}
            </section>
          )}
        </div>}
      </aside>

      <InventoryOverlay
        open={inventoryOpen && started && mode === "playing"}
        memoryAsh={hud.player.memoryAsh}
        onEnhance={enhanceGearItem}
        onClose={() => setInventoryScreenOpen(false)}
        equipment={hud.player.equipment}
        inventory={hud.player.inventory}
        inventoryCapacity={inventoryCapacity}
        playerLevel={hud.player.level}
        onOpenShop={openShopFromInventory}
        selectedGearId={selectedGearId}
        onSelect={setSelectedGearId}
        onEquip={equipInventoryItem}
        onUnequip={unequipInventoryItem}
        onSalvage={salvageInventoryItem}
        onSalvageMany={salvageInventoryItems}
        autoSalvageMaxRarity={hud.player.autoSalvageMaxRarity}
        onAutoSalvageMaxRarityChange={changeAutoSalvageMaxRarity}
        onGrantRarityShowcase={isLocalRarityShowcaseHost() ? grantLocalRarityShowcase : undefined}
        equippedPower={equippedPower}
      />

      <StatsOverlay
        open={statsOpen && started && mode === "playing"}
        snapshot={playerStats}
        professionTitle={
          hud.player.profession
            ? (PROFESSION_TITLES[hud.player.profession] ?? "이름 없는 전문가")
            : null
        }
        onClose={() => setStatsScreenOpen(false)}
      />

      <ShopOverlay
        key={`game-shop-${shopPreferredProductId ?? "default"}`}
        open={shopOpen && started && mode === "playing"}
        inventoryCount={hud.player.inventory.length}
        inventoryCapacity={inventoryCapacity}
        entitlements={shopEntitlements}
        checkoutMode={shopMode}
        lastReceipt={lastShopReceipt}
        notice={shopNotice}
        preferredProductId={shopPreferredProductId}
        onClose={closeShop}
        onPurchase={purchaseShopProduct}
        onRestore={restoreShopPurchases}
      />

      <nav className="control-dock" aria-label="빠른 조작">
        {hud.player.rooms === 0 && <span><kbd>WASD</kbd> 이동</span>}
        {hud.player.rooms === 0 && <span><kbd>SPACE</kbd> 회피</span>}
        <button type="button" onClick={openMap}><kbd>M</kbd> 지도</button>
        <button type="button" onClick={() => {
          setInventoryScreenOpen(false);
          setStatsScreenOpen(false);
          setBuildTab("build");
          setBuildPanelOpen(!(buildOpen && buildTab === "build"));
        }}><kbd>B</kbd> 빌드</button>
        <button type="button" onClick={() => {
          if (statsOpen) setStatsScreenOpen(false);
          else openStats();
        }}><kbd>C</kbd> 능력치</button>
        <button type="button" onClick={() => {
          setBuildPanelOpen(false);
          setStatsScreenOpen(false);
          setInventoryScreenOpen(!inventoryOpen);
        }}><kbd>I</kbd> 장비 {hud.player.inventory.length}/{inventoryCapacity}</button>
        <button type="button" onClick={openShop}><kbd>P</kbd> 상점</button>
        {nearestLandmark && (
          <em>
            {nearestLandmark.room.kind === "shelter" ? "✦ 쉼터" : "◆ 보스"}{" "}
            {dungeonDisplayCoordinate(nearestLandmark.x)} : {dungeonDisplayCoordinate(nearestLandmark.y)}
            <small>{nearestLandmark.distance}칸</small>
          </em>
        )}
      </nav>

      <div className="toast" role="status">
        <i />
        {toast}
      </div>

      {lootNotice && (
        <div
          className={`loot-toast ${gearRarityClass(lootNotice)}`}
          role="status"
          style={{ "--gear-color": GEAR_RARITY_META[lootNotice.rarity].color } as CSSProperties}
        >
          <span className="loot-toast-icon-stage" aria-hidden="true">
            <span
              className={`inventory-screen-rarity-spectacle inventory-screen-rarity-spectacle--${lootNotice.rarity} loot-toast-rarity-spectacle`}
            />
            <GearIcon item={lootNotice} size={42} />
          </span>
          <div>
            <small>{GEAR_RARITY_META[lootNotice.rarity].label} 장비 획득</small>
            <strong>{formatGearDisplayName(lootNotice)}</strong>
            <span>전투력 {lootNotice.powerScore} · 품질 {lootNotice.qualityScore}% · I에서 비교</span>
          </div>
        </div>
      )}

      <div className="touch-controls" aria-label="터치 조작">
        <div className="dpad">
          <button
            onPointerDown={() => pressControl("arrowup", true)}
            onPointerUp={() => pressControl("arrowup", false)}
            onPointerLeave={() => pressControl("arrowup", false)}
            onPointerCancel={() => pressControl("arrowup", false)}
            aria-label="위"
          >
            ↑
          </button>
          <button
            onPointerDown={() => pressControl("arrowleft", true)}
            onPointerUp={() => pressControl("arrowleft", false)}
            onPointerLeave={() => pressControl("arrowleft", false)}
            onPointerCancel={() => pressControl("arrowleft", false)}
            aria-label="왼쪽"
          >
            ←
          </button>
          <button
            onPointerDown={() => pressControl("arrowdown", true)}
            onPointerUp={() => pressControl("arrowdown", false)}
            onPointerLeave={() => pressControl("arrowdown", false)}
            onPointerCancel={() => pressControl("arrowdown", false)}
            aria-label="아래"
          >
            ↓
          </button>
          <button
            onPointerDown={() => pressControl("arrowright", true)}
            onPointerUp={() => pressControl("arrowright", false)}
            onPointerLeave={() => pressControl("arrowright", false)}
            onPointerCancel={() => pressControl("arrowright", false)}
            aria-label="오른쪽"
          >
            →
          </button>
        </div>
        <button
          className="dash-button"
          data-ready={hud.player.dashCooldown <= 0}
          onPointerDown={() => {
            if (isSimulationRunning()) inputRef.current.dashQueued = true;
          }}
          onPointerCancel={() => {
            inputRef.current.dashQueued = false;
          }}
        >
          {hud.player.dashCooldown <= 0 ? "회피" : hud.player.dashCooldown.toFixed(1)}
        </button>
      </div>

      {mode === "augment" && (
        <div className="modal-layer augment-layer">
          <section className="augment-modal" role="dialog" aria-modal="true" aria-labelledby="augment-title">
            <p className="modal-kicker">LEVEL {hud.player.level} · 기억 동기화</p>
            <h2 id="augment-title">어떤 실패를 힘으로 바꿀까?</h2>
            <p>같은 증강은 최대 20스택까지 누적되며, 최대치에 도달하면 선택지에서 제외됩니다.</p>
            <div className="augment-choices">
              {choices.map((augment, index) => {
                const nextRank = Math.min(
                  MAX_AUGMENT_STACKS,
                  rankOf(hud.player, augment.id) + 1,
                );
                const unlockedSynergy = SYNERGIES.find(
                  (synergy) =>
                    synergy.needs.includes(augment.id) &&
                    synergy.needs.every(
                      (id) => id === augment.id || rankOf(hud.player, id) > 0,
                    ),
                );
                return (
                  <button
                    key={augment.id}
                    className={`augment-card ${nextRank === 1 ? "is-new" : ""} ${unlockedSynergy ? "is-synergy-ready" : ""} ${nextRank >= PROFESSION_THRESHOLD ? "is-mastery-ready" : ""}`}
                    onClick={() => chooseAugment(augment)}
                    style={{ "--augment-color": augment.color } as CSSProperties}
                  >
                    <span className="choice-key">{index + 1}</span>
                    <span className="choice-state">
                      {nextRank === 1 ? "NEW" : `STACK ×${nextRank}`}
                    </span>
                    <AugmentIcon icon={augment.icon} iconAsset={augment.iconAsset} size={104} />
                    <small>{augment.tags.join(" · ")}</small>
                    <h3>{augment.name}</h3>
                    <strong>RANK {nextRank}</strong>
                    <p>{augment.description}</p>
                    {unlockedSynergy && (
                      <span className="choice-synergy">시너지 발현 · {unlockedSynergy.name}</span>
                    )}
                    <em>“{augment.flavor}”</em>
                  </button>
                );
              })}
            </div>
          </section>
        </div>
      )}

      {mode === "profession" && professionCandidate && !professionCeremony && (
        <div className="modal-layer profession-layer">
          <section
            className="profession-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="profession-title"
            style={{ "--profession-color": professionCandidate.color } as CSSProperties}
          >
            <p className="modal-kicker">AUGMENT MASTERY · 20 STACKS</p>
            <div className="profession-emblem">
              <AugmentIcon icon={professionCandidate.icon} size={118} />
            </div>
            <small>{professionCandidate.name} 전문 직업</small>
            <h2 id="profession-title">{PROFESSION_TITLES[professionCandidate.id]}</h2>
            <p>
              {professionCandidate.name}의 실제 최대 {MAX_AUGMENT_STACKS}스택은 유지하면서
              전투 계산에서만 <b>{100 + PROFESSION_BONUS_PERCENT}% 효율</b>로
              증폭합니다. 전직은 실제 스택 상한을 늘리지 않습니다.
            </p>
            {hud.player.profession && hud.player.profession !== professionCandidate.id && (
              <span className="profession-warning">
                현재 직업 {PROFESSION_TITLES[hud.player.profession]}의 전문 보정은 해제됩니다.
              </span>
            )}
            <div className="profession-rank-preview" aria-label="전직 전후 증강 효율">
              <div><small>실제 스택</small><strong>{rankOf(hud.player, professionCandidate.id)}</strong></div>
              <i>→</i>
              <div><small>전문 효율</small><strong>{100 + PROFESSION_BONUS_PERCENT}%</strong></div>
            </div>
            <div className="modal-actions">
              <button
                className="primary-button compact"
                data-audio-cue="none"
                disabled={!professionCeremonyReady}
                aria-busy={!professionCeremonyReady}
                onClick={confirmProfession}
              >
                {!professionCeremonyReady
                  ? "전직 문장 준비 중…"
                  : hud.player.profession
                    ? "이 직업으로 전향"
                    : "전직한다"}
              </button>
              <button className="text-button" onClick={closeProfessionChoice}>
                나중에 결정
              </button>
            </div>
          </section>
        </div>
      )}

      {mode === "profession" && professionCeremony && (
        <div
          ref={professionCeremonyDialogRef}
          className="profession-ceremony"
          role="dialog"
          aria-modal="true"
          aria-labelledby="profession-ceremony-title"
          aria-describedby="profession-ceremony-result"
          tabIndex={-1}
          style={
            {
              "--profession-color": professionCeremony.augment.color,
              "--profession-ceremony-duration": `${PROFESSION_CEREMONY_DURATION_MS}ms`,
            } as CSSProperties
          }
        >
          <div className="profession-ceremony-visuals" aria-hidden="true">
            <span className="profession-ceremony-veil" />
            <span className="profession-ceremony-rays profession-ceremony-rays--outer" />
            <span className="profession-ceremony-rays profession-ceremony-rays--inner" />
            <span className="profession-ceremony-pillar profession-ceremony-pillar--left" />
            <span className="profession-ceremony-pillar profession-ceremony-pillar--right" />
            <div className="profession-ceremony-sigil-stage">
              <span className="profession-ceremony-sigil profession-ceremony-sigil--echo" />
              <span className="profession-ceremony-sigil profession-ceremony-sigil--main" />
              <span className="profession-ceremony-orbit profession-ceremony-orbit--outer" />
              <span className="profession-ceremony-orbit profession-ceremony-orbit--inner" />
              <span className="profession-ceremony-core" />
              <div className="profession-ceremony-emblem">
                <AugmentIcon
                  icon={professionCeremony.augment.icon}
                  iconAsset={professionCeremony.augment.iconAsset}
                  size={136}
                />
              </div>
              <div className="profession-ceremony-particles">
                {PROFESSION_CEREMONY_PARTICLES.map((particle, index) => (
                  <i
                    key={index}
                    style={
                      {
                        "--particle-angle": particle.angle,
                        "--particle-distance": particle.distance,
                        "--particle-delay": particle.delay,
                        "--particle-scale": particle.scale,
                      } as CSSProperties
                    }
                  />
                ))}
              </div>
            </div>
            <span className="profession-ceremony-impact" />
            <span className="profession-ceremony-shockwave profession-ceremony-shockwave--one" />
            <span className="profession-ceremony-shockwave profession-ceremony-shockwave--two" />
          </div>
          <section className="profession-ceremony-revelation" aria-live="assertive">
            <p>MEMORY AWAKENING · AUGMENT MASTERY</p>
            <span>전직 완료</span>
            <h2 id="profession-ceremony-title">{professionCeremony.title}</h2>
            <strong>{professionCeremony.augment.name}의 기억이 완전히 각성했습니다</strong>
            <small id="profession-ceremony-result">
              실제 {professionCeremony.rawRank}스택 · 전투 효율 {100 + PROFESSION_BONUS_PERCENT}%
            </small>
          </section>
        </div>
      )}

      {mode === "story" && (
        <div className="modal-layer story-layer">
          <section className="story-modal" role="dialog" aria-modal="true" aria-labelledby="story-title">
            <p className="modal-kicker">{story.eyebrow}</p>
            <h2 id="story-title">{story.title}</h2>
            <p>{story.body}</p>
            <button
              className="primary-button compact"
              onClick={() => storyActionRef.current()}
            >
              지도를 펼친다
            </button>
          </section>
        </div>
      )}

      {mode === "shelter" && (
        <div className="modal-layer shelter-layer">
          <section className="shelter-modal" role="dialog" aria-modal="true" aria-labelledby="shelter-title">
            <p className="modal-kicker">SHELTER · FIRST REST SAVED</p>
            <h2 id="shelter-title">마지막 쉼표</h2>
            <p>
              모닥불이 지금까지의 증강을 <b>고정된 기억</b>으로 바꿨습니다.
              여기서 쓰러져도 이 빌드로 돌아옵니다. 이 쉼터의 불꽃은 이제
              소진되어 다시 방문해도 회복하거나 기억을 고정하지 않습니다.
            </p>
            <dl>
              <div>
                <dt>고정 증강</dt>
                <dd>{Object.values(hud.player.augments).reduce((a, b) => a + b, 0)}</dd>
              </div>
              <div>
                <dt>현재 심도</dt>
                <dd>지하 {hud.world.dungeonFloor}층</dd>
              </div>
              <div>
                <dt>활성 시너지</dt>
                <dd>{synergies.length}</dd>
              </div>
            </dl>
            <div className="modal-actions">
              <button className="primary-button compact" onClick={() => setGameMode("playing")}>
                다시 길 위로
              </button>
              <button className="text-button" onClick={returnToMenu}>
                {onReturnToPlaza ? "마을 광장으로 돌아가기" : "타이틀로 돌아가기"}
              </button>
            </div>
          </section>
        </div>
      )}

      {mode === "map" && (
        <div className="modal-layer map-layer">
          <section className="map-modal" role="dialog" aria-modal="true" aria-labelledby="map-title">
            <header>
              <div>
                <p className="modal-kicker">99×99 FLOOR CARTOGRAPHY · M</p>
                <h2 id="map-title">무진도 탐사도</h2>
                <span>
                  지하 {mapSnapshot.dungeonFloor}층 · 방 {dungeonDisplayCoordinate(mapSnapshot.roomX)} : {dungeonDisplayCoordinate(mapSnapshot.roomY)}
                </span>
              </div>
              <div className="map-header-actions">
                <div
                  className={`map-teleport-license ${mapTeleportUnlocked ? "is-unlocked" : "is-locked"}`}
                  role="status"
                >
                  <small>무진도의 길잡이</small>
                  <strong>
                    {!mapTeleportUnlocked
                      ? "상점 해금 필요"
                      : mapTeleportDepartureSafe
                        ? "방문·정복 좌표 도약 가능"
                        : "현재 방 정복 후 사용 가능"}
                  </strong>
                </div>
                {!mapTeleportUnlocked && (
                  <button
                    type="button"
                    className="map-teleport-shop"
                    onClick={() => {
                      setGameMode("playing");
                      openWayfinderShop();
                    }}
                  >
                    상점에서 해금
                  </button>
                )}
                <button
                  type="button"
                  className="map-close"
                  onClick={() => setGameMode("playing")}
                  aria-label="지도 닫기"
                >
                  ×
                </button>
              </div>
            </header>
            <div className="map-board" ref={mapBoardRef}>
              <span className="compass north">N</span>
              <span className="compass east">E</span>
              <span className="compass south">S</span>
              <span className="compass west">W</span>
              <MapGrid
                world={mapSnapshot}
                large
                teleportUnlocked={mapTeleportUnlocked}
                teleportDepartureSafe={mapTeleportDepartureSafe}
                onTeleport={teleportToVisitedRoom}
              />
            </div>
            <footer>
              <div className="map-legend" aria-label="지도 범례">
                <span><i className="legend-current" />현재 위치</span>
                <span><i className="legend-teleport" />도약 가능</span>
                <span><i className="legend-cleared" />정복 완료</span>
                <span><i className="legend-visited" />진입함</span>
                <span><i className="legend-battle" />회랑</span>
                <span><i className="legend-horde" />군락</span>
                <span><i className="legend-elite" />정예</span>
                <span><i className="legend-memory" />기억</span>
                <span><i className="legend-shelter" />쉼터</span>
                <span><i className="legend-boss" />보스</span>
                <span><i className="legend-stairs" />발견한 하행 계단</span>
              </div>
              <div className="map-route-summary">
                <small>탐사 기록</small>
                <strong>
                  {mapCounts.visited.toLocaleString("ko-KR")}/9,801 진입 · {mapCounts.cleared.toLocaleString("ko-KR")} 정복 · {mapCounts.known.toLocaleString("ko-KR")} 좌표 확인
                </strong>
                <span>
                  {mapNearestLandmark
                    ? `가장 가까운 ${mapNearestLandmark.room.kind === "shelter" ? "쉼터" : "보스"}: ${dungeonDisplayCoordinate(mapNearestLandmark.x)} : ${dungeonDisplayCoordinate(mapNearestLandmark.y)} · ${mapNearestLandmark.distance}칸`
                    : "사방의 문을 지나 새로운 좌표를 정찰하세요."}
                </span>
              </div>
              <button className="primary-button compact" onClick={() => setGameMode("playing")}>
                탐험 계속
              </button>
            </footer>
          </section>
        </div>
      )}

      {mode === "paused" && (
        <div className="modal-layer pause-layer">
          <section className="pause-modal" role="dialog" aria-modal="true" aria-labelledby="pause-title">
            <p className="modal-kicker">PAUSED</p>
            <h2 id="pause-title">지도를 접었습니다</h2>
            <div className="pause-dashboard">
              <div>
                <small>현재 원정</small>
                <strong>LV.{hud.player.level} · 지하 {hud.world.dungeonFloor}층</strong>
                <span>증강 {Object.values(hud.player.augments).reduce((a, b) => a + b, 0)}중첩 · 시너지 {synergies.length}</span>
              </div>
              <dl>
                <div><dt>이동</dt><dd>WASD / 방향키</dd></div>
                <div><dt>회피</dt><dd>SPACE</dd></div>
                <div><dt>전체 지도</dt><dd>M</dd></div>
                <div><dt>빌드 패널</dt><dd>B</dd></div>
              </dl>
            </div>
            <div className="modal-actions">
              <button className="primary-button compact" onClick={() => setGameMode("playing")}>
                계속 탐험
              </button>
              <button
                className="text-button"
                onClick={() =>
                  requestGameConfirmation(
                    {
                      eyebrow: "ABANDON EXPEDITION",
                      title: onReturnToPlaza
                        ? "마을 광장으로 돌아갈까요?"
                        : "타이틀로 돌아갈까요?",
                      body: "마지막 쉼터 이후에 얻은 증강과 장비는 사라집니다.",
                      confirmLabel: "원정 포기",
                      tone: "danger",
                    },
                    returnToMenu,
                  )
                }
              >
                {onReturnToPlaza ? "마을 광장으로" : "타이틀로"}
              </button>
            </div>
          </section>
        </div>
      )}

      {mode === "dead" && (
        <div className="modal-layer death-layer">
          <section className="death-modal" role="dialog" aria-modal="true" aria-labelledby="death-title">
            <p className="modal-kicker">MEMORY LOST</p>
            <h2 id="death-title">하린의 문장이 끊겼다</h2>
            <p>
              마지막 쉼터 이후 얻은 불안정한 기억은 흩어집니다.
              <br />
              고정된 빌드와 같은 지도는 그대로 남아 있습니다.
            </p>
            <div className="run-summary">
              <span>
                처치 <b>{hud.player.kills}</b>
              </span>
              <span>
                심도 <b>지하 {hud.world.dungeonFloor}층</b>
              </span>
              <span>
                증강 <b>{ownedAugments.length}</b>
              </span>
            </div>
            <div className="modal-actions">
              <button className="primary-button compact" onClick={retryFromShelter}>
                마지막 쉼표에서 재도전
              </button>
              <button className="text-button" onClick={() => startNewRun()}>
                새 기억으로 시작
              </button>
            </div>
          </section>
        </div>
      )}

      {mode === "ending" && (
        <div className="modal-layer ending-layer">
          <section
            className="ending-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="ending-title"
            aria-describedby="ending-copy"
          >
            <header className="ending-header">
              <p className="modal-kicker">{endingChapter.eyebrow}</p>
              <span aria-label={`반전 기록 ${endingChapterIndex + 1}/${FIRST_BOSS_ENDING_CHAPTERS.length}`}>
                MEMORY {String(endingChapterIndex + 1).padStart(2, "0")} / {String(FIRST_BOSS_ENDING_CHAPTERS.length).padStart(2, "0")}
              </span>
            </header>
            <h2 id="ending-title">{endingChapter.title}</h2>
            <div className="ending-progress" aria-hidden="true">
              {FIRST_BOSS_ENDING_CHAPTERS.map((chapter, index) => (
                <i
                  key={chapter.title}
                  className={index <= endingChapterIndex ? "is-revealed" : ""}
                />
              ))}
            </div>
            <div
              className="ending-story"
              id="ending-copy"
              key={endingChapter.title}
              aria-live="polite"
            >
              {endingChapter.paragraphs.map((paragraph) => (
                <p key={paragraph}>{paragraph}</p>
              ))}
            </div>
            <footer className="ending-actions">
              <button
                type="button"
                className="text-button ending-back"
                disabled={endingChapterIndex === 0}
                onClick={() => {
                  setEndingChapterIndex((current) => Math.max(0, current - 1));
                }}
              >
                이전 기록
              </button>
              <button
                type="button"
                className="primary-button compact ending-next"
                onClick={() => {
                  if (endingIsFinal) {
                    continueAfterEnding();
                    return;
                  }
                  setEndingChapterIndex((current) =>
                    Math.min(FIRST_BOSS_ENDING_CHAPTERS.length - 1, current + 1),
                  );
                }}
              >
                {endingIsFinal ? ENDING_CONTINUE_LABEL : "다음 기억을 읽는다"}
              </button>
            </footer>
          </section>
        </div>
      )}
      {gameConfirmationOverlay}
    </main>
  );
}
