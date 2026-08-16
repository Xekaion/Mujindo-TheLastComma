import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import ts from "typescript";
import { inflateSync } from "node:zlib";

const root = process.cwd();
const modulePath = "app/forbidden-indexer.ts";

async function importTypeScriptModule(relativePath) {
  const source = await readFile(path.join(root, relativePath), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: relativePath,
  }).outputText;
  return import(
    `data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`
  );
}

function decodeRgbaPng(png, relativePath) {
  assert.equal(
    png.subarray(0, 8).toString("hex"),
    "89504e470d0a1a0a",
    `${relativePath} must be a PNG`,
  );
  let offset = 8;
  let width = 0;
  let height = 0;
  const compressed = [];
  while (offset + 12 <= png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.subarray(offset + 4, offset + 8).toString("ascii");
    const start = offset + 8;
    const end = start + length;
    assert.ok(end + 4 <= png.length, `${relativePath} has a truncated ${type} chunk`);
    if (type === "IHDR") {
      width = png.readUInt32BE(start);
      height = png.readUInt32BE(start + 4);
      assert.equal(png[start + 8], 8, `${relativePath} must use 8-bit channels`);
      assert.equal(png[start + 9], 6, `${relativePath} must be RGBA`);
      assert.equal(png[start + 12], 0, `${relativePath} must not be interlaced`);
    } else if (type === "IDAT") {
      compressed.push(png.subarray(start, end));
    }
    offset = end + 4;
    if (type === "IEND") break;
  }
  assert.ok(width > 0 && height > 0 && compressed.length > 0);
  const stride = width * 4;
  const raw = inflateSync(Buffer.concat(compressed));
  assert.equal(raw.length, (stride + 1) * height);
  const pixels = Buffer.alloc(stride * height);
  const paeth = (left, above, upperLeft) => {
    const prediction = left + above - upperLeft;
    const leftDistance = Math.abs(prediction - left);
    const aboveDistance = Math.abs(prediction - above);
    const upperLeftDistance = Math.abs(prediction - upperLeft);
    if (leftDistance <= aboveDistance && leftDistance <= upperLeftDistance) return left;
    return aboveDistance <= upperLeftDistance ? above : upperLeft;
  };
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    assert.ok(filter <= 4, `${relativePath} uses PNG filter ${filter}`);
    const rawStart = y * (stride + 1) + 1;
    const outputStart = y * stride;
    for (let byte = 0; byte < stride; byte += 1) {
      const left = byte >= 4 ? pixels[outputStart + byte - 4] : 0;
      const above = y > 0 ? pixels[outputStart + byte - stride] : 0;
      const upperLeft = y > 0 && byte >= 4
        ? pixels[outputStart + byte - stride - 4]
        : 0;
      const predictor =
        filter === 0
          ? 0
          : filter === 1
            ? left
            : filter === 2
              ? above
              : filter === 3
                ? Math.floor((left + above) / 2)
                : paeth(left, above, upperLeft);
      pixels[outputStart + byte] = (raw[rawStart + byte] + predictor) & 0xff;
    }
  }
  return { width, height, pixels };
}

function cellBytes(image, column, row, columns, rows) {
  const cellWidth = image.width / columns;
  const cellHeight = image.height / rows;
  const bytes = Buffer.alloc(cellWidth * cellHeight * 4);
  let output = 0;
  for (let y = 0; y < cellHeight; y += 1) {
    for (let x = 0; x < cellWidth; x += 1) {
      const source =
        (((row * cellHeight + y) * image.width + column * cellWidth + x) * 4);
      image.pixels.copy(bytes, output, source, source + 4);
      output += 4;
    }
  }
  return bytes;
}

function cellMetrics(image, column, row, columns, rows) {
  const cellWidth = image.width / columns;
  const cellHeight = image.height / rows;
  let visible = 0;
  let transparent = 0;
  let brightGreen = 0;
  for (let y = 0; y < cellHeight; y += 1) {
    for (let x = 0; x < cellWidth; x += 1) {
      const offset =
        (((row * cellHeight + y) * image.width + column * cellWidth + x) * 4);
      const red = image.pixels[offset];
      const green = image.pixels[offset + 1];
      const blue = image.pixels[offset + 2];
      const alpha = image.pixels[offset + 3];
      if (alpha > 16) visible += 1;
      if (alpha === 0) transparent += 1;
      if (alpha > 16 && green > 180 && green > red + 70 && green > blue + 70) {
        brightGreen += 1;
      }
    }
  }
  return { visible, transparent, brightGreen, pixels: cellWidth * cellHeight };
}

function arrayLiteralElementCount(source, variableName) {
  const file = ts.createSourceFile(
    "GameCanvas.tsx",
    source,
    ts.ScriptTarget.ES2022,
    true,
    ts.ScriptKind.TSX,
  );
  let count = null;
  const unwrap = (initializer) => {
    let current = initializer;
    while (
      current &&
      (ts.isAsExpression(current) ||
        ts.isSatisfiesExpression(current) ||
        ts.isParenthesizedExpression(current))
    ) {
      current = current.expression;
    }
    return current && ts.isArrayLiteralExpression(current) ? current : null;
  };
  const visit = (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === variableName &&
      node.initializer
    ) {
      const array = unwrap(node.initializer);
      if (array) count = array.elements.length;
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  assert.notEqual(count, null, `${variableName} array is missing`);
  return count;
}

const baseInput = (overrides = {}) => ({
  dt: 0,
  seed: 73_911,
  castIndex: 0,
  bossPosition: { x: 640, y: 360 },
  previousPlayerPosition: { x: 820, y: 360 },
  playerPosition: { x: 820, y: 360 },
  playerRadius: 14,
  arena: { minX: 80, minY: 70, maxX: 1200, maxY: 650 },
  wallPadding: 20,
  ...overrides,
});

test("kind 13 follows Inkbound in the deep roster without disturbing floor one", async () => {
  const roster = await importTypeScriptModule("app/boss-roster.ts");
  for (const kind of [5, 9, 11, 12, 13]) assert.equal(roster.isBossKind(kind), true);
  assert.equal(roster.isBossKind(10), false);
  assert.equal(roster.isBossKind(14), false);
  assert.deepEqual(
    Array.from({ length: 9 }, (_, index) =>
      roster.bossKindForProgress(2, index + 1, 1),
    ),
    [9, 11, 5, 9, 11, 5, 9, 11, 5],
  );
  assert.deepEqual(
    Array.from({ length: 10 }, (_, index) =>
      roster.bossKindForProgress(2, index + 1, 2),
    ),
    [12, 13, 11, 5, 9, 12, 13, 11, 5, 9],
  );
  for (const floor of [1, 2, 99]) {
    assert.equal(roster.bossKindForProgress(1, 999, floor), 5);
  }
});

test("the Forbidden Indexer exposes a complete stronger boss contract", async () => {
  const boss = await importTypeScriptModule(modulePath);
  assert.equal(boss.FORBIDDEN_INDEXER_KIND, 13);
  assert.equal(boss.FORBIDDEN_INDEXER_DISPLAY_NAME, "금서의 색인관");
  assert.deepEqual(boss.FORBIDDEN_INDEXER_PATTERN_SEQUENCE, [
    "indexLances",
    "marginPrison",
    "eclipseRing",
  ]);
  assert.ok(boss.FORBIDDEN_INDEXER_BASE_HP > 780);
  assert.ok(boss.FORBIDDEN_INDEXER_BASE_DAMAGE > 18);
  assert.ok(boss.FORBIDDEN_INDEXER_RADIUS >= 60);
  assert.deepEqual(
    Object.keys(boss.FORBIDDEN_INDEXER_PATTERN_LABELS),
    boss.FORBIDDEN_INDEXER_PATTERN_SEQUENCE,
  );
  for (let index = 0; index < 12; index += 1) {
    assert.equal(
      boss.forbiddenIndexerPatternAt(index),
      boss.FORBIDDEN_INDEXER_PATTERN_SEQUENCE[index % 3],
    );
  }
  assert.equal(boss.forbiddenIndexerPatternAt(Number.NaN), "indexLances");
  assert.equal(boss.forbiddenIndexerPatternAt(Number.POSITIVE_INFINITY), "indexLances");
  const source = await readFile(path.join(root, modulePath), "utf8");
  assert.doesNotMatch(source, /Math\.random|performance\.now/);
});

test("seeded prison layout and arena clamps are deterministic and wall safe", async () => {
  const boss = await importTypeScriptModule(modulePath);
  const arena = { minX: 100, minY: 50, maxX: 900, maxY: 550 };
  assert.deepEqual(
    boss.clampForbiddenIndexerPointToArena(
      { x: Number.NEGATIVE_INFINITY, y: 9_999 },
      arena,
      60,
      20,
    ),
    { x: 500, y: 470 },
  );
  const axis = boss.forbiddenIndexerMarginAxis(933, 4);
  const repeatedAxis = boss.forbiddenIndexerMarginAxis(933, 4);
  assert.equal(axis, repeatedAxis);
  const center = boss.forbiddenIndexerMarginSafeCenter(arena, axis, 933, 4, 110, 20);
  assert.equal(
    center,
    boss.forbiddenIndexerMarginSafeCenter(arena, axis, 933, 4, 110, 20),
  );
  const minimum = axis === "vertical" ? arena.minX : arena.minY;
  const maximum = axis === "vertical" ? arena.maxX : arena.maxY;
  assert.ok(center >= minimum + 130 && center <= maximum - 130);
});

test("lance, prison, and swept eclipse geometry include player radius and safe gaps", async () => {
  const boss = await importTypeScriptModule(modulePath);
  const lance = boss.forbiddenIndexerLanceSegment(
    { x: 100, y: 100 },
    { x: 500, y: 100 },
    1,
    600,
  );
  assert.equal(
    boss.forbiddenIndexerLanceHits({ x: 300, y: 129 }, 14, lance, 16),
    true,
  );
  assert.equal(
    boss.forbiddenIndexerLanceHits({ x: 300, y: 132 }, 14, lance, 16),
    false,
  );
  const arena = { minX: 0, minY: 0, maxX: 1000, maxY: 600 };
  assert.equal(
    boss.forbiddenIndexerMarginHits(
      { x: 500, y: 300 },
      14,
      arena,
      "vertical",
      500,
      1,
      110,
    ),
    false,
  );
  assert.equal(
    boss.forbiddenIndexerMarginHits(
      { x: 395, y: 300 },
      14,
      arena,
      "vertical",
      500,
      1,
      110,
    ),
    true,
  );
  const center = { x: 500, y: 300 };
  const ringRadius = 200;
  const safeAngle = 0;
  assert.equal(
    boss.forbiddenIndexerEclipseHits(
      { x: 700, y: 300 },
      { x: 700, y: 300 },
      10,
      center,
      ringRadius,
      safeAngle,
    ),
    false,
  );
  assert.equal(
    boss.forbiddenIndexerEclipseHits(
      { x: 300, y: 300 },
      { x: 300, y: 300 },
      10,
      center,
      ringRadius,
      safeAngle,
    ),
    true,
  );
  assert.equal(
    boss.forbiddenIndexerEclipseHits(
      { x: 500, y: 40 },
      { x: 500, y: 560 },
      10,
      center,
      ringRadius,
      safeAngle,
    ),
    true,
    "a movement segment crossing the ring must not tunnel through it",
  );
});

test("all three patterns remain harmless in telegraph and emit bounded authored attacks", async () => {
  const boss = await importTypeScriptModule(modulePath);

  let state = boss.createForbiddenIndexerState({ phaseTimer: 0, patternIndex: 0 });
  let step = boss.advanceForbiddenIndexer(state, baseInput());
  assert.equal(step.state.phase, "telegraph");
  assert.deepEqual(step.commands.map((command) => command.type), ["telegraph"]);
  assert.equal(step.commands.some((command) => command.type === "damage"), false);
  const lanceCommands = [];
  for (let index = 0; index < 3; index += 1) {
    state = boss.createForbiddenIndexerState({ ...step.state, phaseTimer: 0 });
    step = boss.advanceForbiddenIndexer(state, baseInput());
    lanceCommands.push(...step.commands);
  }
  assert.equal(lanceCommands.filter((command) => command.type === "indexLance").length, 3);
  assert.ok(lanceCommands.filter((command) => command.type === "damage").length <= 1);

  state = boss.createForbiddenIndexerState({ phaseTimer: 0, patternIndex: 1 });
  step = boss.advanceForbiddenIndexer(state, baseInput({ castIndex: 2 }));
  assert.equal(step.state.phase, "telegraph");
  assert.equal(step.commands.some((command) => command.type === "damage"), false);
  state = boss.createForbiddenIndexerState({ ...step.state, phaseTimer: 0 });
  step = boss.advanceForbiddenIndexer(state, baseInput({ castIndex: 2 }));
  assert.equal(step.state.phase, "marginPrison");
  assert.ok(step.commands.some((command) => command.type === "marginPrison"));
  let marginDamage = 0;
  for (let index = 0; index < 2; index += 1) {
    step = boss.advanceForbiddenIndexer(
      step.state,
      baseInput({
        dt: boss.FORBIDDEN_INDEXER_MARGIN_SECONDS / 2,
        castIndex: 2,
        previousPlayerPosition: { x: 82, y: 72 },
        playerPosition: { x: 82, y: 72 },
      }),
    );
    marginDamage += step.commands.filter((command) => command.type === "damage").length;
  }
  assert.equal(marginDamage, 1);

  state = boss.createForbiddenIndexerState({ phaseTimer: 0, patternIndex: 2 });
  step = boss.advanceForbiddenIndexer(state, baseInput({ castIndex: 7 }));
  assert.equal(step.state.phase, "telegraph");
  assert.equal(step.commands.some((command) => command.type === "damage"), false);
  const eclipseCommands = [];
  for (let pulse = 0; pulse < boss.FORBIDDEN_INDEXER_ECLIPSE_RADII.length; pulse += 1) {
    const radius = boss.FORBIDDEN_INDEXER_ECLIPSE_RADII[pulse];
    const safeAngle = boss.forbiddenIndexerEclipseSafeAngle(73_911, 7, pulse);
    const playerPosition = {
      x: 640 + Math.cos(safeAngle + Math.PI) * radius,
      y: 360 + Math.sin(safeAngle + Math.PI) * radius,
    };
    state = boss.createForbiddenIndexerState({ ...step.state, phaseTimer: 0 });
    step = boss.advanceForbiddenIndexer(
      state,
      baseInput({
        castIndex: 7,
        previousPlayerPosition: playerPosition,
        playerPosition,
      }),
    );
    eclipseCommands.push(...step.commands);
  }
  assert.equal(eclipseCommands.filter((command) => command.type === "eclipseRing").length, 3);
  assert.equal(eclipseCommands.filter((command) => command.type === "damage").length, 3);

  const bounded = boss.advanceForbiddenIndexer(
    boss.createForbiddenIndexerState({ phaseTimer: 0 }),
    baseInput({ dt: Number.POSITIVE_INFINITY }),
  );
  assert.ok(bounded.commands.length <= 32);
});

test("corrupt state and input values are sanitized into a finite bounded reducer state", async () => {
  const boss = await importTypeScriptModule(modulePath);
  const corrupt = boss.createForbiddenIndexerState({
    phase: "not-a-phase",
    pattern: "not-a-pattern",
    phaseTimer: Number.NaN,
    phaseElapsed: Number.POSITIVE_INFINITY,
    patternIndex: Number.NaN,
    castIndex: Number.NEGATIVE_INFINITY,
    strikeIndex: Number.POSITIVE_INFINITY,
    pulseIndex: Number.POSITIVE_INFINITY,
    origin: { x: Number.NaN, y: Number.POSITIVE_INFINITY },
    anchor: { x: Number.NEGATIVE_INFINITY, y: Number.NaN },
    safeCenter: Number.NaN,
    safeAngle: Number.POSITIVE_INFINITY,
    hitTokens: ["ok", 4, null],
  });
  assert.equal(corrupt.phase, "pursuit");
  assert.equal(corrupt.pattern, "indexLances");
  const step = boss.advanceForbiddenIndexer(
    corrupt,
    baseInput({
      dt: Number.POSITIVE_INFINITY,
      seed: Number.NaN,
      castIndex: Number.POSITIVE_INFINITY,
      bossPosition: { x: Number.NaN, y: Number.POSITIVE_INFINITY },
      previousPlayerPosition: { x: Number.NaN, y: Number.NEGATIVE_INFINITY },
      playerPosition: { x: Number.NEGATIVE_INFINITY, y: Number.NaN },
      playerRadius: Number.NaN,
      arena: {
        minX: Number.NaN,
        minY: Number.POSITIVE_INFINITY,
        maxX: Number.NEGATIVE_INFINITY,
        maxY: Number.NaN,
      },
    }),
  );
  for (const value of [
    step.state.phaseTimer,
    step.state.phaseElapsed,
    step.state.patternIndex,
    step.state.castIndex,
    step.state.strikeIndex,
    step.state.pulseIndex,
    step.state.origin.x,
    step.state.origin.y,
    step.state.anchor.x,
    step.state.anchor.y,
    step.state.safeCenter,
    step.state.safeAngle,
  ]) {
    assert.ok(Number.isFinite(value), `${value} must be finite`);
  }
  assert.ok(step.commands.length <= 32);
});

test("walk and pattern atlases are RGBA, crop-safe, chroma-clean, and correctly registered", async () => {
  const configs = [
    {
      path: "public/assets/walk/forbidden-indexer-walk-v1.png",
      size: [1024, 1536],
      columns: 4,
      rows: 8,
      minimumVisible: 2_500,
      minimumUnique: 28,
    },
    {
      path: "public/assets/effects/forbidden-indexer-patterns-v1.png",
      size: [2048, 1024],
      columns: 4,
      rows: 2,
      minimumVisible: 8_000,
      minimumUnique: 8,
    },
  ];
  for (const config of configs) {
    const png = await readFile(path.join(root, config.path));
    const image = decodeRgbaPng(png, config.path);
    assert.deepEqual([image.width, image.height], config.size);
    const hashes = new Set();
    let green = 0;
    for (let row = 0; row < config.rows; row += 1) {
      for (let column = 0; column < config.columns; column += 1) {
        const metrics = cellMetrics(image, column, row, config.columns, config.rows);
        assert.ok(metrics.visible >= config.minimumVisible, `${config.path} ${row},${column} is empty`);
        assert.ok(metrics.transparent / metrics.pixels >= 0.12, `${config.path} ${row},${column} needs compositing room`);
        green += metrics.brightGreen;
        hashes.add(
          createHash("sha256")
            .update(cellBytes(image, column, row, config.columns, config.rows))
            .digest("hex"),
        );
        const cellWidth = image.width / config.columns;
        const cellHeight = image.height / config.rows;
        for (const [x, y] of [
          [column * cellWidth, row * cellHeight],
          [(column + 1) * cellWidth - 1, row * cellHeight],
          [column * cellWidth, (row + 1) * cellHeight - 1],
          [(column + 1) * cellWidth - 1, (row + 1) * cellHeight - 1],
        ]) {
          assert.equal(image.pixels[(y * image.width + x) * 4 + 3], 0);
        }
      }
    }
    assert.ok(hashes.size >= config.minimumUnique, `${config.path} repeats too many frames`);
    assert.equal(green, 0, `${config.path} retains green-key pixels`);
  }

  const walkPng = await readFile(path.join(root, configs[0].path));
  const walk = decodeRgbaPng(walkPng, configs[0].path);
  const cellWidth = walk.width / 4;
  const cellHeight = walk.height / 8;
  for (let column = 0; column < 4; column += 1) {
    for (let y = 0; y < cellHeight; y += 1) {
      for (let x = 0; x < cellWidth; x += 1) {
        const southWest =
          (((1 * cellHeight + y) * walk.width + column * cellWidth + x) * 4);
        const southEast =
          (((7 * cellHeight + y) * walk.width + column * cellWidth + (cellWidth - 1 - x)) * 4);
        assert.deepEqual(
          walk.pixels.subarray(southWest, southWest + 4),
          walk.pixels.subarray(southEast, southEast + 4),
        );
      }
    }
  }
});

test("GameCanvas aligns kind 13 data, controller, floor VFX, and HUD state", async () => {
  const source = await readFile(path.join(root, "app/GameCanvas.tsx"), "utf8");
  const rendererStart = source.indexOf("const drawForbiddenIndexerPattern");
  const rendererEnd = source.indexOf("const drawTimeRiftSprite", rendererStart);
  assert.ok(rendererStart >= 0 && rendererEnd > rendererStart);
  const renderer = source.slice(rendererStart, rendererEnd);
  assert.match(renderer, /-size \/ 2,[\s\S]{0,80}?-size \/ 2,[\s\S]{0,80}?size,[\s\S]{0,40}?size,/);
  assert.match(
    renderer,
    /const sourceCapHeight = sourceHeight \/ 4;[\s\S]{0,240}?const scale = width \/ sourceHalfWidth;[\s\S]{0,1500}?while \(destinationY < middleEndY - 0\.01\)/,
    "prison half-cells must use a uniformly scaled three-slice instead of stretching",
  );
  assert.match(
    renderer,
    /const drawLanceCell = \([\s\S]{0,500}?const sourceCapWidth = sourceWidth \/ 4;[\s\S]{0,900}?while \(destinationX < middleEndX - 0\.01\)/,
    "lances must animate through an authored three-slice instead of enlarging one square cell",
  );
  assert.match(
    renderer,
    /drawLanceCell\([\s\S]{0,220}?active \? 168 : 116 \+ progress \* 18/,
  );
  assert.doesNotMatch(
    renderer,
    /drawCell\(\s*active \? 1 : 0,\s*0,|\n\s*154,\n\s*longSide/,
    "Forbidden Indexer atlas cells must never be independently stretched on each axis",
  );
  const enemyKind = source.match(/type\s+EnemyKind\s*=([\s\S]*?);/);
  assert.ok(enemyKind);
  const kinds = [...enemyKind[1].matchAll(/\b(\d+)\b/g)].map((match) => Number(match[1]));
  assert.deepEqual(
    [...new Set(kinds)].sort((left, right) => left - right),
    Array.from({ length: 14 }, (_, kind) => kind),
  );
  for (const arrayName of ["ENEMY_NAMES", "WALK_IMAGE_KEYS", "ENEMY_DIRECTION_FRAMES"]) {
    assert.equal(arrayLiteralElementCount(source, arrayName), 14);
  }
  assert.match(source, /walkForbiddenIndexer:\s*["']\/assets\/walk\/forbidden-indexer-walk-v1\.png["']/);
  assert.match(source, /forbiddenIndexerPatterns:\s*["']\/assets\/effects\/forbidden-indexer-patterns-v1\.png["']/);
  const eagerImageTable = source.slice(
    source.indexOf("const imagePaths: Record<string, string>"),
    source.indexOf("for (const [name, source] of gameplayVfxImageEntries())"),
  );
  assert.doesNotMatch(
    eagerImageTable,
    /walkForbiddenIndexer|forbiddenIndexerPatterns/,
    "deep-floor Forbidden Indexer atlases must not inflate the initial expedition load",
  );
  assert.match(
    source,
    /if \(hud\.world\.bossKind !== FORBIDDEN_INDEXER_KIND\) return;[\s\S]{0,700}?deferredBossImages[\s\S]{0,700}?imagesRef\.current\[name\] = image;/,
    "the active Forbidden Indexer room must lazily register both authored atlases",
  );
  assert.match(
    source,
    /enemyVfxShowcaseMode !== "forbidden-indexer"[\s\S]{0,3000}?createForbiddenIndexerState\(\{[\s\S]{0,240}?phase: "telegraph"/,
    "localhost must expose a storage-free authored Forbidden Indexer animation showcase",
  );
  const entrySource = await readFile(path.join(root, "app/GameEntryFlow.tsx"), "utf8");
  assert.match(
    entrySource,
    /requestedEnemyMode === "forbidden-indexer"/,
    "the entry gate must pass the storage-free Forbidden Indexer showcase through",
  );
  assert.match(source, /indexer\?:\s*ForbiddenIndexerState/);
  assert.match(source, /kind\s*===\s*FORBIDDEN_INDEXER_KIND[\s\S]{0,180}?createForbiddenIndexerState\(/);
  assert.equal(
    (source.match(/else if \(enemy\.kind === FORBIDDEN_INDEXER_KIND\)/g) ?? []).length,
    2,
    "one update branch and one floor-render branch are expected",
  );
  assert.match(source, /advanceForbiddenIndexer\(currentIndexer/);
  assert.match(
    source,
    /enemy\.kind\s*===\s*FORBIDDEN_INDEXER_KIND[\s\S]{0,120}?enemy\.indexer\?\.phase\s*===\s*["']pursuit["']/,
  );
  const floorDraw = source.indexOf(
    "drawForbiddenIndexerPattern(images.forbiddenIndexerPatterns, enemy)",
  );
  const actors = source.indexOf("const sortedEnemies = [...world.enemies].sort", floorDraw);
  assert.ok(floorDraw >= 0 && actors > floorDraw);
  assert.match(source, /indexerPattern:\s*null\s+as\s+ForbiddenIndexerPattern\s*\|\s*null/);
  assert.match(source, /indexerPhase:\s*boss\?\.indexer\?\.phase\s*\?\?\s*null/);
  assert.match(source, /FORBIDDEN_INDEXER_PATTERN_LABELS\[hud\.world\.indexerPattern\]/);
  assert.match(source, /금단의 색인/);
});
