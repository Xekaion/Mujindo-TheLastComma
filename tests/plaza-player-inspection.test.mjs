import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import ts from "typescript";

const root = process.cwd();

async function importInspectionModule() {
  const relativePath = "app/plaza-player-inspection.ts";
  const source = await readFile(path.join(root, relativePath), "utf8");
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

test("canvas CSS coordinates map to the camera-centered plaza viewport", async () => {
  const { canvasClientPointToWorld } = await importInspectionModule();
  const rect = { left: 20, top: 30, width: 640, height: 360 };
  const viewport = { width: 1_280, height: 720 };
  const camera = { x: 1_300, y: 700 };

  assert.deepEqual(
    canvasClientPointToWorld(340, 210, rect, viewport, camera),
    camera,
    "the displayed canvas center must always resolve to the camera center",
  );
  assert.deepEqual(
    canvasClientPointToWorld(180, 120, rect, viewport, camera),
    { x: 980, y: 520 },
    "CSS-scaled quarter coordinates must map into the logical viewport",
  );
  assert.deepEqual(
    canvasClientPointToWorld(660, 390, rect, viewport, camera),
    { x: 1_940, y: 1_060 },
  );
});

test("invalid canvas geometry returns a finite camera fallback", async () => {
  const { canvasClientPointToWorld } = await importInspectionModule();
  const viewport = { width: 1_280, height: 720 };

  assert.deepEqual(
    canvasClientPointToWorld(
      Number.NaN,
      100,
      { left: 0, top: 0, width: 640, height: 360 },
      viewport,
      { x: 800, y: 600 },
    ),
    { x: 800, y: 600 },
  );
  assert.deepEqual(
    canvasClientPointToWorld(
      100,
      100,
      { left: 0, top: 0, width: 0, height: 360 },
      viewport,
      { x: 800, y: 600 },
    ),
    { x: 800, y: 600 },
  );
  assert.deepEqual(
    canvasClientPointToWorld(
      100,
      100,
      { left: 0, top: 0, width: 640, height: 360 },
      viewport,
      { x: Number.POSITIVE_INFINITY, y: Number.NaN },
    ),
    { x: 0, y: 0 },
  );
});

test("player inspection hit boxes include the rendered body and reject misses", async () => {
  const { pickPlazaInspectablePlayer } = await importInspectionModule();
  const player = { id: "remote-a", x: 500, y: 400 };

  assert.strictEqual(
    pickPlazaInspectablePlayer([player], { x: 500, y: 300 }),
    player,
  );
  assert.strictEqual(
    pickPlazaInspectablePlayer([player], { x: 448, y: 288 }),
    player,
    "the authored hit-box boundary is inclusive",
  );
  assert.equal(
    pickPlazaInspectablePlayer([player], { x: 447.99, y: 350 }),
    null,
  );
  assert.equal(
    pickPlazaInspectablePlayer([player], { x: 500, y: 436.01 }),
    null,
  );
  assert.equal(pickPlazaInspectablePlayer([], { x: 500, y: 400 }), null);
  assert.equal(
    pickPlazaInspectablePlayer([player], { x: Number.NaN, y: 400 }),
    null,
  );
  assert.equal(
    pickPlazaInspectablePlayer(
      [{ id: "invalid", x: Number.NaN, y: 400 }],
      { x: 500, y: 400 },
    ),
    null,
  );
});

test("overlapping players follow plaza draw order then center distance", async () => {
  const { pickPlazaInspectablePlayer } = await importInspectionModule();
  const higher = { id: "higher", x: 500, y: 390 };
  const drawnLater = { id: "drawn-later", x: 500, y: 420 };

  assert.strictEqual(
    pickPlazaInspectablePlayer([drawnLater, higher], { x: 500, y: 350 }),
    drawnLater,
    "larger ground Y wins regardless of input order",
  );

  const farther = { id: "farther", x: 470, y: 400 };
  const nearer = { id: "nearer", x: 510, y: 400 };
  assert.strictEqual(
    pickPlazaInspectablePlayer([nearer, farther], { x: 505, y: 360 }),
    nearer,
    "equal-Y overlap resolves to the nearest character center",
  );

  const exactTieFirst = { id: "tie-first", x: 500, y: 400 };
  const exactTieLast = { id: "tie-last", x: 500, y: 400 };
  assert.strictEqual(
    pickPlazaInspectablePlayer(
      [exactTieFirst, exactTieLast],
      { x: 500, y: 350 },
    ),
    exactTieLast,
    "an exact tie preserves the later render-list entry",
  );
});
