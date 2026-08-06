import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import ts from "typescript";

const root = process.cwd();

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

test("PVP protocol normalizes movement and strips client-authority fields", async () => {
  const protocol = await importTypeScriptModule("app/pvp-protocol.ts");
  assert.equal(protocol.PVP_ARENA_WIDTH, 1280);
  assert.equal(protocol.PVP_ARENA_HEIGHT, 720);
  assert.equal(protocol.PVP_ROUND_DURATION_MS, 90_000);
  assert.equal(protocol.PVP_SCORE_TO_WIN, 3);

  const parsed = protocol.parseRealtimeClientMessage({
    type: "pvp_input",
    sequence: 9,
    moveX: 10,
    moveY: 0,
    aimX: 4,
    aimY: 3,
    fire: true,
    dash: false,
    x: 0,
    y: 0,
    damage: 999_999,
    victory: true,
  });
  assert.deepEqual(parsed, {
    type: "pvp_input",
    sequence: 9,
    moveX: 1,
    moveY: 0,
    aimX: 0.8,
    aimY: 0.6,
    fire: true,
    dash: false,
  });
  assert.equal(protocol.parseRealtimeClientMessage({ type: "pvp_input" }), null);
  assert.equal(
    protocol.parseRealtimeClientMessage({
      type: "pvp_input",
      sequence: 1,
      moveX: Number.POSITIVE_INFINITY,
      moveY: 0,
      aimX: 1,
      aimY: 0,
      fire: true,
      dash: false,
    }),
    null,
  );
});

test("world loot protocol only admits mythic and cosmic acquisitions", async () => {
  const protocol = await importTypeScriptModule("app/pvp-protocol.ts");
  const base = {
    type: "announce_loot",
    acquisitionId: "acquisition-proof-001",
    itemName: "  태초의   별검  ",
    itemLevel: 1_200,
    enhancement: 17,
  };
  assert.equal(
    protocol.parseRealtimeClientMessage({ ...base, rarity: "legendary" }),
    null,
  );
  assert.deepEqual(
    protocol.parseRealtimeClientMessage({ ...base, rarity: "mythic" }),
    {
      type: "announce_loot",
      acquisitionId: "acquisition-proof-001",
      itemName: "태초의 별검",
      rarity: "mythic",
      itemLevel: 999,
      enhancement: 10,
    },
  );
});

test("PVP worker is server authoritative and wired through one durable world", async () => {
  const [worker, entry, vite, game, page, arena] = await Promise.all([
    readFile(path.join(root, "worker/realtime-world.ts"), "utf8"),
    readFile(path.join(root, "worker/index.ts"), "utf8"),
    readFile(path.join(root, "vite.config.ts"), "utf8"),
    readFile(path.join(root, "app/GameCanvas.tsx"), "utf8"),
    readFile(path.join(root, "app/pvp/page.tsx"), "utf8"),
    readFile(path.join(root, "app/pvp/PvpArena.tsx"), "utf8"),
  ]);

  assert.match(worker, /PROJECTILE_DAMAGE\s*=\s*18/);
  assert.match(worker, /target\.hp\s*=\s*Math\.max\(0, target\.hp - projectile\.damage\)/);
  assert.match(worker, /owner\.score\s*\+=\s*1/);
  assert.match(worker, /input\.sequence\s*<=\s*matchPlayer\.lastInputSequence/);
  assert.match(worker, /MAX_INPUTS_PER_SECOND/);
  assert.match(entry, /REALTIME_WORLD\.idFromName\("mujindo-global-v1"\)/);
  assert.match(vite, /name:\s*"REALTIME_WORLD"/);
  assert.match(vite, /new_sqlite_classes:\s*\["RealtimeWorld"\]/);
  assert.match(page, /<PvpArena/);
  assert.match(arena, /getRealtimeClient\(\)\.sendPvpInput/);

  const pickupIndex = game.indexOf("player.inventory.push(cloneGearItem(drop.item));");
  const announcementIndex = game.indexOf("getRealtimeClient().announceLoot", pickupIndex);
  const bagFullIndex = game.indexOf("player.inventory.length >= inventoryCapacityRef.current");
  assert.ok(bagFullIndex >= 0 && bagFullIndex < pickupIndex);
  assert.ok(pickupIndex >= 0 && announcementIndex > pickupIndex);
  assert.match(
    game.slice(pickupIndex, announcementIndex + 100),
    /drop\.item\.rarity === "mythic"[\s\S]*drop\.item\.rarity === "cosmic"/,
  );
});
