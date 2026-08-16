/// <reference types="@cloudflare/workers-types" />

import {
  DEFAULT_HUB_APPEARANCE,
  HUB_DASH_COOLDOWN_MS,
  HUB_DASH_DISTANCE,
  HUB_DASH_SWEEP_STEP_PX,
  HUB_HEARTBEAT_INTERVAL_MS,
  HUB_MAP_VERSION,
  HUB_MAX_DUNGEON_FLOOR,
  HUB_NEARBY_RADIUS,
  HUB_ONLINE_WINDOW_MS,
  HUB_PLAYER_RADIUS,
  HUB_PLAYER_SPEED,
  HUB_PORTALS,
  HUB_SESSION_TTL_MS,
  HUB_SPAWN_POINTS,
  HUB_ZONE_ID,
  normalizeHubAppearance,
  normalizeHubDungeonFloor,
  normalizeHubStoredAppearanceEnvelope,
  parseHubAppearanceRequest,
  parseHubCharacterProfileRequest,
  parseHubMoveIntent,
  parseHubSessionRequest,
  type HubAppearance,
  type HubCharacterSlot,
  type HubFacing,
  type HubPlayerSnapshot,
} from "../app/hub-protocol";
import {
  isCharacterNicknameSlot,
  validateCharacterNickname,
} from "../app/character-nickname";
import { resolvePlazaSweptMovement } from "../app/plaza-world";

export type HubD1Env = {
  DB?: D1Database;
};

type CharacterRow = {
  public_character_id: string;
  nickname: string | null;
  nickname_key: string | null;
};

type CharacterRosterRow = CharacterRow & {
  slot: number;
};

type SessionRow = {
  id: string;
  account_id: string;
  character_slot: number;
  public_character_id: string;
  display_name: string;
  level: number;
  dungeon_floor: number;
  appearance_json: string;
  zone: string;
  x: number;
  y: number;
  facing: number;
  moving: number;
  last_sequence: number;
  last_move_at: number;
  last_dash_at: number;
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
  | "dungeon_floor"
  | "appearance_json"
  | "x"
  | "y"
  | "facing"
  | "moving"
  | "updated_at"
>;

const MAX_BODY_BYTES = 24 * 1_024;
const MAX_MOVE_STEP_MS = 250;
const STALE_SESSION_RETENTION_MS = 60_000;
const GUEST_CHARACTER_ORPHAN_GRACE_MS = 30_000;
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
  const setup = (async () => {
    await db.batch([
      db.prepare(`CREATE TABLE IF NOT EXISTS hub_character_slots (
        account_id TEXT NOT NULL,
        slot INTEGER NOT NULL CHECK (slot BETWEEN 1 AND 3),
        public_character_id TEXT NOT NULL UNIQUE,
        nickname TEXT,
        nickname_key TEXT,
        nickname_claimed_at INTEGER,
        identity_version INTEGER NOT NULL DEFAULT 0,
        level INTEGER NOT NULL CHECK (level BETWEEN 1 AND 999),
        dungeon_floor INTEGER NOT NULL DEFAULT 1 CHECK (dungeon_floor BETWEEN 1 AND ${HUB_MAX_DUNGEON_FLOOR}),
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
        dungeon_floor INTEGER NOT NULL DEFAULT 1 CHECK (dungeon_floor BETWEEN 1 AND ${HUB_MAX_DUNGEON_FLOOR}),
        appearance_json TEXT NOT NULL,
        zone TEXT NOT NULL DEFAULT 'memory-plaza-v1',
        x REAL NOT NULL,
        y REAL NOT NULL,
        facing INTEGER NOT NULL CHECK (facing BETWEEN 0 AND 7),
        moving INTEGER NOT NULL DEFAULT 0 CHECK (moving IN (0, 1)),
        last_sequence INTEGER NOT NULL DEFAULT 0,
        last_move_at INTEGER NOT NULL,
        last_dash_at INTEGER NOT NULL DEFAULT 0,
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
    ]);

    // The worker also self-heals local/legacy D1 databases that predate the
    // display-only dungeon-floor claim. Production still receives the matching
    // numbered migration; this path prevents CREATE IF NOT EXISTS from leaving
    // an old table shape behind during local recovery.
    for (const table of ["hub_character_slots", "hub_sessions"] as const) {
      const columns = await db.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>();
      if ((columns.results ?? []).some((column) => column.name === "dungeon_floor")) {
        continue;
      }
      try {
        await db.prepare(
          `ALTER TABLE ${table} ADD COLUMN dungeon_floor INTEGER NOT NULL DEFAULT 1 CHECK (dungeon_floor BETWEEN 1 AND ${HUB_MAX_DUNGEON_FLOOR})`,
        ).run();
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        if (!/duplicate column name:\s*dungeon_floor/i.test(message)) throw error;
      }
    }

    const sessionColumns = await db.prepare(`PRAGMA table_info(hub_sessions)`).all<{ name: string }>();
    if (!(sessionColumns.results ?? []).some((column) => column.name === "last_dash_at")) {
      try {
        await db.prepare(
          `ALTER TABLE hub_sessions ADD COLUMN last_dash_at INTEGER NOT NULL DEFAULT 0`,
        ).run();
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        if (!/duplicate column name:\s*last_dash_at/i.test(message)) throw error;
      }
    }

    const characterColumns = await db
      .prepare(`PRAGMA table_info(hub_character_slots)`)
      .all<{ name: string }>();
    const existingCharacterColumns = new Set(
      (characterColumns.results ?? []).map((column) => column.name),
    );
    const missingCharacterColumns = [
      ["nickname", "TEXT"],
      ["nickname_key", "TEXT"],
      ["nickname_claimed_at", "INTEGER"],
      ["identity_version", "INTEGER NOT NULL DEFAULT 0"],
    ] as const;
    const upgradedCharacterIdentity = missingCharacterColumns.some(
      ([column]) => !existingCharacterColumns.has(column),
    );
    for (const [column, definition] of missingCharacterColumns) {
      if (existingCharacterColumns.has(column)) continue;
      try {
        await db
          .prepare(
            `ALTER TABLE hub_character_slots ADD COLUMN ${column} ${definition}`,
          )
          .run();
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        if (!new RegExp(`duplicate column name:\\s*${column}`, "i").test(message)) {
          throw error;
        }
      }
    }
    await db
      .prepare(
        `CREATE UNIQUE INDEX IF NOT EXISTS hub_character_nickname_key
          ON hub_character_slots(nickname_key)
          WHERE nickname_key IS NOT NULL`,
      )
      .run();
    if (upgradedCharacterIdentity) {
      // Match the numbered migration: sessions created before character-bound
      // nicknames still contain account display labels and must not survive.
      await db.prepare(`DELETE FROM hub_sessions`).run();
    }
  })().catch((error: unknown) => {
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
        AND created_at<?
        AND NOT EXISTS (
          SELECT 1 FROM hub_sessions WHERE hub_sessions.account_id=hub_character_slots.account_id
        )`).bind(now - GUEST_CHARACTER_ORPHAN_GRACE_MS),
    db.prepare(`DELETE FROM hub_rate_limits WHERE window_started_at<? AND (blocked_until IS NULL OR blocked_until<?)`)
      .bind(now - HUB_SESSION_TTL_MS, now),
  ]);
}

function parseAppearanceJson(value: string): HubAppearance {
  try {
    return normalizeHubStoredAppearanceEnvelope(JSON.parse(value) as unknown).appearance;
  } catch {
    return normalizeHubAppearance(DEFAULT_HUB_APPEARANCE);
  }
}

function parseStoredAppearanceJson(value: string) {
  try {
    return normalizeHubStoredAppearanceEnvelope(JSON.parse(value) as unknown);
  } catch {
    return normalizeHubStoredAppearanceEnvelope(DEFAULT_HUB_APPEARANCE);
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
    dungeonFloor: normalizeHubDungeonFloor(row.dungeon_floor),
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
      id,character_slot,public_character_id,display_name,level,dungeon_floor,appearance_json,
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
  dash: boolean,
  facing: HubFacing,
): { x: number; y: number } {
  const seconds = clamp(elapsedMs, 0, MAX_MOVE_STEP_MS) / 1_000;
  let position = resolvePlazaSweptMovement(
    { x: currentX, y: currentY },
    { x: moveX * HUB_PLAYER_SPEED * seconds, y: moveY * HUB_PLAYER_SPEED * seconds },
    HUB_PLAYER_RADIUS,
    HUB_DASH_SWEEP_STEP_PX,
  );
  if (!dash) return position;

  const direction = resolveDashDirection(moveX, moveY, facing);
  position = resolvePlazaSweptMovement(
    position,
    {
      x: direction.x * HUB_DASH_DISTANCE,
      y: direction.y * HUB_DASH_DISTANCE,
    },
    HUB_PLAYER_RADIUS,
    HUB_DASH_SWEEP_STEP_PX,
  );
  return position;
}

function resolveDashDirection(
  moveX: number,
  moveY: number,
  facing: HubFacing,
): { x: number; y: number } {
  const magnitude = Math.hypot(moveX, moveY);
  if (magnitude >= 0.05) {
    return { x: moveX / magnitude, y: moveY / magnitude };
  }
  const diagonal = Math.SQRT1_2;
  return ([
    { x: 0, y: 1 },
    { x: -diagonal, y: diagonal },
    { x: -1, y: 0 },
    { x: -diagonal, y: -diagonal },
    { x: 0, y: -1 },
    { x: diagonal, y: -diagonal },
    { x: 1, y: 0 },
    { x: diagonal, y: diagonal },
  ] as const)[facing];
}

function nicknameValidationProblem(
  validation: Exclude<
    ReturnType<typeof validateCharacterNickname>,
    { ok: true }
  >,
): HubProblem {
  return new HubProblem(
    400,
    validation.code,
    "The character nickname does not satisfy the creation rules.",
  );
}

function isNicknameUniqueConstraint(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /UNIQUE constraint failed:\s*hub_character_slots\.nickname_key/i.test(
    message,
  );
}

async function characterRoster(
  request: Request,
  db: D1Database,
): Promise<Response> {
  const accountId = trustedAccountId(request);
  const url = new URL(request.url);
  const requestedNickname = url.searchParams.get("nickname");

  if (requestedNickname !== null) {
    const validation = validateCharacterNickname(requestedNickname);
    if (!validation.ok) throw nicknameValidationProblem(validation);
    const requestedSlot = Number(url.searchParams.get("slot"));
    if (!isCharacterNicknameSlot(requestedSlot)) {
      throw new HubProblem(
        400,
        "invalid_character_slot",
        "Choose character slot 1, 2, or 3.",
      );
    }
    const rateSubject =
      accountId ??
      `guest:${await sha256(
        request.headers.get("cf-connecting-ip") ?? url.hostname,
      )}`;
    await enforceRateLimit(db, rateSubject, "nickname-check", 30, 60_000, 60_000);
    const existing = await db
      .prepare(
        `SELECT account_id,slot FROM hub_character_slots
          WHERE nickname_key=? LIMIT 1`,
      )
      .bind(validation.nicknameKey)
      .first<{ account_id: string; slot: number }>();
    const available =
      !existing ||
      (accountId !== null &&
        existing.account_id === accountId &&
        existing.slot === requestedSlot);
    return json({
      available,
      authority: accountId === null ? "device" : "account",
    });
  }

  if (!accountId) {
    throw new HubProblem(
      401,
      "account_required",
      "Link Steam before synchronizing account character nicknames.",
    );
  }
  await enforceRateLimit(db, accountId, "character-roster", 20, 60_000, 60_000);
  const rows = await db
    .prepare(
      `SELECT slot,public_character_id,nickname,nickname_key
        FROM hub_character_slots
        WHERE account_id=? AND nickname IS NOT NULL
        ORDER BY slot ASC`,
    )
    .bind(accountId)
    .all<CharacterRosterRow>();
  return json({
    characters: (rows.results ?? []).flatMap((row) => {
      const validation = validateCharacterNickname(row.nickname);
      return isCharacterNicknameSlot(row.slot) &&
        validation.ok &&
        row.nickname_key === validation.nicknameKey
        ? [{
            slot: row.slot,
            publicCharacterId: row.public_character_id,
            nickname: validation.nickname,
          }]
        : [];
    }),
  });
}

async function claimCharacterNickname(
  request: Request,
  db: D1Database,
): Promise<Response> {
  const accountId = trustedAccountId(request);
  if (!accountId) {
    throw new HubProblem(
      401,
      "account_required",
      "Link Steam before reserving an account character nickname.",
    );
  }
  const body = await readJson(request);
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new HubProblem(400, "nickname_invalid", "A nickname claim is required.");
  }
  const record = body as Record<string, unknown>;
  if (!isCharacterNicknameSlot(record.slot)) {
    throw new HubProblem(
      400,
      "invalid_character_slot",
      "Choose character slot 1, 2, or 3.",
    );
  }
  const validation = validateCharacterNickname(record.nickname);
  if (!validation.ok) throw nicknameValidationProblem(validation);
  await enforceRateLimit(db, accountId, "nickname-claim", 10, 60_000, 60_000);

  const now = Date.now();
  const publicCharacterId = crypto.randomUUID();
  const initialAppearanceJson = JSON.stringify({
    appearance: DEFAULT_HUB_APPEARANCE,
    publicEquipment: null,
  });
  let character: CharacterRow | null = null;
  try {
    character = await db
      .prepare(
        `INSERT INTO hub_character_slots
          (account_id,slot,public_character_id,nickname,nickname_key,
           nickname_claimed_at,identity_version,level,dungeon_floor,
           appearance_json,created_at,updated_at)
        VALUES(?,?,?,?,?,?,1,1,1,?,?,?)
        ON CONFLICT(account_id,slot) DO UPDATE SET
          nickname=CASE
            WHEN hub_character_slots.nickname_key IS NULL
              THEN excluded.nickname
            ELSE hub_character_slots.nickname
          END,
          nickname_key=CASE
            WHEN hub_character_slots.nickname_key IS NULL
              THEN excluded.nickname_key
            ELSE hub_character_slots.nickname_key
          END,
          nickname_claimed_at=COALESCE(
            hub_character_slots.nickname_claimed_at,
            excluded.nickname_claimed_at
          ),
          identity_version=CASE
            WHEN hub_character_slots.nickname_key IS NULL
              THEN hub_character_slots.identity_version+1
            ELSE hub_character_slots.identity_version
          END,
          updated_at=excluded.updated_at
        WHERE hub_character_slots.nickname_key IS NULL
           OR hub_character_slots.nickname_key=excluded.nickname_key
        RETURNING public_character_id,nickname,nickname_key`,
      )
      .bind(
        accountId,
        record.slot,
        publicCharacterId,
        validation.nickname,
        validation.nicknameKey,
        now,
        initialAppearanceJson,
        now,
        now,
      )
      .first<CharacterRow>();
  } catch (error) {
    if (isNicknameUniqueConstraint(error)) {
      throw new HubProblem(
        409,
        "nickname_taken",
        "That character nickname is already in use.",
      );
    }
    throw error;
  }
  if (!character) {
    throw new HubProblem(
      409,
      "slot_occupied",
      "This character slot already owns another nickname.",
    );
  }
  return json({
    slot: record.slot,
    publicCharacterId: character.public_character_id,
    nickname: character.nickname,
  });
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

  const appearanceJson = JSON.stringify({
    appearance: parsed.appearance,
    publicEquipment: parsed.publicEquipment,
  });
  let character: CharacterRow | null;
  let characterDisplayName: string;
  if (authenticatedAccountId) {
    character = await db
      .prepare(
        `SELECT public_character_id,nickname,nickname_key
          FROM hub_character_slots WHERE account_id=? AND slot=? LIMIT 1`,
      )
      .bind(accountId, parsed.characterSlot)
      .first<CharacterRow>();
    const storedNickname = validateCharacterNickname(character?.nickname);
    if (
      !character ||
      !storedNickname.ok ||
      character.nickname_key !== storedNickname.nicknameKey
    ) {
      throw new HubProblem(
        409,
        "nickname_required",
        "Create this character's nickname before entering the plaza.",
      );
    }
    characterDisplayName = storedNickname.nickname;
    await db
      .prepare(
        `UPDATE hub_character_slots
          SET level=?,dungeon_floor=?,appearance_json=?,updated_at=?
          WHERE account_id=? AND slot=?`,
      )
      .bind(
        parsed.level,
        parsed.dungeonFloor,
        appearanceJson,
        now,
        accountId,
        parsed.characterSlot,
      )
      .run();
  } else {
    const guestNickname = validateCharacterNickname(parsed.displayName);
    if (!guestNickname.ok) throw nicknameValidationProblem(guestNickname);
    characterDisplayName = guestNickname.nickname;
    const guestNicknameKey = guestNickname.nicknameKey;
    const generatedCharacterId = crypto.randomUUID();
    try {
      character = await db
        .prepare(
          `INSERT INTO hub_character_slots
            (account_id,slot,public_character_id,nickname,nickname_key,
             nickname_claimed_at,identity_version,level,dungeon_floor,
             appearance_json,created_at,updated_at)
          VALUES(?,?,?,?,?,?,1,?,?,?,?,?)
          RETURNING public_character_id,nickname,nickname_key`,
        )
        .bind(
          accountId,
          parsed.characterSlot,
          generatedCharacterId,
          characterDisplayName,
          guestNicknameKey,
          now,
          parsed.level,
          parsed.dungeonFloor,
          appearanceJson,
          now,
          now,
        )
        .first<CharacterRow>();
    } catch (error) {
      if (isNicknameUniqueConstraint(error)) {
        throw new HubProblem(
          409,
          "nickname_taken",
          "That character nickname is already in use.",
        );
      }
      throw error;
    }
  }
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
       level,dungeon_floor,appearance_json,zone,x,y,facing,moving,last_sequence,
       last_move_at,last_dash_at,last_seen_at,expires_at,version,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,0,0,?,0,?,?,0,?,?)
    ON CONFLICT(account_id) DO UPDATE SET
      id=excluded.id,token_hash=excluded.token_hash,character_slot=excluded.character_slot,
      public_character_id=excluded.public_character_id,display_name=excluded.display_name,
      level=excluded.level,dungeon_floor=excluded.dungeon_floor,
      appearance_json=excluded.appearance_json,zone=excluded.zone,
      x=excluded.x,y=excluded.y,facing=excluded.facing,moving=0,last_sequence=0,
      last_move_at=excluded.last_move_at,last_dash_at=0,last_seen_at=excluded.last_seen_at,
      expires_at=excluded.expires_at,version=hub_sessions.version+1,
      created_at=excluded.created_at,updated_at=excluded.updated_at`)
    .bind(
      playerId,
      tokenHash,
      accountId,
      parsed.characterSlot,
      character.public_character_id,
      characterDisplayName,
      parsed.level,
      parsed.dungeonFloor,
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
    const dashAccepted =
      intent.dash && now - row.last_dash_at >= HUB_DASH_COOLDOWN_MS;
    const position = resolveAuthoritativePosition(
      row.x,
      row.y,
      intent.moveX,
      intent.moveY,
      now - row.last_move_at,
      dashAccepted,
      intent.facing,
    );
    const moving = Math.hypot(intent.moveX, intent.moveY) >= 0.05 || dashAccepted ? 1 : 0;
    const updated = await db.prepare(`UPDATE hub_sessions SET
        x=?,y=?,facing=?,moving=?,last_sequence=?,last_move_at=?,last_dash_at=?,last_seen_at=?,
        expires_at=?,version=version+1,updated_at=?
      WHERE id=? AND account_id=? AND version=? AND last_sequence<?`)
      .bind(
        position.x,
        position.y,
        intent.facing,
        moving,
        intent.sequence,
        now,
        dashAccepted ? now : row.last_dash_at,
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
  const dungeonFloor = normalizeHubDungeonFloor(
    parsed.dungeonFloor ?? row.dungeon_floor,
  );
  const stored = parseStoredAppearanceJson(row.appearance_json);
  const appearanceJson = JSON.stringify({
    appearance: parsed.appearance,
    publicEquipment: parsed.publicEquipment ?? stored.publicEquipment,
  });
  await db.batch([
    db.prepare(`UPDATE hub_character_slots SET level=?,dungeon_floor=?,appearance_json=?,updated_at=?
      WHERE account_id=? AND slot=?`)
      .bind(parsed.level, dungeonFloor, appearanceJson, now, accountId, row.character_slot),
    db.prepare(`UPDATE hub_sessions SET level=?,dungeon_floor=?,appearance_json=?,last_seen_at=?,
      version=version+1,updated_at=? WHERE id=? AND account_id=?`)
      .bind(parsed.level, dungeonFloor, appearanceJson, now, now, row.id, accountId),
  ]);
  const current = await sessionByToken(db, request);
  return json(await snapshotEnvelope(db, current, now));
}

async function inspectCharacterProfile(request: Request, db: D1Database): Promise<Response> {
  const parsed = parseHubCharacterProfileRequest(await readJson(request));
  if (!parsed) {
    throw new HubProblem(400, "invalid_character_id", "A valid plaza character is required.");
  }
  const self = await sessionByToken(db, request);
  await enforceRateLimit(db, self.account_id, "profile", 24, 60_000, 10_000);
  const now = Date.now();
  const target = await db.prepare(`SELECT * FROM hub_sessions
    WHERE public_character_id=? AND zone=? AND last_seen_at>=? AND expires_at>?
      AND x BETWEEN ? AND ? AND y BETWEEN ? AND ?
    LIMIT 1`)
    .bind(
      parsed.characterId,
      self.zone,
      now - HUB_ONLINE_WINDOW_MS,
      now,
      self.x - HUB_NEARBY_RADIUS,
      self.x + HUB_NEARBY_RADIUS,
      self.y - HUB_NEARBY_RADIUS,
      self.y + HUB_NEARBY_RADIUS,
    )
    .first<SessionRow>();
  if (!target) {
    throw new HubProblem(404, "character_not_available", "That character is not available nearby.");
  }
  const dx = target.x - self.x;
  const dy = target.y - self.y;
  if (dx * dx + dy * dy > HUB_NEARBY_RADIUS * HUB_NEARBY_RADIUS) {
    throw new HubProblem(404, "character_not_available", "That character is not available nearby.");
  }
  const stored = parseStoredAppearanceJson(target.appearance_json);
  return json({
    characterId: target.public_character_id,
    displayName: target.display_name,
    level: clamp(Math.floor(target.level), 1, 999),
    dungeonFloor: normalizeHubDungeonFloor(target.dungeon_floor),
    publicEquipment: stored.publicEquipment,
    updatedAt: target.updated_at,
  });
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
  if (route === "/api/hub/characters") {
    if (request.method === "GET") return characterRoster(request, db);
    if (request.method === "POST") return claimCharacterNickname(request, db);
    return methodNotAllowed("GET, POST");
  }
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
  if (route === "/api/hub/profile") {
    return request.method === "POST" ? inspectCharacterProfile(request, db) : methodNotAllowed("POST");
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
      "/api/hub/characters",
      "/api/hub/session",
      "/api/hub/sync",
      "/api/hub/heartbeat",
      "/api/hub/appearance",
      "/api/hub/profile",
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
