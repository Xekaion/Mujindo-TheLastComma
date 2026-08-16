import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const root = process.cwd();

const read = (relativePath) =>
  readFile(path.join(root, relativePath), "utf8");

test("the whole game is contained by one centered 16:9 viewport", async () => {
  const [layout, globals] = await Promise.all([
    read("app/layout.tsx"),
    read("app/globals.css"),
  ]);

  assert.match(
    layout,
    /<body className="game-viewport" data-game-aspect="16:9">[\s\S]*?<GameAudioProvider>\{children\}<\/GameAudioProvider>/,
    "every route and the provider-owned audio UI must share the same aspect frame",
  );
  assert.match(
    globals,
    /html\s*\{[^}]*height:\s*100%;[^}]*overflow:\s*hidden;[^}]*background:\s*#000;/,
    "the browser area outside the game must be a clipped black letterbox",
  );
  assert.match(globals, /html\s*\{[^}]*display:\s*grid;[^}]*place-items:\s*center;/);

  const frameRule = globals.match(/body\.game-viewport\s*\{([^}]*)\}/);
  assert.ok(frameRule, "the shared game viewport rule is missing");
  assert.match(globals, /--game-design-width:\s*1920px;/);
  assert.match(globals, /--game-design-height:\s*1080px;/);
  assert.match(
    globals,
    /--game-viewport-scale:\s*min\([\s\S]*?calc\(100vw\s*\/\s*var\(--game-design-width\)\)[\s\S]*?calc\(100dvh\s*\/\s*var\(--game-design-height\)\)[\s\S]*?\);/,
    "the release viewport must scale one canonical design plane instead of reflowing it",
  );
  assert.match(frameRule[1], /width:\s*var\(--game-design-width\);/);
  assert.match(frameRule[1], /height:\s*var\(--game-design-height\);/);
  assert.match(frameRule[1], /position:\s*absolute;/);
  assert.match(frameRule[1], /top:\s*50%;/);
  assert.match(frameRule[1], /left:\s*50%;/);
  assert.match(frameRule[1], /margin:\s*-540px\s+0\s+0\s+-960px;/);
  assert.match(frameRule[1], /aspect-ratio:\s*16\s*\/\s*9;/);
  assert.match(frameRule[1], /overflow:\s*hidden;/);
  assert.match(frameRule[1], /container-name:\s*game-viewport;/);
  assert.match(frameRule[1], /container-type:\s*size;/);
  assert.match(frameRule[1], /contain:\s*size layout paint;/);
  assert.match(
    frameRule[1],
    /transform:\s*translateZ\(0\)\s*scale\(var\(--game-viewport-scale\)\);/,
  );
  assert.match(frameRule[1], /transform-origin:\s*center;/);

  assert.match(
    globals,
    /\.game-entry-flow\s*\{[^}]*width:\s*100%;[^}]*height:\s*100%;[^}]*min-height:\s*0;[^}]*overflow:\s*hidden;/,
  );
});

test("all game screens fill the aspect frame instead of the browser viewport", async () => {
  const [game, character, plaza, pvp, market, stats, profile, audio] = await Promise.all([
    read("app/game.css"),
    read("app/character-entry.css"),
    read("app/plaza.css"),
    read("app/pvp/pvp.css"),
    read("app/market/market.css"),
    read("app/stats-overlay.css"),
    read("app/plaza-character-profile.css"),
    read("app/audio-controls.css"),
  ]);

  assert.match(
    game,
    /\.menu-screen,\s*\n\.game-screen\s*\{[^}]*width:\s*100%;[^}]*height:\s*100%;[^}]*min-height:\s*0;/,
  );
  assert.match(
    character,
    /\.character-entry\s*\{[^}]*width:\s*100%;[^}]*height:\s*100%;[^}]*min-height:\s*0;/,
  );
  assert.match(
    plaza,
    /\.plaza-hub\s*\{[^}]*width:\s*100%;[^}]*height:\s*100%;[^}]*min-height:\s*0;/,
  );
  assert.match(
    pvp,
    /\.pvp-screen\s*\{[^}]*width:\s*100%;[^}]*height:\s*100%;[^}]*min-height:\s*0;/,
  );
  assert.match(
    market,
    /\.market-screen\s*\{[^}]*width:\s*100%;[^}]*height:\s*100%;[^}]*min-height:\s*0;[^}]*overflow-y:\s*auto;/,
    "the market must scroll inside the aspect frame",
  );

  for (const [name, css] of Object.entries({ game, character, plaza, pvp, market, stats, profile, audio })) {
    assert.doesNotMatch(
      css,
      /(?:\d|\.)(?:d|s|l)?v[wh]\b/,
      `${name} CSS must use game-container units rather than escaping to the browser viewport`,
    );
    assert.doesNotMatch(
      css,
      /@media[^\r\n{]*(?:min|max)-(?:width|height)/,
      `${name} responsive breakpoints must measure the 16:9 game frame, not the outer browser`,
    );
  }

  assert.match(market, /@container game-viewport \(max-width: 840px\)/);
  assert.match(
    pvp,
    /@container game-viewport \(max-width: 900px\)[\s\S]*?\.pvp-lobby\s*\{[^}]*align-content:\s*start;[^}]*overflow-y:\s*auto;/,
    "an unusually short compact PVP lobby must scroll from its true top edge",
  );
  assert.match(stats, /@container game-viewport \(max-height: 700px\) and \(min-width: 981px\)/);
});

test("fixed overlays and canvas sizing remain local to the aspect frame", async () => {
  const [inventory, plane, plaza, pvp] = await Promise.all([
    read("app/InventoryOverlay.tsx"),
    read("app/canonical-game-plane.ts"),
    read("app/PlazaHub.tsx"),
    read("app/pvp/PvpArena.tsx"),
  ]);

  assert.match(plane, /export const GAME_DESIGN_WIDTH = 1920;/);
  assert.match(plane, /export const GAME_DESIGN_HEIGHT = 1080;/);
  assert.match(plane, /const rect = plane\.getBoundingClientRect\(\);/);
  assert.match(plane, /const width = positiveOr\(plane\.clientWidth, GAME_DESIGN_WIDTH\);/);
  assert.match(plane, /const height = positiveOr\(plane\.clientHeight, GAME_DESIGN_HEIGHT\);/);
  assert.match(plane, /clientToPlaneScaleX: width \/ renderedWidth,/);
  assert.match(plane, /clientToPlaneScaleY: height \/ renderedHeight,/);
  assert.match(plane, /x: \(clientX - metrics\.clientLeft\) \* metrics\.clientToPlaneScaleX,/);
  assert.match(plane, /y: \(clientY - metrics\.clientTop\) \* metrics\.clientToPlaneScaleY,/);
  assert.match(plane, /width: rect\.width \* metrics\.clientToPlaneScaleX,/);
  assert.match(plane, /height: rect\.height \* metrics\.clientToPlaneScaleY,/);
  assert.doesNotMatch(plane, /window\.(?:innerWidth|innerHeight)/);
  assert.match(inventory, /const frame = readGamePlaneMetrics\(\);/);
  assert.match(inventory, /const localPoint = clientPointToGamePlane\(clientX, clientY, frame\);/);
  assert.match(inventory, /const size = clientRectSizeToGamePlane\(rect\);/);
  assert.match(inventory, /onMeasure\(size\.width, size\.height\);/);
  assert.match(
    inventory,
    /const logicalOffsetInClientPixels = 56 \/ frame\.clientToPlaneScaleY;/,
    "focus anchors must preserve the same 56 design-pixel offset at every viewport scale",
  );
  assert.equal(
    (inventory.match(/const anchor = focusTooltipAnchor\(rect\);/g) ?? []).length,
    2,
    "focus and pointer-leave focus retention must share one canonical anchor conversion",
  );
  assert.doesNotMatch(
    inventory,
    /onMeasure\(rect\.width,\s*rect\.height\)/,
    "transformed tooltip measurements must be converted back into design-plane units",
  );
  assert.match(inventory, /createPortal\([\s\S]{0,800}?document\.body,/);
  assert.match(plaza, /const width = Math\.max\(1, root\.clientWidth\);/);
  assert.match(plaza, /const height = Math\.max\(1, root\.clientHeight\);/);
  assert.match(plaza, /const renderedScale = Math\.max\([\s\S]{0,180}?rect\.width \/ width[\s\S]{0,80}?rect\.height \/ height/);
  assert.match(plaza, /canvas\.style\.width = "100%";/);
  assert.match(plaza, /canvas\.style\.height = "100%";/);
  assert.doesNotMatch(plaza, /canvas\.style\.(?:width|height) = `\$\{/);
  assert.match(plaza, /window\.addEventListener\("resize", resize\);/);
  assert.match(plaza, /window\.removeEventListener\("resize", resize\);/);
  assert.doesNotMatch(plaza, /Math\.max\(320, rect\.(?:width|height)\)/);
  assert.match(
    pvp,
    /const clear = \(\) => \{[\s\S]{0,180}?keysRef\.current\.clear\(\);[\s\S]{0,180}?mobileMoveRef\.current = \{ x: 0, y: 0 \};[\s\S]{0,120}?dashQueuedRef\.current = false;/,
  );
  assert.equal((pvp.match(/onPointerLeave=\{\(\) => setMobileMove\(0, 0\)\}/g) ?? []).length, 4);
});

test("DOM overlays, portals, and inventory card metadata have no second viewport scale", async () => {
  const [
    globals,
    game,
    audio,
    character,
    stats,
    market,
    inventory,
    shop,
    provider,
  ] = await Promise.all([
    read("app/globals.css"),
    read("app/game.css"),
    read("app/audio-controls.css"),
    read("app/character-entry.css"),
    read("app/stats-overlay.css"),
    read("app/market/market.css"),
    read("app/InventoryOverlay.tsx"),
    read("app/ShopOverlay.tsx"),
    read("app/GameAudioProvider.tsx"),
  ]);

  assert.match(globals, /--game-safe-top:\s*0px;/);
  assert.match(globals, /--game-safe-right:\s*0px;/);
  assert.match(globals, /--game-safe-bottom:\s*0px;/);
  assert.match(globals, /--game-safe-left:\s*0px;/);

  for (const [name, source] of Object.entries({
    globals,
    game,
    audio,
    character,
    stats,
    market,
    inventory,
    shop,
    provider,
  })) {
    assert.doesNotMatch(
      source,
      /env\(safe-area-inset-(?:top|right|bottom|left)\)/,
      `${name} must not apply physical-device insets inside the letterboxed picture`,
    );
    assert.doesNotMatch(
      source,
      /window\.(?:innerWidth|innerHeight)|visualViewport|screen\.(?:width|height)/,
      `${name} must not re-layout against the outer browser after the plane transform`,
    );
  }

  assert.match(game, /\.shop-screen\s*\{[^}]*position:\s*fixed;[^}]*inset:\s*0;/);
  assert.match(game, /\.inventory-screen\s*\{[^}]*position:\s*fixed;[^}]*inset:\s*0;/);
  assert.match(stats, /\.stats-backdrop\s*\{[^}]*position:\s*fixed;[^}]*inset:\s*0;/);
  assert.match(character, /\.character-entry-dialog-backdrop\s*\{[^}]*position:\s*fixed;[^}]*inset:\s*0;/);
  assert.match(market, /\.market-confirm-backdrop\s*\{[^}]*position:\s*fixed;[^}]*inset:\s*0;/);
  assert.match(audio, /\.audio-dock\s*\{[^}]*position:\s*fixed;[^}]*right:\s*max\(18px,\s*var\(--game-safe-right\)\);[^}]*bottom:\s*max\(18px,\s*var\(--game-safe-bottom\)\);/);

  const portalTargets = inventory.match(/document\.body,/g) ?? [];
  assert.equal(portalTargets.length, 2, "both inventory portals must remain children of the transformed body");
  assert.equal(
    inventory.match(/createPortal\(/g)?.length,
    portalTargets.length,
    "an inventory portal must never escape to the browser document element",
  );

  const cardContractStart = game.indexOf("Investor-ready inventory card hierarchy V10");
  assert.ok(cardContractStart >= 0, "the canonical inventory-card contract is missing");
  const cardContract = game.slice(cardContractStart);
  assert.doesNotMatch(
    cardContract,
    /(?:font-size|top|right|bottom|left|padding|height):[^;]*(?:\bcqw\b|\bcqh\b|\bvw\b|\bvh\b|\bvmin\b|\bvmax\b|\bclamp\s*\()/,
    "card text and corner chips must scale only with the whole game plane",
  );
  assert.match(cardContract, /\.inventory-screen-card-edge-chip\s*\{[^}]*position:\s*absolute;[^}]*inset:\s*auto;/);
  assert.match(cardContract, /\.inventory-screen \.inventory-screen-card-edge-chip\.inventory-screen-grid-level\s*\{[^}]*top:\s*5px;[^}]*left:\s*6px;[^}]*font-size:\s*8px;/);
  assert.match(cardContract, /\.inventory-screen \.inventory-screen-card-edge-chip\.inventory-screen-grid-delta\s*\{[^}]*top:\s*5px;[^}]*right:\s*5px;[^}]*font-size:\s*9px;/);
  assert.match(cardContract, /\.inventory-screen \.inventory-screen-card-edge-chip\.inventory-screen-enhancement-badge\s*\{[^}]*bottom:\s*6px;[^}]*left:\s*6px;[^}]*font-size:\s*9px;/);
  assert.match(cardContract, /\.inventory-screen \.inventory-screen-card-edge-chip\.inventory-screen-grid-quality\s*\{[^}]*right:\s*5px;[^}]*bottom:\s*6px;[^}]*font-size:\s*7px;/);
  assert.match(cardContract, /\.inventory-screen \.inventory-screen-grid-item \.inventory-screen-slot-clip > \.inventory-screen-gear-icon\s*\{[^}]*width:\s*calc\(100% - 2px\) !important;[^}]*height:\s*calc\(100% - 2px\) !important;/);
});
