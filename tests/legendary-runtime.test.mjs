import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import ts from "typescript";

const root = process.cwd();
const source = await readFile(path.join(root, "app/legendary-runtime.ts"), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ES2022,
  },
  fileName: "app/legendary-runtime.ts",
}).outputText;
const runtime = await import(
  `data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`
);

test("legendary proc counters trigger exactly on their configured cadence", () => {
  let count = 0;
  for (let hit = 1; hit <= 11; hit += 1) {
    const step = runtime.advanceLegendaryCounter(count, 12);
    assert.equal(step.triggered, false, `hit ${hit} must not trigger early`);
    count = step.count;
  }
  const twelfth = runtime.advanceLegendaryCounter(count, 12);
  assert.deepEqual(twelfth, { count: 0, triggered: true });
  assert.deepEqual(runtime.advanceLegendaryCounter(Number.NaN, 0), {
    count: 0,
    triggered: true,
  });
});

test("ashbound refresh, absorption, and expiry preserve every unrelated shield point", () => {
  const refreshed = runtime.refreshTrackedShield(50, 20, 200, 0.08);
  assert.deepEqual(refreshed, { shield: 46, trackedShield: 16 });

  const hit = runtime.absorbTrackedShield(
    refreshed.shield,
    refreshed.trackedShield,
    10,
  );
  assert.deepEqual(hit, {
    shield: 36,
    trackedShield: 6,
    damageAfterShield: 0,
    absorbed: 10,
  });
  assert.deepEqual(runtime.removeTrackedShield(hit.shield, hit.trackedShield), {
    shield: 30,
    trackedShield: 0,
  });

  const overflow = runtime.absorbTrackedShield(46, 16, 50);
  assert.deepEqual(overflow, {
    shield: 0,
    trackedShield: 0,
    damageAfterShield: 4,
    absorbed: 46,
  });
});

test("phantom march charges only during actual continuous movement", () => {
  assert.equal(runtime.advanceContinuousMovement(0, 1.5, true, 3), 1.5);
  assert.equal(runtime.advanceContinuousMovement(1.5, 1.5, true, 3), 3);
  assert.equal(runtime.advanceContinuousMovement(3, 8, true, 3), 3.5);
  assert.equal(runtime.advanceContinuousMovement(3.5, 1 / 60, false, 3), 0);
});

test("all five slot powers are connected to live GameCanvas runtime paths", async () => {
  const game = await readFile(path.join(root, "app/GameCanvas.tsx"), "utf8");
  for (const powerId of [
    "mirrorAegis",
    "starfallMantle",
    "bloodwovenGrip",
    "ashboundGirdle",
    "phantomMarch",
  ]) {
    assert.match(game, new RegExp(`hasLegendaryPower\\(player, ["']${powerId}["']\\)`));
  }
  assert.match(game, /advanceLegendaryCounter/);
  assert.match(game, /absorbTrackedShield/);
  assert.match(game, /advanceContinuousMovement/);
  assert.doesNotMatch(game, /setLineDash/);
});
