import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
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
const CELL_WIDTH = 1280;
const CELL_HEIGHT = 720;
const ATLAS_COLUMNS = 2;
const ATLAS_ROWS = 3;
const ATLAS_WIDTH = CELL_WIDTH * ATLAS_COLUMNS;
const ATLAS_HEIGHT = CELL_HEIGHT * ATLAS_ROWS;
const PIXEL_DIFFERENCE_THRESHOLD = 6;
const DOOR_REGION_GUARD_PIXELS = 3;

const EXPECTED_DOORWAY_CLIPS = {
  north: { x: 574.4, y: 0, width: 131.2, height: 102.4 },
  east: { x: 1155.2, y: 299.2, width: 124.8, height: 121.6 },
  south: { x: 564.8, y: 616, width: 150.4, height: 104 },
  west: { x: 0, y: 299.2, width: 124.8, height: 121.6 },
};

const BACKDROP_PATHS = {
  ...roomVisuals.ROOM_ART_PATHS,
  ...roomVisuals.ROOM_STAIR_ART_PATHS,
};

const guardedDoorPixels = new Uint8Array(CELL_WIDTH * CELL_HEIGHT);
for (const clip of Object.values(EXPECTED_DOORWAY_CLIPS)) {
  const left = Math.max(0, Math.floor(clip.x - DOOR_REGION_GUARD_PIXELS));
  const top = Math.max(0, Math.floor(clip.y - DOOR_REGION_GUARD_PIXELS));
  const right = Math.min(
    CELL_WIDTH,
    Math.ceil(clip.x + clip.width + DOOR_REGION_GUARD_PIXELS),
  );
  const bottom = Math.min(
    CELL_HEIGHT,
    Math.ceil(clip.y + clip.height + DOOR_REGION_GUARD_PIXELS),
  );
  for (let y = top; y < bottom; y += 1) {
    guardedDoorPixels.fill(1, y * CELL_WIDTH + left, y * CELL_WIDTH + right);
  }
}

const frameRect = (frame) => ({
  left: (frame % ATLAS_COLUMNS) * CELL_WIDTH,
  top: Math.floor(frame / ATLAS_COLUMNS) * CELL_HEIGHT,
  width: CELL_WIDTH,
  height: CELL_HEIGHT,
});

function visuallyDifferentPixels(left, right) {
  assert.equal(left.length, right.length);
  let count = 0;
  for (let offset = 0; offset < left.length; offset += 3) {
    if (
      Math.abs(left[offset] - right[offset]) > PIXEL_DIFFERENCE_THRESHOLD ||
      Math.abs(left[offset + 1] - right[offset + 1]) > PIXEL_DIFFERENCE_THRESHOLD ||
      Math.abs(left[offset + 2] - right[offset + 2]) > PIXEL_DIFFERENCE_THRESHOLD
    ) {
      count += 1;
    }
  }
  return count;
}

function imageDifference(left, right) {
  assert.equal(left.length, right.length);
  let absoluteDifference = 0;
  let maximumDifference = 0;
  for (let offset = 0; offset < left.length; offset += 1) {
    const difference = Math.abs(left[offset] - right[offset]);
    absoluteDifference += difference;
    maximumDifference = Math.max(maximumDifference, difference);
  }
  return {
    mean: absoluteDifference / left.length,
    maximum: maximumDifference,
  };
}

function changedPixelsOutsideDoorways(left, right) {
  assert.equal(left.length, right.length);
  let changed = 0;
  for (let pixel = 0; pixel < guardedDoorPixels.length; pixel += 1) {
    if (guardedDoorPixels[pixel]) continue;
    const offset = pixel * 3;
    if (
      left[offset] !== right[offset] ||
      left[offset + 1] !== right[offset + 1] ||
      left[offset + 2] !== right[offset + 2]
    ) {
      changed += 1;
    }
  }
  return changed;
}

test("all base and stair maps own six complete opaque room-door frames", async () => {
  assert.equal(visuals.ROOM_DOOR_ATLAS_CELL_WIDTH, CELL_WIDTH);
  assert.equal(visuals.ROOM_DOOR_ATLAS_CELL_HEIGHT, CELL_HEIGHT);
  assert.equal(visuals.ROOM_DOOR_ATLAS_COLUMN_COUNT, ATLAS_COLUMNS);
  assert.equal(visuals.ROOM_DOOR_ATLAS_ROW_COUNT, ATLAS_ROWS);
  assert.equal(visuals.ROOM_DOOR_ATLAS_WIDTH, ATLAS_WIDTH);
  assert.equal(visuals.ROOM_DOOR_ATLAS_HEIGHT, ATLAS_HEIGHT);
  assert.deepEqual(
    Object.keys(visuals.ROOM_DOOR_VISUALS).sort(),
    Object.keys(BACKDROP_PATHS).sort(),
    "the manifest must cover nine base maps and all nine matching stair maps",
  );

  const buildReport = JSON.parse(
    await readFile(
      path.join(root, "public/assets/maps/room-doors-v4/build-report.json"),
      "utf8",
    ),
  );
  const promptMetadata = JSON.parse(
    await readFile(
      path.join(
        root,
        "asset-sources/imagegen/room-doors-v4/room-doors-v4.prompt.json",
      ),
      "utf8",
    ),
  );
  assert.equal(buildReport.version, 4);
  assert.deepEqual(buildReport.encoding, {
    format: "WEBP",
    lossless: true,
    reason: "keep every non-door room pixel stable across animation frames",
  });
  assert.equal(
    buildReport.productionContract.completeFrame,
    "every cell is a complete opaque room image",
  );
  assert.match(buildReport.productionContract.runtime, /no standalone gate sprite/);
  assert.deepEqual(
    Object.keys(buildReport.rooms).sort(),
    Object.values(BACKDROP_PATHS)
      .map((backdropPath) => path.basename(backdropPath, ".webp"))
      .sort(),
  );
  assert.deepEqual(
    [...promptMetadata.targets].sort(),
    Object.keys(buildReport.rooms).sort(),
    "the ImageGen provenance must cover every production base and stair map",
  );

  for (const [backdropKey, backdropPath] of Object.entries(BACKDROP_PATHS)) {
    const definition = visuals.ROOM_DOOR_VISUALS[backdropKey];
    assert.ok(definition, `${backdropKey} is missing its full-room door atlas`);
    const backdropStem = path.basename(backdropPath, ".webp");
    const roomReport = buildReport.rooms[backdropStem];
    assert.equal(
      definition.imagePath,
      `/assets/maps/room-doors-v4/${backdropStem}-doors-v4.webp`,
    );
    assert.deepEqual(definition.doorwayClips, EXPECTED_DOORWAY_CLIPS);

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

    const frames = await Promise.all(
      Array.from({ length: FRAME_COUNT }, async (_, frame) =>
        sharp(assetPath)
          .extract(frameRect(frame))
          .removeAlpha()
          .raw()
          .toBuffer(),
      ),
    );
    const openFrame = frames[FRAME_COUNT - 1];
    const differenceCounts = frames.map((frame) =>
      visuallyDifferentPixels(frame, openFrame),
    );
    const frameHashes = frames.map((frame) =>
      createHash("sha256").update(frame).digest("hex"),
    );
    assert.deepEqual(
      frameHashes,
      roomReport.frames.map((entry) => entry.pixelHash),
      `${backdropKey} atlas must decode byte-exactly to its authored full-room frames`,
    );

    assert.ok(
      differenceCounts[0] > 15_000,
      `${backdropKey} closed frame must visibly contain its authored gates`,
    );
    assert.equal(
      changedPixelsOutsideDoorways(frames[0], openFrame),
      0,
      `${backdropKey} closed frame must not alter untouched walls or floor`,
    );
    for (let frame = 1; frame < FRAME_COUNT; frame += 1) {
      assert.ok(
        differenceCounts[frame] < differenceCounts[frame - 1],
        `${backdropKey} frame ${frame} must reveal more of the complete open room`,
      );
      assert.notEqual(
        frameHashes[frame],
        frameHashes[frame - 1],
        `${backdropKey} frames ${frame - 1} and ${frame} must be distinct full maps`,
      );
      assert.equal(
        changedPixelsOutsideDoorways(frames[frame], openFrame),
        0,
        `${backdropKey} frame ${frame} must not shimmer on untouched walls or floor`,
      );
    }
    assert.equal(differenceCounts[FRAME_COUNT - 1], 0);

    const expectedOpenFrame = await sharp(mapPath)
      .resize(CELL_WIDTH, CELL_HEIGHT, { fit: "fill" })
      .removeAlpha()
      .raw()
      .toBuffer();
    const openDifference = imageDifference(openFrame, expectedOpenFrame);
    assert.ok(
      openDifference.mean < 4 && openDifference.maximum <= 80,
      `${backdropKey} open frame must faithfully reproduce its production map`,
    );

    assert.deepEqual(roomReport.output.size, [ATLAS_WIDTH, ATLAS_HEIGHT]);
    assert.equal(roomReport.output.mode, "RGB");
    assert.equal(roomReport.frames.length, FRAME_COUNT);
    assert.deepEqual(
      roomReport.frames.map((entry) => entry.changedPixelsFromOpen),
      [...roomReport.frames]
        .map((entry) => entry.changedPixelsFromOpen)
        .sort((left, right) => right - left),
      `${backdropKey} authored gate area must shrink monotonically while opening`,
    );
  }
});

test("full-room atlas and boundary-clip sampling use the native 1280x720 frame", () => {
  assert.deepEqual(visuals.roomDoorAtlasFrameSourceRect(0), {
    x: 0,
    y: 0,
    width: CELL_WIDTH,
    height: CELL_HEIGHT,
  });
  assert.deepEqual(visuals.roomDoorAtlasFrameSourceRect(1), {
    x: CELL_WIDTH,
    y: 0,
    width: CELL_WIDTH,
    height: CELL_HEIGHT,
  });
  assert.deepEqual(visuals.roomDoorAtlasFrameSourceRect(2), {
    x: 0,
    y: CELL_HEIGHT,
    width: CELL_WIDTH,
    height: CELL_HEIGHT,
  });
  assert.deepEqual(visuals.roomDoorAtlasFrameSourceRect(5), {
    x: CELL_WIDTH,
    y: CELL_HEIGHT * 2,
    width: CELL_WIDTH,
    height: CELL_HEIGHT,
  });
  assert.deepEqual(
    visuals.roomDoorAtlasFrameSourceRect(-99),
    visuals.roomDoorAtlasFrameSourceRect(0),
  );
  assert.deepEqual(
    visuals.roomDoorAtlasFrameSourceRect(999),
    visuals.roomDoorAtlasFrameSourceRect(5),
  );

  assert.deepEqual(
    visuals.roomDoorAtlasClipSourceRect(2, EXPECTED_DOORWAY_CLIPS.west),
    {
      x: 0,
      y: CELL_HEIGHT + EXPECTED_DOORWAY_CLIPS.west.y,
      width: EXPECTED_DOORWAY_CLIPS.west.width,
      height: EXPECTED_DOORWAY_CLIPS.west.height,
    },
  );
  assert.deepEqual(
    visuals.roomDoorClipCanvasRect(
      EXPECTED_DOORWAY_CLIPS.north,
      1600,
      900,
    ),
    { x: 718, y: 0, width: 164, height: 128 },
  );
  assert.equal(visuals.mirroredRoomDoorSide("west"), "east");
  assert.equal(visuals.mirroredRoomDoorSide("east"), "west");
  assert.equal(visuals.mirroredRoomDoorSide("north"), "north");
});

test("runtime renders one complete map frame and uses only same-map clips at sealed boundaries", async () => {
  const source = await readFile(path.join(root, "app/GameCanvas.tsx"), "utf8");
  assert.match(
    source,
    /const backdropKey\s*=\s*roomDoorBackdropKeyForWorld\(world\)/,
  );
  assert.match(source, /const roomDoorAtlasRevealDeadlineRef = useRef\(/);
  assert.match(
    source,
    /let roomDoorAtlasSettled = world\.transition <= 0;[\s\S]{0,1200}?roomDoorAtlasSettled\s*=\s*roomDoorAtlasReady\s*\|\|\s*roomDoorAtlasFailed\s*\|\|\s*doorLoadNow >= roomDoorAtlasRevealDeadline/,
    "a cold room load must remain hidden until its complete-room atlas settles",
  );
  assert.match(
    source,
    /if \(roomDoorAtlasSettled\) \{\s*world\.transition = Math\.max\(0, world\.transition - dt\)/,
  );
  assert.match(
    source,
    /roomDoorAtlasSettled &&\s*\(world\.doorMotion\.phase !== "closing"/,
    "door motion must not outrun a cold atlas decode",
  );
  assert.match(source, /ROOM_DOOR_VISUALS\[backdropKey\]/);
  assert.match(source, /roomDoorAtlasImageKey\(backdropKey\)/);
  assert.match(source, /roomDoorAtlasFrameSourceRect\(frame\)/);
  assert.match(source, /roomDoorAtlasClipSourceRect\(frame, doorwayClip\)/);
  assert.match(source, /roomDoorClipCanvasRect\(doorwayClip, WIDTH, HEIGHT\)/);
  assert.match(source, /drawRoomDoorAtlasFrame\(animatedDoorFrame\);/);
  assert.match(
    source,
    /for \(const physicalSide of ROOM_DOOR_SIDES\) \{\s*if \(existingDoorways\[physicalSide\]\) continue;\s*drawRoomDoorAtlasFrame\(0, authoredDoorwayClip\(physicalSide\)\);/,
  );
  assert.match(source, /if \(mirrorRoom\)[\s\S]{0,180}?context\.scale\(-1, 1\)/);
  assert.match(source, /mirroredRoomDoorSide\(physicalSide\)/);
  assert.doesNotMatch(
    source,
    /room-doors-v3|roomDoorAtlasSourceRect|roomDoorCanvasRect|drawRoomDoorPatch|room-portcullis/,
    "the prohibited standalone/small door-overlay runtime must stay removed",
  );

  const completeFrameBranch = source.indexOf("if (roomDoorAtlasReady) {");
  const fallbackBranch = source.indexOf("} else if (", completeFrameBranch);
  const playerInput = source.indexOf(
    "if (inputRef.current.hasMoveTarget)",
    completeFrameBranch,
  );
  assert.ok(
    completeFrameBranch >= 0 && fallbackBranch > completeFrameBranch,
    "the decoded atlas must replace the full backplate",
  );
  assert.ok(
    playerInput > completeFrameBranch,
    "the complete room frame must be painted before actors and player input",
  );
  assert.doesNotMatch(
    source.slice(completeFrameBranch, fallbackBranch),
    /fillRect\(/,
    "the complete-frame path must not flash synthetic door rectangles",
  );

  const playerStart = source.indexOf("const playerWalkFrame = characterRenderFrameIndex");
  const foregroundStart = source.indexOf(
    "The southern doorway belongs to the foreground wall",
  );
  assert.ok(
    playerStart >= 0 && foregroundStart > playerStart,
    "the same full-map south clip must preserve foreground depth after the player",
  );
  assert.match(
    source.slice(foregroundStart, foregroundStart + 500),
    /drawRoomDoorAtlasFrame\(\s*southDoorFrame,\s*southDoorwayClip,?\s*\)/,
  );
  assert.doesNotMatch(
    source.slice(
      source.indexOf("world.doorEffects = []"),
      source.indexOf("world.clearHandled"),
    ),
    /playerImpact|doorEffects\.push/,
    "entering a room must not add a vector impact over the authored room image",
  );
});

test("production assets omit retired standalone door overlays and superseded equipment atlases", async () => {
  const retiredPaths = [
    "public/assets/effects/room-doors-v2",
    "public/assets/equipment/equipment-types.png",
    "public/assets/equipment/equipment-types-v2.png",
    "public/assets/equipment/equipment-types-v3.png",
    "public/assets/equipment/equipment-icons.png",
    "public/assets/ui/rarity-frames-v2.png",
    "public/assets/walk/proofreader-walk.png",
    "public/assets/effects/equipped-rarity-aura-source-v1.png",
    "public/assets/effects/room-portcullis-source-v1.png",
  ];

  for (const retiredPath of retiredPaths) {
    await assert.rejects(
      access(path.join(root, retiredPath)),
      (error) => error?.code === "ENOENT",
      `${retiredPath} must not be copied into the production build`,
    );
  }

  await access(path.join(root, "public/assets/maps/room-doors-v4"));
  await access(
    path.join(root, "public/assets/equipment/equipment-types-v4.png"),
  );
  await access(
    path.join(
      root,
      "asset-sources/legacy-arpg/equipped-rarity-aura-source-v1.png",
    ),
  );
  await access(
    path.join(
      root,
      "asset-sources/legacy-arpg/room-portcullis-source-v1.png",
    ),
  );
});
