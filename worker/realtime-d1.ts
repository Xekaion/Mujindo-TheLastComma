/// <reference types="@cloudflare/workers-types" />

import {
  DEFAULT_PVP_APPEARANCE,
  PVP_ARENA_HEIGHT,
  PVP_ARENA_WIDTH,
  PVP_BASE_MAX_HP,
  PVP_BOSS_HIT_RADIUS,
  PVP_COMBAT_MODEL,
  PVP_COMBAT_VERSION,
  PVP_COUNTDOWN_MS,
  PVP_DASH_DURATION_MS,
  PVP_PHANTOM_MARCH_ACTIVATION_MS,
  PVP_PHANTOM_MARCH_MOVEMENT_EPSILON,
  PVP_PHANTOM_MARCH_MOVE_MULTIPLIER,
  PVP_PHANTOM_MARCH_TIMER_CAP_MS,
  PVP_ROUND_DURATION_MS,
  PVP_SCORE_TO_WIN,
  PVP_TARGET_CLASS,
  parseRealtimeClientMessage,
  resolvePvpCombatProfile,
  sanitizePvpAppearance,
  sanitizePvpBuildProfile,
  type PvpAppearance,
  type PvpBuildProfile,
  type PvpCombatEvent,
  type PvpCombatEventKind,
  type PvpInput,
  type PvpPhase,
  type PvpPlayerSnapshot,
  type PvpProjectileSnapshot,
  type RealtimeClientMessage,
  type RealtimeServerMessage,
  type WorldLootAnnouncement,
} from "../app/pvp-protocol";
import {
  WALKABLE_FLOOR_POLYGON,
  constrainPointToConvexPolygon,
} from "../app/room-collision";
import {
  isCharacterNicknameSlot,
  validateCharacterNickname,
  type CharacterNicknameSlot,
} from "../app/character-nickname";

export type RealtimeD1Env = {
  DB?: D1Database;
};

type StoredSession = {
  token: string;
  playerId: string;
  accountId?: string;
  characterSlot?: CharacterNicknameSlot;
  displayName: string;
  createdAt: number;
  expiresAt: number;
  lastSeenAt: number;
  queued: boolean;
  matchId: string | null;
  lastLootAnnouncementAt: number;
  inputWindowStartedAt: number;
  inputCount: number;
  appearance?: PvpAppearance;
  combatProfile?: PvpBuildProfile;
};

type MatchPlayer = {
  id: string;
  name: string;
  sessionToken: string;
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
  shotCooldownMs: number;
  dashCooldownMs: number;
  dashRemainingMs: number;
  dashX: number;
  dashY: number;
  dashCooldownDurationMs: number;
  invulnerableMs: number;
  respawnMs: number;
  disconnectedAt: number | null;
  input: PvpInput;
  lastInputSequence: number;
  equipmentPower: number;
  moveSpeed: number;
  dashSpeed: number;
  attackRate: number;
  projectileCount: number;
  projectileSpeed: number;
  projectileLifeMs: number;
  projectileRadius: number;
  critChance: number;
  critMultiplier: number;
  homingStrength: number;
  pierce: number;
  projectileDamage: number;
  continuousMoveMultiplier: number;
  hasPhantomMarch: boolean;
  phantomMarchMoveMs: number;
  appearance?: PvpAppearance;
};

type MatchProjectile = PvpProjectileSnapshot & {
  damage: number;
  homingStrength: number;
  pierceRemaining: number;
  hitPlayerIds: string[];
};

type MatchCombatEvent = PvpCombatEvent;

type PvpMatch = {
  id: string;
  /** Missing means the persisted legacy arena, preserving in-flight matches. */
  arenaVersion?: number;
  tick: number;
  phase: PvpPhase;
  startsAt: number;
  endsAt: number;
  finishedAt: number | null;
  winnerId: string | null;
  resultReason: "score" | "timeout" | "disconnect" | "draw" | null;
  players: [MatchPlayer, MatchPlayer];
  projectiles: MatchProjectile[];
  nextProjectileId: number;
  nextVolleyId?: number;
  nextEventId?: number;
  events?: MatchCombatEvent[];
  lastSteppedAt: number;
  accumulatorMs: number;
  combatVersion?: number;
  targetClass?: typeof PVP_TARGET_CLASS;
  combatModel?: typeof PVP_COMBAT_MODEL;
};

type AcquisitionRecord = {
  id: string;
  createdAt: number;
};

type RealtimeWorldState = {
  format: 1;
  sessions: Record<string, StoredSession>;
  queue: string[];
  matches: Record<string, PvpMatch>;
  recentAnnouncements: WorldLootAnnouncement[];
  announcementSequence: number;
  acquisitionIds: AcquisitionRecord[];
};

type WorldRow = {
  version: number;
  state_json: string;
};

type SyncRequestBody = {
  messages: RealtimeClientMessage[];
  knownMatchId: string | null;
  lastAnnouncementSequence: number;
};

const WORLD_STATE_ID = 1;
const WORLD_STATE_FORMAT = 1;
const TICK_MS = 50;
const MAX_SIMULATION_DEBT_MS = 2_000;
const MAX_STEPS_PER_REQUEST = 20;
const RESPAWN_MS = 1_900;
const DISCONNECT_FORFEIT_MS = 10_000;
const ONLINE_WINDOW_MS = 6_000;
const QUEUE_STALE_MS = 10_000;
const MATCH_RETENTION_MS = 12_000;
const SESSION_TTL_MS = 12 * 60 * 60 * 1_000;
const MAX_INPUTS_PER_SECOND = 42;
const LOOT_ANNOUNCEMENT_COOLDOWN_MS = 3_000;
const ACQUISITION_RETENTION_MS = SESSION_TTL_MS;
const PVP_PLAYER_COLLISION_CLEARANCE = 27;
const MAX_REQUEST_BYTES = 32 * 1_024;
const MAX_SYNC_MESSAGES = 48;
const MAX_SESSIONS = 512;
const MAX_QUEUE_SIZE = 128;
const MAX_MATCHES = 64;
const MAX_PROJECTILES_PER_MATCH = 384;
const MAX_ACQUISITION_IDS = 256;
const MAX_RECENT_ANNOUNCEMENTS = 12;
const MAX_STATE_BYTES = 8_000_000;
const CAS_RETRIES = 8;
const PVP_ARENA_VERSION = 2;
const COMBAT_EVENT_RETENTION_MS = 1_000;
const LEGACY_ARENA_MARGIN_X = 88;
const LEGACY_ARENA_MARGIN_TOP = 112;
const LEGACY_ARENA_MARGIN_BOTTOM = 76;
const LEGACY_ARENA_OBSTACLES = [
  { x: 510, y: 360, radius: 66 },
  { x: 770, y: 360, radius: 66 },
] as const;

const clamp = (value: number, minimum: number, maximum: number) =>
  Math.max(minimum, Math.min(maximum, value));

const schemaReady = new WeakMap<object, Promise<void>>();

class RequestProblem extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
  }
}

class CasConflict extends Error {}

const idleInput = (): PvpInput => ({
  sequence: 0,
  moveX: 0,
  moveY: 0,
  aimX: 1,
  aimY: 0,
  fire: false,
  dash: false,
});

const createInitialState = (): RealtimeWorldState => ({
  format: WORLD_STATE_FORMAT,
  sessions: {},
  queue: [],
  matches: {},
  recentAnnouncements: [],
  announcementSequence: 0,
  acquisitionIds: [],
});

const json = (body: unknown, status = 200, extraHeaders?: HeadersInit): Response => {
  const headers = new Headers(extraHeaders);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  headers.set("x-content-type-options", "nosniff");
  return new Response(JSON.stringify(body), { status, headers });
};

const distanceSquared = (ax: number, ay: number, bx: number, by: number): number => {
  const dx = ax - bx;
  const dy = ay - by;
  return dx * dx + dy * dy;
};

const distanceToSegmentSquared = (
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number => {
  const abX = bx - ax;
  const abY = by - ay;
  const lengthSquared = abX * abX + abY * abY;
  if (lengthSquared <= 0.000_001) return distanceSquared(px, py, ax, ay);
  const projection = clamp(
    ((px - ax) * abX + (py - ay) * abY) / lengthSquared,
    0,
    1,
  );
  return distanceSquared(px, py, ax + abX * projection, ay + abY * projection);
};

function appendCombatEvent(
  match: PvpMatch,
  kind: PvpCombatEventKind,
  actorId: string,
  x: number,
  y: number,
  now: number,
  options: { targetId?: string; critical?: boolean; volleyId?: number } = {},
): void {
  const events = (match.events ??= []);
  const nextEventId = Number.isSafeInteger(match.nextEventId)
    ? Math.max(1, match.nextEventId as number)
    : events.reduce((highest, event) => Math.max(highest, event.id + 1), 1);
  events.push({
    id: nextEventId,
    kind,
    actorId,
    ...(options.targetId ? { targetId: options.targetId } : {}),
    x,
    y,
    occurredAt: now,
    ...(options.critical !== undefined ? { critical: options.critical } : {}),
    ...(Number.isSafeInteger(options.volleyId) && (options.volleyId as number) > 0
      ? { volleyId: options.volleyId }
      : {}),
  });
  match.nextEventId = nextEventId + 1;
  match.events = events.filter((event) => now - event.occurredAt <= COMBAT_EVENT_RETENTION_MS);
}

const encodedLength = (value: string): number => new TextEncoder().encode(value).byteLength;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasOwn = (value: object, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

function sameOriginOrAbsent(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  try {
    return new URL(origin).origin === new URL(request.url).origin;
  } catch {
    return false;
  }
}

function trustedAccountId(request: Request): string | null {
  const value = request.headers.get("x-mujindo-account-id");
  return value && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
    ? value.toLowerCase()
    : null;
}

function bearerToken(request: Request): string | null {
  const authorization = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+([a-f0-9]{64})$/i.exec(authorization);
  return match?.[1] ?? null;
}

async function readJson(request: Request, allowEmpty = false): Promise<unknown> {
  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BYTES) {
    throw new RequestProblem(413, "request_too_large", "Request body is too large.");
  }
  const raw = await request.text();
  if (encodedLength(raw) > MAX_REQUEST_BYTES) {
    throw new RequestProblem(413, "request_too_large", "Request body is too large.");
  }
  if (!raw.trim()) {
    if (allowEmpty) return {};
    throw new RequestProblem(400, "invalid_json", "A JSON request body is required.");
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new RequestProblem(400, "invalid_json", "The request body is not valid JSON.");
  }
}

function parseSyncBody(value: unknown): SyncRequestBody {
  if (!isRecord(value) || !Array.isArray(value.messages)) {
    throw new RequestProblem(400, "invalid_sync_body", "messages must be an array.");
  }
  if (value.messages.length > MAX_SYNC_MESSAGES) {
    throw new RequestProblem(413, "too_many_messages", "Too many realtime messages.");
  }
  if (
    value.knownMatchId !== undefined &&
    value.knownMatchId !== null &&
    (typeof value.knownMatchId !== "string" || value.knownMatchId.length > 64)
  ) {
    throw new RequestProblem(400, "invalid_match_id", "knownMatchId is invalid.");
  }
  if (
    value.lastAnnouncementSequence !== undefined &&
    (!Number.isSafeInteger(value.lastAnnouncementSequence) ||
      (value.lastAnnouncementSequence as number) < 0)
  ) {
    throw new RequestProblem(
      400,
      "invalid_announcement_sequence",
      "lastAnnouncementSequence is invalid.",
    );
  }

  const messages: RealtimeClientMessage[] = [];
  for (const rawMessage of value.messages) {
    const parsed = parseRealtimeClientMessage(rawMessage);
    if (parsed) messages.push(parsed);
  }
  return {
    messages,
    knownMatchId:
      typeof value.knownMatchId === "string" ? value.knownMatchId : null,
    lastAnnouncementSequence:
      typeof value.lastAnnouncementSequence === "number"
        ? value.lastAnnouncementSequence
        : 0,
  };
}

function isWorldState(value: unknown): value is RealtimeWorldState {
  if (!isRecord(value)) return false;
  return (
    value.format === WORLD_STATE_FORMAT &&
    isRecord(value.sessions) &&
    Array.isArray(value.queue) &&
    isRecord(value.matches) &&
    Array.isArray(value.recentAnnouncements) &&
    Number.isSafeInteger(value.announcementSequence) &&
    Array.isArray(value.acquisitionIds)
  );
}

function parseWorldState(serialized: string): RealtimeWorldState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized) as unknown;
  } catch {
    throw new RequestProblem(503, "state_corrupt", "Realtime state could not be decoded.");
  }
  if (!isWorldState(parsed)) {
    throw new RequestProblem(503, "state_corrupt", "Realtime state has an unknown format.");
  }
  return parsed;
}

async function ensureSchema(db: D1Database): Promise<void> {
  const existing = schemaReady.get(db as object);
  if (existing) return existing;

  const setup = db
    .batch([
      db.prepare(
        `CREATE TABLE IF NOT EXISTS realtime_world_state (
          id INTEGER PRIMARY KEY NOT NULL,
          version INTEGER NOT NULL DEFAULT 0,
          state_json TEXT NOT NULL,
          updated_at INTEGER NOT NULL,
          CHECK (id = 1)
        )`,
      ),
      db.prepare(
        `INSERT OR IGNORE INTO realtime_world_state
          (id, version, state_json, updated_at) VALUES (?, 0, ?, ?)`,
      ).bind(WORLD_STATE_ID, JSON.stringify(createInitialState()), Date.now()),
    ])
    .then(() => undefined)
    .catch((error: unknown) => {
      schemaReady.delete(db as object);
      throw error;
    });
  schemaReady.set(db as object, setup);
  return setup;
}

function resultChanges(result: D1Result): number {
  const meta = result.meta as D1Meta & { changes?: number };
  return typeof meta.changes === "number" ? meta.changes : 0;
}

function compactState(state: RealtimeWorldState, now: number): void {
  state.recentAnnouncements = state.recentAnnouncements.slice(
    -MAX_RECENT_ANNOUNCEMENTS,
  );
  state.acquisitionIds = state.acquisitionIds
    .filter((entry) => now - entry.createdAt <= ACQUISITION_RETENTION_MS)
    .slice(-MAX_ACQUISITION_IDS);
  state.queue = state.queue.slice(0, MAX_QUEUE_SIZE);
  for (const match of Object.values(state.matches)) {
    if (match.projectiles.length > MAX_PROJECTILES_PER_MATCH) {
      match.projectiles = match.projectiles
        .sort((left, right) => (left.ageMs ?? 0) - (right.ageMs ?? 0))
        .slice(0, MAX_PROJECTILES_PER_MATCH);
    }
    if (match.events) {
      match.events = match.events
        .filter((event) => now - event.occurredAt <= COMBAT_EVENT_RETENTION_MS);
    }
  }
}

function serializeWorldState(state: RealtimeWorldState, now: number): string {
  compactState(state, now);
  let serialized = JSON.stringify(state);
  if (encodedLength(serialized) <= MAX_STATE_BYTES) return serialized;

  state.acquisitionIds = state.acquisitionIds.slice(-64);
  for (const match of Object.values(state.matches)) {
    match.projectiles = match.projectiles.slice(-MAX_PROJECTILES_PER_MATCH);
  }
  serialized = JSON.stringify(state);
  const removableSessions = Object.values(state.sessions)
    .filter((session) => !session.queued && !session.matchId)
    .sort((left, right) => left.lastSeenAt - right.lastSeenAt);
  while (removableSessions.length > 0 && encodedLength(serialized) > MAX_STATE_BYTES) {
    const session = removableSessions.shift()!;
    delete state.sessions[session.token];
    serialized = JSON.stringify(state);
  }
  if (encodedLength(serialized) > MAX_STATE_BYTES) {
    throw new RequestProblem(
      503,
      "state_capacity",
      "Realtime state is temporarily at capacity.",
      true,
    );
  }
  return serialized;
}

async function casMutate<T>(
  db: D1Database,
  mutate: (state: RealtimeWorldState, now: number) => T,
): Promise<T> {
  for (let attempt = 0; attempt < CAS_RETRIES; attempt += 1) {
    const row = await db
      .prepare(
        "SELECT version, state_json FROM realtime_world_state WHERE id = ? LIMIT 1",
      )
      .bind(WORLD_STATE_ID)
      .first<WorldRow>();
    if (!row || !Number.isSafeInteger(row.version) || typeof row.state_json !== "string") {
      throw new RequestProblem(503, "state_unavailable", "Realtime state is unavailable.", true);
    }
    const state = parseWorldState(row.state_json);
    const now = Date.now();
    const value = mutate(state, now);
    const serialized = serializeWorldState(state, now);
    const update = await db
      .prepare(
        `UPDATE realtime_world_state
          SET version = ?, state_json = ?, updated_at = ?
          WHERE id = ? AND version = ?`,
      )
      .bind(row.version + 1, serialized, now, WORLD_STATE_ID, row.version)
      .run();
    if (resultChanges(update) === 1) return value;
  }
  throw new CasConflict();
}

async function readWorldState(db: D1Database): Promise<RealtimeWorldState> {
  const row = await db
    .prepare(
      "SELECT version, state_json FROM realtime_world_state WHERE id = ? LIMIT 1",
    )
    .bind(WORLD_STATE_ID)
    .first<WorldRow>();
  if (!row || !Number.isSafeInteger(row.version) || typeof row.state_json !== "string") {
    throw new RequestProblem(
      503,
      "state_unavailable",
      "Realtime state is unavailable.",
      true,
    );
  }
  return parseWorldState(row.state_json);
}

function sessionIsOnline(session: StoredSession, now: number): boolean {
  return session.expiresAt > now && now - session.lastSeenAt <= ONLINE_WINDOW_MS;
}

function onlineCount(state: RealtimeWorldState, now: number): number {
  return Object.values(state.sessions).filter((session) => sessionIsOnline(session, now)).length;
}

function activeMatchCount(state: RealtimeWorldState): number {
  return Object.values(state.matches).filter((match) => match.phase !== "finished").length;
}

function legacyArenaCollision(player: MatchPlayer): void {
  player.x = clamp(
    player.x,
    LEGACY_ARENA_MARGIN_X,
    PVP_ARENA_WIDTH - LEGACY_ARENA_MARGIN_X,
  );
  player.y = clamp(
    player.y,
    LEGACY_ARENA_MARGIN_TOP,
    PVP_ARENA_HEIGHT - LEGACY_ARENA_MARGIN_BOTTOM,
  );
  for (const obstacle of LEGACY_ARENA_OBSTACLES) {
    const dx = player.x - obstacle.x;
    const dy = player.y - obstacle.y;
    const distance = Math.hypot(dx, dy);
    const minimumDistance = obstacle.radius + PVP_PLAYER_COLLISION_CLEARANCE;
    if (distance >= minimumDistance) continue;
    const safeDistance = distance || 1;
    player.x = obstacle.x + (dx / safeDistance) * minimumDistance;
    player.y = obstacle.y + (dy / safeDistance) * minimumDistance;
  }
}

function resolveArenaCollision(player: MatchPlayer, arenaVersion: number): void {
  if (arenaVersion < PVP_ARENA_VERSION) {
    legacyArenaCollision(player);
    return;
  }
  constrainPointToConvexPolygon(
    player,
    WALKABLE_FLOOR_POLYGON,
    PVP_PLAYER_COLLISION_CLEARANCE,
  );
}

function reconcilePhantomMarchRuntime(
  player: MatchPlayer,
  profile: ReturnType<typeof resolvePvpCombatProfile>,
  preserveTimer: boolean,
): void {
  player.continuousMoveMultiplier = profile.continuousMoveMultiplier;
  player.hasPhantomMarch = profile.continuousMoveMultiplier > 1;
  player.phantomMarchMoveMs =
    preserveTimer &&
    player.hasPhantomMarch &&
    Number.isFinite(player.phantomMarchMoveMs)
      ? clamp(player.phantomMarchMoveMs, 0, PVP_PHANTOM_MARCH_TIMER_CAP_MS)
      : 0;
}

function reconcileVolleyIdentity(match: PvpMatch): void {
  let nextVolleyId =
    Number.isSafeInteger(match.nextVolleyId) && (match.nextVolleyId as number) > 0
      ? (match.nextVolleyId as number)
      : 1;
  for (const event of match.events ?? []) {
    if (Number.isSafeInteger(event.volleyId) && (event.volleyId as number) > 0) {
      nextVolleyId = Math.max(nextVolleyId, (event.volleyId as number) + 1);
    }
  }
  for (const projectile of match.projectiles) {
    if (Number.isSafeInteger(projectile.volleyId) && projectile.volleyId > 0) {
      nextVolleyId = Math.max(nextVolleyId, projectile.volleyId + 1);
    }
  }

  const legacyVolleyIds = new Map<string, number>();
  for (const projectile of match.projectiles) {
    if (Number.isSafeInteger(projectile.volleyId) && projectile.volleyId > 0) {
      continue;
    }
    const hasStableTiming =
      Number.isFinite(projectile.ageMs) && Number.isFinite(projectile.lifeMs);
    const legacyGroup = hasStableTiming
      ? `${projectile.ownerId}:${projectile.ageMs}:${projectile.lifeMs}:${projectile.critical ? 1 : 0}`
      : `${projectile.ownerId}:projectile:${projectile.id}`;
    let volleyId = legacyVolleyIds.get(legacyGroup);
    if (!volleyId) {
      volleyId = nextVolleyId;
      nextVolleyId += 1;
      legacyVolleyIds.set(legacyGroup, volleyId);
    }
    projectile.volleyId = volleyId;
  }
  match.nextVolleyId = nextVolleyId;
}

function migrateMatchToEquipmentPower(
  state: RealtimeWorldState,
  match: PvpMatch,
  now: number,
): void {
  if (
    match.combatVersion === PVP_COMBAT_VERSION &&
    match.combatModel === PVP_COMBAT_MODEL &&
    match.targetClass === PVP_TARGET_CLASS
  ) {
    for (const player of match.players) {
      const session = state.sessions[player.sessionToken];
      reconcilePhantomMarchRuntime(
        player,
        resolvePvpCombatProfile(session?.combatProfile),
        true,
      );
    }
    reconcileVolleyIdentity(match);
    match.events = (match.events ?? []).filter(
      (event) => now - event.occurredAt <= COMBAT_EVENT_RETENTION_MS,
    );
    const nextEventId = match.events.reduce(
      (highest, event) =>
        Number.isSafeInteger(event.id) ? Math.max(highest, event.id + 1) : highest,
      1,
    );
    if (
      !Number.isSafeInteger(match.nextEventId) ||
      (match.nextEventId as number) < nextEventId
    ) {
      match.nextEventId = nextEventId;
    }
    return;
  }

  for (const player of match.players) {
    const session = state.sessions[player.sessionToken];
    const resolved = resolvePvpCombatProfile(session?.combatProfile);
    const previousMaxHp = Number.isFinite(player.maxHp) && player.maxHp > 0
      ? player.maxHp
      : PVP_BASE_MAX_HP;
    const healthRatio = clamp(
      (Number.isFinite(player.hp) ? player.hp : previousMaxHp) / previousMaxHp,
      0,
      1,
    );
    player.hp = healthRatio * PVP_BASE_MAX_HP;
    player.maxHp = PVP_BASE_MAX_HP;
    player.dashX = Number.isFinite(player.dashX) ? player.dashX : player.aimX;
    player.dashY = Number.isFinite(player.dashY) ? player.dashY : player.aimY;
    player.dashCooldownDurationMs = resolved.dashCooldownMs;
    player.equipmentPower = resolved.equipmentPower;
    player.moveSpeed = resolved.moveSpeed;
    player.dashSpeed = resolved.dashSpeed;
    player.attackRate = resolved.attackRate;
    player.projectileCount = resolved.projectileCount;
    player.projectileSpeed = resolved.projectileSpeed;
    player.projectileLifeMs = resolved.projectileLifeMs;
    player.projectileRadius = resolved.projectileRadius;
    player.critChance = resolved.critChance;
    player.critMultiplier = resolved.critMultiplier;
    player.homingStrength = resolved.homingStrength;
    player.pierce = resolved.pierce;
    player.projectileDamage = resolved.projectileDamage;
    reconcilePhantomMarchRuntime(player, resolved, false);
  }
  // Legacy projectiles contain damage resolved by the removed adaptive model.
  // Retaining them would apply that old value directly after the no-cap switch.
  match.projectiles = [];
  match.nextVolleyId = 1;
  match.events = [];
  match.nextEventId = 1;
  match.combatVersion = PVP_COMBAT_VERSION;
  match.combatModel = PVP_COMBAT_MODEL;
  match.targetClass = PVP_TARGET_CLASS;
}

function legacyProjectileHitsObstacle(projectile: MatchProjectile): boolean {
  return LEGACY_ARENA_OBSTACLES.some(
    (obstacle) =>
      distanceSquared(projectile.x, projectile.y, obstacle.x, obstacle.y) <=
      (obstacle.radius + projectile.radius) ** 2,
  );
}

function finishMatch(
  match: PvpMatch,
  winnerId: string | null,
  reason: "score" | "timeout" | "disconnect" | "draw",
  now: number,
): void {
  if (match.phase === "finished") return;
  match.phase = "finished";
  match.finishedAt = now;
  match.winnerId = winnerId;
  match.resultReason = reason;
  match.projectiles = [];
}

function respawnPlayer(player: MatchPlayer): void {
  player.x = player.side === 0 ? 250 : PVP_ARENA_WIDTH - 250;
  player.y = PVP_ARENA_HEIGHT / 2;
  player.hp = player.maxHp;
  player.invulnerableMs = 900;
  player.shotCooldownMs = 450;
  player.dashRemainingMs = 0;
  player.phantomMarchMoveMs = 0;
}

function stepSimulation(match: PvpMatch, stepNow: number): void {
  if (match.phase !== "playing") return;
  match.tick += 1;
  const deltaSeconds = TICK_MS / 1_000;
  const arenaVersion = match.arenaVersion ?? 1;
  match.events = (match.events ?? []).filter(
    (event) => stepNow - event.occurredAt <= COMBAT_EVENT_RETENTION_MS,
  );

  for (const player of match.players) {
    const liveOpponent = match.players.find(
      (candidate) =>
        candidate.id !== player.id && candidate.respawnMs <= 0,
    );
    if (player.input.fire && player.respawnMs <= 0 && liveOpponent) {
      // Preserve fractional cooldown debt while continuously firing so rates
      // such as 12/s remain accurate on the fixed 20 Hz simulation tick.
      player.shotCooldownMs -= TICK_MS;
    } else {
      // Idle or targetless time is not a bank of future attacks. Stop at ready
      // (zero) so an opponent respawn cannot produce a catch-up burst.
      player.shotCooldownMs = Math.max(0, player.shotCooldownMs - TICK_MS);
    }
    player.dashCooldownMs = Math.max(0, player.dashCooldownMs - TICK_MS);
    player.invulnerableMs = Math.max(0, player.invulnerableMs - TICK_MS);
    if (player.respawnMs > 0) {
      player.phantomMarchMoveMs = 0;
      player.respawnMs = Math.max(0, player.respawnMs - TICK_MS);
      if (player.respawnMs === 0) respawnPlayer(player);
      continue;
    }
    if (player.input.dash && player.dashCooldownMs <= 0) {
      const moveLength = Math.hypot(player.input.moveX, player.input.moveY);
      const aimLength = Math.hypot(player.aimX, player.aimY);
      player.dashX = moveLength > 0.001
        ? player.input.moveX / moveLength
        : aimLength > 0.001
          ? player.aimX / aimLength
          : player.side === 0
            ? 1
            : -1;
      player.dashY = moveLength > 0.001
        ? player.input.moveY / moveLength
        : aimLength > 0.001
          ? player.aimY / aimLength
          : 0;
      player.dashRemainingMs = PVP_DASH_DURATION_MS;
      player.dashCooldownMs = player.dashCooldownDurationMs;
      player.invulnerableMs = PVP_DASH_DURATION_MS + 30;
      appendCombatEvent(match, "dash", player.id, player.x, player.y, stepNow);
    }
    player.input = { ...player.input, dash: false };
    const dashStepMs = Math.min(TICK_MS, player.dashRemainingMs);
    const normalStepMs = TICK_MS - dashStepMs;
    const phantomMarchActive =
      player.hasPhantomMarch &&
      player.phantomMarchMoveMs >= PVP_PHANTOM_MARCH_ACTIVATION_MS;
    const normalMoveSpeed =
      player.moveSpeed *
      (phantomMarchActive ? player.continuousMoveMultiplier : 1);
    const previousPlayerX = player.x;
    const previousPlayerY = player.y;
    player.x +=
      player.dashX * player.dashSpeed * (dashStepMs / 1_000) +
      player.input.moveX * normalMoveSpeed * (normalStepMs / 1_000);
    player.y +=
      player.dashY * player.dashSpeed * (dashStepMs / 1_000) +
      player.input.moveY * normalMoveSpeed * (normalStepMs / 1_000);
    player.dashRemainingMs = Math.max(0, player.dashRemainingMs - TICK_MS);
    if (player.dashRemainingMs > 0) {
      player.vx = player.dashX * player.dashSpeed;
      player.vy = player.dashY * player.dashSpeed;
    } else {
      player.vx = player.input.moveX * normalMoveSpeed;
      player.vy = player.input.moveY * normalMoveSpeed;
    }
    resolveArenaCollision(player, arenaVersion);
    const actuallyMoved =
      Math.hypot(
        player.x - previousPlayerX,
        player.y - previousPlayerY,
      ) > PVP_PHANTOM_MARCH_MOVEMENT_EPSILON;
    player.phantomMarchMoveMs =
      player.hasPhantomMarch && actuallyMoved
        ? Math.min(
            PVP_PHANTOM_MARCH_TIMER_CAP_MS,
            player.phantomMarchMoveMs + TICK_MS,
          )
        : 0;

    if (
      player.input.fire &&
      liveOpponent &&
      player.shotCooldownMs <= 0
    ) {
      const projectileCount = player.projectileCount;
      while (
        match.projectiles.length + projectileCount >
        MAX_PROJECTILES_PER_MATCH
      ) {
        let oldestIndex = 0;
        for (let index = 1; index < match.projectiles.length; index += 1) {
          if (
            match.projectiles[index].ageMs >
            match.projectiles[oldestIndex].ageMs
          ) {
            oldestIndex = index;
          }
        }
        // Capacity retirement is not a physical collision. Removing it
        // silently preserves the new volley without fabricating up to hundreds
        // of impact VFX/SFX events per second on long-lived projectile builds.
        if (match.projectiles.splice(oldestIndex, 1).length === 0) break;
      }
      const critical = Math.random() < player.critChance;
      const volleyDamage = Math.max(
        0,
        player.projectileDamage * (critical ? player.critMultiplier : 1),
      );
      const baseAngle = Math.atan2(
        liveOpponent.y - player.y,
        liveOpponent.x - player.x,
      );
      const spread = Math.min(0.62, projectileCount * 0.07);
      const volleyId =
        Number.isSafeInteger(match.nextVolleyId) &&
        (match.nextVolleyId as number) > 0
          ? (match.nextVolleyId as number)
          : 1;
      match.nextVolleyId = volleyId + 1;
      appendCombatEvent(
        match,
        "shot",
        player.id,
        player.x,
        player.y,
        stepNow,
        { critical, volleyId },
      );
      for (let index = 0; index < projectileCount; index += 1) {
        const angle =
          baseAngle +
          (projectileCount === 1
            ? 0
            : -spread / 2 + (spread * index) / (projectileCount - 1));
        const startX = player.x;
        const startY = player.y - 8;
        match.projectiles.push({
          id: match.nextProjectileId,
          volleyId,
          ownerId: player.id,
          x: startX,
          y: startY,
          previousX: startX,
          previousY: startY,
          vx: Math.cos(angle) * player.projectileSpeed,
          vy: Math.sin(angle) * player.projectileSpeed,
          radius: player.projectileRadius,
          ageMs: 0,
          lifeMs: player.projectileLifeMs,
          critical,
          affinity: "arcane",
          damage: volleyDamage,
          homingStrength: player.homingStrength,
          pierceRemaining: player.pierce,
          hitPlayerIds: [],
        });
        match.nextProjectileId += 1;
      }
      player.shotCooldownMs += 1_000 / player.attackRate;
    }
  }

  const liveProjectiles: MatchProjectile[] = [];
  for (const projectile of match.projectiles) {
    const target = match.players.find(
      (candidate) =>
        candidate.id !== projectile.ownerId && candidate.respawnMs <= 0,
    );
    if (target && projectile.homingStrength > 0) {
      const projectileSpeed = Math.hypot(projectile.vx, projectile.vy);
      if (projectileSpeed > 0.001) {
        const currentAngle = Math.atan2(projectile.vy, projectile.vx);
        const targetAngle = Math.atan2(
          target.y - projectile.y,
          target.x - projectile.x,
        );
        const angleDelta = Math.atan2(
          Math.sin(targetAngle - currentAngle),
          Math.cos(targetAngle - currentAngle),
        );
        const steeredAngle =
          currentAngle +
          clamp(
            angleDelta,
            -projectile.homingStrength * deltaSeconds,
            projectile.homingStrength * deltaSeconds,
          );
        projectile.vx = Math.cos(steeredAngle) * projectileSpeed;
        projectile.vy = Math.sin(steeredAngle) * projectileSpeed;
      }
    }
    projectile.previousX = projectile.x;
    projectile.previousY = projectile.y;
    projectile.ageMs += TICK_MS;
    projectile.lifeMs -= TICK_MS;
    projectile.x += projectile.vx * deltaSeconds;
    projectile.y += projectile.vy * deltaSeconds;
    const leftArena =
      projectile.lifeMs <= 0 ||
      projectile.x < 0 ||
      projectile.x > PVP_ARENA_WIDTH ||
      projectile.y < 0 ||
      projectile.y > PVP_ARENA_HEIGHT ||
      (arenaVersion < PVP_ARENA_VERSION &&
        legacyProjectileHitsObstacle(projectile));
    const collisionRadius = projectile.radius + PVP_BOSS_HIT_RADIUS;
    if (
      target &&
      target.invulnerableMs <= 0 &&
      !projectile.hitPlayerIds.includes(target.id) &&
      distanceToSegmentSquared(
        target.x,
        target.y,
        projectile.previousX,
        projectile.previousY,
        projectile.x,
        projectile.y,
      ) <= collisionRadius ** 2
    ) {
      const appliedDamage = Number.isFinite(projectile.damage)
        ? Math.max(0, projectile.damage)
        : 0;
      target.hp = Math.max(0, target.hp - appliedDamage);
      projectile.hitPlayerIds.push(target.id);
      appendCombatEvent(
        match,
        "hit",
        projectile.ownerId,
        projectile.x,
        projectile.y,
        stepNow,
        {
          targetId: target.id,
          critical: projectile.critical,
          volleyId: projectile.volleyId,
        },
      );
      if (target.hp <= 0) {
        const owner = match.players.find(
          (candidate) => candidate.id === projectile.ownerId,
        );
        appendCombatEvent(
          match,
          "defeat",
          projectile.ownerId,
          target.x,
          target.y,
          stepNow,
          {
            targetId: target.id,
            critical: projectile.critical,
            volleyId: projectile.volleyId,
          },
        );
        if (owner) {
          owner.score += 1;
          if (owner.score >= PVP_SCORE_TO_WIN) {
            finishMatch(match, owner.id, "score", stepNow);
            return;
          }
        }
        target.respawnMs = RESPAWN_MS;
        target.phantomMarchMoveMs = 0;
        target.vx = 0;
        target.vy = 0;
      }
      if (projectile.pierceRemaining > 0 && !leftArena) {
        projectile.pierceRemaining -= 1;
        liveProjectiles.push(projectile);
      }
      continue;
    }
    if (leftArena) {
      appendCombatEvent(
        match,
        "impact",
        projectile.ownerId,
        clamp(projectile.x, 0, PVP_ARENA_WIDTH),
        clamp(projectile.y, 0, PVP_ARENA_HEIGHT),
        stepNow,
        { critical: projectile.critical, volleyId: projectile.volleyId },
      );
      continue;
    }
    liveProjectiles.push(projectile);
  }
  match.projectiles = liveProjectiles;
}

function advanceMatch(
  state: RealtimeWorldState,
  match: PvpMatch,
  now: number,
): void {
  migrateMatchToEquipmentPower(state, match, now);
  if (match.phase === "finished") return;
  if (match.phase === "countdown") {
    if (now < match.startsAt) {
      match.lastSteppedAt = now;
      match.accumulatorMs = 0;
      return;
    }
    match.phase = "playing";
    match.lastSteppedAt = Math.max(match.lastSteppedAt, match.startsAt);
  }

  for (const player of match.players) {
    const session = state.sessions[player.sessionToken];
    if (session && sessionIsOnline(session, now)) {
      player.disconnectedAt = null;
      continue;
    }
    const disconnectedSince = session?.lastSeenAt ?? player.disconnectedAt ?? now;
    player.disconnectedAt ??= disconnectedSince;
    if (now - disconnectedSince >= DISCONNECT_FORFEIT_MS) {
      const opponent = match.players.find((candidate) => candidate.id !== player.id)!;
      finishMatch(match, opponent.id, "disconnect", now);
      return;
    }
  }

  if (now >= match.endsAt) {
    const [left, right] = match.players;
    if (left.score === right.score) finishMatch(match, null, "draw", now);
    else finishMatch(match, left.score > right.score ? left.id : right.id, "timeout", now);
    return;
  }

  const elapsed = Math.max(0, now - match.lastSteppedAt);
  match.lastSteppedAt = now;
  match.accumulatorMs = Math.min(
    MAX_SIMULATION_DEBT_MS,
    Math.max(0, match.accumulatorMs) + elapsed,
  );
  let simulatedAt = now - match.accumulatorMs;
  let steps = 0;
  while (
    match.accumulatorMs >= TICK_MS &&
    match.phase === "playing" &&
    steps < MAX_STEPS_PER_REQUEST
  ) {
    simulatedAt += TICK_MS;
    stepSimulation(match, simulatedAt);
    match.accumulatorMs -= TICK_MS;
    steps += 1;
  }
}

function pruneWorld(state: RealtimeWorldState, now: number): void {
  for (const match of Object.values(state.matches)) {
    if (match.phase === "finished") continue;
    if (now >= match.endsAt) {
      const [left, right] = match.players;
      if (left.score === right.score) finishMatch(match, null, "draw", now);
      else finishMatch(match, left.score > right.score ? left.id : right.id, "timeout", now);
      continue;
    }
    const stale = match.players.filter((player) => {
      const session = state.sessions[player.sessionToken];
      return !session || now - session.lastSeenAt >= DISCONNECT_FORFEIT_MS;
    });
    if (stale.length === 2) {
      finishMatch(match, null, "draw", now);
    } else if (stale.length === 1) {
      const winner = match.players.find((player) => player.id !== stale[0].id)!;
      finishMatch(match, winner.id, "disconnect", now);
    }
  }

  for (const [matchId, match] of Object.entries(state.matches)) {
    if (!match.finishedAt || now - match.finishedAt < MATCH_RETENTION_MS) continue;
    for (const participant of match.players) {
      const session = state.sessions[participant.sessionToken];
      if (session?.matchId === matchId) session.matchId = null;
    }
    delete state.matches[matchId];
  }

  for (const [token, session] of Object.entries(state.sessions)) {
    if (session.expiresAt > now) continue;
    session.queued = false;
    session.appearance = { ...DEFAULT_PVP_APPEARANCE };
    if (!session.matchId || !hasOwn(state.matches, session.matchId)) {
      delete state.sessions[token];
    }
  }

  const seen = new Set<string>();
  const cleanedQueue: string[] = [];
  for (const token of state.queue) {
    if (seen.has(token)) continue;
    seen.add(token);
    const session = state.sessions[token];
    if (
      !session ||
      !session.queued ||
      session.matchId ||
      now - session.lastSeenAt > QUEUE_STALE_MS
    ) {
      if (session) {
        session.queued = false;
        session.appearance = { ...DEFAULT_PVP_APPEARANCE };
      }
      continue;
    }
    cleanedQueue.push(token);
    if (cleanedQueue.length >= MAX_QUEUE_SIZE) break;
  }
  state.queue = cleanedQueue;

  state.acquisitionIds = state.acquisitionIds.filter(
    (entry) => now - entry.createdAt <= ACQUISITION_RETENTION_MS,
  );

  const sessions = Object.values(state.sessions);
  if (sessions.length >= MAX_SESSIONS) {
    const removable = sessions
      .filter(
        (session) =>
          !session.queued && !session.matchId && !sessionIsOnline(session, now),
      )
      .sort((left, right) => left.lastSeenAt - right.lastSeenAt);
    while (Object.keys(state.sessions).length >= MAX_SESSIONS && removable.length > 0) {
      delete state.sessions[removable.shift()!.token];
    }
  }
  compactState(state, now);
}

function makeMatchPlayer(
  session: StoredSession,
  side: 0 | 1,
  profile: ReturnType<typeof resolvePvpCombatProfile>,
): MatchPlayer {
  return {
    id: session.playerId,
    name: session.displayName,
    sessionToken: session.token,
    side,
    x: side === 0 ? 250 : PVP_ARENA_WIDTH - 250,
    y: PVP_ARENA_HEIGHT / 2,
    vx: 0,
    vy: 0,
    aimX: side === 0 ? 1 : -1,
    aimY: 0,
    hp: PVP_BASE_MAX_HP,
    maxHp: PVP_BASE_MAX_HP,
    score: 0,
    shotCooldownMs: 0,
    dashCooldownMs: 0,
    dashRemainingMs: 0,
    dashX: side === 0 ? 1 : -1,
    dashY: 0,
    dashCooldownDurationMs: profile.dashCooldownMs,
    invulnerableMs: 850,
    respawnMs: 0,
    disconnectedAt: null,
    input: idleInput(),
    lastInputSequence: 0,
    equipmentPower: profile.equipmentPower,
    moveSpeed: profile.moveSpeed,
    dashSpeed: profile.dashSpeed,
    attackRate: profile.attackRate,
    projectileCount: profile.projectileCount,
    projectileSpeed: profile.projectileSpeed,
    projectileLifeMs: profile.projectileLifeMs,
    projectileRadius: profile.projectileRadius,
    critChance: profile.critChance,
    critMultiplier: profile.critMultiplier,
    homingStrength: profile.homingStrength,
    pierce: profile.pierce,
    projectileDamage: profile.projectileDamage,
    continuousMoveMultiplier: profile.continuousMoveMultiplier,
    hasPhantomMarch: profile.continuousMoveMultiplier > 1,
    phantomMarchMoveMs: 0,
    appearance: sanitizePvpAppearance(session.appearance),
  };
}

function makeMatches(state: RealtimeWorldState, now: number): void {
  while (
    state.queue.length >= 2 &&
    activeMatchCount(state) < MAX_MATCHES
  ) {
    const leftToken = state.queue.shift()!;
    const rightToken = state.queue.shift()!;
    const left = state.sessions[leftToken];
    const right = state.sessions[rightToken];
    if (!left || !right || !left.queued || !right.queued) continue;

    left.queued = false;
    right.queued = false;
    const leftProfile = resolvePvpCombatProfile(left.combatProfile);
    const rightProfile = resolvePvpCombatProfile(right.combatProfile);
    const matchId = crypto.randomUUID();
    const match: PvpMatch = {
      id: matchId,
      arenaVersion: PVP_ARENA_VERSION,
      tick: 0,
      phase: "countdown",
      startsAt: now + PVP_COUNTDOWN_MS,
      endsAt: now + PVP_COUNTDOWN_MS + PVP_ROUND_DURATION_MS,
      finishedAt: null,
      winnerId: null,
      resultReason: null,
      players: [
        makeMatchPlayer(left, 0, leftProfile),
        makeMatchPlayer(right, 1, rightProfile),
      ],
      projectiles: [],
      nextProjectileId: 1,
      nextVolleyId: 1,
      nextEventId: 1,
      events: [],
      lastSteppedAt: now,
      accumulatorMs: 0,
      combatVersion: PVP_COMBAT_VERSION,
      targetClass: PVP_TARGET_CLASS,
      combatModel: PVP_COMBAT_MODEL,
    };
    state.matches[match.id] = match;
    left.matchId = match.id;
    right.matchId = match.id;
    // The match owns its immutable cosmetic copies; queued session state does
    // not need to retain ten verbose slot records for the next twelve hours.
    left.appearance = { ...DEFAULT_PVP_APPEARANCE };
    right.appearance = { ...DEFAULT_PVP_APPEARANCE };
  }
}

function joinQueue(
  state: RealtimeWorldState,
  session: StoredSession,
  profile: PvpBuildProfile,
  appearance: PvpAppearance,
  directMessages: RealtimeServerMessage[],
): void {
  if (session.matchId) {
    const match = state.matches[session.matchId];
    if (!match || match.phase === "finished") session.matchId = null;
  }
  if (session.matchId) {
    directMessages.push({
      type: "error",
      code: "match_in_progress",
      message: "A duel is already in progress.",
    });
    return;
  }
  if (!session.queued) {
    if (state.queue.length >= MAX_QUEUE_SIZE) {
      directMessages.push({
        type: "error",
        code: "queue_full",
        message: "The duel queue is currently full.",
      });
      return;
    }
    session.combatProfile = sanitizePvpBuildProfile(profile);
    session.appearance = sanitizePvpAppearance(appearance);
    session.queued = true;
    state.queue.push(session.token);
  }
}

function leaveQueue(state: RealtimeWorldState, session: StoredSession): void {
  session.queued = false;
  session.appearance = { ...DEFAULT_PVP_APPEARANCE };
  state.queue = state.queue.filter((token) => token !== session.token);
}

function receiveInput(
  state: RealtimeWorldState,
  session: StoredSession,
  input: PvpInput,
  now: number,
): void {
  if (!session.matchId) return;
  if (now - session.inputWindowStartedAt >= 1_000) {
    session.inputWindowStartedAt = now;
    session.inputCount = 0;
  }
  session.inputCount += 1;
  if (session.inputCount > MAX_INPUTS_PER_SECOND) return;

  const match = state.matches[session.matchId];
  const player = match?.players.find((candidate) => candidate.id === session.playerId);
  if (!player || match.phase === "finished" || input.sequence <= player.lastInputSequence) {
    return;
  }
  player.lastInputSequence = input.sequence;
  // A short dash press must survive batching until the next authoritative step.
  player.input = { ...input, dash: player.input.dash || input.dash };
  player.aimX = input.aimX;
  player.aimY = input.aimY;
}

function publishLoot(
  state: RealtimeWorldState,
  session: StoredSession,
  message: Extract<RealtimeClientMessage, { type: "announce_loot" }>,
  now: number,
): void {
  if (now - session.lastLootAnnouncementAt < LOOT_ANNOUNCEMENT_COOLDOWN_MS) return;
  if (state.acquisitionIds.some((entry) => entry.id === message.acquisitionId)) return;

  session.lastLootAnnouncementAt = now;
  state.acquisitionIds.push({ id: message.acquisitionId, createdAt: now });
  state.announcementSequence += 1;
  state.recentAnnouncements.push({
    id: crypto.randomUUID(),
    sequence: state.announcementSequence,
    playerName: session.displayName,
    itemName: message.itemName,
    rarity: message.rarity,
    itemLevel: message.itemLevel,
    enhancement: message.enhancement,
    createdAt: now,
  });
  compactState(state, now);
}

function snapshotFor(
  state: RealtimeWorldState,
  match: PvpMatch,
  now: number,
): RealtimeServerMessage {
  return {
    type: "pvp_snapshot",
    matchId: match.id,
    tick: match.tick,
    serverTime: now,
    phase: match.phase,
    startsAt: match.startsAt,
    remainingMs:
      match.phase === "countdown"
        ? PVP_ROUND_DURATION_MS
        : Math.max(0, match.endsAt - now),
    winnerId: match.winnerId,
    combatVersion: match.combatVersion ?? PVP_COMBAT_VERSION,
    targetClass: PVP_TARGET_CLASS,
    combatModel: PVP_COMBAT_MODEL,
    players: match.players.map<PvpPlayerSnapshot>((player) => {
      const participantSession = state.sessions[player.sessionToken];
      return {
        id: player.id,
        name: player.name,
        side: player.side,
        x: Math.round(player.x * 10) / 10,
        y: Math.round(player.y * 10) / 10,
        vx: Math.round(player.vx * 10) / 10,
        vy: Math.round(player.vy * 10) / 10,
        aimX: player.aimX,
        aimY: player.aimY,
        hp: player.hp,
        maxHp: player.maxHp,
        score: player.score,
        dashCooldownMs: player.dashCooldownMs,
        dashRemainingMs: player.dashRemainingMs,
        invulnerableMs: player.invulnerableMs,
        respawnMs: player.respawnMs,
        connected: Boolean(
          participantSession && sessionIsOnline(participantSession, now),
        ),
        lastInputSequence: player.lastInputSequence,
        equipmentPower: player.equipmentPower,
        attackRate: player.attackRate,
        projectileCount: player.projectileCount,
        projectileSpeed: player.projectileSpeed,
        projectileLifeMs: player.projectileLifeMs,
        projectileRadius: player.projectileRadius,
        homingStrength: player.homingStrength,
        pierce: player.pierce,
        projectileDamage: player.projectileDamage,
        phantomMarchMoveMs: player.phantomMarchMoveMs,
        continuousMoveMultiplier: player.continuousMoveMultiplier,
        appearance: sanitizePvpAppearance(player.appearance),
      };
    }),
    projectiles: match.projectiles.map(
      ({
        id,
        volleyId,
        ownerId,
        x,
        y,
        vx,
        vy,
        radius,
        previousX,
        previousY,
        ageMs,
        lifeMs,
        critical,
        affinity,
      }) => ({
        id,
        volleyId,
        ownerId,
        x,
        y,
        vx,
        vy,
        radius,
        previousX,
        previousY,
        ageMs,
        lifeMs,
        critical,
        affinity,
      }),
    ),
    events: (match.events ?? [])
      .filter((event) => now - event.occurredAt <= COMBAT_EVENT_RETENTION_MS)
      .map<PvpCombatEvent>((event) => ({
        id: event.id,
        kind: event.kind,
        actorId: event.actorId,
        ...(event.targetId ? { targetId: event.targetId } : {}),
        x: event.x,
        y: event.y,
        occurredAt: event.occurredAt,
        ...(event.critical !== undefined ? { critical: event.critical } : {}),
        ...(event.volleyId !== undefined ? { volleyId: event.volleyId } : {}),
      })),
  };
}

function buildSyncMessages(
  state: RealtimeWorldState,
  session: StoredSession,
  body: SyncRequestBody,
  directMessages: RealtimeServerMessage[],
  now: number,
): RealtimeServerMessage[] {
  const messages = [...directMessages];
  messages.push({ type: "presence", online: onlineCount(state, now) });

  for (const announcement of state.recentAnnouncements) {
    if (announcement.sequence > body.lastAnnouncementSequence) {
      messages.push({ type: "world_announcement", announcement });
    }
  }

  const match = session.matchId ? state.matches[session.matchId] : undefined;
  if (match) {
    const player = match.players.find((candidate) => candidate.id === session.playerId);
    const opponent = match.players.find((candidate) => candidate.id !== session.playerId);
    if (player && opponent && body.knownMatchId !== match.id) {
      messages.push({
        type: "match_found",
        matchId: match.id,
        opponentName: opponent.name,
        side: player.side,
        startsAt: match.startsAt,
        durationMs: PVP_ROUND_DURATION_MS,
        scoreToWin: PVP_SCORE_TO_WIN,
      });
    }
    messages.push(snapshotFor(state, match, now));
    if (match.phase === "finished" && match.resultReason) {
      messages.push({
        type: "match_result",
        matchId: match.id,
        winnerId: match.winnerId,
        reason: match.resultReason,
      });
    }
  } else if (session.queued) {
    const position = state.queue.indexOf(session.token) + 1;
    messages.push({
      type: "queue_state",
      state: "queued",
      position: Math.max(1, position),
    });
  } else {
    messages.push({ type: "queue_state", state: "idle" });
  }
  return messages;
}

async function createSession(request: Request, db: D1Database): Promise<Response> {
  const rawBody = await readJson(request, true);
  if (!isRecord(rawBody)) {
    throw new RequestProblem(400, "invalid_session_body", "Session body must be an object.");
  }
  if (!isCharacterNicknameSlot(rawBody.characterSlot)) {
    throw new RequestProblem(
      400,
      "invalid_character_slot",
      "Choose character slot 1, 2, or 3.",
    );
  }
  const characterSlot = rawBody.characterSlot;
  const accountId = trustedAccountId(request);
  let displayName: string;
  if (accountId) {
    const character = await db
      .prepare(
        `SELECT nickname,nickname_key
          FROM hub_character_slots
          WHERE account_id=? AND slot=? LIMIT 1`,
      )
      .bind(accountId, characterSlot)
      .first<{ nickname: string | null; nickname_key: string | null }>();
    const storedNickname = validateCharacterNickname(character?.nickname);
    if (
      !character ||
      !storedNickname.ok ||
      character.nickname_key !== storedNickname.nicknameKey
    ) {
      throw new RequestProblem(
        409,
        "nickname_required",
        "Create this character's nickname before entering the memory duel.",
      );
    }
    displayName = storedNickname.nickname;
  } else {
    const localNickname = validateCharacterNickname(rawBody.displayName);
    if (!localNickname.ok) {
      throw new RequestProblem(
        409,
        "nickname_required",
        "Create this character's nickname before entering the memory duel.",
      );
    }
    displayName = localNickname.nickname;
  }
  const token = `${crypto.randomUUID().replaceAll("-", "")}${crypto
    .randomUUID()
    .replaceAll("-", "")}`;
  const playerId = crypto.randomUUID();

  const response = await casMutate(db, (state, now) => {
    pruneWorld(state, now);
    if (Object.keys(state.sessions).length >= MAX_SESSIONS) {
      throw new RequestProblem(
        503,
        "session_capacity",
        "The realtime service is currently at capacity.",
        true,
      );
    }
    const session: StoredSession = {
      token,
      playerId,
      ...(accountId ? { accountId } : {}),
      characterSlot,
      displayName,
      createdAt: now,
      expiresAt: now + SESSION_TTL_MS,
      lastSeenAt: now,
      queued: false,
      matchId: null,
      lastLootAnnouncementAt: 0,
      inputWindowStartedAt: now,
      inputCount: 0,
      appearance: sanitizePvpAppearance(undefined),
      combatProfile: sanitizePvpBuildProfile(undefined),
    };
    state.sessions[token] = session;
    return {
      token,
      playerId,
      displayName,
      expiresAt: session.expiresAt,
      online: onlineCount(state, now),
      recentAnnouncements: state.recentAnnouncements.slice(-6),
    };
  });
  return json(response);
}

async function syncSession(request: Request, db: D1Database): Promise<Response> {
  const token = bearerToken(request);
  if (!token) {
    throw new RequestProblem(401, "invalid_session", "A valid bearer session is required.");
  }
  const body = parseSyncBody(await readJson(request));
  const accountId = trustedAccountId(request);

  const messages = await casMutate(db, (state, now) => {
    const session = state.sessions[token];
    if (!session || session.expiresAt <= now) {
      throw new RequestProblem(401, "invalid_session", "The realtime session has expired.");
    }
    if (accountId && session.accountId !== accountId) {
      throw new RequestProblem(403, "account_session_mismatch", "Realtime session does not belong to this account.");
    }
    session.lastSeenAt = now;
    if (session.matchId) {
      const match = state.matches[session.matchId];
      const player = match?.players.find((candidate) => candidate.id === session.playerId);
      if (player) player.disconnectedAt = null;
      if (match) advanceMatch(state, match, now);
    }
    pruneWorld(state, now);

    const directMessages: RealtimeServerMessage[] = [];
    for (const message of body.messages) {
      switch (message.type) {
        case "queue":
          joinQueue(
            state,
            session,
            message.profile,
            message.appearance,
            directMessages,
          );
          break;
        case "cancel_queue":
          leaveQueue(state, session);
          break;
        case "pvp_input":
          receiveInput(state, session, message, now);
          break;
        case "announce_loot":
          publishLoot(state, session, message, now);
          break;
        case "ping":
          directMessages.push({
            type: "pong",
            clientTime: message.clientTime,
            serverTime: now,
          });
          break;
      }
    }
    makeMatches(state, now);
    pruneWorld(state, now);
    return buildSyncMessages(state, session, body, directMessages, now);
  });
  return json({ messages });
}

async function health(db: D1Database): Promise<Response> {
  const state = await readWorldState(db);
  const now = Date.now();
  const queued = state.queue.filter((token) => {
    const session = state.sessions[token];
    return Boolean(
      session &&
        session.queued &&
        !session.matchId &&
        now - session.lastSeenAt <= QUEUE_STALE_MS,
    );
  }).length;
  const matches = Object.values(state.matches).filter(
    (match) => match.phase !== "finished" && match.endsAt > now,
  ).length;
  return json({
    ok: true,
    online: onlineCount(state, now),
    queued,
    matches,
    transport: "d1-poll" as const,
  });
}

function methodNotAllowed(allowed: string): Response {
  return json(
    { error: "method_not_allowed", message: `Use ${allowed}.` },
    405,
    { allow: allowed },
  );
}

export async function handleRealtimeRequest(
  request: Request,
  env: RealtimeD1Env,
): Promise<Response> {
  try {
    const db = env.DB;
    if (!db) {
      return json(
        {
          error: "realtime_unavailable",
          message: "The realtime database binding is unavailable.",
          retryable: true,
        },
        503,
      );
    }

    const url = new URL(request.url);
    const route = url.pathname.replace(/\/+$/, "");
    const isSession = route === "/api/realtime/session";
    const isSync = route === "/api/realtime/sync";
    const isHealth = route === "/api/realtime/health";
    if (!isSession && !isSync && !isHealth) {
      return json({ error: "not_found" }, 404);
    }
    if ((isSession || isSync) && !sameOriginOrAbsent(request)) {
      return json({ error: "invalid_origin", message: "Origin does not match." }, 403);
    }

    await ensureSchema(db);
    if (isSession) {
      if (request.method !== "POST") return methodNotAllowed("POST");
      return await createSession(request, db);
    }
    if (isSync) {
      if (request.method !== "POST") return methodNotAllowed("POST");
      return await syncSession(request, db);
    }
    if (request.method !== "GET") return methodNotAllowed("GET");
    return await health(db);
  } catch (error) {
    if (error instanceof RequestProblem) {
      return json(
        {
          error: error.code,
          message: error.message,
          ...(error.retryable ? { retryable: true } : {}),
        },
        error.status,
        error.retryable ? { "retry-after": "1" } : undefined,
      );
    }
    if (error instanceof CasConflict) {
      return json(
        {
          error: "state_conflict",
          message: "Realtime state was busy. Retry the request.",
          retryable: true,
        },
        409,
        { "retry-after": "0.2" },
      );
    }
    return json(
      {
        error: "realtime_storage_error",
        message: "The realtime database is temporarily unavailable.",
        retryable: true,
      },
      503,
      { "retry-after": "1" },
    );
  }
}

export const PVP_D1_SERVER_RULES = {
  tickMs: TICK_MS,
  maxSimulationDebtMs: MAX_SIMULATION_DEBT_MS,
  maxStepsPerRequest: MAX_STEPS_PER_REQUEST,
  combatVersion: PVP_COMBAT_VERSION,
  targetClass: PVP_TARGET_CLASS,
  combatModel: PVP_COMBAT_MODEL,
  baseMaxHp: PVP_BASE_MAX_HP,
  bossHitRadius: PVP_BOSS_HIT_RADIUS,
  dashDurationMs: PVP_DASH_DURATION_MS,
  phantomMarchActivationMs: PVP_PHANTOM_MARCH_ACTIVATION_MS,
  phantomMarchMoveMultiplier: PVP_PHANTOM_MARCH_MOVE_MULTIPLIER,
  phantomMarchTimerCapMs: PVP_PHANTOM_MARCH_TIMER_CAP_MS,
  phantomMarchMovementEpsilon: PVP_PHANTOM_MARCH_MOVEMENT_EPSILON,
  maxProjectilesPerMatch: MAX_PROJECTILES_PER_MATCH,
  combatEventRetentionMs: COMBAT_EVENT_RETENTION_MS,
  disconnectForfeitMs: DISCONNECT_FORFEIT_MS,
  playerCollisionClearance: PVP_PLAYER_COLLISION_CLEARANCE,
  walkableFloorPolygon: WALKABLE_FLOOR_POLYGON,
} as const;
