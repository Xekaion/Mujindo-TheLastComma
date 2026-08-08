import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import ts from "typescript";

const root = process.cwd();

async function importDungeonFloor() {
  const relativePath = "app/dungeon-floor.ts";
  const source = await readFile(path.join(root, relativePath), "utf8");
  const javascript = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: relativePath,
  }).outputText;
  return import(
    `data:text/javascript;base64,${Buffer.from(javascript).toString("base64")}`
  );
}

const dungeon = await importDungeonFloor();

function sourceSection(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(start, -1, `missing source marker: ${startMarker}`);
  assert.notEqual(end, -1, `missing source marker: ${endMarker}`);
  return source.slice(start, end);
}

test("the signed 99x99 contract has one exact center and canonical coordinates", () => {
  assert.equal(dungeon.DUNGEON_LAYOUT_VERSION, 2);
  assert.equal(dungeon.DUNGEON_GRID_SIZE, 99);
  assert.equal(dungeon.DUNGEON_MIN_COORDINATE, -49);
  assert.equal(dungeon.DUNGEON_MAX_COORDINATE, 49);
  assert.equal(dungeon.DUNGEON_CENTER_COORDINATE, 0);
  assert.equal(
    dungeon.DUNGEON_MAX_COORDINATE - dungeon.DUNGEON_MIN_COORDINATE + 1,
    dungeon.DUNGEON_GRID_SIZE,
  );
  assert.equal(dungeon.DUNGEON_GRID_SIZE ** 2, 9_801);

  for (const [x, y] of [
    [-49, -49],
    [-49, 49],
    [0, 0],
    [49, -49],
    [49, 49],
  ]) {
    assert.equal(dungeon.isDungeonCoordinate(x, y), true, `${x},${y}`);
    const key = dungeon.dungeonCoordinateKey(x, y);
    assert.deepEqual(dungeon.parseDungeonCoordinateKey(key), { x, y });
  }

  for (const [x, y] of [
    [-50, 0],
    [50, 0],
    [0, -50],
    [0, 50],
    [1.5, 0],
    [Number.NaN, 0],
    [Number.POSITIVE_INFINITY, 0],
  ]) {
    assert.equal(dungeon.isDungeonCoordinate(x, y), false, `${x},${y}`);
  }

  for (const key of ["-50,0", "50,0", "01,0", "+1,0", "-0,0", "1,0,0", ""]) {
    assert.equal(dungeon.parseDungeonCoordinateKey(key), null, key);
  }

  assert.equal(dungeon.dungeonDisplayCoordinate(-49), 1);
  assert.equal(dungeon.dungeonDisplayCoordinate(0), 50);
  assert.equal(dungeon.dungeonDisplayCoordinate(49), 99);
});

test("floor normalization is one-based and preserves every safe positive floor", () => {
  for (const floor of [1, 2, 99, 2_000_000, Number.MAX_SAFE_INTEGER]) {
    assert.equal(dungeon.normalizeDungeonFloor(floor), floor);
  }
  for (const floor of [undefined, null, 0, -1, 1.5, "2", Number.NaN, Infinity]) {
    assert.equal(dungeon.normalizeDungeonFloor(floor), 1);
  }
});

test("every floor has exactly forty unique deterministic non-central stair rooms", () => {
  assert.equal(dungeon.DOWN_STAIR_ROOM_COUNT, 40);

  for (const seed of [0, 1, 42, 0x7fffffff, -2_147_483_648]) {
    for (const floor of [1, 2, 37, 999, 2_000_000]) {
      const first = dungeon.createDownStairRoomKeys(seed, floor);
      const repeated = dungeon.createDownStairRoomKeys(seed, floor);
      const lookup = dungeon.createDownStairRoomLookup(seed, floor);

      assert.deepEqual(repeated, first, `${seed}/${floor} must be repeatable`);
      assert.equal(first.length, dungeon.DOWN_STAIR_ROOM_COUNT);
      assert.equal(new Set(first).size, dungeon.DOWN_STAIR_ROOM_COUNT);
      assert.equal(Object.keys(lookup).length, dungeon.DOWN_STAIR_ROOM_COUNT);
      assert.equal(first.includes("0,0"), false);

      for (const key of first) {
        const coordinate = dungeon.parseDungeonCoordinateKey(key);
        assert.ok(coordinate, `${seed}/${floor} produced invalid ${key}`);
        assert.equal(lookup[key], true);
      }
    }
  }

  assert.notDeepEqual(
    dungeon.createDownStairRoomKeys(42, 1),
    dungeon.createDownStairRoomKeys(42, 2),
    "the floor number must participate in layout generation",
  );
  assert.notDeepEqual(
    dungeon.createDownStairRoomKeys(42, 1),
    dungeon.createDownStairRoomKeys(43, 1),
    "the run seed must participate in layout generation",
  );
  assert.deepEqual(
    dungeon.createDownStairRoomKeys(42, 0),
    dungeon.createDownStairRoomKeys(42, 1),
    "invalid legacy floors normalize to B1 before generation",
  );
});

test("door access exhaustively seals the four outer edges of the 99x99 floor", () => {
  assert.deepEqual(dungeon.dungeonDoorAccess(0, 0, false), {
    west: false,
    east: false,
    north: false,
    south: false,
  });
  assert.deepEqual(dungeon.dungeonDoorAccess(0, 0, true), {
    west: true,
    east: true,
    north: true,
    south: true,
  });
  assert.deepEqual(dungeon.dungeonDoorAccess(-49, -49, true), {
    west: false,
    east: true,
    north: false,
    south: true,
  });
  assert.deepEqual(dungeon.dungeonDoorAccess(49, 49, true), {
    west: true,
    east: false,
    north: true,
    south: false,
  });

  const directionCounts = { 2: 0, 3: 0, 4: 0 };
  for (let y = -49; y <= 49; y += 1) {
    for (let x = -49; x <= 49; x += 1) {
      const openDirections = Object.values(
        dungeon.dungeonDoorAccess(x, y, true),
      ).filter(Boolean).length;
      directionCounts[openDirections] += 1;
    }
  }
  assert.deepEqual(directionCounts, {
    2: 4,
    3: 388,
    4: 9_409,
  });
});

test("runtime descent resets only floor-local state and checkpoints the floor number", async () => {
  const source = await readFile(path.join(root, "app/GameCanvas.tsx"), "utf8");
  const makeWorld = sourceSection(source, "function makeWorld(", "function augmentTier(");
  assert.match(makeWorld, /layoutVersion: DUNGEON_LAYOUT_VERSION/);
  assert.match(makeWorld, /dungeonFloor: normalizedFloor/);
  assert.match(makeWorld, /roomX: DUNGEON_CENTER_COORDINATE/);
  assert.match(makeWorld, /roomY: DUNGEON_CENTER_COORDINATE/);
  assert.match(makeWorld, /rooms: \{\}/);
  assert.match(makeWorld, /visited: \[\]/);
  assert.match(makeWorld, /createDownStairRoomLookup\(seed, normalizedFloor\)/);

  const descent = sourceSection(
    source,
    "const descendToNextFloor = useCallback(",
    "const teleportToVisitedRoom = useCallback(",
  );
  assert.match(descent, /world\.stairRoomLookup\[currentKey\] !== true/);
  assert.match(descent, /!currentRoom\?\.cleared/);
  assert.match(descent, /!world\.visitedLookup\[currentKey\]/);
  assert.match(descent, /world\.enemies\.length > 0 \|\| world\.transition > 0/);
  assert.match(descent, /world\.dungeonFloor >= Number\.MAX_SAFE_INTEGER/);
  assert.match(descent, /const nextFloor = world\.dungeonFloor \+ 1/);
  assert.match(descent, /worldRef\.current = makeWorld\(world\.seed, nextFloor\)/);
  assert.match(
    descent,
    /enterRoom\(\s*DUNGEON_CENTER_COORDINATE,\s*DUNGEON_CENTER_COORDINATE,\s*"center"/,
  );
  assert.doesNotMatch(
    descent,
    /saveAtShelter|writeSaveSlot|bossesCleared\s*=/,
    "stairs must not bypass checkpoints or reset lifetime boss progress",
  );

  assert.match(source, /bossKindForProgress\(player\.endingVersion, player\.bossesCleared\)/);
  assert.match(
    source,
    /if \(world\.roomKind === "boss"\) \{\s*player\.bossesCleared \+= 1;/,
  );

  const shelterSave = sourceSection(
    source,
    "const saveAtShelter = useCallback(",
    "const makeEnemy = useCallback(",
  );
  assert.match(shelterSave, /layoutVersion: world\.layoutVersion/);
  assert.match(shelterSave, /dungeonFloor: world\.dungeonFloor/);

  const legacyRestore = sourceSection(
    source,
    "function normalizeSavedDungeonWorld(",
    "const AUGMENTS:",
  );
  assert.match(legacyRestore, /world\.layoutVersion !== DUNGEON_LAYOUT_VERSION/);
  assert.match(legacyRestore, /dungeonFloor: 1/);
  assert.match(legacyRestore, /roomX: DUNGEON_CENTER_COORDINATE/);
  assert.match(legacyRestore, /roomY: DUNGEON_CENTER_COORDINATE/);
});
