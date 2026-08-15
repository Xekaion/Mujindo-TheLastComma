import { ROOM_DOOR_FRAME_COUNT } from "./room-doors";
import type { RoomArtKey, RoomStairArtKey } from "./room-visuals";

// V4 stores one complete 1280x720 room per frame in a two-column by
// three-row atlas. Frame zero is fully closed and frame five is fully open.
export const ROOM_DOOR_ATLAS_CELL_WIDTH = 1280;
export const ROOM_DOOR_ATLAS_CELL_HEIGHT = 720;
export const ROOM_DOOR_ATLAS_COLUMN_COUNT = 2;
export const ROOM_DOOR_ATLAS_ROW_COUNT = 3;
export const ROOM_DOOR_ATLAS_WIDTH =
  ROOM_DOOR_ATLAS_CELL_WIDTH * ROOM_DOOR_ATLAS_COLUMN_COUNT;
export const ROOM_DOOR_ATLAS_HEIGHT =
  ROOM_DOOR_ATLAS_CELL_HEIGHT * ROOM_DOOR_ATLAS_ROW_COUNT;
export const ROOM_DOOR_REFERENCE_WIDTH = ROOM_DOOR_ATLAS_CELL_WIDTH;
export const ROOM_DOOR_REFERENCE_HEIGHT = ROOM_DOOR_ATLAS_CELL_HEIGHT;

export const ROOM_DOOR_SIDES = ["north", "east", "south", "west"] as const;
export type RoomDoorSide = (typeof ROOM_DOOR_SIDES)[number];

export type RoomDoorClip = Readonly<{
  /** Rectangle in the authored 1280x720 room frame. */
  x: number;
  y: number;
  width: number;
  height: number;
}>;

export type RoomDoorVisualDefinition = Readonly<{
  imagePath: string;
  doorwayClips: Readonly<Record<RoomDoorSide, RoomDoorClip>>;
}>;

export type RoomDoorBackdropKey = RoomArtKey | RoomStairArtKey;

// These are the original room doorway bounds projected from 1600x900 onto the
// native v4 frame. Keeping the bounds shared by every backdrop lets a closed
// v4 frame seal only a missing edge doorway without replacing the room itself.
export const ROOM_DOOR_DOORWAY_CLIPS = {
  north: { x: 574.4, y: 0, width: 131.2, height: 102.4 },
  east: { x: 1155.2, y: 299.2, width: 124.8, height: 121.6 },
  south: { x: 564.8, y: 616, width: 150.4, height: 104 },
  west: { x: 0, y: 299.2, width: 124.8, height: 121.6 },
} as const satisfies Readonly<Record<RoomDoorSide, RoomDoorClip>>;

const roomDoorVisual = (roomStem: string): RoomDoorVisualDefinition => ({
  imagePath: `/assets/maps/room-doors-v4/${roomStem}-doors-v4.webp`,
  doorwayClips: ROOM_DOOR_DOORWAY_CLIPS,
});

/** Full-room v4 atlases for all nine base and nine stair backdrops. */
export const ROOM_DOOR_VISUALS = {
  roomBattle: roomDoorVisual("room-battle"),
  roomHorde: roomDoorVisual("room-horde"),
  roomElite: roomDoorVisual("room-elite"),
  roomMemory: roomDoorVisual("room-memory"),
  roomShelter: roomDoorVisual("room-shelter"),
  roomBoss: roomDoorVisual("room-boss"),
  roomDrownedArchive: roomDoorVisual("room-drowned-archive"),
  roomRootboundOssuary: roomDoorVisual("room-rootbound-ossuary"),
  roomShatteredAstrarium: roomDoorVisual("room-shattered-astrarium"),
  roomBattleStairs: roomDoorVisual("room-battle-stairs-v1"),
  roomHordeStairs: roomDoorVisual("room-horde-stairs-v1"),
  roomEliteStairs: roomDoorVisual("room-elite-stairs-v1"),
  roomMemoryStairs: roomDoorVisual("room-memory-stairs-v1"),
  roomShelterStairs: roomDoorVisual("room-shelter-stairs-v1"),
  roomBossStairs: roomDoorVisual("room-boss-stairs-v1"),
  roomDrownedArchiveStairs: roomDoorVisual(
    "room-drowned-archive-stairs-v1",
  ),
  roomRootboundOssuaryStairs: roomDoorVisual(
    "room-rootbound-ossuary-stairs-v1",
  ),
  roomShatteredAstrariumStairs: roomDoorVisual(
    "room-shattered-astrarium-stairs-v1",
  ),
} as const satisfies Record<RoomDoorBackdropKey, RoomDoorVisualDefinition>;

export function roomDoorAtlasImageKey(backdropKey: RoomDoorBackdropKey) {
  return `roomDoorAtlas:${backdropKey}`;
}

export function roomDoorAtlasFrameSourceRect(frame: number) {
  const finiteFrame = Number.isFinite(frame) ? Math.trunc(frame) : 0;
  const clampedFrame = Math.max(
    0,
    Math.min(ROOM_DOOR_FRAME_COUNT - 1, finiteFrame),
  );
  return {
    x:
      (clampedFrame % ROOM_DOOR_ATLAS_COLUMN_COUNT) *
      ROOM_DOOR_ATLAS_CELL_WIDTH,
    y:
      Math.floor(clampedFrame / ROOM_DOOR_ATLAS_COLUMN_COUNT) *
      ROOM_DOOR_ATLAS_CELL_HEIGHT,
    width: ROOM_DOOR_ATLAS_CELL_WIDTH,
    height: ROOM_DOOR_ATLAS_CELL_HEIGHT,
  } as const;
}

export function roomDoorAtlasClipSourceRect(
  frame: number,
  clip: RoomDoorClip,
) {
  const frameRect = roomDoorAtlasFrameSourceRect(frame);
  return {
    x: frameRect.x + clip.x,
    y: frameRect.y + clip.y,
    width: clip.width,
    height: clip.height,
  } as const;
}

export function roomDoorClipCanvasRect(
  clip: RoomDoorClip,
  canvasWidth: number,
  canvasHeight: number,
) {
  return {
    x: (clip.x / ROOM_DOOR_REFERENCE_WIDTH) * canvasWidth,
    y: (clip.y / ROOM_DOOR_REFERENCE_HEIGHT) * canvasHeight,
    width: (clip.width / ROOM_DOOR_REFERENCE_WIDTH) * canvasWidth,
    height: (clip.height / ROOM_DOOR_REFERENCE_HEIGHT) * canvasHeight,
  } as const;
}

export function mirroredRoomDoorSide(side: RoomDoorSide): RoomDoorSide {
  if (side === "east") return "west";
  if (side === "west") return "east";
  return side;
}
