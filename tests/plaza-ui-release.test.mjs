import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import sharp from "sharp";
import ts from "typescript";

const root = fileURLToPath(new URL("..", import.meta.url));
const readSource = (relativePath) =>
  readFile(path.join(root, relativePath), "utf8");

const PORTAL_IDS = ["expedition", "duel", "exchange", "caravan"];
const PORTAL_ASSET_URLS = Object.fromEntries(
  PORTAL_IDS.map((id) => [id, `/assets/plaza/portal-${id}-v2.png`]),
);
const PORTAL_WORLD_ASSET_URLS = {
  expedition: "/assets/plaza/portal-expedition-v2.png",
  duel: "/assets/plaza/portal-duel-world-v2.png",
  exchange: "/assets/plaza/portal-exchange-world-v2.png",
  caravan: "/assets/plaza/portal-caravan-v2.png",
};
const SANCTUM_FRAME_URL = "/assets/ui/plaza-hub/sanctum-frame-v2.png";
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function visit(node, callback) {
  callback(node);
  ts.forEachChild(node, (child) => visit(child, callback));
}

function tsxSource(source, fileName = "app/PlazaHub.tsx") {
  return ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.ESNext,
    true,
    ts.ScriptKind.TSX,
  );
}

function variableOwningEveryUrl(sourceFile, urls) {
  const matches = [];
  visit(sourceFile, (node) => {
    if (
      !ts.isVariableDeclaration(node) ||
      !ts.isIdentifier(node.name) ||
      !node.initializer
    ) {
      return;
    }
    const literals = new Set();
    visit(node.initializer, (child) => {
      if (ts.isStringLiteralLike(child)) literals.add(child.text);
    });
    if (urls.every((url) => literals.has(url))) {
      matches.push({
        name: node.name.text,
        declaration: node,
        text: node.initializer.getText(sourceFile),
      });
    }
  });
  matches.sort((left, right) => left.text.length - right.text.length);
  return matches[0] ?? null;
}

function namedFunction(sourceFile, name) {
  let match = null;
  visit(sourceFile, (node) => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) match = node;
  });
  return match;
}

function sectionFrom(source, marker, closingTag) {
  const start = source.indexOf(marker);
  assert.ok(start >= 0, `missing ${marker}`);
  const end = source.indexOf(closingTag, start);
  assert.ok(end > start, `missing ${closingTag} after ${marker}`);
  return source.slice(start, end + closingTag.length);
}

function blockAfter(source, marker) {
  const markerIndex = source.indexOf(marker);
  assert.ok(markerIndex >= 0, `missing CSS block ${marker}`);
  const open = source.indexOf("{", markerIndex);
  assert.ok(open >= 0, `missing opening brace for ${marker}`);
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    else if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, index);
    }
  }
  assert.fail(`missing closing brace for ${marker}`);
}

async function importPlazaWorld() {
  const source = await readSource("app/plaza-world.ts");
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: "app/plaza-world.ts",
  }).outputText;
  return import(
    `data:text/javascript;base64,${Buffer.from(output).toString("base64")}`
  );
}

async function readRequiredAsset(relativePath) {
  try {
    return await readFile(path.join(root, relativePath));
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      assert.fail(`missing release plaza asset: ${relativePath}`);
    }
    throw error;
  }
}

async function inspectTransparentRgbaPng(contract) {
  const bytes = await readRequiredAsset(contract.relativePath);
  assert.ok(bytes.length >= 33, `${contract.relativePath} is too short to be a PNG`);
  assert.ok(
    bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE),
    `${contract.relativePath} must have a PNG signature`,
  );
  assert.ok(
    bytes.length <= contract.maxBytes,
    `${contract.relativePath} exceeds its ${contract.maxBytes}-byte texture budget`,
  );
  assert.equal(bytes.subarray(12, 16).toString("ascii"), "IHDR");
  assert.equal(bytes[24], 8, `${contract.relativePath} must use 8-bit channels`);
  assert.equal(bytes[25], 6, `${contract.relativePath} must be encoded as RGBA`);
  assert.equal(bytes[28], 0, `${contract.relativePath} must not be interlaced`);

  const metadata = await sharp(bytes, { failOn: "error" }).metadata();
  assert.equal(metadata.format, "png", `${contract.relativePath} failed PNG decode`);
  assert.equal(metadata.channels, 4, `${contract.relativePath} must have four channels`);
  assert.equal(metadata.hasAlpha, true, `${contract.relativePath} must retain alpha`);
  assert.ok(
    metadata.width >= contract.minWidth && metadata.width <= contract.maxWidth,
    `${contract.relativePath} width ${metadata.width} is outside ${contract.minWidth}..${contract.maxWidth}`,
  );
  assert.ok(
    metadata.height >= contract.minHeight && metadata.height <= contract.maxHeight,
    `${contract.relativePath} height ${metadata.height} is outside ${contract.minHeight}..${contract.maxHeight}`,
  );

  const { data, info } = await sharp(bytes, { failOn: "error" })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  let visiblePixels = 0;
  let strongestAlpha = 0;
  let visibleEdgePixels = 0;
  for (let y = 0; y < info.height; y += 1) {
    for (let x = 0; x < info.width; x += 1) {
      const alpha = data[(y * info.width + x) * 4 + 3];
      if (alpha > 0) visiblePixels += 1;
      strongestAlpha = Math.max(strongestAlpha, alpha);
      if (
        alpha > 0 &&
        (x === 0 || y === 0 || x === info.width - 1 || y === info.height - 1)
      ) {
        visibleEdgePixels += 1;
      }
    }
  }
  assert.ok(
    visiblePixels >= info.width * info.height * 0.003,
    `${contract.relativePath} is effectively blank`,
  );
  assert.ok(strongestAlpha >= 192, `${contract.relativePath} has no solid readable artwork`);
  assert.equal(
    visibleEdgePixels,
    0,
    `${contract.relativePath} artwork touches the texture edge and can clip or bleed`,
  );
  return {
    hash: createHash("sha256").update(bytes).digest("hex"),
    width: info.width,
    height: info.height,
  };
}

test("PlazaHub preloads distinct UI and world-space portal art with a cold-load fallback", async () => {
  const source = await readSource("app/PlazaHub.tsx");
  const sourceFile = tsxSource(source);
  const expectedUrls = Object.values(PORTAL_ASSET_URLS);
  const assetCollection = variableOwningEveryUrl(sourceFile, expectedUrls);
  assert.ok(
    assetCollection,
    "PlazaHub must declare one runtime portal asset collection containing all four v2 URLs",
  );

  for (const [id, url] of Object.entries(PORTAL_ASSET_URLS)) {
    assert.match(assetCollection.text, new RegExp(`${id}[\\s\\S]*?${url.replaceAll("/", "\\/")}`));
  }
  const worldAssetCollection = variableOwningEveryUrl(
    sourceFile,
    Object.values(PORTAL_WORLD_ASSET_URLS),
  );
  assert.ok(worldAssetCollection, "PlazaHub must declare direction-aware world portal art");

  const preloadScopes = [];
  visit(sourceFile, (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "useEffect"
    ) {
      preloadScopes.push(node.getText(sourceFile));
    }
  });
  assert.ok(
    preloadScopes.some(
      (scope) =>
        scope.includes(assetCollection.name) &&
        scope.includes(worldAssetCollection.name) &&
        /new\s+Image\s*\(/.test(scope) &&
        /\.src\s*=/.test(scope),
    ),
    `${assetCollection.name} must be traversed by an Image-based preload effect`,
  );
  const portalPreloadScope = preloadScopes.find(
    (scope) => scope.includes(assetCollection.name) && scope.includes(worldAssetCollection.name),
  );
  assert.match(
    portalPreloadScope,
    /images\.get\(path\)\s*===\s*image[\s\S]*?images\.delete\(path\)/,
    "an old StrictMode image error must not delete a newer scene image",
  );
  assert.match(
    portalPreloadScope,
    /removeEventListener\(\s*["']error["']\s*,\s*handleImageError\s*\)/,
    "scene image cleanup must detach the owned error handler before clearing src",
  );

  const drawPortal = namedFunction(sourceFile, "drawPortal");
  assert.ok(drawPortal?.body, "the portal renderer must remain an explicit drawPortal function");
  const imageParameters = new Set(
    drawPortal.parameters
      .filter((parameter) => /HTMLImageElement/.test(parameter.type?.getText(sourceFile) ?? ""))
      .map((parameter) => parameter.name.getText(sourceFile)),
  );
  assert.ok(imageParameters.size > 0, "drawPortal must receive a preloaded HTMLImageElement");

  let authoredDraw = null;
  visit(drawPortal.body, (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "drawImage" &&
      node.arguments[0] &&
      [...imageParameters].some((name) => node.arguments[0].getText(sourceFile).includes(name))
    ) {
      authoredDraw = node;
    }
  });
  assert.ok(authoredDraw, "drawPortal must pass its authored portal image to canvas drawImage");
  assert.match(
    drawPortal.body.getText(sourceFile),
    /drawPortalFallback\s*\(/,
    "cold or failed portal textures must retain a visible authored fallback",
  );

  const portalLoops = [];
  visit(sourceFile, (node) => {
    if (
      ts.isForOfStatement(node) &&
      node.expression.getText(sourceFile).includes("PLAZA_PORTALS")
    ) {
      portalLoops.push(node.getText(sourceFile));
    }
  });
  assert.ok(
    portalLoops.some(
      (loop) =>
        loop.includes(worldAssetCollection.name) &&
        /portal\.id/.test(loop) &&
        /sceneImagesRef\.current\.get\s*\(/.test(loop) &&
        /drawPortal\s*\(/.test(loop),
    ),
    "the PLAZA_PORTALS render loop must resolve each direction-aware image and pass it to drawPortal",
  );
});

test("portal navigation and the nearby prompt expose destination-aware semantics", async () => {
  const [source, plazaWorld] = await Promise.all([
    readSource("app/PlazaHub.tsx"),
    importPlazaWorld(),
  ]);
  const directory = sectionFrom(
    source,
    '<nav className="plaza-portal-directory"',
    "</nav>",
  );
  assert.match(
    directory,
    /aria-keyshortcuts\s*=\s*\{\s*portal\.hotkey\s*\}/,
    "each directory button must publish its numeric shortcut",
  );
  assert.doesNotMatch(
    directory,
    /aria-pressed\s*=\s*\{[^}]+\}/,
    "one-shot guide commands must not announce themselves as toggle buttons",
  );
  assert.match(
    directory,
    /aria-describedby\s*=\s*\{`plaza-gate-status-\$\{portal\.id\}`\}/,
    "each guide command must associate its live destination status",
  );
  assert.match(
    directory,
    /data-portal-id\s*=\s*\{\s*portal\.id\s*\}/,
    "each directory button needs a stable portal id for styling and QA",
  );

  assert.deepEqual(
    plazaWorld.PLAZA_PORTALS.map((portal) => portal.id),
    PORTAL_IDS,
  );
  const prompt = sectionFrom(
    source,
    'className="plaza-portal-prompt"',
    "</section>",
  );
  const usesPortalField = /\{\s*nearPortal\.actionLabel\s*\}/.test(prompt);
  const helperCall = prompt.match(
    /\{\s*([A-Za-z_$][\w$]*)\s*\(\s*nearPortal\.id\s*\)\s*\}/,
  );
  assert.ok(
    usesPortalField || helperCall,
    "the nearby prompt button must resolve its action copy from the selected destination",
  );

  let actionLabels;
  if (usesPortalField) {
    actionLabels = plazaWorld.PLAZA_PORTALS.map((portal) => portal.actionLabel);
    for (const [index, label] of actionLabels.entries()) {
      assert.equal(typeof label, "string", `${PORTAL_IDS[index]} must declare actionLabel`);
    }
  } else {
    const sourceFile = tsxSource(source);
    const helper = namedFunction(sourceFile, helperCall[1]);
    assert.ok(helper?.body, `missing destination action helper ${helperCall[1]}`);
    assert.match(
      helper.parameters[0]?.type?.getText(sourceFile) ?? "",
      /PlazaPortalId/,
      `${helperCall[1]} must accept the closed PlazaPortalId union`,
    );
    const helperText = helper.body.getText(sourceFile);
    for (const id of PORTAL_IDS.slice(0, -1)) {
      assert.match(helperText, new RegExp(`["']${id}["']`), `${helperCall[1]} does not branch for ${id}`);
    }
    actionLabels = [];
    visit(helper.body, (node) => {
      if (ts.isReturnStatement(node) && node.expression && ts.isStringLiteralLike(node.expression)) {
        actionLabels.push(node.expression.text);
      }
    });
  }

  for (const [index, label] of actionLabels.entries()) {
    assert.ok(label.trim().length >= 2, `destination action ${index + 1} is too short`);
    assert.notEqual(label.trim(), "포탈 이용", "the nearby prompt still uses the generic action");
  }
  assert.equal(
    new Set(actionLabels.map((label) => label.trim())).size,
    PORTAL_IDS.length,
    "every destination must have its own action label",
  );
});

test("release plaza interactions replay notices and expose player inspection without a mouse", async () => {
  const source = await readSource("app/PlazaHub.tsx");
  assert.match(
    source,
    /setNoticeEvent\s*\(\s*\(current\)\s*=>\s*\(\{\s*id:\s*current\.id\s*\+\s*1/,
    "repeated identical notices need a monotonically increasing event id",
  );
  assert.match(
    source,
    /key=\{noticeEvent\.id\}[\s\S]*?noticeEvent\.message/,
    "each notice event must restart its visual lifecycle while the live region persists",
  );
  assert.match(source, /aria-keyshortcuts="F"/, "keyboard inspection must publish its shortcut");
  assert.match(source, /className="is-inspect"/, "touch controls need a dedicated record action");
  assert.match(
    source,
    /event\.pointerType\s*!==\s*"mouse"[\s\S]*?pickPlazaInspectablePlayer/,
    "touching a rendered player must inspect instead of issuing movement",
  );

  const sourceFile = tsxSource(source);
  const drawPortal = namedFunction(sourceFile, "drawPortal");
  const portalFontSizes = [
    ...drawPortal.body.getText(sourceFile).matchAll(/context\.font\s*=\s*["'][^"']*?(\d+(?:\.\d+)?)px/g),
  ].map((match) => Number(match[1]));
  assert.ok(portalFontSizes.length > 0, "portal renderer must declare its canvas typography");
  assert.ok(
    portalFontSizes.every((size) => size >= 12),
    `portal canvas text cannot be smaller than 12px: ${portalFontSizes.join(", ")}`,
  );

  const layout = namedFunction(sourceFile, "plazaPortalArtLayout");
  assert.ok(layout?.body, "portal artwork must have an explicit safe layout function");
  assert.match(
    layout.body.getText(sourceFile),
    /portal\.approachX[\s\S]*portal\.approachY/,
    "world portal structures must be centered on their reachable in-frame approach points",
  );
});

test("release plaza CSS uses authored sanctum chrome and readable accessible states", async () => {
  const css = await readSource("app/plaza.css");
  const escapedFrameUrl = SANCTUM_FRAME_URL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  assert.match(
    css,
    new RegExp(
      `(?:background(?:-image)?|border-image(?:-source)?|mask(?:-image)?)\\s*:[^;{}]*url\\(\\s*["']?${escapedFrameUrl}["']?\\s*\\)`,
      "i",
    ),
    "the plaza HUD must use the authored sanctum frame as real CSS chrome",
  );
  assert.match(
    css,
    /border-image-source:\s*url\("\/assets\/ui\/plaza-hub\/sanctum-frame-v2\.png"\)[\s\S]{0,220}?border-image-repeat:\s*round/,
    "the sanctum rails must tile cleanly instead of stretching engraved pixels",
  );

  const fontDeclarations = [
    ...css.matchAll(/(?:^|[;{])\s*(font-size|font)\s*:\s*([^;}]+)/gim),
  ];
  assert.ok(fontDeclarations.length > 0, "plaza.css must declare its typography");
  for (const declaration of fontDeclarations) {
    const pixelSizes = [...declaration[2].matchAll(/(\d+(?:\.\d+)?)px\b/g)].map(
      (match) => Number(match[1]),
    );
    for (const size of pixelSizes) {
      assert.ok(
        size >= 12,
        `release plaza text cannot be smaller than 12px: ${declaration[0].trim()}`,
      );
    }
  }

  const focusBlocks = [
    ...css.matchAll(/([^{}]*(?::focus-visible)[^{}]*)\{([^{}]*)\}/gim),
  ].filter((match) =>
    /\.plaza-portal-directory|\.plaza-hub[^,{]*button/.test(match[1]),
  );
  assert.ok(focusBlocks.length > 0, "portal controls need an explicit :focus-visible rule");
  assert.ok(
    focusBlocks.some((match) => {
      const declarations = match[2];
      return (
        /outline\s*:\s*(?!none\b|0(?:\D|$))[^;]+/i.test(declarations) ||
        /box-shadow\s*:\s*(?!none\b)[^;]+/i.test(declarations)
      );
    }),
    "keyboard focus must draw a visible outline or focus ring on portal controls",
  );

  const reducedMotion = blockAfter(css, "@media (prefers-reduced-motion: reduce)");
  assert.match(
    reducedMotion,
    /animation(?:-duration)?\s*:\s*(?:none|0(?:ms|s)?|\.0*1ms)/i,
    "reduced-motion must suppress plaza animation",
  );
  assert.match(
    reducedMotion,
    /transition(?:-duration)?\s*:\s*(?:none|0(?:ms|s)?|\.0*1ms)/i,
    "reduced-motion must suppress plaza transitions",
  );
});

test("release plaza bitmaps are substantial, distinct, padded RGBA PNGs", async () => {
  const portalResults = await Promise.all(
    PORTAL_IDS.map((id) =>
      inspectTransparentRgbaPng({
        relativePath: `public${PORTAL_ASSET_URLS[id]}`,
        minWidth: 320,
        minHeight: 320,
        maxWidth: 2_048,
        maxHeight: 2_048,
        maxBytes: 8 * 1_024 * 1_024,
      }),
    ),
  );
  assert.equal(
    new Set(portalResults.map((result) => result.hash)).size,
    PORTAL_IDS.length,
    "the four destination portal files must contain distinct authored artwork",
  );

  const directionalWorldResults = await Promise.all(
    ["duel", "exchange"].map((id) =>
      inspectTransparentRgbaPng({
        relativePath: `public${PORTAL_WORLD_ASSET_URLS[id]}`,
        minWidth: 512,
        minHeight: 512,
        maxWidth: 2_048,
        maxHeight: 2_048,
        maxBytes: 8 * 1_024 * 1_024,
      }),
    ),
  );
  assert.equal(
    new Set(directionalWorldResults.map((result) => result.hash)).size,
    directionalWorldResults.length,
    "west and east world portals must be independently authored",
  );

  await inspectTransparentRgbaPng({
    relativePath: `public${SANCTUM_FRAME_URL}`,
    minWidth: 768,
    minHeight: 256,
    maxWidth: 4_096,
    maxHeight: 2_048,
    maxBytes: 12 * 1_024 * 1_024,
  });
});
