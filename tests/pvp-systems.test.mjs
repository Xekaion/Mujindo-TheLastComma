import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import ts from "typescript";

const root = process.cwd();

async function readSource(relativePath) {
  return readFile(path.join(root, relativePath), "utf8");
}

async function importTypeScriptModule(relativePath) {
  const source = await readSource(relativePath);
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: relativePath,
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(output).toString("base64")}`);
}

test("PVP protocol normalizes input and strips client-authority fields", async () => {
  const protocol = await importTypeScriptModule("app/pvp-protocol.ts");
  assert.equal(protocol.PVP_ARENA_WIDTH, 1280);
  assert.equal(protocol.PVP_ARENA_HEIGHT, 720);
  assert.equal(protocol.PVP_ROUND_DURATION_MS, 90_000);
  assert.equal(protocol.PVP_SCORE_TO_WIN, 3);

  const parsed = protocol.parseRealtimeClientMessage({
    type: "pvp_input",
    sequence: 9,
    moveX: 10,
    moveY: 0,
    aimX: 4,
    aimY: 3,
    fire: true,
    dash: false,
    x: 0,
    y: 0,
    hp: 9_999,
    damage: 999_999,
    score: 99,
    victory: true,
  });
  assert.deepEqual(parsed, {
    type: "pvp_input",
    sequence: 9,
    moveX: 1,
    moveY: 0,
    aimX: 0.8,
    aimY: 0.6,
    fire: true,
    dash: false,
  });
  assert.equal(protocol.parseRealtimeClientMessage({ type: "pvp_input" }), null);
  assert.equal(
    protocol.parseRealtimeClientMessage({
      type: "pvp_input",
      sequence: 1,
      moveX: Number.POSITIVE_INFINITY,
      moveY: 0,
      aimX: 1,
      aimY: 0,
      fire: true,
      dash: false,
    }),
    null,
  );
});

test("world loot protocol admits only mythic and cosmic acquisitions", async () => {
  const protocol = await importTypeScriptModule("app/pvp-protocol.ts");
  const base = {
    type: "announce_loot",
    acquisitionId: "acquisition-proof-001",
    itemName: "  Astral Crown  ",
    itemLevel: 1_200,
    enhancement: 17,
  };
  for (const rarity of ["normal", "magic", "advanced", "rare", "heroic", "legendary"]) {
    assert.equal(protocol.parseRealtimeClientMessage({ ...base, rarity }), null);
  }
  for (const rarity of ["mythic", "cosmic"]) {
    assert.deepEqual(protocol.parseRealtimeClientMessage({ ...base, rarity }), {
      type: "announce_loot",
      acquisitionId: "acquisition-proof-001",
      itemName: "Astral Crown",
      rarity,
      itemLevel: 999,
      enhancement: 10,
    });
  }
});

test("Sites binds D1 and the worker delegates every realtime request to the D1 handler", async () => {
  const [hostingText, entry] = await Promise.all([
    readSource(".openai/hosting.json"),
    readSource("worker/index.ts"),
  ]);
  const hosting = JSON.parse(hostingText);

  assert.equal(hosting.d1, "DB");
  assert.match(entry, /import\s*\{\s*handleRealtimeRequest\s*\}\s*from\s*["']\.\/realtime-d1["']/);
  assert.match(entry, /DB\??:\s*D1Database/);
  assert.match(entry, /url\.pathname\.startsWith\(["']\/api\/realtime\/["']\)/);
  assert.match(entry, /return\s+handleRealtimeRequest\(realtimeRequest,\s*env\)/);
});

test("polling client creates an authenticated session, syncs, and coalesces only the latest input", async () => {
  const client = await readSource("app/realtime-client.ts");

  assert.match(client, /["']\/api\/realtime\/session["']/);
  assert.match(client, /["']\/api\/realtime\/sync["']/);
  assert.match(client, /Authorization\s*:\s*`Bearer\s+\$\{[^}]+\}`/);
  assert.match(
    client,
    /if\s*\(message\.type === "pvp_input"\)\s*\{\s*this\.latestPvpInput\s*=\s*message;?\s*\}\s*else\s*\{\s*this\.enqueueReliable\(message\)/,
  );
  assert.match(client, /const sentInput\s*=\s*this\.latestPvpInput/);
  assert.match(
    client,
    /this\.latestPvpInput\?\.sequence\s*===\s*sentInput\.sequence[\s\S]*this\.latestPvpInput\s*=\s*null/,
  );
  assert.match(client, /this\.pendingMessages/);
  assert.match(client, /FAST_POLL_MIN_GAP_MS\s*=\s*24/);
  assert.match(client, /FAST_POLL_JITTER_MS\s*=\s*36/);
  assert.match(
    client,
    /Date\.now\(\)\s*-\s*this\.lastSyncStartedAt[\s\S]*FAST_POLL_MS\s*-\s*elapsed/,
  );
});

test("D1 realtime handler exposes authenticated routes and compare-and-swap persistence", async () => {
  const server = await readSource("worker/realtime-d1.ts");

  for (const route of ["/session", "/sync", "/health"]) {
    assert.ok(server.includes(route), `missing D1 realtime route: ${route}`);
  }
  assert.match(server, /Authorization/i);
  assert.match(server, /request\.headers\.get\(["']authorization["']\)/i);
  assert.match(server, /\^Bearer\\s\+/i);
  assert.match(server, /parseRealtimeClientMessage/);
  assert.match(server, /CREATE TABLE IF NOT EXISTS realtime_world_state/i);
  assert.match(server, /UPDATE realtime_world_state[\s\S]*WHERE[\s\S]*version\s*=\s*\?/i);
  assert.match(server, /(?:meta\.)?changes/);
  assert.match(server, /CAS|compare-and-swap|cas/i);
});

test("D1 simulation remains fixed-step and server authoritative for movement, damage, and results", async () => {
  const server = await readSource("worker/realtime-d1.ts");

  assert.match(server, /(?:SIMULATION_STEP_MS|TICK_MS)\s*=\s*50/);
  assert.match(server, /PLAYER_SPEED\s*=\s*235/);
  assert.match(server, /PROJECTILE_DAMAGE\s*=\s*18/);
  assert.match(server, /player\.vx\s*=\s*player\.input\.moveX\s*\*\s*speed/);
  assert.match(server, /player\.x\s*\+=\s*player\.vx\s*\*\s*deltaSeconds/);
  assert.match(server, /target\.hp\s*=\s*Math\.max\(0,\s*target\.hp\s*-\s*projectile\.damage\)/);
  assert.match(server, /owner\.score\s*\+=\s*1/);
  assert.match(server, /owner\.score\s*>=\s*PVP_SCORE_TO_WIN/);
  assert.match(server, /finishMatch\([^)]*["']score["']/);
  assert.match(server, /["']timeout["']/);
  assert.match(server, /["']draw["']/);
  assert.match(server, /input\.sequence\s*<=\s*player\.lastInputSequence/);
  assert.match(server, /MAX_SIMULATION_DEBT_MS\s*=\s*2_000/);
  assert.match(server, /MAX_STEPS_PER_REQUEST\s*=\s*20/);
  assert.match(server, /if\s*\(match\)\s*advanceMatch\(state,\s*match,\s*now\)/);
  assert.doesNotMatch(server, /function\s+advanceMatches\s*\(/);
  assert.match(
    server,
    /async function health\(db:\s*D1Database\)[\s\S]*readWorldState\(db\)/,
  );
});

test("world announcement fires only after the item is actually stored", async () => {
  const game = await readSource("app/GameCanvas.tsx");
  const bagFullIndex = game.indexOf("player.inventory.length >= inventoryCapacityRef.current");
  const pickupIndex = game.indexOf("player.inventory.push(cloneGearItem(drop.item));");
  const announcementIndex = game.indexOf("getRealtimeClient().announceLoot", pickupIndex);

  assert.ok(bagFullIndex >= 0 && bagFullIndex < pickupIndex);
  assert.ok(pickupIndex >= 0 && announcementIndex > pickupIndex);
  assert.match(
    game.slice(pickupIndex, announcementIndex + 150),
    /drop\.item\.rarity === "mythic"[\s\S]*drop\.item\.rarity === "cosmic"/,
  );
});
