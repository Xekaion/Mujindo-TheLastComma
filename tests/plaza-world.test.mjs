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

test("long plaza dash impulses sweep the full path instead of tunneling through scenery", async () => {
  const plaza = await importTypeScriptModule("app/plaza-world.ts");
  const start = { x: 1_200, y: 280 };
  const dashedNorth = plaza.resolvePlazaSweptMovement(start, { x: 0, y: -180 });
  assert.equal(plaza.isPlazaWalkable(dashedNorth), true);
  assert.ok(dashedNorth.y >= 113, "the dash must remain inside the visible north boundary");

  const deskStart = { x: 950, y: 1_020 };
  const dashedThroughDesk = plaza.resolvePlazaSweptMovement(
    deskStart,
    { x: -550, y: 0 },
  );
  assert.equal(plaza.isPlazaWalkable(dashedThroughDesk), true);
  assert.ok(
    dashedThroughDesk.x >= 881,
    "a valid endpoint behind the southern desk must not allow wall tunneling",
  );

  const diagonal = plaza.resolvePlazaSweptMovement(
    { x: 1_200, y: 675 },
    { x: 108.19, y: 108.19 },
  );
  assert.equal(plaza.isPlazaWalkable(diagonal), true);
  assert.ok(Math.hypot(diagonal.x - 1_200, diagonal.y - 675) <= 153.01);
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

test("PlazaHub supports keyboard and touch dash with authored mobility-power VFX", async () => {
  const source = await readFile(path.join(root, "app/PlazaHub.tsx"), "utf8");
  assert.match(source, /key === " " && !event\.repeat/);
  assert.match(source, /const queueDash = useCallback/);
  assert.match(source, /onDashIntentRef\.current\?\.\(\)/);
  assert.match(source, /resolvePlazaSweptMovement\(positionRef\.current/);
  assert.match(source, /const usesServerAuthority = Boolean\(onDashIntentRef\.current\)/);
  assert.match(source, /usesServerAuthority \? HUB_DASH_SPEED : mobility\.dashSpeed/);
  assert.match(
    source,
    /HUB_DASH_COOLDOWN_MS \/ 1_000 \+ \(usesServerAuthority \? 0\.1 : 0\)/,
  );
  assert.match(source, /isDashing \? 220 : undefined/);
  assert.match(source, /className="is-dash"/);
  assert.match(source, /aria-label="회피 대시"/);
  assert.match(source, /legendaryVfxId\("starfallMantle"\)/);
  assert.match(source, /legendaryVfxId\("riftStride"\)/);
  assert.match(source, /legendaryVfxId\("phantomMarch"\)/);
  assert.match(source, /paperdollVisualCenterY\(/);
  assert.match(source, /advanceContinuousMovement\(/);
  assert.match(source, /equipment\?: EquipmentLoadout \| null/);
  assert.match(source, /Local-only loadout/);
});

test("plaza paperdolls contact their shadows instead of floating above them", async () => {
  const source = await readFile(path.join(root, "app/PlazaHub.tsx"), "utf8");
  const readConstant = (name) => {
    const match = source.match(new RegExp(`export const ${name} = (\\d+);`));
    assert.ok(match, `${name} is missing`);
    return Number(match[1]);
  };
  const ground = readConstant("PLAZA_PLAYER_GROUND_OFFSET_Y");
  const shadowCenter = readConstant("PLAZA_PLAYER_SHADOW_CENTER_OFFSET_Y");
  const shadowRadius = readConstant("PLAZA_PLAYER_SHADOW_RADIUS_Y");

  assert.ok(
    shadowCenter - shadowRadius <= ground,
    "the top of the plaza shadow must meet or overlap the authored foot baseline",
  );
  assert.ok(
    ground - (shadowCenter - shadowRadius) <= 3,
    "the shadow must not climb far enough to cover the lower body",
  );
  assert.match(source, /y: player\.y \+ PLAZA_PLAYER_GROUND_OFFSET_Y/g);
  assert.match(
    source,
    /player\.y \+ PLAZA_PLAYER_SHADOW_CENTER_OFFSET_Y,[\s\S]{0,100}?PLAZA_PLAYER_SHADOW_RADIUS_Y/,
  );
  assert.doesNotMatch(source, /context\.ellipse\(player\.x, player\.y \+ 24/);
});

test("plaza reconciliation stays frame-driven and settles without idle sliding", async () => {
  const source = await readFile(path.join(root, "app/PlazaHub.tsx"), "utf8");
  assert.match(
    source,
    /authoritativePositionRef\.current = localAuthoritativePosition[\s\S]{0,180}?authoritativeMovingRef\.current = Boolean\(localAuthoritativeMoving\)/,
  );
  assert.doesNotMatch(source, /positionRef\.current = \{[\s\S]{0,100}?\* 0\.34/);
  assert.match(
    source,
    /!hasMovementInput &&[\s\S]{0,80}?authoritativeTarget &&[\s\S]{0,80}?!authoritativeMovingRef\.current/,
  );
  assert.match(
    source,
    /const correctionAlpha = 1 - Math\.exp\(-dt \* LOCAL_CORRECTION_RESPONSE_PER_SECOND\);[\s\S]{0,180}?resolvePlazaMovement/,
  );
  assert.match(
    source,
    /const cameraLerp = 1 - Math\.exp\(-dt \* CAMERA_RESPONSE_PER_SECOND\)/,
  );
  assert.match(
    source,
    /!player\.moving && remainingDistance <= REMOTE_SETTLE_DISTANCE[\s\S]{0,160}?previousRenderX = renderPoint\.x;[\s\S]{0,80}?previousRenderY = renderPoint\.y/,
  );

  const responseMatch = source.match(/const CAMERA_RESPONSE_PER_SECOND = ([\d.]+);/);
  assert.ok(responseMatch);
  const response = Number(responseMatch[1]);
  const afterOneSecond = (fps) => {
    let value = 0;
    const alpha = 1 - Math.exp(-(1 / fps) * response);
    for (let frame = 0; frame < fps; frame += 1) value += (1 - value) * alpha;
    return value;
  };
  const samples = [30, 60, 144].map(afterOneSecond);
  assert.ok(Math.max(...samples) - Math.min(...samples) < 1e-12);
});
