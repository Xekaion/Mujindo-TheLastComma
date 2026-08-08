import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { inflateSync } from "node:zlib";
import ts from "typescript";

const root = process.cwd();

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

  assert.equal((source.match(/room\?\.kind === "boss"/g) ?? []).length, 2);
  assert.match(source, /className="map-room-emblem map-room-emblem--boss"/);
  assert.match(source, /className="map-room-emblem map-room-emblem--boss"[\s\S]{0,80}?aria-hidden="true"/);
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

function alphaRectMetrics(image, left, top, width, height, label) {
  assert.ok(Number.isInteger(left) && Number.isInteger(top), `${label} needs integer coordinates`);
  assert.ok(Number.isInteger(width) && width > 0, `${label} needs a positive integer width`);
  assert.ok(Number.isInteger(height) && height > 0, `${label} needs a positive integer height`);
  assert.ok(left >= 0 && top >= 0, `${label} starts outside its atlas`);
  assert.ok(left + width <= image.width, `${label} exceeds the atlas width`);
  assert.ok(top + height <= image.height, `${label} exceeds the atlas height`);

  let opaquePixels = 0;
  let minimumX = left + width;
  let maximumX = left - 1;
  let minimumY = top + height;
  let maximumY = top - 1;
  for (let y = top; y < top + height; y += 1) {
    for (let x = left; x < left + width; x += 1) {
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
    left: minimumX - left,
    right: left + width - 1 - maximumX,
    top: minimumY - top,
    bottom: top + height - 1 - maximumY,
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

async function importTypeScriptModule(relativePath) {
  const source = await readFile(path.join(root, relativePath), "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: relativePath,
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(output).toString("base64")}`);
}

class MemoryStorage {
  #items = new Map();

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

const sampleSave = {
  savedAt: 1_753_000_000_000,
  player: {
    level: 12,
    rooms: 27,
    augments: { fang: 20, haste: 7 },
    profession: "fang",
  },
  world: {
    seed: 42,
    roomX: 5,
    roomY: 0,
    rooms: { "5,0": { kind: "shelter", cleared: true } },
    visited: ["5,0"],
  },
  stableAugments: { fang: 20, haste: 7 },
};

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
  const catalog = source.match(/const AUGMENTS: Augment\[\] = \[([\s\S]*?)\n\];\n\nconst SYNERGIES/);
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
  assert.match(source, /const executionThreshold = Math\.min\(0\.4/);
  assert.match(source, /Math\.pow\(1 \+ armorRank \* 0\.1, 0\.62\)/);
  assert.match(source, /player\.hp \+ regenerationRank \* 0\.14 \* dt/);
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
  const catalog = source.match(/const AUGMENTS: Augment\[\] = \[([\s\S]*?)\n\];\n\nconst SYNERGIES/);
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

test("opening basic attacks defeat common enemies in two unmodified hits", async () => {
  const [combatBalance, source] = await Promise.all([
    importTypeScriptModule("app/combat-balance.ts"),
    readFile(path.join(root, "app/GameCanvas.tsx"), "utf8"),
  ]);

  assert.equal(combatBalance.BASE_PLAYER_ATTACK_DAMAGE, 14);
  assert.equal(Math.ceil(24 / combatBalance.BASE_PLAYER_ATTACK_DAMAGE), 2);
  assert.equal(Math.ceil(28 / combatBalance.BASE_PLAYER_ATTACK_DAMAGE), 2);
  assert.ok(
    combatBalance.BASE_PLAYER_ATTACK_DAMAGE * 1.7 < 24,
    "the five-percent opening critical roll must not randomly one-shot even the weakest enemy",
  );
  assert.match(source, /import \{ BASE_PLAYER_ATTACK_DAMAGE \} from "\.\/combat-balance";/);
  assert.match(source, /let damage =\s*BASE_PLAYER_ATTACK_DAMAGE \*/);
  assert.match(source, /const riftDamage =\s*BASE_PLAYER_ATTACK_DAMAGE \*/);
  assert.match(source, /const resonanceDamage =\s*BASE_PLAYER_ATTACK_DAMAGE \*/);
  assert.doesNotMatch(source, /let damage =\s*12 \*/);
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
    /const owned = available\.filter[\s\S]{0,160}?const unowned = available\.filter[\s\S]{0,160}?const pool = \[\.\.\.owned, \.\.\.owned, \.\.\.unowned\]/,
    "owned and unowned choice pools must both derive only from uncapped augments",
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
    /augments: normalizeAugmentStacks\(data\.player\.augments\)[\s\S]{0,1600}?stableAugmentsRef\.current = normalizeAugmentStacks\(/,
    "loading must normalize both volatile and shelter-stable augment ledgers",
  );
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
  assert.equal(saves.readSaveSlotSummaries(storage)[1].augmentStacks, 27);
  const gearSave = structuredClone(sampleSave);
  const rolledWeapon = equipment.rollGear("save-slot-gear", {
    level: 12,
    slot: "weapon",
    rarity: "legendary",
  });
  const weapon = equipment.normalizeGearItem({ ...rolledWeapon, enhancement: 7 });
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
  assert.equal(roster.bossKindForProgress(2, 2), 5);
  assert.equal(roster.bossKindForProgress(2, 3), 9);
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
    /if \(kind === "boss"\) \{[\s\S]{0,420}?bossKindForProgress\([\s\S]{0,120}?player\.endingVersion,[\s\S]{0,120}?clearedBossRooms[\s\S]{0,160}?makeEnemy\(bossKind,/,
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
  assert.match(bossRoom[1], /const bossKind = bossKindForProgress\(/);
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
  assert.match(source, /data-boss-pattern=\{hud\.world\.bossPattern \?\? hud\.world\.binderPattern \?\? "none"\}/);
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
  assert.match(source, /const boss = world\.enemies\.find\(\(enemy\) => isBossKind\(enemy\.kind\)\);/);
  assert.match(source, /const dropCount = isBossKind\(enemy\.kind\) \? 2 : 1;/);

  const controller = source.match(
    /else if \(enemy\.kind === FINAL_BINDER_KIND\) \{([\s\S]*?)\n\s*\} else if \(enemy\.kind === 6\) \{/,
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

  assert.match(
    source,
    /const shelterActivated\s*=\s*isFirstShelterRest\(kind, world\.visitedLookup\[key\] === true\);[\s\S]{0,500}?if \(!world\.visitedLookup\[key\]\)/,
    "the first-visit decision must be captured before the coordinate enters the visited ledger",
  );
  assert.match(
    source,
    /if \(kind === "shelter"\) \{\s*if \(shelterActivated\) \{\s*saveAtShelter\(\);\s*setGameMode\("shelter"\);\s*\} else \{\s*setToast\(SPENT_SHELTER_MESSAGE\);/,
    "only a fresh shelter may save and open the rest modal",
  );
  assert.match(source, /const saveAtShelter[\s\S]{0,180}?player\.hp = player\.maxHp;/);
  assert.match(
    source,
    /enterRoom\(data\.world\.roomX, data\.world\.roomY, "left"\);\s*setGameMode\("playing"\);\s*setToast\(`\$\{slot\}번 슬롯 · 고정된 기억에서 원정을 재개했습니다\.`\);/,
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
    ["public/assets/walk/margin-severer-walk-v1.png", [1024, 1536]],
    ["public/assets/walk/final-binder-walk-v1.png", [1024, 1536]],
    ["public/assets/walk/harin-equipped-v3.png", [1024, 1536]],
    ["public/assets/effects/summon-rift.png", [1024, 1024]],
    ["public/assets/effects/teleport-rift.png", [1024, 1024]],
    ["public/assets/effects/proofreader-telegraph.png", [1536, 1024]],
    ["public/assets/effects/time-stalker-rift-warning-v1.png", [1254, 1254]],
    ["public/assets/effects/time-stalker-rift-burst-v1.png", [1254, 1254]],
    ["public/assets/effects/margin-sever-line-v1.png", [1254, 1254]],
    ["public/assets/effects/final-binder-patterns-v1.png", [1254, 1254]],
    ["public/assets/equipment/equipment-types-v4.png", [2800, 2800]],
    ["public/assets/equipment/equipment-icons-expanded.png", [1400, 1120]],
    ["public/assets/effects/loot-awakening.png", [1600, 800]],
    ["public/assets/effects/loot-cosmic-awakening.png", [1536, 768]],
    ["public/assets/equipment/paperdoll-equipment.png", [1000, 1536]],
    ["public/assets/ui/rarity-frames.png", [2560, 320]],
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
    /enemy\.kind === 6\s*\?\s*192[\s\S]{0,520}?enemy\.kind === 6\s*\?\s*144/,
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
    /TIME_STALKER_DIRECTION_FRAMES,[\s\S]{0,400}?MARGIN_SEVERER_DIRECTION_FRAMES,[\s\S]{0,320}?makeDirectionFrames\(\[0, 1, 2, 3, 4, 5, 6, 7\]\),[\s\S]{0,40}?\];/,
    "the canonical Time Stalker direction map must occupy kind 7's frame slot",
  );
  assert.match(
    source,
    /enemy\.kind === 7 \? false : directionFrame\.flipX/,
    "kind 7 must never be mirrored at draw time",
  );
  assert.match(
    source,
    /const hpBases = \[[\s\S]{0,260}?BLANK_CARTOGRAPHER_BASE_HP,[\s\S]{0,80}?58,[\s\S]{0,80}?92,[\s\S]{0,80}?68,[\s\S]{0,80}?FINAL_BINDER_BASE_HP,[\s\S]{0,40}?\];[\s\S]{0,260}?const speedBases = \[76, 50, 43, 26, 62, 38, 72, 66, 58, FINAL_BINDER_BASE_SPEED\];/,
    "kind 7 needs explicit health and movement stats",
  );
  assert.match(
    source,
    /:\s*\[0, 1, 2, 3, 4, 6, 7, MARGIN_SEVERER_KIND\];/,
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
  assert.deepEqual(balance.MARGIN_SEVERER_WALK_ROW_CROPS, [
    { y: 0, height: 220 },
    { y: 220, height: 215 },
    { y: 435, height: 200 },
    { y: 635, height: 208 },
    { y: 843, height: 200 },
    { y: 1043, height: 205 },
    { y: 1248, height: 204 },
  ]);

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
  assert.equal(hpBases.length, 10, "every enemy kind needs an aligned health entry");
  assert.equal(speedBases.length, 10, "every enemy kind needs an aligned speed entry");
  assert.equal(damageBases.length, 10, "every enemy kind needs an aligned damage entry");
  assert.equal(radii.length, 10, "every enemy kind needs an aligned radius entry");
  assert.deepEqual(
    [hpBases[8], speedBases[8], damageBases[8], radii[8]],
    ["68", "58", "11", "23"],
    "kind 8 must retain its complete authored stat row",
  );
  assert.match(
    makeEnemy,
    /kind === 7 \|\| kind === MARGIN_SEVERER_KIND[\s\S]{0,80}?\? ["']orbit["']/,
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
  assert.equal(unlockedPools.length, 2, "both post-unlock normal pools must include kind 8");
  assert.ok(unlockedPools[1].includes("7"), "the deepest pool must retain the Time Stalker");
  const roomLimitStart = spawnRoom.indexOf("if (enemyKind === MARGIN_SEVERER_KIND)");
  const roomLimitEnd = spawnRoom.indexOf("const elite =", roomLimitStart);
  assert.ok(roomLimitStart >= 0 && roomLimitEnd > roomLimitStart, "the room cap guard is missing");
  const roomLimit = spawnRoom.slice(roomLimitStart, roomLimitEnd);
  assert.match(roomLimit, /marginSevererCount >= MARGIN_SEVERER_MAX_PER_ROOM/);
  assert.match(roomLimit, /enemyKind =\s*hash\([^;]+\) < 0\.5 \? 2 : 4;/);
  assert.match(roomLimit, /else \{\s*marginSevererCount \+= 1;/);

  const controllerStart = source.indexOf("} else if (enemy.kind === MARGIN_SEVERER_KIND) {");
  const controllerEnd = source.indexOf("\n        } else {\n          let movement = 1;", controllerStart);
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
    'drawProjectileVfx(projectile, ambientTime, world.projectiles.length, "trail")',
    floorDrawIndex,
  );
  const actorDrawIndex = source.indexOf("const sortedEnemies = [...world.enemies]", floorDrawIndex);
  assert.ok(
    floorDrawIndex >= 0 && projectileTrailIndex > floorDrawIndex && actorDrawIndex > floorDrawIndex,
    "the visible collision seam must render on the floor before projectiles and actors",
  );
});

test("the Margin Severer walk and sever atlases remain cropped, chroma-clean, and fully wired", async () => {
  const [balance, source] = await Promise.all([
    importTypeScriptModule("app/enemy-balance.ts"),
    readFile(path.join(root, "app/GameCanvas.tsx"), "utf8"),
  ]);
  const walkPath = "public/assets/walk/margin-severer-walk-v1.png";
  const linePath = "public/assets/effects/margin-sever-line-v1.png";
  const [walk, lineEffect] = await Promise.all([
    readFile(path.join(root, walkPath)).then((png) => decodeRgbaPng(png, walkPath)),
    readFile(path.join(root, linePath)).then((png) => decodeRgbaPng(png, linePath)),
  ]);

  assert.deepEqual([walk.width, walk.height], [1024, 1536]);
  assert.equal(walk.width % 4, 0, "the walk sheet must retain four animation columns");
  assert.equal(balance.MARGIN_SEVERER_WALK_ROW_CROPS.length, 7);
  let previousCropEnd = 0;
  for (const [row, crop] of balance.MARGIN_SEVERER_WALK_ROW_CROPS.entries()) {
    assert.equal(crop.y, previousCropEnd, `walk row ${row} must begin after the prior authored row`);
    previousCropEnd = crop.y + crop.height;
    for (let column = 0; column < 4; column += 1) {
      const label = `margin severer row ${row} column ${column}`;
      const metrics = alphaRectMetrics(walk, column * 256, crop.y, 256, crop.height, label);
      assert.ok(metrics.opaquePixels >= 8_000, `${label} lacks a complete silhouette`);
      assert.ok(metrics.width >= 95 && metrics.height >= 165, `${label} is undersized`);
      assert.ok(metrics.left >= 16 && metrics.right >= 16, `${label} needs horizontal crop safety`);
      assert.ok(metrics.top >= 8 && metrics.bottom >= 8, `${label} needs vertical crop safety`);
    }
  }
  assert.ok(previousCropEnd < walk.height, "the custom rows must leave a guarded atlas tail");
  for (let y = previousCropEnd; y < walk.height; y += 1) {
    for (let x = 0; x < walk.width; x += 1) {
      assert.equal(
        walk.pixels[(y * walk.width + x) * 4 + 3],
        0,
        "pixels outside the seven exported row crops must remain transparent",
      );
    }
  }
  assert.equal(countGreenChromaPixels(walk), 0, `${walkPath} retains green-screen contamination`);

  assert.match(
    source,
    /walkMarginSeverer:\s*["']\/assets\/walk\/margin-severer-walk-v1\.png["']/,
    "the authored walk sheet must be preloaded",
  );
  assert.match(
    source,
    /const MARGIN_SEVERER_DIRECTION_FRAMES = makeDirectionFrames\(\s*\[0, 1, 2, 3, 4, 5, 6, 1\],\s*\[false, false, false, false, false, false, false, true\],?\s*\);/,
    "only the absent southeast pose may mirror the authored southwest row",
  );
  assert.match(
    source,
    /MARGIN_SEVERER_DIRECTION_FRAMES,[\s\S]{0,320}?makeDirectionFrames\(\[0, 1, 2, 3, 4, 5, 6, 7\]\),[\s\S]{0,40}?\];/,
    "kind 8 must own the ninth enemy direction-table slot",
  );
  assert.match(
    source,
    /images\[WALK_IMAGE_KEYS\[enemy\.kind\]\][\s\S]{0,320}?directionFrame\.flipX,[\s\S]{0,120}?enemy\.kind === MARGIN_SEVERER_KIND\s*\? MARGIN_SEVERER_WALK_ROW_CROPS\[directionFrame\.row\]/,
    "runtime rendering must apply both the SE mirror and the exported custom row crop",
  );

  assert.deepEqual([lineEffect.width, lineEffect.height], [1254, 1254]);
  assert.equal(lineEffect.width % 2, 0);
  assert.equal(lineEffect.height % 2, 0);
  for (let row = 0; row < 2; row += 1) {
    for (let column = 0; column < 2; column += 1) {
      const label = `margin sever line row ${row} column ${column}`;
      const metrics = alphaCellMetrics(lineEffect, column, row, 2, 2, label);
      assert.ok(metrics.opaquePixels >= 6_000, `${label} lacks its authored line effect`);
      assert.ok(metrics.width >= 500, `${label} must span most of its animation cell`);
      assert.ok(metrics.height >= 50, `${label} is too thin to remain legible in play`);
      assert.ok(metrics.left >= 20 && metrics.right >= 20, `${label} needs safe horizontal padding`);
      assert.ok(metrics.top >= 180 && metrics.bottom >= 180, `${label} needs safe vertical padding`);
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

  assert.match(
    source,
    /marginSeverLine:\s*["']\/assets\/effects\/margin-sever-line-v1\.png["']/,
    "the four-frame sever effect must be preloaded",
  );
  const rendererStart = source.indexOf("const drawMarginSeverLine = (");
  const rendererEnd = source.indexOf("const drawTimeRiftSprite = (", rendererStart);
  const renderer = source.slice(rendererStart, rendererEnd);
  assert.match(
    renderer,
    /phase === ["']inscribe["']\s*\? Math\.min\(1, Math\.floor\(progress \* 2\)\)\s*:\s*progress < 0\.88\s*\? 2\s*:\s*3/,
    "telegraph frames 0-1 and active frames 2-3 must remain phase-separated",
  );
  assert.match(renderer, /const sourceWidth = image\.naturalWidth \/ 2;/);
  assert.match(renderer, /const sourceHeight = image\.naturalHeight \/ 2;/);
  assert.match(renderer, /const column = frameIndex % 2;\s*const row = Math\.floor\(frameIndex \/ 2\);/);
  assert.match(
    renderer,
    /context\.drawImage\(\s*image,\s*column \* sourceWidth,\s*row \* sourceHeight,\s*sourceWidth,\s*sourceHeight,/,
    "the renderer must crop all four cells instead of sampling the whole atlas",
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

test("gear option text keeps two decimals and exposes the exact enhancement contribution", async () => {
  const equipment = await importTypeScriptModule("app/equipment.ts");

  assert.equal(equipment.formatGearNumericValue(12.345), "12.35");
  assert.equal(equipment.formatGearNumericValue(-12.345), "-12.35");
  assert.equal(equipment.formatGearNumericValue(-0.001), "0.00");
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
  const item = { rarity: "rare", enhancement: 3 };
  const display = equipment.getGearAffixDisplay(affix, item);
  assert.deepEqual(
    {
      totalValue: display.totalValue,
      baseValue: display.baseValue,
      enhancementValue: display.enhancementValue,
      nextStageGainValue: display.nextStageGainValue,
    },
    {
      totalValue: 13,
      baseValue: 10,
      enhancementValue: 3,
      nextStageGainValue: 1,
    },
  );
  assert.equal(display.totalLabel, equipment.formatEnhancedGearAffix(item, affix));
  assert.match(display.totalLabel, /\+13\.00%$/);
  assert.match(display.baseLabel, /\+10\.00%$/);
  assert.match(display.enhancementLabel, /\+3\.00%p$/);
  assert.match(display.nextStageGainLabel, /\+1\.00%p$/);

  const reductionDisplay = equipment.getGearAffixDisplay(
    { ...affix, stat: "damageReductionPercent" },
    item,
  );
  assert.match(reductionDisplay.totalLabel, /-13\.00%$/);
  assert.match(reductionDisplay.baseLabel, /-10\.00%$/);
  assert.match(reductionDisplay.enhancementLabel, /-3\.00%p$/);
  assert.doesNotMatch(
    [
      display.totalLabel,
      display.baseLabel,
      display.enhancementLabel,
      display.nextStageGainLabel,
      equipment.getGearAffixDisplay(
        { ...affix, stat: "damageReductionPercent" },
        { rarity: "common", enhancement: 0 },
      ).enhancementLabel,
      equipment.formatGearNumericValue(-0),
    ].join(" "),
    /-0\.00/,
    "rounded zero must never surface as negative zero",
  );
});

test("comprehensive equipment power models every live stat, runtime caps, and multiplicative synergy", async () => {
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
    qualityScore: 100,
    powerScore: 1,
  });
  const loadoutOf = (...items) => {
    const loadout = equipment.createEmptyEquipment();
    for (const item of items) loadout[item.slot] = item;
    return loadout;
  };
  const scoreStat = (stat, value) => {
    const slot = equipment.GEAR_AFFIX_DEFINITIONS[stat].slots[0];
    return equipment.calculateEquipmentCombatPower(
      loadoutOf(makeItem({ slot, stat, value })),
    );
  };

  const emptyPower = equipment.calculateEquipmentCombatPower(
    equipment.createEmptyEquipment(),
  );
  assert.equal(emptyPower, 1_000, "the documented equipment-only baseline must remain stable");

  const monotonicRanges = {
    damagePercent: [20, 80],
    attackSpeedPercent: [20, 80],
    projectileSpeedPercent: [50, 150],
    maxHpFlat: [50, 200],
    damageReductionPercent: [15, 45],
    moveSpeedPercent: [20, 80],
    dashCooldownPercent: [30, 100],
    pickupRadiusPercent: [100, 500],
    xpGainPercent: [20, 100],
    critChancePercent: [15, 50],
    critDamagePercent: [50, 200],
    projectileSizePercent: [50, 140],
    eliteDamagePercent: [50, 200],
    lifeOnHitFlat: [5, 15],
    gearFindPercent: [50, 150],
  };
  assert.deepEqual(Object.keys(monotonicRanges), equipment.GEAR_AFFIX_STATS);
  for (const stat of equipment.GEAR_AFFIX_STATS) {
    const [lowerValue, higherValue] = monotonicRanges[stat];
    const lowerPower = scoreStat(stat, lowerValue);
    const higherPower = scoreStat(stat, higherValue);
    assert.ok(lowerPower > emptyPower, `${stat} must contribute to comprehensive power`);
    assert.ok(
      higherPower > lowerPower,
      `${stat} must remain monotonic before its runtime cap`,
    );
  }

  for (const [stat, cap, overflow] of [
    ["damageReductionPercent", 65, 500],
    ["critChancePercent", 70, 500],
    ["projectileSizePercent", 150, 500],
    ["lifeOnHitFlat", 18.75, 500],
    ["gearFindPercent", 200, 500],
  ]) {
    assert.equal(
      scoreStat(stat, overflow),
      scoreStat(stat, cap),
      `${stat} must stop adding power at the same cap used by live combat`,
    );
  }

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
  assertMultiplicativeSynergy(
    makeItem({ slot: "armor", stat: "maxHpFlat", value: 100 }),
    makeItem({ slot: "belt", stat: "damageReductionPercent", value: 50 }),
    "maximum health and damage reduction",
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
    qualityScore: 100,
    powerScore: 1,
  });
  const loadoutOf = (...items) => {
    const loadout = equipment.createEmptyEquipment();
    for (const item of items) loadout[item.slot] = item;
    return loadout;
  };
  const emptyPower = equipment.calculateEquipmentCombatPower(
    equipment.createEmptyEquipment(),
  );
  const activePowers = [
    "crescentEcho",
    "hunterSigil",
    "lastMemory",
    "riftStride",
    "commaResonance",
  ];
  const inactivePowers = [
    "mirrorAegis",
    "starfallMantle",
    "bloodwovenGrip",
    "ashboundGirdle",
    "phantomMarch",
  ];

  for (const legendaryPowerId of activePowers) {
    const slot = equipment.LEGENDARY_POWERS[legendaryPowerId].slot;
    const item = makeItem({ slot, rarity: "legendary", legendaryPowerId });
    assert.ok(
      equipment.calculateEquipmentCombatPower(loadoutOf(item)) > emptyPower,
      `${legendaryPowerId} is implemented at runtime and must contribute power`,
    );
    assert.ok(
      equipment.calculateGearPowerScore(item) > 1,
      `${legendaryPowerId} must contribute to intrinsic item power too`,
    );
  }
  for (const legendaryPowerId of inactivePowers) {
    const slot = equipment.LEGENDARY_POWERS[legendaryPowerId].slot;
    const item = makeItem({ slot, rarity: "legendary", legendaryPowerId });
    assert.equal(
      equipment.calculateEquipmentCombatPower(loadoutOf(item)),
      emptyPower,
      `${legendaryPowerId} must not claim power before its runtime behavior exists`,
    );
    assert.equal(equipment.calculateGearPowerScore(item), 1);
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

test("enhancement power comes only from enhanced affixes and stale saves recompute derived values", async () => {
  const equipment = await importTypeScriptModule("app/equipment.ts");
  const emptyItem = {
    slot: "weapon",
    rarity: "cosmic",
    level: 999,
    affixes: [],
    legendaryPowerId: null,
    enhancement: 0,
  };
  assert.equal(equipment.calculateGearPowerScore(emptyItem), 1);
  assert.equal(
    equipment.calculateGearPowerScore({ ...emptyItem, enhancement: 10 }),
    1,
    "level, rarity, and enhancement cannot invent combat power without an affix or active effect",
  );

  const affix = {
    stat: "damagePercent",
    value: 100,
    rollPercent: 100,
    label: equipment.formatGearAffix("damagePercent", 100),
  };
  const commonItem = {
    ...emptyItem,
    rarity: "common",
    level: 1,
    affixes: [affix],
  };
  const legendaryItem = { ...commonItem, rarity: "legendary" };
  const commonBasePower = equipment.calculateGearPowerScore(commonItem);
  const legendaryBasePower = equipment.calculateGearPowerScore(legendaryItem);
  assert.equal(commonBasePower, legendaryBasePower);
  const commonGain =
    equipment.calculateGearPowerScore({ ...commonItem, enhancement: 1 })
    - commonBasePower;
  const legendaryGain =
    equipment.calculateGearPowerScore({ ...legendaryItem, enhancement: 1 })
    - legendaryBasePower;
  assert.ok(commonGain > 0);
  assert.ok(
    legendaryGain >= commonGain * 2,
    "legendary +1 must convert its twice-as-large affix multiplier into real power",
  );

  const rolled = equipment.rollGear("stale-derived-power-save", {
    level: 42,
    slot: "weapon",
    rarity: "legendary",
  });
  const stale = JSON.parse(JSON.stringify(rolled));
  stale.enhancement = 5;
  stale.powerScore = -999_999;
  for (const savedAffix of stale.affixes) savedAffix.label = "stale label";
  const normalized = equipment.normalizeGearItem(stale);
  assert.ok(normalized);
  assert.equal(
    normalized.powerScore,
    equipment.calculateGearPowerScore(normalized),
    "saved power is derived and must be recomputed under the comprehensive formula",
  );
  for (const normalizedAffix of normalized.affixes) {
    assert.equal(
      normalizedAffix.label,
      equipment.formatGearAffix(normalizedAffix.stat, normalizedAffix.value),
      "saved option labels must migrate to the exact two-decimal formatter",
    );
  }
});

test("equipment rolls fifteen affix types with percent quality and identical-seed determinism", async () => {
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
  ];
  assert.deepEqual(equipment.GEAR_AFFIX_STATS, expectedStats);
  assert.deepEqual(Object.keys(equipment.GEAR_AFFIX_DEFINITIONS), expectedStats);
  for (const slot of equipment.EQUIPMENT_SLOTS) {
    const eligibleAffixes = expectedStats.filter((stat) =>
      equipment.GEAR_AFFIX_DEFINITIONS[stat].slots.includes(slot),
    );
    assert.ok(
      eligibleAffixes.length >= equipment.GEAR_RARITY_META.cosmic.affixCount,
      `${slot} needs at least eight eligible affixes for cosmic gear`,
    );
  }

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
        for (const affix of first.affixes) {
          assert.ok(Number.isSafeInteger(affix.rollPercent));
          assert.ok(affix.rollPercent >= 1 && affix.rollPercent <= 100);
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
    for (const affix of item.affixes) expectedTotals[affix.stat] += affix.value;
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

test("gear enhancement normalizes legacy saves and defines complete +0 through +10 rules", async () => {
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
  for (const rarity of equipment.GEAR_RARITIES) {
    const rate = equipment.GEAR_ENHANCEMENT_EFFECT_PER_STAGE[rarity];
    const actualAffixValue = equipment.getEnhancedGearAffixValue(
      { rarity, enhancement: 1 },
      { value: 100 },
    );
    assert.ok(
      Math.abs(actualAffixValue - 100 * (1 + rate)) < 1e-9,
      `${rarity} +1 must apply its declared rarity efficiency to live affixes`,
    );
  }
  const baseItem = equipment.rollGear("enhancement-contract", {
    level: 42,
    slot: "armor",
    rarity: "rare",
  });
  assert.equal(baseItem.enhancement, 0, "fresh drops must start at +0");

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

  const commonAnchor = {
    slot: "armor",
    rarity: "common",
    level: 1,
    affixes: [{
      stat: "damagePercent",
      value: 100,
      rollPercent: 100,
      label: equipment.formatGearAffix("damagePercent", 100),
    }],
    legendaryPowerId: null,
    enhancement: 0,
  };
  const legendaryAnchor = {
    ...commonAnchor,
    rarity: "legendary",
  };
  const commonAnchorPower = equipment.calculateGearPowerScore(commonAnchor);
  const legendaryAnchorPower = equipment.calculateGearPowerScore(legendaryAnchor);
  assert.equal(commonAnchorPower, legendaryAnchorPower);
  const commonPlusOneGain = equipment.calculateGearPowerScore({
    ...commonAnchor,
    enhancement: 1,
  }) - commonAnchorPower;
  const legendaryPlusOneGain = equipment.calculateGearPowerScore({
    ...legendaryAnchor,
    enhancement: 1,
  }) - legendaryAnchorPower;
  assert.ok(
    commonPlusOneGain > 0 && legendaryPlusOneGain >= commonPlusOneGain * 2,
    `legendary +1 gain ${legendaryPlusOneGain} must be at least twice common ${commonPlusOneGain}`,
  );

  const legacy = JSON.parse(JSON.stringify(baseItem));
  delete legacy.enhancement;
  const normalizedLegacy = equipment.normalizeGearItem(legacy);
  assert.ok(normalizedLegacy);
  assert.equal(normalizedLegacy.enhancement, 0, "pre-enhancement saves must migrate to +0");
  assert.equal(equipment.normalizeGearItem({ ...baseItem, enhancement: -1 }), null);
  assert.equal(equipment.normalizeGearItem({ ...baseItem, enhancement: 11 }), null);
  assert.equal(equipment.normalizeGearItem({ ...baseItem, enhancement: 1.5 }), null);

  let previousCost = 0;
  for (let enhancement = 0; enhancement < 10; enhancement += 1) {
    const item = { ...baseItem, enhancement };
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
  }
  assert.equal(equipment.getGearEnhancementRule({ ...baseItem, enhancement: 10 }), null);

  const plusFive = { ...baseItem, enhancement: 5 };
  const plusTen = { ...baseItem, enhancement: 10 };
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
    const currentRefund = equipment.getGearEnhancementAshRefund({
      ...baseItem,
      enhancement,
    });
    const previousRefund = equipment.getGearEnhancementAshRefund({
      ...baseItem,
      enhancement: enhancement - 1,
    });
    const previousRule = equipment.getGearEnhancementRule({
      ...baseItem,
      enhancement: enhancement - 1,
    });
    assert.equal(
      currentRefund - previousRefund,
      previousRule.ashCost,
      `+${enhancement} refund delta must equal that stage's deterministic cost`,
    );
  }

  const maxEnhanced = equipment.normalizeGearItem({ ...baseItem, enhancement: 10 });
  assert.ok(maxEnhanced);
  assert.ok(maxEnhanced.powerScore > baseItem.powerScore);
  const baseLoadout = equipment.createEmptyEquipment();
  baseLoadout.armor = baseItem;
  const enhancedLoadout = equipment.createEmptyEquipment();
  enhancedLoadout.armor = maxEnhanced;
  const baseTotals = equipment.aggregateEquipmentStats(baseLoadout);
  const enhancedTotals = equipment.aggregateEquipmentStats(enhancedLoadout);
  for (const affix of baseItem.affixes) {
    assert.ok(enhancedTotals[affix.stat] > baseTotals[affix.stat]);
    assert.equal(
      enhancedTotals[affix.stat],
      Math.round(
        baseTotals[affix.stat]
          * equipment.getGearEnhancementMultiplier(baseItem.rarity, 10)
          * 100,
      ) / 100,
      `${affix.stat} must use the same rarity-scaled multiplier as displayed power`,
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
  ];
  const allMapAssets = [...roomAssets, "map-board.webp"];

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

  const [game, css] = await Promise.all([
    readFile(path.join(root, "app/GameCanvas.tsx"), "utf8"),
    readFile(path.join(root, "app/game.css"), "utf8"),
  ]);
  for (const assetName of roomAssets) {
    assert.match(game, new RegExp(`/assets/maps/${assetName.replace(".", "\\.")}`));
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
  assert.match(game, /doorRects\.forEach\(drawDoorWard\)/);
  assert.match(game, /transitionOpacity = clamp\(world\.transition \/ 0\.55, 0, 1\)/);
  assert.doesNotMatch(game, /context\.strokeRect\(68, 64, WIDTH - 136, HEIGHT - 128\)/);
});

test("minimap coordinates, complete snapshots, room states, and square geometry match the world", async () => {
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
  assert.match(source, /gridColumn: x - minimumX \+ 1/);
  assert.match(source, /gridRow: y - minimumY \+ 1/);
  assert.match(source, /room \? `is-\$\{room\.kind\}` : ""/);
  assert.match(source, /data-room-kind=\{room\?\.kind \?\? "unknown"\}/);
  assert.match(source, /data-cleared=\{Boolean\(room\?\.cleared\)\}/);
  assert.match(source, /data-visited=\{wasVisited\}/);
  assert.match(source, /rooms: Object\.fromEntries\(/);
  assert.match(source, /visited: \[\.\.\.world\.visited\]/);
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
    /@media \(max-width: 620px\)[\s\S]*?\.minimap-grid:not\(\.is-large\) \{[\s\S]*?width: 70px;[\s\S]*?height: 70px;/,
  );
  assert.match(css, /\.minimap-grid\.is-large \{[\s\S]*?var\(--map-columns/);
  assert.match(css, /\.minimap-grid\.is-large \{[\s\S]*?var\(--map-rows/);
  for (const kind of ["battle", "horde", "elite", "memory", "shelter", "boss"]) {
    assert.match(css, new RegExp(`\\.map-cell\\.is-${kind}\\s*\\{`), `${kind} needs a map style`);
  }
  assert.doesNotMatch(css, /map-board\.webp/);
});

test("the purchased wayfinder teleports only between safe visited and cleared map rooms", async () => {
  const [travel, source, shopOverlay, css] = await Promise.all([
    importTypeScriptModule("app/map-teleport.ts"),
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

  assert.equal(travel.isSafeMapCoordinate(-12, 7), true);
  for (const [x, y] of [
    [1.5, 2],
    [Number.NaN, 2],
    [Number.POSITIVE_INFINITY, 2],
    [Number.MAX_SAFE_INTEGER + 1, 0],
  ]) {
    assert.equal(travel.isSafeMapCoordinate(x, y), false);
  }
  assert.deepEqual(travel.parseMapCoordinateKey("-12,7"), { x: -12, y: 7 });
  for (const key of ["1,2,3", "01,2", "+1,2", "1,2foo", "1", "", "-0,2"]) {
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
  assert.match(source, /disabled=\{teleportStatus !== "available"\}/);
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

test("player movement is constrained to the walkable floor while open door corridors remain passable", async () => {
  const source = await readFile(path.join(root, "app/GameCanvas.tsx"), "utf8");
  assert.match(
    source,
    /const WALKABLE_FLOOR_POLYGON\s*=\s*\[[\s\S]{0,700}?\] as const;/,
    "the room floor needs an explicit collision polygon",
  );
  assert.match(
    source,
    /function pointInsideWalkableFloor[\s\S]{0,900}?WALKABLE_FLOOR_POLYGON/,
  );
  assert.match(
    source,
    /function constrainPlayerToWalkableFloor\([\s\S]{0,800}?if \(doorOpen && inHorizontalDoor\)[\s\S]{0,180}?player\.x\s*=\s*clamp\([\s\S]{0,180}?return;/,
    "an open horizontal doorway must preserve its left/right corridor",
  );
  assert.match(
    source,
    /function constrainPlayerToWalkableFloor\([\s\S]{0,1200}?if \(doorOpen && inVerticalDoor\)[\s\S]{0,180}?player\.y\s*=\s*clamp\([\s\S]{0,180}?return;/,
    "an open vertical doorway must preserve its top/bottom corridor",
  );
  assert.match(
    source,
    /if \(pointInsideWalkableFloor\(player\.x, player\.y\)\) return;[\s\S]{0,1600}?player\.x\s*=\s*closestX;[\s\S]{0,80}?player\.y\s*=\s*closestY;/,
    "out-of-bounds movement must project back to the nearest polygon edge",
  );
  assert.match(
    source,
    /player\.x \+= dx \* speed \* dt;[\s\S]{0,9000}?constrainPlayerToWalkableFloor\(player, doorOpen\);/,
    "the movement update must invoke the polygon constraint after applying motion",
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
  assert.match(source, /drawProjectileVfx\(projectile, ambientTime, world\.projectiles\.length, "trail"\)/);
  assert.match(source, /drawProjectileVfx\(projectile, ambientTime, world\.projectiles\.length, "core"\)/);
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
  assert.ok(
    [...source.matchAll(/\bnormalizeEquipment\b/g)].length >= 2,
    "normalizeEquipment must be imported and applied while restoring a save",
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
  assert.match(overlay, /role=["']dialog["'][\s\S]{0,100}?aria-modal=["']true["']/);
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
    /const selectedItem = selectedInventoryItem \?\? selectedEquippedItem;[\s\S]{0,12000}?className={`inventory-screen-details/,
    "equipped and backpack items must feed the same detail view",
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
    /const loop = \(now: number\) => \{[\s\S]{0,240}?if \(isSimulationRunning\(\)\) update\(dt\);\s*draw\(\);/,
    "the animation frame must keep drawing UI/canvas while skipping combat updates",
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
    /selectedIsEquipped[\s\S]{0,400}?className=["']inventory-screen-unequip-button["'][\s\S]{0,220}?onClick=\{\(\) => onUnequip\(selectedItem\.slot\)\}/,
    "only the selected equipped item should expose the unequip action",
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
    /roll < rule\.successPercent[\s\S]{0,300}?enhancement:\s*rule\.target[\s\S]{0,160}?powerScore:\s*calculateGearPowerScore\(\{ \.\.\.item, enhancement:\s*rule\.target \}\)/,
    "successful enhancement must advance the stage and recompute power",
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
    overlay,
    /const enhancementEfficiencyPercent[\s\S]{0,220}?GEAR_ENHANCEMENT_EFFECT_PER_STAGE\[selectedItem\.rarity\]/,
    "the workbench must preview the selected rarity's per-stage efficiency",
  );
  assert.match(
    overlay,
    /const equipmentWithSelectedItem[\s\S]{0,320}?const enhancementPowerGain[\s\S]{0,240}?calculateEquipmentPowerDelta\(equipmentWithSelectedItem,\s*\{[\s\S]{0,120}?enhancement:\s*enhancementRule\.target/,
    "the workbench must preview the exact contextual power gained by its next stage",
  );
  assert.match(
    overlay,
    /enhancementPowerGain\.toLocaleString\(["']ko-KR["']\)/,
    "the enhancement action must show its exact power gain before spending ash",
  );
  assert.match(
    overlay,
    /function GearAffixBreakdown[\s\S]{0,500}?getGearAffixDisplay\(affix, item\)/,
    "all option rows must use the canonical base and enhancement display split",
  );
  assert.match(
    overlay,
    /<GearAffixBreakdown item=\{item\} affix=\{affix\} compact/,
    "hover options must show their live enhancement-scaled values",
  );
  assert.match(
    overlay,
    /<GearAffixBreakdown item=\{selectedItem\} affix=\{affix\}/,
    "workbench options must show their live enhancement-scaled values",
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

test("equipped gear selects a frame-matched composite walk sheet instead of icon overlays", async () => {
  const [source, overlay, css] = await Promise.all([
    readFile(path.join(root, "app/GameCanvas.tsx"), "utf8"),
    readFile(path.join(root, "app/InventoryOverlay.tsx"), "utf8"),
    readFile(path.join(root, "app/game.css"), "utf8"),
  ]);
  assert.match(
    source,
    /walkHarinEquipped\s*:\s*["']\/assets\/walk\/harin-equipped-v3\.png["']/,
    "the equipped composite walk sheet must be preloaded",
  );
  assert.match(source, /hasEquippedGear\s*=\s*EQUIPMENT_SLOTS\.some\(\(slot\)\s*=>\s*player\.equipment\[slot\]\)/);
  assert.match(
    source,
    /hasEquippedGear\s*&&\s*drawWalkSprite\(\s*images\.walkHarinEquipped,\s*HARIN_V2_DIRECTION_ROWS\[player\.facing\]\s*\?\?\s*player\.facing,\s*playerWalkFrame/,
    "equipped and base sheets must consume the exact same mapped direction and walk frame",
  );
  assert.match(
    source,
    /drawWalkSprite\(\s*images\.walkHarinEquipped,[\s\S]{0,420}?playerAlpha,\s*\)/,
    "the authored equipped directions must be drawn directly without horizontal mirroring",
  );
  assert.match(
    source,
    /equippedHarinDrawn\s*\|\|\s*drawWalkSprite\(\s*images\.walkHarin,/,
    "a missing or failed equipped sheet must fall back to the normal Harin sheet",
  );
  assert.doesNotMatch(
    source,
    /paperdollEquipment|paperdoll-equipment\.png|drawEquipmentOverlay|drawWearableLayer|harinWearables/,
    "square item art must never be layered over the in-game character",
  );
  assert.match(
    source,
    /sourceWidth\s*=\s*image\.naturalWidth\s*\/\s*4;[\s\S]{0,140}?sourceHeight\s*=\s*sourceRowCrop\?\.height\s*\?\?\s*image\.naturalHeight\s*\/\s*8;/,
    "the composite must follow the same four-frame by eight-direction walk contract",
  );

  // Ground loot and inventory thumbnails still use the separate icon atlas.
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
    /(?:function|const)\s+(?:Item|Gear)Tooltip[\s\S]{0,9000}?LEGENDARY_POWERS\[item\.legendaryPowerId\]/,
    "legendary powers must be visible directly in the tooltip",
  );
  assert.match(
    css,
    /\.inventory-screen-tooltip\s*\{[\s\S]{0,500}?position:\s*fixed;[\s\S]{0,1800}?pointer-events:\s*none;/,
    "the item tooltip must float above the inventory without affecting its layout",
  );
});

test("inventory clears a tooltip before moving its item to equipment", async () => {
  const overlay = await readFile(path.join(root, "app/InventoryOverlay.tsx"), "utf8");
  assert.match(
    overlay,
    /const equipItem\s*=\s*\(gearId:\s*string\)\s*=>\s*\{\s*setHoveredItem\(null\);\s*onEquip\(gearId\);\s*\}/,
  );
  assert.match(
    overlay,
    /onDoubleClick=\{\(\) => \{\s*if \(!salvageMode\) equipItem\(item\.id\)/,
    "moving gear between backpack and equipment must dismiss the stale source tooltip",
  );
});

test("batch salvage mode suppresses item information tooltips", async () => {
  const overlay = await readFile(path.join(root, "app/InventoryOverlay.tsx"), "utf8");
  assert.match(
    overlay,
    /const showPointerTooltip[\s\S]{0,220}?if \(salvageMode\) return;/,
    "pointer hover must be inert while batch salvage selection is active",
  );
  assert.match(
    overlay,
    /const showFocusTooltip[\s\S]{0,220}?if \(salvageMode\) return;/,
    "keyboard focus must not open item information during batch salvage",
  );
  assert.match(
    overlay,
    /const toggleSalvageMode[\s\S]{0,220}?clearSalvageSelection\(\);[\s\S]{0,120}?setHoveredItem\(null\);/,
    "entering or leaving batch salvage must dismiss any already-open tooltip",
  );
  assert.match(
    overlay,
    /\{!salvageMode && hoveredItem && typeof document !== ["']undefined["'] &&[\s\S]{0,120}?createPortal/,
    "the tooltip portal needs a final render guard against salvage mode",
  );
  assert.ok(
    [...overlay.matchAll(/aria-describedby=\{[^}]*!salvageMode[^}]*inventory-screen-hover-tooltip/g)].length >= 2,
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
    /@media\s*\(max-width:\s*900px\)[\s\S]{0,420}?grid-template-columns:\s*repeat\(4,\s*minmax\(0,\s*1fr\)\)/,
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
    { id: "power", label: "전투력", title: "전투력이 높은 장비부터 정렬" },
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

test("the enhancement workbench keeps its rates and equipment actions in separate rows", async () => {
  const css = await readFile(path.join(root, "app/game.css"), "utf8");

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
  assert.match(
    css,
    /\.inventory-screen-detail-actions-column\s*\{[^}]*grid-template-rows:\s*minmax\(min-content,\s*1fr\)\s+auto;[^}]*align-content:\s*start;/,
    "enhancement content and equip controls must retain two content-safe grid tracks",
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
    /\.inventory-screen-left-column\s*\{[^}]*grid-template-rows:\s*minmax\(360px,\s*1\.08fr\)\s+minmax\(250px,\s*0\.92fr\)/,
    "the desktop paperdoll and workbench must retain dedicated non-overlapping tracks",
  );
  assert.match(
    geometryContract,
    /@media\s*\(min-height:\s*681px\)\s*and\s*\(max-height:\s*800px\)\s*and\s*\(min-width:\s*901px\)[\s\S]{0,500}?\.inventory-screen-left-column\s*\{[^}]*minmax\(320px,\s*1\.1fr\)\s+minmax\(210px,\s*0\.9fr\)/,
    "low desktop layouts must reserve the larger share for five safe paperdoll rows",
  );
});

test("every backpack item shows its equipped-slot power delta before hover", async () => {
  const [overlay, css] = await Promise.all([
    readFile(path.join(root, "app/InventoryOverlay.tsx"), "utf8"),
    readFile(path.join(root, "app/game.css"), "utf8"),
  ]);

  assert.match(
    overlay,
    /sortedInventory\.map\(\(item,\s*itemIndex\) => \{[\s\S]{0,300}?const itemPowerDelta = calculateEquipmentPowerDelta\(equipment,\s*item\)/,
    "each backpack card must use the whole-loadout contextual comparison",
  );
  assert.match(
    overlay,
    /className=\{`inventory-screen-grid-delta\s+\$\{powerDeltaClass\(itemPowerDelta\)\}`\}/,
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
    /import[\s\S]{0,800}?getGearSalvageAshBreakdown[\s\S]{0,120}?from ["']\.\/equipment["']/,
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
    /const checkedForSalvage\s*=\s*selectedForSalvage\.has\(item\.id\)/,
    "the occupied backpack card itself must be the keyboard-accessible selection control",
  );
  assert.match(overlay, /onClick=\{\(\) => \{\s*if \(salvageMode\) toggleSalvageSelection\(item\.id\)/);
  assert.match(overlay, /aria-pressed=\{salvageMode \? checkedForSalvage : selected\}/);
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
  const [overlay, css] = await Promise.all([
    readFile(path.join(root, "app/InventoryOverlay.tsx"), "utf8"),
    readFile(path.join(root, "app/game.css"), "utf8"),
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
    3,
    "tooltip, equipped, and backpack render paths must all use the same authored aura",
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
    /\.inventory-screen-rarity-aura\s*\{[\s\S]{0,760}?z-index:\s*3;[\s\S]{0,120}?inset:\s*-10%;[\s\S]{0,300}?background-size:\s*400%\s+200%;[\s\S]{0,220}?opacity:\s*var\(--inventory-rarity-aura-opacity\);[\s\S]{0,500}?animation:\s*inventory-rarity-aura-frames-v3/,
    "the generated border must sit above the icon clip and animate while idle",
  );
  assert.match(
    auraCss,
    /\.inventory-screen-grid-item > \.inventory-screen-slot-clip,[\s\S]{0,180}?border-color:\s*transparent;/,
    "filled cards must not retain a second straight border beneath the authored frame",
  );
  assert.match(
    auraCss,
    /\.inventory-screen-rarity--rare\.inventory-screen-grid-item::before,[\s\S]{0,900}?opacity:\s*0;/,
    "rare+ cards must retire the competing static atlas frame",
  );
  assert.match(
    auraCss,
    /\.inventory-screen-rarity--rare\.inventory-screen-grid-item::after,[\s\S]{0,900}?display:\s*none;[\s\S]{0,100}?content:\s*none;/,
    "the hidden legacy pseudo-element aura must stay retired",
  );
  assert.match(css, /@keyframes\s+inventory-rarity-star-twinkle\s*\{/);
  assert.match(css, /@keyframes\s+inventory-rarity-dust-drift\s*\{/);
  assert.match(css, /\.inventory-screen-tooltip--rare::after\s*\{[^}]*inventory-rarity-tooltip-shimmer/);
  assert.match(css, /\.inventory-screen-tooltip--epic::after\s*\{[^}]*inventory-rarity-tooltip-shimmer/);
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
    3,
    "tooltip, equipped, and backpack paths must share the all-rarity spectacle",
  );
  assert.match(
    spectacleCss,
    /\.inventory-screen-rarity-spectacle\s*\{[\s\S]{0,640}?z-index:\s*1;[\s\S]{0,300}?background-size:\s*400%\s+200%;[\s\S]{0,520}?animation:\s*inventory-rarity-spectacle-frames-v4/,
    "the spectacle must animate behind the z-index 2 icon and z-index 3 exact border",
  );
  assert.match(spectacleCss, /\.inventory-screen-grid-cell--salvage-mode \.inventory-screen-rarity-spectacle\s*\{[^}]*visibility:\s*visible;[^}]*animation-play-state:\s*running;/);
  assert.match(game, /loot-toast-icon-stage[\s\S]{0,260}?inventory-screen-rarity-spectacle--\$\{lootNotice\.rarity\}[\s\S]{0,180}?<GearIcon item=\{lootNotice\}/);
  assert.match(spectacleCss, /\.loot-toast-icon-stage > \.loot-toast-rarity-spectacle\s*\{[^}]*z-index:\s*1;[^}]*opacity:\s*var\(--inventory-rarity-spectacle-active-opacity\);/);
  assert.match(spectacleCss, /\.loot-toast\.gear-rarity-rare::after,[\s\S]{0,900}?animation:\s*loot-toast-rarity-sweep/);
  assert.match(spectacleCss, /@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]{0,320}?\.inventory-screen-rarity-spectacle\s*\{[^}]*animation:\s*none;/);
});

test("inventory paperdoll keeps ten square side slots and normalizes frame and aura bounds", async () => {
  const [equipment, overlay, css] = await Promise.all([
    readFile(path.join(root, "app/equipment.ts"), "utf8"),
    readFile(path.join(root, "app/InventoryOverlay.tsx"), "utf8"),
    readFile(path.join(root, "app/game.css"), "utf8"),
  ]);
  const contractStart = css.lastIndexOf("Inventory geometry contract V3");
  assert.ok(contractStart >= 0, "the final inventory cascade contract is missing");
  const finalCss = css.slice(contractStart);

  assert.match(
    equipment,
    /EQUIPMENT_SLOTS\s*=\s*\[\s*"weapon",\s*"offhand",\s*"helm",\s*"shoulders",\s*"armor",\s*"gloves",\s*"belt",\s*"legs",\s*"boots",\s*"relic",?\s*\]/,
  );
  assert.match(overlay, /inventory-screen-paperdoll-figure/);
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
  assert.match(finalCss, /--inventory-paperdoll-row-spread:\s*clamp\(3px,\s*0\.65vh,\s*5px\);/);
  assert.match(finalCss, /--inventory-paperdoll-row-spread-double:\s*clamp\(6px,\s*1\.3vh,\s*10px\);/);
  assert.match(
    finalCss,
    /@media \(min-width:\s*901px\)[\s\S]{0,900}?equipment-card--helm,[\s\S]{0,120}?equipment-card--relic\s*\{[^}]*translate:\s*0\s+calc\(0px\s*-\s*var\(--inventory-paperdoll-row-spread-double\)\);[\s\S]{0,700}?equipment-card--belt,[\s\S]{0,120}?equipment-card--boots\s*\{[^}]*translate:\s*0\s+var\(--inventory-paperdoll-row-spread-double\);/,
    "desktop paperdoll rows must spread symmetrically into the available top and bottom room",
  );
  assert.match(finalCss, /padding-block:\s*var\(--inventory-paperdoll-aura-safe\);/);
  assert.match(finalCss, /height:\s*auto;[\s\S]{0,120}?align-self:\s*stretch;/);
  assert.match(
    finalCss,
    /\.inventory-screen-equipment-card\s*\{[\s\S]{0,520}?width:\s*auto;[\s\S]{0,100}?height:\s*100%;[\s\S]{0,160}?max-width:\s*var\(--inventory-paperdoll-slot-cap\);[\s\S]{0,160}?aspect-ratio:\s*1;/,
  );
  assert.match(finalCss, /@media \(max-width:\s*1240px\)[\s\S]{0,1100}?--inventory-paperdoll-slot-cap:\s*66px;[\s\S]{0,120}?--inventory-paperdoll-aura-safe:\s*30px;/);
  assert.doesNotMatch(
    finalCss,
    /grid-template-rows:\s*repeat\(5,\s*var\(--inventory-paperdoll-slot-size\)\)/,
    "paperdoll rows must fit the real equipment track instead of overflowing a viewport-sized minimum",
  );
  assert.doesNotMatch(
    finalCss.slice(0, finalCss.indexOf("/* rarity-frames.png")),
    /--inventory-paperdoll-slot-(?:cap|size):[\s\S]{0,180}?cq[wh]/,
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
    /\.inventory-screen-slot-clip\s*\{[\s\S]{0,240}?z-index:\s*auto;[\s\S]{0,220}?overflow:\s*hidden;/,
    "the dark slot plate must not form a z2 rectangle over the rarity spectacle",
  );
  assert.match(
    finalCss,
    /\.inventory-screen-slot-clip > \.inventory-screen-gear-icon\s*\{[^}]*position:\s*relative;[^}]*z-index:\s*2;/,
    "the clipped item icon must remain above the z1 spectacle",
  );
  assert.match(
    finalCss,
    /\.inventory-screen-rarity-aura\s*\{[\s\S]{0,300}?z-index:\s*3;/,
    "the exact rarity border must remain above the icon",
  );
  assert.match(finalCss, /Full names belong in the workbench[\s\S]{0,260}?\.inventory-screen-grid-name\s*\{\s*display:\s*none;/);
  assert.match(finalCss, /rarity-frames\.png:[\s\S]{0,520}?inset:\s*-2\.632%;[\s\S]{0,180}?background-size:\s*800%\s+100%;/);
  assert.match(finalCss, /Animated aura atlases:[\s\S]{0,650}?inset:\s*-10%;[\s\S]{0,180}?background-size:\s*400%\s+200%;/);
  assert.match(finalCss, /Tooltips use scalable panel chrome[\s\S]{0,450}?border-image:\s*url\("\/assets\/ui\/inventory-chrome\/tooltip-panel\.png"\)/);
  assert.match(finalCss, /@media \(max-width:\s*900px\)[\s\S]{0,1200}?\.inventory-screen-details\s*\{\s*display:\s*none;/);
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
  assert.match(source, /const \{ beamHeight, beamWidth \}\s*=\s*rarityVfx;/);
  assert.doesNotMatch(source, /const beam(?:Height|Width)\s*=\s*\[[^\]]+\]\[rarityTier\]/);
  assert.match(source, /rarityTier\s*===\s*EQUIPMENT_RARITY_TIER\.cosmic[\s\S]{0,500}?for \(let point = 0; point < 16;/);
});

test("the V5 field-loot builder keeps authored frame scale and never recolors one shared atlas", async () => {
  const builder = await readFile(
    path.join(root, "work/build_rarity_spectacle_assets.py"),
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

test("field drops use eight unique arrival patterns and reveal the beam and item on authored cues", async () => {
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
  assert.match(drawDrops, /appearanceProgress - rarityVfx\.beamRevealAt/);
  assert.match(drawDrops, /appearanceProgress - rarityVfx\.itemRevealAt/);
  assert.match(
    drawDrops,
    /context\.globalAlpha = beamReveal;[\s\S]{0,260}?context\.fillStyle = beam;/,
    "the persistent beam must stay gated until its rarity cue",
  );
  assert.match(
    drawDrops,
    /context\.globalAlpha = itemReveal;[\s\S]{0,180}?const equipmentIcons = images\.equipmentIcons;[\s\S]{0,900}?context\.drawImage\(/,
    "the equipment icon must materialize only after its rarity cue",
  );
  assert.match(
    drawDrops,
    /if \(beamReveal > 0\.001\) \{[\s\S]{0,220}?context\.createLinearGradient\(/,
    "hidden persistent beams must skip their gradient and particle render work",
  );
  assert.match(
    drawDrops,
    /if \(itemReveal > 0\.001\) \{[\s\S]{0,180}?const equipmentIcons = images\.equipmentIcons/,
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

test("the field-loot showcase is localhost-only and spawns real drops through production VFX", async () => {
  const source = await readFile(path.join(root, "app/GameCanvas.tsx"), "utf8");
  assert.match(
    source,
    /const isLocalRarityShowcaseHost = \(\) =>[\s\S]{0,180}?\["localhost", "127\.0\.0\.1", "::1", "\[::1\]"\]\.includes\(window\.location\.hostname\)/,
  );
  assert.match(
    source,
    /const lootVfxShowcaseMode = isLocalRarityShowcaseHost\(\)[\s\S]{0,120}?new URLSearchParams\(window\.location\.search\)\.get\("lootVfxShowcase"\)[\s\S]{0,40}?: null/,
    "the query parameter must be inert away from local hosts",
  );
  assert.match(source, /lootVfxShowcaseMode === "all"\s*\? EQUIPMENT_RARITIES/);
  const showcase = source.match(
    /const spawnLocalLootVfxShowcase = \(\) => \{[\s\S]*?(?=\n\s*const spawnCombatEffect)/,
  );
  assert.ok(showcase, "the local field-loot showcase hook is missing");
  assert.match(showcase[0], /lootVfxShowcaseSpawnedRef\.current/);
  assert.match(showcase[0], /modeRef\.current !== "playing"/);
  assert.match(
    showcase[0],
    /const item = rollGear\(`local-loot-vfx-\$\{rarity\}`,[\s\S]{0,160}?rarity,/,
    "showcase items must be produced by the real gear roller with a forced rarity",
  );
  assert.match(
    showcase[0],
    /world\.gearDrops\.push\(\{[\s\S]{0,220}?item,[\s\S]{0,120}?pickupDelay:\s*30,[\s\S]{0,80}?appearanceAge:\s*0/,
    "the showcase must create real collectible GearDrop records",
  );
  assert.match(showcase[0], /spawnLootAwakening\(position\.x, position\.y, rarity\)/);
  assert.match(source, /const loop = \(now: number\) => \{[\s\S]{0,140}?spawnLocalLootVfxShowcase\(\)/);
});

test("inventory v2 artwork, eight rarity frames, and every rare+ authored animation remain connected", async () => {
  const backgroundPath = "public/assets/ui/inventory-sanctum-v2.png";
  const framesPath = "public/assets/ui/rarity-frames.png";
  const auraAssets = ["rare", "epic", "legendary", "mythic", "cosmic"].map((tier) => [
    tier,
    `public/assets/ui/inventory-rarity-aura-${tier}-v3.png`,
  ]);
  const [backgroundPng, framePng, overlay, css, ...auraPngs] = await Promise.all([
    readFile(path.join(root, backgroundPath)),
    readFile(path.join(root, framesPath)),
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
  assert.equal(frames.width, frames.height * 8, "rarity frames must form an eight-column by one-row atlas");
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
  assert.match(css, /url\(["']?\/assets\/ui\/rarity-frames\.png["']?\)/);
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

test("the inventory paperdoll figure preserves its authored silhouette and generous safe area", async () => {
  const assetPath = "public/assets/ui/inventory-paperdoll-figure.png";
  const [png, overlay, css] = await Promise.all([
    readFile(path.join(root, assetPath)),
    readFile(path.join(root, "app/InventoryOverlay.tsx"), "utf8"),
    readFile(path.join(root, "app/game.css"), "utf8"),
  ]);
  const figure = decodeRgbaPng(png, assetPath);
  assert.deepEqual([figure.width, figure.height], [1023, 1537]);
  const margins = alphaCellMetrics(figure, 0, 0, 1, 1, "inventory paperdoll figure");
  assert.ok(margins.left >= 200, `paperdoll left alpha gutter is ${margins.left}px`);
  assert.ok(margins.right >= 200, `paperdoll right alpha gutter is ${margins.right}px`);
  assert.ok(margins.top >= 70, `paperdoll top alpha gutter is ${margins.top}px`);
  assert.ok(margins.bottom >= 120, `paperdoll bottom alpha gutter is ${margins.bottom}px`);

  assert.match(
    overlay,
    /className=["']inventory-screen-paperdoll-figure["'][^>]*aria-hidden=["']true["']/,
  );
  assert.match(
    css,
    /\.inventory-screen-paperdoll-figure\s*\{[\s\S]{0,500}?url\(["']?\/assets\/ui\/inventory-paperdoll-figure\.png["']?\)[\s\S]{0,160}?contain\s+no-repeat/,
    "the authored paperdoll must be contained behind the five live equipment slots",
  );
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
    ["inventory-chrome/tooltip-panel.png", ".inventory-screen-tooltip::before"],
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
