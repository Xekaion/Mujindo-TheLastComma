import { ROOM_DOOR_FRAME_COUNT } from "./room-doors";
import type { RoomArtKey } from "./room-visuals";

// The largest in-game doorway is 188x152 px. A 256x192 authored cell keeps
// enough supersampling for Lanczos downscaling while avoiding a 19 MB decoded
// texture for every room variant.
export const ROOM_DOOR_ATLAS_CELL_WIDTH = 256;
export const ROOM_DOOR_ATLAS_CELL_HEIGHT = 192;
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
   * Exact crop of the original 1600x900 room painting that was used while
   * authoring this side. The transparent door-only cell is stretched back to
   * this rectangle, so its vanishing point stays locked to the backplate.
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
 * These rectangles are intentionally recorded per room painting instead of
 * rotating one front-facing gate at runtime. Every authored cell is a
 * transparent crop produced for the named room's exact doorway rectangle,
 * including that doorway's oblique wall angle and foreground occlusion.
 *
 * The nine paintings share a 1600x900 composition but their masonry is not
 * pixel-identical. Wide crop-safe gutters let the generated door overlap the
 * original jamb instead of floating in front of the walkable-floor boundary.
 */
export const ROOM_DOOR_VISUALS = {
  roomBattle: {
    imagePath: "/assets/effects/room-doors-v2/room-battle-doors-v2.webp",
    sides: ARCHWAY_CROPS,
  },
  roomHorde: {
    imagePath: "/assets/effects/room-doors-v2/room-horde-doors-v2.webp",
    sides: ARCHWAY_CROPS,
  },
  roomElite: {
    imagePath: "/assets/effects/room-doors-v2/room-elite-doors-v2.webp",
    sides: ARCHWAY_CROPS,
  },
  roomMemory: {
    imagePath: "/assets/effects/room-doors-v2/room-memory-doors-v2.webp",
    sides: ARCHWAY_CROPS,
  },
  roomShelter: {
    imagePath: "/assets/effects/room-doors-v2/room-shelter-doors-v2.webp",
    sides: ARCHWAY_CROPS,
  },
  roomBoss: {
    imagePath: "/assets/effects/room-doors-v2/room-boss-doors-v2.webp",
    sides: ARCHWAY_CROPS,
  },
  roomDrownedArchive: {
    imagePath:
      "/assets/effects/room-doors-v2/room-drowned-archive-doors-v2.webp",
    sides: ARCHWAY_CROPS,
  },
  roomRootboundOssuary: {
    imagePath:
      "/assets/effects/room-doors-v2/room-rootbound-ossuary-doors-v2.webp",
    sides: ARCHWAY_CROPS,
  },
  roomShatteredAstrarium: {
    imagePath:
      "/assets/effects/room-doors-v2/room-shattered-astrarium-doors-v2.webp",
    sides: ARCHWAY_CROPS,
  },
} as const satisfies Record<RoomArtKey, RoomDoorVisualDefinition>;

export function roomDoorVisualImageKey(roomArtKey: RoomArtKey) {
  return `roomDoorVisual:${roomArtKey}`;
}

export function roomDoorAtlasSourceRect(side: RoomDoorSide, frame: number) {
  const clampedFrame = Math.max(
    0,
    Math.min(ROOM_DOOR_FRAME_COUNT - 1, Math.trunc(frame)),
  );
  return {
    x: clampedFrame * ROOM_DOOR_ATLAS_CELL_WIDTH,
    y: ROOM_DOOR_SIDES.indexOf(side) * ROOM_DOOR_ATLAS_CELL_HEIGHT,
    width: ROOM_DOOR_ATLAS_CELL_WIDTH,
    height: ROOM_DOOR_ATLAS_CELL_HEIGHT,
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
