/// <reference types="@cloudflare/workers-types" />

import {
  DEFAULT_HUB_APPEARANCE,
  HUB_HEARTBEAT_INTERVAL_MS,
  HUB_MAP_VERSION,
  HUB_NEARBY_RADIUS,
  HUB_ONLINE_WINDOW_MS,
  HUB_PLAYER_SPEED,
  HUB_PORTALS,
  HUB_SESSION_TTL_MS,
  HUB_SPAWN_POINTS,
  HUB_ZONE_ID,
  normalizeHubAppearance,
  parseHubAppearanceRequest,
  parseHubMoveIntent,
  parseHubSessionRequest,
  type HubAppearance,
  type HubCharacterSlot,
  type HubFacing,
  type HubPlayerSnapshot,
} from "../app/hub-protocol";
import { resolvePlazaMovement } from "../app/plaza-world";

export type HubD1Env = {
  DB?: D1Database;
};

type CharacterRow = {
  public_character_id: string;
};

type SessionRow = {
  id: string;
  account_id: string;
  character_slot: number;
  public_character_id: string;
  display_name: string;
  level: number;
  appearance_json: string;
  x: number;
  y: number;
  facing: number;
  moving: number;
  last_sequence: number;
  last_move_at: number;
  last_seen_at: number;
  expires_at: number;
  version: number;
  updated_at: number;
};

type NearbyRow = Pick<
  SessionRow,
  | "id"
  | "character_slot"
  | "public_character_id"
  | "display_name"
  | "level"
  | "appearance_json"
  | "x"
  | "y"
  | "facing"
  | "moving"
  | "updated_at"
>;

const MAX_BODY_BYTES = 8 * 1_024;
const MAX_MOVE_STEP_MS = 250;
const STALE_SESSION_RETENTION_MS = 60_000;
const MAX_NEARBY_PLAYERS = 48;
const SNAPSHOT_QUERY_CANDIDATES = 96;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const schemaReady = new WeakMap<object, Promise<void>>();

class HubProblem extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
  }
}

const clamp = (value: number, minimum: number, maximum: number): number =>
  Math.max(minimum, Math.min(maximum, value));

const encodedLength = (value: string): number =>
  new TextEncoder().encode(value).byteLength;

const json = (body: unknown, status = 200, extra?: HeadersInit): Response => {
  const headers = new Headers(extra);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store, private");
  headers.set("x-content-type-options", "nosniff");
  headers.set("referrer-policy", "no-referrer");
  return new Response(JSON.stringify(body), { status, headers });
};

function resultChanges(result: D1Result): number {
  const meta = result.meta as D1Meta & { changes?: number };
  return typeof meta.changes === "number" ? meta.changes : 0;
}

function sameOriginOrAbsent(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return request.headers.get("sec-fetch-site") !== "cross-site";
  try {
    return new URL(origin).origin === new URL(request.url).origin;
  } catch {
    return false;
  }
}

function trustedAccountId(request: Request): string | null {
  const accountId = request.headers.get("x-mujindo-account-id") ?? "";
  if (UUID_PATTERN.test(accountId)) return accountId.toLowerCase();
  if (request.headers.get("x-mujindo-hub-auth-mode") === "guest") return null;
  throw new HubProblem(401, "account_required", "An authenticated account or server-issued guest identity is required.");
}

function trustedDisplayName(request: Request, guestFallback = "방랑자"): string {
  const value = request.headers.get("x-mujindo-player-name") ?? guestFallback;
  const normalized = value
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 18);
  return normalized || "방랑자";
}

function bearerToken(request: Request): string {
  const authorization = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+([a-f0-9]{64})$/i.exec(authorization);
  if (!match) {
    throw new HubProblem(401, "invalid_hub_session", "A valid plaza session is required.");
  }
  return match[1].toLowerCase();
}

const toHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return toHex(new Uint8Array(digest));
}

async function readJson(request: Request, allowEmpty = false): Promise<unknown> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    throw new HubProblem(413, "request_too_large", "The plaza request is too large.");
  }
  const raw = await request.text();
  if (encodedLength(raw) > MAX_BODY_BYTES) {
    throw new HubProblem(413, "request_too_large", "The plaza request is too large.");
  }
  if (!raw.trim() && allowEmpty) return {};
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new HubProblem(400, "invalid_json", "A valid JSON request body is required.");
  }
}

async function ensureSchema(db: D1Database): Promise<void> {
  const existing = schemaReady.get(db as object);
  if (existing) return existing;
  const setup = db
    .batch([
      db.prepare(`CREATE TABLE IF NOT EXISTS hub_character_slots (
        account_id TEXT NOT NULL,
        slot INTEGER NOT NULL CHECK (slot BETWEEN 1 AND 3),
        public_character_id TEXT NOT NULL UNIQUE,
        level INTEGER NOT NULL CHECK (level BETWEEN 1 AND 999),
        appearance_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (account_id, slot)
      )`),
      db.prepare(`CREATE TABLE IF NOT EXISTS hub_sessions (
        id TEXT PRIMARY KEY NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        account_id TEXT NOT NULL UNIQUE,
        character_slot INTEGER NOT NULL CHECK (character_slot BETWEEN 1 AND 3),
        public_character_id TEXT NOT NULL,
        display_name TEXT NOT NULL,
        level INTEGER NOT NULL CHECK (level BETWEEN 1 AND 999),
        appearance_json TEXT NOT NULL,
        zone TEXT NOT NULL DEFAULT 'memory-plaza-v1',
        x REAL NOT NULL,
        y REAL NOT NULL,
        facing INTEGER NOT NULL CHECK (facing BETWEEN 0 AND 7),
        moving INTEGER NOT NULL DEFAULT 0 CHECK (moving IN (0, 1)),
        last_sequence INTEGER NOT NULL DEFAULT 0,
        last_move_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        version INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (account_id, character_slot)
          REFERENCES hub_character_slots(account_id, slot) ON DELETE CASCADE
      )`),
      db.prepare(`CREATE INDEX IF NOT EXISTS hub_sessions_presence
        ON hub_sessions(zone, last_seen_at, x, y)`),
      db.prepare(`CREATE TABLE IF NOT EXISTS hub_rate_limits (
        account_id TEXT NOT NULL,
        bucket TEXT NOT NULL,
        window_started_at INTEGER NOT NULL,
        request_count INTEGER NOT NULL,
        blocked_until INTEGER,
        PRIMARY KEY (account_id, bucket)
      )`),
    ])
    .then(() => undefined)
    .catch((error: unknown) => {
      schemaReady.delete(db as object);
      throw error;
    });
  schemaReady.set(db as object, setup);
  return setup;
}

function isMissingHubSchemaError(error: unknown): boolean {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "object" && error !== null && "message" in error
        ? String(error.message)
        : String(error);
  return /\bno such table:\s*hub_(?:character_slots|sessions|rate_limits)\b/i.test(
    message,
  );
}

async function enforceRateLimit(
  db: D1Database,
  accountId: string,
  bucket: string,
  limit: number,
  windowMs: number,
  blockMs: number,
): Promise<void> {
  const now = Date.now();
  const resetBefore = now - windowMs;
  const row = await db.prepare(`INSERT INTO hub_rate_limits
      (account_id,bucket,window_started_at,request_count,blocked_until)
    VALUES(?,?,?,1,NULL)
    ON CONFLICT(account_id,bucket) DO UPDATE SET
      request_count=CASE WHEN hub_rate_limits.window_started_at<=? THEN 1 ELSE hub_rate_limits.request_count+1 END,
      window_started_at=CASE WHEN hub_rate_limits.window_started_at<=? THEN excluded.window_started_at ELSE hub_rate_limits.window_started_at END,
      blocked_until=CASE
        WHEN hub_rate_limits.blocked_until>excluded.window_started_at THEN hub_rate_limits.blocked_until
        WHEN hub_rate_limits.window_started_at<=? THEN NULL
        WHEN hub_rate_limits.request_count+1>? THEN excluded.window_started_at+?
        ELSE NULL END
    RETURNING request_count,blocked_until`)
    .bind(accountId, bucket, now, resetBefore, resetBefore, resetBefore, limit, blockMs)
    .first<{ request_count: number; blocked_until: number | null }>();
  if (row?.blocked_until && row.blocked_until > now) {
    throw new HubProblem(429, "hub_rate_limited", "Too many plaza requests.", true);
  }
}

async function pruneStaleSessions(db: D1Database, now: number): Promise<void> {
  await db.batch([
    db.prepare(`DELETE FROM hub_sessions WHERE expires_at<=? OR last_seen_at<?`)
      .bind(now, now - STALE_SESSION_RETENTION_MS),
    db.prepare(`DELETE FROM hub_character_slots
      WHERE account_id LIKE 'guest:%'
        AND NOT EXISTS (
          SELECT 1 FROM hub_sessions WHERE hub_sessions.account_id=hub_character_slots.account_id
        )`),
    db.prepare(`DELETE FROM hub_rate_limits WHERE window_started_at<? AND (blocked_until IS NULL OR blocked_until<?)`)
      .bind(now - HUB_SESSION_TTL_MS, now),
  ]);
}

function parseAppearanceJson(value: string): HubAppearance {
  try {
    return normalizeHubAppearance(JSON.parse(value) as unknown);
  } catch {
    return normalizeHubAppearance(DEFAULT_HUB_APPEARANCE);
  }
}

function toSnapshot(row: NearbyRow): HubPlayerSnapshot {
  const slot = clamp(Math.floor(row.character_slot), 1, 3) as HubCharacterSlot;
  return {
    playerId: row.id,
    characterId: row.public_character_id,
    displayName: row.display_name,
    characterSlot: slot,
    level: clamp(Math.floor(row.level), 1, 999),
    x: Math.round(row.x * 100) / 100,
    y: Math.round(row.y * 100) / 100,
    facing: clamp(Math.floor(row.facing), 0, 7) as HubFacing,
    moving: row.moving === 1,
    appearance: parseAppearanceJson(row.appearance_json),
    updatedAt: row.updated_at,
  };
}

async function sessionByToken(
  db: D1Database,
  request: Request,
): Promise<SessionRow> {
  const accountId = trustedAccountId(request);
  const tokenHash = await sha256(bearerToken(request));
  const row = await db.prepare(`SELECT * FROM hub_sessions
    WHERE token_hash=? AND expires_at>? LIMIT 1`)
    .bind(tokenHash, Date.now())
    .first<SessionRow>();
  if (!row || (accountId !== null && row.account_id !== accountId)) {
    throw new HubProblem(401, "invalid_hub_session", "The plaza session expired or belongs to another account.");
  }
  return row;
}

async function snapshotEnvelope(db: D1Database, selfRow: SessionRow, now: number) {
  const candidates = await db.prepare(`SELECT
      id,character_slot,public_character_id,display_name,level,appearance_json,
      x,y,facing,moving,updated_at
    FROM hub_sessions
    WHERE zone=? AND id<>? AND last_seen_at>=? AND expires_at>?
      AND x BETWEEN ? AND ? AND y BETWEEN ? AND ?
    ORDER BY last_seen_at DESC LIMIT ?`)
    .bind(
      HUB_ZONE_ID,
      selfRow.id,
      now - HUB_ONLINE_WINDOW_MS,
      now,
      selfRow.x - HUB_NEARBY_RADIUS,
      selfRow.x + HUB_NEARBY_RADIUS,
      selfRow.y - HUB_NEARBY_RADIUS,
      selfRow.y + HUB_NEARBY_RADIUS,
      SNAPSHOT_QUERY_CANDIDATES,
    )
    .all<NearbyRow>();
  const radiusSquared = HUB_NEARBY_RADIUS * HUB_NEARBY_RADIUS;
  const nearbyPlayers = (candidates.results ?? [])
    .filter((row) => {
      const dx = row.x - selfRow.x;
      const dy = row.y - selfRow.y;
      return dx * dx + dy * dy <= radiusSquared;
    })
    .slice(0, MAX_NEARBY_PLAYERS)
    .map(toSnapshot);
  const online = await db.prepare(`SELECT COUNT(*) AS count FROM hub_sessions
    WHERE zone=? AND last_seen_at>=? AND expires_at>?`)
    .bind(HUB_ZONE_ID, now - HUB_ONLINE_WINDOW_MS, now)
    .first<{ count: number }>();
  return {
    serverTime: now,
    zone: HUB_ZONE_ID,
    mapVersion: HUB_MAP_VERSION,
    online: Number(online?.count ?? 1),
    self: toSnapshot(selfRow),
    nearbyPlayers,
    portals: HUB_PORTALS,
    heartbeatIntervalMs: HUB_HEARTBEAT_INTERVAL_MS,
  };
}

function resolveAuthoritativePosition(
  currentX: number,
  currentY: number,
  moveX: number,
  moveY: number,
  elapsedMs: number,
): { x: number; y: number } {
  const seconds = clamp(elapsedMs, 0, MAX_MOVE_STEP_MS) / 1_000;
  return resolvePlazaMovement(
    { x: currentX, y: currentY },
    {
      x: moveX * HUB_PLAYER_SPEED * seconds,
      y: moveY * HUB_PLAYER_SPEED * seconds,
    },
  );
}

async function createSession(request: Request, db: D1Database): Promise<Response> {
  const authenticatedAccountId = trustedAccountId(request);
  const parsed = parseHubSessionRequest(await readJson(request));
  if (!parsed) {
    throw new HubProblem(400, "invalid_character_slot", "Choose character slot 1, 2, or 3 before entering the plaza.");
  }
  const guestRateSubject = `guest:${await sha256(
    request.headers.get("cf-connecting-ip") ?? new URL(request.url).hostname,
  )}`;
  await enforceRateLimit(
    db,
    authenticatedAccountId ?? guestRateSubject,
    "session",
    8,
    60_000,
    60_000,
  );
  const now = Date.now();
  await pruneStaleSessions(db, now);

  // Guests cannot nominate this id. It is generated here and becomes usable
  // only through the cryptographically random bearer token returned below.
  const accountId = authenticatedAccountId ?? `guest:${crypto.randomUUID()}`;

  const appearanceJson = JSON.stringify(parsed.appearance);
  const generatedCharacterId = crypto.randomUUID();
  const character = await db.prepare(`INSERT INTO hub_character_slots
      (account_id,slot,public_character_id,level,appearance_json,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?)
    ON CONFLICT(account_id,slot) DO UPDATE SET
      level=excluded.level,appearance_json=excluded.appearance_json,updated_at=excluded.updated_at
    RETURNING public_character_id`)
    .bind(
      accountId,
      parsed.characterSlot,
      generatedCharacterId,
      parsed.level,
      appearanceJson,
      now,
      now,
    )
    .first<CharacterRow>();
  if (!character) throw new HubProblem(503, "hub_storage_error", "Could not bind the selected character.", true);

  const rawToken = `${crypto.randomUUID().replaceAll("-", "")}${crypto.randomUUID().replaceAll("-", "")}`;
  const tokenHash = await sha256(rawToken);
  const playerId = crypto.randomUUID();
  const spawn = HUB_SPAWN_POINTS[parsed.arrival];
  const jitterAngle = crypto.getRandomValues(new Uint32Array(1))[0] / 0xffffffff * Math.PI * 2;
  const spawnX = spawn.x + Math.cos(jitterAngle) * 34;
  const spawnY = spawn.y + Math.sin(jitterAngle) * 24;
  await db.prepare(`INSERT INTO hub_sessions
      (id,token_hash,account_id,character_slot,public_character_id,display_name,
       level,appearance_json,zone,x,y,facing,moving,last_sequence,last_move_at,
       last_seen_at,expires_at,version,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,0,0,?,?,?,0,?,?)
    ON CONFLICT(account_id) DO UPDATE SET
      id=excluded.id,token_hash=excluded.token_hash,character_slot=excluded.character_slot,
      public_character_id=excluded.public_character_id,display_name=excluded.display_name,
      level=excluded.level,appearance_json=excluded.appearance_json,zone=excluded.zone,
      x=excluded.x,y=excluded.y,facing=excluded.facing,moving=0,last_sequence=0,
      last_move_at=excluded.last_move_at,last_seen_at=excluded.last_seen_at,
      expires_at=excluded.expires_at,version=hub_sessions.version+1,
      created_at=excluded.created_at,updated_at=excluded.updated_at`)
    .bind(
      playerId,
      tokenHash,
      accountId,
      parsed.characterSlot,
      character.public_character_id,
      trustedDisplayName(request, parsed.displayName),
      parsed.level,
      appearanceJson,
      HUB_ZONE_ID,
      spawnX,
      spawnY,
      spawn.facing,
      now,
      now,
      now + HUB_SESSION_TTL_MS,
      now,
      now,
    )
    .run();
  const session = await db.prepare(`SELECT * FROM hub_sessions WHERE account_id=? LIMIT 1`)
    .bind(accountId)
    .first<SessionRow>();
  if (!session) throw new HubProblem(503, "hub_storage_error", "Could not open the plaza session.", true);
  return json({ token: rawToken, ...(await snapshotEnvelope(db, session, now)) }, 201);
}

async function syncSession(request: Request, db: D1Database): Promise<Response> {
  const intent = parseHubMoveIntent(await readJson(request));
  if (!intent) {
    throw new HubProblem(400, "invalid_move_intent", "Movement requires a monotonic sequence and normalized input axes.");
  }
  const row = await sessionByToken(db, request);
  await enforceRateLimit(db, row.account_id, "sync", 40, 1_000, 2_000);
  const accountId = row.account_id;
  const now = Date.now();
  if (intent.sequence <= row.last_sequence) {
    await db.prepare(`UPDATE hub_sessions SET last_seen_at=?,updated_at=? WHERE id=?`)
      .bind(now, now, row.id)
      .run();
  } else {
    const position = resolveAuthoritativePosition(
      row.x,
      row.y,
      intent.moveX,
      intent.moveY,
      now - row.last_move_at,
    );
    const moving = Math.hypot(intent.moveX, intent.moveY) >= 0.05 ? 1 : 0;
    const updated = await db.prepare(`UPDATE hub_sessions SET
        x=?,y=?,facing=?,moving=?,last_sequence=?,last_move_at=?,last_seen_at=?,
        expires_at=?,version=version+1,updated_at=?
      WHERE id=? AND account_id=? AND version=? AND last_sequence<?`)
      .bind(
        position.x,
        position.y,
        intent.facing,
        moving,
        intent.sequence,
        now,
        now,
        now + HUB_SESSION_TTL_MS,
        now,
        row.id,
        accountId,
        row.version,
        intent.sequence,
      )
      .run();
    if (resultChanges(updated) !== 1) {
      throw new HubProblem(409, "hub_state_conflict", "A newer movement update already won.", true);
    }
  }
  await pruneStaleSessions(db, now);
  const current = await sessionByToken(db, request);
  return json(await snapshotEnvelope(db, current, now));
}

async function heartbeat(request: Request, db: D1Database): Promise<Response> {
  await readJson(request, true);
  const row = await sessionByToken(db, request);
  const accountId = row.account_id;
  await enforceRateLimit(db, accountId, "heartbeat", 30, 60_000, 5_000);
  const now = Date.now();
  await db.prepare(`UPDATE hub_sessions SET moving=0,last_seen_at=?,expires_at=?,updated_at=?
    WHERE id=? AND account_id=?`)
    .bind(now, now + HUB_SESSION_TTL_MS, now, row.id, accountId)
    .run();
  await pruneStaleSessions(db, now);
  const current = await sessionByToken(db, request);
  return json(await snapshotEnvelope(db, current, now));
}

async function updateAppearance(request: Request, db: D1Database): Promise<Response> {
  const parsed = parseHubAppearanceRequest(await readJson(request));
  if (!parsed) throw new HubProblem(400, "invalid_appearance", "Appearance payload is invalid.");
  const row = await sessionByToken(db, request);
  const accountId = row.account_id;
  await enforceRateLimit(db, accountId, "appearance", 12, 60_000, 15_000);
  const now = Date.now();
  const appearanceJson = JSON.stringify(parsed.appearance);
  await db.batch([
    db.prepare(`UPDATE hub_character_slots SET level=?,appearance_json=?,updated_at=?
      WHERE account_id=? AND slot=?`)
      .bind(parsed.level, appearanceJson, now, accountId, row.character_slot),
    db.prepare(`UPDATE hub_sessions SET level=?,appearance_json=?,last_seen_at=?,
      version=version+1,updated_at=? WHERE id=? AND account_id=?`)
      .bind(parsed.level, appearanceJson, now, now, row.id, accountId),
  ]);
  const current = await sessionByToken(db, request);
  return json(await snapshotEnvelope(db, current, now));
}

async function leaveSession(request: Request, db: D1Database): Promise<Response> {
  const row = await sessionByToken(db, request);
  const accountId = row.account_id;
  await db.batch([
    db.prepare(`DELETE FROM hub_sessions WHERE id=? AND account_id=?`)
      .bind(row.id, accountId),
    db.prepare(`DELETE FROM hub_character_slots
      WHERE account_id=? AND account_id LIKE 'guest:%'
        AND NOT EXISTS (SELECT 1 FROM hub_sessions WHERE account_id=?)`)
      .bind(accountId, accountId),
  ]);
  return json({ ok: true });
}

async function health(db: D1Database): Promise<Response> {
  const now = Date.now();
  await pruneStaleSessions(db, now);
  const row = await db.prepare(`SELECT COUNT(*) AS count FROM hub_sessions
    WHERE zone=? AND last_seen_at>=? AND expires_at>?`)
    .bind(HUB_ZONE_ID, now - HUB_ONLINE_WINDOW_MS, now)
    .first<{ count: number }>();
  return json({
    ok: true,
    transport: "d1-authoritative-poll",
    zone: HUB_ZONE_ID,
    mapVersion: HUB_MAP_VERSION,
    online: Number(row?.count ?? 0),
    heartbeatIntervalMs: HUB_HEARTBEAT_INTERVAL_MS,
  });
}

function methodNotAllowed(allowed: string): Response {
  return json({ error: "method_not_allowed", message: `Use ${allowed}.` }, 405, { allow: allowed });
}

async function dispatchHubRequest(
  request: Request,
  db: D1Database,
  route: string,
): Promise<Response> {
  if (route === "/api/hub/session") {
    return request.method === "POST" ? createSession(request, db) : methodNotAllowed("POST");
  }
  if (route === "/api/hub/sync") {
    return request.method === "POST" ? syncSession(request, db) : methodNotAllowed("POST");
  }
  if (route === "/api/hub/heartbeat") {
    return request.method === "POST" ? heartbeat(request, db) : methodNotAllowed("POST");
  }
  if (route === "/api/hub/appearance") {
    return request.method === "PATCH" ? updateAppearance(request, db) : methodNotAllowed("PATCH");
  }
  if (route === "/api/hub/leave") {
    return request.method === "POST" ? leaveSession(request, db) : methodNotAllowed("POST");
  }
  return request.method === "GET" ? health(db) : methodNotAllowed("GET");
}

export async function handleHubRequest(request: Request, env: HubD1Env): Promise<Response> {
  try {
    if (!env.DB) {
      return json({ error: "hub_unavailable", message: "The plaza database is unavailable.", retryable: true }, 503);
    }
    const db = env.DB;
    const route = new URL(request.url).pathname.replace(/\/+$/, "");
    const knownRoute = [
      "/api/hub/session",
      "/api/hub/sync",
      "/api/hub/heartbeat",
      "/api/hub/appearance",
      "/api/hub/leave",
      "/api/hub/health",
    ].includes(route);
    if (!knownRoute) return json({ error: "not_found" }, 404);
    if (route !== "/api/hub/health" && !sameOriginOrAbsent(request)) {
      return json({ error: "invalid_origin", message: "Origin does not match." }, 403);
    }
    await ensureSchema(db);
    const retryRequest = (request.body === null ? request : request.clone()) as Request;
    try {
      return await dispatchHubRequest(request, db, route);
    } catch (error) {
      if (!isMissingHubSchemaError(error)) throw error;
      // Local D1 can be recreated while Vite keeps this Worker isolate alive.
      // Rebuild only the missing hub schema and replay the request once; never
      // delete or replace the rest of the shared database.
      schemaReady.delete(db as object);
      await ensureSchema(db);
      return dispatchHubRequest(retryRequest, db, route);
    }
  } catch (error) {
    if (error instanceof HubProblem) {
      return json(
        { error: error.code, message: error.message, ...(error.retryable ? { retryable: true } : {}) },
        error.status,
        error.retryable ? { "retry-after": "1" } : undefined,
      );
    }
    return json(
      { error: "hub_storage_error", message: "The plaza is temporarily unavailable.", retryable: true },
      503,
      { "retry-after": "1" },
    );
  }
}

export const HUB_D1_SERVER_RULES = {
  maxBodyBytes: MAX_BODY_BYTES,
  maxMoveStepMs: MAX_MOVE_STEP_MS,
  staleSessionRetentionMs: STALE_SESSION_RETENTION_MS,
  maxNearbyPlayers: MAX_NEARBY_PLAYERS,
  movementRatePerSecond: 40,
  oneLiveSessionPerAccount: true,
  clientPositionAccepted: false,
  rawAccountIdExposed: false,
} as const;
