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

function functionSource(sourceText, functionName) {
  const start = sourceText.indexOf(`function ${functionName}`);
  assert.notEqual(start, -1, `missing function: ${functionName}`);
  const nextFunction = sourceText.indexOf("\nasync function ", start + 1);
  const nextPlainFunction = sourceText.indexOf("\nfunction ", start + 1);
  const candidates = [nextFunction, nextPlainFunction].filter((index) => index > start);
  const end = candidates.length > 0 ? Math.min(...candidates) : sourceText.length;
  return sourceText.slice(start, end);
}

function preparedSqlTemplate(sourceText, functionName) {
  const block = functionSource(sourceText, functionName);
  const match = block.match(/db\.prepare\(\s*`([\s\S]*?)`,?\s*\)/);
  assert.ok(match, `missing prepared SQL template in ${functionName}`);
  return match[1];
}

function preparedSqlTemplateContaining(sourceText, interpolationName) {
  const token = `\${${interpolationName}}`;
  const templates = [...sourceText.matchAll(/db\.prepare\(\s*`([\s\S]*?)`,?\s*\)/g)]
    .map((match) => match[1]);
  const template = templates.find((candidate) => candidate.includes(token));
  assert.ok(template, `missing prepared SQL template containing ${token}`);
  return template;
}

function renderSqlTemplate(template, substitutions = {}) {
  return template.replace(/\$\{([A-Za-z0-9_]+)\}/g, (_match, name) => {
    assert.ok(Object.hasOwn(substitutions, name), `missing SQL template substitution: ${name}`);
    return substitutions[name];
  });
}

async function importTs(relative) {
  const text = await source(relative);
  const output = ts.transpileModule(text, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    fileName: relative,
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(output).toString("base64")}`);
}

async function importEconomyClient() {
  const [clientSource, protocolSource] = await Promise.all([
    source("app/economy-client.ts"),
    source("app/economy-protocol.ts"),
  ]);
  const compilerOptions = {
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ES2022,
  };
  const protocolOutput = ts.transpileModule(protocolSource, {
    compilerOptions,
    fileName: "app/economy-protocol.ts",
  }).outputText;
  const protocolUrl = `data:text/javascript;base64,${Buffer.from(protocolOutput).toString("base64")}`;
  const clientOutput = ts.transpileModule(clientSource, {
    compilerOptions,
    fileName: "app/economy-client.ts",
  }).outputText.replaceAll('from "./economy-protocol"', `from ${JSON.stringify(protocolUrl)}`);
  return import(`data:text/javascript;base64,${Buffer.from(clientOutput).toString("base64")}`);
}

async function importEconomySchema() {
  const [schemaSource, migration1, migration2] = await Promise.all([
    source("worker/economy-schema.ts"),
    source("drizzle/0001_secure_market.sql"),
    source("drizzle/0002_loud_major_mapleleaf.sql"),
  ]);
  const output = ts.transpileModule(schemaSource, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    fileName: "worker/economy-schema.ts",
  }).outputText
    .replace(
      /import secureMarketSql from [^;]+;/,
      `const secureMarketSql = ${JSON.stringify(migration1)};`,
    )
    .replace(
      /import listingExpirySql from [^;]+;/,
      `const listingExpirySql = ${JSON.stringify(migration2)};`,
    );
  return import(`data:text/javascript;base64,${Buffer.from(output).toString("base64")}`);
}

async function importEconomyTriggerInstaller() {
  const [installerSource, triggerSql] = await Promise.all([
    source("worker/economy-trigger-installer.ts"),
    source("worker/economy-triggers.sql"),
  ]);
  const output = ts.transpileModule(installerSource, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    fileName: "worker/economy-trigger-installer.ts",
  }).outputText.replace(
    /import economyTriggerSql from [^;]+;/,
    `const economyTriggerSql = ${JSON.stringify(triggerSql)};`,
  );
  return import(`data:text/javascript;base64,${Buffer.from(output).toString("base64")}`);
}

class D1StatementAdapter {
  constructor(database, sql, bindings = []) {
    this.database = database;
    this.sql = sql;
    this.bindings = bindings;
  }
  bind(...bindings) {
    return new D1StatementAdapter(this.database, this.sql, bindings);
  }
  first() {
    return this.database.prepare(this.sql).get(...this.bindings) ?? null;
  }
  all() {
    return { results: this.database.prepare(this.sql).all(...this.bindings) };
  }
  run() {
    const result = this.database.prepare(this.sql).run(...this.bindings);
    return { success: true, meta: { changes: Number(result.changes) } };
  }
}

class D1DatabaseAdapter {
  constructor() {
    this.database = database();
  }
  prepare(sql) {
    return new D1StatementAdapter(this.database, sql);
  }
  async batch(statements) {
    this.database.exec("BEGIN");
    try {
      const results = statements.map((statement) => statement.run());
      this.database.exec("COMMIT");
      return results;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
  close() {
    this.database.close();
  }
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

  const characterItem = {
    id: "gear-character-market-contract",
    slot: "weapon",
    rarity: "rare",
    level: 42,
    baseName: "contract blade",
    affixes: [{ stat: "attackPowerFlat", value: 7, rollPercent: 55 }],
  };
  const characterList = {
    protocolVersion: 1,
    action: "list_item",
    idempotencyKey: "list-character:0000000000000001",
    itemId: UUID.item1,
    priceAsh: 4_200,
    expiresInSeconds: 3_600,
    expectedItemVersion: 0,
    characterItem,
    sourceSaveSlot: 2,
  };
  const characterHash = await protocol.computeEconomyCommandHash(characterList);
  const parsedCharacterList = protocol.parseEconomyCommand({
    ...characterList,
    requestHash: characterHash,
  });
  assert.ok(parsedCharacterList);
  assert.equal(await protocol.verifyEconomyCommandHash(parsedCharacterList), true);
  assert.equal(protocol.parseEconomyCommand({
    ...characterList,
    requestHash: characterHash,
    expectedItemVersion: 1,
  }), null);
  assert.equal(protocol.parseEconomyCommand({
    ...characterList,
    requestHash: characterHash,
    sourceSaveSlot: 4,
  }), null);
  assert.equal(protocol.parseEconomyCommand({
    ...characterList,
    requestHash: characterHash,
    characterItem: [characterItem],
  }), null);
  assert.equal(protocol.parseEconomyCommand({
    ...characterList,
    requestHash: characterHash,
    ownerAccountId: UUID.b,
  }), null);
  assert.equal(await protocol.verifyEconomyCommandHash({
    ...parsedCharacterList,
    characterItem: { ...characterItem, level: 43 },
  }), false);

  const vaultList = {
    protocolVersion: 1,
    action: "list_item",
    idempotencyKey: "list-vault:000000000000000001",
    itemId: UUID.item2,
    priceAsh: 2_100,
    expiresInSeconds: 3_600,
    expectedItemVersion: 7,
  };
  const vaultHash = await protocol.computeEconomyCommandHash(vaultList);
  assert.ok(protocol.parseEconomyCommand({ ...vaultList, requestHash: vaultHash }));

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
  assert.deepEqual(protocol.parseMarketQuery({
    kind: "items",
    limit: 60,
    sort: "power_desc",
  }), {
    kind: "items",
    limit: 60,
    sort: "power_desc",
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

test("economy client reuses one intent key after response loss and consumes the command snapshot", async () => {
  const client = await importEconomyClient();
  const originalFetch = globalThis.fetch;
  const intentKey = "market-buy:00000000-0000-4000-8000-000000000001";
  const seenRequests = [];
  const committedKeys = new Set();
  let mutations = 0;
  globalThis.fetch = async (input, init = {}) => {
    assert.equal(String(input), "/api/economy/command");
    assert.equal(init.method, "POST");
    const body = JSON.parse(String(init.body));
    const headerKey = new Headers(init.headers).get("Idempotency-Key");
    seenRequests.push({ body, headerKey });
    if (!committedKeys.has(body.idempotencyKey)) {
      committedKeys.add(body.idempotencyKey);
      mutations += 1;
    }
    if (seenRequests.length === 1) throw new TypeError("response lost after commit");
    return new Response(JSON.stringify({
      ok: true,
      data: {
        snapshot: {
          revision: 17,
          auctionTrades: [{
            tradeId: "trade-response-loss",
            item: {
              vaultItemId: UUID.item1,
              itemId: UUID.item1,
              displayName: "응답 유실 검",
              baseName: "응답 유실 검",
              rarity: "legendary",
              slot: "weapon",
              level: 70,
              enhancement: 5,
              powerScore: 1_234,
              qualityScore: 88,
              iconIndex: 3,
              affixes: [{ label: "공격력", value: "+12" }],
              tradeState: "available",
              lockedUntil: null,
              version: 2,
            },
            priceAsh: 4_200,
            executedAt: "2026-08-17T00:00:00.000Z",
          }],
        },
      },
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const commandDraft = {
    action: "buy_listing",
    listingId: UUID.listing1,
    expectedListingVersion: 0,
    expectedPriceAsh: 4_200,
  };
  try {
    await assert.rejects(
      client.sendEconomyCommand(commandDraft, { csrfToken: null, revision: 0 }, { idempotencyKey: intentKey }),
      /response lost after commit/,
    );
    const snapshot = await client.sendEconomyCommand(
      commandDraft,
      { csrfToken: null, revision: 0 },
      { idempotencyKey: intentKey },
    );
    assert.equal(mutations, 1, "the simulated server must mutate once for one intent key");
    assert.equal(seenRequests.length, 2, "embedded command snapshots must avoid a follow-up GET");
    assert.deepEqual(seenRequests.map((entry) => entry.headerKey), [intentKey, intentKey]);
    assert.deepEqual(seenRequests.map((entry) => entry.body.idempotencyKey), [intentKey, intentKey]);
    assert.equal(seenRequests[0].body.requestHash, seenRequests[1].body.requestHash);
    assert.equal(snapshot.revision, 17);
    assert.equal(snapshot.auctionTrades.length, 1);
    assert.equal(snapshot.auctionTrades[0].item.enhancement, 5);
    assert.equal(snapshot.auctionTrades[0].priceAsh, 4_200);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("market item decoding preserves every canonical legendary, enhancement, forge, and affix field", async () => {
  const client = await importEconomyClient();
  const canonicalItem = {
    vaultItemId: UUID.item1,
    itemId: UUID.item1,
    displayName: "canonical market blade",
    baseName: "market blade",
    rarity: "legendary",
    slot: "weapon",
    level: 77,
    enhancement: 5,
    legendaryPowerId: "crescentEcho",
    enhancementRanks: [2, 1, 2],
    divineForgeRerolls: 3,
    powerScore: 12_345,
    qualityScore: 91,
    iconIndex: 7,
    affixes: [
      { stat: "damagePercent", label: "damage +12%", value: 12.5, rollPercent: 91 },
      { stat: "critChancePercent", label: "critical +6%", value: 6, rollPercent: 74 },
    ],
    tradeState: "available",
    lockedUntil: null,
    version: 4,
  };
  const snapshot = client.normalizeEconomySnapshot({
    vaultItems: [canonicalItem],
    listings: [{
      listingId: UUID.listing1,
      sellerName: "seller",
      item: canonicalItem,
      priceAsh: 4_200,
      listedAt: "2026-08-17T00:00:00.000Z",
      expiresAt: "2026-08-24T00:00:00.000Z",
      mine: false,
      version: 2,
    }],
    auctionTrades: [{
      tradeId: uuidLike(420),
      item: canonicalItem,
      priceAsh: 4_000,
      executedAt: "2026-08-16T00:00:00.000Z",
    }],
  });
  const decoded = snapshot.vaultItems[0];
  assert.deepEqual({
    legendaryPowerId: decoded.legendaryPowerId,
    enhancementRanks: decoded.enhancementRanks,
    divineForgeRerolls: decoded.divineForgeRerolls,
    affixes: decoded.affixes,
  }, {
    legendaryPowerId: "crescentEcho",
    enhancementRanks: [2, 1, 2],
    divineForgeRerolls: 3,
    affixes: canonicalItem.affixes,
  });
  assert.deepEqual(snapshot.listings[0].item, decoded);
  assert.deepEqual(snapshot.auctionTrades[0].item, decoded);

  const [clientSource, workerSource] = await Promise.all([
    source("app/economy-client.ts"),
    source("worker/economy-d1.ts"),
  ]);
  for (const field of [
    "legendaryPowerId",
    "enhancementRanks",
    "divineForgeRerolls",
    "stat",
    "value",
    "rollPercent",
  ]) {
    assert.match(clientSource, new RegExp(field));
    assert.match(workerSource, new RegExp(field));
  }
});

test("production economy client rejects browser-authored character equipment before transport", async () => {
  const client = await importEconomyClient();
  const originalFetch = globalThis.fetch;
  let fetchCount = 0;
  globalThis.fetch = async () => {
    fetchCount += 1;
    throw new Error("must not reach transport");
  };
  try {
    await assert.rejects(
      client.sendEconomyCommand({
        action: "list_item",
        itemId: UUID.item1,
        priceAsh: 1_000,
        expiresInSeconds: 3_600,
        expectedItemVersion: 0,
        sourceSaveSlot: 1,
        characterItem: {
          id: "forged-client-item",
          slot: "weapon",
          rarity: "cosmic",
          level: 999,
          baseName: "forged",
          affixes: [],
        },
      }, { csrfToken: null, revision: 0 }),
      (error) => error instanceof client.EconomyClientError &&
        error.status === 403 &&
        error.code === "SECURE_INVENTORY_REQUIRED",
    );
    assert.equal(fetchCount, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
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

test("item market power sort is numeric and has deterministic descending tie breaks", async () => {
  const worker = await source("worker/economy-d1.ts");
  const orderByMatch = worker.match(
    /power_desc:\s*`([\s\S]*?)`,\s*\n\s*level_desc:/,
  );
  assert.ok(orderByMatch, "worker must expose the authoritative power_desc ordering");

  const db = database();
  db.exec(`
    CREATE TABLE items (
      id TEXT PRIMARY KEY,
      item_level INTEGER NOT NULL,
      item_json TEXT NOT NULL
    );
    CREATE TABLE listings (
      id TEXT PRIMARY KEY,
      item_id TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);
  const insertItem = db.prepare(
    "INSERT INTO items(id,item_level,item_json) VALUES(?,?,json_object('powerScore',?))",
  );
  const insertListing = db.prepare(
    "INSERT INTO listings(id,item_id,created_at) VALUES(?,?,?)",
  );
  for (const row of [
    { id: "a", power: 900, level: 99, createdAt: 3 },
    { id: "b", power: 1200, level: 1, createdAt: 1 },
    { id: "c", power: 900, level: 100, createdAt: 1 },
    { id: "d", power: 900, level: 100, createdAt: 2 },
    { id: "e", power: 900, level: 100, createdAt: 2 },
  ]) {
    insertItem.run(row.id, row.level, row.power);
    insertListing.run(row.id, row.id, row.createdAt);
  }
  const ids = db.prepare(
    `SELECT l.id FROM listings l JOIN items i ON i.id=l.item_id ORDER BY ${orderByMatch[1]}`,
  ).all().map((row) => row.id);
  assert.deepEqual(ids, ["b", "e", "d", "c", "a"]);
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
  assert.match(installer, /secure-market-triggers-v6/);
  for (const triggerName of [
    "economy_payment_finalize_before",
    "economy_list_item_before",
    "economy_buy_listing_before",
    "economy_place_exchange_before",
    "economy_fill_exchange_before",
    "economy_cancel_listing_before",
    "economy_cancel_exchange_before",
  ]) {
    const drop = `DROP TRIGGER IF EXISTS ${triggerName}`;
    assert.ok(installer.includes(drop), `v6 must replace ${triggerName}`);
    assert.ok(
      installer.indexOf(drop) < installer.indexOf("...economyTriggerStatements.map"),
      `${triggerName} must be dropped before authoritative triggers are installed`,
    );
  }
  assert.match(installer, /economy_trigger_install_incomplete/);
});

test("trigger installer v6 replaces stale v5 bodies and self-heals a missing trigger", async () => {
  const installer = await importEconomyTriggerInstaller();
  const db = new D1DatabaseAdapter();
  await migrate(db.database);
  db.database.exec(`
    DROP TRIGGER economy_buy_listing_before;
    CREATE TRIGGER economy_buy_listing_before
    BEFORE INSERT ON economy_commands WHEN NEW.action='buy_listing'
    BEGIN
      SELECT 1;
    END;
  `);
  db.database.prepare(`INSERT INTO economy_rate_limits
    (subject_key,bucket,window_started_at,request_count,blocked_until)
    VALUES('system:economy-schema','secure-market-triggers-v5',1,0,NULL)`).run();

  await installer.ensureEconomyTriggers(db);
  const installedSql = db.database.prepare(`SELECT sql FROM sqlite_master
    WHERE type='trigger' AND name='economy_buy_listing_before'`).get().sql;
  assert.match(installedSql, /i\.state='escrow' AND i\.tradeable=1/);
  assert.match(installedSql, /s\.scope IN \('login','market','wallet'\)/);
  assert.match(installedSql, /w\.ash_available\+w\.ash_reserved\+l\.price_ash<=9000000000000/);
  assert.equal(db.database.prepare(`SELECT COUNT(*) AS count FROM economy_rate_limits
    WHERE subject_key='system:economy-schema' AND bucket='secure-market-triggers-v6'`).get().count, 1);

  db.database.exec("DROP TRIGGER economy_cancel_exchange_before");
  await installer.ensureEconomyTriggers(db);
  const healedCancel = db.database.prepare(`SELECT sql FROM sqlite_master
    WHERE type='trigger' AND name='economy_cancel_exchange_before'`).get().sql;
  assert.match(healedCancel, /account_id=NEW\.actor_account_id/);
  assert.match(healedCancel, /status IN \('open','partially_filled'\)/);
  assert.doesNotMatch(healedCancel, /economy_sanctions|wallet_frozen|steam_ownership_stale/);
  assert.equal(db.database.prepare(`SELECT COUNT(*) AS count FROM sqlite_master
    WHERE type='trigger'`).get().count, 26);
  db.close();
});

test("localhost economy schema self-heals a fresh or hub-only D1 without losing rows", async () => {
  const schema = await importEconomySchema();
  const db = new D1DatabaseAdapter();
  db.database.exec("CREATE TABLE hub_sessions (id TEXT PRIMARY KEY); INSERT INTO hub_sessions(id) VALUES('preserve-me')");

  await Promise.all([
    schema.ensureEconomySchema(db, { allowLocalBootstrap: true }),
    schema.ensureEconomySchema(db, { allowLocalBootstrap: true }),
  ]);
  assert.equal(db.database.prepare("SELECT id FROM hub_sessions").get().id, "preserve-me");
  assert.equal(
    db.database.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name LIKE 'economy_%'").get().count,
    new Set(schema.economySchemaTableNames).size,
  );

  db.database.prepare(`INSERT INTO economy_accounts
    (id,display_name,status,steam_ownership_verified,trade_eligible,wallet_frozen,auth_epoch,risk_score,created_at,updated_at)
    VALUES(?,?,'active',0,0,0,0,0,1,1)`).run(UUID.a, "preserved account");
  schema.resetEconomySchemaReadiness(db);
  await schema.ensureEconomySchema(db, { allowLocalBootstrap: true });
  assert.equal(db.database.prepare("SELECT display_name FROM economy_accounts WHERE id=?").get(UUID.a).display_name, "preserved account");
  db.close();
});

test("remote economy databases remain fail-closed when migrations are missing", async () => {
  const schema = await importEconomySchema();
  const db = new D1DatabaseAdapter();
  await assert.rejects(
    schema.ensureEconomySchema(db, { allowLocalBootstrap: false }),
    (error) => error instanceof schema.EconomySchemaMissingError && error.missingObjects.includes("table:economy_accounts"),
  );
  assert.equal(
    db.database.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name LIKE 'economy_%'").get().count,
    0,
  );
  db.close();
});

test("missing economy security indexes fail closed remotely and self-heal locally", async () => {
  const schema = await importEconomySchema();
  const db = new D1DatabaseAdapter();
  await schema.ensureEconomySchema(db, { allowLocalBootstrap: true });
  db.database.exec("DROP INDEX economy_one_open_listing_per_item");
  schema.resetEconomySchemaReadiness(db);

  await assert.rejects(
    schema.ensureEconomySchema(db, { allowLocalBootstrap: false }),
    (error) => error instanceof schema.EconomySchemaMissingError &&
      error.missingObjects.includes("index:economy_one_open_listing_per_item"),
  );
  await schema.ensureEconomySchema(db, { allowLocalBootstrap: true });
  assert.ok(db.database.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='index' AND name='economy_one_open_listing_per_item'",
  ).get());
  db.close();
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
  const completedTrade = db.prepare(`SELECT t.id AS trade_id,t.price_ash AS trade_price_ash,
    t.created_at AS trade_created_at,i.*
    FROM economy_auction_trades t JOIN economy_items i ON i.id=t.item_id
    ORDER BY t.created_at DESC,t.id DESC LIMIT 100`).get();
  assert.equal(completedTrade.trade_id, "50000000-0000-4000-8000-000000000001");
  assert.equal(completedTrade.trade_price_ash, 400);
  assert.equal(completedTrade.id, UUID.item1);
  assert.equal(completedTrade.owner_account_id, UUID.b);
  assert.throws(() => command(db, { id: "40000000-0000-4000-8000-000000000004", actor: UUID.b, action: "buy_listing", key: "buy:00000000-0000-4000-8000-000000000001", result: "50000000-0000-4000-8000-000000000003", listing: UUID.listing1, price: 400, version: 1, now: now + 3 }), /UNIQUE|listing_unavailable/);

  command(db, { id: "40000000-0000-4000-8000-000000000005", actor: UUID.a, action: "list_item", key: "list:00000000-0000-4000-8000-000000000002", result: UUID.listing2, item: UUID.item2, price: 300, version: 0, expires: now + 60_000, now: now + 4 });
  assert.throws(() => command(db, { id: "40000000-0000-4000-8000-000000000006", actor: UUID.b, action: "cancel_listing", key: "cancel:00000000-0000-4000-8000-000000000001", result: uuidLike(6), listing: UUID.listing2, version: 0, now: now + 5 }), /listing_not_owned/);
  db.prepare(`INSERT INTO economy_sanctions(id,account_id,scope,reason,starts_at,created_by,created_at) VALUES(?,?,'market','fraud review',?,'test',?)`).run("60000000-0000-4000-8000-000000000001", UUID.a, now, now);
  assert.throws(() => command(db, { id: "40000000-0000-4000-8000-000000000007", actor: UUID.b, action: "buy_listing", key: "buy:00000000-0000-4000-8000-000000000003", result: uuidLike(7), listing: UUID.listing2, price: 300, version: 0, now: now + 6 }), /seller_sanctioned/);
  assert.equal(db.prepare(`SELECT status FROM economy_listings WHERE id=?`).get(UUID.listing2).status, "open");
  assert.equal(db.prepare(`SELECT ash_available FROM economy_wallets WHERE account_id=?`).get(UUID.b).ash_available, 1_600);
  const worker = await source("worker/economy-d1.ts");
  assert.match(worker, /FROM economy_auction_trades t[\s\S]{0,100}?JOIN economy_items i ON i\.id=t\.item_id/);
  assert.match(worker, /publicTradeImportPredicate = includeDevelopmentImports[\s\S]{0,120}?\? ""[\s\S]{0,120}?WHERE NOT \(i\.provenance='server_drop' AND i\.origin_id LIKE 'character:%'\)/);
  assert.match(worker, /auctionTrades: auctionTrades\.results\.map\(auctionTradeView\)/);
  assert.match(worker, /myAuctionTrades: myAuctionTrades\.results\.map\(\(row\) => accountAuctionTradeView\(row, auth\.account\.id\)\)/);
  assert.match(worker, /WHERE \(t\.seller_account_id=\? OR t\.buyer_account_id=\?\)/);
  assert.match(worker, /role = row\.buyer_account_id === accountId \? "buyer" : "seller"/);
});

test("listing and settlement receive limits count ash already reserved by the wallet", async () => {
  const db = database();
  await migrate(db);
  const now = seed(db);
  const maxAsh = 9_000_000_000_000;

  db.prepare(`UPDATE economy_wallets SET ash_available=?,ash_reserved=50 WHERE account_id=?`)
    .run(maxAsh - 50, UUID.a);
  assert.throws(
    () => command(db, {
      id: uuidLike(740),
      actor: UUID.a,
      action: "list_item",
      key: "list:reserved-capacity-0000001",
      result: UUID.listing1,
      item: UUID.item1,
      price: 1,
      version: 0,
      expires: now + 60_000,
      now,
    }),
    /seller_wallet_capacity/,
  );
  assert.equal(db.prepare(`SELECT state FROM economy_items WHERE id=?`).get(UUID.item1).state, "inventory");
  assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM economy_listings`).get().count, 0);

  db.prepare(`UPDATE economy_wallets SET ash_available=1000,ash_reserved=0 WHERE account_id=?`)
    .run(UUID.a);
  command(db, {
    id: uuidLike(741),
    actor: UUID.a,
    action: "list_item",
    key: "list:reserved-capacity-0000002",
    result: UUID.listing1,
    item: UUID.item1,
    price: 400,
    version: 0,
    expires: now + 60_000,
    now: now + 1,
  });
  db.prepare(`UPDATE economy_wallets SET ash_available=?,ash_reserved=50 WHERE account_id=?`)
    .run(maxAsh - 50, UUID.a);
  assert.throws(
    () => command(db, {
      id: uuidLike(742),
      actor: UUID.b,
      action: "buy_listing",
      key: "buy:reserved-capacity-0000001",
      result: uuidLike(743),
      listing: UUID.listing1,
      price: 400,
      version: 0,
      now: now + 2,
    }),
    /seller_wallet_capacity/,
  );
  assert.equal(db.prepare(`SELECT status FROM economy_listings WHERE id=?`).get(UUID.listing1).status, "open");
  assert.equal(db.prepare(`SELECT owner_account_id FROM economy_items WHERE id=?`).get(UUID.item1).owner_account_id, UUID.a);
  assert.equal(db.prepare(`SELECT ash_available FROM economy_wallets WHERE account_id=?`).get(UUID.b).ash_available, 2_000);
  db.close();
});

test("account listings stay cancelable when newer foreign listings fill the public snapshot", async () => {
  const db = database();
  await migrate(db);
  const now = seed(db);

  for (let index = 0; index < 101; index += 1) {
    const suffix = String(index + 1).padStart(12, "0");
    const itemId = `81000000-0000-4000-8000-${suffix}`;
    const listingId = `82000000-0000-4000-8000-${suffix}`;
    db.prepare(`INSERT INTO economy_items
      (id,owner_account_id,state,tradeable,provenance,origin_id,slot,rarity,item_level,display_name,item_json,version,created_at,updated_at)
      VALUES(?,?,'escrow',1,'development',?,'weapon','legendary',70,?,'{}',0,?,?)`)
      .run(itemId, UUID.b, `foreign-${index}`, `foreign-${index}`, now + 1_000 + index, now + 1_000 + index);
    db.prepare(`INSERT INTO economy_listings
      (id,item_id,seller_account_id,price_ash,status,version,created_at,expires_at)
      VALUES(?,?,?,100,'open',0,?,?)`)
      .run(listingId, itemId, UUID.b, now + 1_000 + index, now + 100_000);
  }

  for (let index = 0; index < 2; index += 1) {
    const suffix = String(index + 1).padStart(12, "0");
    const itemId = `83000000-0000-4000-8000-${suffix}`;
    const listingId = `84000000-0000-4000-8000-${suffix}`;
    db.prepare(`INSERT INTO economy_items
      (id,owner_account_id,state,tradeable,provenance,origin_id,slot,rarity,item_level,display_name,item_json,version,created_at,updated_at)
      VALUES(?,?,'escrow',1,'development',?,'weapon','legendary',70,?,'{}',0,?,?)`)
      .run(itemId, UUID.a, `mine-${index}`, `mine-${index}`, now + index, now + index);
    db.prepare(`INSERT INTO economy_listings
      (id,item_id,seller_account_id,price_ash,status,version,created_at,expires_at)
      VALUES(?,?,?,200,'open',0,?,?)`)
      .run(listingId, itemId, UUID.a, now + index, now + 100_000);
  }

  const publicRows = db.prepare(`SELECT l.id
    FROM economy_listings l JOIN economy_items i ON i.id=l.item_id
    WHERE l.status='open' AND l.expires_at>? AND i.state='escrow' AND i.tradeable=1
    ORDER BY l.created_at DESC,l.id DESC LIMIT 100`).all(Date.now());
  assert.equal(publicRows.some((row) => String(row.id).startsWith("84000000")), false);

  const worker = await source("worker/economy-d1.ts");
  const privateTemplate = preparedSqlTemplate(worker, "queryMyListings");
  assert.doesNotMatch(privateTemplate, /\$\{/);
  const privateRows = db.prepare(privateTemplate).all(UUID.a, Date.now(), 200);
  assert.equal(privateRows.length, 2);
  assert.ok(privateRows.every((row) => row.seller_account_id === UUID.a));
  assert.match(worker, /myListings: accountListings/);
});

test("character-import trade history is visible locally and excluded from public and private live history", async () => {
  const db = database();
  await migrate(db);
  const now = seed(db);
  db.prepare(`UPDATE economy_items SET provenance='server_drop',origin_id=? WHERE id=?`)
    .run(`character:${UUID.a}:gear-local-history`, UUID.item1);
  command(db, {
    id: uuidLike(751),
    actor: UUID.a,
    action: "list_item",
    key: "list:local-history-0000000001",
    result: UUID.listing1,
    item: UUID.item1,
    price: 400,
    version: 0,
    expires: now + 60_000,
    now,
  });
  command(db, {
    id: uuidLike(752),
    actor: UUID.b,
    action: "buy_listing",
    key: "buy:local-history-00000000001",
    result: uuidLike(753),
    listing: UUID.listing1,
    price: 400,
    version: 0,
    now: now + 1,
  });

  const worker = await source("worker/economy-d1.ts");
  const publicTemplate = preparedSqlTemplateContaining(worker, "publicTradeImportPredicate");
  const privateTemplate = preparedSqlTemplateContaining(worker, "privateTradeImportPredicate");
  const livePredicate = "NOT (i.provenance='server_drop' AND i.origin_id LIKE 'character:%')";
  const localPublic = db.prepare(renderSqlTemplate(publicTemplate, {
    publicTradeImportPredicate: "",
  })).all(100);
  const livePublic = db.prepare(renderSqlTemplate(publicTemplate, {
    publicTradeImportPredicate: `WHERE ${livePredicate}`,
  })).all(100);
  const localPrivate = db.prepare(renderSqlTemplate(privateTemplate, {
    privateTradeImportPredicate: "",
  })).all(UUID.a, UUID.a, 100);
  const livePrivate = db.prepare(renderSqlTemplate(privateTemplate, {
    privateTradeImportPredicate: `AND ${livePredicate}`,
  })).all(UUID.a, UUID.a, 100);

  assert.deepEqual(localPublic.map((row) => row.trade_id), [uuidLike(753)]);
  assert.deepEqual(localPrivate.map((row) => row.trade_id), [uuidLike(753)]);
  assert.equal(livePublic.length, 0);
  assert.equal(livePrivate.length, 0);
  db.close();
});

test("auction search and purchase both reject nontradeable or non-escrow item rows", async () => {
  const db = database();
  await migrate(db);
  const now = seed(db);
  command(db, {
    id: uuidLike(801),
    actor: UUID.a,
    action: "list_item",
    key: "list:visibility-guard-00000001",
    result: UUID.listing1,
    item: UUID.item1,
    price: 400,
    version: 0,
    expires: now + 60_000,
    now,
  });
  const visibleCount = () => db.prepare(`SELECT COUNT(*) AS count
    FROM economy_listings l JOIN economy_items i ON i.id=l.item_id
    WHERE l.status='open' AND l.expires_at>? AND i.state='escrow' AND i.tradeable=1
      AND NOT (i.provenance='server_drop' AND i.origin_id LIKE 'character:%')`)
    .get(now + 1).count;
  assert.equal(visibleCount(), 1);

  db.prepare(`UPDATE economy_items SET tradeable=0 WHERE id=?`).run(UUID.item1);
  assert.equal(visibleCount(), 0, "nontradeable equipment must disappear from search");
  assert.throws(() => command(db, {
    id: uuidLike(802),
    actor: UUID.b,
    action: "buy_listing",
    key: "buy:visibility-guard-000000001",
    result: uuidLike(902),
    listing: UUID.listing1,
    price: 400,
    version: 0,
    now: now + 1,
  }), /listing_unavailable/);
  assert.equal(db.prepare(`SELECT status FROM economy_listings WHERE id=?`).get(UUID.listing1).status, "open");

  db.prepare(`UPDATE economy_items SET tradeable=1,state='inventory' WHERE id=?`).run(UUID.item1);
  assert.equal(visibleCount(), 0, "an item outside escrow must disappear from search");
  assert.throws(() => command(db, {
    id: uuidLike(803),
    actor: UUID.b,
    action: "buy_listing",
    key: "buy:visibility-guard-000000002",
    result: uuidLike(903),
    listing: UUID.listing1,
    price: 400,
    version: 0,
    now: now + 2,
  }), /listing_unavailable/);
  assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM economy_auction_trades`).get().count, 0);

  db.prepare(`UPDATE economy_items
    SET state='escrow',provenance='server_drop',origin_id=? WHERE id=?`)
    .run(`character:${UUID.a}:legacy-client-item`, UUID.item1);
  assert.equal(visibleCount(), 0, "legacy browser-imported rows stay hidden until ownership audit");
  assert.equal(db.prepare(`SELECT 1 AS contaminated FROM economy_items
    WHERE provenance='server_drop' AND origin_id LIKE 'character:%' LIMIT 1`).get().contaminated, 1);

  const worker = await source("worker/economy-d1.ts");
  const triggers = await source("worker/economy-triggers.sql");
  assert.match(worker, /const where = \[[\s\S]{0,180}?"i\.state='escrow'"[\s\S]{0,80}?"i\.tradeable=1"/);
  assert.match(triggers, /economy_buy_listing_before[\s\S]*?i\.state='escrow' AND i\.tradeable=1 AND i\.owner_account_id=l\.seller_account_id/);
  assert.match(worker, /hasLegacyCharacterImportContamination/);
  assert.match(worker, /"INVENTORY_AUDIT_REQUIRED"/);
  assert.match(worker, /const live = economyLiveEnabled\(env\) && !inventoryAuditRequired/);
  assert.match(worker, /NOT \(i\.provenance='server_drop' AND i\.origin_id LIKE 'character:%'\)/);
});

test("login sanctions hide actor listings and maker orders while owner cancellation remains available", async () => {
  const db = database();
  await migrate(db);
  const now = seed(db);
  command(db, {
    id: uuidLike(760),
    actor: UUID.a,
    action: "list_item",
    key: "list:login-sanction-000000001",
    result: UUID.listing1,
    item: UUID.item1,
    price: 400,
    version: 0,
    expires: now + 60_000,
    now,
  });
  command(db, {
    id: uuidLike(761),
    actor: UUID.a,
    action: "place_exchange",
    key: "place:login-sanction-00000001",
    result: UUID.order1,
    side: "sell_gold",
    price: 10,
    gold: 10,
    now,
  });
  db.prepare(`INSERT INTO economy_sanctions
    (id,account_id,scope,reason,starts_at,created_by,created_at)
    VALUES(?,?,'login','account protection',?,'test',?)`)
    .run(uuidLike(762), UUID.a, now + 1, now + 1);

  assert.throws(() => command(db, {
    id: uuidLike(763),
    actor: UUID.a,
    action: "list_item",
    key: "list:login-sanction-000000002",
    result: UUID.listing2,
    item: UUID.item2,
    price: 300,
    version: 0,
    expires: now + 60_000,
    now: now + 2,
  }), /account_sanctioned/);
  assert.throws(() => command(db, {
    id: uuidLike(764),
    actor: UUID.b,
    action: "buy_listing",
    key: "buy:login-sanction-0000000001",
    result: uuidLike(864),
    listing: UUID.listing1,
    price: 400,
    version: 0,
    now: now + 2,
  }), /seller_sanctioned/);
  assert.throws(() => command(db, {
    id: uuidLike(765),
    actor: UUID.b,
    action: "fill_exchange",
    key: "fill:login-sanction-000000001",
    result: uuidLike(865),
    order: UUID.order1,
    price: 10,
    gold: 1,
    version: 0,
    now: now + 2,
  }), /maker_sanctioned/);

  const publicListingCount = db.prepare(`SELECT COUNT(*) AS count
    FROM economy_listings l
    JOIN economy_items i ON i.id=l.item_id
    JOIN economy_accounts a ON a.id=l.seller_account_id
    JOIN economy_wallets w ON w.account_id=l.seller_account_id
    WHERE l.status='open' AND l.expires_at>? AND i.state='escrow' AND i.tradeable=1
      AND a.status='active' AND a.trade_eligible=1 AND a.steam_ownership_verified=1 AND a.wallet_frozen=0
      AND NOT EXISTS(SELECT 1 FROM economy_sanctions s
        WHERE s.account_id=l.seller_account_id AND s.revoked_at IS NULL AND s.starts_at<=?
          AND (s.expires_at IS NULL OR s.expires_at>?) AND s.scope IN ('login','market','wallet'))`)
    .get(now + 2, now + 2, now + 2).count;
  assert.equal(publicListingCount, 0);

  command(db, {
    id: uuidLike(766),
    actor: UUID.a,
    action: "cancel_listing",
    key: "cancel:login-sanction-0000001",
    result: uuidLike(866),
    listing: UUID.listing1,
    version: 0,
    now: now + 3,
  });
  command(db, {
    id: uuidLike(767),
    actor: UUID.a,
    action: "cancel_exchange",
    key: "cancel:login-sanction-0000002",
    result: uuidLike(867),
    order: UUID.order1,
    version: 0,
    now: now + 3,
  });
  assert.equal(db.prepare(`SELECT status FROM economy_listings WHERE id=?`).get(UUID.listing1).status, "cancelled");
  assert.equal(db.prepare(`SELECT status FROM economy_exchange_orders WHERE id=?`).get(UUID.order1).status, "cancelled");
  assert.equal(db.prepare(`SELECT state FROM economy_items WHERE id=?`).get(UUID.item1).state, "inventory");
  assert.equal(db.prepare(`SELECT gold_reserved FROM economy_wallets WHERE account_id=?`).get(UUID.a).gold_reserved, 0);

  const [worker, triggers] = await Promise.all([
    source("worker/economy-d1.ts"),
    source("worker/economy-triggers.sql"),
  ]);
  assert.match(worker, /s\.scope IN \('login','market','wallet'\)/);
  assert.match(worker, /s\.scope IN \('login','exchange','wallet'\)/);
  assert.match(worker, /riskReducingCancellation = parsed\.action === "cancel_listing"[\s\S]{0,100}?parsed\.action === "cancel_exchange"/);
  assert.match(worker, /assertWriteAllowed\(request, db, env, auth, riskReducingCancellation\)/);
  assert.match(triggers, /economy_cancel_listing_before[\s\S]{0,300}?listing_not_owned_or_version/);
  assert.match(triggers, /economy_cancel_exchange_before[\s\S]{0,350}?exchange_order_not_owned_or_version/);
  assert.doesNotMatch(
    triggers.match(/CREATE TRIGGER IF NOT EXISTS economy_cancel_listing_before[\s\S]*?END;/)?.[0] ?? "",
    /economy_sanctions|wallet_frozen|steam_ownership_stale/,
  );
  db.close();
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

test("public exchange depth, best prices, and private orders stay independent beyond 60 rows per side", async () => {
  const db = database();
  await migrate(db);
  seed(db);
  const wallNow = Date.now();
  const maxAsh = 9_000_000_000_000;
  const frozenAccount = "00000000-0000-4000-8000-00000000000d";
  const sanctionedAccount = "00000000-0000-4000-8000-00000000000e";
  for (const [id, frozen] of [[frozenAccount, 1], [sanctionedAccount, 0]]) {
    db.prepare(`INSERT INTO economy_accounts
      (id,display_name,status,steam_ownership_verified,trade_eligible,wallet_frozen,auth_epoch,risk_score,created_at,updated_at)
      VALUES(?,?,'active',1,1,?,0,0,?,?)`)
      .run(id, id === frozenAccount ? "frozen" : "sanctioned", frozen, wallNow, wallNow);
    db.prepare(`INSERT INTO economy_wallets
      (account_id,ash_available,ash_reserved,gold_available,gold_reserved,gold_locked,version,updated_at)
      VALUES(?,0,0,0,0,0,0,?)`).run(id, wallNow);
  }
  db.prepare(`INSERT INTO economy_sanctions
    (id,account_id,scope,reason,starts_at,created_by,created_at)
    VALUES(?,?,'login','public filter',?,'test',?)`)
    .run(uuidLike(870), sanctionedAccount, wallNow - 1, wallNow - 1);

  // This maker can receive exactly three more gold at the best ask. The
  // private order must keep its original remaining quantity of ten.
  db.prepare(`UPDATE economy_wallets SET ash_available=?,ash_reserved=50 WHERE account_id=?`)
    .run(maxAsh - 350, UUID.a);
  const insertOrder = (id, accountId, side, price, createdAt) => {
    db.prepare(`INSERT INTO economy_exchange_orders
      (id,account_id,side,price_ash_per_gold,gold_initial,gold_remaining,
        ash_reserved_remaining,gold_reserved_remaining,status,version,created_at,updated_at)
      VALUES(?,?,?,?,10,10,?,?,'open',0,?,?)`)
      .run(
        id,
        accountId,
        side,
        price,
        side === "buy_gold" ? 10 * price : 0,
        side === "sell_gold" ? 10 : 0,
        createdAt,
        createdAt,
      );
  };
  insertOrder("mine-partial-public-headroom", UUID.a, "sell_gold", 100, wallNow);
  for (let index = 0; index < 65; index += 1) {
    insertOrder(`buy-${String(index).padStart(3, "0")}`, UUID.b, "buy_gold", 1_000 - index, wallNow + index);
    insertOrder(`sell-${String(index).padStart(3, "0")}`, UUID.c, "sell_gold", 200 + index, wallNow + index);
  }
  insertOrder("frozen-best-bid", frozenAccount, "buy_gold", 10_000, wallNow - 2);
  insertOrder("sanctioned-best-ask", sanctionedAccount, "sell_gold", 1, wallNow - 2);

  const worker = await source("worker/economy-d1.ts");
  const sideTemplate = preparedSqlTemplate(worker, "queryExchangeOrdersForSide");
  const levelTemplate = preparedSqlTemplate(worker, "queryOrderBookLevels");
  const publicBuy = db.prepare(renderSqlTemplate(sideTemplate, { priceDirection: "DESC" }))
    .all("buy_gold", wallNow, wallNow, 60);
  const publicSell = db.prepare(renderSqlTemplate(sideTemplate, { priceDirection: "ASC" }))
    .all("sell_gold", wallNow, wallNow, 60);
  const myOrders = db.prepare(`SELECT * FROM economy_exchange_orders
    WHERE account_id=? AND status IN ('open','partially_filled')
    ORDER BY created_at DESC,id DESC LIMIT ?`)
    .all(UUID.a, 100);
  assert.equal(publicBuy.length, 60);
  assert.equal(publicSell.length, 60, "60+ bids must never consume the ask-side limit");
  assert.equal(publicBuy[0].price_ash_per_gold, 1_000);
  assert.equal(publicSell[0].price_ash_per_gold, 100);
  assert.equal(publicSell[0].public_gold_remaining, 3);
  assert.equal(publicBuy.some((row) => row.id === "frozen-best-bid"), false);
  assert.equal(publicSell.some((row) => row.id === "sanctioned-best-ask"), false);
  assert.equal(myOrders.length, 1);
  assert.equal(myOrders[0].id, "mine-partial-public-headroom");
  assert.equal(myOrders[0].gold_remaining, 10, "private orders retain their authoritative raw remainder");

  const bidLevels = db.prepare(renderSqlTemplate(levelTemplate, { priceDirection: "DESC" }))
    .all("buy_gold", wallNow, wallNow, 20);
  const askLevels = db.prepare(renderSqlTemplate(levelTemplate, { priceDirection: "ASC" }))
    .all("sell_gold", wallNow, wallNow, 20);
  assert.equal(bidLevels[0].price_ash_per_gold, 1_000);
  assert.equal(askLevels[0].price_ash_per_gold, 100);
  assert.equal(askLevels[0].gold_amount, 3);

  const legacyMixedLimit = db.prepare(`SELECT * FROM economy_exchange_orders
    WHERE status IN ('open','partially_filled')
    ORDER BY CASE WHEN side='buy_gold' THEN price_ash_per_gold END DESC,
      CASE WHEN side='sell_gold' THEN price_ash_per_gold END ASC,created_at ASC LIMIT 60`).all();
  assert.equal(legacyMixedLimit.filter((row) => row.side === "sell_gold").length, 0,
    "the regression fixture must reproduce the previous missing-ask bug");

  assert.doesNotMatch(worker, /ORDER BY CASE WHEN side='buy_gold'/);
  assert.match(worker, /queryExchangeOrdersForSide\(db, "buy_gold", PUBLIC_EXCHANGE_SIDE_LIMIT\)/);
  assert.match(worker, /queryExchangeOrdersForSide\(db, "sell_gold", PUBLIC_EXCHANGE_SIDE_LIMIT\)/);
  assert.match(worker, /WHERE account_id=\? AND status IN \('open','partially_filled'\)/);
  assert.match(worker, /queryOrderBookLevels\(db, "buy_gold"\)/);
  assert.match(worker, /queryOrderBookLevels\(db, "sell_gold"\)/);
  assert.match(sideTemplate, /JOIN economy_accounts a ON a\.id=o\.account_id/);
  assert.match(sideTemplate, /JOIN economy_wallets w ON w\.account_id=o\.account_id/);
  assert.match(sideTemplate, /a\.wallet_frozen=0/);
  assert.match(sideTemplate, /s\.scope IN \('login','exchange','wallet'\)/);
  assert.match(sideTemplate, /w\.ash_available-w\.ash_reserved/);
  assert.match(sideTemplate, /AS public_gold_remaining/);
  assert.match(worker, /remainingGold: Number\(row\.public_gold_remaining \?\? row\.gold_remaining\)/);
  assert.match(worker, /query\.side === "sell_gold"[\s\S]{0,220}?queryExchangeOrdersForSide\(db, "buy_gold", query\.limit\)/);
  assert.match(worker, /query\.side === "buy_gold"[\s\S]{0,220}?queryExchangeOrdersForSide\(db, "sell_gold", query\.limit\)/);
  db.close();
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

test("effective live, admin, and payment gates cannot be opened by remote config alone", async () => {
  const worker = await source("worker/economy-d1.ts");
  const liveGate = functionSource(worker, "economyLiveEnabled");
  const writeGate = functionSource(worker, "assertWriteAllowed");
  const paymentGate = functionSource(worker, "steamPaymentsEnabled");
  const paymentAssertion = functionSource(worker, "assertSteamPaymentsEnabled");
  const adminGate = functionSource(worker, "adminSanctions");
  const healthGate = functionSource(worker, "health");

  assert.match(worker, /const REMOTE_ADMIN_CONTROL_PLANE_READY = false/);
  assert.match(liveGate, /env\.ECONOMY_LIVE_ENABLED === "true" && REMOTE_ADMIN_CONTROL_PLANE_READY/);
  assert.match(writeGate, /if \(!economyLiveEnabled\(env\)\)/);
  assert.match(writeGate, /"MARKET_CONTROL_PLANE_NOT_READY"/);
  assert.match(worker, /const live = economyLiveEnabled\(env\) && !inventoryAuditRequired/);
  assert.match(healthGate, /liveEnabled: economyLiveEnabled\(env\)/);
  assert.match(healthGate, /remoteAdminControlPlaneReady: REMOTE_ADMIN_CONTROL_PLANE_READY/);

  assert.match(adminGate, /if \(!isLocalHost\(new URL\(request\.url\)\)\)/);
  assert.match(adminGate, /"ADMIN_CONTROL_PLANE_LOCKED"/);
  assert.ok(
    adminGate.indexOf("ADMIN_CONTROL_PLANE_LOCKED") < adminGate.indexOf("ECONOMY_ADMIN_KEY"),
    "remote admin must fail closed before a bearer key is considered",
  );

  assert.match(paymentGate, /STEAM_MICROTXN_SANDBOX === "true"[\s\S]{0,100}?isLocalHost\(new URL\(request\.url\)\)/);
  assert.match(paymentGate, /ECONOMY_PAYMENTS_ENABLED === "true" && \(localSandbox \|\| productionReady\)/);
  assert.match(paymentAssertion, /STEAM_MICROTXN_SANDBOX === "true" && !isLocalHost\(new URL\(request\.url\)\)/);
  assert.match(paymentAssertion, /"PAYMENT_SANDBOX_HOST_LOCKED"/);
  assert.ok(
    paymentAssertion.indexOf("PAYMENT_SANDBOX_HOST_LOCKED") <
      paymentAssertion.indexOf("PAYMENT_RECONCILIATION_NOT_READY"),
    "a remote sandbox request must be rejected by host before reconciliation checks",
  );
});

test("worker gates live writes, atomically imports one canonical character item, and exposes no arbitrary save upload", async () => {
  const [worker, entry, client] = await Promise.all([
    source("worker/economy-d1.ts"),
    source("worker/index.ts"),
    source("app/economy-client.ts"),
  ]);
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
  assert.match(client, /power:\s*"power_desc"/);
  assert.match(
    worker,
    /power_desc:\s*`CAST\(COALESCE\(json_extract\(i\.item_json, '\$\.powerScore'\), 0\) AS REAL\) DESC,[\s\S]{0,120}?i\.item_level DESC,l\.created_at DESC,l\.id DESC`/,
  );
  assert.match(worker, /\? await marketResponse\(request, db, auth\)/);
  assert.match(worker, /\? await executeCommand\(request, db, env, auth\)/);
  assert.doesNotMatch(worker, /route\.endsWith/);
  assert.match(worker, /sellerUserId: mine \? accountId : ""/);
  assert.match(worker, /normalizeGearItem\(command\.characterItem\)/);
  assert.match(worker, /parsed\.action === "list_item" && "characterItem" in parsed && !auth\.development/);
  assert.match(worker, /"SECURE_INVENTORY_REQUIRED"/);
  assert.match(client, /command\.action === "list_item"[\s\S]{0,120}?"characterItem" in command[\s\S]{0,120}?!isLocalEconomySandbox\(\)/);
  assert.match(client, /"SECURE_INVENTORY_REQUIRED"/);
  assert.match(worker, /return `character:\$\{accountId\}:\$\{item\.id\}`/);
  assert.match(worker, /"CHARACTER_ITEM_MISMATCH"/);
  assert.match(worker, /importedCharacterItemIds/);
  assert.match(worker, /WHERE provenance='server_drop' AND substr\(origin_id,1,\?\)=\?/);
  const characterBatch = worker.indexOf("if (characterCommand && canonicalCharacter && characterOrigin && !existingCharacterRow)");
  const liveCharacterGuard = worker.indexOf('parsed.action === "list_item" && "characterItem" in parsed && !auth.development');
  const replayLookup = worker.indexOf("SELECT id,request_hash,action,result_ref_id FROM economy_commands", liveCharacterGuard);
  const characterItemInsert = worker.indexOf("INSERT INTO economy_items", characterBatch);
  const characterCommandInsert = worker.indexOf("commandInsert", characterItemInsert);
  const characterBatchEnd = worker.indexOf("]);", characterCommandInsert);
  assert.ok(
    characterBatch >= 0 &&
      characterItemInsert > characterBatch &&
      characterCommandInsert > characterItemInsert &&
      characterBatchEnd > characterCommandInsert,
    "character item and list command must commit in the same D1 batch",
  );
  assert.ok(
    liveCharacterGuard >= 0 && replayLookup > liveCharacterGuard && characterBatch > replayLookup,
    "live browser-authored items must be rejected before replay or item import touches D1",
  );
  assert.match(worker, /assertNoActiveSanction\(db, auth\.account\.id, \["login", "payment", "wallet"\]\)/);
  assert.match(worker, /QueryTxn\/v3/);
  assert.match(worker, /steamTransactionDisposition\(transaction\.status\)/);
  assert.match(worker, /disposition === "finalize"/);
  assert.match(worker, /const paymentStillPending = transaction\.status === "Init"/);
  assert.match(worker, /STEAM_PAYMENT_NOT_APPROVED[\s\S]{0,360}?paymentStillPending,\s*\)/);
  assert.match(worker, /if \(terminalStatus\)[\s\S]{0,260}?UPDATE economy_payment_orders SET status=\?/);
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
  assert.doesNotMatch(worker, /localStorage|from ["']\.\.\/app\/save-slots|upload_save|import_inventory/i);
  assert.match(entry, /headers\.delete\("x-mujindo-player-name"\)/);
  assert.match(entry, /headers\.delete\("x-mujindo-dev-user"\)/);
  assert.match(entry, /headers\.delete\("x-mujindo-internal-dev-user"\)/);
  assert.match(entry, /headers\.delete\("x-mujindo-account-id"\)/);
  assert.doesNotMatch(entry, /headers\.get\("oai-authenticated-user/);
  assert.match(entry, /localSameOrigin/);
  assert.match(worker, /url\.hostname === "\[::1\]"/);
  assert.match(entry, /url\.hostname === "\[::1\]"/);
});
