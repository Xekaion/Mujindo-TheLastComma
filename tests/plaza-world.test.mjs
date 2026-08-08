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

test("the shared plaza keeps one 16:9 world and four cardinal portals", async () => {
  const plaza = await importTypeScriptModule("app/plaza-world.ts");
  assert.equal(plaza.PLAZA_WORLD_WIDTH, 2_400);
  assert.equal(plaza.PLAZA_WORLD_HEIGHT, 1_350);
  assert.equal(plaza.PLAZA_WORLD_WIDTH / plaza.PLAZA_WORLD_HEIGHT, 16 / 9);
  assert.deepEqual(plaza.PLAZA_SPAWN_POINT, { x: 1_200, y: 675 });
  assert.deepEqual(
    plaza.PLAZA_PORTALS.map((portal) => portal.id),
    ["expedition", "duel", "exchange", "caravan"],
  );
  assert.equal(plaza.PLAZA_PORTALS[0].x, plaza.PLAZA_WORLD_WIDTH / 2);
  assert.ok(plaza.PLAZA_PORTALS[0].y < plaza.PLAZA_WORLD_HEIGHT / 2);
  assert.ok(plaza.PLAZA_PORTALS[1].x < plaza.PLAZA_WORLD_WIDTH / 2);
  assert.ok(plaza.PLAZA_PORTALS[2].x > plaza.PLAZA_WORLD_WIDTH / 2);
  assert.equal(plaza.PLAZA_PORTALS[3].x, plaza.PLAZA_WORLD_WIDTH / 2);
  assert.ok(plaza.PLAZA_PORTALS[3].y > plaza.PLAZA_WORLD_HEIGHT / 2);
  assert.deepEqual(
    plaza.PLAZA_PORTALS.map((portal) => portal.href),
    ["/?mode=expedition", "/pvp", "/market", "/?shop=1"],
  );
});

test("every portal has a reachable approach point with unambiguous proximity", async () => {
  const plaza = await importTypeScriptModule("app/plaza-world.ts");
  for (const portal of plaza.PLAZA_PORTALS) {
    const approach = { x: portal.approachX, y: portal.approachY };
    assert.equal(plaza.isPlazaWalkable(approach), true, `${portal.id} approach must be walkable`);
    assert.equal(plaza.nearestPlazaPortal(approach)?.id, portal.id);
  }
  assert.equal(plaza.nearestPlazaPortal({ x: 1_200, y: 675 }), null);
});

test("the plaza keeps the central crowd space open and blocks its visible outer wall", async () => {
  const plaza = await importTypeScriptModule("app/plaza-world.ts");
  assert.equal(plaza.isPlazaWalkable({ x: 1_200, y: 675 }), true);
  assert.equal(plaza.isPlazaWalkable({ x: 1_200, y: 60 }), false);
  assert.equal(plaza.isPlazaWalkable({ x: 40, y: 675 }), false);
  assert.equal(plaza.isPlazaWalkable({ x: 2_360, y: 675 }), false);
  assert.equal(plaza.isPlazaWalkable({ x: 1_200, y: 1_310 }), false);
  assert.equal(plaza.isPlazaWalkable({ x: 700, y: 170 }), false);
  assert.equal(plaza.isPlazaWalkable({ x: 170, y: 400 }), false);
  assert.equal(plaza.isPlazaWalkable({ x: 1_700, y: 1_120 }), false);

  const start = { x: 1_200, y: 125 };
  assert.equal(plaza.isPlazaWalkable(start), true);
  assert.deepEqual(plaza.resolvePlazaMovement(start, { x: 0, y: -200 }), start);
});

test("plaza facing and Harin's authored rows stay aligned in all eight directions", async () => {
  const plaza = await importTypeScriptModule("app/plaza-world.ts");
  const vectors = [
    [0, 1],
    [-1, 1],
    [-1, 0],
    [-1, -1],
    [0, -1],
    [1, -1],
    [1, 0],
    [1, 1],
  ];
  assert.deepEqual(
    vectors.map(([x, y]) => plaza.plazaFacingForVector(x, y)),
    [0, 1, 2, 3, 4, 5, 6, 7],
  );
  assert.deepEqual(
    Array.from({ length: 8 }, (_, facing) => plaza.plazaSpriteRowForFacing(facing)),
    [0, 7, 6, 3, 4, 5, 2, 1],
  );
});

test("PlazaHub uses the generated map, authoritative intent, and accessible controls", async () => {
  const source = await readFile(path.join(root, "app/PlazaHub.tsx"), "utf8");
  assert.match(source, /memory-plaza-v1\.png/);
  assert.match(source, /onMoveIntent/);
  assert.match(source, /localAuthoritativePosition/);
  assert.match(source, /aria-label="광장 포탈 안내"/);
  assert.match(source, /aria-label="터치 이동 조작"/);
  assert.match(source, /onPointerDown=\{handleCanvasPointer\}/);
  assert.match(source, /remotePlayers/);
  assert.match(source, /lastSentIntentRef/);
  assert.match(source, /const intentChanged =/);
  assert.match(source, /normalizedCharacterRef\.current/);
  assert.doesNotMatch(
    source,
    /\}, \[guidedPortalId, normalizedCharacter, onMoveIntent\]\);/,
  );
});
