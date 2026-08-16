import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { inflateSync } from "node:zlib";
import ts from "typescript";

const root = process.cwd();
const rigManifest = JSON.parse(
  await readFile(path.join(root, "app/paperdoll-rig-manifest.json"), "utf8"),
);
const frameWidth = rigManifest.frame.width;
const frameHeight = rigManifest.frame.height;

const sha256 = (payload) => createHash("sha256").update(payload).digest("hex");
const sha256Lines = (records) => sha256(
  records.map(([name, digest]) => `${name}:${digest}\n`).join(""),
);

async function importTypeScriptModule(relativePath) {
  const source = await readFile(path.join(root, relativePath), "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(output).toString("base64")}`);
}

function decodePng(buffer) {
  let offset = 8;
  let width = 0;
  let height = 0;
  const idat = [];
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.subarray(offset + 4, offset + 8).toString("ascii");
    const start = offset + 8;
    if (type === "IHDR") {
      width = buffer.readUInt32BE(start);
      height = buffer.readUInt32BE(start + 4);
      assert.equal(buffer[start + 8], 8);
      assert.equal(buffer[start + 9], 6);
      assert.equal(buffer[start + 12], 0);
    } else if (type === "IDAT") idat.push(buffer.subarray(start, start + length));
    offset = start + length + 4;
    if (type === "IEND") break;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * 4;
  const pixels = new Uint8Array(width * height * 4);
  const paeth = (a, b, c) => {
    const p = a + b - c;
    const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const input = y * (stride + 1) + 1;
    const output = y * stride;
    for (let x = 0; x < stride; x += 1) {
      const left = x >= 4 ? pixels[output + x - 4] : 0;
      const above = y ? pixels[output + x - stride] : 0;
      const diagonal = y && x >= 4 ? pixels[output + x - stride - 4] : 0;
      const predictor = filter === 0 ? 0 : filter === 1 ? left : filter === 2 ? above : filter === 3 ? Math.floor((left + above) / 2) : paeth(left, above, diagonal);
      pixels[output + x] = (raw[input + x] + predictor) & 255;
    }
  }
  return { width, height, pixels };
}

function alphaMask(image, row, column) {
  const mask = new Uint8Array(frameWidth * frameHeight);
  for (let y = 0; y < frameHeight; y += 1) for (let x = 0; x < frameWidth; x += 1) {
    const source = (((row * frameHeight + y) * image.width + column * frameWidth + x) * 4) + 3;
    mask[y * frameWidth + x] = image.pixels[source] > 16 ? 1 : 0;
  }
  return mask;
}

function lowerIou(left, right) {
  let intersection = 0, union = 0;
  const lowerBodyStart = Math.round(frameHeight * (104 / 192));
  for (let y = lowerBodyStart; y < frameHeight; y += 1) for (let x = 0; x < frameWidth; x += 1) {
    const a = left[y * frameWidth + x], b = right[y * frameWidth + x];
    if (a || b) union += 1;
    if (a && b) intersection += 1;
  }
  return intersection / union;
}

test("halted characters always render the balanced standing frame", async () => {
  const motion = await importTypeScriptModule("app/character-motion.ts");
  assert.equal(motion.CHARACTER_IDLE_FRAME, 1);
  for (const cycle of [-11, 0, 0.75, 1.9, 3.99, 99, Number.NaN]) {
    assert.equal(motion.settleCharacterWalkCycle(cycle), 1);
    assert.equal(motion.characterWalkFrameIndex(cycle, false), 1);
  }
  assert.equal(motion.characterRenderFrameIndex(0, 3.2, false), 1);
  assert.equal(motion.characterRenderFrameIndex(4, 0.2, false), 1);
  for (const facing of [1, 2, 3, 5, 6, 7]) {
    assert.equal(
      motion.characterRenderFrameIndex(facing, 0.2, false),
      3,
      `facing ${facing} must retain its angled neutral stance`,
    );
  }
  assert.deepEqual([0, 1, 2, 3].map((cycle) => motion.characterWalkFrameIndex(cycle, true)), [0, 1, 2, 3]);
});

test("the active rig's north and south contact poses alternate", async () => {
  const image = decodePng(
    await readFile(path.join(root, "public", rigManifest.bodyPath.replace(/^\/+/, ""))),
  );
  assert.equal(rigManifest.version, "v1");
  assert.deepEqual(
    [image.width, image.height],
    [
      frameWidth * rigManifest.frame.columns,
      frameHeight * rigManifest.frame.directionRows.length,
    ],
  );
  for (const [direction, maximumContactIou] of [[0, 0.86], [4, 0.93]]) {
    const row = rigManifest.frame.directionRows[direction];
    assert.ok(lowerIou(alphaMask(image, row, 0), alphaMask(image, row, 2)) < maximumContactIou, `cardinal row ${row} does not alternate feet`);
  }
});

test("runtime paperdoll revision and provenance pins match exact production bytes", async () => {
  assert.equal(
    rigManifest.assetIntegrity.algorithm,
    "relative-path-sha256-lines-v1",
  );
  const atlasRecords = await Promise.all(
    rigManifest.slots.flatMap((slot) =>
      rigManifest.variantNames.map(async (name, variant) => {
        const filename = `${String(variant).padStart(2, "0")}-${name}.png`;
        const relative = `${slot}/${filename}`;
        const bytes = await readFile(
          path.join(root, "public/assets/paperdoll/v1", relative),
        );
        return [relative, sha256(bytes)];
      }),
    ),
  );
  atlasRecords.sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  assert.equal(atlasRecords.length, 100);
  assert.equal(rigManifest.assetIntegrity.atlasCount, atlasRecords.length);
  assert.equal(sha256Lines(atlasRecords), rigManifest.assetRevision);

  const bodyBytes = await readFile(
    path.join(root, "public", rigManifest.bodyPath.replace(/^\/+/, "")),
  );
  assert.equal(sha256(bodyBytes), rigManifest.assetIntegrity.bodySha256);
  const sourceProfiles = [
    "harin-equipped-iron-v1.png",
    "harin-equipped-frost-v2.png",
    "harin-equipped-jade-v1.png",
    "harin-equipped-blood-v1.png",
    "harin-equipped-arcane-v1.png",
    "harin-equipped-waraxe-v1.png",
    "harin-equipped-celestial-v1.png",
    "harin-equipped-void-v1.png",
    "harin-equipped-sealed-v1.png",
    "harin-equipped-cosmic-v1.png",
  ];
  const sourceRecords = [["body/harin-mannequin-v1.png", sha256(bodyBytes)]];
  for (const filename of sourceProfiles) {
    const bytes = await readFile(path.join(root, "public/assets/walk", filename));
    sourceRecords.push([`profile/${filename}`, sha256(bytes)]);
  }
  assert.equal(
    sha256Lines(sourceRecords),
    rigManifest.assetIntegrity.sourceAggregateSha256,
  );

  const [reference, allowlist, runtime, fixture] = await Promise.all([
    readFile(path.join(root, rigManifest.assetIntegrity.silhouetteReferencePath)),
    readFile(path.join(root, rigManifest.assetIntegrity.warningAllowlistPath)),
    readFile(path.join(root, "app/character-paperdoll.ts"), "utf8"),
    readFile(path.join(root, "tests/fixtures/paperdoll-visual-qa.html"), "utf8"),
  ]);
  assert.equal(
    sha256(reference),
    rigManifest.assetIntegrity.silhouetteReferenceSha256,
  );
  assert.equal(
    sha256(allowlist),
    rigManifest.assetIntegrity.warningAllowlistSha256,
  );
  assert.match(
    runtime,
    /\.png\?v=\$\{encodeURIComponent\(PAPERDOLL_ASSET_REVISION\)\}/,
  );
  assert.match(
    fixture,
    /\.png\?v=\$\{encodeURIComponent\(rig\.assetRevision\)\}/,
  );
});

test("expedition, plaza, and PVP share one corrected player scale", async () => {
  const [paperdoll, expedition, plaza, pvp] = await Promise.all([
    readFile(path.join(root, "app/character-paperdoll.ts"), "utf8"),
    readFile(path.join(root, "app/GameCanvas.tsx"), "utf8"),
    readFile(path.join(root, "app/PlazaHub.tsx"), "utf8"),
    readFile(path.join(root, "app/pvp/PvpArena.tsx"), "utf8"),
  ]);
  assert.match(paperdoll, /paperdoll-rig-manifest\.json/);
  assert.match(
    paperdoll,
    /PAPERDOLL_BODY_PATH\s*=\s*PAPERDOLL_RIG_MANIFEST\.bodyPath/,
  );
  assert.match(
    paperdoll,
    /PAPERDOLL_LAYER_ROOT\s*=\s*PAPERDOLL_RIG_MANIFEST\.layerRoot/,
  );
  assert.match(paperdoll, /context\.imageSmoothingEnabled\s*=\s*false/g);
  assert.match(
    paperdoll,
    /PAPERDOLL_WORLD_RENDER_WIDTH\s*=\s*PAPERDOLL_RIG_MANIFEST\.worldRender\.width/,
  );
  assert.match(
    paperdoll,
    /PAPERDOLL_WORLD_RENDER_HEIGHT\s*=\s*PAPERDOLL_RIG_MANIFEST\.worldRender\.height/,
  );
  assert.deepEqual(rigManifest.worldRender, { width: 136, height: 102 });
  for (const source of [expedition, plaza, pvp]) {
    assert.match(source, /PAPERDOLL_WORLD_RENDER_WIDTH/);
    assert.match(source, /PAPERDOLL_WORLD_RENDER_HEIGHT/);
  }
  assert.doesNotMatch(`${expedition}\n${plaza}`, /width:\s*171[\s\S]{0,30}height:\s*128/);
  assert.doesNotMatch(pvp, /width:\s*157[\s\S]{0,30}height:\s*118/);
});

test("static and local paperdoll QA consume the active runtime rig manifest", async () => {
  const [fixture, renderer, server] = await Promise.all([
    readFile(path.join(root, "tests/fixtures/paperdoll-visual-qa.html"), "utf8"),
    readFile(path.join(root, "scripts/render_layered_paperdoll_qa.py"), "utf8"),
    readFile(path.join(root, "scripts/serve-paperdoll-visual-qa.mjs"), "utf8"),
  ]);

  assert.equal(rigManifest.version, "v1");
  assert.equal(rigManifest.bodyPath, "/assets/walk/harin-mannequin-v1.png");
  assert.equal(rigManifest.layerRoot, "/assets/paperdoll/v1");

  const setupStart = fixture.indexOf("const slots = ");
  const setupEnd = fixture.indexOf("const images = ", setupStart);
  assert.ok(setupStart >= 0 && setupEnd > setupStart, "fixture QA matrix setup is missing");
  const evaluateFixtureMatrix = Function(
    "rig",
    `"use strict";\n${fixture.slice(setupStart, setupEnd)}\nreturn { slots, drawOrder, variants, facings, builds };`,
  );
  const fixtureMatrix = evaluateFixtureMatrix(rigManifest);
  assert.deepEqual(fixtureMatrix.slots, rigManifest.slots);
  assert.deepEqual(fixtureMatrix.variants, rigManifest.variantNames);
  assert.equal(fixtureMatrix.facings.length, rigManifest.frame.directionRows.length);
  assert.equal(fixtureMatrix.facings.length, 8);
  assert.equal(rigManifest.frame.columns, 4);

  const expectedIndividualItems =
    rigManifest.slots.length * rigManifest.variantNames.length;
  const individualBuilds = fixtureMatrix.builds.slice(1, expectedIndividualItems + 1);
  assert.equal(expectedIndividualItems, 100);
  assert.equal(individualBuilds.length, 100);
  assert.equal(new Set(individualBuilds.map(([label]) => label)).size, 100);
  for (const [itemIndex, [label, loadout]] of individualBuilds.entries()) {
    const expectedSlot = Math.floor(itemIndex / rigManifest.variantNames.length);
    const expectedVariant = itemIndex % rigManifest.variantNames.length;
    assert.equal(
      label,
      `${fixtureMatrix.slots[expectedSlot]}/${String(expectedVariant).padStart(2, "0")}-${rigManifest.variantNames[expectedVariant]}`,
    );
    assert.deepEqual(
      loadout.flatMap((variant, slot) => variant === null ? [] : [[slot, variant]]),
      [[expectedSlot, expectedVariant]],
      `${label} must equip only its named piece`,
    );
  }
  assert.equal(
    individualBuilds.length * fixtureMatrix.facings.length * rigManifest.frame.columns,
    3_200,
  );
  assert.deepEqual(
    fixtureMatrix.builds.slice(expectedIndividualItems + 1),
    rigManifest.qaCompositeBuilds.map((build) => [build.label, build.variants]),
    "browser full/mixed loadouts must use the canonical slot-to-variant matrix",
  );

  assert.match(fixture, /const rig = __PAPERDOLL_RIG_MANIFEST__;/);
  assert.match(fixture, /imageFor\(rig\.bodyPath\)/);
  assert.match(fixture, /`\$\{rig\.layerRoot\}\/\$\{slot\}/);
  assert.match(fixture, /for \(const \[label, authoredRow, direction\] of facings\)/);
  assert.match(fixture, /frame = \(frame \+ 1\) % rig\.frame\.columns/);
  assert.match(fixture, /document\.body\.dataset\.qaItems = "100"/);
  assert.match(fixture, /document\.body\.dataset\.qaCells = "3200"/);
  assert.doesNotMatch(fixture, /harin-mannequin-v[25]|paperdoll\/v[25]/);

  const rendererSlotsBlock = renderer.match(/^SLOTS = \(([^)]*)\)/m);
  assert.ok(rendererSlotsBlock, "static renderer slot declaration is missing");
  const rendererSlots = [...rendererSlotsBlock[1].matchAll(/"([^"]+)"/g)]
    .map((match) => match[1]);
  assert.deepEqual(rendererSlots, rigManifest.slots);
  assert.equal(rendererSlots.length * rigManifest.variantNames.length, 100);
  const rendererDrawOrderBlock = renderer.match(/^DRAW_ORDER = \(([^)]*)\)/m);
  assert.ok(rendererDrawOrderBlock, "static renderer draw order is missing");
  const rendererDrawOrder = [...rendererDrawOrderBlock[1].matchAll(/"([^"]+)"/g)]
    .map((match) => match[1]);
  assert.deepEqual(rendererDrawOrder, fixtureMatrix.drawOrder);
  assert.match(renderer, /RIG_MANIFEST\["qaCompositeBuilds"\]/);
  const individualRendererStart = renderer.indexOf("def render_all_individual_equipment(");
  const individualRendererEnd = renderer.indexOf("\ndef main()", individualRendererStart);
  assert.ok(
    individualRendererStart >= 0 && individualRendererEnd > individualRendererStart,
    "individual-equipment renderer is missing",
  );
  const individualRenderer = renderer.slice(individualRendererStart, individualRendererEnd);
  assert.match(individualRenderer, /item_count = len\(SLOTS\) \* len\(NAMES\)/);
  assert.match(individualRenderer, /for slot in SLOTS:\s+for variant, variant_name in enumerate\(NAMES\):/);
  assert.match(individualRenderer, /for phase in PHASES:\s+for runtime_direction, authored_row in enumerate\(\s*RUNTIME_TO_AUTHORED_DIRECTION\s*\):/);
  assert.match(individualRenderer, /expected_cells_per_item = len\(RUNTIME_TO_AUTHORED_DIRECTION\) \* len\(PHASES\)/);
  assert.match(individualRenderer, /"cells": expected_cells_per_item/);
  assert.match(individualRenderer, /"visible_cells": visible_cells/);
  assert.match(individualRenderer, /"passed": visible_cells == expected_cells_per_item/);
  assert.match(individualRenderer, /"passed": not failed_items/);
  assert.match(individualRenderer, /if failed_items:\s+raise RuntimeError/);
  assert.match(individualRenderer, /"rendered_cells": item_count\s*\* len\(RUNTIME_TO_AUTHORED_DIRECTION\)\s*\* len\(PHASES\)/);
  assert.match(renderer, /render_all_individual_equipment\(\s*mannequin,\s*layers,\s*layer_root,\s*individual_output,\s*version,\s*\)/);
  assert.match(renderer, /paperdoll-rig-manifest\.json/);
  assert.match(renderer, /version = args\.version or active_version/);
  assert.doesNotMatch(renderer, /default=["']v[25]["']/);
  assert.match(server, /paperdoll-rig-manifest\.json/);
  assert.match(server, /replaceAll\("__PAPERDOLL_RIG_MANIFEST__"/);
});
