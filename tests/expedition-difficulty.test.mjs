import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import ts from "typescript";

const root = process.cwd();
const difficultySource = await readFile(
  path.join(root, "app/expedition-difficulty.ts"),
  "utf8",
);
const javascript = ts.transpileModule(difficultySource, {
  compilerOptions: {
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ES2022,
  },
}).outputText;
const difficulty = await import(
  `data:text/javascript;base64,${Buffer.from(javascript).toString("base64")}`
);

const roomDifficulty = (roomsCleared, combatPower, playerLevel = 80, extra = {}) =>
  difficulty.calculateExpeditionDifficulty({
    roomsCleared,
    playerLevel,
    combatPower,
    ...extra,
  });

test("adaptive power scaling stays off through level 70 and for the first story boss", () => {
  assert.equal(difficulty.expectedExpeditionCombatPower(0), 1_000);
  assert.equal(difficulty.expectedExpeditionCombatPower(8), 1_405);
  assert.equal(difficulty.EXPEDITION_POWER_SCALING_START_LEVEL, 70);
  assert.equal(difficulty.EXPEDITION_POWER_SCALING_FULL_LEVEL, 80);

  for (const playerLevel of [1, 69, 70]) {
    const result = roomDifficulty(100, 1_000_000_000, playerLevel);
    assert.equal(result.lateGameRamp, 0);
    assert.equal(result.normalHpMultiplier, 1);
    assert.equal(result.eliteHpMultiplier, 1);
    assert.equal(result.bossHpMultiplier, 1);
    assert.equal(result.enemyCountBonus, 0);
  }

  const firstBoss = roomDifficulty(100, 1_000_000_000, 100, {
    suppressPowerScaling: true,
  });
  assert.equal(firstBoss.normalHpMultiplier, 1);
  assert.equal(firstBoss.eliteHpMultiplier, 1);
  assert.equal(firstBoss.bossHpMultiplier, 1);
  assert.equal(firstBoss.enemyCountBonus, 0);
});

test("adaptive difficulty rises rapidly from level 71 and is fully active at 80", () => {
  const expected = difficulty.expectedExpeditionCombatPower(40);
  const level70 = roomDifficulty(40, expected * 4, 70);
  const level71 = roomDifficulty(40, expected * 4, 71);
  const level75 = roomDifficulty(40, expected * 4, 75);
  const level80 = roomDifficulty(40, expected * 4, 80);

  assert.equal(level70.lateGameRamp, 0);
  assert.ok(Math.abs(level71.lateGameRamp - 0.028) < 1e-12);
  assert.equal(level75.lateGameRamp, 0.5);
  assert.equal(level80.lateGameRamp, 1);
  assert.ok(level71.normalHpMultiplier > level70.normalHpMultiplier);
  assert.ok(level75.normalHpMultiplier > level71.normalHpMultiplier);
  assert.ok(level80.normalHpMultiplier > level75.normalHpMultiplier);
  assert.ok(level80.enemyCountBonus >= level75.enemyCountBonus);
});

test("late difficulty scales monotonically above expected combat power", () => {
  const expected = difficulty.expectedExpeditionCombatPower(40);
  assert.equal(expected, 2_919);
  const baseline = roomDifficulty(40, expected);
  const double = roomDifficulty(40, expected * 2);
  const quadruple = roomDifficulty(40, expected * 4);

  assert.equal(baseline.powerRatio, 1);
  assert.equal(baseline.normalHpMultiplier, 1);
  assert.equal(baseline.enemyCountBonus, 0);
  assert.ok(double.normalHpMultiplier > baseline.normalHpMultiplier);
  assert.ok(quadruple.normalHpMultiplier > double.normalHpMultiplier);
  assert.ok(quadruple.eliteHpMultiplier > quadruple.normalHpMultiplier);
  assert.ok(quadruple.bossHpMultiplier > quadruple.eliteHpMultiplier);
  assert.equal(quadruple.enemyCountBonus, 3);
  assert.ok(
    quadruple.normalHpMultiplier < 4,
    "power growth must still make the player relatively stronger",
  );
});

test("HP and population scaling stay finite and performance bounded", () => {
  const extreme = roomDifficulty(40, Number.MAX_SAFE_INTEGER);
  assert.equal(extreme.powerRatio, difficulty.EXPEDITION_MAX_POWER_RATIO);
  assert.ok(
    extreme.normalHpMultiplier <= difficulty.EXPEDITION_MAX_NORMAL_HP_MULTIPLIER,
  );
  assert.ok(
    extreme.eliteHpMultiplier <= difficulty.EXPEDITION_MAX_ELITE_HP_MULTIPLIER,
  );
  assert.ok(
    extreme.bossHpMultiplier <= difficulty.EXPEDITION_MAX_BOSS_HP_MULTIPLIER,
  );
  assert.ok(
    extreme.enemyCountBonus <= difficulty.EXPEDITION_MAX_ENEMY_COUNT_BONUS,
  );

  assert.equal(
    difficulty.calculateExpeditionEnemyCount({
      roomsCleared: 0,
      roomKind: "battle",
      difficulty: difficulty.BASE_EXPEDITION_DIFFICULTY,
    }),
    6,
  );
  assert.equal(
    difficulty.calculateExpeditionEnemyCount({
      roomsCleared: 0,
      roomKind: "horde",
      difficulty: difficulty.BASE_EXPEDITION_DIFFICULTY,
    }),
    10,
  );
  assert.equal(
    difficulty.calculateExpeditionEnemyCount({
      roomsCleared: 31,
      roomKind: "battle",
      difficulty: difficulty.BASE_EXPEDITION_DIFFICULTY,
    }),
    16,
  );
  assert.equal(
    difficulty.calculateExpeditionEnemyCount({
      roomsCleared: 31,
      roomKind: "horde",
      difficulty: difficulty.BASE_EXPEDITION_DIFFICULTY,
    }),
    25,
  );
  assert.equal(
    difficulty.calculateExpeditionEnemyCount({
      roomsCleared: 100,
      roomKind: "battle",
      difficulty: extreme,
    }),
    difficulty.EXPEDITION_MAX_NORMAL_ENEMIES,
  );
  assert.equal(
    difficulty.calculateExpeditionEnemyCount({
      roomsCleared: 100,
      roomKind: "horde",
      difficulty: extreme,
    }),
    difficulty.EXPEDITION_MAX_HORDE_ENEMIES,
  );
  assert.equal(
    difficulty.calculateExpeditionEnemyCount({
      roomsCleared: 100,
      roomKind: "shelter",
      difficulty: extreme,
    }),
    0,
  );
  assert.equal(
    difficulty.calculateExpeditionEnemyCount({
      roomsCleared: 100,
      roomKind: "boss",
      difficulty: extreme,
    }),
    1,
  );
});

test("the room power rating absorbs upgrades gradually and resists doorway stripping", () => {
  assert.equal(
    difficulty.updateExpeditionPowerRating({
      previousRating: 5_000,
      currentCombatPower: 10_000,
    }),
    5_900,
  );
  assert.equal(
    difficulty.updateExpeditionPowerRating({
      previousRating: 10_000,
      currentCombatPower: 1_000,
    }),
    9_640,
  );
  assert.equal(
    difficulty.updateExpeditionPowerRating({
      previousRating: Number.NaN,
      currentCombatPower: Number.POSITIVE_INFINITY,
    }),
    1_000,
  );
});

test("GameCanvas snapshots comprehensive power once and every summon inherits it", async () => {
  const source = await readFile(path.join(root, "app/GameCanvas.tsx"), "utf8");

  assert.match(
    source,
    /const currentCombatPower = calculatePlayerStatsForRuntime\(player\)\.ratings\.combatPower;/,
  );
  assert.match(
    source,
    /player\.expeditionPowerRating = updateExpeditionPowerRating\([\s\S]{0,220}?world\.expeditionDifficulty = calculateExpeditionDifficulty\(/,
  );
  assert.match(
    source,
    /calculateExpeditionDifficulty\(\{[\s\S]{0,120}?playerLevel: player\.level,/,
  );
  assert.match(
    source,
    /suppressPowerScaling:[\s\S]{0,120}?bossKind === BLANK_CARTOGRAPHER_KIND[\s\S]{0,120}?player\.endingVersion < FIRST_BOSS_ENDING_VERSION/,
  );
  assert.match(
    source,
    /const difficultyTier = isBossKind\(kind\) \? "boss" : elite \? "elite" : "normal";/,
  );
  assert.match(
    source,
    /const hp = hpBases\[kind\] \* scale \* eliteScale \* combatHpScale;/,
  );
  assert.match(
    source,
    /worldRef\.current\.expeditionDifficulty/,
    "initial enemies and both summon paths must share the locked room snapshot",
  );
  assert.equal(
    (source.match(/world\.expeditionDifficulty = calculateExpeditionDifficulty\(/g) ?? [])
      .length,
    1,
    "difficulty may be resolved only once per newly spawned room",
  );
  assert.doesNotMatch(
    source,
    /damageBases\[kind\][\s\S]{0,180}?expeditionDifficulty/,
    "combat power must not punish defensive builds by increasing enemy damage",
  );
});
