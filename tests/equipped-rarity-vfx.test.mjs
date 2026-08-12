import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { inflateSync } from "node:zlib";
import ts from "typescript";

const root = process.cwd();

const moduleUrl = (source) =>
  `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;

async function transpiledModuleUrl(relativePath, dependencyUrls = {}) {
  let source = await readFile(path.join(root, relativePath), "utf8");
  for (const [specifier, dependencyUrl] of Object.entries(dependencyUrls)) {
    source = source
      .replaceAll(`"${specifier}"`, JSON.stringify(dependencyUrl))
      .replaceAll(`'${specifier}'`, JSON.stringify(dependencyUrl));
  }
  return moduleUrl(
    ts.transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022,
      },
      fileName: relativePath,
    }).outputText,
  );
}

async function importVfxModule() {
  const equipmentUrl = await transpiledModuleUrl("app/equipment.ts");
  const paperdollUrl = await transpiledModuleUrl("app/character-paperdoll.ts", {
    "./equipment": equipmentUrl,
  });
  return import(
    await transpiledModuleUrl("app/equipped-rarity-vfx.ts", {
      "./equipment": equipmentUrl,
      "./character-paperdoll": paperdollUrl,
    })
  );
}

function gear(slot, rarity, enhancement = 0) {
  return { slot, variant: 0, rarity, enhancement };
}

function fullChaseLoadout(rarity = "cosmic") {
  return {
    weapon: gear("weapon", rarity),
    offhand: gear("offhand", rarity),
    helm: gear("helm", rarity),
    shoulders: gear("shoulders", rarity),
    armor: gear("armor", rarity),
    gloves: gear("gloves", rarity),
    belt: gear("belt", rarity),
    legs: gear("legs", rarity),
    boots: gear("boots", rarity),
    relic: gear("relic", rarity),
  };
}

function mockCanvas() {
  const calls = [];
  let saves = 0;
  let restores = 0;
  return {
    calls,
    get saves() {
      return saves;
    },
    get restores() {
      return restores;
    },
    context: {
      globalAlpha: 1,
      globalCompositeOperation: "source-over",
      save() {
        saves += 1;
      },
      restore() {
        restores += 1;
      },
      drawImage(...args) {
        calls.push(args);
      },
    },
  };
}

test("equipped rarity VFX plan filters lower tiers and orders cosmic pieces first", async () => {
  const vfx = await importVfxModule();
  const first = vfx.resolveEquippedRarityVfxPlan({
    boots: gear("boots", "common"),
    armor: gear("armor", "legendary"),
    gloves: gear("gloves", "mythic", 99),
    relic: gear("relic", "cosmic", -4),
    weapon: gear("weapon", "cosmic", 7),
    shoulders: gear("shoulders", "mythic", 3),
  });
  const permuted = vfx.resolveEquippedRarityVfxPlan({
    shoulders: gear("shoulders", "mythic", 3),
    weapon: gear("weapon", "cosmic", 7),
    relic: gear("relic", "cosmic", -4),
    gloves: gear("gloves", "mythic", 99),
    armor: gear("armor", "legendary"),
    boots: gear("boots", "common"),
  });

  assert.deepEqual(first, permuted, "object insertion order must not alter the visual plan");
  assert.deepEqual(
    first.pieces.map(({ slot, tier, enhancement }) => [slot, tier, enhancement]),
    [
      ["weapon", "cosmic", 7],
      ["relic", "cosmic", 0],
      ["shoulders", "mythic", 3],
      ["gloves", "mythic", 10],
    ],
  );
  assert.equal(first.cosmicCount, 2);
  assert.equal(first.mythicCount, 2);
  assert.equal(first.saturation, 6 / 10);
  assert.deepEqual(vfx.resolveEquippedRarityVfxPlan({}), {
    pieces: [],
    mythicCount: 0,
    cosmicCount: 0,
    saturation: 0,
  });
});

test("equipped rarity VFX frame selection is deterministic and reduced-motion safe", async () => {
  const vfx = await importVfxModule();
  assert.deepEqual(
    [0, 109, 110, 219, 220, 329, 330, 439, 440].map((timeMs) =>
      vfx.equippedRarityVfxFrame(timeMs, "weapon"),
    ),
    [0, 0, 1, 1, 2, 2, 3, 3, 0],
  );
  assert.equal(
    vfx.equippedRarityVfxFrame(1234, "relic"),
    vfx.equippedRarityVfxFrame(1234, "relic"),
  );
  assert.equal(vfx.equippedRarityVfxFrame(9999, "boots", true), 1);
  assert.equal(vfx.equippedRarityVfxFrame(Number.NaN, "boots"), 1);
});

test("equipped rarity VFX enforces per-context draw caps with atlas-safe source cells", async () => {
  const vfx = await importVfxModule();
  const plan = vfx.resolveEquippedRarityVfxPlan(fullChaseLoadout());
  const source = { width: 1024, height: 256 };
  const expectedCaps = {
    combat: 4,
    "plaza-local": 3,
    "plaza-remote": 1,
    portrait: 5,
  };

  for (const [context, expected] of Object.entries(expectedCaps)) {
    const canvas = mockCanvas();
    const draws = vfx.drawEquippedRarityVfx(canvas.context, {
      plan,
      images: { mythic: source, cosmic: source },
      direction: 6,
      frame: 2,
      timeMs: 750,
      x: 400,
      y: 300,
      width: 192,
      height: 144,
      context,
    });
    assert.equal(draws, expected, `${context} must remain inside its performance budget`);
    assert.equal(canvas.calls.length, expected);
    assert.equal(canvas.saves, 1);
    assert.equal(canvas.restores, 1);
    for (const call of canvas.calls) {
      assert.equal(call[2], 0, "every atlas sample begins on the first row");
      assert.equal(call[3], 256);
      assert.equal(call[4], 256);
      assert.ok([0, 256, 512, 768].includes(call[1]), `invalid source x ${call[1]}`);
      for (const value of call.slice(5)) assert.ok(Number.isFinite(value));
    }
  }

  const wrongSize = mockCanvas();
  assert.equal(
    vfx.drawEquippedRarityVfx(wrongSize.context, {
      plan,
      images: { cosmic: { width: 256, height: 256 } },
      direction: 0,
      frame: 0,
      timeMs: 0,
      x: 0,
      y: 0,
      width: 100,
      height: 100,
    }),
    0,
    "an incorrectly cropped atlas must never be drawn",
  );
});

test("mythic and cosmic VFX preserve authored opacity in every render context", async () => {
  const source = await readFile(path.join(root, "app/equipped-rarity-vfx.ts"), "utf8");
  assert.match(
    source,
    /combat:\s*1,[\s\S]*?"plaza-local":\s*1,[\s\S]*?"plaza-remote":\s*1,[\s\S]*?portrait:\s*1/,
  );
  assert.match(source, /canvas\.globalAlpha\s*=\s*alpha\s*\*\s*CONTEXT_ALPHA\[context\]/);
  assert.doesNotMatch(source, /piece\.tier\s*===\s*"cosmic"\s*\?\s*0\./);
});

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

function frameMetrics(image, column, label) {
  const cellSize = 256;
  const cellLeft = column * cellSize;
  let opaquePixels = 0;
  let minimumX = cellSize;
  let maximumX = -1;
  let minimumY = cellSize;
  let maximumY = -1;
  const frameBytes = Buffer.alloc(cellSize * cellSize * 4);
  for (let y = 0; y < cellSize; y += 1) {
    for (let x = 0; x < cellSize; x += 1) {
      const source = (y * image.width + cellLeft + x) * 4;
      const target = (y * cellSize + x) * 4;
      frameBytes[target] = image.pixels[source];
      frameBytes[target + 1] = image.pixels[source + 1];
      frameBytes[target + 2] = image.pixels[source + 2];
      frameBytes[target + 3] = image.pixels[source + 3];
      if (image.pixels[source + 3] === 0) continue;
      opaquePixels += 1;
      minimumX = Math.min(minimumX, x);
      maximumX = Math.max(maximumX, x);
      minimumY = Math.min(minimumY, y);
      maximumY = Math.max(maximumY, y);
    }
  }
  assert.ok(opaquePixels >= 5_000, `${label} is too sparse (${opaquePixels} pixels)`);
  return {
    hash: createHash("sha256").update(frameBytes).digest("hex"),
    left: minimumX,
    right: cellSize - 1 - maximumX,
    top: minimumY,
    bottom: cellSize - 1 - maximumY,
    centerX: (minimumX + maximumX) / 2,
    centerY: (minimumY + maximumY) / 2,
  };
}

test("mythic and cosmic equipped aura atlases retain four padded, unique RGBA frames", async () => {
  for (const tier of ["mythic", "cosmic"]) {
    const relativePath = `public/assets/effects/equipped-${tier}-aura-v1.png`;
    const image = decodeRgbaPng(await readFile(path.join(root, relativePath)), relativePath);
    assert.deepEqual([image.width, image.height], [1024, 256]);
    const frames = Array.from({ length: 4 }, (_, column) =>
      frameMetrics(image, column, `${tier} frame ${column}`),
    );
    assert.equal(
      new Set(frames.map(({ hash }) => hash)).size,
      4,
      `${tier} animation must contain four visually distinct frames`,
    );
    for (const [column, frame] of frames.entries()) {
      assert.ok(frame.left >= 12, `${tier} frame ${column} lacks left alpha padding`);
      assert.ok(frame.right >= 12, `${tier} frame ${column} lacks right alpha padding`);
      assert.ok(frame.top >= 12, `${tier} frame ${column} lacks top alpha padding`);
      assert.ok(frame.bottom >= 12, `${tier} frame ${column} lacks bottom alpha padding`);
      assert.ok(Math.abs(frame.centerX - 128) <= 24, `${tier} frame ${column} is off-center on x`);
      assert.ok(Math.abs(frame.centerY - 128) <= 12, `${tier} frame ${column} is off-center on y`);
    }
  }
});
