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

test("PVP build profiles clamp authored inputs and strip injected combat authority", async () => {
  const protocol = await importTypeScriptModule("app/pvp-protocol.ts");
  assert.equal(protocol.PVP_MAX_PROFILE_LEVEL, 999);
  assert.equal(protocol.PVP_MAX_EQUIPMENT_POWER, 10_000_000);
  assert.equal(protocol.PVP_MAX_TOTAL_AUGMENT_STACKS, 1_000);

  const injectedProfile = {
    level: 50_000.9,
    equipmentPower: 999_999_999,
    augmentStacks: 50_000.8,
    buildRating: 99_999_999,
    rawOffenseScale: 500,
    offenseScale: 500,
    projectileDamage: 999_999,
    maxHp: 1,
    vitalityMultiplier: 0,
    minimumHitsToKo: 1,
  };
  const sanitized = protocol.sanitizePvpBuildProfile(injectedProfile);
  assert.deepEqual(sanitized, {
    level: protocol.PVP_MAX_PROFILE_LEVEL,
    equipmentPower: protocol.PVP_MAX_EQUIPMENT_POWER,
    augmentStacks: protocol.PVP_MAX_TOTAL_AUGMENT_STACKS,
  });
  assert.deepEqual(Object.keys(sanitized), ["level", "equipmentPower", "augmentStacks"]);
  for (const forbidden of [
    "buildRating",
    "rawOffenseScale",
    "offenseScale",
    "projectileDamage",
    "maxHp",
    "vitalityMultiplier",
    "minimumHitsToKo",
  ]) {
    assert.equal(forbidden in sanitized, false, `${forbidden} must remain server-derived`);
  }
  assert.deepEqual(
    protocol.sanitizePvpBuildProfile({
      level: -100,
      equipmentPower: -1,
      augmentStacks: -8,
    }),
    { level: 1, equipmentPower: 0, augmentStacks: 0 },
  );
  assert.deepEqual(
    protocol.sanitizePvpBuildProfile({
      level: Number.NaN,
      equipmentPower: Number.POSITIVE_INFINITY,
      augmentStacks: "1000",
    }),
    protocol.DEFAULT_PVP_BUILD_PROFILE,
  );
  assert.deepEqual(
    protocol.parseRealtimeClientMessage({ type: "queue", profile: injectedProfile }),
    { type: "queue", profile: sanitized },
    "the queue parser must sanitize again at the network trust boundary",
  );
  assert.deepEqual(
    protocol.parseRealtimeClientMessage({
      type: "queue",
      damage: 999_999,
      maxHp: 1,
    }),
    { type: "queue", profile: protocol.DEFAULT_PVP_BUILD_PROFILE },
    "legacy clients stay compatible while injected derived combat fields are discarded",
  );
});

test("adaptive PVP balance is symmetric, monotonic, and preserves minimum survival budgets", async () => {
  const protocol = await importTypeScriptModule("app/pvp-protocol.ts");
  assert.equal(protocol.PVP_BASE_PROJECTILE_DAMAGE, 18);
  assert.equal(protocol.PVP_BASE_SHOT_COOLDOWN_MS, 360);
  assert.equal(protocol.PVP_TARGET_TTK_SECONDS, 4.5);
  assert.equal(protocol.PVP_MIN_HITS_TO_KO, 8);
  assert.equal(protocol.PVP_BURST_WINDOW_MS, 300);
  assert.equal(protocol.PVP_BURST_MAX_HEALTH_FRACTION, 0.25);
  assert.equal(protocol.PVP_BALANCE_VERSION, 2);

  const weak = { level: 1, equipmentPower: 0, augmentStacks: 0 };
  const middle = { level: 120, equipmentPower: 80_000, augmentStacks: 360 };
  const strong = {
    level: protocol.PVP_MAX_PROFILE_LEVEL,
    equipmentPower: protocol.PVP_MAX_EQUIPMENT_POWER,
    augmentStacks: protocol.PVP_MAX_TOTAL_AUGMENT_STACKS,
  };
  assert.ok(protocol.calculatePvpBuildRating(weak) < protocol.calculatePvpBuildRating(middle));
  assert.ok(protocol.calculatePvpBuildRating(middle) < protocol.calculatePvpBuildRating(strong));
  assert.ok(protocol.calculatePvpOffenseScale(weak) < protocol.calculatePvpOffenseScale(middle));
  assert.ok(protocol.calculatePvpOffenseScale(middle) < protocol.calculatePvpOffenseScale(strong));

  const weakWeak = protocol.resolvePvpMatchBalance(weak, weak);
  const weakMiddle = protocol.resolvePvpMatchBalance(weak, middle);
  const weakStrong = protocol.resolvePvpMatchBalance(weak, strong);
  const middleStrong = protocol.resolvePvpMatchBalance(middle, strong);
  const strongWeak = protocol.resolvePvpMatchBalance(strong, weak);
  const strongStrong = protocol.resolvePvpMatchBalance(strong, strong);
  assert.deepEqual(weakStrong.left, strongWeak.right);
  assert.deepEqual(weakStrong.right, strongWeak.left);
  assert.equal(weakStrong.maxHp, strongWeak.maxHp);
  assert.equal(weakStrong.vitalityMultiplier, strongWeak.vitalityMultiplier);
  assert.deepEqual(strongStrong.left, strongStrong.right);
  assert.ok(weakWeak.maxHp < weakMiddle.maxHp);
  assert.ok(weakMiddle.maxHp < weakStrong.maxHp);
  assert.equal(
    weakStrong.maxHp,
    strongStrong.maxHp,
    "the stronger participant must determine the one shared HP pool for the match",
  );
  assert.ok(
    weakStrong.left.offenseScale > weakWeak.left.offenseScale,
    "a weak build must receive partial adaptive offense only when a stronger build is involved",
  );
  assert.ok(weakStrong.left.offenseScale < weakStrong.right.offenseScale);
  assert.ok(middleStrong.left.offenseScale > weakStrong.left.offenseScale);
  assert.equal(middleStrong.right.offenseScale, weakStrong.right.offenseScale);

  const strongestDamage = weakStrong.right.projectileDamage;
  const strongestHitsToKo = Math.ceil(weakStrong.maxHp / strongestDamage);
  const strongestSustainedSeconds =
    weakStrong.maxHp /
    (strongestDamage / (protocol.PVP_BASE_SHOT_COOLDOWN_MS / 1_000));
  assert.ok(
    strongestHitsToKo >= protocol.PVP_MIN_HITS_TO_KO,
    "even the strongest legal build must need at least eight clean hits",
  );
  assert.ok(
    strongestSustainedSeconds >= protocol.PVP_TARGET_TTK_SECONDS,
    "continuous perfect fire must still respect the 4.5-second target survival floor",
  );
  assert.equal(
    protocol.capPvpHitDamage(Number.MAX_VALUE, weakStrong.maxHp),
    weakStrong.maxHp / protocol.PVP_MIN_HITS_TO_KO,
  );
  assert.equal(protocol.capPvpHitDamage(-10, weakStrong.maxHp), 0);
  assert.equal(protocol.capPvpHitDamage(Number.NaN, weakStrong.maxHp), 0);
  assert.equal(protocol.capPvpHitDamage(10, 0), 0);
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
  assert.match(
    server,
    /PROJECTILE_DAMAGE\s*=\s*(?:18|PVP_BASE_PROJECTILE_DAMAGE)/,
    "the fixed fallback damage may come from the shared balance constant",
  );
  assert.match(server, /player\.vx\s*=\s*player\.input\.moveX\s*\*\s*speed/);
  assert.match(server, /player\.x\s*\+=\s*player\.vx\s*\*\s*deltaSeconds/);
  assert.match(server, /target\.hp\s*=\s*Math\.max\(0,\s*target\.hp\s*-\s*appliedDamage\)/);
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

test("D1 and the arena wire saved build profiles into adaptive HP, damage caps, and snapshots", async () => {
  const [server, arena] = await Promise.all([
    readSource("worker/realtime-d1.ts"),
    readSource("app/pvp/PvpArena.tsx"),
  ]);

  assert.match(
    arena,
    /const save = readSaveSlot\(readActiveSaveSlot\(\)\);[\s\S]{0,300}?level: save\.player\.level,[\s\S]{0,300}?calculateEquipmentCombatPower\(\s*normalizeEquipment\(save\.player\.equipment\),?\s*\)[\s\S]{0,300}?augmentStacks: Object\.values\(save\.player\.augments\)\.reduce/,
    "the queue profile must be rebuilt from the active save's level, equipment, and capped augments",
  );
  assert.match(arena, /getRealtimeClient\(\)\.joinQueue\(buildProfile\)/);
  assert.match(arena, /RATING \{localBuildRating\.toLocaleString\(["']ko-KR["']\)\}/);
  assert.match(
    arena,
    /buildProfile\.augmentStacks\}\/\{PVP_MAX_TOTAL_AUGMENT_STACKS\}/,
  );
  assert.match(arena, /localOffenseScale\.toFixed\(2\)/);
  assert.match(
    arena,
    /localPlayer\?\.hp[\s\S]{0,160}?localPlayer\?\.maxHp[\s\S]{0,180}?localPlayer\?\.offenseScale/,
    "the local HUD must label authoritative current/max HP and adaptive offense",
  );
  assert.match(
    arena,
    /opponent\?\.hp[\s\S]{0,160}?opponent\?\.maxHp[\s\S]{0,220}?opponent\?\.offenseScale/,
    "the opponent HUD must expose the same authoritative balance fields",
  );

  assert.match(server, /combatProfile\?: PvpBuildProfile;/);
  assert.match(
    server,
    /session\.combatProfile = sanitizePvpBuildProfile\(profile\);/,
    "D1 must sanitize the profile again when queue state is persisted",
  );
  assert.match(
    server,
    /const leftProfile = sanitizePvpBuildProfile\(left\.combatProfile\);[\s\S]{0,180}?const rightProfile = sanitizePvpBuildProfile\(right\.combatProfile\);[\s\S]{0,180}?const balance = resolvePvpMatchBalance\(leftProfile, rightProfile\);/,
  );
  assert.match(
    server,
    /makeMatchPlayer\(left, 0, balance\.maxHp, balance\.left\),[\s\S]{0,80}?makeMatchPlayer\(right, 1, balance\.maxHp, balance\.right\)/,
    "both players must receive the exact same adaptive match HP",
  );
  assert.match(
    server,
    /damage: player\.projectileDamage \?\? PROJECTILE_DAMAGE/,
    "projectiles must snapshot their owner's server-resolved damage",
  );
  assert.match(
    server,
    /const hitDamage = capPvpHitDamage\(projectile\.damage, target\.maxHp\);/,
    "every collision must pass through the minimum-hit cap",
  );
  assert.match(
    server,
    /stepNow - damageWindowStartedAt >= PVP_BURST_WINDOW_MS[\s\S]{0,500}?target\.maxHp \* PVP_BURST_MAX_HEALTH_FRACTION -[\s\S]{0,160}?target\.damageWindowAmount[\s\S]{0,180}?const appliedDamage = Math\.min\(hitDamage, burstBudget\);/,
    "the 300ms rolling burst budget must cap combined damage as a fraction of target HP",
  );
  assert.match(
    server,
    /balanceVersion: match\.balanceVersion \?\? (?:PVP_BALANCE_VERSION|1),[\s\S]{0,160}?vitalityMultiplier: match\.vitalityMultiplier \?\? 1,[\s\S]{0,160}?targetTtkSeconds: match\.targetTtkSeconds \?\? PVP_TARGET_TTK_SECONDS/,
    "snapshots must identify the adaptive balance contract",
  );
  assert.match(
    server,
    /hp: player\.hp,[\s\S]{0,80}?maxHp: player\.maxHp,[\s\S]{0,300}?buildRating: player\.buildRating \?\? 100,[\s\S]{0,120}?offenseScale: player\.offenseScale \?\? 1,[\s\S]{0,120}?projectileDamage: player\.projectileDamage \?\? PROJECTILE_DAMAGE/,
    "each snapshot player must carry authoritative health and offense labels",
  );
  assert.match(
    server,
    /burstWindowMs: PVP_BURST_WINDOW_MS,[\s\S]{0,100}?burstMaxHealthFraction: PVP_BURST_MAX_HEALTH_FRACTION/,
    "health diagnostics must publish the live anti-burst constants",
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
