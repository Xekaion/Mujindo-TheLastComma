/// <reference types="@cloudflare/workers-types" />

import {
  PVP_ARENA_HEIGHT,
  PVP_ARENA_WIDTH,
  PVP_COUNTDOWN_MS,
  PVP_ROUND_DURATION_MS,
  PVP_SCORE_TO_WIN,
  parseRealtimeClientMessage,
  sanitizeDisplayName,
  type PvpInput,
  type PvpPhase,
  type PvpPlayerSnapshot,
  type PvpProjectileSnapshot,
  type RealtimeClientMessage,
  type RealtimeServerMessage,
  type WorldLootAnnouncement,
} from "../app/pvp-protocol";

export type RealtimeD1Env = {
  DB?: D1Database;
};

type StoredSession = {
  token: string;
  playerId: string;
  displayName: string;
  createdAt: number;
  expiresAt: number;
  lastSeenAt: number;
  queued: boolean;
  matchId: string | null;
  lastLootAnnouncementAt: number;
  inputWindowStartedAt: number;
  inputCount: number;
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
  invulnerableMs: number;
  respawnMs: number;
  disconnectedAt: number | null;
  input: PvpInput;
  lastInputSequence: number;
};

type MatchProjectile = PvpProjectileSnapshot & {
  lifeMs: number;
  damage: number;
};

type PvpMatch = {
  id: string;
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
  lastSteppedAt: number;
  accumulatorMs: number;
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
const MAX_CATCH_UP_MS = 250;
const PLAYER_SPEED = 235;
const DASH_SPEED_MULTIPLIER = 3.15;
const DASH_DURATION_MS = 165;
const DASH_COOLDOWN_MS = 1_550;
const SHOT_COOLDOWN_MS = 360;
const PROJECTILE_SPEED = 650;
const PROJECTILE_DAMAGE = 18;
const PROJECTILE_RADIUS = 8;
const PROJECTILE_LIFE_MS = 1_650;
const RESPAWN_MS = 1_900;
const DISCONNECT_FORFEIT_MS = 10_000;
const ONLINE_WINDOW_MS = 6_000;
const QUEUE_STALE_MS = 10_000;
const MATCH_RETENTION_MS = 12_000;
const SESSION_TTL_MS = 12 * 60 * 60 * 1_000;
const MAX_INPUTS_PER_SECOND = 42;
const LOOT_ANNOUNCEMENT_COOLDOWN_MS = 3_000;
const ACQUISITION_RETENTION_MS = SESSION_TTL_MS;
const ARENA_MARGIN_X = 88;
const ARENA_MARGIN_TOP = 112;
const ARENA_MARGIN_BOTTOM = 76;
const MAX_REQUEST_BYTES = 32 * 1_024;
const MAX_SYNC_MESSAGES = 48;
const MAX_SESSIONS = 512;
const MAX_QUEUE_SIZE = 128;
const MAX_MATCHES = 64;
const MAX_PROJECTILES_PER_MATCH = 96;
const MAX_ACQUISITION_IDS = 256;
const MAX_RECENT_ANNOUNCEMENTS = 12;
const MAX_STATE_BYTES = 900_000;
const CAS_RETRIES = 8;
const ARENA_OBSTACLES = [
  { x: 510, y: 360, radius: 66 },
  { x: 770, y: 360, radius: 66 },
] as const;

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

const clamp = (value: number, minimum: number, maximum: number): number =>
  Math.max(minimum, Math.min(maximum, value));

const distanceSquared = (ax: number, ay: number, bx: number, by: number): number => {
  const dx = ax - bx;
  const dy = ay - by;
  return dx * dx + dy * dy;
};

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

function trustedDisplayName(request: Request, requestedName: unknown): string {
  const trustedName = request.headers.get("x-mujindo-player-name");
  return sanitizeDisplayName(trustedName ?? requestedName);
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
      match.projectiles = match.projectiles.slice(-MAX_PROJECTILES_PER_MATCH);
    }
  }
}

function serializeWorldState(state: RealtimeWorldState, now: number): string {
  compactState(state, now);
  let serialized = JSON.stringify(state);
  if (encodedLength(serialized) <= MAX_STATE_BYTES) return serialized;

  state.acquisitionIds = state.acquisitionIds.slice(-64);
  for (const match of Object.values(state.matches)) {
    match.projectiles = match.projectiles.slice(-48);
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

function sessionIsOnline(session: StoredSession, now: number): boolean {
  return session.expiresAt > now && now - session.lastSeenAt <= ONLINE_WINDOW_MS;
}

function onlineCount(state: RealtimeWorldState, now: number): number {
  return Object.values(state.sessions).filter((session) => sessionIsOnline(session, now)).length;
}

function activeMatchCount(state: RealtimeWorldState): number {
  return Object.values(state.matches).filter((match) => match.phase !== "finished").length;
}

function resolveArenaCollision(player: MatchPlayer): void {
  player.x = clamp(player.x, ARENA_MARGIN_X, PVP_ARENA_WIDTH - ARENA_MARGIN_X);
  player.y = clamp(player.y, ARENA_MARGIN_TOP, PVP_ARENA_HEIGHT - ARENA_MARGIN_BOTTOM);
  for (const obstacle of ARENA_OBSTACLES) {
    const dx = player.x - obstacle.x;
    const dy = player.y - obstacle.y;
    const distance = Math.hypot(dx, dy);
    const minimumDistance = obstacle.radius + 27;
    if (distance >= minimumDistance) continue;
    const safeDistance = distance || 1;
    player.x = obstacle.x + (dx / safeDistance) * minimumDistance;
    player.y = obstacle.y + (dy / safeDistance) * minimumDistance;
  }
}

function projectileHitsObstacle(projectile: MatchProjectile): boolean {
  return ARENA_OBSTACLES.some(
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
}

function stepSimulation(match: PvpMatch, stepNow: number): void {
  if (match.phase !== "playing") return;
  match.tick += 1;
  const deltaSeconds = TICK_MS / 1_000;

  for (const player of match.players) {
    player.shotCooldownMs = Math.max(0, player.shotCooldownMs - TICK_MS);
    player.dashCooldownMs = Math.max(0, player.dashCooldownMs - TICK_MS);
    player.dashRemainingMs = Math.max(0, player.dashRemainingMs - TICK_MS);
    player.invulnerableMs = Math.max(0, player.invulnerableMs - TICK_MS);
    if (player.respawnMs > 0) {
      player.respawnMs = Math.max(0, player.respawnMs - TICK_MS);
      if (player.respawnMs === 0) respawnPlayer(player);
      continue;
    }
    if (player.input.dash && player.dashCooldownMs <= 0) {
      player.dashRemainingMs = DASH_DURATION_MS;
      player.dashCooldownMs = DASH_COOLDOWN_MS;
      player.invulnerableMs = DASH_DURATION_MS + 70;
    }
    player.input = { ...player.input, dash: false };
    const speed =
      PLAYER_SPEED * (player.dashRemainingMs > 0 ? DASH_SPEED_MULTIPLIER : 1);
    player.vx = player.input.moveX * speed;
    player.vy = player.input.moveY * speed;
    player.x += player.vx * deltaSeconds;
    player.y += player.vy * deltaSeconds;
    resolveArenaCollision(player);

    if (
      player.input.fire &&
      player.shotCooldownMs <= 0 &&
      player.dashRemainingMs <= 0 &&
      match.projectiles.length < MAX_PROJECTILES_PER_MATCH
    ) {
      player.shotCooldownMs = SHOT_COOLDOWN_MS;
      match.projectiles.push({
        id: match.nextProjectileId,
        ownerId: player.id,
        x: player.x + player.aimX * 32,
        y: player.y + player.aimY * 32,
        vx: player.aimX * PROJECTILE_SPEED,
        vy: player.aimY * PROJECTILE_SPEED,
        radius: PROJECTILE_RADIUS,
        lifeMs: PROJECTILE_LIFE_MS,
        damage: PROJECTILE_DAMAGE,
      });
      match.nextProjectileId += 1;
    }
  }

  const liveProjectiles: MatchProjectile[] = [];
  for (const projectile of match.projectiles) {
    projectile.lifeMs -= TICK_MS;
    projectile.x += projectile.vx * deltaSeconds;
    projectile.y += projectile.vy * deltaSeconds;
    if (
      projectile.lifeMs <= 0 ||
      projectile.x < 0 ||
      projectile.x > PVP_ARENA_WIDTH ||
      projectile.y < 0 ||
      projectile.y > PVP_ARENA_HEIGHT ||
      projectileHitsObstacle(projectile)
    ) {
      continue;
    }
    const target = match.players.find(
      (candidate) => candidate.id !== projectile.ownerId && candidate.respawnMs <= 0,
    );
    if (
      target &&
      target.invulnerableMs <= 0 &&
      distanceSquared(projectile.x, projectile.y, target.x, target.y) <=
        (projectile.radius + 25) ** 2
    ) {
      target.hp = Math.max(0, target.hp - projectile.damage);
      if (target.hp <= 0) {
        const owner = match.players.find(
          (candidate) => candidate.id === projectile.ownerId,
        );
        if (owner) {
          owner.score += 1;
          if (owner.score >= PVP_SCORE_TO_WIN) {
            finishMatch(match, owner.id, "score", stepNow);
            return;
          }
        }
        target.respawnMs = RESPAWN_MS;
        target.vx = 0;
        target.vy = 0;
      }
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

  const elapsed = clamp(now - match.lastSteppedAt, 0, MAX_CATCH_UP_MS);
  match.lastSteppedAt = now;
  match.accumulatorMs = Math.min(
    MAX_CATCH_UP_MS,
    Math.max(0, match.accumulatorMs) + elapsed,
  );
  let simulatedAt = now - match.accumulatorMs;
  while (match.accumulatorMs >= TICK_MS && match.phase === "playing") {
    simulatedAt += TICK_MS;
    stepSimulation(match, simulatedAt);
    match.accumulatorMs -= TICK_MS;
  }
}

function advanceMatches(state: RealtimeWorldState, now: number): void {
  for (const match of Object.values(state.matches)) advanceMatch(state, match, now);
}

function pruneWorld(state: RealtimeWorldState, now: number): void {
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
      if (session) session.queued = false;
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

function maintainWorld(state: RealtimeWorldState, now: number): void {
  advanceMatches(state, now);
  pruneWorld(state, now);
}

function makeMatchPlayer(session: StoredSession, side: 0 | 1): MatchPlayer {
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
    hp: 100,
    maxHp: 100,
    score: 0,
    shotCooldownMs: 500,
    dashCooldownMs: 0,
    dashRemainingMs: 0,
    invulnerableMs: 850,
    respawnMs: 0,
    disconnectedAt: null,
    input: idleInput(),
    lastInputSequence: 0,
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
    const matchId = crypto.randomUUID();
    const match: PvpMatch = {
      id: matchId,
      tick: 0,
      phase: "countdown",
      startsAt: now + PVP_COUNTDOWN_MS,
      endsAt: now + PVP_COUNTDOWN_MS + PVP_ROUND_DURATION_MS,
      finishedAt: null,
      winnerId: null,
      resultReason: null,
      players: [makeMatchPlayer(left, 0), makeMatchPlayer(right, 1)],
      projectiles: [],
      nextProjectileId: 1,
      lastSteppedAt: now,
      accumulatorMs: 0,
    };
    state.matches[match.id] = match;
    left.matchId = match.id;
    right.matchId = match.id;
  }
}

function joinQueue(
  state: RealtimeWorldState,
  session: StoredSession,
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
    session.queued = true;
    state.queue.push(session.token);
  }
}

function leaveQueue(state: RealtimeWorldState, session: StoredSession): void {
  session.queued = false;
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
        respawnMs: player.respawnMs,
        connected: Boolean(
          participantSession && sessionIsOnline(participantSession, now),
        ),
        lastInputSequence: player.lastInputSequence,
      };
    }),
    projectiles: match.projectiles.map(
      ({ id, ownerId, x, y, vx, vy, radius }) => ({
        id,
        ownerId,
        x,
        y,
        vx,
        vy,
        radius,
      }),
    ),
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
  const displayName = trustedDisplayName(request, rawBody.displayName);
  const token = `${crypto.randomUUID().replaceAll("-", "")}${crypto
    .randomUUID()
    .replaceAll("-", "")}`;
  const playerId = crypto.randomUUID();

  const response = await casMutate(db, (state, now) => {
    maintainWorld(state, now);
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
      displayName,
      createdAt: now,
      expiresAt: now + SESSION_TTL_MS,
      lastSeenAt: now,
      queued: false,
      matchId: null,
      lastLootAnnouncementAt: 0,
      inputWindowStartedAt: now,
      inputCount: 0,
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

  const messages = await casMutate(db, (state, now) => {
    const session = state.sessions[token];
    if (!session || session.expiresAt <= now) {
      throw new RequestProblem(401, "invalid_session", "The realtime session has expired.");
    }
    session.lastSeenAt = now;
    if (session.matchId) {
      const match = state.matches[session.matchId];
      const player = match?.players.find((candidate) => candidate.id === session.playerId);
      if (player) player.disconnectedAt = null;
    }
    maintainWorld(state, now);

    const directMessages: RealtimeServerMessage[] = [];
    for (const message of body.messages) {
      switch (message.type) {
        case "queue":
          joinQueue(state, session, directMessages);
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
  const status = await casMutate(db, (state, now) => {
    maintainWorld(state, now);
    return {
      ok: true,
      online: onlineCount(state, now),
      queued: state.queue.length,
      matches: activeMatchCount(state),
      transport: "d1-poll" as const,
    };
  });
  return json(status);
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
    const isSession = route.endsWith("/session");
    const isSync = route.endsWith("/sync");
    const isHealth = route.endsWith("/health");
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
  maxCatchUpMs: MAX_CATCH_UP_MS,
  playerSpeed: PLAYER_SPEED,
  dashCooldownMs: DASH_COOLDOWN_MS,
  shotCooldownMs: SHOT_COOLDOWN_MS,
  projectileDamage: PROJECTILE_DAMAGE,
  disconnectForfeitMs: DISCONNECT_FORFEIT_MS,
  obstacles: ARENA_OBSTACLES,
} as const;
