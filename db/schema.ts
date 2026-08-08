import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  foreignKey,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

/**
 * The polling realtime coordinator deliberately uses one compare-and-swap row.
 * Keeping the world in a single JSON document makes queueing, matchmaking,
 * combat simulation, and announcements commit atomically in D1.
 */
export const realtimeWorldState = sqliteTable("realtime_world_state", {
  id: integer("id").primaryKey(),
  version: integer("version").notNull().default(0),
  stateJson: text("state_json").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

/**
 * Authoritative online-economy tables. Local save JSON is intentionally not
 * represented here: only server-issued items and ledgered balances can trade.
 * Cross-table invariants and immutable-ledger guards live in migration 0001.
 */
export const economyAccounts = sqliteTable("economy_accounts", {
  id: text("id").primaryKey(),
  displayName: text("display_name").notNull(),
  status: text("status").notNull().default("active"),
  steamOwnershipVerified: integer("steam_ownership_verified").notNull().default(0),
  tradeEligible: integer("trade_eligible").notNull().default(0),
  walletFrozen: integer("wallet_frozen").notNull().default(0),
  authEpoch: integer("auth_epoch").notNull().default(0),
  riskScore: integer("risk_score").notNull().default(0),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

/**
 * Account-bound characters and ephemeral, server-authoritative plaza presence.
 * Raw account ids never appear in public snapshots; sessions expose only their
 * random id and a stable per-slot public character id.
 */
export const hubCharacterSlots = sqliteTable(
  "hub_character_slots",
  {
    accountId: text("account_id").notNull(),
    slot: integer("slot").notNull(),
    publicCharacterId: text("public_character_id").notNull().unique(),
    level: integer("level").notNull(),
    dungeonFloor: integer("dungeon_floor").notNull().default(1),
    appearanceJson: text("appearance_json").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.accountId, table.slot] }),
    check("hub_character_slot_range", sql`${table.slot} BETWEEN 1 AND 3`),
    check("hub_character_level_range", sql`${table.level} BETWEEN 1 AND 999`),
    check(
      "hub_character_dungeon_floor_range",
      sql`${table.dungeonFloor} BETWEEN 1 AND 999999`,
    ),
  ],
);

export const hubSessions = sqliteTable(
  "hub_sessions",
  {
    id: text("id").primaryKey(),
    tokenHash: text("token_hash").notNull().unique(),
    accountId: text("account_id").notNull().unique(),
    characterSlot: integer("character_slot").notNull(),
    publicCharacterId: text("public_character_id").notNull(),
    displayName: text("display_name").notNull(),
    level: integer("level").notNull(),
    dungeonFloor: integer("dungeon_floor").notNull().default(1),
    appearanceJson: text("appearance_json").notNull(),
    zone: text("zone").notNull().default("memory-plaza-v1"),
    x: real("x").notNull(),
    y: real("y").notNull(),
    facing: integer("facing").notNull(),
    moving: integer("moving").notNull().default(0),
    lastSequence: integer("last_sequence").notNull().default(0),
    lastMoveAt: integer("last_move_at").notNull(),
    lastSeenAt: integer("last_seen_at").notNull(),
    expiresAt: integer("expires_at").notNull(),
    version: integer("version").notNull().default(0),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    index("hub_sessions_presence").on(table.zone, table.lastSeenAt, table.x, table.y),
    foreignKey({
      name: "hub_sessions_selected_character",
      columns: [table.accountId, table.characterSlot],
      foreignColumns: [hubCharacterSlots.accountId, hubCharacterSlots.slot],
    }).onDelete("cascade"),
    check("hub_session_slot_range", sql`${table.characterSlot} BETWEEN 1 AND 3`),
    check("hub_session_level_range", sql`${table.level} BETWEEN 1 AND 999`),
    check(
      "hub_session_dungeon_floor_range",
      sql`${table.dungeonFloor} BETWEEN 1 AND 999999`,
    ),
    check("hub_session_facing_range", sql`${table.facing} BETWEEN 0 AND 7`),
    check("hub_session_moving_boolean", sql`${table.moving} IN (0, 1)`),
  ],
);

export const hubRateLimits = sqliteTable(
  "hub_rate_limits",
  {
    accountId: text("account_id").notNull(),
    bucket: text("bucket").notNull(),
    windowStartedAt: integer("window_started_at").notNull(),
    requestCount: integer("request_count").notNull(),
    blockedUntil: integer("blocked_until"),
  },
  (table) => [primaryKey({ columns: [table.accountId, table.bucket] })],
);

export const economyIdentities = sqliteTable(
  "economy_identities",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull().references(() => economyAccounts.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    providerSubject: text("provider_subject").notNull(),
    ownerSubject: text("owner_subject"),
    ownershipPermanent: integer("ownership_permanent").notNull().default(0),
    verifiedAt: integer("verified_at").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("economy_identity_subject").on(table.provider, table.providerSubject),
    uniqueIndex("economy_identity_one_steam_per_account")
      .on(table.accountId)
      .where(sql`${table.provider} = 'steam'`),
  ],
);

export const economySessions = sqliteTable(
  "economy_sessions",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull().references(() => economyAccounts.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    authEpoch: integer("auth_epoch").notNull(),
    expiresAt: integer("expires_at").notNull(),
    revokedAt: integer("revoked_at"),
    createdAt: integer("created_at").notNull(),
    lastSeenAt: integer("last_seen_at").notNull(),
  },
  (table) => [uniqueIndex("economy_session_token_hash").on(table.tokenHash)],
);

export const economyAuthStates = sqliteTable(
  "economy_auth_states",
  {
    stateHash: text("state_hash").primaryKey(),
    pendingAccountId: text("pending_account_id").references(() => economyAccounts.id, { onDelete: "cascade" }),
    returnTo: text("return_to").notNull(),
    expiresAt: integer("expires_at").notNull(),
    consumedAt: integer("consumed_at"),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [index("economy_auth_state_expiry").on(table.expiresAt)],
);

export const economyWallets = sqliteTable("economy_wallets", {
  accountId: text("account_id").primaryKey().references(() => economyAccounts.id, { onDelete: "cascade" }),
  ashAvailable: integer("ash_available").notNull().default(0),
  ashReserved: integer("ash_reserved").notNull().default(0),
  goldAvailable: integer("gold_available").notNull().default(0),
  goldReserved: integer("gold_reserved").notNull().default(0),
  goldLocked: integer("gold_locked").notNull().default(0),
  version: integer("version").notNull().default(0),
  updatedAt: integer("updated_at").notNull(),
});

export const economyLedger = sqliteTable(
  "economy_ledger",
  {
    id: text("id").primaryKey(),
    operationId: text("operation_id").notNull(),
    accountId: text("account_id").notNull().references(() => economyAccounts.id),
    currency: text("currency").notNull(),
    availableDelta: integer("available_delta").notNull(),
    reservedDelta: integer("reserved_delta").notNull().default(0),
    lockedDelta: integer("locked_delta").notNull().default(0),
    reason: text("reason").notNull(),
    referenceType: text("reference_type").notNull(),
    referenceId: text("reference_id").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [uniqueIndex("economy_ledger_operation_leg").on(table.operationId, table.accountId, table.currency, table.reason)],
);

export const economyItems = sqliteTable(
  "economy_items",
  {
    id: text("id").primaryKey(),
    ownerAccountId: text("owner_account_id").notNull().references(() => economyAccounts.id),
    state: text("state").notNull().default("inventory"),
    tradeable: integer("tradeable").notNull().default(0),
    provenance: text("provenance").notNull(),
    originId: text("origin_id").notNull(),
    slot: text("slot").notNull(),
    rarity: text("rarity").notNull(),
    itemLevel: integer("item_level").notNull(),
    displayName: text("display_name").notNull(),
    itemJson: text("item_json").notNull(),
    version: integer("version").notNull().default(0),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [uniqueIndex("economy_item_origin").on(table.provenance, table.originId)],
);

export const economyListings = sqliteTable(
  "economy_listings",
  {
    id: text("id").primaryKey(),
    itemId: text("item_id").notNull().references(() => economyItems.id),
    sellerAccountId: text("seller_account_id").notNull().references(() => economyAccounts.id),
    buyerAccountId: text("buyer_account_id").references(() => economyAccounts.id),
    priceAsh: integer("price_ash").notNull(),
    status: text("status").notNull().default("open"),
    version: integer("version").notNull().default(0),
    createdAt: integer("created_at").notNull(),
    expiresAt: integer("expires_at").notNull(),
    closedAt: integer("closed_at"),
  },
  (table) => [
    uniqueIndex("economy_one_open_listing_per_item")
      .on(table.itemId)
      .where(sql`${table.status} = 'open'`),
    index("economy_open_listing_price").on(table.status, table.priceAsh, table.createdAt),
    index("economy_listing_seller").on(table.sellerAccountId, table.status, table.createdAt),
  ],
);

export const economyAuctionTrades = sqliteTable("economy_auction_trades", {
  id: text("id").primaryKey(),
  listingId: text("listing_id").notNull().unique().references(() => economyListings.id),
  itemId: text("item_id").notNull().references(() => economyItems.id),
  sellerAccountId: text("seller_account_id").notNull().references(() => economyAccounts.id),
  buyerAccountId: text("buyer_account_id").notNull().references(() => economyAccounts.id),
  priceAsh: integer("price_ash").notNull(),
  createdAt: integer("created_at").notNull(),
});

export const economyExchangeOrders = sqliteTable(
  "economy_exchange_orders",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull().references(() => economyAccounts.id),
    side: text("side").notNull(),
    priceAshPerGold: integer("price_ash_per_gold").notNull(),
    goldInitial: integer("gold_initial").notNull(),
    goldRemaining: integer("gold_remaining").notNull(),
    ashReservedRemaining: integer("ash_reserved_remaining").notNull().default(0),
    goldReservedRemaining: integer("gold_reserved_remaining").notNull().default(0),
    status: text("status").notNull().default("open"),
    version: integer("version").notNull().default(0),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    index("economy_exchange_match").on(table.side, table.status, table.priceAshPerGold, table.createdAt),
    index("economy_exchange_owner").on(table.accountId, table.status, table.createdAt),
  ],
);

export const economyExchangeFills = sqliteTable("economy_exchange_fills", {
  id: text("id").primaryKey(),
  makerOrderId: text("maker_order_id").notNull().references(() => economyExchangeOrders.id),
  makerAccountId: text("maker_account_id").notNull().references(() => economyAccounts.id),
  takerAccountId: text("taker_account_id").notNull().references(() => economyAccounts.id),
  buyerAccountId: text("buyer_account_id").notNull().references(() => economyAccounts.id),
  sellerAccountId: text("seller_account_id").notNull().references(() => economyAccounts.id),
  goldAmount: integer("gold_amount").notNull(),
  ashAmount: integer("ash_amount").notNull(),
  priceAshPerGold: integer("price_ash_per_gold").notNull(),
  createdAt: integer("created_at").notNull(),
});

export const economyPaymentOrders = sqliteTable(
  "economy_payment_orders",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull().references(() => economyAccounts.id),
    provider: text("provider").notNull(),
    providerOrderId: text("provider_order_id").notNull(),
    productSku: text("product_sku").notNull(),
    amountMinor: integer("amount_minor").notNull(),
    currency: text("currency").notNull(),
    goldAmount: integer("gold_amount").notNull(),
    status: text("status").notNull(),
    approvalUrl: text("approval_url"),
    idempotencyKey: text("idempotency_key").notNull(),
    requestHash: text("request_hash").notNull(),
    createdAt: integer("created_at").notNull(),
    authorizedAt: integer("authorized_at"),
    finalizedAt: integer("finalized_at"),
  },
  (table) => [
    uniqueIndex("economy_payment_provider_order").on(table.providerOrderId),
    uniqueIndex("economy_payment_idempotency").on(table.accountId, table.idempotencyKey),
  ],
);

export const economyPaymentEvents = sqliteTable(
  "economy_payment_events",
  {
    id: text("id").primaryKey(),
    paymentOrderId: text("payment_order_id").notNull().references(() => economyPaymentOrders.id),
    providerEventId: text("provider_event_id").notNull(),
    eventKind: text("event_kind").notNull(),
    payloadHash: text("payload_hash").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [uniqueIndex("economy_payment_event_provider_id").on(table.providerEventId)],
);

export const economyGoldLots = sqliteTable(
  "economy_gold_lots",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull().references(() => economyAccounts.id),
    source: text("source").notNull(),
    sourceId: text("source_id").notNull(),
    amount: integer("amount").notNull(),
    remaining: integer("remaining").notNull(),
    state: text("state").notNull(),
    tradeableAt: integer("tradeable_at").notNull(),
    releasedAt: integer("released_at"),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("economy_gold_lot_source").on(table.source, table.sourceId),
    index("economy_gold_lot_release").on(table.accountId, table.state, table.tradeableAt),
  ],
);

export const economyExchangeOrderGoldLots = sqliteTable(
  "economy_exchange_order_gold_lots",
  {
    orderId: text("order_id").notNull().references(() => economyExchangeOrders.id, { onDelete: "cascade" }),
    lotId: text("lot_id").notNull().references(() => economyGoldLots.id),
    amountReserved: integer("amount_reserved").notNull(),
    amountRemaining: integer("amount_remaining").notNull(),
  },
  (table) => [primaryKey({ columns: [table.orderId, table.lotId] })],
);

export const economyGoldLotTransfers = sqliteTable("economy_gold_lot_transfers", {
  id: text("id").primaryKey(),
  fillId: text("fill_id").notNull().references(() => economyExchangeFills.id),
  sourceLotId: text("source_lot_id").notNull().references(() => economyGoldLots.id),
  recipientAccountId: text("recipient_account_id").notNull().references(() => economyAccounts.id),
  amount: integer("amount").notNull(),
  createdAt: integer("created_at").notNull(),
});

export const economyPaymentFinalizeCommands = sqliteTable(
  "economy_payment_finalize_commands",
  {
    id: text("id").primaryKey(),
    paymentOrderId: text("payment_order_id").notNull().references(() => economyPaymentOrders.id),
    accountId: text("account_id").notNull().references(() => economyAccounts.id),
    idempotencyKey: text("idempotency_key").notNull(),
    requestHash: text("request_hash").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("economy_payment_finalize_order").on(table.paymentOrderId),
    uniqueIndex("economy_payment_finalize_idempotency").on(table.accountId, table.idempotencyKey),
  ],
);

export const economySanctions = sqliteTable(
  "economy_sanctions",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull().references(() => economyAccounts.id),
    scope: text("scope").notNull(),
    reason: text("reason").notNull(),
    evidenceReference: text("evidence_reference"),
    startsAt: integer("starts_at").notNull(),
    expiresAt: integer("expires_at"),
    revokedAt: integer("revoked_at"),
    createdBy: text("created_by").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    index("economy_active_sanctions").on(
      table.accountId,
      table.scope,
      table.startsAt,
      table.expiresAt,
      table.revokedAt,
    ),
  ],
);

export const economyRiskEvents = sqliteTable("economy_risk_events", {
  id: text("id").primaryKey(),
  accountId: text("account_id").references(() => economyAccounts.id),
  signal: text("signal").notNull(),
  severity: integer("severity").notNull(),
  requestId: text("request_id"),
  metadataJson: text("metadata_json").notNull().default("{}"),
  createdAt: integer("created_at").notNull(),
});

export const economyAuditEvents = sqliteTable(
  "economy_audit_events",
  {
    id: text("id").primaryKey(),
    actorAccountId: text("actor_account_id").references(() => economyAccounts.id),
    targetAccountId: text("target_account_id").references(() => economyAccounts.id),
    action: text("action").notNull(),
    objectType: text("object_type").notNull(),
    objectId: text("object_id").notNull(),
    requestId: text("request_id").notNull(),
    idempotencyKey: text("idempotency_key"),
    requestHash: text("request_hash"),
    metadataJson: text("metadata_json").notNull().default("{}"),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("economy_admin_request_idempotency")
      .on(table.idempotencyKey)
      .where(sql`${table.actorAccountId} IS NULL AND ${table.idempotencyKey} IS NOT NULL`),
  ],
);

export const economyRateLimits = sqliteTable("economy_rate_limits", {
  subjectKey: text("subject_key").notNull(),
  bucket: text("bucket").notNull(),
  windowStartedAt: integer("window_started_at").notNull(),
  requestCount: integer("request_count").notNull(),
  blockedUntil: integer("blocked_until"),
}, (table) => [primaryKey({ columns: [table.subjectKey, table.bucket] })]);

export const economyCommands = sqliteTable(
  "economy_commands",
  {
    id: text("id").primaryKey(),
    actorAccountId: text("actor_account_id").notNull().references(() => economyAccounts.id),
    action: text("action").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    requestHash: text("request_hash").notNull(),
    resultRefId: text("result_ref_id").notNull(),
    itemId: text("item_id"),
    listingId: text("listing_id"),
    orderId: text("order_id"),
    side: text("side"),
    currency: text("currency"),
    priceAsh: integer("price_ash"),
    goldAmount: integer("gold_amount"),
    amount: integer("amount"),
    expectedVersion: integer("expected_version"),
    expiresAt: integer("expires_at"),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [uniqueIndex("economy_command_idempotency").on(table.actorAccountId, table.idempotencyKey)],
);

export const economyListingExpiryCommands = sqliteTable(
  "economy_listing_expiry_commands",
  {
    id: text("id").primaryKey(),
    listingId: text("listing_id").notNull().references(() => economyListings.id),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [uniqueIndex("economy_listing_expiry_listing").on(table.listingId)],
);

export const economyGoldReleaseCommands = sqliteTable("economy_gold_release_commands", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull().references(() => economyAccounts.id),
  createdAt: integer("created_at").notNull(),
});
