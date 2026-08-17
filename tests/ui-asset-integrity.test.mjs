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
  "asset-sources/imagegen/inventory-portrait-mannequin-v1.prompt.json",
  "asset-sources/imagegen/auction-hall-backdrop-v1.prompt.json",
  "asset-sources/imagegen/auction-registry-crest-v1.prompt.json",
  "asset-sources/imagegen/market-gold-ingot-stack-v1.prompt.json",
  "asset-sources/imagegen/market-gold-ingot-token-v1.prompt.json",
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

  assert.match(runtimeSource, /inventory-portrait\/mannequin-base-v1\.png/);
  assert.match(runtimeSource, /equipment\/equipment-types-v4\.png/);
  assert.match(gameCss, /\.inventory-screen-paperdoll-base\s*\{[\s\S]{0,360}?background-size:\s*contain/);
  assert.match(gameCss, /\.inventory-screen-paperdoll-stage\s*\{[\s\S]{0,260}?aspect-ratio:\s*2\s*\/\s*3/);
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

test("market ImageGen art keeps fixed release geometry, clean alpha, and ratio-safe CSS", async () => {
  const records = [
    {
      prompt: "asset-sources/imagegen/auction-hall-backdrop-v1.prompt.json",
      source: "asset-sources/imagegen/auction-hall-backdrop-v1-source.png",
      sourceSha256: "91c10721548bd963b3fb02bac4d0dcc0e6987d6337b671881ed6d77338254d60",
      output: "public/assets/ui/market/auction-hall-backdrop-v1.webp",
      outputSha256: "04becdfb3e52fbe175efee949fdf9f9c5c5c89491bd77f825bd40dfe1b4ae6e7",
    },
    {
      prompt: "asset-sources/imagegen/auction-registry-crest-v1.prompt.json",
      source: "asset-sources/imagegen/auction-registry-crest-v1-source.png",
      sourceSha256: "ce6fe106e045051bc48bfdb6396693ca1f549a8286053a56e851dbfe78ba7d02",
      output: "public/assets/ui/market/auction-registry-crest-v1.png",
      outputSha256: "b73fd346a53ea096f73026c412ab8e92ae9d47c8cd37276db1ad286d19bc10e1",
    },
    {
      prompt: "asset-sources/imagegen/market-gold-ingot-stack-v1.prompt.json",
      source: "asset-sources/imagegen/market-gold-ingot-stack-v1-source.png",
      sourceSha256: "053d4d161963f448f306a2372681d1c82371f65582f8932581eb8c9411b1a43a",
      output: "public/assets/ui/market/gold-ingot-stack-v1.png",
      outputSha256: "b5aeee355e3fcf26e70fb9a490f2a9b8bd809e88e191397e3e5c04866a2389e7",
    },
    {
      prompt: "asset-sources/imagegen/market-gold-ingot-token-v1.prompt.json",
      source: "asset-sources/imagegen/market-gold-ingot-token-v1-source.png",
      sourceSha256: "be20174951ce4f9f777ba9a3f46148d389feeb5746009d27a2ad18be0959e384",
      output: "public/assets/ui/market/gold-ingot-token-v1.png",
      outputSha256: "6c5bf549ee56b3b2e9cd8ee44a74889ecf38994b62e00fe91a9c17c9f7b054e4",
    },
  ];

  for (const record of records) {
    const prompt = JSON.parse(await readFile(path.join(root, record.prompt), "utf8"));
    assert.equal(prompt.mode, "generate", `${record.prompt} must retain its original generation mode`);
    assert.match(prompt.tool, /image_gen/, `${record.prompt} must identify the built-in ImageGen path`);
    assert.equal(prompt.source, record.source, `${record.prompt} source provenance drifted`);
    assert.equal(prompt.output, record.output, `${record.prompt} output provenance drifted`);
    assert.ok(prompt.prompt.length >= 500, `${record.prompt} lost its production generation brief`);
    assert.equal(sha256(await readProjectFile(record.source)), record.sourceSha256, `${record.source} SHA-256 drifted`);
    assert.equal(sha256(await readProjectFile(record.output)), record.outputSha256, `${record.output} SHA-256 drifted`);
  }

  const backdropPrompt = JSON.parse(await readFile(path.join(root, records[0].prompt), "utf8"));
  assert.equal(backdropPrompt.generationResult.sourceSha256, records[0].sourceSha256);
  assert.equal(backdropPrompt.productionOutput.sha256, records[0].outputSha256);
  assert.deepEqual(backdropPrompt.productionOutput.size, [1920, 1080]);
  assert.equal(backdropPrompt.productionOutput.mode, "RGB");
  assert.match(backdropPrompt.productionOutput.pipeline, /Lanczos3[\s\S]*cover crop[\s\S]*no stretch/i);

  const backdrop = await sharp(path.join(root, records[0].output), { failOn: "error" }).metadata();
  assert.deepEqual([backdrop.width, backdrop.height], [1920, 1080]);
  assert.equal(backdrop.format, "webp");
  assert.equal(backdrop.channels, 3, "the fullscreen market backdrop must remain opaque RGB");
  assert.equal(backdrop.hasAlpha, false, "the fullscreen market backdrop must not ship an alpha plane");

  const crest = await sharp(path.join(root, records[1].output), { failOn: "error" })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  assert.deepEqual([crest.info.width, crest.info.height, crest.info.channels], [384, 384, 4]);
  let hiddenRgbPixels = 0;
  let edgeAlphaPixels = 0;
  let minimumX = crest.info.width;
  let minimumY = crest.info.height;
  let maximumX = -1;
  let maximumY = -1;
  for (let y = 0; y < crest.info.height; y += 1) {
    for (let x = 0; x < crest.info.width; x += 1) {
      const offset = (y * crest.info.width + x) * 4;
      const alpha = crest.data[offset + 3];
      if (alpha === 0 && (crest.data[offset] || crest.data[offset + 1] || crest.data[offset + 2])) {
        hiddenRgbPixels += 1;
      }
      if ((x === 0 || y === 0 || x === crest.info.width - 1 || y === crest.info.height - 1) && alpha > 0) {
        edgeAlphaPixels += 1;
      }
      if (alpha > 8) {
        minimumX = Math.min(minimumX, x);
        minimumY = Math.min(minimumY, y);
        maximumX = Math.max(maximumX, x);
        maximumY = Math.max(maximumY, y);
      }
    }
  }
  assert.equal(hiddenRgbPixels, 0, "the market crest must zero RGB beneath fully transparent texels");
  assert.equal(edgeAlphaPixels, 0, "the market crest must not touch any texture edge");
  assert.ok(maximumX >= minimumX && maximumY >= minimumY, "the market crest is effectively blank");
  assert.ok(
    Math.min(minimumX, minimumY, crest.info.width - 1 - maximumX, crest.info.height - 1 - maximumY) >= 4,
    "the market crest needs a transparent gutter on every side",
  );

  for (const [record, expectedSize] of [
    [records[2], 512],
    [records[3], 256],
  ]) {
    const goldAsset = await sharp(path.join(root, record.output), { failOn: "error" })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    assert.deepEqual(
      [goldAsset.info.width, goldAsset.info.height, goldAsset.info.channels],
      [expectedSize, expectedSize, 4],
      `${record.output} geometry or alpha layout drifted`,
    );
    let goldHiddenRgb = 0;
    let goldEdgeAlpha = 0;
    let goldVisiblePixels = 0;
    for (let y = 0; y < goldAsset.info.height; y += 1) {
      for (let x = 0; x < goldAsset.info.width; x += 1) {
        const offset = (y * goldAsset.info.width + x) * 4;
        const alpha = goldAsset.data[offset + 3];
        if (alpha > 0) goldVisiblePixels += 1;
        else if (goldAsset.data[offset] || goldAsset.data[offset + 1] || goldAsset.data[offset + 2]) goldHiddenRgb += 1;
        if ((x === 0 || y === 0 || x === goldAsset.info.width - 1 || y === goldAsset.info.height - 1) && alpha > 0) {
          goldEdgeAlpha += 1;
        }
      }
    }
    assert.equal(goldHiddenRgb, 0, `${record.output} must zero RGB beneath transparent texels`);
    assert.equal(goldEdgeAlpha, 0, `${record.output} must retain a transparent gutter`);
    assert.ok(goldVisiblePixels > expectedSize * expectedSize * 0.08, `${record.output} is effectively blank`);
  }

  const marketCss = await readFile(path.join(root, "app", "market", "market.css"), "utf8");
  const backdropRule = marketCss.match(/\.market-backdrop\s*\{([^}]*)\}/)?.[1] ?? "";
  assert.match(backdropRule, /auction-hall-backdrop-v1\.webp["']?\)\s+center\s*\/\s*cover\s+no-repeat/);
  assert.doesNotMatch(backdropRule, /background-size:\s*100%\s+100%|\/\s*100%\s+100%/);
  for (const selector of ["market-brand-seal", "market-auction-crest"]) {
    const rule = marketCss.match(new RegExp(`\\.${selector}\\s*\\{([^}]*)\\}`))?.[1] ?? "";
    assert.match(rule, /auction-registry-crest-v1\.png["']?\)\s+center\s*\/\s*contain\s+no-repeat/);
    assert.doesNotMatch(rule, /background-size:\s*100%\s+100%|\/\s*100%\s+100%/);
  }
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
    "fittedArmorSource",
    "fittedArmorOutput",
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
