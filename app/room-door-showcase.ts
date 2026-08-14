export const ROOM_DOOR_SHOWCASE_ROOMS = [
  "roomBattle",
  "roomHorde",
  "roomElite",
  "roomMemory",
  "roomShelter",
  "roomBoss",
  "roomDrownedArchive",
  "roomRootboundOssuary",
  "roomShatteredAstrarium",
] as const;

export type RoomDoorShowcaseRoom =
  (typeof ROOM_DOOR_SHOWCASE_ROOMS)[number];
export type RoomDoorShowcaseVariant = "base" | "stairs";

export type RoomDoorShowcaseRequest = Readonly<{
  room: RoomDoorShowcaseRoom;
  variant: RoomDoorShowcaseVariant;
  fixedFrame: number | null;
  mirror: boolean;
}>;

type ShowcaseQueryValue = string | string[] | undefined;
type ShowcaseQuery = Record<string, ShowcaseQueryValue>;

const isRoomDoorShowcaseRoom = (
  value: string,
): value is RoomDoorShowcaseRoom =>
  ROOM_DOOR_SHOWCASE_ROOMS.some((room) => room === value);

export function isLocalRoomDoorShowcaseHost(host: string | null): boolean {
  const firstHost = (host ?? "").split(",", 1)[0]?.trim().toLowerCase() ?? "";
  if (!firstHost) return false;
  const hostname = firstHost.startsWith("[")
    ? firstHost.slice(1, firstHost.indexOf("]"))
    : firstHost.split(":", 1)[0];
  return hostname === "localhost" || hostname === "127.0.0.1";
}

export function resolveRoomDoorShowcaseRequest(
  query: ShowcaseQuery,
  host: string | null,
): RoomDoorShowcaseRequest | null {
  if (!isLocalRoomDoorShowcaseHost(host)) return null;

  const requestedRoom = query.roomDoorShowcase;
  if (
    typeof requestedRoom !== "string" ||
    !isRoomDoorShowcaseRoom(requestedRoom)
  ) {
    return null;
  }

  const requestedVariant = query.variant;
  const variant: RoomDoorShowcaseVariant =
    requestedVariant === "stairs" ? "stairs" : "base";
  const requestedFrame = query.frame;
  const fixedFrame =
    typeof requestedFrame === "string" && /^[0-5]$/.test(requestedFrame)
      ? Number(requestedFrame)
      : null;

  return {
    room: requestedRoom,
    variant,
    fixedFrame,
    mirror: query.mirror === "1",
  };
}
