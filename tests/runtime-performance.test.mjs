import assert from "node:assert/strict";
import test from "node:test";
import ts from "typescript";
import { readFile } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();

async function importTypeScriptModule(relativePath) {
  const source = await readFile(path.join(root, relativePath), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: relativePath,
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);
}

test("hot-path array compaction preserves identity and ordering", async () => {
  const { compactArrayInPlace, compactPositiveFieldInPlace } = await importTypeScriptModule(
    "app/runtime-performance.ts",
  );
  const first = { id: 1, active: true };
  const discarded = { id: 2, active: false };
  const last = { id: 3, active: true };
  const values = [first, discarded, last];
  const identity = values;

  compactArrayInPlace(values, (value) => value.active);

  assert.equal(values, identity);
  assert.deepEqual(values, [first, last]);
  assert.equal(values[0], first);
  assert.equal(values[1], last);

  const effects = [{ life: 1 }, { life: 0 }, { life: -1 }, { life: 0.5 }];
  compactPositiveFieldInPlace(effects, "life");
  assert.deepEqual(effects, [{ life: 1 }, { life: 0.5 }]);
});

test("nearest-target scan ignores dead and excluded enemies without sorting", async () => {
  const { findNearestAliveEntity, findNearestUnhitAliveEntity } = await importTypeScriptModule(
    "app/runtime-performance.ts",
  );
  const enemies = [
    { id: 1, x: 2, y: 0, hp: 10 },
    { id: 2, x: 1, y: 0, hp: 0 },
    { id: 3, x: 4, y: 0, hp: 10 },
    { id: 4, x: 3, y: 0, hp: 10 },
  ];

  assert.equal(findNearestAliveEntity(enemies, 0, 0, 1, 5)?.id, 4);
  assert.equal(findNearestAliveEntity(enemies, 0, 0, 1, 2), undefined);
  assert.equal(findNearestUnhitAliveEntity(enemies, 0, 0, new Set([1]))?.id, 4);
});

test("dense friendly projectile trails are budgeted while hostile warnings remain", async () => {
  const { shouldDrawProjectileTrail } = await importTypeScriptModule(
    "app/runtime-performance.ts",
  );

  assert.equal(shouldDrawProjectileTrail(7, false, 120), true);
  assert.equal(shouldDrawProjectileTrail(7, true, 500), true);
  const dense = Array.from({ length: 120 }, (_, index) =>
    shouldDrawProjectileTrail(index, false, 121),
  ).filter(Boolean).length;
  const overloaded = Array.from({ length: 120 }, (_, index) =>
    shouldDrawProjectileTrail(index, false, 221),
  ).filter(Boolean).length;
  assert.equal(dense, 60);
  assert.equal(overloaded, 20);
  const lateGameBudget = Array.from({ length: 486 }, (_, index) =>
    shouldDrawProjectileTrail(index, false, 486),
  ).filter(Boolean).length;
  assert.equal(lateGameBudget, 81);
});

test("projectile motion interpolation bridges fast movement with a bounded dense-scene budget", async () => {
  const { projectileMotionInterpolationSamples } = await importTypeScriptModule(
    "app/runtime-performance.ts",
  );

  const sparse = projectileMotionInterpolationSamples(0, 0, 48, 24, 6, 40, false);
  assert.ok(sparse.length > 0, "a fast projectile needs at least one in-between pose");
  assert.ok(sparse.length <= 3, "one projectile must not create an unbounded draw cost");
  let priorX = 0;
  for (const sample of sparse) {
    assert.ok(Number.isFinite(sample.x) && Number.isFinite(sample.y));
    assert.ok(sample.x > priorX && sample.x < 48, "samples must stay between simulation poses");
    assert.ok(sample.y > 0 && sample.y < 24);
    assert.ok(Math.abs(sample.y - sample.x / 2) < 1e-9, "samples must follow the swept path");
    priorX = sample.x;
  }

  const denseFriendly = projectileMotionInterpolationSamples(0, 0, 48, 24, 6, 300, false);
  const denseHostile = projectileMotionInterpolationSamples(0, 0, 48, 24, 6, 300, true);
  assert.ok(denseFriendly.length < sparse.length, "friendly interpolation must shed work when crowded");
  assert.ok(denseHostile.length > 0, "hostile projectile readability remains protected");
  assert.ok(denseHostile.length <= 3);
  assert.deepEqual(
    projectileMotionInterpolationSamples(12, 8, 12, 8, 6, 40, false),
    [],
    "stationary projectiles do not emit duplicate samples",
  );
});

test("swept-circle broad phase keeps boundary hits and rejects distant targets", async () => {
  const { sweptCircleMayOverlap } = await importTypeScriptModule(
    "app/runtime-performance.ts",
  );

  assert.equal(sweptCircleMayOverlap(0, 0, 10, 0, 5, 3, 3), true);
  assert.equal(sweptCircleMayOverlap(0, 0, 10, 0, 13, 0, 3), true);
  assert.equal(sweptCircleMayOverlap(0, 0, 10, 0, 5, 3.01, 3), false);
  assert.equal(sweptCircleMayOverlap(0, 0, 10, 0, -3.01, 0, 3), false);
});

test("swept-circle broad phase has no false negatives across a representative grid", async () => {
  const { sweptCircleMayOverlap } = await importTypeScriptModule(
    "app/runtime-performance.ts",
  );
  const segmentDistance = (targetX, targetY, startX, startY, endX, endY) => {
    const deltaX = endX - startX;
    const deltaY = endY - startY;
    const lengthSquared = deltaX * deltaX + deltaY * deltaY;
    const position =
      lengthSquared === 0
        ? 0
        : Math.max(
            0,
            Math.min(
              1,
              ((targetX - startX) * deltaX + (targetY - startY) * deltaY) /
                lengthSquared,
            ),
          );
    return Math.hypot(
      targetX - (startX + deltaX * position),
      targetY - (startY + deltaY * position),
    );
  };

  const segments = [
    [0, 0, 10, 0],
    [0, 0, 7, 9],
    [8, -4, -3, 11],
    [2, 2, 2, 2],
  ];
  for (const [startX, startY, endX, endY] of segments) {
    for (let targetX = -8; targetX <= 16; targetX += 0.5) {
      for (let targetY = -10; targetY <= 18; targetY += 0.5) {
        if (segmentDistance(targetX, targetY, startX, startY, endX, endY) > 3) {
          continue;
        }
        assert.equal(
          sweptCircleMayOverlap(startX, startY, endX, endY, targetX, targetY, 3),
          true,
          `rejected exact hit at (${targetX}, ${targetY})`,
        );
      }
    }
  }
});

test("expedition hot path wires caches and visual budgets without skipping cores", async () => {
  const source = await readFile(path.join(root, "app/GameCanvas.tsx"), "utf8");

  assert.match(source, /cached\.equipment === equipment/);
  assert.match(
    source,
    /cached\.equipmentItems\[index\] === equipment\[EQUIPMENT_SLOTS\[index\]\]/,
  );
  assert.match(source, /getEquipmentRuntimeCache\(player\.equipment\)\.stats/);
  assert.match(
    source,
    /player\.inventory\.length !== gearSnapshotCache\.inventoryItems\.length/,
  );
  assert.match(source, /sweptCircleMayOverlap\([\s\S]*?distanceToSegment\(/);
  assert.match(source, /shouldDrawProjectileTrail\([\s\S]*?"trail"/);
  assert.match(source, /projectileMotionInterpolationSamples\(/);
  assert.match(
    source,
    /for \(const projectile of world\.projectiles\) \{\s*drawProjectileVfx\(projectile, ambientTime, projectileCount, "core"\)/,
  );
  assert.equal(
    (source.match(/const roomVignette = context\.createRadialGradient/g) ?? []).length,
    1,
  );
});
