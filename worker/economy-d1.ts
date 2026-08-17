/// <reference types="@cloudflare/workers-types" />

import {
  canonicalizeJson,
  computeCanonicalRequestHash,
  parseAdminEconomyRequest,
  parseEconomyCommand,
  parseMarketQuery,
  parsePaymentCheckoutRequest,
  parsePaymentFinalizeRequest,
  parseSteamTransactionItems,
  steamTransactionDisposition,
  verifyEconomyCommandHash,
  type EconomyCommand,
  type ItemMarketQuery,
  type ListCharacterItemCommand,
  type SteamTransactionItem,
} from "../app/economy-protocol";
import { normalizeGearItem, type GearItem } from "../app/equipment";
import { ensureEconomyTriggers } from "./economy-trigger-installer";
import {
  EconomySchemaMissingError,
  ensureEconomySchema,
  resetEconomySchemaReadiness,
} from "./economy-schema";

export type EconomyD1Env = {
  DB?: D1Database;
  ECONOMY_LIVE_ENABLED?: string;
  ECONOMY_PAYMENTS_ENABLED?: string;
  PVP_ACCOUNT_AUTH_ENABLED?: string;
  ECONOMY_ACCOUNT_PEPPER?: string;
  ECONOMY_ADMIN_KEY?: string;
  STEAM_PUBLISHER_KEY?: string;
  STEAM_APP_ID?: string;
  STEAM_MICROTXN_SANDBOX?: string;
};

type AccountRow = {
  id: string;
  display_name: string;
  status: string;
  steam_ownership_verified: number;
  trade_eligible: number;
  wallet_frozen: number;
  auth_epoch: number;
  created_at: number;
  steam_id?: string | null;
  steam_verified_at?: number | null;
};

type WalletRow = {
  ash_available: number;
  ash_reserved: number;
  gold_available: number;
  gold_reserved: number;
  gold_locked: number;
  version: number;
};

type CommandRow = {
  id: string;
  request_hash: string;
  action: string;
  result_ref_id: string;
};

type CharacterItemRow = {
  id: string;
  owner_account_id: string;
  state: string;
  item_json: string;
  version: number;
};

type AuthContext = {
  account: AccountRow;
  development: boolean;
  steamId: string | null;
};

const SESSION_COOKIE = "mujindo_economy_session";
const STEAM_STATE_COOKIE = "mujindo_steam_state";
const GOLD_HOLD_MS = 72 * 60 * 60 * 1_000;
const SESSION_TTL_MS = 12 * 60 * 60 * 1_000;
const STEAM_OWNERSHIP_TTL_MS = SESSION_TTL_MS;
const MAX_BODY_BYTES = 64 * 1024;
const DEV_ACCOUNT_IDS = {
  A: "00000000-0000-4000-8000-00000000000a",
  B: "00000000-0000-4000-8000-00000000000b",
} as const;
const PRODUCT_CATALOG = {
  // Steam MicroTxn amounts are hundredths of a currency unit. KRW is reported
  // in jeon, so ₩1,100 must be sent as 110,000 (and in 1,000-jeon steps).
  "gold-10": { itemId: "10010", gold: 10, amountHundredths: 110_000, currency: "KRW", description: "금괴 10개" },
  "gold-55": { itemId: "10055", gold: 55, amountHundredths: 550_000, currency: "KRW", description: "금괴 55개" },
  "gold-120": { itemId: "10120", gold: 120, amountHundredths: 1_100_000, currency: "KRW", description: "금괴 120개" },
  "gold-390": { itemId: "10390", gold: 390, amountHundredths: 3_300_000, currency: "KRW", description: "금괴 390개" },
} as const;
const TERMINAL_PAYMENT_STATUSES = new Set(["failed", "refunded", "chargeback", "reversed"]);
// This must be changed only together with a deployed GetReport/refund/
// chargeback reconciler and tested lot-clawback/debt workflow. Until then,
// production Steam money can never be enabled by configuration alone.
const CHARGEBACK_RECONCILIATION_READY = false;

function steamPaymentsEnabled(env: EconomyD1Env): boolean {
  return env.ECONOMY_PAYMENTS_ENABLED === "true" &&
    (env.STEAM_MICROTXN_SANDBOX === "true" || CHARGEBACK_RECONCILIATION_READY);
}

function assertSteamPaymentsEnabled(env: EconomyD1Env): void {
  if (env.ECONOMY_PAYMENTS_ENABLED !== "true") {
    throw new EconomyProblem(423, "PAYMENTS_CLOSED", "실결제 운영 스위치가 잠겨 있습니다.");
  }
  if (env.STEAM_MICROTXN_SANDBOX !== "true" && !CHARGEBACK_RECONCILIATION_READY) {
    throw new EconomyProblem(423, "PAYMENT_RECONCILIATION_NOT_READY", "환불·차지백 대사 체계가 준비되지 않아 실제 결제를 열 수 없습니다.");
  }
}

class EconomyProblem extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
  }
}

const json = (body: unknown, status = 200, extra?: HeadersInit): Response => {
  const headers = new Headers(extra);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store, private");
  headers.set("x-content-type-options", "nosniff");
  headers.set("referrer-policy", "no-referrer");
  return new Response(JSON.stringify(body), { status, headers });
};

const success = (data: unknown, requestId: string, replayed = false): Response =>
  json({ ok: true, requestId, replayed, serverTime: Date.now(), data });

async function steamFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  try {
    return await fetch(input, { ...init, signal: AbortSignal.timeout(8_000) });
  } catch {
    throw new EconomyProblem(503, "STEAM_TIMEOUT", "Steam 서버 응답 시간이 초과되었습니다.", true);
  }
}

const uuid = (): string => crypto.randomUUID();
const toHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return toHex(new Uint8Array(digest));
}

async function hmacSha256(key: string, value: string): Promise<string> {
  const imported = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return toHex(new Uint8Array(await crypto.subtle.sign("HMAC", imported, new TextEncoder().encode(value))));
}

async function constantTimeSecretEqual(left: string, right: string): Promise<boolean> {
  const [leftHash, rightHash] = await Promise.all([sha256(left), sha256(right)]);
  let difference = leftHash.length ^ rightHash.length;
  const length = Math.max(leftHash.length, rightHash.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (leftHash.charCodeAt(index) || 0) ^ (rightHash.charCodeAt(index) || 0);
  }
  return difference === 0;
}

function isLocalHost(url: URL): boolean {
  return url.hostname === "localhost" ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "::1" ||
    url.hostname === "[::1]";
}

function sameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return request.headers.get("sec-fetch-site") === "same-origin";
  try {
    return new URL(origin).origin === new URL(request.url).origin;
  } catch {
    return false;
  }
}

async function rateLimitSubject(request: Request, env: EconomyD1Env): Promise<string> {
  const url = new URL(request.url);
  const address = isLocalHost(url) ? "localhost" : (request.headers.get("cf-connecting-ip") ?? "missing-edge-ip");
  return env.ECONOMY_ACCOUNT_PEPPER
    ? hmacSha256(env.ECONOMY_ACCOUNT_PEPPER, `rate:${address}`)
    : sha256(`development-rate:${address}`);
}

async function enforceRateLimit(
  db: D1Database,
  subjectKey: string,
  bucket: string,
  limit: number,
  windowMs: number,
  blockMs: number,
): Promise<void> {
  const now = Date.now();
  const resetBefore = now - windowMs;
  const row = await db.prepare(`INSERT INTO economy_rate_limits(subject_key,bucket,window_started_at,request_count,blocked_until)
    VALUES(?,?,?,1,NULL)
    ON CONFLICT(subject_key,bucket) DO UPDATE SET
      request_count=CASE WHEN economy_rate_limits.window_started_at<=? THEN 1 ELSE economy_rate_limits.request_count+1 END,
      window_started_at=CASE WHEN economy_rate_limits.window_started_at<=? THEN excluded.window_started_at ELSE economy_rate_limits.window_started_at END,
      blocked_until=CASE
        WHEN economy_rate_limits.blocked_until>excluded.window_started_at THEN economy_rate_limits.blocked_until
        WHEN economy_rate_limits.window_started_at<=? THEN NULL
        WHEN economy_rate_limits.request_count+1>? THEN excluded.window_started_at+?
        ELSE NULL END
    RETURNING request_count,blocked_until`)
    .bind(subjectKey, bucket, now, resetBefore, resetBefore, resetBefore, limit, blockMs)
    .first<{ request_count: number; blocked_until: number | null }>();
  if (row?.blocked_until && row.blocked_until > now) {
    throw new EconomyProblem(429, "RATE_LIMITED", "요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.", true);
  }
}

async function enforceRequestRateLimit(
  request: Request,
  db: D1Database,
  env: EconomyD1Env,
  bucket: string,
  limit: number,
  windowMs: number,
  blockMs: number,
  accountId?: string,
): Promise<void> {
  await enforceRateLimit(db, `ip:${await rateLimitSubject(request, env)}`, bucket, limit, windowMs, blockMs);
  if (accountId) await enforceRateLimit(db, `account:${accountId}`, bucket, limit, windowMs, blockMs);
}

function cookieValue(request: Request, name: string): string | null {
  for (const member of (request.headers.get("cookie") ?? "").split(";")) {
    const [key, ...rest] = member.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}

async function readJson(request: Request): Promise<unknown> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    throw new EconomyProblem(413, "REQUEST_TOO_LARGE", "요청 본문이 너무 큽니다.");
  }
  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) {
    throw new EconomyProblem(413, "REQUEST_TOO_LARGE", "요청 본문이 너무 큽니다.");
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new EconomyProblem(400, "BAD_REQUEST", "올바른 JSON 요청이 필요합니다.");
  }
}

async function accountById(db: D1Database, id: string): Promise<AccountRow | null> {
  return db.prepare(
    `SELECT a.*, (SELECT provider_subject FROM economy_identities i
       WHERE i.account_id=a.id AND i.provider='steam' LIMIT 1) AS steam_id,
       (SELECT verified_at FROM economy_identities i
       WHERE i.account_id=a.id AND i.provider='steam' LIMIT 1) AS steam_verified_at
       FROM economy_accounts a WHERE a.id=? LIMIT 1`,
  ).bind(id).first<AccountRow>();
}

async function ensureDevelopmentAccount(
  db: D1Database,
  label: "A" | "B",
): Promise<AccountRow> {
  const now = Date.now();
  const accountId = DEV_ACCOUNT_IDS[label];
  const itemId = label === "A"
    ? "10000000-0000-4000-8000-00000000000a"
    : "10000000-0000-4000-8000-00000000000b";
  const seedGold = label === "A" ? 350 : 500;
  const seedGoldLotId = label === "A"
    ? "10000000-0000-4000-8000-00000000a0aa"
    : "10000000-0000-4000-8000-00000000b0bb";
  const itemJson = JSON.stringify({
    baseName: label === "A" ? "개발자의 기억검" : "검증자의 성갑",
    enhancement: label === "A" ? 3 : 1,
    powerScore: label === "A" ? 840 : 610,
    qualityScore: label === "A" ? 91 : 74,
    iconIndex: label === "A" ? 8 : 24,
    affixes: [
      { label: "공격력 +12.00%", value: "+12.00%" },
      { label: "치명타 확률 +6.00%", value: "+6.00%" },
    ],
  });
  await db.batch([
    db.prepare(`INSERT OR IGNORE INTO economy_accounts
      (id,display_name,status,steam_ownership_verified,trade_eligible,wallet_frozen,auth_epoch,risk_score,created_at,updated_at)
      VALUES(?,?, 'active',1,1,0,0,0,?,?)`).bind(accountId, `로컬 유저 ${label}`, now, now),
    db.prepare(`INSERT OR IGNORE INTO economy_identities
      (id,account_id,provider,provider_subject,ownership_permanent,verified_at,created_at)
      VALUES(?,?, 'development',?,1,?,?)`).bind(uuid(), accountId, label, now, now),
    db.prepare(`INSERT OR IGNORE INTO economy_wallets
      (account_id,ash_available,ash_reserved,gold_available,gold_reserved,gold_locked,version,updated_at)
      VALUES(?,?,0,?,0,0,0,?)`).bind(accountId, label === "A" ? 1_200_000 : 900_000, seedGold, now),
    db.prepare(`INSERT OR IGNORE INTO economy_gold_lots
      (id,account_id,source,source_id,amount,remaining,state,tradeable_at,released_at,created_at)
      VALUES(?,?, 'admin',?,?,?,'available',?,?,?)`)
      .bind(seedGoldLotId, accountId, `development-seed-gold-${label}`, seedGold, seedGold, now, now, now),
    db.prepare(`INSERT OR IGNORE INTO economy_items
      (id,owner_account_id,state,tradeable,provenance,origin_id,slot,rarity,item_level,display_name,item_json,version,created_at,updated_at)
      VALUES(?,?, 'inventory',1,'development',?,'weapon','legendary',70,?,?,0,?,?)`)
      .bind(itemId, accountId, `dev-${label}-item`, label === "A" ? "개발자의 기억검" : "검증자의 성갑", itemJson, now, now),
  ]);
  const account = await accountById(db, accountId);
  if (!account) throw new EconomyProblem(503, "STORAGE_ERROR", "개발 계정을 만들지 못했습니다.", true);
  return account;
}

async function findSessionAccount(db: D1Database, token: string): Promise<AccountRow | null> {
  if (!/^[A-Za-z0-9_-]{43,160}$/.test(token)) return null;
  const tokenHash = await sha256(token);
  return db.prepare(
    `SELECT a.*, (SELECT provider_subject FROM economy_identities i WHERE i.account_id=a.id AND i.provider='steam' LIMIT 1) AS steam_id,
       (SELECT verified_at FROM economy_identities i WHERE i.account_id=a.id AND i.provider='steam' LIMIT 1) AS steam_verified_at
       FROM economy_sessions s JOIN economy_accounts a ON a.id=s.account_id
      WHERE s.token_hash=? AND s.revoked_at IS NULL AND s.expires_at>? AND s.auth_epoch=a.auth_epoch LIMIT 1`,
  ).bind(tokenHash, Date.now()).first<AccountRow>();
}

async function authenticate(
  request: Request,
  db: D1Database,
): Promise<AuthContext> {
  const url = new URL(request.url);
  const devLabel = request.headers.get("x-mujindo-internal-dev-user");
  if (isLocalHost(url) && (devLabel === "A" || devLabel === "B")) {
    return { account: await ensureDevelopmentAccount(db, devLabel), development: true, steamId: `dev-${devLabel}` };
  }
  const token = cookieValue(request, SESSION_COOKIE);
  if (token) {
    const account = await findSessionAccount(db, token);
    if (account) return { account, development: false, steamId: account.steam_id ?? null };
  }
  throw new EconomyProblem(401, "UNAUTHENTICATED", "거래소 로그인이 필요합니다.");
}

function assertWriteAllowed(request: Request, env: EconomyD1Env, auth: AuthContext): void {
  if (!sameOrigin(request)) throw new EconomyProblem(403, "INVALID_ORIGIN", "동일 출처 요청만 허용됩니다.");
  if (auth.development) return;
  if (env.ECONOMY_LIVE_ENABLED !== "true") {
    throw new EconomyProblem(423, "MARKET_CLOSED", "운영 경제 런치 스위치가 잠겨 있습니다.");
  }
  if (!env.ECONOMY_ACCOUNT_PEPPER) {
    throw new EconomyProblem(503, "SECURITY_CONFIG_MISSING", "운영 계정 보안 키가 구성되지 않았습니다.");
  }
  if (
    !auth.account.steam_verified_at ||
    auth.account.steam_verified_at < Date.now() - STEAM_OWNERSHIP_TTL_MS
  ) {
    throw new EconomyProblem(403, "STEAM_OWNERSHIP_STALE", "Steam 소유권을 다시 확인해야 합니다.");
  }
  if (
    auth.account.status !== "active" ||
    auth.account.wallet_frozen !== 0 ||
    auth.account.steam_ownership_verified !== 1 ||
    auth.account.trade_eligible !== 1
  ) {
    throw new EconomyProblem(403, "TRADE_NOT_ELIGIBLE", "Steam 소유권 검증과 거래 자격이 필요합니다.");
  }
}

async function assertNoActiveSanction(
  db: D1Database,
  accountId: string,
  scopes: readonly string[],
): Promise<void> {
  const now = Date.now();
  const placeholders = scopes.map(() => "?").join(",");
  const sanction = await db.prepare(`SELECT scope FROM economy_sanctions
    WHERE account_id=? AND revoked_at IS NULL AND starts_at<=?
      AND (expires_at IS NULL OR expires_at>?) AND scope IN (${placeholders}) LIMIT 1`)
    .bind(accountId, now, now, ...scopes).first<{ scope: string }>();
  if (sanction) throw new EconomyProblem(403, "SANCTIONED", "현재 계정 제재로 이 작업을 수행할 수 없습니다.");
}

async function recordRiskEvent(
  db: D1Database,
  accountId: string,
  signal: string,
  severity: number,
  requestId: string,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  try {
    const now = Date.now();
    await db.batch([
      db.prepare(`INSERT INTO economy_risk_events(id,account_id,signal,severity,request_id,metadata_json,created_at) VALUES(?,?,?,?,?,?,?)`)
        .bind(uuid(), accountId, signal, severity, requestId, JSON.stringify(metadata), now),
      db.prepare(`UPDATE economy_accounts SET risk_score=MIN(10000,risk_score+?),updated_at=? WHERE id=?`)
        .bind(severity, now, accountId),
    ]);
  } catch {
    // Telemetry failure must not change the authoritative transaction result.
  }
}

async function releaseMatureGold(db: D1Database, accountId: string): Promise<void> {
  const now = Date.now();
  await db.prepare(`INSERT INTO economy_gold_release_commands(id,account_id,created_at)
    SELECT ?,?,? WHERE EXISTS(SELECT 1 FROM economy_gold_lots WHERE account_id=? AND state='locked' AND tradeable_at<=? AND remaining>0)`)
    .bind(uuid(), accountId, now, accountId, now).run();
}

async function expireAuctionListings(db: D1Database): Promise<void> {
  const now = Date.now();
  // A deterministic command id makes concurrent cleanup attempts idempotent.
  // The trigger returns escrow and writes its audit row in one transaction.
  await db.prepare(`INSERT OR IGNORE INTO economy_listing_expiry_commands(id,listing_id,created_at)
    SELECT 'expiry:' || expired.id,expired.id,?
      FROM (SELECT id FROM economy_listings WHERE status='open' AND expires_at<=? ORDER BY expires_at ASC LIMIT 100) AS expired`)
    .bind(now, now).run();
}

function parseItemJson(raw: string): Record<string, unknown> {
  try {
    const value = JSON.parse(raw) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function characterItemOrigin(accountId: string, item: GearItem): string {
  return `character:${accountId}:${item.id}`;
}

function normalizeCharacterItem(command: ListCharacterItemCommand): {
  item: GearItem;
  json: string;
} {
  const item = normalizeGearItem(command.characterItem);
  if (!item) {
    throw new EconomyProblem(
      400,
      "INVALID_CHARACTER_ITEM",
      "판매할 캐릭터 장비 데이터가 올바르지 않습니다.",
    );
  }
  return { item, json: canonicalizeJson(item) };
}

function assertMatchingCharacterItem(row: CharacterItemRow, canonicalJson: string): void {
  const stored = normalizeGearItem(parseItemJson(row.item_json));
  if (!stored || canonicalizeJson(stored) !== canonicalJson) {
    throw new EconomyProblem(
      409,
      "CHARACTER_ITEM_MISMATCH",
      "이미 거래소에 맡긴 장비와 현재 장비 데이터가 일치하지 않습니다.",
    );
  }
}

async function characterItemByOrigin(
  db: D1Database,
  originId: string,
): Promise<CharacterItemRow | null> {
  return db.prepare(`SELECT id,owner_account_id,state,item_json,version
      FROM economy_items WHERE provenance='server_drop' AND origin_id=? LIMIT 1`)
    .bind(originId)
    .first<CharacterItemRow>();
}

async function reconciliationResultRef(
  db: D1Database,
  row: CharacterItemRow,
): Promise<string> {
  const listing = await db.prepare(`SELECT id FROM economy_listings
      WHERE item_id=? AND status='open' ORDER BY created_at DESC LIMIT 1`)
    .bind(row.id)
    .first<{ id: string }>();
  return listing?.id ?? row.id;
}

function itemView(row: Record<string, unknown>) {
  const data = parseItemJson(String(row.item_json ?? "{}"));
  return {
    vaultItemId: String(row.id),
    itemId: String(row.id),
    displayName: String(row.display_name),
    baseName: String(data.baseName ?? row.display_name),
    rarity: String(row.rarity),
    slot: String(row.slot),
    level: Number(row.item_level),
    enhancement: Number(data.enhancement ?? 0),
    powerScore: Number(data.powerScore ?? 0),
    qualityScore: Number(data.qualityScore ?? 0),
    iconIndex: Number(data.iconIndex ?? 0),
    affixes: Array.isArray(data.affixes) ? data.affixes : [],
    tradeState: row.state === "inventory" ? "available" : row.state === "escrow" ? "listed" : "locked",
    lockedUntil: null,
    version: Number(row.version),
  };
}

function listingView(row: Record<string, unknown>, accountId: string) {
  const mine = row.seller_account_id === accountId;
  return {
    listingId: String(row.listing_id),
    // Internal account UUIDs are never public market identifiers. The client
    // only needs its own id to reconcile optimistic state; other sellers are
    // represented by their bounded display name.
    sellerUserId: mine ? accountId : "",
    sellerName: String(row.seller_name),
    item: itemView(row),
    priceAsh: Number(row.price_ash),
    listedAt: new Date(Number(row.listing_created_at)).toISOString(),
    expiresAt: new Date(Number(row.expires_at)).toISOString(),
    mine,
    version: Number(row.listing_version),
  };
}

function orderView(row: Record<string, unknown>, accountId: string) {
  return {
    orderId: String(row.id),
    side: row.side === "buy_gold" ? "buy" : "sell",
    priceAshPerGold: Number(row.price_ash_per_gold),
    goldAmount: Number(row.gold_initial),
    remainingGold: Number(row.gold_remaining),
    status: row.status === "partially_filled" ? "partial" : String(row.status),
    mine: row.account_id === accountId,
    createdAt: new Date(Number(row.created_at)).toISOString(),
    version: Number(row.version),
  };
}

async function queryListings(db: D1Database, query: ItemMarketQuery) {
  const where = ["l.status='open'", "l.expires_at>?"];
  const bindings: unknown[] = [Date.now()];
  if (query.search) {
    const escaped = query.search.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
    where.push("i.display_name LIKE ? ESCAPE '\\'");
    bindings.push(`%${escaped}%`);
  }
  if (query.slot) {
    where.push("i.slot=?");
    bindings.push(query.slot);
  }
  if (query.rarity) {
    where.push("i.rarity=?");
    bindings.push(query.rarity);
  }
  if (query.minLevel !== undefined) {
    where.push("i.item_level>=?");
    bindings.push(query.minLevel);
  }
  if (query.maxLevel !== undefined) {
    where.push("i.item_level<=?");
    bindings.push(query.maxLevel);
  }
  if (query.minPriceAsh !== undefined) {
    where.push("l.price_ash>=?");
    bindings.push(query.minPriceAsh);
  }
  if (query.maxPriceAsh !== undefined) {
    where.push("l.price_ash<=?");
    bindings.push(query.maxPriceAsh);
  }
  const orderBy: Record<ItemMarketQuery["sort"], string> = {
    newest: "l.created_at DESC,l.id DESC",
    price_asc: "l.price_ash ASC,l.created_at DESC",
    price_desc: "l.price_ash DESC,l.created_at DESC",
    power_desc: `CAST(COALESCE(json_extract(i.item_json, '$.powerScore'), 0) AS REAL) DESC,
      i.item_level DESC,l.created_at DESC,l.id DESC`,
    level_desc: "i.item_level DESC,l.created_at DESC",
    rarity_desc: `CASE i.rarity
      WHEN 'cosmic' THEN 8 WHEN 'mythic' THEN 7 WHEN 'legendary' THEN 6 WHEN 'epic' THEN 5
      WHEN 'rare' THEN 4 WHEN 'superior' THEN 3 WHEN 'magic' THEN 2 ELSE 1 END DESC,
      i.item_level DESC,l.created_at DESC`,
  };
  bindings.push(query.limit);
  const result = await db.prepare(
    `SELECT l.id AS listing_id,l.seller_account_id,a.display_name AS seller_name,l.price_ash,
      l.version AS listing_version,l.created_at AS listing_created_at,l.expires_at,
      i.id,i.state,i.slot,i.rarity,i.item_level,i.display_name,i.item_json,i.version
      FROM economy_listings l JOIN economy_items i ON i.id=l.item_id
      JOIN economy_accounts a ON a.id=l.seller_account_id
      WHERE ${where.join(" AND ")} ORDER BY ${orderBy[query.sort]} LIMIT ?`,
  ).bind(...bindings).all<Record<string, unknown>>();
  return result.results;
}

async function buildSnapshot(
  db: D1Database,
  env: EconomyD1Env,
  auth: AuthContext,
  request: Request,
) {
  await releaseMatureGold(db, auth.account.id);
  await expireAuctionListings(db);
  const importedOriginPrefix = `character:${auth.account.id}:`;
  const [wallet, inventory, listings, orders, fills, sanctions, audit, sessionCount, best, lockedLot, importedCharacterItems] = await Promise.all([
    db.prepare(`SELECT * FROM economy_wallets WHERE account_id=?`).bind(auth.account.id).first<WalletRow>(),
    db.prepare(`SELECT * FROM economy_items WHERE owner_account_id=? AND state<>'destroyed' ORDER BY created_at DESC LIMIT 2000`).bind(auth.account.id).all<Record<string, unknown>>(),
    queryListings(db, { kind: "items", limit: 100, sort: "newest" }),
    db.prepare(`SELECT * FROM economy_exchange_orders WHERE status IN ('open','partially_filled') ORDER BY created_at DESC LIMIT 200`).all<Record<string, unknown>>(),
    db.prepare(`SELECT * FROM economy_exchange_fills ORDER BY created_at DESC LIMIT 30`).all<Record<string, unknown>>(),
    db.prepare(`SELECT * FROM economy_sanctions WHERE account_id=? AND revoked_at IS NULL AND starts_at<=? AND (expires_at IS NULL OR expires_at>?) ORDER BY created_at DESC`).bind(auth.account.id, Date.now(), Date.now()).all<Record<string, unknown>>(),
    db.prepare(`SELECT * FROM economy_audit_events WHERE actor_account_id=? OR target_account_id=? ORDER BY created_at DESC LIMIT 20`).bind(auth.account.id, auth.account.id).all<Record<string, unknown>>(),
    db.prepare(`SELECT COUNT(*) AS count FROM economy_sessions WHERE account_id=? AND revoked_at IS NULL AND expires_at>?`).bind(auth.account.id, Date.now()).first<{ count: number }>(),
    db.prepare(`SELECT MAX(CASE WHEN side='buy_gold' THEN price_ash_per_gold END) AS bid, MIN(CASE WHEN side='sell_gold' THEN price_ash_per_gold END) AS ask FROM economy_exchange_orders WHERE status IN ('open','partially_filled')`).first<{ bid: number | null; ask: number | null }>(),
    db.prepare(`SELECT MIN(tradeable_at) AS tradeable_at FROM economy_gold_lots WHERE account_id=? AND state='locked' AND remaining>0`).bind(auth.account.id).first<{ tradeable_at: number | null }>(),
    db.prepare(`SELECT item_json FROM economy_items
      WHERE provenance='server_drop' AND substr(origin_id,1,?)=?
      ORDER BY created_at DESC LIMIT 2000`)
      .bind(importedOriginPrefix.length, importedOriginPrefix)
      .all<{ item_json: string }>(),
  ]);
  if (!wallet) throw new EconomyProblem(503, "WALLET_MISSING", "서버 지갑이 없습니다.", true);
  const local = auth.development && isLocalHost(new URL(request.url));
  const live = env.ECONOMY_LIVE_ENABLED === "true";
  const activeScopes = new Set(sanctions.results.map((sanction) => String(sanction.scope)));
  const hasTradeSanction = ["login", "market", "exchange", "wallet"].some((scope) => activeScopes.has(scope));
  const steamOwnershipFresh = Boolean(
    auth.account.steam_verified_at &&
    auth.account.steam_verified_at >= Date.now() - STEAM_OWNERSHIP_TTL_MS,
  );
  const canTrade = !hasTradeSanction && (local || (live && steamOwnershipFresh && auth.account.status === "active" && auth.account.wallet_frozen === 0 && auth.account.steam_ownership_verified === 1 && auth.account.trade_eligible === 1));
  const openListings = listings.map((row) => listingView(row, auth.account.id));
  const orderViews = orders.results.map((row) => orderView(row, auth.account.id));
  const aggregateLevels = (side: "buy" | "sell") => {
    const levels = new Map<number, { priceAshPerGold: number; goldAmount: number; orderCount: number }>();
    for (const order of orderViews.filter((candidate) => candidate.side === side)) {
      const previous = levels.get(order.priceAshPerGold) ?? { priceAshPerGold: order.priceAshPerGold, goldAmount: 0, orderCount: 0 };
      previous.goldAmount += order.remainingGold;
      previous.orderCount += 1;
      levels.set(order.priceAshPerGold, previous);
    }
    return [...levels.values()].sort((left, right) => side === "buy" ? right.priceAshPerGold-left.priceAshPerGold : left.priceAshPerGold-right.priceAshPerGold).slice(0, 20);
  };
  return {
    revision: wallet.version,
    serverTime: new Date().toISOString(),
    csrfToken: null,
    featureMode: local ? "sandbox" : live ? "live" : "read-only",
    launchGateReason: local || live ? null : "ECONOMY_LIVE_ENABLED 런치 스위치가 잠겨 운영 거래는 읽기 전용입니다.",
    paymentMode: live && steamPaymentsEnabled(env) && env.STEAM_PUBLISHER_KEY && env.STEAM_APP_ID
      ? env.STEAM_MICROTXN_SANDBOX === "true" ? "sandbox" : "steam"
      : "disabled",
    account: {
      userId: auth.account.id,
      displayName: auth.account.display_name,
      steamId: auth.steamId,
      steamLinked: Boolean(auth.steamId),
      gameOwned: auth.account.steam_ownership_verified === 1,
      restricted: hasTradeSanction || auth.account.status !== "active" || auth.account.wallet_frozen === 1,
      restrictionReason: sanctions.results[0] ? String(sanctions.results[0].reason) : null,
      sanctionCode: sanctions.results[0] ? String(sanctions.results[0].scope) : null,
      trustTier: auth.development ? "trusted" : canTrade ? "standard" : "unverified",
      createdAt: new Date(auth.account.created_at).toISOString(),
    },
    wallet: {
      memoryAsh: { available: wallet.ash_available, escrow: wallet.ash_reserved, locked72h: 0 },
      goldBars: { available: wallet.gold_available, escrow: wallet.gold_reserved, locked72h: wallet.gold_locked },
    },
    vaultItems: inventory.results.map(itemView),
    importedCharacterItemIds: [...new Set(importedCharacterItems.results.flatMap((row) => {
      const item = normalizeGearItem(parseItemJson(row.item_json));
      return item ? [item.id] : [];
    }))],
    listings: openListings,
    goldExchange: {
      bestBid: best?.bid ?? null,
      bestAsk: best?.ask ?? null,
      lastPrice: fills.results[0] ? Number(fills.results[0].price_ash_per_gold) : null,
      bids: aggregateLevels("buy"),
      asks: aggregateLevels("sell"),
      myOrders: orderViews.filter((order) => order.mine),
      orders: orderViews,
      recentTrades: fills.results.map((fill) => ({
        tradeId: String(fill.id),
        priceAshPerGold: Number(fill.price_ash_per_gold),
        goldAmount: Number(fill.gold_amount),
        executedAt: new Date(Number(fill.created_at)).toISOString(),
      })),
    },
    security: {
      activeSessions: Number(sessionCount?.count ?? 0),
      lastLoginAt: null,
      lastSteamTicketVerifiedAt: auth.account.steam_verified_at ? new Date(auth.account.steam_verified_at).toISOString() : null,
      withdrawalLockUntil: lockedLot?.tradeable_at ? new Date(lockedLot.tradeable_at).toISOString() : null,
      auditTrail: audit.results.map((entry) => ({
        id: String(entry.id),
        category: String(entry.action),
        message: `${String(entry.action)} · ${String(entry.object_type)}`,
        ipHint: null,
        createdAt: new Date(Number(entry.created_at)).toISOString(),
      })),
    },
    capabilities: {
      canTrade,
      canTopUp: local || (live && steamPaymentsEnabled(env) && Boolean(env.STEAM_PUBLISHER_KEY && env.STEAM_APP_ID)),
      canUseGoldExchange: canTrade,
      localSandbox: local,
    },
  };
}

function commandColumns(command: EconomyCommand, now: number) {
  const resultRefId = uuid();
  switch (command.action) {
    case "list_item": return { resultRefId, itemId: command.itemId, listingId: null, orderId: null, side: null, currency: null, price: command.priceAsh, gold: null, amount: null, version: command.expectedItemVersion, expires: now + command.expiresInSeconds * 1_000 };
    case "buy_listing": return { resultRefId, itemId: null, listingId: command.listingId, orderId: null, side: null, currency: null, price: command.expectedPriceAsh, gold: null, amount: null, version: command.expectedListingVersion, expires: null };
    case "cancel_listing": return { resultRefId, itemId: null, listingId: command.listingId, orderId: null, side: null, currency: null, price: null, gold: null, amount: null, version: command.expectedListingVersion, expires: null };
    case "place_exchange": return { resultRefId, itemId: null, listingId: null, orderId: null, side: command.side, currency: null, price: command.priceAshPerGold, gold: command.goldAmount, amount: null, version: null, expires: null };
    case "fill_exchange": return { resultRefId, itemId: null, listingId: null, orderId: command.orderId, side: null, currency: null, price: command.expectedPriceAshPerGold, gold: command.goldAmount, amount: null, version: command.expectedOrderVersion, expires: null };
    case "cancel_exchange": return { resultRefId, itemId: null, listingId: null, orderId: command.orderId, side: null, currency: null, price: null, gold: null, amount: null, version: command.expectedOrderVersion, expires: null };
    case "sandbox_topup": return { resultRefId, itemId: null, listingId: null, orderId: null, side: null, currency: command.currency, price: null, gold: null, amount: command.amount, version: null, expires: null };
  }
}

async function executeCommand(
  request: Request,
  db: D1Database,
  env: EconomyD1Env,
  auth: AuthContext,
): Promise<Response> {
  assertWriteAllowed(request, env, auth);
  await enforceRequestRateLimit(request, db, env, "economy-command", auth.development ? 240 : 60, 60_000, 60_000, auth.account.id);
  const parsed = parseEconomyCommand(await readJson(request));
  if (!parsed) throw new EconomyProblem(400, "BAD_REQUEST", "경제 명령 형식이 올바르지 않습니다.");
  if (!(await verifyEconomyCommandHash(parsed))) throw new EconomyProblem(400, "HASH_MISMATCH", "요청 해시가 일치하지 않습니다.");
  if (request.headers.get("idempotency-key") !== parsed.idempotencyKey) {
    throw new EconomyProblem(400, "IDEMPOTENCY_HEADER_MISMATCH", "멱등 키 헤더와 본문이 다릅니다.");
  }
  if (parsed.action === "sandbox_topup" && !auth.development) {
    throw new EconomyProblem(403, "SANDBOX_ONLY", "샌드박스 충전은 localhost에서만 허용됩니다.");
  }
  await releaseMatureGold(db, auth.account.id);
  const replay = await db.prepare(`SELECT id,request_hash,action,result_ref_id FROM economy_commands WHERE actor_account_id=? AND idempotency_key=? LIMIT 1`)
    .bind(auth.account.id, parsed.idempotencyKey).first<CommandRow>();
  if (replay) {
    if (replay.request_hash !== parsed.requestHash) {
      await recordRiskEvent(db, auth.account.id, "idempotency_mismatch", 80, replay.id, { action: parsed.action });
      throw new EconomyProblem(409, "IDEMPOTENCY_CONFLICT", "같은 멱등 키가 다른 요청에 재사용됐습니다.");
    }
    return success({ snapshot: await buildSnapshot(db, env, auth, request), resultRefId: replay.result_ref_id }, replay.id, true);
  }
  const now = Date.now();
  const commandId = uuid();
  const columns = commandColumns(parsed, now);
  const characterCommand = parsed.action === "list_item" && "characterItem" in parsed
    ? parsed as ListCharacterItemCommand
    : null;
  const canonicalCharacter = characterCommand
    ? normalizeCharacterItem(characterCommand)
    : null;
  const characterOrigin = canonicalCharacter
    ? characterItemOrigin(auth.account.id, canonicalCharacter.item)
    : null;
  let existingCharacterRow = characterOrigin
    ? await characterItemByOrigin(db, characterOrigin)
    : null;
  if (existingCharacterRow && canonicalCharacter) {
    assertMatchingCharacterItem(existingCharacterRow, canonicalCharacter.json);
    if (
      existingCharacterRow.owner_account_id !== auth.account.id ||
      existingCharacterRow.state !== "inventory"
    ) {
      const resultRefId = await reconciliationResultRef(db, existingCharacterRow);
      return success(
        { snapshot: await buildSnapshot(db, env, auth, request), resultRefId },
        commandId,
        true,
      );
    }
    columns.itemId = existingCharacterRow.id;
    columns.version = existingCharacterRow.version;
  }
  try {
    const commandInsert = db.prepare(`INSERT INTO economy_commands
      (id,actor_account_id,action,idempotency_key,request_hash,result_ref_id,item_id,listing_id,order_id,side,currency,price_ash,gold_amount,amount,expected_version,expires_at,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .bind(commandId, auth.account.id, parsed.action, parsed.idempotencyKey, parsed.requestHash, columns.resultRefId, columns.itemId, columns.listingId, columns.orderId, columns.side, columns.currency, columns.price, columns.gold, columns.amount, columns.version, columns.expires, now);
    if (characterCommand && canonicalCharacter && characterOrigin && !existingCharacterRow) {
      await db.batch([
        db.prepare(`INSERT INTO economy_items
          (id,owner_account_id,state,tradeable,provenance,origin_id,slot,rarity,item_level,display_name,item_json,version,created_at,updated_at)
          VALUES(?,?,'inventory',1,'server_drop',?,?,?,?,?,?,0,?,?)`)
          .bind(
            characterCommand.itemId,
            auth.account.id,
            characterOrigin,
            canonicalCharacter.item.slot,
            canonicalCharacter.item.rarity,
            canonicalCharacter.item.level,
            canonicalCharacter.item.displayName,
            canonicalCharacter.json,
            now,
            now,
          ),
        commandInsert,
      ]);
    } else {
      await commandInsert.run();
    }
  } catch (error) {
    // Identical commands may pass the optimistic pre-read concurrently. The
    // database row is authoritative, so return the winner as an idempotent replay.
    const committed = await db.prepare(`SELECT id,request_hash,action,result_ref_id FROM economy_commands WHERE actor_account_id=? AND idempotency_key=? LIMIT 1`)
      .bind(auth.account.id, parsed.idempotencyKey).first<CommandRow>();
    if (committed) {
      if (committed.request_hash !== parsed.requestHash) {
        await recordRiskEvent(db, auth.account.id, "idempotency_mismatch", 80, committed.id, { action: parsed.action });
        throw new EconomyProblem(409, "IDEMPOTENCY_CONFLICT", "같은 멱등 키가 다른 요청에 재사용됐습니다.");
      }
      return success({ snapshot: await buildSnapshot(db, env, auth, request), resultRefId: committed.result_ref_id }, committed.id, true);
    }
    if (characterOrigin && canonicalCharacter) {
      existingCharacterRow = await characterItemByOrigin(db, characterOrigin);
      if (existingCharacterRow) {
        assertMatchingCharacterItem(existingCharacterRow, canonicalCharacter.json);
        if (
          existingCharacterRow.owner_account_id !== auth.account.id ||
          existingCharacterRow.state !== "inventory"
        ) {
          const resultRefId = await reconciliationResultRef(db, existingCharacterRow);
          return success(
            { snapshot: await buildSnapshot(db, env, auth, request), resultRefId },
            commandId,
            true,
          );
        }
      }
    }
    const message = error instanceof Error ? error.message : String(error);
    if (/UNIQUE constraint failed:\s*economy_items\.id/i.test(message)) {
      throw new EconomyProblem(
        409,
        "CHARACTER_ITEM_ID_CONFLICT",
        "장비 등록 식별자가 이미 사용되었습니다. 다시 시도해 주세요.",
      );
    }
    if (/open_(?:listing|exchange_order)_limit/i.test(message)) throw new EconomyProblem(409, "OPEN_ORDER_LIMIT", "동시에 등록할 수 있는 거래 수를 초과했습니다.");
    if (/insufficient/i.test(message)) throw new EconomyProblem(409, "INSUFFICIENT_FUNDS", "사용 가능한 재화가 부족합니다.");
    if (/(?:seller|maker)_sanctioned/i.test(message)) {
      throw new EconomyProblem(409, "COUNTERPARTY_RESTRICTED", "거래 상대가 제한되어 체결할 수 없습니다.");
    }
    if (/account_sanctioned/i.test(message)) {
      await recordRiskEvent(db, auth.account.id, "sanction_evasion_attempt", 75, commandId, { action: parsed.action });
      throw new EconomyProblem(403, "SANCTIONED", "제재 중에는 이 작업을 할 수 없습니다.");
    }
    if (/self_trade/i.test(message)) {
      await recordRiskEvent(db, auth.account.id, "self_trade_attempt", 70, commandId, { action: parsed.action });
      throw new EconomyProblem(409, "VERSION_OR_OWNERSHIP_CONFLICT", "자기 거래는 허용되지 않습니다.");
    }
    if (/not_owned|version|unavailable/i.test(message)) throw new EconomyProblem(409, "VERSION_OR_OWNERSHIP_CONFLICT", "소유권·가격·버전이 바뀌었습니다.");
    if (/trade_eligible/i.test(message)) throw new EconomyProblem(403, "TRADE_NOT_ELIGIBLE", "거래 자격을 확인할 수 없습니다.");
    throw error;
  }
  return success({ snapshot: await buildSnapshot(db, env, auth, request), resultRefId: columns.resultRefId }, commandId);
}

async function marketResponse(request: Request, db: D1Database, auth: AuthContext): Promise<Response> {
  await expireAuctionListings(db);
  const url = new URL(request.url);
  const numericKeys = new Set(["limit", "minLevel", "maxLevel", "minPriceAsh", "maxPriceAsh"]);
  const rawQuery: Record<string, string | number> = {};
  for (const [key, value] of url.searchParams) {
    rawQuery[key] = numericKeys.has(key) ? Number(value) : value;
  }
  rawQuery.kind ??= "items";
  const query = parseMarketQuery(rawQuery);
  if (!query) throw new EconomyProblem(400, "BAD_MARKET_QUERY", "거래소 검색 조건이 올바르지 않습니다.");
  if (query.cursor) throw new EconomyProblem(400, "CURSOR_NOT_SUPPORTED", "이 거래소 버전에서는 커서 조회를 지원하지 않습니다.");
  if (query.kind === "exchange") {
    const sideSql = query.side === "both" ? "" : " AND side=?";
    const bindings = query.side === "both" ? [query.limit] : [query.side, query.limit];
    const rows = await db.prepare(`SELECT * FROM economy_exchange_orders WHERE status IN ('open','partially_filled')${sideSql} ORDER BY CASE WHEN side='buy_gold' THEN price_ash_per_gold END DESC,CASE WHEN side='sell_gold' THEN price_ash_per_gold END ASC,created_at ASC LIMIT ?`).bind(...bindings).all<Record<string, unknown>>();
    return success({
      buyOrders: rows.results.filter((row) => row.side === "buy_gold").map((row) => orderView(row, auth.account.id)),
      sellOrders: rows.results.filter((row) => row.side === "sell_gold").map((row) => orderView(row, auth.account.id)),
    }, uuid());
  }
  const rows = await queryListings(db, query);
  return success({ listings: rows.map((row) => listingView(row, auth.account.id)) }, uuid());
}

function setCookie(name: string, value: string, maxAge: number): string {
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

async function steamStart(request: Request, db: D1Database, env: EconomyD1Env): Promise<Response> {
  await enforceRequestRateLimit(request, db, env, "steam-auth-start", 8, 10 * 60_000, 15 * 60_000);
  const url = new URL(request.url);
  const returnToRaw = url.searchParams.get("return_to") ?? "/market";
  let returnTo = "/market";
  try {
    const resolved = new URL(returnToRaw, url.origin);
    if (
      returnToRaw.startsWith("/") &&
      !returnToRaw.startsWith("//") &&
      !/%(?:2f|5c)/i.test(returnToRaw) &&
      !returnToRaw.includes("\\") &&
      resolved.origin === url.origin
    ) returnTo = `${resolved.pathname}${resolved.search}${resolved.hash}`;
  } catch { /* Fall back to the fixed same-origin market route. */ }
  let pendingAccountId: string | null = null;
  try { pendingAccountId = (await authenticate(request, db)).account.id; } catch { /* Steam-only login. */ }
  const state = `${uuid().replaceAll("-", "")}${uuid().replaceAll("-", "")}`;
  const stateHash = await sha256(state);
  const callback = new URL("/api/economy/auth/steam/callback", url.origin);
  callback.searchParams.set("state", state);
  const now = Date.now();
  await db.batch([
    db.prepare(`DELETE FROM economy_auth_states WHERE expires_at<?`).bind(now - 24 * 60 * 60_000),
    db.prepare(`INSERT INTO economy_auth_states(state_hash,pending_account_id,return_to,expires_at,created_at) VALUES(?,?,?,?,?)`)
      .bind(stateHash, pendingAccountId, returnTo, now + 10 * 60 * 1_000, now),
  ]);
  const openid = new URL("https://steamcommunity.com/openid/login");
  openid.searchParams.set("openid.ns", "http://specs.openid.net/auth/2.0");
  openid.searchParams.set("openid.mode", "checkid_setup");
  openid.searchParams.set("openid.return_to", callback.toString());
  openid.searchParams.set("openid.realm", url.origin);
  openid.searchParams.set("openid.identity", "http://specs.openid.net/auth/2.0/identifier_select");
  openid.searchParams.set("openid.claimed_id", "http://specs.openid.net/auth/2.0/identifier_select");
  return new Response(null, { status: 302, headers: { location: openid.toString(), "set-cookie": setCookie(STEAM_STATE_COOKIE, state, 600), "cache-control": "no-store" } });
}

async function verifySteamOwnership(env: EconomyD1Env, steamId: string) {
  if (!env.STEAM_PUBLISHER_KEY || !env.STEAM_APP_ID) {
    throw new EconomyProblem(503, "STEAM_NOT_CONFIGURED", "Steam Publisher key와 AppID가 서버에 구성되지 않았습니다.", true);
  }
  const endpoint = new URL("https://partner.steam-api.com/ISteamUser/CheckAppOwnership/v4/");
  endpoint.searchParams.set("key", env.STEAM_PUBLISHER_KEY);
  endpoint.searchParams.set("steamid", steamId);
  endpoint.searchParams.set("appid", env.STEAM_APP_ID);
  const response = await steamFetch(endpoint, { headers: { accept: "application/json" } });
  if (!response.ok) throw new EconomyProblem(503, "STEAM_UNAVAILABLE", "Steam 소유권 검증에 실패했습니다.", true);
  const payload = await response.json() as { appownership?: { ownsapp?: boolean; permanent?: boolean; ownersteamid?: string } };
  return {
    owns: payload.appownership?.ownsapp === true && payload.appownership?.permanent === true,
    ownerSteamId: payload.appownership?.ownersteamid ?? steamId,
  };
}

async function verifySteamPaymentProfile(env: EconomyD1Env, steamId: string): Promise<void> {
  if (!env.STEAM_PUBLISHER_KEY || !env.STEAM_APP_ID) throw new EconomyProblem(503, "STEAM_PAYMENT_NOT_CONFIGURED", "Steam 결제 서버 설정이 없습니다.", true);
  const service = env.STEAM_MICROTXN_SANDBOX === "true" ? "ISteamMicroTxnSandbox" : "ISteamMicroTxn";
  const endpoint = new URL(`https://partner.steam-api.com/${service}/GetUserInfo/v2/`);
  endpoint.searchParams.set("key", env.STEAM_PUBLISHER_KEY);
  endpoint.searchParams.set("steamid", steamId);
  endpoint.searchParams.set("appid", env.STEAM_APP_ID);
  const response = await steamFetch(endpoint, { headers: { accept: "application/json" } });
  const payload = await response.json().catch(() => null) as { response?: { result?: string; params?: { currency?: string; status?: string } } } | null;
  const params = payload?.response?.params;
  if (!response.ok || payload?.response?.result !== "OK" || params?.currency !== "KRW" || !["Active", "Trusted"].includes(params.status ?? "")) {
    throw new EconomyProblem(403, "STEAM_PAYMENT_PROFILE_BLOCKED", "현재 Steam 지갑 국가·통화 또는 계정 상태로는 결제할 수 없습니다.");
  }
}

async function steamCallback(request: Request, db: D1Database, env: EconomyD1Env): Promise<Response> {
  await enforceRequestRateLimit(request, db, env, "steam-auth-callback", 12, 10 * 60_000, 15 * 60_000);
  const url = new URL(request.url);
  const state = url.searchParams.get("state") ?? "";
  const cookieState = cookieValue(request, STEAM_STATE_COOKIE);
  if (!state || !cookieState || state !== cookieState) throw new EconomyProblem(403, "STEAM_STATE_MISMATCH", "Steam 로그인 상태가 일치하지 않습니다.");
  const stateHash = await sha256(state);
  const authState = await db.prepare(`SELECT * FROM economy_auth_states WHERE state_hash=? AND consumed_at IS NULL AND expires_at>? LIMIT 1`).bind(stateHash, Date.now()).first<{ pending_account_id: string | null; return_to: string }>();
  if (!authState) throw new EconomyProblem(403, "STEAM_STATE_EXPIRED", "Steam 로그인 요청이 만료됐습니다.");
  const expectedReturnTo = new URL("/api/economy/auth/steam/callback", url.origin);
  expectedReturnTo.searchParams.set("state", state);
  const signedFields = new Set((url.searchParams.get("openid.signed") ?? "").split(","));
  const claimed = url.searchParams.get("openid.claimed_id") ?? "";
  const identity = url.searchParams.get("openid.identity") ?? "";
  if (
    url.searchParams.get("openid.ns") !== "http://specs.openid.net/auth/2.0" ||
    url.searchParams.get("openid.mode") !== "id_res" ||
    url.searchParams.get("openid.op_endpoint") !== "https://steamcommunity.com/openid/login" ||
    url.searchParams.get("openid.return_to") !== expectedReturnTo.toString() ||
    claimed !== identity ||
    !["op_endpoint", "claimed_id", "identity", "return_to", "response_nonce"].every((field) => signedFields.has(field)) ||
    !/^\d{4}-\d{2}-\d{2}T/.test(url.searchParams.get("openid.response_nonce") ?? "")
  ) throw new EconomyProblem(403, "STEAM_ASSERTION_INVALID", "Steam OpenID 응답 필드가 올바르지 않습니다.");
  const check = new URLSearchParams();
  for (const [key, value] of url.searchParams) if (key.startsWith("openid.")) check.set(key, value);
  check.set("openid.mode", "check_authentication");
  const verification = await steamFetch("https://steamcommunity.com/openid/login", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: check });
  const verificationText = await verification.text();
  if (!verification.ok || !verificationText.includes("is_valid:true")) throw new EconomyProblem(403, "STEAM_INVALID", "Steam 서명을 검증하지 못했습니다.");
  const steamId = /^https:\/\/steamcommunity\.com\/openid\/id\/(\d{17})$/.exec(claimed)?.[1];
  if (!steamId) throw new EconomyProblem(403, "STEAM_INVALID_ID", "SteamID64를 확인하지 못했습니다.");
  const ownership = await verifySteamOwnership(env, steamId);
  if (!ownership.owns) throw new EconomyProblem(403, "GAME_NOT_OWNED", "영구 Steam 라이선스 보유자만 거래할 수 있습니다.");
  const now = Date.now();
  const stateClaim = await db.prepare(`UPDATE economy_auth_states SET consumed_at=? WHERE state_hash=? AND consumed_at IS NULL AND expires_at>?`)
    .bind(now, stateHash, now).run();
  if (Number(stateClaim.meta.changes ?? 0) !== 1) throw new EconomyProblem(409, "STEAM_STATE_REPLAY", "이미 사용된 Steam 로그인 응답입니다.");
  const existingIdentity = await db.prepare(`SELECT account_id FROM economy_identities WHERE provider='steam' AND provider_subject=? LIMIT 1`).bind(steamId).first<{ account_id: string }>();
  if (existingIdentity && authState.pending_account_id && existingIdentity.account_id !== authState.pending_account_id) {
    throw new EconomyProblem(409, "STEAM_ALREADY_LINKED", "이 Steam 계정은 다른 게임 계정에 이미 연결되어 있습니다.");
  }
  let accountId = existingIdentity?.account_id ?? authState.pending_account_id ?? uuid();
  const createdStandaloneAccount = !existingIdentity && !authState.pending_account_id;
  if (createdStandaloneAccount) {
    await db.batch([
      db.prepare(`INSERT INTO economy_accounts(id,display_name,status,steam_ownership_verified,trade_eligible,wallet_frozen,auth_epoch,risk_score,created_at,updated_at) VALUES(?,?,'active',1,1,0,0,0,?,?)`).bind(accountId, `Steam ${steamId.slice(-6)}`, now, now),
      db.prepare(`INSERT INTO economy_wallets(account_id,updated_at) VALUES(?,?)`).bind(accountId, now),
    ]);
  }
  await db.prepare(`INSERT INTO economy_identities(id,account_id,provider,provider_subject,owner_subject,ownership_permanent,verified_at,created_at)
      VALUES(?,?,'steam',?,?,1,?,?)
      ON CONFLICT(provider,provider_subject) DO UPDATE SET
        owner_subject=excluded.owner_subject,
        ownership_permanent=excluded.ownership_permanent,
        verified_at=excluded.verified_at
      WHERE economy_identities.account_id=excluded.account_id`)
    .bind(uuid(), accountId, steamId, ownership.ownerSteamId, now, now).run();
  const linkedIdentity = await db.prepare(`SELECT account_id FROM economy_identities WHERE provider='steam' AND provider_subject=? LIMIT 1`)
    .bind(steamId).first<{ account_id: string }>();
  if (!linkedIdentity) throw new EconomyProblem(409, "STEAM_ACCOUNT_LINK_CONFLICT", "계정에 이미 다른 Steam ID가 연결되어 있습니다.");
  if (authState.pending_account_id && linkedIdentity.account_id !== authState.pending_account_id) {
    throw new EconomyProblem(409, "STEAM_ALREADY_LINKED", "이 Steam 계정은 다른 게임 계정에 이미 연결되어 있습니다.");
  }
  if (createdStandaloneAccount && linkedIdentity.account_id !== accountId) {
    await db.batch([
      db.prepare(`DELETE FROM economy_wallets WHERE account_id=?`).bind(accountId),
      db.prepare(`DELETE FROM economy_accounts WHERE id=? AND NOT EXISTS(SELECT 1 FROM economy_identities WHERE account_id=?)`).bind(accountId, accountId),
    ]);
    accountId = linkedIdentity.account_id;
  }
  await db.prepare(`UPDATE economy_accounts SET steam_ownership_verified=1,trade_eligible=1,updated_at=? WHERE id=?`).bind(now, accountId).run();
  const token = `${uuid().replaceAll("-", "")}${uuid().replaceAll("-", "")}`;
  const account = await accountById(db, accountId);
  if (!account) throw new EconomyProblem(503, "ACCOUNT_MISSING", "Steam 계정을 연결하지 못했습니다.", true);
  const loginSanction = await db.prepare(`SELECT 1 AS denied FROM economy_sanctions WHERE account_id=? AND scope='login' AND revoked_at IS NULL AND starts_at<=? AND (expires_at IS NULL OR expires_at>?) LIMIT 1`)
    .bind(accountId, now, now).first<{ denied: number }>();
  if (account.status === "banned" || loginSanction) throw new EconomyProblem(403, "LOGIN_SANCTIONED", "이 계정은 현재 로그인할 수 없습니다.");
  await db.prepare(`INSERT INTO economy_sessions(id,account_id,token_hash,auth_epoch,expires_at,created_at,last_seen_at) VALUES(?,?,?,?,?,?,?)`)
    .bind(uuid(), accountId, await sha256(token), account.auth_epoch, now + SESSION_TTL_MS, now, now).run();
  const headers = new Headers({ location: authState.return_to, "cache-control": "no-store" });
  headers.append("set-cookie", setCookie(SESSION_COOKIE, token, SESSION_TTL_MS / 1_000));
  headers.append("set-cookie", setCookie(STEAM_STATE_COOKIE, "", 0));
  return new Response(null, { status: 302, headers });
}

async function steamPaymentInit(request: Request, db: D1Database, env: EconomyD1Env, auth: AuthContext): Promise<Response> {
  assertWriteAllowed(request, env, auth);
  await enforceRequestRateLimit(request, db, env, "steam-payment-init", 4, 5 * 60_000, 15 * 60_000, auth.account.id);
  await assertNoActiveSanction(db, auth.account.id, ["login", "payment", "wallet"]);
  assertSteamPaymentsEnabled(env);
  if (!env.STEAM_PUBLISHER_KEY || !env.STEAM_APP_ID || !auth.steamId) throw new EconomyProblem(503, "STEAM_PAYMENT_NOT_CONFIGURED", "Steam 결제 서버 설정이 없습니다.", true);
  const body = await readJson(request);
  const parsed = parsePaymentCheckoutRequest(body);
  if (!parsed || await computeCanonicalRequestHash(body as Record<string, unknown>) !== parsed.requestHash) throw new EconomyProblem(400, "BAD_PAYMENT_REQUEST", "결제 요청이 올바르지 않습니다.");
  const product = PRODUCT_CATALOG[parsed.productSku as keyof typeof PRODUCT_CATALOG];
  if (!product) throw new EconomyProblem(400, "UNKNOWN_PRODUCT", "등록되지 않은 금괴 상품입니다.");
  const existing = await db.prepare(`SELECT * FROM economy_payment_orders WHERE account_id=? AND idempotency_key=? LIMIT 1`).bind(auth.account.id, parsed.idempotencyKey).first<Record<string, unknown>>();
  if (existing) {
    if (existing.request_hash !== parsed.requestHash) throw new EconomyProblem(409, "IDEMPOTENCY_CONFLICT", "결제 멱등 키가 충돌했습니다.");
    const status = String(existing.status ?? "");
    if (TERMINAL_PAYMENT_STATUSES.has(status)) {
      throw new EconomyProblem(409, "PAYMENT_INIT_TERMINAL", "이미 실패하거나 취소·환불된 결제 주문은 다시 승인할 수 없습니다.");
    }
    if (!["created", "authorized", "finalized"].includes(status)) {
      throw new EconomyProblem(409, "PAYMENT_INIT_STATE_INVALID", "현재 결제 주문 상태로는 승인 화면을 다시 열 수 없습니다.");
    }
    const approvalUrl = typeof existing.approval_url === "string" ? existing.approval_url : null;
    if (!approvalUrl) {
      throw new EconomyProblem(409, "PAYMENT_INIT_IN_PROGRESS", "Steam 승인 주소를 생성하는 중입니다. 잠시 후 같은 요청으로 다시 시도해 주세요.", true);
    }
    return success({ paymentOrderId: existing.id, providerOrderId: existing.provider_order_id, redirectUrl: approvalUrl, status, holdHours: 72 }, String(existing.id), true);
  }
  await verifySteamPaymentProfile(env, auth.steamId);
  const paymentIp = request.headers.get("cf-connecting-ip");
  if (!paymentIp && !isLocalHost(new URL(request.url))) throw new EconomyProblem(400, "PAYMENT_IP_MISSING", "Steam 웹 결제에 필요한 접속 주소를 확인하지 못했습니다.");
  const id = uuid();
  const providerOrderId = `${Date.now()}${crypto.getRandomValues(new Uint32Array(1))[0].toString().padStart(10, "0")}`.slice(0, 20);
  const now = Date.now();
  await db.prepare(`INSERT INTO economy_payment_orders(id,account_id,provider,provider_order_id,product_sku,amount_minor,currency,gold_amount,status,idempotency_key,request_hash,created_at) VALUES(?,?,'steam',?,?,?,?,?,'created',?,?,?)`)
    .bind(id, auth.account.id, providerOrderId, parsed.productSku, product.amountHundredths, product.currency, product.gold, parsed.idempotencyKey, parsed.requestHash, now).run();
  const endpoint = env.STEAM_MICROTXN_SANDBOX === "true" ? "https://partner.steam-api.com/ISteamMicroTxnSandbox/InitTxn/v3/" : "https://partner.steam-api.com/ISteamMicroTxn/InitTxn/v3/";
  const form = new URLSearchParams({ key: env.STEAM_PUBLISHER_KEY, orderid: providerOrderId, steamid: auth.steamId, appid: env.STEAM_APP_ID, itemcount: "1", language: "ko", currency: product.currency, usersession: "web", ipaddress: paymentIp ?? "127.0.0.1", "itemid[0]": product.itemId, "qty[0]": "1", "amount[0]": String(product.amountHundredths), "description[0]": product.description });
  let response: Response;
  try {
    response = await steamFetch(endpoint, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form });
  } catch (error) {
    // Steam documents that an InitTxn communication failure should be
    // abandoned. Make the local order terminal so retries use a new order and
    // this idempotency key cannot strand the player in an in-progress state.
    await db.prepare(`UPDATE economy_payment_orders SET status='failed' WHERE id=? AND status='created'`).bind(id).run();
    throw error;
  }
  const payload = await response.json().catch(() => null) as { response?: { result?: string; params?: { steamurl?: string } } } | null;
  if (!response.ok || payload?.response?.result !== "OK") {
    await db.prepare(`UPDATE economy_payment_orders SET status='failed' WHERE id=? AND status='created'`).bind(id).run();
    throw new EconomyProblem(503, "STEAM_PAYMENT_INIT_FAILED", "Steam 결제를 시작하지 못했습니다.", true);
  }
  const rawSteamUrl = payload?.response?.params?.steamurl;
  let approvalUrl: string;
  try {
    const steamUrl = new URL(rawSteamUrl ?? "");
    if (steamUrl.protocol !== "https:" || steamUrl.hostname !== "store.steampowered.com") throw new Error("invalid_steam_origin");
    const returnUrl = new URL("/market", request.url);
    returnUrl.searchParams.set("payment_return", id);
    steamUrl.searchParams.set("returnurl", returnUrl.toString());
    approvalUrl = steamUrl.toString();
  } catch {
    await db.prepare(`UPDATE economy_payment_orders SET status='failed' WHERE id=? AND status='created'`).bind(id).run();
    throw new EconomyProblem(503, "STEAM_PAYMENT_URL_INVALID", "Steam 결제 승인 주소를 확인하지 못했습니다.", true);
  }
  const stored = await db.prepare(`UPDATE economy_payment_orders SET approval_url=? WHERE id=? AND status='created' AND approval_url IS NULL`)
    .bind(approvalUrl, id).run();
  if (Number(stored.meta.changes ?? 0) !== 1) throw new EconomyProblem(503, "PAYMENT_APPROVAL_STORE_FAILED", "Steam 승인 주소를 안전하게 저장하지 못했습니다.", true);
  return success({ paymentOrderId: id, providerOrderId, redirectUrl: approvalUrl, status: "created", holdHours: 72 }, id);
}

type SteamTransaction = {
  orderId: string;
  steamId: string;
  currency: string;
  status: string;
  items: SteamTransactionItem[];
};

async function querySteamTransaction(env: EconomyD1Env, providerOrderId: string): Promise<SteamTransaction> {
  if (!env.STEAM_PUBLISHER_KEY || !env.STEAM_APP_ID) throw new EconomyProblem(503, "STEAM_PAYMENT_NOT_CONFIGURED", "Steam 결제 서버 설정이 없습니다.", true);
  const service = env.STEAM_MICROTXN_SANDBOX === "true" ? "ISteamMicroTxnSandbox" : "ISteamMicroTxn";
  const endpoint = new URL(`https://partner.steam-api.com/${service}/QueryTxn/v3/`);
  endpoint.searchParams.set("key", env.STEAM_PUBLISHER_KEY);
  endpoint.searchParams.set("appid", env.STEAM_APP_ID);
  endpoint.searchParams.set("orderid", providerOrderId);
  const response = await steamFetch(endpoint, { headers: { accept: "application/json" } });
  const payload = await response.json().catch(() => null) as {
    response?: { result?: string; params?: { orderid?: unknown; steamid?: unknown; currency?: unknown; status?: unknown; items?: unknown } };
  } | null;
  const params = payload?.response?.params;
  if (!response.ok || payload?.response?.result !== "OK" || !params) {
    throw new EconomyProblem(503, "STEAM_PAYMENT_QUERY_FAILED", "Steam 결제 승인 상태를 검증하지 못했습니다.", true);
  }
  const items = parseSteamTransactionItems(params.items);
  if (
    typeof params.orderid !== "string" ||
    typeof params.steamid !== "string" ||
    typeof params.currency !== "string" ||
    typeof params.status !== "string" ||
    !items
  ) {
    throw new EconomyProblem(503, "STEAM_PAYMENT_QUERY_INVALID", "Steam 결제 승인 응답 형식이 올바르지 않습니다.", true);
  }
  return {
    orderId: params.orderid,
    steamId: params.steamid,
    currency: params.currency.toUpperCase(),
    status: params.status,
    items,
  };
}

async function steamPaymentFinalize(request: Request, db: D1Database, env: EconomyD1Env, auth: AuthContext): Promise<Response> {
  assertWriteAllowed(request, env, auth);
  await enforceRequestRateLimit(request, db, env, "steam-payment-finalize", 6, 5 * 60_000, 15 * 60_000, auth.account.id);
  await assertNoActiveSanction(db, auth.account.id, ["login", "payment", "wallet"]);
  assertSteamPaymentsEnabled(env);
  if (!env.STEAM_PUBLISHER_KEY || !env.STEAM_APP_ID || !auth.steamId) throw new EconomyProblem(503, "STEAM_PAYMENT_NOT_CONFIGURED", "Steam 결제 서버 설정이 없습니다.", true);
  const body = await readJson(request);
  const parsed = parsePaymentFinalizeRequest(body);
  if (!parsed || await computeCanonicalRequestHash(body as Record<string, unknown>) !== parsed.requestHash) throw new EconomyProblem(400, "BAD_REQUEST", "결제 완료 요청이 올바르지 않습니다.");
  const existingFinalize = await db.prepare(`SELECT payment_order_id,request_hash FROM economy_payment_finalize_commands WHERE account_id=? AND idempotency_key=? LIMIT 1`)
    .bind(auth.account.id, parsed.idempotencyKey).first<{ payment_order_id: string; request_hash: string }>();
  if (existingFinalize && (existingFinalize.payment_order_id !== parsed.paymentOrderId || existingFinalize.request_hash !== parsed.requestHash)) {
    throw new EconomyProblem(409, "IDEMPOTENCY_CONFLICT", "결제 완료 멱등 키가 다른 주문에 재사용됐습니다.");
  }
  const order = await db.prepare(`SELECT * FROM economy_payment_orders WHERE id=? AND account_id=? LIMIT 1`).bind(parsed.paymentOrderId, auth.account.id).first<Record<string, unknown>>();
  if (!order) throw new EconomyProblem(404, "PAYMENT_NOT_FOUND", "결제 주문을 찾을 수 없습니다.");
  if (order.status === "finalized") return success({ paymentOrderId: order.id, holdHours: 72 }, String(order.id), true);
  const orderStatus = String(order.status ?? "");
  if (TERMINAL_PAYMENT_STATUSES.has(orderStatus)) throw new EconomyProblem(409, "PAYMENT_NOT_FINALIZABLE", "실패하거나 취소·환불된 결제 주문은 확정할 수 없습니다.");
  if (orderStatus !== "created" && orderStatus !== "authorized") throw new EconomyProblem(409, "PAYMENT_NOT_FINALIZABLE", "현재 상태의 결제 주문은 확정할 수 없습니다.");

  const transaction = await querySteamTransaction(env, String(order.provider_order_id));
  const product = PRODUCT_CATALOG[String(order.product_sku) as keyof typeof PRODUCT_CATALOG];
  const transactionItem = transaction.items[0];
  if (
    transaction.orderId !== String(order.provider_order_id) ||
    transaction.steamId !== auth.steamId ||
    transaction.currency !== String(order.currency).toUpperCase() ||
    !product ||
    !Number.isSafeInteger(order.amount_minor) ||
    !Number.isSafeInteger(order.gold_amount) ||
    Number(order.amount_minor) !== product.amountHundredths ||
    Number(order.gold_amount) !== product.gold ||
    String(order.currency).toUpperCase() !== product.currency ||
    transaction.items.length !== 1 ||
    !transactionItem ||
    transactionItem.itemId !== product.itemId ||
    transactionItem.quantity !== 1 ||
    transactionItem.amountMinor !== Number(order.amount_minor)
  ) {
    await recordRiskEvent(db, auth.account.id, "steam_transaction_mismatch", 95, String(order.id), {
      paymentOrderId: String(order.id),
    });
    throw new EconomyProblem(409, "STEAM_TRANSACTION_MISMATCH", "Steam 승인 거래가 이 계정의 결제 주문과 일치하지 않습니다.");
  }
  const disposition = steamTransactionDisposition(transaction.status);
  if (disposition === "reject") {
    const terminalStatus = transaction.status === "Failed"
      ? "failed"
      : ["Refunded", "PartialRefund"].includes(transaction.status)
        ? "refunded"
        : ["Chargedback", "ChargedBack", "RefundedSuspectedFraud"].includes(transaction.status)
          ? "chargeback"
          : null;
    if (terminalStatus) {
      await db.prepare(`UPDATE economy_payment_orders SET status=? WHERE id=? AND status IN ('created','authorized')`)
        .bind(terminalStatus, order.id).run();
    }
    throw new EconomyProblem(409, transaction.status === "Init" ? "STEAM_PAYMENT_NOT_APPROVED" : "PAYMENT_RECONCILIATION_REQUIRED", transaction.status === "Init" ? "Steam에서 결제 승인이 완료되지 않았습니다." : "결제 상태 확인이 필요하여 자동 확정을 중단했습니다.");
  }
  const authorizedAt = Date.now();
  await db.prepare(`UPDATE economy_payment_orders SET status='authorized',authorized_at=COALESCE(authorized_at,?) WHERE id=? AND status IN ('created','authorized')`)
    .bind(authorizedAt, order.id).run();

  if (disposition === "finalize") {
    const endpoint = env.STEAM_MICROTXN_SANDBOX === "true" ? "https://partner.steam-api.com/ISteamMicroTxnSandbox/FinalizeTxn/v2/" : "https://partner.steam-api.com/ISteamMicroTxn/FinalizeTxn/v2/";
    const form = new URLSearchParams({ key: env.STEAM_PUBLISHER_KEY, orderid: String(order.provider_order_id), appid: env.STEAM_APP_ID });
    const response = await steamFetch(endpoint, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form });
    const payload = await response.json().catch(() => null) as { response?: { result?: string } } | null;
    if (!response.ok || payload?.response?.result !== "OK") throw new EconomyProblem(503, "STEAM_PAYMENT_FINALIZE_FAILED", "Steam 결제 확정에 실패했습니다.", true);
  }
  try {
    await db.prepare(`INSERT INTO economy_payment_finalize_commands(id,payment_order_id,account_id,idempotency_key,request_hash,created_at) VALUES(?,?,?,?,?,?)`)
      .bind(uuid(), String(order.id), auth.account.id, parsed.idempotencyKey, parsed.requestHash, Date.now()).run();
  } catch (error) {
    const committed = await db.prepare(`SELECT status FROM economy_payment_orders WHERE id=? AND account_id=? LIMIT 1`)
      .bind(parsed.paymentOrderId, auth.account.id).first<{ status: string }>();
    if (committed?.status === "finalized") return success({ paymentOrderId: order.id, holdHours: 72 }, String(order.id), true);
    throw error;
  }
  return success({ paymentOrderId: order.id, holdHours: 72 }, String(order.id));
}

async function adminSanctions(request: Request, db: D1Database, env: EconomyD1Env): Promise<Response> {
  if (!isLocalHost(new URL(request.url))) {
    throw new EconomyProblem(423, "ADMIN_CONTROL_PLANE_LOCKED", "명명된 운영자·MFA·RBAC·2인 승인이 준비되기 전에는 원격 제재 API를 열 수 없습니다.");
  }
  if (!env.ECONOMY_ADMIN_KEY) throw new EconomyProblem(503, "ADMIN_NOT_CONFIGURED", "관리자 보안 키가 구성되지 않았습니다.");
  if (!env.ECONOMY_ACCOUNT_PEPPER) throw new EconomyProblem(503, "SECURITY_CONFIG_MISSING", "운영 계정 보안 키가 구성되지 않았습니다.");
  if (!sameOrigin(request)) throw new EconomyProblem(403, "INVALID_ORIGIN", "동일 출처 관리자 요청만 허용됩니다.");
  await enforceRequestRateLimit(request, db, env, "economy-admin", 20, 60_000, 10 * 60_000, "admin-api");
  const supplied = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  if (!supplied || !(await constantTimeSecretEqual(supplied, env.ECONOMY_ADMIN_KEY))) throw new EconomyProblem(403, "ADMIN_FORBIDDEN", "관리자 권한이 없습니다.");
  const value = await readJson(request);
  const parsed = parseAdminEconomyRequest(value);
  if (!parsed || await computeCanonicalRequestHash(value as Record<string, unknown>) !== parsed.requestHash) throw new EconomyProblem(400, "BAD_ADMIN_REQUEST", "관리자 요청이 올바르지 않습니다.");
  const auditMetadata = JSON.stringify({
    reason: parsed.reason,
    ...("evidenceReference" in parsed && parsed.evidenceReference ? { evidenceReference: parsed.evidenceReference } : {}),
    ...(parsed.action === "apply_sanction" ? { scope: parsed.scope, expiresAt: parsed.expiresAt } : {}),
  });
  type AdminReplayRow = { request_hash: string | null; action: string; object_id: string; request_id: string };
  const findAdminReplay = () => db.prepare(`SELECT request_hash,action,object_id,request_id FROM economy_audit_events WHERE actor_account_id IS NULL AND idempotency_key=? LIMIT 1`)
    .bind(parsed.idempotencyKey).first<AdminReplayRow>();
  const replayResponse = (row: AdminReplayRow): Response => success(
    row.action === "apply_sanction" || row.action === "revoke_sanction" ? { sanctionId: row.object_id } : { accountId: row.object_id },
    row.request_id,
    true,
  );
  const existingReplay = await findAdminReplay();
  if (existingReplay) {
    if (existingReplay.request_hash !== parsed.requestHash) throw new EconomyProblem(409, "IDEMPOTENCY_CONFLICT", "관리자 멱등 키가 다른 요청에 재사용됐습니다.");
    return replayResponse(existingReplay);
  }
  const runAdminBatch = async (statements: D1PreparedStatement[], data: unknown, resultRequestId: string): Promise<Response> => {
    try {
      await db.batch(statements);
      return success(data, resultRequestId);
    } catch (error) {
      const raced = await findAdminReplay();
      if (raced) {
        if (raced.request_hash !== parsed.requestHash) throw new EconomyProblem(409, "IDEMPOTENCY_CONFLICT", "관리자 멱등 키가 다른 요청에 재사용됐습니다.");
        return replayResponse(raced);
      }
      throw error;
    }
  };
  const now = Date.now();
  const requestId = uuid();
  if (parsed.action === "apply_sanction") {
    const sanctionId = uuid();
    return runAdminBatch([
      db.prepare(`INSERT INTO economy_sanctions(id,account_id,scope,reason,evidence_reference,starts_at,expires_at,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?)`).bind(sanctionId, parsed.targetAccountId, parsed.scope, parsed.reason, parsed.evidenceReference, now, parsed.expiresAt, "admin-api", now),
      db.prepare(`UPDATE economy_accounts SET status=CASE WHEN status='banned' THEN status WHEN ? IS NULL AND ? IN ('login','market','exchange','payment','wallet') THEN 'restricted' ELSE status END,auth_epoch=auth_epoch+1,updated_at=? WHERE id=?`).bind(parsed.expiresAt, parsed.scope, now, parsed.targetAccountId),
      db.prepare(`UPDATE economy_sessions SET revoked_at=? WHERE account_id=? AND revoked_at IS NULL`).bind(now, parsed.targetAccountId),
      db.prepare(`INSERT INTO economy_audit_events(id,target_account_id,action,object_type,object_id,request_id,idempotency_key,request_hash,metadata_json,created_at) VALUES(?,?,'apply_sanction','sanction',?,?,?,?,?,?)`).bind(uuid(), parsed.targetAccountId, sanctionId, requestId, parsed.idempotencyKey, parsed.requestHash, auditMetadata, now),
    ], { sanctionId }, requestId);
  }
  if (parsed.action === "revoke_sanction") {
    const sanction = await db.prepare(`SELECT account_id FROM economy_sanctions WHERE id=? LIMIT 1`).bind(parsed.sanctionId).first<{ account_id: string }>();
    if (!sanction) throw new EconomyProblem(404, "SANCTION_NOT_FOUND", "제재를 찾을 수 없습니다.");
    return runAdminBatch([
      db.prepare(`UPDATE economy_sanctions SET revoked_at=? WHERE id=? AND revoked_at IS NULL`).bind(now, parsed.sanctionId),
      db.prepare(`UPDATE economy_accounts SET status=CASE
        WHEN status IN ('banned','frozen') THEN status
        WHEN wallet_frozen=1 OR EXISTS(SELECT 1 FROM economy_sanctions s WHERE s.account_id=economy_accounts.id AND s.revoked_at IS NULL AND s.starts_at<=? AND (s.expires_at IS NULL OR s.expires_at>?) AND s.scope IN ('login','market','exchange','payment','wallet')) THEN 'restricted'
        ELSE 'active' END,updated_at=? WHERE id=?`).bind(now, now, now, sanction.account_id),
      db.prepare(`INSERT INTO economy_audit_events(id,action,object_type,object_id,request_id,idempotency_key,request_hash,metadata_json,created_at) VALUES(?,'revoke_sanction','sanction',?,?,?,?,?,?)`).bind(uuid(), parsed.sanctionId, requestId, parsed.idempotencyKey, parsed.requestHash, auditMetadata, now),
    ], { sanctionId: parsed.sanctionId }, requestId);
  }
  const targetAccountId = parsed.targetAccountId;
  const statements: D1PreparedStatement[] = [];
  if (parsed.action === "freeze_wallet" || parsed.action === "unfreeze_wallet") {
    if (parsed.action === "freeze_wallet") {
      statements.push(db.prepare(`UPDATE economy_accounts SET wallet_frozen=1,status=CASE WHEN status='banned' THEN status ELSE 'restricted' END,auth_epoch=auth_epoch+1,updated_at=? WHERE id=?`).bind(now, targetAccountId));
    } else {
      statements.push(db.prepare(`UPDATE economy_accounts SET wallet_frozen=0,status=CASE
        WHEN status IN ('banned','frozen') THEN status
        WHEN EXISTS(SELECT 1 FROM economy_sanctions s WHERE s.account_id=economy_accounts.id AND s.revoked_at IS NULL AND s.starts_at<=? AND (s.expires_at IS NULL OR s.expires_at>?) AND s.scope IN ('login','market','exchange','payment','wallet')) THEN 'restricted'
        ELSE 'active' END,auth_epoch=auth_epoch+1,updated_at=? WHERE id=?`).bind(now, now, now, targetAccountId));
    }
  } else {
    statements.push(
      db.prepare(`UPDATE economy_accounts SET auth_epoch=auth_epoch+1,updated_at=? WHERE id=?`).bind(now, targetAccountId),
      db.prepare(`UPDATE economy_sessions SET revoked_at=? WHERE account_id=? AND revoked_at IS NULL`).bind(now, targetAccountId),
    );
  }
  statements.push(db.prepare(`INSERT INTO economy_audit_events(id,target_account_id,action,object_type,object_id,request_id,idempotency_key,request_hash,metadata_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)`)
    .bind(uuid(), targetAccountId, parsed.action, "account", targetAccountId, requestId, parsed.idempotencyKey, parsed.requestHash, auditMetadata, now));
  return runAdminBatch(statements, { accountId: targetAccountId }, requestId);
}

async function health(db: D1Database, env: EconomyD1Env): Promise<Response> {
  const schema = await db.prepare(`SELECT COUNT(*) AS count FROM sqlite_master
    WHERE type='table' AND name IN ('economy_accounts','economy_wallets','economy_items','economy_listings','economy_listing_expiry_commands','economy_ledger')`)
    .first<{ count: number }>();
  if (Number(schema?.count ?? 0) !== 6) {
    throw new EconomyProblem(503, "ECONOMY_MIGRATION_REQUIRED", "secure market migrations are not fully applied.");
  }
  return json({
    ok: true,
    storage: "d1",
    schema: "secure-market-v1",
    liveEnabled: env.ECONOMY_LIVE_ENABLED === "true",
    paymentsEnabled: steamPaymentsEnabled(env),
    paymentsConfigured: Boolean(env.STEAM_PUBLISHER_KEY && env.STEAM_APP_ID),
    securityConfigured: Boolean(env.ECONOMY_ACCOUNT_PEPPER),
    chargebackReconciliationReady: CHARGEBACK_RECONCILIATION_READY,
    productionPaymentBlocked: !CHARGEBACK_RECONCILIATION_READY,
    remoteAdminControlPlaneReady: false,
    legacyUploadAccepted: false,
  });
}

function methodNotAllowed(allowed: string): Response {
  return json({ ok: false, error: { code: "METHOD_NOT_ALLOWED", message: `Use ${allowed}.`, retryable: false } }, 405, { allow: allowed });
}

export async function handleEconomyRequest(request: Request, env: EconomyD1Env): Promise<Response> {
  const requestId = uuid();
  try {
    if (!env.DB) throw new EconomyProblem(503, "ECONOMY_UNAVAILABLE", "경제 D1 binding이 없습니다.", true);
    const db = env.DB;
    const url = new URL(request.url);
    await ensureEconomySchema(db, { allowLocalBootstrap: isLocalHost(url) });
    await ensureEconomyTriggers(db);
    const route = url.pathname.replace(/\/+$/, "");
    if (route === "/api/economy/health") return request.method === "GET" ? await health(db, env) : methodNotAllowed("GET");
    if (route === "/api/economy/auth/steam/start") return request.method === "GET" ? await steamStart(request, db, env) : methodNotAllowed("GET");
    if (route === "/api/economy/auth/steam/callback") return request.method === "GET" ? await steamCallback(request, db, env) : methodNotAllowed("GET");
    if (route === "/api/economy/admin/sanctions") return request.method === "POST" ? await adminSanctions(request, db, env) : methodNotAllowed("POST");
    const auth = await authenticate(request, db);
    if (request.method === "GET" && (route === "/api/economy/snapshot" || route === "/api/economy/market")) {
      await enforceRequestRateLimit(request, db, env, "economy-read", auth.development ? 600 : 120, 60_000, 60_000, auth.account.id);
    }
    if (route === "/api/economy/snapshot") return request.method === "GET" ? success(await buildSnapshot(db, env, auth, request), requestId) : methodNotAllowed("GET");
    if (route === "/api/economy/market") return request.method === "GET" ? await marketResponse(request, db, auth) : methodNotAllowed("GET");
    if (route === "/api/economy/command") return request.method === "POST" ? await executeCommand(request, db, env, auth) : methodNotAllowed("POST");
    if (route === "/api/economy/payments/steam/init") return request.method === "POST" ? await steamPaymentInit(request, db, env, auth) : methodNotAllowed("POST");
    if (route === "/api/economy/payments/steam/finalize") return request.method === "POST" ? await steamPaymentFinalize(request, db, env, auth) : methodNotAllowed("POST");
    return json({ ok: false, error: { code: "NOT_FOUND", message: "Unknown economy route.", retryable: false } }, 404);
  } catch (error) {
    if (error instanceof EconomySchemaMissingError) {
      return json({ ok: false, requestId, error: { code: "ECONOMY_MIGRATION_REQUIRED", message: "secure market migrations are not fully applied.", retryable: false } }, 503);
    }
    if (error instanceof EconomyProblem) {
      return json({ ok: false, requestId, serverTime: Date.now(), error: { code: error.code, message: error.message, retryable: error.retryable } }, error.status, error.retryable ? { "retry-after": "1" } : undefined);
    }
    const message = error instanceof Error ? error.message : String(error);
    if (/no such table/i.test(message)) {
      if (env.DB) resetEconomySchemaReadiness(env.DB);
      return json({ ok: false, requestId, error: { code: "ECONOMY_MIGRATION_REQUIRED", message: "secure market migrations are not fully applied.", retryable: false } }, 503);
    }
    return json({ ok: false, requestId, serverTime: Date.now(), error: { code: "ECONOMY_STORAGE_ERROR", message: "경제 서버 저장 작업에 실패했습니다.", retryable: true } }, 503, { "retry-after": "1" });
  }
}

/**
 * Optional production gate for binding realtime PVP traffic to the same
 * immutable account and sanction state as the economy. It stays disabled until
 * Steam account linking is configured, so local/offline PVP keeps working.
 */
export async function authorizeRealtimeEconomyRequest(
  request: Request,
  env: EconomyD1Env,
): Promise<{ accountId: string; displayName: string } | Response | null> {
  if (env.PVP_ACCOUNT_AUTH_ENABLED !== "true") return null;
  if (!env.DB) return json({ error: "realtime_identity_unavailable", message: "계정 인증 저장소를 사용할 수 없습니다." }, 503);
  try {
    const auth = await authenticate(request, env.DB);
    if (
      !auth.steamId ||
      auth.account.steam_ownership_verified !== 1 ||
      auth.account.trade_eligible !== 1 ||
      !auth.account.steam_verified_at ||
      auth.account.steam_verified_at < Date.now() - STEAM_OWNERSHIP_TTL_MS ||
      auth.account.status === "banned" ||
      auth.account.status === "frozen"
    ) {
      throw new EconomyProblem(403, "PVP_IDENTITY_REQUIRED", "Steam 소유권이 확인된 게임 계정으로 로그인해야 합니다.");
    }
    await assertNoActiveSanction(env.DB, auth.account.id, ["login", "pvp"]);
    return { accountId: auth.account.id, displayName: auth.account.display_name };
  } catch (error) {
    if (error instanceof EconomyProblem) {
      return json({ error: error.code.toLowerCase(), message: error.message }, error.status);
    }
    return json({ error: "realtime_identity_error", message: "PVP 계정 상태를 확인하지 못했습니다." }, 503);
  }
}

/**
 * The shared plaza is an account-owned world, so unlike optional offline PVP
 * it never accepts an anonymous identity. Local A/B accounts still pass
 * through authenticate() only when worker/index.ts reconstructed the internal
 * development header from a same-origin localhost request.
 */
export async function authorizeHubEconomyRequest(
  request: Request,
  env: EconomyD1Env,
): Promise<{ accountId: string; displayName: string } | Response | null> {
  if (!env.DB) {
    return json(
      { error: "hub_identity_unavailable", message: "The account store is unavailable." },
      503,
    );
  }
  const accountAuthRequired = env.PVP_ACCOUNT_AUTH_ENABLED === "true";
  try {
    const auth = await authenticate(request, env.DB);
    const accountIsEligible =
      auth.account.status === "active" &&
      auth.account.steam_ownership_verified === 1 &&
      auth.account.trade_eligible === 1;
    const steamIsFresh =
      auth.development ||
      Boolean(
        auth.steamId &&
        auth.account.steam_verified_at &&
        auth.account.steam_verified_at >= Date.now() - STEAM_OWNERSHIP_TTL_MS,
      );
    if (accountAuthRequired && (!accountIsEligible || !steamIsFresh)) {
      throw new EconomyProblem(
        403,
        "HUB_IDENTITY_REQUIRED",
        "Enter the shared plaza with a verified game account.",
      );
    }
    await assertNoActiveSanction(env.DB, auth.account.id, ["login", "multiplayer", "pvp"]);
    return {
      accountId: auth.account.id,
      displayName: auth.account.display_name,
    };
  } catch (error) {
    if (error instanceof EconomyProblem) {
      if (!accountAuthRequired && error.status === 401) return null;
      return json(
        { error: error.code.toLowerCase(), message: error.message },
        error.status,
      );
    }
    return json(
      { error: "hub_identity_error", message: "Could not verify the plaza account." },
      503,
    );
  }
}

export const ECONOMY_SECURITY_RULES = {
  goldHoldMs: GOLD_HOLD_MS,
  productionWritesRequireLaunchGate: true,
  clientSaveUploadAccepted: false,
  steamSecretsServerOnly: true,
} as const;
