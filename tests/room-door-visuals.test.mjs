import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import sharp from "sharp";
import ts from "typescript";

const root = process.cwd();

async function importTypeScriptModule(relativePath, replacements = []) {
  let source = await readFile(path.join(root, relativePath), "utf8");
  for (const [pattern, replacement] of replacements) {
    source = source.replace(pattern, replacement);
  }
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

const visuals = await importTypeScriptModule("app/room-door-visuals.ts", [
  [/import \{ ROOM_DOOR_FRAME_COUNT \} from "\.\/room-doors";/, "const ROOM_DOOR_FRAME_COUNT = 6;"],
  [/import type \{ RoomArtKey \} from "\.\/room-visuals";/, ""],
]);

test("every room painting owns a six-frame four-side perspective atlas", async () => {
  assert.equal(visuals.ROOM_DOOR_ATLAS_COLUMN_COUNT, 6);
  assert.equal(visuals.ROOM_DOOR_ATLAS_ROW_COUNT, 4);
  assert.equal(Object.keys(visuals.ROOM_DOOR_VISUALS).length, 9);

  for (const [roomArtKey, definition] of Object.entries(visuals.ROOM_DOOR_VISUALS)) {
    assert.match(
      definition.imagePath,
      new RegExp(`/room-doors-v2/${roomArtKey.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}-doors-v2\\.webp$`),
    );
    const asset = path.join(root, "public", definition.imagePath.replace(/^\//, ""));
    const metadata = await sharp(asset).metadata();
    assert.deepEqual(
      [metadata.width, metadata.height, metadata.hasAlpha],
      [
        6 * visuals.ROOM_DOOR_ATLAS_CELL_WIDTH,
        4 * visuals.ROOM_DOOR_ATLAS_CELL_HEIGHT,
        true,
      ],
      `${roomArtKey} must be a transparent six-by-four atlas`,
    );
    const image = sharp(asset).ensureAlpha();
    let previousCoverage = Number.POSITIVE_INFINITY;
    for (let frame = 0; frame < 6; frame += 1) {
      const { data, info } = await image
        .clone()
        .extract({
          left: frame * visuals.ROOM_DOOR_ATLAS_CELL_WIDTH,
          top: 0,
          width: visuals.ROOM_DOOR_ATLAS_CELL_WIDTH,
          height: visuals.ROOM_DOOR_ATLAS_CELL_HEIGHT,
        })
        .raw()
        .toBuffer({ resolveWithObject: true });
      let coverage = 0;
      for (let offset = 3; offset < data.length; offset += info.channels) {
        if (data[offset] >= 16) coverage += 1;
      }
      assert.ok(coverage <= previousCoverage, `${roomArtKey} frame ${frame} cannot grow while opening`);
      previousCoverage = coverage;
      if (frame === 0) assert.ok(coverage > 5_000, `${roomArtKey} closed frame is empty`);
      if (frame === 5) assert.equal(coverage, 0, `${roomArtKey} open frame must be transparent`);
    }
    assert.deepEqual(Object.keys(definition.sides), ["north", "east", "south", "west"]);
    for (const [index, side] of visuals.ROOM_DOOR_SIDES.entries()) {
      const crop = definition.sides[side];
      assert.equal(crop.row, index);
      assert.ok(crop.x >= 0 && crop.y >= 0);
      assert.ok(crop.width > 0 && crop.height > 0);
      assert.ok(crop.x + crop.width <= visuals.ROOM_DOOR_REFERENCE_WIDTH);
      assert.ok(crop.y + crop.height <= visuals.ROOM_DOOR_REFERENCE_HEIGHT);
    }
  }
});

test("atlas sampling and room-space placement preserve side and frame identity", () => {
  const source = visuals.roomDoorAtlasSourceRect("west", 5);
  assert.deepEqual(source, {
    x: 5 * visuals.ROOM_DOOR_ATLAS_CELL_WIDTH,
    y: 3 * visuals.ROOM_DOOR_ATLAS_CELL_HEIGHT,
    width: visuals.ROOM_DOOR_ATLAS_CELL_WIDTH,
    height: visuals.ROOM_DOOR_ATLAS_CELL_HEIGHT,
  });
  assert.equal(visuals.roomDoorAtlasSourceRect("north", -99).x, 0);
  assert.equal(
    visuals.roomDoorAtlasSourceRect("north", 999).x,
    5 * visuals.ROOM_DOOR_ATLAS_CELL_WIDTH,
  );

  const crop = { row: 0, x: 718, y: 0, width: 164, height: 128 };
  assert.deepEqual(visuals.roomDoorCanvasRect(crop, 1280, 720), {
    x: 574.4,
    y: 0,
    width: 131.2,
    height: 102.4,
  });
  assert.equal(visuals.mirroredRoomDoorSide("west"), "east");
  assert.equal(visuals.mirroredRoomDoorSide("east"), "west");
  assert.equal(visuals.mirroredRoomDoorSide("north"), "north");
});

test("runtime composites room-specific crops and never rotates the legacy front gate", async () => {
  const source = await readFile(path.join(root, "app/GameCanvas.tsx"), "utf8");
  assert.match(source, /const roomDoorVisual = ROOM_DOOR_VISUALS\[roomArtKey\]/);
  assert.match(source, /roomDoorAtlasSourceRect\(authoredSide, frame\)/);
  assert.match(source, /roomDoorCanvasRect\(\s*roomDoorVisual\.sides\[authoredSide\]/);
  assert.match(source, /if \(mirrorRoom\)[\s\S]{0,180}?context\.scale\(-1, 1\)/);
  assert.match(source, /if \(roomDoorVisualReady && roomDoorVisualImage\)/);
  assert.doesNotMatch(source, /ROOM_DOOR_PLACEMENTS|ROOM_DOOR_ASSET_PATH|roomPortcullis/);
  assert.match(source, /Never flash the old front-facing gate rotated onto side walls/);
  assert.match(source, /if \(physicalSide === "south"\) continue/);
  const playerStart = source.indexOf("const playerWalkFrame = characterRenderFrameIndex");
  const foregroundStart = source.indexOf("The southern doorway belongs to the foreground wall");
  assert.ok(playerStart >= 0 && foregroundStart > playerStart, "south door must composite after the player");
  assert.doesNotMatch(
    source.slice(source.indexOf("world.doorEffects = []"), source.indexOf("world.clearHandled")),
    /playerImpact|doorEffects\.push/,
    "entering a room must not draw the old red vector impact over authored doors",
  );
  assert.doesNotMatch(
    source.slice(source.indexOf("if (roomDoorVisualReady"), source.indexOf("if (inputRef.current.hasMoveTarget")),
    /context\.rotate\(/,
    "the normal authored path must never rotate one front-facing gate",
  );
});
