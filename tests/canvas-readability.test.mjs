import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const readSource = (relativePath) =>
  readFile(path.join(root, relativePath), "utf8");

test("the expedition canvas keeps every label in its canonical 1280 by 720 coordinate plane", async () => {
  const source = await readSource("app/GameCanvas.tsx");

  assert.doesNotMatch(
    source,
    /<canvas[\s\S]{0,120}?(?:width=\{WIDTH\}|height=\{HEIGHT\})/,
    "React props must not reset the resize-managed backing store to 1280x720",
  );
  assert.match(source, /canvasBackingDimensions\(\s*WIDTH,\s*HEIGHT,/);
  assert.doesNotMatch(
    source,
    /canvasCssScale|cacheCanvasCssScale|readableCanvasFontSize/,
  );
  assert.doesNotMatch(source, /minimumCssPx\s*\/\s*canvasCssScale/);
  assert.match(source, /context\.font = "800 18px serif";/);
  assert.match(source, /context\.font = "700 10px sans-serif";/);
  assert.match(source, /\? "700 15px serif"\s*: "600 11px sans-serif"/);
  assert.match(source, /context\.font = "700 12px sans-serif";/);
  assert.match(
    source,
    /return \(\) => \{\s*cancelAnimationFrame\(frame\);\s*\};/,
  );

  // Map scrolling is also expressed in layout pixels; visual DOMRect pixels
  // would apply the outer 16:9 scale twice.
  assert.match(
    source,
    /current\.offsetLeft \+\s*current\.offsetWidth \/ 2 - board\.clientWidth \/ 2/,
  );
  assert.match(
    source,
    /current\.offsetTop \+\s*current\.offsetHeight \/ 2 - board\.clientHeight \/ 2/,
  );
});

test("ordinary shield points stay in the HUD without drawing a persistent ring around the player", async () => {
  const source = await readSource("app/GameCanvas.tsx");
  const playerRenderStart = source.lastIndexOf("const playerDrawn =");
  const mirrorBarrierStart = source.indexOf(
    "if (player.mirrorAegisBarrierTime > 0)",
    playerRenderStart,
  );

  assert.ok(playerRenderStart >= 0 && mirrorBarrierStart > playerRenderStart);
  const ordinaryPlayerRender = source.slice(playerRenderStart, mirrorBarrierStart);
  assert.doesNotMatch(
    ordinaryPlayerRender,
    /if \(player\.shield > 0\)[\s\S]{0,320}?context\.(?:arc|stroke)\(/,
    "ordinary shield points must not draw a circle beneath or around the player",
  );
  assert.match(
    source,
    /hud\.player\.shield > 0[\s\S]{0,100}?Math\.ceil\(hud\.player\.shield\)/,
    "the shield amount must remain visible in the combat HUD",
  );
});

test("the PVP canvas scales names, respawn text, and countdown copy with the whole 16:9 plane", async () => {
  const source = await readSource("app/pvp/PvpArena.tsx");

  assert.doesNotMatch(
    source,
    /<canvas[\s\S]{0,120}?(?:width=\{PVP_ARENA_WIDTH\}|height=\{PVP_ARENA_HEIGHT\})/,
    "React props must not reset the resize-managed PVP backing store",
  );
  assert.match(
    source,
    /canvasBackingDimensions\(\s*PVP_ARENA_WIDTH,\s*PVP_ARENA_HEIGHT,/,
  );
  assert.doesNotMatch(
    source,
    /canvasCssScale|cacheCanvasCssScale|readableCanvasFontSize/,
  );
  assert.doesNotMatch(source, /minimumCssPx\s*\/\s*canvasCssScale/);
  assert.match(
    source,
    /context\.font = "700 12px Pretendard, sans-serif";\s*context\.letterSpacing = "0px";[\s\S]{0,180}?context\.fillText\(player\.name/,
  );
  assert.match(
    source,
    /context\.fillText\(`\$\{Math\.ceil\(player\.respawnMs \/ 1_000\)\}`/,
  );
  assert.match(source, /context\.font = "700 82px Georgia, serif";/);
  assert.match(
    source,
    /context\.font = "800 12px Pretendard, sans-serif";[\s\S]{0,180}?context\.fillText\(/,
  );
  assert.match(
    source,
    /return \(\) => \{\s*window\.cancelAnimationFrame\(animationFrame\);[\s\S]{0,360}?roomAtlas\.src = "";[\s\S]{0,120}?fallbackRoom\.src = "";/,
  );
});

test("the inventory portrait is a static illustrated compositor rather than a gameplay canvas", async () => {
  const source = await readSource("app/InventoryPaperdollFigure.tsx");

  assert.match(source, /data-portrait-mode="illustrated"/);
  assert.match(source, /INVENTORY_PORTRAIT_BASE_PATH/);
  assert.match(source, /INVENTORY_PORTRAIT_FITTED_ARMOR_PATH/);
  assert.match(source, /INVENTORY_PORTRAIT_GEAR_ATLAS_PATH/);
  assert.match(source, /left: `\$\{geometry\.left\}%`/);
  assert.match(source, /top: `\$\{geometry\.top\}%`/);
  assert.match(source, /width: `\$\{geometry\.width\}%`/);
  assert.doesNotMatch(
    source,
    /<canvas|getContext\(|devicePixelRatio|requestAnimationFrame|characterRenderFrameIndex|PAPERDOLL_BODY_PATH/,
  );
});

test("the shared plaza canvas uses layout coordinates and never inversely scales character labels", async () => {
  const source = await readSource("app/PlazaHub.tsx");

  assert.match(source, /const width = Math\.max\(1, root\.clientWidth\);/);
  assert.match(source, /const height = Math\.max\(1, root\.clientHeight\);/);
  assert.match(source, /canvas\.style\.width = "100%";/);
  assert.match(source, /canvas\.style\.height = "100%";/);
  assert.doesNotMatch(source, /minimumCssPx\s*\/\s*canvasCssScale/);
  assert.match(
    source,
    /readableCanvasFontSize = \(basePx: number, minimumCssPx: number\) => \{\s*void minimumCssPx;\s*return basePx;/,
  );
  assert.match(
    source,
    /readableCanvasFontSize\(14, 11\).*?sans-serif[\s\S]{0,220}?context\.fillText\([\s\S]{0,100}?`\$\{player\.displayName\}[^`]*LV\.\$\{player\.level\}`/,
  );
  const nameplateStart = source.indexOf("function drawPlazaPlayerNameplate(");
  const connectionLabelStart = source.indexOf("function connectionLabel(");
  assert.ok(
    nameplateStart >= 0 && connectionLabelStart > nameplateStart,
    "plaza nameplate renderer must exist",
  );
  const drawPlayerBlock = source.slice(nameplateStart, connectionLabelStart);
  assert.doesNotMatch(
    drawPlayerBlock,
    /dungeonFloor/,
    "plaza overhead labels must contain only the nickname and level",
  );

  const animationEffect = source.slice(
    source.indexOf('const context = canvas.getContext("2d", { alpha: false });'),
    source.indexOf("const handleCanvasPointer"),
  );
  const animationFrameBody = animationEffect.slice(
    animationEffect.indexOf("const frame = (now: number) =>"),
  );
  assert.doesNotMatch(animationFrameBody, /getBoundingClientRect\(\)/);
});
