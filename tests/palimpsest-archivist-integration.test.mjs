import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import ts from "typescript";

const root = process.cwd();

const readSource = (relativePath) =>
  readFile(path.join(root, relativePath), "utf8");

async function importTypeScriptModule(relativePath) {
  const source = await readSource(relativePath);
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: relativePath,
  }).outputText;
  return import(
    `data:text/javascript;base64,${Buffer.from(output).toString("base64")}`
  );
}

function sourceSection(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.ok(start >= 0, `missing source marker: ${startMarker}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(end > start, `missing source marker after ${startMarker}: ${endMarker}`);
  return source.slice(start, end);
}

function balancedBlockAfter(source, marker) {
  const markerIndex = source.indexOf(marker);
  assert.ok(markerIndex >= 0, `missing block marker: ${marker}`);
  const open = source.indexOf("{", markerIndex + marker.length);
  assert.ok(open >= 0, `missing opening brace after: ${marker}`);
  let depth = 0;
  let quote = null;
  let escaped = false;
  for (let index = open; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'" || character === "`") {
      quote = character;
      continue;
    }
    if (character === "{") depth += 1;
    if (character === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, index);
    }
  }
  assert.fail(`missing closing brace after: ${marker}`);
}

function branchSection(source, marker) {
  const start = source.indexOf(marker);
  assert.ok(start >= 0, `missing branch marker: ${marker}`);
  const candidates = ["} else if (", "\n    } else {", "\n  }\n"]
    .map((next) => source.indexOf(next, start + marker.length))
    .filter((next) => next > start);
  assert.ok(candidates.length > 0, `missing end of branch: ${marker}`);
  return source.slice(start, Math.min(...candidates));
}

test("the boss roster preserves the ending bosses before cycling the Palimpsest Archivist", async () => {
  const [roster, archivist] = await Promise.all([
    importTypeScriptModule("app/boss-roster.ts"),
    importTypeScriptModule("app/palimpsest-archivist.ts"),
  ]);

  assert.equal(archivist.PALIMPSEST_ARCHIVIST_KIND, 11);
  assert.equal(roster.isBossKind(5), true);
  assert.equal(roster.isBossKind(9), true);
  assert.equal(roster.isBossKind(11), true);
  assert.equal(roster.isBossKind(12), true);
  assert.equal(roster.isBossKind(10), false);

  assert.equal(roster.bossKindForProgress(0, 0), 5);
  assert.equal(roster.bossKindForProgress(1, 12), 5);
  assert.deepEqual(
    Array.from({ length: 9 }, (_, index) =>
      roster.bossKindForProgress(2, index + 1),
    ),
    [9, 11, 5, 9, 11, 5, 9, 11, 5],
    "after the one-time ending, the Final Binder must remain first before 11 and 5 cycle",
  );

  assert.deepEqual(archivist.PALIMPSEST_PATTERN_SEQUENCE, [
    "redactTrace",
    "restoreTrace",
    "proofRoute",
  ]);
  assert.deepEqual(
    Object.keys(archivist.PALIMPSEST_ARCHIVIST_PATTERN_LABELS),
    archivist.PALIMPSEST_PATTERN_SEQUENCE,
  );
  for (const label of Object.values(archivist.PALIMPSEST_ARCHIVIST_PATTERN_LABELS)) {
    assert.match(label, /\S/);
  }
  for (const phase of [
    "pursuit",
    "warning",
    "record",
    "execute",
    "route",
    "recovery",
  ]) {
    assert.match(
      archivist.PALIMPSEST_ARCHIVIST_PHASE_LABELS[phase] ?? "",
      /\S/,
      `${phase} must have a player-facing HUD label`,
    );
  }
});

test("GameCanvas catalogs kind 11, its authored atlases, and complete spawn state", async () => {
  const source = await readSource("app/GameCanvas.tsx");

  const enemyKind = source.match(/type\s+EnemyKind\s*=([\s\S]*?);/);
  assert.ok(enemyKind, "EnemyKind must remain a finite numeric union");
  const kinds = [...enemyKind[1].matchAll(/\b(\d+)\b/g)].map((match) => Number(match[1]));
  assert.deepEqual(
    [...new Set(kinds)].sort((left, right) => left - right),
    Array.from({ length: 13 }, (_, kind) => kind),
    "enemy array indices require a contiguous 0 through 12 union",
  );

  const enemyNames = sourceSection(source, "const ENEMY_NAMES", "const spriteCrops");
  assert.match(enemyNames, /덧쓴 기록관/);

  const walkKeys = sourceSection(source, "const WALK_IMAGE_KEYS", "type DirectionFrame");
  assert.match(walkKeys, /["']walkPalimpsestArchivist["']/);
  const directionRows = sourceSection(
    source,
    "const ENEMY_DIRECTION_FRAMES",
    "const DIRECTION_NAMES",
  );
  assert.ok(
    (directionRows.match(/makeDirectionFrames\(\s*\[0,\s*1,\s*2,\s*3,\s*4,\s*5,\s*6,\s*7\]/g) ?? [])
      .length >= 3,
    "kind 11 needs eight authored direction rows without runtime mirroring",
  );

  assert.match(
    source,
    /walkPalimpsestArchivist:\s*["']\/assets\/walk\/palimpsest-archivist-walk-v1\.png["']/,
  );
  assert.match(
    source,
    /palimpsestArchivistPatterns:\s*["']\/assets\/effects\/palimpsest-archivist-patterns-v1\.png["']/,
  );
  assert.match(source, /archivist\?:\s*PalimpsestArchivistRuntimeState/);

  const makeEnemy = sourceSection(
    source,
    "const makeEnemy = useCallback(",
    "const spawnRoom = useCallback(",
  );
  assert.match(makeEnemy, /const hpBases\s*=\s*\[[\s\S]*?PALIMPSEST_ARCHIVIST_BASE_HP[\s\S]*?\];/);
  assert.match(makeEnemy, /const speedBases\s*=\s*\[[\s\S]*?PALIMPSEST_ARCHIVIST_BASE_SPEED[\s\S]*?\];/);
  assert.match(makeEnemy, /const damageBases\s*=\s*\[[\s\S]*?PALIMPSEST_ARCHIVIST_BASE_DAMAGE[\s\S]*?\];/);
  assert.match(makeEnemy, /const radii\s*=\s*\[[\s\S]*?PALIMPSEST_ARCHIVIST_RADIUS[\s\S]*?\];/);
  assert.match(
    makeEnemy,
    /archivist:\s*kind\s*===\s*PALIMPSEST_ARCHIVIST_KIND\s*\?[\s\S]{0,260}?createPalimpsestState\s*\(/,
    "kind 11 must receive a fresh, explicit runtime state",
  );
});

test("the isolated archivist controller is deterministic and keeps record and warning phases harmless", async () => {
  const [game, moduleSource] = await Promise.all([
    readSource("app/GameCanvas.tsx"),
    readSource("app/palimpsest-archivist.ts"),
  ]);

  const marker = "else if (enemy.kind === PALIMPSEST_ARCHIVIST_KIND)";
  assert.equal(
    (game.match(/else if \(enemy\.kind === PALIMPSEST_ARCHIVIST_KIND\)/g) ?? []).length,
    1,
    "kind 11 must have exactly one isolated update controller",
  );
  const controller = balancedBlockAfter(game, marker);
  assert.match(controller, /advancePalimpsestArchivist\(/);
  assert.match(controller, /damagePlayer\(/, "only reducer damage commands may reach player HP");
  assert.match(controller, /setToast\(/, "pattern feedback must reach the in-game message layer");
  assert.doesNotMatch(controller, /spawnHostileProjectile\s*\(/);
  assert.doesNotMatch(controller, /world\.enemies\.push\s*\(/);
  assert.doesNotMatch(controller, /spawnVisualEffect\s*\(\s*["']summon["']/);
  assert.doesNotMatch(controller, /Math\.random\s*\(/);
  assert.doesNotMatch(controller, /performance\.now\s*\(/);

  for (const phase of ["record", "warning"]) {
    const phaseMarker = moduleSource.includes(`state.phase === "${phase}"`)
      ? `state.phase === "${phase}"`
      : `state.phase === '${phase}'`;
    const phaseBlock = branchSection(moduleSource, phaseMarker);
    assert.doesNotMatch(
      phaseBlock,
      /(?:type\s*:\s*["']damage["']|damagePlayer\s*\(|commands?\.push\s*\([^)]*damage)/,
      `${phase} must never emit damage before the visible execution phase`,
    );
  }

  const contact = sourceSection(game, "const bossCanDealContactDamage =", "bossCanDealContactDamage &&");
  assert.match(
    contact,
    /enemy\.kind\s*===\s*PALIMPSEST_ARCHIVIST_KIND[\s\S]{0,180}?enemy\.archivist\?\.phase\s*===\s*["']pursuit["']/,
    "the Archivist may deal contact damage only while visibly pursuing",
  );
});

test("the archivist danger art renders on the floor before actors and reports its state through the HUD", async () => {
  const source = await readSource("app/GameCanvas.tsx");

  assert.match(source, /const drawPalimpsestPattern\s*=\s*\(/);
  const floorDraw = source.indexOf(
    "drawPalimpsestPattern(images.palimpsestArchivistPatterns, enemy)",
  );
  const actorDraw = source.indexOf(
    "const sortedEnemies = [...world.enemies].sort",
    Math.max(0, floorDraw),
  );
  assert.ok(floorDraw >= 0 && actorDraw > floorDraw, "danger geometry must render below actors");
  assert.equal(
    source.indexOf(
      "drawPalimpsestPattern(images.palimpsestArchivistPatterns, enemy)",
      floorDraw + 1,
    ),
    -1,
    "the floor pass must draw the Archivist pattern exactly once",
  );

  assert.match(source, /archivistPattern:\s*null\s+as\s+PalimpsestArchivistPattern\s*\|\s*null/);
  assert.match(source, /archivistPhase:\s*null\s+as\s+PalimpsestArchivistPhase\s*\|\s*null/);
  assert.match(source, /archivistPattern:\s*boss\?\.archivist\?\.pattern\s*\?\?\s*null/);
  assert.match(source, /archivistPhase:\s*boss\?\.archivist\?\.phase\s*\?\?\s*null/);
  assert.match(
    source,
    /data-boss-pattern=\{[\s\S]{0,220}?hud\.world\.archivistPattern[\s\S]{0,80}?["']none["']\}/,
  );
  assert.match(
    source,
    /data-boss-phase=\{[\s\S]{0,220}?hud\.world\.archivistPhase[\s\S]{0,80}?["']none["']\}/,
  );
  assert.match(
    source,
    /PALIMPSEST_ARCHIVIST_PATTERN_LABELS\[hud\.world\.archivistPattern\]/,
  );
  assert.match(
    source,
    /PALIMPSEST_ARCHIVIST_PHASE_LABELS\[hud\.world\.archivistPhase\]/,
  );
  assert.match(
    source,
    /bossKind\s*===\s*PALIMPSEST_ARCHIVIST_KIND[\s\S]{0,500}?setToast\([\s\S]{0,180}?(?:덧쓴 기록관|ENEMY_NAMES\[bossKind\])/,
    "the boss entrance must use an in-game toast instead of a browser dialog",
  );
  assert.doesNotMatch(source, /alert\s*\([\s\S]{0,120}?덧쓴 기록관/);
});

test("kind 11 inherits the canonical boss HUD, damage, and guaranteed loot paths", async () => {
  const source = await readSource("app/GameCanvas.tsx");

  assert.match(
    source,
    /let boss:\s*Enemy\s*\|\s*undefined;[\s\S]{0,560}?if\s*\(!boss\s*&&\s*isBossKind\(enemy\.kind\)\)\s*boss\s*=\s*enemy;/,
  );
  assert.match(source, /const difficultyTier\s*=\s*isBossKind\(kind\)\s*\?\s*["']boss["']/);
  assert.match(source, /if\s*\(boss\)\s*multiplier\s*\*=\s*1\s*\+\s*equipmentStats\.bossDamagePercent\s*\/\s*100/);
  assert.match(
    source,
    /const dropSource\s*=\s*isBossKind\(enemy\.kind\)\s*\?\s*["']boss["']/,
  );
  assert.match(
    source,
    /const gearDropChance\s*=\s*dropSource\s*===\s*["']boss["']\s*\?\s*1/,
  );
  assert.match(
    source,
    /const dropCount\s*=\s*isBossKind\(enemy\.kind\)\s*\?\s*2\s*:\s*1/,
  );
  assert.match(
    source,
    /rollGearDropLevel\(\s*dropSeed,\s*player\.level,\s*dropSource,?\s*\)/,
  );
  assert.match(source, /const barWidth\s*=\s*isBossKind\(enemy\.kind\)\s*\?\s*180/);
  assert.match(
    source,
    /if\s*\(kind\s*===\s*["']boss["']\)[\s\S]{0,260}?enemies\.push\(makeEnemy\(bossKind,[\s\S]{0,120}?playGameSfx\(["']bossAppear["']/,
    "all roster bosses must share the one-enemy boss-room spawn path",
  );
});
