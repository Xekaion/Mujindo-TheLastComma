import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const root = process.cwd();

const read = (relativePath) => readFile(path.join(root, relativePath), "utf8");

const normalizeSelector = (selector) => selector.replace(/\s+/g, " ").trim();

function cssRules(css) {
  const source = css.replace(/\/\*[\s\S]*?\*\//g, "");
  return [...source.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((match) => ({
    index: match.index,
    selectors: match[1].split(",").map(normalizeSelector),
    body: match[2],
  }));
}

function rulesFor(css, selector) {
  const normalized = normalizeSelector(selector);
  return cssRules(css).filter((rule) => rule.selectors.includes(normalized));
}

function declarations(body) {
  const result = new Map();
  for (const match of body.matchAll(/(?:^|;)\s*([\w-]+)\s*:\s*([^;]+)/g)) {
    result.set(match[1].toLowerCase(), match[2].trim());
  }
  return result;
}

function selectorHasClass(selector, className) {
  return new RegExp(`\\.${className}(?![\\w-])`).test(selector);
}

async function assertPng(relativePath) {
  const bytes = await readFile(path.join(root, relativePath));
  assert.ok(bytes.length >= 33, `${relativePath} is too short to be a PNG`);
  assert.deepEqual(
    [...bytes.subarray(0, 8)],
    [137, 80, 78, 71, 13, 10, 26, 10],
    `${relativePath} must have the PNG signature`,
  );
  assert.equal(bytes.subarray(12, 16).toString("ascii"), "IHDR", `${relativePath}: IHDR`);
  assert.ok(bytes.readUInt32BE(16) > 0, `${relativePath} needs a positive width`);
  assert.ok(bytes.readUInt32BE(20) > 0, `${relativePath} needs a positive height`);
  return bytes;
}

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function listCssFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await listCssFiles(absolutePath));
    else if (entry.isFile() && entry.name.endsWith(".css")) files.push(absolutePath);
  }
  return files;
}

test("the release shell is one centered 1920x1080 plane scaled by a transform", async () => {
  const [layout, globals] = await Promise.all([
    read("app/layout.tsx"),
    read("app/globals.css"),
  ]);

  assert.match(
    layout,
    /<body className="game-viewport" data-game-aspect="16:9">[\s\S]*?<GameAudioProvider>\{children\}<\/GameAudioProvider>/,
    "every route, overlay, and provider-owned widget must share the canonical plane",
  );
  assert.match(globals, /--game-design-width:\s*1920px;/);
  assert.match(globals, /--game-design-height:\s*1080px;/);
  assert.match(
    globals,
    /--game-viewport-scale:\s*min\(\s*calc\(100vw\s*\/\s*var\(--game-design-width\)\),\s*calc\(100dvh\s*\/\s*var\(--game-design-height\)\)\s*\);/,
    "the browser may change only the transform scale, never the design-plane dimensions",
  );

  const htmlRule = rulesFor(globals, "html").map((rule) => rule.body).join("\n");
  assert.match(htmlRule, /display:\s*grid;/);
  assert.match(htmlRule, /place-items:\s*center;/);
  assert.match(htmlRule, /overflow:\s*hidden;/);

  const frameRules = rulesFor(globals, "body.game-viewport");
  assert.ok(frameRules.length > 0, "body.game-viewport needs a canonical-plane rule");
  const frame = frameRules.map((rule) => rule.body).join("\n");
  assert.match(frame, /width:\s*var\(--game-design-width\);/);
  assert.match(frame, /height:\s*var\(--game-design-height\);/);
  assert.match(frame, /position:\s*absolute;/);
  assert.match(frame, /top:\s*50%;/);
  assert.match(frame, /left:\s*50%;/);
  assert.match(frame, /margin:\s*-540px\s+0\s+0\s+-960px;/);
  assert.match(frame, /aspect-ratio:\s*16\s*\/\s*9;/);
  assert.match(frame, /overflow:\s*hidden;/);
  assert.match(frame, /contain:\s*size layout paint;/);
  assert.match(
    frame,
    /transform:\s*translateZ\(0\)\s*scale\(var\(--game-viewport-scale\)\);/,
  );
  assert.match(frame, /transform-origin:\s*(?:center|50%\s+50%);/);
  assert.doesNotMatch(frame, /\bzoom\s*:/, "zoom would create a second scaling contract");
  assert.doesNotMatch(
    frame,
    /(?:width|height):\s*min\([^;]*(?:cqw|cqh|vw|vh)/,
    "the canonical plane must not reflow back to the browser dimensions",
  );
});

test("game content never re-adapts to raw browser viewport units inside the canonical plane", async () => {
  const cssFiles = await listCssFiles(path.join(root, "app"));
  for (const file of cssFiles) {
    if (path.basename(file) === "globals.css") continue;
    const css = (await readFile(file, "utf8")).replace(/\/\*[\s\S]*?\*\//g, "");
    assert.doesNotMatch(
      css,
      /-?(?:\d*\.)?\d+(?:vw|vh|vmin|vmax|svw|svh|lvw|lvh|dvw|dvh)\b/i,
      `${path.relative(root, file)} must size against the 1920x1080 container, not the browser`,
    );
  }
});

test("inventory card metadata uses one reset edge-chip contract and one corner per chip", async () => {
  const [overlay, gameCss] = await Promise.all([
    read("app/InventoryOverlay.tsx"),
    read("app/game.css"),
  ]);

  const classAttributes = [
    ...overlay.matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\})/g),
  ].map((match) => match[1] ?? match[2]);
  const placements = [
    ["inventory-screen-grid-level", "top", "left"],
    ["inventory-screen-grid-delta", "top", "right"],
    ["inventory-screen-enhancement-badge", "bottom", "left"],
    ["inventory-screen-grid-quality", "bottom", "right"],
  ];

  for (const [className] of placements) {
    assert.ok(
      classAttributes.some((value) =>
        value.includes(className) && value.includes("inventory-screen-card-edge-chip")),
      `${className} must opt into the shared compact edge-chip contract`,
    );
  }

  const allRules = cssRules(gameCss);
  const resetRules = rulesFor(gameCss, ".inventory-screen-card-edge-chip");
  assert.ok(resetRules.length > 0, ".inventory-screen-card-edge-chip needs a shared rule");
  const resetRule = resetRules.at(-1);
  const reset = declarations(resetRule.body);
  assert.equal(reset.get("position"), "absolute");
  assert.equal(reset.get("inset"), "auto", "the shared rule must clear every legacy inset");
  assert.match(resetRule.body, /display:\s*(?:inline-)?(?:flex|grid);/);
  assert.match(resetRule.body, /max-width:\s*[^;]+;/);
  assert.match(resetRule.body, /padding:\s*[^;]+;/);
  assert.match(resetRule.body, /border(?:-[\w-]+)?:\s*[^;]+;/);
  assert.match(resetRule.body, /background(?:-[\w-]+)?:\s*[^;]+;/);
  assert.match(resetRule.body, /white-space:\s*nowrap;/);

  for (const [className, verticalEdge, horizontalEdge] of placements) {
    const compoundRules = allRules.filter((rule) => rule.selectors.some((selector) =>
      selectorHasClass(selector, className)
      && selectorHasClass(selector, "inventory-screen-card-edge-chip")));
    assert.ok(compoundRules.length > 0, `${className} needs an authoritative corner rule`);
    const cornerRule = compoundRules.at(-1);
    assert.ok(
      cornerRule.index > resetRule.index,
      `${className} must be positioned after the common inset reset`,
    );

    const corner = declarations(cornerRule.body);
    const oppositeVertical = verticalEdge === "top" ? "bottom" : "top";
    const oppositeHorizontal = horizontalEdge === "left" ? "right" : "left";
    assert.ok(corner.has(verticalEdge), `${className} needs ${verticalEdge}`);
    assert.ok(corner.has(horizontalEdge), `${className} needs ${horizontalEdge}`);
    assert.notEqual(corner.get(verticalEdge), "auto", `${className} ${verticalEdge} must be active`);
    assert.notEqual(corner.get(horizontalEdge), "auto", `${className} ${horizontalEdge} must be active`);
    assert.ok(
      !corner.has(oppositeVertical) || corner.get(oppositeVertical) === "auto",
      `${className} must not activate both top and bottom`,
    );
    assert.ok(
      !corner.has(oppositeHorizontal) || corner.get(oppositeHorizontal) === "auto",
      `${className} must not activate both left and right`,
    );
    assert.ok(
      !corner.has("inset") || corner.get("inset") === "auto",
      `${className} must not replace the reset with a four-edge inset`,
    );

    const laterPositionalRule = allRules.find((rule) =>
      rule.index > cornerRule.index
      && rule.selectors.some((selector) => selectorHasClass(selector, className))
      && /(?:^|;)\s*(?:inset|top|right|bottom|left)\s*:/m.test(rule.body));
    assert.equal(
      laterPositionalRule,
      undefined,
      `${className} has a later positional override that can revive opposing insets`,
    );
  }
});

test("SOUND uses its dedicated PNG at one fixed canonical-plane position", async () => {
  const soundAsset = "/assets/ui/audio/audio-dock-medallion-v1.png";
  const [audioCss, provider] = await Promise.all([
    read("app/audio-controls.css"),
    read("app/GameAudioProvider.tsx"),
    assertPng(`public${soundAsset}`),
  ]);

  assert.match(
    provider,
    /className="audio-dock__trigger"[\s\S]{0,900}?<span>SOUND<\/span>/,
    "the provider-owned control must retain its visible SOUND label",
  );

  const rules = cssRules(audioCss);
  const dockRules = rulesFor(audioCss, ".audio-dock");
  const baseDockRule = dockRules.find((rule) => declarations(rule.body).get("position") === "fixed");
  assert.ok(baseDockRule, ".audio-dock must be fixed inside the transformed body");
  const baseDock = declarations(baseDockRule.body);
  assert.equal(baseDock.get("right"), "max(18px, var(--game-safe-right))");
  assert.equal(baseDock.get("bottom"), "max(18px, var(--game-safe-bottom))");

  const rightOffsets = dockRules
    .map((rule) => declarations(rule.body).get("right"))
    .filter(Boolean);
  const bottomOffsets = dockRules
    .map((rule) => declarations(rule.body).get("bottom"))
    .filter(Boolean);
  assert.equal(new Set(rightOffsets).size, 1, "SOUND right offset must not fork at a breakpoint");
  assert.equal(new Set(bottomOffsets).size, 1, "SOUND bottom offset must not fork at a breakpoint");

  const triggerRules = rulesFor(audioCss, ".audio-dock__trigger");
  const widths = triggerRules.map((rule) => declarations(rule.body).get("width")).filter(Boolean);
  const heights = triggerRules.map((rule) => declarations(rule.body).get("height")).filter(Boolean);
  assert.equal(new Set(widths).size, 1, "SOUND width must not fork at a compact breakpoint");
  assert.equal(new Set(heights).size, 1, "SOUND height must not fork at a compact breakpoint");
  assert.match(widths[0] ?? "", /^\d+(?:\.\d+)?px$/);
  assert.match(heights[0] ?? "", /^\d+(?:\.\d+)?px$/);

  const artRules = rules.filter((rule) =>
    rule.selectors.some((selector) => selector.startsWith(".audio-dock__trigger"))
    && rule.body.includes(soundAsset));
  assert.ok(artRules.length > 0, ".audio-dock__trigger must consume its dedicated medallion PNG");
  assert.ok(
    artRules.some((rule) => /background-size:\s*contain;|\/\s*contain(?:\s|;)/.test(rule.body)),
    "the SOUND medallion must preserve its authored aspect ratio",
  );

  const soundGeometry = [...dockRules, ...triggerRules]
    .map((rule) => rule.body)
    .join("\n");
  assert.doesNotMatch(
    soundGeometry,
    /(?:right|bottom|width|height):[^;]*(?:cqw|cqh|vw|vh)/,
    "the body transform, not a second responsive rule, must scale SOUND",
  );
});

test("the shared image scrollbar contract is used by real scroll owners", async () => {
  const assets = {
    track: "/assets/ui/scrollbars/gothic-track-v1.png",
    gold: "/assets/ui/scrollbars/gothic-thumb-gold-v1.png",
    aether: "/assets/ui/scrollbars/gothic-thumb-aether-v1.png",
  };
  await Promise.all(Object.values(assets).map((asset) => assertPng(`public${asset}`)));

  const cssFiles = await listCssFiles(path.join(root, "app"));
  const css = (await Promise.all(cssFiles.map((file) => readFile(file, "utf8")))).join("\n");
  const rules = cssRules(css);
  const hasAssetRule = (selector, asset) => rules.some((rule) =>
    rule.selectors.includes(normalizeSelector(selector)) && rule.body.includes(asset));

  assert.ok(rulesFor(css, ".game-scrollbar").length > 0, ".game-scrollbar needs a shared base rule");
  assert.ok(
    hasAssetRule(".game-scrollbar::-webkit-scrollbar-track", assets.track),
    ".game-scrollbar must use the shared Gothic track",
  );
  assert.ok(
    hasAssetRule(".game-scrollbar::-webkit-scrollbar-thumb", assets.gold),
    ".game-scrollbar must default to the shared gold thumb",
  );

  const goldOwners = [
    ".inventory-screen-grid-viewport",
    ".inventory-screen-detail-stats",
    ".audio-dock__panel",
  ];
  const aetherOwners = [".inventory-screen-enhancement-scroll"];
  for (const owner of [...goldOwners, ...aetherOwners]) {
    assert.ok(
      hasAssetRule(`${owner}::-webkit-scrollbar-track`, assets.track),
      `${owner} must share the Gothic image track instead of owning ad hoc scrollbar art`,
    );
  }
  for (const owner of goldOwners) {
    assert.ok(
      hasAssetRule(`${owner}::-webkit-scrollbar-thumb`, assets.gold),
      `${owner} must use the shared gold thumb`,
    );
  }
  for (const owner of aetherOwners) {
    assert.ok(
      hasAssetRule(`${owner}::-webkit-scrollbar-thumb`, assets.aether),
      `${owner} must use the shared aether thumb`,
    );
  }
});

test("divider consumers preserve the authored PNG ratio", async () => {
  const divider = "/assets/ui/inventory-controls/divider.png";
  const [gameCss, statsCss] = await Promise.all([
    read("app/game.css"),
    read("app/stats-overlay.css"),
  ]);
  const css = `${gameCss}\n${statsCss}`;
  const consumers = cssRules(css).filter((rule) => rule.body.includes(divider));
  assert.ok(consumers.length > 0, "the divider asset needs at least one live consumer");

  for (const consumer of consumers) {
    assert.doesNotMatch(
      consumer.body,
      /100%\s+100%/,
      `${consumer.selectors.join(", ")} must not stretch divider.png in both axes`,
    );
  }
  for (const selector of [
    ".inventory-screen-section-heading::after",
    ".stats-header::after",
  ]) {
    assert.ok(
      consumers.some((rule) => rule.selectors.includes(selector)),
      `${selector} must retain the shared divider`,
    );
  }
});

test("live panel CSS no longer crops augment-ui-atlas as a background", async () => {
  const cssFiles = await listCssFiles(path.join(root, "app"));
  assert.ok(cssFiles.length > 0, "app CSS files are missing");
  for (const file of cssFiles) {
    const css = (await readFile(file, "utf8")).replace(/\/\*[\s\S]*?\*\//g, "");
    assert.doesNotMatch(
      css,
      /url\(\s*["']?\/assets\/augment-ui-atlas\.png["']?\s*\)/,
      `${path.relative(root, file)} still paints a live panel with augment-ui-atlas.png`,
    );
  }
});

test("generated investor UI art keeps reproducible source, prompt, matte, and output records", async () => {
  const build = JSON.parse(await read("asset-sources/imagegen/investor-ui-assets-v1.build.json"));
  assert.equal(build.builder, "scripts/build_investor_ui_assets_v1.py");
  assert.equal(build.generator, "OpenAI built-in image_gen");
  assert.match(build.pipeline.resize, /premultiplied-alpha/i);
  assert.deepEqual(build.pipeline.audioCanvas, [320, 320]);
  assert.deepEqual(build.pipeline.scrollbarCanvas, [96, 576]);

  for (const record of [...build.inputs, ...build.outputs]) {
    const bytes = await readFile(path.join(root, record.path));
    assert.equal(sha256(bytes), record.sha256, `${record.path} must match its build record`);
  }
  for (const output of build.outputs) {
    assert.equal(output.chromaResidualPixels, 0, `${output.path} must be chroma-clean`);
    assert.ok(output.alphaLevels >= 16, `${output.path} must retain soft alpha detail`);
  }
});
