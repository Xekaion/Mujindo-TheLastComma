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
    /readableCanvasFontSize\(9, 11\).*?sans-serif[\s\S]{0,120}?context\.fillText\("현재 캐릭터"/,
  );
  assert.match(
    source,
    /readableCanvasFontSize\(14, 11\).*?sans-serif[\s\S]{0,220}?context\.fillText\([\s\S]{0,100}?`\$\{player\.displayName\} · 기록 심도 지하 \$\{player\.dungeonFloor\}층 · LV\.\$\{player\.level\}`/,
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
