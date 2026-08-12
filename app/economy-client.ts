/**
 * Browser client for the authoritative economy service.
 *
 * This module deliberately never reads or mutates the local save file. Tradeable
 * gear and both currencies are hydrated exclusively from the server snapshot.
 */
import {
  ECONOMY_PROTOCOL_VERSION,
  computeCanonicalRequestHash,
  computeEconomyCommandHash,
  type EconomyCommandDraft,
} from "./economy-protocol";

export const ECONOMY_POLL_INTERVAL_MS = 5_000;

export const MARKET_RARITIES = [
  "common",
  "magic",
  "superior",
  "rare",
  "epic",
  "legendary",
  "mythic",
  "cosmic",
] as const;

export type MarketRarity = (typeof MARKET_RARITIES)[number];

export const MARKET_SLOTS = [
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

export type MarketSlot = (typeof MARKET_SLOTS)[number];

export type WalletBalance = {
  available: number;
  escrow: number;
  locked72h: number;
};

export type EconomyWallet = {
  memoryAsh: WalletBalance;
  goldBars: WalletBalance;
};

export type EconomyAccount = {
  userId: string | null;
  displayName: string;
  steamId: string | null;
  steamLinked: boolean;
  gameOwned: boolean;
  restricted: boolean;
  restrictionReason: string | null;
  sanctionCode: string | null;
  trustTier: "unverified" | "standard" | "trusted" | "restricted";
  createdAt: string | null;
};

export type MarketVaultItem = {
  vaultItemId: string;
  itemId: string;
  displayName: string;
  baseName: string;
  rarity: MarketRarity;
  slot: MarketSlot;
  level: number;
  enhancement: number;
  powerScore: number;
  qualityScore: number;
  iconIndex: number;
  affixes: Array<{ label: string; value: string }>;
  tradeState: "available" | "listed" | "escrow" | "locked";
  lockedUntil: string | null;
  version: number;
};

export type MarketListing = {
  listingId: string;
  sellerUserId: string;
  sellerName: string;
  item: MarketVaultItem;
  priceAsh: number;
  listedAt: string;
  expiresAt: string;
  mine: boolean;
  version: number;
};

export type GoldOrder = {
  orderId: string;
  side: "buy" | "sell";
  priceAshPerGold: number;
  goldAmount: number;
  remainingGold: number;
  status: "open" | "partial" | "filled" | "cancelled";
  mine: boolean;
  createdAt: string;
  version: number;
};

export type OrderBookLevel = {
  priceAshPerGold: number;
  goldAmount: number;
  orderCount: number;
};

export type GoldTrade = {
  tradeId: string;
  priceAshPerGold: number;
  goldAmount: number;
  executedAt: string;
};

export type EconomyAuditEntry = {
  id: string;
  category: string;
  message: string;
  ipHint: string | null;
  createdAt: string;
};

export type EconomySnapshot = {
  revision: number;
  serverTime: string;
  csrfToken: string | null;
  featureMode: "disabled" | "read-only" | "sandbox" | "live";
  launchGateReason: string | null;
  paymentMode: "disabled" | "sandbox" | "steam";
  account: EconomyAccount;
  wallet: EconomyWallet;
  vaultItems: MarketVaultItem[];
  listings: MarketListing[];
  goldExchange: {
    bestBid: number | null;
    bestAsk: number | null;
    lastPrice: number | null;
    bids: OrderBookLevel[];
    asks: OrderBookLevel[];
    myOrders: GoldOrder[];
    orders: GoldOrder[];
    recentTrades: GoldTrade[];
  };
  security: {
    activeSessions: number;
    lastLoginAt: string | null;
    lastSteamTicketVerifiedAt: string | null;
    withdrawalLockUntil: string | null;
    auditTrail: EconomyAuditEntry[];
  };
  capabilities: {
    canTrade: boolean;
    canTopUp: boolean;
    canUseGoldExchange: boolean;
    localSandbox: boolean;
  };
};

export type MarketSearch = {
  search?: string;
  rarity?: MarketRarity | "all";
  slot?: MarketSlot | "all";
  sort?: "recent" | "price-low" | "price-high" | "power" | "level";
};

export type EconomyCommand =
  | { action: "list_item"; itemId: string; priceAsh: number; expiresInSeconds: number; expectedItemVersion: number }
  | { action: "buy_listing"; listingId: string; expectedListingVersion: number; expectedPriceAsh: number }
  | { action: "cancel_listing"; listingId: string; expectedListingVersion: number }
  | {
      action: "place_exchange";
      side: "buy_gold" | "sell_gold";
      priceAshPerGold: number;
      goldAmount: number;
    }
  | {
      action: "fill_exchange";
      orderId: string;
      goldAmount: number;
      expectedOrderVersion: number;
      expectedPriceAshPerGold: number;
    }
  | { action: "cancel_exchange"; orderId: string; expectedOrderVersion: number }
  | { action: "sandbox_topup"; currency: "ash" | "gold"; amount: number };

export type EconomyClientOptions = {
  signal?: AbortSignal;
  demoUser?: "A" | "B" | null;
};

export class EconomyClientError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(message: string, status = 0, code = "ECONOMY_REQUEST_FAILED") {
    super(message);
    this.name = "EconomyClientError";
    this.status = status;
    this.code = code;
  }
}

const EMPTY_BALANCE: WalletBalance = { available: 0, escrow: 0, locked72h: 0 };

const EMPTY_SNAPSHOT: EconomySnapshot = {
  revision: 0,
  serverTime: new Date(0).toISOString(),
  csrfToken: null,
  featureMode: "disabled",
  launchGateReason: "경제 서버 응답을 기다리고 있습니다.",
  paymentMode: "disabled",
  account: {
    userId: null,
    displayName: "미연동 방랑자",
    steamId: null,
    steamLinked: false,
    gameOwned: false,
    restricted: false,
    restrictionReason: null,
    sanctionCode: null,
    trustTier: "unverified",
    createdAt: null,
  },
  wallet: { memoryAsh: { ...EMPTY_BALANCE }, goldBars: { ...EMPTY_BALANCE } },
  vaultItems: [],
  listings: [],
  goldExchange: {
    bestBid: null,
    bestAsk: null,
    lastPrice: null,
    bids: [],
    asks: [],
    myOrders: [],
    orders: [],
    recentTrades: [],
  },
  security: {
    activeSessions: 0,
    lastLoginAt: null,
    lastSteamTicketVerifiedAt: null,
    withdrawalLockUntil: null,
    auditTrail: [],
  },
  capabilities: {
    canTrade: false,
    canTopUp: false,
    canUseGoldExchange: false,
    localSandbox: false,
  },
};

export function isLocalEconomySandbox(hostname?: string): boolean {
  const host = hostname ?? (typeof window === "undefined" ? "" : window.location.hostname);
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
}

export function createEconomyIdempotencyKey(prefix = "economy"): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  return `${prefix}:${uuid ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
}

function demoHeaders(demoUser?: "A" | "B" | null): HeadersInit {
  if (!demoUser || !isLocalEconomySandbox()) return {};
  return { "x-mujindo-dev-user": demoUser };
}

async function readJson(response: Response): Promise<unknown> {
  const payload = await response.json().catch(() => null);
  const record = asRecord(payload);
  if (!response.ok || record?.ok === false) {
    const error = asRecord(record?.error);
    throw new EconomyClientError(
      typeof error?.message === "string"
        ? error.message
        : typeof record?.message === "string"
          ? record.message
          : "거래 서버가 요청을 거절했습니다.",
      response.status,
      typeof error?.code === "string"
        ? error.code
        : typeof record?.code === "string"
          ? record.code
          : "ECONOMY_REQUEST_FAILED",
    );
  }
  return record?.ok === true && Object.prototype.hasOwnProperty.call(record, "data")
    ? record.data
    : payload;
}

export async function fetchEconomySnapshot(
  options: EconomyClientOptions = {},
): Promise<EconomySnapshot> {
  const response = await fetch("/api/economy/snapshot", {
    method: "GET",
    credentials: "same-origin",
    cache: "no-store",
    headers: {
      Accept: "application/json",
      ...demoHeaders(options.demoUser),
    },
    signal: options.signal,
  });
  const payload = await readJson(response);
  const record = asRecord(payload);
  return normalizeEconomySnapshot({
    ...(record ?? {}),
    featureMode:
      record?.featureMode ?? response.headers.get("x-mujindo-economy-mode"),
    paymentMode:
      record?.paymentMode ?? response.headers.get("x-mujindo-payment-mode"),
    launchGateReason:
      record?.launchGateReason ?? response.headers.get("x-mujindo-launch-gate-reason"),
  });
}

export async function fetchMarketListings(
  search: MarketSearch,
  options: EconomyClientOptions = {},
): Promise<MarketListing[]> {
  const query = new URLSearchParams();
  query.set("kind", "items");
  query.set("limit", "60");
  if (search.search?.trim()) query.set("search", search.search.trim());
  if (search.rarity && search.rarity !== "all") query.set("rarity", search.rarity);
  if (search.slot && search.slot !== "all") query.set("slot", search.slot);
  const sortMap: Readonly<Record<NonNullable<MarketSearch["sort"]>, string>> = {
    recent: "newest",
    "price-low": "price_asc",
    "price-high": "price_desc",
    power: "rarity_desc",
    level: "level_desc",
  };
  if (search.sort) query.set("sort", sortMap[search.sort]);
  const response = await fetch(`/api/economy/market?${query.toString()}`, {
    method: "GET",
    credentials: "same-origin",
    cache: "no-store",
    headers: {
      Accept: "application/json",
      ...demoHeaders(options.demoUser),
    },
    signal: options.signal,
  });
  const payload = await readJson(response);
  const record = asRecord(payload);
  const listings = Array.isArray(payload)
    ? payload
    : Array.isArray(record?.listings)
      ? record.listings
      : [];
  return listings.map(normalizeListing).filter((listing): listing is MarketListing => listing !== null);
}

export async function fetchExchangeOrders(
  options: EconomyClientOptions = {},
): Promise<GoldOrder[]> {
  const query = new URLSearchParams({ kind: "exchange", side: "both", limit: "60" });
  const response = await fetch(`/api/economy/market?${query.toString()}`, {
    method: "GET",
    credentials: "same-origin",
    cache: "no-store",
    headers: { Accept: "application/json", ...demoHeaders(options.demoUser) },
    signal: options.signal,
  });
  const payload = await readJson(response);
  const record = asRecord(payload);
  const source = [
    ...arrayValue(record?.buyOrders),
    ...arrayValue(record?.sellOrders),
    ...arrayValue(record?.orders),
  ];
  return source.map(normalizeOrder).filter((order): order is GoldOrder => order !== null);
}

export async function sendEconomyCommand(
  command: EconomyCommand,
  snapshot: Pick<EconomySnapshot, "csrfToken" | "revision">,
  options: EconomyClientOptions = {},
): Promise<EconomySnapshot> {
  const idempotencyKey = createEconomyIdempotencyKey(command.action);
  const draft = {
    protocolVersion: ECONOMY_PROTOCOL_VERSION,
    idempotencyKey,
    ...command,
  } as EconomyCommandDraft;
  const requestHash = await computeEconomyCommandHash(draft);
  const response = await fetch("/api/economy/command", {
    method: "POST",
    credentials: "same-origin",
    cache: "no-store",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "X-Requested-With": "MujindoEconomyClient",
      "Idempotency-Key": idempotencyKey,
      ...demoHeaders(options.demoUser),
    },
    body: JSON.stringify({ ...draft, requestHash }),
    signal: options.signal,
  });
  await readJson(response);
  return fetchEconomySnapshot(options);
}

export async function initializeSteamGoldPurchase(
  packId: string,
  snapshot: Pick<EconomySnapshot, "csrfToken" | "revision">,
  options: EconomyClientOptions = {},
): Promise<{ redirectUrl: string | null; snapshot: EconomySnapshot | null }> {
  const idempotencyKey = createEconomyIdempotencyKey("steam-topup");
  const draft = { productSku: packId, idempotencyKey };
  const requestHash = await computeCanonicalRequestHash(draft);
  const response = await fetch("/api/economy/payments/steam/init", {
    method: "POST",
    credentials: "same-origin",
    cache: "no-store",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "X-Requested-With": "MujindoEconomyClient",
      "Idempotency-Key": idempotencyKey,
      ...demoHeaders(options.demoUser),
    },
    body: JSON.stringify({ ...draft, requestHash }),
    signal: options.signal,
  });
  const payload = await readJson(response);
  const record = asRecord(payload);
  return {
    redirectUrl: typeof record?.redirectUrl === "string" ? record.redirectUrl : null,
    snapshot: record?.snapshot ? normalizeEconomySnapshot(record.snapshot) : null,
  };
}

export async function finalizeSteamGoldPurchase(
  paymentOrderId: string,
  options: EconomyClientOptions = {},
): Promise<EconomySnapshot> {
  const idempotencyKey = createEconomyIdempotencyKey("steam-finalize");
  const draft = { paymentOrderId, idempotencyKey };
  const requestHash = await computeCanonicalRequestHash(draft);
  const response = await fetch("/api/economy/payments/steam/finalize", {
    method: "POST",
    credentials: "same-origin",
    cache: "no-store",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "X-Requested-With": "MujindoEconomyClient",
      "Idempotency-Key": idempotencyKey,
      ...demoHeaders(options.demoUser),
    },
    body: JSON.stringify({ ...draft, requestHash }),
    signal: options.signal,
  });
  await readJson(response);
  return fetchEconomySnapshot(options);
}

export function steamLinkUrl(returnTo = "/market"): string {
  const safeReturnTo = returnTo.startsWith("/") && !returnTo.startsWith("//") ? returnTo : "/market";
  return `/api/economy/auth/steam/start?return_to=${encodeURIComponent(safeReturnTo)}`;
}

export function formatEconomyAmount(value: number): string {
  return Math.max(0, Math.trunc(Number.isFinite(value) ? value : 0)).toLocaleString("ko-KR");
}

export function normalizeEconomySnapshot(payload: unknown): EconomySnapshot {
  const envelope = asRecord(payload);
  const data = asRecord(envelope?.data);
  const source = asRecord(data?.snapshot) ?? asRecord(envelope?.snapshot) ?? data ?? envelope;
  if (!source) return structuredClone(EMPTY_SNAPSHOT);
  const account = asRecord(source.account);
  const wallet = asRecord(source.wallet);
  const exchange = asRecord(source.goldExchange) ?? asRecord(source.exchange);
  const security = asRecord(source.security);
  const capabilities = asRecord(source.capabilities) ?? asRecord(data?.capabilities) ?? asRecord(envelope?.capabilities);
  const resolvedFeatureMode = featureMode(source.featureMode ?? data?.featureMode ?? envelope?.featureMode);
  const resolvedPaymentMode = paymentMode(source.paymentMode ?? data?.paymentMode ?? envelope?.paymentMode);
  const vaultSource = Array.isArray(source.vaultItems)
    ? source.vaultItems
    : Array.isArray(source.vault)
      ? source.vault
      : Array.isArray(source.inventory)
        ? source.inventory
        : [];
  const listingsSource = Array.isArray(source.listings) ? source.listings : [];
  return {
    revision: positiveInteger(source.revision, 0),
    serverTime: timestampString(source.serverTime),
    csrfToken: nullableString(source.csrfToken),
    featureMode: resolvedFeatureMode,
    launchGateReason: nullableString(source.launchGateReason ?? data?.launchGateReason ?? envelope?.launchGateReason),
    paymentMode: resolvedPaymentMode,
    account: {
      userId: nullableString(account?.userId ?? account?.id),
      displayName: stringValue(account?.displayName, "미연동 방랑자"),
      steamId: nullableString(account?.steamId),
      steamLinked: booleanValue(account?.steamLinked, isLocalEconomySandbox()),
      gameOwned: booleanValue(account?.gameOwned ?? account?.ownsGame, isLocalEconomySandbox()),
      restricted: booleanValue(account?.restricted ?? account?.sanctioned, account?.status !== undefined && account.status !== "active"),
      restrictionReason: nullableString(account?.restrictionReason) ?? nullableString(arrayValue(source.sanctions)[0] && asRecord(arrayValue(source.sanctions)[0])?.reason),
      sanctionCode: nullableString(account?.sanctionCode) ?? nullableString(arrayValue(source.sanctions)[0] && asRecord(arrayValue(source.sanctions)[0])?.scope),
      trustTier: trustTier(account?.trustTier),
      createdAt: nullableString(account?.createdAt),
    },
    wallet: {
      memoryAsh: normalizeBalance(wallet?.memoryAsh ?? wallet?.ash ?? { available: wallet?.ashAvailable, escrow: wallet?.ashReserved, locked72h: 0 }),
      goldBars: normalizeBalance(wallet?.goldBars ?? wallet?.gold ?? { available: wallet?.goldAvailable, escrow: wallet?.goldReserved, locked72h: wallet?.goldChargebackHold }),
    },
    vaultItems: vaultSource.map(normalizeVaultItem).filter((item): item is MarketVaultItem => item !== null),
    listings: listingsSource.map(normalizeListing).filter((item): item is MarketListing => item !== null),
    goldExchange: {
      bestBid: nullableNumber(exchange?.bestBid),
      bestAsk: nullableNumber(exchange?.bestAsk),
      lastPrice: nullableNumber(exchange?.lastPrice),
      bids: normalizeBook(exchange?.bids),
      asks: normalizeBook(exchange?.asks),
      myOrders: arrayValue(exchange?.myOrders ?? source.exchangeOrders).map(normalizeOrder).filter((item): item is GoldOrder => item !== null).map((item) => ({ ...item, mine: true })),
      orders: arrayValue(exchange?.orders).map(normalizeOrder).filter((item): item is GoldOrder => item !== null),
      recentTrades: arrayValue(exchange?.recentTrades).map(normalizeTrade).filter((item): item is GoldTrade => item !== null),
    },
    security: {
      activeSessions: positiveInteger(security?.activeSessions, 0),
      lastLoginAt: nullableString(security?.lastLoginAt),
      lastSteamTicketVerifiedAt: nullableString(security?.lastSteamTicketVerifiedAt),
      withdrawalLockUntil: nullableString(security?.withdrawalLockUntil),
      auditTrail: arrayValue(security?.auditTrail).map((entry, index) => {
        const record = asRecord(entry);
        return {
          id: stringValue(record?.id, `audit-${index}`),
          category: stringValue(record?.category, "SECURITY"),
          message: stringValue(record?.message, "보안 이벤트"),
          ipHint: nullableString(record?.ipHint),
          createdAt: stringValue(record?.createdAt, new Date(0).toISOString()),
        };
      }),
    },
    capabilities: {
      canTrade: booleanValue(capabilities?.canTrade, resolvedFeatureMode === "live" || (resolvedFeatureMode === "sandbox" && isLocalEconomySandbox())),
      canTopUp: booleanValue(capabilities?.canTopUp, resolvedPaymentMode === "steam"),
      canUseGoldExchange: booleanValue(capabilities?.canUseGoldExchange, resolvedFeatureMode === "live" || (resolvedFeatureMode === "sandbox" && isLocalEconomySandbox())),
      localSandbox: booleanValue(capabilities?.localSandbox, resolvedFeatureMode === "sandbox" && isLocalEconomySandbox()),
    },
  };
}

function normalizeBalance(value: unknown): WalletBalance {
  const record = asRecord(value);
  return {
    available: positiveInteger(record?.available, 0),
    escrow: positiveInteger(record?.escrow, 0),
    locked72h: positiveInteger(record?.locked72h ?? record?.locked, 0),
  };
}

function normalizeVaultItem(value: unknown): MarketVaultItem | null {
  const record = asRecord(value);
  if (!record) return null;
  const item = asRecord(record.item) ?? record;
  const data = asRecord(item.data);
  const vaultItemId = stringValue(record.vaultItemId ?? record.id, "");
  if (!vaultItemId) return null;
  const rarity = rarityValue(item.rarity);
  const slot = slotValue(item.slot);
  return {
    vaultItemId,
    itemId: stringValue(item.itemId ?? item.id, vaultItemId),
    displayName: stringValue(item.displayName ?? item.name, "이름 없는 장비"),
    baseName: stringValue(item.baseName ?? data?.baseName, "미상 장비"),
    rarity,
    slot,
    level: positiveInteger(item.level ?? item.itemLevel, 1),
    enhancement: positiveInteger(item.enhancement ?? data?.enhancement, 0),
    powerScore: positiveInteger(item.powerScore ?? data?.powerScore, 0),
    qualityScore: positiveInteger(item.qualityScore ?? data?.qualityScore, 0),
    iconIndex: positiveInteger(item.iconIndex ?? data?.iconIndex, 0),
    affixes: arrayValue(item.affixes ?? data?.affixes).map((affix) => {
      const affixRecord = asRecord(affix);
      return {
        label: stringValue(affixRecord?.label ?? affixRecord?.stat, "옵션"),
        value: stringValue(affixRecord?.formattedValue ?? affixRecord?.value, ""),
      };
    }),
    tradeState:
      item.tradeable === false || item.state === "equipped"
        ? "locked"
        : tradeState(record.tradeState ?? item.tradeState ?? (item.state === "inventory" ? "available" : item.state)),
    lockedUntil: nullableString(record.lockedUntil ?? item.lockedUntil),
    version: positiveInteger(item.version, 0),
  };
}

function normalizeListing(value: unknown): MarketListing | null {
  const record = asRecord(value);
  if (!record) return null;
  const listingId = stringValue(record.listingId ?? record.id, "");
  const item = normalizeVaultItem(record.item ?? record.vaultItem);
  if (!listingId || !item) return null;
  return {
    listingId,
    sellerUserId: stringValue(record.sellerUserId, ""),
    sellerName: stringValue(record.sellerName ?? record.sellerAlias, "익명의 기록자"),
    item,
    priceAsh: positiveInteger(record.priceAsh ?? record.price, 0),
    listedAt: timestampString(record.listedAt ?? record.createdAt),
    expiresAt: timestampString(record.expiresAt),
    mine: booleanValue(record.mine ?? record.isMine),
    version: positiveInteger(record.version, 0),
  };
}

function normalizeOrder(value: unknown): GoldOrder | null {
  const record = asRecord(value);
  if (!record) return null;
  const orderId = stringValue(record.orderId ?? record.id, "");
  if (!orderId) return null;
  return {
    orderId,
    side: record.side === "sell" || record.side === "sell_gold" ? "sell" : "buy",
    priceAshPerGold: positiveInteger(record.priceAshPerGold ?? record.price, 0),
    goldAmount: positiveInteger(record.goldAmount ?? record.goldAmountInitial ?? record.amount, 0),
    remainingGold: positiveInteger(record.remainingGold ?? record.goldAmountRemaining ?? record.remaining, 0),
    status: orderStatus(record.status),
    mine: booleanValue(record.mine ?? record.isMine, false),
    createdAt: timestampString(record.createdAt),
    version: positiveInteger(record.version, 0),
  };
}

function normalizeBook(value: unknown): OrderBookLevel[] {
  return arrayValue(value).map((level) => {
    const record = asRecord(level);
    return {
      priceAshPerGold: positiveInteger(record?.priceAshPerGold ?? record?.price, 0),
      goldAmount: positiveInteger(record?.goldAmount ?? record?.amount, 0),
      orderCount: positiveInteger(record?.orderCount ?? record?.count, 0),
    };
  });
}

function normalizeTrade(value: unknown): GoldTrade | null {
  const record = asRecord(value);
  if (!record) return null;
  const tradeId = stringValue(record.tradeId ?? record.id, "");
  if (!tradeId) return null;
  return {
    tradeId,
    priceAshPerGold: positiveInteger(record.priceAshPerGold ?? record.price, 0),
    goldAmount: positiveInteger(record.goldAmount ?? record.amount, 0),
    executedAt: stringValue(record.executedAt ?? record.createdAt, new Date(0).toISOString()),
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === "string" && value ? value : fallback;
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function nullableNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function positiveInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.trunc(value))
    : fallback;
}

function booleanValue(value: unknown, fallback = false): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function rarityValue(value: unknown): MarketRarity {
  return MARKET_RARITIES.includes(value as MarketRarity) ? (value as MarketRarity) : "common";
}

function slotValue(value: unknown): MarketSlot {
  return MARKET_SLOTS.includes(value as MarketSlot) ? (value as MarketSlot) : "weapon";
}

function tradeState(value: unknown): MarketVaultItem["tradeState"] {
  return value === "listed" || value === "escrow" || value === "locked" ? value : "available";
}

function trustTier(value: unknown): EconomyAccount["trustTier"] {
  return value === "standard" || value === "trusted" || value === "restricted"
    ? value
    : "unverified";
}

function orderStatus(value: unknown): GoldOrder["status"] {
  if (value === "partial" || value === "partially_filled") return "partial";
  return value === "filled" || value === "cancelled" ? value : "open";
}

function timestampString(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) return new Date(value).toISOString();
  return stringValue(value, new Date(0).toISOString());
}

function featureMode(value: unknown): EconomySnapshot["featureMode"] {
  return value === "read-only" || value === "sandbox" || value === "live" ? value : "disabled";
}

function paymentMode(value: unknown): EconomySnapshot["paymentMode"] {
  return value === "sandbox" || value === "steam" ? value : "disabled";
}
