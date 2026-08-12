export const ROOM_VISUAL_KINDS = [
  "battle",
  "horde",
  "elite",
  "memory",
  "shelter",
  "boss",
] as const;

export type RoomVisualKind = (typeof ROOM_VISUAL_KINDS)[number];

export const ROOM_ART_PATHS = {
  roomBattle: "/assets/maps/room-battle.webp",
  roomHorde: "/assets/maps/room-horde.webp",
  roomElite: "/assets/maps/room-elite.webp",
  roomMemory: "/assets/maps/room-memory.webp",
  roomShelter: "/assets/maps/room-shelter.webp",
  roomBoss: "/assets/maps/room-boss.webp",
  roomDrownedArchive: "/assets/maps/room-drowned-archive.webp",
  roomRootboundOssuary: "/assets/maps/room-rootbound-ossuary.webp",
  roomShatteredAstrarium: "/assets/maps/room-shattered-astrarium.webp",
} as const;

export type RoomArtKey = keyof typeof ROOM_ART_PATHS;

export const ROOM_STAIR_ART_PATHS = {
  roomBattleStairs: "/assets/maps/room-battle-stairs-v1.webp",
  roomHordeStairs: "/assets/maps/room-horde-stairs-v1.webp",
  roomEliteStairs: "/assets/maps/room-elite-stairs-v1.webp",
  roomMemoryStairs: "/assets/maps/room-memory-stairs-v1.webp",
  roomShelterStairs: "/assets/maps/room-shelter-stairs-v1.webp",
  roomBossStairs: "/assets/maps/room-boss-stairs-v1.webp",
  roomDrownedArchiveStairs:
    "/assets/maps/room-drowned-archive-stairs-v1.webp",
  roomRootboundOssuaryStairs:
    "/assets/maps/room-rootbound-ossuary-stairs-v1.webp",
  roomShatteredAstrariumStairs:
    "/assets/maps/room-shattered-astrarium-stairs-v1.webp",
} as const;

export type RoomStairArtKey = keyof typeof ROOM_STAIR_ART_PATHS;

export const ROOM_STAIR_ART_BY_ROOM_ART = {
  roomBattle: "roomBattleStairs",
  roomHorde: "roomHordeStairs",
  roomElite: "roomEliteStairs",
  roomMemory: "roomMemoryStairs",
  roomShelter: "roomShelterStairs",
  roomBoss: "roomBossStairs",
  roomDrownedArchive: "roomDrownedArchiveStairs",
  roomRootboundOssuary: "roomRootboundOssuaryStairs",
  roomShatteredAstrarium: "roomShatteredAstrariumStairs",
} as const satisfies Record<RoomArtKey, RoomStairArtKey>;

export const ROOM_STAIR_ASSET_ANCHOR = {
  sourceWidth: 1600,
  sourceHeight: 900,
  x: 800,
  y: 560,
} as const;

export function resolveStairRoomArtKey(
  roomArtKey: RoomArtKey,
): RoomStairArtKey {
  return ROOM_STAIR_ART_BY_ROOM_ART[roomArtKey];
}

export const ROOM_ART_VARIANTS = {
  battle: [
    "roomBattle",
    "roomDrownedArchive",
    "roomRootboundOssuary",
    "roomShatteredAstrarium",
  ],
  horde: [
    "roomHorde",
    "roomDrownedArchive",
    "roomRootboundOssuary",
    "roomShatteredAstrarium",
  ],
  elite: [
    "roomElite",
    "roomDrownedArchive",
    "roomRootboundOssuary",
    "roomShatteredAstrarium",
  ],
  memory: [
    "roomMemory",
    "roomDrownedArchive",
    "roomRootboundOssuary",
    "roomShatteredAstrarium",
  ],
  shelter: ["roomShelter"],
  boss: ["roomBoss"],
} as const satisfies Record<RoomVisualKind, readonly RoomArtKey[]>;

export const ROOM_ART_NAMES: Record<RoomArtKey, string> = {
  roomBattle: "잊힌 교정 회랑",
  roomHorde: "메마른 자들의 굴",
  roomElite: "붉은 봉인의 방",
  roomMemory: "어린 기억의 성소",
  roomShelter: "마지막 쉼표",
  roomBoss: "지도의 심장",
  roomDrownedArchive: "침수된 기록 수장고",
  roomRootboundOssuary: "뿌리 침식 납골당",
  roomShatteredAstrarium: "붕괴한 천문 관측실",
};

type ResolveRoomArtOptions = {
  seed: number;
  dungeonFloor: number;
  roomX: number;
  roomY: number;
  roomKind: RoomVisualKind;
};

function positiveModulo(value: number, divisor: number) {
  return ((value % divisor) + divisor) % divisor;
}

function floorVisualOffset(seed: number, dungeonFloor: number) {
  let value =
    (seed ^ Math.imul(dungeonFloor + 4093, 0x45d9f3b) ^ 0x6d2b79f5) | 0;
  value = Math.imul(value ^ (value >>> 15), 0x2c1b3c6d);
  return (value ^ (value >>> 12)) >>> 0;
}

/**
 * Resolves a room backplate without adding anything to the save schema.
 *
 * Ordinary rooms share four visual families. The coordinate strides are both
 * coprime to four, so crossing a cardinal doorway cannot immediately repeat
 * the same family. The floor offset keeps a coordinate fresh on the next
 * dungeon floor while remaining stable across reloads and exploration order.
 */
export function resolveRoomArtKey({
  seed,
  dungeonFloor,
  roomX,
  roomY,
  roomKind,
}: ResolveRoomArtOptions): RoomArtKey {
  const variants = ROOM_ART_VARIANTS[roomKind];
  if (variants.length === 1) return variants[0];

  const index = positiveModulo(
    floorVisualOffset(seed, dungeonFloor) + roomX * 3 + roomY * 5,
    variants.length,
  );
  return variants[index];
}
