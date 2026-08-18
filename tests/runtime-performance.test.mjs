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

test("continuous frame work keeps a stable high-refresh display divisor", async () => {
  const {
    CONTINUOUS_FRAME_MIN_INTERVAL_MS,
    shouldProcessContinuousFrame,
  } = await importTypeScriptModule("app/runtime-performance.ts");

  assert.equal(CONTINUOUS_FRAME_MIN_INTERVAL_MS, 10);
  assert.equal(shouldProcessContinuousFrame(100, 109.998), false);
  assert.equal(
    shouldProcessContinuousFrame(100, 109.9995),
    true,
    "sub-microsecond timestamp drift must not lose an otherwise due frame",
  );
  assert.equal(shouldProcessContinuousFrame(100, 110), true);
  assert.equal(shouldProcessContinuousFrame(100, 100), false);
  assert.equal(shouldProcessContinuousFrame(Number.NEGATIVE_INFINITY, 0), true);
  assert.equal(shouldProcessContinuousFrame(100, 99), true, "clock rollback resets the gate");
  assert.equal(shouldProcessContinuousFrame(100, Number.NaN), false);

  const durationMs = 10_000;
  const expectations = new Map([
    [60, 600],
    [75, 750],
    [90, 900],
    [120, 600],
    [144, 720],
    [165, 825],
    [240, 800],
  ]);
  for (const [refreshRate, expectedProcessed] of expectations) {
    const callbackInterval = 1_000 / refreshRate;
    const callbackCount = Math.floor(durationMs / callbackInterval + 1e-9);
    let lastProcessedAt = Number.NEGATIVE_INFINITY;
    let processed = 0;
    for (let callback = 0; callback < callbackCount; callback += 1) {
      const now = callback * callbackInterval;
      if (!shouldProcessContinuousFrame(lastProcessedAt, now)) continue;
      lastProcessedAt = now;
      processed += 1;
    }
    assert.ok(
      Math.abs(processed - expectedProcessed) <= 1,
      `${refreshRate} Hz processed ${processed} callbacks instead of about ${expectedProcessed}`,
    );
    assert.ok(
      processed <= durationMs / CONTINUOUS_FRAME_MIN_INTERVAL_MS + 1,
      `${refreshRate} Hz exceeded the continuous-work ceiling`,
    );
    if (refreshRate <= 90) {
      assert.equal(
        processed,
        callbackCount,
        `${refreshRate} Hz must process every display callback`,
      );
    }
  }
});

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

test("canvas backing resolution follows rendered pixels with a bounded memory ceiling", async () => {
  const {
    canvasBackingDimensions,
    MAX_CANVAS_BACKING_SCALE,
    MAX_CONTINUOUS_GAMEPLAY_BACKING_SCALE,
    MAX_PLAZA_BACKING_SCALE,
  } =
    await importTypeScriptModule("app/canvas-performance.ts");

  assert.equal(MAX_CANVAS_BACKING_SCALE, 2);
  assert.equal(MAX_CONTINUOUS_GAMEPLAY_BACKING_SCALE, 1.5);
  assert.equal(MAX_PLAZA_BACKING_SCALE, 1.25);
  assert.deepEqual(
    canvasBackingDimensions(1280, 720, 1920, 1080, 1),
    { width: 1920, height: 1080, scale: 1.5 },
    "a 1080p game plane must render at native 1080p instead of stretching 720p",
  );
  assert.deepEqual(
    canvasBackingDimensions(1280, 720, 960, 540, 2),
    { width: 1920, height: 1080, scale: 1.5 },
    "high-DPI windowed mode should retain the pixels its display can show",
  );
  assert.deepEqual(
    canvasBackingDimensions(1280, 720, 3840, 2160, 1),
    { width: 2560, height: 1440, scale: 2 },
    "4K rendering must stay under the two-times backing-store memory cap",
  );
  assert.deepEqual(
    canvasBackingDimensions(1280, 720, 640, 360, 1),
    { width: 1280, height: 720, scale: 1 },
    "small windows keep the authored canvas rather than throwing away source detail",
  );
  assert.deepEqual(
    canvasBackingDimensions(1920, 1080, 3840, 2160, 1, MAX_PLAZA_BACKING_SCALE),
    { width: 2400, height: 1350, scale: 1.25 },
    "the plaza must never recreate its former 4K backing surface",
  );
});

test("canvas and measured overlays retain a resize fallback without ResizeObserver", async () => {
  for (const relativePath of [
    "app/GameCanvas.tsx",
    "app/pvp/PvpArena.tsx",
    "app/PlazaHub.tsx",
    "app/InventoryOverlay.tsx",
  ]) {
    const source = await readFile(path.join(root, relativePath), "utf8");
    assert.match(
      source,
      /typeof ResizeObserver === "undefined"/,
      `${relativePath} must not abort its layout effect when ResizeObserver is unavailable`,
    );
  }
  for (const relativePath of [
    "app/GameCanvas.tsx",
    "app/pvp/PvpArena.tsx",
    "app/PlazaHub.tsx",
  ]) {
    const source = await readFile(path.join(root, relativePath), "utf8");
    assert.match(
      source,
      /window\.addEventListener\("resize",/,
      `${relativePath} must retain a browser resize fallback`,
    );
  }
  const portrait = await readFile(
    path.join(root, "app/InventoryPaperdollFigure.tsx"),
    "utf8",
  );
  assert.match(portrait, /data-portrait-mode="illustrated"/);
  assert.doesNotMatch(
    portrait,
    /ResizeObserver|window\.addEventListener\("resize"|<canvas/,
    "the static illustrated portrait must not own a measured canvas lifecycle",
  );
  const expedition = await readFile(path.join(root, "app/GameCanvas.tsx"), "utf8");
  assert.match(
    expedition,
    /const canvas = canvasRef\.current;[\s\S]{0,900}?resizeBackingStore\(\);[\s\S]{0,220}?\}, \[started\]\);/,
    "the backing-store effect must rerun when the menu creates the expedition canvas",
  );
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
  const {
    projectileMotionInterpolationCount,
    projectileMotionInterpolationSamples,
  } = await importTypeScriptModule("app/runtime-performance.ts");

  const sparse = projectileMotionInterpolationSamples(0, 0, 48, 24, 6, 40, false);
  assert.equal(sparse.length, 1, "a friendly projectile gets at most one in-between pose");
  let priorX = 0;
  for (const sample of sparse) {
    assert.ok(Number.isFinite(sample.x) && Number.isFinite(sample.y));
    assert.ok(sample.x > priorX && sample.x < 48, "samples must stay between simulation poses");
    assert.ok(sample.y > 0 && sample.y < 24);
    assert.ok(Math.abs(sample.y - sample.x / 2) < 1e-9, "samples must follow the swept path");
    priorX = sample.x;
  }

  const sparseHostile = projectileMotionInterpolationSamples(0, 0, 48, 24, 6, 40, true);
  const crowdedFriendly = projectileMotionInterpolationSamples(0, 0, 48, 24, 6, 97, false);
  const protectedHostile = projectileMotionInterpolationSamples(0, 0, 48, 24, 6, 160, true);
  const crowdedHostile = projectileMotionInterpolationSamples(0, 0, 48, 24, 6, 161, true);
  assert.equal(sparseHostile.length, 2, "a hostile projectile gets at most two warning poses");
  assert.deepEqual(crowdedFriendly, [], "friendly interpolation stops above 96 projectiles");
  assert.equal(protectedHostile.length, 2, "hostile readability remains protected through 160 projectiles");
  assert.deepEqual(crowdedHostile, [], "hostile interpolation stops above 160 projectiles");
  assert.deepEqual(
    projectileMotionInterpolationSamples(12, 8, 12, 8, 6, 40, false),
    [],
    "stationary projectiles do not emit duplicate samples",
  );

  assert.equal(projectileMotionInterpolationCount(0, 0, 48, 0, 6, 40, false), 1);
  assert.equal(projectileMotionInterpolationCount(0, 0, 48, 0, 6, 40, true), 2);
  assert.equal(projectileMotionInterpolationCount(0, 0, 48, 0, 6, 96, false), 1);
  assert.equal(projectileMotionInterpolationCount(0, 0, 48, 0, 6, 97, false), 0);
  assert.equal(projectileMotionInterpolationCount(0, 0, 48, 0, 6, 160, true), 2);
  assert.equal(projectileMotionInterpolationCount(0, 0, 48, 0, 6, 161, true), 0);
  assert.equal(projectileMotionInterpolationCount(0, 0, 16, 0, 6, 40, true), 0);
  assert.equal(projectileMotionInterpolationCount(0, 0, 16.01, 0, 6, 40, true), 1);
  assert.equal(projectileMotionInterpolationCount(Number.NaN, 0, 48, 0, 6, 40, true), 0);
  assert.equal(projectileMotionInterpolationCount(0, 0, 48, 0, 6, Number.POSITIVE_INFINITY, true), 0);

  for (const args of [
    [0, 0, 48, 24, 6, 40, false],
    [0, 0, 48, 24, 6, 40, true],
    [0, 0, 48, 24, 6, 96, false],
    [0, 0, 48, 24, 6, 97, false],
    [0, 0, 48, 24, 6, 160, true],
    [0, 0, 48, 24, 6, 161, true],
    [12, 8, 12, 8, 6, 40, false],
  ]) {
    assert.equal(
      projectileMotionInterpolationSamples(...args).length,
      projectileMotionInterpolationCount(...args),
      `sample API diverged from allocation-free count for ${args.join(",")}`,
    );
  }
});

test("projectile interpolation count has no array or sample-object allocation", async () => {
  const source = await readFile(path.join(root, "app/runtime-performance.ts"), "utf8");
  const sourceFile = ts.createSourceFile(
    "app/runtime-performance.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const declaration = sourceFile.statements.find(
    (statement) =>
      ts.isFunctionDeclaration(statement) &&
      statement.name?.text === "projectileMotionInterpolationCount",
  );
  assert.ok(declaration && ts.isFunctionDeclaration(declaration) && declaration.body);

  const allocations = [];
  const visit = (node) => {
    if (
      ts.isArrayLiteralExpression(node) ||
      ts.isObjectLiteralExpression(node) ||
      ts.isNewExpression(node)
    ) {
      allocations.push(node.getText(sourceFile));
    }
    ts.forEachChild(node, visit);
  };
  visit(declaration.body);
  assert.deepEqual(
    allocations,
    [],
    "the hot-path count helper must return a primitive without temporary containers",
  );

  const sampleDeclaration = sourceFile.statements.find(
    (statement) =>
      ts.isFunctionDeclaration(statement) &&
      statement.name?.text === "projectileMotionInterpolationSamples",
  );
  assert.ok(sampleDeclaration && ts.isFunctionDeclaration(sampleDeclaration));
  assert.match(
    sampleDeclaration.getText(sourceFile),
    /projectileMotionInterpolationCount\(/,
    "the compatibility sample API must reuse the allocation-free budget",
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
  assert.match(source, /projectileMotionInterpolationCount\(/);
  assert.doesNotMatch(source, /projectileMotionInterpolationSamples\(/);
  assert.match(source, /projectileCount <= 48/);
  assert.match(
    source,
    /for \(const projectile of world\.projectiles\) \{\s*drawProjectileVfx\(projectile, ambientTime, projectileCount, "core"\)/,
  );
  assert.equal(
    (source.match(/roomVignette = context\.createRadialGradient/g) ?? []).length,
    1,
  );
});

test("continuous canvases gate high-refresh work and freeze behind modal blur", async () => {
  const [game, plaza, pvp] = await Promise.all([
    readFile(path.join(root, "app/GameCanvas.tsx"), "utf8"),
    readFile(path.join(root, "app/PlazaHub.tsx"), "utf8"),
    readFile(path.join(root, "app/pvp/PvpArena.tsx"), "utf8"),
  ]);

  for (const [label, source] of [
    ["expedition", game],
    ["plaza", plaza],
    ["PVP", pvp],
  ]) {
    assert.match(
      source,
      /shouldProcessContinuousFrame\(lastProcessedFrameAt, (?:now|renderTime)\)/,
      `${label} must not multiply full work on high-refresh displays`,
    );
  }
  assert.match(
    game,
    /if \(simulationRunning\) \{[\s\S]{0,300}?update\(dt\);[\s\S]{0,100}?draw\(\);[\s\S]{0,500}?else if \(/,
    "the expedition should render one static frame, not a moving canvas, behind menus",
  );
  assert.match(
    plaza,
    /if \(pausedRef\.current \|\| document\.hidden\) \{[\s\S]{0,180}?requestAnimationFrame\(frame\);[\s\S]{0,40}?return;/,
    "the plaza should stop full rendering while a modal covers it",
  );
  assert.match(game, /MAX_CONTINUOUS_GAMEPLAY_BACKING_SCALE/);
  assert.match(pvp, /MAX_CONTINUOUS_GAMEPLAY_BACKING_SCALE/);
  assert.match(plaza, /MAX_PLAZA_BACKING_SCALE/);
});

test("authored VFX drawing avoids interpolation result and frame-closure allocation", async () => {
  const source = await readFile(path.join(root, "app/augment-vfx.ts"), "utf8");
  const start = source.indexOf("export function drawGameplayVfxFrame(");
  assert.ok(start >= 0);
  const body = source.slice(start);
  assert.doesNotMatch(body, /gameplayVfxFrameInterpolation\(/);
  assert.doesNotMatch(body, /const drawFrame\s*=/);
  assert.match(body, /const currentFrame =/);
});

test("expedition and PVP resize backing stores outside animation frames", async () => {
  const [game, pvp] = await Promise.all([
    readFile(path.join(root, "app/GameCanvas.tsx"), "utf8"),
    readFile(path.join(root, "app/pvp/PvpArena.tsx"), "utf8"),
  ]);

  for (const [label, source, endMarker] of [
    ["expedition", game, "const handleAim ="],
    ["PVP", pvp, "const handleAim ="],
  ]) {
    assert.match(source, /canvasBackingDimensions\(/, `${label} must size its backing store`);
    assert.match(source, /new ResizeObserver\(resizeBackingStore\)/);
    assert.match(source, /window\.addEventListener\("resize", resizeBackingStore\)/);
    assert.match(
      source,
      /context\.setTransform\(backingScale, 0, 0, backingScale, 0, 0\)/,
      `${label} must preserve its logical 1280 by 720 draw coordinates`,
    );
    const animationStart = Math.max(
      source.indexOf("const loop = (now: number) =>"),
      source.indexOf("const render = (renderTime: number) =>"),
    );
    assert.ok(animationStart >= 0, `${label} animation frame must exist`);
    assert.doesNotMatch(
      source.slice(animationStart, source.indexOf(endMarker, animationStart)),
      /getBoundingClientRect\(\)/,
      `${label} animation frames must reuse resize-time layout metrics`,
    );
  }

  assert.match(game, /image\.decoding = "async";[\s\S]{0,80}?image\.src = source;/);
  assert.match(
    game,
    /for \(const image of new Set\(Object\.values\(imagesRef\.current\)\)\)[\s\S]{0,220}?image\.removeAttribute\("src"\);[\s\S]{0,100}?imagesRef\.current = \{\};/,
    "expedition teardown must release its owned image elements",
  );
});

test("the plaza animation reuses bounded arrays and its viewport gradient", async () => {
  const source = await readFile(path.join(root, "app/PlazaHub.tsx"), "utf8");
  const frameStart = source.indexOf("const frame = (now: number) =>");
  assert.ok(frameStart >= 0);
  const frame = source.slice(frameStart, source.indexOf("const handleCanvasPointer"));

  assert.match(frame, /compactPositiveFieldInPlace\(skillEffectsRef\.current, "life"\)/);
  assert.doesNotMatch(
    frame,
    /skillEffectsRef\.current\s*=\s*skillEffectsRef\.current\.filter/,
  );
  assert.match(source, /const getViewportVignette =/);
  assert.match(frame, /context\.fillStyle = getViewportVignette\(width, height, dpr\)/);
  assert.match(
    source,
    /remoteRenderPointsRef\.current\.delete\(characterId\);\s*remoteWalkCyclesRef\.current\.delete\(characterId\);/,
    "departed plaza players must not leave an unbounded walk-cycle cache",
  );
  assert.equal(
    (frame.match(/context\.createRadialGradient\(/g) ?? []).length,
    0,
    "the viewport vignette must not allocate a new gradient inside each frame",
  );
});

test("scene paperdoll image stores initialize once per mount, not once per render", async () => {
  const sources = await Promise.all(
    ["app/GameCanvas.tsx", "app/PlazaHub.tsx", "app/pvp/PvpArena.tsx"].map(
      (relativePath) => readFile(path.join(root, relativePath), "utf8"),
    ),
  );
  for (const source of sources) {
    assert.match(source, /useState\(createBrowserPaperdollImageStore\)/);
    assert.doesNotMatch(source, /useRef\(createBrowserPaperdollImageStore\(\)\)/);
  }
});
