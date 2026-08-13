import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const readSource = (relativePath) =>
  readFile(path.join(root, relativePath), "utf8");

test("the expedition canvas caches its CSS scale and keeps combat labels readable", async () => {
  const source = await readSource("app/GameCanvas.tsx");

  assert.match(
    source,
    /const initialCanvasRect = canvas\.getBoundingClientRect\(\);\s*cacheCanvasCssScale\(initialCanvasRect\.width, initialCanvasRect\.height\);/,
  );
  assert.match(
    source,
    /new ResizeObserver\(\(\[entry\]\) => \{[\s\S]{0,180}?entry\.contentRect\.width[\s\S]{0,80}?entry\.contentRect\.height/,
  );
  assert.match(
    source,
    /Math\.min\(renderedWidth \/ WIDTH, renderedHeight \/ HEIGHT\)/,
  );
  assert.match(
    source,
    /Math\.max\(basePx, minimumCssPx \/ canvasCssScale\)/,
  );
  assert.match(source, /readableCanvasFontSize\(10, 11\).*?sans-serif/);
  assert.match(source, /readableCanvasFontSize\(11, 11\).*?sans-serif/);
  assert.match(source, /readableCanvasFontSize\(12, 11\).*?sans-serif/);
  assert.match(
    source,
    /return \(\) => \{\s*canvasResizeObserver\.disconnect\(\);\s*cancelAnimationFrame\(frame\);\s*\};/,
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

test("the PVP canvas applies the same scale floor to names, respawn text, and countdown copy", async () => {
  const source = await readSource("app/pvp/PvpArena.tsx");

  assert.match(
    source,
    /Math\.min\(\s*renderedWidth \/ PVP_ARENA_WIDTH,\s*renderedHeight \/ PVP_ARENA_HEIGHT,\s*\)/,
  );
  assert.match(
    source,
    /const initialCanvasRect = canvas\.getBoundingClientRect\(\);\s*cacheCanvasCssScale\(initialCanvasRect\.width, initialCanvasRect\.height\);/,
  );
  assert.match(
    source,
    /new ResizeObserver\(\(\[entry\]\) => \{[\s\S]{0,180}?entry\.contentRect\.width[\s\S]{0,80}?entry\.contentRect\.height/,
  );
  assert.match(
    source,
    /context\.font = `700 \$\{readableCanvasFontSize\(12, 11\)\}px Pretendard, sans-serif`;\s*context\.letterSpacing = "0px";[\s\S]{0,180}?context\.fillText\(player\.name/,
  );
  assert.match(
    source,
    /context\.fillText\(`\$\{Math\.ceil\(player\.respawnMs \/ 1_000\)\}`/,
  );
  assert.match(
    source,
    /readableCanvasFontSize\(12, 10\).*?Pretendard[\s\S]{0,180}?context\.fillText\("MEMORY DUEL"/,
  );
  assert.match(
    source,
    /return \(\) => \{\s*canvasResizeObserver\.disconnect\(\);\s*window\.cancelAnimationFrame\(animationFrame\);\s*\};/,
  );
});

test("the shared plaza canvas keeps character labels readable without frame-time layout reads", async () => {
  const source = await readSource("app/PlazaHub.tsx");

  assert.match(
    source,
    /const initialCanvasRect = canvas\.getBoundingClientRect\(\);\s*cacheCanvasCssScale\(initialCanvasRect\.width, initialCanvasRect\.height\);/,
  );
  assert.match(
    source,
    /new ResizeObserver\(\(\[entry\]\) => \{[\s\S]{0,180}?entry\.contentRect\.width[\s\S]{0,80}?entry\.contentRect\.height/,
  );
  assert.match(
    source,
    /Math\.min\(renderedWidth \/ logicalWidth, renderedHeight \/ logicalHeight\)/,
  );
  assert.match(
    source,
    /readableCanvasFontSize\(14, 11\).*?sans-serif[\s\S]{0,220}?context\.fillText\([\s\S]{0,100}?`\$\{player\.displayName\} · LV\.\$\{player\.level\}`/,
  );
  const drawPlayerBlock = source.slice(
    source.indexOf("function drawPlayer("),
    source.indexOf("function connectionLabel("),
  );
  assert.doesNotMatch(
    drawPlayerBlock,
    /dungeonFloor|기록 심도|지하|현재 캐릭터/,
    "plaza overhead labels must contain only the nickname and level",
  );
  assert.match(
    source,
    /return \(\) => \{\s*canvasResizeObserver\.disconnect\(\);\s*window\.cancelAnimationFrame\(animationFrame\);/,
  );

  const animationEffect = source.slice(
    source.indexOf('const context = canvas.getContext("2d", { alpha: false });'),
    source.indexOf("const handleCanvasPointer"),
  );
  const animationFrameBody = animationEffect.slice(animationEffect.indexOf("const frame = (now: number) =>"));
  assert.doesNotMatch(animationFrameBody, /getBoundingClientRect\(\)/);
});
