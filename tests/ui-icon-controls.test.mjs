import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const root = process.cwd();
const read = (relativePath) => readFile(path.join(root, relativePath), "utf8");

const iconCloseClasses = [
  "build-panel-close",
  "map-close",
  "shop-close",
  "inventory-screen-close",
  "inventory-screen-divine-forge-close",
  "plaza-character-profile__close",
];

function ruleBodiesForClass(css, className) {
  const rules = [];
  for (const match of css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (new RegExp(`\\.${className}(?![\\w-])`).test(match[1])) rules.push(match[2]);
  }
  return rules;
}

test("icon-only close controls share one fixed canonical-plane asset contract", async () => {
  const [css, asset] = await Promise.all([
    read("app/ui-controls.css"),
    readFile(path.join(root, "public/assets/ui/inventory-controls/close.png")),
  ]);

  assert.deepEqual([...asset.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.match(css, /--game-icon-close-size:\s*42px;/);
  assert.doesNotMatch(
    css,
    /-?(?:\d*\.)?\d+(?:vw|vh|vmin|vmax|cqw|cqh|svw|svh|dvw|dvh)\b|\bclamp\s*\(/i,
    "close buttons must scale only with the canonical body transform",
  );

  for (const className of iconCloseClasses) {
    const bodies = ruleBodiesForClass(css, className).join("\n");
    assert.match(bodies, /width:\s*var\(--game-icon-close-size\);/);
    assert.match(bodies, /height:\s*var\(--game-icon-close-size\);/);
    assert.match(bodies, /background-image:\s*url\("\/assets\/ui\/inventory-controls\/close\.png"\);/);
    assert.match(bodies, /background-size:\s*contain;/, `${className} must preserve the asset ratio`);
    assert.match(bodies, /font-size:\s*0;/, `${className} must not paint its fallback × glyph`);
  }

  assert.doesNotMatch(css, /\.stats-close(?![\w-])/, "the semantic stats close action stays textual");
});

test("icon-only close controls expose complete interactive and reduced-motion states", async () => {
  const css = await read("app/ui-controls.css");

  assert.match(css, /:not\(:disabled\):hover\s*\{[\s\S]*?filter:\s*brightness\(/);
  assert.match(
    css,
    /:focus-visible\s*\{[\s\S]*?outline:\s*none;[\s\S]*?drop-shadow\(0 0 2px[\s\S]*?drop-shadow\(0 0 9px/,
    "authored close medallions need a shape-following keyboard focus halo",
  );
  assert.match(css, /:not\(:disabled\):active\s*\{[\s\S]*?scale\(0\.955\)/);
  assert.match(css, /:disabled\s*\{[\s\S]*?cursor:\s*not-allowed;/);
  assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)/);
  assert.match(css, /cursor:\s*pointer;/);
  assert.match(css, /:focus-visible[\s\S]*?scale\(1\.075\)/, "keyboard focus must remain visibly enlarged");
});

test("every unified icon close remains a labelled native button", async () => {
  const sources = await Promise.all([
    read("app/GameCanvas.tsx"),
    read("app/InventoryOverlay.tsx"),
    read("app/ShopOverlay.tsx"),
    read("app/PlazaCharacterProfile.tsx"),
  ]);
  const source = sources.join("\n");

  for (const className of iconCloseClasses) {
    const classOffset = source.indexOf(`className="${className}"`);
    assert.notEqual(classOffset, -1, `${className} must be attached to its close button`);
    const openingButton = source.lastIndexOf("<button", classOffset);
    const closingButton = source.indexOf("</button>", classOffset);
    assert.ok(openingButton >= 0 && closingButton > classOffset, `${className} must be a native button`);
    const buttonMarkup = source.slice(openingButton, closingButton);
    assert.match(buttonMarkup, /type="button"/, `${className} must never submit an enclosing form`);
    assert.match(buttonMarkup, /aria-label=/, `${className} requires an accessible name`);
    assert.doesNotMatch(buttonMarkup, /disabled=\{?true\}?/, `${className} must remain operable`);
  }
});
