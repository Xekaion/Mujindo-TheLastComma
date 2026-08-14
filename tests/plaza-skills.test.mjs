import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import ts from "typescript";

const root = process.cwd();

const moduleUrl = (source) =>
  `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;

async function transpiledModuleUrl(relativePath, dependencyUrls = {}) {
  let source = await readFile(path.join(root, relativePath), "utf8");
  for (const [specifier, dependencyUrl] of Object.entries(dependencyUrls)) {
    source = source
      .replaceAll(`"${specifier}"`, JSON.stringify(dependencyUrl))
      .replaceAll(`'${specifier}'`, JSON.stringify(dependencyUrl));
  }
  return moduleUrl(
    ts.transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022,
      },
      fileName: relativePath,
    }).outputText,
  );
}

const equipmentUrl = await transpiledModuleUrl("app/equipment.ts");
const equipmentPromise = import(equipmentUrl);
const plazaSkillsPromise = import(
  await transpiledModuleUrl("app/plaza-skills.ts", {
    "./equipment": equipmentUrl,
  })
);

const closeTo = (actual, expected, epsilon = 1e-10) => {
  assert.ok(
    Math.abs(actual - expected) <= epsilon,
    `expected ${actual} to be within ${epsilon} of ${expected}`,
  );
};

test("plaza mobility keeps expedition dash constants and a safe null baseline", async () => {
  const plaza = await plazaSkillsPromise;
  assert.equal(plaza.PLAZA_DASH_DURATION_SECONDS, 0.17);
  assert.equal(plaza.PLAZA_DASH_BASE_SPEED, 900);
  assert.equal(plaza.PLAZA_DASH_BASE_COOLDOWN_SECONDS, 1.35);
  assert.equal(plaza.PLAZA_STARFALL_SECONDS, 4);
  assert.equal(plaza.PLAZA_PHANTOM_ACTIVATION_SECONDS, 3);
  assert.equal(plaza.PLAZA_PHANTOM_MOVE_MULTIPLIER, 1.12);
  assert.equal(plaza.PLAZA_RIFT_COOLDOWN_EFFICIENCY_PERCENT, 30);

  assert.deepEqual(plaza.resolvePlazaMobilityProfile(null), {
    moveSpeedPercent: 0,
    cosmicActionSpeedPercent: 0,
    dashSpeedPercent: 0,
    dashCooldownPercent: 0,
    moveSpeedMultiplier: 1,
    dashSpeed: 900,
    dashCooldownSeconds: 1.35,
    hasStarfallMantle: false,
    hasRiftStride: false,
    hasPhantomMarch: false,
  });
});

test("showcase loadout is deterministic, storage-free, and contains exactly the three plaza powers", async () => {
  const [equipment, plaza] = await Promise.all([
    equipmentPromise,
    plazaSkillsPromise,
  ]);
  const first = plaza.createPlazaSkillShowcaseEquipment();
  const second = plaza.createPlazaSkillShowcaseEquipment();
  assert.deepEqual(first, second);
  assert.equal(
    equipment.EQUIPMENT_SLOTS.filter((slot) => first[slot] !== null).length,
    3,
  );
  assert.deepEqual(
    equipment.equippedLegendaryPowers(first).sort(),
    ["phantomMarch", "riftStride", "starfallMantle"].sort(),
  );
  assert.equal(first.shoulders.legendaryPowerId, "starfallMantle");
  assert.equal(first.legs.legendaryPowerId, "phantomMarch");
  assert.equal(first.boots.legendaryPowerId, "riftStride");

  const profile = plaza.resolvePlazaMobilityProfile(first);
  const stats = equipment.aggregateEquipmentStats(first);
  assert.equal(profile.moveSpeedPercent, stats.moveSpeedPercent);
  assert.equal(
    profile.cosmicActionSpeedPercent,
    stats.cosmicActionSpeedPercent,
  );
  assert.equal(profile.dashSpeedPercent, stats.dashSpeedPercent);
  assert.equal(profile.dashCooldownPercent, stats.dashCooldownPercent);
  closeTo(
    profile.moveSpeedMultiplier,
    (1 + stats.moveSpeedPercent / 100) *
      (1 + stats.cosmicActionSpeedPercent / 100),
  );
  closeTo(profile.dashSpeed, 900 * (1 + stats.dashSpeedPercent / 100));
  closeTo(
    profile.dashCooldownSeconds,
    1.35 / ((1 + stats.dashCooldownPercent / 100) * 1.3),
  );
  assert.equal(profile.hasStarfallMantle, true);
  assert.equal(profile.hasRiftStride, true);
  assert.equal(profile.hasPhantomMarch, true);
});

test("plaza mobility clamps corrupted percentages and falls back from malformed equipment", async () => {
  const [equipment, plaza] = await Promise.all([
    equipmentPromise,
    plazaSkillsPromise,
  ]);
  const loadout = equipment.createEmptyEquipment();
  const item = equipment.rollGear("plaza-overflow-guard", {
    slot: "shoulders",
    rarity: "legendary",
    level: 100,
  });
  item.affixes = [
    { stat: "moveSpeedPercent", value: 1e12, rollPercent: 100, label: "" },
    {
      stat: "cosmicActionSpeedPercent",
      value: 1e12,
      rollPercent: 100,
      label: "",
    },
    { stat: "dashSpeedPercent", value: 1e12, rollPercent: 100, label: "" },
    {
      stat: "dashCooldownPercent",
      value: 1e12,
      rollPercent: 100,
      label: "",
    },
  ];
  loadout.shoulders = item;
  const profile = plaza.resolvePlazaMobilityProfile(loadout);
  assert.deepEqual(
    [
      profile.moveSpeedPercent,
      profile.cosmicActionSpeedPercent,
      profile.dashSpeedPercent,
      profile.dashCooldownPercent,
    ],
    [500, 500, 500, 500],
  );
  assert.ok(Number.isFinite(profile.moveSpeedMultiplier));
  assert.ok(Number.isFinite(profile.dashSpeed));
  assert.ok(Number.isFinite(profile.dashCooldownSeconds));
  assert.ok(profile.dashCooldownSeconds > 0);

  const malformed = equipment.createEmptyEquipment();
  malformed.weapon = { affixes: null };
  assert.deepEqual(
    plaza.resolvePlazaMobilityProfile(malformed),
    plaza.resolvePlazaMobilityProfile(null),
  );
});

test("dash direction maps all canonical facings and prefers normalized movement input", async () => {
  const plaza = await plazaSkillsPromise;
  const diagonal = Math.SQRT1_2;
  const expected = [
    [0, 1],
    [-diagonal, diagonal],
    [-1, 0],
    [-diagonal, -diagonal],
    [0, -1],
    [diagonal, -diagonal],
    [1, 0],
    [diagonal, diagonal],
  ];
  expected.forEach(([x, y], facing) => {
    const direction = plaza.plazaDashDirection(0, 0, facing);
    closeTo(direction.x, x);
    closeTo(direction.y, y);
  });

  const inputDirection = plaza.plazaDashDirection(3, 4, 2);
  closeTo(inputDirection.x, 0.6);
  closeTo(inputDirection.y, 0.8);
  closeTo(Math.hypot(inputDirection.x, inputDirection.y), 1);

  const hugeDirection = plaza.plazaDashDirection(
    Number.MAX_VALUE,
    -Number.MAX_VALUE,
    0,
  );
  closeTo(hugeDirection.x, diagonal);
  closeTo(hugeDirection.y, -diagonal);
  assert.deepEqual(plaza.plazaDashDirection(Number.NaN, Infinity, 6), {
    x: 1,
    y: 0,
  });
  assert.deepEqual(plaza.plazaDashDirection(0, 0, Number.NaN), {
    x: 0,
    y: 1,
  });
});
