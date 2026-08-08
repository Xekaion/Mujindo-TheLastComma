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

test("version-one baseline preserves sheet attack and theoretical stat DPS", () => {
  const result = rate({});
  assert.equal(evaluation.BOSS_CONVERSION_VERSION, 1);
  assert.equal(result.version, 1);
  assert.equal(result.sheetAttackPower, 14);
  assert.ok(Math.abs(result.statAttackDps - 20.286) < 1e-12);
  assert.ok(result.standardBossDps > 19 && result.standardBossDps < 20.286);
  assert.equal(
    result.standardBossDamage60,
    result.standardBossDps * 60,
  );
  assert.ok(result.combatPower >= 980 && result.combatPower <= 1_010);
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
});

test("boss multiplier affects the boss conversion, not unconditional stat DPS", () => {
  const normal = rate({});
  const bossGear = rate({ bossMultiplier: 1.35 });
  assert.equal(bossGear.statAttackDps, normal.statAttackDps);
  assert.ok(
    Math.abs(bossGear.standardBossDps - normal.standardBossDps * 1.35) <
      1e-12,
  );
});

test("survival budget changes only the composite combat power", () => {
  const fragile = rate({ survivalBudget: 50 });
  const sturdy = rate({ survivalBudget: 200 });
  assert.equal(sturdy.sheetAttackPower, fragile.sheetAttackPower);
  assert.equal(sturdy.statAttackDps, fragile.statAttackDps);
  assert.equal(sturdy.standardBossDps, fragile.standardBossDps);
  assert.equal(sturdy.hitRate, fragile.hitRate);
  assert.ok(sturdy.combatPower > fragile.combatPower);
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
  const base = rate(geometry).hitRate;
  const bigger = rate({ ...geometry, projectileRadius: 48 }).hitRate;
  const homing = rate({ ...geometry, homing: 4 }).hitRate;
  const faster = rate({ ...geometry, projectileSpeed: 900 }).hitRate;
  const longer = rate({ ...geometry, projectileRange: 520 }).hitRate;
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
  assert.notEqual(renderedNine.hitRate, renderedNinety.hitRate);
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
