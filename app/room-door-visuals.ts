import { ROOM_DOOR_FRAME_COUNT } from "./room-doors";
import type { RoomArtKey, RoomStairArtKey } from "./room-visuals";

// V3 stores opaque patches baked from the exact room backdrop. Every atlas
// cell uses the largest doorway as its stride, while sampling only the authored
// crop dimensions so padding can never overwrite neighboring room pixels.
export const ROOM_DOOR_ATLAS_CELL_WIDTH = 188;
export const ROOM_DOOR_ATLAS_CELL_HEIGHT = 152;
export const ROOM_DOOR_ATLAS_COLUMN_COUNT = ROOM_DOOR_FRAME_COUNT;
export const ROOM_DOOR_ATLAS_ROW_COUNT = 4;
export const ROOM_DOOR_REFERENCE_WIDTH = 1600;
export const ROOM_DOOR_REFERENCE_HEIGHT = 900;

export const ROOM_DOOR_SIDES = ["north", "east", "south", "west"] as const;
export type RoomDoorSide = (typeof ROOM_DOOR_SIDES)[number];

export type RoomDoorCrop = Readonly<{
  /** Row in the six-column by four-row authored atlas. */
  row: number;
  /**
   * Exact crop of the original 1600x900 room painting baked into this side's
   * opaque state cell. Sampling it at native dimensions keeps the patch and
   * backplate on the same pixel grid.
   */
  x: number;
  y: number;
  width: number;
  height: number;
}>;

export type RoomDoorVisualDefinition = Readonly<{
  imagePath: string;
  sides: Readonly<Record<RoomDoorSide, RoomDoorCrop>>;
}>;

export type RoomDoorBackdropKey = RoomArtKey | RoomStairArtKey;

const roomDoorCrops = (
  north: Omit<RoomDoorCrop, "row">,
  east: Omit<RoomDoorCrop, "row">,
  south: Omit<RoomDoorCrop, "row">,
  west: Omit<RoomDoorCrop, "row">,
): RoomDoorVisualDefinition["sides"] => ({
  north: { row: 0, ...north },
  east: { row: 1, ...east },
  south: { row: 2, ...south },
  west: { row: 3, ...west },
});

const ARCHWAY_CROPS = roomDoorCrops(
  { x: 718, y: 0, width: 164, height: 128 },
  { x: 1444, y: 374, width: 156, height: 152 },
  { x: 706, y: 770, width: 188, height: 130 },
  { x: 0, y: 374, width: 156, height: 152 },
);

/*
 * Every v3 cell is an opaque replacement patch cut from the named 1600x900
 * backdrop after its ironwork was authored in place. Base and stair paintings
 * therefore have separate atlases even though their doorway coordinates match.
 */
export const ROOM_DOOR_VISUALS = {
  roomBattle: {
    imagePath: "/assets/effects/room-doors-v3/room-battle-doors-v3.webp",
    sides: ARCHWAY_CROPS,
  },
  roomHorde: {
    imagePath: "/assets/effects/room-doors-v3/room-horde-doors-v3.webp",
    sides: ARCHWAY_CROPS,
  },
  roomElite: {
    imagePath: "/assets/effects/room-doors-v3/room-elite-doors-v3.webp",
    sides: ARCHWAY_CROPS,
  },
  roomMemory: {
    imagePath: "/assets/effects/room-doors-v3/room-memory-doors-v3.webp",
    sides: ARCHWAY_CROPS,
  },
  roomShelter: {
    imagePath: "/assets/effects/room-doors-v3/room-shelter-doors-v3.webp",
    sides: ARCHWAY_CROPS,
  },
  roomBoss: {
    imagePath: "/assets/effects/room-doors-v3/room-boss-doors-v3.webp",
    sides: ARCHWAY_CROPS,
  },
  roomDrownedArchive: {
    imagePath:
      "/assets/effects/room-doors-v3/room-drowned-archive-doors-v3.webp",
    sides: ARCHWAY_CROPS,
  },
  roomRootboundOssuary: {
    imagePath:
      "/assets/effects/room-doors-v3/room-rootbound-ossuary-doors-v3.webp",
    sides: ARCHWAY_CROPS,
  },
  roomShatteredAstrarium: {
    imagePath:
      "/assets/effects/room-doors-v3/room-shattered-astrarium-doors-v3.webp",
    sides: ARCHWAY_CROPS,
  },
  roomBattleStairs: {
    imagePath:
      "/assets/effects/room-doors-v3/room-battle-stairs-v1-doors-v3.webp",
    sides: ARCHWAY_CROPS,
  },
  roomHordeStairs: {
    imagePath:
      "/assets/effects/room-doors-v3/room-horde-stairs-v1-doors-v3.webp",
    sides: ARCHWAY_CROPS,
  },
  roomEliteStairs: {
    imagePath:
      "/assets/effects/room-doors-v3/room-elite-stairs-v1-doors-v3.webp",
    sides: ARCHWAY_CROPS,
  },
  roomMemoryStairs: {
    imagePath:
      "/assets/effects/room-doors-v3/room-memory-stairs-v1-doors-v3.webp",
    sides: ARCHWAY_CROPS,
  },
  roomShelterStairs: {
    imagePath:
      "/assets/effects/room-doors-v3/room-shelter-stairs-v1-doors-v3.webp",
    sides: ARCHWAY_CROPS,
  },
  roomBossStairs: {
    imagePath:
      "/assets/effects/room-doors-v3/room-boss-stairs-v1-doors-v3.webp",
    sides: ARCHWAY_CROPS,
  },
  roomDrownedArchiveStairs: {
    imagePath:
      "/assets/effects/room-doors-v3/room-drowned-archive-stairs-v1-doors-v3.webp",
    sides: ARCHWAY_CROPS,
  },
  roomRootboundOssuaryStairs: {
    imagePath:
      "/assets/effects/room-doors-v3/room-rootbound-ossuary-stairs-v1-doors-v3.webp",
    sides: ARCHWAY_CROPS,
  },
  roomShatteredAstrariumStairs: {
    imagePath:
      "/assets/effects/room-doors-v3/room-shattered-astrarium-stairs-v1-doors-v3.webp",
    sides: ARCHWAY_CROPS,
  },
} as const satisfies Record<RoomDoorBackdropKey, RoomDoorVisualDefinition>;

export function roomDoorVisualImageKey(backdropKey: RoomDoorBackdropKey) {
  return `roomDoorVisual:${backdropKey}`;
}

export function roomDoorAtlasSourceRect(
  side: RoomDoorSide,
  frame: number,
  crop: RoomDoorCrop,
) {
  const clampedFrame = Math.max(
    0,
    Math.min(ROOM_DOOR_FRAME_COUNT - 1, Math.trunc(frame)),
  );
  return {
    x: clampedFrame * ROOM_DOOR_ATLAS_CELL_WIDTH,
    y: ROOM_DOOR_SIDES.indexOf(side) * ROOM_DOOR_ATLAS_CELL_HEIGHT,
    width: crop.width,
    height: crop.height,
  } as const;
}

export function roomDoorCanvasRect(
  crop: RoomDoorCrop,
  canvasWidth: number,
  canvasHeight: number,
) {
  return {
    x: (crop.x / ROOM_DOOR_REFERENCE_WIDTH) * canvasWidth,
    y: (crop.y / ROOM_DOOR_REFERENCE_HEIGHT) * canvasHeight,
    width: (crop.width / ROOM_DOOR_REFERENCE_WIDTH) * canvasWidth,
    height: (crop.height / ROOM_DOOR_REFERENCE_HEIGHT) * canvasHeight,
  } as const;
}

export function mirroredRoomDoorSide(side: RoomDoorSide): RoomDoorSide {
  if (side === "east") return "west";
  if (side === "west") return "east";
  return side;
}
