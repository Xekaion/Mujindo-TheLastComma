import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const ROOT = process.cwd();
const css = fs.readFileSync(path.join(ROOT, "app", "ui-form-controls.css"), "utf8");
const audioSource = fs.readFileSync(path.join(ROOT, "app", "GameAudioProvider.tsx"), "utf8");
const inventorySource = fs.readFileSync(path.join(ROOT, "app", "InventoryOverlay.tsx"), "utf8");
const marketSource = fs.readFileSync(path.join(ROOT, "app", "market", "MarketBoard.tsx"), "utf8");

test("native buttons and selects cannot fall back to operating-system chrome", () => {
  assert.match(css, /:where\(body\.game-viewport\) button\s*\{[\s\S]*?appearance:\s*none/);
  assert.match(css, /:where\(body\.game-viewport\) button\s*\{[\s\S]*?border:\s*1px solid[\s\S]*?linear-gradient/);
  assert.match(css, /body\.game-viewport select\s*\{[\s\S]*?appearance:\s*none\s*!important/);
  assert.match(css, /gothic-nine-slice-frame-v2\.png/);
  assert.match(css, /border-image-slice:\s*16%/);
  assert.match(css, /border-image-repeat:\s*round/);
  assert.doesNotMatch(css, /tooltip-panel\.png/);
  assert.match(css, /linear-gradient\(45deg[\s\S]*linear-gradient\(135deg/);
  assert.match(css, /select:hover:not\(:disabled\)/);
  assert.match(css, /select:focus-visible/);
  assert.match(css, /select:disabled/);
});

test("range controls have complete Blink-WebKit and Gecko skins", () => {
  assert.match(audioSource, /type="range"/);
  assert.match(css, /input\[type="range"\]::-webkit-slider-runnable-track/);
  assert.match(css, /input\[type="range"\]::-webkit-slider-thumb/);
  assert.match(css, /input\[type="range"\]::-moz-range-track/);
  assert.match(css, /input\[type="range"\]::-moz-range-progress/);
  assert.match(css, /input\[type="range"\]::-moz-range-thumb/);
  assert.match(css, /input\[type="range"\]:disabled/);
});

test("checkbox and radio states are themed, keyboard-visible, and contrast-safe", () => {
  assert.match(css, /input\[type="checkbox"\][\s\S]*checkbox-off\.png/);
  assert.match(css, /input\[type="checkbox"\]:checked[\s\S]*checkbox-on\.png/);
  assert.match(css, /input\[type="checkbox"\]:indeterminate/);
  assert.match(css, /input\[type="radio"\]:checked[\s\S]*radial-gradient/);
  assert.match(css, /:where\(button, input, select, textarea\):focus-visible/);
  assert.match(css, /@media \(forced-colors: active\)/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
});

test("the shared native skin covers every current production form family", () => {
  assert.match(inventorySource, /<select/);
  assert.match(marketSource, /<select/);
  assert.match(marketSource, /<input[^>]*type="number"/);
  assert.match(css, /body\.game-viewport select/);
  assert.match(css, /input\[type="number"\]::-webkit-inner-spin-button/);
  assert.match(css, /input:not\(\[type\]\)/);
});
