import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import sharp from "sharp";

const root = fileURLToPath(new URL("..", import.meta.url));
const uiRoot = path.join(root, "public", "assets", "ui");

const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const rgbBackgrounds = new Set([
  "public/assets/ui/inventory-sanctum.png",
  "public/assets/ui/inventory-sanctum-v2.png",
]);

// These predate the alpha-safe production builders. Their fully transparent
// texels still carry RGB, which is visually inert with correct premultiplication
// but must not spread to any new UI asset. Lower counts (including zero) pass.
const legacyHiddenRgbCeilings = new Map([
  ["public/assets/ui/inventory-paperdoll-figure.png", 10_948],
  ["public/assets/ui/inventory-rarity-spectacle-common-v4.png", 800_532],
  ["public/assets/ui/inventory-rarity-spectacle-magic-v4.png", 800_532],
  ["public/assets/ui/inventory-rarity-spectacle-superior-v4.png", 800_532],
  ["public/assets/ui/inventory-rarity-spectacle-rare-v4.png", 800_532],
  ["public/assets/ui/inventory-rarity-spectacle-epic-v4.png", 800_532],
]);

const sourceOnlyUiPngs = new Set([
  "public/assets/ui/rarity-frames.png",
]);

const uiPromptFiles = [
  "asset-sources/imagegen/audio-dock-medallion-v1.prompt.json",
  "asset-sources/imagegen/gothic-scrollbar-v1.prompt.json",
  "asset-sources/imagegen/divine-forge-ui-v1.prompt.json",
  "asset-sources/imagegen/inventory-enhancement-button-v1.prompt.json",
  "asset-sources/imagegen/gothic-panel-assets-v2.prompt.json",
];

function posix(relativePath) {
  return relativePath.replaceAll("\\", "/");
}

function projectPath(absolutePath) {
  return posix(path.relative(root, absolutePath));
}

async function filesUnder(directory, predicate = () => true) {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...(await filesUnder(absolute, predicate)));
    else if (predicate(absolute)) found.push(absolute);
  }
  return found.sort();
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function readProjectFile(relativePath) {
  return readFile(path.join(root, relativePath));
}

async function assertFileReference(relativePath, record, label) {
  assert.equal(
    relativePath.startsWith("work/"),
    false,
    `${label} points into ignored work/ instead of a versioned source directory`,
  );
  const bytes = await readProjectFile(relativePath);
  assert.ok(bytes.length > 0, `${label} is empty: ${relativePath}`);
  if (record.sha256) assert.equal(sha256(bytes), record.sha256, `${label} SHA-256 drifted`);
  if (record.bytes !== undefined) assert.equal(bytes.length, record.bytes, `${label} byte count drifted`);
  if (record.size && relativePath.endsWith(".png")) {
    const metadata = await sharp(bytes, { failOn: "error" }).metadata();
    assert.deepEqual([metadata.width, metadata.height], record.size, `${label} geometry drifted`);
  }
  if (record.mode && relativePath.endsWith(".png")) {
    const metadata = await sharp(bytes, { failOn: "error" }).metadata();
    const expectedChannels = record.mode === "RGBA" ? 4 : record.mode === "RGB" ? 3 : undefined;
    if (expectedChannels) assert.equal(metadata.channels, expectedChannels, `${label} mode drifted`);
  }
}

function visit(value, callback, trail = "root") {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => visit(entry, callback, `${trail}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") return;
  callback(value, trail);
  for (const [key, entry] of Object.entries(value)) visit(entry, callback, `${trail}.${key}`);
}

test("every shipped UI bitmap decodes and retains safe production alpha geometry", async () => {
  const pngs = await filesUnder(uiRoot, (file) => file.endsWith(".png"));
  assert.ok(pngs.length >= 50, "the complete public UI asset family must be audited");

  for (const absolute of pngs) {
    const relative = projectPath(absolute);
    const bytes = await readFile(absolute);
    assert.ok(bytes.length >= 33, `${relative} is too short to be a PNG`);
    assert.ok(bytes.subarray(0, 8).equals(pngSignature), `${relative} has an invalid PNG signature`);
    assert.equal(bytes.subarray(12, 16).toString("ascii"), "IHDR", `${relative} has no leading IHDR`);

    const width = bytes.readUInt32BE(16);
    const height = bytes.readUInt32BE(20);
    const bitDepth = bytes[24];
    const colorType = bytes[25];
    const interlace = bytes[28];
    assert.ok(width > 0 && height > 0, `${relative} has zero geometry`);
    assert.ok(width <= 4096 && height <= 2048, `${relative} exceeds the UI texture budget`);
    assert.equal(bitDepth, 8, `${relative} must remain an 8-bit PNG`);
    assert.equal(interlace, 0, `${relative} must remain non-interlaced`);

    const metadata = await sharp(bytes, { failOn: "error" }).metadata();
    assert.equal(metadata.format, "png", `${relative} failed full PNG decode`);
    assert.deepEqual([metadata.width, metadata.height], [width, height], `${relative} IHDR disagrees with decode`);

    const expectsRgb = rgbBackgrounds.has(relative);
    assert.equal(colorType, expectsRgb ? 2 : 6, `${relative} has an unexpected PNG color type`);
    assert.equal(metadata.channels, expectsRgb ? 3 : 4, `${relative} has an unexpected channel layout`);
    if (expectsRgb) continue;

    const { data, info } = await sharp(bytes, { failOn: "error" }).ensureAlpha().raw().toBuffer({
      resolveWithObject: true,
    });
    let alphaMin = 255;
    let alphaMax = 0;
    let visiblePixels = 0;
    let hiddenRgbPixels = 0;
    let edgeAlphaPixels = 0;
    for (let y = 0; y < info.height; y += 1) {
      for (let x = 0; x < info.width; x += 1) {
        const offset = (y * info.width + x) * 4;
        const alpha = data[offset + 3];
        alphaMin = Math.min(alphaMin, alpha);
        alphaMax = Math.max(alphaMax, alpha);
        if (alpha > 0) visiblePixels += 1;
        else if (data[offset] || data[offset + 1] || data[offset + 2]) hiddenRgbPixels += 1;
        if ((x === 0 || y === 0 || x === info.width - 1 || y === info.height - 1) && alpha > 0) {
          edgeAlphaPixels += 1;
        }
      }
    }

    assert.equal(alphaMin, 0, `${relative} lost its transparent production gutter`);
    assert.equal(alphaMax, 255, `${relative} has no fully opaque authored pixels`);
    assert.ok(visiblePixels > width * height * 0.005, `${relative} is effectively blank`);
    assert.equal(edgeAlphaPixels, 0, `${relative} artwork touches a texture edge and can clip/bleed`);

    const ceiling = legacyHiddenRgbCeilings.get(relative) ?? 0;
    assert.ok(
      hiddenRgbPixels <= ceiling,
      `${relative} carries RGB in ${hiddenRgbPixels} fully transparent pixels (allowed ${ceiling})`,
    );
  }
});

test("UI atlases retain exact cells and CSS never falls back to the obsolete seven-column crop", async () => {
  const contracts = [
    [/inventory-rarity-(?:aura|spectacle)-.+\.png$/, [1536, 768]],
    [/inventory-(?:legendary|mythic|cosmic)-aura\.png$/, [1536, 768]],
    [/rarity-frames(?:-v6)?\.png$/, [2560, 320]],
    [/world-announcement-(?:mythic|cosmic)-v1\.png$/, [4096, 256]],
    [/inventory-(?:chrome|controls)-atlas\.png$/, [1600, 800]],
  ];
  const pngs = await filesUnder(uiRoot, (file) => file.endsWith(".png"));
  for (const absolute of pngs) {
    const contract = contracts.find(([pattern]) => pattern.test(posix(absolute)));
    if (!contract) continue;
    const metadata = await sharp(absolute).metadata();
    assert.deepEqual([metadata.width, metadata.height], contract[1], `${projectPath(absolute)} atlas grid drifted`);
  }

  const gameCss = await readFile(path.join(root, "app", "game.css"), "utf8");
  const globalCss = await readFile(path.join(root, "app", "globals.css"), "utf8");
  assert.doesNotMatch(gameCss, /700%\s+100%/, "the eight-column rarity sheet must never use its old 7-column crop");
  assert.match(gameCss, /rarity-frames-v6\.png[\s\S]{0,180}?background-size:\s*800%\s+100%/);
  assert.match(gameCss, /\.inventory-screen-rarity-aura\s*\{[\s\S]{0,760}?background-size:\s*400%\s+200%/);
  assert.match(gameCss, /\.inventory-screen-rarity-spectacle\s*\{[\s\S]{0,760}?background-size:\s*400%\s+200%/);
  assert.match(globalCss, /\.world-announcement-art\s*\{[\s\S]{0,420}?background-size:\s*400%\s+200%/);
});

test("runtime UI references resolve and standalone art uses ratio-safe rendering contracts", async () => {
  const runtimeFiles = await filesUnder(path.join(root, "app"), (file) => /\.(?:css|ts|tsx)$/.test(file));
  const runtimeSource = (await Promise.all(runtimeFiles.map((file) => readFile(file, "utf8")))).join("\n");
  const references = new Set(
    [...runtimeSource.matchAll(/["'(](\/assets\/ui\/[^"')]+\.png)/g)].map((match) => match[1]),
  );
  for (const url of references) {
    const bytes = await readProjectFile(`public${url}`);
    assert.ok(bytes.length > 0, `runtime UI reference is missing or empty: ${url}`);
  }

  const pngs = await filesUnder(uiRoot, (file) => file.endsWith(".png"));
  for (const absolute of pngs) {
    const relative = projectPath(absolute);
    if (sourceOnlyUiPngs.has(relative)) continue;
    const url = `/${posix(path.relative(path.join(root, "public"), absolute))}`;
    assert.ok(references.has(url), `${relative} is an unregistered, unused production UI bitmap`);
  }

  const gameCss = await readFile(path.join(root, "app", "game.css"), "utf8");
  const audioCss = await readFile(path.join(root, "app", "audio-controls.css"), "utf8");
  const scrollbarCss = await readFile(path.join(root, "app", "ui-scrollbars.css"), "utf8");
  const marker = gameCss.lastIndexOf("Final geometry contract");
  assert.ok(marker > 0, "the tight-asset cascade marker is missing");
  for (const atlas of ["inventory-chrome-atlas.png", "inventory-controls-atlas.png"]) {
    assert.ok(gameCss.lastIndexOf(atlas) < marker, `${atlas} must not win after the tight-asset cascade`);
  }

  assert.match(gameCss, /inventory-paperdoll-figure\.png["']?\)\s+center\s*\/\s*contain\s+no-repeat/);
  assert.match(gameCss, /inventory-sanctum-v2\.png["']?\)\s+center\s*\/\s*cover\s+no-repeat/);
  assert.match(gameCss, /divine-forge-(?:crest|title|socket|button)-v1\.png["']?\)\s+center\s*\/\s*contain\s+no-repeat/);
  assert.match(gameCss, /enhancement-button-v1\.png["']?\)\s+27%\s+4%\s+27%\s+4%\s+fill/);
  assert.match(audioCss, /audio-dock-medallion-v1\.png["']?\)\s+center\s*\/\s*contain\s+no-repeat/);
  assert.match(scrollbarCss, /border-image-source:\s*url\("\/assets\/ui\/scrollbars\/gothic-track-v1\.png"\)/);
  assert.match(scrollbarCss, /border-image-source:\s*url\("\/assets\/ui\/scrollbars\/gothic-thumb-gold-v1\.png"\)/);
  assert.match(scrollbarCss, /border-image-source:\s*url\("\/assets\/ui\/scrollbars\/gothic-thumb-aether-v1\.png"\)/);
});

test("gothic panel V2 keeps fixed modal geometry and a fill-free modular frame", async () => {
  const [gameCss, runtimeFiles, modalMetadata, frameImage] = await Promise.all([
    readFile(path.join(root, "app", "game.css"), "utf8"),
    filesUnder(path.join(root, "app"), (file) => /\.(?:css|ts|tsx)$/.test(file)),
    sharp(path.join(uiRoot, "gothic-modal-panel-v2.png")).metadata(),
    sharp(path.join(uiRoot, "gothic-nine-slice-frame-v2.png"))
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true }),
  ]);
  const runtimeSource = (await Promise.all(runtimeFiles.map((file) => readFile(file, "utf8")))).join("\n");

  assert.deepEqual([modalMetadata.width, modalMetadata.height], [1536, 1024]);
  assert.equal(modalMetadata.channels, 4);
  assert.deepEqual([frameImage.info.width, frameImage.info.height], [1254, 1254]);
  const centerOffset =
    (Math.floor(frameImage.info.height / 2) * frameImage.info.width +
      Math.floor(frameImage.info.width / 2)) *
    4;
  assert.equal(frameImage.data[centerOffset + 3], 0, "the modular frame center must stay transparent");
  let opaqueCenterPixels = 0;
  const centerStart = Math.floor(frameImage.info.width * 0.32);
  const centerEnd = Math.ceil(frameImage.info.width * 0.68);
  for (let y = centerStart; y < centerEnd; y += 1) {
    for (let x = centerStart; x < centerEnd; x += 1) {
      if (frameImage.data[(y * frameImage.info.width + x) * 4 + 3] !== 0) {
        opaqueCenterPixels += 1;
      }
    }
  }
  assert.equal(opaqueCenterPixels, 0, "the full nine-slice center field must stay transparent");

  assert.match(
    gameCss,
    /\.death-modal\s*\{[\s\S]{0,700}?aspect-ratio:\s*3\s*\/\s*2;[\s\S]{0,300}?border-image:\s*none;[\s\S]{0,400}?gothic-modal-panel-v2\.png["']?\)\s+center\s*\/\s*contain\s+no-repeat;/,
  );
  assert.match(gameCss, /\.death-retry-button\s*\{[^}]*background:\s*transparent;/);
  assert.match(runtimeSource, /gothic-nine-slice-frame-v2\.png["']?\)\s+16%\s*\/[^;]+\sround;/);
  const dynamicContractStart = gameCss.indexOf("/* Distortion-proof dynamic panel chrome.");
  const dynamicContractEnd = gameCss.indexOf(".choice-state,", dynamicContractStart);
  assert.ok(
    dynamicContractStart >= 0 && dynamicContractEnd > dynamicContractStart,
    "dynamic story and build panels need one final stretch-proof frame contract",
  );
  const dynamicContract = gameCss.slice(dynamicContractStart, dynamicContractEnd);
  assert.match(dynamicContract, /\.build-content,\s*\.story-modal,\s*\.ending-modal\s*\{/);
  assert.match(dynamicContract, /border-image-source:\s*url\("\/assets\/ui\/gothic-nine-slice-frame-v2\.png"\);/);
  assert.match(dynamicContract, /border-image-slice:\s*16%;/);
  assert.match(dynamicContract, /border-image-repeat:\s*round;/);
  assert.doesNotMatch(dynamicContract, /\bfill\b|gothic-modal-panel-v2|background-size:\s*100%\s+100%/);
  assert.equal(
    [...runtimeSource.matchAll(/gothic-modal-panel-v2\.png/g)].length,
    1,
    "the authored 3:2 filled plate must remain exclusive to the death modal",
  );
  assert.doesNotMatch(
    runtimeSource,
    /inventory-chrome\/tooltip-panel\.png/,
    "the retired low-resolution filled panel must not return to runtime",
  );
});

test("UI build reports and ImageGen prompts resolve only versioned, hash-locked provenance", async () => {
  const reports = [
    ...(await filesUnder(uiRoot, (file) => file.endsWith(".build.json"))),
    path.join(root, "asset-sources", "imagegen", "investor-ui-assets-v1.build.json"),
  ];

  for (const absolute of reports) {
    const relativeReport = projectPath(absolute);
    const report = JSON.parse(await readFile(absolute, "utf8"));
    assert.equal(typeof report.builder, "string", `${relativeReport} must name its deterministic builder`);
    await assertFileReference(report.builder, {}, `${relativeReport}.builder`);

    const checks = [];
    visit(report, (record, trail) => {
      if (typeof record.path === "string") {
        checks.push(assertFileReference(record.path, record, `${relativeReport}:${trail}.path`));
      }
      for (const field of ["source", "output"]) {
        const relative = record[field];
        const digest = record[`${field}Sha256`];
        if (typeof relative === "string" && typeof digest === "string") {
          const details = { sha256: digest };
          if (field === "output" && record.bytes !== undefined) details.bytes = record.bytes;
          checks.push(assertFileReference(relative, details, `${relativeReport}:${trail}.${field}`));
        }
      }
    });
    await Promise.all(checks);
  }

  const pathKeys = new Set([
    "path",
    "source",
    "keyed",
    "output",
    "generatedSource",
    "keyedSource",
    "selectedSource",
    "productionBuilder",
    "builder",
  ]);
  const pathArrayKeys = new Set(["outputs", "productionOutputs", "referenceImages"]);
  for (const relativePrompt of uiPromptFiles) {
    const prompt = JSON.parse(await readFile(path.join(root, relativePrompt), "utf8"));
    const refs = [];
    function collect(value, key = "root") {
      if (Array.isArray(value)) {
        if (pathArrayKeys.has(key)) refs.push(...value.filter((entry) => typeof entry === "string"));
        value.forEach((entry) => collect(entry));
        return;
      }
      if (!value || typeof value !== "object") return;
      for (const [childKey, entry] of Object.entries(value)) {
        if (pathKeys.has(childKey) && typeof entry === "string") refs.push(entry);
        collect(entry, childKey);
      }
    }
    collect(prompt);
    assert.ok(refs.length > 0, `${relativePrompt} has no source/output provenance`);
    for (const reference of new Set(refs)) {
      await assertFileReference(reference, {}, `${relativePrompt}:${reference}`);
    }
  }
});
