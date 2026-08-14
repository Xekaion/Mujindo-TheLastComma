import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
  [/import type \{[^;]+\} from "\.\/room-visuals";/, ""],
]);
const roomVisuals = await importTypeScriptModule("app/room-visuals.ts");

const FRAME_COUNT = 6;
const ATLAS_STRIDE_WIDTH = 188;
const ATLAS_STRIDE_HEIGHT = 152;
const ATLAS_WIDTH = FRAME_COUNT * ATLAS_STRIDE_WIDTH;
const ATLAS_HEIGHT = 4 * ATLAS_STRIDE_HEIGHT;
const SEAM_BORDER = 3;

const EXPECTED_CROPS = {
  north: { row: 0, x: 718, y: 0, width: 164, height: 128 },
  east: { row: 1, x: 1444, y: 374, width: 156, height: 152 },
  south: { row: 2, x: 706, y: 770, width: 188, height: 130 },
  west: { row: 3, x: 0, y: 374, width: 156, height: 152 },
};

const BACKDROP_PATHS = {
  ...roomVisuals.ROOM_ART_PATHS,
  ...roomVisuals.ROOM_STAIR_ART_PATHS,
};

const rgbDiffers = (left, leftOffset, right, rightOffset) =>
  left[leftOffset] !== right[rightOffset] ||
  left[leftOffset + 1] !== right[rightOffset + 1] ||
  left[leftOffset + 2] !== right[rightOffset + 2];

function inspectBakedFrame({
  atlasData,
  atlasChannels,
  mapData,
  mapChannels,
  crop,
  frame,
}) {
  let differencePixels = 0;
  const hash = createHash("sha256");
  const pixel = Buffer.allocUnsafe(3);

  for (let y = 0; y < crop.height; y += 1) {
    for (let x = 0; x < crop.width; x += 1) {
      const atlasOffset =
        (((crop.row * ATLAS_STRIDE_HEIGHT + y) * ATLAS_WIDTH +
          frame * ATLAS_STRIDE_WIDTH +
          x) *
          atlasChannels);
      const mapOffset =
        (((crop.y + y) * visuals.ROOM_DOOR_REFERENCE_WIDTH + crop.x + x) *
          mapChannels);
      const differs = rgbDiffers(atlasData, atlasOffset, mapData, mapOffset);
      if (differs) differencePixels += 1;

      pixel[0] = atlasData[atlasOffset];
      pixel[1] = atlasData[atlasOffset + 1];
      pixel[2] = atlasData[atlasOffset + 2];
      hash.update(pixel);

      const onSeamBorder =
        x < SEAM_BORDER ||
        y < SEAM_BORDER ||
        x >= crop.width - SEAM_BORDER ||
        y >= crop.height - SEAM_BORDER;
      if (onSeamBorder) {
        assert.equal(
          differs,
          false,
          `frame ${frame} alters the ${SEAM_BORDER}px room seam at ${x},${y}`,
        );
      }
    }
  }

  return {
    differencePixels,
    hash: hash.digest("hex"),
  };
}

test("all base and stair backplates own opaque six-frame room-baked door atlases", async () => {
  assert.equal(visuals.ROOM_DOOR_ATLAS_CELL_WIDTH, ATLAS_STRIDE_WIDTH);
  assert.equal(visuals.ROOM_DOOR_ATLAS_CELL_HEIGHT, ATLAS_STRIDE_HEIGHT);
  assert.equal(visuals.ROOM_DOOR_ATLAS_COLUMN_COUNT, FRAME_COUNT);
  assert.equal(visuals.ROOM_DOOR_ATLAS_ROW_COUNT, 4);
  assert.deepEqual(
    Object.keys(visuals.ROOM_DOOR_VISUALS).sort(),
    Object.keys(BACKDROP_PATHS).sort(),
    "the manifest must cover nine base rooms and their nine stair backplates",
  );

  for (const [backdropKey, backdropPath] of Object.entries(BACKDROP_PATHS)) {
    const definition = visuals.ROOM_DOOR_VISUALS[backdropKey];
    assert.ok(definition, `${backdropKey} is missing its room-baked door atlas`);
    const backdropSlug = path.basename(backdropPath, ".webp");
    assert.equal(
      definition.imagePath,
      `/assets/effects/room-doors-v3/${backdropSlug}-doors-v3.webp`,
    );
    assert.deepEqual(definition.sides, EXPECTED_CROPS);

    const assetPath = path.join(
      root,
      "public",
      definition.imagePath.replace(/^\//, ""),
    );
    const mapPath = path.join(root, "public", backdropPath.replace(/^\//, ""));
    const metadata = await sharp(assetPath).metadata();
    assert.deepEqual(
      [metadata.width, metadata.height, metadata.hasAlpha],
      [ATLAS_WIDTH, ATLAS_HEIGHT, false],
      `${backdropKey} must be an opaque RGB ${ATLAS_WIDTH}x${ATLAS_HEIGHT} atlas`,
    );

    const [{ data: atlasData, info: atlasInfo }, { data: mapData, info: mapInfo }] =
      await Promise.all([
        sharp(assetPath).removeAlpha().raw().toBuffer({ resolveWithObject: true }),
        sharp(mapPath).removeAlpha().raw().toBuffer({ resolveWithObject: true }),
      ]);
    assert.equal(atlasInfo.channels, 3, `${backdropKey} atlas must decode as RGB`);
    assert.deepEqual(
      [mapInfo.width, mapInfo.height, mapInfo.channels],
      [
        visuals.ROOM_DOOR_REFERENCE_WIDTH,
        visuals.ROOM_DOOR_REFERENCE_HEIGHT,
        3,
      ],
      `${backdropKey} source map must remain the 1600x900 RGB reference`,
    );

    for (const [side, crop] of Object.entries(EXPECTED_CROPS)) {
      const frames = [];
      for (let frame = 0; frame < FRAME_COUNT; frame += 1) {
        try {
          frames.push(
            inspectBakedFrame({
              atlasData,
              atlasChannels: atlasInfo.channels,
              mapData,
              mapChannels: mapInfo.channels,
              crop,
              frame,
            }),
          );
        } catch (error) {
          error.message = `${backdropKey}/${side}: ${error.message}`;
          throw error;
        }
      }

      assert.ok(
        frames[0].differencePixels > 0,
        `${backdropKey}/${side} closed frame must contain a baked iron door`,
      );
      for (let frame = 1; frame < FRAME_COUNT; frame += 1) {
        assert.ok(
          frames[frame].differencePixels < frames[frame - 1].differencePixels,
          `${backdropKey}/${side} frame ${frame} must reveal more of the source room`,
        );
        assert.notEqual(
          frames[frame].hash,
          frames[frame - 1].hash,
          `${backdropKey}/${side} frames ${frame - 1} and ${frame} must be visibly distinct`,
        );
      }
      assert.equal(
        frames[FRAME_COUNT - 1].differencePixels,
        0,
        `${backdropKey}/${side} open frame must exactly reproduce its source map crop`,
      );
    }
  }
});

test("atlas sampling uses each room crop's native dimensions inside the 188x152 stride", () => {
  const source = visuals.roomDoorAtlasSourceRect(
    "west",
    5,
    EXPECTED_CROPS.west,
  );
  assert.deepEqual(source, {
    x: 5 * ATLAS_STRIDE_WIDTH,
    y: 3 * ATLAS_STRIDE_HEIGHT,
    width: EXPECTED_CROPS.west.width,
    height: EXPECTED_CROPS.west.height,
  });
  assert.deepEqual(
    visuals.roomDoorAtlasSourceRect("north", -99, EXPECTED_CROPS.north),
    {
      x: 0,
      y: 0,
      width: EXPECTED_CROPS.north.width,
      height: EXPECTED_CROPS.north.height,
    },
  );
  assert.equal(
    visuals.roomDoorAtlasSourceRect("south", 999, EXPECTED_CROPS.south).x,
    5 * ATLAS_STRIDE_WIDTH,
  );

  assert.deepEqual(
    visuals.roomDoorCanvasRect(EXPECTED_CROPS.north, 1280, 720),
    { x: 574.4, y: 0, width: 131.2, height: 102.4 },
  );
  assert.equal(visuals.mirroredRoomDoorSide("west"), "east");
  assert.equal(visuals.mirroredRoomDoorSide("east"), "west");
  assert.equal(visuals.mirroredRoomDoorSide("north"), "north");
});

test("runtime selects the active base or stair backplate and never flashes black door rectangles", async () => {
  const source = await readFile(path.join(root, "app/GameCanvas.tsx"), "utf8");
  assert.match(
    source,
    /const backdropKey\s*=\s*[\s\S]{0,240}?stairRoomArtReady[\s\S]{0,180}?stairRoomArtKey[\s\S]{0,180}?roomArtKey/,
    "door patches must follow whichever base or stair backplate was actually drawn",
  );
  assert.match(source, /ROOM_DOOR_VISUALS\[backdropKey\]/);
  assert.match(source, /roomDoorVisualImageKey\(backdropKey\)/);
  assert.match(
    source,
    /roomDoorAtlasSourceRect\(\s*authoredSide,\s*frame,\s*roomDoorVisual\.sides\[authoredSide\],?\s*\)/,
  );
  assert.match(source, /if \(mirrorRoom\)[\s\S]{0,180}?context\.scale\(-1, 1\)/);
  assert.match(source, /mirroredRoomDoorSide\(physicalSide\)/);
  assert.match(source, /if \(physicalSide === "south"\) continue/);

  const firstDoorRender = source.indexOf(
    "if (roomDoorVisualReady && roomDoorVisualImage)",
  );
  const playerInput = source.indexOf(
    "if (inputRef.current.hasMoveTarget)",
    firstDoorRender,
  );
  assert.ok(firstDoorRender >= 0 && playerInput > firstDoorRender);
  assert.doesNotMatch(
    source.slice(firstDoorRender, playerInput),
    /fillRect\(/,
    "an undecoded atlas must leave the painted backplate intact instead of flashing black rectangles",
  );

  const playerStart = source.indexOf("const playerWalkFrame = characterRenderFrameIndex");
  const foregroundStart = source.indexOf(
    "The southern doorway belongs to the foreground wall",
  );
  assert.ok(
    playerStart >= 0 && foregroundStart > playerStart,
    "the baked south-door patch must remain a foreground layer after the player",
  );
  assert.doesNotMatch(
    source.slice(
      source.indexOf("world.doorEffects = []"),
      source.indexOf("world.clearHandled"),
    ),
    /playerImpact|doorEffects\.push/,
    "entering a room must not add a vector impact over authored baked doors",
  );
  assert.doesNotMatch(
    source.slice(firstDoorRender, playerInput),
    /context\.rotate\(/,
    "room-baked side doors must never be made by rotating one front-facing gate",
  );
});
