export const PVP_ARENA_WIDTH = 1280;
export const PVP_ARENA_HEIGHT = 720;
export const PVP_ROUND_DURATION_MS = 90_000;
export const PVP_COUNTDOWN_MS = 3_000;
export const PVP_SCORE_TO_WIN = 3;
export const PVP_INPUT_RATE_HZ = 30;
export const PVP_BASE_PROJECTILE_DAMAGE = 18;
export const PVP_BASE_SHOT_COOLDOWN_MS = 360;
export const PVP_TARGET_TTK_SECONDS = 4.5;
export const PVP_MIN_HITS_TO_KO = 8;
export const PVP_BURST_WINDOW_MS = 300;
export const PVP_BURST_MAX_HEALTH_FRACTION = 0.25;
export const PVP_BALANCE_VERSION = 2;
export const PVP_MAX_PROFILE_LEVEL = 999;
export const PVP_MAX_EQUIPMENT_POWER = 10_000_000;
export const PVP_MAX_TOTAL_AUGMENT_STACKS = 1_000;

export type PvpBuildProfile = {
  level: number;
  equipmentPower: number;
  augmentStacks: number;
};

export const DEFAULT_PVP_BUILD_PROFILE: Readonly<PvpBuildProfile> = {
  level: 1,
  equipmentPower: 0,
  augmentStacks: 0,
};

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
  buildRating: number;
  offenseScale: number;
  projectileDamage: number;
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
  balanceVersion: number;
  vitalityMultiplier: number;
  targetTtkSeconds: number;
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
  | { type: "queue"; profile: PvpBuildProfile }
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

const clampNumber = (value: number, minimum: number, maximum: number): number =>
  Math.max(minimum, Math.min(maximum, value));

const roundTo = (value: number, places: number): number => {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
};

export function sanitizePvpBuildProfile(value: unknown): PvpBuildProfile {
  if (!isRecord(value)) return { ...DEFAULT_PVP_BUILD_PROFILE };
  const finiteOr = (candidate: unknown, fallback: number) =>
    isFiniteNumber(candidate) ? candidate : fallback;
  return {
    level: Math.floor(
      clampNumber(
        finiteOr(value.level, DEFAULT_PVP_BUILD_PROFILE.level),
        1,
        PVP_MAX_PROFILE_LEVEL,
      ),
    ),
    equipmentPower: Math.round(
      clampNumber(
        finiteOr(
          value.equipmentPower,
          DEFAULT_PVP_BUILD_PROFILE.equipmentPower,
        ),
        0,
        PVP_MAX_EQUIPMENT_POWER,
      ),
    ),
    augmentStacks: Math.floor(
      clampNumber(
        finiteOr(
          value.augmentStacks,
          DEFAULT_PVP_BUILD_PROFILE.augmentStacks,
        ),
        0,
        PVP_MAX_TOTAL_AUGMENT_STACKS,
      ),
    ),
  };
}

export function calculatePvpBuildRating(value: unknown): number {
  const profile = sanitizePvpBuildProfile(value);
  return Math.round(
    100 +
      (profile.level - 1) * 8 +
      Math.sqrt(profile.equipmentPower) * 10 +
      profile.augmentStacks * 6,
  );
}

export function calculatePvpOffenseScale(value: unknown): number {
  const rating = calculatePvpBuildRating(value);
  return roundTo(
    clampNumber(Math.pow(rating / 1_000, 0.28), 0.65, 3.25),
    4,
  );
}

export type PvpResolvedCombatantBalance = {
  buildRating: number;
  rawOffenseScale: number;
  offenseScale: number;
  projectileDamage: number;
};

export type PvpResolvedMatchBalance = {
  balanceVersion: number;
  maxHp: number;
  vitalityMultiplier: number;
  targetTtkSeconds: number;
  minimumHitsToKo: number;
  left: PvpResolvedCombatantBalance;
  right: PvpResolvedCombatantBalance;
};

/**
 * Both duelists receive the same match HP, sized from the stronger build. The
 * weaker build is pulled part-way toward the peak through a square-root curve:
 * build advantage remains visible without turning an uneven match into a
 * one-shot. The result is symmetric when player order is swapped.
 */
export function resolvePvpMatchBalance(
  leftProfile: unknown,
  rightProfile: unknown,
): PvpResolvedMatchBalance {
  const leftRaw = calculatePvpOffenseScale(leftProfile);
  const rightRaw = calculatePvpOffenseScale(rightProfile);
  const peak = Math.max(leftRaw, rightRaw);
  const peakDamage = roundTo(PVP_BASE_PROJECTILE_DAMAGE * peak, 2);
  const peakDps = peakDamage / (PVP_BASE_SHOT_COOLDOWN_MS / 1_000);
  const maxHp = Math.ceil(
    Math.max(
      peakDamage * PVP_MIN_HITS_TO_KO,
      peakDps * PVP_TARGET_TTK_SECONDS,
    ),
  );
  const resolveCombatant = (
    profile: unknown,
    rawOffenseScale: number,
  ): PvpResolvedCombatantBalance => {
    const offenseScale = roundTo(Math.sqrt(rawOffenseScale * peak), 4);
    return {
      buildRating: calculatePvpBuildRating(profile),
      rawOffenseScale,
      offenseScale,
      projectileDamage: roundTo(
        PVP_BASE_PROJECTILE_DAMAGE * offenseScale,
        2,
      ),
    };
  };
  return {
    balanceVersion: PVP_BALANCE_VERSION,
    maxHp,
    vitalityMultiplier: roundTo(maxHp / 100, 2),
    targetTtkSeconds: PVP_TARGET_TTK_SECONDS,
    minimumHitsToKo: PVP_MIN_HITS_TO_KO,
    left: resolveCombatant(leftProfile, leftRaw),
    right: resolveCombatant(rightProfile, rightRaw),
  };
}

export function capPvpHitDamage(damage: number, maxHp: number): number {
  if (!Number.isFinite(damage) || !Number.isFinite(maxHp) || maxHp <= 0) return 0;
  return Math.min(
    Math.max(0, damage),
    maxHp / PVP_MIN_HITS_TO_KO,
  );
}

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
  if (value.type === "queue") {
    return { type: "queue", profile: sanitizePvpBuildProfile(value.profile) };
  }
  if (value.type === "cancel_queue") {
    return { type: "cancel_queue" };
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
