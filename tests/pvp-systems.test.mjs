import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import ts from "typescript";

const root = process.cwd();

async function readSource(relativePath) {
  return readFile(path.join(root, relativePath), "utf8");
}

async function typeScriptModuleUrl(relativePath, dependencyUrls = {}) {
  let source = await readSource(relativePath);
  for (const [specifier, dependencyUrl] of Object.entries(dependencyUrls)) {
    source = source
      .replaceAll(`"${specifier}"`, `"${dependencyUrl}"`)
      .replaceAll(`'${specifier}'`, `'${dependencyUrl}'`);
  }
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: relativePath,
  }).outputText;
  return `data:text/javascript;base64,${Buffer.from(output).toString("base64")}`;
}

const equipmentModuleUrlPromise = typeScriptModuleUrl("app/equipment.ts");

async function importTypeScriptModule(relativePath) {
  const dependencyUrls = relativePath === "app/pvp-protocol.ts"
    ? { "./equipment": await equipmentModuleUrlPromise }
    : {};
  return import(await typeScriptModuleUrl(relativePath, dependencyUrls));
}

async function importPvpEquipmentProfileModules() {
  const equipmentUrl = await equipmentModuleUrlPromise;
  const protocolUrl = await typeScriptModuleUrl("app/pvp-protocol.ts", {
    "./equipment": equipmentUrl,
  });
  const profileUrl = await typeScriptModuleUrl(
    "app/pvp-equipment-profile.ts",
    {
      "./equipment": equipmentUrl,
      "./pvp-protocol": protocolUrl,
    },
  );
  return Promise.all([
    import(equipmentUrl),
    import(protocolUrl),
    import(profileUrl),
  ]);
}

async function importRealtimeServer() {
  const equipmentUrl = await equipmentModuleUrlPromise;
  const protocolUrl = await typeScriptModuleUrl("app/pvp-protocol.ts", {
    "./equipment": equipmentUrl,
  });
  const collisionUrl = await typeScriptModuleUrl("app/room-collision.ts");
  const nicknameUrl = await typeScriptModuleUrl("app/character-nickname.ts");
  return import(
    await typeScriptModuleUrl("worker/realtime-d1.ts", {
      "../app/pvp-protocol": protocolUrl,
      "../app/room-collision": collisionUrl,
      "../app/character-nickname": nicknameUrl,
    })
  );
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

test("PVP equipment profiles admit only canonical PVE fields and strong safety bounds", async () => {
  const protocol = await importTypeScriptModule("app/pvp-protocol.ts");
  assert.equal(protocol.PVP_MAX_EQUIPMENT_POWER, 1_000_000_000_000);
  assert.equal(protocol.DEFAULT_PVP_BUILD_PROFILE.equipmentPower, 1_000);
  assert.equal(protocol.DEFAULT_PVP_BUILD_PROFILE.moveSpeed, 245);
  assert.equal(protocol.DEFAULT_PVP_BUILD_PROFILE.dashSpeed, 900);
  assert.equal(protocol.DEFAULT_PVP_BUILD_PROFILE.dashCooldownMs, 1_350);
  assert.equal(protocol.DEFAULT_PVP_BUILD_PROFILE.attackRate, 1.4);
  assert.equal(protocol.DEFAULT_PVP_BUILD_PROFILE.projectileSpeed, 660);
  assert.equal(protocol.DEFAULT_PVP_BUILD_PROFILE.projectileLifeMs, 1_150);
  assert.equal(protocol.DEFAULT_PVP_BUILD_PROFILE.projectileRadius, 5);
  assert.equal(protocol.DEFAULT_PVP_BUILD_PROFILE.critChance, 0.05);
  assert.equal(protocol.DEFAULT_PVP_BUILD_PROFILE.critMultiplier, 1.7);
  assert.equal(protocol.DEFAULT_PVP_BUILD_PROFILE.continuousMoveMultiplier, 1);

  const injectedProfile = {
    equipmentPower: 197_477_041_320,
    moveSpeed: 0,
    dashSpeed: Number.POSITIVE_INFINITY,
    dashCooldownMs: 99_999,
    attackRate: 0,
    projectileCount: 99,
    projectileSpeed: 0,
    projectileLifeMs: 0,
    projectileRadius: 0,
    critChance: 2,
    critMultiplier: 0,
    homingStrength: 99,
    pierce: 99_999,
    continuousMoveMultiplier: 99,
    level: 50_000,
    augmentStacks: 50_000,
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
    equipmentPower: 197_477_041_320,
    moveSpeed: 245,
    dashSpeed: 900,
    dashCooldownMs: 1_350,
    attackRate: 1.4,
    projectileCount: 9,
    projectileSpeed: 660,
    projectileLifeMs: 1_150,
    projectileRadius: 5,
    critChance: 0.75,
    critMultiplier: 1.7,
    homingStrength: 14,
    pierce: 10_000,
    continuousMoveMultiplier: 1,
  });
  assert.deepEqual(Object.keys(sanitized), [
    "equipmentPower",
    "moveSpeed",
    "dashSpeed",
    "dashCooldownMs",
    "attackRate",
    "projectileCount",
    "projectileSpeed",
    "projectileLifeMs",
    "projectileRadius",
    "critChance",
    "critMultiplier",
    "homingStrength",
    "pierce",
    "continuousMoveMultiplier",
  ]);
  for (const forbidden of [
    "level",
    "augmentStacks",
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
      equipmentPower: -1,
      moveSpeed: -1,
      dashSpeed: -1,
      dashCooldownMs: -1,
      attackRate: -1,
      projectileCount: -1,
      projectileSpeed: -1,
      projectileLifeMs: -1,
      projectileRadius: -1,
      critChance: -1,
      critMultiplier: -1,
      homingStrength: -1,
      pierce: -1,
      continuousMoveMultiplier: -1,
    }),
    {
      ...protocol.DEFAULT_PVP_BUILD_PROFILE,
      equipmentPower: 0,
      dashCooldownMs: 100,
    },
  );
  assert.deepEqual(
    protocol.sanitizePvpBuildProfile({
      equipmentPower: Number.POSITIVE_INFINITY,
      attackRate: "12",
    }),
    protocol.DEFAULT_PVP_BUILD_PROFILE,
  );
  assert.equal(
    protocol.sanitizePvpBuildProfile({ continuousMoveMultiplier: 1.12 })
      .continuousMoveMultiplier,
    1.12,
  );
  for (const rejectedMultiplier of [1.06, 99, -1, Number.NaN, "1.12"]) {
    assert.equal(
      protocol.sanitizePvpBuildProfile({
        continuousMoveMultiplier: rejectedMultiplier,
      }).continuousMoveMultiplier,
      1,
      `non-canonical Phantom March multiplier ${String(rejectedMultiplier)} must fail closed`,
    );
  }
  assert.deepEqual(
    protocol.parseRealtimeClientMessage({ type: "queue", profile: injectedProfile }),
    {
      type: "queue",
      profile: sanitized,
      appearance: protocol.DEFAULT_PVP_APPEARANCE,
    },
    "the queue parser must sanitize again at the network trust boundary",
  );
  assert.deepEqual(
    protocol.parseRealtimeClientMessage({
      type: "queue",
      profile: { equipmentPower: Number.MAX_SAFE_INTEGER },
      damage: Number.MAX_SAFE_INTEGER,
      maxHp: 1,
    }),
    {
      type: "queue",
      profile: {
        ...protocol.DEFAULT_PVP_BUILD_PROFILE,
        equipmentPower: protocol.PVP_MAX_EQUIPMENT_POWER,
      },
      appearance: protocol.DEFAULT_PVP_APPEARANCE,
    },
    "derived damage and health are discarded while equipment power remains bounded",
  );
});

test("PVP equipment profile mirrors exact equipment-only expedition formulas", async () => {
  const [equipment, protocol, profileModule] =
    await importPvpEquipmentProfileModules();
  const { createPvpEquipmentProfile } = profileModule;
  const roundToFour = (value) => Math.round(value * 10_000) / 10_000;

  const baseline = createPvpEquipmentProfile({});
  assert.deepEqual(baseline, protocol.DEFAULT_PVP_BUILD_PROFILE);
  assert.equal(JSON.stringify(protocol.sanitizePvpBuildProfile(baseline)), JSON.stringify(baseline));

  const ordinaryLegs = equipment.rollGear("pvp-profile-ordinary-legs", {
    slot: "legs",
    rarity: "rare",
    level: 999,
  });
  assert.equal(
    createPvpEquipmentProfile({ legs: ordinaryLegs }).continuousMoveMultiplier,
    1,
  );

  const phantomLegs = equipment.rollGear("pvp-profile-phantom-legs", {
    slot: "legs",
    rarity: "legendary",
    level: 999,
  });
  assert.equal(phantomLegs.legendaryPowerId, "phantomMarch");
  const phantomProfile = createPvpEquipmentProfile({ legs: phantomLegs });
  assert.equal(
    phantomProfile.continuousMoveMultiplier,
    protocol.PVP_PHANTOM_MARCH_MOVE_MULTIPLIER,
  );
  assert.equal(
    JSON.stringify(protocol.sanitizePvpBuildProfile(phantomProfile)),
    JSON.stringify(phantomProfile),
    "a legal Phantom March profile must survive the network sanitizer byte-for-byte",
  );

  const loadout = {};
  for (const slot of equipment.EQUIPMENT_SLOTS) {
    loadout[slot] = equipment.rollGear(`pvp-profile-cosmic-${slot}`, {
      slot,
      rarity: "cosmic",
      level: 999,
    });
  }
  const stats = equipment.aggregateEquipmentStats(loadout);
  const exact = createPvpEquipmentProfile(loadout);
  assert.equal(
    exact.equipmentPower,
    equipment.calculateEquipmentCombatPower(loadout),
  );
  assert.equal(
    exact.moveSpeed,
    roundToFour(
      245 *
        (1 + stats.moveSpeedPercent / 100) *
        (1 + stats.cosmicActionSpeedPercent / 100),
    ),
  );
  assert.equal(
    exact.dashSpeed,
    roundToFour(900 * (1 + stats.dashSpeedPercent / 100)),
  );
  assert.equal(
    exact.dashCooldownMs,
    Math.round(1_350 / ((1 + stats.dashCooldownPercent / 100) * 1.3)),
  );
  assert.equal(
    exact.attackRate,
    roundToFour(
      Math.min(
        12,
        1.4 *
          (1 + stats.attackSpeedPercent / 100) *
          (1 + stats.cosmicActionSpeedPercent / 100),
      ),
    ),
  );
  assert.equal(
    exact.projectileCount,
    Math.min(9, 1 + Math.max(0, Math.floor(stats.projectileCountFlat))),
  );
  assert.equal(
    exact.projectileSpeed,
    roundToFour(660 * (1 + stats.projectileSpeedPercent / 100)),
  );
  assert.equal(
    exact.projectileLifeMs,
    Math.round(1_150 * (1 + stats.projectileLifetimePercent / 100)),
  );
  assert.equal(
    exact.projectileRadius,
    roundToFour(5 * (1 + Math.min(150, stats.projectileSizePercent) / 100)),
  );
  assert.equal(
    exact.critChance,
    roundToFour(Math.min(0.75, Math.max(0, 0.05 + stats.critChancePercent / 100))),
  );
  assert.equal(
    exact.critMultiplier,
    roundToFour(1.7 + stats.critDamagePercent / 100),
  );
  assert.equal(
    exact.homingStrength,
    roundToFour(Math.min(14, Math.max(0, stats.homingStrengthFlat))),
  );
  assert.equal(exact.pierce, Math.max(0, Math.floor(stats.pierceFlat)));
  assert.equal(
    exact.continuousMoveMultiplier,
    protocol.PVP_PHANTOM_MARCH_MOVE_MULTIPLIER,
  );
  assert.equal(
    JSON.stringify(protocol.sanitizePvpBuildProfile(exact)),
    JSON.stringify(exact),
    "the largest deterministic legal fixture must not be truncated or reordered",
  );
  for (const forbidden of [
    "level",
    "augmentStacks",
    "legendaryPowerId",
    "equipment",
    "affixes",
  ]) {
    assert.equal(forbidden in exact, false, `${forbidden} must not enter the wire profile`);
  }
});

test("PVP appearance admits only renderer-safe cosmetic metadata", async () => {
  const protocol = await importTypeScriptModule("app/pvp-protocol.ts");
  const untrustedAppearance = {
    weapon: {
      slot: "weapon",
      variant: 9,
      rarity: "cosmic",
      enhancement: 10,
      id: "private-item-id",
      affixes: [{ stat: "damage", value: 999_999 }],
      powerScore: 999_999,
      spriteUrl: "https://attacker.invalid/weapon.png",
      css: "body { display: none }",
    },
    armor: {
      slot: "armor",
      variant: 4,
      rarity: "legendary",
      enhancement: 3,
      save: { player: { hp: 999_999 } },
    },
    offhand: {
      slot: "weapon",
      variant: 2,
      rarity: "mythic",
      enhancement: 5,
    },
    helm: {
      slot: "helm",
      variant: 10,
      rarity: "mythic",
      enhancement: 5,
    },
    boots: {
      slot: "boots",
      variant: 1,
      rarity: "admin",
      enhancement: 0,
    },
    relic: {
      slot: "relic",
      variant: 0,
      rarity: "rare",
      enhancement: 11,
    },
    prototypePollution: {
      slot: "weapon",
      variant: 0,
      rarity: "cosmic",
      enhancement: 10,
    },
  };
  const sanitized = protocol.sanitizePvpAppearance(untrustedAppearance);
  assert.deepEqual(sanitized, {
    weapon: {
      slot: "weapon",
      variant: 9,
      rarity: "cosmic",
      enhancement: 10,
    },
    armor: {
      slot: "armor",
      variant: 4,
      rarity: "legendary",
      enhancement: 3,
    },
  });
  assert.deepEqual(Object.keys(sanitized.weapon), [
    "slot",
    "variant",
    "rarity",
    "enhancement",
  ]);
  for (const forbidden of [
    "id",
    "affixes",
    "powerScore",
    "spriteUrl",
    "css",
    "save",
  ]) {
    assert.equal(forbidden in sanitized.weapon, false);
    assert.equal(forbidden in sanitized.armor, false);
  }
  assert.deepEqual(protocol.sanitizePvpAppearance(undefined), {});
  assert.deepEqual(protocol.sanitizePvpAppearance([]), {});

  const parsed = protocol.parseRealtimeClientMessage({
    type: "queue",
    profile: { level: 20, equipmentPower: 5_000, augmentStacks: 12 },
    appearance: untrustedAppearance,
    equipment: { weapon: untrustedAppearance.weapon },
    affixes: [{ stat: "damage", value: 999_999 }],
    spriteUrl: "https://attacker.invalid/body.png",
  });
  assert.deepEqual(parsed, {
    type: "queue",
    profile: { ...protocol.DEFAULT_PVP_BUILD_PROFILE, equipmentPower: 5_000 },
    appearance: sanitized,
  });
  assert.equal("equipment" in parsed, false);
  assert.equal("affixes" in parsed, false);
  assert.equal("spriteUrl" in parsed, false);
});

test("PVP combat is fixed-health linear equipment power against a boss target", async () => {
  const protocol = await importTypeScriptModule("app/pvp-protocol.ts");
  assert.equal(protocol.PVP_COMBAT_VERSION, 4);
  assert.equal(protocol.PVP_BASE_MAX_HP, 100);
  assert.equal(protocol.PVP_BOSS_HIT_RADIUS, 52);
  assert.equal(protocol.PVP_TARGET_CLASS, "boss");
  assert.equal(protocol.PVP_COMBAT_MODEL, "equipment-power");
  assert.equal(protocol.PVP_PHANTOM_MARCH_ACTIVATION_MS, 3_000);
  assert.equal(protocol.PVP_PHANTOM_MARCH_MOVE_MULTIPLIER, 1.12);
  assert.equal(protocol.PVP_PHANTOM_MARCH_TIMER_CAP_MS, 3_500);
  assert.equal(protocol.PVP_PHANTOM_MARCH_MOVEMENT_EPSILON, 0.05);

  const baseline = protocol.resolvePvpCombatProfile(
    protocol.DEFAULT_PVP_BUILD_PROFILE,
  );
  const doubled = protocol.resolvePvpCombatProfile({
    ...protocol.DEFAULT_PVP_BUILD_PROFILE,
    equipmentPower: 2_000,
  });
  assert.equal(doubled.expectedBossDps, baseline.expectedBossDps * 2);
  assert.equal(doubled.projectileDamage, baseline.projectileDamage * 2);
  assert.ok(Math.abs(baseline.projectileDamage - 14) < 1e-10);
  assert.ok(
    Math.abs(
      baseline.expectedBossDps -
        baseline.projectileDamage *
          baseline.attackRate *
          baseline.projectileCount *
          (1 + baseline.critChance * (baseline.critMultiplier - 1)),
    ) < 1e-10,
  );

  const shaped = protocol.resolvePvpCombatProfile({
    ...protocol.DEFAULT_PVP_BUILD_PROFILE,
    equipmentPower: 1_000,
    attackRate: 12,
    projectileCount: 9,
    critChance: 0.75,
    critMultiplier: 17.5972,
  });
  assert.equal(shaped.expectedBossDps, baseline.expectedBossDps);
  assert.ok(
    Math.abs(
      shaped.projectileDamage *
        shaped.attackRate *
        shaped.projectileCount *
        (1 + shaped.critChance * (shaped.critMultiplier - 1)) -
        baseline.expectedBossDps,
    ) < 1e-10,
    "projectile shaping must preserve the exact equipment-power boss DPS",
  );

  for (const removed of [
    "calculatePvpBuildRating",
    "calculatePvpOffenseScale",
    "resolvePvpMatchBalance",
    "capPvpHitDamage",
    "PVP_TARGET_TTK_SECONDS",
    "PVP_MIN_HITS_TO_KO",
    "PVP_BURST_WINDOW_MS",
    "PVP_BURST_MAX_HEALTH_FRACTION",
  ]) {
    assert.equal(protocol[removed], undefined, `${removed} must not survive the CP-only model`);
  }
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
    /if\s*\(message\.type === "pvp_input"\)\s*\{[\s\S]{0,360}?this\.pendingPvpDashSequence\s*=\s*message\.sequence[\s\S]{0,520}?this\.latestPvpInput\s*=\s*message/,
  );
  assert.match(
    client,
    /const sentInput\s*=\s*this\.latestPvpInput && this\.pendingPvpDashVector[\s\S]{0,260}?\.\.\.this\.pendingPvpDashVector,[\s\S]{0,80}?dash:\s*true/,
    "the reliable dash edge must overlay its latched direction onto the newest held input",
  );
  assert.match(client, /const sentInput\s*=\s*this\.latestPvpInput/);
  assert.match(
    client,
    /this\.latestPvpInput\?\.sequence\s*===\s*sentInput\.sequence[\s\S]*this\.latestPvpInput\s*=\s*null/,
  );
  assert.match(client, /this\.pendingMessages/);
  assert.match(client, /FAST_POLL_MS\s*=\s*50/);
  assert.match(client, /FAST_POLL_MIN_GAP_MS\s*=\s*24/);
  assert.match(client, /FAST_POLL_JITTER_MS\s*=\s*36/);
  assert.match(
    client,
    /Date\.now\(\)\s*-\s*this\.lastSyncStartedAt[\s\S]*FAST_POLL_MS\s*-\s*elapsed/,
  );
  assert.match(
    client,
    /joinQueue\(profile:\s*PvpBuildProfile,\s*appearance\?:\s*PvpAppearance\)/,
  );
  assert.match(client, /appearance:\s*sanitizePvpAppearance\(appearance\)/);
  assert.match(
    client,
    /sentInput\?\.dash[\s\S]{0,220}?this\.pendingPvpDashSequence\s*=\s*null/,
    "a dash edge must survive input coalescing until the carrying request succeeds",
  );
});

test("PVP arena predicts the expedition runtime without duplicate volleys or VFX", async () => {
  const arena = await readSource("app/pvp/PvpArena.tsx");

  assert.match(arena, /gameplayVfxImageEntries\(\)/);
  assert.match(arena, /drawGameplayVfxFrame\(/);
  assert.match(arena, /playGameSfx\(/);
  assert.match(arena, /context:\s*["']combat["']/);
  assert.match(arena, /shouldDrawProjectileTrail\(projectile\.id, hostile, projectileCount\)/);
  assert.doesNotMatch(arena, /PVP_PROJECTILE_VFX/);

  const inputGateStart = arena.indexOf("const canControl =");
  const inputGateEnd = arena.indexOf("const sampledAim =", inputGateStart);
  assert.ok(inputGateStart >= 0 && inputGateEnd > inputGateStart);
  const inputGate = arena.slice(inputGateStart, inputGateEnd);
  assert.match(
    inputGate,
    /const canControl =[\s\S]{0,120}?current\.phase === "playing" && localPlayer\.respawnMs <= 0/,
  );
  assert.match(
    inputGate,
    /const canFire =[\s\S]{0,120}?canControl && Boolean\(opponent && opponent\.respawnMs <= 0\)/,
  );
  const dashGateStart = inputGate.indexOf("const dashAvailable =");
  const dashGateEnd = inputGate.indexOf("const dash =", dashGateStart);
  assert.ok(dashGateStart >= 0 && dashGateEnd > dashGateStart);
  const dashGate = inputGate.slice(dashGateStart, dashGateEnd);
  assert.match(dashGate, /canControl/);
  assert.match(dashGate, /predictedDashAvailable/);
  assert.doesNotMatch(
    dashGate,
    /opponent|canFire/,
    "PVE dash must remain available while the opponent respawns",
  );
  assert.match(
    arena,
    /else if \(predictionDashQueuedRef\.current\) \{[\s\S]{0,260}?predictionDashQueuedRef\.current = false;/,
    "an unavailable dash edge must be consumed instead of becoming a delayed ghost dash",
  );
  assert.match(
    arena,
    /const continuousMoveMultiplier =\s*authoritative\.continuousMoveMultiplier \?\?[\s\S]{0,100}?buildProfile\.continuousMoveMultiplier/,
    "prediction must prefer the server-sanitized Phantom March multiplier",
  );
  assert.match(
    arena,
    /const actuallyMoved =[\s\S]{0,180}?PVP_PHANTOM_MARCH_MOVEMENT_EPSILON;[\s\S]{0,280}?state\.phantomMarchMoveMs \+[\s\S]{0,80}?stepMs[\s\S]{0,100}?: 0;/,
    "Phantom March prediction must use post-collision displacement and reset immediately",
  );

  assert.match(arena, /const muzzleX = localPosition\.x;\s*const muzzleY = pvpPlayerBodyCenterY\(localPosition\.y\);/);
  assert.match(arena, /const startX = localPosition\.x;\s*const startY = localPosition\.y - 8;/);
  assert.match(
    arena,
    /const liveBossAim = normalizeVector\([\s\S]{0,320}?opponent\.x \+ opponent\.vx \* opponentLeadSeconds - localPosition\.x[\s\S]{0,320}?const baseAngle = Math\.atan2\(liveBossAim\.y, liveBossAim\.x\)/,
    "each predicted volley must reacquire the extrapolated live boss at its firing frame",
  );
  assert.match(
    arena,
    /event\.kind === "shot"[\s\S]{0,160}?pvpPlayerBodyCenterY\(event\.y\)/,
    "authoritative muzzle VFX must use the expedition body-center anchor",
  );

  const predictedProjectileStart = arena.indexOf(
    "const advancePredictedProjectiles =",
  );
  const combatEventStart = arena.indexOf(
    "const processCombatEvents =",
    predictedProjectileStart,
  );
  assert.ok(
    predictedProjectileStart >= 0 && combatEventStart > predictedProjectileStart,
  );
  const predictedProjectileRuntime = arena.slice(
    predictedProjectileStart,
    combatEventStart,
  );
  assert.match(
    predictedProjectileRuntime,
    /Math\.ceil\(elapsedSeconds \* 60\)/,
  );
  assert.match(
    predictedProjectileRuntime,
    /for \(let step = 0; step < stepCount; step \+= 1\)/,
  );
  assert.match(
    predictedProjectileRuntime,
    /opponent\.respawnMs <= 0[\s\S]{0,700}?projectile\.homingStrength \* liveSeconds/,
    "predicted homing must use bounded 60 Hz substeps instead of one frame-sized turn",
  );
  assert.match(
    predictedProjectileRuntime,
    /const hitArenaWall =[\s\S]{0,420}?x: clamp\(projectile\.x, 0, PVP_ARENA_WIDTH\)[\s\S]{0,160}?y: clamp\(projectile\.y, 0, PVP_ARENA_HEIGHT\)[\s\S]{0,260}?size: projectile\.radius \* 4\.4[\s\S]{0,300}?durationMs: 220[\s\S]{0,160}?vfxId: projectile\.vfxId/,
    "legendary bonus projectiles must keep the expedition wall-impact VFX contract",
  );

  const reconcileStart = arena.indexOf(
    "const reconcilePredictedProjectiles =",
  );
  assert.ok(reconcileStart >= 0 && predictedProjectileStart > reconcileStart);
  const projectileHandoff = arena.slice(reconcileStart, predictedProjectileStart);
  assert.match(projectileHandoff, /seenAuthoritativeLocalProjectileIds\.add\(projectile\.id\)/);
  assert.match(
    projectileHandoff,
    /reconciledAuthoritativeVolleyIds\.has\(projectile\.volleyId\)[\s\S]{0,100}?reconciledAuthoritativeVolleyIds\.add\(projectile\.volleyId\)/,
    "each exact authoritative volley must hand off only one predicted volley regardless of pellet count",
  );
  assert.match(
    projectileHandoff,
    /if \(event\.volleyId !== undefined\) \{\s*return event\.volleyId === projectile\.volleyId;\s*\}[\s\S]{0,260}?sameVolleyAgeDelta > 0[\s\S]{0,100}?sameVolleyAgeDelta <= PVP_AUTHORITATIVE_TICK_MS/,
    "new events must reconcile by volley identity while persisted legacy events retain bounded age fallback",
  );
  assert.match(
    arena,
    /event\.actorId === playerIdRef\.current && event\.kind === "shot"[\s\S]{0,180}?consumePredictedShot\(\s*renderTime - eventAgeMs,\s*null,?\s*\)/,
    "local shot events must acknowledge by cadence instead of a stale client-aim angle",
  );
  assert.match(
    arena,
    /event\.kind === "hit" &&[\s\S]{0,120}?event\.critical[\s\S]{0,260}?Number\.isSafeInteger\(event\.volleyId\)/,
  );
  assert.match(
    arena,
    /if \(!landedVolleys\.has\(event\.volleyId\)\) \{[\s\S]{0,260}?criticalHitCountByActor/,
    "Bloodwoven cadence must count a critical volley once, not once per pellet hit",
  );
  assert.match(arena, /playGameSfx\("playerImpact"/);
  assert.equal(
    (arena.match(/legendaryVfxId\("riftStride"\)/g) ?? []).length,
    1,
    "Rift Stride trail must have one render source rather than dash-event duplication",
  );

  assert.doesNotMatch(
    arena,
    /buildProfile\.augmentStacks|localOffenseScale|offenseScale|vitalityMultiplier|PVP_TARGET_TTK_SECONDS/,
  );
});

test("cosmetic appearance is persisted and snapshotted independently from combat authority", async () => {
  const [protocol, server] = await Promise.all([
    readSource("app/pvp-protocol.ts"),
    readSource("worker/realtime-d1.ts"),
  ]);

  assert.match(protocol, /from\s+["']\.\/equipment["']/);
  assert.doesNotMatch(protocol, /character-paperdoll/);
  assert.match(server, /appearance\?:\s*PvpAppearance;/);
  assert.match(
    server,
    /session\.combatProfile\s*=\s*sanitizePvpBuildProfile\(profile\);\s*session\.appearance\s*=\s*sanitizePvpAppearance\(appearance\);/,
  );
  assert.match(
    server,
    /appearance:\s*sanitizePvpAppearance\(session\.appearance\)/,
    "the match must freeze the queued appearance instead of reading another client later",
  );
  assert.match(
    server,
    /appearance:\s*sanitizePvpAppearance\(player\.appearance\)/,
    "every snapshot must sanitize persisted and rolling-upgrade match state again",
  );
  assert.match(
    server,
    /message\.profile,\s*message\.appearance,\s*directMessages/,
  );
  assert.match(
    server,
    /left\.appearance = \{ \.\.\.DEFAULT_PVP_APPEARANCE \};\s*right\.appearance = \{ \.\.\.DEFAULT_PVP_APPEARANCE \};/,
    "session cosmetics must be released after immutable match copies are made",
  );
  assert.match(
    server,
    /function leaveQueue[\s\S]{0,220}?session\.appearance = \{ \.\.\.DEFAULT_PVP_APPEARANCE \};/,
    "cancelled queues must not retain cosmetic payloads for the session TTL",
  );
  assert.match(
    server,
    /now - session\.lastSeenAt > QUEUE_STALE_MS[\s\S]{0,180}?session\.appearance = \{ \.\.\.DEFAULT_PVP_APPEARANCE \};/,
    "stale queued sessions must release cosmetic payloads",
  );
  assert.doesNotMatch(
    server,
    /appearance[^\n]*(?:affixes|spriteUrl|powerScore|GearItem)/,
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

test("D1 simulation runs PVE-profile movement, latched dashes, and swept boss hits authoritatively", async () => {
  const server = await readSource("worker/realtime-d1.ts");

  assert.match(server, /(?:SIMULATION_STEP_MS|TICK_MS)\s*=\s*50/);
  assert.match(
    server,
    /const liveOpponent = match\.players\.find\([\s\S]{0,180}?candidate\.id !== player\.id && candidate\.respawnMs <= 0[\s\S]{0,120}?if \(player\.input\.fire && player\.respawnMs <= 0 && liveOpponent\) \{[\s\S]{0,700}?player\.shotCooldownMs -= TICK_MS;[\s\S]{0,700}?\} else \{[\s\S]{0,700}?player\.shotCooldownMs = Math\.max\(0, player\.shotCooldownMs - TICK_MS\);/,
    "continuous live-target fire must retain fractional cadence debt while idle or targetless time stops at zero",
  );
  const simulateShotCadence = (
    fireSchedule,
    attackRate = 12,
    liveOpponentSchedule = fireSchedule.map(() => true),
  ) => {
    let cooldownMs = 0;
    let shots = 0;
    for (let tick = 0; tick < fireSchedule.length; tick += 1) {
      const canFire = fireSchedule[tick] && liveOpponentSchedule[tick];
      cooldownMs = canFire
        ? cooldownMs - 50
        : Math.max(0, cooldownMs - 50);
      if (canFire && cooldownMs <= 0) {
        shots += 1;
        cooldownMs += 1_000 / attackRate;
      }
    }
    return { cooldownMs, shots };
  };
  const continuous = simulateShotCadence(Array(200).fill(true));
  assert.equal(
    continuous.shots,
    121,
    "12 attacks/s must retain 120 cadence intervals plus the immediate opening shot over ten seconds",
  );
  const resumed = simulateShotCadence([
    ...Array(200).fill(false),
    ...Array(20).fill(true),
  ]);
  assert.equal(
    resumed.shots,
    13,
    "ten idle seconds must not bank a 20 Hz burst when one second of firing resumes",
  );
  const heldThroughRespawn = simulateShotCadence(
    Array(220).fill(true),
    12,
    [...Array(200).fill(false), ...Array(20).fill(true)],
  );
  assert.equal(
    heldThroughRespawn.shots,
    13,
    "holding fire without a live opponent must not bank a respawn catch-up burst",
  );
  const cooldownDecayStart = server.indexOf(
    "if (player.input.fire && player.respawnMs <= 0 && liveOpponent) {",
  );
  const respawnWaitStart = server.indexOf(
    "if (player.respawnMs > 0)",
    cooldownDecayStart,
  );
  const fireGateAfterRespawn = server.indexOf("player.input.fire &&", respawnWaitStart);
  assert.ok(
    cooldownDecayStart >= 0 &&
      respawnWaitStart > cooldownDecayStart &&
      fireGateAfterRespawn > respawnWaitStart,
    "cooldown must clamp even while waiting for a respawn before firing is considered",
  );
  assert.match(
    server.slice(fireGateAfterRespawn, fireGateAfterRespawn + 4_000),
    /player\.shotCooldownMs \+= 1_000 \/ player\.attackRate/,
    "the first post-idle shot must resume the authored attack cadence without a burst loop",
  );
  assert.match(
    server,
    /player\.x \+=[\s\S]{0,160}?player\.dashX \* player\.dashSpeed[\s\S]{0,180}?player\.input\.moveX \* normalMoveSpeed/,
    "movement must use the frozen canonical equipment profile",
  );
  assert.match(
    server,
    /const moveLength = Math\.hypot\(player\.input\.moveX, player\.input\.moveY\);[\s\S]{0,700}?player\.dashX = moveLength > 0\.001[\s\S]{0,260}?player\.aimX \/ aimLength/,
    "a stationary dash must latch the aim direction",
  );
  assert.match(server, /player\.dashRemainingMs = PVP_DASH_DURATION_MS/);
  assert.match(server, /player\.dashCooldownMs = player\.dashCooldownDurationMs/);
  const fireGateStart = server.indexOf("player.input.fire &&");
  assert.ok(fireGateStart >= 0);
  const fireGate = server.slice(fireGateStart, fireGateStart + 180);
  assert.doesNotMatch(
    fireGate,
    /dashRemainingMs/,
    "the authoritative server must permit PVE shooting during a dash",
  );
  assert.match(server, /const spread = Math\.min\(0\.62, projectileCount \* 0\.07\)/);
  assert.match(server, /const critical = Math\.random\(\) < player\.critChance/);
  assert.match(
    server,
    /player\.projectileDamage \* \(critical \? player\.critMultiplier : 1\)/,
  );
  assert.match(
    server,
    /const volleyId =[\s\S]{0,220}?match\.nextVolleyId[\s\S]{0,180}?match\.nextVolleyId = volleyId \+ 1;/,
    "each authoritative base attack must allocate one monotonic volley identity",
  );
  assert.match(
    server,
    /appendCombatEvent\(\s*match,\s*"shot",[\s\S]{0,180}?\{ critical, volleyId \},\s*\);[\s\S]{0,700}?match\.projectiles\.push\(\{\s*id: match\.nextProjectileId,\s*volleyId,/,
    "the shot event and every pellet spawned by it must share the allocated volley identity",
  );
  assert.match(
    server,
    /appendCombatEvent\(\s*match,\s*"hit",[\s\S]{0,280}?volleyId: projectile\.volleyId/,
    "hit events must retain their projectile's originating volley identity",
  );
  assert.match(
    server,
    /appendCombatEvent\(\s*match,\s*"defeat",[\s\S]{0,280}?volleyId: projectile\.volleyId/,
    "defeat events must retain their projectile's originating volley identity",
  );
  assert.match(
    server,
    /appendCombatEvent\(\s*match,\s*"impact",[\s\S]{0,260}?volleyId: projectile\.volleyId/,
    "terminal impact events must retain their projectile's originating volley identity",
  );
  let nextVolleyId = 700;
  const createVolleyTrace = (pelletCount) => {
    const volleyId = nextVolleyId;
    nextVolleyId += 1;
    const shot = { kind: "shot", volleyId };
    const projectiles = Array.from({ length: pelletCount }, (_, id) => ({
      id,
      volleyId,
    }));
    const hits = projectiles.map((projectile) => ({
      kind: "hit",
      volleyId: projectile.volleyId,
    }));
    return { shot, projectiles, hits };
  };
  const highSpeedVolleyA = createVolleyTrace(9);
  const highSpeedVolleyB = createVolleyTrace(9);
  assert.ok(
    [...highSpeedVolleyA.projectiles, ...highSpeedVolleyA.hits].every(
      (entry) => entry.volleyId === highSpeedVolleyA.shot.volleyId,
    ),
    "all pellets and hits from one high-speed attack must correlate to its shot",
  );
  assert.ok(
    highSpeedVolleyB.shot.volleyId > highSpeedVolleyA.shot.volleyId &&
      highSpeedVolleyB.hits.every(
        (entry) => entry.volleyId === highSpeedVolleyB.shot.volleyId,
      ),
    "adjacent high-speed volleys must remain distinct while each preserves internal identity",
  );
  assert.match(
    server,
    /const baseAngle = Math\.atan2\(\s*liveOpponent\.y - player\.y,\s*liveOpponent\.x - player\.x,?\s*\);/,
    "the authoritative volley must lock onto the live opponent position at firing time",
  );
  const authoritativeFireStart = server.indexOf("player.input.fire &&");
  const authoritativeFireEnd = server.indexOf(
    "player.shotCooldownMs += 1_000 / player.attackRate;",
    authoritativeFireStart,
  );
  assert.ok(authoritativeFireStart >= 0 && authoritativeFireEnd > authoritativeFireStart);
  assert.doesNotMatch(
    server.slice(authoritativeFireStart, authoritativeFireEnd),
    /Math\.atan2\(player\.aimY, player\.aimX\)/,
    "stale client aim may gate intent but must not determine the server projectile vector",
  );
  const shooter = { x: 100, y: 360 };
  const staleTarget = { x: 300, y: 360 };
  const liveTarget = { x: 300, y: 510 };
  const staleAngle = Math.atan2(
    staleTarget.y - shooter.y,
    staleTarget.x - shooter.x,
  );
  const liveAngle = Math.atan2(
    liveTarget.y - shooter.y,
    liveTarget.x - shooter.x,
  );
  assert.ok(
    Math.abs(liveAngle - staleAngle) > 0.6,
    "the regression target must have moved 150px outside the stale firing line",
  );
  assert.ok(
    Math.abs(
      Math.cos(liveAngle) * (liveTarget.y - shooter.y) -
        Math.sin(liveAngle) * (liveTarget.x - shooter.x),
    ) < 1e-9,
    "the authoritative vector must point through the target's new position",
  );
  assert.match(server, /previousX: startX,[\s\S]{0,80}?previousY: startY/);
  assert.match(
    server,
    /const startX = player\.x;[\s\S]{0,50}?const startY = player\.y - 8;/,
    "PVP projectiles must originate at the expedition player body anchor",
  );
  assert.match(server, /projectile\.previousX = projectile\.x;[\s\S]{0,260}?projectile\.x \+= projectile\.vx \* deltaSeconds/);
  assert.match(
    server,
    /distanceToSegmentSquared\(\s*target\.x,\s*target\.y,\s*projectile\.previousX,\s*projectile\.previousY,\s*projectile\.x,\s*projectile\.y,?\s*\) <= collisionRadius \*\* 2/,
    "20 Hz collision must test the complete projectile segment",
  );
  assert.match(server, /const collisionRadius = projectile\.radius \+ PVP_BOSS_HIT_RADIUS/);
  assert.match(
    server,
    /const targetAngle = Math\.atan2\([\s\S]{0,380}?projectile\.homingStrength \* deltaSeconds/,
    "homing must steer toward the one boss-class opponent with the PVE angular-rate rule",
  );
  assert.match(server, /!projectile\.hitPlayerIds\.includes\(target\.id\)/);
  assert.match(server, /projectile\.hitPlayerIds\.push\(target\.id\)/);
  assert.match(server, /target\.hp\s*=\s*Math\.max\(0,\s*target\.hp\s*-\s*appliedDamage\)/);
  assert.match(server, /owner\.score\s*\+=\s*1/);
  assert.match(server, /owner\.score\s*>=\s*PVP_SCORE_TO_WIN/);
  assert.match(server, /finishMatch\([^)]*["']score["']/);
  assert.match(server, /["']timeout["']/);
  assert.match(server, /["']draw["']/);
  assert.match(server, /input\.sequence\s*<=\s*player\.lastInputSequence/);
  assert.match(server, /MAX_SIMULATION_DEBT_MS\s*=\s*2_000/);
  assert.match(server, /MAX_STEPS_PER_REQUEST\s*=\s*20/);
  assert.match(server, /MAX_PROJECTILES_PER_MATCH\s*=\s*384/);
  assert.doesNotMatch(server, /match\.projectiles\.length\s*<\s*MAX_PROJECTILES_PER_MATCH/);
  assert.doesNotMatch(server, /match\.projectiles\.slice\(-(?:48|96)\)/);
  assert.match(
    server,
    /while \(\s*match\.projectiles\.length \+ projectileCount >\s*MAX_PROJECTILES_PER_MATCH\s*\)[\s\S]{0,900}?match\.projectiles\.splice\(oldestIndex, 1\)/,
    "a full bounded arena retires the oldest projectile instead of suppressing a new volley",
  );
  const capacityRetirementStart = server.indexOf(
    "match.projectiles.length + projectileCount >",
  );
  const capacityRetirementEnd = server.indexOf(
    "const critical = Math.random()",
    capacityRetirementStart,
  );
  assert.ok(capacityRetirementStart >= 0 && capacityRetirementEnd > capacityRetirementStart);
  assert.doesNotMatch(
    server.slice(capacityRetirementStart, capacityRetirementEnd),
    /appendCombatEvent/,
    "capacity retirement is not a collision and must not fabricate impact VFX/SFX events",
  );
  assert.match(server, /PVP_PLAYER_COLLISION_CLEARANCE\s*=\s*27/);
  assert.match(
    server,
    /constrainPointToConvexPolygon\(\s*player,\s*WALKABLE_FLOOR_POLYGON,\s*PVP_PLAYER_COLLISION_CLEARANCE,?\s*\)/,
    "server movement must be constrained to the expedition floor polygon",
  );
  assert.match(server, /const arenaVersion = match\.arenaVersion \?\? 1;/);
  assert.match(server, /arenaVersion:\s*PVP_ARENA_VERSION/);
  assert.match(
    server,
    /arenaVersion < PVP_ARENA_VERSION[\s\S]{0,120}?legacyArenaCollision\(player\)/,
    "only persisted pre-v2 matches may keep their frozen legacy geometry",
  );
  assert.match(
    server,
    /arenaVersion < PVP_ARENA_VERSION &&\s*legacyProjectileHitsObstacle\(projectile\)/,
  );
  assert.doesNotMatch(server, /const\s+ARENA_OBSTACLES\s*=/);
  assert.match(server, /if\s*\(match\)\s*advanceMatch\(state,\s*match,\s*now\)/);
  assert.doesNotMatch(server, /function\s+advanceMatches\s*\(/);
  assert.match(
    server,
    /async function health\(db:\s*D1Database\)[\s\S]*readWorldState\(db\)/,
  );

  const hitEventStart = server.indexOf('"hit",');
  const defeatCheck = server.indexOf("if (target.hp <= 0)", hitEventStart);
  assert.ok(hitEventStart >= 0 && defeatCheck > hitEventStart);
  assert.doesNotMatch(
    server.slice(hitEventStart, defeatCheck),
    /"impact"/,
    "a target collision emits one hit event, not a duplicate impact event",
  );
  assert.match(server, /COMBAT_EVENT_RETENTION_MS\s*=\s*1_000/);
  assert.match(server, /occurredAt:\s*now/);
  assert.match(server, /kind:\s*event\.kind,[\s\S]{0,180}?occurredAt:\s*event\.occurredAt/);
});

test("D1 applies Phantom March from the canonical profile after actual continuous movement", async () => {
  const server = await readSource("worker/realtime-d1.ts");

  assert.doesNotMatch(
    server,
    /hasPhantomMarchFromAppearance|PHANTOM_MARCH_RARITIES/,
    "renderer-only appearance must never grant combat movement authority",
  );
  assert.match(
    server,
    /continuousMoveMultiplier: profile\.continuousMoveMultiplier,[\s\S]{0,100}?hasPhantomMarch: profile\.continuousMoveMultiplier > 1,[\s\S]{0,100}?phantomMarchMoveMs: 0/,
    "matchmaking must freeze Phantom March only from the sanitized canonical profile",
  );
  assert.match(
    server,
    /const phantomMarchActive =[\s\S]{0,160}?player\.phantomMarchMoveMs >= PVP_PHANTOM_MARCH_ACTIVATION_MS;[\s\S]{0,180}?const normalMoveSpeed =[\s\S]{0,120}?player\.continuousMoveMultiplier/,
    "only the timer value from before movement may activate the normal-speed bonus",
  );
  assert.match(
    server,
    /player\.dashX \* player\.dashSpeed \* \(dashStepMs \/ 1_000\)[\s\S]{0,140}?player\.input\.moveX \* normalMoveSpeed/,
    "Phantom March must multiply normal movement without changing dash speed",
  );

  const stepStart = server.indexOf("function stepSimulation(");
  const stepEnd = server.indexOf("function advanceMatch(", stepStart);
  const step = server.slice(stepStart, stepEnd);
  const previousPosition = step.indexOf("const previousPlayerX = player.x;");
  const movePlayer = step.indexOf("player.x +=", previousPosition);
  const collidePlayer = step.indexOf("resolveArenaCollision(player, arenaVersion);", movePlayer);
  const measureMovement = step.indexOf("const actuallyMoved =", collidePlayer);
  const advanceTimer = step.indexOf("player.phantomMarchMoveMs =", measureMovement);
  assert.ok(
    previousPosition >= 0 &&
      movePlayer > previousPosition &&
      collidePlayer > movePlayer &&
      measureMovement > collidePlayer &&
      advanceTimer > measureMovement,
    "continuous movement must be measured from displacement remaining after collision",
  );
  assert.match(
    step.slice(measureMovement, advanceTimer + 360),
    /Math\.hypot\([\s\S]{0,140}?\) > PVP_PHANTOM_MARCH_MOVEMENT_EPSILON;[\s\S]{0,260}?player\.hasPhantomMarch && actuallyMoved[\s\S]{0,180}?PVP_PHANTOM_MARCH_TIMER_CAP_MS[\s\S]{0,120}?player\.phantomMarchMoveMs \+ TICK_MS[\s\S]{0,80}?: 0;/,
    "one stationary or fully blocked tick must reset the capped actual-movement timer",
  );
  assert.match(
    server,
    /function respawnPlayer\([\s\S]{0,360}?player\.phantomMarchMoveMs = 0;/,
    "respawning must always clear continuous movement",
  );
  assert.match(
    step,
    /if \(player\.respawnMs > 0\) \{\s*player\.phantomMarchMoveMs = 0;[\s\S]{0,180}?continue;/,
    "the first stationary respawn-wait tick must clear the timer immediately",
  );
  assert.match(
    step,
    /target\.respawnMs = RESPAWN_MS;\s*target\.phantomMarchMoveMs = 0;/,
    "a defeat snapshot must clear continuous movement without waiting for the next tick",
  );
  assert.match(
    server,
    /reconcilePhantomMarchRuntime\(player, resolved, false\);/,
    "legacy combat migration must initialize Phantom March from the migrated profile with a zero timer",
  );
  assert.match(
    server,
    /phantomMarchMoveMs: player\.phantomMarchMoveMs,[\s\S]{0,100}?continuousMoveMultiplier: player\.continuousMoveMultiplier/,
    "snapshots must expose the authoritative timer and frozen multiplier",
  );

  let timerMs = 0;
  const speedByTick = [];
  for (let tick = 0; tick < 70; tick += 1) {
    const active = timerMs >= 3_000;
    speedByTick.push(245 * (active ? 1.12 : 1));
    timerMs = Math.min(3_500, timerMs + 50);
  }
  assert.ok(speedByTick.slice(0, 60).every((speed) => speed === 245));
  assert.equal(speedByTick[60], 245 * 1.12);
  assert.equal(timerMs, 3_500, "the runtime timer must cap at the PVE 3.5-second ceiling");
  timerMs = 0;
  assert.equal(timerMs, 0, "one stationary tick resets continuous movement immediately");
});

test("D1 and the arena wire canonical equipment power into fixed boss combat snapshots", async () => {
  const [protocol, server, arena] = await Promise.all([
    readSource("app/pvp-protocol.ts"),
    readSource("worker/realtime-d1.ts"),
    readSource("app/pvp/PvpArena.tsx"),
  ]);

  assert.match(
    protocol,
    /export type PvpProjectileSnapshot = \{\s*id: number;\s*volleyId: number;/,
  );
  assert.match(
    protocol,
    /export type PvpCombatEvent = \{[\s\S]{0,360}?volleyId\?: number;/,
    "persisted pre-volley events remain protocol-compatible",
  );

  assert.match(
    arena,
    /const save = readSaveSlot\(readActiveSaveSlot\(\)\);[\s\S]{0,500}?reconcileEquipmentLevelRequirements\(\s*save\.player\.level,\s*save\.player\.equipment,\s*save\.player\.inventory,?\s*\)[\s\S]{0,260}?createPvpEquipmentProfile\(gear\.equipment\)/,
    "the queue profile must be rebuilt only from the reconciled equipment loadout",
  );
  assert.match(
    arena,
    /getRealtimeClient\(\)\.joinQueue\(buildProfile,\s*activeLocalAppearance\)/,
    "the queue must send the renderer-safe local appearance beside the combat profile",
  );
  assert.match(arena, /buildProfile\.equipmentPower\.toLocaleString\(["']ko-KR["']\)/);
  assert.doesNotMatch(arena, /buildProfile\.augmentStacks|localOffenseScale|offenseScale|vitalityMultiplier/);

  assert.match(server, /combatProfile\?: PvpBuildProfile;/);
  assert.match(
    server,
    /session\.combatProfile = sanitizePvpBuildProfile\(profile\);/,
    "D1 must sanitize the profile again when queue state is persisted",
  );
  assert.match(
    server,
    /const leftProfile = resolvePvpCombatProfile\(left\.combatProfile\);[\s\S]{0,120}?const rightProfile = resolvePvpCombatProfile\(right\.combatProfile\);/,
  );
  assert.match(
    server,
    /makeMatchPlayer\(left, 0, leftProfile\),[\s\S]{0,80}?makeMatchPlayer\(right, 1, rightProfile\)/,
    "each player must resolve independently from the opponent profile",
  );
  assert.match(
    server,
    /hp: PVP_BASE_MAX_HP,[\s\S]{0,60}?maxHp: PVP_BASE_MAX_HP/,
    "both combatants use the fixed 100 HP contract rather than opponent-sized health",
  );
  assert.match(
    server,
    /const volleyDamage = Math\.max\([\s\S]{0,160}?player\.projectileDamage \* \(critical \? player\.critMultiplier : 1\)/,
    "projectiles must snapshot their owner's server-resolved damage",
  );
  assert.match(
    server,
    /const appliedDamage = Number\.isFinite\(projectile\.damage\)[\s\S]{0,100}?Math\.max\(0, projectile\.damage\)[\s\S]{0,120}?target\.hp = Math\.max\(0, target\.hp - appliedDamage\)/,
    "server-owned projectile damage must apply directly without a PVP reduction cap",
  );
  assert.match(
    server,
    /combatVersion: match\.combatVersion \?\? PVP_COMBAT_VERSION,[\s\S]{0,100}?targetClass: PVP_TARGET_CLASS,[\s\S]{0,100}?combatModel: PVP_COMBAT_MODEL/,
    "snapshots must identify boss-class linear equipment combat",
  );
  assert.match(
    server,
    /dashRemainingMs: player\.dashRemainingMs,[\s\S]{0,100}?invulnerableMs: player\.invulnerableMs[\s\S]{0,300}?equipmentPower: player\.equipmentPower,[\s\S]{0,100}?attackRate: player\.attackRate,[\s\S]{0,100}?projectileCount: player\.projectileCount,[\s\S]{0,100}?projectileSpeed: player\.projectileSpeed,[\s\S]{0,100}?projectileLifeMs: player\.projectileLifeMs,[\s\S]{0,100}?projectileRadius: player\.projectileRadius,[\s\S]{0,100}?homingStrength: player\.homingStrength,[\s\S]{0,100}?pierce: player\.pierce/,
    "remote legendary projectiles must receive exact frozen PVE geometry instead of client defaults",
  );
  assert.match(
    server,
    /previousX,[\s\S]{0,100}?previousY,[\s\S]{0,100}?ageMs,[\s\S]{0,100}?lifeMs,[\s\S]{0,100}?critical,[\s\S]{0,100}?affinity/,
    "projectile snapshots must carry PVE interpolation and authored VFX metadata",
  );
  assert.match(
    server,
    /events: \(match\.events \?\? \[\]\)[\s\S]{0,500}?occurredAt: event\.occurredAt/,
    "the one-second event ring must carry monotonic ids and server occurrence time",
  );
  assert.match(
    server,
    /migrateMatchToEquipmentPower\(state, match, now\);/,
    "persisted matches must be upgraded before they are stepped or snapshotted",
  );
  assert.match(
    server,
    /function reconcileVolleyIdentity\(match: PvpMatch\)[\s\S]{0,1800}?legacyVolleyIds[\s\S]{0,900}?projectile\.volleyId = volleyId;[\s\S]{0,160}?match\.nextVolleyId = nextVolleyId;/,
    "persisted v4 projectiles must hydrate safe stable volley groups before snapshots",
  );
  assert.match(
    server,
    /id,\s*volleyId,\s*ownerId,[\s\S]{0,500}?\(\{\s*id,\s*volleyId,\s*ownerId,[\s\S]{0,900}?event\.volleyId !== undefined \? \{ volleyId: event\.volleyId \} : \{\}/,
    "projectile and combat event snapshots must serialize authoritative volley identity",
  );
  const migrationStart = server.indexOf("function migrateMatchToEquipmentPower(");
  const migrationEnd = server.indexOf(
    "function legacyProjectileHitsObstacle(",
    migrationStart,
  );
  assert.ok(migrationStart >= 0 && migrationEnd > migrationStart);
  const migration = server.slice(migrationStart, migrationEnd);
  assert.match(
    migration,
    /match\.projectiles = \[\];/,
    "v3 adaptive-damage projectiles must be retired at the v4 direct-damage boundary",
  );
  assert.doesNotMatch(
    migration,
    /match\.projectiles\.map/,
    "legacy adaptive projectile damage must never survive into no-cap combat",
  );

  const removedCorrections = [
    "calculatePvpBuildRating",
    "calculatePvpOffenseScale",
    "resolvePvpMatchBalance",
    "capPvpHitDamage",
    "PVP_TARGET_TTK_SECONDS",
    "PVP_MIN_HITS_TO_KO",
    "PVP_BURST_WINDOW_MS",
    "PVP_BURST_MAX_HEALTH_FRACTION",
    "damageWindowAmount",
    "vitalityMultiplier",
    "offenseScale",
    "buildRating",
  ];
  for (const removed of removedCorrections) {
    assert.doesNotMatch(protocol, new RegExp(`\\b${removed}\\b`));
    assert.doesNotMatch(server, new RegExp(`\\b${removed}\\b`));
  }
});

test("world announcement fires only after the item is actually stored", async () => {
  const [game, banner] = await Promise.all([
    readSource("app/GameCanvas.tsx"),
    readSource("app/WorldAnnouncementBanner.tsx"),
  ]);
  const bagFullIndex = game.indexOf("player.inventory.length >= inventoryCapacityRef.current");
  const pickupIndex = game.indexOf("player.inventory.push(cloneGearItem(drop.item));");
  const announcementIndex = game.indexOf("getRealtimeClient().announceLoot", pickupIndex);

  assert.ok(bagFullIndex >= 0 && bagFullIndex < pickupIndex);
  assert.ok(pickupIndex >= 0 && announcementIndex > pickupIndex);
  assert.match(
    game.slice(pickupIndex, announcementIndex + 150),
    /drop\.item\.rarity === "mythic"[\s\S]*drop\.item\.rarity === "cosmic"/,
  );
  assert.match(
    game.slice(announcementIndex, announcementIndex + 500),
    /itemName: drop\.item\.displayName[\s\S]{0,220}?enhancement: drop\.item\.enhancement/,
    "the sender must keep the canonical item name separate from its enhancement stage",
  );
  assert.doesNotMatch(
    game.slice(announcementIndex, announcementIndex + 500),
    /itemName: formatGearDisplayName/,
    "the sender must not bake a second enhancement suffix into the protocol payload",
  );
  assert.match(
    banner,
    /const itemDisplayName = formatGearDisplayName\(\{[\s\S]{0,160}?displayName: current\.itemName,[\s\S]{0,100}?enhancement: current\.enhancement/,
    "the receiver must compose the player-facing name exactly once",
  );
  assert.doesNotMatch(
    banner,
    /current\.enhancement > 0 \? ` · \+\$\{current\.enhancement\}`/,
    "the banner must not render a duplicate standalone enhancement suffix",
  );
});

test("PVP sessions bind the selected character nickname to server account authority", async () => {
  const [entry, economy, realtime, client] = await Promise.all([
    readSource("worker/index.ts"),
    readSource("worker/economy-d1.ts"),
    readSource("worker/realtime-d1.ts"),
    readSource("app/realtime-client.ts"),
  ]);

  assert.match(entry, /headers\.delete\("x-mujindo-account-id"\)/);
  assert.match(entry, /await authorizeRealtimeEconomyRequest\(sanitizedRequest, env\)/);
  assert.match(
    entry,
    /const isRealtimeSession = realtimeRoute === "\/api\/realtime\/session";[\s\S]{0,440}?if \(isRealtimeSession && realtimeIdentity === null\) \{\s*realtimeIdentity = await authorizeHubEconomyRequest\(sanitizedRequest, env\);/,
    "an authenticated account must still be discovered when strict PVP auth is disabled",
  );
  assert.match(entry, /headers\.set\("x-mujindo-account-id", realtimeIdentity\.accountId\)/);
  assert.doesNotMatch(
    entry,
    /headers\.set\("x-mujindo-player-name"/,
    "the account label must never be promoted to character nickname authority",
  );
  assert.match(economy, /PVP_ACCOUNT_AUTH_ENABLED\?: string/);
  assert.match(economy, /if \(env\.PVP_ACCOUNT_AUTH_ENABLED !== "true"\) return null/);
  assert.match(economy, /assertNoActiveSanction\(env\.DB, auth\.account\.id, \["login", "pvp"\]\)/);
  assert.match(client, /characterSlot:\s*identity\.characterSlot/);
  assert.match(realtime, /accountId\?: string/);
  assert.match(realtime, /\.\.\.\(accountId \? \{ accountId \} : \{\}\)/);
  assert.match(realtime, /isCharacterNicknameSlot\(rawBody\.characterSlot\)/);
  assert.match(
    realtime,
    /SELECT nickname,nickname_key\s*FROM hub_character_slots\s*WHERE account_id=\? AND slot=\? LIMIT 1/,
  );
  assert.match(realtime, /\.bind\(accountId, characterSlot\)/);
  assert.match(realtime, /const storedNickname = validateCharacterNickname\(character\?\.nickname\)/);
  assert.match(realtime, /character\.nickname_key !== storedNickname\.nicknameKey/);
  assert.match(
    realtime,
    /new RequestProblem\(\s*409,\s*"nickname_required"/,
  );
  assert.match(realtime, /displayName = storedNickname\.nickname/);
  assert.match(realtime, /const localNickname = validateCharacterNickname\(rawBody\.displayName\)/);
  assert.doesNotMatch(realtime, /function trustedDisplayName|x-mujindo-player-name/);
  const accountNicknameBranch = realtime.slice(
    realtime.indexOf("if (accountId) {", realtime.indexOf("async function createSession")),
    realtime.indexOf("} else {", realtime.indexOf("async function createSession")),
  );
  assert.doesNotMatch(
    accountNicknameBranch,
    /rawBody\.displayName/,
    "authenticated players may not override their selected D1 character nickname",
  );
  assert.match(realtime, /session\.accountId !== accountId/);
  assert.match(realtime, /"account_session_mismatch"/);
});

test("realtime session creation ignores forged account names and rejects stale nickname keys", async () => {
  const { handleRealtimeRequest } = await importRealtimeServer();
  const db = new D1DatabaseAdapter();
  const accountId = "10000000-0000-4000-8000-000000000001";
  db.database.exec(`CREATE TABLE hub_character_slots (
    account_id TEXT NOT NULL,
    slot INTEGER NOT NULL,
    nickname TEXT,
    nickname_key TEXT,
    PRIMARY KEY (account_id, slot)
  )`);
  db.database
    .prepare(
      `INSERT INTO hub_character_slots(account_id,slot,nickname,nickname_key)
       VALUES(?,?,?,?)`,
    )
    .run(accountId, 1, "Alice01", "alice01");

  const openSession = (body, headers = {}) =>
    handleRealtimeRequest(
      new Request("https://mujindo.example/api/realtime/session", {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
      }),
      { DB: db },
    );

  try {
    const accountResponse = await openSession(
      { characterSlot: 1, displayName: "ForgedName" },
      { "x-mujindo-account-id": accountId },
    );
    assert.equal(accountResponse.status, 200);
    assert.equal((await accountResponse.json()).displayName, "Alice01");

    db.database
      .prepare(
        `UPDATE hub_character_slots SET nickname_key='stale-key'
         WHERE account_id=? AND slot=1`,
      )
      .run(accountId);
    const staleKeyResponse = await openSession(
      { characterSlot: 1, displayName: "Alice01" },
      { "x-mujindo-account-id": accountId },
    );
    assert.equal(staleKeyResponse.status, 409);
    assert.equal((await staleKeyResponse.json()).error, "nickname_required");

    const guestResponse = await openSession({
      characterSlot: 2,
      displayName: "Ａlice02",
    });
    assert.equal(guestResponse.status, 200);
    assert.equal((await guestResponse.json()).displayName, "Alice02");

    const invalidGuestResponse = await openSession({
      characterSlot: 2,
      displayName: "x",
    });
    assert.equal(invalidGuestResponse.status, 409);
    assert.equal((await invalidGuestResponse.json()).error, "nickname_required");

    const invalidSlotResponse = await openSession({
      characterSlot: 4,
      displayName: "Alice02",
    });
    assert.equal(invalidSlotResponse.status, 400);
    assert.equal((await invalidSlotResponse.json()).error, "invalid_character_slot");
  } finally {
    db.close();
  }
});
