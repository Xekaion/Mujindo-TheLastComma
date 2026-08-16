import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";
import { inflateSync } from "node:zlib";

const root = process.cwd();
const modulePath = "app/inkbound-magistrate.ts";

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
      assert.equal(png[start + 10], 0, `${relativePath} uses unsupported compression`);
      assert.equal(png[start + 11], 0, `${relativePath} uses unsupported filtering`);
      assert.equal(png[start + 12], 0, `${relativePath} must not be interlaced`);
    } else if (type === "IDAT") {
      compressed.push(png.subarray(start, end));
    }
    offset = end + 4;
    if (type === "IEND") break;
  }
  assert.ok(width > 0 && height > 0 && compressed.length > 0, `${relativePath} is incomplete`);

  const stride = width * 4;
  const raw = inflateSync(Buffer.concat(compressed));
  assert.equal(raw.length, (stride + 1) * height, `${relativePath} has invalid scanlines`);
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
      const upperLeft = y > 0 && byte >= 4 ? pixels[outputStart + byte - stride - 4] : 0;
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

function cellAlphaMetrics(image, column, row, columns, rows, label) {
  assert.equal(image.width % columns, 0, `${label} has uneven columns`);
  assert.equal(image.height % rows, 0, `${label} has uneven rows`);
  const width = image.width / columns;
  const height = image.height / rows;
  const left = column * width;
  const top = row * height;
  let visible = 0;
  let transparent = 0;
  const support = Buffer.alloc(width * height);
  let supportIndex = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const alpha = image.pixels[((top + y) * image.width + left + x) * 4 + 3];
      if (alpha > 16) visible += 1;
      if (alpha === 0) transparent += 1;
      support[supportIndex] = alpha > 16 ? 1 : 0;
      supportIndex += 1;
    }
  }
  return { visible, transparent, pixels: width * height, support };
}

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

function arrayLiteralElementCount(source, variableName) {
  const file = ts.createSourceFile(
    "GameCanvas.tsx",
    source,
    ts.ScriptTarget.ES2022,
    true,
    ts.ScriptKind.TSX,
  );
  let count = null;
  const arrayInitializer = (initializer) => {
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
      const array = arrayInitializer(node.initializer);
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
  seed: 81_312,
  castIndex: 0,
  bossPosition: { x: 640, y: 360 },
  playerPosition: { x: 820, y: 360 },
  playerRadius: 14,
  arena: { minX: 80, minY: 70, maxX: 1200, maxY: 650 },
  wallPadding: 20,
  ...overrides,
});

const assertFinitePoint = (point) => {
  assert.ok(Number.isFinite(point.x), `${point.x} must be finite`);
  assert.ok(Number.isFinite(point.y), `${point.y} must be finite`);
};

const assertFiniteState = (state) => {
  for (const value of [
    state.phaseTimer,
    state.phaseElapsed,
    state.patternIndex,
    state.castIndex,
    state.pulseIndex,
  ]) {
    assert.ok(Number.isFinite(value), `${value} must be finite`);
  }
  assertFinitePoint(state.origin);
  assertFinitePoint(state.anchor);
  state.clones.forEach(assertFinitePoint);
};

test("boss progression preserves Blank, keeps floor-one Binder, and unlocks kind 12 immediately on floor two", async () => {
  const roster = await importTypeScriptModule("app/boss-roster.ts");
  assert.equal(roster.isBossKind(5), true);
  assert.equal(roster.isBossKind(9), true);
  assert.equal(roster.isBossKind(11), true);
  assert.equal(roster.isBossKind(12), true);
  assert.equal(roster.isBossKind(13), true);
  assert.equal(roster.isBossKind(10), false);
  assert.equal(roster.isBossKind(14), false);

  for (const endingVersion of [-20, 0, 1]) {
    for (const floor of [1, 2, 19, Number.POSITIVE_INFINITY]) {
      assert.equal(
        roster.bossKindForProgress(endingVersion, 999, floor),
        5,
        `the first-story boss must remain Blank on floor ${floor}`,
      );
    }
  }
  assert.equal(
    roster.bossKindForProgress(2, 1, 1),
    9,
    "the first post-ending floor-one boss must remain Final Binder",
  );

  assert.deepEqual(
    Array.from({ length: 10 }, (_, index) =>
      roster.bossKindForProgress(2, index + 1, 1),
    ),
    [9, 11, 5, 9, 11, 5, 9, 11, 5, 9],
    "floor one must preserve the established post-ending rotation",
  );
  for (const floor of [2, 3, 99]) {
    assert.deepEqual(
      Array.from({ length: 10 }, (_, index) =>
        roster.bossKindForProgress(2, index + 1, floor),
      ),
      [12, 13, 11, 5, 9, 12, 13, 11, 5, 9],
      `floor ${floor} must introduce the Inkbound Magistrate on its first post-ending boss room`,
    );
  }
});

test("GameCanvas integrates kind 12 through aligned data, floor-aware spawning, and independent atlases", async () => {
  const source = await readFile(path.join(root, "app/GameCanvas.tsx"), "utf8");
  const enemyKind = source.match(/type\s+EnemyKind\s*=([\s\S]*?);/);
  assert.ok(enemyKind, "EnemyKind must remain a finite numeric union");
  const kinds = [...enemyKind[1].matchAll(/\b(\d+)\b/g)].map((match) => Number(match[1]));
  assert.deepEqual(
    [...new Set(kinds)].sort((left, right) => left - right),
    Array.from({ length: 14 }, (_, kind) => kind),
    "enemy indices must remain contiguous from 0 through 13",
  );
  for (const arrayName of ["ENEMY_NAMES", "WALK_IMAGE_KEYS", "ENEMY_DIRECTION_FRAMES"]) {
    assert.equal(
      arrayLiteralElementCount(source, arrayName),
      14,
      `${arrayName} must align with every enemy kind`,
    );
  }
  assert.match(
    source,
    /bossKindForProgress\(\s*player\.endingVersion,\s*player\.bossesCleared,\s*world\.dungeonFloor,?\s*\)/,
    "boss selection must receive the current dungeon floor",
  );
  assert.match(source, /walkInkboundMagistrate:\s*["']\/assets\/walk\/inkbound-magistrate-walk-v1\.png["']/);
  assert.match(source, /inkboundMagistratePatterns:\s*["']\/assets\/effects\/inkbound-magistrate-patterns-v1\.png["']/);
  assert.match(source, /["']walkInkboundMagistrate["']/);
  const directionStart = source.indexOf("const ENEMY_DIRECTION_FRAMES");
  const directionEnd = source.indexOf("const DIRECTION_NAMES", directionStart);
  assert.ok(directionStart >= 0 && directionEnd > directionStart, "direction table must stay inspectable");
  const directionRows = source.slice(directionStart, directionEnd);
  assert.match(
    directionRows,
    /Inkbound Magistrate[\s\S]{0,100}?makeDirectionFrames\(\s*\[0,\s*1,\s*2,\s*3,\s*4,\s*5,\s*6,\s*7\]\s*\)/,
    "kind 12 needs eight authored direction rows without runtime mirroring",
  );

  const makeEnemyStart = source.indexOf("const makeEnemy = useCallback(");
  const makeEnemyEnd = source.indexOf("const spawnRoom = useCallback(", makeEnemyStart);
  assert.ok(makeEnemyStart >= 0 && makeEnemyEnd > makeEnemyStart, "makeEnemy must stay inspectable");
  const makeEnemy = source.slice(makeEnemyStart, makeEnemyEnd);
  const readBalanceArray = (name) => {
    const match = makeEnemy.match(new RegExp(`const ${name} = \\[([\\s\\S]*?)\\];`));
    assert.ok(match, `${name} is missing from makeEnemy`);
    return match[1].split(",").map((value) => value.trim()).filter(Boolean);
  };
  const hpBases = readBalanceArray("hpBases");
  const speedBases = readBalanceArray("speedBases");
  const damageBases = readBalanceArray("damageBases");
  const radii = readBalanceArray("radii");
  for (const [name, entries] of Object.entries({ hpBases, speedBases, damageBases, radii })) {
    assert.equal(entries.length, 14, `${name} must align with all 14 enemy kinds`);
  }
  assert.deepEqual(
    [hpBases[12], speedBases[12], damageBases[12], radii[12]],
    [
      "INKBOUND_MAGISTRATE_BASE_HP",
      "INKBOUND_MAGISTRATE_BASE_SPEED",
      "INKBOUND_MAGISTRATE_BASE_DAMAGE",
      "INKBOUND_MAGISTRATE_RADIUS",
    ],
    "kind 12 must use its explicit stronger boss budget",
  );
});

test("Inkbound Magistrate walk and pattern atlases are transparent, populated, and correctly tiled", async () => {
  const assets = [
    {
      path: "public/assets/walk/inkbound-magistrate-walk-v1.png",
      width: 1_024,
      height: 1_536,
      columns: 4,
      rows: 8,
      minimumVisible: 350,
    },
    {
      path: "public/assets/effects/inkbound-magistrate-patterns-v1.png",
      width: 2_048,
      height: 1_024,
      columns: 4,
      rows: 2,
      minimumVisible: 2_000,
    },
  ];
  const completeHashes = new Set();
  for (const asset of assets) {
    const png = await readFile(path.join(root, asset.path));
    assert.ok(png.length > 1_024, `${asset.path} is unexpectedly empty`);
    const image = decodeRgbaPng(png, asset.path);
    assert.deepEqual([image.width, image.height], [asset.width, asset.height]);
    let totalTransparent = 0;
    const cellHashes = new Set();
    for (let row = 0; row < asset.rows; row += 1) {
      for (let column = 0; column < asset.columns; column += 1) {
        const label = `${asset.path} cell ${row},${column}`;
        const metrics = cellAlphaMetrics(image, column, row, asset.columns, asset.rows, label);
        assert.ok(metrics.visible >= asset.minimumVisible, `${label} is effectively empty`);
        assert.ok(metrics.transparent / metrics.pixels >= 0.08, `${label} lacks transparent compositing space`);
        const cellWidth = image.width / asset.columns;
        const cellHeight = image.height / asset.rows;
        for (const [x, y] of [
          [column * cellWidth, row * cellHeight],
          [(column + 1) * cellWidth - 1, row * cellHeight],
          [column * cellWidth, (row + 1) * cellHeight - 1],
          [(column + 1) * cellWidth - 1, (row + 1) * cellHeight - 1],
        ]) {
          assert.equal(
            image.pixels[(y * image.width + x) * 4 + 3],
            0,
            `${label} must keep transparent crop-safe corners`,
          );
        }
        totalTransparent += metrics.transparent;
        cellHashes.add(createHash("sha256").update(metrics.support).digest("hex"));
      }
    }
    assert.ok(
      cellHashes.size >= Math.ceil((asset.columns * asset.rows) / 2),
      `${asset.path} repeats too many alpha silhouettes`,
    );
    assert.ok(totalTransparent > 0, `${asset.path} needs an alpha channel`);
    completeHashes.add(createHash("sha256").update(png).digest("hex"));
  }
  assert.equal(completeHashes.size, 2, "the boss walk and attack VFX must be independent bitmap assets");
});

test("the Inkbound Magistrate has kind 12 and exceeds the existing boss budget", async () => {
  const boss = await importTypeScriptModule(modulePath);
  assert.equal(boss.INKBOUND_MAGISTRATE_KIND, 12);
  assert.equal(boss.INKBOUND_MAGISTRATE_DISPLAY_NAME, "먹칠된 판관");
  assert.ok(boss.INKBOUND_MAGISTRATE_BASE_HP > 650);
  assert.ok(boss.INKBOUND_MAGISTRATE_BASE_SPEED > 35);
  assert.ok(boss.INKBOUND_MAGISTRATE_BASE_DAMAGE > 14);
  assert.deepEqual(boss.INKBOUND_MAGISTRATE_PATTERN_SEQUENCE, [
    "chainCross",
    "inkDoubles",
    "finalVerdict",
  ]);
  for (let index = 0; index < 12; index += 1) {
    assert.equal(
      boss.inkboundMagistratePatternAt(index),
      boss.INKBOUND_MAGISTRATE_PATTERN_SEQUENCE[index % 3],
    );
  }
  assert.equal(boss.inkboundMagistratePatternAt(Number.NaN), "chainCross");
  assert.equal(boss.inkboundMagistratePatternAt(Number.POSITIVE_INFINITY), "chainCross");
});

test("wall-safe anchors and clone layouts are deterministic and keep full bodies on floor", async () => {
  const boss = await importTypeScriptModule(modulePath);
  const arena = { minX: 100, minY: 50, maxX: 900, maxY: 550 };
  assert.deepEqual(
    boss.clampInkboundPointToArena(
      { x: Number.NEGATIVE_INFINITY, y: 9_999 },
      arena,
      50,
      25,
    ),
    { x: 500, y: 475 },
  );
  const first = boss.inkboundCloneLayout(
    { x: 140, y: 90 },
    arena,
    7123,
    8,
    4,
    300,
    50,
    25,
  );
  const repeated = boss.inkboundCloneLayout(
    { x: 140, y: 90 },
    arena,
    7123,
    8,
    4,
    300,
    50,
    25,
  );
  assert.deepEqual(first, repeated);
  assert.equal(first.length, 4);
  for (const point of first) {
    assert.ok(point.x >= 175 && point.x <= 825);
    assert.ok(point.y >= 125 && point.y <= 475);
  }
  const safeSeal = boss.inkboundVerdictSafeCenter(arena, 99, 4, 112, 25);
  assert.ok(safeSeal.x >= 237 && safeSeal.x <= 763);
  assert.ok(safeSeal.y >= 187 && safeSeal.y <= 413);
});

test("chain, cross, barrage, and verdict geometry include player radius and reject invalid coordinates", async () => {
  const boss = await importTypeScriptModule(modulePath);
  assert.equal(
    boss.inkboundChainBindHits(
      { x: 100, y: 29 },
      12,
      { x: 0, y: 0 },
      { x: 200, y: 0 },
      18,
    ),
    true,
  );
  assert.equal(
    boss.inkboundChainBindHits(
      { x: 100, y: 31 },
      12,
      { x: 0, y: 0 },
      { x: 200, y: 0 },
      18,
    ),
    false,
  );
  assert.equal(
    boss.inkboundCrossWaveHits(
      { x: 200, y: 25 },
      10,
      { x: 100, y: 100 },
      100,
      16,
      100,
    ),
    true,
  );
  assert.equal(
    boss.inkboundBarrageHits(
      { x: 100, y: 10 },
      4,
      [{ x: 0, y: 0 }, { x: 200, y: 0 }],
      { x: 100, y: 0 },
      7,
    ),
    true,
  );
  assert.equal(
    boss.inkboundVerdictHits(
      { x: 500, y: 300 },
      10,
      { x: 500, y: 300 },
      100,
      { minX: 0, minY: 0, maxX: 1000, maxY: 600 },
    ),
    false,
  );
  assert.equal(
    boss.inkboundVerdictHits(
      { x: 700, y: 300 },
      10,
      { x: 500, y: 300 },
      100,
      { minX: 0, minY: 0, maxX: 1000, maxY: 600 },
    ),
    true,
  );
  assert.equal(
    boss.inkboundSegmentHitsCircle(
      { x: Number.NaN, y: 0 },
      { x: 10, y: 0 },
      { x: 5, y: 0 },
      3,
    ),
    false,
  );
});

test("chainCross always follows telegraph, bind, cross waves, and recovery", async () => {
  const boss = await importTypeScriptModule(modulePath);
  let state = boss.createInkboundMagistrateState({
    patternIndex: 0,
    phase: "pursuit",
    phaseTimer: 0,
  });
  let step = boss.advanceInkboundMagistrate(state, baseInput());
  assert.equal(step.state.phase, "telegraph");
  assert.deepEqual(step.commands.map((command) => command.type), ["telegraph"]);
  assert.equal(step.commands.some((command) => command.type === "damage"), false);

  state = boss.createInkboundMagistrateState({ ...step.state, phaseTimer: 0 });
  step = boss.advanceInkboundMagistrate(state, baseInput());
  assert.equal(step.state.phase, "chainBind");
  assert.ok(step.commands.some((command) => command.type === "chainBind"));

  state = boss.createInkboundMagistrateState({ ...step.state, phaseTimer: 0 });
  step = boss.advanceInkboundMagistrate(state, baseInput());
  assert.equal(step.state.phase, "crossWaves");
  assert.ok(step.commands.some((command) => command.type === "crossWave"));

  state = boss.createInkboundMagistrateState({ ...step.state, phaseTimer: 0 });
  step = boss.advanceInkboundMagistrate(state, baseInput());
  assert.equal(step.state.phase, "recovery");
});

test("inkDoubles telegraphs before clone spawn and emits every deterministic volley", async () => {
  const boss = await importTypeScriptModule(modulePath);
  let state = boss.createInkboundMagistrateState({
    patternIndex: 1,
    phase: "pursuit",
    phaseTimer: 0,
    castIndex: 5,
  });
  let step = boss.advanceInkboundMagistrate(state, baseInput({ castIndex: 5 }));
  assert.equal(step.state.pattern, "inkDoubles");
  assert.equal(step.state.phase, "telegraph");
  assert.equal(step.state.clones.length, boss.INKBOUND_MAGISTRATE_CLONE_COUNT);
  assert.deepEqual(step.commands.map((command) => command.type), ["telegraph"]);

  state = boss.createInkboundMagistrateState({ ...step.state, phaseTimer: 0 });
  step = boss.advanceInkboundMagistrate(state, baseInput({ castIndex: 5 }));
  assert.equal(step.state.phase, "cloneBarrage");
  assert.deepEqual(step.commands.slice(0, 2).map((command) => command.type), [
    "spawnClones",
    "inkBarrage",
  ]);

  step = boss.advanceInkboundMagistrate(
    step.state,
    baseInput({
      dt: boss.INKBOUND_MAGISTRATE_CLONE_BARRAGE_SECONDS,
      castIndex: 5,
    }),
  );
  assert.equal(
    step.commands.filter((command) => command.type === "inkBarrage").length,
    boss.INKBOUND_MAGISTRATE_BARRAGE_VOLLEYS - 1,
  );
  assert.equal(step.state.phase, "recovery");
});

test("finalVerdict cannot burst before both telegraph and execution warning complete", async () => {
  const boss = await importTypeScriptModule(modulePath);
  let state = boss.createInkboundMagistrateState({
    patternIndex: 2,
    phase: "pursuit",
    phaseTimer: 0,
    castIndex: 2,
  });
  let step = boss.advanceInkboundMagistrate(state, baseInput({ castIndex: 2 }));
  assert.equal(step.state.phase, "telegraph");
  assert.equal(step.commands.some((command) => command.type === "verdictBurst"), false);

  state = boss.createInkboundMagistrateState({ ...step.state, phaseTimer: 0 });
  step = boss.advanceInkboundMagistrate(state, baseInput({ castIndex: 2 }));
  assert.equal(step.state.phase, "executionWarning");
  assert.equal(step.commands.some((command) => command.type === "verdictBurst"), false);
  assert.ok(step.commands.some((command) => command.type === "executionWarning"));

  state = boss.createInkboundMagistrateState({ ...step.state, phaseTimer: 0 });
  step = boss.advanceInkboundMagistrate(
    state,
    baseInput({
      castIndex: 2,
      playerPosition: { x: 1100, y: 600 },
    }),
  );
  assert.equal(step.state.phase, "verdictBurst");
  assert.ok(step.commands.some((command) => command.type === "verdictBurst"));
  assert.ok(step.commands.some((command) => command.type === "damage"));
});

test("corrupt states and inputs are sanitized without unbounded reducer work", async () => {
  const boss = await importTypeScriptModule(modulePath);
  const corrupt = boss.createInkboundMagistrateState({
    phase: "not-a-phase",
    pattern: "not-a-pattern",
    phaseTimer: Number.NaN,
    phaseElapsed: Number.POSITIVE_INFINITY,
    patternIndex: Number.NaN,
    castIndex: Number.NEGATIVE_INFINITY,
    pulseIndex: Number.POSITIVE_INFINITY,
    origin: { x: Number.NaN, y: Number.POSITIVE_INFINITY },
    anchor: { x: Number.NEGATIVE_INFINITY, y: Number.NaN },
    clones: [{ x: Number.NaN, y: 1 }],
    hitTokens: ["ok", 4, null],
  });
  assertFiniteState(corrupt);
  assert.equal(corrupt.phase, "pursuit");
  assert.equal(corrupt.pattern, "chainCross");

  const step = boss.advanceInkboundMagistrate(
    corrupt,
    baseInput({
      dt: Number.POSITIVE_INFINITY,
      seed: Number.NaN,
      castIndex: Number.POSITIVE_INFINITY,
      bossPosition: { x: Number.NaN, y: Number.POSITIVE_INFINITY },
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
  assertFiniteState(step.state);
  assert.ok(step.commands.length <= 32);
  for (const command of step.commands) {
    if ("anchor" in command) assertFinitePoint(command.anchor);
    if ("safeCenter" in command) assertFinitePoint(command.safeCenter);
  }
});
