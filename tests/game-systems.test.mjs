import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import ts from "typescript";

const root = process.cwd();

function readUInt24LE(buffer, offset) {
  return buffer[offset] | (buffer[offset + 1] << 8) | (buffer[offset + 2] << 16);
}

function assertWebPIntegrity(webp, relativePath) {
  assert.ok(webp.length >= 100 * 1024, `${relativePath} is unexpectedly small`);
  assert.ok(webp.length <= 2 * 1024 * 1024, `${relativePath} is not web-optimized`);
  assert.equal(webp.subarray(0, 4).toString("ascii"), "RIFF", relativePath);
  assert.equal(webp.subarray(8, 12).toString("ascii"), "WEBP", relativePath);
  assert.equal(webp.readUInt32LE(4) + 8, webp.length, `${relativePath} has a truncated RIFF container`);

  let offset = 12;
  let dimensions = null;
  while (offset + 8 <= webp.length) {
    const chunkType = webp.subarray(offset, offset + 4).toString("ascii");
    const chunkSize = webp.readUInt32LE(offset + 4);
    const dataOffset = offset + 8;
    const dataEnd = dataOffset + chunkSize;
    assert.ok(dataEnd <= webp.length, `${relativePath} has a truncated ${chunkType} chunk`);

    if (chunkType === "VP8X" && chunkSize >= 10) {
      dimensions = [
        readUInt24LE(webp, dataOffset + 4) + 1,
        readUInt24LE(webp, dataOffset + 7) + 1,
      ];
    } else if (chunkType === "VP8 " && chunkSize >= 10) {
      assert.equal(
        webp.subarray(dataOffset + 3, dataOffset + 6).toString("hex"),
        "9d012a",
        `${relativePath} has an invalid VP8 keyframe`,
      );
      dimensions = [
        webp.readUInt16LE(dataOffset + 6) & 0x3fff,
        webp.readUInt16LE(dataOffset + 8) & 0x3fff,
      ];
    } else if (chunkType === "VP8L" && chunkSize >= 5) {
      assert.equal(webp[dataOffset], 0x2f, `${relativePath} has an invalid VP8L signature`);
      const sizeBits = webp.readUInt32LE(dataOffset + 1);
      dimensions = [(sizeBits & 0x3fff) + 1, ((sizeBits >>> 14) & 0x3fff) + 1];
    }

    offset = dataEnd + (chunkSize % 2);
  }

  assert.equal(offset, webp.length, `${relativePath} has malformed chunk padding`);
  assert.ok(dimensions, `${relativePath} is missing a WebP image chunk`);
  return dimensions;
}

async function importTypeScriptModule(relativePath) {
  const source = await readFile(path.join(root, relativePath), "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: relativePath,
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(output).toString("base64")}`);
}

class MemoryStorage {
  #items = new Map();

  getItem(key) {
    return this.#items.has(key) ? this.#items.get(key) : null;
  }

  setItem(key, value) {
    this.#items.set(key, String(value));
  }

  removeItem(key) {
    this.#items.delete(key);
  }
}

const sampleSave = {
  savedAt: 1_753_000_000_000,
  player: {
    level: 12,
    rooms: 27,
    augments: { fang: 20, haste: 7 },
    profession: "fang",
  },
  world: {
    seed: 42,
    roomX: 5,
    roomY: 0,
    rooms: { "5,0": { kind: "shelter", cleared: true } },
    visited: ["5,0"],
  },
  stableAugments: { fang: 20, haste: 7 },
};

test("20-stack professions unlock across the forty-augment catalog", async () => {
  const professions = await importTypeScriptModule("app/professions.ts");
  assert.equal(professions.PROFESSION_THRESHOLD, 20);
  assert.equal(Object.keys(professions.PROFESSION_TITLES).length, 40);
  assert.equal(professions.isProfessionEligible({ fang: 19 }, "fang"), false);
  assert.equal(professions.isProfessionEligible({ fang: 20 }, "fang"), true);
  assert.equal(professions.effectiveAugmentRank({ fang: 20 }, "fang", "fang"), 30);
  assert.equal(professions.effectiveAugmentRank({ fang: 20 }, "haste", "fang"), 20);
  assert.equal(professions.effectiveAugmentRank({ fang: 21 }, "fang", "fang"), 31);
});

test("twenty new augments are unique, profession-ready, and wired into combat", async () => {
  const newAugmentIds = [
    "focus",
    "caliber",
    "homing",
    "ricochet",
    "execution",
    "giantbane",
    "overcharge",
    "shrapnel",
    "leech",
    "armor",
    "resolve",
    "regeneration",
    "ward",
    "bulwark",
    "momentum",
    "reflex",
    "scholar",
    "scavenger",
    "conquest",
    "frenzy",
  ];
  const [source, professions] = await Promise.all([
    readFile(path.join(root, "app/GameCanvas.tsx"), "utf8"),
    importTypeScriptModule("app/professions.ts"),
  ]);
  const catalog = source.match(/const AUGMENTS: Augment\[\] = \[([\s\S]*?)\n\];\n\nconst SYNERGIES/);
  assert.ok(catalog, "augment catalog must remain statically auditable");
  const catalogIds = [...catalog[1].matchAll(/\bid: "([a-z]+)"/g)].map((match) => match[1]);
  assert.equal(catalogIds.length, 40);
  assert.equal(new Set(catalogIds).size, 40, "augment IDs must be unique");
  assert.deepEqual(catalogIds.slice(-20), newAugmentIds);

  for (const id of newAugmentIds) {
    assert.equal(typeof professions.PROFESSION_TITLES[id], "string", `${id} needs a profession`);
    assert.match(
      source,
      new RegExp(`powerRankOf\\(player, "${id}"\\)`),
      `${id} must affect a runtime calculation`,
    );
  }

  assert.match(source, /projectile\.homing \* dt/);
  assert.match(source, /const shardCount = 2 \+ Math\.min\(6, shrapnelRank\)/);
  assert.match(source, /const executionThreshold = Math\.min\(0\.4/);
  assert.match(source, /Math\.pow\(1 \+ armorRank \* 0\.1, 0\.62\)/);
  assert.match(source, /player\.hp \+ regenerationRank \* 0\.14 \* dt/);
  assert.match(source, /const baseValue = enemy\.kind === 5/);
});

test("three save slots isolate data and preserve the legacy backup on migration", async () => {
  const saves = await importTypeScriptModule("app/save-slots.ts");
  const storage = new MemoryStorage();
  assert.deepEqual(saves.SAVE_SLOT_IDS, [1, 2, 3]);
  assert.equal(saves.writeSaveSlot(2, sampleSave, storage), true);
  assert.equal(saves.readSaveSlot(1, storage), null);
  assert.equal(saves.readSaveSlot(2, storage).player.level, 12);
  assert.equal(saves.readSaveSlotSummaries(storage)[1].augmentStacks, 27);
  assert.equal(saves.removeSaveSlot(2, storage), true);
  assert.equal(saves.readSaveSlot(2, storage), null);

  const legacyRaw = JSON.stringify(sampleSave);
  storage.setItem(saves.LEGACY_SAVE_KEY, legacyRaw);
  assert.equal(saves.migrateLegacySave(storage), "copied");
  assert.equal(storage.getItem(saves.LEGACY_SAVE_KEY), legacyRaw);
  assert.equal(storage.getItem(saves.saveSlotKey(1)), legacyRaw);
  assert.equal(saves.migrateLegacySave(storage), "slot-occupied");
});

test("corrupt saves are rejected without overwriting occupied slot 1", async () => {
  const saves = await importTypeScriptModule("app/save-slots.ts");
  const storage = new MemoryStorage();
  storage.setItem(saves.LEGACY_SAVE_KEY, "{bad json");
  assert.equal(saves.migrateLegacySave(storage), "legacy-invalid");
  assert.equal(storage.getItem(saves.saveSlotKey(1)), null);
  storage.setItem(saves.saveSlotKey(1), "corrupt-but-owned");
  assert.equal(saves.migrateLegacySave(storage), "slot-occupied");
  assert.equal(storage.getItem(saves.saveSlotKey(1)), "corrupt-but-owned");
});

test("generated walk and VFX sheets retain their required PNG dimensions", async () => {
  const expected = new Map([
    ["public/assets/walk/withered-walk-v2.png", [1024, 1536]],
    ["public/assets/walk/threader-walk.png", [1024, 1536]],
    ["public/assets/walk/guardian-walk.png", [1024, 1536]],
    ["public/assets/walk/nest-walk.png", [1024, 1536]],
    ["public/assets/walk/witch-walk.png", [1024, 1536]],
    ["public/assets/walk/cartographer-boss-walk.png", [1024, 1536]],
    ["public/assets/effects/summon-rift.png", [1024, 1024]],
    ["public/assets/effects/teleport-rift.png", [1024, 1024]],
  ]);
  for (const [relativePath, [width, height]] of expected) {
    const png = await readFile(path.join(root, relativePath));
    assert.equal(png.subarray(1, 4).toString("ascii"), "PNG", relativePath);
    assert.equal(png.readUInt32BE(16), width, relativePath);
    assert.equal(png.readUInt32BE(20), height, relativePath);
    assert.equal(png[25], 6, `${relativePath} must be RGBA`);
  }
});

test("generated room backplates and the archived cartography texture remain intact", async () => {
  const roomAssets = [
    "room-battle.webp",
    "room-horde.webp",
    "room-elite.webp",
    "room-memory.webp",
    "room-shelter.webp",
    "room-boss.webp",
  ];
  const allMapAssets = [...roomAssets, "map-board.webp"];

  for (const assetName of allMapAssets) {
    const relativePath = `public/assets/maps/${assetName}`;
    const webp = await readFile(path.join(root, relativePath));
    const [width, height] = assertWebPIntegrity(webp, relativePath);
    if (assetName === "map-board.webp") {
      assert.equal(width, height, `${relativePath} must remain square`);
      assert.ok(width >= 768, `${relativePath} is too small for the expanded map`);
    } else {
      assert.deepEqual([width, height], [1600, 900], relativePath);
    }
  }

  const [game, css] = await Promise.all([
    readFile(path.join(root, "app/GameCanvas.tsx"), "utf8"),
    readFile(path.join(root, "app/game.css"), "utf8"),
  ]);
  for (const assetName of roomAssets) {
    assert.match(game, new RegExp(`/assets/maps/${assetName.replace(".", "\\.")}`));
  }
  assert.doesNotMatch(
    css,
    /url\(["']?\/assets\/maps\/map-board\.webp["']?\)/,
    "a painted route must not masquerade as the generated world map",
  );
  assert.doesNotMatch(
    game,
    /environment\s*:\s*["']\/assets\/environment-tile-atlas\.png["']/,
    "the legacy prop atlas must not be loaded as the room background",
  );
  assert.doesNotMatch(
    game,
    /images\.environment\b/,
    "the legacy prop atlas must not be drawn as the room background",
  );
  assert.doesNotMatch(
    css,
    /environment-tile-atlas\.png/,
    "the expanded map must not reuse the legacy prop atlas",
  );
  assert.match(game, /const ROOM_GEOMETRY = \{/);
  assert.match(game, /horizontalDoorTop: HEIGHT \/ 2 - 64/);
  assert.match(game, /verticalDoorLeft: WIDTH \/ 2 - 74/);
  assert.match(game, /player\.x < ROOM_GEOMETRY\.transitionInsetX/);
  assert.match(game, /player\.y < ROOM_GEOMETRY\.transitionInsetY/);
  assert.match(game, /doorRects\.forEach\(drawDoorWard\)/);
  assert.match(game, /transitionOpacity = clamp\(world\.transition \/ 0\.55, 0, 1\)/);
  assert.doesNotMatch(game, /context\.strokeRect\(68, 64, WIDTH - 136, HEIGHT - 128\)/);
});

test("minimap coordinates, complete snapshots, room states, and square geometry match the world", async () => {
  const [source, css] = await Promise.all([
    readFile(path.join(root, "app/GameCanvas.tsx"), "utf8"),
    readFile(path.join(root, "app/game.css"), "utf8"),
  ]);

  assert.match(
    source,
    /const ROOM_DIRECTIONS = \[\s*\[0, -1\],\s*\[1, 0\],\s*\[0, 1\],\s*\[-1, 0\],\s*\] as const/,
    "north/east/south/west room offsets must match screen orientation",
  );
  assert.match(source, /const knownCoordinates = Object\.keys\(world\.rooms\)/);
  assert.match(source, /gridColumn: x - minimumX \+ 1/);
  assert.match(source, /gridRow: y - minimumY \+ 1/);
  assert.match(source, /room \? `is-\$\{room\.kind\}` : ""/);
  assert.match(source, /data-room-kind=\{room\?\.kind \?\? "unknown"\}/);
  assert.match(source, /data-cleared=\{Boolean\(room\?\.cleared\)\}/);
  assert.match(source, /data-visited=\{wasVisited\}/);
  assert.match(source, /rooms: Object\.fromEntries\(/);
  assert.match(source, /visited: \[\.\.\.world\.visited\]/);
  assert.match(source, /<MapGrid world=\{mapSnapshot\} large \/>/);
  assert.doesNotMatch(source, /<MapGrid world=\{hud\.world\} radius=\{5\} large \/>/);
  assert.match(source, /data-known-rooms=\{hud\.world\.knownRoomCount\}/);
  assert.match(source, /if \(modeRef\.current === "playing"\) openMap\(\)/);

  assert.match(css, /\.minimap-grid \{[\s\S]*?width: 84px;[\s\S]*?height: 84px;/);
  assert.match(
    css,
    /@media \(max-width: 620px\)[\s\S]*?\.minimap-grid:not\(\.is-large\) \{[\s\S]*?width: 70px;[\s\S]*?height: 70px;/,
  );
  assert.match(css, /\.minimap-grid\.is-large \{[\s\S]*?var\(--map-columns/);
  assert.match(css, /\.minimap-grid\.is-large \{[\s\S]*?var\(--map-rows/);
  for (const kind of ["battle", "horde", "elite", "memory", "shelter", "boss"]) {
    assert.match(css, new RegExp(`\\.map-cell\\.is-${kind}\\s*\\{`), `${kind} needs a map style`);
  }
  assert.doesNotMatch(css, /map-board\.webp/);
});

test("corrected augment icons, memory pickups, and layered projectile VFX stay wired", async () => {
  const iconPath = "public/assets/augment-icons-v2.webp";
  const iconAtlas = await readFile(path.join(root, iconPath));
  assert.deepEqual(assertWebPIntegrity(iconAtlas, iconPath), [1280, 1024]);

  const pickupPath = "public/assets/pickups/memory-fragments.png";
  const pickups = await readFile(path.join(root, pickupPath));
  assert.equal(pickups.subarray(1, 4).toString("ascii"), "PNG", pickupPath);
  assert.deepEqual([pickups.readUInt32BE(16), pickups.readUInt32BE(20)], [1254, 1254]);
  assert.equal(pickups[25], 6, `${pickupPath} must keep its alpha channel`);
  assert.ok(pickups.length > 500_000, `${pickupPath} looks unexpectedly truncated`);

  const [source, css] = await Promise.all([
    readFile(path.join(root, "app/GameCanvas.tsx"), "utf8"),
    readFile(path.join(root, "app/game.css"), "utf8"),
  ]);
  assert.match(css, /\.augment-icon[\s\S]*augment-icons-v2\.webp/);
  assert.match(source, /backgroundSize: `\$\{size \* 5\}px \$\{size \* 4\}px`/);
  assert.match(source, /memoryFragments: "\/assets\/pickups\/memory-fragments\.png"/);
  assert.match(source, /drawProjectileVfx\(projectile, ambientTime, world\.projectiles\.length, "trail"\)/);
  assert.match(source, /drawProjectileVfx\(projectile, ambientTime, world\.projectiles\.length, "core"\)/);
  assert.match(source, /spawnCombatEffect\(\s*"chainArc"/);
  assert.match(source, /distanceToSegment\(/);
  for (const affinity of ["arcane", "ember", "storm", "frost", "poison", "echo", "enemy", "witch", "boss"]) {
    assert.match(source, new RegExp(`\\| "${affinity}"`), `${affinity} projectile VFX is missing`);
  }
});

test("enemy-specific direction synthesis and both behavior effects stay wired", async () => {
  const source = await readFile(path.join(root, "app/GameCanvas.tsx"), "utf8");
  assert.match(source, /withered-walk-v2\.png/);
  assert.doesNotMatch(source, /walkWithered:\s*"\/assets\/walk\/withered-walk\.png"/);
  assert.match(source, /makeDirectionFrames\(\[0, 1, 6, 5, 4, 3, 2, 1\], \[false, true\]\)/);
  assert.match(source, /makeDirectionFrames\(\[0, 1, 2, 5, 4, 3, 2, 1\], \[false, true, true\]\)/);
  assert.match(source, /spawnVisualEffect\("summon"/);
  assert.match(source, /spawnVisualEffect\("teleport"/);
  assert.match(source, /summon-rift\.png/);
  assert.match(source, /teleport-rift\.png/);
});
