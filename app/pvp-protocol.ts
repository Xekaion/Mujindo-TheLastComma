import {
  BASE_EQUIPMENT_COMBAT_POWER,
  EQUIPMENT_POWER_BASE_ATTACK_DAMAGE,
  EQUIPMENT_SLOTS,
  GEAR_ICON_ROWS,
  GEAR_RARITIES,
  LEGENDARY_POWERS,
  MAX_GEAR_ENHANCEMENT,
  type EquipmentSlot,
  type GearRarity,
} from "./equipment";

export const PVP_ARENA_WIDTH = 1280;
export const PVP_ARENA_HEIGHT = 720;
export const PVP_ROUND_DURATION_MS = 90_000;
export const PVP_COUNTDOWN_MS = 3_000;
export const PVP_SCORE_TO_WIN = 3;
export const PVP_INPUT_RATE_HZ = 30;
export const PVP_COMBAT_VERSION = 4;
export const PVP_TARGET_CLASS = "boss" as const;
export const PVP_COMBAT_MODEL = "equipment-power" as const;
export const PVP_BASE_MAX_HP = 100;
export const PVP_BOSS_HIT_RADIUS = 52;
export const PVP_DASH_DURATION_MS = 170;
export const PVP_PHANTOM_MARCH_ACTIVATION_MS =
  LEGENDARY_POWERS.phantomMarch.parameters.activationSeconds * 1_000;
export const PVP_PHANTOM_MARCH_MOVE_MULTIPLIER =
  1 + LEGENDARY_POWERS.phantomMarch.parameters.moveSpeedPercent / 100;
export const PVP_PHANTOM_MARCH_TIMER_CAP_MS =
  PVP_PHANTOM_MARCH_ACTIVATION_MS + 500;
export const PVP_PHANTOM_MARCH_MOVEMENT_EPSILON = 0.05;
export const PVP_MAX_EQUIPMENT_POWER = 1_000_000_000_000;

export const PVP_BASE_MOVE_SPEED = 245;
export const PVP_BASE_DASH_SPEED = 900;
export const PVP_BASE_DASH_COOLDOWN_MS = 1_350;
export const PVP_BASE_ATTACK_RATE = 1.4;
export const PVP_BASE_PROJECTILE_COUNT = 1;
export const PVP_BASE_PROJECTILE_SPEED = 660;
export const PVP_BASE_PROJECTILE_LIFE_MS = 1_150;
export const PVP_BASE_PROJECTILE_RADIUS = 5;
export const PVP_BASE_CRIT_CHANCE = 0.05;
export const PVP_BASE_CRIT_MULTIPLIER = 1.7;
export const PVP_BASE_HOMING_STRENGTH = 0;
export const PVP_BASE_PIERCE = 0;

export const PVP_PROFILE_LIMITS = Object.freeze({
  moveSpeed: { minimum: PVP_BASE_MOVE_SPEED, maximum: 100_000 },
  dashSpeed: { minimum: PVP_BASE_DASH_SPEED, maximum: 100_000 },
  dashCooldownMs: { minimum: 100, maximum: PVP_BASE_DASH_COOLDOWN_MS },
  attackRate: { minimum: PVP_BASE_ATTACK_RATE, maximum: 12 },
  projectileCount: { minimum: 1, maximum: 9 },
  projectileSpeed: { minimum: PVP_BASE_PROJECTILE_SPEED, maximum: 100_000 },
  projectileLifeMs: { minimum: PVP_BASE_PROJECTILE_LIFE_MS, maximum: 1_000_000 },
  projectileRadius: { minimum: PVP_BASE_PROJECTILE_RADIUS, maximum: 1_000 },
  critChance: { minimum: PVP_BASE_CRIT_CHANCE, maximum: 0.75 },
  critMultiplier: { minimum: PVP_BASE_CRIT_MULTIPLIER, maximum: 1_000 },
  homingStrength: { minimum: 0, maximum: 14 },
  pierce: { minimum: 0, maximum: 10_000 },
} as const);

const PVP_BASE_CRIT_EXPECTATION =
  1 + PVP_BASE_CRIT_CHANCE * (PVP_BASE_CRIT_MULTIPLIER - 1);

/** Equipment power is the standard-boss DPS benchmark expressed on a 1,000-point baseline. */
export const COMBAT_POWER_PER_BOSS_DPS =
  BASE_EQUIPMENT_COMBAT_POWER /
  (EQUIPMENT_POWER_BASE_ATTACK_DAMAGE *
    PVP_BASE_ATTACK_RATE *
    PVP_BASE_CRIT_EXPECTATION);

export type PvpBuildProfile = {
  equipmentPower: number;
  moveSpeed: number;
  dashSpeed: number;
  dashCooldownMs: number;
  attackRate: number;
  projectileCount: number;
  projectileSpeed: number;
  projectileLifeMs: number;
  projectileRadius: number;
  critChance: number;
  critMultiplier: number;
  homingStrength: number;
  pierce: number;
  continuousMoveMultiplier: number;
};

/**
 * Renderer-only equipment metadata. It deliberately excludes item identity,
 * affixes, combat values, trade state, save data, and client-provided URLs.
 */
export type PvpAppearancePiece = Readonly<{
  slot: EquipmentSlot;
  variant: number;
  rarity: GearRarity;
  enhancement: number;
}>;

export type PvpAppearance = Readonly<
  Partial<Record<EquipmentSlot, PvpAppearancePiece>>
>;

export const DEFAULT_PVP_APPEARANCE: Readonly<PvpAppearance> = Object.freeze({});

export const DEFAULT_PVP_BUILD_PROFILE: Readonly<PvpBuildProfile> = {
  equipmentPower: BASE_EQUIPMENT_COMBAT_POWER,
  moveSpeed: PVP_BASE_MOVE_SPEED,
  dashSpeed: PVP_BASE_DASH_SPEED,
  dashCooldownMs: PVP_BASE_DASH_COOLDOWN_MS,
  attackRate: PVP_BASE_ATTACK_RATE,
  projectileCount: PVP_BASE_PROJECTILE_COUNT,
  projectileSpeed: PVP_BASE_PROJECTILE_SPEED,
  projectileLifeMs: PVP_BASE_PROJECTILE_LIFE_MS,
  projectileRadius: PVP_BASE_PROJECTILE_RADIUS,
  critChance: PVP_BASE_CRIT_CHANCE,
  critMultiplier: PVP_BASE_CRIT_MULTIPLIER,
  homingStrength: PVP_BASE_HOMING_STRENGTH,
  pierce: PVP_BASE_PIERCE,
  continuousMoveMultiplier: 1,
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
  dashRemainingMs: number;
  invulnerableMs: number;
  respawnMs: number;
  connected: boolean;
  lastInputSequence: number;
  equipmentPower: number;
  attackRate: number;
  projectileCount: number;
  projectileSpeed: number;
  projectileLifeMs: number;
  projectileRadius: number;
  homingStrength: number;
  pierce: number;
  projectileDamage: number;
  phantomMarchMoveMs: number;
  continuousMoveMultiplier: number;
  appearance: PvpAppearance;
};

export type PvpProjectileSnapshot = {
  id: number;
  volleyId: number;
  ownerId: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
  previousX: number;
  previousY: number;
  ageMs: number;
  lifeMs: number;
  critical: boolean;
  affinity: "arcane";
};

export type PvpCombatEventKind = "shot" | "dash" | "hit" | "impact" | "defeat";

export type PvpCombatEvent = {
  id: number;
  kind: PvpCombatEventKind;
  actorId: string;
  targetId?: string;
  x: number;
  y: number;
  occurredAt: number;
  critical?: boolean;
  /** Absent only on events persisted before authoritative volley identity. */
  volleyId?: number;
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
  combatVersion: number;
  targetClass: typeof PVP_TARGET_CLASS;
  combatModel: typeof PVP_COMBAT_MODEL;
  players: PvpPlayerSnapshot[];
  projectiles: PvpProjectileSnapshot[];
  events: PvpCombatEvent[];
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
  | {
      type: "queue";
      profile: PvpBuildProfile;
      appearance: PvpAppearance;
    }
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

const PVP_GEAR_RARITY_SET = new Set<string>(GEAR_RARITIES);

/**
 * Copies only the four paperdoll fields from the ten canonical equipment
 * slots. Invalid pieces are omitted rather than repaired, so untrusted input
 * can never nominate an atlas URL or smuggle a GearItem across the wire.
 */
export function sanitizePvpAppearance(value: unknown): PvpAppearance {
  if (!isRecord(value)) return { ...DEFAULT_PVP_APPEARANCE };
  const appearance: Partial<Record<EquipmentSlot, PvpAppearancePiece>> = {};
  for (const slot of EQUIPMENT_SLOTS) {
    const piece = value[slot];
    if (
      !isRecord(piece) ||
      piece.slot !== slot ||
      !Number.isSafeInteger(piece.variant) ||
      (piece.variant as number) < 0 ||
      (piece.variant as number) >= GEAR_ICON_ROWS ||
      typeof piece.rarity !== "string" ||
      !PVP_GEAR_RARITY_SET.has(piece.rarity) ||
      !Number.isSafeInteger(piece.enhancement) ||
      (piece.enhancement as number) < 0 ||
      (piece.enhancement as number) > MAX_GEAR_ENHANCEMENT
    ) {
      continue;
    }
    appearance[slot] = {
      slot,
      variant: piece.variant as number,
      rarity: piece.rarity as GearRarity,
      enhancement: piece.enhancement as number,
    };
  }
  return appearance;
}

const clampNumber = (value: number, minimum: number, maximum: number): number =>
  Math.max(minimum, Math.min(maximum, value));

export function sanitizePvpBuildProfile(value: unknown): PvpBuildProfile {
  if (!isRecord(value)) return { ...DEFAULT_PVP_BUILD_PROFILE };
  const finiteOr = (candidate: unknown, fallback: number) =>
    isFiniteNumber(candidate) ? candidate : fallback;
  const bounded = <Key extends keyof typeof PVP_PROFILE_LIMITS>(
    key: Key,
    candidate: unknown,
    fallback: number,
  ) => {
    const limits = PVP_PROFILE_LIMITS[key];
    return clampNumber(finiteOr(candidate, fallback), limits.minimum, limits.maximum);
  };
  return {
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
    moveSpeed: bounded("moveSpeed", value.moveSpeed, DEFAULT_PVP_BUILD_PROFILE.moveSpeed),
    dashSpeed: bounded("dashSpeed", value.dashSpeed, DEFAULT_PVP_BUILD_PROFILE.dashSpeed),
    dashCooldownMs: Math.round(
      bounded(
        "dashCooldownMs",
        value.dashCooldownMs,
        DEFAULT_PVP_BUILD_PROFILE.dashCooldownMs,
      ),
    ),
    attackRate: bounded("attackRate", value.attackRate, DEFAULT_PVP_BUILD_PROFILE.attackRate),
    projectileCount: Math.floor(
      bounded(
        "projectileCount",
        value.projectileCount,
        DEFAULT_PVP_BUILD_PROFILE.projectileCount,
      ),
    ),
    projectileSpeed: bounded(
      "projectileSpeed",
      value.projectileSpeed,
      DEFAULT_PVP_BUILD_PROFILE.projectileSpeed,
    ),
    projectileLifeMs: Math.round(
      bounded(
        "projectileLifeMs",
        value.projectileLifeMs,
        DEFAULT_PVP_BUILD_PROFILE.projectileLifeMs,
      ),
    ),
    projectileRadius: bounded(
      "projectileRadius",
      value.projectileRadius,
      DEFAULT_PVP_BUILD_PROFILE.projectileRadius,
    ),
    critChance: bounded(
      "critChance",
      value.critChance,
      DEFAULT_PVP_BUILD_PROFILE.critChance,
    ),
    critMultiplier: bounded(
      "critMultiplier",
      value.critMultiplier,
      DEFAULT_PVP_BUILD_PROFILE.critMultiplier,
    ),
    homingStrength: bounded(
      "homingStrength",
      value.homingStrength,
      DEFAULT_PVP_BUILD_PROFILE.homingStrength,
    ),
    pierce: Math.floor(
      bounded("pierce", value.pierce, DEFAULT_PVP_BUILD_PROFILE.pierce),
    ),
    continuousMoveMultiplier:
      value.continuousMoveMultiplier === PVP_PHANTOM_MARCH_MOVE_MULTIPLIER
        ? PVP_PHANTOM_MARCH_MOVE_MULTIPLIER
        : DEFAULT_PVP_BUILD_PROFILE.continuousMoveMultiplier,
  };
}

export type PvpResolvedCombatProfile = PvpBuildProfile & {
  expectedBossDps: number;
  projectileDamage: number;
};

/**
 * Resolves one combatant independently. Equipment power already represents
 * sustained damage against a standard boss, so no opponent-derived multiplier
 * or second boss-damage pass belongs here.
 */
export function resolvePvpCombatProfile(value: unknown): PvpResolvedCombatProfile {
  const profile = sanitizePvpBuildProfile(value);
  const expectedBossDps = profile.equipmentPower / COMBAT_POWER_PER_BOSS_DPS;
  const criticalExpectation =
    1 + profile.critChance * (profile.critMultiplier - 1);
  const projectileDamage =
    expectedBossDps /
    (profile.attackRate * profile.projectileCount * criticalExpectation);
  return {
    ...profile,
    expectedBossDps,
    projectileDamage,
  };
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
    return {
      type: "queue",
      profile: sanitizePvpBuildProfile(value.profile),
      appearance: sanitizePvpAppearance(value.appearance),
    };
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
