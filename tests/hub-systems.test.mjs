import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import ts from "typescript";
import { DatabaseSync } from "node:sqlite";

const root = process.cwd();

async function readSource(relativePath) {
  return readFile(path.join(root, relativePath), "utf8");
}

function transpile(source, fileName) {
  return ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
    fileName,
  }).outputText;
}

const dataModule = (source) =>
  `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;

async function importPlazaModules() {
  const plazaSource = await readSource("app/plaza-world.ts");
  const plazaUrl = dataModule(transpile(plazaSource, "app/plaza-world.ts"));
  const equipmentUrl = dataModule(
    transpile(await readSource("app/equipment.ts"), "app/equipment.ts"),
  );
  const protocolSource = transpile(
    await readSource("app/hub-protocol.ts"),
    "app/hub-protocol.ts",
  )
    .replace(/from\s+["']\.\/plaza-world["']/, `from ${JSON.stringify(plazaUrl)}`)
    .replace(/from\s+["']\.\/equipment["']/, `from ${JSON.stringify(equipmentUrl)}`);
  return {
    plaza: await import(plazaUrl),
    equipment: await import(equipmentUrl),
    protocol: await import(dataModule(protocolSource)),
  };
}

async function importHubServer() {
  const plazaSource = await readSource("app/plaza-world.ts");
  const plazaUrl = dataModule(transpile(plazaSource, "app/plaza-world.ts"));
  const equipmentUrl = dataModule(
    transpile(await readSource("app/equipment.ts"), "app/equipment.ts"),
  );
  const protocolSource = transpile(
    await readSource("app/hub-protocol.ts"),
    "app/hub-protocol.ts",
  )
    .replace(/from\s+["']\.\/plaza-world["']/, `from ${JSON.stringify(plazaUrl)}`)
    .replace(/from\s+["']\.\/equipment["']/, `from ${JSON.stringify(equipmentUrl)}`);
  const protocolUrl = dataModule(protocolSource);
  const serverSource = transpile(
    await readSource("worker/hub-d1.ts"),
    "worker/hub-d1.ts",
  )
    .replace(/from\s+["']\.\.\/app\/hub-protocol["']/, `from ${JSON.stringify(protocolUrl)}`)
    .replace(/from\s+["']\.\.\/app\/plaza-world["']/, `from ${JSON.stringify(plazaUrl)}`);
  return import(dataModule(serverSource));
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
    this.database = new DatabaseSync(":memory:");
    this.database.exec("PRAGMA foreign_keys = ON");
  }
  prepare(sql) {
    return new D1StatementAdapter(this.database, sql);
  }
  batch(statements) {
    return Promise.resolve(statements.map((statement) => statement.run()));
  }
  close() {
    this.database.close();
  }
}

test("hub and plaza share one 2400x1350 geometry and cardinal portal source", async () => {
  const { plaza, protocol } = await importPlazaModules();
  assert.equal(plaza.PLAZA_WORLD_WIDTH, 2400);
  assert.equal(plaza.PLAZA_WORLD_HEIGHT, 1350);
  assert.equal(protocol.HUB_MAP_WIDTH, plaza.PLAZA_WORLD_WIDTH);
  assert.equal(protocol.HUB_MAP_HEIGHT, plaza.PLAZA_WORLD_HEIGHT);
  assert.equal(protocol.HUB_PLAYER_RADIUS, plaza.PLAZA_PLAYER_RADIUS);
  assert.strictEqual(protocol.HUB_PORTALS, plaza.PLAZA_PORTALS);
  assert.deepEqual(
    plaza.PLAZA_PORTALS.map(({ id, x, y }) => [id, x, y]),
    [
      ["expedition", 1200, 160],
      ["duel", 250, 675],
      ["exchange", 2150, 675],
      ["caravan", 1200, 1190],
    ],
  );
  assert.equal(
    plaza.PLAZA_OBSTACLES.some(
      (entry) => entry.kind === "circle" && entry.x === 1200 && entry.y === 675,
    ),
    false,
    "the shared center must remain open for a large concurrent crowd",
  );
});

test("hub protocol strips coordinate authority and allowlists every visual field", async () => {
  const { protocol } = await importPlazaModules();
  assert.equal(protocol.parseHubSessionRequest({ characterSlot: 0 }), null);
  assert.equal(protocol.parseHubSessionRequest({ characterSlot: 4 }), null);
  const session = protocol.parseHubSessionRequest({
    characterSlot: 2,
    displayName: "  기억   순례자  ",
    level: 50_000,
    dungeonFloor: 50_000_000,
    arrival: "duel",
    accountId: "client-forgery",
    appearance: {
      spriteKey: "https://attacker.invalid/avatar.png",
      palette: "javascript:alert(1)",
      gear: { weapon: 99, helm: -3, armor: 4, css: "position:fixed" },
      spriteUrl: "https://attacker.invalid/pixel.gif",
    },
  });
  assert.equal(session.characterSlot, 2);
  assert.equal(session.displayName, "기억 순례자");
  assert.equal(session.level, protocol.HUB_MAX_LEVEL);
  assert.equal(session.dungeonFloor, protocol.HUB_MAX_DUNGEON_FLOOR);
  assert.equal(session.arrival, "duel");
  assert.equal(session.appearance.spriteKey, "harin");
  assert.equal(session.appearance.palette, "scarlet");
  assert.equal(session.appearance.gear.weapon, 9);
  assert.equal(session.appearance.gear.helm, 0);
  assert.equal(session.appearance.gear.armor, 4);
  assert.equal("spriteUrl" in session.appearance, false);
  assert.equal("css" in session.appearance.gear, false);
  assert.equal("accountId" in session, false);
  assert.equal(
    protocol.parseHubSessionRequest({ characterSlot: 1 }).dungeonFloor,
    protocol.HUB_MIN_DUNGEON_FLOOR,
  );
  assert.equal(
    protocol.parseHubAppearanceRequest({ dungeonFloor: -10 }).dungeonFloor,
    protocol.HUB_MIN_DUNGEON_FLOOR,
  );
  assert.equal(
    protocol.parseHubAppearanceRequest({}).dungeonFloor,
    null,
    "an old appearance-only client must not reset a newer floor claim",
  );

  const intent = protocol.parseHubMoveIntent({
    sequence: 11,
    moveX: 30,
    moveY: 40,
    facing: 4,
    x: 2_399,
    y: 1,
    speed: 99_999,
    teleport: true,
    dungeonFloor: 888_888,
  });
  assert.deepEqual(intent, {
    sequence: 11,
    moveX: 0.6,
    moveY: 0.8,
    facing: 7,
  });
  for (const forbidden of ["x", "y", "speed", "teleport", "dungeonFloor"]) {
    assert.equal(forbidden in intent, false);
  }
});

test("public plaza equipment is canonical, ten-slot, and strips private gear fields", async () => {
  const { equipment, protocol } = await importPlazaModules();
  const weapon = equipment.rollGear("hub-public-weapon", {
    slot: "weapon",
    rarity: "legendary",
    level: 72,
  });
  weapon.enhancement = 5;
  const loadout = equipment.createEmptyEquipment();
  loadout.weapon = weapon;
  const publicEquipment = protocol.hubPublicEquipmentFromLoadout(loadout);
  assert.deepEqual(Object.keys(publicEquipment).sort(), [...equipment.EQUIPMENT_SLOTS].sort());
  assert.deepEqual(Object.keys(publicEquipment.weapon).sort(), [
    "affixes", "baseName", "enhancement", "level", "rarity", "slot",
  ]);
  assert.equal("id" in publicEquipment.weapon, false);
  assert.equal("powerScore" in publicEquipment.weapon, false);
  assert.equal("displayName" in publicEquipment.weapon, false);
  assert.equal("label" in publicEquipment.weapon.affixes[0], false);

  const forged = structuredClone(publicEquipment);
  forged.weapon.id = "leaked-private-id";
  forged.weapon.affixes[0].label = "attacker copy";
  forged.weapon.css = "position:fixed";
  const normalized = protocol.normalizeHubPublicEquipment(forged);
  assert.equal("id" in normalized.weapon, false);
  assert.equal("css" in normalized.weapon, false);
  assert.equal("label" in normalized.weapon.affixes[0], false);
  assert.equal(protocol.hubPublicEquipmentToLoadout(normalized).weapon.enhancement, 5);

  forged.weapon.baseName = "not-a-real-weapon";
  assert.equal(protocol.normalizeHubPublicEquipment(forged).weapon, null);
  const legacy = protocol.normalizeHubStoredAppearanceEnvelope({
    spriteKey: "harin-equipped",
    gear: { weapon: 4 },
  });
  assert.equal(legacy.appearance.gear.weapon, 4);
  assert.equal(legacy.publicEquipment.weapon, null);
});

test("hub worker is token-bound, rate-limited, CAS protected, and prunes stale sessions", async () => {
  const [entry, economy, server, client] = await Promise.all([
    readSource("worker/index.ts"),
    readSource("worker/economy-d1.ts"),
    readSource("worker/hub-d1.ts"),
    readSource("app/hub-client.ts"),
  ]);
  for (const route of ["session", "sync", "heartbeat", "appearance", "profile", "leave", "health"]) {
    assert.ok(server.includes(`/api/hub/${route}`), `missing hub route ${route}`);
  }
  assert.match(entry, /headers\.delete\("x-mujindo-hub-auth-mode"\)/);
  assert.match(entry, /await authorizeHubEconomyRequest\(sanitizedRequest, env\)/);
  assert.match(entry, /headers\.set\("x-mujindo-hub-auth-mode", "guest"\)/);
  assert.match(economy, /PVP_ACCOUNT_AUTH_ENABLED === "true"/);
  assert.match(economy, /\["login", "multiplayer", "pvp"\]/);
  assert.match(server, /sha256\(bearerToken\(request\)\)/);
  assert.match(server, /token_hash TEXT NOT NULL UNIQUE/);
  assert.match(server, /account_id TEXT NOT NULL UNIQUE/);
  assert.match(server, /last_sequence<\?/);
  assert.match(server, /version=version\+1/);
  assert.match(server, /AND version=\? AND last_sequence<\?/);
  assert.match(server, /resolvePlazaMovement\(/);
  assert.match(server, /MAX_MOVE_STEP_MS\s*=\s*250/);
  assert.match(server, /hub_rate_limits/);
  assert.match(server, /DELETE FROM hub_sessions WHERE expires_at<=\? OR last_seen_at<\?/);
  assert.match(server, /account_id LIKE 'guest:%'/);
  assert.match(server, /`guest:\$\{crypto\.randomUUID\(\)\}`/);
  assert.match(server, /SET moving=0,last_seen_at=/);
  assert.match(server, /MAX_NEARBY_PLAYERS\s*=\s*48/);
  assert.doesNotMatch(server, /row\.account_id[^\n]*playerId|account_id:\s*row\.account_id/);
  assert.match(client, /sendsClientPosition:\s*false/);
  assert.match(client, /persistsBearerToken:\s*false/);
  assert.match(client, /inspectCharacterProfile\(characterId: string\): Promise<HubCharacterProfile>/);
  assert.match(client, /profileController: AbortController \| null = null/);
  assert.match(client, /class HubRequestError extends Error/);
  assert.match(client, /if \(!retryable\) \{[\s\S]{0,100}?this\.setState\("offline"\)/);
  assert.match(client, /characterSlot:\s*this\.config\.characterSlot/);
  assert.match(client, /dungeonFloor:\s*this\.config\.dungeonFloor/);
  assert.match(client, /\{ sequence: \+\+this\.sequence, \.\.\.this\.intent \}/);
});

test("guest A/B sessions share snapshots while forged coordinates never reach storage", async () => {
  const [{ handleHubRequest }, { equipment, protocol }] = await Promise.all([
    importHubServer(),
    importPlazaModules(),
  ]);
  const db = new D1DatabaseAdapter();
  const env = { DB: db };
  const makeRequest = (route, body, token, method = "POST") =>
    new Request(`https://game.local/api/hub/${route}`, {
      method,
      headers: {
        origin: "https://game.local",
        "content-type": "application/json",
        "x-mujindo-hub-auth-mode": "guest",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });
  const publicLoadout = equipment.createEmptyEquipment();
  publicLoadout.weapon = equipment.rollGear("profile-visible-weapon", {
    slot: "weapon",
    rarity: "legendary",
    level: 72,
  });
  const publicEquipment = protocol.hubPublicEquipmentFromLoadout(publicLoadout);

  const responseA = await handleHubRequest(
    makeRequest("session", {
      characterSlot: 1,
      displayName: "A",
      level: 20,
      dungeonFloor: 17,
      appearance: { spriteKey: "harin" },
      publicEquipment,
    }),
    env,
  );
  assert.equal(responseA.status, 201);
  const sessionA = await responseA.json();
  assert.match(sessionA.token, /^[a-f0-9]{64}$/);
  assert.equal(sessionA.self.characterSlot, 1);
  assert.equal(sessionA.self.dungeonFloor, 17);
  assert.equal("accountId" in sessionA.self, false);
  assert.equal("publicEquipment" in sessionA.self, false);

  const responseB = await handleHubRequest(
    makeRequest("session", {
      characterSlot: 3,
      displayName: "B",
      level: 33,
      appearance: { spriteKey: "harin-equipped" },
    }),
    env,
  );
  assert.equal(responseB.status, 201);
  const sessionB = await responseB.json();
  assert.equal(sessionB.self.dungeonFloor, 1, "missing legacy claims default to floor one");
  assert.equal(sessionB.nearbyPlayers.some((player) => player.displayName === "A"), true);
  assert.equal(
    sessionB.nearbyPlayers.find((player) => player.displayName === "A").dungeonFloor,
    17,
  );
  assert.equal(
    "publicEquipment" in sessionB.nearbyPlayers.find((player) => player.displayName === "A"),
    false,
    "exact gear must stay out of high-frequency presence snapshots",
  );

  const profileResponse = await handleHubRequest(
    makeRequest(
      "profile",
      { characterId: sessionA.self.characterId },
      sessionB.token,
    ),
    env,
  );
  assert.equal(profileResponse.status, 200);
  const profile = await profileResponse.json();
  assert.deepEqual(Object.keys(profile).sort(), [
    "characterId", "displayName", "dungeonFloor", "level", "publicEquipment", "updatedAt",
  ]);
  assert.equal(profile.characterId, sessionA.self.characterId);
  assert.equal(profile.dungeonFloor, 17);
  assert.equal(Object.keys(profile.publicEquipment).length, 10);
  assert.equal(profile.publicEquipment.weapon.rarity, "legendary");
  assert.equal("id" in profile.publicEquipment.weapon, false);
  assert.equal("accountId" in profile, false);
  assert.equal("x" in profile, false);

  const invalidProfile = await handleHubRequest(
    makeRequest("profile", { characterId: "not-a-uuid" }, sessionB.token),
    env,
  );
  assert.equal(invalidProfile.status, 400);

  const legacyAppearancePatch = await handleHubRequest(
    makeRequest(
      "appearance",
      { appearance: { spriteKey: "harin-equipped" }, level: 21, dungeonFloor: 18 },
      sessionA.token,
      "PATCH",
    ),
    env,
  );
  assert.equal(legacyAppearancePatch.status, 200);
  const preservedProfileResponse = await handleHubRequest(
    makeRequest("profile", { characterId: sessionA.self.characterId }, sessionB.token),
    env,
  );
  assert.equal(preservedProfileResponse.status, 200);
  assert.equal(
    (await preservedProfileResponse.json()).publicEquipment.weapon.rarity,
    "legendary",
    "a rolling-upgrade appearance PATCH must preserve stored public equipment",
  );

  const beforeX = sessionA.self.x;
  const movedResponse = await handleHubRequest(
    makeRequest(
      "sync",
      { sequence: 1, moveX: 1, moveY: 0, facing: 6, x: 2_399, y: 1, speed: 999_999 },
      sessionA.token,
    ),
    env,
  );
  assert.equal(movedResponse.status, 200);
  const moved = await movedResponse.json();
  assert.ok(moved.self.x >= beforeX);
  assert.ok(moved.self.x - beforeX <= 62.5, "one request cannot exceed the 250ms movement budget");
  assert.notEqual(moved.self.x, 2_399);
  assert.notEqual(moved.self.y, 1);

  const staleResponse = await handleHubRequest(
    makeRequest("sync", { sequence: 1, moveX: -1, moveY: 0, facing: 2 }, sessionA.token),
    env,
  );
  assert.equal(staleResponse.status, 200);
  const stale = await staleResponse.json();
  assert.equal(stale.self.x, moved.self.x, "replayed sequence must not move the player twice");
  db.close();
});

test("hub schema cache self-heals when local D1 state is recreated", async () => {
  const { handleHubRequest } = await importHubServer();
  const db = new D1DatabaseAdapter();
  const env = { DB: db };
  const healthRequest = () =>
    new Request("https://game.local/api/hub/health", { method: "GET" });

  const initialized = await handleHubRequest(healthRequest(), env);
  assert.equal(initialized.status, 200);

  db.database.exec("DROP TABLE hub_rate_limits");
  const sessionResponse = await handleHubRequest(
    new Request("https://game.local/api/hub/session", {
      method: "POST",
      headers: {
        origin: "https://game.local",
        "content-type": "application/json",
        "x-mujindo-hub-auth-mode": "guest",
      },
      body: JSON.stringify({
        characterSlot: 2,
        displayName: "Recovery",
        level: 70,
        appearance: { spriteKey: "harin" },
      }),
    }),
    env,
  );
  assert.equal(sessionResponse.status, 201, "a consumed request body must replay safely");
  assert.ok(
    db.database
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='hub_rate_limits'")
      .get(),
  );

  db.database.exec("DROP TABLE hub_sessions");
  const recoveredHealth = await handleHubRequest(healthRequest(), env);
  assert.equal(recoveredHealth.status, 200);
  assert.ok(
    db.database
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='hub_sessions'")
      .get(),
  );
  db.close();
});

test("runtime schema setup adds floor-one claims to pre-floor D1 tables", async () => {
  const [{ handleHubRequest }, legacyMigration] = await Promise.all([
    importHubServer(),
    readSource("drizzle/0003_sparkling_smasher.sql"),
  ]);
  const db = new D1DatabaseAdapter();
  for (const statement of legacyMigration.split("--> statement-breakpoint")) {
    if (statement.trim()) db.database.exec(statement);
  }
  const now = Date.now();
  db.database.prepare(`INSERT INTO hub_character_slots
    (account_id,slot,public_character_id,level,appearance_json,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?)`).run("legacy", 1, "legacy-character", 44, "{}", now, now);

  const response = await handleHubRequest(
    new Request("https://game.local/api/hub/health", { method: "GET" }),
    { DB: db },
  );
  assert.equal(response.status, 200);
  assert.equal(
    db.database.prepare("SELECT dungeon_floor FROM hub_character_slots WHERE account_id='legacy'")
      .get().dungeon_floor,
    1,
  );
  assert.ok(
    db.database.prepare("PRAGMA table_info(hub_sessions)").all()
      .some((column) => column.name === "dungeon_floor"),
  );
  db.close();
});

test("hub migration enforces selected-slot ownership and one live session per identity", async () => {
  const [migration, floorMigration] = await Promise.all([
    readSource("drizzle/0003_sparkling_smasher.sql"),
    readSource("drizzle/0004_superb_the_anarchist.sql"),
  ]);
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  for (const statement of migration.split("--> statement-breakpoint")) {
    if (statement.trim()) db.exec(statement);
  }
  const now = Date.now();
  db.prepare(`INSERT INTO hub_character_slots
    (account_id,slot,public_character_id,level,appearance_json,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?)`).run("guest-a", 1, "character-a", 20, "{}", now, now);
  assert.throws(() =>
    db.prepare(`INSERT INTO hub_character_slots
      (account_id,slot,public_character_id,level,appearance_json,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?)`).run("guest-a", 4, "bad-slot", 20, "{}", now, now),
  );
  const insertSession = db.prepare(`INSERT INTO hub_sessions
    (id,token_hash,account_id,character_slot,public_character_id,display_name,level,
     appearance_json,zone,x,y,facing,moving,last_sequence,last_move_at,last_seen_at,
     expires_at,version,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  insertSession.run(
    "player-a", "a".repeat(64), "guest-a", 1, "character-a", "A", 20,
    "{}", "memory-plaza-v1", 1200, 1000, 4, 0, 0, now, now, now + 10_000, 0, now, now,
  );
  assert.throws(() =>
    insertSession.run(
      "player-a-duplicate", "b".repeat(64), "guest-a", 1, "character-a", "A2", 20,
      "{}", "memory-plaza-v1", 1200, 1000, 4, 0, 0, now, now, now + 10_000, 0, now, now,
    ),
    /UNIQUE constraint failed: hub_sessions\.account_id/,
  );
  assert.throws(() =>
    insertSession.run(
      "player-b", "c".repeat(64), "guest-b", 1, "character-a", "B", 20,
      "{}", "memory-plaza-v1", 1200, 1000, 4, 0, 0, now, now, now + 10_000, 0, now, now,
    ),
    /FOREIGN KEY constraint failed/,
  );

  for (const statement of floorMigration.split("--> statement-breakpoint")) {
    if (statement.trim()) db.exec(statement);
  }
  assert.equal(
    db.prepare("SELECT dungeon_floor FROM hub_character_slots WHERE account_id=? AND slot=?")
      .get("guest-a", 1).dungeon_floor,
    1,
  );
  assert.equal(
    db.prepare("SELECT dungeon_floor FROM hub_sessions WHERE id=?")
      .get("player-a").dungeon_floor,
    1,
  );
  assert.throws(() =>
    db.prepare("UPDATE hub_sessions SET dungeon_floor=0 WHERE id=?").run("player-a"),
  );
  db.close();
});
