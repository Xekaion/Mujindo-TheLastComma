import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { inflateSync } from "node:zlib";

const root = path.resolve(import.meta.dirname, "..");
const readSource = (relativePath) =>
  readFile(path.join(root, relativePath), "utf8");

const ATLAS_WIDTH = 4_096;
const ATLAS_HEIGHT = 256;
const FRAME_COLUMNS = 4;
const FRAME_ROWS = 2;
const FRAME_WIDTH = 1_024;
const FRAME_HEIGHT = 128;
const MAX_ASSET_BYTES = 3 * 1_024 * 1_024;

function decodeRgbaPng(png, relativePath) {
  assert.equal(
    png.subarray(0, 8).toString("hex"),
    "89504e470d0a1a0a",
    `${relativePath} must be a PNG`,
  );

  let offset = 8;
  let width = 0;
  let height = 0;
  const compressed = [];
  while (offset + 12 <= png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.subarray(offset + 4, offset + 8).toString("ascii");
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    assert.ok(dataEnd + 4 <= png.length, `${relativePath} has a truncated ${type} chunk`);
    if (type === "IHDR") {
      width = png.readUInt32BE(dataStart);
      height = png.readUInt32BE(dataStart + 4);
      assert.equal(png[dataStart + 8], 8, `${relativePath} must use 8-bit channels`);
      assert.equal(png[dataStart + 9], 6, `${relativePath} must be RGBA`);
      assert.equal(png[dataStart + 12], 0, `${relativePath} must not be interlaced`);
    } else if (type === "IDAT") {
      compressed.push(png.subarray(dataStart, dataEnd));
    }
    offset = dataEnd + 4;
    if (type === "IEND") break;
  }
  assert.ok(width > 0 && height > 0 && compressed.length > 0, `${relativePath} is incomplete`);

  const bytesPerPixel = 4;
  const stride = width * bytesPerPixel;
  const raw = inflateSync(Buffer.concat(compressed));
  assert.equal(raw.length, (stride + 1) * height, `${relativePath} has malformed scanlines`);
  const pixels = new Uint8Array(stride * height);
  const paeth = (left, above, upperLeft) => {
    const estimate = left + above - upperLeft;
    const leftDistance = Math.abs(estimate - left);
    const aboveDistance = Math.abs(estimate - above);
    const upperLeftDistance = Math.abs(estimate - upperLeft);
    if (leftDistance <= aboveDistance && leftDistance <= upperLeftDistance) return left;
    return aboveDistance <= upperLeftDistance ? above : upperLeft;
  };
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    assert.ok(filter >= 0 && filter <= 4, `${relativePath} uses PNG filter ${filter}`);
    const rawStart = y * (stride + 1) + 1;
    const outputStart = y * stride;
    for (let x = 0; x < stride; x += 1) {
      const encoded = raw[rawStart + x];
      const left = x >= bytesPerPixel ? pixels[outputStart + x - bytesPerPixel] : 0;
      const above = y > 0 ? pixels[outputStart + x - stride] : 0;
      const upperLeft = y > 0 && x >= bytesPerPixel
        ? pixels[outputStart + x - stride - bytesPerPixel]
        : 0;
      const predictor = filter === 0
        ? 0
        : filter === 1
          ? left
          : filter === 2
            ? above
            : filter === 3
              ? Math.floor((left + above) / 2)
              : paeth(left, above, upperLeft);
      pixels[outputStart + x] = (encoded + predictor) & 0xff;
    }
  }
  return { width, height, pixels };
}

function alphaAt(image, x, y) {
  return image.pixels[(y * image.width + x) * 4 + 3];
}

function frameBytes(image, column, row) {
  const bytes = Buffer.alloc(FRAME_WIDTH * FRAME_HEIGHT * 4);
  let visiblePixels = 0;
  for (let y = 0; y < FRAME_HEIGHT; y += 1) {
    for (let x = 0; x < FRAME_WIDTH; x += 1) {
      const sourceX = column * FRAME_WIDTH + x;
      const sourceY = row * FRAME_HEIGHT + y;
      const source = (sourceY * image.width + sourceX) * 4;
      const target = (y * FRAME_WIDTH + x) * 4;
      bytes[target] = image.pixels[source];
      bytes[target + 1] = image.pixels[source + 1];
      bytes[target + 2] = image.pixels[source + 2];
      bytes[target + 3] = image.pixels[source + 3];
      if (image.pixels[source + 3] > 0) visiblePixels += 1;
    }
  }
  return { bytes, visiblePixels };
}

function assertTransparentFrameEdges(image, column, row, label) {
  const left = column * FRAME_WIDTH;
  const right = left + FRAME_WIDTH - 1;
  const top = row * FRAME_HEIGHT;
  const bottom = top + FRAME_HEIGHT - 1;
  for (let x = left; x <= right; x += 1) {
    assert.equal(alphaAt(image, x, top), 0, `${label} touches its top crop edge at x=${x - left}`);
    assert.equal(alphaAt(image, x, bottom), 0, `${label} touches its bottom crop edge at x=${x - left}`);
  }
  for (let y = top; y <= bottom; y += 1) {
    assert.equal(alphaAt(image, left, y), 0, `${label} touches its left crop edge at y=${y - top}`);
    assert.equal(alphaAt(image, right, y), 0, `${label} touches its right crop edge at y=${y - top}`);
  }
}

function cssBlock(source, selectorOrAtRule, fromIndex = 0) {
  const start = source.indexOf(selectorOrAtRule, fromIndex);
  assert.ok(start >= 0, `missing CSS block ${selectorOrAtRule}`);
  const open = source.indexOf("{", start);
  assert.ok(open >= 0, `missing opening brace for ${selectorOrAtRule}`);
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, index);
    }
  }
  assert.fail(`missing closing brace for ${selectorOrAtRule}`);
}

test("mythic and cosmic world-announcement atlases retain eight unique padded RGBA frames", async () => {
  const tiers = ["mythic", "cosmic"];
  const assetHashes = new Set();

  for (const tier of tiers) {
    const relativePath = `public/assets/ui/world-announcement-${tier}-v1.png`;
    const png = await readFile(path.join(root, relativePath));
    assert.ok(png.length < MAX_ASSET_BYTES, `${relativePath} must remain below 3 MiB`);
    assetHashes.add(createHash("sha256").update(png).digest("hex"));

    const image = decodeRgbaPng(png, relativePath);
    assert.deepEqual(
      [image.width, image.height],
      [ATLAS_WIDTH, ATLAS_HEIGHT],
      `${relativePath} must be a 4x2 atlas of 1024x128 cells`,
    );

    const hashes = [];
    for (let row = 0; row < FRAME_ROWS; row += 1) {
      for (let column = 0; column < FRAME_COLUMNS; column += 1) {
        const label = `${tier} frame ${row * FRAME_COLUMNS + column}`;
        assertTransparentFrameEdges(image, column, row, label);
        const frame = frameBytes(image, column, row);
        assert.ok(frame.visiblePixels > 100, `${label} must not be blank`);
        hashes.push(createHash("sha256").update(frame.bytes).digest("hex"));
      }
    }
    assert.equal(new Set(hashes).size, 8, `${tier} must contain eight distinct animation frames`);
  }

  assert.equal(assetHashes.size, 2, "mythic and cosmic announcement art must not be identical");
});

test("world announcement component exposes accessible rarity art, localhost previews, and tracked timers", async () => {
  const source = await readSource("app/WorldAnnouncementBanner.tsx");

  assert.match(source, /role=["']status["']/);
  assert.match(source, /aria-live=["']polite["']/);
  assert.match(source, /aria-atomic=["']true["']/);
  assert.match(source, /world-announcement-mythic-v1\.png/);
  assert.match(source, /world-announcement-cosmic-v1\.png/);
  assert.match(source, /current\.rarity\s*===\s*["']cosmic["']/);
  assert.match(source, /["']신화 발견["']/);
  assert.match(source, /["']우주 발견["']/);

  assert.match(source, /window\.location\.hostname/);
  assert.match(source, /["']localhost["']/);
  assert.match(source, /["']127\.0\.0\.1["']/);
  assert.match(source, /\.get\(["']worldAnnouncement["']\)/);
  const previewReader = source.slice(
    source.indexOf("function readLocalPreviewAnnouncement"),
    source.indexOf("export default function WorldAnnouncementBanner"),
  );
  assert.match(previewReader, /rarity\s*!==\s*["']mythic["']/);
  assert.match(previewReader, /rarity\s*!==\s*["']cosmic["']/);

  const timeoutCalls = source.match(/(?:window\.)?setTimeout\s*\(/g) ?? [];
  const trackedTimeouts = [
    ...source.matchAll(/(\w+Ref)\.current\s*=\s*(?:window\.)?setTimeout\s*\(/g),
  ];
  const timerRefs = [...new Set(trackedTimeouts.map((match) => match[1]))];
  assert.ok(timeoutCalls.length >= 2, "display and inter-message gap need separate timers");
  assert.equal(
    trackedTimeouts.length,
    timeoutCalls.length,
    "every setTimeout call must store a cancellable handle",
  );
  assert.ok(timerRefs.length >= 2, "display and gap timers must not share one handle");
  const teardown = source.slice(source.lastIndexOf("return () =>"));
  for (const timerRef of timerRefs) {
    const directlyCleared = new RegExp(
      `(?:window\\.)?clearTimeout\\(\\s*${timerRef}\\.current\\s*\\)`,
    ).test(teardown);
    const helperCleared = new RegExp(`clearTimer\\(\\s*${timerRef}\\s*\\)`).test(source) &&
      /clearAllTimers\(\)/.test(teardown) &&
      /clearTimeout\(\s*timer\.current\s*\)/.test(source);
    assert.ok(directlyCleared || helperCleared, `${timerRef} must be cleared during teardown`);
  }
});

test("world announcement CSS keeps full-opacity top-layer atlas animation and motion-safe mobile text", async () => {
  const css = await readSource("app/globals.css");
  const bannerRule = cssBlock(css, ".world-announcement {");
  assert.match(bannerRule, /opacity:\s*1\b/);
  const zIndex = Number(bannerRule.match(/z-index:\s*(\d+)/)?.[1]);
  assert.ok(Number.isFinite(zIndex) && zIndex > 400, `world banner z-index must exceed 400, got ${zIndex}`);

  assert.match(css, /world-announcement-mythic-v1\.png/);
  const cosmicRule = cssBlock(css, ".world-announcement.is-cosmic {");
  assert.match(cosmicRule, /world-announcement-cosmic-v1\.png/);
  assert.match(
    css,
    /\.world-announcement\.is-mythic\s+\.world-announcement-art\s*\{[\s\S]{0,220}?animation:\s*world-announcement-atlas/,
  );
  assert.match(
    css,
    /\.world-announcement\.is-cosmic\s+\.world-announcement-art\s*\{[\s\S]{0,220}?animation:\s*world-announcement-atlas/,
  );
  const atlasRule = cssBlock(css, ".world-announcement-art {");
  assert.match(atlasRule, /background-size:\s*400%\s+200%/);
  const atlasKeyframes = cssBlock(css, "@keyframes world-announcement-atlas");
  assert.ok(
    (atlasKeyframes.match(/background-position:/g) ?? []).length >= 8,
    "the 4x2 atlas animation must address all eight frames",
  );

  const reducedMotion = cssBlock(css, "@media (prefers-reduced-motion: reduce)");
  assert.match(reducedMotion, /world-announcement/);
  assert.match(reducedMotion, /world-announcement-art/);
  assert.match(reducedMotion, /animation(?:-play-state)?:\s*(?:none|paused)(?:\s*!important)?/);

  const mobile = cssBlock(css, "@media (max-width: 700px)");
  const mobileCopy = cssBlock(mobile, ".world-announcement p");
  const pixelSizes = [...mobileCopy.matchAll(/font-size:[^;]*?(\d+(?:\.\d+)?)px/g)].map(
    (match) => Number(match[1]),
  );
  assert.ok(pixelSizes.length > 0, "mobile announcement copy needs an explicit pixel readability floor");
  assert.ok(
    pixelSizes.every((size) => size >= 13),
    `mobile announcement copy must remain at least 13px, got ${pixelSizes.join(", ")}`,
  );
});

test("the market page participates in world announcements", async () => {
  const source = await readSource("app/market/page.tsx");
  assert.match(source, /import\s+WorldAnnouncementBanner\s+from\s+["']\.\.\/WorldAnnouncementBanner["']/);
  assert.match(source, /<WorldAnnouncementBanner\s+suggestedName=\{user\?\.displayName\s*\?\?\s*null\}\s*\/>/);
  assert.match(source, /<MarketBoard\s+suggestedName=\{user\?\.displayName\s*\?\?\s*null\}\s*\/>/);
});
