import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { inflateSync } from "node:zlib";
import ts from "typescript";

const root = process.cwd();
const paperdollRigManifest = JSON.parse(
  await readFile(path.join(root, "app/paperdoll-rig-manifest.json"), "utf8"),
);

function decodeRgbaPng(png, relativePath) {
  assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a", relativePath);
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
  const raw = inflateSync(Buffer.concat(compressed));
  const bytesPerPixel = 4;
  const stride = width * bytesPerPixel;
  assert.equal(raw.length, (stride + 1) * height, `${relativePath} has unexpected scanline data`);
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
    assert.ok(filter >= 0 && filter <= 4, `${relativePath} uses unknown PNG filter ${filter}`);
    const rawStart = y * (stride + 1) + 1;
    const outputStart = y * stride;
    for (let x = 0; x < stride; x += 1) {
      const encoded = raw[rawStart + x];
      const left = x >= bytesPerPixel ? pixels[outputStart + x - bytesPerPixel] : 0;
      const above = y > 0 ? pixels[outputStart + x - stride] : 0;
      const upperLeft = y > 0 && x >= bytesPerPixel
        ? pixels[outputStart + x - stride - bytesPerPixel]
        : 0;
      const predictor =
        filter === 0
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

test("automatic salvage is slot-scoped, chase-rarity safe, and precedes backpack capacity", async () => {
  const [autoSalvage, source, overlay] = await Promise.all([
    importTypeScriptModule("app/auto-salvage.ts"),
    readFile(path.join(root, "app/GameCanvas.tsx"), "utf8"),
    readFile(path.join(root, "app/InventoryOverlay.tsx"), "utf8"),
  ]);

  assert.deepEqual(autoSalvage.AUTO_SALVAGE_RARITIES, [
    "common",
    "magic",
    "superior",
    "rare",
    "epic",
  ]);
  for (const rarity of ["common", "magic", "superior", "rare"]) {
    assert.equal(autoSalvage.shouldAutoSalvageRarity(rarity, "rare"), true);
  }
  for (const rarity of ["epic", "legendary", "mythic", "cosmic"]) {
    assert.equal(autoSalvage.shouldAutoSalvageRarity(rarity, "rare"), false);
  }
  assert.equal(autoSalvage.shouldAutoSalvageRarity("legendary", "epic"), false);
  assert.equal(autoSalvage.normalizeAutoSalvageThreshold("legendary"), null);
  assert.equal(autoSalvage.normalizeAutoSalvageThreshold("invalid"), null);

  const storage = new MemoryStorage();
  assert.equal(autoSalvage.readAutoSalvagePreference(1, storage), undefined);
  assert.equal(autoSalvage.writeAutoSalvagePreference(1, "rare", storage), true);
  assert.equal(autoSalvage.writeAutoSalvagePreference(2, null, storage), true);
  assert.equal(autoSalvage.readAutoSalvagePreference(1, storage), "rare");
  assert.equal(autoSalvage.readAutoSalvagePreference(2, storage), null);
  assert.equal(autoSalvage.readAutoSalvagePreference(3, storage), undefined);
  assert.throws(() => autoSalvage.autoSalvagePreferenceKey(4), RangeError);

  const pickupMarker = source.indexOf("const collectedGear = new Set<number>()");
  const pickupStart = source.indexOf("for (const drop of world.gearDrops)", pickupMarker);
  const pickupEnd = source.indexOf("if (collectedGear.size > 0)", pickupStart);
  assert.ok(pickupMarker >= 0 && pickupStart > pickupMarker && pickupEnd > pickupStart);
  const pickupLoop = source.slice(pickupStart, pickupEnd);
  assert.ok(
    pickupLoop.indexOf("shouldAutoSalvageRarity") <
      pickupLoop.indexOf("player.inventory.length >= inventoryCapacityRef.current"),
    "automatic salvage must happen before the full-backpack guard",
  );
  assert.match(
    pickupLoop,
    /getGearSalvageAshBreakdown\(drop\.item\)[\s\S]{0,180}?player\.memoryAsh \+= ashBreakdown\.total[\s\S]{0,220}?collectedGear\.add\(drop\.id\)[\s\S]{0,80}?continue;/,
    "auto salvage must share the canonical ash formula and consume only the ground drop",
  );
  assert.match(source, /autoSalvagedGearCount[\s\S]{0,600}?자동 분해/);
  assert.match(source, /data-auto-salvage=\{hud\.player\.autoSalvageMaxRarity \?\? "off"\}/);
  assert.match(
    source,
    /storedAutoSalvagePreference === undefined[\s\S]{0,180}?normalizeAutoSalvageThreshold\(data\.player\.autoSalvageMaxRarity\)/,
    "save hydration must prefer the immediate slot preference and migrate an older saved field",
  );
  assert.match(source, /writeAutoSalvagePreference\(\s*activeSaveSlotRef\.current,/);
  assert.match(overlay, /autoSalvageMaxRarity:\s*AutoSalvageThreshold;/);
  assert.match(overlay, /aria-label="새 장비 자동 분해 등급 기준"/);
  assert.match(overlay, /AUTO_SALVAGE_RARITIES\.map\(\(rarity\) =>/);
  assert.match(overlay, /새 장비만 · 전설 이상 보호/);
});

test("rarity salvage filters toggle exact grades while preserving confirmation and rarity effects", async () => {
  const [autoSalvage, overlay, css] = await Promise.all([
    importTypeScriptModule("app/auto-salvage.ts"),
    readFile(path.join(root, "app/InventoryOverlay.tsx"), "utf8"),
    readFile(path.join(root, "app/game.css"), "utf8"),
  ]);
  const inventory = [
    { id: "common-a", rarity: "common" },
    { id: "common-b", rarity: "common" },
    { id: "epic-a", rarity: "epic" },
    { id: "legendary-a", rarity: "legendary" },
  ];
  const partial = new Set(["common-a", "legendary-a"]);
  const allCommon = autoSalvage.toggleRaritySalvageSelection(
    inventory,
    partial,
    "common",
  );
  assert.deepEqual([...allCommon].sort(), ["common-a", "common-b", "legendary-a"]);
  const clearedCommon = autoSalvage.toggleRaritySalvageSelection(
    inventory,
    allCommon,
    "common",
  );
  assert.deepEqual([...clearedCommon], ["legendary-a"]);
  const allLegendary = autoSalvage.toggleRaritySalvageSelection(
    inventory,
    clearedCommon,
    "legendary",
  );
  assert.deepEqual([...allLegendary], []);

  assert.match(overlay, /role="group"\s*aria-label="등급별 일괄 분해 선택"/);
  assert.match(overlay, /GEAR_RARITIES\.map\(\(rarity\) =>/);
  assert.match(overlay, /selectionState === "mixed"\s*\? "mixed"/);
  assert.match(overlay, /onClick=\{\(\) => toggleRarityForSalvage\(rarity\)\}/);
  assert.match(overlay, /disabled=\{selectedSalvageItems\.length === 0\}/);
  assert.doesNotMatch(overlay, /type="checkbox"/);
  assert.match(overlay, /onClick=\{requestSalvageMany\}/);
  assert.match(overlay, /role="alertdialog"/);
  assert.match(css, /\.inventory-screen-rarity-salvage-filters\s*\{[\s\S]{0,260}?grid-template-columns:\s*repeat\(8,/);
  assert.match(css, /\.inventory-screen-rarity-salvage-filter\.is-all\s*\{/);
  assert.match(css, /\.inventory-screen-rarity-salvage-filter\.is-mixed\s*\{/);
  assert.match(css, /\.inventory-screen-grid-cell--salvage-mode \.inventory-screen-rarity-aura\s*\{[^}]*animation-play-state:\s*running;/);
});

test("boss rooms use a generated transparent emblem in both minimap scales", async () => {
  const assetPath = "public/assets/ui/boss-room-emblem-v1.png";
  const [source, css, png] = await Promise.all([
    readFile(path.join(root, "app/GameCanvas.tsx"), "utf8"),
    readFile(path.join(root, "app/game.css"), "utf8"),
    readFile(path.join(root, assetPath)),
  ]);
  const image = decodeRgbaPng(png, assetPath);
  assert.deepEqual([image.width, image.height], [256, 256]);

  let opaquePixels = 0;
  let minimumX = image.width;
  let minimumY = image.height;
  let maximumX = -1;
  let maximumY = -1;
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      const alpha = image.pixels[(y * image.width + x) * 4 + 3];
      if (alpha <= 16) continue;
      opaquePixels += 1;
      minimumX = Math.min(minimumX, x);
      minimumY = Math.min(minimumY, y);
      maximumX = Math.max(maximumX, x);
      maximumY = Math.max(maximumY, y);
    }
  }
  assert.ok(opaquePixels > 4_000, "the boss emblem must remain visible when downscaled");
  assert.ok(minimumX >= 8 && minimumY >= 8, "the emblem needs safe padding on its top and left");
  assert.ok(maximumX <= 247 && maximumY <= 247, "the emblem needs safe padding on its bottom and right");
  for (const [x, y] of [[0, 0], [255, 0], [0, 255], [255, 255]]) {
    assert.equal(image.pixels[(y * image.width + x) * 4 + 3], 0);
  }

  assert.equal((source.match(/room\?\.kind === "boss"/g) ?? []).length, 1);
  assert.equal(
    (source.match(/\{cellVisual\}/g) ?? []).length,
    2,
    "both the compact minimap and full atlas must reuse the same boss emblem node",
  );
  assert.match(source, /className="map-room-emblem map-room-emblem--boss"/);
  assert.match(source, /className="map-cell-node" aria-hidden="true"/);
  assert.match(css, /\.map-room-emblem\s*\{[^}]*pointer-events:\s*none;/);
  assert.match(css, /\.map-room-emblem--boss\s*\{[^}]*boss-room-emblem-v1\.png/);
  assert.match(css, /\.minimap-grid\.is-large \.map-room-emblem--boss\s*\{/);
  assert.match(css, /\.map-legend \.legend-boss\s*\{[^}]*boss-room-emblem-v1\.png/);
});

function assertAlphaCellGutter(image, column, row, columns, rows, label) {
  assert.equal(image.width % columns, 0, `${label} atlas width must divide evenly`);
  assert.equal(image.height % rows, 0, `${label} atlas height must divide evenly`);
  const cellWidth = image.width / columns;
  const cellHeight = image.height / rows;
  const left = column * cellWidth;
  const top = row * cellHeight;
  let opaquePixels = 0;
  let minimumX = left + cellWidth;
  let maximumX = left - 1;
  let minimumY = top + cellHeight;
  let maximumY = top - 1;
  for (let y = top; y < top + cellHeight; y += 1) {
    for (let x = left; x < left + cellWidth; x += 1) {
      if (image.pixels[(y * image.width + x) * 4 + 3] === 0) continue;
      opaquePixels += 1;
      minimumX = Math.min(minimumX, x);
      maximumX = Math.max(maximumX, x);
      minimumY = Math.min(minimumY, y);
      maximumY = Math.max(maximumY, y);
    }
  }
  assert.ok(opaquePixels >= 100, `${label} is effectively empty (${opaquePixels} alpha pixels)`);
  assert.ok(minimumX > left, `${label} touches its left cell boundary`);
  assert.ok(maximumX < left + cellWidth - 1, `${label} touches its right cell boundary`);
  assert.ok(minimumY > top, `${label} touches its top cell boundary`);
  assert.ok(maximumY < top + cellHeight - 1, `${label} touches its bottom cell boundary`);
}

function alphaCellMetrics(image, column, row, columns, rows, label) {
  assert.equal(image.width % columns, 0, `${label} atlas width must divide evenly`);
  assert.equal(image.height % rows, 0, `${label} atlas height must divide evenly`);
  const cellWidth = image.width / columns;
  const cellHeight = image.height / rows;
  const left = column * cellWidth;
  const top = row * cellHeight;
  let opaquePixels = 0;
  let minimumX = left + cellWidth;
  let maximumX = left - 1;
  let minimumY = top + cellHeight;
  let maximumY = top - 1;
  for (let y = top; y < top + cellHeight; y += 1) {
    for (let x = left; x < left + cellWidth; x += 1) {
      if (image.pixels[(y * image.width + x) * 4 + 3] === 0) continue;
      opaquePixels += 1;
      minimumX = Math.min(minimumX, x);
      maximumX = Math.max(maximumX, x);
      minimumY = Math.min(minimumY, y);
      maximumY = Math.max(maximumY, y);
    }
  }
  assert.ok(opaquePixels >= 100, `${label} is effectively empty (${opaquePixels} alpha pixels)`);
  return {
    opaquePixels,
    width: maximumX - minimumX + 1,
    height: maximumY - minimumY + 1,
    centerX: (minimumX + maximumX) / 2 - left,
    centerY: (minimumY + maximumY) / 2 - top,
    cellWidth,
    cellHeight,
    left: minimumX - left,
    right: left + cellWidth - 1 - maximumX,
    top: minimumY - top,
    bottom: top + cellHeight - 1 - maximumY,
  };
}

function rgbaCellBuffer(image, column, row, columns, rows, label) {
  assert.equal(image.width % columns, 0, `${label} atlas width must divide evenly`);
  assert.equal(image.height % rows, 0, `${label} atlas height must divide evenly`);
  const cellWidth = image.width / columns;
  const cellHeight = image.height / rows;
  const output = Buffer.alloc(cellWidth * cellHeight * 4);
  let outputOffset = 0;
  for (let y = row * cellHeight; y < (row + 1) * cellHeight; y += 1) {
    const sourceOffset = (y * image.width + column * cellWidth) * 4;
    output.set(
      image.pixels.subarray(sourceOffset, sourceOffset + cellWidth * 4),
      outputOffset,
    );
    outputOffset += cellWidth * 4;
  }
  return output;
}

function centreClearComponentMetrics(image, column, row, columns, rows, label, threshold = 8) {
  assert.equal(image.width % columns, 0, `${label} atlas width must divide evenly`);
  assert.equal(image.height % rows, 0, `${label} atlas height must divide evenly`);
  const cellWidth = image.width / columns;
  const cellHeight = image.height / rows;
  const cellLeft = column * cellWidth;
  const cellTop = row * cellHeight;
  const centreX = Math.floor(cellWidth / 2);
  const centreY = Math.floor(cellHeight / 2);
  const alphaAt = (x, y) =>
    image.pixels[((cellTop + y) * image.width + cellLeft + x) * 4 + 3];
  assert.ok(alphaAt(centreX, centreY) <= threshold, `${label} centre is not transparent`);

  const visited = new Uint8Array(cellWidth * cellHeight);
  const queueX = new Int16Array(cellWidth * cellHeight);
  const queueY = new Int16Array(cellWidth * cellHeight);
  let head = 0;
  let tail = 1;
  queueX[0] = centreX;
  queueY[0] = centreY;
  visited[centreY * cellWidth + centreX] = 1;
  let minimumX = centreX;
  let maximumX = centreX;
  let minimumY = centreY;
  let maximumY = centreY;
  while (head < tail) {
    const x = queueX[head];
    const y = queueY[head];
    head += 1;
    for (const [nextX, nextY] of [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]]) {
      if (nextX < 0 || nextX >= cellWidth || nextY < 0 || nextY >= cellHeight) continue;
      const index = nextY * cellWidth + nextX;
      if (visited[index] || alphaAt(nextX, nextY) > threshold) continue;
      visited[index] = 1;
      queueX[tail] = nextX;
      queueY[tail] = nextY;
      tail += 1;
      minimumX = Math.min(minimumX, nextX);
      maximumX = Math.max(maximumX, nextX);
      minimumY = Math.min(minimumY, nextY);
      maximumY = Math.max(maximumY, nextY);
    }
  }
  assert.ok(tail >= 100, `${label} centre clear component is unexpectedly small`);
  return {
    left: minimumX,
    top: minimumY,
    right: maximumX + 1,
    bottom: maximumY + 1,
    width: maximumX - minimumX + 1,
    height: maximumY - minimumY + 1,
    centerX: (minimumX + maximumX) / 2,
    centerY: (minimumY + maximumY) / 2,
    pixels: tail,
  };
}

function rgbToHsv(red, green, blue) {
  const maximum = Math.max(red, green, blue) / 255;
  const minimum = Math.min(red, green, blue) / 255;
  const delta = maximum - minimum;
  let hue = 0;
  if (delta > 0) {
    if (maximum === red / 255) hue = ((green - blue) / 255 / delta) % 6;
    else if (maximum === green / 255) hue = (blue - red) / 255 / delta + 2;
    else hue = (red - green) / 255 / delta + 4;
    hue *= 60;
    if (hue < 0) hue += 360;
  }
  return {
    hue,
    saturation: maximum === 0 ? 0 : delta / maximum,
    value: maximum,
  };
}

function persistentPillarFrameMetrics(image, column, label) {
  const frame = rgbaCellBuffer(image, column, 0, 4, 1, label);
  const colourHistogram = new Map();
  let visiblePixels = 0;
  let brightPixels = 0;
  let nearClipPixels = 0;
  let whitePixels = 0;
  let goldPixels = 0;
  let cyanPixels = 0;

  for (let offset = 0; offset < frame.length; offset += 4) {
    const red = frame[offset];
    const green = frame[offset + 1];
    const blue = frame[offset + 2];
    const alpha = frame[offset + 3];
    if (alpha < 64) continue;
    visiblePixels += 1;
    const key = (red << 16) | (green << 8) | blue;
    colourHistogram.set(key, (colourHistogram.get(key) ?? 0) + 1);
    const luminance = red * 0.299 + green * 0.587 + blue * 0.114;
    if (luminance >= 205) brightPixels += 1;
    if (red >= 250 && green >= 250 && blue >= 250) nearClipPixels += 1;

    const { hue, saturation, value } = rgbToHsv(red, green, blue);
    if (saturation <= 0.18 && value >= 0.78) whitePixels += 1;
    else if (hue >= 30 && hue <= 65 && saturation >= 0.4 && value >= 0.35) {
      goldPixels += 1;
    } else if (
      hue >= 165 &&
      hue <= 205 &&
      saturation >= 0.3 &&
      value >= 0.35
    ) {
      cyanPixels += 1;
    }
  }

  assert.ok(visiblePixels > 0, `${label} has no visible pixels`);
  const counts = [...colourHistogram.values()].sort((left, right) => right - left);
  const entropy = counts.reduce((sum, count) => {
    const probability = count / visiblePixels;
    return sum - probability * Math.log2(probability);
  }, 0);
  const ratio = (count) => count / visiblePixels;
  return {
    rgba: frame,
    sha256: createHash("sha256").update(frame).digest("hex"),
    visiblePixels,
    uniqueVisibleRgb: colourHistogram.size,
    entropy,
    effectiveColourCount: 2 ** entropy,
    dominantColourRatio: ratio(counts[0] ?? 0),
    topTwoColourRatio: ratio((counts[0] ?? 0) + (counts[1] ?? 0)),
    brightPixelRatio: ratio(brightPixels),
    nearClipPixelRatio: ratio(nearClipPixels),
    whitePixelRatio: ratio(whitePixels),
    goldPixelRatio: ratio(goldPixels),
    cyanPixelRatio: ratio(cyanPixels),
    otherPixelRatio: ratio(visiblePixels - whitePixels - goldPixels - cyanPixels),
  };
}

function rgbaTemporalMetrics(leftFrame, rightFrame, alphaThreshold = 64) {
  assert.equal(leftFrame.length, rightFrame.length);
  let unionPixels = 0;
  let intersectionPixels = 0;
  let changedPixels = 0;
  for (let offset = 0; offset < leftFrame.length; offset += 4) {
    const leftVisible = leftFrame[offset + 3] >= alphaThreshold;
    const rightVisible = rightFrame[offset + 3] >= alphaThreshold;
    if (!leftVisible && !rightVisible) continue;
    unionPixels += 1;
    if (leftVisible && rightVisible) intersectionPixels += 1;
    if (
      Math.abs(leftFrame[offset] - rightFrame[offset]) >= 16 ||
      Math.abs(leftFrame[offset + 1] - rightFrame[offset + 1]) >= 16 ||
      Math.abs(leftFrame[offset + 2] - rightFrame[offset + 2]) >= 16 ||
      Math.abs(leftFrame[offset + 3] - rightFrame[offset + 3]) >= 16
    ) {
      changedPixels += 1;
    }
  }
  return {
    alphaSupportIou: unionPixels === 0 ? 0 : intersectionPixels / unionPixels,
    changedPixelRatio: unionPixels === 0 ? 0 : changedPixels / unionPixels,
  };
}

function countGreenChromaPixels(image) {
  let chromaPixels = 0;
  for (let index = 0; index < image.pixels.length; index += 4) {
    const red = image.pixels[index];
    const green = image.pixels[index + 1];
    const blue = image.pixels[index + 2];
    const alpha = image.pixels[index + 3];
    if (alpha > 8 && green > red + 65 && green > blue + 65 && green > 110) {
      chromaPixels += 1;
    }
  }
  return chromaPixels;
}

function alphaCellComponents(image, column, row, columns, rows, alphaThreshold = 42) {
  const cellWidth = image.width / columns;
  const cellHeight = image.height / rows;
  const cellLeft = column * cellWidth;
  const cellTop = row * cellHeight;
  const visited = new Uint8Array(cellWidth * cellHeight);
  const components = [];

  for (let startY = 0; startY < cellHeight; startY += 1) {
    for (let startX = 0; startX < cellWidth; startX += 1) {
      const startIndex = startY * cellWidth + startX;
      const startAlpha = image.pixels[
        ((cellTop + startY) * image.width + cellLeft + startX) * 4 + 3
      ];
      if (visited[startIndex] || startAlpha < alphaThreshold) continue;

      const stack = [startIndex];
      visited[startIndex] = 1;
      let count = 0;
      while (stack.length > 0) {
        const index = stack.pop();
        const x = index % cellWidth;
        const y = Math.floor(index / cellWidth);
        count += 1;
        for (let nextY = Math.max(0, y - 1); nextY <= Math.min(cellHeight - 1, y + 1); nextY += 1) {
          for (let nextX = Math.max(0, x - 1); nextX <= Math.min(cellWidth - 1, x + 1); nextX += 1) {
            const nextIndex = nextY * cellWidth + nextX;
            if (visited[nextIndex]) continue;
            const alpha = image.pixels[
              ((cellTop + nextY) * image.width + cellLeft + nextX) * 4 + 3
            ];
            if (alpha < alphaThreshold) continue;
            visited[nextIndex] = 1;
            stack.push(nextIndex);
          }
        }
      }
      if (count >= 24) components.push(count);
    }
  }
  return components.sort((left, right) => right - left);
}

function readUInt24LE(buffer, offset) {
  return buffer[offset] | (buffer[offset + 1] << 8) | (buffer[offset + 2] << 16);
}

function assertWebPIntegrity(webp, relativePath) {
  assert.ok(webp.length >= 100 * 1024, `${relativePath} is unexpectedly small`);
  assert.ok(webp.length <= 2 * 1024 * 1024, `${relativePath} is not web-optimized`);
  assert.equal(webp.subarray(0, 4).toString("ascii"), "RIFF", relativePath);
  assert.equal(webp.subarray(8, 12).toString("ascii"), "WEBP", relativePath);
  assert.equal(webp.readUInt32LE(4) + 8, webp.length, `${relativePath} has a truncated RIFF container`);

  let offset = 12;
  let dimensions = null;
  while (offset + 8 <= webp.length) {
    const chunkType = webp.subarray(offset, offset + 4).toString("ascii");
    const chunkSize = webp.readUInt32LE(offset + 4);
    const dataOffset = offset + 8;
    const dataEnd = dataOffset + chunkSize;
    assert.ok(dataEnd <= webp.length, `${relativePath} has a truncated ${chunkType} chunk`);

    if (chunkType === "VP8X" && chunkSize >= 10) {
      dimensions = [
        readUInt24LE(webp, dataOffset + 4) + 1,
        readUInt24LE(webp, dataOffset + 7) + 1,
      ];
    } else if (chunkType === "VP8 " && chunkSize >= 10) {
      assert.equal(
        webp.subarray(dataOffset + 3, dataOffset + 6).toString("hex"),
        "9d012a",
        `${relativePath} has an invalid VP8 keyframe`,
      );
      dimensions = [
        webp.readUInt16LE(dataOffset + 6) & 0x3fff,
        webp.readUInt16LE(dataOffset + 8) & 0x3fff,
      ];
    } else if (chunkType === "VP8L" && chunkSize >= 5) {
      assert.equal(webp[dataOffset], 0x2f, `${relativePath} has an invalid VP8L signature`);
      const sizeBits = webp.readUInt32LE(dataOffset + 1);
      dimensions = [(sizeBits & 0x3fff) + 1, ((sizeBits >>> 14) & 0x3fff) + 1];
    }

    offset = dataEnd + (chunkSize % 2);
  }

  assert.equal(offset, webp.length, `${relativePath} has malformed chunk padding`);
  assert.ok(dimensions, `${relativePath} is missing a WebP image chunk`);
  return dimensions;
}

async function typeScriptModuleUrl(relativePath, dependencyUrls = {}) {
  let source = await readFile(path.join(root, relativePath), "utf8");
  for (const [specifier, dependencyUrl] of Object.entries(dependencyUrls)) {
    source = source
      .replaceAll(`"${specifier}"`, `"${dependencyUrl}"`)
      .replaceAll(`'${specifier}'`, `'${dependencyUrl}'`);
  }
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: relativePath,
  }).outputText;
  return `data:text/javascript;base64,${Buffer.from(output).toString("base64")}`;
}

async function importTypeScriptModule(relativePath, dependencyUrls = {}) {
  return import(await typeScriptModuleUrl(relativePath, dependencyUrls));
}

class MemoryStorage {
  #items = new Map();

  get length() {
    return this.#items.size;
  }

  key(index) {
    return [...this.#items.keys()][index] ?? null;
  }

  getItem(key) {
    return this.#items.has(key) ? this.#items.get(key) : null;
  }

  setItem(key, value) {
    this.#items.set(key, String(value));
  }

  removeItem(key) {
    this.#items.delete(key);
  }
}

async function jsonDefaultModuleUrl(relativePath) {
  const value = JSON.parse(await readFile(path.join(root, relativePath), "utf8"));
  return `data:text/javascript;base64,${Buffer.from(
    `export default ${JSON.stringify(value)};`,
  ).toString("base64")}`;
}

class WriteRejectingStorage extends MemoryStorage {
  rejectWrites = false;

  setItem(key, value) {
    if (this.rejectWrites) throw new Error("storage write rejected");
    super.setItem(key, value);
  }
}

class VerificationMismatchStorage extends MemoryStorage {
  #mismatchedKeys = new Set();
  #protectedKey;

  mismatchNewKeys = false;

  constructor(protectedKey) {
    super();
    this.#protectedKey = protectedKey;
  }

  setItem(key, value) {
    super.setItem(key, value);
    if (this.mismatchNewKeys && key !== this.#protectedKey) {
      this.#mismatchedKeys.add(key);
    }
  }

  getItem(key) {
    const value = super.getItem(key);
    return value !== null && this.#mismatchedKeys.has(key)
      ? `${value}\u0000verification-mismatch`
      : value;
  }
}

function storageSnapshot(storage) {
  const entries = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (key !== null) entries.push([key, storage.getItem(key)]);
  }
  return entries.sort(([left], [right]) => left.localeCompare(right));
}

const sampleSave = {
  savedAt: 1_753_000_000_000,
  expeditionPowerRatingVersion: 2,
  player: {
    level: 12,
    rooms: 27,
    augments: { fang: 20, haste: 7 },
    profession: "fang",
  },
  world: {
    seed: 42,
    dungeonFloor: 6,
    roomX: 5,
    roomY: 0,
    rooms: { "5,0": { kind: "shelter", cleared: true } },
    visited: ["5,0"],
  },
  stableAugments: { fang: 20, haste: 7 },
};

test("save slots preserve and validate the expedition power formula version", async () => {
  const saves = await importTypeScriptModule("app/save-slots.ts");
  const storage = new MemoryStorage();
  assert.equal(saves.writeSaveSlot(1, structuredClone(sampleSave), storage), true);
  assert.equal(saves.readSaveSlot(1, storage).expeditionPowerRatingVersion, 2);

  const legacy = structuredClone(sampleSave);
  delete legacy.expeditionPowerRatingVersion;
  assert.equal(saves.writeSaveSlot(2, legacy, storage), true);
  assert.equal(saves.readSaveSlot(2, storage).expeditionPowerRatingVersion, undefined);

  for (const invalidVersion of [0, -1, 1.5, "2"]) {
    const malformed = structuredClone(sampleSave);
    malformed.expeditionPowerRatingVersion = invalidVersion;
    assert.equal(saves.writeSaveSlot(3, malformed, storage), false);
  }
});

test("20-stack professions unlock across the fifty-augment catalog", async () => {
  const professions = await importTypeScriptModule("app/professions.ts");
  assert.equal(professions.PROFESSION_THRESHOLD, 20);
  assert.equal(Object.keys(professions.PROFESSION_TITLES).length, 50);
  assert.equal(professions.isProfessionEligible({ fang: 19 }, "fang"), false);
  assert.equal(professions.isProfessionEligible({ fang: 20 }, "fang"), true);
  assert.equal(professions.effectiveAugmentRank({ fang: 20 }, "fang", "fang"), 30);
  assert.equal(professions.effectiveAugmentRank({ fang: 20 }, "haste", "fang"), 20);
  assert.equal(
    professions.effectiveAugmentRank({ fang: 21 }, "fang", "fang"),
    30,
    "legacy over-cap ranks must not create more than the capped profession effect",
  );
});

test("profession confirmation stays paused for one guarded cinematic before resuming", async () => {
  const [source, css] = await Promise.all([
    readFile(path.join(root, "app/GameCanvas.tsx"), "utf8"),
    readFile(path.join(root, "app/game.css"), "utf8"),
  ]);
  const confirmStart = source.indexOf("const confirmProfession = useCallback");
  const ceremonyEffectStart = source.indexOf("useEffect(() => {", confirmStart);
  const chooseStart = source.indexOf("const chooseAugment = useCallback", ceremonyEffectStart);
  assert.ok(confirmStart >= 0 && ceremonyEffectStart > confirmStart && chooseStart > ceremonyEffectStart);
  const confirmation = source.slice(confirmStart, ceremonyEffectStart);
  const ceremonyEffect = source.slice(ceremonyEffectStart, chooseStart);
  const completionStart = ceremonyEffect.indexOf("const completionTimer");
  const completionEnd = ceremonyEffect.indexOf("}, completionDelay)", completionStart);
  assert.ok(completionStart >= 0 && completionEnd > completionStart);
  const completion = ceremonyEffect.slice(completionStart, completionEnd);

  assert.match(confirmation, /professionCeremonyActiveRef\.current/);
  assert.match(confirmation, /!professionCeremonyReady/);
  assert.match(confirmation, /setProfessionCeremony\(\{/);
  assert.ok(
    confirmation.indexOf("player.profession = professionCandidate.id") <
      confirmation.indexOf("setProfessionCeremony({"),
    "the profession must be applied before its cinematic snapshot is shown",
  );
  assert.match(confirmation, /reducedMotion \? "enhanceSuccess" : "professionAscend"/);
  assert.doesNotMatch(confirmation, /setProfessionCandidate\(null\)/);
  assert.doesNotMatch(confirmation, /professionResumeRef\.current\(\)/);
  assert.doesNotMatch(confirmation, /\bresume\(\);/);
  assert.match(ceremonyEffect, /PROFESSION_CEREMONY_DURATION_MS/);
  assert.match(ceremonyEffect, /prefers-reduced-motion: reduce/);
  assert.match(ceremonyEffect, /requestAnimationFrame\(\(\) => \{[\s\S]{0,100}?professionCeremonyDialogRef\.current\?\.focus\(\{ preventScroll: true \}\)/);
  assert.match(ceremonyEffect, /cancelAnimationFrame\(focusFrame\)/);
  assert.match(ceremonyEffect, /impactTimer !== null\) window\.clearTimeout\(impactTimer\)/);
  assert.match(ceremonyEffect, /window\.clearTimeout\(completionTimer\)/);
  assert.doesNotMatch(ceremonyEffect.slice(ceremonyEffect.indexOf("return () =>")), /professionCeremonyActiveRef\.current = false/);
  assert.match(completion, /professionCeremonyActiveRef\.current = false/);
  assert.match(completion, /setProfessionCeremony\(null\)[\s\S]{0,90}?setProfessionCandidate\(null\)/);
  assert.ok(
    completion.indexOf("setProfessionCandidate(null)") <
      completion.indexOf("professionResumeRef.current = () => undefined") &&
      completion.indexOf("professionResumeRef.current = () => undefined") <
      completion.indexOf("resume();"),
    "completion must clear state, consume the callback, and then resume exactly once",
  );
  assert.equal((ceremonyEffect.match(/\bresume\(\);/g) ?? []).length, 1);
  assert.match(source, /professionCeremonyActiveRef\.current \|\|[\s\S]{0,120}?isProfessionEligible/);
  assert.match(source, /if \(professionCeremonyActiveRef\.current\) \{[\s\S]{0,100}?event\.preventDefault\(\);[\s\S]{0,100}?event\.stopPropagation\(\);/);
  assert.match(
    source,
    /if \(!professionCeremonyActiveRef\.current\) \{\s*const simulationRunning = isSimulationRunning\(\);/,
    "the guarded cinematic must bypass the continuous simulation and render branch",
  );
  assert.match(source, /mode === "profession" && professionCandidate && !professionCeremony/);
  assert.match(source, /className="profession-ceremony"[\s\S]{0,180}?role="dialog"[\s\S]{0,120}?aria-modal="true"/);
  assert.match(source, /ref=\{professionCeremonyDialogRef\}[\s\S]{0,220}?aria-describedby="profession-ceremony-result"[\s\S]{0,80}?tabIndex=\{-1\}/);
  assert.match(source, /className="profession-ceremony-visuals" aria-hidden="true"/);
  assert.match(source, /className="profession-ceremony-revelation" aria-live="assertive"/);
  assert.match(source, /data-audio-cue="none"[\s\S]{0,220}?onClick=\{confirmProfession\}/);
  assert.match(source, /disabled=\{!professionCeremonyReady\}[\s\S]{0,80}?aria-busy=\{!professionCeremonyReady\}/);
  assert.match(source, /PROFESSION_CEREMONY_PARTICLES = Array\.from\(\{ length: 24 \}/);
  assert.match(source, /"--profession-ceremony-duration": `\$\{PROFESSION_CEREMONY_DURATION_MS\}ms`/);
  assert.match(css, /Profession ascension ceremony V1/);
  assert.match(css, /\.profession-ceremony\s*\{[^}]*z-index:\s*340;[^}]*overflow:\s*hidden;/);
  assert.match(css, /animation:\s*profession-ceremony-arrive var\(--profession-ceremony-duration\)/);
  for (const selector of ["profession-ceremony-rays", "profession-ceremony-shockwave"]) {
    const blocks = [...css.matchAll(new RegExp(`\\.${selector}\\s*\\{([^}]*)\\}`, "g"))];
    const block = blocks.find((candidate) =>
      candidate[1].includes("inset: auto") && candidate[1].includes("top: 43%"));
    assert.ok(block, `${selector} CSS is missing`);
    assert.ok(block[1].indexOf("inset: auto") < block[1].indexOf("top: 43%"), `${selector} inset must not override its center`);
    assert.ok(block[1].indexOf("top: 43%") < block[1].indexOf("left: 50%"), `${selector} must keep a centered origin`);
  }
  assert.match(css, /@keyframes profession-ceremony-pillar[\s\S]{0,520}?rotate\(var\(--profession-pillar-rotation\)\)/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.profession-ceremony-sigil--main[\s\S]*?animation:\s*none;/);
});

test("profession ascension sigil is transparent, crop-safe, and runtime-wired", async () => {
  const assetPath = "public/assets/effects/profession-ascension-sigil-v1.png";
  const [source, css, png] = await Promise.all([
    readFile(path.join(root, "app/GameCanvas.tsx"), "utf8"),
    readFile(path.join(root, "app/game.css"), "utf8"),
    readFile(path.join(root, assetPath)),
  ]);
  const image = decodeRgbaPng(png, assetPath);
  assert.deepEqual([image.width, image.height], [1254, 1254]);
  assert.ok(png.length <= 2_500_000, `profession sigil exceeds its 2.5 MB budget: ${png.length}`);

  let visiblePixels = 0;
  let transparentPixels = 0;
  for (let index = 0; index < image.pixels.length; index += 4) {
    const alpha = image.pixels[index + 3];
    if (alpha > 16) visiblePixels += 1;
    if (alpha === 0) transparentPixels += 1;
  }
  const metrics = alphaCellMetrics(image, 0, 0, 1, 1, "profession ascension sigil");
  assert.ok(visiblePixels > 250_000, "the ascension seal must remain legible after scaling");
  assert.ok(transparentPixels / (image.width * image.height) > 0.35, "the seal needs a transparent compositing field");
  assert.ok(Math.min(metrics.left, metrics.right, metrics.top, metrics.bottom) >= 16, "the seal needs crop-safe outer padding");
  assert.equal(countGreenChromaPixels(image), 0, "the keyed seal must not retain green spill");
  for (const [x, y] of [[0, 0], [image.width - 1, 0], [0, image.height - 1], [image.width - 1, image.height - 1]]) {
    assert.equal(image.pixels[(y * image.width + x) * 4 + 3], 0, `corner ${x},${y} must be transparent`);
  }
  assert.match(source, /const canDecodeCeremonyImage = typeof ceremonyImage\.decode === "function"/);
  assert.match(source, /if \(!canDecodeCeremonyImage\) \{[\s\S]{0,120}?ceremonyImage\.addEventListener\("load", markCeremonyReady/);
  assert.match(source, /if \(canDecodeCeremonyImage\) \{[\s\S]{0,120}?ceremonyImage\.decode\(\)\.then\(markCeremonyReady\)/);
  assert.match(css, /background:\s*url\("\/assets\/effects\/profession-ascension-sigil-v1\.png"\) center \/ contain no-repeat/);
});

test("twenty new augments are unique, profession-ready, and wired into combat", async () => {
  const newAugmentIds = [
    "focus",
    "caliber",
    "homing",
    "ricochet",
    "execution",
    "giantbane",
    "overcharge",
    "shrapnel",
    "leech",
    "armor",
    "resolve",
    "regeneration",
    "ward",
    "bulwark",
    "momentum",
    "reflex",
    "scholar",
    "scavenger",
    "conquest",
    "frenzy",
  ];
  const [source, professions] = await Promise.all([
    readFile(path.join(root, "app/GameCanvas.tsx"), "utf8"),
    importTypeScriptModule("app/professions.ts"),
  ]);
  const catalog = source.match(/const AUGMENT_DEFINITIONS: Augment\[\] = \[([\s\S]*?)\n\];\n\n\/\/ The first 20 definitions/);
  assert.ok(catalog, "augment catalog must remain statically auditable");
  const catalogIds = [...catalog[1].matchAll(/\bid: "([a-z]+)"/g)].map((match) => match[1]);
  assert.equal(catalogIds.length, 50);
  assert.equal(new Set(catalogIds).size, 50, "augment IDs must be unique");
  assert.deepEqual(catalogIds.slice(20, 40), newAugmentIds);

  for (const id of newAugmentIds) {
    assert.equal(typeof professions.PROFESSION_TITLES[id], "string", `${id} needs a profession`);
    assert.match(
      source,
      new RegExp(`powerRankOf\\(player, "${id}"\\)`),
      `${id} must affect a runtime calculation`,
    );
  }

  assert.match(source, /projectile\.homing \* dt/);
  assert.match(source, /const shardCount = 2 \+ Math\.min\(6, shrapnelRank\)/);
  assert.match(
    source,
    /const executionThreshold =[\s\S]{0,140}?Math\.min\(0\.4/,
  );
  assert.match(
    source,
    /function applyPlayerDamage[\s\S]{0,1800}?bossDamagePercent[\s\S]{0,900}?executeDamagePercent/,
  );
  assert.match(source, /Math\.pow\(1 \+ armorRank \* 0\.1, 0\.62\)/);
  assert.match(
    source,
    /const regenerationPerSecond =[\s\S]{0,140}?regenerationRank \* 0\.14 \+ equipmentStats\.hpRegenPerSecondFlat/,
  );
  assert.match(source, /player\.hp \+ regenerationPerSecond \* dt/);
  assert.match(
    source,
    /const baseValue =[\s\S]{0,90}?isBossKind\(enemy\.kind\)/,
  );
});

test("ten simple augments use exact card values and affect runtime calculations", async () => {
  const expectedCards = [
    ["strength", "공격력 증가", "스택당 기본 공격 피해 +10%."],
    ["rapidfire", "속사", "스택당 공격 속도 +8%."],
    ["range", "사거리 증가", "스택당 투사체 사거리 +12%."],
    ["velocity", "탄속 증가", "스택당 투사체 속도 +10%."],
    ["expansion", "탄환 확대", "스택당 투사체 크기 +8%."],
    ["sprint", "이동 속도 증가", "스택당 이동 속도 +5%."],
    ["defense", "방어력 증가", "스택당 받는 피해 -3%."],
    ["recovery", "전투 회복", "스택당 방 클리어 시 체력 5 회복."],
    ["learning", "빠른 성장", "스택당 경험치 획득량 +10%."],
    ["collection", "수집 범위 증가", "스택당 기억 조각과 장비 획득 범위 +15%."],
  ];
  const [source, professions, balance] = await Promise.all([
    readFile(path.join(root, "app/GameCanvas.tsx"), "utf8"),
    importTypeScriptModule("app/professions.ts"),
    importTypeScriptModule("app/augment-balance.ts"),
  ]);
  const catalog = source.match(/const AUGMENT_DEFINITIONS: Augment\[\] = \[([\s\S]*?)\n\];\n\n\/\/ The first 20 definitions/);
  assert.ok(catalog, "augment catalog must remain statically auditable");
  const catalogIds = [...catalog[1].matchAll(/\bid: "([a-z]+)"/g)].map((match) => match[1]);
  assert.deepEqual(catalogIds.slice(-10), balance.SIMPLE_AUGMENT_IDS);

  for (const [id, name, description] of expectedCards) {
    const card = catalog[1].match(new RegExp(`\\{\\s*id: "${id}",([\\s\\S]*?)\\n\\s*\\},`));
    assert.ok(card, `${id} card must remain in the catalog`);
    assert.ok(card[1].includes(`name: "${name}"`), `${id} needs its plain-language name`);
    assert.ok(
      card[1].includes(`description: "${description}"`),
      `${id} needs its exact per-stack value`,
    );
    assert.equal(typeof professions.PROFESSION_TITLES[id], "string", `${id} needs a profession`);
    assert.match(
      source,
      new RegExp(`powerRankOf\\(player, "${id}"\\)`),
      `${id} must affect a runtime calculation`,
    );
  }

  assert.deepEqual(balance.SIMPLE_AUGMENT_BONUSES, {
    strengthDamagePerRank: 0.1,
    rapidfireAttackSpeedPerRank: 0.08,
    rangeProjectileLifePerRank: 0.12,
    velocityProjectileSpeedPerRank: 0.1,
    expansionProjectileSizePerRank: 0.08,
    sprintMoveSpeedPerRank: 0.05,
    defenseDamageReductionPerRank: 0.03,
    recoveryRoomHealPerRank: 5,
    learningXpGainPerRank: 0.1,
    collectionPickupRangePerRank: 0.15,
  });
  assert.equal(balance.simpleAugmentMultiplier(0, 0.1), 1);
  assert.equal(balance.simpleAugmentMultiplier(20, 0.1), 3);
  assert.equal(balance.simpleAugmentMultiplier(30, 0.1), 3);
  assert.equal(balance.simpleDefenseDamageMultiplier(0), 1);
  assert.ok(Math.abs(balance.simpleDefenseDamageMultiplier(20) - 0.97 ** 20) < 1e-12);
  assert.equal(
    balance.simpleDefenseDamageMultiplier(30),
    balance.simpleDefenseDamageMultiplier(20),
  );
});

test("build augment rows disclose their authored descriptions without nesting profession actions", async () => {
  const [source, css] = await Promise.all([
    readFile(path.join(root, "app/GameCanvas.tsx"), "utf8"),
    readFile(path.join(root, "app/game.css"), "utf8"),
  ]);
  const listStart = source.indexOf('<section className="augment-stack-list">');
  const listEnd = source.indexOf("</section>", listStart);
  assert.ok(listStart >= 0 && listEnd > listStart, "the build augment list must remain auditable");
  const list = source.slice(listStart, listEnd);

  assert.match(
    source,
    /const \[selectedBuildAugmentId, setSelectedBuildAugmentId\] = useState<string \| null>\(/,
  );
  assert.match(list, /type="button"\s+className="augment-stack-trigger"/);
  assert.match(list, /aria-expanded=\{selected\}/);
  assert.match(list, /aria-controls=\{detailId\}/);
  assert.match(list, /current === augment\.id \? null : augment\.id/);
  assert.match(
    list,
    /id=\{detailId\}[\s\S]{0,180}?role="region"[\s\S]{0,180}?aria-labelledby=\{triggerId\}/,
  );
  assert.match(list, /\{augment\.tags\.join\(" · "\)\}/);
  assert.match(list, /<p>\{augment\.description\}<\/p>/);
  assert.match(list, /<em>“\{augment\.flavor\}”<\/em>/);

  const triggerStart = list.indexOf('className="augment-stack-trigger"');
  const triggerEnd = list.indexOf("</button>", triggerStart);
  assert.ok(triggerStart >= 0 && triggerEnd > triggerStart, "the disclosure trigger must close");
  assert.doesNotMatch(
    list.slice(triggerStart, triggerEnd),
    /profession-inline-button/,
    "the profession action must not become a nested button",
  );
  assert.ok(
    list.indexOf("profession-inline-button", triggerEnd) > triggerEnd,
    "the profession action must remain a sibling of the disclosure trigger",
  );

  assert.match(css, /\.augment-stack-trigger \{[\s\S]{0,220}?min-height:\s*60px;/);
  assert.match(css, /\.augment-stack-trigger:focus-visible \{/);
  assert.match(css, /\.augment-stack-detail \{[\s\S]{0,260}?overflow-wrap:\s*anywhere;/);
  assert.match(css, /\.augment-stack-detail > p \{[\s\S]{0,180}?font-size:\s*11px;[\s\S]{0,100}?line-height:\s*1\.55;/);
});

test("opening basic attacks defeat common enemies in two unmodified hits", async () => {
  const [combatBalance, equipment, source] = await Promise.all([
    importTypeScriptModule("app/combat-balance.ts"),
    importTypeScriptModule("app/equipment.ts"),
    readFile(path.join(root, "app/GameCanvas.tsx"), "utf8"),
  ]);

  assert.equal(combatBalance.BASE_PLAYER_ATTACK_DAMAGE, 14);
  assert.equal(
    equipment.EQUIPMENT_POWER_BASE_ATTACK_DAMAGE,
    combatBalance.BASE_PLAYER_ATTACK_DAMAGE,
    "combat and equipment power must share one unmodified attack anchor",
  );
  assert.equal(Math.ceil(24 / combatBalance.BASE_PLAYER_ATTACK_DAMAGE), 2);
  assert.equal(Math.ceil(28 / combatBalance.BASE_PLAYER_ATTACK_DAMAGE), 2);
  assert.ok(
    combatBalance.BASE_PLAYER_ATTACK_DAMAGE * 1.7 < 24,
    "the five-percent opening critical roll must not randomly one-shot even the weakest enemy",
  );
  assert.match(source, /import \{ BASE_PLAYER_ATTACK_DAMAGE \} from "\.\/combat-balance";/);
  assert.match(
    source,
    /let damage =\s*\(BASE_PLAYER_ATTACK_DAMAGE \+ equipmentStats\.attackPowerFlat\) \*/,
  );
  assert.match(
    source,
    /const riftDamage =\s*\(BASE_PLAYER_ATTACK_DAMAGE \+ equipmentStats\.attackPowerFlat\) \*/,
  );
  assert.match(
    source,
    /const resonanceDamage =\s*\(BASE_PLAYER_ATTACK_DAMAGE \+ equipmentStats\.attackPowerFlat\) \*/,
  );
  assert.doesNotMatch(source, /let damage =\s*12 \*/);
});

test("projectile cadence, return timing, and special-projectile gear rules match the sheet", async () => {
  const source = await readFile(path.join(root, "app/GameCanvas.tsx"), "utf8");
  assert.match(source, /player\.fireCooldown \+= 1 \/ visibleRate/);
  assert.match(
    source,
    /while \(player\.fireCooldown <= 0 && catchUpShots < 4\)/,
    "low frame rates must preserve elapsed attack time with bounded catch-up",
  );
  assert.match(
    source,
    /projectile\.outboundSpent = true;[\s\S]{0,100}?projectile\.vx = 0;[\s\S]{0,80}?projectile\.vy = 0;/,
    "an outbound hit must survive until the authored return timer",
  );
  assert.match(
    source,
    /projectile\.returning = true;[\s\S]{0,80}?projectile\.outboundSpent = false;/,
  );
  assert.match(
    source,
    /const echoProjectileLife =[\s\S]{0,240}?equipmentStats\.projectileLifetimePercent/,
  );
  assert.match(
    source,
    /const resonanceSpeed =[\s\S]{0,260}?equipmentStats\.projectileSpeedPercent/,
  );
  assert.match(
    source,
    /const resonanceLife =[\s\S]{0,260}?equipmentStats\.projectileLifetimePercent/,
  );
  assert.match(
    source,
    /pierce:\s*1 \+ Math\.max\(0, Math\.floor\(equipmentStats\.pierceFlat\)\)/,
  );
});

test("the universal twenty-stack ceiling normalizes runtime choices and every save boundary", async () => {
  const [balance, saves, source] = await Promise.all([
    importTypeScriptModule("app/augment-balance.ts"),
    importTypeScriptModule("app/save-slots.ts"),
    readFile(path.join(root, "app/GameCanvas.tsx"), "utf8"),
  ]);
  assert.equal(balance.MAX_AUGMENT_STACKS, 20);
  assert.equal(saves.SAVE_AUGMENT_STACK_CAP, balance.MAX_AUGMENT_STACKS);
  assert.equal(balance.clampAugmentStack(-9), 0);
  assert.equal(balance.clampAugmentStack(12.9), 12);
  assert.equal(balance.clampAugmentStack(20), 20);
  assert.equal(balance.clampAugmentStack(21), 20);
  assert.equal(balance.clampAugmentStack(9_999), 20);
  assert.equal(balance.clampAugmentStack(Number.NaN), 0);
  assert.equal(balance.clampAugmentStack(Number.POSITIVE_INFINITY), 0);
  assert.equal(balance.clampAugmentStack("20"), 0);
  assert.deepEqual(
    balance.normalizeAugmentStacks({
      fang: 91,
      haste: 20.8,
      split: -4,
      eye: Number.NaN,
      zero: 0,
    }),
    { fang: 20, haste: 20 },
  );
  assert.equal(balance.totalAugmentStacks({ fang: 91, haste: 20.8 }), 40);

  const oldSave = structuredClone(sampleSave);
  oldSave.player.augments = { fang: 99, haste: 21, split: 0 };
  oldSave.stableAugments = { fang: 88, haste: 25, split: 0 };
  const readStorage = new MemoryStorage();
  readStorage.setItem(saves.saveSlotKey(1), JSON.stringify(oldSave));
  const normalizedOldSave = saves.readSaveSlot(1, readStorage);
  assert.ok(normalizedOldSave, "a valid pre-cap save must remain readable");
  assert.deepEqual(normalizedOldSave.player.augments, { fang: 20, haste: 20 });
  assert.deepEqual(normalizedOldSave.stableAugments, { fang: 20, haste: 20 });
  assert.equal(
    saves.readSaveSlotSummaries(readStorage)[0].augmentStacks,
    40,
    "slot summaries must count normalized player stacks rather than legacy overflow",
  );

  const writeStorage = new MemoryStorage();
  assert.equal(saves.writeSaveSlot(2, oldSave, writeStorage), true);
  const persisted = JSON.parse(writeStorage.getItem(saves.saveSlotKey(2)));
  assert.deepEqual(persisted.player.augments, { fang: 20, haste: 20 });
  assert.deepEqual(persisted.stableAugments, { fang: 20, haste: 20 });
  assert.deepEqual(saves.readSaveSlot(2, writeStorage).player.augments, {
    fang: 20,
    haste: 20,
  });
  assert.equal(saves.readSaveSlotSummaries(writeStorage)[1].augmentStacks, 40);

  const migrationStorage = new MemoryStorage();
  migrationStorage.setItem(saves.LEGACY_SAVE_KEY, JSON.stringify(oldSave));
  assert.equal(saves.writeActiveSaveSlot(3, migrationStorage), true);
  assert.equal(saves.readActiveSaveSlot(migrationStorage), 3);
  assert.equal(saves.migrateLegacySave(migrationStorage), "copied");
  assert.deepEqual(saves.readSaveSlot(1, migrationStorage).player.augments, {
    fang: 20,
    haste: 20,
  });
  assert.deepEqual(saves.readSaveSlot(1, migrationStorage).stableAugments, {
    fang: 20,
    haste: 20,
  });
  migrationStorage.setItem(saves.ACTIVE_SAVE_SLOT_KEY, "99");
  assert.equal(saves.readActiveSaveSlot(migrationStorage), 1);

  assert.match(
    source,
    /const rankOf = \(player: Player, id: string\) =>\s*clampAugmentStack\(player\.augments\[id\]\);/,
    "every runtime raw-rank read must pass through the universal clamp",
  );
  assert.match(
    source,
    /const available = AUGMENTS\.filter\(\s*\(augment\) => rankOf\(player, augment\.id\) < MAX_AUGMENT_STACKS,?\s*\);/,
    "maxed augments must be removed before the choice pool is weighted",
  );
  assert.match(
    source,
    /const picked = selectAugmentChoices\(\{[\s\S]{0,180}?available,[\s\S]{0,180}?getRank:/,
    "the live choice controller must delegate the filtered pool to the audited selector",
  );
  assert.doesNotMatch(
    source,
    /selectAugmentChoices\(\{[\s\S]{0,180}?playerLevel:/,
    "augment choices must not receive a player-level appearance override",
  );

  const openChoice = source.match(
    /const openAugmentChoice = useCallback\(\(\) => \{([\s\S]*?)\n\s*\}, \[setGameMode, syncHud\]\);/,
  );
  assert.ok(openChoice, "the augment choice controller must remain auditable");
  const allMaxBail = openChoice[1].match(
    /if \(available\.length === 0\) \{([\s\S]*?)\n\s*\}/,
  );
  assert.ok(allMaxBail, "an all-max build needs an explicit no-choice path");
  assert.match(allMaxBail[1], /setChoices\(\[\]\);/);
  assert.match(allMaxBail[1], /syncHud\(\);[\s\S]{0,40}?return;/);
  assert.doesNotMatch(
    allMaxBail[1],
    /setGameMode\("augment"\)/,
    "an exhausted choice pool must not open an empty modal",
  );
  assert.ok(
    openChoice[1].indexOf('if (available.length === 0)') <
      openChoice[1].indexOf('setGameMode("augment")'),
    "the exhausted-pool return must precede modal entry",
  );
  assert.match(
    source,
    /const chooseAugment = useCallback\([\s\S]{0,240}?if \(previous >= MAX_AUGMENT_STACKS\) \{[\s\S]{0,220}?resumeAfterAugmentChoice\(\);[\s\S]{0,40}?return;[\s\S]{0,120}?const nextRank = Math\.min\(MAX_AUGMENT_STACKS, previous \+ 1\);/,
    "stale clicks must bail out and the authoritative write must clamp once more",
  );
  assert.match(
    source,
    /augments: normalizeAugmentStacks\(data\.player\.augments\)/,
    "loading must normalize the volatile augment ledger",
  );
  assert.match(
    source,
    /stableAugmentsRef\.current = normalizeAugmentStacks\(/,
    "loading must normalize both volatile and shelter-stable augment ledgers",
  );
});

test("split follows the ordinary augment pool at every level", async () => {
  const balance = await importTypeScriptModule("app/augment-balance.ts");
  const candidates = ["split", "fang", "haste", "pierce"].map((id) => ({ id }));
  const rankOf = () => 0;
  const randomSequence = (...values) => {
    let cursor = 0;
    return () => values[cursor++] ?? 0.37;
  };

  assert.equal(balance.EARLY_SPLIT_APPEARANCE_CHANCE, undefined);
  assert.equal(balance.EARLY_SPLIT_MAX_LEVEL, undefined);
  assert.equal(balance.usesEarlySplitAppearanceRule, undefined);

  const lowRoll = balance.selectAugmentChoices({
    available: candidates,
    getRank: rankOf,
    random: randomSequence(0, 0.9, 0.8, 0.7),
  });
  assert.deepEqual(lowRoll.map(({ id }) => id), ["fang", "haste", "pierce"]);

  const highRoll = balance.selectAugmentChoices({
    available: candidates,
    getRank: rankOf,
    random: randomSequence(0.99, 0.1, 0.2, 0.3),
  });
  assert.equal(highRoll[0].id, "split");
  assert.equal(new Set(highRoll.map(({ id }) => id)).size, highRoll.length);

  const onlySplitFallback = balance.selectAugmentChoices({
    available: [{ id: "split" }],
    getRank: () => 19,
    random: randomSequence(0),
  });
  assert.deepEqual(onlySplitFallback, [{ id: "split" }]);
});

test("three save slots isolate data and preserve the legacy backup on migration", async () => {
  const [saves, equipment] = await Promise.all([
    importTypeScriptModule("app/save-slots.ts"),
    importTypeScriptModule("app/equipment.ts"),
  ]);
  const storage = new MemoryStorage();
  assert.deepEqual(saves.SAVE_SLOT_IDS, [1, 2, 3]);
  assert.equal(saves.writeSaveSlot(2, sampleSave, storage), true);
  assert.equal(saves.readSaveSlot(1, storage), null);
  assert.equal(saves.readSaveSlot(2, storage).player.level, 12);
  assert.equal(saves.readSaveSlot(2, storage).world.dungeonFloor, 6);
  assert.equal(saves.readSaveSlotSummaries(storage)[1].dungeonFloor, 6);
  assert.equal(
    saves.readSaveSlotSummaries(storage)[1].roomsCleared,
    27,
    "the lifetime room ledger must remain independent from dungeon floor",
  );
  assert.equal(saves.readSaveSlotSummaries(storage)[1].augmentStacks, 27);
  const gearSave = structuredClone(sampleSave);
  const rolledWeapon = equipment.rollGear("save-slot-gear", {
    level: 12,
    slot: "weapon",
    rarity: "legendary",
  });
  const legacyEnhancedWeapon = { ...rolledWeapon, enhancement: 7 };
  delete legacyEnhancedWeapon.enhancementRanks;
  const weapon = equipment.normalizeGearItem(legacyEnhancedWeapon);
  assert.ok(weapon);
  gearSave.player.memoryAsh = 345;
  gearSave.player.equipment = { weapon, helm: null, armor: null, boots: null, relic: null };
  gearSave.player.inventory = [equipment.rollGear("save-slot-pack", { level: 12 })];
  assert.equal(saves.writeSaveSlot(3, gearSave, storage), true);
  assert.equal(saves.readSaveSlot(3, storage).player.equipment.weapon.id, weapon.id);
  assert.equal(saves.readSaveSlot(3, storage).player.equipment.weapon.enhancement, 7);
  assert.equal(saves.readSaveSlot(3, storage).player.memoryAsh, 345);
  assert.equal(saves.readSaveSlotSummaries(storage)[2].equippedItems, 1);
  assert.equal(saves.readSaveSlotSummaries(storage)[2].inventoryItems, 1);
  assert.equal(saves.removeSaveSlot(2, storage), true);
  assert.equal(saves.readSaveSlot(2, storage), null);

  const legacyRaw = JSON.stringify(sampleSave);
  storage.setItem(saves.LEGACY_SAVE_KEY, legacyRaw);
  assert.equal(saves.migrateLegacySave(storage), "copied");
  assert.equal(storage.getItem(saves.LEGACY_SAVE_KEY), legacyRaw);
  assert.equal(storage.getItem(saves.saveSlotKey(1)), legacyRaw);
  assert.equal(saves.migrateLegacySave(storage), "slot-occupied");
});

test("slot overwrites and explicit removal preserve byte-exact rotating recovery candidates", async () => {
  const saves = await importTypeScriptModule("app/save-slots.ts");
  const storage = new MemoryStorage();
  const slotKey = saves.saveSlotKey(1);
  const level81 = structuredClone(sampleSave);
  level81.savedAt += 81;
  level81.player.level = 81;
  level81.player.rooms = 481;
  const level81Raw = JSON.stringify(level81, null, 2);
  storage.setItem(slotKey, level81Raw);

  assert.equal(typeof saves.SAVE_RECOVERY_KEY_PREFIX, "string");
  assert.equal(typeof saves.saveRecoveryKey, "function");
  assert.equal(typeof saves.readSaveRecoveryCandidates, "function");

  const replacement = structuredClone(sampleSave);
  replacement.savedAt += 82;
  replacement.player.level = 82;
  assert.equal(saves.writeSaveSlot(1, replacement, storage), true);

  const replacementRaw = storage.getItem(slotKey);
  assert.notEqual(replacementRaw, level81Raw);
  const beforeRecoveryRead = storageSnapshot(storage);
  const afterOverwrite = saves.readSaveRecoveryCandidates(storage);
  assert.deepEqual(
    storageSnapshot(storage),
    beforeRecoveryRead,
    "discovering recovery candidates must be strictly read-only",
  );
  const level81Candidate = afterOverwrite.find(
    (candidate) => candidate.slot === 1 && candidate.raw === level81Raw,
  );
  assert.ok(level81Candidate, "the overwritten level-81 raw save must remain recoverable");
  assert.equal(saves.parseSaveRun(level81Candidate.raw).player.level, 81);

  assert.equal(saves.removeSaveSlot(1, storage), true);
  assert.equal(storage.getItem(slotKey), null);
  const afterRemoval = saves.readSaveRecoveryCandidates(storage);
  const removedCandidate = afterRemoval.find(
    (candidate) => candidate.slot === 1 && candidate.raw === replacementRaw,
  );
  assert.ok(removedCandidate, "explicit removal must archive the final owned raw value");
  assert.equal(saves.parseSaveRun(removedCandidate.raw).player.level, 82);
});

test("backup write failures and verification mismatches never mutate the owned slot", async () => {
  const saves = await importTypeScriptModule("app/save-slots.ts");
  const replacement = structuredClone(sampleSave);
  replacement.savedAt += 1;
  replacement.player.level = 82;

  const rejectingStorage = new WriteRejectingStorage();
  const rejectingSlotKey = saves.saveSlotKey(1);
  const rejectingRaw = JSON.stringify({
    ...sampleSave,
    savedAt: sampleSave.savedAt + 81,
    player: { ...sampleSave.player, level: 81 },
  }, null, 2);
  rejectingStorage.setItem(rejectingSlotKey, rejectingRaw);
  rejectingStorage.rejectWrites = true;
  assert.equal(saves.writeSaveSlot(1, replacement, rejectingStorage), false);
  assert.equal(rejectingStorage.getItem(rejectingSlotKey), rejectingRaw);
  assert.equal(saves.removeSaveSlot(1, rejectingStorage), false);
  assert.equal(rejectingStorage.getItem(rejectingSlotKey), rejectingRaw);

  const mismatchSlotKey = saves.saveSlotKey(2);
  const mismatchStorage = new VerificationMismatchStorage(mismatchSlotKey);
  const mismatchRaw = JSON.stringify({
    ...sampleSave,
    savedAt: sampleSave.savedAt + 181,
    player: { ...sampleSave.player, level: 81 },
  }, null, 2);
  mismatchStorage.setItem(mismatchSlotKey, mismatchRaw);
  mismatchStorage.mismatchNewKeys = true;
  assert.equal(saves.writeSaveSlot(2, replacement, mismatchStorage), false);
  assert.equal(
    mismatchStorage.getItem(mismatchSlotKey),
    mismatchRaw,
    "a failed backup verification must abort before overwriting the slot",
  );

  const removeMismatchSlotKey = saves.saveSlotKey(3);
  const removeMismatchStorage = new VerificationMismatchStorage(removeMismatchSlotKey);
  const removeMismatchRaw = JSON.stringify({
    ...sampleSave,
    savedAt: sampleSave.savedAt + 281,
    player: { ...sampleSave.player, level: 81 },
  }, null, 2);
  removeMismatchStorage.setItem(removeMismatchSlotKey, removeMismatchRaw);
  removeMismatchStorage.mismatchNewKeys = true;
  assert.equal(saves.removeSaveSlot(3, removeMismatchStorage), false);
  assert.equal(
    removeMismatchStorage.getItem(removeMismatchSlotKey),
    removeMismatchRaw,
    "a failed backup verification must abort before removing the slot",
  );
});

test("a recovery candidate copies byte-exactly into an empty slot without changing the active slot", async () => {
  const saves = await importTypeScriptModule("app/save-slots.ts");
  const storage = new MemoryStorage();
  const level81 = structuredClone(sampleSave);
  level81.savedAt += 810;
  level81.player.level = 81;
  level81.player.rooms = 581;
  level81.player.inventory = [{ id: "level-81-recovery-item", rarity: "cosmic" }];
  const level81Raw = JSON.stringify(level81, null, 2);
  const sourceKey = saves.saveRecoveryKey(1, 1);
  const destinationKey = saves.saveSlotKey(2);
  storage.setItem(sourceKey, level81Raw);
  assert.equal(saves.writeActiveSaveSlot(3, storage), true);

  assert.equal(storage.getItem(destinationKey), null);
  assert.equal(saves.restoreSaveRecoveryCandidate(1, 1, 2, storage), true);
  assert.equal(
    storage.getItem(destinationKey),
    level81Raw,
    "recovery must copy the protected raw JSON without normalization or reserialization",
  );
  assert.equal(storage.getItem(sourceKey), level81Raw, "recovery must copy, never move");
  assert.equal(saves.readSaveSlot(2, storage).player.level, 81);
  assert.equal(saves.parseSaveRun(storage.getItem(destinationKey)).player.level, 81);
  assert.equal(
    saves.readActiveSaveSlot(storage),
    3,
    "the low-level restore operation must not silently switch the selected character",
  );
});

test("recovery refuses valid or corrupt occupied targets and preserves every owned byte", async () => {
  const saves = await importTypeScriptModule("app/save-slots.ts");
  const storage = new MemoryStorage();
  const level81 = structuredClone(sampleSave);
  level81.savedAt += 811;
  level81.player.level = 81;
  const level81Raw = JSON.stringify(level81, null, 2);
  const sourceKey = saves.saveRecoveryKey(1, 1);
  storage.setItem(sourceKey, level81Raw);
  assert.equal(saves.writeActiveSaveSlot(1, storage), true);

  const occupiedKey = saves.saveSlotKey(2);
  const occupiedRaw = JSON.stringify({
    ...sampleSave,
    savedAt: sampleSave.savedAt + 47,
    player: { ...sampleSave.player, level: 47 },
  }, null, 2);
  storage.setItem(occupiedKey, occupiedRaw);
  const beforeOccupiedRestore = storageSnapshot(storage);
  assert.equal(saves.restoreSaveRecoveryCandidate(1, 1, 2, storage), false);
  assert.deepEqual(storageSnapshot(storage), beforeOccupiedRestore);
  assert.equal(storage.getItem(occupiedKey), occupiedRaw);
  assert.equal(storage.getItem(sourceKey), level81Raw);
  assert.equal(saves.readActiveSaveSlot(storage), 1);

  const corruptKey = saves.saveSlotKey(3);
  const corruptRaw = "corrupt-but-owned-and-never-overwritable";
  storage.setItem(corruptKey, corruptRaw);
  const beforeCorruptRestore = storageSnapshot(storage);
  assert.equal(saves.restoreSaveRecoveryCandidate(1, 1, 3, storage), false);
  assert.deepEqual(storageSnapshot(storage), beforeCorruptRestore);
  assert.equal(storage.getItem(corruptKey), corruptRaw);
  assert.equal(storage.getItem(sourceKey), level81Raw);
  assert.equal(saves.readActiveSaveSlot(storage), 1);

  const corruptSourceStorage = new MemoryStorage();
  corruptSourceStorage.setItem(saves.saveRecoveryKey(1, 1), "{bad recovery json");
  assert.equal(saves.writeActiveSaveSlot(3, corruptSourceStorage), true);
  const beforeCorruptSource = storageSnapshot(corruptSourceStorage);
  assert.equal(
    saves.restoreSaveRecoveryCandidate(1, 1, 2, corruptSourceStorage),
    false,
  );
  assert.deepEqual(storageSnapshot(corruptSourceStorage), beforeCorruptSource);
  assert.equal(corruptSourceStorage.getItem(saves.saveSlotKey(2)), null);
  assert.equal(saves.readActiveSaveSlot(corruptSourceStorage), 3);
});

test("legacy saves default to the first dungeon floor without reinterpreting cleared rooms", async () => {
  const saves = await importTypeScriptModule("app/save-slots.ts");
  const storage = new MemoryStorage();
  const legacy = structuredClone(sampleSave);
  delete legacy.world.dungeonFloor;
  legacy.player.rooms = 847;
  storage.setItem(saves.saveSlotKey(1), JSON.stringify(legacy));

  const normalized = saves.readSaveSlot(1, storage);
  assert.equal(normalized.world.dungeonFloor, 1);
  assert.equal(normalized.player.rooms, 847);
  assert.equal(saves.readSaveSlotSummaries(storage)[0].dungeonFloor, 1);
  assert.equal(saves.readSaveSlotSummaries(storage)[0].roomsCleared, 847);
  assert.equal(saves.normalizeDungeonFloor(2_000_000), 2_000_000);

  for (const invalidFloor of [0, -1, 1.5, "2"]) {
    const malformed = structuredClone(sampleSave);
    malformed.world.dungeonFloor = invalidFloor;
    assert.equal(saves.writeSaveSlot(2, malformed, storage), false);
  }
});

test("corrupt saves are rejected without overwriting occupied slot 1", async () => {
  const saves = await importTypeScriptModule("app/save-slots.ts");
  const storage = new MemoryStorage();
  storage.setItem(saves.LEGACY_SAVE_KEY, "{bad json");
  assert.equal(saves.migrateLegacySave(storage), "legacy-invalid");
  assert.equal(storage.getItem(saves.saveSlotKey(1)), null);
  storage.setItem(saves.saveSlotKey(1), "corrupt-but-owned");
  assert.equal(saves.migrateLegacySave(storage), "slot-occupied");
  assert.equal(storage.getItem(saves.saveSlotKey(1)), "corrupt-but-owned");
});

test("the ending receipt patches only the one-time story flag at the saved shelter", async () => {
  const [saves, ending] = await Promise.all([
    importTypeScriptModule("app/save-slots.ts"),
    importTypeScriptModule("app/ending.ts"),
  ]);
  const storage = new MemoryStorage();
  const checkpoint = structuredClone(sampleSave);
  const originalWorld = structuredClone(checkpoint.world);
  const originalAugments = structuredClone(checkpoint.player.augments);

  assert.equal(saves.writeSaveSlot(2, checkpoint, storage), true);
  assert.equal(
    saves.markSaveSlotEndingSeen(2, ending.FIRST_BOSS_ENDING_VERSION, storage),
    true,
  );
  const patched = saves.readSaveSlot(2, storage);

  assert.equal(patched.player.endingSeen, true);
  assert.equal(patched.player.endingVersion, ending.FIRST_BOSS_ENDING_VERSION);
  assert.equal(patched.savedAt, checkpoint.savedAt, "the shelter timestamp must not move");
  assert.deepEqual(patched.world, originalWorld, "the shelter checkpoint must not move");
  assert.deepEqual(
    patched.player.augments,
    originalAugments,
    "unstable run progress must not be written by an ending receipt",
  );
  assert.equal(
    saves.markSaveSlotEndingSeen(1, ending.FIRST_BOSS_ENDING_VERSION, storage),
    false,
  );

  const malformed = structuredClone(sampleSave);
  malformed.player.endingSeen = "yes";
  assert.equal(saves.writeSaveSlot(3, malformed, storage), false);
  malformed.player.endingSeen = false;
  malformed.player.endingVersion = "two";
  assert.equal(saves.writeSaveSlot(3, malformed, storage), false);
  assert.equal(
    saves.writeSaveSlot(3, structuredClone(sampleSave), storage),
    true,
    "legacy saves without the optional flag remain valid",
  );
});

test("the blank cartographer owns the first boss and its long ending can trigger only once", async () => {
  const [ending, roster, source, css] = await Promise.all([
    importTypeScriptModule("app/ending.ts"),
    importTypeScriptModule("app/boss-roster.ts"),
    readFile(path.join(root, "app/GameCanvas.tsx"), "utf8"),
    readFile(path.join(root, "app/game.css"), "utf8"),
  ]);

  assert.equal(ending.BLANK_CARTOGRAPHER_KIND, 5);
  assert.equal(ending.FIRST_BOSS_ENDING_VERSION, 2);
  assert.equal(ending.ENDING_CONTINUE_LABEL, "모험을 계속한다");
  assert.equal(ending.shouldRevealFirstBossEnding("boss", 5, 0), true);
  assert.equal(
    ending.shouldRevealFirstBossEnding("boss", 5, 1),
    true,
    "a save that saw the former short ending must receive the expanded reveal once",
  );
  assert.equal(ending.shouldRevealFirstBossEnding("boss", 5, 2), false);
  assert.equal(ending.shouldRevealFirstBossEnding("boss", 9, 0), false);
  assert.equal(ending.shouldRevealFirstBossEnding("elite", 5, 0), false);
  assert.equal(roster.bossKindForProgress(0, 0), 5);
  assert.equal(roster.bossKindForProgress(1, 1), 5);
  assert.equal(roster.bossKindForProgress(2, 1), 9);
  assert.equal(roster.bossKindForProgress(2, 2), 11);
  assert.equal(roster.bossKindForProgress(2, 3), 5);
  assert.equal(roster.bossKindForProgress(2, 4), 9);
  assert.equal(roster.bossKindForProgress(0, 99, 99), 5);
  assert.equal(roster.bossKindForProgress(1, 99, 99), 5);
  assert.equal(roster.bossKindForProgress(2, 1, 99), 12);
  assert.deepEqual(
    Array.from({ length: 10 }, (_, index) => roster.bossKindForProgress(2, index + 1, 2)),
    [12, 13, 11, 5, 9, 12, 13, 11, 5, 9],
  );
  assert.equal(ending.normalizeEndingVersion(undefined, false), 0);
  assert.equal(ending.normalizeEndingVersion(undefined, true), 1);
  assert.equal(ending.normalizeEndingVersion(2, false), 2);
  assert.ok(ending.FIRST_BOSS_ENDING_CHAPTERS.length >= 8);

  const paragraphs = ending.FIRST_BOSS_ENDING_CHAPTERS.flatMap(
    (chapter) => chapter.paragraphs,
  );
  const fullEnding = paragraphs.join(" ");
  assert.ok(paragraphs.length >= 38, "the twist must remain a substantial epilogue");
  for (const revelation of [
    "이번의 나",
    "그는 이미 죽어 있었다",
    "기억의 재",
    "최초의 쉼표",
    "끝은 사라졌다",
  ]) {
    assert.match(fullEnding, new RegExp(revelation));
  }

  assert.match(
    source,
    /const bossKind =[\s\S]{0,160}?kind === "boss"[\s\S]{0,240}?bossKindForProgress\(\s*player\.endingVersion,\s*player\.bossesCleared,\s*world\.dungeonFloor,?\s*\)[\s\S]{0,1000}?if \(kind === "boss"\) \{[\s\S]{0,180}?makeEnemy\(bossKind,/,
    "boss spawning must preserve the first boss while selecting the post-ending roster",
  );
  assert.match(
    source,
    /if \(world\.roomKind === "boss"\) \{[\s\S]{0,260}?shouldRevealFirstBossEnding\([\s\S]{0,100}?world\.roomKind,[\s\S]{0,100}?world\.activeBossKind,[\s\S]{0,100}?player\.endingVersion,[\s\S]{0,320}?return;/,
    "later boss clears must return without scheduling another ending",
  );
  assert.match(
    source,
    /const continueAfterEnding[\s\S]{0,400}?playerRef\.current\.endingVersion = FIRST_BOSS_ENDING_VERSION;[\s\S]{0,180}?markSaveSlotEndingSeen\([\s\S]{0,100}?FIRST_BOSS_ENDING_VERSION/,
    "only the final continuation action may seal the ending receipt",
  );
  assert.match(
    source,
    /const savedEndingVersion = normalizeEndingVersion\([\s\S]{0,360}?endingSeen: savedEndingVersion >= FIRST_BOSS_ENDING_VERSION,[\s\S]{0,80}?endingVersion: savedEndingVersion/,
  );
  assert.match(
    source,
    /endingIsFinal \? ENDING_CONTINUE_LABEL : "다음 기억을 읽는다"/,
  );
  assert.match(
    css,
    /\.ending-modal\s*\{[^}]*height:[^}]*overflow:\s*hidden;/,
    "the long ending must stay inside the viewport",
  );
  assert.match(
    css,
    /\.ending-story\s*\{[^}]*overflow-y:\s*auto;/,
    "only the story transcript should scroll",
  );
});

test("the blank cartographer deterministically cycles every inherited attack behind a telegraph", async () => {
  const [balance, source] = await Promise.all([
    importTypeScriptModule("app/boss-balance.ts"),
    readFile(path.join(root, "app/GameCanvas.tsx"), "utf8"),
  ]);

  const expectedPatterns = [
    "aimedVolley",
    "teleport",
    "charge",
    "timeRifts",
    "summon",
    "radialVolley",
  ];
  assert.equal(balance.BLANK_CARTOGRAPHER_BASE_HP, 650);
  assert.ok(
    balance.BLANK_CARTOGRAPHER_BASE_HP < 950,
    "the pattern-heavy boss must have less base health than its former 950 HP budget",
  );
  assert.ok(
    balance.BLANK_CARTOGRAPHER_BASE_HP > 92,
    "the reduced boss health must still exceed every ordinary enemy base-health budget",
  );
  assert.deepEqual(balance.BLANK_CARTOGRAPHER_PATTERN_SEQUENCE, expectedPatterns);
  assert.deepEqual(Object.keys(balance.BLANK_CARTOGRAPHER_PATTERN_LABELS), expectedPatterns);
  assert.deepEqual(Object.keys(balance.BLANK_CARTOGRAPHER_TELEGRAPH_SECONDS), expectedPatterns);
  assert.equal(balance.BLANK_CARTOGRAPHER_RIFT_COUNT, 4);
  assert.equal(balance.BLANK_CARTOGRAPHER_SUMMON_COUNT, 2);
  assert.ok(balance.BLANK_CARTOGRAPHER_RECOVERY_SECONDS > 0);

  for (const pattern of expectedPatterns) {
    assert.match(balance.BLANK_CARTOGRAPHER_PATTERN_LABELS[pattern], /\S/);
    assert.ok(
      balance.BLANK_CARTOGRAPHER_TELEGRAPH_SECONDS[pattern] > 0,
      `${pattern} must expose a non-zero warning window`,
    );
  }
  for (let index = 0; index < expectedPatterns.length * 3; index += 1) {
    assert.equal(
      balance.blankCartographerPatternAt(index),
      expectedPatterns[index % expectedPatterns.length],
      "the authored cycle must make every pattern reachable without random starvation",
    );
  }
  assert.equal(balance.blankCartographerPatternAt(-1), expectedPatterns[0]);
  assert.equal(balance.blankCartographerPatternAt(Number.NaN), expectedPatterns[0]);
  assert.equal(balance.blankCartographerPatternAt(Number.POSITIVE_INFINITY), expectedPatterns[0]);

  const bossRoom = source.match(
    /if \(kind === "boss"\) \{([\s\S]*?)\n\s*\}\n\n\s*for \(let i = 0; i < count;/,
  );
  assert.ok(bossRoom, "the boss-room spawn branch must remain isolated");
  assert.match(
    source,
    /const bossKind =[\s\S]{0,240}?bossKindForProgress\(\s*player\.endingVersion,\s*player\.bossesCleared,\s*world\.dungeonFloor,?\s*\)/,
  );
  assert.match(bossRoom[1], /if \(bossKind === null\) return;/);
  assert.match(bossRoom[1], /makeEnemy\(bossKind,/);
  assert.equal(
    [...bossRoom[1].matchAll(/\bmakeEnemy\(/g)].length,
    1,
    "the first boss must begin alone instead of retaining the former escort pack",
  );

  const bossController = source.match(
    /if \(enemy\.kind === BLANK_CARTOGRAPHER_KIND\) \{([\s\S]*?)\n\s*\} else if \(enemy\.kind === FINAL_BINDER_KIND\) \{/,
  );
  assert.ok(bossController, "the blank cartographer needs a dedicated controller");
  const bossBody = bossController[1];
  assert.match(
    bossBody,
    /const nextPattern = blankCartographerPatternAt\(patternIndex\);[\s\S]{0,260}?BLANK_CARTOGRAPHER_TELEGRAPH_SECONDS\[nextPattern\][\s\S]{0,220}?enemy\.bossPatternIndex = patternIndex \+ 1;/,
    "the live controller must consume the complete deterministic pattern cycle",
  );

  const executionPhaseMarker = '} else if (bossPhase === "telegraph") {';
  const executionPhaseIndex = bossBody.indexOf(executionPhaseMarker);
  assert.ok(executionPhaseIndex > 0, "the controller must separate warnings from execution");
  const warningPhase = bossBody.slice(0, executionPhaseIndex);
  const executionAndRecovery = bossBody.slice(executionPhaseIndex);
  assert.doesNotMatch(
    warningPhase,
    /damagePlayer\(|spawnHostileProjectile\(|world\.enemies\.push\(/,
    "warning setup must not deal damage, launch missiles, or materialize summons",
  );
  assert.match(
    executionAndRecovery,
    /enemy\.moving = false;[\s\S]{0,100}?if \(\(enemy\.patternTimer \?\? 0\) <= 0\) \{[\s\S]{0,120}?const pattern = enemy\.bossPattern;/,
    "ordinary patterns may execute only after their warning timer expires",
  );

  assert.match(
    warningPhase,
    /if \(nextPattern === "teleport"\) \{[\s\S]*?spawnVisualEffect\(\s*"teleport",[\s\S]*?spawnVisualEffect\(\s*"teleport",/,
    "teleport must mark both departure and arrival before moving the boss",
  );
  assert.match(
    warningPhase,
    /else if \(nextPattern === "summon"\) \{[\s\S]*?4 - activeAdds[\s\S]*?spawnVisualEffect\(\s*"summon",/,
    "summons must reserve visible portals and respect the four-add encounter cap",
  );
  assert.match(
    warningPhase,
    /else if \(nextPattern === "charge"\) \{[\s\S]*?enemy\.patternX = Math\.cos\(chargeAngle\);[\s\S]*?enemy\.patternY = Math\.sin\(chargeAngle\);/,
    "the charge warning must lock a predicted direction before execution",
  );
  assert.match(
    warningPhase,
    /else \{\s*spawnCombatEffect\(\s*"timeRiftTelegraph",[\s\S]*?nextPattern === "radialVolley"/,
    "aimed and radial volleys must share an authored pre-fire warning",
  );

  assert.match(
    executionAndRecovery,
    /if \(pattern === "aimedVolley"\) \{[\s\S]*?for \(let shotIndex = -1; shotIndex <= 1; shotIndex \+= 1\) \{[\s\S]*?spawnHostileProjectile\(/,
    "the inherited aimed attack must fire its three-projectile spread",
  );
  assert.match(
    executionAndRecovery,
    /else if \(pattern === "teleport"\) \{[\s\S]*?enemy\.x = enemy\.patternTargetX \?\? enemy\.x;[\s\S]*?for \(let shotIndex = -1; shotIndex <= 1; shotIndex \+= 1\) \{[\s\S]*?spawnHostileProjectile\(/,
    "the inherited teleport must resolve only after warning and finish with missiles",
  );
  assert.match(
    executionAndRecovery,
    /else if \(pattern === "summon"\) \{[\s\S]*?4 - activeAdds[\s\S]*?world\.enemies\.push\(\s*makeEnemy\(/,
    "the inherited summoner pattern must materialize its pre-announced targets",
  );
  assert.match(
    executionAndRecovery,
    /else if \(pattern === "radialVolley"\) \{[\s\S]*?healthRatio > 0\.66 \? 8 : healthRatio > 0\.33 \? 12 : 16[\s\S]*?spawnHostileProjectile\(/,
    "the boss's original radial barrage must remain and scale across health phases",
  );
  assert.match(
    executionAndRecovery,
    /else if \(pattern === "charge"\) \{\s*enemy\.bossPhase = "charge";[\s\S]*?else if \(bossPhase === "charge"\) \{[\s\S]*?damagePlayer\(enemy\.damage \* 1\.35\);/,
    "charge collision damage must live only in the post-warning charge phase",
  );
  assert.match(
    executionAndRecovery,
    /else if \(bossPhase === "timeRifts"\) \{[\s\S]*?if \(!rift\.telegraphed && rift\.delay <= 0\) \{[\s\S]*?"timeRiftTelegraph"[\s\S]*?else if \(rift\.telegraphed\) \{[\s\S]*?rift\.timer -= dt;[\s\S]*?if \(rift\.timer <= 0\) \{[\s\S]*?"timeRiftBurst"[\s\S]*?damagePlayer\(enemy\.damage \* 1\.14\);[\s\S]*?for \(let missileIndex = 0; missileIndex < 6; missileIndex \+= 1\) \{[\s\S]*?spawnHostileProjectile\(/,
    "each targeted circle must warn, detonate once, then release its six missiles",
  );
  assert.match(
    source,
    /const bossWindup =[\s\S]{0,180}?enemy\.bossPattern === "charge"[\s\S]{0,100}?enemy\.bossPhase === "telegraph";[\s\S]{0,1000}?drawProofreaderTelegraph\(/,
    "the boss charge warning must use the authored charge telegraph asset",
  );
  assert.match(
    source,
    /data-boss-pattern=\{hud\.world\.bossPattern \?\? hud\.world\.binderPattern \?\? hud\.world\.archivistPattern \?\? hud\.world\.magistratePattern \?\? hud\.world\.indexerPattern \?\? "none"\}/,
  );
  assert.match(source, /BLANK_CARTOGRAPHER_PATTERN_LABELS\[hud\.world\.bossPattern\]/);
});

test("the Final Binder is a post-ending boss with three telegraphed arena patterns and clean assets", async () => {
  const walkPath = "public/assets/walk/final-binder-walk-v1.png";
  const effectPath = "public/assets/effects/final-binder-patterns-v1.png";
  const [balance, roster, source, walk, effects] = await Promise.all([
    importTypeScriptModule("app/final-binder-balance.ts"),
    importTypeScriptModule("app/boss-roster.ts"),
    readFile(path.join(root, "app/GameCanvas.tsx"), "utf8"),
    readFile(path.join(root, walkPath)).then((png) => decodeRgbaPng(png, walkPath)),
    readFile(path.join(root, effectPath)).then((png) => decodeRgbaPng(png, effectPath)),
  ]);

  assert.equal(balance.FINAL_BINDER_KIND, 9);
  assert.equal(balance.FINAL_BINDER_BASE_HP, 575);
  assert.equal(balance.FINAL_BINDER_BASE_SPEED, 35);
  assert.equal(balance.FINAL_BINDER_BASE_DAMAGE, 14);
  assert.equal(balance.FINAL_BINDER_RADIUS, 58);
  assert.deepEqual(balance.FINAL_BINDER_PATTERN_SEQUENCE, [
    "pageWall",
    "threadSweep",
    "chapterTurn",
  ]);
  assert.deepEqual(
    Object.keys(balance.FINAL_BINDER_PATTERN_LABELS),
    balance.FINAL_BINDER_PATTERN_SEQUENCE,
  );
  assert.equal(balance.FINAL_BINDER_CHAPTER_PULSES, 3);
  assert.ok(balance.FINAL_BINDER_TELEGRAPH_SECONDS.pageWall >= 0.9);
  assert.ok(balance.FINAL_BINDER_TELEGRAPH_SECONDS.threadSweep >= 1);
  assert.ok(balance.FINAL_BINDER_TELEGRAPH_SECONDS.chapterTurn >= 0.75);
  for (let index = 0; index < 12; index += 1) {
    assert.equal(
      balance.finalBinderPatternAt(index),
      balance.FINAL_BINDER_PATTERN_SEQUENCE[index % 3],
    );
  }

  const pageWall = balance.finalBinderPageWallSegments(
    "horizontal",
    1,
    0.5,
    640,
  );
  assert.equal(pageWall.length, 2);
  assert.equal(
    pageWall[1].startX - pageWall[0].endX,
    balance.FINAL_BINDER_PAGE_WALL_HORIZONTAL_GAP,
  );
  assert.equal(pageWall[0].startY, pageWall[1].startY);
  const forwardEnd = balance.finalBinderPageWallSegments("vertical", 1, 1, 360);
  const reverseStart = balance.finalBinderPageWallSegments("vertical", -1, 0, 360);
  assert.deepEqual(forwardEnd, reverseStart, "opposite casts must share exact wall geometry");

  const sweep = balance.finalBinderThreadSweepSegment(640, 360, 0, 1, 0);
  assert.equal(sweep.startX, 640 + balance.FINAL_BINDER_THREAD_INNER_RADIUS);
  assert.equal(sweep.startY, 360);
  assert.equal(
    Math.hypot(sweep.endX - sweep.startX, sweep.endY - sweep.startY),
    balance.FINAL_BINDER_THREAD_OUTER_RADIUS -
      balance.FINAL_BINDER_THREAD_INNER_RADIUS,
  );
  assert.equal(balance.finalBinderChapterSafeSector(0, 1, 0), 0);
  assert.equal(balance.finalBinderChapterSafeSector(0, 1, 1), 1);
  assert.equal(balance.finalBinderChapterSafeSector(0, -1, 1), 3);
  assert.equal(
    balance.finalBinderChapterHits(840, 360, 640, 360, 0),
    false,
    "the marked east sector must remain safe",
  );
  assert.equal(
    balance.finalBinderChapterHits(440, 360, 640, 360, 0),
    true,
    "the opposite annulus must remain dangerous",
  );

  assert.equal(roster.isBossKind(5), true);
  assert.equal(roster.isBossKind(9), true);
  assert.equal(roster.isBossKind(11), true);
  assert.equal(roster.isBossKind(8), false);
  assert.equal(roster.bossKindForProgress(1, 10), 5);
  assert.equal(roster.bossKindForProgress(2, 1), 9);

  assert.deepEqual([walk.width, walk.height], [1024, 1536]);
  for (let row = 0; row < 8; row += 1) {
    for (let column = 0; column < 4; column += 1) {
      const label = "final binder row " + row + " column " + column;
      const metrics = alphaCellMetrics(walk, column, row, 4, 8, label);
      assert.ok(metrics.opaquePixels >= 7_000, label + " lacks a readable boss silhouette");
      assert.ok(metrics.left >= 12 && metrics.right >= 12, label + " clips horizontally");
      assert.ok(metrics.top >= 12 && metrics.bottom >= 12, label + " clips vertically");
    }
  }
  for (let frame = 0; frame < 4; frame += 1) {
    for (let y = 0; y < 192; y += 1) {
      for (let x = 0; x < 256; x += 1) {
        const southwest = ((1 * 192 + y) * walk.width + frame * 256 + x) * 4;
        const southeast = ((7 * 192 + y) * walk.width + frame * 256 + (255 - x)) * 4;
        for (let channel = 0; channel < 4; channel += 1) {
          assert.equal(
            walk.pixels[southwest + channel],
            walk.pixels[southeast + channel],
            "SE must be the exact horizontal counterpart of SW",
          );
        }
      }
    }
  }
  assert.equal(countGreenChromaPixels(walk), 0, walkPath + " retains green spill");

  assert.deepEqual([effects.width, effects.height], [1254, 1254]);
  for (let row = 0; row < 2; row += 1) {
    for (let column = 0; column < 2; column += 1) {
      const label = "final binder effect row " + row + " column " + column;
      const metrics = alphaCellMetrics(effects, column, row, 2, 2, label);
      assert.ok(metrics.opaquePixels >= 5_000, label + " is missing");
      assert.ok(metrics.left >= 18 && metrics.right >= 18, label + " clips horizontally");
      assert.ok(metrics.top >= 40 && metrics.bottom >= 40, label + " clips vertically");
    }
  }
  assert.equal(countGreenChromaPixels(effects), 0, effectPath + " retains green spill");

  assert.match(source, /type EnemyKind\s*=\s*0\s*\|\s*1\s*\|\s*2\s*\|\s*3\s*\|\s*4\s*\|\s*5\s*\|\s*6\s*\|\s*7\s*\|\s*8\s*\|\s*9/);
  assert.match(source, /["']종언의 제본사["']/);
  assert.match(source, /walkFinalBinder:\s*["']\/assets\/walk\/final-binder-walk-v1\.png["']/);
  assert.match(source, /finalBinderPatterns:\s*["']\/assets\/effects\/final-binder-patterns-v1\.png["']/);
  assert.match(
    source,
    /let boss: Enemy \| undefined;[\s\S]{0,500}?if \(!boss && isBossKind\(enemy\.kind\)\) boss = enemy;/,
  );
  assert.match(source, /const dropCount = isBossKind\(enemy\.kind\) \? 2 : 1;/);

  const controller = source.match(
    /else if \(enemy\.kind === FINAL_BINDER_KIND\) \{([\s\S]*?)\n\s*\} else if \(enemy\.kind === PALIMPSEST_ARCHIVIST_KIND\) \{/,
  );
  assert.ok(controller, "kind 9 needs an isolated controller");
  const warningMarker = '} else if (binderPhase === "telegraph") {';
  const warningEnd = controller[1].indexOf(warningMarker);
  assert.ok(warningEnd > 0);
  assert.doesNotMatch(
    controller[1].slice(0, warningEnd),
    /damagePlayer\(/,
    "pursuit and warning setup must not deal damage",
  );
  assert.match(
    controller[1],
    /binderPhase === "pageWall"[\s\S]*?finalBinderPageWallSegments\([\s\S]*?FINAL_BINDER_PAGE_WALL_HALF_WIDTH[\s\S]*?damagePlayer\(enemy\.damage\);/,
  );
  assert.match(
    controller[1],
    /binderPhase === "threadSweep"[\s\S]*?finalBinderThreadSweepSegment\([\s\S]*?FINAL_BINDER_THREAD_HALF_WIDTH[\s\S]*?damagePlayer\(enemy\.damage \* 1\.12\);/,
  );
  assert.match(
    controller[1],
    /binderPhase === "chapterBurst"[\s\S]*?finalBinderChapterHits\([\s\S]*?damagePlayer\(enemy\.damage \* 0\.55\);/,
  );
  const finalBinderFloorIndex = source.indexOf(
    "drawFinalBinderPattern(images.finalBinderPatterns, enemy)",
  );
  const actorIndex = source.indexOf(
    "const sortedEnemies = [...world.enemies]",
    finalBinderFloorIndex,
  );
  assert.ok(
    finalBinderFloorIndex >= 0 && actorIndex > finalBinderFloorIndex,
    "all boss danger geometry must render below the actor layer",
  );
  assert.match(source, /FINAL_BINDER_PATTERN_LABELS\[hud\.world\.binderPattern\]/);
  assert.match(source, /FINAL_BINDER_PHASE_LABELS\[hud\.world\.binderPhase\]/);
});

test("long Proofreader and Final Binder lanes use uniform horizontal three-slices", async () => {
  const [vfx, source] = await Promise.all([
    importTypeScriptModule("app/augment-vfx.ts"),
    readFile(path.join(root, "app/GameCanvas.tsx"), "utf8"),
  ]);
  const renderThreeSlice = (options) => {
    const drawCalls = [];
    const context = {
      drawImage(...args) {
        drawCalls.push(args);
      },
    };
    const rendered = vfx.drawHorizontalThreeSliceAtlasCell(context, {}, options);
    return { drawCalls, rendered };
  };
  const assertUniformDraws = (
    drawCalls,
    expectedStart,
    expectedWidth,
    label,
    minimumCalls = 3,
  ) => {
    assert.ok(
      drawCalls.length >= minimumCalls,
      `${label} must retain its uniformly scaled slices`,
    );
    assert.ok(Math.abs(drawCalls[0][5] - expectedStart) < 1e-9, `${label} start drifted`);
    const last = drawCalls.at(-1);
    assert.ok(
      Math.abs(last[5] + last[7] - (expectedStart + expectedWidth)) < 1e-7,
      `${label} must cover the complete destination width`,
    );
    for (const [index, args] of drawCalls.entries()) {
      const scaleX = args[7] / args[3];
      const scaleY = args[8] / args[4];
      assert.ok(
        Math.abs(scaleX - scaleY) < 1e-9,
        `${label} segment ${index} distorts an authored source axis`,
      );
      assert.ok(args[3] > 0 && args[7] > 0);
    }
  };

  const proofreader = renderThreeSlice({
    sourceX: 512,
    sourceY: 512,
    sourceWidth: 512,
    sourceHeight: 512,
    destinationX: -112,
    destinationY: -72,
    destinationLength: 920,
    destinationHeight: 144,
    sourceCapWidth: 128,
  });
  assert.equal(proofreader.rendered, true);
  assertUniformDraws(proofreader.drawCalls, -112, 920, "Proofreader telegraph");
  assert.equal(proofreader.drawCalls[0][3], 128);
  assert.equal(proofreader.drawCalls[0][7], 36);
  assert.equal(proofreader.drawCalls.at(-1)[1], 896);

  const binder = renderThreeSlice({
    sourceX: 627,
    sourceY: 0,
    sourceWidth: 627,
    sourceHeight: 627,
    destinationX: -500,
    destinationY: -47,
    destinationLength: 1000,
    destinationHeight: 94,
    sourceCapWidth: 627 / 4,
  });
  assert.equal(binder.rendered, true);
  assertUniformDraws(binder.drawCalls, -500, 1000, "Final Binder thread");
  assert.ok(
    binder.drawCalls.length > 10,
    "the long binding thread must repeat its authored centre",
  );

  const contained = renderThreeSlice({
    sourceX: 0,
    sourceY: 0,
    sourceWidth: 512,
    sourceHeight: 512,
    destinationX: 10,
    destinationY: 20,
    destinationLength: 50,
    destinationHeight: 144,
    sourceCapWidth: 128,
  });
  assert.equal(contained.rendered, true);
  assert.equal(contained.drawCalls.length, 2, "short lanes retain two uniformly scaled caps");
  assert.equal(contained.drawCalls[0][7] + contained.drawCalls[1][7], 50);
  assert.equal(contained.drawCalls[0][8], 100);
  assert.equal(contained.drawCalls[0][6], 42);
  assertUniformDraws(contained.drawCalls, 10, 50, "short three-slice fallback", 2);
  assert.equal(
    renderThreeSlice({
      sourceX: 0,
      sourceY: 0,
      sourceWidth: 0,
      sourceHeight: 512,
      destinationX: 0,
      destinationY: 0,
      destinationLength: 920,
      destinationHeight: 144,
    }).rendered,
    false,
  );

  const proofreaderStart = source.indexOf("const drawProofreaderTelegraph = (");
  const proofreaderEnd = source.indexOf("const drawMarginSeverLine = (", proofreaderStart);
  const proofreaderRenderer = source.slice(proofreaderStart, proofreaderEnd);
  assert.ok(proofreaderStart >= 0 && proofreaderEnd > proofreaderStart);
  assert.match(
    proofreaderRenderer,
    /drawHorizontalThreeSliceAtlasCell\(context, image, \{[\s\S]{0,500}?sourceCapWidth:\s*sourceWidth \/ 4/,
  );
  assert.doesNotMatch(
    proofreaderRenderer,
    /context\.drawImage\(/,
    "the 512×512 Proofreader cell must never return to one 920×144 draw",
  );

  const binderStart = source.indexOf("const drawFinalBinderPattern = (");
  const binderEnd = source.indexOf("const drawPalimpsestPattern = (", binderStart);
  const binderRenderer = source.slice(binderStart, binderEnd);
  const bindingLine = binderRenderer.match(/const drawBindingLine = \([\s\S]*?\n      \};/);
  assert.ok(bindingLine, "the Final Binder needs an isolated line renderer");
  assert.match(
    bindingLine[0],
    /drawHorizontalThreeSliceAtlasCell\(context, image, \{[\s\S]{0,500}?sourceCapWidth:\s*sourceWidth \/ 4/,
  );
  assert.doesNotMatch(
    bindingLine[0],
    /context\.drawImage\(/,
    "the 627×627 binder cell must never return to one independently scaled strip",
  );
});

test("each shelter heals and saves only on its first coordinate visit", async () => {
  const [shelterMemory, source] = await Promise.all([
    importTypeScriptModule("app/shelter-memory.ts"),
    readFile(path.join(root, "app/GameCanvas.tsx"), "utf8"),
  ]);

  const visited = {};
  const visit = (key, kind = "shelter") => {
    const firstRest = shelterMemory.isFirstShelterRest(kind, visited[key] === true);
    visited[key] = true;
    return firstRest;
  };
  assert.equal(visit("5,0"), true, "a new shelter must grant its one rest");
  assert.equal(visit("5,0"), false, "the same shelter must be spent on revisit");
  assert.equal(visit("10,0"), true, "a different new shelter gets its own one rest");
  assert.equal(visit("3,0", "battle"), false, "ordinary rooms never activate a shelter rest");
  assert.match(shelterMemory.SPENT_SHELTER_MESSAGE, /체력 회복과 기억 고정은 다시 일어나지 않습니다/);

  const firstVisitDecision = source.indexOf(
    "const shelterActivated =\n        isFirstShelterRest(kind, world.visitedLookup[key] === true);",
  );
  const visitedLedgerInsertion = source.indexOf(
    "if (!world.visitedLookup[key])",
    firstVisitDecision,
  );
  assert.ok(
    firstVisitDecision >= 0 && visitedLedgerInsertion > firstVisitDecision,
    "the first-visit decision must be captured before the coordinate enters the visited ledger",
  );
  assert.match(
    source,
    /if \(kind === "shelter"\) \{\s*if \(shelterActivated\) \{\s*saveAtShelter\(\);\s*setGameMode\("shelter"\);\s*\} else \{\s*setToast\(SPENT_SHELTER_MESSAGE\);/,
    "only a fresh shelter may save and open the rest modal",
  );
  assert.match(
    source,
    /const saveAtShelter[\s\S]{0,240}?if \(isLocalVfxShowcase\) return;[\s\S]{0,220}?player\.hp = player\.maxHp;/,
    "normal shelters still heal, while the local visual fixture remains storage-free",
  );
  assert.match(
    source,
    /const savedDungeon = normalizeSavedDungeonWorld\(data\.world\);[\s\S]{0,1800}?enterRoom\(savedDungeon\.roomX, savedDungeon\.roomY, "left"\);\s*setGameMode\("playing"\);[\s\S]{0,1100}?setToast\(`\$\{slot\}번 슬롯 · 고정된 기억에서 원정을 재개했습니다\.`\);/,
    "loading a checkpoint must not pretend to activate its already-spent shelter again",
  );
  assert.match(source, /새 쉼터에 처음 닿을 때만 장비와 빌드가 함께 저장됩니다/);
  assert.match(source, /다시 방문해도 회복하거나 기억을 고정하지 않습니다/);
});

test("local cash-shop conveniences preserve independent travel and sequential bag entitlements", async () => {
  const [shop, saves] = await Promise.all([
    importTypeScriptModule("app/shop.ts"),
    importTypeScriptModule("app/save-slots.ts"),
  ]);
  const storage = new MemoryStorage();

  assert.equal(shop.BASE_INVENTORY_CAPACITY, 24);
  assert.equal(shop.MAX_INVENTORY_CAPACITY, 48);
  assert.equal(shop.SHOP_PRODUCTS.length, 5);
  assert.equal(new Set(shop.SHOP_PRODUCTS.map((product) => product.id)).size, 5);
  for (const product of shop.SHOP_PRODUCTS) {
    assert.ok(Number.isSafeInteger(product.priceKrw) && product.priceKrw > 0);
  }
  const expansionProducts = shop.SHOP_PRODUCTS.filter(
    (product) => product.kind === "inventory-expansion",
  );
  const wayfinderProduct = shop.SHOP_PRODUCTS.find(
    (product) => product.id === shop.MAP_TELEPORT_PRODUCT_ID,
  );
  assert.equal(expansionProducts.length, 4);
  assert.ok(expansionProducts.every((product) => product.inventorySlots === 6));
  assert.equal(wayfinderProduct?.kind, "map-teleport");
  assert.equal(wayfinderProduct?.inventorySlots, 0);
  assert.equal(wayfinderProduct?.priceKrw, 12_900);
  assert.equal(shop.shopCheckoutMode("localhost"), "local-test");
  assert.equal(shop.shopCheckoutMode("127.0.0.1"), "local-test");
  assert.equal(shop.shopCheckoutMode("game.example.com"), "unconfigured");
  assert.equal(shop.inventoryCapacityFor(shop.readShopEntitlements(storage)), 24);

  const wayfinder = shop.completeLocalShopPurchase(
    shop.MAP_TELEPORT_PRODUCT_ID,
    storage,
    100,
  );
  assert.equal(wayfinder.status, "purchased");
  assert.equal(shop.hasMapTeleportEntitlement(wayfinder.entitlements), true);
  assert.equal(
    shop.inventoryCapacityFor(wayfinder.entitlements),
    24,
    "map travel must never change backpack capacity",
  );
  const wayfinderReplay = shop.completeLocalShopPurchase(
    shop.MAP_TELEPORT_PRODUCT_ID,
    storage,
    101,
  );
  assert.equal(wayfinderReplay.status, "already-owned");
  assert.equal(wayfinderReplay.entitlements.receipts.length, 1);

  const locked = shop.completeLocalShopPurchase("inventory-expansion-2", storage, 102);
  assert.equal(locked.status, "locked");
  assert.equal(
    shop.hasMapTeleportEntitlement(locked.entitlements),
    true,
    "travel ownership must not bypass or disappear behind the bag chain",
  );
  assert.equal(shop.inventoryCapacityFor(shop.readShopEntitlements(storage)), 24);

  const first = shop.completeLocalShopPurchase("inventory-expansion-1", storage, 103);
  assert.equal(first.status, "purchased");
  assert.equal(first.receipt.priceKrw, expansionProducts[0].priceKrw);
  assert.equal(shop.inventoryCapacityFor(first.entitlements), 30);
  const replay = shop.completeLocalShopPurchase("inventory-expansion-1", storage, 104);
  assert.equal(replay.status, "already-owned");
  assert.equal(replay.entitlements.receipts.length, 2, "a replay must not issue a second receipt");

  assert.equal(saves.writeSaveSlot(1, sampleSave, storage), true);
  assert.equal(saves.removeSaveSlot(1, storage), true);
  assert.equal(
    shop.inventoryCapacityFor(shop.readShopEntitlements(storage)),
    30,
    "deleting a run must not delete the device-wide purchase",
  );
  assert.equal(
    shop.hasMapTeleportEntitlement(shop.readShopEntitlements(storage)),
    true,
    "deleting a run must not delete the device-wide travel item",
  );

  for (const [index, product] of expansionProducts.slice(1).entries()) {
    const result = shop.completeLocalShopPurchase(product.id, storage, 200 + index);
    assert.equal(result.status, "purchased");
  }
  const completed = shop.readShopEntitlements(storage);
  assert.equal(shop.inventoryCapacityFor(completed), 48);
  assert.equal(completed.purchasedProductIds.length, 5);
  assert.equal(completed.receipts.length, 5);

  storage.setItem(
    shop.SHOP_STORAGE_KEY,
    JSON.stringify({
      version: 1,
      purchasedProductIds: ["inventory-expansion-4", shop.MAP_TELEPORT_PRODUCT_ID],
      receipts: [],
      updatedAt: 999,
    }),
  );
  assert.equal(
    shop.inventoryCapacityFor(shop.readShopEntitlements(storage)),
    24,
    "a forged later tier cannot bypass sequential entitlements",
  );
  assert.equal(
    shop.hasMapTeleportEntitlement(shop.readShopEntitlements(storage)),
    true,
    "an independent valid travel purchase must survive beside a forged bag tier",
  );

  storage.setItem(
    shop.SHOP_STORAGE_KEY,
    JSON.stringify({
      version: 1,
      purchasedProductIds: expansionProducts.map((product) => product.id),
      receipts: [],
      updatedAt: 1_000,
    }),
  );
  const legacyBagOnly = shop.readShopEntitlements(storage);
  assert.equal(shop.inventoryCapacityFor(legacyBagOnly), 48);
  assert.equal(shop.hasMapTeleportEntitlement(legacyBagOnly), false);
});

test("generated walk, VFX, and equipment sheets retain their required PNG dimensions", async () => {
  const expected = new Map([
    ["public/assets/walk/withered-walk-v2.png", [1024, 1536]],
    ["public/assets/walk/threader-walk.png", [1024, 1536]],
    ["public/assets/walk/guardian-walk.png", [1024, 1536]],
    ["public/assets/walk/nest-walk.png", [1024, 1536]],
    ["public/assets/walk/witch-walk.png", [1024, 1536]],
    ["public/assets/walk/cartographer-boss-walk.png", [1024, 1536]],
    ["public/assets/walk/proofreader-walk-v2.png", [1024, 1536]],
    ["public/assets/walk/time-stalker-walk.png", [1024, 1536]],
    ["public/assets/walk/margin-severer-walk-v2.png", [1024, 1536]],
    ["public/assets/walk/final-binder-walk-v1.png", [1024, 1536]],
    ["public/assets/walk/silent-librarian-walk-v2.png", [1024, 1536]],
    ["public/assets/walk/palimpsest-archivist-walk-v1.png", [1024, 1536]],
    ["public/assets/walk/forbidden-indexer-walk-v1.png", [1024, 1536]],
    ["public/assets/walk/harin-neutral-walk-v4.png", [1024, 1536]],
    ["public/assets/walk/harin-mannequin-v2.png", [1024, 1536]],
    ["public/assets/effects/summon-rift.png", [1024, 1024]],
    ["public/assets/effects/teleport-rift.png", [1024, 1024]],
    ["public/assets/effects/proofreader-telegraph.png", [1536, 1024]],
    ["public/assets/effects/time-stalker-rift-warning-v1.png", [1254, 1254]],
    ["public/assets/effects/time-stalker-rift-burst-v1.png", [1254, 1254]],
    ["public/assets/effects/margin-sever-line-v3.png", [1536, 640]],
    ["public/assets/effects/final-binder-patterns-v1.png", [1254, 1254]],
    ["public/assets/effects/silent-librarian-echo-v4.png", [512, 256]],
    ["public/assets/effects/palimpsest-archivist-patterns-v1.png", [2048, 1024]],
    ["public/assets/effects/forbidden-indexer-patterns-v1.png", [2048, 1024]],
    ["public/assets/equipment/equipment-types-v4.png", [2800, 2800]],
    ["public/assets/equipment/equipment-icons-expanded.png", [1400, 1120]],
    ["public/assets/effects/loot-awakening.png", [1600, 800]],
    ["public/assets/effects/loot-cosmic-awakening.png", [1536, 768]],
    ["public/assets/equipment/paperdoll-equipment.png", [1000, 1536]],
    ["public/assets/ui/rarity-frames-v6.png", [2560, 320]],
    ["public/assets/ui/inventory-cosmic-aura.png", [1536, 768]],
    ["public/assets/ui/inventory-rarity-aura-rare-v3.png", [1536, 768]],
    ["public/assets/ui/inventory-rarity-aura-epic-v3.png", [1536, 768]],
    ["public/assets/ui/inventory-rarity-aura-legendary-v3.png", [1536, 768]],
    ["public/assets/ui/inventory-rarity-aura-mythic-v3.png", [1536, 768]],
    ["public/assets/ui/inventory-rarity-aura-cosmic-v3.png", [1536, 768]],
  ]);
  for (const [relativePath, [width, height]] of expected) {
    const png = await readFile(path.join(root, relativePath));
    assert.equal(png.subarray(1, 4).toString("ascii"), "PNG", relativePath);
    assert.equal(png.readUInt32BE(16), width, relativePath);
    assert.equal(png.readUInt32BE(20), height, relativePath);
    assert.equal(png[25], 6, `${relativePath} must be RGBA`);
  }
});

test("the Proofreader walk atlas fills all canonical direction cells without edge clipping", async () => {
  const relativePath = "public/assets/walk/proofreader-walk-v2.png";
  const image = decodeRgbaPng(await readFile(path.join(root, relativePath)), relativePath);
  assert.deepEqual([image.width, image.height], [1024, 1536]);
  for (let row = 0; row < 8; row += 1) {
    for (let column = 0; column < 4; column += 1) {
      const label = `proofreader row ${row} column ${column}`;
      assertAlphaCellGutter(image, column, row, 4, 8, label);
      const metrics = alphaCellMetrics(image, column, row, 4, 8, label);
      assert.ok(metrics.left >= 40 && metrics.right >= 40, `${label} needs horizontal crop safety`);
      assert.ok(metrics.top >= 16, `${label} needs complete helmet and horn padding`);
      assert.ok(metrics.bottom >= 18, `${label} needs complete feet and sword padding`);
      assert.ok(metrics.width <= 216 && metrics.height <= 158, `${label} exceeds the normalized silhouette box`);
    }
  }

  for (const [leftRow, rightRow] of [[1, 7], [2, 6], [3, 5]]) {
    let mismatches = 0;
    for (let frame = 0; frame < 4; frame += 1) {
      for (let y = 0; y < 192; y += 1) {
        for (let x = 0; x < 256; x += 1) {
          const leftPixel = ((leftRow * 192 + y) * image.width + frame * 256 + x) * 4;
          const rightPixel = ((rightRow * 192 + y) * image.width + frame * 256 + (255 - x)) * 4;
          for (let channel = 0; channel < 4; channel += 1) {
            if (image.pixels[leftPixel + channel] !== image.pixels[rightPixel + channel]) mismatches += 1;
          }
        }
      }
    }
    assert.equal(mismatches, 0, `direction rows ${leftRow}/${rightRow} must be exact facing mirrors`);
  }

  const source = await readFile(path.join(root, "app/GameCanvas.tsx"), "utf8");
  assert.match(source, /"walkProofreader"[\s\S]{0,260}?] as const/);
  assert.match(
    source,
    /makeDirectionFrames\(\[0, 1, 2, 3, 4, 5, 6, 7\]\)[\s\S]{0,900}?const DIRECTION_NAMES/,
    "the authored Proofreader rows must retain their canonical direction order",
  );
  assert.match(source, /ENEMY_DIRECTION_FRAMES\[enemy\.kind\]\[enemy\.facing\]/);
  assert.match(source, /images\[WALK_IMAGE_KEYS\[enemy\.kind\]\]/);
  assert.match(
    source,
    /const walkWidth =[\s\S]{0,520}?enemy\.kind === 6\s*\?\s*192[\s\S]{0,700}?const walkHeight =[\s\S]{0,520}?enemy\.kind === 6\s*\?\s*144/,
  );
});

test("the Time Stalker uses an authored 4x8 atlas and a sequential predictive rift pattern", async () => {
  const relativePath = "public/assets/walk/time-stalker-walk.png";
  const image = decodeRgbaPng(await readFile(path.join(root, relativePath)), relativePath);
  assert.deepEqual([image.width, image.height], [1024, 1536]);
  for (let row = 0; row < 8; row += 1) {
    for (let column = 0; column < 4; column += 1) {
      assertAlphaCellGutter(image, column, row, 4, 8, `time stalker row ${row} column ${column}`);
    }
  }

  const source = await readFile(path.join(root, "app/GameCanvas.tsx"), "utf8");
  assert.match(
    source,
    /type EnemyKind\s*=\s*0\s*\|\s*1\s*\|\s*2\s*\|\s*3\s*\|\s*4\s*\|\s*5\s*\|\s*6\s*\|\s*7/,
  );
  assert.match(source, /시간의 추적자/);
  assert.match(
    source,
    /walkTimeStalker:\s*["']\/assets\/walk\/time-stalker-walk\.png["']/,
  );
  assert.match(
    source,
    /timeRiftWarning:\s*["']\/assets\/effects\/time-stalker-rift-warning-v1\.png["']/,
  );
  assert.match(
    source,
    /timeRiftBurst:\s*["']\/assets\/effects\/time-stalker-rift-burst-v1\.png["']/,
  );
  assert.match(source, /WALK_IMAGE_KEYS[\s\S]{0,300}?["']walkTimeStalker["']/);
  assert.match(
    source,
    /const TIME_STALKER_DIRECTION_FRAMES\s*=\s*makeDirectionFrames\(\[0, 1, 2, 3, 4, 5, 6, 7\]\)/,
    "all eight Time Stalker facings must come from authored rows",
  );
  assert.match(
    source,
    /TIME_STALKER_DIRECTION_FRAMES,[\s\S]{0,400}?MARGIN_SEVERER_DIRECTION_FRAMES,[\s\S]{0,520}?makeDirectionFrames\(\[0, 1, 2, 3, 4, 5, 6, 7\]\),[\s\S]{0,320}?makeDirectionFrames\(\[0, 1, 2, 3, 4, 5, 6, 7\]\),[\s\S]{0,40}?\];/,
    "the canonical Time Stalker direction map must occupy kind 7's frame slot",
  );
  assert.match(
    source,
    /enemy\.kind === 7 \|\|[\s\S]{0,80}?enemy\.kind === MARGIN_SEVERER_KIND \|\|[\s\S]{0,80}?enemy\.kind === SILENT_LIBRARIAN_KIND[\s\S]{0,220}?\? false[\s\S]{0,80}?: directionFrame\.flipX/,
    "kind 7 must never be mirrored at draw time",
  );
  assert.match(
    source,
    /const hpBases = \[[\s\S]{0,420}?BLANK_CARTOGRAPHER_BASE_HP,[\s\S]{0,80}?58,[\s\S]{0,80}?92,[\s\S]{0,80}?68,[\s\S]{0,80}?FINAL_BINDER_BASE_HP,[\s\S]{0,80}?82,[\s\S]{0,80}?PALIMPSEST_ARCHIVIST_BASE_HP,[\s\S]{0,80}?INKBOUND_MAGISTRATE_BASE_HP,[\s\S]{0,80}?FORBIDDEN_INDEXER_BASE_HP,[\s\S]{0,40}?\];[\s\S]{0,380}?const speedBases = \[[\s\S]{0,240}?76, 50, 43, 26, 62, 38, 72, 66, 58,[\s\S]{0,80}?FINAL_BINDER_BASE_SPEED, 54, PALIMPSEST_ARCHIVIST_BASE_SPEED,[\s\S]{0,80}?INKBOUND_MAGISTRATE_BASE_SPEED,[\s\S]{0,80}?FORBIDDEN_INDEXER_BASE_SPEED,/,
    "kind 7 needs explicit health and movement stats",
  );
  assert.match(
    source,
    /:\s*depth < SILENT_LIBRARIAN_UNLOCK_DEPTH[\s\S]{0,100}?\? \[0, 1, 2, 3, 4, 6, 7, MARGIN_SEVERER_KIND\]/,
    "deep rooms must include kind 7 in their normal spawn distribution",
  );
  assert.match(source, /const TIME_RIFT_WARNING_SECONDS = 0\.9;/);

  const branch = source.match(
    /else if \(enemy\.kind === 7\) \{([\s\S]*?)\n\s*\} else \{\n\s*let movement = 1;/,
  );
  assert.ok(branch, "kind 7 needs a controller isolated from the existing enemy movement branch");
  const body = branch[1];
  assert.match(body, /const preferredDistance = 320;/, "the controller must hold medium range");
  assert.match(body, /strafeStrength[\s\S]{0,500}?Math\.PI \/ 2/, "the controller must strafe");
  assert.match(
    body,
    /Array\.from\(\{ length: 3 \}[\s\S]{0,500}?predictionDistance[\s\S]{0,300}?player\.x \+ dx \* predictionDistance/,
    "each attack must predict movement and place exactly three rifts",
  );
  assert.match(body, /const delay = index \* TIME_RIFT_SEQUENCE_GAP;/);
  assert.match(
    body,
    /spawnCombatEffect\([\s\S]{0,80}?["']timeRiftTelegraph["'][\s\S]{0,180}?TIME_RIFT_WARNING_SECONDS/,
  );
  assert.match(
    body,
    /if \(rift\.timer <= 0\) \{[\s\S]{0,120}?rift\.triggered = true;[\s\S]{0,160}?["']timeRiftBurst["']/,
    "each rift must detonate only once",
  );
  assert.match(
    body,
    /distance\(player\.x, player\.y, rift\.x, rift\.y\)[\s\S]{0,120}?TIME_RIFT_RADIUS \+ player\.radius[\s\S]{0,160}?damagePlayer\(enemy\.damage/,
    "a detonation must apply one-time circular AoE damage",
  );

  assert.match(
    source,
    /effect\.kind === ["']timeRiftTelegraph["'][\s\S]{0,900}?drawTimeRiftSprite\([\s\S]{0,180}?imagesRef\.current\.timeRiftWarning/,
    "the warning must use its authored sprite sheet",
  );
  assert.match(
    source,
    /spriteDrawn\s*\?\s*warningRadius\s*:\s*warningRadius\s*\*\s*pulse/,
    "the loaded warning sheet must retain an exact-radius collision ring",
  );
  assert.match(
    source,
    /if \(spriteDrawn\) \{[\s\S]{0,120}?context\.restore\(\);[\s\S]{0,80}?return true;[\s\S]{0,900}?context\.strokeRect/,
    "procedural warning runes must remain as an image-load fallback",
  );
  assert.match(
    source,
    /if \(effect\.kind === ["']timeRiftBurst["']\) \{[\s\S]{0,260}?drawTimeRiftSprite\(imagesRef\.current\.timeRiftBurst, effect, ["']burst["']\)/,
    "the time-rift burst must use its authored sprite sheet",
  );
  assert.match(
    source,
    /if \(effect\.kind === ["']timeRiftBurst["']\) \{[\s\S]{0,900}?createRadialGradient[\s\S]{0,420}?rgba\(99, 247, 255,[\s\S]{0,260}?rgba\(240, 91, 255,/,
    "the cyan-magenta procedural detonation must remain as an image-load fallback",
  );
  assert.match(
    source,
    /enemy\.kind === 7\s*\? ["']#394a72["']/,
    "kind 7 needs a distinct fallback fill",
  );
  assert.match(
    source,
    /if \(effect\.kind === ["']timeRiftTelegraph["']\) \{\s*drawCombatEffect\(effect, ambientTime\);/,
    "the warning must render on the floor before enemy sprites",
  );
  assert.match(
    source,
    /if \(effect\.kind !== ["']timeRiftTelegraph["']\) \{\s*drawCombatEffect\(effect, ambientTime\);/,
    "the foreground pass must not draw the warning a second time",
  );
});

test("Time Stalker skill sheets contain four transparent, chroma-clean animation cells", async () => {
  const assetPaths = [
    "public/assets/effects/time-stalker-rift-warning-v1.png",
    "public/assets/effects/time-stalker-rift-burst-v1.png",
  ];
  for (const assetPath of assetPaths) {
    const image = decodeRgbaPng(await readFile(path.join(root, assetPath)), assetPath);
    assert.deepEqual([image.width, image.height], [1254, 1254]);
    assert.equal(image.width % 2, 0, `${assetPath} width must divide into two columns`);
    assert.equal(image.height % 2, 0, `${assetPath} height must divide into two rows`);

    let chromaPixels = 0;
    for (let row = 0; row < 2; row += 1) {
      for (let column = 0; column < 2; column += 1) {
        const metrics = alphaCellMetrics(
          image,
          column,
          row,
          2,
          2,
          `${assetPath} row ${row} column ${column}`,
        );
        assert.ok(metrics.width >= 360, `${assetPath} frame ${row}:${column} is empty or undersized`);
        assert.ok(metrics.height >= 340, `${assetPath} frame ${row}:${column} is empty or undersized`);
      }
    }
    for (let index = 0; index < image.pixels.length; index += 4) {
      const red = image.pixels[index];
      const green = image.pixels[index + 1];
      const blue = image.pixels[index + 2];
      const alpha = image.pixels[index + 3];
      if (alpha > 8 && green > red + 65 && green > blue + 65 && green > 110) {
        chromaPixels += 1;
      }
    }
    assert.equal(chromaPixels, 0, `${assetPath} retains green-screen contamination`);
    for (const [x, y] of [
      [0, 0],
      [image.width - 1, 0],
      [0, image.height - 1],
      [image.width - 1, image.height - 1],
    ]) {
      assert.equal(
        image.pixels[(y * image.width + x) * 4 + 3],
        0,
        `${assetPath} needs transparent outer corners`,
      );
    }
  }

  const source = await readFile(path.join(root, "app/GameCanvas.tsx"), "utf8");
  assert.match(source, /const TIME_RIFT_SPRITE_GRID = 2;/);
  assert.match(source, /const TIME_RIFT_SOURCE_INSET_RATIO = 0\.025;/);
  assert.match(
    source,
    /const restoresPeakBurst = variant === ["']burst["'] && frameIndex === 2;/,
    "the peak vertical tear must be recovered without leaking an adjacent frame",
  );
  assert.match(source, /const frameIndex = clamp\(Math\.floor\(progress \* 4\), 0, 3\);/);
});

test("the Margin Severer keeps one deterministic line contract from spawn through collision", async () => {
  const [balance, source] = await Promise.all([
    importTypeScriptModule("app/enemy-balance.ts"),
    readFile(path.join(root, "app/GameCanvas.tsx"), "utf8"),
  ]);

  assert.equal(balance.MARGIN_SEVERER_KIND, 8);
  assert.equal(balance.MARGIN_SEVERER_UNLOCK_DEPTH, 4);
  assert.equal(balance.MARGIN_SEVERER_MAX_PER_ROOM, 1);
  assert.equal(balance.MARGIN_SEVERER_TELEGRAPH_SECONDS, 0.95);
  assert.equal(balance.MARGIN_SEVERER_ACTIVE_SECONDS, 1.55);
  assert.equal(balance.MARGIN_SEVERER_RECOVERY_SECONDS, 0.8);
  assert.equal(balance.MARGIN_SEVERER_LINE_LENGTH, 520);
  assert.equal(balance.MARGIN_SEVERER_HIT_HALF_WIDTH, 12);
  assert.equal(balance.MARGIN_SEVERER_DAMAGE_MULTIPLIER, 1.2);
  const line = balance.marginSeverLine(100, 200, 3, 4);
  assert.deepEqual(line, { startX: -56, startY: -8, endX: 256, endY: 408 });
  assert.equal((line.startX + line.endX) / 2, 100, "the segment must stay centered on its mark");
  assert.equal((line.startY + line.endY) / 2, 200, "the segment must stay centered on its mark");
  assert.equal(
    Math.hypot(line.endX - line.startX, line.endY - line.startY),
    balance.MARGIN_SEVERER_LINE_LENGTH,
    "direction magnitude must not change the sever length",
  );
  assert.deepEqual(
    balance.marginSeverLine(100, 200, 30, 40),
    line,
    "scaled direction vectors must produce the same visible and damaging segment",
  );
  assert.deepEqual(
    balance.marginSeverLine(100, 200, 0, 0),
    { startX: 100, startY: 200, endX: 100, endY: 200 },
    "a degenerate direction must remain finite and centered",
  );

  assert.match(
    source,
    /type EnemyKind\s*=\s*0\s*\|\s*1\s*\|\s*2\s*\|\s*3\s*\|\s*4\s*\|\s*5\s*\|\s*6\s*\|\s*7\s*\|\s*8/,
  );
  assert.match(source, /["']여백 절단사["']/);

  const makeEnemyStart = source.indexOf("const makeEnemy = useCallback(");
  const makeEnemyEnd = source.indexOf("const spawnRoom = useCallback(", makeEnemyStart);
  assert.ok(makeEnemyStart >= 0 && makeEnemyEnd > makeEnemyStart, "makeEnemy must stay inspectable");
  const makeEnemy = source.slice(makeEnemyStart, makeEnemyEnd);
  const readBalanceArray = (name) => {
    const match = makeEnemy.match(new RegExp(`const ${name} = \\[([\\s\\S]*?)\\];`));
    assert.ok(match, `${name} is missing from makeEnemy`);
    return match[1].split(",").map((value) => value.trim()).filter(Boolean);
  };
  const hpBases = readBalanceArray("hpBases");
  const speedBases = readBalanceArray("speedBases");
  const damageBases = readBalanceArray("damageBases");
  const radii = readBalanceArray("radii");
  assert.equal(hpBases.length, 14, "every enemy kind needs an aligned health entry");
  assert.equal(speedBases.length, 14, "every enemy kind needs an aligned speed entry");
  assert.equal(damageBases.length, 14, "every enemy kind needs an aligned damage entry");
  assert.equal(radii.length, 14, "every enemy kind needs an aligned radius entry");
  assert.deepEqual(
    [hpBases[8], speedBases[8], damageBases[8], radii[8]],
    ["68", "58", "11", "23"],
    "kind 8 must retain its complete authored stat row",
  );
  assert.deepEqual(
    [hpBases[10], speedBases[10], damageBases[10], radii[10]],
    ["82", "54", "14", "25"],
    "kind 10 must retain its complete authored stat row",
  );
  assert.match(
    makeEnemy,
    /kind === 7 \|\| kind === MARGIN_SEVERER_KIND \|\| kind === SILENT_LIBRARIAN_KIND[\s\S]{0,80}?\? ["']orbit["']/,
    "the Margin Severer must begin in its orbit phase",
  );
  assert.match(
    makeEnemy,
    /kind === MARGIN_SEVERER_KIND[\s\S]{0,100}?1\.65 \+ hash\([^;]*807\) \* 1\.1/,
    "its initial attack delay must be deterministically staggered",
  );

  const spawnStart = source.indexOf("const spawnRoom = useCallback(");
  const spawnEnd = source.indexOf("const determineRoomKind", spawnStart);
  assert.ok(spawnStart >= 0 && spawnEnd > spawnStart, "spawnRoom must stay inspectable");
  const spawnRoom = source.slice(spawnStart, spawnEnd);
  assert.match(spawnRoom, /let marginSevererCount = 0;/);
  assert.match(
    spawnRoom,
    /depth < MARGIN_SEVERER_UNLOCK_DEPTH\s*\? \[0, 1, 2, 6\]/,
    "kind 8 must be absent before its depth-four unlock",
  );
  const unlockedPools = [
    ...spawnRoom.matchAll(/\[([^\]]*MARGIN_SEVERER_KIND[^\]]*)\]/g),
  ].map((match) => match[1]);
  assert.equal(unlockedPools.length, 3, "all post-unlock normal pools must include kind 8");
  assert.ok(unlockedPools.at(-1).includes("7"), "the deepest pool must retain the Time Stalker");
  const roomLimitStart = spawnRoom.indexOf("if (enemyKind === MARGIN_SEVERER_KIND)");
  const roomLimitEnd = spawnRoom.indexOf("const elite =", roomLimitStart);
  assert.ok(roomLimitStart >= 0 && roomLimitEnd > roomLimitStart, "the room cap guard is missing");
  const roomLimit = spawnRoom.slice(roomLimitStart, roomLimitEnd);
  assert.match(roomLimit, /marginSevererCount >= MARGIN_SEVERER_MAX_PER_ROOM/);
  assert.match(roomLimit, /enemyKind =\s*hash\([^;]+\) < 0\.5 \? 2 : 4;/);
  assert.match(roomLimit, /else \{\s*marginSevererCount \+= 1;/);

  const controllerStart = source.indexOf("} else if (enemy.kind === MARGIN_SEVERER_KIND) {");
  const controllerEnd = source.indexOf(
    "\n        } else if (enemy.kind === SILENT_LIBRARIAN_KIND) {",
    controllerStart,
  );
  assert.ok(controllerStart >= 0 && controllerEnd > controllerStart, "kind 8 needs an isolated FSM");
  const controller = source.slice(controllerStart, controllerEnd);
  const inscribeIndex = controller.indexOf('phase === "inscribe"');
  const severIndex = controller.indexOf('phase === "sever"');
  const recoverIndex = controller.indexOf('enemy.patternPhase = "recover"');
  assert.ok(
    inscribeIndex >= 0 && severIndex > inscribeIndex && recoverIndex > severIndex,
    "the FSM must advance from telegraph to sever to recovery",
  );
  assert.match(
    controller,
    /enemy\.patternPhase = ["']inscribe["'];\s*enemy\.patternTimer = MARGIN_SEVERER_TELEGRAPH_SECONDS;/,
  );
  assert.match(
    controller,
    /phase === ["']inscribe["'][\s\S]{0,260}?enemy\.patternPhase = ["']sever["'];\s*enemy\.patternTimer = MARGIN_SEVERER_ACTIVE_SECONDS;/,
  );
  assert.match(
    controller,
    /phase === ["']sever["'][\s\S]{0,1200}?enemy\.patternPhase = ["']recover["'];\s*enemy\.patternTimer = MARGIN_SEVERER_RECOVERY_SECONDS;/,
  );
  assert.equal(
    (controller.match(/marginSeverLine\(/g) ?? []).length,
    1,
    "collision must derive one canonical segment per update",
  );
  assert.match(
    controller,
    /const severLine = marginSeverLine\(\s*enemy\.patternTargetX \?\? player\.x,\s*enemy\.patternTargetY \?\? player\.y,\s*enemy\.patternX \?\? 1,\s*enemy\.patternY \?\? 0,?\s*\);/,
  );
  assert.match(
    controller,
    /if \(\s*!enemy\.patternHit &&[\s\S]{0,480}?distanceToSegment\([\s\S]{0,320}?MARGIN_SEVERER_HIT_HALF_WIDTH[\s\S]{0,100}?enemy\.patternHit = true;\s*damagePlayer\(enemy\.damage \* MARGIN_SEVERER_DAMAGE_MULTIPLIER\);/,
    "the active seam may damage the player only once per attack",
  );
  assert.match(
    source,
    /enemy\.kind !== 6 &&\s*enemy\.kind !== 7 &&\s*enemy\.kind !== MARGIN_SEVERER_KIND &&/,
    "kind 8 must not add ordinary contact damage on top of its seam",
  );

  const drawStart = source.indexOf("const drawMarginSeverLine = (");
  const drawEnd = source.indexOf("const drawTimeRiftSprite = (", drawStart);
  assert.ok(drawStart >= 0 && drawEnd > drawStart, "the visible seam renderer is missing");
  const drawLine = source.slice(drawStart, drawEnd);
  assert.equal(
    (drawLine.match(/marginSeverLine\(/g) ?? []).length,
    1,
    "rendering must derive the same canonical segment exactly once",
  );
  assert.match(drawLine, /const centerX = enemy\.patternTargetX \?\? enemy\.x;/);
  assert.match(drawLine, /const centerY = enemy\.patternTargetY \?\? enemy\.y;/);
  assert.match(
    drawLine,
    /const severLine = marginSeverLine\(\s*centerX,\s*centerY,\s*enemy\.patternX \?\? 1,\s*enemy\.patternY \?\? 0,?\s*\);/,
  );
  const floorDrawIndex = source.indexOf("drawMarginSeverLine(images.marginSeverLine, enemy)");
  const projectileTrailIndex = source.indexOf(
    'drawProjectileVfx(projectile, ambientTime, projectileCount, "trail")',
    floorDrawIndex,
  );
  const actorDrawIndex = source.indexOf("const sortedEnemies = [...world.enemies]", floorDrawIndex);
  assert.ok(
    floorDrawIndex >= 0 && projectileTrailIndex > floorDrawIndex && actorDrawIndex > floorDrawIndex,
    "the visible collision seam must render on the floor before projectiles and actors",
  );
});

test("the Silent Librarian uses eight fixed-size authored stages with stable wave slots", async () => {
  const balanceUrl = await typeScriptModuleUrl("app/silent-librarian.ts");
  const [balance, vfx, source, vfxSource, builderSource, buildText, promptText] =
    await Promise.all([
      import(balanceUrl),
      importTypeScriptModule("app/silent-librarian-vfx.ts", {
        "./silent-librarian": balanceUrl,
      }),
      readFile(path.join(root, "app/GameCanvas.tsx"), "utf8"),
      readFile(path.join(root, "app/silent-librarian-vfx.ts"), "utf8"),
      readFile(path.join(root, "scripts/build_silent_librarian_echo_v4.py"), "utf8"),
      readFile(
        path.join(root, "public/assets/effects/silent-librarian-echo-v4.build.json"),
        "utf8",
      ),
      readFile(
        path.join(root, "asset-sources/imagegen/silent-librarian-echo-v4.prompt.json"),
        "utf8",
      ),
    ]);
  const walkPath = "public/assets/walk/silent-librarian-walk-v2.png";
  const echoPath = "public/assets/effects/silent-librarian-echo-v4.png";
  const buildReport = JSON.parse(buildText);
  const promptMetadata = JSON.parse(promptText);
  const [walk, echoBytes] = await Promise.all([
    readFile(path.join(root, walkPath)).then((png) => decodeRgbaPng(png, walkPath)),
    readFile(path.join(root, echoPath)),
  ]);
  const echo = decodeRgbaPng(echoBytes, echoPath);

  assert.equal(balance.SILENT_LIBRARIAN_KIND, 10);
  assert.equal(balance.SILENT_LIBRARIAN_UNLOCK_DEPTH, 8);
  assert.equal(balance.SILENT_LIBRARIAN_MAX_PER_ROOM, 1);
  assert.equal(balance.silentLibrarianWaveRadius(balance.SILENT_LIBRARIAN_WAVE_SECONDS), 44);
  assert.equal(balance.silentLibrarianWaveRadius(0), 340);
  assert.equal(
    balance.sweptEchoRingHits({
      previousRadius: 100,
      currentRadius: 145,
      targetDistance: 130,
      targetRadius: 16,
    }),
    true,
    "a fast frame must not tunnel through the player",
  );
  assert.equal(
    balance.sweptEchoRingHits({
      previousRadius: 100,
      currentRadius: 145,
      targetDistance: 45,
      targetRadius: 16,
    }),
    false,
    "the hollow center must remain safe after the ring passes",
  );

  assert.deepEqual([walk.width, walk.height], [1024, 1536]);
  for (let row = 0; row < 8; row += 1) {
    for (let column = 0; column < 4; column += 1) {
      const label = `silent librarian row ${row} column ${column}`;
      const metrics = alphaCellMetrics(walk, column, row, 4, 8, label);
      assert.ok(metrics.opaquePixels >= 4_000, `${label} lacks a complete silhouette`);
      assert.ok(metrics.left >= 16 && metrics.right >= 16, `${label} needs horizontal crop safety`);
      assert.ok(metrics.top >= 6 && metrics.bottom >= 8, `${label} needs vertical crop safety`);
    }
  }
  assert.equal(countGreenChromaPixels(walk), 0, `${walkPath} retains green-screen contamination`);

  assert.deepEqual([echo.width, echo.height], [512, 256]);
  const framePixelHashes = [];
  let remainingMagenta = 0;
  for (let row = 0; row < 2; row += 1) {
    for (let column = 0; column < 4; column += 1) {
      const frameIndex = row * 4 + column;
      const label = `silent librarian V4 frame ${frameIndex}`;
      const metrics = alphaCellMetrics(echo, column, row, 4, 2, label);
      const pixels = rgbaCellBuffer(echo, column, row, 4, 2, label);
      const alphaLevels = new Set();
      const visibleRgb = new Set();
      for (let index = 0; index < pixels.length; index += 4) {
        const red = pixels[index];
        const green = pixels[index + 1];
        const blue = pixels[index + 2];
        const alpha = pixels[index + 3];
        alphaLevels.add(alpha);
        if (alpha > 0) visibleRgb.add((red << 16) | (green << 8) | blue);
        if (alpha > 8 && red > 180 && blue > 180 && green + 70 < Math.min(red, blue)) {
          remainingMagenta += 1;
        }
      }
      for (const cornerPixel of [0, 127, 127 * 128, 128 * 128 - 1]) {
        assert.equal(pixels[cornerPixel * 4 + 3], 0, `${label} must keep transparent corners`);
      }
      assert.ok(metrics.opaquePixels >= 400, `${label} lacks visible authored detail`);
      assert.ok(metrics.left >= 8 && metrics.right >= 8, `${label} needs safe side gutters`);
      assert.ok(metrics.top >= 8 && metrics.bottom >= 8, `${label} needs safe vertical gutters`);
      assert.ok(alphaLevels.size >= 12, `${label} needs enough alpha gradation for a clean glow`);
      assert.ok(visibleRgb.size >= 96, `${label} needs enough authored RGB detail`);
      framePixelHashes.push(createHash("sha256").update(pixels).digest("hex"));
    }
  }
  assert.equal(new Set(framePixelHashes).size, 8, "all eight atlas frames must be distinct");
  assert.equal(remainingMagenta, 0, `${echoPath} retains its ImageGen chroma key`);

  assert.equal(vfx.SILENT_LIBRARIAN_ECHO_VFX_PATH, "/assets/effects/silent-librarian-echo-v4.png");
  assert.equal(vfx.silentLibrarianEchoStampCount(44), 12);
  assert.equal(vfx.silentLibrarianEchoStampCount(340), 12);
  assert.equal(vfx.silentLibrarianWindupRadius(1), 44);

  const layoutOptions = { progress: 0.375, seed: 71, dissolveProgress: 0 };
  const openingLayout = vfx.silentLibrarianEchoStampLayout({ radius: 44, ...layoutOptions });
  const expandedLayout = vfx.silentLibrarianEchoStampLayout({ radius: 340, ...layoutOptions });
  assert.equal(openingLayout.length, 12);
  assert.equal(expandedLayout.length, 12);
  for (let index = 0; index < 12; index += 1) {
    const openingStamp = openingLayout[index];
    const expandedStamp = expandedLayout[index];
    assert.equal(openingStamp.slotIndex, index);
    assert.equal(expandedStamp.slotIndex, index);
    assert.equal(expandedStamp.angle, openingStamp.angle, "radius must not replace slot identity");
    assert.equal(openingStamp.size, 128);
    assert.equal(expandedStamp.size, 128);
    assert.equal(expandedStamp.frameIndex, openingStamp.frameIndex);
    assert.equal(expandedStamp.nextFrameIndex, openingStamp.nextFrameIndex);
    assert.equal(expandedStamp.frameBlend, openingStamp.frameBlend);
    assert.ok(
      Math.hypot(expandedStamp.x, expandedStamp.y) > Math.hypot(openingStamp.x, openingStamp.y) + 280,
      "the same slot should travel outward as the ring radius grows",
    );
  }

  for (const progress of [0, 0.125, 0.375, 0.625, 0.999, 1]) {
    const stamps = vfx.silentLibrarianEchoStampLayout({ radius: 180, progress, seed: 83 });
    assert.equal(stamps.length, 12);
    for (const stamp of stamps) {
      assert.ok(stamp.frameIndex >= 4 && stamp.frameIndex <= 7, "wave frames belong to row two");
      assert.ok(
        stamp.nextFrameIndex === stamp.frameIndex || stamp.nextFrameIndex === stamp.frameIndex + 1,
        "crossfades may only use adjacent wave frames",
      );
      assert.ok(stamp.frameBlend >= 0 && stamp.frameBlend <= 1);
      assert.equal(stamp.size, 128);
    }
  }
  const blendedWave = vfx.silentLibrarianEchoStampLayout({
    radius: 180,
    progress: 0.375,
    seed: 83,
  });
  assert.ok(blendedWave.every(({ frameIndex, nextFrameIndex }) => frameIndex === 5 && nextFrameIndex === 6));
  assert.ok(blendedWave.every(({ frameBlend }) => frameBlend > 0 && frameBlend < 1));

  for (const progress of [0, 0.125, 0.375, 0.625, 1]) {
    const bookPlan = vfx.silentLibrarianWindupBookPlan(progress);
    assert.equal(bookPlan.length, 2, "book stages must crossfade at one centered location");
    assert.ok(bookPlan.every(({ frameIndex }) => frameIndex >= 0 && frameIndex <= 3));
    assert.ok(bookPlan.every(({ size }) => size === 128));
    assert.ok(
      bookPlan[1].frameIndex === bookPlan[0].frameIndex ||
        bookPlan[1].frameIndex === bookPlan[0].frameIndex + 1,
      "book crossfades may only use adjacent top-row frames",
    );
    assert.ok(Math.abs(bookPlan[0].alpha + bookPlan[1].alpha - 1) < 1e-12);
  }

  assert.equal(buildReport.version, 4);
  assert.equal(buildReport.format, "RGBA PNG");
  assert.deepEqual(buildReport.sheet, {
    columns: 4,
    rows: 2,
    cellSize: [128, 128],
    size: [512, 256],
  });
  assert.deepEqual(
    buildReport.frames.map(({ role }) => role),
    [
      "sealed-grimoire",
      "igniting-clasps",
      "opening-pages",
      "released-rune-pulse",
      "compact-echo-wedge",
      "unfurling-echo-slash",
      "splitting-page-slivers",
      "dissipating-glyph-fragments",
    ],
  );
  assert.deepEqual(buildReport.frames.map(({ index }) => index), [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(buildReport.frames.map(({ row }) => row), [0, 0, 0, 0, 1, 1, 1, 1]);
  assert.deepEqual(buildReport.frames.map(({ column }) => column), [0, 1, 2, 3, 0, 1, 2, 3]);
  assert.equal(new Set(buildReport.frames.map(({ pixelHash }) => pixelHash)).size, 8);
  assert.ok(
    buildReport.frames.every(({ alphaLevels }) =>
      (Array.isArray(alphaLevels) ? alphaLevels.length : alphaLevels) >= 12,
    ),
  );
  assert.ok(buildReport.frames.every(({ uniqueVisibleRgb }) => uniqueVisibleRgb >= 96));
  assert.equal(
    createHash("sha256").update(echoBytes).digest("hex"),
    buildReport.outputSha256,
  );
  for (const [relativePath, expectedHash] of [
    [buildReport.sourceOriginal, buildReport.sourceOriginalSha256],
    [buildReport.sourceKeyed, buildReport.sourceKeyedSha256],
    [buildReport.promptMetadata, buildReport.promptMetadataSha256],
  ]) {
    const bytes = await readFile(path.join(root, relativePath));
    assert.equal(createHash("sha256").update(bytes).digest("hex"), expectedHash, relativePath);
  }
  assert.equal(promptMetadata.tool, "image_gen.imagegen built-in");
  assert.ok(promptMetadata.generationPrompt.length >= 500);
  assert.match(builderSource, /sealed-grimoire/);
  assert.match(builderSource, /dissipating-glyph-fragments/);

  assert.match(source, /walkSilentLibrarian:\s*["']\/assets\/walk\/silent-librarian-walk-v2\.png["']/);
  assert.match(source, /silentLibrarianEcho:\s*SILENT_LIBRARIAN_ECHO_VFX_PATH/);
  assert.match(source, /drawSilentLibrarianEchoVfx\(\{/);
  assert.match(vfxSource, /const SHEET_COLUMNS = 4;/);
  assert.match(vfxSource, /const SHEET_ROWS = 2;/);
  assert.match(vfxSource, /const SHEET_CELL_SIZE = 128;/);
  assert.match(vfxSource, /const WAVE_SLOT_COUNT = 12;/);
  assert.match(vfxSource, /const bookX = x;/);
  assert.match(vfxSource, /stamp\.nextFrameIndex/);
  assert.match(vfxSource, /1 - stamp\.frameBlend/);
  assert.match(vfxSource, /stamp\.frameBlend/);
  assert.match(vfxSource, /context\.globalCompositeOperation = ["']source-over["']/);
  assert.match(vfxSource, /context\.imageSmoothingEnabled = false/);
  assert.match(vfxSource, /context\.shadowBlur = 0/);
  assert.doesNotMatch(vfxSource, /\bMAX_WAVE_STAMPS\b|\b70\b|x\s*\+\s*50/);
  assert.doesNotMatch(vfxSource, /drawSize|radius\s*\*\s*2\.18/);
  assert.doesNotMatch(vfxSource, /context\.globalCompositeOperation = ["']lighter["']/);
  const floorDrawIndex = source.indexOf("drawSilentLibrarianEchoVfx({");
  const actorDrawIndex = source.indexOf("const sortedEnemies = [...world.enemies]", floorDrawIndex);
  assert.ok(floorDrawIndex >= 0 && actorDrawIndex > floorDrawIndex);
  assert.match(source, /enemy\.kind === SILENT_LIBRARIAN_KIND[\s\S]{0,5000}?sweptEchoRingHits/);
  assert.match(source, /silentLibrarianCount >= SILENT_LIBRARIAN_MAX_PER_ROOM/);
  assert.match(source, /enemy\.kind !== SILENT_LIBRARIAN_KIND/);
});

test("walk sprites preserve each authored atlas-cell aspect ratio", async () => {
  const [spriteFrame, source] = await Promise.all([
    importTypeScriptModule("app/sprite-frame.ts"),
    readFile(path.join(root, "app/GameCanvas.tsx"), "utf8"),
  ]);

  assert.deepEqual(
    spriteFrame.fitSpriteFrameWithin(256, 192, 136, 158),
    { width: 136, height: 102 },
    "the Silent Librarian must not be stretched from a 4:3 cell into a tall box",
  );
  assert.deepEqual(
    spriteFrame.fitSpriteFrameWithin(256, 192, 192, 144),
    { width: 192, height: 144 },
    "an already-correct 4:3 render must remain unchanged",
  );
  const marginSeverer = spriteFrame.fitSpriteFrameWithin(256, 192, 140, 154);
  assert.equal(marginSeverer.width, 140);
  assert.equal(marginSeverer.height, 105);
  assert.deepEqual(spriteFrame.fitSpriteFrameWithin(0, 192, 136, 158), {
    width: 0,
    height: 0,
  });

  const legacyRendererStart = source.indexOf("const drawSprite = (");
  const rendererStart = source.indexOf("const drawWalkSprite = (");
  const rendererEnd = source.indexOf("const drawEffectSprite = (", rendererStart);
  const legacyRenderer = source.slice(legacyRendererStart, rendererStart);
  const renderer = source.slice(rendererStart, rendererEnd);
  assert.match(
    legacyRenderer,
    /fitSpriteFrameWithin\(\s*crop\[2\],\s*crop\[3\],\s*width,\s*height/,
    "legacy fallback crops must fit their bounds without independent-axis stretching",
  );
  assert.match(legacyRenderer, /fittedFrame\.width,\s*fittedFrame\.height/);
  assert.match(renderer, /fitSpriteFrameWithin\(\s*sourceWidth,\s*sourceHeight,\s*width,\s*height/);
  assert.match(renderer, /fittedFrame\.width,\s*fittedFrame\.height/);
  assert.match(renderer, /context\.imageSmoothingEnabled = false/);
  assert.doesNotMatch(
    renderer,
    /y - height \* 0\.78,\s*width,\s*height/,
    "the destination rectangle must never distort a walk cell independently per axis",
  );
});

test("the Margin Severer uses eight aspect-safe authored sever stages instead of stretching one image", async () => {
  const [balance, vfx, source, entrySource, vfxSource, builderSource, buildText, promptText] = await Promise.all([
    importTypeScriptModule("app/enemy-balance.ts"),
    importTypeScriptModule("app/margin-severer-vfx.ts"),
    readFile(path.join(root, "app/GameCanvas.tsx"), "utf8"),
    readFile(path.join(root, "app/GameEntryFlow.tsx"), "utf8"),
    readFile(path.join(root, "app/margin-severer-vfx.ts"), "utf8"),
    readFile(path.join(root, "scripts/build_margin_sever_line_v3.py"), "utf8"),
    readFile(path.join(root, "public/assets/effects/margin-sever-line-v3.build.json"), "utf8"),
    readFile(
      path.join(root, "asset-sources/imagegen/margin-sever-line-storyboard-v3.prompt.json"),
      "utf8",
    ),
  ]);
  const walkPath = "public/assets/walk/margin-severer-walk-v2.png";
  const linePath = "public/assets/effects/margin-sever-line-v3.png";
  const [walk, lineBytes] = await Promise.all([
    readFile(path.join(root, walkPath)).then((png) => decodeRgbaPng(png, walkPath)),
    readFile(path.join(root, linePath)),
  ]);
  const lineEffect = decodeRgbaPng(lineBytes, linePath);
  const buildReport = JSON.parse(buildText);
  const promptMetadata = JSON.parse(promptText);

  assert.deepEqual([walk.width, walk.height], [1024, 1536]);
  assert.equal(walk.width % 4, 0, "the walk sheet must retain four animation columns");
  for (let row = 0; row < 8; row += 1) {
    for (let column = 0; column < 4; column += 1) {
      const label = `margin severer row ${row} column ${column}`;
      const metrics = alphaCellMetrics(walk, column, row, 4, 8, label);
      assert.ok(metrics.opaquePixels >= 5_000, `${label} lacks a complete silhouette`);
      assert.ok(metrics.width >= 90 && metrics.height >= 155, `${label} is undersized`);
      assert.ok(metrics.left >= 16 && metrics.right >= 16, `${label} needs horizontal crop safety`);
      assert.ok(metrics.top >= 6 && metrics.bottom >= 8, `${label} needs vertical crop safety`);
    }
  }
  assert.equal(countGreenChromaPixels(walk), 0, `${walkPath} retains green-screen contamination`);

  assert.match(
    source,
    /walkMarginSeverer:\s*["']\/assets\/walk\/margin-severer-walk-v2\.png["']/,
    "the authored walk sheet must be preloaded",
  );
  assert.match(
    source,
    /const MARGIN_SEVERER_DIRECTION_FRAMES = makeDirectionFrames\(\[0, 1, 2, 3, 4, 5, 6, 7\]\);/,
    "the v2 atlas must use all eight authored direction rows",
  );
  assert.match(
    source,
    /MARGIN_SEVERER_DIRECTION_FRAMES,[\s\S]{0,520}?makeDirectionFrames\(\[0, 1, 2, 3, 4, 5, 6, 7\]\),[\s\S]{0,320}?makeDirectionFrames\(\[0, 1, 2, 3, 4, 5, 6, 7\]\),[\s\S]{0,40}?\];/,
    "kind 8 must own the ninth enemy direction-table slot",
  );
  assert.doesNotMatch(source, /MARGIN_SEVERER_WALK_ROW_CROPS/);

  assert.deepEqual([lineEffect.width, lineEffect.height], [1536, 640]);
  assert.equal(lineEffect.width % 2, 0);
  assert.equal(lineEffect.height % 4, 0);
  for (let row = 0; row < 4; row += 1) {
    for (let column = 0; column < 2; column += 1) {
      const label = `margin sever line row ${row} column ${column}`;
      const metrics = alphaCellMetrics(lineEffect, column, row, 2, 4, label);
      assert.ok(metrics.opaquePixels >= 7_000, `${label} lacks its authored line effect`);
      assert.ok(metrics.width >= 727, `${label} must retain the fixed endpoint span`);
      assert.ok(metrics.height >= 90, `${label} is too thin to remain legible in play`);
      assert.ok(metrics.left >= 19 && metrics.right >= 19, `${label} needs safe horizontal padding`);
      assert.ok(metrics.top >= 12 && metrics.bottom >= 12, `${label} needs safe vertical padding`);
      assert.ok(
        Math.abs(metrics.centerX - (metrics.cellWidth - 1) / 2) <= 0.5,
        `${label} drifts horizontally during playback`,
      );
      assert.ok(
        Math.abs(metrics.centerY - (metrics.cellHeight - 1) / 2) <= 0.5,
        `${label} drifts vertically during playback`,
      );
    }
  }
  assert.equal(
    countGreenChromaPixels(lineEffect),
    0,
    `${linePath} retains green-screen contamination`,
  );
  for (const [x, y] of [
    [0, 0],
    [lineEffect.width - 1, 0],
    [0, lineEffect.height - 1],
    [lineEffect.width - 1, lineEffect.height - 1],
  ]) {
    assert.equal(lineEffect.pixels[(y * lineEffect.width + x) * 4 + 3], 0);
  }

  let remainingMagenta = 0;
  const alphaLevels = new Set();
  for (let index = 0; index < lineEffect.pixels.length; index += 4) {
    const red = lineEffect.pixels[index];
    const green = lineEffect.pixels[index + 1];
    const blue = lineEffect.pixels[index + 2];
    const alpha = lineEffect.pixels[index + 3];
    alphaLevels.add(alpha);
    if (alpha > 8 && red > 180 && blue > 180 && green + 70 < Math.min(red, blue)) {
      remainingMagenta += 1;
    }
  }
  assert.equal(remainingMagenta, 0, `${linePath} retains its ImageGen chroma key`);
  assert.deepEqual([...alphaLevels].sort((left, right) => left - right), [
    0,
    48,
    96,
    144,
    192,
    224,
    255,
  ]);

  assert.equal(vfx.MARGIN_SEVERER_VFX_PATH, "/assets/effects/margin-sever-line-v3.png");
  assert.deepEqual(
    [vfx.MARGIN_SEVERER_VFX_COLUMNS, vfx.MARGIN_SEVERER_VFX_ROWS],
    [2, 4],
  );
  assert.deepEqual(
    [0, 0.34, 0.67, 0.999].map((progress) =>
      vfx.marginSeverVfxFrameIndex("inscribe", progress),
    ),
    [0, 1, 2, 2],
  );
  assert.deepEqual(
    [0, 0.2, 0.4, 0.6, 0.8, 0.999].map((progress) =>
      vfx.marginSeverVfxFrameIndex("sever", progress),
    ),
    [3, 4, 5, 6, 7, 7],
  );
  const layout = vfx.marginSeverVfxLayout(balance.MARGIN_SEVERER_LINE_LENGTH);
  assert.ok(Math.abs(layout.width / 768 - layout.height / 160) < 1e-12);
  assert.ok(Math.abs(layout.width * (728 / 768) - balance.MARGIN_SEVERER_LINE_LENGTH) < 1e-9);
  assert.ok(layout.height > 110 && layout.height < 116, "the native wide cell should stay legible");
  const inscribeGlowStart = vfx.marginSeverVfxGlowStyle("inscribe", 0);
  const inscribeGlowPeak = vfx.marginSeverVfxGlowStyle("inscribe", 0.999);
  const severGlowPeak = vfx.marginSeverVfxGlowStyle("sever", 0.4);
  const severGlowDissolve = vfx.marginSeverVfxGlowStyle("sever", 0.999);
  assert.equal(inscribeGlowStart.color, "#f2c36f");
  assert.equal(severGlowPeak.color, "#ddfbff");
  assert.ok(inscribeGlowPeak.blur > inscribeGlowStart.blur);
  assert.ok(inscribeGlowPeak.alpha > inscribeGlowStart.alpha);
  assert.ok(severGlowPeak.blur > inscribeGlowPeak.blur);
  assert.ok(severGlowPeak.alpha > inscribeGlowPeak.alpha);
  assert.ok(severGlowDissolve.blur < severGlowPeak.blur);
  assert.ok(severGlowDissolve.alpha < severGlowPeak.alpha);
  for (const style of [
    inscribeGlowStart,
    inscribeGlowPeak,
    severGlowPeak,
    severGlowDissolve,
  ]) {
    assert.ok(Number.isFinite(style.blur) && style.blur > 0);
    assert.ok(Number.isFinite(style.alpha) && style.alpha > 0 && style.alpha < 1);
  }

  assert.deepEqual(buildReport.sheet, {
    columns: 2,
    rows: 4,
    size: [1536, 640],
    cell: [768, 160],
  });
  assert.deepEqual(buildReport.phaseFrames, { inscribe: [0, 1, 2], sever: [3, 4, 5, 6, 7] });
  assert.equal(new Set(buildReport.frames.map(({ pixelHash }) => pixelHash)).size, 8);
  assert.ok(
    buildReport.frames[5].hotPixelCentroidX > buildReport.frames[4].hotPixelCentroidX + 250,
    "the compact cut-front must visibly travel from left to right",
  );
  assert.ok(buildReport.pipeline.preserveAspectRatio);
  assert.ok(buildReport.pipeline.centerEveryFrame);
  assert.equal(
    createHash("sha256").update(lineBytes).digest("hex"),
    buildReport.outputSha256,
  );
  for (const [relativePath, expectedHash] of [
    [buildReport.sourceOriginal, buildReport.sourceOriginalSha256],
    [buildReport.sourceKeyed, buildReport.sourceKeyedSha256],
    [buildReport.promptMetadata, buildReport.promptMetadataSha256],
  ]) {
    const bytes = await readFile(path.join(root, relativePath));
    assert.equal(createHash("sha256").update(bytes).digest("hex"), expectedHash, relativePath);
  }
  assert.equal(promptMetadata.tool, "image_gen.imagegen built-in");
  assert.match(promptMetadata.prompt, /must not be stretched/i);
  assert.match(promptMetadata.prompt, /never a square image squeezed wide/i);
  assert.match(builderSource, /fitted into a wide output cell without changing its authored aspect ratio/i);
  assert.match(vfxSource, /MARGIN_SEVERER_VFX_CELL_WIDTH = 768/);
  assert.match(vfxSource, /MARGIN_SEVERER_VFX_CELL_HEIGHT = 160/);
  assert.match(source, /marginSeverLine:\s*MARGIN_SEVERER_VFX_PATH/);
  const rendererStart = source.indexOf("const drawMarginSeverLine = (");
  const rendererEnd = source.indexOf("const drawTimeRiftSprite = (", rendererStart);
  const renderer = source.slice(rendererStart, rendererEnd);
  assert.match(renderer, /marginSeverVfxFrameIndex\(phase, progress\)/);
  assert.match(renderer, /const vfxLayout = marginSeverVfxLayout\(lineLength\);/);
  assert.match(renderer, /const glowStyle = marginSeverVfxGlowStyle\(phase, progress\);/);
  assert.match(renderer, /const sourceWidth = image\.naturalWidth \/ MARGIN_SEVERER_VFX_COLUMNS;/);
  assert.match(renderer, /const sourceHeight = image\.naturalHeight \/ MARGIN_SEVERER_VFX_ROWS;/);
  assert.match(renderer, /context\.imageSmoothingEnabled = false/);
  const texturePassIndex = renderer.indexOf('context.globalCompositeOperation = "source-over";');
  const glowPassIndex = renderer.indexOf('context.globalCompositeOperation = "lighter";');
  assert.ok(texturePassIndex >= 0 && glowPassIndex > texturePassIndex);
  assert.match(renderer, /context\.shadowColor = ["']transparent["'];\s*context\.shadowBlur = 0;\s*drawFrame\(\);/);
  assert.match(
    renderer,
    /context\.globalAlpha = alpha \* glowStyle\.alpha;\s*context\.globalCompositeOperation = ["']lighter["'];\s*context\.shadowColor = glowStyle\.color;\s*context\.shadowBlur = glowStyle\.blur;/,
  );
  assert.match(renderer, /context\.shadowOffsetX = 0;\s*context\.shadowOffsetY = 0;/);
  assert.equal(
    (renderer.match(/drawFrame\(\);/g) ?? []).length,
    2,
    "the authored texture and additive glow must share the exact same frame geometry",
  );
  assert.doesNotMatch(renderer, /lineHeight|progress < 0\.88|atlasDrawWidth/);
  assert.match(
    renderer,
    /-vfxLayout\.width \/ 2,\s*-vfxLayout\.height \/ 2,\s*vfxLayout\.width,\s*vfxLayout\.height/,
    "the renderer must use one uniform scale for both destination axes",
  );

  const showcaseStart = source.indexOf("const spawnLocalEnemyVfxShowcase = () => {");
  const showcaseEnd = source.indexOf("const spawnCombatEffect = (", showcaseStart);
  assert.ok(showcaseStart >= 0 && showcaseEnd > showcaseStart);
  const showcase = source.slice(showcaseStart, showcaseEnd);
  assert.match(source, /get\(["']enemyVfxShowcase["']\)/);
  assert.match(showcase, /enemyVfxShowcaseMode !== ["']margin-severer["']/);
  assert.match(showcase, /enemyVfxShowcaseMode !== ["']silent-librarian["']/);
  assert.match(showcase, /enemyVfxShowcaseMode === ["']silent-librarian["']/);
  assert.match(
    showcase,
    /forbiddenIndexerShowcase\s*\? FORBIDDEN_INDEXER_KIND\s*:\s*silentLibrarianShowcase\s*\? SILENT_LIBRARIAN_KIND\s*:\s*MARGIN_SEVERER_KIND/,
  );
  assert.match(showcase, /silentLibrarianShowcase \? ["']echoWindup["'] : ["']inscribe["']/);
  assert.match(
    showcase,
    /silentLibrarianShowcase\s*\? SILENT_LIBRARIAN_TELEGRAPH_SECONDS\s*:\s*MARGIN_SEVERER_TELEGRAPH_SECONDS/,
  );
  assert.match(showcase, /enemy\.damage = 0;/);
  assert.doesNotMatch(showcase, /localStorage|writeSaveSlot|removeItem|clear\(/);
  assert.match(source, /spawnLocalLootVfxShowcase\(\);\s*spawnLocalEnemyVfxShowcase\(\);/);

  const recoveryLoopStart = source.indexOf("const loopLocalSilentLibrarianShowcase =");
  const recoveryLoopEnd = source.indexOf("let movement = 1;", recoveryLoopStart);
  assert.ok(recoveryLoopStart >= 0 && recoveryLoopEnd > recoveryLoopStart);
  const recoveryLoop = source.slice(recoveryLoopStart, recoveryLoopEnd);
  assert.match(recoveryLoop, /enemyVfxShowcaseMode === ["']silent-librarian["']/);
  assert.match(recoveryLoop, /\? ["']echoWindup["']\s*:\s*["']orbit["']/);
  assert.match(
    recoveryLoop,
    /\? SILENT_LIBRARIAN_TELEGRAPH_SECONDS\s*:\s*2\.8/,
    "the local Silent Librarian showcase must replay after recovery",
  );
  assert.match(recoveryLoop, /enemy\.patternHit = false;/);

  assert.match(entrySource, /requestedEnemyMode === ["']margin-severer["']/);
  assert.match(entrySource, /requestedEnemyMode === ["']silent-librarian["']/);
  assert.match(entrySource, /setLocalEnemyVfxShowcase\(requestedEnemyMode\)/);
  assert.match(
    entrySource,
    /localEnemyVfxShowcase\s*\?\s*["']local-enemy-vfx-showcase["']/,
  );
  assert.match(
    entrySource,
    /<GameCanvas[\s\S]{0,180}?localEnemyVfxShowcase=\{localEnemyVfxShowcase \?\? undefined\}[\s\S]{0,180}?\/>/,
    "localhost QA must bypass character selection without creating a save slot",
  );
  const transientStartIndex = source.indexOf(
    "if (!isLocalVfxShowcase || initialSaveSlotHandledRef.current) return;",
  );
  const transientEndIndex = source.indexOf(
    "if (isLocalVfxShowcase) return;",
    transientStartIndex,
  );
  assert.ok(transientStartIndex >= 0 && transientEndIndex > transientStartIndex);
  const transientStart = source.slice(transientStartIndex, transientEndIndex);
  assert.match(transientStart, /playerRef\.current = makePlayer\(\);/);
  assert.match(transientStart, /worldRef\.current = makeWorld\(/);
  assert.match(transientStart, /setGameMode\(["']playing["']\);/);
  assert.doesNotMatch(
    transientStart,
    /loadSave|startNewRun|writeSaveSlot|removeSaveSlot|migrateLegacySave|localStorage/,
    "the visual QA boot path must stay entirely in memory",
  );
  assert.match(
    source,
    /const saveCheck = isLocalVfxShowcase\s*\? null\s*:\s*window\.setTimeout/,
    "the transient showcase must not run save migration",
  );
});

test("the memory-stitched armor icon occupies its ten-column atlas cell with transparent gutters", async () => {
  const equipment = await importTypeScriptModule("app/equipment.ts");
  const baseName = "기억 봉합의";
  assert.equal(equipment.GEAR_BASE_NAMES.armor[3], baseName);
  assert.equal(equipment.gearIconIndex("armor", baseName), 3 * 10 + 4);

  const relativePath = "public/assets/equipment/equipment-types-v4.png";
  const image = decodeRgbaPng(await readFile(path.join(root, relativePath)), relativePath);
  assert.deepEqual([image.width, image.height], [2800, 2800]);
  assertAlphaCellGutter(image, 4, 3, 10, 10, "memory-stitched armor");
});

test("the v4 equipment atlas centers every cell and removes cross-row source fragments", async () => {
  const relativePath = "public/assets/equipment/equipment-types-v4.png";
  const image = decodeRgbaPng(await readFile(path.join(root, relativePath)), relativePath);
  assert.deepEqual([image.width, image.height], [2800, 2800]);

  const maximumComponentsByColumn = new Map([
    [1, 1], // offhand
    [3, 2], // paired shoulders
    [5, 2], // paired gloves
    [6, 1], // belt
    [7, 2], // paired legs
  ]);

  for (let row = 0; row < 10; row += 1) {
    for (let column = 0; column < 10; column += 1) {
      const label = `equipment row ${row} column ${column}`;
      const metrics = alphaCellMetrics(image, column, row, 10, 10, label);
      const expectedCenter = (metrics.cellWidth - 1) / 2;
      assert.ok(metrics.left >= 28 && metrics.right >= 28, `${label} needs horizontal crop safety`);
      assert.ok(metrics.top >= 28 && metrics.bottom >= 28, `${label} needs vertical crop safety`);
      assert.ok(Math.abs(metrics.centerX - expectedCenter) <= 1.5, `${label} drifts horizontally`);
      assert.ok(Math.abs(metrics.centerY - expectedCenter) <= 1.5, `${label} drifts vertically`);

      let alphaWeight = 0;
      let weightedX = 0;
      let weightedY = 0;
      const cellLeft = column * metrics.cellWidth;
      const cellTop = row * metrics.cellHeight;
      for (let y = 0; y < metrics.cellHeight; y += 1) {
        for (let x = 0; x < metrics.cellWidth; x += 1) {
          const alpha = image.pixels[((cellTop + y) * image.width + cellLeft + x) * 4 + 3];
          alphaWeight += alpha;
          weightedX += x * alpha;
          weightedY += y * alpha;
        }
      }
      const visualDistance = Math.hypot(
        weightedX / alphaWeight - expectedCenter,
        weightedY / alphaWeight - expectedCenter,
      );
      if (column !== 0) {
        assert.ok(
          visualDistance <= 19,
          `${label} visual mass drifts ${visualDistance.toFixed(2)}px, suggesting a retained row fragment`,
        );
      }

      const maximumComponents = maximumComponentsByColumn.get(column);
      if (maximumComponents === undefined) continue;
      const components = alphaCellComponents(image, column, row, 10, 10);
      const significant = components.filter((count) => count >= components[0] * 0.075);
      assert.ok(
        significant.length <= maximumComponents,
        `${label} retains ${significant.length} major components; expected at most ${maximumComponents}`,
      );
      if (significant.length === 2) {
        assert.ok(
          significant[1] >= significant[0] * 0.35,
          `${label} retains a small detached source fragment`,
        );
      }
    }
  }
  assert.equal(countGreenChromaPixels(image), 0, `${relativePath} retains green spill`);
});

test("the oath shield and memory-weaver gloves finish with tapered lower silhouettes", async () => {
  const equipment = await importTypeScriptModule("app/equipment.ts");
  const relativePath = "public/assets/equipment/equipment-types-v4.png";
  const atlasBytes = await readFile(path.join(root, relativePath));
  const image = decodeRgbaPng(atlasBytes, relativePath);
  const report = JSON.parse(
    await readFile(
      path.join(root, "asset-sources/imagegen/equipment-icon-repair-v1/build-report.json"),
      "utf8",
    ),
  );
  const builderSource = await readFile(
    path.join(root, "scripts/build_equipment_icon_repairs_v1.py"),
    "utf8",
  );
  const cases = [
    {
      label: "심홍 맹세방패",
      slot: "offhand",
      baseName: "심홍 맹세방패",
      baseRow: 4,
      column: 1,
      row: 4,
      iconIndex: 41,
      seed: "local-loot-crop-shield-14",
      rarity: "common",
      originalHash: "329de4514bfef7f3c44b3fefca70677e42d96176745ab86eba427cd6ee70c41a",
      outputHash: "b413874f5d35517c4ad279ea83facefc513bcffe41517bed621a207837187d92",
    },
    {
      label: "각인된 기억직조 장갑",
      slot: "gloves",
      baseName: "기억직조 장갑",
      baseRow: 2,
      column: 5,
      row: 2,
      iconIndex: 25,
      seed: "local-loot-crop-gloves-0",
      rarity: "magic",
      originalHash: "7b7666d107739b67bcc0246253c52369bf9d20bd308f7c1f57b8aaf404902274",
      outputHash: "0adc14adc96de0d513c0d3667a6b7760007dcd71af5be738c4435d1f3e26b896",
    },
  ];

  assert.equal(report.builder, "scripts/build_equipment_icon_repairs_v1.py");
  assert.equal(report.generator, "OpenAI built-in image_gen");
  assert.equal(report.unchangedCellCount, 98);
  assert.equal(report.inputValidation, "full-file SHA-256 before decode");
  assert.deepEqual(report.acceptedInputAtlasSha256.toSorted(), [
    report.baselineAtlasSha256,
    report.outputAtlasSha256,
  ].toSorted());
  assert.equal(
    report.outputAtlasSha256,
    createHash("sha256").update(atlasBytes).digest("hex"),
    "the provenance report must describe the shipped atlas bytes",
  );
  const inputHashValidation = builderSource.indexOf(
    "input_atlas_sha256 = sha256_file(atlas_path)",
  );
  const atlasDecode = builderSource.indexOf('atlas = Image.open(atlas_path).convert("RGBA")');
  const outputHashValidation = builderSource.indexOf(
    "output_atlas_sha256 = sha256_file(temporary_path)",
  );
  const atlasReplacement = builderSource.indexOf("temporary_path.replace(atlas_path)");
  assert.ok(
    inputHashValidation >= 0 &&
      inputHashValidation < atlasDecode &&
      outputHashValidation > atlasDecode &&
      outputHashValidation < atlasReplacement,
    "the repair builder must reject full-atlas drift before decode and verify output before replace",
  );

  for (const repair of cases) {
    assert.equal(equipment.GEAR_BASE_NAMES[repair.slot][repair.baseRow], repair.baseName);
    assert.equal(equipment.gearIconIndex(repair.slot, repair.baseName), repair.iconIndex);
    assert.deepEqual(equipment.gearIconCell(repair.iconIndex), {
      column: repair.column,
      row: repair.row,
    });
    const showcaseItem = equipment.rollGear(repair.seed, {
      level: 1,
      slot: repair.slot,
      rarity: repair.rarity,
    });
    assert.equal(showcaseItem.baseName, repair.baseName);
    assert.equal(showcaseItem.iconIndex, repair.iconIndex);
    assert.equal(equipment.formatGearDisplayName(showcaseItem), repair.label);

    const cell = rgbaCellBuffer(image, repair.column, repair.row, 10, 10, repair.label);
    const cellHash = createHash("sha256").update(cell).digest("hex");
    assert.notEqual(cellHash, repair.originalHash, `${repair.label} regressed to the cropped source`);
    assert.equal(cellHash, repair.outputHash, `${repair.label} repair pixels drifted`);

    const rowWidths = [];
    for (let y = 0; y < 280; y += 1) {
      let width = 0;
      for (let x = 0; x < 280; x += 1) {
        if (cell[(y * 280 + x) * 4 + 3] >= 42) width += 1;
      }
      rowWidths.push(width);
    }
    let finalRow = rowWidths.length - 1;
    while (finalRow >= 0 && rowWidths[finalRow] === 0) finalRow -= 1;
    const maximumRowWidth = Math.max(...rowWidths);
    const terminalRows = rowWidths.slice(finalRow - 5, finalRow + 1);
    assert.ok(finalRow >= 245, `${repair.label} no longer reaches its authored lower point`);
    assert.ok(
      rowWidths[finalRow] <= maximumRowWidth * 0.08,
      `${repair.label} ends in a wide horizontal cutoff instead of a point`,
    );
    for (let index = 1; index < terminalRows.length; index += 1) {
      assert.ok(
        terminalRows[index] <= terminalRows[index - 1],
        `${repair.label} lower silhouette does not taper continuously`,
      );
    }
  }
});

test("equipment exposes one hundred base-name icons in a ten-column by ten-row atlas", async () => {
  const equipment = await importTypeScriptModule("app/equipment.ts");

  assert.deepEqual(equipment.EQUIPMENT_SLOTS, [
    "weapon",
    "offhand",
    "helm",
    "shoulders",
    "armor",
    "gloves",
    "belt",
    "legs",
    "boots",
    "relic",
  ]);
  assert.deepEqual(equipment.EQUIPMENT_SLOT_LABELS, {
    weapon: "무기",
    offhand: "보조 장비",
    helm: "투구",
    shoulders: "어깨",
    armor: "갑옷",
    gloves: "장갑",
    belt: "허리띠",
    legs: "각반",
    boots: "장화",
    relic: "유물",
  });
  assert.deepEqual(equipment.GEAR_RARITIES, [
    "common",
    "magic",
    "superior",
    "rare",
    "epic",
    "legendary",
    "mythic",
    "cosmic",
  ]);
  assert.equal(equipment.GEAR_ICON_COLUMNS, 10);
  assert.equal(equipment.GEAR_ICON_ROWS, 10);

  const bases = Object.values(equipment.GEAR_BASE_NAMES).flat();
  assert.equal(bases.length, 100, "ten slots need ten visual bases apiece");
  assert.equal(new Set(bases).size, 100, "every base name must identify one visual base");

  const mappedIndices = [];
  for (const [column, slot] of equipment.EQUIPMENT_SLOTS.entries()) {
    const slotBases = equipment.GEAR_BASE_NAMES[slot];
    assert.equal(slotBases.length, 10, `${slot} needs ten base names`);
    for (const [row, baseName] of slotBases.entries()) {
      const iconIndex = equipment.gearIconIndex(slot, baseName);
      assert.equal(iconIndex, row * 10 + column, `${slot}/${baseName} maps to the wrong atlas cell`);
      assert.deepEqual(equipment.gearIconCell(iconIndex), { column, row });
      mappedIndices.push(iconIndex);
    }
  }

  assert.deepEqual(
    mappedIndices.sort((a, b) => a - b),
    Array.from({ length: 100 }, (_, index) => index),
    "the ten-slot by ten-base atlas must map every cell exactly once",
  );

  assert.deepEqual(
    equipment.EQUIPMENT_SLOTS.map((slot) => equipment.GEAR_BASE_NAMES[slot].slice(8)),
    [
      ["종언의 제본침", "성운 절단검"],
      ["봉인된 최종장", "별무덤 천구의"],
      ["무문장의 가면", "무진성 관측면갑"],
      ["교정쇄 견갑", "혜성흔 견갑"],
      ["종언 편집자의 법의", "성운 방랑갑"],
      ["문장 봉합장갑", "유성 파지장갑"],
      ["제본사의 사슬띠", "항성고리 요대"],
      ["마지막 장의 각반", "은하 답파각"],
      ["여백 순례화", "별틈 도약화"],
      ["종언의 쉼표", "궤도 밖의 쉼표"],
    ],
  );

  assert.equal(equipment.LEGENDARY_POWER_IDS.length, 10);
  for (const slot of equipment.EQUIPMENT_SLOTS) {
    const powerId = equipment.LEGENDARY_POWER_BY_SLOT[slot];
    assert.ok(equipment.LEGENDARY_POWER_IDS.includes(powerId));
    assert.equal(equipment.LEGENDARY_POWERS[powerId].slot, slot);
  }
});

test("eight equipment rarities preserve exact restored drop odds and top-tier invariants", async () => {
  const equipment = await importTypeScriptModule("app/equipment.ts");
  assert.deepEqual(equipment.GEAR_RARITIES, [
    "common",
    "magic",
    "superior",
    "rare",
    "epic",
    "legendary",
    "mythic",
    "cosmic",
  ]);
  assert.deepEqual(Object.keys(equipment.GEAR_RARITY_META), equipment.GEAR_RARITIES);
  assert.deepEqual(Object.keys(equipment.GEAR_DROP_RARITY_WEIGHTS), ["normal", "elite", "boss"]);
  assert.deepEqual(equipment.GEAR_DROP_BASE_CHANCE, {
    normal: 0.19,
    elite: 0.68,
    boss: 1,
  });
  assert.deepEqual(equipment.GEAR_DROP_CHANCE_CAP, {
    normal: 0.72,
    elite: 0.95,
    boss: 1,
  });
  assert.equal(equipment.GEAR_DROP_SCAVENGER_CHANCE_CAP, 0.42);
  assert.equal(equipment.GEAR_DROP_SCAVENGER_CHANCE_PER_RANK, 0.008);

  const sourceKinds = ["normal", "elite", "boss"];
  for (const sourceKind of sourceKinds) {
    const weights = equipment.GEAR_DROP_RARITY_WEIGHTS[sourceKind];
    assert.deepEqual(Object.keys(weights), equipment.GEAR_RARITIES);
    assert.equal(
      Object.values(weights).reduce((sum, weight) => sum + weight, 0),
      95_000_000,
      `${sourceKind} weights must share the exact 95,000,000 denominator`,
    );
    for (const weight of Object.values(weights)) {
      assert.ok(Number.isSafeInteger(weight) && weight >= 0);
    }
  }

  for (const rarity of ["legendary", "mythic", "cosmic"]) {
    const expectedWeight = equipment.GEAR_DROP_RARITY_WEIGHTS.normal[rarity];
    for (const sourceKind of sourceKinds) {
      assert.equal(
        equipment.GEAR_DROP_RARITY_WEIGHTS[sourceKind][rarity],
        expectedWeight,
        `${rarity} conditional weight must not change by source`,
      );
    }
  }
  assert.equal(equipment.GEAR_DROP_RARITY_WEIGHTS.normal.legendary, 1_000_000);
  assert.equal(equipment.GEAR_DROP_RARITY_WEIGHTS.normal.mythic, 100_000);
  assert.equal(equipment.GEAR_DROP_RARITY_WEIGHTS.normal.cosmic, 2_000);

  const normalTotal = 95_000_000;
  assert.equal(
    equipment.GEAR_DROP_BASE_CHANCE.normal
      * equipment.GEAR_DROP_RARITY_WEIGHTS.normal.legendary
      / normalTotal,
    1 / 500,
  );
  assert.equal(
    equipment.GEAR_DROP_BASE_CHANCE.normal
      * equipment.GEAR_DROP_RARITY_WEIGHTS.normal.mythic
      / normalTotal,
    1 / 5_000,
  );
  assert.equal(
    equipment.GEAR_DROP_BASE_CHANCE.normal
      * equipment.GEAR_DROP_RARITY_WEIGHTS.normal.cosmic
      / normalTotal,
    1 / 250_000,
  );
  assert.ok(
    equipment.GEAR_DROP_RARITY_WEIGHTS.boss.epic
      > equipment.GEAR_DROP_RARITY_WEIGHTS.normal.epic,
    "boss loot must visibly bias toward upper tiers",
  );

  const topTierMidpoints = {
    legendary: (93_898_000 + 500_000) / normalTotal,
    mythic: (94_898_000 + 50_000) / normalTotal,
    cosmic: (94_998_000 + 1_000) / normalTotal,
  };
  for (const sourceKind of sourceKinds) {
    assert.equal(
      equipment.rollGearDropRarity(topTierMidpoints.legendary, sourceKind),
      "legendary",
    );
    assert.equal(
      equipment.rollGearDropRarity(topTierMidpoints.mythic, sourceKind),
      "mythic",
    );
    assert.equal(
      equipment.rollGearDropRarity(topTierMidpoints.cosmic, sourceKind),
      "cosmic",
    );
    for (const [rarity, midpoint] of Object.entries(topTierMidpoints)) {
      assert.equal(
        equipment.rollGearDropRarity(midpoint, sourceKind, 100),
        rarity,
        "gear-find may improve ordinary tiers but must not inflate top-tier odds",
      );
    }
  }

  assert.equal(
    Math.min(
      equipment.GEAR_DROP_CHANCE_CAP.normal,
      Math.min(
        equipment.GEAR_DROP_SCAVENGER_CHANCE_CAP,
        equipment.GEAR_DROP_BASE_CHANCE.normal
          + 999 * equipment.GEAR_DROP_SCAVENGER_CHANCE_PER_RANK,
      ) * 2,
    ),
    0.72,
    "normal drop chance must respect both the pre-find and final cap",
  );
});

test("character levels 1 through 19 use the exact onboarding rarity distribution", async () => {
  const [equipment, source] = await Promise.all([
    importTypeScriptModule("app/equipment.ts"),
    readFile(path.join(root, "app/equipment.ts"), "utf8"),
  ]);
  assert.equal(equipment.GEAR_EARLY_RARITY_LEVEL_CUTOFF, 20);
  assert.deepEqual(equipment.GEAR_EARLY_LEVEL_RARITY_WEIGHTS, {
    common: 250_000,
    magic: 250_000,
    superior: 200_000,
    rare: 150_000,
    epic: 100_000,
    legendary: 40_000,
    mythic: 9_999,
    cosmic: 1,
  });
  assert.equal(
    Object.values(equipment.GEAR_EARLY_LEVEL_RARITY_WEIGHTS).reduce(
      (sum, weight) => sum + weight,
      0,
    ),
    1_000_000,
  );

  const midpointByRarity = {
    common: 0.125,
    magic: 0.375,
    superior: 0.6,
    rare: 0.775,
    epic: 0.9,
    legendary: 0.97,
    mythic: 0.994_999_5,
    cosmic: 0.999_999_5,
  };
  for (const sourceKind of ["normal", "elite", "boss"]) {
    for (const [rarity, midpoint] of Object.entries(midpointByRarity)) {
      assert.equal(
        equipment.rollGearDropRarity(midpoint, sourceKind, 100, 19),
        rarity,
        `level 19 ${sourceKind} loot must preserve the exact ${rarity} share`,
      );
    }
  }

  for (const [boundary, expectedRarity] of [
    [0.25, "magic"],
    [0.5, "superior"],
    [0.7, "rare"],
    [0.85, "epic"],
    [0.95, "legendary"],
    [0.99, "mythic"],
    [0.999_999, "cosmic"],
  ]) {
    assert.equal(
      equipment.rollGearDropRarity(boundary, "normal", 0, 19),
      expectedRarity,
    );
  }

  assert.equal(
    equipment.rollGearDropRarity(0, "boss", 100, 19),
    "common",
    "early rarity odds must not be rewritten by source or gear find",
  );
  assert.equal(
    equipment.rollGearDropRarity(0, "boss", 0, 20),
    "rare",
    "level 20 must immediately restore the existing boss rarity table",
  );
  assert.match(
    source,
    /function chooseRarity[\s\S]{0,180}?level < GEAR_EARLY_RARITY_LEVEL_CUTOFF[\s\S]{0,160}?rarityFromWeights\(rng\(\), GEAR_EARLY_LEVEL_RARITY_WEIGHTS\)/,
    "unforced low-level gear rolls must use the same onboarding table",
  );
});

test("the expedition starting room guarantees one drop with the exact six-tier table", async () => {
  const [equipment, source] = await Promise.all([
    importTypeScriptModule("app/equipment.ts"),
    readFile(path.join(root, "app/GameCanvas.tsx"), "utf8"),
  ]);

  assert.deepEqual(equipment.FIRST_ROOM_GUARANTEED_RARITY_WEIGHTS, {
    common: 0,
    magic: 0,
    superior: 40_000,
    rare: 35_000,
    epic: 22_000,
    legendary: 2_000,
    mythic: 998,
    cosmic: 2,
  });
  assert.equal(
    Object.values(equipment.FIRST_ROOM_GUARANTEED_RARITY_WEIGHTS).reduce(
      (sum, weight) => sum + weight,
      0,
    ),
    100_000,
  );

  for (const [roll, rarity] of [
    [0, "superior"],
    [0.4, "rare"],
    [0.75, "epic"],
    [0.97, "legendary"],
    [0.99, "mythic"],
    [0.99998, "cosmic"],
  ]) {
    assert.equal(equipment.rollFirstRoomGuaranteedRarity(roll), rarity);
  }

  const finalEnemyContext = {
    clearedRoomCount: 0,
    roomX: 0,
    roomY: 0,
    roomHasDroppedGear: false,
    survivingEnemyCount: 0,
  };
  assert.equal(equipment.isExpeditionStartingRoom(finalEnemyContext), true);
  assert.equal(equipment.shouldForceFirstRoomGearDrop(finalEnemyContext), true);
  assert.equal(
    equipment.shouldForceFirstRoomGearDrop({
      ...finalEnemyContext,
      survivingEnemyCount: 1,
    }),
    false,
    "the fallback must wait for the last living enemy",
  );
  assert.equal(
    equipment.shouldForceFirstRoomGearDrop({
      ...finalEnemyContext,
      roomHasDroppedGear: true,
    }),
    false,
    "an earlier equipment drop must suppress the fallback",
  );
  assert.equal(
    equipment.shouldForceFirstRoomGearDrop({
      ...finalEnemyContext,
      clearedRoomCount: 1,
    }),
    false,
    "later rooms must keep their existing drop behavior",
  );
  assert.equal(
    equipment.shouldForceFirstRoomGearDrop({
      ...finalEnemyContext,
      roomX: 1,
    }),
    false,
    "only the origin room may receive the onboarding guarantee",
  );

  const killEnemy = source.match(
    /const killEnemy = \(enemy: Enemy\) => \{([\s\S]*?)\n\s*const firePlayerWeapon = \(\) => \{/,
  );
  assert.ok(killEnemy, "the enemy drop flow must remain present");
  assert.match(
    killEnemy[1],
    /const survivingEnemyCount = world\.enemies\.reduce\([\s\S]{0,220}?candidate\.hp > 0/,
    "the guarantee must count living enemies after the current damage frame",
  );
  assert.match(
    killEnemy[1],
    /lootRoll < gearDropChance \|\| forcedFirstRoomDrop/,
    "the last enemy fallback must join, not replace, ordinary drop rolls",
  );
  assert.match(
    killEnemy[1],
    /firstRoomDrop\s*\? rollFirstRoomGuaranteedRarity\(rarityRoll\)\s*:\s*regularRarity/,
    "every starting-room equipment drop must use the requested rarity table",
  );
  assert.match(
    killEnemy[1],
    /if \(firstRoomDrop\) firstRoomGearDroppedRef\.current = true;/,
    "a spawned item must permanently satisfy the current room's guarantee",
  );
});

test("GameCanvas applies the exact restored source, scavenger, and gear-find drop formula", async () => {
  const source = await readFile(path.join(root, "app/GameCanvas.tsx"), "utf8");
  assert.match(
    source,
    /GEAR_DROP_SCAVENGER_CHANCE_CAP,[\s\S]{0,100}?GEAR_DROP_SCAVENGER_CHANCE_PER_RANK,/,
    "the runtime must consume the shared scavenger tuning constants",
  );
  const killEnemy = source.match(
    /const killEnemy = \(enemy: Enemy\) => \{([\s\S]*?)\n\s*const firePlayerWeapon = \(\) => \{/,
  );
  assert.ok(killEnemy, "the enemy drop flow must remain present");
  const body = killEnemy[1];
  assert.match(
    body,
    /const gearFindPercent = Math\.max\(\s*0,\s*Math\.min\(200, equipmentStats\.gearFindPercent\),?\s*\);/,
    "gear find must clamp at 200%",
  );
  assert.match(
    body,
    /const sourceChance =\s*dropSource === ["']normal["']\s*\? Math\.min\(\s*GEAR_DROP_SCAVENGER_CHANCE_CAP,\s*GEAR_DROP_BASE_CHANCE\.normal \+\s*scavengerRank \* GEAR_DROP_SCAVENGER_CHANCE_PER_RANK,?\s*\)\s*:\s*GEAR_DROP_BASE_CHANCE\[dropSource\];/,
    "only normal enemies should receive the capped scavenger source bonus",
  );
  assert.match(
    body,
    /const gearDropChance =\s*dropSource === ["']boss["']\s*\? 1\s*:\s*Math\.min\(\s*GEAR_DROP_CHANCE_CAP\[dropSource\],\s*sourceChance \* \(1 \+ gearFindPercent \/ 100\),?\s*\);/,
    "bosses must always drop and all other sources must use the full capped gear-find multiplier",
  );
  assert.match(
    body,
    /rollGearDropRarity\(\s*rarityRoll,\s*dropSource,\s*gearFindPercent,\s*player\.level,?\s*\)/,
    "gear find and character level must both feed the conditional rarity roll",
  );
  assert.doesNotMatch(
    body,
    /0\.065|scavengerRank \* 0\.001|gearFindBonus|\* 0\.5(?!\d)/,
  );
});

test("normal and elite equipment drops retain the deterministic player-level five-band", async () => {
  const [equipment, source] = await Promise.all([
    importTypeScriptModule("app/equipment.ts"),
    readFile(path.join(root, "app/GameCanvas.tsx"), "utf8"),
  ]);
  assert.equal(equipment.GEAR_DROP_LEVEL_RADIUS, 5);

  for (const playerLevel of [1, 2, 45, 995, 999]) {
    const minimumLevel = Math.max(1, playerLevel - equipment.GEAR_DROP_LEVEL_RADIUS);
    const maximumLevel = Math.min(999, playerLevel + equipment.GEAR_DROP_LEVEL_RADIUS);
    const observedLevels = new Set();
    for (let seed = 0; seed < 512; seed += 1) {
      const dropSeed = `drop-level-${playerLevel}-${seed}`;
      const first = equipment.rollGearDropLevel(dropSeed, playerLevel);
      const second = equipment.rollGearDropLevel(dropSeed, playerLevel);
      const elite = equipment.rollGearDropLevel(dropSeed, playerLevel, "elite");
      assert.equal(first, second, "the same drop seed and player level must be deterministic");
      assert.equal(elite, first, "elite drops must preserve the existing non-boss level band");
      assert.ok(Number.isSafeInteger(first));
      assert.ok(
        first >= minimumLevel && first <= maximumLevel,
        `level ${playerLevel} produced out-of-band item level ${first}`,
      );
      observedLevels.add(first);
    }
    assert.ok(observedLevels.has(minimumLevel), `level ${playerLevel} must reach its lower bound`);
    assert.ok(observedLevels.has(maximumLevel), `level ${playerLevel} must reach its upper bound`);
  }

  const killEnemy = source.match(
    /const killEnemy = \(enemy: Enemy\) => \{([\s\S]*?)\n\s*const firePlayerWeapon = \(\) => \{/,
  );
  assert.ok(killEnemy, "the enemy drop flow must remain present");
  assert.match(
    killEnemy[1],
    /const dropLevel = rollGearDropLevel\(\s*dropSeed,\s*player\.level,\s*dropSource,?\s*\);[\s\S]{0,160}?level: dropLevel,/,
    "runtime drops must derive item level from the character and defeated-enemy source",
  );
  assert.doesNotMatch(
    killEnemy[1],
    /level:\s*Math\.max\(1,\s*player\.level\s*\+\s*Math\.floor\(player\.rooms\s*\/\s*2\)\)/,
  );

  const legacyHighLevelItem = equipment.rollGear("pre-band-save", {
    level: 90,
    slot: "weapon",
    rarity: "legendary",
  });
  const normalizedLegacyItem = equipment.normalizeGearItem({
    ...legacyHighLevelItem,
    powerScore: -1,
  });
  assert.ok(normalizedLegacyItem, "pre-band saved gear must remain loadable");
  assert.equal(normalizedLegacyItem.level, 90, "the new drop band must not rewrite saved item levels");
  assert.equal(normalizedLegacyItem.id, legacyHighLevelItem.id);
  assert.deepEqual(normalizedLegacyItem.affixes, legacyHighLevelItem.affixes);
});

test("boss equipment drops deterministically roll five to ten levels above the player", async () => {
  const [equipment, source] = await Promise.all([
    importTypeScriptModule("app/equipment.ts"),
    readFile(path.join(root, "app/GameCanvas.tsx"), "utf8"),
  ]);
  assert.equal(equipment.GEAR_BOSS_DROP_LEVEL_MIN_BONUS, 5);
  assert.equal(equipment.GEAR_BOSS_DROP_LEVEL_MAX_BONUS, 10);

  for (const playerLevel of [1, 45, 989, 990, 994, 999]) {
    const minimumLevel = Math.min(
      999,
      playerLevel + equipment.GEAR_BOSS_DROP_LEVEL_MIN_BONUS,
    );
    const maximumLevel = Math.min(
      999,
      playerLevel + equipment.GEAR_BOSS_DROP_LEVEL_MAX_BONUS,
    );
    const observedLevels = new Set();
    for (let seed = 0; seed < 512; seed += 1) {
      const dropSeed = `boss-drop-level-${playerLevel}-${seed}`;
      const first = equipment.rollGearDropLevel(dropSeed, playerLevel, "boss");
      const second = equipment.rollGearDropLevel(dropSeed, playerLevel, "boss");
      assert.equal(first, second, "boss level rolls must be deterministic");
      assert.ok(Number.isSafeInteger(first));
      assert.ok(
        first >= minimumLevel && first <= maximumLevel,
        `level ${playerLevel} boss produced out-of-band item level ${first}`,
      );
      observedLevels.add(first);
    }
    assert.ok(
      observedLevels.has(minimumLevel),
      `level ${playerLevel} boss loot must reach its clamped lower bound`,
    );
    assert.ok(
      observedLevels.has(maximumLevel),
      `level ${playerLevel} boss loot must reach its clamped upper bound`,
    );
  }

  const killEnemy = source.match(
    /const killEnemy = \(enemy: Enemy\) => \{([\s\S]*?)\n\s*const firePlayerWeapon = \(\) => \{/,
  );
  assert.ok(killEnemy, "the enemy drop flow must remain present");
  assert.match(
    killEnemy[1],
    /const dropCount = isBossKind\(enemy\.kind\) \? 2 : 1;[\s\S]{0,700}?for \(let dropIndex = 0; dropIndex < dropCount; dropIndex \+= 1\)[\s\S]{0,700}?rollGearDropLevel\(\s*dropSeed,\s*player\.level,\s*dropSource,?\s*\)/,
    "both guaranteed boss items must receive the boss-only level source",
  );
});

test("rarity tier rating preserves the level-100 equivalence ladder without faking combat power", async () => {
  const equipment = await importTypeScriptModule("app/equipment.ts");
  assert.equal(equipment.GEAR_POWER_PER_LEVEL, 8);
  assert.deepEqual(equipment.GEAR_RARITY_LEVEL_EQUIVALENT, {
    common: 0,
    magic: 5,
    superior: 10,
    rare: 15,
    epic: 20,
    legendary: 30,
    mythic: 45,
    cosmic: 60,
  });

  const equivalentLevels = {
    common: 100,
    magic: 95,
    superior: 90,
    rare: 85,
    epic: 80,
    legendary: 70,
    mythic: 55,
    cosmic: 40,
  };

  const commonAnchor = equipment.calculateGearTierRating({
    level: equivalentLevels.common,
    rarity: "common",
  });
  assert.equal(commonAnchor, equivalentLevels.common * equipment.GEAR_POWER_PER_LEVEL);

  for (const rarity of equipment.GEAR_RARITIES) {
    const targetLevel = equivalentLevels[rarity];
    assert.equal(
      equipment.calculateGearTierRating({ level: targetLevel, rarity }),
      commonAnchor,
      `level-${targetLevel} ${rarity} must share the exact level-100 common tier anchor`,
    );
    assert.equal(
      equipment.calculateGearTierRating({ level: targetLevel + 1, rarity }),
      commonAnchor + equipment.GEAR_POWER_PER_LEVEL,
      `${rarity} tier rating must still gain exactly one item-level step`,
    );
  }
});

test("all ten slots expose their rarity-equivalent basic option as one enhancement candidate", async () => {
  const equipment = await importTypeScriptModule("app/equipment.ts");
  assert.deepEqual(
    Object.fromEntries(
      equipment.EQUIPMENT_SLOTS.map((slot) => [
        slot,
        equipment.GEAR_IMPLICIT_OPTION_BY_SLOT[slot].stat,
      ]),
    ),
    {
      weapon: "attackPowerFlat",
      offhand: "projectileSizePercent",
      helm: "maxHpFlat",
      shoulders: "projectileSpeedPercent",
      armor: "damageReductionPercent",
      gloves: "attackSpeedPercent",
      belt: "lifeOnHitFlat",
      legs: "dashCooldownPercent",
      boots: "moveSpeedPercent",
      relic: "critChancePercent",
    },
  );

  for (const slot of equipment.EQUIPMENT_SLOTS) {
    const commonAnchorItem = {
      slot,
      level: 100,
      rarity: "common",
      enhancement: 0,
      enhancementRanks: [0],
    };
    const commonAnchor = equipment.getGearImplicitBaseValue(commonAnchorItem);
    assert.ok(commonAnchor > 0, `${slot} needs a meaningful base option`);
    for (const rarity of equipment.GEAR_RARITIES) {
      const level = 100 - equipment.GEAR_RARITY_LEVEL_EQUIVALENT[rarity];
      const item = { slot, level, rarity, enhancement: 0, enhancementRanks: [0] };
      assert.equal(
        equipment.getGearImplicitBaseValue(item),
        commonAnchor,
        `${slot} ${rarity} must preserve the established equivalent-level ladder`,
      );
      const perRankGain = equipment.getGearOptionEnhancementGain(
        item,
        equipment.GEAR_IMPLICIT_OPTION_BY_SLOT[slot].stat,
      );
      const allImplicitRanks = {
        ...item,
        enhancement: 10,
        enhancementRanks: [10],
      };
      assert.ok(
        equipment.getEnhancedGearImplicitValue(allImplicitRanks) > commonAnchor,
        `${slot} ${rarity} must gain when its basic option wins the draw`,
      );
      assert.equal(
        equipment.getEnhancedGearImplicitValue(allImplicitRanks),
        Math.round((commonAnchor + perRankGain * 10) * 100) / 100,
        `${slot} ${rarity} must accumulate repeated draws on the same option`,
      );
      assert.equal(
        equipment.getEnhancedGearImplicitValue({
          ...allImplicitRanks,
          enhancementRanks: [0],
        }),
        commonAnchor,
        "the stage number alone must not enhance an option that received no ranks",
      );
    }
  }
});

test("gear text and resolved stats expose ranks on both implicit and additional options", async () => {
  const equipment = await importTypeScriptModule("app/equipment.ts");

  assert.equal(equipment.formatGearNumericValue(12.345), "12.35");
  assert.equal(equipment.formatGearNumericValue(-12.345), "-12.35");
  assert.equal(equipment.formatGearNumericValue(-0.001), "0.00");
  assert.equal(equipment.formatCompactGearLabel("치명타 확률 +3.00%"), "치명타 확률 +3%");
  assert.equal(equipment.formatCompactGearLabel("공격 속도 +3.50%"), "공격 속도 +3.5%");
  assert.equal(equipment.formatCompactGearLabel("기본 공격력 +3.25"), "기본 공격력 +3.25");
  assert.equal(
    equipment.formatGearDisplayName({
      displayName: "끝나지 않은 쉼표 · 무진도 파편",
      enhancement: 5,
    }),
    "끝나지 않은 쉼표 · 무진도 파편 +5",
  );
  assert.equal(
    equipment.formatGearDisplayName({ displayName: "무진도 파편", enhancement: 0 }),
    "무진도 파편",
  );
  assert.equal(
    equipment.formatGearDisplayName(
      { displayName: "무진도 파편", enhancement: 0 },
      { includeZero: true },
    ),
    "무진도 파편 +0",
  );
  assert.equal(equipment.normalizeGearEnhancement(999), 10);
  assert.equal(equipment.normalizeGearEnhancement(-7), 0);
  assert.equal(equipment.normalizeGearEnhancement(Number.NaN), 0);
  assert.equal(
    equipment.formatGearAffix("damagePercent", 12.345),
    `${equipment.GEAR_AFFIX_DEFINITIONS.damagePercent.name} +12.35%`,
  );
  assert.equal(
    equipment.formatGearAffix("damageReductionPercent", 4.567),
    `${equipment.GEAR_AFFIX_DEFINITIONS.damageReductionPercent.name} -4.57%`,
    "reduction affixes must retain their semantic minus sign",
  );
  assert.equal(
    equipment.formatGearAffix("maxHpFlat", 123.456),
    `${equipment.GEAR_AFFIX_DEFINITIONS.maxHpFlat.name} +123.46`,
  );

  const affix = {
    stat: "damagePercent",
    value: 10,
    rollPercent: 50,
    label: "stale",
  };
  const item = {
    slot: "weapon",
    rarity: "rare",
    level: 100,
    enhancement: 3,
    enhancementRanks: [0, 3],
    affixes: [affix],
    legendaryPowerId: null,
  };
  const perRankGain = equipment.getGearOptionEnhancementGain(item, affix.stat);
  const display = equipment.getGearAffixDisplay(affix, item);
  assert.deepEqual(
    {
      totalValue: display.totalValue,
      baseValue: display.baseValue,
      enhancementValue: display.enhancementValue,
      nextStageGainValue: display.nextStageGainValue,
      enhancementCount: display.enhancementCount,
    },
    {
      totalValue: Math.round((10 + perRankGain * 3) * 100) / 100,
      baseValue: 10,
      enhancementValue: Math.round(perRankGain * 3 * 100) / 100,
      nextStageGainValue: perRankGain,
      enhancementCount: 3,
    },
  );
  assert.ok(display.totalLabel.startsWith(equipment.formatEnhancedGearAffix(item, affix)));
  assert.match(display.totalLabel, /3회/);
  assert.match(display.baseLabel, /\+10\.00%$/);
  assert.match(display.enhancementLabel, /3회/);
  assert.match(display.nextStageGainLabel, new RegExp(perRankGain.toFixed(2)));
  assert.equal(
    equipment.getEnhancedGearAffixValue(item, affix),
    display.totalValue,
    "additional options must consume the ranks allocated to their own line",
  );

  const implicitItem = {
    ...item,
    level: 70,
    rarity: "legendary",
    enhancementRanks: [3, 0],
  };
  const implicit = equipment.getGearImplicitDisplay(implicitItem);
  const implicitPerRankGain = equipment.getGearOptionEnhancementGain(
    implicitItem,
    equipment.GEAR_IMPLICIT_OPTION_BY_SLOT.weapon.stat,
  );
  assert.deepEqual(
    {
      stat: implicit.stat,
      baseValue: implicit.baseValue,
      totalValue: implicit.totalValue,
      enhancementValue: implicit.enhancementValue,
      nextStageGainValue: implicit.nextStageGainValue,
      enhancementCount: implicit.enhancementCount,
    },
    {
      stat: "attackPowerFlat",
      baseValue: 4,
      totalValue: Math.round((4 + implicitPerRankGain * 3) * 100) / 100,
      enhancementValue: Math.round(implicitPerRankGain * 3 * 100) / 100,
      nextStageGainValue: implicitPerRankGain,
      enhancementCount: 3,
    },
  );
  assert.match(implicit.totalLabel, /강화 3회/);
  assert.match(implicit.enhancementLabel, /3회/);

  const affixRankStats = equipment.resolveGearItemStats(item);
  const implicitRankStats = equipment.resolveGearItemStats(implicitItem);
  assert.equal(affixRankStats.damagePercent, display.totalValue);
  assert.equal(
    affixRankStats.attackPowerFlat,
    equipment.getGearImplicitBaseValue(item),
    "affix ranks must leave the basic option unchanged",
  );
  assert.equal(implicitRankStats.damagePercent, affix.value);
  assert.equal(implicitRankStats.attackPowerFlat, implicit.totalValue);

  const reductionAffix = { ...affix, stat: "damageReductionPercent" };
  const reductionItem = {
    ...item,
    affixes: [reductionAffix],
    enhancementRanks: [0, 3],
  };
  const reductionDisplay = equipment.getGearAffixDisplay(
    reductionAffix,
    reductionItem,
  );
  assert.match(reductionDisplay.totalLabel, /-\d+\.\d{2}%/);
  assert.match(reductionDisplay.baseLabel, /-10\.00%$/);
  assert.match(reductionDisplay.enhancementLabel, /3회/);
  assert.doesNotMatch(
    [
      display.totalLabel,
      display.baseLabel,
      display.enhancementLabel,
      display.nextStageGainLabel,
      equipment.getGearAffixDisplay(
        reductionAffix,
        {
          ...reductionItem,
          rarity: "common",
          enhancement: 0,
          enhancementRanks: [0, 0],
        },
      ).enhancementLabel,
      equipment.formatGearNumericValue(-0),
    ].join(" "),
    /-0\.00/,
    "rounded zero must never surface as negative zero",
  );
});

test("equipment power is only all-hit sustained standard-boss DPS", async () => {
  const equipment = await importTypeScriptModule("app/equipment.ts");
  const makeItem = ({
    slot,
    stat = null,
    value = 0,
    rarity = "common",
    enhancement = 0,
    legendaryPowerId = null,
  }) => ({
    id: `test-${slot}-${stat ?? legendaryPowerId ?? "empty"}-${value}-${enhancement}`,
    slot,
    rarity,
    level: 1,
    baseName: equipment.GEAR_BASE_NAMES[slot][0],
    displayName: "test gear",
    iconIndex: equipment.gearIconIndex(slot, equipment.GEAR_BASE_NAMES[slot][0]),
    affixes: stat
      ? [{ stat, value, rollPercent: 100, label: equipment.formatGearAffix(stat, value) }]
      : [],
    legendaryPowerId,
    enhancement,
    enhancementRanks: stat ? [enhancement, 0] : [enhancement],
    qualityScore: 100,
    powerScore: 1,
  });
  const loadoutOf = (...items) => {
    const loadout = equipment.createEmptyEquipment();
    for (const item of items) loadout[item.slot] = item;
    return loadout;
  };
  const scoreStats = (values) => {
    const stats = equipment.createEmptyGearStatTotals();
    Object.assign(stats, values);
    return equipment.calculateCombatPowerFromEquipmentStats(stats);
  };

  const emptyPower = equipment.calculateEquipmentCombatPower(
    equipment.createEmptyEquipment(),
  );
  assert.equal(emptyPower, 1_000, "the documented equipment-only baseline must remain stable");
  assert.deepEqual(equipment.GEAR_STAT_KEYS, ["attackPowerFlat", ...equipment.GEAR_AFFIX_STATS]);
  const baseline = scoreStats({});
  assert.deepEqual(
    {
      total: baseline.total,
      offense: baseline.offense,
      defense: baseline.defense,
      sustain: baseline.sustain,
      mobility: baseline.mobility,
      utility: baseline.utility,
      defenseIndex: baseline.defenseIndex,
      sustainIndex: baseline.sustainIndex,
      mobilityIndex: baseline.mobilityIndex,
      utilityIndex: baseline.utilityIndex,
    },
    {
      total: 1_000,
      offense: 1_000,
      defense: 0,
      sustain: 0,
      mobility: 0,
      utility: 0,
      defenseIndex: 0,
      sustainIndex: 0,
      mobilityIndex: 0,
      utilityIndex: 0,
    },
  );

  const lowAttackPower = scoreStats({ attackPowerFlat: 4 }).total;
  const highAttackPower = scoreStats({ attackPowerFlat: 12 }).total;
  assert.ok(lowAttackPower > emptyPower);
  assert.ok(
    highAttackPower > lowAttackPower,
    "implicit weapon attack power must be monotonic in boss DPS",
  );

  const offensiveRanges = {
    damagePercent: [20, 80],
    attackSpeedPercent: [20, 80],
    critChancePercent: [15, 50],
    critDamagePercent: [50, 200],
    eliteDamagePercent: [50, 200],
    projectileCountFlat: [1, 3],
    bossDamagePercent: [30, 75],
    executeDamagePercent: [30, 90],
    cosmicFinalDamagePercent: [8, 30],
    cosmicActionSpeedPercent: [6, 22],
  };
  for (const [stat, [lowerValue, higherValue]] of Object.entries(offensiveRanges)) {
    const lowerPower = scoreStats({ [stat]: lowerValue }).total;
    const higherPower = scoreStats({ [stat]: higherValue }).total;
    assert.ok(lowerPower > emptyPower, `${stat} must contribute to standard-boss DPS`);
    assert.ok(
      higherPower > lowerPower,
      `${stat} must remain monotonic in standard-boss DPS`,
    );
  }

  const zeroPowerStats = [
    "projectileSpeedPercent",
    "maxHpFlat",
    "damageReductionPercent",
    "moveSpeedPercent",
    "dashCooldownPercent",
    "pickupRadiusPercent",
    "xpGainPercent",
    "projectileSizePercent",
    "lifeOnHitFlat",
    "gearFindPercent",
    "pierceFlat",
    "projectileLifetimePercent",
    "homingStrengthFlat",
    "hpRegenPerSecondFlat",
    "roomClearHealFlat",
    "roomEntryShieldFlat",
    "dashSpeedPercent",
    "cosmicAegisPercent",
  ];
  assert.deepEqual(
    [...Object.keys(offensiveRanges), ...zeroPowerStats].sort(),
    [...equipment.GEAR_AFFIX_STATS].sort(),
    "every equipment stat must be explicitly classified",
  );
  for (const stat of zeroPowerStats) {
    assert.equal(
      scoreStats({ [stat]: 999 }).total,
      emptyPower,
      `${stat} must add exactly zero equipment power`,
    );
    const slot = equipment.GEAR_AFFIX_DEFINITIONS[stat].legacySlots[0];
    const plain = makeItem({ slot });
    const rolled = makeItem({ slot, stat, value: 999 });
    assert.equal(
      equipment.calculateGearPowerScore(rolled),
      equipment.calculateGearPowerScore(plain),
      `${stat} must add exactly zero intrinsic item power`,
    );
  }

  assert.equal(scoreStats({ projectileCountFlat: 0.99 }).total, emptyPower);
  assert.equal(scoreStats({ projectileCountFlat: 1 }).total, emptyPower * 2);

  const stackedRegeneration = equipment.aggregateEquipmentStats(
    loadoutOf(
      makeItem({ slot: "weapon", stat: "hpRegenPerSecondFlat", value: 20 }),
      makeItem({ slot: "offhand", stat: "hpRegenPerSecondFlat", value: 20 }),
    ),
  );
  assert.equal(stackedRegeneration.hpRegenPerSecondFlat, 40);
  const stackedRoomHeal = equipment.aggregateEquipmentStats(
    loadoutOf(
      makeItem({ slot: "weapon", stat: "roomClearHealFlat", value: 100 }),
      makeItem({ slot: "offhand", stat: "roomClearHealFlat", value: 100 }),
    ),
  );
  assert.equal(stackedRoomHeal.roomClearHealFlat, 200);

  const assertMultiplicativeSynergy = (first, second, description) => {
    const firstPower = equipment.calculateEquipmentCombatPower(loadoutOf(first));
    const secondPower = equipment.calculateEquipmentCombatPower(loadoutOf(second));
    const combinedPower = equipment.calculateEquipmentCombatPower(loadoutOf(first, second));
    assert.ok(
      combinedPower - emptyPower
        > (firstPower - emptyPower) + (secondPower - emptyPower),
      `${description} must be valued as a multiplicative interaction`,
    );
  };
  assertMultiplicativeSynergy(
    makeItem({ slot: "weapon", stat: "damagePercent", value: 100 }),
    makeItem({ slot: "offhand", stat: "attackSpeedPercent", value: 100 }),
    "damage and attack speed",
  );
  assertMultiplicativeSynergy(
    makeItem({ slot: "helm", stat: "critChancePercent", value: 70 }),
    makeItem({ slot: "relic", stat: "critDamagePercent", value: 100 }),
    "critical chance and critical damage",
  );
  assert.equal(
    equipment.calculateEquipmentCombatPower(
      loadoutOf(
        makeItem({ slot: "armor", stat: "maxHpFlat", value: 100 }),
        makeItem({ slot: "belt", stat: "damageReductionPercent", value: 50 }),
      ),
    ),
    emptyPower,
    "defensive synergy must add exactly zero DPS power",
  );
});

test("combat power values only implemented legendary effects and computes contextual replacement deltas", async () => {
  const equipment = await importTypeScriptModule("app/equipment.ts");
  const makeItem = ({
    slot,
    stat = null,
    value = 0,
    rarity = "common",
    enhancement = 0,
    legendaryPowerId = null,
  }) => ({
    id: `power-${slot}-${stat ?? legendaryPowerId ?? "empty"}-${value}-${enhancement}`,
    slot,
    rarity,
    level: 1,
    baseName: equipment.GEAR_BASE_NAMES[slot][0],
    displayName: "power test gear",
    iconIndex: equipment.gearIconIndex(slot, equipment.GEAR_BASE_NAMES[slot][0]),
    affixes: stat
      ? [{ stat, value, rollPercent: 100, label: equipment.formatGearAffix(stat, value) }]
      : [],
    legendaryPowerId,
    enhancement,
    enhancementRanks: stat ? [enhancement, 0] : [enhancement],
    qualityScore: 100,
    powerScore: 1,
  });
  const loadoutOf = (...items) => {
    const loadout = equipment.createEmptyEquipment();
    for (const item of items) loadout[item.slot] = item;
    return loadout;
  };
  const offensivePowers = new Set([
    "crescentEcho",
    "mirrorAegis",
    "hunterSigil",
    "starfallMantle",
    "bloodwovenGrip",
    "phantomMarch",
    "riftStride",
    "commaResonance",
  ]);

  for (const legendaryPowerId of equipment.LEGENDARY_POWER_IDS) {
    const slot = equipment.LEGENDARY_POWERS[legendaryPowerId].slot;
    const item = makeItem({ slot, rarity: "legendary", legendaryPowerId });
    const implicitOnlyItem = { ...item, legendaryPowerId: null };
    const loadoutPower = equipment.calculateEquipmentCombatPower(loadoutOf(item));
    const implicitPower = equipment.calculateEquipmentCombatPower(loadoutOf(implicitOnlyItem));
    const itemPower = equipment.calculateGearPowerScore(item);
    const implicitItemPower = equipment.calculateGearPowerScore(implicitOnlyItem);
    if (offensivePowers.has(legendaryPowerId)) {
      assert.ok(loadoutPower > implicitPower, `${legendaryPowerId} offensive proc must contribute DPS`);
      assert.ok(itemPower > implicitItemPower, `${legendaryPowerId} offensive proc must contribute item DPS`);
    } else {
      assert.equal(loadoutPower, implicitPower, `${legendaryPowerId} non-offense must add zero power`);
      assert.equal(itemPower, implicitItemPower, `${legendaryPowerId} non-offense must add zero item power`);
    }
  }
  const equippedWeapon = makeItem({
    slot: "weapon",
    stat: "damagePercent",
    value: 20,
  });
  const attackSpeedItem = makeItem({
    slot: "offhand",
    stat: "attackSpeedPercent",
    value: 80,
  });
  const candidateWeapon = makeItem({
    slot: "weapon",
    stat: "damagePercent",
    value: 100,
  });
  const currentLoadout = loadoutOf(equippedWeapon, attackSpeedItem);
  const nextLoadout = { ...currentLoadout, weapon: candidateWeapon };
  const expectedDelta =
    equipment.calculateEquipmentCombatPower(nextLoadout)
    - equipment.calculateEquipmentCombatPower(currentLoadout);
  const contextualDelta = equipment.calculateEquipmentPowerDelta(
    currentLoadout,
    candidateWeapon,
  );
  assert.equal(contextualDelta, expectedDelta);
  assert.ok(
    contextualDelta
      > equipment.calculateGearPowerScore(candidateWeapon)
        - equipment.calculateGearPowerScore(equippedWeapon),
    "replacement power must include synergy with the rest of the equipped build",
  );
  assert.equal(currentLoadout.weapon, equippedWeapon, "comparison must not mutate the loadout");
});

test("enhancement power follows the selected option line and stale saves rebuild deterministic ranks", async () => {
  const equipment = await importTypeScriptModule("app/equipment.ts");
  const affix = {
    stat: "damagePercent",
    value: 100,
    rollPercent: 100,
    label: equipment.formatGearAffix("damagePercent", 100),
  };
  const baseItem = {
    slot: "weapon",
    rarity: "rare",
    level: 100,
    affixes: [affix],
    legendaryPowerId: null,
    enhancement: 0,
    enhancementRanks: [0, 0],
  };
  const baseStats = equipment.resolveGearItemStats(baseItem);
  const basePower = equipment.calculateGearPowerScore(baseItem);
  const implicitHit = {
    ...baseItem,
    enhancement: 1,
    enhancementRanks: [1, 0],
  };
  const affixHit = {
    ...baseItem,
    enhancement: 1,
    enhancementRanks: [0, 1],
  };
  const implicitStats = equipment.resolveGearItemStats(implicitHit);
  const affixStats = equipment.resolveGearItemStats(affixHit);
  assert.ok(
    implicitStats.attackPowerFlat > baseStats.attackPowerFlat,
    "an implicit-option win must raise only the slot's basic stat",
  );
  assert.equal(implicitStats.damagePercent, baseStats.damagePercent);
  assert.equal(affixStats.attackPowerFlat, baseStats.attackPowerFlat);
  assert.ok(
    affixStats.damagePercent > baseStats.damagePercent,
    "an affix win must raise the selected random option",
  );
  assert.ok(
    equipment.calculateGearPowerScore(implicitHit) > basePower,
    "an offensive basic-option rank must increase power",
  );
  assert.ok(
    equipment.calculateGearPowerScore(affixHit) > basePower,
    "an offensive additional-option rank must increase power",
  );

  const rolled = equipment.rollGear("stale-derived-power-save", {
    level: 42,
    slot: "weapon",
    rarity: "legendary",
  });
  const stale = JSON.parse(JSON.stringify(rolled));
  stale.enhancement = 5;
  delete stale.enhancementRanks;
  stale.powerScore = -999_999;
  for (const savedAffix of stale.affixes) savedAffix.label = "stale label";
  const normalized = equipment.normalizeGearItem(stale);
  const normalizedAgain = equipment.normalizeGearItem(stale);
  assert.ok(normalized);
  assert.deepEqual(
    normalized.enhancementRanks,
    normalizedAgain.enhancementRanks,
    "the same pre-rank save must always receive the same random allocation migration",
  );
  assert.equal(normalized.enhancementRanks.length, normalized.affixes.length + 1);
  assert.equal(
    normalized.enhancementRanks.reduce((total, rank) => total + rank, 0),
    normalized.enhancement,
  );
  assert.equal(
    normalized.powerScore,
    equipment.calculateGearPowerScore(normalized),
    "saved power is derived and must be recomputed under the boss-DPS formula",
  );
  for (const normalizedAffix of normalized.affixes) {
    assert.equal(
      normalizedAffix.label,
      equipment.formatGearAffix(normalizedAffix.stat, normalizedAffix.value),
      "saved option labels must migrate to the exact two-decimal formatter",
    );
  }
});

test("equipment gates apex affixes and deterministically repairs incompatible saved rolls", async () => {
  const equipment = await importTypeScriptModule("app/equipment.ts");
  const apexStats = new Set(equipment.GEAR_COSMIC_AFFIX_STATS);

  for (const rarity of equipment.GEAR_RARITIES) {
    for (const slot of equipment.EQUIPMENT_SLOTS) {
      for (let seed = 0; seed < 240; seed += 1) {
        const item = equipment.rollGear(`apex-gate-${rarity}-${slot}-${seed}`, {
          level: 80,
          slot,
          rarity,
        });
        const rolledStats = item.affixes.map((affix) => affix.stat);
        if (rarity !== "mythic" && rarity !== "cosmic") {
          assert.equal(
            rolledStats.includes("projectileCountFlat"),
            false,
            `${rarity}/${slot} must not receive a fresh additional-projectile roll`,
          );
        }
        if (rarity === "cosmic") {
          assert.equal(
            rolledStats.filter((stat) => apexStats.has(stat)).length,
            1,
            `every cosmic ${slot} must carry exactly one pinnacle option`,
          );
        } else {
          assert.equal(
            rolledStats.some((stat) => apexStats.has(stat)),
            false,
            `${rarity}/${slot} must not receive a cosmic pinnacle option`,
          );
        }
      }
    }
  }

  const lowRarityLegacy = equipment.rollGear("legacy-low-projectile", {
    level: 1,
    slot: "weapon",
    rarity: "common",
  });
  lowRarityLegacy.affixes = [{
    stat: "projectileCountFlat",
    value: 3,
    rollPercent: 100,
    label: equipment.formatGearAffix("projectileCountFlat", 3),
  }];
  lowRarityLegacy.powerScore = -1;
  lowRarityLegacy.qualityScore = -1;
  const preserved = equipment.normalizeGearItem(lowRarityLegacy);
  assert.ok(preserved, "an incompatible legacy item must remain loadable");
  assert.equal(preserved.id, lowRarityLegacy.id);
  assert.equal(preserved.affixes.length, 1);
  assert.notEqual(preserved.affixes[0].stat, "projectileCountFlat");
  assert.deepEqual(
    equipment.normalizeGearItem(preserved),
    preserved,
    "save repair must be idempotent",
  );

  const forgedCosmicStat = equipment.rollGear("forged-low-cosmic-affix", {
    level: 1,
    slot: "weapon",
    rarity: "common",
  });
  forgedCosmicStat.affixes = [{
    stat: "cosmicFinalDamagePercent",
    value: 30,
    rollPercent: 100,
    label: equipment.formatGearAffix("cosmicFinalDamagePercent", 30),
  }];
  const repairedForgedCosmic = equipment.normalizeGearItem(forgedCosmicStat);
  assert.ok(repairedForgedCosmic, "a forged option must not delete its containing item");
  assert.equal(repairedForgedCosmic.id, forgedCosmicStat.id);
  assert.equal(repairedForgedCosmic.affixes.length, 1);
  assert.equal(
    repairedForgedCosmic.affixes.some((affix) => apexStats.has(affix.stat)),
    false,
  );

  const cosmicDonors = new Map();
  const regularDonors = new Map();
  let cosmicBase = null;
  for (let seed = 0; seed < 500 && (cosmicDonors.size < 3 || regularDonors.size < 8); seed += 1) {
    const item = equipment.rollGear(`cosmic-repair-donor-${seed}`, {
      level: 80,
      slot: "weapon",
      rarity: "cosmic",
    });
    cosmicBase ??= item;
    for (const affix of item.affixes) {
      const target = apexStats.has(affix.stat) ? cosmicDonors : regularDonors;
      if (!target.has(affix.stat)) target.set(affix.stat, affix);
    }
  }
  assert.ok(cosmicBase);
  assert.equal(cosmicDonors.size, 3);
  assert.ok(regularDonors.size >= 8);
  const threeCosmic = {
    ...cosmicBase,
    affixes: [
      ...cosmicDonors.values(),
      ...[...regularDonors.values()].slice(0, 5),
    ],
  };
  const zeroCosmic = {
    ...cosmicBase,
    id: `${cosmicBase.id}-zero-apex`,
    affixes: [...regularDonors.values()].slice(0, 8),
  };
  for (const candidate of [threeCosmic, zeroCosmic]) {
    const repaired = equipment.normalizeGearItem(candidate);
    assert.ok(repaired);
    assert.equal(repaired.affixes.length, 8);
    assert.equal(
      repaired.affixes.filter((affix) => apexStats.has(affix.stat)).length,
      1,
      "every loaded cosmic item must have exactly one pinnacle option",
    );
    assert.deepEqual(equipment.normalizeGearItem(repaired), repaired);
  }
});

test("equipment requires character level equal to item level minus twenty", async () => {
  const equipment = await importTypeScriptModule("app/equipment.ts");
  assert.equal(equipment.GEAR_EQUIP_LEVEL_OFFSET, 20);
  assert.equal(equipment.getGearRequiredLevel(1), 1);
  assert.equal(equipment.getGearRequiredLevel(20), 1);
  assert.equal(equipment.getGearRequiredLevel(21), 1);
  assert.equal(equipment.getGearRequiredLevel(70), 50);
  assert.equal(equipment.getGearRequiredLevel(999), 979);

  const levelSeventyGear = equipment.rollGear("equip-level-contract", {
    level: 70,
    slot: "weapon",
    rarity: "legendary",
  });
  assert.equal(equipment.getGearRequiredLevel(levelSeventyGear), 50);
  assert.equal(equipment.canEquipGearAtLevel(49, levelSeventyGear), false);
  assert.equal(equipment.canEquipGearAtLevel(50, levelSeventyGear), true);
});

test("save hydration unequips level-locked gear without deleting it", async () => {
  const equipment = await importTypeScriptModule("app/equipment.ts");
  const lockedShoulders = equipment.rollGear("level-repair-locked", {
    level: 90,
    slot: "shoulders",
    rarity: "mythic",
  });
  const wearableWeapon = equipment.rollGear("level-repair-wearable", {
    level: 64,
    slot: "weapon",
    rarity: "legendary",
  });
  const backpackBoots = equipment.rollGear("level-repair-backpack", {
    level: 80,
    slot: "boots",
    rarity: "rare",
  });
  const savedEquipment = equipment.createEmptyEquipment();
  savedEquipment.shoulders = lockedShoulders;
  savedEquipment.weapon = wearableWeapon;

  const repaired = equipment.reconcileEquipmentLevelRequirements(
    45,
    savedEquipment,
    [backpackBoots],
  );
  assert.equal(repaired.equipment.weapon?.id, wearableWeapon.id);
  assert.equal(repaired.equipment.shoulders, null);
  assert.deepEqual(
    repaired.inventory.map((item) => item.id),
    [backpackBoots.id, lockedShoulders.id],
  );
  assert.deepEqual(repaired.unequipped.map((item) => item.id), [lockedShoulders.id]);
  assert.equal(repaired.repaired, true);

  const fullBackpack = Array.from({ length: 20 }, (_, index) =>
    equipment.rollGear(`level-repair-full-${index}`, {
      level: 40,
      rarity: "common",
    }),
  );
  const capacityIndependent = equipment.reconcileEquipmentLevelRequirements(
    45,
    savedEquipment,
    fullBackpack,
  );
  assert.equal(
    capacityIndependent.inventory.length,
    fullBackpack.length + 1,
    "restore must preserve locked gear even when the paid backpack capacity is already full",
  );
  assert.equal(capacityIndependent.inventory.at(-1)?.id, lockedShoulders.id);
});

test("equip-level reconciliation safely normalizes invalid player levels", async () => {
  const equipment = await importTypeScriptModule("app/equipment.ts");
  const highGear = equipment.rollGear("level-repair-invalid-player", {
    level: 70,
    slot: "helm",
    rarity: "legendary",
  });
  const savedEquipment = equipment.createEmptyEquipment();
  savedEquipment.helm = highGear;
  for (const invalidLevel of [Number.NaN, Number.POSITIVE_INFINITY, "70", null]) {
    const repaired = equipment.reconcileEquipmentLevelRequirements(
      invalidLevel,
      savedEquipment,
      [],
    );
    assert.equal(repaired.equipment.helm, null);
    assert.equal(repaired.inventory[0]?.id, highGear.id);
  }
});

test("save hydration strips duplicate gear identities and remains idempotent", async () => {
  const equipment = await importTypeScriptModule("app/equipment.ts");
  const weapon = equipment.rollGear("level-repair-duplicate", {
    level: 55,
    slot: "weapon",
    rarity: "epic",
  });
  const savedEquipment = equipment.createEmptyEquipment();
  savedEquipment.weapon = weapon;
  const duplicateBackpackItem = structuredClone(weapon);

  const repaired = equipment.reconcileEquipmentLevelRequirements(
    50,
    savedEquipment,
    [duplicateBackpackItem],
  );
  assert.equal(repaired.equipment.weapon?.id, weapon.id);
  assert.deepEqual(repaired.inventory, []);
  assert.equal(repaired.repaired, true);

  const repeated = equipment.reconcileEquipmentLevelRequirements(
    50,
    repaired.equipment,
    repaired.inventory,
  );
  assert.deepEqual(repeated.equipment, repaired.equipment);
  assert.deepEqual(repeated.inventory, repaired.inventory);
  assert.equal(repeated.repaired, false);
});

test("save hydration rejects gear stored under the wrong equipment slot", async () => {
  const equipment = await importTypeScriptModule("app/equipment.ts");
  const weapon = equipment.rollGear("level-repair-wrong-slot", {
    level: 50,
    slot: "weapon",
    rarity: "rare",
  });
  const malformedLoadout = equipment.createEmptyEquipment();
  malformedLoadout.helm = weapon;
  const repaired = equipment.reconcileEquipmentLevelRequirements(
    50,
    malformedLoadout,
    [],
  );
  assert.equal(repaired.equipment.helm, null);
  assert.equal(repaired.equipment.weapon, null);
  assert.deepEqual(repaired.inventory, []);
  assert.equal(repaired.repaired, true);
});

test("every equip gesture is protected by the shared level requirement", async () => {
  const [source, overlay, town] = await Promise.all([
    readFile(path.join(root, "app/GameCanvas.tsx"), "utf8"),
    readFile(path.join(root, "app/InventoryOverlay.tsx"), "utf8"),
    readFile(path.join(root, "app/GameEntryFlow.tsx"), "utf8"),
  ]);
  const equipHandler = source.match(
    /const equipInventoryItem = useCallback\(([\s\S]*?)\n\s*const unequipInventoryItem = useCallback/,
  );
  assert.ok(equipHandler, "the canonical equip handler must remain present");
  assert.match(
    equipHandler[1],
    /const requiredLevel = getGearRequiredLevel\(item\);[\s\S]{0,180}?if \(!canEquipGearAtLevel\(player\.level, item\)\) \{[\s\S]{0,300}?setToast\([\s\S]{0,240}?return;/,
  );
  assert.match(
    equipHandler[1],
    /착용 필요 레벨 부족 · 아이템 레벨 \$\{item\.level\}/,
  );
  assert.ok(
    equipHandler[1].indexOf("canEquipGearAtLevel(player.level, item)")
      < equipHandler[1].indexOf("player.equipment[item.slot] = item"),
    "the level gate must run before any equipment or inventory mutation",
  );
  assert.match(overlay, /playerLevel: number;/);
  assert.match(
    overlay,
    /아이템 레벨 \{selectedItem\.level\} · 착용 필요 레벨 \{selectedRequiredLevel\}/,
  );
  assert.match(overlay, /disabled=\{selectedLevelLocked\}/);
  assert.match(
    overlay,
    /const item = inventory\.find\(\(candidate\) => candidate\.id === gearId\);[\s\S]{0,120}?if \(!item \|\| !canEquipGearAtLevel\(playerLevel, item\)\) return;/,
    "the overlay wrapper must reject locked gear even if an enabled-looking gesture is synthesized",
  );
  assert.match(source, /playerLevel=\{hud\.player\.level\}/);
  assert.match(town, /playerLevel=\{level\}/);
  assert.match(
    source,
    /reconcileEquipmentLevelRequirements\(\s*data\.player\.level,\s*data\.player\.equipment,\s*data\.player\.inventory,?\s*\)/,
    "save restoration must apply the same equip gate before combat stats hydrate",
  );
  assert.match(
    source,
    /gearReconciliation\.repaired[\s\S]{0,500}?writeSaveSlot\(slot,[\s\S]{0,500}?equipment: cloneEquipment\(normalizedEquipment\)[\s\S]{0,200}?inventory: normalizedInventory\.map\(cloneGearItem\)/,
    "repaired equipment must be persisted immediately instead of resurrecting on reload",
  );
});

test("equipment rolls twenty-eight real affix types from twenty-option slot pools deterministically", async () => {
  const equipment = await importTypeScriptModule("app/equipment.ts");
  const expectedStats = [
    "damagePercent",
    "attackSpeedPercent",
    "projectileSpeedPercent",
    "maxHpFlat",
    "damageReductionPercent",
    "moveSpeedPercent",
    "dashCooldownPercent",
    "pickupRadiusPercent",
    "xpGainPercent",
    "critChancePercent",
    "critDamagePercent",
    "projectileSizePercent",
    "eliteDamagePercent",
    "lifeOnHitFlat",
    "gearFindPercent",
    "projectileCountFlat",
    "pierceFlat",
    "projectileLifetimePercent",
    "homingStrengthFlat",
    "hpRegenPerSecondFlat",
    "roomClearHealFlat",
    "roomEntryShieldFlat",
    "dashSpeedPercent",
    "bossDamagePercent",
    "executeDamagePercent",
    "cosmicFinalDamagePercent",
    "cosmicAegisPercent",
    "cosmicActionSpeedPercent",
  ];
  assert.deepEqual(equipment.GEAR_AFFIX_STATS, expectedStats);
  assert.deepEqual(Object.keys(equipment.GEAR_AFFIX_DEFINITIONS), expectedStats);
  for (const slot of equipment.EQUIPMENT_SLOTS) {
    const dropPool = equipment.GEAR_AFFIX_DROP_POOL_BY_SLOT[slot];
    assert.equal(dropPool.length, 20, `${slot} must expose exactly twenty drop options`);
    assert.equal(
      new Set(dropPool).size,
      20,
      `${slot} drop options must be actual distinct stats`,
    );
    for (const stat of dropPool) {
      assert.ok(expectedStats.includes(stat), `${slot}/${stat} must be a real affix stat`);
      assert.ok(
        equipment.GEAR_AFFIX_DEFINITIONS[stat].dropSlots.includes(slot),
        `${slot}/${stat} must agree with its definition drop slots`,
      );
    }
  }
  assert.deepEqual(
    equipment.GEAR_AFFIX_DEFINITIONS.attackSpeedPercent.dropSlots,
    ["weapon"],
    "new attack-speed affixes must be weapon-exclusive",
  );
  assert.deepEqual(
    equipment.GEAR_AFFIX_DEFINITIONS.attackSpeedPercent.legacySlots,
    ["weapon", "offhand", "helm", "gloves", "belt", "boots", "relic"],
    "the pre-pool attack-speed slots remain valid for save migration",
  );
  assert.equal(equipment.GEAR_AFFIX_DEFINITIONS.projectileCountFlat.integerRoll, true);
  assert.equal(equipment.GEAR_AFFIX_DEFINITIONS.pierceFlat.integerRoll, true);
  assert.equal(equipment.formatGearAffix("projectileCountFlat", 2), "추가 투사체 +2");
  assert.equal(equipment.formatGearAffix("pierceFlat", 3), "관통 횟수 +3");
  assert.equal(
    equipment.GEAR_AFFIX_DEFINITIONS.projectileCountFlat.minimumDropRarity,
    "mythic",
  );
  assert.deepEqual(equipment.GEAR_COSMIC_AFFIX_STATS, [
    "cosmicFinalDamagePercent",
    "cosmicAegisPercent",
    "cosmicActionSpeedPercent",
  ]);
  assert.equal(
    equipment.formatGearAffix("cosmicFinalDamagePercent", 12),
    "우주 최종 피해 +12.00%",
  );

  const observedBases = new Set();
  const observedStats = new Set();
  for (const [column, slot] of equipment.EQUIPMENT_SLOTS.entries()) {
    for (const rarity of equipment.GEAR_RARITIES) {
      for (let seed = 0; seed < 400; seed += 1) {
        const options = { level: 37, slot, rarity };
        const seedValue = `contract-${slot}-${rarity}-${seed}`;
        const first = equipment.rollGear(seedValue, options);
        const second = equipment.rollGear(seedValue, options);
        assert.deepEqual(first, second, `${slot}/${rarity}/${seed} must be deterministic`);
        assert.equal(first.slot, slot);
        assert.equal(first.rarity, rarity);
        assert.equal(first.iconIndex % 10, column);
        assert.deepEqual(equipment.gearIconCell(first.iconIndex), {
          column,
          row: equipment.GEAR_BASE_NAMES[slot].indexOf(first.baseName),
        });
        assert.equal(first.affixes.length, equipment.GEAR_RARITY_META[rarity].affixCount);
        assert.equal(
          first.legendaryPowerId === null,
          rarity !== "legendary" && rarity !== "mythic" && rarity !== "cosmic",
        );
        assert.equal(equipment.isGearItem(first), true);
        assert.deepEqual(JSON.parse(JSON.stringify(first)), first, "gear must remain JSON-safe");
        assert.equal(
          new Set(first.affixes.map((affix) => affix.stat)).size,
          first.affixes.length,
          "one item must never repeat an affix stat",
        );
        for (const affix of first.affixes) {
          assert.ok(
            equipment.isGearAffixRollableForSlot(slot, affix.stat),
            `${slot} must only roll stats from its explicit regular or cosmic pool`,
          );
          assert.ok(Number.isSafeInteger(affix.rollPercent));
          assert.ok(affix.rollPercent >= 1 && affix.rollPercent <= 100);
          if (affix.stat === "projectileCountFlat" || affix.stat === "pierceFlat") {
            assert.ok(Number.isSafeInteger(affix.value), `${affix.stat} must roll whole values`);
          }
          observedStats.add(affix.stat);
        }
        assert.equal(first.qualityScore, equipment.calculateGearQualityScore(first.affixes));
        assert.ok(first.qualityScore >= 1 && first.qualityScore <= 100);
        observedBases.add(first.baseName);
      }
    }
  }
  assert.deepEqual([...observedStats].sort(), [...expectedStats].sort(), "every affix must be rollable");
  assert.deepEqual([...observedBases].sort(), Object.values(equipment.GEAR_BASE_NAMES).flat().sort());

  const numericOptions = { level: 99, slot: "relic", rarity: "legendary" };
  assert.deepEqual(
    equipment.rollGear(987_654_321, numericOptions),
    equipment.rollGear(987_654_321, numericOptions),
    "numeric seeds must be deterministic too",
  );

  const legacyOffhand = equipment.rollGear("legacy-offhand-attack-speed", {
    level: 1,
    slot: "offhand",
    rarity: "common",
  });
  legacyOffhand.affixes = [{
    stat: "attackSpeedPercent",
    value: 4,
    rollPercent: 1,
    label: equipment.formatGearAffix("attackSpeedPercent", 4),
  }];
  legacyOffhand.qualityScore = -1;
  legacyOffhand.powerScore = -1;
  const normalizedLegacyOffhand = equipment.normalizeGearItem(legacyOffhand);
  assert.ok(normalizedLegacyOffhand, "an old non-weapon attack-speed item must remain loadable");
  assert.equal(normalizedLegacyOffhand.affixes[0].stat, "attackSpeedPercent");
  assert.equal(equipment.isGearItem(normalizedLegacyOffhand), true);
  assert.equal(
    equipment.GEAR_AFFIX_DROP_POOL_BY_SLOT.offhand.includes("attackSpeedPercent"),
    false,
    "the compatible legacy stat must not leak back into new offhand drops",
  );
});

test("saved equipment repairs derived quality and normalizes legacy affixes", async () => {
  const equipment = await importTypeScriptModule("app/equipment.ts");
  const loadout = equipment.createEmptyEquipment();
  const expectedTotals = equipment.createEmptyGearStatTotals();

  for (const [index, slot] of equipment.EQUIPMENT_SLOTS.entries()) {
    const item = equipment.rollGear(`normalize-${slot}`, {
      level: 20 + index,
      slot,
      rarity: index === 0 ? "legendary" : "rare",
    });
    loadout[slot] = item;
    const itemTotals = equipment.resolveGearItemStats(item);
    for (const stat of equipment.GEAR_STAT_KEYS) {
      expectedTotals[stat] += itemTotals[stat];
      expectedTotals[stat] = Math.round(expectedTotals[stat] * 100) / 100;
    }
  }

  const saved = JSON.parse(JSON.stringify(loadout));
  saved.weapon.displayName = "tampered derived name";
  saved.weapon.iconIndex = -99;
  saved.weapon.qualityScore = -1;
  saved.weapon.powerScore = -1;
  const normalized = equipment.normalizeEquipment(saved);

  assert.deepEqual(Object.keys(normalized), equipment.EQUIPMENT_SLOTS);
  assert.equal(normalized.weapon.slot, "weapon");
  assert.notEqual(normalized.weapon.displayName, "tampered derived name");
  assert.equal(
    normalized.weapon.iconIndex,
    equipment.gearIconIndex("weapon", normalized.weapon.baseName),
  );
  assert.equal(
    normalized.weapon.qualityScore,
    equipment.calculateGearQualityScore(normalized.weapon.affixes),
  );
  assert.ok(normalized.weapon.powerScore > 0);
  assert.deepEqual(equipment.aggregateEquipmentStats(normalized), expectedTotals);

  const legacySlotOrder = ["weapon", "helm", "armor", "boots", "relic"];
  const legacyFiveSlotSave = Object.fromEntries(
    legacySlotOrder.map((slot, legacyColumn) => {
      const item = JSON.parse(JSON.stringify(loadout[slot]));
      const row = equipment.GEAR_BASE_NAMES[slot].indexOf(item.baseName);
      item.iconIndex = row * 5 + legacyColumn;
      return [slot, item];
    }),
  );
  const migratedFiveSlotSave = equipment.normalizeEquipment(legacyFiveSlotSave);
  assert.deepEqual(Object.keys(migratedFiveSlotSave), equipment.EQUIPMENT_SLOTS);
  for (const slot of legacySlotOrder) {
    assert.equal(migratedFiveSlotSave[slot].id, legacyFiveSlotSave[slot].id);
    assert.equal(migratedFiveSlotSave[slot].baseName, legacyFiveSlotSave[slot].baseName);
    assert.deepEqual(migratedFiveSlotSave[slot].affixes, legacyFiveSlotSave[slot].affixes);
  }
  for (const slot of ["offhand", "shoulders", "gloves", "belt", "legs"]) {
    assert.equal(migratedFiveSlotSave[slot], null, `${slot} must be null in migrated five-slot saves`);
  }

  const legacyItem = JSON.parse(JSON.stringify(loadout.weapon));
  delete legacyItem.qualityScore;
  for (const affix of legacyItem.affixes) delete affix.rollPercent;
  const normalizedLegacy = equipment.normalizeGearItem(legacyItem);
  assert.ok(normalizedLegacy, "legacy items without rollPercent must remain loadable");
  assert.equal(normalizedLegacy.id, legacyItem.id);
  assert.equal(normalizedLegacy.affixes.length, legacyItem.affixes.length);
  assert.ok(
    normalizedLegacy.affixes.every(
      (affix) => Number.isSafeInteger(affix.rollPercent) && affix.rollPercent >= 1 && affix.rollPercent <= 100,
    ),
  );
  assert.equal(
    normalizedLegacy.qualityScore,
    equipment.calculateGearQualityScore(normalizedLegacy.affixes),
  );

  const invalidPercent = JSON.parse(JSON.stringify(loadout.weapon));
  invalidPercent.affixes[0].rollPercent = invalidPercent.affixes[0].rollPercent === 100 ? 1 : 100;
  assert.equal(
    equipment.normalizeGearItem(invalidPercent),
    null,
    "a persisted percentile that cannot produce its value must be rejected",
  );

  const mismatched = { ...saved, helm: saved.weapon };
  assert.equal(equipment.normalizeEquipment(mismatched).helm, null);
  assert.deepEqual(equipment.normalizeEquipment(null), equipment.createEmptyEquipment());
});

test("gear enhancement migrates random option ranks and defines complete +0 through +10 rules", async () => {
  const equipment = await importTypeScriptModule("app/equipment.ts");
  assert.equal(equipment.MAX_GEAR_ENHANCEMENT, 10);
  assert.deepEqual(equipment.GEAR_ENHANCEMENT_EFFECT_PER_STAGE, {
    common: 0.07,
    magic: 0.08,
    superior: 0.09,
    rare: 0.1,
    epic: 0.12,
    legendary: 0.14,
    mythic: 0.17,
    cosmic: 0.21,
  });
  assert.deepEqual(equipment.GEAR_RARITY_ECONOMY_MULTIPLIER, {
    common: 1,
    magic: 1.25,
    superior: 1.4,
    rare: 1.6,
    epic: 1.9,
    legendary: 2.2,
    mythic: 3,
    cosmic: 4,
  });
  assert.equal(
    equipment.GEAR_ENHANCEMENT_EFFECT_PER_STAGE.legendary,
    equipment.GEAR_ENHANCEMENT_EFFECT_PER_STAGE.common * 2,
    "legendary must gain exactly twice the per-stage percentage of common gear",
  );
  assert.equal(
    Math.round(equipment.GEAR_ENHANCEMENT_EFFECT_PER_STAGE.cosmic * 100),
    Math.round(equipment.GEAR_ENHANCEMENT_EFFECT_PER_STAGE.common * 100) * 3,
    "cosmic must gain exactly three times the per-stage percentage of common gear",
  );

  const anchorGains = Object.fromEntries(
    equipment.GEAR_STAT_KEYS.map((stat) => [
      stat,
      equipment.getGearOptionEnhancementGain(
        { rarity: "rare", level: 100 },
        stat,
      ),
    ]),
  );
  assert.ok(
    Object.values(anchorGains).every((gain) => gain > 0),
    "every selectable option needs a positive enhancement payoff",
  );
  assert.ok(
    new Set(Object.values(anchorGains)).size >= 10,
    "option families must use meaningfully differentiated balance increments",
  );
  assert.equal(
    anchorGains.projectileCountFlat,
    0.2,
    "one projectile-count draw must be fractional progress instead of doubling DPS",
  );
  assert.equal(anchorGains.pierceFlat, 0.25);
  assert.notEqual(anchorGains.critChancePercent, anchorGains.critDamagePercent);

  const commonEquivalentGain = equipment.getGearOptionEnhancementGain(
    { rarity: "common", level: 100 },
    "damagePercent",
  );
  const legendaryEquivalentGain = equipment.getGearOptionEnhancementGain(
    { rarity: "legendary", level: 70 },
    "damagePercent",
  );
  const cosmicEquivalentGain = equipment.getGearOptionEnhancementGain(
    { rarity: "cosmic", level: 40 },
    "damagePercent",
  );
  assert.ok(
    Math.abs(legendaryEquivalentGain / commonEquivalentGain - 2) < 0.03,
    "equivalent-level legendary gear must keep its twice-common rank reward within display rounding",
  );
  assert.ok(
    Math.abs(cosmicEquivalentGain / commonEquivalentGain - 3) < 0.03,
    "equivalent-level cosmic gear must keep its three-times-common rank reward within display rounding",
  );

  const baseItem = equipment.rollGear("enhancement-contract", {
    level: 42,
    slot: "armor",
    rarity: "rare",
  });
  assert.equal(baseItem.enhancement, 0, "fresh drops must start at +0");
  assert.equal(baseItem.enhancementRanks.length, baseItem.affixes.length + 1);
  assert.deepEqual(
    baseItem.enhancementRanks,
    Array.from({ length: baseItem.affixes.length + 1 }, () => 0),
    "fresh drops must expose one zero rank for the implicit and every affix line",
  );

  const mythicItem = equipment.rollGear("mythic-enhancement-cost", {
    level: 42,
    slot: "armor",
    rarity: "mythic",
  });
  const cosmicItem = equipment.rollGear("cosmic-enhancement-cost", {
    level: 42,
    slot: "armor",
    rarity: "cosmic",
  });
  assert.ok(equipment.isGearItem(cosmicItem));
  assert.match(cosmicItem.displayName, /^우주의 /);
  assert.ok(
    equipment.getGearEnhancementRule(cosmicItem).ashCost
      > equipment.getGearEnhancementRule(mythicItem).ashCost,
    "cosmic enhancement must carry its own cost tier above mythic",
  );

  const legacy = JSON.parse(JSON.stringify(baseItem));
  delete legacy.enhancement;
  delete legacy.enhancementRanks;
  const normalizedLegacy = equipment.normalizeGearItem(legacy);
  assert.ok(normalizedLegacy);
  assert.equal(normalizedLegacy.enhancement, 0, "pre-enhancement saves must migrate to +0");
  assert.deepEqual(
    normalizedLegacy.enhancementRanks,
    Array.from({ length: baseItem.affixes.length + 1 }, () => 0),
  );

  const legacyPlusFive = JSON.parse(JSON.stringify(baseItem));
  legacyPlusFive.enhancement = 5;
  delete legacyPlusFive.enhancementRanks;
  const migratedPlusFive = equipment.normalizeGearItem(legacyPlusFive);
  const migratedPlusFiveAgain = equipment.normalizeGearItem(legacyPlusFive);
  assert.ok(migratedPlusFive && migratedPlusFiveAgain);
  assert.deepEqual(
    migratedPlusFive.enhancementRanks,
    migratedPlusFiveAgain.enhancementRanks,
    "legacy +N allocation must be stable across every load of the same item",
  );
  assert.equal(migratedPlusFive.enhancementRanks.length, baseItem.affixes.length + 1);
  assert.equal(
    migratedPlusFive.enhancementRanks.reduce((total, rank) => total + rank, 0),
    5,
    "legacy +5 gear must receive exactly five random option ranks",
  );

  assert.equal(equipment.normalizeGearItem({ ...baseItem, enhancement: -1 }), null);
  assert.equal(equipment.normalizeGearItem({ ...baseItem, enhancement: 11 }), null);
  assert.equal(equipment.normalizeGearItem({ ...baseItem, enhancement: 1.5 }), null);
  const correctRankLength = baseItem.affixes.length + 1;
  assert.equal(
    equipment.normalizeGearItem({
      ...baseItem,
      enhancement: 1,
      enhancementRanks: [1],
    }),
    null,
    "rank arrays must include the implicit plus every affix",
  );
  assert.equal(
    equipment.normalizeGearItem({
      ...baseItem,
      enhancement: 1,
      enhancementRanks: Array.from({ length: correctRankLength }, () => 0),
    }),
    null,
    "rank sum must exactly equal the enhancement stage",
  );
  assert.equal(
    equipment.normalizeGearItem({
      ...baseItem,
      enhancement: 1,
      enhancementRanks: Array.from(
        { length: correctRankLength },
        (_, index) => (index === 0 ? -1 : index === 1 ? 2 : 0),
      ),
    }),
    null,
    "negative ranks must be rejected even when the sum matches",
  );
  assert.equal(
    equipment.normalizeGearItem({
      ...baseItem,
      enhancement: 1,
      enhancementRanks: Array.from(
        { length: correctRankLength },
        (_, index) => (index === 0 || index === 1 ? 0.5 : 0),
      ),
    }),
    null,
    "fractional ranks must be rejected",
  );

  const optionCount = baseItem.affixes.length + 1;
  for (let optionIndex = 0; optionIndex < optionCount; optionIndex += 1) {
    const result = equipment.applySuccessfulGearEnhancement(
      baseItem,
      (optionIndex + 0.5) / optionCount,
    );
    assert.ok(result, `option ${optionIndex} must be selectable`);
    assert.equal(result.optionIndex, optionIndex);
    assert.equal(result.item.enhancement, 1);
    assert.equal(result.item.enhancementRanks.length, optionCount);
    assert.equal(
      result.item.enhancementRanks.reduce((total, rank) => total + rank, 0),
      1,
    );
    assert.equal(result.item.enhancementRanks[optionIndex], 1);
    assert.equal(
      result.item.powerScore,
      equipment.calculateGearPowerScore(result.item),
      "the shared success helper must immediately refresh derived power",
    );
  }
  assert.equal(equipment.applySuccessfulGearEnhancement(baseItem, -1).optionIndex, 0);
  assert.equal(
    equipment.applySuccessfulGearEnhancement(baseItem, 1).optionIndex,
    optionCount - 1,
    "the upper random boundary must safely select the final option",
  );

  const repeatedOptionIndex = optionCount - 1;
  let repeatedItem = baseItem;
  for (let stage = 0; stage < 5; stage += 1) {
    const result = equipment.applySuccessfulGearEnhancement(
      repeatedItem,
      (repeatedOptionIndex + 0.5) / optionCount,
    );
    assert.ok(result);
    repeatedItem = result.item;
  }
  assert.equal(repeatedItem.enhancement, 5);
  assert.equal(repeatedItem.enhancementRanks[repeatedOptionIndex], 5);
  assert.equal(
    repeatedItem.enhancementRanks.reduce((total, rank) => total + rank, 0),
    5,
    "all five successful stages may land on the same option",
  );
  assert.deepEqual(
    baseItem.enhancementRanks,
    Array.from({ length: optionCount }, () => 0),
    "enhancement must not mutate the original item or its rank array",
  );

  let previousCost = 0;
  const enhancementStates = [baseItem];
  for (let enhancement = 0; enhancement < 10; enhancement += 1) {
    const item = enhancementStates[enhancement];
    const rule = equipment.getGearEnhancementRule(item);
    assert.ok(rule, `+${enhancement} needs a next-stage rule`);
    assert.equal(rule.target, enhancement + 1);
    for (const field of ["successPercent", "failurePercent", "destroyPercent", "ashCost"]) {
      assert.ok(Number.isSafeInteger(rule[field]), `+${enhancement} ${field} must be an integer`);
      assert.ok(rule[field] >= 0, `+${enhancement} ${field} cannot be negative`);
    }
    assert.equal(
      rule.successPercent + rule.failurePercent + rule.destroyPercent,
      100,
      `+${enhancement} outcome chances must total 100%`,
    );
    assert.ok(rule.ashCost > previousCost, `+${enhancement} ash cost must increase by stage`);
    previousCost = rule.ashCost;
    const next = equipment.applySuccessfulGearEnhancement(item, 0);
    assert.ok(next);
    enhancementStates.push(next.item);
  }
  assert.equal(equipment.getGearEnhancementRule(enhancementStates[10]), null);

  const plusFive = enhancementStates[5];
  const plusTen = enhancementStates[10];
  assert.equal(
    equipment.getGearEnhancementAshRefund(plusFive),
    3_414,
    "+5 refund must equal the exact +1 through +5 first-attempt costs",
  );
  assert.equal(
    equipment.getGearEnhancementAshRefund(plusTen),
    15_972,
    "+10 refund must equal the exact +1 through +10 first-attempt costs",
  );
  assert.deepEqual(equipment.getGearSalvageAshBreakdown(baseItem), {
    baseYield: 112,
    enhancementRefund: 0,
    total: 112,
  });
  assert.deepEqual(equipment.getGearSalvageAshBreakdown(plusFive), {
    baseYield: 112,
    enhancementRefund: 3_414,
    total: 3_526,
  });
  assert.deepEqual(equipment.getGearSalvageAshBreakdown(plusTen), {
    baseYield: 112,
    enhancementRefund: 15_972,
    total: 16_084,
  });
  const levelFiftySalvage = equipment.GEAR_RARITIES.map((rarity) =>
    equipment.getGearSalvageAshBreakdown({
      rarity,
      level: 50,
      enhancement: 0,
    }).baseYield,
  );
  assert.deepEqual(levelFiftySalvage, [81, 101, 113, 130, 154, 178, 243, 324]);
  for (let index = 1; index < levelFiftySalvage.length; index += 1) {
    assert.ok(
      levelFiftySalvage[index] > levelFiftySalvage[index - 1],
      "every rarity must return strictly more base ash than the previous tier",
    );
  }
  assert.equal(
    levelFiftySalvage.at(-1),
    levelFiftySalvage[0] * 4,
    "cosmic salvage must return four times the ash of equal-level common gear",
  );
  for (const [index, rarity] of equipment.GEAR_RARITIES.entries()) {
    assert.ok(
      equipment.getGearSalvageAshBreakdown({
        rarity,
        level: 51,
        enhancement: 0,
      }).baseYield > levelFiftySalvage[index],
      `${rarity} salvage must continue scaling with item level`,
    );
  }
  for (let enhancement = 1; enhancement <= 10; enhancement += 1) {
    const currentRefund = equipment.getGearEnhancementAshRefund(
      enhancementStates[enhancement],
    );
    const previousRefund = equipment.getGearEnhancementAshRefund(
      enhancementStates[enhancement - 1],
    );
    const previousRule = equipment.getGearEnhancementRule(
      enhancementStates[enhancement - 1],
    );
    assert.equal(
      currentRefund - previousRefund,
      previousRule.ashCost,
      `+${enhancement} refund delta must equal that stage's deterministic cost`,
    );
  }

  const maxEnhanced = plusTen;
  const baseLoadout = equipment.createEmptyEquipment();
  baseLoadout.armor = baseItem;
  const enhancedLoadout = equipment.createEmptyEquipment();
  enhancedLoadout.armor = maxEnhanced;
  const baseTotals = equipment.aggregateEquipmentStats(baseLoadout);
  const enhancedTotals = equipment.aggregateEquipmentStats(enhancedLoadout);
  const implicitStat = equipment.GEAR_IMPLICIT_OPTION_BY_SLOT[baseItem.slot].stat;
  const implicitGain = Math.round(
    (equipment.getEnhancedGearImplicitValue(plusTen)
      - equipment.getEnhancedGearImplicitValue(baseItem)) * 100,
  ) / 100;
  for (const stat of equipment.GEAR_STAT_KEYS) {
    const actualGain = Math.round((enhancedTotals[stat] - baseTotals[stat]) * 100) / 100;
    const expectedGain = stat === implicitStat ? implicitGain : 0;
    assert.equal(
      actualGain,
      expectedGain,
      `${stat} must ${stat === implicitStat ? "receive the ten selected implicit ranks" : "remain unchanged"}`,
    );
  }
  for (const affix of baseItem.affixes) {
    assert.equal(
      equipment.getEnhancedGearAffixValue(plusTen, affix),
      affix.value,
      `${affix.stat} must remain unchanged when every rank lands on the implicit line`,
    );
  }
});

test("generated room backplates and the archived cartography texture remain intact", async () => {
  const roomAssets = [
    "room-battle.webp",
    "room-horde.webp",
    "room-elite.webp",
    "room-memory.webp",
    "room-shelter.webp",
    "room-boss.webp",
    "room-drowned-archive.webp",
    "room-rootbound-ossuary.webp",
    "room-shattered-astrarium.webp",
  ];
  const stairRoomAssets = roomAssets.map((assetName) =>
    assetName.replace(/\.webp$/, "-stairs-v1.webp"),
  );
  const allMapAssets = [...roomAssets, ...stairRoomAssets, "map-board.webp"];

  for (const assetName of allMapAssets) {
    const relativePath = `public/assets/maps/${assetName}`;
    const webp = await readFile(path.join(root, relativePath));
    const [width, height] = assertWebPIntegrity(webp, relativePath);
    if (assetName === "map-board.webp") {
      assert.equal(width, height, `${relativePath} must remain square`);
      assert.ok(width >= 768, `${relativePath} is too small for the expanded map`);
    } else {
      assert.deepEqual([width, height], [1600, 900], relativePath);
    }
  }

  const [game, css, roomVisuals] = await Promise.all([
    readFile(path.join(root, "app/GameCanvas.tsx"), "utf8"),
    readFile(path.join(root, "app/game.css"), "utf8"),
    readFile(path.join(root, "app/room-visuals.ts"), "utf8"),
  ]);
  for (const assetName of [...roomAssets, ...stairRoomAssets]) {
    assert.match(
      `${game}\n${roomVisuals}`,
      new RegExp(`/assets/maps/${assetName.replace(".", "\\.")}`),
    );
  }
  assert.doesNotMatch(
    css,
    /url\(["']?\/assets\/maps\/map-board\.webp["']?\)/,
    "a painted route must not masquerade as the generated world map",
  );
  assert.doesNotMatch(
    game,
    /environment\s*:\s*["']\/assets\/environment-tile-atlas\.png["']/,
    "the legacy prop atlas must not be loaded as the room background",
  );
  assert.doesNotMatch(
    game,
    /images\.environment\b/,
    "the legacy prop atlas must not be drawn as the room background",
  );
  assert.doesNotMatch(
    css,
    /environment-tile-atlas\.png/,
    "the expanded map must not reuse the legacy prop atlas",
  );
  assert.match(game, /const ROOM_GEOMETRY = \{/);
  assert.match(game, /horizontalDoorTop: HEIGHT \/ 2 - 64/);
  assert.match(game, /verticalDoorLeft: WIDTH \/ 2 - 74/);
  assert.match(game, /player\.x < ROOM_GEOMETRY\.transitionInsetX/);
  assert.match(game, /player\.y < ROOM_GEOMETRY\.transitionInsetY/);
  assert.match(game, /ROOM_DOOR_VISUALS\[backdropKey\]/);
  assert.match(
    game,
    /roomDoorAtlasFrameSourceRect\(frame\)/,
  );
  assert.match(game, /drawRoomDoorAtlasFrame\(animatedDoorFrame\)/);
  assert.match(game, /roomDoorAtlasClipSourceRect\(frame, doorwayClip\)/);
  assert.match(game, /roomDoorClipCanvasRect\(doorwayClip, WIDTH, HEIGHT\)/);
  assert.doesNotMatch(
    game,
    /ROOM_DOOR_PLACEMENTS|ROOM_DOOR_ASSET_PATH|roomPortcullis|room-doors-v3|roomDoorAtlasSourceRect|roomDoorCanvasRect/,
  );
  assert.doesNotMatch(game, /drawDoorWard|traceDiamond/);
  assert.match(game, /transitionOpacity = clamp\(world\.transition \/ 0\.55, 0, 1\)/);
  assert.doesNotMatch(game, /context\.strokeRect\(68, 64, WIDTH - 136, HEIGHT - 128\)/);
});

test("down-stair rooms use complete room-art variants instead of vector geometry", async () => {
  const [visuals, game] = await Promise.all([
    importTypeScriptModule("app/room-visuals.ts"),
    readFile(path.join(root, "app/GameCanvas.tsx"), "utf8"),
  ]);

  const baseKeys = Object.keys(visuals.ROOM_ART_PATHS);
  assert.equal(baseKeys.length, 9);
  assert.equal(Object.keys(visuals.ROOM_STAIR_ART_PATHS).length, baseKeys.length);
  assert.equal(
    Object.keys(visuals.ROOM_STAIR_ART_BY_ROOM_ART).length,
    baseKeys.length,
  );
  assert.equal(
    new Set(Object.values(visuals.ROOM_STAIR_ART_BY_ROOM_ART)).size,
    baseKeys.length,
    "every room family must own one distinct staircase backplate",
  );

  for (const baseKey of baseKeys) {
    const stairKey = visuals.resolveStairRoomArtKey(baseKey);
    const basePath = visuals.ROOM_ART_PATHS[baseKey];
    const stairPath = visuals.ROOM_STAIR_ART_PATHS[stairKey];
    assert.equal(
      stairPath,
      basePath.replace(/\.webp$/, "-stairs-v1.webp"),
      `${baseKey} must resolve to its own staircase backplate`,
    );
  }

  assert.deepEqual(visuals.ROOM_STAIR_ASSET_ANCHOR, {
    sourceWidth: 1600,
    sourceHeight: 900,
    x: 800,
    y: 560,
  });
  assert.match(
    game,
    /const isStairRoom = world\.stairRoomLookup\[currentRoomKey\] === true/,
  );
  assert.match(
    game,
    /const stairRoomArtKey = isStairRoom[\s\S]{0,100}?resolveStairRoomArtKey\(roomArtKey\)/,
  );
  assert.match(game, /stairRoomArt = new Image\(\)/);
  assert.match(game, /stairRoomArt\.decoding = "async"/);
  assert.match(game, /await stairRoomArt\?\.decode\(\)/);
  assert.match(game, /stairRoomArt\.src = ROOM_STAIR_ART_PATHS\[stairRoomArtKey\]/);
  assert.match(game, /if \(\s*stairRoomArtReady &&[\s\S]{0,220}?drawRoomBackplate\(stairRoomArt\)/);
  assert.match(game, /delete imagesRef\.current\[stairRoomArtKey\]/);
  assert.match(game, /attempts < 2/);
  assert.match(
    game,
    /\.slice\(0, activeStairRoomArtKey \? 1 : 2\)/,
    "only the current plus one recent stair backplate may remain cached",
  );
  const preloadBlock = game.slice(
    game.indexOf("const imagePaths: Record<string, string> = {"),
    game.indexOf("for (const config of Object.values(EQUIPMENT_RARITY_VFX))"),
  );
  assert.doesNotMatch(
    preloadBlock,
    /ROOM_STAIR_ART_PATHS/,
    "nine large staircase backplates must not be eagerly decoded at startup",
  );
  assert.doesNotMatch(game, /const stairPulse =/);
  assert.doesNotMatch(game, /context\.ellipse\(0, 24, 76, 42/);
  assert.doesNotMatch(game, /context\.moveTo\(0, 55\)/);
});

test("ordinary room art is deterministic, varied, and never repeats across a doorway", async () => {
  const visuals = await importTypeScriptModule("app/room-visuals.ts");
  const ordinaryKinds = ["battle", "horde", "elite", "memory"];

  for (const roomKind of ordinaryKinds) {
    const seen = new Set();
    for (let y = -12; y <= 12; y += 1) {
      for (let x = -12; x <= 12; x += 1) {
        const options = {
          seed: 0x5eed1234,
          dungeonFloor: 17,
          roomX: x,
          roomY: y,
          roomKind,
        };
        const selected = visuals.resolveRoomArtKey(options);
        assert.equal(
          visuals.resolveRoomArtKey(options),
          selected,
          `${roomKind} art must be stable for ${x},${y}`,
        );
        assert.ok(visuals.ROOM_ART_PATHS[selected], `${selected} must be preloaded`);
        seen.add(selected);

        for (const [dx, dy] of [[1, 0], [0, 1]]) {
          const neighbor = visuals.resolveRoomArtKey({
            ...options,
            roomX: x + dx,
            roomY: y + dy,
          });
          assert.notEqual(
            neighbor,
            selected,
            `${roomKind} art repeated across ${x},${y} -> ${x + dx},${y + dy}`,
          );
        }
      }
    }
    assert.equal(seen.size, 4, `${roomKind} must reach every visual family`);
  }

  for (const roomKind of ["shelter", "boss"]) {
    const seen = new Set();
    for (let floor = 1; floor <= 8; floor += 1) {
      seen.add(visuals.resolveRoomArtKey({
        seed: floor * 73,
        dungeonFloor: floor,
        roomX: floor - 4,
        roomY: 4 - floor,
        roomKind,
      }));
    }
    assert.equal(seen.size, 1, `${roomKind} must keep its signature art`);
  }

  const game = await readFile(path.join(root, "app/GameCanvas.tsx"), "utf8");
  assert.match(game, /const roomArtKey = resolveRoomArtKey\(\{/);
  assert.match(game, /data-room-art=\{currentRoomArtKey\}/);
  assert.match(game, /data-room-theme=\{ROOM_ART_NAMES\[currentRoomArtKey\]\}/);
});

test("the minimap preserves a 99x99 world while the full atlas frames the discovered sector", async () => {
  const [source, css] = await Promise.all([
    readFile(path.join(root, "app/GameCanvas.tsx"), "utf8"),
    readFile(path.join(root, "app/game.css"), "utf8"),
  ]);

  assert.match(
    source,
    /const ROOM_DIRECTIONS = \[\s*\[0, -1\],\s*\[1, 0\],\s*\[0, 1\],\s*\[-1, 0\],\s*\] as const/,
    "north/east/south/west room offsets must match screen orientation",
  );
  assert.match(source, /const knownCoordinates = Object\.keys\(world\.rooms\)/);
  assert.match(source, /const sectorPadding = 3;/);
  assert.match(source, /const minimumSectorRadius = 6;/);
  assert.match(
    source,
    /const minimumX = large\s*\? Math\.max\([\s\S]{0,180}?DUNGEON_MIN_COORDINATE,[\s\S]{0,180}?discoveredMinimumX - sectorPadding[\s\S]{0,120}?world\.roomX - minimumSectorRadius/,
  );
  assert.match(
    source,
    /const maximumX = large\s*\? Math\.min\([\s\S]{0,180}?DUNGEON_MAX_COORDINATE,[\s\S]{0,180}?discoveredMaximumX \+ sectorPadding[\s\S]{0,120}?world\.roomX \+ minimumSectorRadius/,
  );
  assert.match(
    source,
    /const minimumY = large\s*\? Math\.max\([\s\S]{0,180}?discoveredMinimumY - sectorPadding[\s\S]{0,120}?world\.roomY - minimumSectorRadius/,
  );
  assert.match(
    source,
    /const maximumY = large\s*\? Math\.min\([\s\S]{0,180}?discoveredMaximumY \+ sectorPadding[\s\S]{0,120}?world\.roomY \+ minimumSectorRadius/,
  );
  assert.match(source, /gridColumn: x - minimumX \+ 1/);
  assert.match(source, /gridRow: y - minimumY \+ 1/);
  assert.match(source, /room \? `is-\$\{room\.kind\}` : ""/);
  assert.match(source, /data-room-kind=\{room\?\.kind \?\? "unknown"\}/);
  assert.match(source, /data-cleared=\{Boolean\(room\?\.cleared\)\}/);
  assert.match(source, /data-visited=\{wasVisited\}/);
  assert.match(
    source,
    /const stairsRevealed =\s*wasVisited && Boolean\(room\?\.cleared\) && world\.stairRoomLookup\[key\] === true;/,
    "an adjacent pre-generated room must not expose its staircase before visit and conquest",
  );
  assert.match(source, /data-stairs-revealed=\{stairsRevealed\}/);
  assert.match(source, /stairsRevealed \? "is-stairs" : ""/);
  assert.equal(
    (source.match(/stairsRevealed \? <span className="map-room-emblem map-room-emblem--stairs"/g) ?? []).length,
    1,
    "the shared cell visual must own one revealed-stair emblem",
  );
  assert.match(source, /data-map-world-columns=\{DUNGEON_MAX_COORDINATE - DUNGEON_MIN_COORDINATE \+ 1\}/);
  assert.match(source, /data-map-world-rows=\{DUNGEON_MAX_COORDINATE - DUNGEON_MIN_COORDINATE \+ 1\}/);
  assert.match(source, /data-map-view=\{large \? "discovered-sector" : "local"\}/);
  assert.match(source, /rooms: Object\.fromEntries\(/);
  assert.match(source, /visited: \[\.\.\.world\.visited\]/);
  assert.match(source, /dungeonFloor: world\.dungeonFloor/);
  assert.match(source, /stairRoomLookup: \{ \.\.\.world\.stairRoomLookup \}/);
  assert.match(
    source,
    /<MapGrid[\s\S]{0,220}?world=\{mapSnapshot\}[\s\S]{0,120}?large[\s\S]{0,260}?onTeleport=\{teleportToVisitedRoom\}/,
  );
  assert.doesNotMatch(source, /<MapGrid world=\{hud\.world\} radius=\{5\} large \/>/);
  assert.match(source, /data-known-rooms=\{hud\.world\.knownRoomCount\}/);
  assert.match(source, /if \(modeRef\.current === "playing"\) openMap\(\)/);

  assert.match(css, /\.minimap-grid \{[\s\S]*?width: 84px;[\s\S]*?height: 84px;/);
  assert.match(
    css,
    /@container game-viewport \(max-width: 620px\)[\s\S]*?\.minimap-grid:not\(\.is-large\) \{[\s\S]*?width: 70px;[\s\S]*?height: 70px;/,
  );
  assert.match(css, /\.minimap-grid\.is-large \{[\s\S]*?var\(--map-columns/);
  assert.match(css, /\.minimap-grid\.is-large \{[\s\S]*?var\(--map-rows/);
  assert.match(css, /\.minimap-grid\.is-large \.map-cell::after\s*\{[\s\S]*?--path-north/);
  assert.match(css, /\.map-cell-node\s*\{[\s\S]*?clip-path:\s*polygon/);
  assert.match(css, /\.map-cell\.is-stairs\s*\{/);
  assert.match(css, /\.map-room-emblem--stairs\s*\{/);
  for (const kind of ["battle", "horde", "elite", "memory", "shelter", "boss"]) {
    assert.match(css, new RegExp(`\\.map-cell\\.is-${kind}\\s*\\{`), `${kind} needs a map style`);
  }
  assert.doesNotMatch(css, /map-board\.webp/);
});

test("the purchased wayfinder teleports only between safe visited and cleared map rooms", async () => {
  const dungeonFloorUrl = await typeScriptModuleUrl("app/dungeon-floor.ts");
  const [travel, source, shopOverlay, css] = await Promise.all([
    importTypeScriptModule("app/map-teleport.ts", {
      "./dungeon-floor": dungeonFloorUrl,
    }),
    readFile(path.join(root, "app/GameCanvas.tsx"), "utf8"),
    readFile(path.join(root, "app/ShopOverlay.tsx"), "utf8"),
    readFile(path.join(root, "app/game.css"), "utf8"),
  ]);

  const available = {
    hasEntitlement: true,
    departureSafe: true,
    current: false,
    known: true,
    visited: true,
    cleared: true,
  };
  assert.equal(travel.getMapTeleportStatus(available), "available");
  assert.equal(travel.getMapTeleportStatus({ ...available, current: true }), "current");
  assert.equal(
    travel.getMapTeleportStatus({ ...available, hasEntitlement: false }),
    "locked-product",
  );
  assert.equal(
    travel.getMapTeleportStatus({ ...available, departureSafe: false }),
    "combat-locked",
  );
  assert.equal(travel.getMapTeleportStatus({ ...available, known: false }), "unknown");
  assert.equal(
    travel.getMapTeleportStatus({ ...available, visited: false }),
    "unvisited",
    "a pre-scouted cleared shelter must not be a travel destination",
  );
  assert.equal(travel.getMapTeleportStatus({ ...available, cleared: false }), "uncleared");
  assert.deepEqual(
    Object.keys(travel.MAP_TELEPORT_STATUS_LABELS).sort(),
    ["available", "combat-locked", "current", "locked-product", "uncleared", "unknown", "unvisited"],
  );

  for (const [x, y] of [[-49, -49], [-12, 7], [0, 0], [49, 49]]) {
    assert.equal(travel.isSafeMapCoordinate(x, y), true);
  }
  for (const [x, y] of [
    [-50, 0],
    [50, 0],
    [0, -50],
    [0, 50],
    [1.5, 2],
    [Number.NaN, 2],
    [Number.POSITIVE_INFINITY, 2],
    [Number.MAX_SAFE_INTEGER + 1, 0],
  ]) {
    assert.equal(travel.isSafeMapCoordinate(x, y), false);
  }
  assert.deepEqual(travel.parseMapCoordinateKey("-12,7"), { x: -12, y: 7 });
  for (const key of ["-50,0", "50,0", "1,2,3", "01,2", "+1,2", "1,2foo", "1", "", "-0,2"]) {
    assert.equal(travel.parseMapCoordinateKey(key), null, `${key} must not become a map target`);
  }

  const safeDeparture = { roomCleared: true, enemyCount: 0, transition: 0 };
  assert.equal(travel.isMapTeleportDepartureSafe(safeDeparture), true);
  assert.equal(
    travel.isMapTeleportDepartureSafe({ ...safeDeparture, roomCleared: false }),
    false,
  );
  for (const enemyCount of [1, -1, 0.5]) {
    assert.equal(
      travel.isMapTeleportDepartureSafe({ ...safeDeparture, enemyCount }),
      false,
    );
  }
  for (const transition of [0.01, Number.NaN]) {
    assert.equal(
      travel.isMapTeleportDepartureSafe({ ...safeDeparture, transition }),
      false,
    );
  }

  assert.match(source, /visited: world\.visitedLookup\[targetKey\] === true/);
  assert.match(
    source,
    /const liveWorld = worldRef\.current;[\s\S]{0,700}?const liveStatus = getMapTeleportStatus/,
    "the confirmation action must revalidate against the live world",
  );
  assert.match(source, /hasMapTeleportEntitlement\(readShopEntitlements\(\)\)/);
  assert.match(source, /enterRoom\(x, y, "center"\)/);
  assert.match(source, /arrivalWorld\.effects\.push\(\{[\s\S]{0,180}?kind: "teleport"/);
  assert.match(source, /setShopPreferredProductId\(MAP_TELEPORT_PRODUCT_ID\)/);
  assert.match(source, /preferredProductId=\{shopPreferredProductId\}/);
  assert.match(source, /onClick=\{\(\) => \{[\s\S]{0,160}?openWayfinderShop\(\)/);
  assert.match(source, /if \(large && onTeleport\) \{[\s\S]{0,1600}?<button/);
  assert.match(source, /role=\{large && onTeleport \? "group" : "img"\}/);
  assert.match(source, /aria-disabled=\{teleportStatus !== "available"\}/);
  assert.match(source, /tabIndex=\{current \? 0 : -1\}/);
  assert.match(source, /ArrowUp:\s*\[0, -1\]/);
  assert.match(source, /event\.key === "Home"/);
  assert.match(source, /<MapGrid world=\{hud\.world\} \/>/);
  assert.match(shopOverlay, /shop-product--travel/);
  assert.match(shopOverlay, /preferredProductId\?: ShopProductId \| null/);
  assert.match(
    shopOverlay,
    /preferredProductId && findShopProduct\(preferredProductId\)[\s\S]{0,80}?preferredProductId/,
  );
  assert.match(source, /key=\{`game-shop-\$\{shopPreferredProductId \?\? "default"\}`\}/);
  assert.match(shopOverlay, /지도 순간이동/);
  assert.match(css, /button\.map-cell\.is-teleportable/);
  assert.match(css, /\.shop-bag-illustration\.is-wayfinder::before/);
});

test("the release cartography UI uses authored chrome without rectangular underpaint", async () => {
  const framePath = "public/assets/ui/cartography/cartography-frame-v1.png";
  const buttonPath = "public/assets/ui/cartography/cartography-command-button-v1.png";
  const [source, css, formCss, framePng, buttonPng, manifest] = await Promise.all([
    readFile(path.join(root, "app/GameCanvas.tsx"), "utf8"),
    readFile(path.join(root, "app/game.css"), "utf8"),
    readFile(path.join(root, "app/ui-form-controls.css"), "utf8"),
    readFile(path.join(root, framePath)),
    readFile(path.join(root, buttonPath)),
    readFile(path.join(root, "public/assets/ui/cartography/cartography-ui-v1.build.json"), "utf8").then(JSON.parse),
  ]);

  const frame = decodeRgbaPng(framePng, framePath);
  const button = decodeRgbaPng(buttonPng, buttonPath);
  assert.deepEqual([frame.width, frame.height], [1536, 1024]);
  assert.deepEqual([button.width, button.height], [1200, 240]);
  for (const [image, label, minimumMoat] of [
    [frame, framePath, 20],
    [button, buttonPath, 20],
  ]) {
    const margins = alphaCellMetrics(image, 0, 0, 1, 1, label);
    for (const side of ["left", "right", "top", "bottom"]) {
      assert.ok(margins[side] >= minimumMoat, `${label} ${side} moat is only ${margins[side]}px`);
    }
    for (const [x, y] of [[0, 0], [image.width - 1, 0], [0, image.height - 1], [image.width - 1, image.height - 1]]) {
      assert.equal(image.pixels[(y * image.width + x) * 4 + 3], 0, `${label} corner must stay transparent`);
    }
  }
  assert.equal(manifest.generator, "OpenAI built-in image_gen");
  assert.equal(manifest.outputs.length, 2);

  const primaryRule = css.match(/\.primary-button,\s*\.secondary-button\s*\{([\s\S]*?)\}/)?.[1] ?? "";
  assert.match(primaryRule, /primary-button\.png/);
  assert.doesNotMatch(primaryRule, /destructive-button\.png/);
  assert.match(primaryRule, /background:\s*transparent;/);
  assert.match(primaryRule, /box-shadow:\s*none;/);
  assert.match(primaryRule, /filter:\s*drop-shadow/);
  assert.match(css, /\.primary-button::after,[\s\S]{0,80}?\.secondary-button::after\s*\{[\s\S]{0,80}?content:\s*none;/);

  assert.match(css, /\.map-modal-chrome\s*\{[\s\S]{0,260}?cartography-frame-v1\.png/);
  assert.match(css, /\.map-modal\s*\{[\s\S]{0,340}?aspect-ratio:\s*3\s*\/\s*2/);
  assert.match(css, /\.map-modal\s*\{[\s\S]{0,520}?background:\s*transparent;[\s\S]{0,80}?box-shadow:\s*none/);
  assert.match(css, /\.map-modal::before\s*\{[\s\S]{0,220}?inset:\s*52px 58px;[\s\S]{0,420}?clip-path:\s*polygon/);
  assert.match(css, /\.map-modal > :not\(\.map-modal-chrome\):is\(header, footer\)\s*\{[\s\S]{0,80}?z-index:\s*6/);
  assert.match(css, /\.map-modal > header \.map-close\s*\{[\s\S]{0,420}?inventory-controls\/close\.png/);
  assert.match(css, /\.map-continue-button\s*\{[\s\S]{0,420}?aspect-ratio:\s*5\s*\/\s*1[\s\S]{0,420}?cartography-command-button-v1\.png[\s\S]{0,180}?box-shadow:\s*none/);
  assert.match(css, /\.map-board\s*\{[\s\S]{0,760}?scrollbar-width:\s*none/);
  assert.match(css, /\.map-board::-webkit-scrollbar\s*\{[\s\S]{0,100}?display:\s*none/);
  assert.match(css, /\.game-viewport \.map-board::-webkit-scrollbar-track-piece,[\s\S]{0,360}?background:\s*transparent\s*!important/);
  assert.match(css, /\.map-recenter-button\s*\{/);
  assert.doesNotMatch(source, /className="primary-button compact"[^>]*>[\s\S]{0,80}?탐험 계속/);
  assert.match(source, /className="map-continue-button"[\s\S]{0,120}?탐험 계속/);

  assert.match(formCss, /Complete art controls carry transparent gutters/);
  assert.match(formCss, /\.map-continue-button,[\s\S]{0,520}?:focus-visible\s*\{[\s\S]{0,120}?outline:\s*none/);
});

test("the full map traps focus, restores its caller, and supports keyboard and pointer panning", async () => {
  const source = await readFile(path.join(root, "app/GameCanvas.tsx"), "utf8");
  assert.match(source, /const mapDialogRef = useRef<HTMLElement \| null>\(null\)/);
  assert.match(source, /const mapReturnFocusRef = useRef<HTMLElement \| null>\(null\)/);
  assert.match(source, /mapReturnFocusRef\.current =\s*document\.activeElement instanceof HTMLElement/);
  assert.match(source, /const closeMap = useCallback\([\s\S]{0,380}?returnTarget\?\.isConnected[\s\S]{0,80}?returnTarget\.focus\(\)/);
  assert.match(source, /ref=\{mapDialogRef\}[\s\S]{0,180}?aria-modal="true"[\s\S]{0,80}?tabIndex=\{-1\}/);
  assert.match(source, /if \(gameConfirmationOpenRef\.current\) \{[\s\S]{0,180}?closeGameConfirmation\(\);[\s\S]{0,80}?return;[\s\S]{0,120}?if \(modeRef\.current === "map"\)/);
  assert.match(source, /if \(modeRef\.current === "map"\) \{[\s\S]{0,220}?key === "m" \|\| key === "escape"/);
  assert.ok(
    source.indexOf('if (modeRef.current === "map")') < source.indexOf('if (isInteractive && key !== "escape") return;'),
    "map keyboard handling must run before the generic interactive-control early return",
  );
  assert.match(source, /key === "tab"[\s\S]{0,760}?last\.focus\(\)[\s\S]{0,260}?first\.focus\(\)/);
  assert.match(source, /onPointerDown=\{\(event\) =>[\s\S]{0,760}?setPointerCapture/);
  assert.match(source, /onPointerMove=\{\(event\) =>[\s\S]{0,560}?scrollLeft[\s\S]{0,180}?scrollTop/);
  assert.match(source, /onWheel=\{\(event\) =>[\s\S]{0,220}?event\.shiftKey[\s\S]{0,220}?scrollLeft/);
  assert.match(source, /className="map-recenter-button"[\s\S]{0,120}?onClick=\{centerMapOnCurrent\}/);
  assert.match(source, /className="map-close"[\s\S]{0,100}?onClick=\{closeMap\}/);
  assert.match(source, /className="map-continue-button" onClick=\{closeMap\}/);
});

test("player movement is constrained to the walkable floor while open door corridors remain passable", async () => {
  const [source, collisionSource] = await Promise.all([
    readFile(path.join(root, "app/GameCanvas.tsx"), "utf8"),
    readFile(path.join(root, "app/room-collision.ts"), "utf8"),
  ]);
  assert.match(
    collisionSource,
    /export const WALKABLE_FLOOR_POLYGON\s*=\s*\[[\s\S]{0,700}?\] as const;/,
    "the room floor needs an explicit collision polygon",
  );
  assert.match(
    source,
    /import \{[\s\S]{0,160}?WALKABLE_FLOOR_POLYGON,[\s\S]{0,180}?\} from "\.\/room-collision";/,
    "players, enemies, and loot must share one polygon source of truth",
  );
  assert.match(
    source,
    /function pointInsideWalkableFloor[\s\S]{0,900}?WALKABLE_FLOOR_POLYGON/,
  );
  const constraintStart = source.indexOf("function constrainPlayerToWalkableFloor(");
  const constraintEnd = source.indexOf("const isLocalRarityShowcaseHost", constraintStart);
  assert.ok(constraintStart >= 0 && constraintEnd > constraintStart);
  const constraint = source.slice(constraintStart, constraintEnd);
  assert.match(constraint, /doors: DungeonDoorAccess/);
  assert.match(
    constraint,
    /const canUseHorizontalDoor =[\s\S]{0,220}?player\.x < WIDTH \/ 2 && doors\.west[\s\S]{0,120}?player\.x >= WIDTH \/ 2 && doors\.east[\s\S]{0,160}?if \(canUseHorizontalDoor\) \{[\s\S]{0,120}?player\.x = clamp\(/,
    "horizontal corridors must open only toward the available west/east door",
  );
  assert.match(
    constraint,
    /const canUseVerticalDoor =[\s\S]{0,220}?player\.y < HEIGHT \/ 2 && doors\.north[\s\S]{0,120}?player\.y >= HEIGHT \/ 2 && doors\.south[\s\S]{0,160}?if \(canUseVerticalDoor\) \{[\s\S]{0,120}?player\.y = clamp\(/,
    "vertical corridors must open only toward the available north/south door",
  );
  assert.match(
    source,
    /if \(pointInsideWalkableFloor\(player\.x, player\.y\)\) return;[\s\S]{0,1600}?player\.x\s*=\s*closestX;[\s\S]{0,80}?player\.y\s*=\s*closestY;/,
    "out-of-bounds movement must project back to the nearest polygon edge",
  );
  assert.match(
    source,
    /player\.x \+= dx \* speed \* dt;[\s\S]{0,4000}?const doors = dungeonDoorAccess\(\s*world\.roomX,\s*world\.roomY,\s*roomDoorsPassable\(world\.doorMotion\),?\s*\);[\s\S]{0,1800}?constrainPlayerToWalkableFloor\(player, doors\);/,
    "movement must stay sealed until the authored door animation reaches its open state",
  );
});

test("room gates use opaque room-baked assets for closing, opening, rendering, and traversal", async () => {
  const source = await readFile(path.join(root, "app/GameCanvas.tsx"), "utf8");
  const doorSource = await readFile(path.join(root, "app/room-doors.ts"), "utf8");

  assert.match(doorSource, /ROOM_DOOR_FRAME_COUNT = 6/);
  assert.match(source, /ROOM_DOOR_VISUALS\[backdropKey\]/);
  assert.doesNotMatch(source, /ROOM_DOOR_PLACEMENTS|ROOM_DOOR_ASSET_PATH|roomPortcullis/);
  assert.match(source, /world\.doorMotion = createRoomDoorMotion\(world\.roomCleared\)/);
  assert.match(source, /world\.doorMotion = beginRoomDoorOpening\(world\.doorMotion\)/);
  assert.match(source, /world\.doorMotion = advanceRoomDoorMotion\(world\.doorMotion, dt\)/);
  assert.match(source, /world\.transition <= ROOM_DOOR_CLOSE_REVEAL_TRANSITION/);
  assert.match(source, /roomDoorAtlasFrameSourceRect\(frame\)/);
  assert.match(source, /roomDoorVisual\.doorwayClips\[authoredSide\]/);
  assert.match(
    source,
    /drawRoomDoorAtlasFrame\(animatedDoorFrame\)/,
  );
  assert.match(source, /roomDoorAtlasClipSourceRect\(frame, doorwayClip\)/);
  assert.match(source, /roomDoorClipCanvasRect\(doorwayClip, WIDTH, HEIGHT\)/);
  assert.match(
    source,
    /if \(existingDoorways\[physicalSide\]\) continue;\s*drawRoomDoorAtlasFrame\(0, authoredDoorwayClip\(physicalSide\)\)/,
  );
  assert.doesNotMatch(
    source,
    /room-doors-v3|roomDoorAtlasSourceRect|roomDoorCanvasRect|drawRoomDoorPatch/,
    "each state must remain a complete room map, not a standalone door overlay",
  );
  assert.match(source, /const animatedDoorFrame = roomDoorFrame\(world\.doorMotion\)/);
  assert.match(source, /roomDoorsPassable\(world\.doorMotion\) && world\.transition <= 0/);
  assert.doesNotMatch(
    source,
    /dungeonDoorAccess\(\s*world\.roomX,\s*world\.roomY,\s*world\.roomCleared/,
    "roomCleared must not visually or physically open the gate before frame four",
  );
});

test("enemy bodies, teleports, summons, and death loot stay on the walkable room floor", async () => {
  const [collision, source] = await Promise.all([
    importTypeScriptModule("app/room-collision.ts"),
    readFile(path.join(root, "app/GameCanvas.tsx"), "utf8"),
  ]);
  const polygon = collision.WALKABLE_FLOOR_POLYGON;

  assert.equal(collision.pointInsideConvexPolygon({ x: 640, y: 360 }, polygon), true);
  for (const clearance of [0, 21, 32, 62]) {
    for (const [x, y] of [
      [82, 360],
      [1198, 360],
      [640, 78],
      [640, 642],
      [130, 120],
      [1160, 110],
      [120, 610],
      [1160, 610],
    ]) {
      const projected = collision.projectPointToConvexPolygon(
        x,
        y,
        polygon,
        clearance,
      );
      assert.equal(
        collision.pointInsideConvexPolygon(projected, polygon, clearance),
        true,
        `${x},${y} with ${clearance}px clearance must land on the field`,
      );
      const repeated = { ...projected };
      assert.equal(
        collision.constrainPointToConvexPolygon(repeated, polygon, clearance),
        false,
        "a safe projection must be idempotent",
      );
      assert.deepEqual(repeated, projected);
    }
    for (let x = 82; x <= 1198; x += 37) {
      for (let y = 78; y <= 642; y += 29) {
        const projected = collision.projectPointToConvexPolygon(
          x,
          y,
          polygon,
          clearance,
        );
        assert.equal(
          collision.pointInsideConvexPolygon(projected, polygon, clearance),
          true,
          `grid projection ${x},${y}/${clearance}`,
        );
      }
    }
  }
  const reversedPolygon = [...polygon].reverse();
  const reversedProjection = collision.projectPointToConvexPolygon(
    120,
    110,
    reversedPolygon,
    62,
  );
  assert.equal(
    collision.pointInsideConvexPolygon(reversedProjection, reversedPolygon, 62),
    true,
    "polygon winding must not weaken wall collision",
  );

  const bossDeath = collision.projectPointToConvexPolygon(130, 120, polygon, 62);
  const bossDrops = [-26, 26].map((offset) =>
    collision.projectPointToConvexPolygon(
      bossDeath.x + offset,
      bossDeath.y + 12,
      polygon,
      40,
    ),
  );
  for (const drop of bossDrops) {
    assert.equal(collision.pointInsideConvexPolygon(drop, polygon, 40), true);
  }
  assert.ok(
    Math.hypot(
      bossDrops[0].x - bossDrops[1].x,
      bossDrops[0].y - bossDrops[1].y,
    ) > 20,
    "two boss drops must remain visibly distinct after wall projection",
  );

  assert.match(
    source,
    /const spawnPoint = safeWalkableFloorPoint\(x, y, radius\);[\s\S]{0,520}?return \{[\s\S]{0,120}?x: spawnPoint\.x,[\s\S]{0,80}?y: spawnPoint\.y,[\s\S]{0,80}?radius,/,
    "every makeEnemy caller must receive the normalized spawn coordinate",
  );
  assert.match(
    source,
    /const memoryDropPoint = safeWalkableFloorPoint\([\s\S]{0,180}?MEMORY_DROP_WALL_CLEARANCE[\s\S]{0,220}?x: memoryDropPoint\.x,[\s\S]{0,80}?y: memoryDropPoint\.y/,
    "memory fragments need their own safe death coordinate",
  );
  assert.match(
    source,
    /const gearDropPoint = safeWalkableFloorPoint\([\s\S]{0,260}?GEAR_DROP_WALL_CLEARANCE[\s\S]{0,320}?x: gearDropPoint\.x,[\s\S]{0,80}?y: gearDropPoint\.y[\s\S]{0,260}?spawnLootAwakening\(gearDropPoint\.x, gearDropPoint\.y, item\.rarity\)/,
    "the ground item and its awakening effect must share one safe coordinate",
  );
  assert.doesNotMatch(
    source,
    /enemy\.x = clamp\(enemy\.x, 82, WIDTH - 82\)/,
    "the obsolete rectangular enemy clamp would still admit diagonal wall space",
  );
  assert.match(
    source,
    /const candidate = safeWalkableFloorPoint\([\s\S]{0,700}?enemy\.radius[\s\S]{0,180}?const candidateX = candidate\.x;[\s\S]{0,80}?const candidateY = candidate\.y;/,
    "the boss teleport telegraph and arrival need one radius-safe target",
  );
  assert.match(
    source,
    /const target = safeWalkableFloorPoint\([\s\S]{0,700}?SUMMON_WALL_CLEARANCE[\s\S]{0,220}?spawnVisualEffect\([\s\S]{0,80}?target\.x,[\s\S]{0,80}?target\.y \+ 8/,
    "boss summon telegraphs must also be painted on safe floor",
  );
  assert.match(
    source,
    /bestTargetX = candidateX;[\s\S]{0,80}?bestTargetY = candidateY;[\s\S]{0,180}?enemy\.patternTargetX = bestTargetX;[\s\S]{0,80}?enemy\.patternTargetY = bestTargetY;/,
    "the boss must retain the selected safe teleport candidate",
  );
  assert.match(
    source,
    /pattern === "teleport"[\s\S]{0,160}?enemy\.x = enemy\.patternTargetX \?\? enemy\.x;[\s\S]{0,80}?enemy\.y = enemy\.patternTargetY \?\? enemy\.y;[\s\S]{0,160}?spawnVisualEffect\("teleport", enemy\.x, enemy\.y \+ 8/,
    "the boss arrival must consume the same safe target used by its telegraph",
  );
  assert.match(
    source,
    /const summonedEnemy = makeEnemy\([\s\S]{0,260}?world\.enemies\.push\(summonedEnemy\)[\s\S]{0,160}?summonedEnemy\.x,[\s\S]{0,80}?summonedEnemy\.y \+ 8/,
    "summon VFX and the spawned enemy must use the same normalized location",
  );
  assert.equal(
    (source.match(/const chargeHitWall = constrainEnemyToWalkableFloor\(enemy\);/g) ?? [])
      .length,
    2,
    "both charge enemies must collide before swept-hit evaluation",
  );

  const chargeContracts = [
    {
      start: "const chargeSpeed = 650;",
      end: '} else if (bossPhase === "timeRifts")',
    },
    {
      start: "const chargeSpeed = enemy.elite ? 760 : 680;",
      end: "          } else {\n            enemy.moving = false;",
    },
  ];
  for (const contract of chargeContracts) {
    const start = source.indexOf(contract.start);
    const end = source.indexOf(contract.end, start);
    assert.ok(start >= 0 && end > start, contract.start);
    const branch = source.slice(start, end);
    const movement = branch.indexOf("enemy.x +=");
    const constraint = branch.indexOf("const chargeHitWall = constrainEnemyToWalkableFloor(enemy);");
    const sweptHit = branch.indexOf("distanceToSegment(");
    const wallRecovery = branch.indexOf("chargeHitWall ||");
    assert.ok(
      movement >= 0 &&
        movement < constraint &&
        constraint < sweptHit &&
        sweptHit < wallRecovery,
      `${contract.start} must use its wall-clipped endpoint for hit and recovery`,
    );
  }

  const updateStart = source.indexOf("const now = performance.now();");
  const updateEnd = source.indexOf("const orbitRank = powerRankOf(player, \"orbit\")", updateStart);
  assert.ok(updateStart >= 0 && updateEnd > updateStart);
  const enemyUpdate = source.slice(updateStart, updateEnd);
  const finalConstraint = enemyUpdate.indexOf("\n        constrainEnemyToWalkableFloor(enemy);");
  const rangedAttack = enemyUpdate.indexOf("if (enemy.kind === 1 && enemy.shootCooldown <= 0)");
  const ordinaryTeleport = enemyUpdate.indexOf("const teleportTarget = safeWalkableFloorPoint(");
  assert.ok(finalConstraint >= 0 && finalConstraint < rangedAttack);
  assert.ok(rangedAttack < ordinaryTeleport);
  const teleportEnd = enemyUpdate.indexOf("const bossCanDealContactDamage", ordinaryTeleport);
  const teleportBlock = enemyUpdate.slice(ordinaryTeleport, teleportEnd);
  const teleportRadius = teleportBlock.indexOf("enemy.radius");
  const applyTeleportX = teleportBlock.indexOf("enemy.x = teleportTarget.x;");
  const applyTeleportY = teleportBlock.indexOf("enemy.y = teleportTarget.y;");
  const arrivalEffect = teleportBlock.indexOf('spawnVisualEffect("teleport", enemy.x');
  const arrivalShot = teleportBlock.indexOf("spawnHostileProjectile(enemy.x, enemy.y");
  assert.ok(
    teleportRadius >= 0 &&
      teleportRadius < applyTeleportX &&
      applyTeleportX < applyTeleportY &&
      applyTeleportY < arrivalEffect &&
      arrivalEffect < arrivalShot,
    "ordinary teleport must apply its radius-safe target before VFX and firing",
  );
  const localShowcaseStart = source.indexOf(
    "for (const [index, rarity] of lootVfxShowcaseRarities.entries())",
  );
  const localShowcaseEnd = source.indexOf(
    "const spawnLocalEnemyVfxShowcase",
    localShowcaseStart,
  );
  const localShowcaseBlock = source.slice(localShowcaseStart, localShowcaseEnd);
  const localSafePosition = localShowcaseBlock.indexOf(
    "const safePosition = safeWalkableFloorPoint(",
  );
  const localWallClearance = localShowcaseBlock.indexOf(
    "GEAR_DROP_WALL_CLEARANCE",
    localSafePosition,
  );
  const localDropPush = localShowcaseBlock.indexOf("world.gearDrops.push({", localWallClearance);
  const localDropX = localShowcaseBlock.indexOf("x: safePosition.x,", localDropPush);
  const localDropY = localShowcaseBlock.indexOf("y: safePosition.y,", localDropX);
  const localAwakening = localShowcaseBlock.indexOf(
    "spawnLootAwakening(safePosition.x, safePosition.y, rarity, false)",
    localDropY,
  );
  assert.ok(
    localShowcaseStart >= 0 &&
      localShowcaseEnd > localShowcaseStart &&
      localSafePosition >= 0 &&
      localSafePosition < localWallClearance &&
      localWallClearance < localDropPush &&
      localDropPush < localDropX &&
      localDropX < localDropY &&
      localDropY < localAwakening,
    "the local VFX showcase must preserve the same GearDrop invariant",
  );
});

test("corrected augment icons, memory pickups, and layered projectile VFX stay wired", async () => {
  const iconPath = "public/assets/augment-icons-v2.webp";
  const iconAtlas = await readFile(path.join(root, iconPath));
  assert.deepEqual(assertWebPIntegrity(iconAtlas, iconPath), [1280, 1024]);

  const pickupPath = "public/assets/pickups/memory-fragments.png";
  const pickups = await readFile(path.join(root, pickupPath));
  assert.equal(pickups.subarray(1, 4).toString("ascii"), "PNG", pickupPath);
  assert.deepEqual([pickups.readUInt32BE(16), pickups.readUInt32BE(20)], [1254, 1254]);
  assert.equal(pickups[25], 6, `${pickupPath} must keep its alpha channel`);
  assert.ok(pickups.length > 500_000, `${pickupPath} looks unexpectedly truncated`);

  const [source, css] = await Promise.all([
    readFile(path.join(root, "app/GameCanvas.tsx"), "utf8"),
    readFile(path.join(root, "app/game.css"), "utf8"),
  ]);
  assert.match(css, /\.augment-icon[\s\S]*augment-icons-v2\.webp/);
  assert.match(source, /backgroundSize: `\$\{size \* 5\}px \$\{size \* 4\}px`/);
  assert.match(source, /memoryFragments: "\/assets\/pickups\/memory-fragments\.png"/);
  assert.doesNotMatch(
    source,
    /#78e3cd/i,
    "the legacy teal circle must not be drawn behind or after memory-fragment sprites",
  );
  assert.match(source, /shouldDrawProjectileTrail\([\s\S]{0,180}?drawProjectileVfx\(projectile, ambientTime, projectileCount, "trail"\)/);
  assert.match(source, /drawProjectileVfx\(projectile, ambientTime, projectileCount, "core"\)/);
  assert.match(source, /spawnCombatEffect\(\s*"chainArc"/);
  assert.match(source, /distanceToSegment\(/);
  for (const affinity of ["arcane", "ember", "storm", "frost", "poison", "echo", "enemy", "witch", "boss"]) {
    assert.match(source, new RegExp(`\\| "${affinity}"`), `${affinity} projectile VFX is missing`);
  }
});

test("enemy-specific direction synthesis and both behavior effects stay wired", async () => {
  const source = await readFile(path.join(root, "app/GameCanvas.tsx"), "utf8");
  assert.match(source, /withered-walk-v2\.png/);
  assert.doesNotMatch(source, /walkWithered:\s*"\/assets\/walk\/withered-walk\.png"/);
  assert.match(source, /makeDirectionFrames\(\[0, 1, 6, 5, 4, 3, 2, 1\], \[false, true\]\)/);
  assert.match(source, /makeDirectionFrames\(\[0, 1, 2, 5, 4, 3, 2, 1\], \[false, true, true\]\)/);
  assert.match(source, /spawnVisualEffect\("summon"/);
  assert.match(source, /spawnVisualEffect\("teleport"/);
  assert.match(source, /summon-rift\.png/);
  assert.match(source, /teleport-rift\.png/);
});

test("the Crimson Proofreader keeps its unique eight-direction charge pattern wired", async () => {
  const source = await readFile(path.join(root, "app/GameCanvas.tsx"), "utf8");

  assert.match(
    source,
    /type EnemyKind\s*=\s*0\s*\|\s*1\s*\|\s*2\s*\|\s*3\s*\|\s*4\s*\|\s*5\s*\|\s*6/,
    "enemy kind 6 must remain part of the runtime union",
  );
  assert.match(source, /붉은 교정자/, "the new enemy must retain its in-game identity");
  assert.match(source, /proofreader-walk-v2\.png/, "the regenerated eight-direction atlas must be loaded");
  assert.match(
    source,
    /(?:pattern|proofreader)(?:Phase|State)\??:\s*[\s\S]{0,100}["']windup["'][\s\S]{0,100}["']charge["']/i,
    "the enemy state model must expose windup and charge phases",
  );
  assert.match(
    source,
    /(?:enemy\.(?:pattern|proofreader)(?:Phase|State)|phase)\s*===\s*["']windup["']/i,
    "the telegraphed windup must execute in the enemy update/draw loop",
  );
  assert.match(
    source,
    /(?:enemy\.(?:pattern|proofreader)(?:Phase|State)|phase)\s*===\s*["']charge["']/i,
    "the high-speed charge must execute in the enemy update/draw loop",
  );
  assert.match(source, /WALK_IMAGE_KEYS[\s\S]*?(?:walkProofreader|proofreader)/);
  assert.match(
    source,
    /proofreaderTelegraph\s*:\s*["']\/assets\/effects\/proofreader-telegraph\.png["']/,
    "the six-frame charge telegraph must be preloaded",
  );
  assert.match(
    source,
    /drawProofreaderTelegraph[\s\S]{0,800}?progress|drawProofreaderTelegraph[\s\S]{0,800}?charge/,
  );
  assert.match(
    source,
    /frameIndex\s*=\s*clamp\(Math\.floor\([^;]*\*\s*6\)[\s\S]{0,260}?naturalWidth\s*\/\s*3[\s\S]{0,100}?naturalHeight\s*\/\s*2/,
    "the telegraph renderer must address all six cells of its 3x2 atlas",
  );
  assert.match(
    source,
    /const proofreaderWindup =[\s\S]{0,100}?enemy\.kind === 6 && enemy\.patternPhase === "windup";[\s\S]{0,1400}?if \(proofreaderWindup \|\| bossWindup\)[\s\S]{0,350}?drawProofreaderTelegraph\(images\.proofreaderTelegraph/,
    "the shared charge renderer must still route the Proofreader windup through its authored atlas",
  );
  assert.doesNotMatch(
    source,
    /setLineDash\s*\(/,
    "the old dashed-canvas Proofreader windup must be removed",
  );
});

test("enemy loot, inventory, equipment comparison, and save restoration remain integrated", async () => {
  const source = await readFile(path.join(root, "app/GameCanvas.tsx"), "utf8");

  assert.match(source, /\bgearDrops\s*:/, "world state needs independent ground equipment drops");
  assert.match(source, /world\.gearDrops\.push\(/, "defeated enemies must create equipment drops");
  assert.ok(
    [...source.matchAll(/\brollGear\b/g)].length >= 2,
    "rollGear must be imported and called by the drop flow",
  );
  assert.match(
    source,
    /equipmentIcons\s*:\s*["']\/assets\/equipment\/equipment-types-v4\.png["']/,
    "the hundred-type equipment atlas must be loaded by the canvas",
  );
  assert.match(source, /\binventory\s*:/, "player state needs a persisted equipment inventory");
  assert.match(source, /\bequipment\s*:/, "player state needs a five-slot equipment loadout");
  assert.match(
    source,
    /key\s*===\s*["']i["'][\s\S]{0,260}?setInventoryScreenOpen\(shouldOpen\)/,
    "I must remain the inventory shortcut",
  );
  assert.match(
    source,
    /(?:const\s+|function\s+)equip(?:Gear|Item|InventoryItem)[A-Za-z]*\b/i,
    "inventory UI needs an explicit equip action",
  );
  assert.match(
    source,
    /(?:equipment\[[^\]]+\]|equipment\.[a-z]+)\s*=/,
    "the equip action must update a loadout slot",
  );
  assert.match(
    source,
    /reconcileEquipmentLevelRequirements\(\s*data\.player\.level,\s*data\.player\.equipment,\s*data\.player\.inventory,?\s*\)/,
    "save restore must normalize gear and apply the equip-level gate",
  );
});

test("I opens the centered inventory overlay and equipped-slot clicks drive its detail panel", async () => {
  const [source, overlay, css] = await Promise.all([
    readFile(path.join(root, "app/GameCanvas.tsx"), "utf8"),
    readFile(path.join(root, "app/InventoryOverlay.tsx"), "utf8"),
    readFile(path.join(root, "app/game.css"), "utf8"),
  ]);
  assert.match(source, /import InventoryOverlay from ["']\.\/InventoryOverlay["'];/);
  assert.match(
    source,
    /if \(key === ["']i["'][\s\S]{0,260}?setInventoryScreenOpen\(shouldOpen\)/,
    "I must toggle the dedicated inventory screen",
  );
  assert.match(
    source,
    /<InventoryOverlay[\s\S]{0,180}?open=\{inventoryOpen && started && mode === ["']playing["']\}/,
  );
  assert.match(
    css,
    /\.inventory-screen \{[\s\S]{0,300}?position:\s*fixed;[\s\S]{0,100}?inset:\s*0;[\s\S]{0,150}?display:\s*grid;[\s\S]{0,80}?place-items:\s*center;/,
    "the inventory must occupy and center within the viewport",
  );
  assert.match(css, /url\(["']?\/assets\/ui\/inventory-sanctum\.png["']?\)/);
  assert.match(
    overlay,
    /role=\{divineForgeOpen \? undefined : ["']dialog["']\}[\s\S]{0,140}?aria-modal=\{divineForgeOpen \? undefined : ["']true["']\}/,
    "the inventory owns modal semantics until the nested divine forge takes them over",
  );
  assert.match(
    overlay,
    /const selectedEquippedItem\s*=[\s\S]{0,180}?equippedItems\.find\(\(item\) => item\.id === selectedGearId\)/,
  );
  assert.match(
    overlay,
    /className=\{`inventory-screen-equipment-card[\s\S]{0,500}?onClick=\{\(\) => item && onSelect\(item\.id\)\}/,
    "clicking an equipped slot must select that item",
  );
  assert.match(
    overlay,
    /const selectedItem = selectedInventoryItem \?\? selectedEquippedItem;/,
    "equipped and backpack items must feed the same detail view",
  );
  assert.match(
    overlay,
    /className=\{`inventory-screen-details \$\{readOnly \? "inventory-screen-details--read-only" : ""\} \$\{selectedItem \? rarityClass\(selectedItem\) : "inventory-screen-details--empty"\}`\}/,
    "the shared detail panel must render from the normalized selected item",
  );
});

test("opening the inventory freezes combat simulation and rejects queued gameplay input", async () => {
  const source = await readFile(path.join(root, "app/GameCanvas.tsx"), "utf8");

  assert.match(
    source,
    /const isSimulationRunning = useCallback\([\s\S]{0,260}?modeRef\.current === ["']playing["'][\s\S]{0,100}?!buildOpenRef\.current[\s\S]{0,100}?!inventoryOpenRef\.current/,
    "one ref-backed gate must define whether combat simulation and gameplay input may advance",
  );
  assert.match(
    source,
    /const setInventoryScreenOpen = useCallback\([\s\S]{0,320}?inventoryOpenRef\.current = next[\s\S]{0,180}?keysRef\.current\.clear\(\)[\s\S]{0,120}?dashQueued = false[\s\S]{0,120}?hasMoveTarget = false/,
    "opening inventory must synchronously stop held movement, queued dash, and click-to-move",
  );
  assert.match(
    source,
    /const update = \(dt: number\) => \{\s*if \(!isSimulationRunning\(\)\) return;/,
    "the entire mutable simulation update must stop while inventory is open",
  );
  assert.match(
    source,
    /const simulationRunning = isSimulationRunning\(\);\s*if \(simulationRunning\) \{[\s\S]{0,240}?update\(dt\);\s*draw\(\);[\s\S]{0,520}?else if \(\s*wasSimulationRunning \|\|\s*canvasNeedsStaticRedrawRef\.current\s*\) \{[\s\S]{0,260}?draw\(\);/,
    "the animation frame must stop combat and leave one stable canvas frame behind the inventory",
  );
  assert.match(
    source,
    /if \(isSimulationRunning\(\)\) \{\s*keysRef\.current\.add\(key\);/,
    "keyboard movement must not be queued behind the inventory",
  );
  assert.match(
    source,
    /key === ["'] ["'] && isSimulationRunning\(\)[\s\S]{0,80}?dashQueued = true/,
    "keyboard dash must not be queued behind the inventory",
  );
  assert.match(source, /const handleAim[\s\S]{0,100}?if \(!isSimulationRunning\(\)\) return;/);
  assert.match(source, /const handleMoveTarget[\s\S]{0,100}?if \(!isSimulationRunning\(\)\) return;/);
  assert.match(
    source,
    /const pressControl[\s\S]{0,140}?active && isSimulationRunning\(\)/,
    "touch movement must share the same pause gate",
  );
});

test("equipped gear can be safely unequipped without overflowing the backpack or corrupting HP", async () => {
  const [source, overlay] = await Promise.all([
    readFile(path.join(root, "app/GameCanvas.tsx"), "utf8"),
    readFile(path.join(root, "app/InventoryOverlay.tsx"), "utf8"),
  ]);

  assert.match(overlay, /onUnequip:\s*\(slot:\s*EquipmentSlot\)\s*=>\s*void;/);
  assert.match(
    overlay,
    /selectedIsEquipped[\s\S]{0,400}?className=["']inventory-screen-unequip-button["'][\s\S]{0,220}?onClick=\{\(\) => unequipItem\(selectedItem\.slot\)\}/,
    "only the selected equipped item should expose the unequip action",
  );
  assert.match(
    overlay,
    /const unequipItem\s*=\s*\(slot:\s*EquipmentSlot\)\s*=>\s*\{\s*if \(readOnly\) return;\s*setHoveredItem\(null\);\s*setHoveredItemIsEquipped\(false\);\s*onUnequip\(slot\);\s*\}/,
    "every inventory unequip gesture must reuse one tooltip-safe callback",
  );
  assert.match(
    overlay,
    /inventory-screen-equipment-card[\s\S]{0,700}?onDoubleClick=\{\(\) => \{\s*if \(item && !salvageModeActive && !readOnly\) unequipItem\(slot\);\s*\}\}/,
    "double-clicking equipped gear must use the safe runtime unequip path outside salvage mode",
  );
  assert.match(
    overlay,
    /readOnly[\s\S]{0,160}?equipped[\s\S]{0,160}?더블 클릭하여 장착 해제[\s\S]{0,100}?더블 클릭하여 장착/,
    "the item tooltip must explain the correct double-click action for its source",
  );
  assert.match(
    source,
    /const unequipInventoryItem = useCallback\([\s\S]{0,300}?\(slot:\s*EquipmentSlot\)[\s\S]{0,300}?const item = player\.equipment\[slot\]/,
  );
  assert.match(
    source,
    /const unequipInventoryItem[\s\S]{0,700}?if \(player\.inventory\.length >= inventoryCapacityRef\.current\) \{[\s\S]{0,260}?return;[\s\S]{0,500}?player\.equipment\[slot\] = null;[\s\S]{0,160}?player\.inventory\.push\(item\)/,
    "a full expanded backpack must abort before either equipment collection mutates",
  );
  assert.match(
    source,
    /const unequipInventoryItem[\s\S]{0,900}?const previousMaxHp = aggregateEquipmentStats\(player\.equipment\)\.maxHpFlat;[\s\S]{0,300}?player\.equipment\[slot\] = null;[\s\S]{0,300}?const nextMaxHp = aggregateEquipmentStats\(player\.equipment\)\.maxHpFlat;[\s\S]{0,220}?const maxHpDelta = nextMaxHp - previousMaxHp;[\s\S]{0,220}?player\.maxHp = Math\.max\(1, player\.maxHp \+ maxHpDelta\);[\s\S]{0,220}?player\.hp = clamp\(player\.hp \+ Math\.max\(0, maxHpDelta\), 1, player\.maxHp\)/,
    "unequipping max-HP gear must recalculate both the cap and current HP safely",
  );
  assert.match(
    source,
    /<InventoryOverlay[\s\S]{0,700}?onUnequip=\{unequipInventoryItem\}/,
    "the centered inventory must receive the runtime unequip callback",
  );
});

test("memory ash salvage and every enhancement outcome remain connected to runtime and saves", async () => {
  const [source, overlay, equipmentSource] = await Promise.all([
    readFile(path.join(root, "app/GameCanvas.tsx"), "utf8"),
    readFile(path.join(root, "app/InventoryOverlay.tsx"), "utf8"),
    readFile(path.join(root, "app/equipment.ts"), "utf8"),
  ]);
  assert.match(source, /type Player\s*=\s*\{[\s\S]{0,1400}?memoryAsh:\s*number;/);
  assert.match(source, /memoryAsh:\s*0,/);
  assert.match(
    source,
    /memoryAsh:\s*Number\.isFinite\(data\.player\.memoryAsh\)[\s\S]{0,180}?Math\.max\(0, Math\.floor\(data\.player\.memoryAsh\)\)[\s\S]{0,80}?: 0,/,
    "missing legacy ash must restore as zero and saved ash must be sanitized",
  );

  assert.match(
    equipmentSource,
    /function getGearEnhancementAshRefund[\s\S]{0,700}?for \(let enhancement = 0; enhancement < item\.enhancement; enhancement \+= 1\)[\s\S]{0,400}?getGearEnhancementRule\(\{ \.\.\.item, enhancement \}\)[\s\S]{0,180}?refund \+= rule\.ashCost/,
    "enhancement refunds must sum each exact first-attempt stage cost",
  );
  assert.match(
    equipmentSource,
    /function getGearSalvageAshBreakdown[\s\S]{0,700}?baseYield[\s\S]{0,300}?getGearEnhancementAshRefund\(item\)[\s\S]{0,240}?total: baseYield \+ enhancementRefund/,
    "one shared breakdown must combine base salvage with the deterministic enhancement refund",
  );
  assert.doesNotMatch(source, /item\.enhancement\s*\*\s*5/);
  assert.doesNotMatch(overlay, /item\.enhancement\s*\*\s*5/);
  assert.match(
    source,
    /const salvageInventoryItem[\s\S]{0,900}?player\.inventory\.splice\(index, 1\)[\s\S]{0,300}?const ashBreakdown = getGearSalvageAshBreakdown\(item\)[\s\S]{0,220}?player\.memoryAsh \+= ashBreakdown\.total/,
    "salvaging must consume a backpack item and award memory ash",
  );
  assert.match(
    source,
    /const salvageInventoryItems[\s\S]{0,1000}?getGearSalvageAshBreakdown\(item\)[\s\S]{0,900}?player\.memoryAsh \+= ashBreakdown\.total/,
    "batch salvage must add every item's base yield and enhancement refund",
  );
  assert.match(
    overlay,
    /getGearSalvageAshBreakdown\(item\)\.total[\s\S]{0,900}?getGearSalvageAshBreakdown\(item\)\.enhancementRefund/,
    "inventory previews must use the exact same shared breakdown as runtime awards",
  );
  assert.match(
    overlay,
    /const selectedSalvageAsh[\s\S]{0,180}?getGearSalvageAshBreakdown\(selectedInventoryItem\)\.total/,
    "the item detail action must preview its exact rarity-scaled salvage award",
  );
  assert.match(overlay, /selectedSalvageAsh\.toLocaleString\(["']ko-KR["']\)/);
  assert.match(overlay, /강화 비용 환급[\s\S]{0,220}?100% 성공 기준/);
  const singleSalvage = source.match(
    /const salvageInventoryItem = useCallback\(([\s\S]*?)\n\s*const salvageInventoryItems = useCallback\(/,
  );
  const batchSalvage = source.match(
    /const salvageInventoryItems = useCallback\(([\s\S]*?)\n\s*const performGearEnhancement = useCallback\(/,
  );
  assert.ok(singleSalvage && batchSalvage, "both inventory salvage callbacks must remain wired");
  assert.doesNotMatch(singleSalvage[1], /(?:window\.)?(?:alert|confirm|prompt)\s*\(/);
  assert.doesNotMatch(batchSalvage[1], /(?:window\.)?(?:alert|confirm|prompt)\s*\(/);
  assert.doesNotMatch(source, /(?:window\.)?(?:alert|confirm|prompt)\s*\(/);
  assert.doesNotMatch(overlay, /(?:window\.)?(?:alert|confirm|prompt)\s*\(/);
  assert.match(source, /const requestGameConfirmation[\s\S]{0,900}?setGameConfirmation\(confirmation\)/);
  assert.match(source, /game-confirmation-dialog is-\$\{[\s\S]{0,220}?role="alertdialog"/);
  const enhancementRequest = source.match(
    /const enhanceGearItem = useCallback\(([\s\S]*?)\n\s*const returnToMenu = useCallback/,
  );
  assert.ok(enhancementRequest, "the inventory enhancement callback must remain wired");
  assert.match(
    enhancementRequest[1],
    /requestGameConfirmation\([\s\S]*?\(\) => performGearEnhancement\(itemId\)/,
    "destructive enhancement must use the shared in-game confirmation layer",
  );
  assert.doesNotMatch(
    source,
    /onClick=\{\(\) => salvageInventoryItem\(/,
    "no legacy UI may bypass the centered inventory salvage confirmation",
  );
  assert.match(source, /const enhanceGearItem[\s\S]{0,900}?getGearEnhancementRule\(item\)/);
  assert.match(source, /player\.memoryAsh < rule\.ashCost/);
  assert.match(source, /player\.memoryAsh -= rule\.ashCost/);
  assert.match(
    source,
    /roll < rule\.successPercent[\s\S]{0,300}?applySuccessfulGearEnhancement\(\s*item,\s*Math\.random\(\),?\s*\)/,
    "runtime success must delegate option selection, stage advancement, and power refresh to the shared helper",
  );
  assert.match(
    source,
    /roll < rule\.successPercent \+ rule\.destroyPercent[\s\S]{0,300}?player\.inventory\.splice\(inventoryIndex, 1\)[\s\S]{0,160}?player\.equipment\[equippedSlot\] = null/,
    "destruction must remove either an inventory or equipped item",
  );
  assert.match(
    source,
    /else \{[\s\S]{0,180}?강화 실패|else \{[\s\S]{0,180}?媛뺥솕 \?ㅽ뙣/,
    "the non-success, non-destruction branch must preserve the item as a normal failure",
  );
  assert.match(source, /<InventoryOverlay[\s\S]{0,500}?memoryAsh=\{hud\.player\.memoryAsh\}/);
  assert.match(source, /<InventoryOverlay[\s\S]{0,650}?onEnhance=\{enhanceGearItem\}/);
  assert.match(
    source,
    /const optionCount = item\.affixes\.length \+ 1;[\s\S]{0,260}?Array\.from\(\{ length: optionCount \}, \(_, index\) =>[\s\S]{0,180}?applySuccessfulGearEnhancement\(item, \(index \+ 0\.5\) \/ optionCount\)/,
    "the expedition confirmation must preview every uniformly selectable option through the shared helper",
  );
  assert.match(
    source,
    /const minimumPowerGain = Math\.min\(\.\.\.powerGains\);[\s\S]{0,120}?const maximumPowerGain = Math\.max\(\.\.\.powerGains\)/,
    "the expedition confirmation must disclose the random candidate power range",
  );
  assert.match(
    overlay,
    /const enhancementOptionPreviews = selectedItem && enhancementRule[\s\S]{0,360}?Array\.from\(\{ length: selectedItem\.affixes\.length \+ 1 \}, \(_, index\) =>[\s\S]{0,220}?applySuccessfulGearEnhancement/,
    "the workbench must use the same helper to preview the implicit and every affix boundary",
  );
  assert.match(
    overlay,
    /const minimumEnhancementPowerGain[\s\S]{0,260}?const maximumEnhancementPowerGain[\s\S]{0,300}?enhancementPowerGainLabel/,
    "the workbench must show the possible contextual power range rather than one false deterministic value",
  );
  assert.match(
    overlay,
    /function GearAffixBreakdown[\s\S]{0,500}?getGearAffixDisplay\(affix, item\)[\s\S]{0,220}?formatCompactGearLabel\(display\.totalLabel\)[\s\S]{0,300}?<strong>\{optionLabel\}<\/strong>/,
    "each rolled option must render only its compact canonical total on one line",
  );
  assert.match(
    overlay,
    /function GearImplicitBreakdown[\s\S]{0,500}?getGearImplicitDisplay\(item\)[\s\S]{0,220}?formatCompactGearLabel\(display\.totalLabel\)[\s\S]{0,300}?<strong>\{optionLabel\}<\/strong>/,
    "the implicit option must render only its compact enhanced total on one line",
  );
  assert.match(
    overlay,
    /성공 시 \{selectedItem\.affixes\.length \+ 1\}개 옵션 중 1개 균등 선택 · 중복 가능/,
    "the workbench must list every equal-probability gain and state that repeated option hits are allowed",
  );
  assert.match(
    overlay,
    /formatCompactGearLabel\(selectedImplicitDisplay\.nextStageGainLabel\)/,
    "the implicit option must appear in the random candidate preview",
  );
  assert.match(
    overlay,
    /selectedItem\.affixes\.map[\s\S]{0,500}?formatCompactGearLabel\(display\.nextStageGainLabel\)/,
    "every rolled affix must expose its own per-hit gain in the candidate preview",
  );
  for (const removedCopy of [
    "추가 옵션",
    "획득 시 고정",
    "획득 시 확정",
    "강화 영향 없음",
  ]) {
    assert.doesNotMatch(
      overlay,
      new RegExp(removedCopy),
      `${removedCopy} classification copy must stay out of the simplified equipment UI`,
    );
  }
  assert.doesNotMatch(
    overlay,
    /(?:display|selectedImplicitDisplay)\??\.(?:baseLabel|enhancementLabel)/,
    "the UI must not split current option totals back into base and enhancement contributions",
  );
  assert.match(
    source,
    /const optionGainSummary = `\$\{enhancementResult\.optionLabel\} \$\{formatCompactGearLabel\(enhancementResult\.gainLabel\)\}`/,
    "enhancement messaging must identify the option actually selected by the shared result",
  );
  assert.match(
    source,
    /강화 성공 · \$\{formatGearDisplayName\(enhancedItem\)\}/,
    "enhancement messaging must append the stage through the display-only name helper",
  );
  assert.match(
    source,
    /const savedHpRatio = savedHp \/ savedMaxHp;[\s\S]{0,1600}?const baseMaxHp = rankOf\(hydratedPlayer, ["']blood["']\) > 0 \? 85 : 100;[\s\S]{0,260}?aggregateEquipmentStats\(normalizedEquipment\)\.maxHpFlat[\s\S]{0,260}?hydratedPlayer\.maxHp \* savedHpRatio/,
    "loading a save must rebuild enhanced maximum health while preserving the saved health ratio",
  );
  assert.match(overlay, /onClick=\{\(\) => requestSalvageOne\(selectedItem\.id\)\}/);
  assert.match(
    overlay,
    /const confirmSalvage[\s\S]{0,300}?pendingSingleSalvageItem[\s\S]{0,120}?onSalvage\(pendingSingleSalvageItem\.id\)/,
    "single salvage must execute only after InventoryOverlay's alertdialog confirms it",
  );
  assert.match(overlay, /onClick=\{\(\) => onEnhance\(selectedItem\.id\)\}/);
  assert.match(overlay, /disabled=\{!canAffordEnhancement\}/);
});

test("every rarity preloads a dedicated loot-awakening sheet and draws all eight cells", async () => {
  const source = await readFile(path.join(root, "app/GameCanvas.tsx"), "utf8");
  for (const rarity of ["common", "magic", "superior", "rare", "epic", "legendary", "mythic", "cosmic"]) {
    assert.match(
      source,
      new RegExp(`imagePath:\\s*["']/assets/effects/loot-awakening-${rarity}-v5\\.png["']`),
      `${rarity} must own a dedicated 4x2 loot-awakening sheet`,
    );
  }
  assert.match(source, /Object\.values\(EQUIPMENT_RARITY_VFX\)[\s\S]{0,180}?imagePaths\[config\.imageKey\]\s*=\s*config\.imagePath/);
  assert.match(source, /const config\s*=\s*EQUIPMENT_RARITY_VFX\[effect\.rarity\s*\?\?\s*["']common["']\][\s\S]{0,160}?images\[config\.imageKey\]/);
  assert.match(
    source,
    /frameIndex\s*=\s*clamp\(Math\.floor\(progress\s*\*\s*8\)[\s\S]{0,300}?naturalWidth\s*\/\s*4[\s\S]{0,120}?naturalHeight\s*\/\s*2/,
    "loot awakening must animate all eight cells from its four-column by two-row sheet",
  );
});

test("freshly spawned gear counts down a pickup delay before collection", async () => {
  const source = await readFile(path.join(root, "app/GameCanvas.tsx"), "utf8");
  assert.match(source, /type GearDrop\s*=\s*\{[\s\S]*?pickupDelay\s*:\s*number;/);
  assert.match(
    source,
    /pickupDelay\s*:\s*EQUIPMENT_RARITY_VFX\[item\.rarity\]\.awakeningDuration\s*\+\s*0?\.\d+/,
    "new drops must remain locked until their authored arrival finishes",
  );
  assert.match(
    source,
    /drop\.pickupDelay\s*=\s*Math\.max\(0,\s*drop\.pickupDelay\s*-\s*dt\)/,
    "the pickup lockout must count down in game time",
  );
  assert.match(
    source,
    /drop\.pickupDelay\s*>\s*0/,
    "ground gear cannot be collected before its pickup lockout expires",
  );
});

test("Harin's rebuilt atlas retains a dedicated stance and anatomically alternating gait", async () => {
  const relativePath = "public/assets/walk/harin-mannequin-v1.png";
  const image = decodeRgbaPng(await readFile(path.join(root, relativePath)), relativePath);
  assert.deepEqual([image.width, image.height], [1024, 1536]);
  assert.equal(countGreenChromaPixels(image), 0, `${relativePath} retains green-screen contamination`);

  const cellWidth = image.width / 4;
  const cellHeight = image.height / 8;
  const groundBaselines = new Set();
  for (let row = 0; row < 8; row += 1) {
    const frameHashes = new Set();
    for (let column = 0; column < 4; column += 1) {
      const label = `Harin direction ${row} gait ${column}`;
      assertAlphaCellGutter(image, column, row, 4, 8, label);
      const metrics = alphaCellMetrics(image, column, row, 4, 8, label);
      groundBaselines.add(cellHeight - 1 - metrics.bottom);
      const hash = createHash("sha256");
      for (let y = row * cellHeight; y < (row + 1) * cellHeight; y += 1) {
        const start = (y * image.width + column * cellWidth) * 4;
        const visibleRow = image.pixels.slice(start, start + cellWidth * 4);
        for (let offset = 0; offset < visibleRow.length; offset += 4) {
          if (visibleRow[offset + 3] > 8) continue;
          visibleRow[offset] = 0;
          visibleRow[offset + 1] = 0;
          visibleRow[offset + 2] = 0;
          visibleRow[offset + 3] = 0;
        }
        hash.update(visibleRow);
      }
      frameHashes.add(hash.digest("hex"));
    }
    assert.equal(frameHashes.size, 4, `Harin direction ${row} contains a duplicated walk frame`);
  }
  assert.equal(groundBaselines.size, 1, "all 32 gait poses must share one pixel-exact foot baseline");

  // Opposite contact poses must either separate in silhouette or visibly swap
  // their painted leg detail.  A strict alpha-only IoU is insufficient for the
  // west-facing legacy render: its isometric legs overlap in screen space even
  // though the lit boot and shaded trailing leg alternate between contacts.
  for (let row = 0; row < 8; row += 1) {
    for (const [leftColumn, rightColumn, phase] of [[0, 2, "opposite contact"]]) {
      let intersection = 0;
      let union = 0;
      let paintedDifference = 0;
      let comparedPaintedPixels = 0;
      for (let localY = Math.floor(cellHeight * 0.58); localY < cellHeight; localY += 1) {
        for (let localX = 0; localX < cellWidth; localX += 1) {
          const leftOffset =
            (((row * cellHeight + localY) * image.width + leftColumn * cellWidth + localX) * 4) + 3;
          const rightOffset =
            (((row * cellHeight + localY) * image.width + rightColumn * cellWidth + localX) * 4) + 3;
          const leftVisible = image.pixels[leftOffset] > 16;
          const rightVisible = image.pixels[rightOffset] > 16;
          if (leftVisible || rightVisible) union += 1;
          if (leftVisible && rightVisible) intersection += 1;
          if (leftVisible && rightVisible) {
            const leftPixel = leftOffset - 3;
            const rightPixel = rightOffset - 3;
            paintedDifference +=
              Math.abs(image.pixels[leftPixel] - image.pixels[rightPixel]) +
              Math.abs(image.pixels[leftPixel + 1] - image.pixels[rightPixel + 1]) +
              Math.abs(image.pixels[leftPixel + 2] - image.pixels[rightPixel + 2]);
            comparedPaintedPixels += 3;
          }
        }
      }
      const lowerBodyIou = intersection / Math.max(1, union);
      const maximumContactIou = row === 4 ? 0.93 : 0.9;
      const meanPaintedDifference = paintedDifference / Math.max(1, comparedPaintedPixels);
      assert.ok(
        lowerBodyIou < maximumContactIou || meanPaintedDifference >= 7,
        `Harin row ${row} ${phase} frames repeat one leg pose (IoU ${lowerBodyIou.toFixed(3)}, RGB delta ${meanPaintedDifference.toFixed(2)})`,
      );
    }
  }
});

test("shared character motion follows post-collision displacement and travelled distance", async () => {
  const motion = await importTypeScriptModule("app/character-motion.ts");

  assert.deepEqual([...motion.HARIN_WALK_ROW_BY_FACING], [0, 7, 6, 3, 4, 5, 2, 1]);
  assert.equal(motion.CHARACTER_WALK_FRAME_COUNT, 4);
  assert.equal(motion.CHARACTER_IDLE_FRAME, 1);
  assert.deepEqual([...motion.CHARACTER_CONTACT_FRAMES], [0, 2]);
  assert.deepEqual([...motion.CHARACTER_GAIT_PHASE_NAMES], [
    "left-contact",
    "neutral-passing",
    "right-contact",
    "neutral-return",
  ]);
  assert.equal(motion.characterSpriteRowForFacing(2), 6, "west must use the authored west row");
  assert.equal(motion.characterSpriteRowForFacing(6), 2, "east must use the authored east row");
  assert.equal(motion.characterSpriteRowForFacing(3), 3, "north-west must not mirror north-east");
  assert.equal(motion.characterSpriteRowForFacing(5), 5, "north-east must not mirror north-west");
  for (const [dx, dy, expectedFacing] of [
    [0, 1, 0],
    [-1, 1, 1],
    [-1, 0, 2],
    [-1, -1, 3],
    [0, -1, 4],
    [1, -1, 5],
    [1, 0, 6],
    [1, 1, 7],
  ]) {
    assert.equal(
      motion.characterFacingForVector(dx, dy, 0),
      expectedFacing,
      `vector ${dx},${dy} must resolve to facing ${expectedFacing}`,
    );
  }

  const blocked = motion.resolveCharacterMotion(0, 0, 6);
  assert.equal(blocked.moving, false, "pushing into a wall must not play a walk cycle");
  assert.equal(blocked.facing, 6, "a fully blocked step must retain the prior facing");
  assert.equal(
    motion.characterWalkFrameIndex(3.75, blocked.moving),
    motion.CHARACTER_IDLE_FRAME,
    "standing still must settle on the explicit idle frame",
  );

  const wallSlide = motion.resolveCharacterMotion(0, 12, 7);
  assert.equal(wallSlide.moving, true);
  assert.equal(wallSlide.facing, 0, "an axis slide must face its actual southward displacement");
  assert.equal(wallSlide.distance, 12);
  assert.equal(motion.resolveCharacterMotion(-8, 0, 6).facing, 2);
  assert.equal(motion.resolveCharacterMotion(8, 0, 2).facing, 6);

  const oneStep = motion.advanceCharacterWalkCycle(0, 48);
  const splitStep = motion.advanceCharacterWalkCycle(
    motion.advanceCharacterWalkCycle(0, 24),
    24,
  );
  assert.equal(oneStep, splitStep, "walk phase must depend on distance, not update frequency");
  assert.equal(motion.advanceCharacterWalkCycle(0, motion.CHARACTER_WALK_CYCLE_DISTANCE), 0);
  assert.equal(motion.characterWalkFrameIndex(3.75, true), 3);

  const cadenceSampleSeconds = 0.25;
  const cadenceLimited = motion.advanceCharacterWalkCycle(
    0,
    motion.CHARACTER_WALK_CYCLE_DISTANCE * 100,
    motion.CHARACTER_WALK_CYCLE_DISTANCE,
    cadenceSampleSeconds,
  );
  assert.equal(
    cadenceLimited,
    (motion.CHARACTER_MAX_WALK_CYCLES_PER_SECOND *
      motion.CHARACTER_WALK_FRAME_COUNT *
      cadenceSampleSeconds) % motion.CHARACTER_WALK_FRAME_COUNT,
    "extreme movement speed must be capped by elapsed-time gait cadence",
  );
  assert.equal(
    motion.advanceCharacterWalkCycle(
      1.25,
      motion.CHARACTER_WALK_CYCLE_DISTANCE,
      motion.CHARACTER_WALK_CYCLE_DISTANCE,
      0,
    ),
    1.25,
    "a zero-duration frame must not advance the gait",
  );
  assert.equal(motion.settleCharacterWalkCycle(1.4), 1);
  assert.equal(motion.characterWalkFrameIndex(1.4, false), 1);
  assert.equal(motion.settleCharacterWalkCycle(3.6), 1);
  assert.equal(
    motion.settleCharacterWalkCycle(3),
    1,
    "every halted gait must settle on the authored balanced standing pose",
  );
});

test("the paperdoll compositor consumes ten registered 32-frame wearable layers with bounded caching", async () => {
  const [equipmentUrl, rigManifestUrl] = await Promise.all([
    typeScriptModuleUrl("app/equipment.ts"),
    jsonDefaultModuleUrl("app/paperdoll-rig-manifest.json"),
  ]);
  const [equipment, paperdoll, motion, paperdollSource] = await Promise.all([
    importTypeScriptModule("app/equipment.ts"),
    importTypeScriptModule("app/character-paperdoll.ts", {
      "./equipment": equipmentUrl,
      "./paperdoll-rig-manifest.json": rigManifestUrl,
    }),
    importTypeScriptModule("app/character-motion.ts"),
    readFile(path.join(root, "app/character-paperdoll.ts"), "utf8"),
  ]);

  assert.equal(equipment.EQUIPMENT_SLOTS.length, 10);
  assert.equal(paperdoll.PAPERDOLL_ACTIVE_RIG_VERSION, paperdollRigManifest.version);
  assert.equal(paperdoll.PAPERDOLL_FRAME_COLUMNS, paperdollRigManifest.frame.columns);
  assert.equal(
    paperdoll.PAPERDOLL_DIRECTION_COUNT,
    paperdollRigManifest.frame.directionRows.length,
  );
  assert.deepEqual(
    [...paperdoll.PAPERDOLL_DIRECTION_ROWS],
    [...motion.HARIN_WALK_ROW_BY_FACING],
    "body and equipment layers must share one direction contract",
  );

  const worn = {};
  for (const [column, slot] of equipment.EQUIPMENT_SLOTS.entries()) {
    const variant = (column + 2) % equipment.GEAR_ICON_ROWS;
    worn[slot] = {
      slot,
      rarity: equipment.GEAR_RARITIES[column % equipment.GEAR_RARITIES.length],
      enhancement: column % (equipment.MAX_GEAR_ENHANCEMENT + 1),
      iconIndex: variant * equipment.GEAR_ICON_COLUMNS + column,
    };
  }
  const loadout = paperdoll.paperdollLoadoutFromEquipment(worn);
  assert.equal(Object.keys(loadout).length, 10, "every equipped slot must reach the in-game renderer");
  for (const slot of equipment.EQUIPMENT_SLOTS) {
    const piece = loadout[slot];
    assert.ok(piece, `${slot} is missing from the paperdoll loadout`);
    assert.equal(
      paperdoll.getPaperdollLayerPath(slot, piece.variant),
      paperdoll.PAPERDOLL_LAYER_PATHS[slot][piece.variant],
    );
  }
  assert.equal(
    paperdoll.paperdollGearMetaFromItem({ ...worn.weapon, iconIndex: worn.weapon.iconIndex + 1 }),
    null,
    "a slot may not crop a neighbouring atlas column",
  );

  const publicVariants = Object.fromEntries(
    equipment.EQUIPMENT_SLOTS.map((slot, index) => [slot, index]),
  );
  const publicLoadout = paperdoll.paperdollLoadoutFromVisualGear(publicVariants);
  assert.equal(Object.keys(publicLoadout).length, 10);
  for (const [variant, slot] of equipment.EQUIPMENT_SLOTS.entries()) {
    assert.deepEqual(publicLoadout[slot], {
      slot,
      variant,
      rarity: "common",
      enhancement: 0,
    });
  }
  assert.deepEqual(
    paperdoll.paperdollLoadoutFromVisualGear({
      ...publicVariants,
      helm: 10,
      weapon: -1,
      relic: "9",
    }),
    Object.fromEntries(
      Object.entries(publicLoadout).filter(([slot]) => !["helm", "weapon", "relic"].includes(slot)),
    ),
    "untrusted hub variants outside 0..9 or with the wrong type must be dropped",
  );

  assert.deepEqual(paperdoll.paperdollFrameCell(6, 2), {
    x: 2 * paperdollRigManifest.frame.width,
    y:
      paperdollRigManifest.frame.directionRows[6] *
      paperdollRigManifest.frame.height,
    width: paperdollRigManifest.frame.width,
    height: paperdollRigManifest.frame.height,
  });
  assert.equal(
    paperdoll.PAPERDOLL_GROUND_ANCHOR_RATIO,
    paperdollRigManifest.frame.groundBaseline / paperdollRigManifest.frame.height,
  );
  assert.ok(
    Math.abs(
      paperdoll.paperdollVisualCenterY(8, paperdoll.PAPERDOLL_WORLD_RENDER_HEIGHT) -
        (
          8 +
          paperdoll.PAPERDOLL_WORLD_RENDER_HEIGHT *
            (0.5 - paperdollRigManifest.frame.groundBaseline / paperdollRigManifest.frame.height)
        ),
    ) < 1e-9,
    "the expedition ground baseline must resolve to the audited paperdoll body centre",
  );
  assert.equal(paperdoll.paperdollLayerPathsForLoadout(loadout).length, 10);

  const bodyAtlas = {
    width: paperdoll.PAPERDOLL_BODY_ATLAS_WIDTH,
    height: paperdoll.PAPERDOLL_BODY_ATLAS_HEIGHT,
  };
  const layerAtlas = {
    width: paperdoll.PAPERDOLL_LAYER_ATLAS_WIDTH,
    height: paperdoll.PAPERDOLL_LAYER_ATLAS_HEIGHT,
  };
  const createDirectContext = (throwingSource = null) => ({
    globalAlpha: 1,
    imageSmoothingEnabled: true,
    save() {},
    restore() {},
    translate() {},
    scale() {},
    drawImage(source) {
      if (source === throwingSource) throw new Error("synthetic layer draw failure");
    },
  });
  const fullLayerSources = new Map(
    paperdoll.paperdollLayerPathsForLoadout(loadout).map((path) => [path, layerAtlas]),
  );
  assert.deepEqual(
    paperdoll.drawPaperdollCharacterDirectReport(createDirectContext(), {
      bodyAtlas,
      layerSources: fullLayerSources,
      loadout,
      direction: 0,
      frame: 0,
      x: 0,
      y: 0,
      width: 136,
      height: 102,
    }),
    { drawn: true, complete: true, drawnLayerCount: 10 },
    "the direct report must count every layer actually drawn to the destination canvas",
  );
  const singleWeapon = { weapon: loadout.weapon };
  const weaponPath = paperdoll.paperdollLayerPathsForLoadout(singleWeapon)[0];
  assert.deepEqual(
    paperdoll.drawPaperdollCharacterDirectReport(
      createDirectContext(layerAtlas),
      {
        bodyAtlas,
        layerSources: new Map([[weaponPath, layerAtlas]]),
        loadout: singleWeapon,
        direction: 0,
        frame: 0,
        x: 0,
        y: 0,
        width: 136,
        height: 102,
      },
    ),
    { drawn: true, complete: false, drawnLayerCount: 0 },
    "a failed layer draw may not masquerade as a complete body-only paperdoll",
  );

  const sorted = paperdoll.sortPaperdollPieces(loadout, 6);
  const layerRank = { rear: 0, body: 1, front: 2 };
  const layers = sorted.map((piece) =>
    paperdoll.resolvePaperdollLayer(piece.slot, 6)
  );
  assert.deepEqual([...new Set(layers)], ["rear", "body", "front"]);
  assert.deepEqual(
    layers.map((layer) => layerRank[layer]),
    layers.map((layer) => layerRank[layer]).toSorted((left, right) => left - right),
    "a frame must compose back gear, then body gear, then front gear",
  );

  const cache = new paperdoll.PaperdollLruCache(3);
  cache.set("a", 1);
  cache.set("b", 2);
  cache.set("c", 3);
  assert.equal(cache.get("a"), 1);
  cache.set("d", 4);
  assert.equal(cache.peek("b"), undefined, "the least-recently-used frame must be evicted");
  assert.deepEqual(cache.keys(), ["c", "a", "d"]);
  assert.equal(new paperdoll.PaperdollLruCache(10_000).capacity, 256);

  assert.match(
    paperdollSource,
    /drawPass\("rear"\)[\s\S]{0,220}?drawRegisteredAtlasFrame\(context, bodyAtlas, cell\)[\s\S]{0,220}?drawPass\("body"\)[\s\S]{0,80}?drawPass\("front"\)/,
    "runtime must draw rear gear, the mannequin, worn gear, then front gear",
  );
  assert.doesNotMatch(paperdollSource, /equipment-types-v4|trim\.x|context\.rotate|containPaperdollPart/);
});

test("all hundred fitted wearable atlases are registered, crop-safe, and independent", async () => {
  const [equipmentUrl, rigManifestUrl] = await Promise.all([
    typeScriptModuleUrl("app/equipment.ts"),
    jsonDefaultModuleUrl("app/paperdoll-rig-manifest.json"),
  ]);
  const [equipment, paperdoll] = await Promise.all([
    importTypeScriptModule("app/equipment.ts"),
    importTypeScriptModule("app/character-paperdoll.ts", {
      "./equipment": equipmentUrl,
      "./paperdoll-rig-manifest.json": rigManifestUrl,
    }),
  ]);

  let count = 0;
  for (const slot of equipment.EQUIPMENT_SLOTS) {
    const paths = paperdoll.PAPERDOLL_LAYER_PATHS[slot];
    assert.equal(paths.length, paperdollRigManifest.variantNames.length);
    for (const publicPath of paths) {
      assert.match(
        publicPath,
        new RegExp(`${paperdollRigManifest.layerRoot}/${slot}/`),
      );
      const [assetPath, query] = publicPath.split("?");
      assert.equal(
        query,
        `v=${encodeURIComponent(paperdollRigManifest.assetRevision)}`,
        "every runtime atlas request must be cache-busted by the pinned aggregate revision",
      );
      const relativePath = `public${assetPath}`;
      const image = decodeRgbaPng(await readFile(path.join(root, relativePath)), relativePath);
      assert.deepEqual(
        [image.width, image.height],
        [
          paperdollRigManifest.frame.width * paperdollRigManifest.frame.columns,
          paperdollRigManifest.frame.height *
            paperdollRigManifest.frame.directionRows.length,
        ],
      );
      let opaque = 0;
      for (let index = 3; index < image.pixels.length; index += 4) {
        if (image.pixels[index] > 8) opaque += 1;
      }
      assert.ok(opaque > 20, `${relativePath} must contain a visible fitted layer`);
      for (let row = 0; row < paperdollRigManifest.frame.directionRows.length; row += 1) {
        for (let column = 0; column < paperdollRigManifest.frame.columns; column += 1) {
          let frameOpaque = 0;
          for (
            let y = row * paperdollRigManifest.frame.height;
            y < (row + 1) * paperdollRigManifest.frame.height;
            y += 1
          ) {
            for (
              let x = column * paperdollRigManifest.frame.width;
              x < (column + 1) * paperdollRigManifest.frame.width;
              x += 1
            ) {
              const alphaIndex = (y * image.width + x) * 4 + 3;
              if (image.pixels[alphaIndex] > 8) frameOpaque += 1;
            }
          }
          assert.ok(
            frameOpaque > 0,
            `${relativePath} frame ${row},${column} must not make equipped gear disappear`,
          );
        }
      }
      count += 1;
    }
  }
  assert.equal(count, 100);
});

test("paperdoll image storage prunes stale atlases and recovers from bounded failures", async () => {
  const imageStore = await importTypeScriptModule("app/paperdoll-image-store.ts");
  const attempts = new Map();
  const pending = new Map();
  const retryQueue = [];
  const store = new imageStore.PaperdollImageStore((path, onLoad, onError) => {
    attempts.set(path, (attempts.get(path) ?? 0) + 1);
    pending.set(path, { onLoad, onError });
    return { complete: false, naturalWidth: 0, naturalHeight: 0, path };
  }, imageStore.PAPERDOLL_IMAGE_MAX_ATTEMPTS, (callback, delayMs) => {
    retryQueue.push({ callback, delayMs });
  });

  store.reconcile(["a", "b", "c"]);
  assert.deepEqual(store.keys(), ["a", "b", "c"]);
  assert.equal(store.size, 3);
  store.reconcile(["b", "d"]);
  assert.deepEqual(store.keys(), ["b", "d"], "only current-scene atlases remain resident");

  pending.get("b").onError();
  assert.equal(store.has("b"), false, "a failed image is removed instead of poisoning the map");
  // Run the captured retry synchronously; production uses the same delay with setTimeout.
  const firstRetry = retryQueue.shift();
  assert.equal(firstRetry.delayMs, imageStore.PAPERDOLL_IMAGE_RETRY_BASE_DELAY_MS);
  firstRetry.callback();
  assert.equal(attempts.get("b"), 2, "a required failed image receives a bounded retry");
  pending.get("b").onError();
  const secondRetry = retryQueue.shift();
  assert.equal(secondRetry.delayMs, imageStore.PAPERDOLL_IMAGE_RETRY_BASE_DELAY_MS * 2);
  secondRetry.callback();
  assert.equal(attempts.get("b"), 3);
  pending.get("b").onError();
  assert.equal(retryQueue.length, 1);
  assert.equal(
    retryQueue[0].delayMs,
    imageStore.PAPERDOLL_IMAGE_RETRY_COOLDOWN_MS,
  );
  assert.equal(attempts.get("b"), 3, "a permanently missing path may not retry forever");
  assert.equal(store.size, 1, "only the still-required successful/in-flight path remains");
  retryQueue.shift().callback();
  assert.equal(
    attempts.get("b"),
    4,
    "a required path starts one new bounded retry burst after its cooldown",
  );
  assert.equal(store.size, 2);
  store.clear();
  assert.equal(store.size, 0);

  const invalidPending = new Map();
  const invalidRetries = [];
  const validatingStore = new imageStore.PaperdollImageStore(
    (path, onLoad, onError) => {
      const image = { complete: true, naturalWidth: 64, naturalHeight: 64, path };
      invalidPending.set(path, { onLoad, onError, image });
      return image;
    },
    imageStore.PAPERDOLL_IMAGE_MAX_ATTEMPTS,
    (callback, delayMs) => invalidRetries.push({ callback, delayMs }),
    (_path, image) =>
      image.naturalWidth ===
        paperdollRigManifest.frame.width * paperdollRigManifest.frame.columns &&
      image.naturalHeight ===
        paperdollRigManifest.frame.height *
          paperdollRigManifest.frame.directionRows.length,
  );
  validatingStore.reconcile(["wrong-size"]);
  invalidPending.get("wrong-size").onLoad();
  assert.equal(validatingStore.has("wrong-size"), false);
  assert.equal(invalidRetries.length, 1, "wrong dimensions must enter the retry path");
});

test("expedition and plaza render independent fitted layers and preserve public gear appearance", async () => {
  const [source, plaza, paperdollSource, overlay, css] = await Promise.all([
    readFile(path.join(root, "app/GameCanvas.tsx"), "utf8"),
    readFile(path.join(root, "app/PlazaHub.tsx"), "utf8"),
    readFile(path.join(root, "app/character-paperdoll.ts"), "utf8"),
    readFile(path.join(root, "app/InventoryOverlay.tsx"), "utf8"),
    readFile(path.join(root, "app/game.css"), "utf8"),
  ]);

  for (const runtimeSource of [source, plaza]) {
    assert.match(runtimeSource, /drawPaperdollCharacter/);
    assert.match(runtimeSource, /paperdollLayerPathsForLoadout/);
    assert.doesNotMatch(runtimeSource, /drawHarinAppearanceFrame|resolveHarinAppearance|equipmentAtlas:/);
    assert.doesNotMatch(runtimeSource, /harin-equipped-v3\.png|walkHarinEquipped/);
    assert.doesNotMatch(
      runtimeSource,
      /(?:HARIN|PLAYER)[A-Z_]*DIRECTION[A-Z_]*\s*=\s*\[\s*0,\s*7,\s*6,\s*3,\s*4,\s*5,\s*2,\s*1\s*\]/,
      "direction-row ownership must stay in the shared character modules",
    );
  }
  assert.equal(paperdollRigManifest.version, "v1");
  assert.match(paperdollSource, /paperdoll-rig-manifest\.json/);
  assert.match(
    paperdollSource,
    /PAPERDOLL_BODY_PATH\s*=\s*PAPERDOLL_RIG_MANIFEST\.bodyPath/,
  );
  assert.match(
    paperdollSource,
    /PAPERDOLL_LAYER_ROOT\s*=\s*PAPERDOLL_RIG_MANIFEST\.layerRoot/,
  );
  assert.match(
    paperdollSource,
    /context\.imageSmoothingEnabled\s*=\s*false/g,
    "the legacy pre-rendered body and equipment pixels must not be blurred at runtime",
  );
  assert.match(
    paperdollSource,
    /PAPERDOLL_GROUND_BASELINE\s*=\s*PAPERDOLL_RIG_MANIFEST\.frame\.groundBaseline/,
  );
  assert.doesNotMatch(paperdollSource, /equipment-types-v4\.png/);
  assert.match(source, /getEquipmentRuntimeCache\(player\.equipment\)[\s\S]{0,120}?\.loadout/);
  assert.match(source, /paperdollLoadoutFromEquipment\(equipment\)/);
  assert.match(source, /createPaperdollEquipmentSignature/);
  assert.match(source, /paperdollImagesRef\.current\.reconcile\(paths\)/);
  assert.match(source, /paperdollImagesRef\.current\.imageMap\(\)/);
  assert.match(plaza, /drawPaperdollCharacterDirect/);
  assert.doesNotMatch(
    plaza,
    /drawPaperdollCharacter\(context/,
    "the multiplayer plaza must not churn shared composite-frame canvases",
  );
  assert.match(plaza, /paperdollImages\.reconcile\(requiredLayerPaths\)/);
  assert.match(plaza, /selectPlazaRemotePlayersForRender/);
  assert.match(plaza, /PLAZA_REMOTE_RENDER_LIMIT\s*=\s*32/);
  assert.match(plaza, /PLAZA_REMOTE_EQUIPMENT_DETAIL_LIMIT\s*=\s*2/);
  assert.match(
    plaza,
    /const players: DrawPlayer\[\] = renderableRemotePlayers\.map/,
    "the multiplayer plaza must draw only camera-culled remote paperdolls",
  );
  const expeditionMotionStart = source.indexOf("const previousPlayerX = player.x;");
  const expeditionCollision = source.indexOf(
    "constrainPlayerToWalkableFloor(player, doors);",
    expeditionMotionStart,
  );
  const expeditionMotionResolve = source.indexOf(
    "const playerMotion = resolveCharacterMotion(",
    expeditionCollision,
  );
  assert.ok(
    expeditionMotionStart >= 0 &&
      expeditionCollision > expeditionMotionStart &&
      expeditionMotionResolve > expeditionCollision,
    "expedition motion must be sampled after wall collision correction",
  );
  assert.match(
    source.slice(expeditionMotionStart, expeditionMotionResolve + 320),
    /actualMoveX\s*=\s*player\.x\s*-\s*previousPlayerX;[\s\S]{0,120}?actualMoveY\s*=\s*player\.y\s*-\s*previousPlayerY;[\s\S]{0,160}?resolveCharacterMotion\(\s*actualMoveX,\s*actualMoveY/,
  );
  assert.match(
    source,
    /advanceCharacterWalkCycle\(\s*player\.walkCycle,\s*playerMotion\.distance/,
  );
  assert.match(source, /characterRenderFrameIndex\(\s*player\.facing,\s*player\.walkCycle,\s*player\.moving\s*,?\s*\)/);

  const plazaMotionStart = plaza.indexOf("const previousPosition = { ...positionRef.current };");
  const plazaCollision = plaza.indexOf(
    "positionRef.current = resolvePlazaMovement(",
    plazaMotionStart,
  );
  const plazaCorrection = plaza.indexOf(
    "const correctionX = authoritativeTarget.x - positionRef.current.x;",
    plazaCollision,
  );
  const plazaMotionResolve = plaza.indexOf(
    "const motion = resolveCharacterMotion(",
    plazaCorrection,
  );
  assert.ok(
    plazaMotionStart >= 0 &&
      plazaCollision > plazaMotionStart &&
      plazaCorrection > plazaCollision &&
      plazaMotionResolve > plazaCorrection,
    "plaza motion must sample input, collision, and server settling as one final displacement",
  );
  assert.match(
    plaza.slice(plazaMotionResolve, plazaMotionResolve + 2_400),
    /positionRef\.current\.x\s*-\s*previousPosition\.x,[\s\S]{0,100}?positionRef\.current\.y\s*-\s*previousPosition\.y[\s\S]{0,2200}?advanceCharacterWalkCycle\(\s*walkCycleRef\.current,\s*motion\.distance,\s*isDashing\s*\?\s*220\s*:\s*undefined,\s*dt\s*,?\s*\)/,
  );
  assert.doesNotMatch(plaza, /Math\.floor\(time\s*\*\s*8\.5\)/);
  assert.match(
    plaza,
    /paperdollLoadoutFromVisualGear\(\s*player\.appearance\?\.gear,\s*"common",\s*0,\s*player\.appearance\?\.rarities,?\s*\)/,
    "remote public gear must request its independent fitted layers",
  );
  assert.match(
    plaza,
    /paperdollLayerPathsForLoadout\(\s*localPaperdollLoadoutRef\.current,?\s*\)/,
    "the selected local character's canonical equipment must request its independent fitted layers",
  );
  assert.doesNotMatch(
    plaza,
    /paperdollLoadoutFromVisualGear\(\s*normalizedCharacterRef\.current\.appearance\?\.gear/,
    "a stale public appearance echo must not replace the selected local equipment",
  );
  assert.doesNotMatch(plaza, /equipment-types-v4\.png/);

  // Ground loot and inventory thumbnails keep the same transparent source atlas.
  assert.match(css, /equipment-types-v4\.png/);
  assert.match(overlay, /backgroundImage:\s*["']url\(["']\/assets\/equipment\/equipment-types-v4\.png["']\)["']/);
  assert.match(overlay, /backgroundSize:\s*`\$\{GEAR_ICON_COLUMNS \* 100\}% \$\{GEAR_ICON_ROWS \* 100\}%`/);
  assert.doesNotMatch(
    css,
    /\.inventory-screen[^{}]*\.inventory-screen-gear-icon\s*\{[^}]*background-size:\s*(?:500%|calc\([^)]*\*\s*5\))/s,
    "responsive inventory rules must not override the ten-column atlas with the obsolete five-column crop",
  );
  assert.doesNotMatch(
    css,
    /\.gear-icon\s*\{[^}]*background-size:\s*500%\s+800%/s,
    "the shared equipment icon fallback must use all ten atlas columns",
  );
  assert.match(
    source,
    /backgroundSize:\s*`\$\{size \* GEAR_ICON_COLUMNS\}px \$\{size \* GEAR_ICON_ROWS\}px`/,
  );
  assert.match(
    source,
    /sourceWidth\s*=\s*equipmentIcons\.naturalWidth\s*\/\s*GEAR_ICON_COLUMNS;[\s\S]{0,120}?sourceHeight\s*=\s*equipmentIcons\.naturalHeight\s*\/\s*GEAR_ICON_ROWS;/,
    "ground loot must crop the same ten-column by ten-row atlas as the UI",
  );
});

test("PVP preserves expedition gait and renders both sanitized duel appearances", async () => {
  const source = await readFile(path.join(root, "app/pvp/PvpArena.tsx"), "utf8");
  assert.doesNotMatch(
    source,
    /harin-neutral-walk-v4\.png|harin-walk-v2\.png|HARIN_DIRECTION_ROWS/,
    "PVP must not regress to a standalone character atlas",
  );
  assert.match(source, /PAPERDOLL_BODY_PATH/);
  assert.match(source, /createBrowserPaperdollImageStore/);
  assert.match(source, /reconcileEquipmentLevelRequirements\(\s*save\.player\.level,\s*save\.player\.equipment,\s*save\.player\.inventory/);
  assert.match(source, /paperdollLoadoutFromEquipment\(gear\.equipment\)/);
  assert.match(source, /paperdollLayerPathsForLoadout\(activeLocalAppearance\)/);
  assert.match(
    source,
    /activeSnapshot\?\.players[\s\S]{0,300}?paperdollLayerPathsForLoadout\(\s*sanitizePvpAppearance\(participant\.appearance\)/,
    "both participants must preload only their allowlisted wearable atlases",
  );
  assert.match(source, /drawPaperdollCharacterDirect\(context, \{/);
  assert.match(
    source,
    /const snapshotAppearance = sanitizePvpAppearance\(player\.appearance\);/,
    "remote cosmetics must pass through the same strict appearance sanitizer",
  );
  assert.doesNotMatch(source, /player\.id === playerIdRef\.current \? localPaperdollLoadout : \{\}/);
  assert.match(source, /getRealtimeClient\(\)\.joinQueue\(buildProfile, activeLocalAppearance\)/);
  assert.doesNotMatch(
    source,
    /joinQueue\([^)]*(?:GearItem|affix|equipment\.)/i,
    "the realtime path must not send canonical equipment or affixes",
  );
  assert.match(
    source,
    /resolveCharacterMotion\(\s*rendered\.x - previousRenderedX,\s*rendered\.y - previousRenderedY/,
    "PVP animation must follow interpolated movement instead of a global clock",
  );
  assert.match(
    source,
    /advanceCharacterWalkCycle\(\s*rendered\.walkCycle,\s*motion\.distance,\s*target\.dashRemainingMs > 0 \? 220 : undefined,\s*elapsedSeconds,?\s*\)/,
    "PVP must apply the shared elapsed-time cadence cap to interpolated movement",
  );
  assert.match(source, /settleCharacterWalkCycle\(rendered\.walkCycle\)/);
  assert.match(source, /characterRenderFrameIndex\(\s*rendered\.facing,\s*rendered\.walkCycle,\s*moving\s*,?\s*\)/);
  assert.match(
    source,
    /width:\s*PAPERDOLL_WORLD_RENDER_WIDTH,\s*height:\s*PAPERDOLL_WORLD_RENDER_HEIGHT,/,
    "PVP must share the same fitted silhouette scale as expedition and plaza",
  );
  assert.match(
    source,
    /y:\s*rendered\.y \+ PVP_PLAYER_GROUND_OFFSET_Y/,
    "PVP must share the expedition collision-foot baseline instead of sinking actors",
  );
  const paperdollPass = source.indexOf(
    "appearanceDrawn = drawPaperdollCharacterDirect",
  );
  const pvpRarityPass = source.indexOf(
    "drawEquippedRarityVfx(context",
    paperdollPass,
  );
  assert.ok(
    paperdollPass >= 0 && pvpRarityPass > paperdollPass,
    "PVP must render expedition equipment effects against the completed paperdoll",
  );
  assert.match(
    source.slice(pvpRarityPass, pvpRarityPass + 800),
    /context:\s*"combat",[\s\S]{0,80}?alpha,?/,
    "duels must reuse the exact expedition combat aura context and actor alpha",
  );
});

test("active PVP combat reuses the authored expedition room and fills the 16:9 frame", async () => {
  const [source, css, worker] = await Promise.all([
    readFile(path.join(root, "app/pvp/PvpArena.tsx"), "utf8"),
    readFile(path.join(root, "app/pvp/pvp.css"), "utf8"),
    readFile(path.join(root, "worker/realtime-d1.ts"), "utf8"),
  ]);

  assert.match(source, /ROOM_DOOR_VISUALS\.roomElite/);
  assert.match(source, /roomDoorAtlasFrameSourceRect\(0\)/);
  assert.match(source, /drawSouthDoorForeground\(\)/);
  assert.match(source, /drawGameplayVfxFrame\(/);
  assert.match(source, /loopingGameplayVfxProgress\(/);
  assert.doesNotMatch(source, /ARENA_OBSTACLES|setLineDash\(\[5, 12\]\)/);
  assert.match(
    css,
    /\.pvp-screen\.is-match-view \.pvp-match-stage\s*\{[^}]*position:\s*absolute;[^}]*inset:\s*0;[^}]*width:\s*100%;[^}]*height:\s*100%;[^}]*padding:\s*0;/,
  );
  assert.match(
    css,
    /\.pvp-screen\.is-match-view \.pvp-canvas\s*\{[^}]*width:\s*100%;[^}]*height:\s*100%;[^}]*max-height:\s*none;[^}]*border:\s*0;/,
  );
  assert.match(worker, /constrainPointToConvexPolygon\(\s*player,\s*WALKABLE_FLOOR_POLYGON,\s*PVP_PLAYER_COLLISION_CLEARANCE/);
  assert.match(worker, /arenaVersion:\s*PVP_ARENA_VERSION/);
  assert.match(worker, /const arenaVersion = match\.arenaVersion \?\? 1;/);
  assert.match(worker, /arenaVersion < PVP_ARENA_VERSION[\s\S]{0,120}?legacyArenaCollision\(player\)/);
  assert.doesNotMatch(worker, /const\s+ARENA_OBSTACLES\s*=/);
});

test("localhost PVP visual QA bypasses saves and realtime sessions", async () => {
  const [source, showcase, page, audio] = await Promise.all([
    readFile(path.join(root, "app/pvp/PvpArena.tsx"), "utf8"),
    readFile(path.join(root, "app/pvp-showcase.ts"), "utf8"),
    readFile(path.join(root, "app/pvp/page.tsx"), "utf8"),
    readFile(path.join(root, "app/GameAudioProvider.tsx"), "utf8"),
  ]);
  assert.match(showcase, /mode === "match" && isLocalPvpShowcaseHost\(host\)/);
  assert.match(showcase, /normalized\.startsWith\("localhost:"\)/);
  assert.match(
    source,
    /isLocalPvpShowcaseRequest\(\s*new URLSearchParams\(window\.location\.search\)\.get\("pvpShowcase"\),\s*window\.location\.hostname/,
  );
  assert.match(
    source,
    /useEffect\(\(\) => \{\s*if \(localShowcase \|\| localPvpShowcaseBrowserSnapshot\(\)\) return;\s*const frame = window\.requestAnimationFrame/,
    "the local QA route must exit before reading the active save",
  );
  assert.match(
    source,
    /if \(localShowcase \|\| localPvpShowcaseBrowserSnapshot\(\)\) \{\s*playerIdRef\.current = PVP_SHOWCASE_PLAYER_ID;[\s\S]{0,140}?return;\s*\}\s*const realtime = getRealtimeClient\(\);/,
    "the local QA route must exit before creating a realtime session",
  );
  assert.match(source, /data-pvp-local-gear-count=\{localGearCount\}/);
  assert.match(source, /data-pvp-opponent-gear-count=\{opponentGearCount\}/);
  assert.match(
    page,
    /const user = localShowcase \? null : await getChatGPTUser\(\);[\s\S]{0,180}?\{!localShowcase && \(\s*<WorldAnnouncementBanner/,
    "the server route must not mount the realtime announcement subscriber in local QA",
  );
  assert.match(
    audio,
    /isLocalPvpShowcaseRequest\(\s*search\.get\("pvpShowcase"\),\s*window\.location\.hostname/,
    "the root audio provider must not initialize storage-backed audio in local QA",
  );
});

test("critical, projectile, elite, sustain, and gear-find affixes affect runtime formulas", async () => {
  const source = await readFile(path.join(root, "app/GameCanvas.tsx"), "utf8");
  const missingWiring = [];
  for (const percentStat of [
    "critChancePercent",
    "critDamagePercent",
    "projectileSizePercent",
    "eliteDamagePercent",
    "gearFindPercent",
  ]) {
    if (!new RegExp(`${percentStat}[^;\\n]{0,80}\\/\\s*100`).test(source)) {
      missingWiring.push(`${percentStat} runtime formula`);
    }
  }
  if (!/equipmentStats\.lifeOnHitFlat/.test(source)) {
    missingWiring.push("lifeOnHitFlat successful-hit healing");
  }
  if (!/player\.hp\s*=\s*Math\.min\(player\.maxHp,\s*player\.hp\s*\+\s*lifeOnHit\)/.test(source)) {
    missingWiring.push("lifeOnHitFlat max-HP cap");
  }
  assert.deepEqual(missingWiring, [], "every new affix needs a concrete runtime consumer");
});

test("inventory hover and keyboard focus expose a complete Diablo-style item tooltip", async () => {
  const [overlay, css] = await Promise.all([
    readFile(path.join(root, "app/InventoryOverlay.tsx"), "utf8"),
    readFile(path.join(root, "app/game.css"), "utf8"),
  ]);

  assert.match(
    overlay,
    /const \[hoveredItem, setHoveredItem\]\s*=\s*useState<GearItem \| null>\(null\)/,
    "hovered gear needs dedicated state instead of replacing the clicked selection",
  );
  assert.match(
    overlay,
    /const \[tooltipPosition, setTooltipPosition\]\s*=\s*useState/,
    "the tooltip must follow or anchor to the hovered/focused item",
  );
  for (const handler of ["onMouseEnter", "onMouseMove", "onMouseLeave", "onFocus", "onBlur"]) {
    assert.ok(
      [...overlay.matchAll(new RegExp(`\\b${handler}=`, "g"))].length >= 2,
      `${handler} must be wired to both equipped and backpack item cards`,
    );
  }
  assert.ok(
    [...overlay.matchAll(/aria-describedby=/g)].length >= 2,
    "both item-card groups must expose the hover tooltip to assistive technology",
  );
  assert.match(overlay, /aria-describedby=\{[^}]*inventory-screen-hover-tooltip/);
  assert.match(overlay, /id=["']inventory-screen-hover-tooltip["']/);
  assert.match(overlay, /role=["']tooltip["']/);
  assert.match(
    overlay,
    /아이템 레벨 \{item\.level\} · 착용 필요 레벨 \{requiredLevel\}/,
    "the item description must label the equip gate as 착용 필요 레벨",
  );
  assert.match(
    overlay,
    /아이템 레벨 \{selectedItem\.level\} · 착용 필요 레벨 \{selectedRequiredLevel\}/,
    "the selected-item description must use the same requirement label",
  );
  assert.doesNotMatch(
    overlay,
    /착용 레벨|착용 요구 레벨|착용 LV/,
    "legacy requirement labels must not remain in item descriptions",
  );
  assert.match(
    overlay,
    /hoveredItem\s*&&[\s\S]{0,500}?createPortal\([\s\S]{0,300}?<(?:Item|Gear)Tooltip[\s\S]{0,300}?item=\{hoveredItem\}[\s\S]{0,300}?position=\{tooltipPosition\}/,
    "the hover state and viewport-aware position must drive a portal tooltip",
  );
  assert.match(
    overlay,
    /(?:function|const)\s+(?:Item|Gear)Tooltip[\s\S]{0,9000}?item\.affixes\.map/,
    "the tooltip must show every random affix rather than a shortened summary",
  );
  assert.match(
    overlay,
    /<h4>\{formatGearDisplayName\(item\)\}<\/h4>[\s\S]{0,900}?<GearImplicitBreakdown item=\{item\} compact \/>[\s\S]{0,900}?item\.affixes\.map/,
    "the tooltip must show the display-only enhanced name followed by compact option rows",
  );
  assert.match(
    overlay,
    /inventory-screen-grid-name">\{formatGearDisplayName\(item\)\}<\/small>/,
    "backpack cards must append enhancement through the same display-only helper",
  );
  assert.match(
    overlay,
    /<strong className="inventory-screen-card-edge-chip inventory-screen-enhancement-badge">\+\{item\.enhancement\}<\/strong>/,
    "icon-first backpack cards must retain a compact stage marker from +0 onward",
  );
  assert.match(
    overlay,
    /\{item && \([\s\S]{0,180}?inventory-screen-equipment-enhancement/,
    "paperdoll cards must retain a compact stage marker from +0 onward",
  );
  assert.match(
    overlay,
    /inventory-screen-equipment-enhancement[\s\S]{0,120}?aria-label=\{`강화 \+\$\{item\.enhancement\}`\}[\s\S]{0,100}?\+\{item\.enhancement\}/,
    "the equipped icon marker must expose the same enhancement stage visually and accessibly",
  );
  assert.match(
    css,
    /\.inventory-screen-equipment-enhancement\s*\{[\s\S]{0,500}?min-width:\s*20px;[\s\S]{0,280}?background:\s*rgba\(5, 7, 9, 0\.9\);/,
    "the equipped enhancement marker must stay legible above bright rarity effects",
  );
  assert.doesNotMatch(
    overlay,
    /<h4>\{item\.displayName\}|inventory-screen-grid-name">\{item\.displayName\}/,
    "visible equipment titles must not bypass the enhancement-aware display helper",
  );
  assert.match(
    overlay,
    /(?:function|const)\s+(?:Item|Gear)Tooltip[\s\S]{0,9000}?LEGENDARY_POWERS\[item\.legendaryPowerId\]/,
    "legendary powers must be visible directly in the tooltip",
  );
  assert.match(
    css,
    /\.inventory-screen-tooltip\s*\{[\s\S]{0,500}?position:\s*fixed;/,
    "the item tooltip must float above the inventory without affecting its layout",
  );
  assert.match(
    overlay,
    /className="inventory-screen-tooltip-scroll"/,
    "a viewport-constrained tooltip must expose a dedicated option scroller",
  );
  assert.ok(
    [...overlay.matchAll(/onWheel=\{handleTooltipWheel\}/g)].length >= 2 &&
      [...overlay.matchAll(/onKeyDown=\{handleTooltipKeyDown\}/g)].length >= 2,
    "equipped and backpack cards must scroll long tooltips without making the overlay intercept clicks",
  );
  assert.match(
    overlay,
    /const size = clientRectSizeToGamePlane\(rect\);[\s\S]{0,100}?onMeasure\(size\.width, size\.height\);[\s\S]{0,180}?new ResizeObserver\(reportSize\)/,
    "tooltip placement must convert rendered dimensions back into canonical game-plane units",
  );
  assert.match(
    css.slice(css.indexOf("Tooltip and confirmation readability contract V7")),
    /\.inventory-screen-tooltip\s*\{[^}]*pointer-events:\s*none;/,
    "scrollable tooltip content must not intercept clicks intended for inventory controls",
  );
});

test("inventory clears a tooltip before moving its item to equipment", async () => {
  const overlay = await readFile(path.join(root, "app/InventoryOverlay.tsx"), "utf8");
  assert.match(
    overlay,
    /const equipItem\s*=\s*\(gearId:\s*string\)\s*=>\s*\{\s*if \(readOnly\) return;[\s\S]{0,260}?setHoveredItem\(null\);\s*onEquip\(gearId\);\s*\}/,
  );
  assert.match(
    overlay,
    /onDoubleClick=\{\(\) => \{\s*if \(!salvageModeActive && !readOnly\) equipItem\(item\.id\)/,
    "moving gear between backpack and equipment must dismiss the stale source tooltip",
  );
});

test("batch salvage mode suppresses item information tooltips", async () => {
  const overlay = await readFile(path.join(root, "app/InventoryOverlay.tsx"), "utf8");
  assert.match(
    overlay,
    /const showPointerTooltip[\s\S]{0,220}?if \(salvageModeActive\) return;/,
    "pointer hover must be inert while batch salvage selection is active",
  );
  assert.match(
    overlay,
    /const showFocusTooltip[\s\S]{0,220}?if \(salvageModeActive\) return;/,
    "keyboard focus must not open item information during batch salvage",
  );
  assert.match(
    overlay,
    /const toggleSalvageMode[\s\S]{0,220}?clearSalvageSelection\(\);[\s\S]{0,120}?setHoveredItem\(null\);/,
    "entering or leaving batch salvage must dismiss any already-open tooltip",
  );
  assert.match(
    overlay,
    /\{!salvageModeActive && hoveredItem && typeof document !== ["']undefined["'] &&[\s\S]{0,120}?createPortal/,
    "the tooltip portal needs a final render guard against salvage mode",
  );
  assert.ok(
    [...overlay.matchAll(/aria-describedby=\{[^}]*!salvageModeActive[^}]*inventory-screen-hover-tooltip/g)].length >= 2,
    "equipped and backpack cards must both drop tooltip descriptions in salvage mode",
  );
});

test("the backpack renders one continuous keyboard-scrollable slot grid", async () => {
  const [source, overlay, css] = await Promise.all([
    readFile(path.join(root, "app/GameCanvas.tsx"), "utf8"),
    readFile(path.join(root, "app/InventoryOverlay.tsx"), "utf8"),
    readFile(path.join(root, "app/game.css"), "utf8"),
  ]);

  assert.match(overlay, /import \{ BASE_INVENTORY_CAPACITY \} from ["']\.\/shop["'];/);
  assert.match(
    overlay,
    /const normalizedInventoryCapacity\s*=\s*Math\.max\([\s\S]{0,120}?BASE_INVENTORY_CAPACITY,[\s\S]{0,100}?Math\.floor\(inventoryCapacity\)/,
  );
  assert.match(
    overlay,
    /const emptyCellCount\s*=\s*Math\.max\(\s*0,\s*normalizedInventoryCapacity\s*-\s*inventory\.length/,
    "all purchased empty slots must continue after the last item in the same grid",
  );
  assert.match(
    overlay,
    /className="inventory-screen-grid-viewport"[\s\S]{0,320}?role="region"[\s\S]{0,220}?세로 스크롤[\s\S]{0,100}?tabIndex=\{0\}[\s\S]{0,120}?onScroll=\{\(\) => setHoveredItem\(null\)\}/,
    "the scroll region must be keyboard reachable and dismiss a stale fixed tooltip while moving",
  );
  assert.match(
    overlay,
    /const handleInventoryScrollKeyDown[\s\S]{0,900}?ArrowDown[\s\S]{0,160}?PageDown[\s\S]{0,240}?End[\s\S]{0,360}?preventDefault\(\);[\s\S]{0,160}?stopPropagation\(\);[\s\S]{0,180}?scrollTo\(\{ top: nextTop, behavior: "auto" \}\)/,
    "arrow, page, home, and end keys must move the bag even while the game owns global movement keys",
  );
  assert.match(overlay, /onKeyDown=\{handleInventoryScrollKeyDown\}/);
  assert.match(
    source,
    /\[tabindex\]:not\(\[tabindex='-1'\]\)/,
    "the global combat key handler must recognize a focused scroll region as interactive UI",
  );
  assert.match(overlay, /\{sortedInventory\.map\(\(item, itemIndex\) => \{/);
  assert.match(
    overlay,
    /const sourceIndex = inventorySourceIndexById\.get\(item\.id\) \?\? itemIndex;[\s\S]{0,100}?const overCapacity = sourceIndex >= normalizedInventoryCapacity;/,
  );
  assert.match(overlay, /setSelectedForSalvage\(new Set\(inventory\.map\(\(item\) => item\.id\)\)\)/);
  assert.doesNotMatch(overlay, /inventory\.slice\(/, "the visible bag must never slice items into pages");
  assert.doesNotMatch(overlay, /inventoryPage|activeInventoryPage|totalInventoryPages|visibleInventory/);
  assert.doesNotMatch(overlay, /inventory-screen-page-tabs|inventory-screen-grid-locked/);
  assert.doesNotMatch(css, /inventory-screen-page-tabs|inventory-screen-grid-locked/);

  const rulesFor = (selector) =>
    [...css.matchAll(new RegExp(`\\.${selector}\\s*\\{([^}]+)\\}`, "g"))].map(
      (match) => match[1],
    );
  const panelRule = rulesFor("inventory-screen-panel")
    .filter((rule) => /width:\s*min\(\d+px/.test(rule))
    .sort(
      (left, right) =>
        Number(right.match(/width:\s*min\((\d+)px/)?.[1] ?? 0)
        - Number(left.match(/width:\s*min\((\d+)px/)?.[1] ?? 0),
    )[0];
  assert.ok(panelRule, "the desktop inventory panel rule is missing");
  const panelWidth = Number(panelRule.match(/width:\s*min\((\d+)px/)?.[1] ?? 0);
  const panelHeight = Number(panelRule.match(/height:\s*min\((\d+)px/)?.[1] ?? 0);
  assert.ok(panelWidth >= 1280, `the inventory panel is still too narrow (${panelWidth}px)`);
  assert.ok(panelHeight >= 760, `the inventory panel is still too short (${panelHeight}px)`);

  const layoutRule = rulesFor("inventory-screen-layout").find((rule) =>
    /grid-template-columns:\s*minmax\(370px/.test(rule),
  );
  assert.ok(layoutRule, "the desktop inventory layout rule is missing");

  const scrollContractStart = css.lastIndexOf("Continuous backpack scroll contract V4");
  assert.ok(scrollContractStart >= 0, "the authoritative continuous-scroll contract is missing");
  const scrollCss = css.slice(scrollContractStart);
  assert.match(scrollCss, /\.inventory-screen-backpack\s*\{[^}]*grid-template-rows:\s*auto\s+auto\s+minmax\(0,\s*1fr\);[^}]*overflow:\s*hidden;/);
  assert.match(
    scrollCss,
    /\.inventory-screen-grid-viewport\s*\{[\s\S]{0,900}?overflow-x:\s*hidden;[\s\S]{0,100}?overflow-y:\s*auto;[\s\S]{0,700}?overscroll-behavior:\s*contain;[\s\S]{0,300}?scrollbar-gutter:\s*stable;/,
    "only the bag viewport should own the vertical scrollbar",
  );
  assert.match(scrollCss, /\.inventory-screen-grid-viewport::-webkit-scrollbar-thumb\s*\{/);
  assert.match(
    scrollCss,
    /\.inventory-screen-grid\s*\{[\s\S]{0,420}?height:\s*auto;[\s\S]{0,100}?min-height:\s*100%;[\s\S]{0,180}?grid-template-columns:\s*repeat\(6,\s*minmax\(0,\s*1fr\)\);[\s\S]{0,100}?grid-template-rows:\s*none;[\s\S]{0,160}?grid-auto-flow:\s*row;[\s\S]{0,180}?align-content:\s*start;[\s\S]{0,180}?overflow:\s*visible;/,
    "rows after slot 24 must extend the grid instead of being clipped",
  );
  assert.match(
    scrollCss,
    /@container\s+game-viewport\s*\(max-width:\s*900px\)[\s\S]{0,420}?grid-template-columns:\s*repeat\(4,\s*minmax\(0,\s*1fr\)\)/,
    "the continuous list must remain usable on the compact inventory layout",
  );
});

test("inventory sorting is stable, display-only, and supports power, rarity, level, and slot", async () => {
  const [sorter, equipment, overlay, css] = await Promise.all([
    importTypeScriptModule("app/inventory-sort.ts"),
    importTypeScriptModule("app/equipment.ts"),
    readFile(path.join(root, "app/InventoryOverlay.tsx"), "utf8"),
    readFile(path.join(root, "app/game.css"), "utf8"),
  ]);
  assert.deepEqual(sorter.INVENTORY_SLOT_ORDER, equipment.EQUIPMENT_SLOTS);
  assert.deepEqual(sorter.INVENTORY_RARITY_ORDER, equipment.GEAR_RARITIES);
  assert.deepEqual(sorter.INVENTORY_SORT_OPTIONS, [
    { id: "power", label: "보스 화력", title: "아이템 보스 화력이 높은 장비부터 정렬" },
    { id: "rarity", label: "등급", title: "높은 등급 장비부터 정렬" },
    { id: "level", label: "레벨", title: "아이템 레벨이 높은 장비부터 정렬" },
    { id: "slot", label: "부위", title: "장비 부위 순서로 묶어서 정렬" },
  ]);

  const inventory = [
    { id: "common-boots", rarity: "common", level: 50, powerScore: 500, slot: "boots" },
    { id: "legendary-weapon-a", rarity: "legendary", level: 30, powerScore: 400, slot: "weapon" },
    { id: "cosmic-relic", rarity: "cosmic", level: 20, powerScore: 300, slot: "relic" },
    { id: "magic-armor", rarity: "magic", level: 90, powerScore: 600, slot: "armor" },
    { id: "legendary-weapon-b", rarity: "legendary", level: 30, powerScore: 400, slot: "weapon" },
  ];
  const originalOrder = inventory.map((item) => item.id);
  const idsFor = (mode) => sorter.sortInventoryItems(inventory, mode).map((item) => item.id);

  assert.deepEqual(idsFor("power"), [
    "magic-armor",
    "common-boots",
    "legendary-weapon-a",
    "legendary-weapon-b",
    "cosmic-relic",
  ]);
  assert.deepEqual(idsFor("rarity"), [
    "cosmic-relic",
    "legendary-weapon-a",
    "legendary-weapon-b",
    "magic-armor",
    "common-boots",
  ]);
  assert.deepEqual(idsFor("level"), [
    "magic-armor",
    "common-boots",
    "legendary-weapon-a",
    "legendary-weapon-b",
    "cosmic-relic",
  ]);
  assert.deepEqual(idsFor("slot"), [
    "legendary-weapon-a",
    "legendary-weapon-b",
    "magic-armor",
    "common-boots",
    "cosmic-relic",
  ]);
  assert.deepEqual(
    inventory.map((item) => item.id),
    originalOrder,
    "sorting must never mutate the persisted acquisition order",
  );

  assert.match(overlay, /useState<InventorySortMode>\(["']power["']\)/);
  assert.match(overlay, /sortInventoryItems\(inventory, inventorySortMode\)/);
  assert.match(overlay, /INVENTORY_SORT_OPTIONS\.map\(\(option\) =>/);
  assert.match(overlay, /aria-label=["']가방 정렬 기준["']/);
  assert.match(overlay, /aria-pressed=\{inventorySortMode === option\.id\}/);
  assert.match(overlay, /sortedInventory\.map\(\(item, itemIndex\) =>/);
  assert.match(
    overlay,
    /const sourceIndex = inventorySourceIndexById\.get\(item\.id\) \?\? itemIndex;[\s\S]{0,100}?const overCapacity = sourceIndex >= normalizedInventoryCapacity;/,
    "view sorting must not reassign which persisted items are over capacity",
  );
  assert.match(css, /\.inventory-screen-sort-controls\s*\{[^}]*display:\s*inline-flex;/);
  assert.match(
    css,
    /\.inventory-screen-sort-controls > button\[aria-pressed=["']true["']\]\s*\{[^}]*border-color:[^}]*box-shadow:/,
    "the active sort criterion needs a strong persistent visual state",
  );
});

test("the cash shop pauses combat and expands every backpack boundary without truncating gear", async () => {
  const [source, overlay, shopOverlay, shop, css] = await Promise.all([
    readFile(path.join(root, "app/GameCanvas.tsx"), "utf8"),
    readFile(path.join(root, "app/InventoryOverlay.tsx"), "utf8"),
    readFile(path.join(root, "app/ShopOverlay.tsx"), "utf8"),
    readFile(path.join(root, "app/shop.ts"), "utf8"),
    readFile(path.join(root, "app/game.css"), "utf8"),
  ]);

  assert.doesNotMatch(
    source,
    /data\.player\.inventory[\s\S]{0,240}?\.slice\(0,\s*24\)/,
    "loading a purchased expansion must never delete gear beyond the legacy limit",
  );
  assert.ok(
    [...source.matchAll(/inventoryCapacityRef\.current/g)].length >= 5,
    "loadout removal, showcase grants, and field pickup must share the live capacity ref",
  );
  assert.match(
    source,
    /const isSimulationRunning[\s\S]{0,300}?!shopOpenRef\.current/,
    "the cash shop must freeze the combat simulation",
  );
  assert.match(source, /key === ["']p["'][\s\S]{0,180}?openShop\(\)/);
  assert.match(source, /data-inventory-capacity=\{inventoryCapacity\}/);
  assert.match(source, /data-shop-open=\{shopOpen\}/);
  assert.match(
    source,
    /<InventoryOverlay[\s\S]{0,500}?inventoryCapacity=\{inventoryCapacity\}[\s\S]{0,120}?onOpenShop=\{openShopFromInventory\}/,
  );
  assert.ok(
    [...source.matchAll(/<ShopOverlay/g)].length >= 2,
    "the title screen and active run both need a store surface",
  );

  assert.match(overlay, /inventoryCapacity:\s*number;/);
  assert.match(overlay, /onOpenShop:\s*\(\)\s*=>\s*void;/);
  assert.match(overlay, /normalizedInventoryCapacity[\s\S]{0,180}?BASE_INVENTORY_CAPACITY/);
  assert.match(overlay, /normalizedInventoryCapacity\s*-\s*inventory\.length/);
  assert.match(overlay, /inventory-screen-grid-cell--over-capacity/);
  assert.match(overlay, /초과 보관/);

  assert.match(shopOverlay, /role="dialog"/);
  assert.match(shopOverlay, /aria-modal="true"/);
  assert.match(shopOverlay, /LOCAL PAYMENT DEMO/);
  assert.match(shopOverlay, /실제 청구나 결제정보 입력 없이/);
  assert.match(shopOverlay, /checkoutMode !== "local-test"/);
  assert.match(shopOverlay, /role="alertdialog"/);
  assert.match(shopOverlay, /구매 기록 복구/);
  assert.doesNotMatch(`${source}\n${overlay}\n${shopOverlay}`, /window\.(?:alert|confirm|prompt)\(/);

  assert.match(shop, /BASE_INVENTORY_CAPACITY = 24/);
  assert.match(shop, /MAX_INVENTORY_CAPACITY = 48/);
  assert.doesNotMatch(shop, /INVENTORY_PAGE_SIZE|가방 페이지/);
  assert.match(shop, /SHOP_STORAGE_KEY/);
  assert.match(shop, /candidate === "localhost" \|\| candidate === "127\.0\.0\.1" \|\| candidate === "::1"/);
  assert.match(css, /\.shop-panel\s*\{[^}]*grid-template-rows:/);
  assert.match(css, /\.shop-layout\s*\{[^}]*grid-template-columns:\s*184px\s+minmax\(430px,\s*1fr\)\s+285px;/);
  assert.match(css, /Continuous backpack scroll contract V4/);
  assert.match(css, /\.inventory-screen-grid-viewport\s*\{[\s\S]{0,900}?overflow-y:\s*auto;/);
  assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*?\.shop-product\.is-selected::after[\s\S]*?animation:\s*none;/);
});

test("the enhancement workbench keeps readable scroll regions and reachable equipment actions", async () => {
  const [overlay, css] = await Promise.all([
    readFile(path.join(root, "app/InventoryOverlay.tsx"), "utf8"),
    readFile(path.join(root, "app/game.css"), "utf8"),
  ]);

  assert.match(
    css,
    /\.inventory-screen-detail-content\s*\{[^}]*height:\s*100%;/,
    "the detail grid item must use its assigned row instead of subtracting the heading twice",
  );
  assert.doesNotMatch(
    css,
    /\.inventory-screen-detail-content\s*\{[^}]*height:\s*calc\(100%\s*-\s*42px\)/,
    "the legacy double height subtraction recreates the workbench overlap",
  );
  const workbenchContract = css.slice(css.indexOf("Inventory workbench readability contract V5"));
  assert.match(
    workbenchContract,
    /\.inventory-screen-detail-actions-column\s*\{[^}]*grid-template-rows:\s*minmax\(0,\s*1fr\)\s+auto;[^}]*overflow:\s*hidden;/,
    "the scrollable enhancement track must shrink before pushing the action row out of view",
  );
  assert.match(
    workbenchContract,
    /\.inventory-screen-detail-stats\s*\{[^}]*overflow-y:\s*auto;[^}]*overscroll-behavior:\s*contain;[^}]*scrollbar-gutter:\s*stable;/,
    "long option lists must remain independently scrollable",
  );
  assert.match(
    workbenchContract,
    /\.inventory-screen-enhancement\s*\{[^}]*display:\s*grid;[^}]*grid-template-rows:\s*minmax\(0,\s*1fr\)\s+auto;[^}]*overflow:\s*hidden;/,
    "the enhancement shell must reserve a fixed footer row for its primary action",
  );
  assert.match(
    workbenchContract,
    /\.inventory-screen-enhancement-scroll\s*\{[^}]*min-height:\s*0;[^}]*overflow-y:\s*auto;[^}]*overscroll-behavior:\s*contain;[^}]*scrollbar-gutter:\s*stable;/,
    "only enhancement information may scroll while the enhance button stays visible",
  );
  assert.doesNotMatch(
    workbenchContract,
    /\.inventory-screen-enhancement\s*\{[^}]*overflow-y:\s*auto;/,
    "the shell itself must never scroll the enhance button out of reach",
  );
  assert.match(
    workbenchContract,
    /\.inventory-screen-enhancement-heading small,[\s\S]{0,700}?font-size:\s*10px;/,
    "secondary enhancement copy must retain a ten-pixel readability floor",
  );
  assert.match(
    overlay,
    /className="inventory-screen-detail-stats"[\s\S]{0,180}?role="region"[\s\S]{0,180}?aria-label="장비 옵션 스크롤 영역"[\s\S]{0,100}?tabIndex=\{0\}/,
    "the option scroller must be keyboard reachable and announced",
  );
  assert.match(
    overlay,
    /className="inventory-screen-enhancement-scroll"[\s\S]{0,180}?role="region"[\s\S]{0,180}?aria-label="강화 정보 스크롤 영역"[\s\S]{0,100}?tabIndex=\{0\}/,
    "the enhancement information scroller must be keyboard reachable and announced",
  );
  assert.match(
    overlay,
    /className="inventory-screen-enhancement-scroll"[\s\S]{0,6000}?<\/div>\s*\{enhancementRule && \(\s*<button[\s\S]{0,160}?className="inventory-screen-enhancement-button"/,
    "the enhance button must be rendered after and outside the information scroller",
  );
  assert.match(
    css,
    /\.inventory-screen-equipped-actions\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s+auto;/,
    "the equipped-state label must receive the space left by its intrinsic-width button",
  );
  assert.match(
    css,
    /\.inventory-screen-equipped-state\s*\{[^}]*text-overflow:\s*ellipsis;[^}]*white-space:\s*nowrap;/,
    "the equipped-state label must never wrap into the enhancement table",
  );

  const geometryContract = css.slice(css.indexOf("Inventory geometry contract V3"));
  assert.match(
    geometryContract,
    /\.inventory-screen-left-column\s*\{[^}]*grid-template-rows:\s*minmax\(360px,\s*1\.28fr\)\s+minmax\(250px,\s*0\.72fr\)/,
    "the desktop paperdoll and workbench must retain dedicated non-overlapping tracks",
  );
  assert.match(
    geometryContract,
    /@container\s+game-viewport\s*\(min-height:\s*681px\)\s*and\s*\(max-height:\s*800px\)\s*and\s*\(min-width:\s*901px\)[\s\S]{0,900}?\.inventory-screen-layout\s*\{[^}]*overflow-y:\s*auto;[\s\S]{0,500}?\.inventory-screen-left-column\s*\{[^}]*grid-template-rows:\s*440px\s+270px;[^}]*min-height:\s*720px/,
    "the narrower desktop fallback must scroll instead of collapsing the five paperdoll rows",
  );

  const desktopDeck = css.slice(css.indexOf("Desktop armory workbench deck V9"));
  assert.match(
    desktopDeck,
    /@container\s+game-viewport\s*\(min-width:\s*1180px\)[\s\S]{0,650}?\.inventory-screen-layout\s*\{[^}]*grid-template-columns:[^}]*minmax\(360px,\s*0\.95fr\)[^}]*minmax\(300px,\s*0\.8fr\)[^}]*minmax\(380px,\s*1\.25fr\);[^}]*overflow:\s*hidden;/,
    "the release-width armory must expose equipment, workbench, and backpack as three full-height columns",
  );
  assert.match(
    desktopDeck,
    /\.inventory-screen-left-column\s*\{[^}]*display:\s*contents;[\s\S]{0,650}?\.inventory-screen-equipment\s*\{[^}]*grid-column:\s*1;[\s\S]{0,300}?\.inventory-screen-details\s*\{[^}]*grid-column:\s*2;[\s\S]{0,300}?\.inventory-screen-backpack\s*\{[^}]*grid-column:\s*3;/,
    "each desktop armory surface must occupy its own column instead of stacking the workbench below equipment",
  );
});

test("dense game surfaces keep readable text floors and viewport-owned scrolling", async () => {
  const [gameCss, shopOverlay, plazaCss, statsCss, audioCss, characterCss, pvpCss, marketCss] =
    await Promise.all([
      readFile(path.join(root, "app/game.css"), "utf8"),
      readFile(path.join(root, "app/ShopOverlay.tsx"), "utf8"),
      readFile(path.join(root, "app/plaza.css"), "utf8"),
      readFile(path.join(root, "app/stats-overlay.css"), "utf8"),
      readFile(path.join(root, "app/audio-controls.css"), "utf8"),
      readFile(path.join(root, "app/character-entry.css"), "utf8"),
      readFile(path.join(root, "app/pvp/pvp.css"), "utf8"),
      readFile(path.join(root, "app/market/market.css"), "utf8"),
    ]);

  assert.match(
    gameCss,
    /\.menu-screen,\s*\n\.game-screen\s*\{[^}]*width:\s*100%;[^}]*height:\s*100%;[^}]*min-height:\s*0;/,
    "the game shell must fill the shared 16:9 frame without enforcing a clipped minimum height",
  );
  assert.match(
    gameCss.slice(gameCss.indexOf("Final inventory text floor V6")),
    /\.inventory-screen \.inventory-screen-equipment-enhancement,[\s\S]{0,900}?font-size:\s*10px;/,
    "equipped enhancement badges must retain the same ten-pixel floor as other slot labels",
  );

  const shopContract = gameCss.slice(gameCss.indexOf("Shop and residual game UI readability contract V1"));
  assert.match(
    shopContract,
    /\.shop-panel\s*\{[^}]*min-height:\s*0;[^}]*max-height:\s*calc\(100cqh\s*-\s*24px\);[^}]*grid-template-rows:\s*78px\s+40px\s+minmax\(0,\s*1fr\)\s+32px;/,
    "the desktop shop must fit inside the viewport instead of enforcing a clipped minimum height",
  );
  assert.match(
    shopContract,
    /\.shop-category,[\s\S]{0,180}?\.shop-product-grid,[\s\S]{0,180}?\.shop-checkout\s*\{[^}]*overflow-y:\s*auto;[^}]*scrollbar-gutter:\s*stable;/,
    "the shop columns must own their overflow",
  );
  assert.match(
    shopContract,
    /\.shop-product-grid\s*\{[^}]*grid-template-rows:\s*none;[^}]*grid-auto-rows:\s*minmax\(86px,\s*auto\);/,
    "larger product copy must reflow instead of being clipped by fixed rows",
  );
  assert.match(shopContract, /\.shop-legal-note,[\s\S]{0,180}?font-size:\s*10px;/);
  assert.match(shopContract, /\.shop-buy,[\s\S]{0,180}?font-size:\s*12px;/);
  assert.match(
    gameCss,
    /@container\s+game-viewport\s*\(max-width:\s*760px\)\s*\{[\s\S]{0,900}?\.shop-layout\s*\{[^}]*display:\s*block;[^}]*overflow-y:\s*auto;/,
    "the shop must leave its two-column minimum-width layout before the 721px clipping band",
  );
  assert.match(
    gameCss,
    /@container\s+game-viewport\s*\(max-width:\s*978px\)\s*\{\s*\.shop-layout\s*\{[^}]*minmax\(390px,\s*1fr\)\s+270px;/,
    "the shop must leave its three-column layout before the 961-978px clipping band",
  );
  assert.match(
    shopOverlay,
    /className="shop-product-grid"[\s\S]{0,180}?aria-label="상점 상품 목록 스크롤 영역"[\s\S]{0,80}?tabIndex=\{0\}/,
  );
  assert.match(
    shopOverlay,
    /className="shop-checkout"[\s\S]{0,120}?aria-labelledby="shop-checkout-title"[\s\S]{0,80}?tabIndex=\{0\}/,
  );

  assert.match(
    plazaCss,
    /@container\s+game-viewport\s*\(max-height:\s*620px\)\s*and\s*\(min-width:\s*821px\)[\s\S]*?\.plaza-portal-directory\s*\{[^}]*max-height:\s*calc\(100cqh\s*-\s*112px\);[^}]*overflow-y:\s*auto;/,
  );
  assert.match(statsCss, /Readability audit:[\s\S]*?\.stats-row dt > span,[\s\S]*?font-size:\s*12px;/);
  assert.match(audioCss, /\.audio-dock__panel\s*\{[^}]*max-height:\s*calc\(100cqh\s*-\s*104px\);[^}]*overflow-y:\s*auto;/);
  assert.match(characterCss, /\.character-entry\s*\{[^}]*overflow-y:\s*auto;/);
  assert.match(pvpCss, /\.pvp-screen\s*\{[^}]*overflow-y:\s*auto;/);
  assert.match(marketCss, /Readability audit:[\s\S]*?\.market-screen small,[\s\S]*?font-size:\s*10px;/);

  const portalledContract = gameCss.slice(gameCss.indexOf("Tooltip and confirmation readability contract V7"));
  assert.match(
    portalledContract,
    /\.inventory-screen-tooltip \.inventory-screen-tooltip-heading small,[\s\S]{0,900}?\.game-confirmation-hint\s*\{[^}]*font-size:\s*10px;/,
    "tooltip and confirmation metadata must not fall below ten pixels",
  );
  assert.match(
    portalledContract,
    /\.inventory-screen-confirm-dialog,[\s\S]{0,80}?\.game-confirmation-dialog\s*\{[^}]*max-height:\s*calc\(100cqh\s*-\s*36px\);[^}]*overflow-y:\s*auto;/,
    "confirmation dialogs must own overflow on short viewports",
  );
  assert.match(
    portalledContract,
    /\.inventory-screen-tooltip-scroll\s*\{[^}]*max-height:\s*calc\(100cqh\s*-\s*60px\);[^}]*overflow-y:\s*auto;/,
    "long hover details must own a viewport-bounded scroll region",
  );

  const compactInventoryContract = gameCss.slice(gameCss.indexOf("Compact inventory access contract V8"));
  assert.match(
    compactInventoryContract,
    /@container\s+game-viewport\s*\(max-width:\s*900px\)[\s\S]{0,1100}?\.inventory-screen-details\s*\{[^}]*display:\s*grid;/,
    "narrow touch layouts must retain the explicit equipment workbench",
  );
  assert.match(
    compactInventoryContract,
    /@container\s+game-viewport\s*\(max-width:\s*900px\)[\s\S]{0,1800}?\.inventory-screen-detail-stats\s*\{[^}]*display:\s*block;/,
    "narrow touch layouts must keep the full option list visible and scrollable",
  );
  assert.match(
    compactInventoryContract,
    /@container\s+game-viewport\s*\(max-height:\s*680px\)\s*and\s*\(min-width:\s*901px\)[\s\S]{0,1000}?\.inventory-screen-details\s*\{[^}]*display:\s*grid;/,
    "short desktop layouts must scroll to the workbench instead of deleting it",
  );
});

test("every backpack item shows its equipped-slot power delta before hover", async () => {
  const [overlay, css] = await Promise.all([
    readFile(path.join(root, "app/InventoryOverlay.tsx"), "utf8"),
    readFile(path.join(root, "app/game.css"), "utf8"),
  ]);

  assert.match(
    overlay,
    /const inventoryPowerDeltaById = useMemo\([\s\S]{0,300}?calculateEquipmentPowerDelta\(equipment, item\)[\s\S]{0,180}?\[equipment, inventory\]/,
    "the whole-loadout contextual comparison must be cached until equipment or inventory changes",
  );
  assert.match(
    overlay,
    /sortedInventory\.map\(\(item,\s*itemIndex\) => \{[\s\S]{0,300}?const itemPowerDelta = inventoryPowerDeltaById\.get\(item\.id\) \?\? 0/,
    "each backpack card must read its cached contextual comparison",
  );
  assert.match(
    overlay,
    /className=\{`inventory-screen-card-edge-chip inventory-screen-grid-delta\s+\$\{powerDeltaClass\(itemPowerDelta\)\}`\}/,
    "power deltas need persistent positive, negative, and neutral badge treatments",
  );
  for (const state of ["positive", "negative", "neutral"]) {
    assert.match(
      overlay,
      new RegExp(`["']inventory-screen-grid-delta--${state}["']`),
      `the power-delta classifier must expose its ${state} state`,
    );
  }
  assert.match(
    overlay,
    /(?:function|const)\s+formatPowerDelta[\s\S]{0,700}?delta\s*>\s*0[\s\S]{0,240}?`\+\$\{[\s\S]{0,360}?delta\s*<\s*0[\s\S]{0,500}?["'`]0["'`]/,
    "the badge formatter must explicitly preserve +, -, and zero outcomes",
  );
  assert.match(
    css,
    /\.inventory-screen-grid-delta\s*\{[\s\S]{0,260}?position:\s*absolute;[\s\S]{0,260}?top:/,
    "the comparison badge must remain visible in the card's upper area without waiting for hover",
  );
  for (const state of ["positive", "negative", "neutral"]) {
    assert.match(css, new RegExp(`\\.inventory-screen-grid-delta--${state}\\s*\\{`));
  }
});

test("inventory salvage mode toggles whole cards and confirms single or batch actions in-game", async () => {
  const [source, overlay, css] = await Promise.all([
    readFile(path.join(root, "app/GameCanvas.tsx"), "utf8"),
    readFile(path.join(root, "app/InventoryOverlay.tsx"), "utf8"),
    readFile(path.join(root, "app/game.css"), "utf8"),
  ]);

  assert.match(overlay, /onSalvageMany\??:\s*\(gearIds:\s*string\[\]\)\s*=>\s*void;/);
  assert.match(
    overlay,
    /import[\s\S]{0,1200}?getGearSalvageAshBreakdown[\s\S]{0,240}?from ["']\.\/equipment["']/,
    "batch salvage previews must share the domain's exact base and enhancement-refund valuation",
  );
  assert.match(
    overlay,
    /const \[selectedForSalvage, setSelectedForSalvage\]\s*=\s*useState<Set<string>>\(/,
    "batch salvage needs independent card-selection state",
  );
  assert.match(overlay, /(?:const|function)\s+toggleSalvageSelection\b/);
  assert.match(overlay, /(?:const|function)\s+selectAllForSalvage\b/);
  assert.match(overlay, /(?:const|function)\s+clearSalvageSelection\b/);
  assert.match(
    overlay,
    /const checkedForSalvage\s*=\s*salvageModeActive && selectedForSalvage\.has\(item\.id\)/,
    "the occupied backpack card itself must be the keyboard-accessible selection control",
  );
  assert.match(overlay, /onClick=\{\(\) => \{\s*if \(salvageModeActive\) toggleSalvageSelection\(item\.id\)/);
  assert.match(overlay, /aria-pressed=\{salvageModeActive \? checkedForSalvage : selected\}/);
  assert.match(
    overlay,
    /\{checkedForSalvage\s*&&\s*\([\s\S]{0,260}?inventory-screen-salvage-selection-mark[\s\S]{0,180}?aria-hidden=["']true["'][\s\S]{0,180}?분해 선택됨/,
    "selected salvage cards need a prominent, non-interactive in-card seal",
  );
  assert.doesNotMatch(overlay, /type=["']checkbox["']/);
  assert.doesNotMatch(
    overlay,
    /inventory-screen-salvage-check/,
    "salvage selection must be shown by the item card itself, not a checkbox-like corner control",
  );
  assert.match(
    overlay,
    /selectedSalvageItems\.length[\s\S]{0,500}?(?:선택|selected)/i,
    "the batch toolbar must show its live selected-item count",
  );
  assert.match(
    overlay,
    /onClick=\{selectAllForSalvage\}[\s\S]{0,500}?onClick=\{clearSalvageSelection\}/,
    "select-all and clear must be adjacent, explicit actions",
  );
  assert.match(
    overlay,
    /const confirmSalvage[\s\S]{0,300}?confirmationSalvageItems\.map\(\(item\) => item\.id\)[\s\S]{0,300}?onSalvageMany\(gearIds\)/,
    "batch salvage must receive only checked IDs",
  );
  assert.match(overlay, /const \[pendingSingleSalvageId, setPendingSingleSalvageId\]/);
  assert.match(overlay, /(?:const|function)\s+requestSalvageOne\b/);
  assert.match(
    overlay,
    /pendingSingleSalvageItem[\s\S]{0,260}?onSalvage\(pendingSingleSalvageItem\.id\)/,
    "single-item salvage must use the same in-game confirmation flow",
  );
  assert.match(
    overlay,
    /onClick=\{requestSalvageMany\}[\s\S]{0,240}?disabled=\{selectedSalvageItems\.length\s*===\s*0\}/,
    "batch salvage must be disabled for an empty selection",
  );
  assert.match(overlay, /role=["']alertdialog["'][\s\S]{0,300}?aria-modal=["']true["']/);
  assert.match(
    overlay,
    /confirmationSalvageItems\.length\}개[\s\S]{0,900}?기본 분해[\s\S]{0,500}?강화 비용 환급[\s\S]{0,400}?100% 성공 기준[\s\S]{0,500}?총 획득[\s\S]{0,300}?confirmationSalvageAsh\.toLocaleString/,
    "the in-game confirmation must separate base salvage, deterministic refund, and total award",
  );
  assert.match(overlay, /event\.key\s*!==\s*["']Escape["'][\s\S]{0,260}?setSalvageConfirmationOpen\(false\)/);
  assert.doesNotMatch(overlay, /(?:window\.)?confirm\s*\(/);
  assert.match(source, /<InventoryOverlay[\s\S]{0,900}?onSalvageMany=\{[A-Za-z][A-Za-z0-9]*\}/);
  assert.match(
    css,
    /\.inventory-screen-batch-toolbar\s*\{[\s\S]{0,500}?display:\s*(?:flex|grid);/,
  );
  assert.match(css, /\.inventory-screen-grid-cell--salvage-selected\s+\.inventory-screen-grid-item\s*\{/);
  assert.match(
    css,
    /\.inventory-screen-grid-cell--salvage-mode:not\(\.inventory-screen-grid-cell--salvage-selected\)\s+\.inventory-screen-grid-item\s*\{[^}]*opacity:\s*1;[^}]*transform:\s*none;/,
    "unselected salvage candidates must not flatten their rarity effects through parent opacity or scaling",
  );
  assert.match(
    css,
    /\.inventory-screen-grid-cell--salvage-mode:not\(\.inventory-screen-grid-cell--salvage-selected\)\s+\.inventory-screen-slot-clip\s*>\s*\.inventory-screen-gear-icon\s*\{[^}]*opacity:\s*0\.5;[^}]*filter:\s*brightness\(0\.58\)\s+saturate\(0\.72\);/,
    "salvage mode should dim only the item icon while preserving rarity-identifying VFX and stacking order",
  );
  assert.doesNotMatch(
    css,
    /\.inventory-screen-grid-cell--salvage-mode:not\(\.inventory-screen-grid-cell--salvage-selected\)\s+\.inventory-screen-slot-clip\s*\{[^}]*(?:opacity|filter):/,
    "salvage mode must not turn the slot clip into a stacking context",
  );
  assert.match(
    css,
    /\.inventory-screen-grid-cell--salvage-selected\s+\.inventory-screen-grid-item\s*\{[^}]*opacity:\s*1;[^}]*filter:\s*none;[^}]*outline:\s*3px\s+solid\s+#e8694f;[^}]*scale\(1\.035\)/,
    "selected cards need a bright high-contrast lock state",
  );
  assert.match(
    css,
    /\.inventory-screen-grid-cell--salvage-selected\s+\.inventory-screen-slot-clip\s*\{[^}]*selected-corners\.png/,
    "salvage selection should reuse the inventory's painted corner treatment",
  );
  assert.match(
    css,
    /\.inventory-screen-grid-cell--salvage-mode \.inventory-screen-rarity-spectacle\s*\{[^}]*visibility:\s*visible;[^}]*animation-play-state:\s*running;/,
    "batch salvage must keep every rarity spectacle visible and animated beneath the card dimming",
  );
  assert.match(
    css,
    /\.inventory-screen-grid-cell--salvage-mode \.inventory-screen-rarity-sparkles\s*\{[^}]*opacity:\s*1;/,
    "batch salvage must preserve rare-and-higher sparkle layers",
  );
  assert.match(
    css,
    /\.inventory-screen-grid-cell--salvage-mode \.inventory-screen-rarity-aura\s*\{[^}]*opacity:\s*var\(--inventory-rarity-aura-opacity\);[^}]*animation-play-state:\s*running;/,
    "batch salvage must preserve the authored rare-and-higher animated borders",
  );
  assert.doesNotMatch(
    css,
    /\.inventory-screen-grid-cell--salvage-mode:not\(\.inventory-screen-grid-cell--salvage-selected\)\s+\.inventory-screen-grid-item\s*\{[^}]*(?:opacity:\s*0\.|scale\()/,
    "batch salvage must not dim or resample the parent that owns rarity effects",
  );
  assert.doesNotMatch(
    css,
    /\.inventory-screen-grid-cell--salvage-mode \.inventory-screen-rarity-(?:spectacle|sparkles|aura)\s*\{[^}]*(?:visibility:\s*hidden|opacity:\s*0(?:[;}])|animation-play-state:\s*paused)/,
    "batch salvage must never hide or pause a rarity-identifying visual layer",
  );
  assert.match(
    css,
    /\.inventory-screen-salvage-selection-mark\s*\{[^}]*z-index:\s*10;[^}]*pointer-events:\s*none;/,
    "the selection seal must stay visible without becoming a competing control",
  );
  assert.match(css, /@keyframes\s+inventory-salvage-card-lock\s*\{/);
  assert.match(
    css,
    /@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*?\.inventory-screen-grid-cell--salvage-selected,[\s\S]*?\.inventory-screen-salvage-selection-mark,[\s\S]*?animation:\s*none;/,
    "salvage selection feedback must honor reduced-motion preferences",
  );
  assert.match(css, /\.inventory-screen-confirm-dialog\s*\{/);
});

test("localhost inventory can grant one deterministic visual sample for every rarity", async () => {
  const [source, overlay, css] = await Promise.all([
    readFile(path.join(root, "app/GameCanvas.tsx"), "utf8"),
    readFile(path.join(root, "app/InventoryOverlay.tsx"), "utf8"),
    readFile(path.join(root, "app/game.css"), "utf8"),
  ]);

  assert.match(
    source,
    /const LOCAL_RARITY_SHOWCASE_SLOTS\s*=\s*\[\s*"boots",\s*"gloves",\s*"belt",\s*"helm",\s*"shoulders",\s*"weapon",\s*"armor",\s*"relic",?\s*\]/,
    "the eight samples should use distinct, visually representative equipment silhouettes",
  );
  assert.match(
    source,
    /const isLocalRarityShowcaseHost[\s\S]{0,240}?localhost[\s\S]{0,160}?window\.location\.hostname/,
    "the giveaway must remain restricted to a local visual-QA host",
  );
  assert.match(
    source,
    /const grantLocalRarityShowcase[\s\S]{0,260}?GEAR_RARITIES\.map\(\(rarity, index\)[\s\S]{0,380}?level:\s*Math\.max\(1, player\.level\)[\s\S]{0,160}?rarity,[\s\S]{0,160}?slot:\s*LOCAL_RARITY_SHOWCASE_SLOTS\[index\][\s\S]{0,180}?id:\s*`local-rarity-showcase-\$\{activeSaveSlotRef\.current\}-\$\{rarity\}`/,
    "the grant must force every rarity at one comparable player level with stable preview IDs",
  );
  assert.match(
    source,
    /const missingItems\s*=\s*showcaseItems\.filter\(\(item\)\s*=>\s*!ownedIds\.has\(item\.id\)\)[\s\S]{0,360}?openSlots\s*<\s*requiredSlots/,
    "repeat grants must refill only missing samples and stay atomic when capacity is short",
  );
  assert.match(
    source,
    /player\.inventory\.unshift\(\.\.\.missingItems\)[\s\S]{0,180}?setSelectedGearId\(missingItems\[0\]\.id\)[\s\S]{0,180}?setLootNotice\(missingItems\[missingItems\.length - 1\]\)/,
    "samples should appear first in the backpack while surfacing the highest newly granted treatment",
  );
  assert.match(
    source,
    /onGrantRarityShowcase=\{isLocalRarityShowcaseHost\(\) \? grantLocalRarityShowcase : undefined\}/,
  );
  assert.match(overlay, /onGrantRarityShowcase\?:\s*\(\)\s*=>\s*void;/);
  assert.match(
    overlay,
    /!salvageMode\s*&&\s*onGrantRarityShowcase[\s\S]{0,360}?inventory-screen-rarity-showcase-button[\s\S]{0,220}?8등급 견본 지급/,
    "the local grant belongs beside the backpack controls and stays out of salvage mode",
  );
  assert.match(css, /\.inventory-screen-rarity-showcase-button\s*\{[^}]*margin-left:\s*auto;/);
  assert.match(css, /\.inventory-screen-rarity-showcase-button::after\s*\{[^}]*content:\s*"✦";/);
});

test("rare and higher inventory gear uses authored animated border assets plus sparkle accents", async () => {
  const [overlay, css, tooltipChrome] = await Promise.all([
    readFile(path.join(root, "app/InventoryOverlay.tsx"), "utf8"),
    readFile(path.join(root, "app/game.css"), "utf8"),
    readFile(path.join(root, "app/InventoryTooltipChrome.tsx"), "utf8"),
  ]);
  const auraContractStart = css.lastIndexOf("Rare+ authored aura contract V3");
  assert.ok(auraContractStart >= 0, "the authoritative rare+ aura contract is missing");
  const auraCss = css.slice(auraContractStart);

  assert.match(
    overlay,
    /const SPARKLING_RARITIES[\s\S]{0,220}?new Set\(\[\s*"rare",\s*"epic",\s*"legendary",\s*"mythic",\s*"cosmic",?\s*\]\)/,
    "only rare and higher tiers should receive the continuous sparkle layer",
  );
  assert.match(
    overlay,
    /function RaritySparkles[\s\S]{0,420}?inventory-screen-rarity-sparkles--\$\{rarity\}[\s\S]{0,180}?aria-hidden=["']true["'][\s\S]{0,160}?<i \/>[\s\S]{0,80}?<i \/>[\s\S]{0,80}?<i \/>/,
    "sparkles must remain decorative and provide three independently phased glints",
  );
  assert.ok(
    [...overlay.matchAll(/<RaritySparkles rarity=\{item\.rarity\} \/>/g)].length >= 2,
    "equipped and backpack cards should share the same rarity animation",
  );
  assert.match(
    overlay,
    /function RarityAura[\s\S]{0,420}?SPARKLING_RARITIES\.has\(rarity\)[\s\S]{0,180}?inventory-screen-rarity-aura--\$\{rarity\}[\s\S]{0,100}?aria-hidden=["']true["']/,
    "rare+ gear needs a dedicated decorative raster-animation layer",
  );
  assert.equal(
    [...overlay.matchAll(/<RarityAura rarity=\{item\.rarity\} \/>/g)].length,
    2,
    "equipped and backpack cards must retain their square authored aura",
  );
  for (const rarity of ["rare", "epic", "legendary", "mythic", "cosmic"]) {
    assert.match(css, new RegExp(`\\.inventory-screen-rarity-sparkles--${rarity}\\s*\\{`));
    assert.match(
      auraCss,
      new RegExp(`\\.inventory-screen-rarity-aura--${rarity}\\s*\\{[^}]*inventory-rarity-aura-${rarity}-v3\\.png`),
      `${rarity} must use its own generated eight-frame border atlas`,
    );
  }
  assert.match(
    auraCss,
    /\.inventory-screen-rarity-aura\s*\{[\s\S]{0,760}?z-index:\s*1;[\s\S]{0,120}?inset:\s*-10%;[\s\S]{0,300}?background-size:\s*400%\s+200%;[\s\S]{0,220}?opacity:\s*var\(--inventory-rarity-aura-opacity\);[\s\S]{0,500}?animation:\s*inventory-rarity-aura-frames-v3[\s\S]{0,180}?animation-play-state:\s*running/,
    "the generated animation must stay above the base plate, below the icon, and animate while idle",
  );
  assert.match(
    auraCss,
    /\.inventory-screen-grid-item > \.inventory-screen-slot-clip,[\s\S]{0,180}?border-color:\s*transparent;/,
    "filled cards must not retain a second straight border beneath the authored frame",
  );
  assert.match(
    auraCss,
    /\.inventory-screen-rarity--rare\.inventory-screen-grid-item::before,[\s\S]{0,900}?opacity:\s*1;/,
    "rare+ cards must retain the same fixed structural atlas frame as every other rarity",
  );
  assert.doesNotMatch(
    auraCss,
    /\.inventory-screen-rarity--rare\.inventory-screen-grid-item::before,[\s\S]{0,900}?opacity:\s*0;/,
    "no rare+ rarity may disable the fixed structural frame",
  );
  assert.match(
    auraCss,
    /\.inventory-screen-rarity--rare\.inventory-screen-grid-item::after,[\s\S]{0,900}?display:\s*none;[\s\S]{0,100}?content:\s*none;/,
    "the hidden legacy pseudo-element aura must stay retired",
  );
  assert.match(css, /@keyframes\s+inventory-rarity-star-twinkle\s*\{/);
  assert.match(css, /@keyframes\s+inventory-rarity-dust-drift\s*\{/);
  assert.match(
    tooltipChrome,
    /const AURA_ATLAS_URLS[\s\S]{0,760}?rare:[\s\S]{0,100}?inventory-rarity-aura-rare-v3\.png[\s\S]{0,520}?cosmic:[\s\S]{0,100}?inventory-rarity-aura-cosmic-v3\.png/,
    "the variable tooltip frame must reuse every authored rare+ animation atlas",
  );
  assert.match(
    tooltipChrome,
    /function drawPanelChrome[\s\S]{0,2600}?drawTiledHorizontal\([\s\S]{0,1500}?drawTiledVertical\([\s\S]{0,1800}?fixedParts/,
    "tooltip animation frames must be rebuilt from fixed ornaments and native-aspect rail tiles",
  );
  assert.doesNotMatch(
    tooltipChrome,
    /drawImage\([^;]{0,500}?layout\.cell[^;]{0,500}?target\.width[^;]{0,200}?target\.height/,
    "a square rarity cell must never be stretched over the rectangular tooltip",
  );
  assert.match(
    css,
    /@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*?\.inventory-screen-rarity-sparkles::before,[\s\S]*?\.inventory-screen-rarity-sparkles > i,[\s\S]*?animation:\s*none;/,
    "the decorative loop must become static when reduced motion is requested",
  );
  assert.match(
    auraCss,
    /@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]{0,420}?\.inventory-screen-rarity-aura\s*\{[\s\S]{0,220}?background-position:\s*0%\s+0%;[\s\S]{0,160}?opacity:\s*var\(--inventory-rarity-aura-opacity\);[\s\S]{0,100}?animation:\s*none;/,
    "reduced motion must preserve a visible authored first frame",
  );
  assert.match(
    tooltipChrome,
    /matchMedia\("\(prefers-reduced-motion: reduce\)"\)[\s\S]{0,1800}?reducedMotion\.matches[\s\S]{0,500}?auraFrame = 0/,
    "the tooltip compositor must freeze on an authored frame for reduced motion",
  );
});

test("all eight inventory rarities use authored spectacle atlases without changing slot geometry", async () => {
  const rarities = ["common", "magic", "superior", "rare", "epic", "legendary", "mythic", "cosmic"];
  const assets = rarities.map((rarity) => [
    rarity,
    `public/assets/ui/inventory-rarity-spectacle-${rarity}-v4.png`,
  ]);
  const [overlay, game, css, legendaryOriginal, mythicOriginal, ...pngs] = await Promise.all([
    readFile(path.join(root, "app/InventoryOverlay.tsx"), "utf8"),
    readFile(path.join(root, "app/GameCanvas.tsx"), "utf8"),
    readFile(path.join(root, "app/game.css"), "utf8"),
    readFile(path.join(root, "public/assets/ui/inventory-legendary-aura.png")),
    readFile(path.join(root, "public/assets/ui/inventory-mythic-aura.png")),
    ...assets.map(([, assetPath]) => readFile(path.join(root, assetPath))),
  ]);
  const spectacleStart = css.lastIndexOf("All-rarity authored spectacle V4");
  assert.ok(spectacleStart >= 0, "the authoritative all-rarity spectacle contract is missing");
  const spectacleCss = css.slice(spectacleStart);

  assert.match(
    spectacleCss,
    /\.inventory-screen-rarity-spectacle\s*\{[\s\S]{0,260}?--inventory-rarity-spectacle-opacity:\s*1;[\s\S]{0,100}?--inventory-rarity-spectacle-active-opacity:\s*1;/,
    "inventory spectacles must remain fully composited while idle",
  );

  for (const [[rarity, assetPath], png] of assets.map((entry, index) => [entry, pngs[index]])) {
    const image = decodeRgbaPng(png, assetPath);
    assert.deepEqual([image.width, image.height], [1536, 768], `${assetPath} atlas dimensions drifted`);
    const frameHashes = [];
    for (let row = 0; row < 2; row += 1) {
      for (let column = 0; column < 4; column += 1) {
        const label = `${rarity} inventory spectacle row ${row} column ${column}`;
        assertAlphaCellGutter(image, column, row, 4, 2, label);
        const hash = createHash("sha256");
        for (let y = row * 384; y < (row + 1) * 384; y += 1) {
          const start = (y * image.width + column * 384) * 4;
          hash.update(image.pixels.subarray(start, start + 384 * 4));
        }
        frameHashes.push(hash.digest("hex"));
      }
    }
    assert.equal(new Set(frameHashes).size, 8, `${assetPath} must contain eight distinct frames`);
    assert.match(
      spectacleCss,
      new RegExp(`\\.inventory-screen-rarity-spectacle--${rarity}\\s*\\{[^}]*inventory-rarity-spectacle-${rarity}-v4\\.png`),
      `${rarity} must consume its dedicated spectacle atlas`,
    );
    assert.match(
      spectacleCss,
      new RegExp(`\\.inventory-screen-rarity-spectacle--${rarity}\\s*\\{[^}]*--inventory-rarity-spectacle-opacity:\\s*1;`),
      `${rarity} spectacle must be fully opaque in its CSS compositing layer`,
    );
  }

  assert.equal(
    createHash("sha256").update(pngs[5]).digest("hex"),
    createHash("sha256").update(legendaryOriginal).digest("hex"),
    "the user's original legendary flame sequence must remain byte-identical",
  );
  assert.equal(
    createHash("sha256").update(pngs[6]).digest("hex"),
    createHash("sha256").update(mythicOriginal).digest("hex"),
    "the user's original mythic astral sequence must remain byte-identical",
  );
  assert.match(
    overlay,
    /function RaritySpectacle[\s\S]{0,360}?inventory-screen-rarity-spectacle--\$\{rarity\}[\s\S]{0,120}?aria-hidden=["']true["']/,
  );
  assert.equal(
    [...overlay.matchAll(/<RaritySpectacle rarity=\{item\.rarity\} \/>/g)].length,
    2,
    "equipped and backpack paths must share the all-rarity spectacle without framing the tooltip icon",
  );
  assert.match(
    spectacleCss,
    /\.inventory-screen-rarity-spectacle\s*\{[\s\S]{0,640}?z-index:\s*1;[\s\S]{0,300}?inset:\s*-4\.545%;[\s\S]{0,300}?background-size:\s*400%\s+200%;[\s\S]{0,520}?animation:\s*inventory-rarity-spectacle-frames-v4[\s\S]{0,180}?animation-play-state:\s*running/,
    "the spectacle must animate above the base plate and below the item icon and fixed frame",
  );
  assert.match(
    spectacleCss,
    /\.inventory-screen-rarity-spectacle--legendary\s*\{[^}]*inset:\s*-10%;[\s\S]{0,220}?\.inventory-screen-rarity-spectacle--mythic\s*\{[^}]*inset:\s*-10%;/,
    "legendary and mythic 320px paint bounds must fit the 384px atlas cell to the square slot",
  );
  assert.doesNotMatch(
    spectacleCss,
    /\.inventory-screen-rarity-spectacle--(?:legendary|mythic|cosmic)\s*\{[^}]*inset:\s*-(?:2[1-9]|3\d)%/,
    "no animated rarity frame may expand beyond the square item slot",
  );
  assert.doesNotMatch(
    css,
    /inventory-screen-(?:grid-item|equipment-card):not\(:hover\)[\s\S]{0,1200}?animation-play-state:\s*paused/,
    "idle inventory cards must keep animating without hover, focus, or selection",
  );
  assert.match(spectacleCss, /\.inventory-screen-grid-cell--salvage-mode \.inventory-screen-rarity-spectacle\s*\{[^}]*visibility:\s*visible;[^}]*animation-play-state:\s*running;/);
  assert.match(game, /loot-toast-icon-stage[\s\S]{0,260}?inventory-screen-rarity-spectacle--\$\{lootNotice\.rarity\}[\s\S]{0,180}?<GearIcon item=\{lootNotice\}/);
  assert.match(spectacleCss, /\.loot-toast-icon-stage > \.loot-toast-rarity-spectacle\s*\{[^}]*z-index:\s*1;[^}]*opacity:\s*var\(--inventory-rarity-spectacle-active-opacity\);/);
  assert.match(spectacleCss, /\.loot-toast\.gear-rarity-rare::after,[\s\S]{0,900}?animation:\s*loot-toast-rarity-sweep/);
  assert.match(spectacleCss, /@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]{0,320}?\.inventory-screen-rarity-spectacle\s*\{[^}]*animation:\s*none;/);
});

test("inventory paperdoll keeps ten square side slots and normalizes frame and aura bounds", async () => {
  const [equipment, overlay, css, tooltipChrome] = await Promise.all([
    readFile(path.join(root, "app/equipment.ts"), "utf8"),
    readFile(path.join(root, "app/InventoryOverlay.tsx"), "utf8"),
    readFile(path.join(root, "app/game.css"), "utf8"),
    readFile(path.join(root, "app/InventoryTooltipChrome.tsx"), "utf8"),
  ]);
  const contractStart = css.lastIndexOf("Inventory geometry contract V3");
  assert.ok(contractStart >= 0, "the final inventory cascade contract is missing");
  const finalCss = css.slice(contractStart);

  assert.match(
    equipment,
    /EQUIPMENT_SLOTS\s*=\s*\[\s*"weapon",\s*"offhand",\s*"helm",\s*"shoulders",\s*"armor",\s*"gloves",\s*"belt",\s*"legs",\s*"boots",\s*"relic",?\s*\]/,
  );
  assert.match(overlay, /<InventoryPaperdollFigure equipment=\{equipment\} \/>/);
  assert.match(
    overlay,
    /inventory-screen-equipment-card[\s\S]{0,1800}?inventory-screen-slot-clip[\s\S]{0,300}?<GearIcon/,
    "equipped icons must render inside the internal clipping layer",
  );
  const backpackCardStart = overlay.indexOf("className={`inventory-screen-grid-item");
  assert.ok(backpackCardStart >= 0, "backpack item cards are missing");
  assert.match(
    overlay.slice(backpackCardStart, backpackCardStart + 2400),
    /inventory-screen-slot-clip[\s\S]{0,180}?<GearIcon/,
    "backpack icons must render inside the same clipping contract",
  );

  for (const [slot, column, row] of [
    ["helm", 1, 1], ["relic", 3, 1],
    ["shoulders", 1, 2], ["offhand", 3, 2],
    ["armor", 1, 3], ["weapon", 3, 3],
    ["gloves", 1, 4], ["legs", 3, 4],
    ["belt", 1, 5], ["boots", 3, 5],
  ]) {
    assert.match(
      finalCss,
      new RegExp(`\\.inventory-screen-equipment-card--${slot}\\s*\\{\\s*grid-column:\\s*${column};\\s*grid-row:\\s*${row};\\s*\\}`),
      `${slot} must stay outside the center silhouette`,
    );
  }
  assert.match(finalCss, /\.inventory-screen-paperdoll-figure\s*\{[\s\S]{0,420}?grid-column:\s*2;[\s\S]{0,120}?grid-row:\s*1\s*\/\s*-1;/);
  assert.match(finalCss, /--inventory-paperdoll-slot-cap:\s*76px;/);
  assert.match(finalCss, /--inventory-paperdoll-aura-safe:\s*32px;/);
  assert.match(finalCss, /grid-template-rows:\s*repeat\(5,\s*minmax\(0,\s*1fr\)\);/);
  assert.match(finalCss, /--inventory-paperdoll-row-spread:\s*clamp\(3px,\s*0\.65cqh,\s*5px\);/);
  assert.match(finalCss, /--inventory-paperdoll-row-spread-double:\s*clamp\(6px,\s*1\.3cqh,\s*10px\);/);
  assert.match(
    finalCss,
    /@container game-viewport \(min-width:\s*901px\)[\s\S]{0,900}?equipment-card--helm,[\s\S]{0,120}?equipment-card--relic\s*\{[^}]*translate:\s*0\s+calc\(0px\s*-\s*var\(--inventory-paperdoll-row-spread-double\)\);[\s\S]{0,700}?equipment-card--belt,[\s\S]{0,120}?equipment-card--boots\s*\{[^}]*translate:\s*0\s+var\(--inventory-paperdoll-row-spread-double\);/,
    "desktop paperdoll rows must spread symmetrically into the available top and bottom room",
  );
  assert.match(finalCss, /padding-block:\s*var\(--inventory-paperdoll-aura-safe\);/);
  assert.match(finalCss, /height:\s*auto;[\s\S]{0,120}?align-self:\s*stretch;/);
  assert.match(
    finalCss,
    /\.inventory-screen-equipment-card\s*\{[\s\S]{0,520}?width:\s*auto;[\s\S]{0,100}?height:\s*100%;[\s\S]{0,160}?max-width:\s*var\(--inventory-paperdoll-slot-cap\);[\s\S]{0,160}?aspect-ratio:\s*1;/,
  );
  assert.match(finalCss, /@container game-viewport \(max-width:\s*1240px\)[\s\S]{0,1100}?--inventory-paperdoll-slot-cap:\s*66px;[\s\S]{0,120}?--inventory-paperdoll-aura-safe:\s*30px;/);
  assert.match(
    finalCss,
    /@container game-viewport \(min-height:\s*681px\) and \(max-height:\s*800px\) and \(min-width:\s*901px\)\s*\{[\s\S]{0,480}?\.inventory-screen-layout\s*\{[^}]*overflow-y:\s*auto;[^}]*scrollbar-gutter:\s*stable;[\s\S]{0,260}?\.inventory-screen-left-column\s*\{[^}]*grid-template-rows:\s*440px\s+270px;[^}]*min-height:\s*720px;[\s\S]{0,180}?\.inventory-screen-backpack\s*\{[^}]*min-height:\s*720px;[\s\S]{0,260}?--inventory-paperdoll-slot-cap:\s*58px;[\s\S]{0,120}?--inventory-paperdoll-aura-safe:\s*28px;[\s\S]{0,160}?--inventory-paperdoll-row-spread:\s*0px;[\s\S]{0,120}?--inventory-paperdoll-row-spread-double:\s*0px;/,
    "low desktop armories must scroll the chrome instead of shrinking equipped items below 58px",
  );
  assert.doesNotMatch(
    finalCss,
    /grid-template-rows:\s*repeat\(5,\s*var\(--inventory-paperdoll-slot-size\)\)/,
    "paperdoll rows must fit the real equipment track instead of overflowing a viewport-sized minimum",
  );
  assert.doesNotMatch(
    finalCss.slice(0, finalCss.indexOf("/* rarity-frames.png")),
    /--inventory-paperdoll-slot-(?:cap|size):[^;\n]*cq[wh]/,
    "slot caps must not resolve differently between the size container and its children",
  );
  assert.match(finalCss, /\.inventory-screen-equipment-card\s*\{[\s\S]{0,420}?overflow:\s*visible;/);
  assert.match(
    finalCss,
    /\.inventory-screen-equipment-card\s*\{[\s\S]{0,120}?isolation:\s*isolate;/,
    "each equipped card must keep its visual layers in one local stacking context",
  );
  assert.match(
    finalCss,
    /\.inventory-screen-grid-item\s*\{[\s\S]{0,100}?isolation:\s*isolate;/,
    "each backpack card must keep its visual layers in one local stacking context",
  );
  assert.match(
    finalCss,
    /\.inventory-screen-slot-clip\s*\{[\s\S]{0,260}?z-index:\s*auto;[\s\S]{0,220}?overflow:\s*hidden;/,
    "the dark slot plate must not form a z2 rectangle over the animated effects",
  );
  assert.match(
    finalCss,
    /\.inventory-screen-slot-clip > \.inventory-screen-gear-icon\s*\{[^}]*position:\s*relative;[^}]*z-index:\s*2;/,
    "the clipped item icon must remain above the z1 spectacle",
  );
  assert.match(
    finalCss,
    /\.inventory-screen-rarity-aura\s*\{[\s\S]{0,760}?z-index:\s*1;/,
    "the animated aura must remain above the base plate and below the item icon",
  );
  assert.match(finalCss, /Full names belong in the workbench[\s\S]{0,260}?\.inventory-screen-grid-name\s*\{\s*display:\s*none;/);
  const slotFrameContract = finalCss.slice(
    finalCss.indexOf("Fixed structural slot-frame contract V6"),
    finalCss.indexOf("Both equipped and backpack cards remain true squares"),
  );
  assert.match(slotFrameContract, /\.inventory-screen-equipment-card:not\([\s\S]{0,160}?\.inventory-screen-grid-item::before[\s\S]{0,520}?rarity-frames-v6\.png[\s\S]{0,180}?background-size:\s*800%\s+100%;/);
  assert.doesNotMatch(
    slotFrameContract,
    /inventory-screen-tooltip-crest/,
    "the square slot frame must never be attached to the tooltip item icon",
  );
  assert.match(
    overlay,
    /<InventoryTooltipChrome rarity=\{item\.rarity\} \/>[\s\S]{0,160}?inventory-screen-tooltip-crest[\s\S]{0,120}?<GearIcon item=\{item\} size=\{88\} \/>/,
    "the rarity frame belongs to the tooltip boundary while the crest contains only the item",
  );
  const tooltipCrestMarkup = overlay.slice(
    overlay.indexOf('<div className="inventory-screen-tooltip-crest"'),
    overlay.indexOf('<div className="inventory-screen-tooltip-scroll"'),
  );
  assert.doesNotMatch(tooltipCrestMarkup, /Rarity(?:Spectacle|Aura|Sparkles)/);
  assert.match(finalCss, /\.inventory-screen-tooltip-crest::before\s*\{[\s\S]{0,180}?border:\s*0;[\s\S]{0,420}?transparent\s+68%[\s\S]{0,100}?box-shadow:\s*none;/);
  assert.match(finalCss, /Animated aura atlases:[\s\S]{0,650}?inset:\s*-10%;[\s\S]{0,180}?background-size:\s*400%\s+200%;/);
  assert.match(
    finalCss,
    /Tooltip rarity panel compositor V1[\s\S]{0,900}?\.inventory-screen-tooltip > \.inventory-screen-tooltip-chrome\s*\{[\s\S]{0,180}?position:\s*absolute;[\s\S]{0,120}?z-index:\s*3;[\s\S]{0,120}?inset:\s*-26px;[\s\S]{0,180}?width:\s*calc\(100% \+ 52px\);[\s\S]{0,120}?height:\s*calc\(100% \+ 52px\);/,
    "the rarity compositor canvas must follow all four outer tooltip edges",
  );
  assert.match(
    finalCss,
    /\.inventory-screen-tooltip > \.inventory-screen-tooltip-chrome\s*\{[\s\S]{0,240}?--inventory-tooltip-chrome-safe-inline:\s*44px;[\s\S]{0,100}?--inventory-tooltip-chrome-safe-top:\s*44px;[\s\S]{0,100}?--inventory-tooltip-chrome-safe-bottom:\s*39px;[\s\S]{0,900}?-webkit-mask:[\s\S]{0,500}?top\s*\/\s*100%\s+var\(--inventory-tooltip-chrome-safe-top\)[\s\S]{0,500}?bottom\s*\/\s*100%\s+var\(--inventory-tooltip-chrome-safe-bottom\)[\s\S]{0,500}?left\s*\/\s*var\(--inventory-tooltip-chrome-safe-inline\)\s+100%[\s\S]{0,500}?right\s*\/\s*var\(--inventory-tooltip-chrome-safe-inline\)\s+100%/,
    "the filtered rarity frame must remain outside the complete tooltip text rectangle",
  );
  assert.match(tooltipChrome, /data-frame-layout="fixed-corners-tiled-rails-cardinal-crests"/);
  assert.match(tooltipChrome, /new ResizeObserver\(render\)[\s\S]{0,120}?resizeObserver\.observe\(canvas\)/);
  assert.match(finalCss, /\.inventory-screen-tooltip::before,[\s\S]{0,100}?\.inventory-screen-tooltip::after,[\s\S]{0,100}?\.inventory-screen-tooltip-crest::after\s*\{[\s\S]{0,120}?display:\s*none;[\s\S]{0,100}?content:\s*none;/);
  assert.doesNotMatch(
    finalCss.slice(finalCss.indexOf("Tooltip rarity panel compositor V1")),
    /gothic-nine-slice-frame-v2|background-size:\s*100%\s+100%/,
    "the final tooltip contract must not fall back to generic or stretched square chrome",
  );
  assert.match(finalCss, /@container game-viewport \(max-width:\s*900px\)[\s\S]{0,1200}?\.inventory-screen-details\s*\{\s*display:\s*none;/);
});

test("the explicit level curve accelerates both absolute and relative XP requirements late-game", async () => {
  const [progression, source] = await Promise.all([
    importTypeScriptModule("app/progression.ts"),
    readFile(path.join(root, "app/GameCanvas.tsx"), "utf8"),
  ]);
  assert.equal(typeof progression.experienceRequiredForLevel, "function");
  const thresholds = Array.from(
    { length: 80 },
    (_, index) => progression.experienceRequiredForLevel(index + 1),
  );
  thresholds.forEach((value, index) => {
    assert.ok(Number.isFinite(value) && value > 0, `level ${index + 1} XP is invalid`);
    if (index > 0) {
      assert.ok(value > thresholds[index - 1], `level ${index + 1} XP must increase`);
    }
  });

  const earlyDelta = thresholds[9] - thresholds[8];
  const midDelta = thresholds[39] - thresholds[38];
  const lateDelta = thresholds[69] - thresholds[68];
  assert.ok(midDelta > earlyDelta, "mid-game XP increments must exceed early increments");
  assert.ok(lateDelta > midDelta, "late-game XP increments must exceed mid-game increments");

  const earlyTenLevelRatio = thresholds[19] / thresholds[9];
  const lateTenLevelRatio = thresholds[69] / thresholds[59];
  assert.ok(
    lateTenLevelRatio > earlyTenLevelRatio,
    `late-game XP ratio ${lateTenLevelRatio.toFixed(3)} must exceed early ratio ${earlyTenLevelRatio.toFixed(3)}`,
  );
  assert.deepEqual(
    [1, 10, 30, 60, 80].map((level) => progression.experienceRequiredForLevel(level)),
    [thresholds[0], thresholds[9], thresholds[29], thresholds[59], thresholds[79]],
  );
  assert.match(
    source,
    /import \{ experienceRequiredForLevel \} from ["']\.\/progression["'];/,
  );
  assert.match(source, /const xpThreshold = experienceRequiredForLevel;/);
  assert.match(source, /nextXp:\s*xpThreshold\(1\),/);
  assert.match(
    source,
    /player\.nextXp = xpThreshold\(player\.level\)/,
  );
  assert.match(
    source,
    /playerRef\.current\.nextXp[\s\S]{0,220}?xpThreshold\(playerRef\.current\.level\)/,
    "save restoration must reconcile old thresholds with the current curve",
  );
});

test("all eight field-loot atlases are safe, unique, lightweight, and finite", async () => {
  const rarities = ["common", "magic", "superior", "rare", "epic", "legendary", "mythic", "cosmic"];
  const assets = rarities.map((rarity) => [
    rarity,
    `public/assets/effects/loot-awakening-${rarity}-v5.png`,
  ]);
  const [source, ...pngs] = await Promise.all([
    readFile(path.join(root, "app/GameCanvas.tsx"), "utf8"),
    ...assets.map(([, assetPath]) => readFile(path.join(root, assetPath))),
  ]);

  const rarityAlphaSupportHashes = [];
  for (const [[rarity, assetPath], png] of assets.map((entry, index) => [entry, pngs[index]])) {
    assert.ok(png.byteLength < 1_250_000, `${assetPath} exceeds the field VFX decode budget`);
    const image = decodeRgbaPng(png, assetPath);
    assert.deepEqual([image.width, image.height], [1024, 512], `${assetPath} must be a lightweight 4x2 atlas`);
    const atlasAlphaSupport = new Uint8Array(image.width * image.height);
    for (let pixel = 0; pixel < atlasAlphaSupport.length; pixel += 1) {
      atlasAlphaSupport[pixel] = image.pixels[pixel * 4 + 3] >= 8 ? 1 : 0;
    }
    rarityAlphaSupportHashes.push(createHash("sha256").update(atlasAlphaSupport).digest("hex"));

    const frameAlphaSupportHashes = [];
    const frameOccupancies = [];
    for (let row = 0; row < 2; row += 1) {
      for (let column = 0; column < 4; column += 1) {
        const label = `${rarity} field awakening row ${row} column ${column}`;
        const metrics = alphaCellMetrics(image, column, row, 4, 2, label);
        frameOccupancies.push(metrics.opaquePixels);
        assert.ok(metrics.left >= 10, `${label} needs a safe left gutter`);
        assert.ok(metrics.right >= 10, `${label} needs a safe right gutter`);
        assert.ok(metrics.top >= 10, `${label} needs a safe top gutter`);
        assert.ok(metrics.bottom >= 10, `${label} needs a safe bottom gutter`);
        if (rarity === "cosmic" && row === 0) {
          assert.ok(
            metrics.bottom >= 24,
            `${label} must not retain lower-row cyan beam fragments`,
          );
        }
        const support = new Uint8Array(256 * 256);
        let supportOffset = 0;
        for (let y = row * 256; y < (row + 1) * 256; y += 1) {
          for (let x = column * 256; x < (column + 1) * 256; x += 1) {
            support[supportOffset] = image.pixels[(y * image.width + x) * 4 + 3] >= 8 ? 1 : 0;
            supportOffset += 1;
          }
        }
        const hash = createHash("sha256");
        hash.update(support);
        frameAlphaSupportHashes.push(hash.digest("hex"));
      }
    }
    assert.equal(
      new Set(frameAlphaSupportHashes).size,
      8,
      `${assetPath} must contain eight distinct alpha-silhouette animation frames`,
    );
    assert.ok(
      Math.max(...frameOccupancies) / Math.min(...frameOccupancies) > 2,
      `${assetPath} must preserve the authored seed-to-climax size progression`,
    );
  }
  assert.equal(
    new Set(rarityAlphaSupportHashes).size,
    rarities.length,
    "all eight rarities must use genuinely different field silhouettes, not recolors",
  );

  assert.match(source, /const EQUIPMENT_RARITY_VFX:[\s\S]{0,120}?Record<GearItem\["rarity"\], EquipmentRarityVfxConfig>/);
  assert.match(source, /cosmic:\s*\{[\s\S]{0,300}?beamHeight:\s*296,[\s\S]{0,80}?beamWidth:\s*42,/);
  const arrivalStart = source.indexOf("const drawLootAwakening = (");
  const arrivalEnd = source.indexOf("const drawProofreaderTelegraph = (", arrivalStart);
  assert.ok(arrivalStart >= 0 && arrivalEnd > arrivalStart, "the V5 arrival renderer is missing");
  const arrivalRenderer = source.slice(arrivalStart, arrivalEnd);
  assert.match(arrivalRenderer, /const frameIndex = clamp\(Math\.floor\(progress \* 8\), 0, 7\);/);
  assert.match(arrivalRenderer, /const sourceWidth = image\.naturalWidth \/ 4;/);
  assert.match(arrivalRenderer, /const sourceHeight = image\.naturalHeight \/ 2;/);
  assert.match(arrivalRenderer, /const config = EQUIPMENT_RARITY_VFX\[rarity\];/);
  assert.match(arrivalRenderer, /config\.arrivalPattern/);
  assert.match(arrivalRenderer, /context\.drawImage\(\s*image,\s*column \* sourceWidth,\s*row \* sourceHeight,/);
});

const PERSISTENT_PILLAR_HEIGHTS = {
  common: 96,
  magic: 108,
  superior: 124,
  rare: 146,
  epic: 174,
  legendary: 216,
  mythic: 274,
  cosmic: 344,
};

const PERSISTENT_PILLAR_GROUND_OFFSETS = {
  common: 4,
  magic: 3,
  superior: 2,
  rare: 1,
  epic: 0,
  legendary: 0,
  mythic: 0,
  cosmic: 0,
};

test("persistent loot-pillar V3 atlases are bright, rarity-correct, transparent four-frame loops", async () => {
  const rarities = ["common", "magic", "superior", "rare", "epic", "legendary", "mythic", "cosmic"];
  const manifestPath = "asset-sources/legacy-arpg/loot-pillar-v3/output/loot-pillar-v3.build.json";
  const builderPath = "scripts/build_loot_pillar_v3_assets.py";
  const [manifestText, builder, ...assetBuffers] = await Promise.all([
    readFile(path.join(root, manifestPath), "utf8"),
    readFile(path.join(root, builderPath), "utf8"),
    ...rarities.map((rarity) =>
      readFile(path.join(root, `asset-sources/legacy-arpg/loot-pillar-v3/output/loot-pillar-${rarity}-v3.png`)),
    ),
  ]);
  const manifest = JSON.parse(manifestText);

  assert.equal(manifest.version, 3);
  assert.equal(manifest.builder, builderPath);
  assert.deepEqual(manifest.atlas, {
    columns: 4,
    rows: 1,
    cell: [256, 512],
  });
  assert.deepEqual(manifest.pipeline.alphaLevels, [0, 64, 128, 192, 255]);
  assert.deepEqual(manifest.pipeline.logicalCell, [128, 256]);
  assert.equal(manifest.pipeline.anchor, "measured-lower-flare-centre");
  assert.ok(manifest.pipeline.rgbGamma < 1, "V3 needs a baked mid-tone lift");
  assert.ok(manifest.pipeline.alphaGamma < 1, "V3 needs a baked glow-opacity lift");
  assert.ok(
    Math.max(...manifest.pipeline.frameFlashGains) >= 1.2,
    "V3 needs an authored flash peak",
  );
  assert.match(builder, /SOURCE_MAP\s*=\s*\{/);
  assert.match(
    builder,
    /"rare":\s*\(SOURCE_ROOT\s*\/\s*"rare-gold-source-contracted\.png",\s*0,\s*1,\s*"gold"\)/,
  );
  assert.match(
    builder,
    /"epic":\s*\(LEGACY_SOURCE_ROOT\s*\/\s*"low-rarities-source\.png",\s*3,\s*4,\s*"violet"\)/,
  );
  assert.match(builder, /CELL_WIDTH\s*=\s*256/);
  assert.match(builder, /CELL_HEIGHT\s*=\s*512/);
  assert.match(
    builder,
    /target_width\s*=\s*min\([\s\S]{0,140}?motif\s*=\s*motif\.resize\(\(target_width, max_height\),/,
  );
  assert.match(builder, /Image\.Resampling\.NEAREST/);
  assert.match(builder, /ALPHA_LEVELS\s*=\s*np\.array\(\(0, 64, 128, 192, 255\)/);

  const expectedSources = {
    common: ["asset-sources/legacy-arpg/loot-pillar-v2/low-rarities-source.png", 0, "ivory"],
    magic: ["asset-sources/legacy-arpg/loot-pillar-v2/low-rarities-source.png", 1, "blue"],
    superior: ["asset-sources/legacy-arpg/loot-pillar-v2/low-rarities-source.png", 2, "green"],
    rare: ["asset-sources/legacy-arpg/loot-pillar-v3/rare-gold-source-contracted.png", 0, "gold"],
    epic: ["asset-sources/legacy-arpg/loot-pillar-v2/low-rarities-source.png", 3, "violet"],
    legendary: ["asset-sources/legacy-arpg/loot-pillar-v2/high-rarities-source.png", 1, "orange"],
    mythic: ["asset-sources/legacy-arpg/loot-pillar-v2/high-rarities-source.png", 2, "magenta"],
    cosmic: ["asset-sources/legacy-arpg/loot-pillar-v2/high-rarities-source.png", 3, "prismatic"],
  };
  assert.equal(manifest.imagegen.tool, "built-in imagegen");
  for (const stage of ["original", "chroma", "alphaFirstPass", "alphaProductionSource"]) {
    const record = manifest.imagegen.outputs[stage];
    const bytes = await readFile(path.join(root, record.path));
    assert.equal(
      createHash("sha256").update(bytes).digest("hex"),
      record.sha256,
      `ImageGen ${stage} provenance must remain reproducible`,
    );
  }
  assert.equal(
    manifest.imagegen.outputs.alphaProductionSource.sha256,
    manifest.sources[expectedSources.rare[0]].sha256,
  );

  const raritySupportHashes = [];
  const meanRgbByRarity = {};
  const adjustedTailByRarity = {};
  const adjustedFrameTailsByRarity = {};
  for (const [index, rarity] of rarities.entries()) {
    const assetPath = `asset-sources/legacy-arpg/loot-pillar-v3/output/loot-pillar-${rarity}-v3.png`;
    const [sourcePath, sourceRow, colourFamily] = expectedSources[rarity];
    const png = assetBuffers[index];
    assert.ok(png.byteLength <= 750_000, `${assetPath} exceeds the 750 KB decode budget`);
    await readFile(path.join(root, sourcePath));

    const image = decodeRgbaPng(png, assetPath);
    assert.deepEqual([image.width, image.height], [1024, 512], `${assetPath} must be a portrait-cell 4x1 atlas`);
    const frameHashes = [];
    const atlasSupport = new Uint8Array(image.width * image.height);
    const alphaLevels = new Set();
    let transparentRgbLeak = 0;
    for (let pixel = 0; pixel < atlasSupport.length; pixel += 1) {
      const alpha = image.pixels[pixel * 4 + 3];
      alphaLevels.add(alpha);
      atlasSupport[pixel] = alpha >= 64 ? 1 : 0;
      if (
        alpha === 0 &&
        (image.pixels[pixel * 4] !== 0 ||
          image.pixels[pixel * 4 + 1] !== 0 ||
          image.pixels[pixel * 4 + 2] !== 0)
      ) {
        transparentRgbLeak += 1;
      }
    }
    assert.deepEqual([...alphaLevels].sort((a, b) => a - b), [0, 64, 128, 192, 255]);
    assert.equal(transparentRgbLeak, 0, `${assetPath} must not retain hidden chroma RGB`);
    raritySupportHashes.push(createHash("sha256").update(atlasSupport).digest("hex"));

    for (let column = 0; column < 4; column += 1) {
      const label = `${rarity} persistent pillar frame ${column}`;
      const metrics = alphaCellMetrics(image, column, 0, 4, 1, label);
      assert.ok(metrics.left >= 8, `${label} needs a safe left gutter`);
      assert.ok(metrics.right >= 8, `${label} needs a safe right gutter`);
      assert.ok(metrics.top >= 8, `${label} needs a safe top gutter`);
      assert.ok(metrics.bottom >= 8, `${label} needs a safe bottom gutter`);
      assert.ok(metrics.height >= 480, `${label} must remain a tall beacon, not ground clutter`);

      const support = new Uint8Array(256 * 512);
      let supportOffset = 0;
      let brightPixels = 0;
      for (let y = 0; y < 512; y += 1) {
        for (let x = column * 256; x < (column + 1) * 256; x += 1) {
          const offset = (y * image.width + x) * 4;
          const alpha = image.pixels[offset + 3];
          support[supportOffset] = alpha >= 64 ? 1 : 0;
          const luminance =
            image.pixels[offset] * 0.299 +
            image.pixels[offset + 1] * 0.587 +
            image.pixels[offset + 2] * 0.114;
          if (alpha >= 64 && luminance >= 205) brightPixels += 1;
          supportOffset += 1;
        }
      }
      assert.ok(brightPixels >= 240, `${label} needs a white-hot light core`);
      frameHashes.push(createHash("sha256").update(support).digest("hex"));
    }
    assert.equal(new Set(frameHashes).size, 4, `${assetPath} needs four unique loop frames`);

    const record = manifest.rarities[rarity];
    assert.equal(record.source, sourcePath);
    assert.equal(record.sourceRow, sourceRow);
    assert.equal(record.colourFamily, colourFamily);
    assert.equal(record.output, assetPath);
    assert.equal(record.bytes, png.byteLength);
    assert.equal(record.frames.length, 4);
    assert.ok(record.frames.every((frame) => frame.bbox[3] - frame.bbox[1] >= 480));
    assert.ok(record.frames.every((frame) => frame.brightPixelRatio >= 0.12));
    assert.ok(record.frames.some((frame) => frame.brightPixelRatio >= 0.2));
    assert.equal(
      record.groundAnchor,
      Math.round(
        record.frames
          .map((frame) => frame.flareY)
          .sort((a, b) => a - b)
          .slice(1, 3)
          .reduce((sum, value) => sum + value, 0) / 2 / 512 * 10_000,
      ) / 10_000,
    );
    const q99Rows = [];
    for (let column = 0; column < 4; column += 1) {
      const rowEnergies = [];
      for (let y = 256; y < 512; y += 1) {
        let energy = 0;
        for (let x = column * 256; x < (column + 1) * 256; x += 1) {
          const offset = (y * image.width + x) * 4;
          const luminance =
            image.pixels[offset] * 0.299 +
            image.pixels[offset + 1] * 0.587 +
            image.pixels[offset + 2] * 0.114;
          energy += luminance * image.pixels[offset + 3];
        }
        rowEnergies.push(energy);
      }
      const targetEnergy = rowEnergies.reduce((sum, value) => sum + value, 0) * 0.99;
      let cumulativeEnergy = 0;
      let q99Y = 511;
      for (let index = 0; index < rowEnergies.length; index += 1) {
        cumulativeEnergy += rowEnergies[index];
        if (cumulativeEnergy >= targetEnergy) {
          q99Y = 256 + index;
          break;
        }
      }
      q99Rows.push(q99Y);
    }
    adjustedFrameTailsByRarity[rarity] = q99Rows.map(
      (q99Y) =>
        ((q99Y - record.groundAnchor * 512) * PERSISTENT_PILLAR_HEIGHTS[rarity]) /
          512 +
        PERSISTENT_PILLAR_GROUND_OFFSETS[rarity],
    );
    adjustedTailByRarity[rarity] =
      adjustedFrameTailsByRarity[rarity].reduce((sum, value) => sum + value, 0) /
      adjustedFrameTailsByRarity[rarity].length;
    meanRgbByRarity[rarity] = record.frames
      .reduce(
        (sum, frame) => sum.map((value, channel) => value + frame.meanRgb[channel]),
        [0, 0, 0],
      )
      .map((value) => value / record.frames.length);
  }
  assert.equal(
    new Set(raritySupportHashes).size,
    rarities.length,
    "persistent pillar loops must use eight genuinely distinct silhouettes",
  );
  const [rareRed, rareGreen, rareBlue] = meanRgbByRarity.rare;
  assert.ok(
    rareRed > rareGreen && rareGreen > rareBlue * 1.25 && rareRed > rareBlue * 1.7,
    "rare must read as saturated gold/yellow",
  );
  const [epicRed, epicGreen, epicBlue] = meanRgbByRarity.epic;
  assert.ok(
    epicBlue > epicRed && epicRed > epicGreen * 1.65,
    "epic must inherit the former rare violet pillar",
  );
  const epicTail = adjustedTailByRarity.epic;
  for (const rarity of ["common", "magic", "superior", "rare"]) {
    assert.ok(
      Math.abs(adjustedTailByRarity[rarity] - epicTail) <= 0.25,
      `${rarity} lower glow tail must align with the unchanged epic baseline`,
    );
    assert.ok(
      adjustedFrameTailsByRarity[rarity].every(
        (tail) => Math.abs(tail - epicTail) <= 1.5,
      ),
      `${rarity} must stay close to the epic baseline in every animation frame`,
    );
  }
});

test("epic persistent pillar V4 preserves ImageGen provenance, safe headroom, and tapered tips", async () => {
  const generatedPath = "asset-sources/imagegen/loot-pillar-epic-v4-source.png";
  const keyedPath = "asset-sources/imagegen/loot-pillar-epic-v4-keyed.png";
  const promptPath = "asset-sources/imagegen/loot-pillar-epic-v4.prompt.json";
  const builderPath = "scripts/build_loot_pillar_epic_v4.py";
  const assetPath = "public/assets/effects/loot-pillar-epic-v4.png";
  const manifestPath = "public/assets/effects/loot-pillar-epic-v4.build.json";
  const [generated, keyed, promptBytes, builder, png, manifestText] =
    await Promise.all([
      readFile(path.join(root, generatedPath)),
      readFile(path.join(root, keyedPath)),
      readFile(path.join(root, promptPath)),
      readFile(path.join(root, builderPath), "utf8"),
      readFile(path.join(root, assetPath)),
      readFile(path.join(root, manifestPath), "utf8"),
    ]);
  const promptMetadata = JSON.parse(promptBytes.toString("utf8"));
  const manifest = JSON.parse(manifestText);
  const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

  assert.equal(manifest.version, 4);
  assert.equal(manifest.builder, builderPath);
  assert.equal(manifest.format, "rgba-png");
  assert.deepEqual(manifest.atlas, {
    columns: 4,
    rows: 1,
    cell: [256, 512],
    size: [1024, 512],
  });
  assert.deepEqual(
    {
      generated: manifest.source.generated.path,
      keyed: manifest.source.keyed.path,
      prompt: manifest.source.promptMetadata.path,
    },
    { generated: generatedPath, keyed: keyedPath, prompt: promptPath },
    "epic V4 must retain all checked-in ImageGen provenance paths",
  );
  for (const [label, record, bytes] of [
    ["generated", manifest.source.generated, generated],
    ["keyed", manifest.source.keyed, keyed],
    ["prompt metadata", manifest.source.promptMetadata, promptBytes],
  ]) {
    assert.equal(record.sha256, sha256(bytes), `epic V4 ${label} provenance hash drifted`);
  }
  const promptText = JSON.stringify(promptMetadata);
  assert.match(promptText, /(?:purple|violet)/i, "epic V4 prompt must preserve its violet identity");
  assert.match(promptText, /(?:four|4)[^]{0,80}(?:frame|cell)|(?:frame|cell)[^]{0,80}(?:four|4)/i);
  assert.match(promptText, /(?:clip|crop|headroom|gutter|padding)/i);

  assert.match(builder, /loot-pillar-epic-v4-source\.png/);
  assert.match(builder, /loot-pillar-epic-v4-keyed\.png/);
  assert.match(builder, /loot-pillar-epic-v4\.prompt\.json/);
  assert.match(builder, /loot-pillar-epic-v4\.png/);
  assert.match(builder, /loot-pillar-epic-v4\.build\.json/);
  assert.match(builder, /VISIBLE_ALPHA_THRESHOLD\s*=\s*64|visibleAlphaThreshold/);
  assert.match(builder, /TARGET_FLARE_Y\s*=\s*475|targetFlareY/);

  assert.equal(manifest.output.path, assetPath);
  assert.equal(manifest.output.bytes, png.byteLength);
  assert.equal(manifest.output.sha256, sha256(png));
  assert.equal(manifest.output.transparentRgbLeak, 0);
  const expectedGroundAnchor = Math.round((475 / 512) * 10_000) / 10_000;
  assert.equal(expectedGroundAnchor, 0.9277);
  assert.equal(manifest.output.groundAnchor, expectedGroundAnchor);
  assert.equal(manifest.frames.length, 4);

  const image = decodeRgbaPng(png, assetPath);
  assert.deepEqual([image.width, image.height], [1024, 512]);
  let transparentRgbLeak = 0;
  for (let offset = 0; offset < image.pixels.length; offset += 4) {
    if (
      image.pixels[offset + 3] === 0 &&
      (image.pixels[offset] !== 0 ||
        image.pixels[offset + 1] !== 0 ||
        image.pixels[offset + 2] !== 0)
    ) {
      transparentRgbLeak += 1;
    }
  }
  assert.equal(transparentRgbLeak, 0, "epic V4 must not retain RGB under zero alpha");

  const frameHashes = [];
  for (let column = 0; column < 4; column += 1) {
    const label = `epic V4 persistent pillar frame ${column}`;
    const cellLeft = column * 256;
    const rowRuns = [];
    let firstVisibleY = -1;
    let lastVisibleY = -1;
    let firstVisibleX = 256;
    let lastVisibleX = -1;
    let visiblePixels = 0;
    let brightPixels = 0;
    let whiteCorePixels = 0;
    let purplePixels = 0;
    const rowEnergy = new Float64Array(512);

    for (let y = 0; y < 512; y += 1) {
      let currentRun = 0;
      let maximumRun = 0;
      for (let localX = 0; localX < 256; localX += 1) {
        const offset = (y * image.width + cellLeft + localX) * 4;
        const red = image.pixels[offset];
        const green = image.pixels[offset + 1];
        const blue = image.pixels[offset + 2];
        const alpha = image.pixels[offset + 3];
        if (alpha < 64) {
          currentRun = 0;
          continue;
        }
        currentRun += 1;
        maximumRun = Math.max(maximumRun, currentRun);
        visiblePixels += 1;
        if (firstVisibleY < 0) firstVisibleY = y;
        lastVisibleY = y;
        firstVisibleX = Math.min(firstVisibleX, localX);
        lastVisibleX = Math.max(lastVisibleX, localX);
        const luminance = red * 0.299 + green * 0.587 + blue * 0.114;
        rowEnergy[y] += luminance * alpha;
        if (luminance >= 205) brightPixels += 1;
        const { hue, saturation, value } = rgbToHsv(red, green, blue);
        if (saturation <= 0.18 && value >= 0.82) whiteCorePixels += 1;
        if (hue >= 255 && hue <= 325 && saturation >= 0.25 && value >= 0.3) {
          purplePixels += 1;
        }
      }
      rowRuns.push(maximumRun);
    }

    assert.ok(visiblePixels >= 100, `${label} is effectively empty`);
    assert.ok(firstVisibleY >= 24, `${label} needs at least 24px of strong-alpha headroom`);
    assert.ok(511 - lastVisibleY >= 8, `${label} needs at least 8px of bottom padding`);
    assert.ok(
      rowRuns[firstVisibleY] <= 4,
      `${label} starts with a ${rowRuns[firstVisibleY]}px flat cap instead of a tapered tip`,
    );
    const firstTwentyFourRuns = rowRuns.slice(firstVisibleY, firstVisibleY + 24);
    for (let offset = 0; offset <= firstTwentyFourRuns.length - 4; offset += 1) {
      const plateau = firstTwentyFourRuns.slice(offset, offset + 4);
      assert.ok(
        Math.min(...plateau) < 12 || Math.max(...plateau) - Math.min(...plateau) > 2,
        `${label} has a wide flat ${plateau.join("/")}px plateau near its tip`,
      );
    }

    let measuredFlareY = Math.ceil(512 * 0.72);
    for (let y = measuredFlareY + 1; y < 512; y += 1) {
      if (rowEnergy[y] > rowEnergy[measuredFlareY]) measuredFlareY = y;
    }
    assert.equal(measuredFlareY, 475, `${label} floor flare moved off its authored anchor`);
    assert.equal(manifest.frames[column].index, column);
    assert.equal(manifest.frames[column].flareY, 475);
    assert.deepEqual(
      manifest.frames[column].padding,
      [
        firstVisibleX,
        firstVisibleY,
        255 - lastVisibleX,
        511 - lastVisibleY,
      ],
      `${label} build report padding must match the checked-in PNG`,
    );
    assert.ok(brightPixels / visiblePixels >= 0.1, `${label} needs a bright flashing core`);
    assert.ok(whiteCorePixels / visiblePixels >= 0.015, `${label} needs an ivory-white core`);
    assert.ok(purplePixels / visiblePixels >= 0.18, `${label} must read as purple/violet`);

    const frame = rgbaCellBuffer(image, column, 0, 4, 1, label);
    const frameHash = sha256(frame);
    frameHashes.push(frameHash);
    assert.equal(manifest.frames[column].pixelHash, frameHash);
  }
  assert.equal(new Set(frameHashes).size, 4, "epic V4 must contain four distinct loop frames");
});

test("rare persistent pillar V4 keeps authored gold, white, and cyan detail without flattening", async () => {
  const assetPath = "asset-sources/imagegen/loot-pillar-rare-v4-production.png";
  const manifestPath = "asset-sources/imagegen/loot-pillar-rare-v4.build.json";
  const builderPath = "scripts/build_loot_pillar_rare_v4.py";
  const [png, manifestText, builder] = await Promise.all([
    readFile(path.join(root, assetPath)),
    readFile(path.join(root, manifestPath), "utf8"),
    readFile(path.join(root, builderPath), "utf8"),
  ]);
  const manifest = JSON.parse(manifestText);

  assert.equal(manifest.version, 4);
  assert.equal(manifest.builder, builderPath);
  assert.equal(manifest.format, "rgba-png");
  assert.deepEqual(manifest.atlas, {
    columns: 4,
    rows: 1,
    cell: [256, 512],
    size: [1024, 512],
  });
  assert.equal(manifest.output.path, assetPath);
  assert.equal(manifest.output.bytes, png.byteLength);
  assert.equal(
    manifest.output.sha256,
    createHash("sha256").update(png).digest("hex"),
    "the checked-in V4 PNG must be the exact output recorded by the build",
  );
  assert.equal(manifest.output.groundAnchor, 0.9219);
  assert.match(builder, /loot-pillar-rare-v4-production\.png/);
  assert.match(builder, /loot-pillar-rare-v4\.build\.json/);
  assert.match(builder, /visibleAlphaThreshold|VISIBLE_ALPHA_THRESHOLD/);
  assert.match(builder, /targetFlareY|TARGET_FLARE_Y/);

  for (const [stage, record] of Object.entries(manifest.source)) {
    const sourceBytes = await readFile(path.join(root, record.path));
    assert.equal(
      createHash("sha256").update(sourceBytes).digest("hex"),
      record.sha256,
      `rare V4 ${stage} provenance must match its checked-in source`,
    );
  }

  assert.ok(png.byteLength <= 1_000_000, `${assetPath} exceeds the 1 MB decode budget`);
  const image = decodeRgbaPng(png, assetPath);
  assert.deepEqual([image.width, image.height], manifest.atlas.size);
  const frameMetrics = [];
  let transparentRgbLeak = 0;
  for (let offset = 0; offset < image.pixels.length; offset += 4) {
    if (
      image.pixels[offset + 3] === 0 &&
      (image.pixels[offset] !== 0 ||
        image.pixels[offset + 1] !== 0 ||
        image.pixels[offset + 2] !== 0)
    ) {
      transparentRgbLeak += 1;
    }
  }
  assert.equal(transparentRgbLeak, 0, "rare V4 must not retain hidden keyed-background RGB");

  for (let column = 0; column < 4; column += 1) {
    const label = `rare V4 persistent pillar frame ${column}`;
    const bounds = alphaCellMetrics(image, column, 0, 4, 1, label);
    const metrics = persistentPillarFrameMetrics(image, column, label);
    const report = manifest.frames[column];
    frameMetrics.push(metrics);

    assert.equal(report.index, column);
    assert.equal(report.visiblePixels, metrics.visiblePixels);
    assert.equal(report.uniqueVisibleRgb, metrics.uniqueVisibleRgb);
    assert.equal(report.pixelHash, metrics.sha256);
    for (const [reportField, metricField] of [
      ["brightPixelRatio", "brightPixelRatio"],
      ["whitePixelRatio", "whitePixelRatio"],
      ["goldPixelRatio", "goldPixelRatio"],
      ["cyanPixelRatio", "cyanPixelRatio"],
      ["topColorRatio", "dominantColourRatio"],
      ["topTwoColorRatio", "topTwoColourRatio"],
    ]) {
      assert.ok(
        Math.abs(report[reportField] - metrics[metricField]) <= 0.001,
        `${label} ${reportField} must be recomputed from the checked-in PNG ` +
          `(report ${report[reportField]}, actual ${metrics[metricField]})`,
      );
    }
    assert.ok(bounds.left >= 1 && bounds.right >= 1, `${label} needs transparent side gutters`);
    assert.ok(bounds.top >= 1 && bounds.bottom >= 1, `${label} needs transparent vertical gutters`);
    assert.ok(
      report.padding.every((padding) => padding >= 8),
      `${label} needs safe visible-alpha gutters`,
    );
    assert.ok(bounds.height >= 450, `${label} must remain a tall ground-to-sky beacon`);

    assert.ok(metrics.entropy >= 5.4, `${label} lost its authored colour entropy`);
    assert.ok(
      metrics.effectiveColourCount >= 42,
      `${label} collapsed toward a flat single-colour silhouette`,
    );
    assert.ok(
      metrics.dominantColourRatio <= 0.22,
      `${label} lets one exact RGB value dominate the authored texture`,
    );
    assert.ok(
      metrics.topTwoColourRatio <= 0.34,
      `${label} lets two flat colours replace the authored texture`,
    );
    assert.ok(
      metrics.brightPixelRatio >= 0.15 && metrics.brightPixelRatio <= 0.62,
      `${label} must flash brightly without becoming a clipped white slab`,
    );
    assert.ok(
      metrics.nearClipPixelRatio <= 0.22,
      `${label} contains too much fully clipped white`,
    );
    assert.ok(metrics.whitePixelRatio >= 0.025, `${label} needs a white-hot core`);
    assert.ok(metrics.goldPixelRatio >= 0.12, `${label} needs a readable rare-grade gold body`);
    assert.ok(metrics.otherPixelRatio >= 0.08, `${label} needs dark and secondary colour detail`);
  }

  assert.ok(
    frameMetrics.filter((frame) => frame.cyanPixelRatio >= 0.0005).length >= 2,
    "rare V4 must animate its restrained cyan rune accents across multiple frames",
  );
  assert.ok(
    frameMetrics.some((frame) => frame.cyanPixelRatio >= 0.015),
    "rare V4 needs one readable cyan-rune accent peak",
  );
  assert.ok(
    frameMetrics.reduce((sum, frame) => sum + frame.cyanPixelRatio, 0) /
      frameMetrics.length >= 0.004,
    "rare V4 must keep a readable cyan accent across its complete loop",
  );

  assert.equal(
    new Set(frameMetrics.map((frame) => frame.sha256)).size,
    4,
    "rare V4 must contain four distinct full-RGBA animation frames",
  );
  const temporalPairs = frameMetrics.map((frame, index) => {
    const to = (index + 1) % frameMetrics.length;
    return [index, to, rgbaTemporalMetrics(frame.rgba, frameMetrics[to].rgba)];
  });
  for (const [from, to, metrics] of temporalPairs) {
    assert.ok(
      metrics.changedPixelRatio >= 0.03 && metrics.changedPixelRatio <= 0.99,
      `rare V4 frames ${from}->${to} must animate without replacing the entire motif`,
    );
    const report = manifest.temporalDifferences.find(
      (entry) => entry.from === from && entry.to === to,
    );
    assert.ok(report, `rare V4 build report is missing temporal pair ${from}->${to}`);
    assert.ok(
      Math.abs(report.changedPixelRatio - metrics.changedPixelRatio) <= 0.000_002,
      `rare V4 ${from}->${to} changed-pixel report must match the checked-in PNG`,
    );
    assert.ok(
      Math.abs(report.alphaSupportIou - metrics.alphaSupportIou) <= 0.000_002,
      `rare V4 ${from}->${to} support IoU report must match the checked-in PNG`,
    );
    assert.ok(report.alphaSupportIou >= 0.2);
  }
});

test("persistent loot-pillar V5 atlases have complete tapered tips, clean floors, and fixed anchors", async () => {
  const rarities = ["common", "magic", "superior", "rare", "legendary", "mythic", "cosmic"];
  const manifestPath = "public/assets/effects/loot-pillar-v5.build.json";
  const builderPath = "scripts/build_loot_pillar_v5_assets.py";
  const [manifestText, builder] = await Promise.all([
    readFile(path.join(root, manifestPath), "utf8"),
    readFile(path.join(root, builderPath), "utf8"),
  ]);
  const manifest = JSON.parse(manifestText);

  assert.equal(manifest.version, 5);
  assert.equal(manifest.builder, builderPath);
  assert.deepEqual(manifest.atlas, {
    columns: 4,
    rows: 1,
    cell: [256, 512],
    size: [1024, 512],
  });
  assert.equal(manifest.contract.targetFlareY, 475);
  assert.equal(manifest.contract.minimumTopPadding, 24);
  assert.equal(manifest.contract.minimumSidePadding, 8);
  assert.equal(manifest.contract.minimumBottomPadding, 8);
  assert.equal(manifest.contract.maximumFirstVisibleRun, 4);
  assert.equal(manifest.contract.detachedBottomComponents, 0);
  assert.match(manifest.contract.resize, /one uniform scale per four-frame sequence/i);
  assert.match(builder, /def premultiplied_resize/);
  assert.match(builder, /def restore_tapered_tip/);
  assert.match(builder, /def remove_detached_below_floor/);
  assert.match(builder, /TARGET_FLARE_Y\s*=\s*475/);
  assert.match(builder, /first_visible_run\s*>\s*MAX_FIRST_VISIBLE_RUN/);

  const promptBytes = await readFile(path.join(root, manifest.promptMetadata.path));
  assert.equal(
    createHash("sha256").update(promptBytes).digest("hex"),
    manifest.promptMetadata.sha256,
    "the checked-in ImageGen prompt/provenance record must match the V5 build",
  );
  assert.equal(manifest.promptMetadata.tool, "image_gen.imagegen built-in");

  const rareFrames = [];
  for (const rarity of rarities) {
    const record = manifest.rarities[rarity];
    assert.ok(record, `${rarity} V5 build record is missing`);
    for (const source of Object.values(record.sources)) {
      const sourceBytes = await readFile(path.join(root, source.path));
      assert.equal(createHash("sha256").update(sourceBytes).digest("hex"), source.sha256);
    }

    const outputBytes = await readFile(path.join(root, record.output.path));
    assert.equal(record.output.path, `public/assets/effects/loot-pillar-${rarity}-v5.png`);
    assert.equal(record.output.bytes, outputBytes.byteLength);
    assert.equal(createHash("sha256").update(outputBytes).digest("hex"), record.output.sha256);
    assert.ok(outputBytes.byteLength <= 1_000_000, `${rarity} V5 exceeds its decode budget`);
    assert.equal(record.output.groundAnchor, 0.927734);

    const image = decodeRgbaPng(outputBytes, record.output.path);
    assert.deepEqual([image.width, image.height], [1024, 512]);
    const frameHashes = [];
    for (let column = 0; column < 4; column += 1) {
      const label = `${rarity} V5 frame ${column}`;
      const frame = rgbaCellBuffer(image, column, 0, 4, 1, label);
      frameHashes.push(createHash("sha256").update(frame).digest("hex"));
      if (rarity === "rare") rareFrames.push(frame);

      const support = new Uint8Array(256 * 512);
      let left = 256;
      let top = 512;
      let right = -1;
      let bottom = -1;
      let visiblePixels = 0;
      let brightPixels = 0;
      const rowEnergy = new Float64Array(512);
      for (let y = 0; y < 512; y += 1) {
        for (let x = 0; x < 256; x += 1) {
          const offset = (y * 256 + x) * 4;
          const alpha = frame[offset + 3];
          const luminance =
            frame[offset] * 0.299 + frame[offset + 1] * 0.587 + frame[offset + 2] * 0.114;
          rowEnergy[y] += luminance * (alpha / 255);
          if (alpha < 64) continue;
          support[y * 256 + x] = 1;
          visiblePixels += 1;
          left = Math.min(left, x);
          top = Math.min(top, y);
          right = Math.max(right, x);
          bottom = Math.max(bottom, y);
          if (luminance >= 205) brightPixels += 1;
        }
      }
      assert.ok(visiblePixels > 0, `${label} is empty`);
      let flareY = 281;
      for (let y = 282; y < 512; y += 1) {
        if (rowEnergy[y] > rowEnergy[flareY]) flareY = y;
      }
      let firstVisibleRun = 0;
      let currentRun = 0;
      for (let x = 0; x < 256; x += 1) {
        if (support[top * 256 + x]) {
          currentRun += 1;
          firstVisibleRun = Math.max(firstVisibleRun, currentRun);
        } else {
          currentRun = 0;
        }
      }

      const frameRecord = record.frames[column];
      assert.deepEqual(frameRecord.bbox, [left, top, right + 1, bottom + 1]);
      assert.deepEqual(frameRecord.padding, [left, top, 255 - right, 511 - bottom]);
      assert.equal(frameRecord.firstVisibleRowMaxRun, firstVisibleRun);
      assert.equal(frameRecord.flareY, flareY);
      assert.equal(frameRecord.detachedBottomComponents, 0);
      assert.equal(frameRecord.detachedBottomPixels, 0);
      assert.ok(top >= 24, `${label} needs visible headroom above its complete tip`);
      assert.ok(255 - right >= 8 && left >= 8, `${label} needs safe side gutters`);
      assert.ok(511 - bottom >= 8, `${label} must not contain a leaked lower-row tip`);
      assert.ok(firstVisibleRun <= 4, `${label} starts with a visibly cropped flat cap`);
      assert.equal(flareY, 475, `${label} floor flare must remain registered`);
      assert.ok(brightPixels / visiblePixels >= 0.05, `${label} needs a bright light core`);
      assert.ok(frameRecord.flatPlateauRows.length === 0, `${label} has a flat top plateau`);
    }
    assert.equal(new Set(frameHashes).size, 4, `${rarity} V5 must animate four unique frames`);
  }

  const rareRecord = manifest.rarities.rare;
  assert.ok(rareRecord.frames.every((frame) => frame.coverage >= 0.2));
  assert.ok(rareRecord.frames.every((frame) => frame.goldPixelRatio >= 0.12));
  for (let index = 0; index < rareFrames.length; index += 1) {
    const metrics = rgbaTemporalMetrics(rareFrames[index], rareFrames[(index + 1) % 4]);
    assert.ok(
      metrics.alphaSupportIou >= 0.55,
      `rare V5 frames ${index}->${(index + 1) % 4} must animate one coherent painted pillar`,
    );
  }
});

test("persistent gear drops draw only authored four-frame portrait pillar sprites", async () => {
  const source = await readFile(path.join(root, "app/GameCanvas.tsx"), "utf8");
  const rarities = ["common", "magic", "superior", "rare", "epic", "legendary", "mythic", "cosmic"];
  const configStart = source.indexOf("const EQUIPMENT_RARITY_VFX:");
  const configEnd = source.indexOf("const EQUIPMENT_RARITIES", configStart);
  assert.ok(configStart >= 0 && configEnd > configStart, "the rarity VFX config is missing");
  const configSource = source.slice(configStart, configEnd);
  const rarityBlocks = Object.fromEntries(
    rarities.map((rarity) => {
      const start = configSource.indexOf(`${rarity}: {`);
      const end = configSource.indexOf("\n  },", start);
      assert.ok(start >= 0 && end > start, `${rarity} VFX configuration is missing`);
      return [rarity, configSource.slice(start, end)];
    }),
  );
  for (const rarity of rarities) {
    const assetSuffix = rarity === "epic" ? "v4\\.png(?:\\?v=[a-f0-9]+)?" : "v5\\.png";
    assert.match(
      rarityBlocks[rarity],
      new RegExp(`pillarImagePath:\\s*["']/assets/effects/loot-pillar-${rarity}-${assetSuffix}["']`),
      `${rarity} must preload its dedicated persistent pillar loop`,
    );
    assert.match(
      rarityBlocks[rarity],
      new RegExp(`pillarCompositeOperation:\\s*"${rarity === "rare" ? "screen" : "lighter"}"`),
      `${rarity} must use its authored persistent-pillar blend mode`,
    );
  }
  assert.doesNotMatch(
    rarityBlocks.epic,
    /loot-pillar-epic-v3\.png/,
    "epic must not regress to the source-clipped V3 pillar",
  );
  assert.match(source, /imagePaths\[config\.pillarImageKey\]\s*=\s*config\.pillarImagePath/);

  const drawStart = source.lastIndexOf("for (const drop of world.gearDrops)");
  const drawEnd = source.indexOf("for (const orb of world.orbs)", drawStart);
  assert.ok(drawStart >= 0 && drawEnd > drawStart, "the persistent gear-drop renderer is missing");
  const drawDrops = source.slice(drawStart, drawEnd);
  const pillarStart = drawDrops.indexOf("const pillarVfxImage =");
  const iconStart = drawDrops.indexOf("if (itemReveal > 0.001) {", pillarStart + 1);
  assert.ok(pillarStart >= 0 && iconStart > pillarStart, "the pillar sprite block is not isolated from the icon block");
  const pillarRenderer = drawDrops.slice(pillarStart, iconStart);

  assert.match(pillarRenderer, /const pillarFrame = positiveModulo\([\s\S]{0,160}?Math\.floor\(ambientTime \* rarityVfx\.pillarFps \+ drop\.id\)[\s\S]{0,40}?,\s*4,/);
  assert.match(pillarRenderer, /const sourceWidth = pillarVfxImage\.naturalWidth \/ 4;/);
  assert.match(pillarRenderer, /const sourceHeight = pillarVfxImage\.naturalHeight;/);
  assert.match(
    pillarRenderer,
    /const pillarRenderWidth\s*=\s*rarityVfx\.pillarHeight \* \(sourceWidth \/ sourceHeight\);/,
    "persistent pillars must preserve the authored frame aspect ratio",
  );
  assert.match(
    pillarRenderer,
    /context\.globalCompositeOperation = rarityVfx\.pillarCompositeOperation;/,
    "the renderer must consume the rarity-specific blend mode instead of flattening rare art additively",
  );
  assert.match(pillarRenderer, /context\.imageSmoothingEnabled = true;/);
  assert.match(pillarRenderer, /context\.imageSmoothingQuality = "high";/);
  assert.match(
    pillarRenderer,
    /context\.drawImage\(\s*pillarVfxImage,\s*pillarFrame \* sourceWidth,\s*0,\s*sourceWidth,\s*sourceHeight,\s*drop\.x - pillarRenderWidth \/ 2,\s*[\s\S]{0,220}?drop\.y \+\s*rarityVfx\.pillarGroundOffsetPx\s*-\s*rarityVfx\.pillarHeight \* rarityVfx\.pillarGroundAnchor,\s*pillarRenderWidth,\s*rarityVfx\.pillarHeight,/,
  );
  assert.doesNotMatch(
    configSource,
    /pillarWidth\s*:/,
    "rarity configs must not reintroduce an independent stretched pillar width",
  );
  assert.match(
    source,
    /pillarGroundAnchor:\s*number;/,
    "persistent pillar placement needs a semantic authored-floor anchor",
  );
  assert.match(
    source,
    /pillarGroundOffsetPx:\s*number;/,
    "persistent pillar placement needs a separate visual floor correction",
  );
  assert.match(
    source,
    /pillarCompositeOperation:\s*"lighter"\s*\|\s*"screen";/,
    "persistent pillars need a constrained authored blend-mode contract",
  );
  const expectedGroundAnchors = {
    common: 0.9277,
    magic: 0.9277,
    superior: 0.9277,
    rare: 0.9277,
    epic: 0.9277,
    legendary: 0.9277,
    mythic: 0.9277,
    cosmic: 0.9277,
  };
  const expectedGroundOffsets = PERSISTENT_PILLAR_GROUND_OFFSETS;
  const actualGroundOffsets = {};
  for (const [rarity, anchor] of Object.entries(expectedGroundAnchors)) {
    assert.match(
      source,
      new RegExp(`${rarity}:\\s*\\{[\\s\\S]{0,900}?pillarGroundAnchor:\\s*${anchor}`),
      `${rarity} must register its measured visible flare-floor origin`,
    );
    assert.ok(anchor > 0.75 && anchor < 0.95, `${rarity} floor anchor must stay inside the lower flare`);
    const rarityBlock = rarityBlocks[rarity];
    const offset = rarityBlock.match(
      /\bpillarGroundOffsetPx:\s*(-?\d+(?:\.\d+)?)\s*,/,
    );
    assert.ok(offset, `${rarity} visual floor correction is missing`);
    actualGroundOffsets[rarity] = Number(offset[1]);
    const height = rarityBlock.match(/\bpillarHeight:\s*(\d+(?:\.\d+)?)\s*,/);
    assert.ok(height, `${rarity} persistent pillar height is missing`);
    assert.equal(
      Number(height[1]),
      PERSISTENT_PILLAR_HEIGHTS[rarity],
      `${rarity} tail-alignment test height must match the production renderer`,
    );
  }
  assert.deepEqual(
    actualGroundOffsets,
    expectedGroundOffsets,
    "short low-tier flare tails must step down to the unchanged epic baseline",
  );
  const legendaryHeight = 216;
  const legacyClippedLegendaryAnchor = 0.8281;
  const oldLegendaryHotspotY =
    12 - legendaryHeight + legacyClippedLegendaryAnchor * legendaryHeight;
  const correctedLegendaryHotspotY =
    expectedGroundOffsets.legendary -
    legendaryHeight * expectedGroundAnchors.legendary +
    legendaryHeight * expectedGroundAnchors.legendary;
  assert.ok(
    oldLegendaryHotspotY < -24,
    "the legacy bottom anchor reproduced the reported raised flare",
  );
  assert.equal(
    correctedLegendaryHotspotY,
    0,
    "the authored legendary flare must meet drop.y exactly",
  );
  const commonVisualContactY =
    expectedGroundOffsets.common -
    96 * expectedGroundAnchors.common +
    96 * expectedGroundAnchors.common;
  assert.equal(
    commonVisualContactY,
    4,
    "the short common flare must render four pixels below its authored anchor",
  );
  assert.doesNotMatch(
    pillarRenderer,
    /context\.(?:beginPath|ellipse|arc|moveTo|lineTo|closePath|stroke|fill|fillRect|createLinearGradient|createRadialGradient)\s*\(/,
    "persistent pillar VFX must not synthesize canvas geometry or gradients",
  );
  const iconRenderer = drawDrops.slice(
    iconStart,
    drawDrops.indexOf("context.restore();", iconStart),
  );
  assert.match(
    iconRenderer,
    /context\.globalCompositeOperation = "source-over";[\s\S]{0,220}?const equipmentIcons = images\.equipmentIcons;/,
    "the icon must restore normal compositing after the additive pillar",
  );
  assert.match(
    iconRenderer,
    /drop\.y - drawSize \* 0\.68 \+ bob \+ riseOffset/,
    "the item position must stay unchanged while only the pillar moves",
  );
  assert.match(
    iconRenderer,
    /context\.fillText\(groundLabel, drop\.x, drop\.y \+ 28\)/,
    "the ground label must stay unchanged while only the pillar moves",
  );
  assert.doesNotMatch(
    iconRenderer,
    /pillarGroundOffsetPx/,
    "the visual correction must affect only the persistent pillar",
  );
  assert.equal(
    source.match(/rarityVfx\.pillarGroundOffsetPx/g)?.length,
    1,
    "the visual correction must not leak into the one-shot awakening renderer",
  );
});

test("the V5 field-loot builder keeps authored frame scale and never recolors one shared atlas", async () => {
  const builder = await readFile(
    path.join(root, "scripts/build_rarity_spectacle_assets.py"),
    "utf8",
  );
  const fixedResize = builder.match(
    /def resize_sequence_preserving_scale\([\s\S]*?(?=\ndef [a-z_]+\()/,
  );
  const fieldBuild = builder.match(/def build_field_assets\(\)[\s\S]*?(?=\n\nif __name__)/);
  assert.ok(fixedResize, "the field builder needs a dedicated fixed-scale sequence transform");
  assert.ok(fieldBuild, "the field builder entry point is missing");
  assert.match(
    fixedResize[0],
    /for index, cell in enumerate\(frame_cells\(source\)\):[\s\S]{0,320}?cell\.convert\("RGBa"\)\.resize\(\s*\(FIELD_CONTENT_SIZE, FIELD_CONTENT_SIZE\)/,
    "every source cell must receive the same fixed transform",
  );
  assert.doesNotMatch(
    fixedResize[0],
    /getbbox\(|cropped\s*=|scale\s*=\s*min\(/,
    "field frames must not be independently cropped and normalized",
  );
  assert.doesNotMatch(builder, /FIELD_TINTS/);
  assert.doesNotMatch(fieldBuild[0], /tint_atlas\(|normalize_spectacle\(/);
  assert.match(fieldBuild[0], /"common": ARRIVAL_SOURCE_ROOT \/ "common-alpha\.png"/);
  assert.match(fieldBuild[0], /"legendary": EFFECT_ROOT \/ "loot-awakening\.png"/);
  assert.match(fieldBuild[0], /"mythic": EFFECT_ROOT \/ "loot-mythic-awakening\.png"/);
  assert.match(fieldBuild[0], /"cosmic": ARRIVAL_SOURCE_ROOT \/ "cosmic-alpha\.png"/);
  assert.match(
    fieldBuild[0],
    /f"loot-awakening-\{rarity\}-v5\.png"[\s\S]{0,220}?resize_sequence_preserving_scale\(\s*sources\[rarity\],[\s\S]{0,100}?clear_top_row_cross_cell_bleed=rarity == "cosmic"/,
  );
  assert.match(
    fixedResize[0],
    /if clear_top_row_cross_cell_bleed:[\s\S]{0,260}?source\.paste\(/,
    "the cosmic source seam must be cleaned reproducibly before atlas scaling",
  );
  assert.match(fieldBuild[0], /len\(set\(support_hashes\)\) != len\(RARITIES\)/);
});

test("field drops keep eight V5 arrival patterns and reveal persistent pillar art with the item", async () => {
  const source = await readFile(path.join(root, "app/GameCanvas.tsx"), "utf8");
  const config = source.match(
    /const EQUIPMENT_RARITY_VFX:[\s\S]*?= \{([\s\S]*?)\n\};\n\nconst EQUIPMENT_RARITIES/,
  );
  assert.ok(config, "the field rarity VFX configuration is missing");
  const patterns = [...config[1].matchAll(/arrivalPattern:\s*"([^"]+)"/g)].map(
    (match) => match[1],
  );
  assert.deepEqual(patterns, [
    "dustSeal",
    "arcaneTriangle",
    "thornBloom",
    "compassBloom",
    "reverseVortex",
    "solarCoronation",
    "mythicCoronation",
    "nebulaCollapse",
  ]);
  assert.equal(new Set(patterns).size, 8, "each rarity needs its own arrival choreography");
  assert.equal((config[1].match(/itemRevealAt:\s*0?\.\d+/g) ?? []).length, 8);
  assert.equal((config[1].match(/beamRevealAt:\s*0?\.\d+/g) ?? []).length, 8);
  assert.equal((config[1].match(/itemRisePx:\s*\d+/g) ?? []).length, 8);

  assert.match(source, /type GearDrop\s*=\s*\{[\s\S]*?appearanceAge:\s*number;/);
  assert.ok(
    (source.match(/appearanceAge:\s*0,/g) ?? []).length >= 2,
    "normal and local-showcase drops must both start hidden at appearance age zero",
  );
  assert.match(
    source,
    /for \(const drop of world\.gearDrops\)[\s\S]{0,260}?drop\.appearanceAge = Math\.min\([\s\S]{0,120}?\(drop\.appearanceAge \?\? 0\) \+ dt/,
    "appearance age must advance in simulation time",
  );

  const drawStart = source.lastIndexOf("for (const drop of world.gearDrops)");
  const drawEnd = source.indexOf("for (const orb of world.orbs)", drawStart);
  assert.ok(drawStart >= 0 && drawEnd > drawStart, "the field-drop render block is missing");
  const drawDrops = source.slice(drawStart, drawEnd);
  assert.match(drawDrops, /const appearanceProgress = clamp\([\s\S]{0,160}?rarityVfx\.awakeningDuration/);
  assert.match(drawDrops, /appearanceProgress - rarityVfx\.itemRevealAt/);
  assert.match(
    drawDrops,
    /const pillarRevealRaw = clamp\([\s\S]{0,180}?drop\.appearanceAge[\s\S]{0,120}?rarityVfx\.awakeningDuration[\s\S]{0,180}?const pillarReveal =[\s\S]{0,240}?const pillarVfxImage = images\[rarityVfx\.pillarImageKey\];[\s\S]{0,180}?pillarReveal > 0\.001[\s\S]{0,900}?context\.drawImage\(\s*pillarVfxImage,/,
    "persistent pillar art must fade in only after the authored arrival completes",
  );
  assert.match(
    drawDrops,
    /context\.globalAlpha = itemReveal;[\s\S]{0,320}?const equipmentIcons = images\.equipmentIcons;[\s\S]{0,900}?context\.drawImage\(/,
    "the equipment icon must materialize only after its rarity cue",
  );
  assert.match(
    drawDrops,
    /const pillarFrame = positiveModulo\([\s\S]{0,180}?,\s*4,/,
    "persistent pillar art must loop all four authored frames",
  );
  assert.match(
    drawDrops,
    /if \(itemReveal > 0\.001\) \{[\s\S]{0,320}?const equipmentIcons = images\.equipmentIcons/,
    "hidden item icons must skip their atlas draw path",
  );
  assert.match(drawDrops, /const riseOffset = rarityVfx\.itemRisePx \* \(1 - itemReveal\)/);
});

test("loot-awakening capacity preserves rare arrivals instead of letting common effects starve them", async () => {
  const source = await readFile(path.join(root, "app/GameCanvas.tsx"), "utf8");
  const spawn = source.match(
    /const spawnLootAwakening = \([\s\S]*?(?=\n\s*const spawnLocalLootVfxShowcase)/,
  );
  assert.ok(spawn, "spawnLootAwakening is missing");
  assert.match(spawn[0], /activeLootEffects\.length >= 18/);
  assert.match(spawn[0], /const incomingTier = EQUIPMENT_RARITY_TIER\[rarity\]/);
  assert.match(
    spawn[0],
    /activeLootEffects\.reduce\(\(lowest, effect\)[\s\S]{0,420}?effectTier < lowestTier[\s\S]{0,180}?effect\.life < lowest\.life/,
    "the cap must identify the lowest-tier, oldest expendable awakening",
  );
  assert.match(spawn[0], /if \(incomingTier <= lowestTier\) return;/);
  assert.match(
    spawn[0],
    /world\.effects = world\.effects\.filter\([\s\S]{0,120}?effect\.id !== lowestPriorityEffect\.id/,
    "a higher-tier arrival must replace the selected lower-tier effect",
  );
});

test("the field-loot showcase is localhost-only, memory-only, and uses production drops", async () => {
  const [source, entrySource, audioProvider] = await Promise.all([
    readFile(path.join(root, "app/GameCanvas.tsx"), "utf8"),
    readFile(path.join(root, "app/GameEntryFlow.tsx"), "utf8"),
    readFile(path.join(root, "app/GameAudioProvider.tsx"), "utf8"),
  ]);
  assert.match(
    source,
    /const isLocalRarityShowcaseHost = \(\) =>[\s\S]{0,180}?\["localhost", "127\.0\.0\.1", "::1", "\[::1\]"\]\.includes\(window\.location\.hostname\)/,
  );
  assert.match(
    source,
    /const lootVfxShowcaseMode =\s*localLootVfxShowcase \?\?[\s\S]{0,120}?isLocalRarityShowcaseHost\(\)[\s\S]{0,120}?get\("lootVfxShowcase"\)[\s\S]{0,40}?: null/,
    "an explicit memory-only prop must win, and the query fallback must stay local",
  );
  assert.match(source, /lootVfxShowcaseMode === "all"\s*\? EQUIPMENT_RARITIES/);
  assert.match(source, /lootVfxShowcaseMode === "crop-icons"/);
  assert.match(
    source,
    /const localDeathUiShowcase\s*=\s*isLocalVfxShowcase\s*&&\s*isLocalRarityShowcaseHost\(\)\s*&&[\s\S]{0,120}?get\("deathUiShowcase"\) === "1"/,
    "death-screen visual QA must remain localhost-only and reuse the save-free showcase path",
  );
  assert.match(
    source,
    /if \(localDeathUiShowcase\) setGameMode\("dead"\);\s*else if \(localEndingUiShowcase\) \{\s*setEndingChapterIndex\(1\);\s*setGameMode\("ending"\);\s*\} else setGameMode\("playing"\);/,
    "the local showcase must render the production death modal without mutating a save",
  );

  assert.match(entrySource, /const LOCAL_VFX_SHOWCASE_HOSTS = \[[\s\S]{0,120}?"localhost"[\s\S]{0,120}?"\[::1\]"/);
  assert.match(
    entrySource,
    /const LOCAL_LOOT_VFX_SHOWCASE_MODES:[\s\S]{0,280}?"common"[\s\S]{0,280}?"cosmic"[\s\S]{0,60}?"all"/,
  );
  assert.match(entrySource, /"crop-icons"/);
  assert.match(audioProvider, /LOCAL_LOOT_VFX_SHOWCASE_MODES[\s\S]{0,260}?"crop-icons"/);
  assert.match(entrySource, /const requestedLootMode = search\.get\("lootVfxShowcase"\);/);
  assert.match(
    entrySource,
    /if \(isLocalLootVfxShowcaseMode\(requestedLootMode\)\) \{\s*setLocalLootVfxShowcase\(requestedLootMode\);/,
    "unknown or remotely supplied loot-showcase modes must never reach GameCanvas",
  );
  const directEntry = entrySource.indexOf(
    "if (localEnemyVfxShowcase || localLootVfxShowcase || localEndingUiShowcase)",
  );
  const characterGate = entrySource.indexOf("if (selection === null)", directEntry);
  assert.ok(
    directEntry >= 0 && characterGate > directEntry,
    "the local VFX route must bypass character selection before the gate can read a save",
  );
  const directEntryBlock = entrySource.slice(directEntry, characterGate);
  assert.match(directEntryBlock, /"local-loot-vfx-showcase"/);
  assert.match(
    directEntryBlock,
    /localLootVfxShowcase=\{localLootVfxShowcase \?\? undefined\}/,
  );
  assert.match(entrySource, /readShopEntitlements\(null\)/);
  assert.match(source, /readShopEntitlements\(null\)/);

  const providerAudioAccess = audioProvider.indexOf("const audio = getGameAudio()");
  const providerLootQuery = audioProvider.lastIndexOf("lootVfxShowcase", providerAudioAccess);
  const providerBypassReturn = audioProvider.lastIndexOf("return undefined", providerAudioAccess);
  assert.ok(providerAudioAccess >= 0, "the global audio provider initialization is missing");
  assert.ok(
    providerLootQuery >= 0 &&
      providerLootQuery < providerBypassReturn &&
      providerBypassReturn < providerAudioAccess,
    "the localhost loot-VFX query must bypass audio hydration before getGameAudio/initialize can touch storage",
  );
  assert.match(
    audioProvider.slice(audioProvider.lastIndexOf("useEffect(() =>", providerAudioAccess), providerAudioAccess),
    /if \(localShowcaseBrowserSnapshot\(\) \|\| localAudioDockShowcase\) return undefined;/,
  );

  const showcase = source.match(
    /const spawnLocalLootVfxShowcase = \(\) => \{[\s\S]*?(?=\n\s*const spawnCombatEffect)/,
  );
  assert.ok(showcase, "the local field-loot showcase hook is missing");
  assert.match(showcase[0], /lootVfxShowcaseSpawnedRef\.current/);
  assert.match(showcase[0], /modeRef\.current !== "playing"/);
  assert.match(
    source,
    /const item = cropIconSpec[\s\S]{0,420}?: rollGear\(`local-loot-vfx-\$\{rarity\}`,[\s\S]{0,160}?rarity,/,
    "showcase items must be produced by the real gear roller with a forced rarity",
  );
  assert.match(
    source,
    /local-loot-crop-shield-14[\s\S]{0,180}?rarity: "common"[\s\S]{0,180}?slot: "offhand"/,
    "the crop QA route must spawn the exact oath-shield cell",
  );
  assert.match(
    source,
    /local-loot-crop-gloves-0[\s\S]{0,180}?rarity: "magic"[\s\S]{0,180}?slot: "gloves"/,
    "the crop QA route must spawn the exact memory-gloves cell",
  );
  assert.match(
    showcase[0],
    /world\.gearDrops = \[\];[\s\S]{0,80}?world\.effects = \[\];/,
    "a repeatable showcase must begin from an isolated in-memory drop/effect list",
  );
  assert.match(
    showcase[0],
    /world\.gearDrops\.push\(\{[\s\S]{0,220}?item,[\s\S]{0,120}?pickupDelay:\s*Number\.POSITIVE_INFINITY,[\s\S]{0,80}?appearanceAge:\s*0/,
    "showcase drops must use real GearDrop records but remain impossible to pick up",
  );
  assert.match(
    showcase[0],
    /const safePosition = safeWalkableFloorPoint\([\s\S]{0,180}?GEAR_DROP_WALL_CLEARANCE/,
  );
  assert.match(
    showcase[0],
    /spawnLootAwakening\(safePosition\.x, safePosition\.y, rarity, false\)/,
    "the production awakening path must run silently in the storage-isolated showcase",
  );
  assert.doesNotMatch(
    showcase[0],
    /localStorage|sessionStorage|loadSave|startNewRun|writeSaveSlot|removeSaveSlot|migrateLegacySave/,
  );
  assert.match(
    source,
    /const loop = \(now: number\) => \{[\s\S]*?if \(simulationRunning\) \{\s*spawnLocalLootVfxShowcase\(\)/,
  );

  const awakening = source.match(
    /const spawnLootAwakening = \([\s\S]*?(?=\n\s*const spawnLocalLootVfxShowcase)/,
  );
  assert.ok(awakening, "spawnLootAwakening is missing");
  assert.match(
    awakening[0],
    /rarity:\s*GearItem\["rarity"\],[\s\S]{0,80}?playSound\s*=\s*true/,
    "normal drops must retain rarity SFX by default",
  );
  assert.match(
    awakening[0],
    /if \(playSound\) playGearRaritySfx\(rarity\)/,
    "rarity SFX must honor the explicit silent-showcase flag",
  );
  assert.match(
    showcase[0],
    /spawnLootAwakening\(safePosition\.x, safePosition\.y, rarity, false\)/,
    "the memory-only loot showcase must not hydrate audio settings through rarity SFX",
  );

  assert.match(
    source,
    /const isLocalVfxShowcase = Boolean\(\s*localEnemyVfxShowcase \|\| localLootVfxShowcase \|\| localEndingUiShowcase,?\s*\);/,
  );
  const transientStart = source.indexOf(
    "if (!isLocalVfxShowcase || initialSaveSlotHandledRef.current) return;",
  );
  const normalSlotHydration = source.indexOf(
    "if (isLocalVfxShowcase) return;",
    transientStart,
  );
  assert.ok(transientStart >= 0 && normalSlotHydration > transientStart);
  const transientBoot = source.slice(transientStart, normalSlotHydration);
  assert.match(transientBoot, /playerRef\.current = makePlayer\(\);/);
  assert.match(transientBoot, /worldRef\.current = makeWorld\(/);
  assert.match(transientBoot, /setGameMode\("playing"\);/);
  assert.doesNotMatch(
    transientBoot,
    /localStorage|sessionStorage|loadSave|startNewRun|writeSaveSlot|removeSaveSlot|migrateLegacySave/,
    "loot-showcase boot must remain fully in memory",
  );
  assert.match(source, /const activateSaveSlot =[\s\S]{0,220}?if \(!isLocalVfxShowcase\) writeActiveSaveSlot\(slot\);/);
  assert.match(source, /const refreshSaveSlots =[\s\S]{0,140}?if \(isLocalVfxShowcase\) return;/);
  assert.match(source, /const saveAtShelter =[\s\S]{0,140}?if \(isLocalVfxShowcase\) return;/);
  assert.match(source, /const loadSave =[\s\S]{0,180}?if \(isLocalVfxShowcase\) return false;/);
  assert.match(source, /const startNewRun =[\s\S]{0,180}?if \(isLocalVfxShowcase\) return;/);
  assert.match(
    source,
    /const saveCheck = isLocalVfxShowcase\s*\? null\s*:\s*window\.setTimeout\(\(\) => \{\s*migrateLegacySave\(\);/,
    "loot-showcase boot must not run save migration",
  );
});

test("inventory v2 artwork, square V6 rarity frames, and every rare+ authored animation remain connected", async () => {
  const backgroundPath = "public/assets/ui/inventory-sanctum-v2.png";
  const framesPath = "public/assets/ui/rarity-frames-v6.png";
  const sourceFramesPath = "public/assets/ui/rarity-frames.png";
  const frameBuildPath = "public/assets/ui/rarity-frames-v6.build.json";
  const auraAssets = ["rare", "epic", "legendary", "mythic", "cosmic"].map((tier) => [
    tier,
    `public/assets/ui/inventory-rarity-aura-${tier}-v3.png`,
  ]);
  const [backgroundPng, framePng, sourceFramePng, frameBuildText, overlay, css, ...auraPngs] = await Promise.all([
    readFile(path.join(root, backgroundPath)),
    readFile(path.join(root, framesPath)),
    readFile(path.join(root, sourceFramesPath)),
    readFile(path.join(root, frameBuildPath), "utf8"),
    readFile(path.join(root, "app/InventoryOverlay.tsx"), "utf8"),
    readFile(path.join(root, "app/game.css"), "utf8"),
    ...auraAssets.map(([, assetPath]) => readFile(path.join(root, assetPath))),
  ]);

  for (const [assetPath, png] of [
    [backgroundPath, backgroundPng],
    [framesPath, framePng],
    ...auraAssets.map(([, assetPath], index) => [assetPath, auraPngs[index]]),
  ]) {
    assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a", assetPath);
  }
  const backgroundWidth = backgroundPng.readUInt32BE(16);
  const backgroundHeight = backgroundPng.readUInt32BE(20);
  assert.ok(backgroundWidth >= 1600, `${backgroundPath} is too narrow for the enlarged inventory`);
  assert.ok(backgroundHeight >= 900, `${backgroundPath} is too short for the enlarged inventory`);
  assert.ok(backgroundWidth / backgroundHeight >= 1.5, `${backgroundPath} must remain a wide panel`);

  const frames = decodeRgbaPng(framePng, framesPath);
  const sourceFrames = decodeRgbaPng(sourceFramePng, sourceFramesPath);
  const frameBuild = JSON.parse(frameBuildText);
  assert.equal(frames.width, frames.height * 8, "rarity frames must form an eight-column by one-row atlas");
  assert.equal(sourceFrames.width, frames.width, "V6 source and output atlas widths must match");
  assert.equal(sourceFrames.height, frames.height, "V6 source and output atlas heights must match");
  assert.equal(frameBuild.version, 6);
  assert.equal(frameBuild.source, sourceFramesPath);
  assert.equal(frameBuild.output, framesPath);
  assert.equal(frameBuild.pipeline.mode, "source-preserving deterministic vertical three-band resize");
  assert.deepEqual(frameBuild.pipeline.editedCells, ["mythic"]);
  assert.equal(frameBuild.pipeline.horizontalCoordinatesChanged, false);
  assert.equal(frameBuild.pipeline.spectacleAssetsChanged, false);
  assert.equal(createHash("sha256").update(sourceFramePng).digest("hex"), frameBuild.sourceSha256);
  assert.equal(createHash("sha256").update(framePng).digest("hex"), frameBuild.outputSha256);
  const frameWidth = frames.width / 8;
  for (let column = 0; column < 8; column += 1) {
    let opaquePixels = 0;
    let transparentPixels = 0;
    for (let y = 0; y < frames.height; y += 1) {
      for (let x = column * frameWidth; x < (column + 1) * frameWidth; x += 1) {
        if (frames.pixels[(y * frames.width + x) * 4 + 3] === 0) transparentPixels += 1;
        else opaquePixels += 1;
      }
    }
    assert.ok(opaquePixels >= 100, `rarity frame column ${column} is empty`);
    assert.ok(transparentPixels >= 100, `rarity frame column ${column} lost its transparent center`);
    const metrics = alphaCellMetrics(frames, column, 0, 8, 1, `rarity frame column ${column}`);
    assert.ok(metrics.width >= 302 && metrics.width <= 304, `rarity frame ${column} width must be normalized`);
    assert.ok(metrics.height >= 302 && metrics.height <= 304, `rarity frame ${column} height must be normalized`);
    assert.ok(Math.abs(metrics.centerX - (frameWidth - 1) / 2) <= 1.5, `rarity frame ${column} drifts horizontally`);
    assert.ok(Math.abs(metrics.centerY - (frames.height - 1) / 2) <= 1.5, `rarity frame ${column} drifts vertically`);
  }
  const structuralMetrics = Array.from({ length: 8 }, (_, column) =>
    alphaCellMetrics(frames, column, 0, 8, 1, `rarity frame column ${column}`),
  );
  const referenceFrame = structuralMetrics[0];
  for (const [column, metrics] of structuralMetrics.entries()) {
    assert.ok(
      Math.abs(metrics.width - referenceFrame.width) <= 2 &&
        Math.abs(metrics.height - referenceFrame.height) <= 2,
      `rarity frame ${column} must fit the same structural slot bounds`,
    );
    assert.ok(
      Math.abs(metrics.centerX - referenceFrame.centerX) <= 1.5 &&
        Math.abs(metrics.centerY - referenceFrame.centerY) <= 1.5,
      `rarity frame ${column} must share the structural frame centre`,
    );
  }

  for (let column = 0; column < 8; column += 1) {
    const sourceCell = rgbaCellBuffer(sourceFrames, column, 0, 8, 1, `V5 rarity frame ${column}`);
    const outputCell = rgbaCellBuffer(frames, column, 0, 8, 1, `V6 rarity frame ${column}`);
    if (column === 6) {
      assert.notDeepEqual(outputCell, sourceCell, "mythic must receive the square-window geometry correction");
    } else {
      assert.deepEqual(outputCell, sourceCell, `rarity frame ${column} must remain pixel-identical`);
    }
  }
  const sourceMythicWindow = centreClearComponentMetrics(
    sourceFrames,
    6,
    0,
    8,
    1,
    "V5 mythic rarity frame",
  );
  const mythicWindow = centreClearComponentMetrics(frames, 6, 0, 8, 1, "V6 mythic rarity frame");
  assert.deepEqual(
    [sourceMythicWindow.width, sourceMythicWindow.height],
    [173, 148],
    "the regression fixture must retain the original rectangular mythic opening",
  );
  assert.deepEqual(
    [mythicWindow.left, mythicWindow.top, mythicWindow.right, mythicWindow.bottom],
    [74, 74, 247, 247],
    "the mythic equipment opening must be the exact centred source-width square",
  );
  assert.equal(mythicWindow.width, mythicWindow.height, "the mythic structural frame must be square");
  assert.ok(Math.abs(mythicWindow.centerX - 160) <= 0.5, "mythic opening drifts horizontally");
  assert.ok(Math.abs(mythicWindow.centerY - 160) <= 0.5, "mythic opening drifts vertically");

  const assertEightFrameAura = (png, assetPath, tierName) => {
    const aura = decodeRgbaPng(png, assetPath);
    assert.ok(aura.width >= 1024 && aura.height >= 512, `${assetPath} is too small`);
    assert.equal(aura.width % 4, 0, `${assetPath} width must divide into four columns`);
    assert.equal(aura.height % 2, 0, `${assetPath} height must divide into two rows`);
    assert.equal(
      aura.width / 4,
      aura.height / 2,
      `${assetPath} must use eight square effect cells`,
    );
    for (let row = 0; row < 2; row += 1) {
      for (let column = 0; column < 4; column += 1) {
        const cellWidth = aura.width / 4;
        const cellHeight = aura.height / 2;
        let opaquePixels = 0;
        let transparentPixels = 0;
        for (let y = row * cellHeight; y < (row + 1) * cellHeight; y += 1) {
          for (let x = column * cellWidth; x < (column + 1) * cellWidth; x += 1) {
            if (aura.pixels[(y * aura.width + x) * 4 + 3] === 0) transparentPixels += 1;
            else opaquePixels += 1;
          }
        }
        assert.ok(opaquePixels >= 100, `${tierName} aura row ${row} column ${column} is empty`);
        assert.ok(
          transparentPixels >= 100,
          `${tierName} aura row ${row} column ${column} lost transparency`,
        );
      }
    }
  };
  for (const [[tierName, assetPath], png] of auraAssets.map((entry, index) => [
    entry,
    auraPngs[index],
  ])) {
    assertEightFrameAura(png, assetPath, tierName);
  }

  assert.match(css, /url\(["']?\/assets\/ui\/inventory-sanctum-v2\.png["']?\)/);
  assert.match(css, /url\(["']?\/assets\/ui\/rarity-frames-v6\.png["']?\)/);
  assert.doesNotMatch(css, /url\(["']?\/assets\/ui\/rarity-frames\.png["']?\)/);
  for (const [tierName] of auraAssets) {
    assert.match(
      css,
      new RegExp(`url\\(["']?\\/assets\\/ui\\/inventory-rarity-aura-${tierName}-v3\\.png["']?\\)`),
    );
  }
  assert.match(css, /background-size:\s*800%\s+100%/);
  assert.match(css, /background-size:\s*400%\s+200%/);
  for (const [rarity, position] of [
    ["common", "0%"],
    ["magic", "14.286%"],
    ["superior", "28.571%"],
    ["rare", "42.857%"],
    ["epic", "57.143%"],
    ["legendary", "71.429%"],
    ["mythic", "85.714%"],
    ["cosmic", "100%"],
  ]) {
    assert.match(
      css,
      new RegExp(`\\.inventory-screen-rarity--${rarity}\\s*\\{[^}]*--inventory-rarity-frame-x:\\s*${position.replace(".", "\\.")}`),
      `${rarity} must select its own rarity-frame atlas cell`,
    );
  }

  assert.match(
    overlay,
    /item\.rarity\s*===\s*["']legendary["'][\s\S]{0,180}?["']inventory-screen-tooltip--legendary["']/,
    "legendary hover cards must opt into the dedicated spectacle class",
  );
  assert.match(
    overlay,
    /item\.rarity\s*===\s*["']mythic["'][\s\S]{0,180}?["']inventory-screen-tooltip--mythic["']/,
    "mythic hover cards must opt into their stronger spectacle class",
  );
  assert.match(
    overlay,
    /item\.rarity\s*===\s*["']cosmic["'][\s\S]{0,180}?["']inventory-screen-tooltip--cosmic["']/,
    "cosmic hover cards must opt into the dedicated spectacle class",
  );
  for (const animationName of [
    "inventory-legendary-pulse",
    "inventory-legendary-sparks",
    "inventory-legendary-border-flow",
    "inventory-mythic-pulse",
    "inventory-mythic-sparks",
    "inventory-mythic-border-flow",
    "inventory-mythic-aura-frames",
  ]) {
    assert.match(css, new RegExp(`@keyframes\\s+${animationName}\\b`));
    assert.ok(
      [...css.matchAll(new RegExp(`\\b${animationName}\\b`, "g"))].length >= 2,
      `${animationName} is declared but not connected to a legendary element`,
    );
  }
  assert.match(
    css,
    /\.inventory-screen-rarity--legendary\.inventory-screen-grid-item[\s\S]{0,900}?animation:[^;]*(?:inventory-legendary-pulse|inventory-legendary-border-flow)/,
    "legendary backpack items need an animated aura or border",
  );
  assert.match(
    css,
    /\.inventory-screen-tooltip--legendary[\s\S]{0,1200}?animation:[^;]*(?:inventory-legendary-sparks|inventory-legendary-border-flow)/,
    "the full legendary tooltip needs its own animated spectacle",
  );
  assert.match(
    css,
    /\.inventory-screen-rarity--mythic\.inventory-screen-grid-item[\s\S]{0,1200}?animation:[^;]*(?:inventory-mythic-pulse|inventory-mythic-border-flow)/,
    "mythic backpack items need a stronger animated aura or border",
  );
  assert.match(
    css,
    /\.inventory-screen-tooltip--mythic[\s\S]{0,1400}?animation:[^;]*(?:inventory-mythic-sparks|inventory-mythic-border-flow)/,
    "the full mythic tooltip needs its own high-intensity spectacle",
  );
  assert.match(
    css,
    /\.inventory-screen-tooltip--cosmic::after\s*\{[\s\S]{0,500}?box-shadow:/,
    "the cosmic tooltip needs a dedicated cyan-violet spectacle",
  );
});

test("rare and higher inventory aura frames share one exact slot-sized normalized canvas", async () => {
  const auraAssets = [
    ["rare", "public/assets/ui/inventory-rarity-aura-rare-v3.png"],
    ["epic", "public/assets/ui/inventory-rarity-aura-epic-v3.png"],
    ["legendary", "public/assets/ui/inventory-rarity-aura-legendary-v3.png"],
    ["mythic", "public/assets/ui/inventory-rarity-aura-mythic-v3.png"],
    ["cosmic", "public/assets/ui/inventory-rarity-aura-cosmic-v3.png"],
  ];
  const [css, ...auraPngs] = await Promise.all([
    readFile(path.join(root, "app/game.css"), "utf8"),
    ...auraAssets.map(([, assetPath]) => readFile(path.join(root, assetPath))),
  ]);
  const auraContractStart = css.lastIndexOf("Rare+ authored aura contract V3");
  assert.ok(auraContractStart >= 0, "the final rare+ aura geometry contract is missing");
  const auraCss = css.slice(auraContractStart);

  for (const [[tierName, assetPath], png] of auraAssets.map((entry, index) => [
    entry,
    auraPngs[index],
  ])) {
    const aura = decodeRgbaPng(png, assetPath);
    assert.deepEqual([aura.width, aura.height], [1536, 768], `${assetPath} atlas dimensions drifted`);
    const cellWidth = aura.width / 4;
    const cellHeight = aura.height / 2;
    assert.deepEqual([cellWidth, cellHeight], [384, 384], `${assetPath} must use eight square cells`);

    const frameMetrics = [];
    const frameHashes = [];
    for (let row = 0; row < 2; row += 1) {
      for (let column = 0; column < 4; column += 1) {
        const label = `${tierName} inventory aura row ${row} column ${column}`;
        const metrics = alphaCellMetrics(aura, column, row, 4, 2, label);
        const expectedCenterX = (metrics.cellWidth - 1) / 2;
        const expectedCenterY = (metrics.cellHeight - 1) / 2;

        assert.ok(
          metrics.width >= 318 && metrics.width <= 322,
          `${label} alpha width ${metrics.width}px must remain normalized to 320px`,
        );
        assert.ok(
          metrics.height >= 318 && metrics.height <= 322,
          `${label} alpha height ${metrics.height}px must remain normalized to 320px`,
        );
        assert.ok(
          Math.abs(metrics.centerX - expectedCenterX) <= 2,
          `${label} alpha center X ${metrics.centerX}px drifts more than 2px from ${expectedCenterX}px`,
        );
        assert.ok(
          Math.abs(metrics.centerY - expectedCenterY) <= 2,
          `${label} alpha center Y ${metrics.centerY}px drifts more than 2px from ${expectedCenterY}px`,
        );
        assert.ok(
          metrics.left >= 30 && metrics.right >= 30 && metrics.top >= 30 && metrics.bottom >= 30,
          `${label} needs a safe transparent gutter on every side`,
        );

        const cellLeft = column * cellWidth;
        const cellTop = row * cellHeight;
        let centerPaintedPixels = 0;
        for (let y = cellTop + 128; y < cellTop + 256; y += 1) {
          for (let x = cellLeft + 128; x < cellLeft + 256; x += 1) {
            if (aura.pixels[(y * aura.width + x) * 4 + 3] > 24) centerPaintedPixels += 1;
          }
        }
        assert.ok(
          centerPaintedPixels < 200,
          `${label} paints ${centerPaintedPixels}px into the equipment icon safe area`,
        );

        const frameHash = createHash("sha256");
        for (let y = cellTop; y < cellTop + cellHeight; y += 1) {
          const start = (y * aura.width + cellLeft) * 4;
          frameHash.update(aura.pixels.subarray(start, start + cellWidth * 4));
        }
        frameHashes.push(frameHash.digest("hex"));
        frameMetrics.push(metrics);
      }
    }
    assert.equal(
      new Set(frameHashes).size,
      8,
      `${tierName} must contain eight genuinely different authored animation frames`,
    );

    const widthSpread =
      Math.max(...frameMetrics.map((metrics) => metrics.width)) -
      Math.min(...frameMetrics.map((metrics) => metrics.width));
    const heightSpread =
      Math.max(...frameMetrics.map((metrics) => metrics.height)) -
      Math.min(...frameMetrics.map((metrics) => metrics.height));
    const maximumSpread = 4;
    assert.ok(
      widthSpread <= maximumSpread,
      `${tierName} aura frame widths vary by ${widthSpread}px; the normalized limit is ${maximumSpread}px`,
    );
    assert.ok(
      heightSpread <= maximumSpread,
      `${tierName} aura frame heights vary by ${heightSpread}px; the normalized limit is ${maximumSpread}px`,
    );

    assert.match(
      auraCss,
      new RegExp(`\\.inventory-screen-rarity-aura--${tierName}\\s*\\{[^}]*inventory-rarity-aura-${tierName}-v3\\.png`),
      `${tierName} atlas must be selected by the dedicated aura element`,
    );
  }

  assert.match(auraCss, /\.inventory-screen-rarity-aura\s*\{[\s\S]{0,500}?inset:\s*-10%;[\s\S]{0,260}?background-size:\s*400%\s+200%;/);
  assert.match(auraCss, /\.inventory-screen-rarity-aura--legendary\s*\{[^}]*duration:\s*780ms;[^}]*opacity:\s*1;/);
  assert.match(auraCss, /@keyframes\s+inventory-rarity-aura-frames-v3\s*\{[\s\S]{0,620}?87\.5%,\s*100%\s*\{\s*background-position:\s*100%\s+100%;/);
});

test("the inventory uses a fixed front-facing illustrated mannequin with all ten live gear cells", async () => {
  const assetPath = "public/assets/ui/inventory-portrait/mannequin-base-v1.png";
  const fittedAssetPath = "public/assets/ui/inventory-portrait/fitted-armor-v1.png";
  const equipmentUrl = await typeScriptModuleUrl("app/equipment.ts");
  const [png, fittedPng, overlay, portrait, portraitSource, css, equipment, portraitModule, prompt] = await Promise.all([
    readFile(path.join(root, assetPath)),
    readFile(path.join(root, fittedAssetPath)),
    readFile(path.join(root, "app/InventoryOverlay.tsx"), "utf8"),
    readFile(path.join(root, "app/InventoryPaperdollFigure.tsx"), "utf8"),
    readFile(path.join(root, "app/inventory-paperdoll-portrait.ts"), "utf8"),
    readFile(path.join(root, "app/game.css"), "utf8"),
    import(equipmentUrl),
    importTypeScriptModule("app/inventory-paperdoll-portrait.ts", {
      "./equipment": equipmentUrl,
    }),
    readFile(
      path.join(root, "asset-sources/imagegen/inventory-portrait-mannequin-v1.prompt.json"),
      "utf8",
    ).then(JSON.parse),
  ]);

  const figure = decodeRgbaPng(png, assetPath);
  assert.deepEqual([figure.width, figure.height], [1024, 1536]);
  const margins = alphaCellMetrics(figure, 0, 0, 1, 1, "inventory portrait mannequin");
  assert.ok(margins.left >= 140, `mannequin left alpha gutter is ${margins.left}px`);
  assert.ok(margins.right >= 140, `mannequin right alpha gutter is ${margins.right}px`);
  assert.ok(margins.top >= 20, `mannequin top alpha gutter is ${margins.top}px`);
  assert.ok(margins.bottom >= 35, `mannequin bottom alpha gutter is ${margins.bottom}px`);
  for (const [x, y] of [[0, 0], [figure.width - 1, 0], [0, figure.height - 1], [figure.width - 1, figure.height - 1]]) {
    assert.equal(figure.pixels[(y * figure.width + x) * 4 + 3], 0, "mannequin corners must remain transparent");
  }
  assert.equal(prompt.generator, "OpenAI built-in image_gen");
  assert.equal(prompt.postprocess.totalPixels, 1024 * 1536);
  const fittedFigure = decodeRgbaPng(fittedPng, fittedAssetPath);
  assert.deepEqual([fittedFigure.width, fittedFigure.height], [941, 1672]);
  for (const [x, y] of [[0, 0], [fittedFigure.width - 1, 0], [0, fittedFigure.height - 1], [fittedFigure.width - 1, fittedFigure.height - 1]]) {
    assert.equal(fittedFigure.pixels[(y * fittedFigure.width + x) * 4 + 3], 0, "fitted armor corners must remain transparent");
  }
  assert.equal(prompt.fittedArmorPostprocess.totalPixels, 941 * 1672);

  assert.match(
    overlay,
    /<InventoryPaperdollFigure equipment=\{equipment\} \/>/,
    "the inventory center portrait must consume the live ten-slot equipment loadout",
  );
  assert.match(portrait, /data-portrait-mode="illustrated"/);
  assert.match(portrait, /INVENTORY_PORTRAIT_BASE_PATH/);
  assert.match(portrait, /INVENTORY_PORTRAIT_FITTED_ARMOR_PATH/);
  assert.match(portrait, /inventoryPortraitPieces\(equipment\)/);
  assert.match(portrait, /role="img"[\s\S]{0,120}?aria-label=\{portraitLabel\}/);
  assert.doesNotMatch(portrait, /character-paperdoll|drawPaperdollCharacter|<canvas|requestAnimationFrame/);
  assert.doesNotMatch(portraitSource, /character-paperdoll|PAPERDOLL_DIRECTION|PORTRAIT_IDLE_FRAME/);
  assert.match(portraitSource, /equipment-types-v4\.png/);
  assert.match(portraitSource, /inventory-portrait\/fitted-armor-v1\.png/);
  assert.match(css, /\.inventory-screen-paperdoll-stage\s*\{[\s\S]{0,260}?aspect-ratio:\s*2\s*\/\s*3/);
  assert.match(css, /\.inventory-screen-paperdoll-base\s*\{[\s\S]{0,360}?background-size:\s*contain/);
  assert.match(css, /\.inventory-screen-paperdoll-piece\s*\{[\s\S]{0,260}?aspect-ratio:\s*1/);
  assert.match(css, /\.inventory-screen-paperdoll-fitted-layer--armor\s*\{[\s\S]{0,180}?clip-path:\s*polygon/);
  assert.match(css, /\.inventory-screen-paperdoll-fitted-layer--gloves-right\s*\{[\s\S]{0,180}?clip-path:\s*polygon/);
  assert.doesNotMatch(css, /\.inventory-screen-paperdoll-figure\.is-ready::before\s*\{[^}]*opacity:\s*0/);

  assert.deepEqual(
    [...portraitModule.INVENTORY_PORTRAIT_SLOT_ORDER].sort(),
    [...equipment.EQUIPMENT_SLOTS].sort(),
    "the illustration compositor must cover every equipment slot exactly once",
  );
  for (const [slotIndex, slot] of equipment.EQUIPMENT_SLOTS.entries()) {
    const geometry = portraitModule.INVENTORY_PORTRAIT_SLOT_GEOMETRY[slot];
    assert.ok(geometry.left >= -5 && geometry.left + geometry.width <= 105, `${slot} horizontal placement escapes the portrait safe area`);
    assert.ok(geometry.top >= -3 && geometry.top + geometry.width * (2 / 3) <= 115, `${slot} vertical placement escapes the portrait safe area`);
    for (let row = 0; row < equipment.GEAR_ICON_ROWS; row += 1) {
      const item = {
        id: `${slot}-${row}`,
        slot,
        iconIndex: row * equipment.GEAR_ICON_COLUMNS + slotIndex,
        rarity: "common",
        enhancement: 0,
      };
      const piece = portraitModule.resolveInventoryPortraitPiece(slot, item);
      assert.equal(piece.column, slotIndex, `${slot} row ${row} atlas column drifted`);
      assert.equal(piece.row, row, `${slot} row ${row} atlas row drifted`);
      assert.equal(piece.geometry, geometry);
    }
  }
});

test("tight inventory chrome and control assets keep safe alpha margins and individual CSS consumers", async () => {
  const assetConsumers = [
    ["inventory-chrome/section-title.png", ".inventory-screen-section-heading h3::before"],
    ["inventory-chrome/resource-counter.png", ".inventory-screen-header-resources::after"],
    ["inventory-chrome/positive-badge.png", ".inventory-screen-grid-delta--positive::before"],
    ["inventory-chrome/negative-badge.png", ".inventory-screen-grid-delta--negative::before"],
    ["inventory-chrome/neutral-badge.png", ".inventory-screen-grid-delta--neutral::before"],
    ["inventory-chrome/primary-button.png", ".inventory-screen-equip-button::before"],
    ["inventory-chrome/destructive-button.png", ".inventory-screen-salvage-button::before"],
    ["inventory-controls/multi-select.png", ".inventory-screen-batch-mode-button::after"],
    ["inventory-controls/close.png", ".inventory-screen-close"],
    ["inventory-controls/selected-corners.png", ".inventory-screen-item--selected"],
    ["inventory-controls/memory-ash.png", ".inventory-screen-ash-icon"],
    ["inventory-controls/keycap.png", ".inventory-screen-footer kbd"],
    ["inventory-controls/divider.png", ".inventory-screen-section-heading::after"],
  ];
  const assetRoot = "public/assets/ui";
  const [css, ...pngs] = await Promise.all([
    readFile(path.join(root, "app/game.css"), "utf8"),
    ...assetConsumers.map(([assetPath]) => readFile(path.join(root, assetRoot, assetPath))),
  ]);

  const ruleBodiesFor = (selector) => {
    const bodies = [];
    for (const rule of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const selectors = rule[1].split(",").map((candidate) => candidate.trim());
      if (selectors.includes(selector)) bodies.push(rule[2]);
    }
    return bodies;
  };

  for (const [[assetPath, selector], png] of assetConsumers.map((entry, index) => [
    entry,
    pngs[index],
  ])) {
    const relativePath = `${assetRoot}/${assetPath}`;
    const image = decodeRgbaPng(png, relativePath);
    const metrics = alphaCellMetrics(image, 0, 0, 1, 1, relativePath);
    for (const side of ["left", "right", "top", "bottom"]) {
      assert.ok(
        metrics[side] >= 6,
        `${relativePath} clips or nearly clips its ${side} edge (${metrics[side]}px)`,
      );
      assert.ok(
        metrics[side] <= 16,
        `${relativePath} is not tightly extracted on its ${side} edge (${metrics[side]}px)`,
      );
    }
    assert.ok(image.width >= 100 && image.height >= 100, `${relativePath} is unexpectedly small`);
    assert.ok(image.width <= 700 && image.height <= 500, `${relativePath} is unexpectedly large`);

    const consumerRules = ruleBodiesFor(selector);
    assert.ok(consumerRules.length > 0, `${selector} needs a CSS rule`);
    assert.ok(
      consumerRules.some((body) => body.includes(`/assets/ui/${assetPath}`)),
      `${selector} must reference its individual tight asset /assets/ui/${assetPath}`,
    );
  }

  for (const tierName of ["legendary", "mythic"]) {
    const tooltipSelector = `.inventory-screen-tooltip--${tierName}::after`;
    const tooltipRules = ruleBodiesFor(tooltipSelector);
    assert.ok(tooltipRules.length > 0, `${tooltipSelector} needs an authored spectacle rule`);
    let effectiveBackground = "";
    for (const body of tooltipRules) {
      for (const declaration of body.matchAll(/\bbackground(?:-image)?:\s*([^;]+);/g)) {
        effectiveBackground = declaration[1].trim();
      }
    }
    assert.ok(effectiveBackground, `${tooltipSelector} must declare its final background treatment`);
    assert.doesNotMatch(
      effectiveBackground,
      /inventory-(?:legendary|mythic)-aura\.png/,
      `${tooltipSelector} must not stretch the square slot aura across a rectangular tooltip`,
    );
  }

  const unifiedFont =
    'font-family: "Noto Serif KR", "Nanum Myeongjo", Batang, serif !important;';
  assert.match(
    css,
    /\.inventory-screen,\s*\.inventory-screen \*,\s*\.inventory-screen-tooltip,\s*\.inventory-screen-tooltip \*\s*\{[^}]*font-family:\s*"Noto Serif KR",\s*"Nanum Myeongjo",\s*Batang,\s*serif\s*!important;/,
    "all inventory text and controls must resolve to one scoped serif family",
  );
  assert.ok(
    css.lastIndexOf(unifiedFont) > css.lastIndexOf("font-family: Arial"),
    "the unified serif override must win over the legacy close-icon font",
  );
});

test("the enhancement workbench uses a native ultra-wide plate instead of stretching general button chrome", async () => {
  const assetPath = "public/assets/ui/inventory-chrome/enhancement-button-v1.png";
  const reportPath = "public/assets/ui/inventory-chrome/enhancement-button-v1.build.json";
  const promptPath = "asset-sources/imagegen/inventory-enhancement-button-v1.prompt.json";
  const [png, css, reportSource, promptSource] = await Promise.all([
    readFile(path.join(root, assetPath)),
    readFile(path.join(root, "app/game.css"), "utf8"),
    readFile(path.join(root, reportPath), "utf8"),
    readFile(path.join(root, promptPath), "utf8"),
  ]);
  const image = decodeRgbaPng(png, assetPath);
  const report = JSON.parse(reportSource);
  const prompt = JSON.parse(promptSource);

  assert.deepEqual([image.width, image.height], [1435, 111]);
  const metrics = alphaCellMetrics(image, 0, 0, 1, 1, assetPath);
  assert.ok(
    metrics.width / metrics.height >= 13 && metrics.width / metrics.height <= 14,
    `authored plaque aspect is ${(metrics.width / metrics.height).toFixed(3)}:1`,
  );
  for (const side of ["left", "right", "top", "bottom"]) {
    assert.ok(metrics[side] >= 2, `${assetPath} clips its ${side} edge`);
    assert.ok(metrics[side] <= 4, `${assetPath} has a loose ${side} gutter`);
  }

  let hiddenRgbPixels = 0;
  let greenFringePixels = 0;
  for (let offset = 0; offset < image.pixels.length; offset += 4) {
    const red = image.pixels[offset];
    const green = image.pixels[offset + 1];
    const blue = image.pixels[offset + 2];
    const alpha = image.pixels[offset + 3];
    if (alpha === 0 && (red !== 0 || green !== 0 || blue !== 0)) hiddenRgbPixels += 1;
    if (alpha >= 16 && green - red >= 48 && green - blue >= 48) greenFringePixels += 1;
  }
  assert.equal(hiddenRgbPixels, 0, "transparent pixels must not retain hidden RGB");
  assert.equal(greenFringePixels, 0, "the chroma-key source must not leave a green fringe");

  assert.equal(prompt.asset, "inventory-enhancement-button-v1");
  assert.equal(prompt.tool, "built-in image_gen");
  assert.equal(prompt.prompts.length, 3);
  assert.equal(report.asset, prompt.asset);
  assert.equal(report.pipeline.resampling, "none; native-ratio crop");
  assert.equal(report.qa.greenFringePixels, 0);
  assert.equal(report.outputs[0].path, assetPath);
  assert.equal(
    report.outputs[0].sha256,
    createHash("sha256").update(png).digest("hex"),
    "the QA report must describe the shipped PNG exactly",
  );

  const sharedPrimaryIndex = css.lastIndexOf(
    'border-image: url("/assets/ui/inventory-chrome/primary-button.png")',
  );
  const dedicatedEnhancementIndex = css.lastIndexOf(
    'border-image: url("/assets/ui/inventory-chrome/enhancement-button-v1.png")',
  );
  assert.ok(sharedPrimaryIndex >= 0, "the general equip button must retain its primary plate");
  assert.ok(
    dedicatedEnhancementIndex > sharedPrimaryIndex,
    "the dedicated enhancement plate must override the general primary plate",
  );
  assert.match(
    css,
    /\.inventory-screen-enhancement-button::before\s*\{\s*border-image:\s*url\("\/assets\/ui\/inventory-chrome\/enhancement-button-v1\.png"\)\s+27%\s+4%\s+27%\s+4%\s+fill\s*\/\s*10px\s+13px\s*\/\s*0\s+stretch;/,
  );
});
