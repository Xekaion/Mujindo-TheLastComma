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
  assert.match(frameRule[1], /width:\s*min\(100vw,\s*177\.777778dvh\);/);
  assert.match(frameRule[1], /height:\s*min\(100dvh,\s*56\.25vw\);/);
  assert.match(frameRule[1], /aspect-ratio:\s*16\s*\/\s*9;/);
  assert.match(frameRule[1], /overflow:\s*hidden;/);
  assert.match(frameRule[1], /container-name:\s*game-viewport;/);
  assert.match(frameRule[1], /container-type:\s*size;/);
  assert.match(frameRule[1], /contain:\s*size layout paint;/);
  assert.match(frameRule[1], /transform:\s*translateZ\(0\);/);

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
  const [inventory, plaza, pvp] = await Promise.all([
    read("app/InventoryOverlay.tsx"),
    read("app/PlazaHub.tsx"),
    read("app/pvp/PvpArena.tsx"),
  ]);

  assert.match(inventory, /const frameRect = document\.body\.getBoundingClientRect\(\);/);
  assert.match(inventory, /const localX = clientX - frameRect\.left;/);
  assert.match(inventory, /const localY = clientY - frameRect\.top;/);
  assert.match(inventory, /createPortal\([\s\S]{0,800}?document\.body,/);
  assert.match(plaza, /const width = Math\.max\(1, rect\.width\);/);
  assert.match(plaza, /const height = Math\.max\(1, rect\.height\);/);
  assert.doesNotMatch(plaza, /Math\.max\(320, rect\.(?:width|height)\)/);
  assert.match(
    pvp,
    /const clear = \(\) => \{[\s\S]{0,180}?keysRef\.current\.clear\(\);[\s\S]{0,180}?mobileMoveRef\.current = \{ x: 0, y: 0 \};[\s\S]{0,120}?dashQueuedRef\.current = false;/,
  );
  assert.equal((pvp.match(/onPointerLeave=\{\(\) => setMobileMove\(0, 0\)\}/g) ?? []).length, 4);
});
