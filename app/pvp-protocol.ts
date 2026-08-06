export const PVP_ARENA_WIDTH = 1280;
export const PVP_ARENA_HEIGHT = 720;
export const PVP_ROUND_DURATION_MS = 90_000;
export const PVP_COUNTDOWN_MS = 3_000;
export const PVP_SCORE_TO_WIN = 3;
export const PVP_INPUT_RATE_HZ = 30;

export type PvpPhase = "countdown" | "playing" | "finished";

export type PvpInput = {
  sequence: number;
  moveX: number;
  moveY: number;
  aimX: number;
  aimY: number;
  fire: boolean;
  dash: boolean;
};

export type PvpPlayerSnapshot = {
  id: string;
  name: string;
  side: 0 | 1;
  x: number;
  y: number;
  vx: number;
  vy: number;
  aimX: number;
  aimY: number;
  hp: number;
  maxHp: number;
  score: number;
  dashCooldownMs: number;
  respawnMs: number;
  connected: boolean;
  lastInputSequence: number;
};

export type PvpProjectileSnapshot = {
  id: number;
  ownerId: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
};

export type PvpSnapshot = {
  type: "pvp_snapshot";
  matchId: string;
  tick: number;
  serverTime: number;
  phase: PvpPhase;
  startsAt: number;
  remainingMs: number;
  winnerId: string | null;
  players: PvpPlayerSnapshot[];
  projectiles: PvpProjectileSnapshot[];
};

export type WorldLootRarity = "mythic" | "cosmic";

export type WorldLootAnnouncement = {
  id: string;
  sequence: number;
  playerName: string;
  itemName: string;
  rarity: WorldLootRarity;
  itemLevel: number;
  enhancement: number;
  createdAt: number;
};

export type RealtimeServerMessage =
  | {
      type: "connected";
      playerId: string;
      displayName: string;
      online: number;
      recentAnnouncements: WorldLootAnnouncement[];
    }
  | { type: "presence"; online: number }
  | { type: "queue_state"; state: "idle" | "queued"; position?: number }
  | {
      type: "match_found";
      matchId: string;
      opponentName: string;
      side: 0 | 1;
      startsAt: number;
      durationMs: number;
      scoreToWin: number;
    }
  | PvpSnapshot
  | {
      type: "match_result";
      matchId: string;
      winnerId: string | null;
      reason: "score" | "timeout" | "disconnect" | "draw";
    }
  | { type: "world_announcement"; announcement: WorldLootAnnouncement }
  | { type: "pong"; clientTime: number; serverTime: number }
  | { type: "error"; code: string; message: string };

export type RealtimeClientMessage =
  | { type: "queue" }
  | { type: "cancel_queue" }
  | ({ type: "pvp_input" } & PvpInput)
  | {
      type: "announce_loot";
      acquisitionId: string;
      itemName: string;
      rarity: WorldLootRarity;
      itemLevel: number;
      enhancement: number;
    }
  | { type: "ping"; clientTime: number };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

export function sanitizeDisplayName(value: unknown): string {
  if (typeof value !== "string") return "이름 없는 방랑자";
  const normalized = value
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 18);
  return normalized || "이름 없는 방랑자";
}

export function sanitizeItemName(value: unknown): string {
  if (typeof value !== "string") return "이름 없는 장비";
  const normalized = value
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 42);
  return normalized || "이름 없는 장비";
}

export function normalizePvpInput(value: unknown): PvpInput | null {
  if (!isRecord(value)) return null;
  const sequence = value.sequence;
  if (!Number.isSafeInteger(sequence) || (sequence as number) < 0) return null;
  if (
    !isFiniteNumber(value.moveX) ||
    !isFiniteNumber(value.moveY) ||
    !isFiniteNumber(value.aimX) ||
    !isFiniteNumber(value.aimY) ||
    typeof value.fire !== "boolean" ||
    typeof value.dash !== "boolean"
  ) {
    return null;
  }
  const moveLength = Math.hypot(value.moveX, value.moveY);
  const aimLength = Math.hypot(value.aimX, value.aimY);
  return {
    sequence: sequence as number,
    moveX: moveLength > 1 ? value.moveX / moveLength : value.moveX,
    moveY: moveLength > 1 ? value.moveY / moveLength : value.moveY,
    aimX: aimLength > 0.001 ? value.aimX / aimLength : 1,
    aimY: aimLength > 0.001 ? value.aimY / aimLength : 0,
    fire: value.fire,
    dash: value.dash,
  };
}

export function parseRealtimeClientMessage(value: unknown): RealtimeClientMessage | null {
  if (!isRecord(value) || typeof value.type !== "string") return null;
  if (value.type === "queue" || value.type === "cancel_queue") {
    return { type: value.type };
  }
  if (value.type === "pvp_input") {
    const input = normalizePvpInput(value);
    return input ? { type: "pvp_input", ...input } : null;
  }
  if (value.type === "ping" && isFiniteNumber(value.clientTime)) {
    return { type: "ping", clientTime: value.clientTime };
  }
  if (value.type === "announce_loot") {
    if (
      typeof value.acquisitionId !== "string" ||
      value.acquisitionId.length < 8 ||
      value.acquisitionId.length > 96 ||
      (value.rarity !== "mythic" && value.rarity !== "cosmic") ||
      !Number.isSafeInteger(value.itemLevel) ||
      !Number.isSafeInteger(value.enhancement)
    ) {
      return null;
    }
    return {
      type: "announce_loot",
      acquisitionId: value.acquisitionId,
      itemName: sanitizeItemName(value.itemName),
      rarity: value.rarity,
      itemLevel: Math.max(1, Math.min(999, value.itemLevel as number)),
      enhancement: Math.max(0, Math.min(10, value.enhancement as number)),
    };
  }
  return null;
}

export function parseRealtimeServerMessage(value: unknown): RealtimeServerMessage | null {
  if (!isRecord(value) || typeof value.type !== "string") return null;
  switch (value.type) {
    case "connected":
    case "presence":
    case "queue_state":
    case "match_found":
    case "pvp_snapshot":
    case "match_result":
    case "world_announcement":
    case "pong":
    case "error":
      return value as RealtimeServerMessage;
    default:
      return null;
  }
}
