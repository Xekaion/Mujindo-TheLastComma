PRAGMA foreign_keys = ON;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS economy_accounts (
  id TEXT PRIMARY KEY NOT NULL,
  display_name TEXT NOT NULL CHECK(length(display_name) BETWEEN 1 AND 48),
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','restricted','frozen','banned')),
  steam_ownership_verified INTEGER NOT NULL DEFAULT 0 CHECK(steam_ownership_verified IN (0,1)),
  trade_eligible INTEGER NOT NULL DEFAULT 0 CHECK(trade_eligible IN (0,1)),
  wallet_frozen INTEGER NOT NULL DEFAULT 0 CHECK(wallet_frozen IN (0,1)),
  auth_epoch INTEGER NOT NULL DEFAULT 0 CHECK(auth_epoch >= 0),
  risk_score INTEGER NOT NULL DEFAULT 0 CHECK(risk_score BETWEEN 0 AND 10000),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS economy_identities (
  id TEXT PRIMARY KEY NOT NULL,
  account_id TEXT NOT NULL REFERENCES economy_accounts(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK(provider IN ('sites','steam','development')),
  provider_subject TEXT NOT NULL CHECK(length(provider_subject) BETWEEN 1 AND 256),
  owner_subject TEXT,
  ownership_permanent INTEGER NOT NULL DEFAULT 0 CHECK(ownership_permanent IN (0,1)),
  verified_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(provider, provider_subject)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS economy_identity_one_steam_per_account
ON economy_identities(account_id) WHERE provider = 'steam';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS economy_sessions (
  id TEXT PRIMARY KEY NOT NULL,
  account_id TEXT NOT NULL REFERENCES economy_accounts(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE CHECK(length(token_hash) = 64),
  auth_epoch INTEGER NOT NULL CHECK(auth_epoch >= 0),
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS economy_auth_states (
  state_hash TEXT PRIMARY KEY NOT NULL CHECK(length(state_hash) = 64),
  pending_account_id TEXT REFERENCES economy_accounts(id) ON DELETE CASCADE,
  return_to TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS economy_auth_state_expiry
ON economy_auth_states(expires_at);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS economy_wallets (
  account_id TEXT PRIMARY KEY NOT NULL REFERENCES economy_accounts(id) ON DELETE CASCADE,
  ash_available INTEGER NOT NULL DEFAULT 0 CHECK(ash_available BETWEEN 0 AND 9000000000000),
  ash_reserved INTEGER NOT NULL DEFAULT 0 CHECK(ash_reserved BETWEEN 0 AND 9000000000000),
  gold_available INTEGER NOT NULL DEFAULT 0 CHECK(gold_available BETWEEN 0 AND 1000000000),
  gold_reserved INTEGER NOT NULL DEFAULT 0 CHECK(gold_reserved BETWEEN 0 AND 1000000000),
  gold_locked INTEGER NOT NULL DEFAULT 0 CHECK(gold_locked BETWEEN 0 AND 1000000000),
  version INTEGER NOT NULL DEFAULT 0 CHECK(version BETWEEN 0 AND 2147483647),
  updated_at INTEGER NOT NULL,
  CHECK(ash_available + ash_reserved <= 9000000000000),
  CHECK(gold_available + gold_reserved + gold_locked <= 1000000000)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS economy_ledger (
  id TEXT PRIMARY KEY NOT NULL,
  operation_id TEXT NOT NULL,
  account_id TEXT NOT NULL REFERENCES economy_accounts(id),
  currency TEXT NOT NULL CHECK(currency IN ('ash','gold')),
  available_delta INTEGER NOT NULL,
  reserved_delta INTEGER NOT NULL DEFAULT 0,
  locked_delta INTEGER NOT NULL DEFAULT 0,
  reason TEXT NOT NULL CHECK(length(reason) BETWEEN 1 AND 64),
  reference_type TEXT NOT NULL CHECK(length(reference_type) BETWEEN 1 AND 48),
  reference_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(operation_id, account_id, currency, reason)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS economy_items (
  id TEXT PRIMARY KEY NOT NULL,
  owner_account_id TEXT NOT NULL REFERENCES economy_accounts(id),
  state TEXT NOT NULL DEFAULT 'inventory' CHECK(state IN ('inventory','equipped','escrow','destroyed')),
  tradeable INTEGER NOT NULL DEFAULT 0 CHECK(tradeable IN (0,1)),
  provenance TEXT NOT NULL CHECK(provenance IN ('server_drop','market','development','admin')),
  origin_id TEXT NOT NULL,
  slot TEXT NOT NULL CHECK(slot IN ('weapon','offhand','helm','shoulders','armor','gloves','belt','legs','boots','relic')),
  rarity TEXT NOT NULL CHECK(rarity IN ('common','magic','superior','rare','epic','legendary','mythic','cosmic')),
  item_level INTEGER NOT NULL CHECK(item_level BETWEEN 1 AND 999),
  display_name TEXT NOT NULL CHECK(length(display_name) BETWEEN 1 AND 96),
  item_json TEXT NOT NULL CHECK(json_valid(item_json)),
  version INTEGER NOT NULL DEFAULT 0 CHECK(version BETWEEN 0 AND 2147483647),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(provenance, origin_id)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS economy_listings (
  id TEXT PRIMARY KEY NOT NULL,
  item_id TEXT NOT NULL REFERENCES economy_items(id),
  seller_account_id TEXT NOT NULL REFERENCES economy_accounts(id),
  buyer_account_id TEXT REFERENCES economy_accounts(id),
  price_ash INTEGER NOT NULL CHECK(price_ash BETWEEN 1 AND 1000000000000),
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','sold','cancelled','expired')),
  version INTEGER NOT NULL DEFAULT 0 CHECK(version BETWEEN 0 AND 2147483647),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  closed_at INTEGER,
  CHECK(expires_at > created_at)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS economy_one_open_listing_per_item
ON economy_listings(item_id) WHERE status = 'open';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS economy_open_listing_price
ON economy_listings(status, price_ash, created_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS economy_listing_seller
ON economy_listings(seller_account_id, status, created_at);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS economy_auction_trades (
  id TEXT PRIMARY KEY NOT NULL,
  listing_id TEXT NOT NULL UNIQUE REFERENCES economy_listings(id),
  item_id TEXT NOT NULL REFERENCES economy_items(id),
  seller_account_id TEXT NOT NULL REFERENCES economy_accounts(id),
  buyer_account_id TEXT NOT NULL REFERENCES economy_accounts(id),
  price_ash INTEGER NOT NULL CHECK(price_ash BETWEEN 1 AND 1000000000000),
  created_at INTEGER NOT NULL,
  CHECK(seller_account_id <> buyer_account_id)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS economy_exchange_orders (
  id TEXT PRIMARY KEY NOT NULL,
  account_id TEXT NOT NULL REFERENCES economy_accounts(id),
  side TEXT NOT NULL CHECK(side IN ('buy_gold','sell_gold')),
  price_ash_per_gold INTEGER NOT NULL CHECK(price_ash_per_gold BETWEEN 1 AND 1000000000),
  gold_initial INTEGER NOT NULL CHECK(gold_initial BETWEEN 1 AND 10000000),
  gold_remaining INTEGER NOT NULL CHECK(gold_remaining BETWEEN 0 AND gold_initial),
  ash_reserved_remaining INTEGER NOT NULL DEFAULT 0 CHECK(ash_reserved_remaining BETWEEN 0 AND 9000000000000),
  gold_reserved_remaining INTEGER NOT NULL DEFAULT 0 CHECK(gold_reserved_remaining BETWEEN 0 AND 1000000000),
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','partially_filled','filled','cancelled','expired')),
  version INTEGER NOT NULL DEFAULT 0 CHECK(version BETWEEN 0 AND 2147483647),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK(gold_initial * price_ash_per_gold <= 9000000000000),
  CHECK(
    (status IN ('open','partially_filled') AND (
      (side = 'buy_gold' AND ash_reserved_remaining = gold_remaining * price_ash_per_gold AND gold_reserved_remaining = 0)
      OR (side = 'sell_gold' AND gold_reserved_remaining = gold_remaining AND ash_reserved_remaining = 0)
    ))
    OR (status IN ('filled','cancelled','expired') AND ash_reserved_remaining = 0 AND gold_reserved_remaining = 0)
  )
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS economy_exchange_match
ON economy_exchange_orders(side, status, price_ash_per_gold, created_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS economy_exchange_owner
ON economy_exchange_orders(account_id, status, created_at);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS economy_exchange_fills (
  id TEXT PRIMARY KEY NOT NULL,
  maker_order_id TEXT NOT NULL REFERENCES economy_exchange_orders(id),
  maker_account_id TEXT NOT NULL REFERENCES economy_accounts(id),
  taker_account_id TEXT NOT NULL REFERENCES economy_accounts(id),
  buyer_account_id TEXT NOT NULL REFERENCES economy_accounts(id),
  seller_account_id TEXT NOT NULL REFERENCES economy_accounts(id),
  gold_amount INTEGER NOT NULL CHECK(gold_amount BETWEEN 1 AND 10000000),
  ash_amount INTEGER NOT NULL CHECK(ash_amount BETWEEN 1 AND 9000000000000),
  price_ash_per_gold INTEGER NOT NULL CHECK(price_ash_per_gold BETWEEN 1 AND 1000000000),
  created_at INTEGER NOT NULL,
  CHECK(maker_account_id <> taker_account_id),
  CHECK(buyer_account_id <> seller_account_id),
  CHECK(ash_amount = gold_amount * price_ash_per_gold)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS economy_payment_orders (
  id TEXT PRIMARY KEY NOT NULL,
  account_id TEXT NOT NULL REFERENCES economy_accounts(id),
  provider TEXT NOT NULL CHECK(provider = 'steam'),
  provider_order_id TEXT NOT NULL UNIQUE,
  product_sku TEXT NOT NULL,
  amount_minor INTEGER NOT NULL CHECK(amount_minor > 0),
  currency TEXT NOT NULL CHECK(length(currency) = 3),
  gold_amount INTEGER NOT NULL CHECK(gold_amount BETWEEN 1 AND 1000000000),
  status TEXT NOT NULL CHECK(status IN ('created','authorized','finalized','refunded','chargeback','failed','reversed')),
  approval_url TEXT CHECK(approval_url IS NULL OR (length(approval_url) BETWEEN 1 AND 4096 AND approval_url LIKE 'https://store.steampowered.com/%')),
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL CHECK(length(request_hash) = 64),
  created_at INTEGER NOT NULL,
  authorized_at INTEGER,
  finalized_at INTEGER,
  UNIQUE(account_id, idempotency_key)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS economy_payment_events (
  id TEXT PRIMARY KEY NOT NULL,
  payment_order_id TEXT NOT NULL REFERENCES economy_payment_orders(id),
  provider_event_id TEXT NOT NULL UNIQUE,
  event_kind TEXT NOT NULL CHECK(event_kind IN ('authorized','finalized','refunded','chargeback','failed')),
  payload_hash TEXT NOT NULL CHECK(length(payload_hash) = 64),
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS economy_gold_lots (
  id TEXT PRIMARY KEY NOT NULL,
  account_id TEXT NOT NULL REFERENCES economy_accounts(id),
  source TEXT NOT NULL CHECK(source IN ('steam_payment','sandbox','market_transfer','admin')),
  source_id TEXT NOT NULL,
  amount INTEGER NOT NULL CHECK(amount BETWEEN 1 AND 1000000000),
  remaining INTEGER NOT NULL CHECK(remaining BETWEEN 0 AND amount),
  state TEXT NOT NULL CHECK(state IN ('locked','available','reserved','spent','reversed')),
  tradeable_at INTEGER NOT NULL,
  released_at INTEGER,
  created_at INTEGER NOT NULL,
  UNIQUE(source, source_id)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS economy_gold_lot_release
ON economy_gold_lots(account_id, state, tradeable_at);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS economy_exchange_order_gold_lots (
  order_id TEXT NOT NULL REFERENCES economy_exchange_orders(id) ON DELETE CASCADE,
  lot_id TEXT NOT NULL REFERENCES economy_gold_lots(id),
  amount_reserved INTEGER NOT NULL CHECK(amount_reserved > 0),
  amount_remaining INTEGER NOT NULL CHECK(amount_remaining BETWEEN 0 AND amount_reserved),
  PRIMARY KEY(order_id, lot_id)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS economy_gold_lot_transfers (
  id TEXT PRIMARY KEY NOT NULL,
  fill_id TEXT NOT NULL REFERENCES economy_exchange_fills(id),
  source_lot_id TEXT NOT NULL REFERENCES economy_gold_lots(id),
  recipient_account_id TEXT NOT NULL REFERENCES economy_accounts(id),
  amount INTEGER NOT NULL CHECK(amount > 0),
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS economy_payment_finalize_commands (
  id TEXT PRIMARY KEY NOT NULL,
  payment_order_id TEXT NOT NULL UNIQUE REFERENCES economy_payment_orders(id),
  account_id TEXT NOT NULL REFERENCES economy_accounts(id),
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL CHECK(length(request_hash)=64),
  created_at INTEGER NOT NULL,
  UNIQUE(account_id,idempotency_key)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS economy_sanctions (
  id TEXT PRIMARY KEY NOT NULL,
  account_id TEXT NOT NULL REFERENCES economy_accounts(id),
  scope TEXT NOT NULL CHECK(scope IN ('login','pvp','market','exchange','payment','wallet','chat')),
  reason TEXT NOT NULL CHECK(length(reason) BETWEEN 8 AND 500),
  evidence_reference TEXT,
  starts_at INTEGER NOT NULL,
  expires_at INTEGER,
  revoked_at INTEGER,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  CHECK(expires_at IS NULL OR expires_at > starts_at)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS economy_active_sanctions
ON economy_sanctions(account_id, scope, starts_at, expires_at, revoked_at);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS economy_risk_events (
  id TEXT PRIMARY KEY NOT NULL,
  account_id TEXT REFERENCES economy_accounts(id),
  signal TEXT NOT NULL CHECK(length(signal) BETWEEN 1 AND 64),
  severity INTEGER NOT NULL CHECK(severity BETWEEN 1 AND 100),
  request_id TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(metadata_json)),
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS economy_audit_events (
  id TEXT PRIMARY KEY NOT NULL,
  actor_account_id TEXT REFERENCES economy_accounts(id),
  target_account_id TEXT REFERENCES economy_accounts(id),
  action TEXT NOT NULL CHECK(length(action) BETWEEN 1 AND 64),
  object_type TEXT NOT NULL CHECK(length(object_type) BETWEEN 1 AND 48),
  object_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  idempotency_key TEXT,
  request_hash TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(metadata_json)),
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS economy_admin_request_idempotency
ON economy_audit_events(idempotency_key)
WHERE actor_account_id IS NULL AND idempotency_key IS NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS economy_rate_limits (
  subject_key TEXT NOT NULL,
  bucket TEXT NOT NULL,
  window_started_at INTEGER NOT NULL,
  request_count INTEGER NOT NULL CHECK(request_count >= 0),
  blocked_until INTEGER,
  PRIMARY KEY(subject_key, bucket)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS economy_commands (
  id TEXT PRIMARY KEY NOT NULL,
  actor_account_id TEXT NOT NULL REFERENCES economy_accounts(id),
  action TEXT NOT NULL CHECK(action IN ('list_item','buy_listing','cancel_listing','place_exchange','fill_exchange','cancel_exchange','sandbox_topup')),
  idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 16 AND 96),
  request_hash TEXT NOT NULL CHECK(length(request_hash) = 64),
  result_ref_id TEXT NOT NULL,
  item_id TEXT,
  listing_id TEXT,
  order_id TEXT,
  side TEXT CHECK(side IS NULL OR side IN ('buy_gold','sell_gold')),
  currency TEXT CHECK(currency IS NULL OR currency IN ('ash','gold')),
  price_ash INTEGER,
  gold_amount INTEGER,
  amount INTEGER,
  expected_version INTEGER,
  expires_at INTEGER,
  created_at INTEGER NOT NULL,
  UNIQUE(actor_account_id, idempotency_key)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS economy_listing_expiry_commands (
  id TEXT PRIMARY KEY NOT NULL,
  listing_id TEXT NOT NULL UNIQUE REFERENCES economy_listings(id),
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS economy_gold_release_commands (
  id TEXT PRIMARY KEY NOT NULL,
  account_id TEXT NOT NULL REFERENCES economy_accounts(id),
  created_at INTEGER NOT NULL
);
