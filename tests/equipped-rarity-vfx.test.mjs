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
  const drawStates = [];
  let saves = 0;
  let restores = 0;
  const context = {
    globalAlpha: 1,
    globalCompositeOperation: "source-over",
    imageSmoothingEnabled: true,
    save() {
      saves += 1;
    },
    restore() {
      restores += 1;
    },
    drawImage(...args) {
      calls.push(args);
      drawStates.push({
        globalAlpha: context.globalAlpha,
        globalCompositeOperation: context.globalCompositeOperation,
        imageSmoothingEnabled: context.imageSmoothingEnabled,
      });
    },
  };
  return {
    calls,
    drawStates,
    get saves() {
      return saves;
    },
    get restores() {
      return restores;
    },
    context,
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
  assert.deepEqual(
    [0, 144, 145, 289, 290, 434, 435, 579, 580].map((timeMs) =>
      vfx.equippedRarityVfxFrame(timeMs, "weapon", false, "mythic"),
    ),
    [0, 0, 1, 1, 2, 2, 3, 3, 0],
    "mythic flash must advance at a clearly readable 145ms cadence",
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
    "plaza-remote": 3,
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

test("detailed plaza remotes preserve both mythic and cosmic equipped effects", async () => {
  const vfx = await importVfxModule();
  const mythic = { width: 1024, height: 256, id: "mythic-atlas" };
  const cosmic = { width: 1024, height: 256, id: "cosmic-atlas" };
  const plan = vfx.resolveEquippedRarityVfxPlan({
    weapon: gear("weapon", "cosmic", 7),
    shoulders: gear("shoulders", "mythic", 4),
  });

  assert.deepEqual(
    plan.pieces.map(({ slot, tier }) => [slot, tier]),
    [
      ["weapon", "cosmic"],
      ["shoulders", "mythic"],
    ],
  );
  for (const context of ["plaza-local", "plaza-remote"]) {
    const canvas = mockCanvas();
    const draws = vfx.drawEquippedRarityVfx(canvas.context, {
      plan,
      images: { mythic, cosmic },
      direction: 0,
      frame: 1,
      timeMs: 330,
      x: 100,
      y: 100,
      width: 136,
      height: 102,
      context,
    });

    assert.equal(draws, 2, `${context} must composite both chase-rarity pieces`);
    assert.deepEqual(
      canvas.calls.map((call) => call[0].id),
      ["cosmic-atlas", "mythic-atlas"],
      `${context} must draw both tier-specific atlases in plan order`,
    );
  }
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

test("equipped rarity VFX preserves the coarse pre-render style at runtime", async () => {
  const vfx = await importVfxModule();
  const canvas = mockCanvas();
  const draws = vfx.drawEquippedRarityVfx(canvas.context, {
    plan: vfx.resolveEquippedRarityVfxPlan({
      weapon: gear("weapon", "cosmic", 10),
      shoulders: gear("shoulders", "mythic", 5),
    }),
    images: {
      mythic: { width: 1024, height: 256 },
      cosmic: { width: 1024, height: 256 },
    },
    direction: 0,
    frame: 1,
    timeMs: 330,
    x: 100,
    y: 100,
    width: 136,
    height: 102,
    context: "combat",
  });

  assert.equal(draws, 2);
  assert.equal(canvas.drawStates.length, 2);
  assert.deepEqual(
    canvas.drawStates.map(({ globalCompositeOperation }) => globalCompositeOperation),
    ["screen", "screen"],
    "both bright transparent rarity flashes must remain luminous over dark equipment",
  );
  for (const state of canvas.drawStates) {
    assert.equal(
      state.imageSmoothingEnabled,
      false,
      "combat-scale equipment effects must use nearest-neighbour sampling",
    );
  }
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

test("cosmic v3 flash is a bright padded cyan-white-violet four-frame galaxy", async () => {
  const relativePath = "public/assets/effects/equipped-cosmic-flash-v3.png";
  const manifestPath = "public/assets/effects/equipped-cosmic-flash-v3.build.json";
  const sourcePath = "asset-sources/legacy-arpg/equipped-cosmic-flash-source-v3.png";
  const [png, manifestBytes, sourceBytes] = await Promise.all([
    readFile(path.join(root, relativePath)),
    readFile(path.join(root, manifestPath)),
    readFile(path.join(root, sourcePath)),
  ]);
  const image = decodeRgbaPng(png, relativePath);
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  assert.deepEqual([image.width, image.height], [1024, 256]);
  assert.equal(manifest.version, 3);
  assert.equal(manifest.builder, "scripts/build_equipped_cosmic_flash_v3.py");
  assert.equal(manifest.source, sourcePath);
  assert.equal(manifest.output, relativePath);
  assert.equal(manifest.format, "RGBA PNG");
  assert.deepEqual(manifest.atlas, { columns: 4, rows: 1, cell: [256, 256] });
  assert.deepEqual(manifest.pipeline.logicalCell, [128, 128]);
  assert.equal(manifest.pipeline.upscale, "nearest-neighbour-2x");
  assert.deepEqual(manifest.pipeline.alphaLevels, [0, 72, 128, 192, 255]);
  assert.equal(manifest.pipeline.centreTreatment, "transparent radial core");
  assert.equal(manifest.outputSha256, createHash("sha256").update(png).digest("hex"));
  assert.equal(manifest.sourceSha256, createHash("sha256").update(sourceBytes).digest("hex"));

  const hashes = [];
  const brightRatios = [];
  const visibleAlphaLevels = new Set();
  for (let column = 0; column < 4; column += 1) {
    const frameBytes = Buffer.alloc(256 * 256 * 4);
    let frameOffset = 0;
    let visiblePixels = 0;
    let brightPixels = 0;
    let whitePixels = 0;
    let cyanPixels = 0;
    let violetPixels = 0;
    let blackPixels = 0;
    let centrePixels = 0;
    let minimumX = 256;
    let maximumX = -1;
    let minimumY = 256;
    let maximumY = -1;
    for (let y = 0; y < 256; y += 1) {
      for (let x = 0; x < 256; x += 1) {
        const source = (y * image.width + column * 256 + x) * 4;
        const red = image.pixels[source];
        const green = image.pixels[source + 1];
        const blue = image.pixels[source + 2];
        const alpha = image.pixels[source + 3];
        frameBytes[frameOffset++] = red;
        frameBytes[frameOffset++] = green;
        frameBytes[frameOffset++] = blue;
        frameBytes[frameOffset++] = alpha;
        visibleAlphaLevels.add(alpha);
        if (alpha < 72) continue;
        visiblePixels += 1;
        minimumX = Math.min(minimumX, x);
        maximumX = Math.max(maximumX, x);
        minimumY = Math.min(minimumY, y);
        maximumY = Math.max(maximumY, y);
        const luminance = red * 0.299 + green * 0.587 + blue * 0.114;
        if (luminance >= 205) brightPixels += 1;
        if (red >= 210 && green >= 210 && blue >= 210) whitePixels += 1;
        if (green >= red * 1.08 && blue >= red * 1.12) cyanPixels += 1;
        if (red >= 110 && blue >= green * 1.03) violetPixels += 1;
        if (luminance < 10) blackPixels += 1;
        if (x >= 94 && x < 162 && y >= 94 && y < 162) centrePixels += 1;
      }
    }
    const reported = manifest.frames[column];
    const bbox = [minimumX, minimumY, maximumX + 1, maximumY + 1];
    const brightRatio = brightPixels / visiblePixels;
    const cyanRatio = cyanPixels / visiblePixels;
    const violetRatio = violetPixels / visiblePixels;
    const centreCoverage = centrePixels / (68 * 68);
    const frameHash = createHash("sha256").update(frameBytes).digest("hex");

    assert.ok(visiblePixels >= 16_000, `cosmic frame ${column} is unexpectedly sparse`);
    assert.ok(minimumX >= 10 && 255 - maximumX >= 10, `cosmic frame ${column} lacks x padding`);
    assert.ok(minimumY >= 10 && 255 - maximumY >= 10, `cosmic frame ${column} lacks y padding`);
    assert.ok(Math.abs((minimumX + maximumX) / 2 - 128) <= 3, `cosmic frame ${column} is off-center on x`);
    assert.ok(Math.abs((minimumY + maximumY) / 2 - 128) <= 3, `cosmic frame ${column} is off-center on y`);
    assert.ok(brightRatio >= 0.025 && brightRatio <= 0.55, `cosmic frame ${column} lacks controlled white sparkle`);
    assert.ok(whitePixels / visiblePixels >= 0.01, `cosmic frame ${column} needs visible white stars`);
    assert.ok(cyanRatio >= 0.35, `cosmic frame ${column} needs a strong cyan galaxy band`);
    assert.ok(violetRatio >= 0.08, `cosmic frame ${column} needs visible violet energy`);
    assert.ok(centreCoverage <= 0.02, `cosmic frame ${column} obscures the equipped item centre`);
    assert.equal(blackPixels, 0, `cosmic frame ${column} contains an opaque black rectangle`);
    assert.deepEqual(reported.bbox, bbox);
    assert.equal(reported.visiblePixels, visiblePixels);
    assert.ok(Math.abs(reported.brightRatio - brightRatio) < 0.000001);
    assert.ok(Math.abs(reported.cyanRatio - cyanRatio) < 0.000001);
    assert.ok(Math.abs(reported.violetRatio - violetRatio) < 0.000001);
    assert.ok(Math.abs(reported.centreCoverage - centreCoverage) < 0.000001);
    assert.equal(reported.pixelHash, frameHash);
    hashes.push(frameHash);
    brightRatios.push(brightRatio);
  }
  assert.equal(new Set(hashes).size, 4, "cosmic v3 needs four distinct temporal poses");
  assert.deepEqual([...visibleAlphaLevels].sort((left, right) => left - right), [0, 72, 128, 192, 255]);
  assert.ok(brightRatios[2] > brightRatios[0] * 8, "cosmic peak frame must greatly outshine frame zero");
  assert.ok(brightRatios[2] > brightRatios[3] * 5, "cosmic peak frame must greatly outshine recovery");
});

test("mythic v3 flash is padded, transparent, stepped, and peaks visibly in frame two", async () => {
  const relativePath = "public/assets/effects/equipped-mythic-flash-v3.png";
  const image = decodeRgbaPng(await readFile(path.join(root, relativePath)), relativePath);
  assert.deepEqual([image.width, image.height], [1024, 256]);
  const hashes = [];
  const brightRatios = [];
  const alphaLevels = new Set();
  for (let column = 0; column < 4; column += 1) {
    const frameBytes = Buffer.alloc(256 * 256 * 4);
    let offset = 0;
    let visible = 0;
    let bright = 0;
    let minimumX = 256;
    let maximumX = -1;
    let minimumY = 256;
    let maximumY = -1;
    let chromaPixels = 0;
    let blackPixels = 0;
    let centreVisible = 0;
    for (let y = 0; y < 256; y += 1) {
      for (let x = 0; x < 256; x += 1) {
        const source = (y * image.width + column * 256 + x) * 4;
        const red = image.pixels[source];
        const green = image.pixels[source + 1];
        const blue = image.pixels[source + 2];
        const alpha = image.pixels[source + 3];
        frameBytes[offset++] = red;
        frameBytes[offset++] = green;
        frameBytes[offset++] = blue;
        frameBytes[offset++] = alpha;
        alphaLevels.add(alpha);
        if (alpha === 0) continue;
        visible += 1;
        minimumX = Math.min(minimumX, x);
        maximumX = Math.max(maximumX, x);
        minimumY = Math.min(minimumY, y);
        maximumY = Math.max(maximumY, y);
        const luminance = red * 0.299 + green * 0.587 + blue * 0.114;
        if (luminance >= 210) bright += 1;
        if (luminance < 12) blackPixels += 1;
        if (blue > red * 1.35 && blue > green * 1.35) chromaPixels += 1;
        if ((x - 128) ** 2 + (y - 128) ** 2 <= 28 ** 2) centreVisible += 1;
      }
    }
    assert.ok(visible >= 800, `mythic frame ${column} is unexpectedly empty`);
    assert.ok(minimumX >= 12 && 255 - maximumX >= 12, `mythic frame ${column} lacks x padding`);
    assert.ok(minimumY >= 12 && 255 - maximumY >= 12, `mythic frame ${column} lacks y padding`);
    assert.equal(chromaPixels, 0, `mythic frame ${column} retains chroma contamination`);
    assert.equal(blackPixels, 0, `mythic frame ${column} contains an opaque black rectangle`);
    assert.ok(
      centreVisible / visible <= 0.08,
      `mythic frame ${column} obscures too much of its equipped slot`,
    );
    hashes.push(createHash("sha256").update(frameBytes).digest("hex"));
    brightRatios.push(bright / visible);
  }
  assert.equal(new Set(hashes).size, 4, "mythic v3 needs four distinct temporal poses");
  assert.deepEqual([...alphaLevels].sort((left, right) => left - right), [0, 72, 128, 192, 255]);
  assert.ok(brightRatios[2] > brightRatios[0] * 1.6, "peak frame must outshine frame zero");
  assert.ok(brightRatios[2] > brightRatios[3] * 1.6, "peak frame must outshine recovery");

  const manifest = JSON.parse(
    await readFile(
      path.join(root, "public/assets/effects/equipped-mythic-flash-v3.build.json"),
      "utf8",
    ),
  );
  assert.deepEqual(manifest.atlas, { columns: 4, rows: 1, cell: [256, 256] });
  assert.deepEqual(manifest.pipeline.alphaLevels, [0, 72, 128, 192, 255]);
  assert.deepEqual(manifest.pipeline.logicalCell, [128, 128]);
  assert.equal(manifest.pipeline.upscale, "nearest-neighbour-2x");
  assert.equal(manifest.pipeline.minimumPadding, 12);
});

test("equipped rarity VFX paths isolate the mythic and cosmic v3 flashes", async () => {
  const vfx = await importVfxModule();
  assert.deepEqual(vfx.EQUIPPED_RARITY_VFX_PATHS, {
    mythic: "/assets/effects/equipped-mythic-flash-v3.png",
    cosmic: "/assets/effects/equipped-cosmic-flash-v3.png",
  });
});
