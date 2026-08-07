import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import ts from "typescript";

const root = process.cwd();
const UUID = {
  a: "00000000-0000-4000-8000-00000000000a",
  b: "00000000-0000-4000-8000-00000000000b",
  c: "00000000-0000-4000-8000-00000000000c",
  item1: "10000000-0000-4000-8000-000000000001",
  item2: "10000000-0000-4000-8000-000000000002",
  listing1: "20000000-0000-4000-8000-000000000001",
  listing2: "20000000-0000-4000-8000-000000000002",
  order1: "30000000-0000-4000-8000-000000000001",
};

async function source(relative) {
  return readFile(path.join(root, relative), "utf8");
}

async function importTs(relative) {
  const text = await source(relative);
  const output = ts.transpileModule(text, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    fileName: relative,
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(output).toString("base64")}`);
}

function database() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  return db;
}

async function migrate(db) {
  db.exec(await source("drizzle/0001_secure_market.sql"));
  db.exec(await source("drizzle/0002_loud_major_mapleleaf.sql"));
  const triggers = (await source("worker/economy-triggers.sql"))
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter(Boolean);
  assert.equal(triggers.length, 26);
  for (const trigger of triggers) db.exec(trigger);
}

function seed(db) {
  const now = 1_800_000_000_000;
  for (const [index, id] of [UUID.a, UUID.b, UUID.c].entries()) {
    db.prepare(`INSERT INTO economy_accounts(id,display_name,status,steam_ownership_verified,trade_eligible,wallet_frozen,auth_epoch,risk_score,created_at,updated_at) VALUES(?,?, 'active',1,1,0,0,0,?,?)`).run(id, `user-${index}`, now, now);
    db.prepare(`INSERT INTO economy_identities(id,account_id,provider,provider_subject,ownership_permanent,verified_at,created_at) VALUES(?,?, 'development',?,1,?,?)`).run(`90000000-0000-4000-8000-00000000000${index}`, id, `dev-${index}`, now, now);
    db.prepare(`INSERT INTO economy_wallets(account_id,ash_available,gold_available,updated_at) VALUES(?,?,?,?)`).run(id, index === 0 ? 1_000 : 2_000, index === 0 ? 100 : 0, now);
  }
  db.prepare(`INSERT INTO economy_gold_lots(id,account_id,source,source_id,amount,remaining,state,tradeable_at,released_at,created_at) VALUES(?,?,?,?,100,100,'available',?,?,?)`).run("80000000-0000-4000-8000-000000000001", UUID.a, "admin", "seed-gold-a", now - 1, now - 1, now - 1);
  for (const [index, id] of [UUID.item1, UUID.item2].entries()) {
    db.prepare(`INSERT INTO economy_items(id,owner_account_id,state,tradeable,provenance,origin_id,slot,rarity,item_level,display_name,item_json,version,created_at,updated_at) VALUES(?,?,'inventory',1,'development',?,'weapon','legendary',70,?,'{}',0,?,?)`).run(id, UUID.a, `item-origin-${index}`, `item-${index}`, now, now);
  }
  return now;
}

function command(db, {
  id,
  actor,
  action,
  key,
  result,
  item = null,
  listing = null,
  order = null,
  side = null,
  currency = null,
  price = null,
  gold = null,
  amount = null,
  version = null,
  expires = null,
  now,
}) {
  return db.prepare(`INSERT INTO economy_commands(id,actor_account_id,action,idempotency_key,request_hash,result_ref_id,item_id,listing_id,order_id,side,currency,price_ash,gold_amount,amount,expected_version,expires_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, actor, action, key, "a".repeat(64), result, item, listing, order, side, currency, price, gold, amount, version, expires, now);
}

test("economy protocol rejects mass assignment, floats, overflow, and hash replay", async () => {
  const protocol = await importTs("app/economy-protocol.ts");
  const base = {
    protocolVersion: 1,
    action: "place_exchange",
    idempotencyKey: "place:00000000-0000-4000-8000-000000000001",
    side: "sell_gold",
    goldAmount: 10,
    priceAshPerGold: 25,
  };
  const requestHash = await protocol.computeEconomyCommandHash(base);
  assert.ok(protocol.parseEconomyCommand({ ...base, requestHash }));
  assert.equal(protocol.parseEconomyCommand({ ...base, requestHash, accountId: UUID.a }), null);
  assert.equal(protocol.parseEconomyCommand({ ...base, requestHash, goldAmount: 1.5 }), null);
  assert.equal(protocol.parseEconomyCommand({ ...base, requestHash, goldAmount: 10_000_001 }), null);
  assert.equal(await protocol.verifyEconomyCommandHash({ ...base, requestHash, goldAmount: 11 }), false);

  assert.deepEqual(protocol.parseMarketQuery({
    kind: "items",
    limit: 40,
    sort: "rarity_desc",
    search: "  망각의 검  ",
    slot: "weapon",
    rarity: "legendary",
    minLevel: 40,
    maxLevel: 90,
    minPriceAsh: 100,
    maxPriceAsh: 50_000,
  }), {
    kind: "items",
    limit: 40,
    sort: "rarity_desc",
    search: "망각의 검",
    slot: "weapon",
    rarity: "legendary",
    minLevel: 40,
    maxLevel: 90,
    minPriceAsh: 100,
    maxPriceAsh: 50_000,
  });
  assert.equal(protocol.parseMarketQuery({ kind: "items", minLevel: 90, maxLevel: 40 }), null);
  assert.equal(protocol.parseMarketQuery({ kind: "items", minPriceAsh: 1.5 }), null);
  assert.equal(protocol.parseMarketQuery({ kind: "items", accountId: UUID.a }), null);
  assert.deepEqual(protocol.parseSteamTransactionItems([
    { itemid: 10055, qty: 1, amount: 550000 },
  ]), [{ itemId: "10055", quantity: 1, amountMinor: 550000 }]);
  assert.deepEqual(protocol.parseSteamTransactionItems([
    { itemid: "10055", qty: "1", amount: "550000" },
  ]), [{ itemId: "10055", quantity: 1, amountMinor: 550000 }]);
  assert.equal(protocol.parseSteamTransactionItems([{ itemid: 10055.5, qty: 1, amount: 550000 }]), null);

  const paymentSanction = {
    protocolVersion: 1,
    action: "apply_sanction",
    idempotencyKey: "admin:payment-sanction-0001",
    requestHash: "b".repeat(64),
    targetAccountId: UUID.a,
    scope: "payment",
    reason: "confirmed payment fraud review",
    expiresAt: null,
    evidenceReference: "case-payment-0001",
  };
  assert.equal(protocol.parseAdminEconomyRequest(paymentSanction)?.scope, "payment");
  assert.equal(protocol.parseAdminEconomyRequest({ ...paymentSanction, scope: "root" }), null);

  const finalizeDraft = {
    paymentOrderId: "a0000000-0000-4000-8000-000000000001",
    idempotencyKey: "steam-finalize:00000000-0000-4000-8000-000000000001",
  };
  const finalizeHash = await protocol.computeCanonicalRequestHash(finalizeDraft);
  assert.deepEqual(protocol.parsePaymentFinalizeRequest({ ...finalizeDraft, requestHash: finalizeHash }), {
    ...finalizeDraft,
    requestHash: finalizeHash,
  });
  assert.equal(protocol.parsePaymentFinalizeRequest({ ...finalizeDraft, requestHash: finalizeHash, steamId: "76561198000000000" }), null);
  assert.equal(protocol.parsePaymentFinalizeRequest({ ...finalizeDraft, paymentOrderId: "not-a-server-order", requestHash: finalizeHash }), null);
  assert.equal(protocol.steamTransactionDisposition("Approved"), "finalize");
  assert.equal(protocol.steamTransactionDisposition("Succeeded"), "recover");
  assert.equal(protocol.steamTransactionDisposition("Init"), "reject");
  assert.deepEqual(protocol.parseSteamTransactionItems([{ itemid: "10055", qty: "1", amount: "550000" }]), [
    { itemId: "10055", quantity: 1, amountMinor: 550000 },
  ]);
  assert.equal(protocol.parseSteamTransactionItems([{ itemid: "10055", qty: 1, amount: Number.MAX_SAFE_INTEGER + 1 }]), null);
});

test("secure market migration applies with normalized tables and immutable ledgers", async () => {
  const db = database();
  await migrate(db);
  const count = db.prepare(`SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name LIKE 'economy_%'`).get().count;
  assert.ok(count >= 20);
  seed(db);
  db.prepare(`INSERT INTO economy_ledger(id,operation_id,account_id,currency,available_delta,reserved_delta,locked_delta,reason,reference_type,reference_id,created_at) VALUES('l1','op1',?,'ash',1,0,0,'test','test','x',1)`).run(UUID.a);
  assert.throws(() => db.prepare(`UPDATE economy_ledger SET available_delta=2 WHERE id='l1'`).run(), /immutable_ledger/);
  assert.throws(() => db.prepare(`DELETE FROM economy_ledger WHERE id='l1'`).run(), /immutable_ledger/);
});

test("Sites migrations stay parser-safe while runtime installs every authoritative trigger", async () => {
  const [migration1, migration2, triggerSql, installer] = await Promise.all([
    source("drizzle/0001_secure_market.sql"),
    source("drizzle/0002_loud_major_mapleleaf.sql"),
    source("worker/economy-triggers.sql"),
    source("worker/economy-trigger-installer.ts"),
  ]);
  assert.doesNotMatch(`${migration1}\n${migration2}`, /CREATE\s+TRIGGER/i);
  assert.equal((triggerSql.match(/CREATE\s+TRIGGER\s+IF\s+NOT\s+EXISTS/gi) ?? []).length, 26);
  assert.match(installer, /db\.batch\(/);
  assert.match(installer, /secure-market-triggers-v2/);
  assert.match(installer, /economy_trigger_install_incomplete/);
});

test("one listing can sell once; idempotency, BOLA, seller sanctions, and rollback hold", async () => {
  const db = database();
  await migrate(db);
  const now = seed(db);
  const originalProvenance = db.prepare(`SELECT provenance FROM economy_items WHERE id=?`).get(UUID.item1).provenance;
  command(db, { id: "40000000-0000-4000-8000-000000000001", actor: UUID.a, action: "list_item", key: "list:00000000-0000-4000-8000-000000000001", result: UUID.listing1, item: UUID.item1, price: 400, version: 0, expires: now + 60_000, now });
  command(db, { id: "40000000-0000-4000-8000-000000000002", actor: UUID.b, action: "buy_listing", key: "buy:00000000-0000-4000-8000-000000000001", result: "50000000-0000-4000-8000-000000000001", listing: UUID.listing1, price: 400, version: 0, now: now + 1 });
  assert.equal(db.prepare(`SELECT status FROM economy_listings WHERE id=?`).get(UUID.listing1).status, "sold");
  assert.equal(db.prepare(`SELECT owner_account_id FROM economy_items WHERE id=?`).get(UUID.item1).owner_account_id, UUID.b);
  assert.equal(db.prepare(`SELECT provenance FROM economy_items WHERE id=?`).get(UUID.item1).provenance, originalProvenance);
  assert.equal(db.prepare(`SELECT ash_available FROM economy_wallets WHERE account_id=?`).get(UUID.b).ash_available, 1_600);
  assert.equal(db.prepare(`SELECT ash_available FROM economy_wallets WHERE account_id=?`).get(UUID.a).ash_available, 1_400);
  assert.throws(() => command(db, { id: "40000000-0000-4000-8000-000000000003", actor: UUID.c, action: "buy_listing", key: "buy:00000000-0000-4000-8000-000000000002", result: "50000000-0000-4000-8000-000000000002", listing: UUID.listing1, price: 400, version: 0, now: now + 2 }), /listing_unavailable/);
  assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM economy_auction_trades`).get().count, 1);
  assert.throws(() => command(db, { id: "40000000-0000-4000-8000-000000000004", actor: UUID.b, action: "buy_listing", key: "buy:00000000-0000-4000-8000-000000000001", result: "50000000-0000-4000-8000-000000000003", listing: UUID.listing1, price: 400, version: 1, now: now + 3 }), /UNIQUE|listing_unavailable/);

  command(db, { id: "40000000-0000-4000-8000-000000000005", actor: UUID.a, action: "list_item", key: "list:00000000-0000-4000-8000-000000000002", result: UUID.listing2, item: UUID.item2, price: 300, version: 0, expires: now + 60_000, now: now + 4 });
  assert.throws(() => command(db, { id: "40000000-0000-4000-8000-000000000006", actor: UUID.b, action: "cancel_listing", key: "cancel:00000000-0000-4000-8000-000000000001", result: uuidLike(6), listing: UUID.listing2, version: 0, now: now + 5 }), /listing_not_owned/);
  db.prepare(`INSERT INTO economy_sanctions(id,account_id,scope,reason,starts_at,created_by,created_at) VALUES(?,?,'market','fraud review',?,'test',?)`).run("60000000-0000-4000-8000-000000000001", UUID.a, now, now);
  assert.throws(() => command(db, { id: "40000000-0000-4000-8000-000000000007", actor: UUID.b, action: "buy_listing", key: "buy:00000000-0000-4000-8000-000000000003", result: uuidLike(7), listing: UUID.listing2, price: 300, version: 0, now: now + 6 }), /seller_sanctioned/);
  assert.equal(db.prepare(`SELECT status FROM economy_listings WHERE id=?`).get(UUID.listing2).status, "open");
  assert.equal(db.prepare(`SELECT ash_available FROM economy_wallets WHERE account_id=?`).get(UUID.b).ash_available, 1_600);
});

test("expired auction listings atomically return escrowed items and remain auditable", async () => {
  const db = database();
  await migrate(db);
  const now = seed(db);
  command(db, { id: uuidLike(8), actor: UUID.a, action: "list_item", key: "list:expiry00000000000000001", result: UUID.listing1, item: UUID.item1, price: 400, version: 0, expires: now + 10, now });
  db.prepare(`INSERT OR IGNORE INTO economy_listing_expiry_commands(id,listing_id,created_at)
    SELECT 'expiry:' || id,id,? FROM economy_listings WHERE id=? AND status='open' AND expires_at<=?`)
    .run(now + 11, UUID.listing1, now + 11);
  const listing = db.prepare(`SELECT status,version,closed_at FROM economy_listings WHERE id=?`).get(UUID.listing1);
  assert.equal(listing.status, "expired");
  assert.equal(listing.version, 1);
  assert.equal(listing.closed_at, now + 11);
  const item = db.prepare(`SELECT state,owner_account_id,version FROM economy_items WHERE id=?`).get(UUID.item1);
  assert.equal(item.state, "inventory");
  assert.equal(item.owner_account_id, UUID.a);
  assert.equal(item.version, 2);
  assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM economy_audit_events WHERE action='expire_listing' AND object_id=?`).get(UUID.listing1).count, 1);
  assert.throws(() => db.prepare(`UPDATE economy_listing_expiry_commands SET created_at=created_at+1 WHERE listing_id=?`).run(UUID.listing1), /immutable_listing_expiry_command/);
});

function uuidLike(value) {
  return `70000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
}

test("exchange uses escrow, partial fill, provenance lots, and exact cancel release", async () => {
  const db = database();
  await migrate(db);
  const now = seed(db);
  command(db, { id: uuidLike(11), actor: UUID.a, action: "place_exchange", key: "place:00000000-0000-4000-8000-000000000001", result: UUID.order1, side: "sell_gold", price: 10, gold: 50, now });
  let walletA = db.prepare(`SELECT * FROM economy_wallets WHERE account_id=?`).get(UUID.a);
  assert.equal(walletA.gold_available, 50);
  assert.equal(walletA.gold_reserved, 50);
  assert.equal(db.prepare(`SELECT SUM(amount_remaining) AS amount FROM economy_exchange_order_gold_lots WHERE order_id=?`).get(UUID.order1).amount, 50);

  command(db, { id: uuidLike(12), actor: UUID.b, action: "fill_exchange", key: "fill:00000000-0000-4000-8000-000000000001", result: uuidLike(112), order: UUID.order1, price: 10, gold: 20, version: 0, now: now + 1 });
  walletA = db.prepare(`SELECT * FROM economy_wallets WHERE account_id=?`).get(UUID.a);
  const walletB = db.prepare(`SELECT * FROM economy_wallets WHERE account_id=?`).get(UUID.b);
  assert.equal(walletA.gold_reserved, 30);
  assert.equal(walletA.ash_available, 1_200);
  assert.equal(walletB.gold_available, 20);
  assert.equal(walletB.ash_available, 1_800);
  assert.equal(db.prepare(`SELECT gold_remaining FROM economy_exchange_orders WHERE id=?`).get(UUID.order1).gold_remaining, 30);
  assert.equal(db.prepare(`SELECT SUM(amount) AS amount FROM economy_gold_lot_transfers WHERE fill_id=?`).get(uuidLike(112)).amount, 20);
  assert.equal(db.prepare(`SELECT remaining FROM economy_gold_lots WHERE source='market_transfer' AND source_id=?`).get(uuidLike(112)).remaining, 20);

  command(db, { id: uuidLike(13), actor: UUID.a, action: "cancel_exchange", key: "cancel:00000000-0000-4000-8000-000000000002", result: uuidLike(113), order: UUID.order1, version: 1, now: now + 2 });
  walletA = db.prepare(`SELECT * FROM economy_wallets WHERE account_id=?`).get(UUID.a);
  assert.equal(walletA.gold_available, 80);
  assert.equal(walletA.gold_reserved, 0);
  assert.equal(db.prepare(`SELECT status FROM economy_exchange_orders WHERE id=?`).get(UUID.order1).status, "cancelled");
  assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM economy_audit_events WHERE action IN ('place_exchange','fill_exchange','cancel_exchange')`).get().count, 3);

  const fullOrder = uuidLike(114);
  command(db, { id: uuidLike(14), actor: UUID.a, action: "place_exchange", key: "place:00000000-0000-4000-8000-000000000014", result: fullOrder, side: "sell_gold", price: 10, gold: 80, now: now + 3 });
  command(db, { id: uuidLike(15), actor: UUID.b, action: "fill_exchange", key: "fill:00000000-0000-4000-8000-000000000015", result: uuidLike(115), order: fullOrder, price: 10, gold: 80, version: 0, now: now + 4 });
  const spentSourceLot = db.prepare(`SELECT remaining,state FROM economy_gold_lots WHERE id='80000000-0000-4000-8000-000000000001'`).get();
  assert.equal(spentSourceLot.remaining, 0);
  assert.equal(spentSourceLot.state, "spent");
});

test("sandbox gold is database-validated and cannot enter exchange before the 72h lot hold", async () => {
  const db = database();
  await migrate(db);
  const now = seed(db);
  command(db, { id: uuidLike(21), actor: UUID.b, action: "sandbox_topup", key: "topup:00000000-0000-4000-8000-000000000001", result: uuidLike(121), currency: "gold", amount: 40, now });
  let wallet = db.prepare(`SELECT * FROM economy_wallets WHERE account_id=?`).get(UUID.b);
  assert.equal(wallet.gold_locked, 40);
  assert.equal(wallet.gold_available, 0);
  assert.equal(db.prepare(`SELECT tradeable_at-created_at AS hold FROM economy_gold_lots WHERE source_id=?`).get(uuidLike(21)).hold, 259_200_000);
  assert.throws(() => command(db, { id: uuidLike(22), actor: UUID.b, action: "place_exchange", key: "place:00000000-0000-4000-8000-000000000002", result: uuidLike(122), side: "sell_gold", price: 10, gold: 1, now: now + 1 }), /insufficient_mature_gold/);
  assert.throws(() => command(db, { id: uuidLike(23), actor: UUID.b, action: "sandbox_topup", key: "topup:00000000-0000-4000-8000-000000000002", result: uuidLike(123), currency: "gold", amount: -1, now: now + 1 }), /invalid_sandbox_gold/);
  db.prepare(`INSERT INTO economy_gold_release_commands(id,account_id,created_at) VALUES(?,?,?)`).run(uuidLike(24), UUID.b, now + 259_200_001);
  wallet = db.prepare(`SELECT * FROM economy_wallets WHERE account_id=?`).get(UUID.b);
  assert.equal(wallet.gold_locked, 0);
  assert.equal(wallet.gold_available, 40);
  command(db, { id: uuidLike(25), actor: UUID.b, action: "place_exchange", key: "place:00000000-0000-4000-8000-000000000003", result: uuidLike(125), side: "sell_gold", price: 10, gold: 5, now: now + 259_200_002 });
  assert.equal(db.prepare(`SELECT gold_reserved FROM economy_wallets WHERE account_id=?`).get(UUID.b).gold_reserved, 5);
});

test("payment finalization mints once, records provenance, and holds gold for 72 hours", async () => {
  const db = database();
  await migrate(db);
  const now = seed(db);
  const paymentId = "a0000000-0000-4000-8000-000000000001";
  const approvalUrl = `https://store.steampowered.com/checkout?returnurl=${encodeURIComponent(`https://game.example/market?payment_return=${paymentId}`)}`;
  db.prepare(`INSERT INTO economy_payment_orders(id,account_id,provider,provider_order_id,product_sku,amount_minor,currency,gold_amount,status,approval_url,idempotency_key,request_hash,created_at) VALUES(?,?,'steam','provider-1','gold-55',550000,'KRW',55,'created',?,'payment-init:000000000001',?,?)`)
    .run(paymentId, UUID.b, approvalUrl, "b".repeat(64), now);
  assert.equal(db.prepare(`SELECT approval_url FROM economy_payment_orders WHERE id=?`).get(paymentId).approval_url, approvalUrl);
  assert.throws(() => db.prepare(`INSERT INTO economy_payment_finalize_commands(id,payment_order_id,account_id,idempotency_key,request_hash,created_at) VALUES(?,?,?,?,?,?)`)
    .run(uuidLike(30), paymentId, UUID.b, "payment-final:000000000", "a".repeat(64), now), /payment_not_finalizable/);
  db.prepare(`UPDATE economy_payment_orders SET status='authorized',authorized_at=? WHERE id=?`).run(now + 1, paymentId);
  db.prepare(`INSERT INTO economy_payment_finalize_commands(id,payment_order_id,account_id,idempotency_key,request_hash,created_at) VALUES(?,?,?,?,?,?)`)
    .run(uuidLike(31), paymentId, UUID.b, "payment-final:000000001", "c".repeat(64), now + 2);
  const wallet = db.prepare(`SELECT gold_locked,gold_available FROM economy_wallets WHERE account_id=?`).get(UUID.b);
  assert.equal(wallet.gold_locked, 55);
  assert.equal(wallet.gold_available, 0);
  const lot = db.prepare(`SELECT amount,remaining,state,tradeable_at-created_at AS hold FROM economy_gold_lots WHERE source='steam_payment' AND source_id=?`).get(paymentId);
  assert.equal(lot.amount, 55);
  assert.equal(lot.remaining, 55);
  assert.equal(lot.state, "locked");
  assert.equal(lot.hold, 259_200_000);
  assert.throws(() => db.prepare(`INSERT INTO economy_payment_finalize_commands(id,payment_order_id,account_id,idempotency_key,request_hash,created_at) VALUES(?,?,?,?,?,?)`)
    .run(uuidLike(32), paymentId, UUID.b, "payment-final:000000002", "d".repeat(64), now + 2), /payment_not_finalizable|UNIQUE/);
  assert.equal(db.prepare(`SELECT gold_locked FROM economy_wallets WHERE account_id=?`).get(UUID.b).gold_locked, 55);
  assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM economy_ledger WHERE reason='steam_payment_mint'`).get().count, 1);
});

test("payment mint rechecks active sanctions inside the same database boundary", async () => {
  const db = database();
  await migrate(db);
  const now = seed(db);
  const paymentId = "a0000000-0000-4000-8000-000000000099";
  db.prepare(`INSERT INTO economy_payment_orders(id,account_id,provider,provider_order_id,product_sku,amount_minor,currency,gold_amount,status,idempotency_key,request_hash,created_at,authorized_at) VALUES(?,?,'steam','provider-sanction-1','gold-10',110000,'KRW',10,'authorized','payment-init:sanction001',?,?,?)`)
    .run(paymentId, UUID.b, "a".repeat(64), now, now);
  db.prepare(`INSERT INTO economy_sanctions(id,account_id,scope,reason,starts_at,expires_at,created_by,created_at) VALUES(?,?,'payment','temporary fraud review',?,?, 'test',?)`)
    .run(uuidLike(390), UUID.b, now, now + 60_000, now);
  assert.throws(() => db.prepare(`INSERT INTO economy_payment_finalize_commands(id,payment_order_id,account_id,idempotency_key,request_hash,created_at) VALUES(?,?,?,?,?,?)`)
    .run(uuidLike(391), paymentId, UUID.b, "payment-final:sanction1", "b".repeat(64), now + 1), /payment_account_sanctioned/);
  assert.equal(db.prepare(`SELECT gold_locked FROM economy_wallets WHERE account_id=?`).get(UUID.b).gold_locked, 0);
  assert.equal(db.prepare(`SELECT status FROM economy_payment_orders WHERE id=?`).get(paymentId).status, "authorized");
});

test("a provider Succeeded replay recovers the DB mint without calling FinalizeTxn again", async () => {
  const protocol = await importTs("app/economy-protocol.ts");
  assert.equal(protocol.steamTransactionDisposition("Succeeded"), "recover");

  const db = database();
  await migrate(db);
  const now = seed(db);
  const paymentId = "a0000000-0000-4000-8000-000000000002";
  db.prepare(`INSERT INTO economy_payment_orders(id,account_id,provider,provider_order_id,product_sku,amount_minor,currency,gold_amount,status,approval_url,idempotency_key,request_hash,created_at,authorized_at) VALUES(?,?,'steam','provider-recovery-1','gold-10',110000,'KRW',10,'authorized','https://store.steampowered.com/checkout','payment-init:recovery0001',?,?,?)`)
    .run(paymentId, UUID.b, "e".repeat(64), now, now);
  db.prepare(`INSERT INTO economy_payment_finalize_commands(id,payment_order_id,account_id,idempotency_key,request_hash,created_at) VALUES(?,?,?,?,?,?)`)
    .run(uuidLike(33), paymentId, UUID.b, "payment-final:recovery1", "f".repeat(64), now + 1);
  assert.equal(db.prepare(`SELECT status FROM economy_payment_orders WHERE id=?`).get(paymentId).status, "finalized");
  assert.equal(db.prepare(`SELECT gold_locked FROM economy_wallets WHERE account_id=?`).get(UUID.b).gold_locked, 10);

  const worker = await source("worker/economy-d1.ts");
  const finalizeCall = worker.indexOf('if (disposition === "finalize")');
  const finalizeCommand = worker.indexOf("INSERT INTO economy_payment_finalize_commands", finalizeCall);
  assert.ok(finalizeCall >= 0 && finalizeCommand > finalizeCall, "recovery must skip provider finalize and still commit the DB command");
});

test("admin audit idempotency is immutable and rejects duplicate operator requests", async () => {
  const db = database();
  await migrate(db);
  const now = seed(db);
  const insert = db.prepare(`INSERT INTO economy_audit_events(id,target_account_id,action,object_type,object_id,request_id,idempotency_key,request_hash,metadata_json,created_at) VALUES(?,?,'freeze_wallet','account',?,?,?,?,'{}',?)`);
  insert.run(uuidLike(41), UUID.a, UUID.a, uuidLike(141), "admin:0000000000000001", "e".repeat(64), now);
  assert.throws(() => insert.run(uuidLike(42), UUID.a, UUID.a, uuidLike(142), "admin:0000000000000001", "e".repeat(64), now + 1), /UNIQUE/);
  assert.throws(() => db.prepare(`UPDATE economy_audit_events SET action='tampered' WHERE id=?`).run(uuidLike(41)), /immutable_audit/);
});

test("worker gates live writes, strips spoofed headers, and exposes no local-save upload", async () => {
  const [worker, entry] = await Promise.all([source("worker/economy-d1.ts"), source("worker/index.ts")]);
  for (const route of ["/snapshot", "/market", "/command", "/auth/steam/start", "/auth/steam/callback", "/payments/steam/init", "/payments/steam/finalize", "/admin/sanctions", "/health"]) {
    assert.ok(worker.includes(route), `missing ${route}`);
  }
  assert.match(worker, /ECONOMY_LIVE_ENABLED\s*!==\s*"true"/);
  assert.match(worker, /ECONOMY_PAYMENTS_ENABLED\s*!==\s*"true"/);
  assert.match(worker, /if \(!env\.ECONOMY_ACCOUNT_PEPPER\)/);
  assert.match(worker, /securityConfigured: Boolean\(env\.ECONOMY_ACCOUNT_PEPPER\)/);
  assert.match(worker, /constantTimeSecretEqual/);
  assert.match(worker, /recordRiskEvent/);
  assert.match(worker, /"self_trade_attempt"/);
  assert.match(worker, /"steam_transaction_mismatch"/);
  assert.match(worker, /STEAM_OWNERSHIP_TTL_MS = SESSION_TTL_MS/);
  assert.match(worker, /ON CONFLICT\(provider,provider_subject\) DO UPDATE SET/);
  assert.match(worker, /auth\.account\.steam_verified_at < Date\.now\(\) - STEAM_OWNERSHIP_TTL_MS/);
  assert.match(worker, /enforceRequestRateLimit/);
  assert.match(worker, /stateClaim\.meta\.changes/);
  assert.match(worker, /route === "\/api\/economy\/market"/);
  assert.match(worker, /\? await marketResponse\(request, db, auth\)/);
  assert.match(worker, /\? await executeCommand\(request, db, env, auth\)/);
  assert.doesNotMatch(worker, /route\.endsWith/);
  assert.match(worker, /sellerUserId: mine \? accountId : ""/);
  assert.match(worker, /assertNoActiveSanction\(db, auth\.account\.id, \["login", "payment", "wallet"\]\)/);
  assert.match(worker, /QueryTxn\/v3/);
  assert.match(worker, /steamTransactionDisposition\(transaction\.status\)/);
  assert.match(worker, /disposition === "finalize"/);
  assert.match(worker, /transaction\.orderId !== String\(order\.provider_order_id\)/);
  assert.match(worker, /transaction\.steamId !== auth\.steamId/);
  assert.match(worker, /transaction\.currency !== String\(order\.currency\)\.toUpperCase\(\)/);
  assert.match(worker, /transaction\.items\.length !== 1/);
  assert.match(worker, /transactionItem\.itemId !== product\.itemId/);
  assert.match(worker, /transactionItem\.quantity !== 1/);
  assert.match(worker, /transactionItem\.amountMinor !== Number\(order\.amount_minor\)/);
  assert.match(worker, /searchParams\.set\("returnurl", returnUrl\.toString\(\)\)/);
  assert.match(worker, /SET approval_url=\?/);
  assert.match(worker, /PAYMENT_INIT_TERMINAL/);
  assert.match(worker, /CHARGEBACK_RECONCILIATION_READY = false/);
  assert.match(worker, /PAYMENT_RECONCILIATION_NOT_READY/);
  assert.match(worker, /ADMIN_CONTROL_PLANE_LOCKED/);
  assert.match(worker, /"economy-read", auth\.development \? 600 : 120/);
  assert.doesNotMatch(worker, /resolveSitesAccount|oai-authenticated-user-email/);
  assert.match(worker, /x-mujindo-internal-dev-user/);
  assert.doesNotMatch(worker, /localStorage|save-slots|upload_save|import_inventory/i);
  assert.match(entry, /headers\.delete\("x-mujindo-player-name"\)/);
  assert.match(entry, /headers\.delete\("x-mujindo-dev-user"\)/);
  assert.match(entry, /headers\.delete\("x-mujindo-internal-dev-user"\)/);
  assert.match(entry, /headers\.delete\("x-mujindo-account-id"\)/);
  assert.doesNotMatch(entry, /headers\.get\("oai-authenticated-user/);
  assert.match(entry, /localSameOrigin/);
});
