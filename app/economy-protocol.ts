/**
 * Dependency-free wire contract for Mujindo's server-authoritative economy.
 *
 * This module intentionally contains no storage, authentication, payment, or
 * game-domain imports. Every parser is an allow-list parser: unknown fields are
 * rejected instead of silently copied. In particular, account identity,
 * ownership, balances, fees, and payment rewards are never client-writable.
 *
 * Parsing is only the first trust boundary. Callers must still authenticate the
 * session, authorize the action, verify request hashes, enforce idempotency,
 * and execute balance/ownership changes in one database transaction.
 */

export const ECONOMY_PROTOCOL_VERSION = 1 as const;

export const ECONOMY_COMMAND_ACTIONS = [
  "list_item",
  "buy_listing",
  "cancel_listing",
  "place_exchange",
  "fill_exchange",
  "cancel_exchange",
  "sandbox_topup",
] as const;

export type EconomyCommandAction = (typeof ECONOMY_COMMAND_ACTIONS)[number];

export const ECONOMY_CURRENCIES = ["ash", "gold"] as const;
export type EconomyCurrency = (typeof ECONOMY_CURRENCIES)[number];

export const EXCHANGE_SIDES = ["buy_gold", "sell_gold"] as const;
export type ExchangeSide = (typeof EXCHANGE_SIDES)[number];

export const ECONOMY_ITEM_STATES = [
  "inventory",
  "equipped",
  "escrow",
  "destroyed",
] as const;
export type EconomyItemState = (typeof ECONOMY_ITEM_STATES)[number];

export const MARKET_LISTING_STATUSES = [
  "open",
  "sold",
  "cancelled",
  "expired",
] as const;
export type MarketListingStatus = (typeof MARKET_LISTING_STATUSES)[number];

export const EXCHANGE_ORDER_STATUSES = [
  "open",
  "partially_filled",
  "filled",
  "cancelled",
  "expired",
] as const;
export type ExchangeOrderStatus = (typeof EXCHANGE_ORDER_STATUSES)[number];

export const ECONOMY_ACCOUNT_STATUSES = [
  "active",
  "restricted",
  "frozen",
  "banned",
] as const;
export type EconomyAccountStatus = (typeof ECONOMY_ACCOUNT_STATUSES)[number];

export const ECONOMY_SANCTION_SCOPES = [
  "login",
  "pvp",
  "market",
  "exchange",
  "payment",
  "wallet",
  "chat",
] as const;
export type EconomySanctionScope = (typeof ECONOMY_SANCTION_SCOPES)[number];

export const ECONOMY_EQUIPMENT_SLOTS = [
  "weapon",
  "offhand",
  "helm",
  "shoulders",
  "armor",
  "gloves",
  "belt",
  "legs",
  "boots",
  "relic",
] as const;
export type EconomyEquipmentSlot = (typeof ECONOMY_EQUIPMENT_SLOTS)[number];

export const ECONOMY_GEAR_RARITIES = [
  "common",
  "magic",
  "superior",
  "rare",
  "epic",
  "legendary",
  "mythic",
  "cosmic",
] as const;
export type EconomyGearRarity = (typeof ECONOMY_GEAR_RARITIES)[number];

/** Upper bounds are deliberately below Number.MAX_SAFE_INTEGER. */
export const ECONOMY_MAX_ASH = 9_000_000_000_000;
export const ECONOMY_MAX_GOLD = 1_000_000_000;
export const ECONOMY_MAX_LISTING_PRICE_ASH = 1_000_000_000_000;
export const ECONOMY_MAX_EXCHANGE_PRICE_ASH_PER_GOLD = 1_000_000_000;
export const ECONOMY_MAX_EXCHANGE_GOLD_PER_ORDER = 10_000_000;
export const ECONOMY_MAX_EXCHANGE_NOTIONAL_ASH = 9_000_000_000_000;
export const ECONOMY_MAX_SANDBOX_TOPUP_ASH = 1_000_000_000;
export const ECONOMY_MAX_SANDBOX_TOPUP_GOLD = 100_000;
export const ECONOMY_MAX_ITEM_LEVEL = 999;
export const ECONOMY_MAX_VERSION = 2_147_483_647;
export const ECONOMY_MIN_LISTING_DURATION_SECONDS = 5 * 60;
export const ECONOMY_MAX_LISTING_DURATION_SECONDS = 30 * 24 * 60 * 60;
export const ECONOMY_DEFAULT_MARKET_PAGE_SIZE = 30;
export const ECONOMY_MAX_MARKET_PAGE_SIZE = 100;
export const ECONOMY_MAX_INVENTORY_SNAPSHOT_ITEMS = 2_000;
export const ECONOMY_MAX_OWN_MARKET_RECORDS = 500;
export const ECONOMY_MAX_CANONICAL_JSON_BYTES = 64 * 1024;
export const ECONOMY_MAX_TIMESTAMP_MS = 8_640_000_000_000_000;
export const ECONOMY_UUID_LENGTH = 36;
export const ECONOMY_IDEMPOTENCY_KEY_MIN_LENGTH = 16;
export const ECONOMY_IDEMPOTENCY_KEY_MAX_LENGTH = 96;
export const ECONOMY_REQUEST_HASH_LENGTH = 64;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | JsonObject;
export type JsonObject = { [key: string]: JsonValue };

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]*[A-Za-z0-9])$/;
const REQUEST_HASH_PATTERN = /^[0-9a-f]{64}$/i;
const CURSOR_PATTERN = /^[A-Za-z0-9_-]{1,256}$/;
const SAFE_TOKEN_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]*[A-Za-z0-9])$/;
const PRODUCT_SKU_PATTERN = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])$/;
const STEAM_TICKET_PATTERN = /^(?:[0-9a-f]{2}){16,2048}$/i;
const CURRENCY_CODE_PATTERN = /^[A-Z]{3}$/;
const FORBIDDEN_OBJECT_KEYS = new Set(["__proto__", "prototype", "constructor"]);

const isRecord = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const isOneOf = <T extends string>(
  values: readonly T[],
  value: unknown,
): value is T => typeof value === "string" && values.includes(value as T);

const hasExactKeys = (
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean => {
  const actual = Object.keys(value);
  return (
    actual.length === keys.length &&
    actual.every((key) => keys.includes(key)) &&
    keys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
  );
};

const hasOnlyKeys = (
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean => Object.keys(value).every((key) => keys.includes(key));

const isBoundedSafeInteger = (
  value: unknown,
  minimum: number,
  maximum: number,
): value is number =>
  Number.isSafeInteger(value) &&
  (value as number) >= minimum &&
  (value as number) <= maximum;

const isTimestamp = (value: unknown): value is number =>
  isBoundedSafeInteger(value, 0, ECONOMY_MAX_TIMESTAMP_MS);

const normalizeText = (
  value: unknown,
  minimumLength: number,
  maximumLength: number,
): string | null => {
  if (typeof value !== "string") return null;
  const normalized = value
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return normalized.length >= minimumLength && normalized.length <= maximumLength
    ? normalized
    : null;
};

const normalizeSafeToken = (
  value: unknown,
  minimumLength: number,
  maximumLength: number,
): string | null => {
  if (
    typeof value !== "string" ||
    value.length < minimumLength ||
    value.length > maximumLength ||
    !SAFE_TOKEN_PATTERN.test(value)
  ) {
    return null;
  }
  return value;
};

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

export function normalizeUuid(value: unknown): string | null {
  return isUuid(value) ? value.toLowerCase() : null;
}

export function isIdempotencyKey(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= ECONOMY_IDEMPOTENCY_KEY_MIN_LENGTH &&
    value.length <= ECONOMY_IDEMPOTENCY_KEY_MAX_LENGTH &&
    IDEMPOTENCY_KEY_PATTERN.test(value)
  );
}

export function normalizeIdempotencyKey(value: unknown): string | null {
  return isIdempotencyKey(value) ? value : null;
}

export function isRequestHash(value: unknown): value is string {
  return typeof value === "string" && REQUEST_HASH_PATTERN.test(value);
}

export function normalizeRequestHash(value: unknown): string | null {
  return isRequestHash(value) ? value.toLowerCase() : null;
}

export function isOpaqueCursor(value: unknown): value is string {
  return typeof value === "string" && CURSOR_PATTERN.test(value);
}

function normalizeJsonValue(
  value: unknown,
  depth = 0,
  seen = new Set<object>(),
): JsonValue | null | undefined {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER) {
      return undefined;
    }
    return Object.is(value, -0) ? 0 : value;
  }
  if (depth >= 32 || typeof value !== "object" || value === null || seen.has(value)) {
    return undefined;
  }
  seen.add(value);
  if (Array.isArray(value)) {
    if (value.length > 4_096) {
      seen.delete(value);
      return undefined;
    }
    const result: JsonValue[] = [];
    for (const member of value) {
      const normalized = normalizeJsonValue(member, depth + 1, seen);
      if (normalized === undefined) {
        seen.delete(value);
        return undefined;
      }
      result.push(normalized);
    }
    seen.delete(value);
    return result;
  }
  if (!isRecord(value)) {
    seen.delete(value);
    return undefined;
  }
  const keys = Object.keys(value);
  if (keys.length > 1_024 || keys.some((key) => FORBIDDEN_OBJECT_KEYS.has(key))) {
    seen.delete(value);
    return undefined;
  }
  const result: JsonObject = {};
  for (const key of keys) {
    const normalized = normalizeJsonValue(value[key], depth + 1, seen);
    if (normalized === undefined) {
      seen.delete(value);
      return undefined;
    }
    result[key] = normalized;
  }
  seen.delete(value);
  return result;
}

export function parseJsonValue(value: unknown): JsonValue | null {
  const normalized = normalizeJsonValue(value);
  return normalized === undefined ? null : normalized;
}

export function isJsonValue(value: unknown): value is JsonValue {
  return normalizeJsonValue(value) !== undefined;
}

function canonicalizeNormalizedJson(value: JsonValue): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") return JSON.stringify(Object.is(value, -0) ? 0 : value);
  if (Array.isArray(value)) {
    return `[${value.map(canonicalizeNormalizedJson).join(",")}]`;
  }
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalizeNormalizedJson(value[key])}`)
    .join(",")}}`;
}

/** RFC-8785-inspired deterministic JSON for request hashing. */
export function canonicalizeJson(value: unknown): string {
  const normalized = normalizeJsonValue(value);
  if (normalized === undefined) throw new TypeError("Value is not bounded JSON");
  const canonical = canonicalizeNormalizedJson(normalized);
  if (new TextEncoder().encode(canonical).byteLength > ECONOMY_MAX_CANONICAL_JSON_BYTES) {
    throw new RangeError("Canonical request exceeds the economy protocol limit");
  }
  return canonical;
}

const toHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

export async function sha256CanonicalJson(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalizeJson(value));
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return toHex(new Uint8Array(digest));
}

function requestHashMaterial<T extends Record<string, unknown>>(value: T): Omit<T, "requestHash"> {
  const result: Record<string, unknown> = {};
  for (const [key, member] of Object.entries(value)) {
    if (key !== "requestHash") result[key] = member;
  }
  return result as Omit<T, "requestHash">;
}

/** Hashes a request after removing its single top-level `requestHash` field. */
export async function computeCanonicalRequestHash(
  value: Record<string, unknown>,
): Promise<string> {
  return sha256CanonicalJson(requestHashMaterial(value));
}

export function timingSafeEqualHex(left: string, right: string): boolean {
  const normalizedLeft = left.toLowerCase();
  const normalizedRight = right.toLowerCase();
  let difference = normalizedLeft.length ^ normalizedRight.length;
  const length = Math.max(normalizedLeft.length, normalizedRight.length);
  for (let index = 0; index < length; index += 1) {
    difference |=
      (normalizedLeft.charCodeAt(index) || 0) ^
      (normalizedRight.charCodeAt(index) || 0);
  }
  return difference === 0;
}

export async function verifyCanonicalRequestHash(
  value: Record<string, unknown>,
  expectedHash: unknown = value.requestHash,
): Promise<boolean> {
  const normalizedExpected = normalizeRequestHash(expectedHash);
  if (!normalizedExpected) return false;
  const actual = await computeCanonicalRequestHash(value);
  return timingSafeEqualHex(actual, normalizedExpected);
}

type CommandEnvelope = {
  protocolVersion: typeof ECONOMY_PROTOCOL_VERSION;
  idempotencyKey: string;
  requestHash: string;
};

export type ListItemCommand = CommandEnvelope & {
  action: "list_item";
  itemId: string;
  priceAsh: number;
  expiresInSeconds: number;
  expectedItemVersion: number;
};

export type BuyListingCommand = CommandEnvelope & {
  action: "buy_listing";
  listingId: string;
  expectedListingVersion: number;
  expectedPriceAsh: number;
};

export type CancelListingCommand = CommandEnvelope & {
  action: "cancel_listing";
  listingId: string;
  expectedListingVersion: number;
};

export type PlaceExchangeCommand = CommandEnvelope & {
  action: "place_exchange";
  side: ExchangeSide;
  goldAmount: number;
  priceAshPerGold: number;
};

export type FillExchangeCommand = CommandEnvelope & {
  action: "fill_exchange";
  orderId: string;
  goldAmount: number;
  expectedOrderVersion: number;
  expectedPriceAshPerGold: number;
};

export type CancelExchangeCommand = CommandEnvelope & {
  action: "cancel_exchange";
  orderId: string;
  expectedOrderVersion: number;
};

export type SandboxTopupCommand = CommandEnvelope & {
  action: "sandbox_topup";
  currency: EconomyCurrency;
  amount: number;
};

export type EconomyCommand =
  | ListItemCommand
  | BuyListingCommand
  | CancelListingCommand
  | PlaceExchangeCommand
  | FillExchangeCommand
  | CancelExchangeCommand
  | SandboxTopupCommand;

type WithoutRequestHash<T> = T extends unknown ? Omit<T, "requestHash"> : never;
export type EconomyCommandDraft = WithoutRequestHash<EconomyCommand>;

const COMMON_COMMAND_KEYS = ["protocolVersion", "action", "idempotencyKey", "requestHash"];

function parseCommandEnvelope(
  value: Record<string, unknown>,
): CommandEnvelope | null {
  if (
    value.protocolVersion !== ECONOMY_PROTOCOL_VERSION ||
    !isIdempotencyKey(value.idempotencyKey)
  ) {
    return null;
  }
  const requestHash = normalizeRequestHash(value.requestHash);
  if (!requestHash) return null;
  return {
    protocolVersion: ECONOMY_PROTOCOL_VERSION,
    idempotencyKey: value.idempotencyKey,
    requestHash,
  };
}

function validExchangeNotional(goldAmount: number, priceAshPerGold: number): boolean {
  const notional = goldAmount * priceAshPerGold;
  return (
    Number.isSafeInteger(notional) &&
    notional >= 1 &&
    notional <= ECONOMY_MAX_EXCHANGE_NOTIONAL_ASH
  );
}

/**
 * Strictly parses a signed command. This validates hash syntax, not equality;
 * call `verifyEconomyCommandHash` after parsing and before any state access.
 */
export function parseEconomyCommand(value: unknown): EconomyCommand | null {
  if (!isRecord(value) || !isOneOf(ECONOMY_COMMAND_ACTIONS, value.action)) return null;
  const envelope = parseCommandEnvelope(value);
  if (!envelope) return null;

  switch (value.action) {
    case "list_item": {
      if (
        !hasExactKeys(value, [
          ...COMMON_COMMAND_KEYS,
          "itemId",
          "priceAsh",
          "expiresInSeconds",
          "expectedItemVersion",
        ]) ||
        !isUuid(value.itemId) ||
        !isBoundedSafeInteger(value.priceAsh, 1, ECONOMY_MAX_LISTING_PRICE_ASH) ||
        !isBoundedSafeInteger(
          value.expiresInSeconds,
          ECONOMY_MIN_LISTING_DURATION_SECONDS,
          ECONOMY_MAX_LISTING_DURATION_SECONDS,
        ) ||
        !isBoundedSafeInteger(value.expectedItemVersion, 0, ECONOMY_MAX_VERSION)
      ) {
        return null;
      }
      return {
        ...envelope,
        action: "list_item",
        itemId: value.itemId.toLowerCase(),
        priceAsh: value.priceAsh,
        expiresInSeconds: value.expiresInSeconds,
        expectedItemVersion: value.expectedItemVersion,
      };
    }
    case "buy_listing": {
      if (
        !hasExactKeys(value, [
          ...COMMON_COMMAND_KEYS,
          "listingId",
          "expectedListingVersion",
          "expectedPriceAsh",
        ]) ||
        !isUuid(value.listingId) ||
        !isBoundedSafeInteger(value.expectedListingVersion, 0, ECONOMY_MAX_VERSION) ||
        !isBoundedSafeInteger(value.expectedPriceAsh, 1, ECONOMY_MAX_LISTING_PRICE_ASH)
      ) {
        return null;
      }
      return {
        ...envelope,
        action: "buy_listing",
        listingId: value.listingId.toLowerCase(),
        expectedListingVersion: value.expectedListingVersion,
        expectedPriceAsh: value.expectedPriceAsh,
      };
    }
    case "cancel_listing": {
      if (
        !hasExactKeys(value, [
          ...COMMON_COMMAND_KEYS,
          "listingId",
          "expectedListingVersion",
        ]) ||
        !isUuid(value.listingId) ||
        !isBoundedSafeInteger(value.expectedListingVersion, 0, ECONOMY_MAX_VERSION)
      ) {
        return null;
      }
      return {
        ...envelope,
        action: "cancel_listing",
        listingId: value.listingId.toLowerCase(),
        expectedListingVersion: value.expectedListingVersion,
      };
    }
    case "place_exchange": {
      if (
        !hasExactKeys(value, [
          ...COMMON_COMMAND_KEYS,
          "side",
          "goldAmount",
          "priceAshPerGold",
        ]) ||
        !isOneOf(EXCHANGE_SIDES, value.side) ||
        !isBoundedSafeInteger(value.goldAmount, 1, ECONOMY_MAX_EXCHANGE_GOLD_PER_ORDER) ||
        !isBoundedSafeInteger(
          value.priceAshPerGold,
          1,
          ECONOMY_MAX_EXCHANGE_PRICE_ASH_PER_GOLD,
        ) ||
        !validExchangeNotional(value.goldAmount, value.priceAshPerGold)
      ) {
        return null;
      }
      return {
        ...envelope,
        action: "place_exchange",
        side: value.side,
        goldAmount: value.goldAmount,
        priceAshPerGold: value.priceAshPerGold,
      };
    }
    case "fill_exchange": {
      if (
        !hasExactKeys(value, [
          ...COMMON_COMMAND_KEYS,
          "orderId",
          "goldAmount",
          "expectedOrderVersion",
          "expectedPriceAshPerGold",
        ]) ||
        !isUuid(value.orderId) ||
        !isBoundedSafeInteger(value.goldAmount, 1, ECONOMY_MAX_EXCHANGE_GOLD_PER_ORDER) ||
        !isBoundedSafeInteger(value.expectedOrderVersion, 0, ECONOMY_MAX_VERSION) ||
        !isBoundedSafeInteger(
          value.expectedPriceAshPerGold,
          1,
          ECONOMY_MAX_EXCHANGE_PRICE_ASH_PER_GOLD,
        ) ||
        !validExchangeNotional(value.goldAmount, value.expectedPriceAshPerGold)
      ) {
        return null;
      }
      return {
        ...envelope,
        action: "fill_exchange",
        orderId: value.orderId.toLowerCase(),
        goldAmount: value.goldAmount,
        expectedOrderVersion: value.expectedOrderVersion,
        expectedPriceAshPerGold: value.expectedPriceAshPerGold,
      };
    }
    case "cancel_exchange": {
      if (
        !hasExactKeys(value, [
          ...COMMON_COMMAND_KEYS,
          "orderId",
          "expectedOrderVersion",
        ]) ||
        !isUuid(value.orderId) ||
        !isBoundedSafeInteger(value.expectedOrderVersion, 0, ECONOMY_MAX_VERSION)
      ) {
        return null;
      }
      return {
        ...envelope,
        action: "cancel_exchange",
        orderId: value.orderId.toLowerCase(),
        expectedOrderVersion: value.expectedOrderVersion,
      };
    }
    case "sandbox_topup": {
      if (
        !hasExactKeys(value, [
          ...COMMON_COMMAND_KEYS,
          "currency",
          "amount",
        ]) ||
        !isOneOf(ECONOMY_CURRENCIES, value.currency)
      ) {
        return null;
      }
      const maximum =
        value.currency === "ash"
          ? ECONOMY_MAX_SANDBOX_TOPUP_ASH
          : ECONOMY_MAX_SANDBOX_TOPUP_GOLD;
      if (!isBoundedSafeInteger(value.amount, 1, maximum)) return null;
      return {
        ...envelope,
        action: "sandbox_topup",
        currency: value.currency,
        amount: value.amount,
      };
    }
  }
}

const EMPTY_REQUEST_HASH = "0".repeat(ECONOMY_REQUEST_HASH_LENGTH);

/**
 * Parses the exact same allow-listed command shape before it is signed. A
 * draft must not contain `requestHash`; this prevents accidentally hashing an
 * attacker-supplied duplicate or nested authority field.
 */
export function parseEconomyCommandDraft(value: unknown): EconomyCommandDraft | null {
  if (!isRecord(value) || Object.prototype.hasOwnProperty.call(value, "requestHash")) {
    return null;
  }
  const signed = parseEconomyCommand({ ...value, requestHash: EMPTY_REQUEST_HASH });
  if (!signed) return null;
  return requestHashMaterial(
    signed as unknown as Record<string, unknown>,
  ) as EconomyCommandDraft;
}

export async function computeEconomyCommandHash(
  command: EconomyCommand | EconomyCommandDraft,
): Promise<string> {
  const record = command as unknown as Record<string, unknown>;
  const signed = Object.prototype.hasOwnProperty.call(record, "requestHash")
    ? parseEconomyCommand(record)
    : null;
  const draft = signed
    ? parseEconomyCommandDraft(requestHashMaterial(signed as unknown as Record<string, unknown>))
    : parseEconomyCommandDraft(record);
  if (!draft) throw new TypeError("Invalid economy command draft");
  return sha256CanonicalJson(draft);
}

export async function verifyEconomyCommandHash(command: EconomyCommand): Promise<boolean> {
  return verifyCanonicalRequestHash(
    command as unknown as Record<string, unknown>,
    command.requestHash,
  );
}

export type ItemMarketQuery = {
  kind: "items";
  cursor?: string;
  limit: number;
  sort: "newest" | "price_asc" | "price_desc" | "level_desc" | "rarity_desc";
  search?: string;
  slot?: EconomyEquipmentSlot;
  rarity?: EconomyGearRarity;
  minLevel?: number;
  maxLevel?: number;
  minPriceAsh?: number;
  maxPriceAsh?: number;
};

export type ExchangeMarketQuery = {
  kind: "exchange";
  cursor?: string;
  limit: number;
  side: ExchangeSide | "both";
};

export type MarketQuery = ItemMarketQuery | ExchangeMarketQuery;

export function parseMarketQuery(value: unknown): MarketQuery | null {
  if (!isRecord(value) || (value.kind !== "items" && value.kind !== "exchange")) return null;
  if (value.kind === "exchange") {
    if (!hasOnlyKeys(value, ["kind", "cursor", "limit", "side"])) return null;
    const cursor = value.cursor === undefined ? undefined : value.cursor;
    const limit = value.limit === undefined ? ECONOMY_DEFAULT_MARKET_PAGE_SIZE : value.limit;
    const side = value.side === undefined ? "both" : value.side;
    if (
      (cursor !== undefined && !isOpaqueCursor(cursor)) ||
      !isBoundedSafeInteger(limit, 1, ECONOMY_MAX_MARKET_PAGE_SIZE) ||
      (side !== "both" && !isOneOf(EXCHANGE_SIDES, side))
    ) {
      return null;
    }
    return {
      kind: "exchange",
      ...(cursor === undefined ? {} : { cursor }),
      limit,
      side,
    };
  }

  const allowedKeys = [
    "kind",
    "cursor",
    "limit",
    "sort",
    "search",
    "slot",
    "rarity",
    "minLevel",
    "maxLevel",
    "minPriceAsh",
    "maxPriceAsh",
  ];
  if (!hasOnlyKeys(value, allowedKeys)) return null;
  const cursor = value.cursor === undefined ? undefined : value.cursor;
  const limit = value.limit === undefined ? ECONOMY_DEFAULT_MARKET_PAGE_SIZE : value.limit;
  const sort = value.sort === undefined ? "newest" : value.sort;
  const search = value.search === undefined ? undefined : normalizeText(value.search, 1, 40);
  if (
    (cursor !== undefined && !isOpaqueCursor(cursor)) ||
    !isBoundedSafeInteger(limit, 1, ECONOMY_MAX_MARKET_PAGE_SIZE) ||
    !isOneOf(
      ["newest", "price_asc", "price_desc", "level_desc", "rarity_desc"] as const,
      sort,
    ) ||
    (value.search !== undefined && search === null) ||
    (value.slot !== undefined && !isOneOf(ECONOMY_EQUIPMENT_SLOTS, value.slot)) ||
    (value.rarity !== undefined && !isOneOf(ECONOMY_GEAR_RARITIES, value.rarity)) ||
    (value.minLevel !== undefined &&
      !isBoundedSafeInteger(value.minLevel, 1, ECONOMY_MAX_ITEM_LEVEL)) ||
    (value.maxLevel !== undefined &&
      !isBoundedSafeInteger(value.maxLevel, 1, ECONOMY_MAX_ITEM_LEVEL)) ||
    (value.minPriceAsh !== undefined &&
      !isBoundedSafeInteger(value.minPriceAsh, 1, ECONOMY_MAX_LISTING_PRICE_ASH)) ||
    (value.maxPriceAsh !== undefined &&
      !isBoundedSafeInteger(value.maxPriceAsh, 1, ECONOMY_MAX_LISTING_PRICE_ASH))
  ) {
    return null;
  }
  if (
    value.minLevel !== undefined &&
    value.maxLevel !== undefined &&
    value.minLevel > value.maxLevel
  ) {
    return null;
  }
  if (
    value.minPriceAsh !== undefined &&
    value.maxPriceAsh !== undefined &&
    value.minPriceAsh > value.maxPriceAsh
  ) {
    return null;
  }
  return {
    kind: "items",
    ...(cursor === undefined ? {} : { cursor }),
    limit,
    sort,
    ...(search === undefined ? {} : { search }),
    ...(value.slot === undefined ? {} : { slot: value.slot }),
    ...(value.rarity === undefined ? {} : { rarity: value.rarity }),
    ...(value.minLevel === undefined ? {} : { minLevel: value.minLevel }),
    ...(value.maxLevel === undefined ? {} : { maxLevel: value.maxLevel }),
    ...(value.minPriceAsh === undefined ? {} : { minPriceAsh: value.minPriceAsh }),
    ...(value.maxPriceAsh === undefined ? {} : { maxPriceAsh: value.maxPriceAsh }),
  } as ItemMarketQuery;
}

export type EconomyItemSnapshot = {
  id: string;
  version: number;
  state: EconomyItemState;
  tradeable: boolean;
  slot: EconomyEquipmentSlot;
  rarity: EconomyGearRarity;
  itemLevel: number;
  name: string;
  data: JsonObject;
};

export type MarketListingSnapshot = {
  id: string;
  item: EconomyItemSnapshot;
  sellerAlias: string;
  priceAsh: number;
  status: MarketListingStatus;
  version: number;
  createdAt: number;
  expiresAt: number;
};

export type ExchangeOrderSnapshot = {
  id: string;
  side: ExchangeSide;
  goldAmountInitial: number;
  goldAmountRemaining: number;
  priceAshPerGold: number;
  status: ExchangeOrderStatus;
  version: number;
  createdAt: number;
};

export type EconomyWalletSnapshot = {
  ashAvailable: number;
  ashReserved: number;
  goldAvailable: number;
  goldReserved: number;
  goldChargebackHold: number;
  version: number;
};

export type EconomyAccountSnapshot = {
  id: string;
  displayName: string;
  status: EconomyAccountStatus;
};

export type EconomySanctionSnapshot = {
  id: string;
  scope: EconomySanctionScope;
  reason: string;
  expiresAt: number | null;
};

export type EconomySnapshot = {
  protocolVersion: typeof ECONOMY_PROTOCOL_VERSION;
  serverTime: number;
  revision: number;
  account: EconomyAccountSnapshot;
  wallet: EconomyWalletSnapshot;
  inventory: EconomyItemSnapshot[];
  listings: MarketListingSnapshot[];
  exchangeOrders: ExchangeOrderSnapshot[];
  sanctions: EconomySanctionSnapshot[];
};

export function parseEconomyItemSnapshot(value: unknown): EconomyItemSnapshot | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "id",
      "version",
      "state",
      "tradeable",
      "slot",
      "rarity",
      "itemLevel",
      "name",
      "data",
    ])
  ) {
    return null;
  }
  const id = normalizeUuid(value.id);
  const name = normalizeText(value.name, 1, 64);
  const normalizedData = normalizeJsonValue(value.data);
  if (
    !id ||
    !isBoundedSafeInteger(value.version, 0, ECONOMY_MAX_VERSION) ||
    !isOneOf(ECONOMY_ITEM_STATES, value.state) ||
    typeof value.tradeable !== "boolean" ||
    !isOneOf(ECONOMY_EQUIPMENT_SLOTS, value.slot) ||
    !isOneOf(ECONOMY_GEAR_RARITIES, value.rarity) ||
    !isBoundedSafeInteger(value.itemLevel, 1, ECONOMY_MAX_ITEM_LEVEL) ||
    !name ||
    normalizedData === undefined ||
    normalizedData === null ||
    Array.isArray(normalizedData) ||
    typeof normalizedData !== "object"
  ) {
    return null;
  }
  try {
    canonicalizeJson(normalizedData);
  } catch {
    return null;
  }
  return {
    id,
    version: value.version,
    state: value.state,
    tradeable: value.tradeable,
    slot: value.slot,
    rarity: value.rarity,
    itemLevel: value.itemLevel,
    name,
    data: normalizedData as JsonObject,
  };
}

export function parseMarketListingSnapshot(value: unknown): MarketListingSnapshot | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "id",
      "item",
      "sellerAlias",
      "priceAsh",
      "status",
      "version",
      "createdAt",
      "expiresAt",
    ])
  ) {
    return null;
  }
  const id = normalizeUuid(value.id);
  const item = parseEconomyItemSnapshot(value.item);
  const sellerAlias = normalizeText(value.sellerAlias, 1, 24);
  if (
    !id ||
    !item ||
    !sellerAlias ||
    !isBoundedSafeInteger(value.priceAsh, 1, ECONOMY_MAX_LISTING_PRICE_ASH) ||
    !isOneOf(MARKET_LISTING_STATUSES, value.status) ||
    !isBoundedSafeInteger(value.version, 0, ECONOMY_MAX_VERSION) ||
    !isTimestamp(value.createdAt) ||
    !isTimestamp(value.expiresAt) ||
    value.expiresAt <= value.createdAt
  ) {
    return null;
  }
  return {
    id,
    item,
    sellerAlias,
    priceAsh: value.priceAsh,
    status: value.status,
    version: value.version,
    createdAt: value.createdAt,
    expiresAt: value.expiresAt,
  };
}

export function parseExchangeOrderSnapshot(value: unknown): ExchangeOrderSnapshot | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "id",
      "side",
      "goldAmountInitial",
      "goldAmountRemaining",
      "priceAshPerGold",
      "status",
      "version",
      "createdAt",
    ])
  ) {
    return null;
  }
  const id = normalizeUuid(value.id);
  if (
    !id ||
    !isOneOf(EXCHANGE_SIDES, value.side) ||
    !isBoundedSafeInteger(value.goldAmountInitial, 1, ECONOMY_MAX_EXCHANGE_GOLD_PER_ORDER) ||
    !isBoundedSafeInteger(
      value.goldAmountRemaining,
      0,
      value.goldAmountInitial as number,
    ) ||
    !isBoundedSafeInteger(
      value.priceAshPerGold,
      1,
      ECONOMY_MAX_EXCHANGE_PRICE_ASH_PER_GOLD,
    ) ||
    !validExchangeNotional(value.goldAmountInitial, value.priceAshPerGold) ||
    !isOneOf(EXCHANGE_ORDER_STATUSES, value.status) ||
    !isBoundedSafeInteger(value.version, 0, ECONOMY_MAX_VERSION) ||
    !isTimestamp(value.createdAt)
  ) {
    return null;
  }
  return {
    id,
    side: value.side,
    goldAmountInitial: value.goldAmountInitial,
    goldAmountRemaining: value.goldAmountRemaining,
    priceAshPerGold: value.priceAshPerGold,
    status: value.status,
    version: value.version,
    createdAt: value.createdAt,
  };
}

export function parseEconomyWalletSnapshot(value: unknown): EconomyWalletSnapshot | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "ashAvailable",
      "ashReserved",
      "goldAvailable",
      "goldReserved",
      "goldChargebackHold",
      "version",
    ]) ||
    !isBoundedSafeInteger(value.ashAvailable, 0, ECONOMY_MAX_ASH) ||
    !isBoundedSafeInteger(value.ashReserved, 0, ECONOMY_MAX_ASH) ||
    !isBoundedSafeInteger(value.goldAvailable, 0, ECONOMY_MAX_GOLD) ||
    !isBoundedSafeInteger(value.goldReserved, 0, ECONOMY_MAX_GOLD) ||
    !isBoundedSafeInteger(value.goldChargebackHold, 0, ECONOMY_MAX_GOLD) ||
    !isBoundedSafeInteger(value.version, 0, ECONOMY_MAX_VERSION)
  ) {
    return null;
  }
  if (
    value.ashAvailable + value.ashReserved > ECONOMY_MAX_ASH ||
    value.goldAvailable + value.goldReserved + value.goldChargebackHold > ECONOMY_MAX_GOLD
  ) {
    return null;
  }
  return {
    ashAvailable: value.ashAvailable,
    ashReserved: value.ashReserved,
    goldAvailable: value.goldAvailable,
    goldReserved: value.goldReserved,
    goldChargebackHold: value.goldChargebackHold,
    version: value.version,
  };
}

function parseArray<T>(
  value: unknown,
  maximumLength: number,
  parser: (member: unknown) => T | null,
): T[] | null {
  if (!Array.isArray(value) || value.length > maximumLength) return null;
  const result: T[] = [];
  for (const member of value) {
    const parsed = parser(member);
    if (parsed === null) return null;
    result.push(parsed);
  }
  return result;
}

export function parseEconomySnapshot(value: unknown): EconomySnapshot | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "protocolVersion",
      "serverTime",
      "revision",
      "account",
      "wallet",
      "inventory",
      "listings",
      "exchangeOrders",
      "sanctions",
    ]) ||
    value.protocolVersion !== ECONOMY_PROTOCOL_VERSION ||
    !isTimestamp(value.serverTime) ||
    !isBoundedSafeInteger(value.revision, 0, ECONOMY_MAX_VERSION) ||
    !isRecord(value.account) ||
    !hasExactKeys(value.account, ["id", "displayName", "status"])
  ) {
    return null;
  }
  const accountId = normalizeUuid(value.account.id);
  const displayName = normalizeText(value.account.displayName, 1, 24);
  const wallet = parseEconomyWalletSnapshot(value.wallet);
  const inventory = parseArray(
    value.inventory,
    ECONOMY_MAX_INVENTORY_SNAPSHOT_ITEMS,
    parseEconomyItemSnapshot,
  );
  const listings = parseArray(
    value.listings,
    ECONOMY_MAX_OWN_MARKET_RECORDS,
    parseMarketListingSnapshot,
  );
  const exchangeOrders = parseArray(
    value.exchangeOrders,
    ECONOMY_MAX_OWN_MARKET_RECORDS,
    parseExchangeOrderSnapshot,
  );
  const sanctions = parseArray(
    value.sanctions,
    64,
    (member): EconomySanctionSnapshot | null => {
      if (
        !isRecord(member) ||
        !hasExactKeys(member, ["id", "scope", "reason", "expiresAt"])
      ) {
        return null;
      }
      const id = normalizeUuid(member.id);
      const reason = normalizeText(member.reason, 1, 240);
      if (
        !id ||
        !isOneOf(ECONOMY_SANCTION_SCOPES, member.scope) ||
        !reason ||
        (member.expiresAt !== null && !isTimestamp(member.expiresAt))
      ) {
        return null;
      }
      return { id, scope: member.scope, reason, expiresAt: member.expiresAt };
    },
  );
  if (
    !accountId ||
    !displayName ||
    !isOneOf(ECONOMY_ACCOUNT_STATUSES, value.account.status) ||
    !wallet ||
    !inventory ||
    !listings ||
    !exchangeOrders ||
    !sanctions
  ) {
    return null;
  }
  return {
    protocolVersion: ECONOMY_PROTOCOL_VERSION,
    serverTime: value.serverTime,
    revision: value.revision,
    account: { id: accountId, displayName, status: value.account.status },
    wallet,
    inventory,
    listings,
    exchangeOrders,
    sanctions,
  };
}

export type ItemMarketPage = {
  kind: "item_listings";
  serverTime: number;
  revision: number;
  listings: MarketListingSnapshot[];
  nextCursor: string | null;
};

export type ExchangeOrderBookPage = {
  kind: "exchange_book";
  serverTime: number;
  revision: number;
  buyOrders: ExchangeOrderSnapshot[];
  sellOrders: ExchangeOrderSnapshot[];
  nextCursor: string | null;
};

export type MarketPage = ItemMarketPage | ExchangeOrderBookPage;

export function parseMarketPage(value: unknown): MarketPage | null {
  if (!isRecord(value)) return null;
  if (value.kind === "item_listings") {
    if (
      !hasExactKeys(value, [
        "kind",
        "serverTime",
        "revision",
        "listings",
        "nextCursor",
      ]) ||
      !isTimestamp(value.serverTime) ||
      !isBoundedSafeInteger(value.revision, 0, ECONOMY_MAX_VERSION) ||
      (value.nextCursor !== null && !isOpaqueCursor(value.nextCursor))
    ) {
      return null;
    }
    const listings = parseArray(
      value.listings,
      ECONOMY_MAX_MARKET_PAGE_SIZE,
      parseMarketListingSnapshot,
    );
    return listings
      ? {
          kind: "item_listings",
          serverTime: value.serverTime,
          revision: value.revision,
          listings,
          nextCursor: value.nextCursor,
        }
      : null;
  }
  if (value.kind === "exchange_book") {
    if (
      !hasExactKeys(value, [
        "kind",
        "serverTime",
        "revision",
        "buyOrders",
        "sellOrders",
        "nextCursor",
      ]) ||
      !isTimestamp(value.serverTime) ||
      !isBoundedSafeInteger(value.revision, 0, ECONOMY_MAX_VERSION) ||
      (value.nextCursor !== null && !isOpaqueCursor(value.nextCursor))
    ) {
      return null;
    }
    const buyOrders = parseArray(
      value.buyOrders,
      ECONOMY_MAX_MARKET_PAGE_SIZE,
      parseExchangeOrderSnapshot,
    );
    const sellOrders = parseArray(
      value.sellOrders,
      ECONOMY_MAX_MARKET_PAGE_SIZE,
      parseExchangeOrderSnapshot,
    );
    if (!buyOrders || !sellOrders) return null;
    return {
      kind: "exchange_book",
      serverTime: value.serverTime,
      revision: value.revision,
      buyOrders,
      sellOrders,
      nextCursor: value.nextCursor,
    };
  }
  return null;
}

export const parseMarketSnapshot = parseMarketPage;

export type EconomyErrorCode =
  | "BAD_REQUEST"
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "SANCTIONED"
  | "RATE_LIMITED"
  | "HASH_MISMATCH"
  | "IDEMPOTENCY_CONFLICT"
  | "NOT_FOUND"
  | "VERSION_CONFLICT"
  | "PRICE_CHANGED"
  | "INSUFFICIENT_FUNDS"
  | "INVENTORY_FULL"
  | "ITEM_NOT_TRADEABLE"
  | "SELF_TRADE_FORBIDDEN"
  | "MARKET_CLOSED"
  | "PAYMENT_REQUIRED"
  | "INTERNAL_ERROR";

export type EconomyApiSuccess<T = JsonValue> = {
  ok: true;
  requestId: string;
  replayed: boolean;
  serverTime: number;
  data: T;
};

export type EconomyApiError = {
  ok: false;
  requestId: string;
  serverTime: number;
  error: {
    code: EconomyErrorCode;
    message: string;
    retryable: boolean;
  };
};

export type EconomyApiResponse<T = JsonValue> =
  | EconomyApiSuccess<T>
  | EconomyApiError;

export type EconomyCommandResult = {
  action: EconomyCommandAction;
  revision: number;
  wallet: EconomyWalletSnapshot;
  listing?: MarketListingSnapshot;
  order?: ExchangeOrderSnapshot;
  item?: EconomyItemSnapshot;
};

export type SteamTicketRequest = {
  ticket: string;
  nonce: string;
};

/** The server chooses the Steam app id and derives the SteamID64 itself. */
export function parseSteamTicketRequest(value: unknown): SteamTicketRequest | null {
  if (!isRecord(value) || !hasExactKeys(value, ["ticket", "nonce"])) return null;
  const nonce = normalizeSafeToken(value.nonce, 16, 128);
  if (typeof value.ticket !== "string" || !STEAM_TICKET_PATTERN.test(value.ticket) || !nonce) {
    return null;
  }
  return { ticket: value.ticket.toLowerCase(), nonce };
}

export const parseSteamAuthRequest = parseSteamTicketRequest;

export type PaymentCheckoutRequest = {
  productSku: string;
  idempotencyKey: string;
  requestHash: string;
};

/** Price, currency, gold amount, account, and redirect URL are server-owned. */
export function parsePaymentCheckoutRequest(value: unknown): PaymentCheckoutRequest | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["productSku", "idempotencyKey", "requestHash"]) ||
    typeof value.productSku !== "string" ||
    value.productSku.length < 3 ||
    value.productSku.length > 48 ||
    !PRODUCT_SKU_PATTERN.test(value.productSku) ||
    !isIdempotencyKey(value.idempotencyKey)
  ) {
    return null;
  }
  const requestHash = normalizeRequestHash(value.requestHash);
  return requestHash
    ? {
        productSku: value.productSku,
        idempotencyKey: value.idempotencyKey,
        requestHash,
      }
    : null;
}

export type PaymentFinalizeRequest = {
  paymentOrderId: string;
  idempotencyKey: string;
  requestHash: string;
};

/** The browser identifies only the server-issued payment order it is returning from. */
export function parsePaymentFinalizeRequest(value: unknown): PaymentFinalizeRequest | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["paymentOrderId", "idempotencyKey", "requestHash"]) ||
    !isIdempotencyKey(value.idempotencyKey)
  ) {
    return null;
  }
  const paymentOrderId = normalizeUuid(value.paymentOrderId);
  const requestHash = normalizeRequestHash(value.requestHash);
  return paymentOrderId && requestHash
    ? { paymentOrderId, idempotencyKey: value.idempotencyKey, requestHash }
    : null;
}

export type SteamTransactionDisposition = "finalize" | "recover" | "reject";

/** Only an approved or already-succeeded provider transaction can reach minting. */
export function steamTransactionDisposition(status: unknown): SteamTransactionDisposition {
  if (status === "Approved") return "finalize";
  if (status === "Succeeded") return "recover";
  return "reject";
}

export type SteamTransactionItem = {
  itemId: string;
  quantity: number;
  amountMinor: number;
};

function normalizeSteamSafeInteger(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  }
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]{0,15})$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/** Steam uint64 identifiers remain strings; monetary and quantity values must be safe integers. */
export function parseSteamTransactionItems(value: unknown): SteamTransactionItem[] | null {
  if (!Array.isArray(value)) return null;
  const items: SteamTransactionItem[] = [];
  for (const member of value) {
    if (!isRecord(member)) return null;
    const itemId = typeof member.itemid === "string"
      ? (/^(?:0|[1-9][0-9]{0,19})$/.test(member.itemid) ? member.itemid : null)
      : (typeof member.itemid === "number" && Number.isSafeInteger(member.itemid) && member.itemid >= 0
          ? String(member.itemid)
          : null);
    if (!itemId) return null;
    const quantity = normalizeSteamSafeInteger(member.qty);
    const amountMinor = normalizeSteamSafeInteger(member.amount);
    if (quantity === null || amountMinor === null) return null;
    items.push({ itemId, quantity, amountMinor });
  }
  return items;
}

export const VERIFIED_PAYMENT_EVENT_KINDS = [
  "payment_succeeded",
  "payment_refunded",
  "payment_chargeback",
] as const;
export type VerifiedPaymentEventKind = (typeof VERIFIED_PAYMENT_EVENT_KINDS)[number];

export type VerifiedPaymentEvent = {
  providerEventId: string;
  kind: VerifiedPaymentEventKind;
  checkoutId: string;
  paymentReference: string;
  amountMinor: number;
  currency: string;
  occurredAt: number;
};

/**
 * Parse only after the provider signature and timestamp have been verified
 * against the raw request body. Gold rewards must be loaded from the server
 * product catalog, never from this event or the client.
 */
export function parseVerifiedPaymentEvent(value: unknown): VerifiedPaymentEvent | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "providerEventId",
      "kind",
      "checkoutId",
      "paymentReference",
      "amountMinor",
      "currency",
      "occurredAt",
    ])
  ) {
    return null;
  }
  const providerEventId = normalizeSafeToken(value.providerEventId, 8, 160);
  const checkoutId = normalizeUuid(value.checkoutId);
  const paymentReference = normalizeSafeToken(value.paymentReference, 6, 160);
  if (
    !providerEventId ||
    !checkoutId ||
    !paymentReference ||
    !isOneOf(VERIFIED_PAYMENT_EVENT_KINDS, value.kind) ||
    !isBoundedSafeInteger(value.amountMinor, 1, 1_000_000_000_000) ||
    typeof value.currency !== "string" ||
    !CURRENCY_CODE_PATTERN.test(value.currency) ||
    !isTimestamp(value.occurredAt)
  ) {
    return null;
  }
  return {
    providerEventId,
    kind: value.kind,
    checkoutId,
    paymentReference,
    amountMinor: value.amountMinor,
    currency: value.currency,
    occurredAt: value.occurredAt,
  };
}

export const ADMIN_ECONOMY_ACTIONS = [
  "apply_sanction",
  "revoke_sanction",
  "freeze_wallet",
  "unfreeze_wallet",
  "invalidate_sessions",
] as const;
export type AdminEconomyAction = (typeof ADMIN_ECONOMY_ACTIONS)[number];

type AdminEnvelope = {
  protocolVersion: typeof ECONOMY_PROTOCOL_VERSION;
  idempotencyKey: string;
  requestHash: string;
};

export type AdminEconomyRequest =
  | (AdminEnvelope & {
      action: "apply_sanction";
      targetAccountId: string;
      scope: EconomySanctionScope;
      reason: string;
      expiresAt: number | null;
      evidenceReference: string | null;
    })
  | (AdminEnvelope & {
      action: "revoke_sanction";
      sanctionId: string;
      reason: string;
    })
  | (AdminEnvelope & {
      action: "freeze_wallet" | "unfreeze_wallet";
      targetAccountId: string;
      reason: string;
      evidenceReference: string | null;
    })
  | (AdminEnvelope & {
      action: "invalidate_sessions";
      targetAccountId: string;
      reason: string;
    });

function parseAdminEnvelope(value: Record<string, unknown>): AdminEnvelope | null {
  const requestHash = normalizeRequestHash(value.requestHash);
  if (
    value.protocolVersion !== ECONOMY_PROTOCOL_VERSION ||
    !isIdempotencyKey(value.idempotencyKey) ||
    !requestHash
  ) {
    return null;
  }
  return {
    protocolVersion: ECONOMY_PROTOCOL_VERSION,
    idempotencyKey: value.idempotencyKey,
    requestHash,
  };
}

/** Authentication, MFA, RBAC, and two-person approval remain caller duties. */
export function parseAdminEconomyRequest(value: unknown): AdminEconomyRequest | null {
  if (!isRecord(value) || !isOneOf(ADMIN_ECONOMY_ACTIONS, value.action)) return null;
  const envelope = parseAdminEnvelope(value);
  if (!envelope) return null;
  if (value.action === "apply_sanction") {
    if (
      !hasExactKeys(value, [
        "protocolVersion",
        "action",
        "idempotencyKey",
        "requestHash",
        "targetAccountId",
        "scope",
        "reason",
        "expiresAt",
        "evidenceReference",
      ])
    ) {
      return null;
    }
    const targetAccountId = normalizeUuid(value.targetAccountId);
    const reason = normalizeText(value.reason, 8, 500);
    const evidenceReference =
      value.evidenceReference === null
        ? null
        : normalizeSafeToken(value.evidenceReference, 6, 160);
    if (
      !targetAccountId ||
      !isOneOf(ECONOMY_SANCTION_SCOPES, value.scope) ||
      !reason ||
      (value.expiresAt !== null && !isTimestamp(value.expiresAt)) ||
      (value.evidenceReference !== null && !evidenceReference)
    ) {
      return null;
    }
    return {
      ...envelope,
      action: "apply_sanction",
      targetAccountId,
      scope: value.scope,
      reason,
      expiresAt: value.expiresAt,
      evidenceReference,
    };
  }
  if (value.action === "revoke_sanction") {
    if (
      !hasExactKeys(value, [
        "protocolVersion",
        "action",
        "idempotencyKey",
        "requestHash",
        "sanctionId",
        "reason",
      ])
    ) {
      return null;
    }
    const sanctionId = normalizeUuid(value.sanctionId);
    const reason = normalizeText(value.reason, 8, 500);
    return sanctionId && reason
      ? { ...envelope, action: "revoke_sanction", sanctionId, reason }
      : null;
  }
  if (value.action === "freeze_wallet" || value.action === "unfreeze_wallet") {
    if (
      !hasExactKeys(value, [
        "protocolVersion",
        "action",
        "idempotencyKey",
        "requestHash",
        "targetAccountId",
        "reason",
        "evidenceReference",
      ])
    ) {
      return null;
    }
    const targetAccountId = normalizeUuid(value.targetAccountId);
    const reason = normalizeText(value.reason, 8, 500);
    const evidenceReference =
      value.evidenceReference === null
        ? null
        : normalizeSafeToken(value.evidenceReference, 6, 160);
    if (
      !targetAccountId ||
      !reason ||
      (value.evidenceReference !== null && !evidenceReference)
    ) {
      return null;
    }
    return {
      ...envelope,
      action: value.action,
      targetAccountId,
      reason,
      evidenceReference,
    };
  }
  if (
    !hasExactKeys(value, [
      "protocolVersion",
      "action",
      "idempotencyKey",
      "requestHash",
      "targetAccountId",
      "reason",
    ])
  ) {
    return null;
  }
  const targetAccountId = normalizeUuid(value.targetAccountId);
  const reason = normalizeText(value.reason, 8, 500);
  return targetAccountId && reason
    ? { ...envelope, action: "invalidate_sessions", targetAccountId, reason }
    : null;
}

export const parseAdminRequest = parseAdminEconomyRequest;
