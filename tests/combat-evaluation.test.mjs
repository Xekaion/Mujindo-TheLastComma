import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import ts from "typescript";

const source = await readFile(
  path.join(process.cwd(), "app/combat-evaluation.ts"),
  "utf8",
);
const javascript = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ES2022,
  },
}).outputText;
const evaluation = await import(
  `data:text/javascript;base64,${Buffer.from(javascript).toString("base64")}`
);

const baseline = Object.freeze({
  sheetAttackPower: 14,
  theoreticalFireRate: 1.4,
  theoreticalProjectileCount: 1,
  critChance: 0.05,
  critMultiplier: 1.7,
  overchargeAverageMultiplier: 1,
  projectileSpreadDegrees: 4.01,
  projectileRadius: 5,
  projectileSpeed: 660,
  projectileRange: 759,
  homing: 0,
  bossMultiplier: 1,
  executeThreshold: 0,
  executeMultiplier: 1,
  timeEchoBonus: 0,
  returnBonus: 0,
  poisonDps: 0,
  legendaryProcBonusDps: 0,
  threeTargetDps: 20.286,
  survivalBudget: 100,
  moveSpeed: 245,
  dashCooldown: 1.35,
  dashDistance: 153,
});

const rate = (overrides) =>
  evaluation.calculateCombatEvaluation({ ...baseline, ...overrides });

test("version-two baseline is exactly the perfect-hit boss DPS rating", () => {
  const result = rate({});
  assert.equal(evaluation.BOSS_CONVERSION_VERSION, 2);
  assert.equal(result.version, 2);
  assert.equal(result.sheetAttackPower, 14);
  assert.ok(Math.abs(result.statAttackDps - 20.286) < 1e-12);
  assert.equal(result.standardBossDps, result.statAttackDps);
  assert.equal(result.hitRate, 1);
  assert.equal(
    result.standardBossDamage60,
    result.standardBossDps * 60,
  );
  assert.equal(
    result.combatPower,
    Math.round(
      result.standardBossDps * evaluation.COMBAT_POWER_PER_BOSS_DPS,
    ),
  );
  assert.equal(result.combatPower, 1_000);
  assert.deepEqual(
    {
      distance: result.bossBreakdown.standardDistance,
      radius: result.bossBreakdown.standardRadius,
      defense: result.bossBreakdown.standardDefense,
    },
    { distance: 260, radius: 52, defense: 0 },
  );
});

test("attack speed raises DPS without rewriting sheet attack power", () => {
  const normal = rate({});
  const fast = rate({ theoreticalFireRate: 2.8 });
  assert.equal(fast.sheetAttackPower, normal.sheetAttackPower);
  assert.equal(fast.statAttackDps, normal.statAttackDps * 2);
  assert.equal(fast.standardBossDps, normal.standardBossDps * 2);
  assert.equal(fast.combatPower, normal.combatPower * 2);
});

test("boss multiplier affects the boss conversion, not unconditional stat DPS", () => {
  const normal = rate({});
  const bossGear = rate({ bossMultiplier: 1.35 });
  assert.equal(bossGear.statAttackDps, normal.statAttackDps);
  assert.ok(
    Math.abs(bossGear.standardBossDps - normal.standardBossDps * 1.35) <
      1e-12,
  );
  assert.ok(bossGear.combatPower > normal.combatPower);
});

test("every offensive boss-DPS source raises power on the exact linear scale", () => {
  const reference = rate({});
  for (const [label, overrides] of [
    ["attack damage", { sheetAttackPower: 21 }],
    ["attack speed", { theoreticalFireRate: 2.1 }],
    ["projectile count", { theoreticalProjectileCount: 3 }],
    ["critical chance", { critChance: 0.5 }],
    ["critical damage", { critMultiplier: 2.5 }],
    ["overcharge", { overchargeAverageMultiplier: 1.4 }],
    ["primary condition", { standardPrimaryDamageMultiplier: 1.3 }],
    ["final damage", { finalDamageMultiplier: 1.2 }],
    ["boss damage", { bossMultiplier: 1.25 }],
    ["execution", { executeThreshold: 0.3, executeMultiplier: 2 }],
    ["time echo", { timeEchoBonus: 0.3 }],
    ["returning projectile", { returnBonus: 0.4 }],
    ["poison", { poisonDps: 12 }],
    ["offensive legendary proc", { legendaryProcBonusDps: 12 }],
  ]) {
    const result = rate(overrides);
    assert.ok(
      result.standardBossDps > reference.standardBossDps,
      `${label} must raise boss DPS`,
    );
    assert.ok(result.combatPower > reference.combatPower, `${label} must raise power`);
    assert.equal(
      result.combatPower,
      Math.round(
        result.standardBossDps * evaluation.COMBAT_POWER_PER_BOSS_DPS,
      ),
      `${label} must use the exact boss-DPS scale`,
    );
  }
});

test("every non-offense input leaves perfect-hit combat power unchanged", () => {
  const reference = rate({});
  const nonOffenseOverrides = [
    ["survival budget", { survivalBudget: 1_000_000 }],
    ["three-target throughput", { threeTargetDps: 1_000_000 }],
    ["projectile render geometry", { projectileGeometryCount: 90 }],
    ["spread", { projectileSpreadDegrees: 359 }],
    ["projectile size", { projectileRadius: 500 }],
    ["projectile speed", { projectileSpeed: 50_000 }],
    ["projectile range", { projectileRange: 50_000 }],
    ["homing", { homing: 1_000 }],
    ["echo accuracy hint", { timeEchoHitRate: 0 }],
    ["move speed", { moveSpeed: 10_000 }],
    ["dash cooldown", { dashCooldown: 0.05 }],
    ["dash distance", { dashDistance: 10_000 }],
  ];

  for (const [label, overrides] of nonOffenseOverrides) {
    const result = rate(overrides);
    assert.equal(result.hitRate, 1, `${label} must keep the perfect-hit contract`);
    assert.equal(
      result.standardBossDps,
      reference.standardBossDps,
      `${label} must not alter boss DPS`,
    );
    assert.equal(
      result.combatPower,
      reference.combatPower,
      `${label} must not alter combat power`,
    );
  }
});

test("execute conversion uses the time-to-kill harmonic factor", () => {
  const threshold = 0.3;
  const multiplier = 2;
  const expected = 1 / ((1 - threshold) + threshold / multiplier);
  const result = rate({
    executeThreshold: threshold,
    executeMultiplier: multiplier,
  });
  assert.ok(Math.abs(result.executeFactor - expected) < 1e-12);
});

test("standard-boss hit rate is monotone in size, homing, speed, and range", () => {
  const geometry = {
    theoreticalProjectileCount: 9,
    projectileSpreadDegrees: 80,
    projectileRadius: 2,
    projectileSpeed: 240,
    projectileRange: 180,
    homing: 0,
  };
  const hitRate = (overrides) =>
    evaluation.calculateStandardBossHitRate({ ...geometry, ...overrides });
  const base = hitRate({});
  const bigger = hitRate({ projectileRadius: 48 });
  const homing = hitRate({ homing: 4 });
  const faster = hitRate({ projectileSpeed: 900 });
  const longer = hitRate({ projectileRange: 520 });
  assert.ok(bigger >= base, `${bigger} should be >= ${base}`);
  assert.ok(homing >= base, `${homing} should be >= ${base}`);
  assert.ok(faster > base, `${faster} should be > ${base}`);
  assert.ok(longer > base, `${longer} should be > ${base}`);
});

test("theoretical projectile count has no renderer cap", () => {
  const nine = rate({
    theoreticalProjectileCount: 9,
    projectileSpreadDegrees: 0,
  });
  const ninety = rate({
    theoreticalProjectileCount: 90,
    projectileSpreadDegrees: 0,
  });
  assert.equal(ninety.statAttackDps, nine.statAttackDps * 10);
  assert.ok(
    Math.abs(ninety.standardBossDps - nine.standardBossDps * 10) < 1e-9,
  );
});

test("render geometry and applied damage-over-time stay separate from theoretical throughput", () => {
  const renderedNine = rate({
    theoreticalProjectileCount: 90,
    projectileGeometryCount: 9,
    projectileSpreadDegrees: 80,
    poisonDps: 10,
  });
  const renderedNinety = rate({
    theoreticalProjectileCount: 90,
    projectileGeometryCount: 90,
    projectileSpreadDegrees: 80,
    poisonDps: 10,
  });
  assert.equal(renderedNine.statAttackDps, renderedNinety.statAttackDps);
  assert.equal(renderedNine.hitRate, 1);
  assert.equal(renderedNinety.hitRate, 1);
  assert.equal(renderedNine.standardBossDps, renderedNinety.standardBossDps);
  assert.equal(renderedNine.combatPower, renderedNinety.combatPower);
  assert.equal(
    renderedNine.bossBreakdown.poisonDps,
    10,
    "the caller supplies already-applied poison uptime; projectile hit rate must not be charged twice",
  );
});

test("standard primary conditions propagate to derived attacks without double-buffing applied dots", () => {
  const normal = rate({
    timeEchoBonus: 0.2,
    timeEchoHitRate: 0.5,
    returnBonus: 0.3,
    poisonDps: 10,
  });
  const conditional = rate({
    standardPrimaryDamageMultiplier: 2,
    timeEchoBonus: 0.2,
    timeEchoHitRate: 0.5,
    returnBonus: 0.3,
    poisonDps: 10,
  });
  assert.equal(conditional.statAttackDps, normal.statAttackDps * 2);
  assert.equal(
    conditional.bossBreakdown.primaryDps,
    normal.bossBreakdown.primaryDps * 2,
  );
  assert.equal(
    conditional.bossBreakdown.timeEchoDps,
    normal.bossBreakdown.timeEchoDps * 2,
  );
  assert.equal(
    conditional.bossBreakdown.returnDps,
    normal.bossBreakdown.returnDps * 2,
  );
  assert.equal(
    conditional.bossBreakdown.poisonDps,
    normal.bossBreakdown.poisonDps,
  );
});

test("non-finite and hostile numeric inputs are sanitized", () => {
  const result = evaluation.calculateCombatEvaluation({
    ...baseline,
    sheetAttackPower: Number.NaN,
    theoreticalFireRate: Number.POSITIVE_INFINITY,
    theoreticalProjectileCount: -50,
    critChance: 50,
    critMultiplier: Number.NEGATIVE_INFINITY,
    projectileRadius: Number.NaN,
    projectileSpeed: -1,
    projectileRange: Number.POSITIVE_INFINITY,
    bossMultiplier: Number.NaN,
    survivalBudget: -100,
    dashCooldown: 0,
  });
  const numbers = [
    result.sheetAttackPower,
    result.statAttackDps,
    result.standardBossDps,
    result.standardBossDamage60,
    result.combatPower,
    result.hitRate,
    result.executeFactor,
    ...Object.values(result.bossBreakdown),
  ];
  assert.ok(numbers.every((value) => Number.isFinite(value) && value >= 0));
});
