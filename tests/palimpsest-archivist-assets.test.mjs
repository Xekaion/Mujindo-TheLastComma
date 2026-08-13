import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { inflateSync } from "node:zlib";

const root = process.cwd();

const ASSETS = {
  walk: {
    path: "public/assets/walk/palimpsest-archivist-walk-v1.png",
    width: 1_024,
    height: 1_536,
    columns: 4,
    rows: 8,
    maximumBytes: 2_000_000,
    minimumOpaquePixels: 11_000,
    minimumGutter: { left: 18, right: 18, top: 16, bottom: 6 },
  },
  patterns: {
    path: "public/assets/effects/palimpsest-archivist-patterns-v1.png",
    width: 2_048,
    height: 1_024,
    columns: 4,
    rows: 2,
    maximumBytes: 3_000_000,
    minimumOpaquePixels: 18_000,
    minimumGutter: { left: 44, right: 44, top: 36, bottom: 36 },
  },
};

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
      assert.equal(png[dataStart + 10], 0, `${relativePath} uses unsupported compression`);
      assert.equal(png[dataStart + 11], 0, `${relativePath} uses unsupported filtering`);
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
  assert.equal(
    raw.length,
    (stride + 1) * height,
    `${relativePath} has unexpected scanline data`,
  );
  const pixels = Buffer.alloc(stride * height);
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
    assert.ok(filter <= 4, `${relativePath} uses unknown PNG filter ${filter}`);
    const rawStart = y * (stride + 1) + 1;
    const outputStart = y * stride;
    for (let byte = 0; byte < stride; byte += 1) {
      const left = byte >= bytesPerPixel ? pixels[outputStart + byte - bytesPerPixel] : 0;
      const above = y > 0 ? pixels[outputStart + byte - stride] : 0;
      const upperLeft =
        y > 0 && byte >= bytesPerPixel
          ? pixels[outputStart + byte - stride - bytesPerPixel]
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
      pixels[outputStart + byte] = (raw[rawStart + byte] + predictor) & 0xff;
    }
  }
  return { width, height, pixels };
}

function cellBytes(image, column, row, columns, rows, alphaOnly = false) {
  assert.equal(image.width % columns, 0);
  assert.equal(image.height % rows, 0);
  const cellWidth = image.width / columns;
  const cellHeight = image.height / rows;
  const channels = alphaOnly ? 1 : 4;
  const bytes = Buffer.alloc(cellWidth * cellHeight * channels);
  let output = 0;
  for (let y = 0; y < cellHeight; y += 1) {
    for (let x = 0; x < cellWidth; x += 1) {
      const source =
        (((row * cellHeight + y) * image.width + column * cellWidth + x) * 4);
      if (alphaOnly) {
        bytes[output] = image.pixels[source + 3];
        output += 1;
      } else {
        image.pixels.copy(bytes, output, source, source + 4);
        output += 4;
      }
    }
  }
  return bytes;
}

function cellMetrics(image, column, row, columns, rows, label) {
  const cellWidth = image.width / columns;
  const cellHeight = image.height / rows;
  const cellLeft = column * cellWidth;
  const cellTop = row * cellHeight;
  let opaquePixels = 0;
  let minimumX = cellWidth;
  let minimumY = cellHeight;
  let maximumX = -1;
  let maximumY = -1;

  for (let y = 0; y < cellHeight; y += 1) {
    for (let x = 0; x < cellWidth; x += 1) {
      const alpha = image.pixels[
        ((cellTop + y) * image.width + cellLeft + x) * 4 + 3
      ];
      if (alpha <= 16) continue;
      opaquePixels += 1;
      minimumX = Math.min(minimumX, x);
      minimumY = Math.min(minimumY, y);
      maximumX = Math.max(maximumX, x);
      maximumY = Math.max(maximumY, y);
    }
  }

  assert.ok(opaquePixels > 0, `${label} is empty`);
  return {
    opaquePixels,
    left: minimumX,
    right: cellWidth - 1 - maximumX,
    top: minimumY,
    bottom: cellHeight - 1 - maximumY,
    cellWidth,
    cellHeight,
  };
}

function assertTransparentCorners(image, columns, rows, label) {
  const cellWidth = image.width / columns;
  const cellHeight = image.height / rows;
  const cornerSize = 8;
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      for (const [startX, startY] of [
        [0, 0],
        [cellWidth - cornerSize, 0],
        [0, cellHeight - cornerSize],
        [cellWidth - cornerSize, cellHeight - cornerSize],
      ]) {
        for (let y = startY; y < startY + cornerSize; y += 1) {
          for (let x = startX; x < startX + cornerSize; x += 1) {
            const alpha = image.pixels[
              (((row * cellHeight + y) * image.width + column * cellWidth + x) * 4) + 3
            ];
            assert.equal(alpha, 0, `${label} cell ${row},${column} has a dirty corner`);
          }
        }
      }
    }
  }
}

function countBrightChromaPixels(image) {
  let green = 0;
  let blue = 0;
  for (let index = 0; index < image.pixels.length; index += 4) {
    const red = image.pixels[index];
    const greenChannel = image.pixels[index + 1];
    const blueChannel = image.pixels[index + 2];
    const alpha = image.pixels[index + 3];
    if (alpha <= 16) continue;
    if (
      greenChannel > 190 &&
      greenChannel > red + 80 &&
      greenChannel > blueChannel + 80
    ) {
      green += 1;
    }
    if (
      blueChannel > 190 &&
      blueChannel > red + 80 &&
      blueChannel > greenChannel + 80
    ) {
      blue += 1;
    }
  }
  return { green, blue };
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function lowerBodyAlpha(image, column, row) {
  const cellWidth = image.width / 4;
  const cellHeight = image.height / 8;
  const startY = Math.floor(cellHeight * 0.48);
  const bytes = Buffer.alloc(cellWidth * (cellHeight - startY));
  let output = 0;
  for (let y = startY; y < cellHeight; y += 1) {
    for (let x = 0; x < cellWidth; x += 1) {
      bytes[output] = image.pixels[
        (((row * cellHeight + y) * image.width + column * cellWidth + x) * 4) + 3
      ];
      output += 1;
    }
  }
  return bytes;
}

function changedAlphaPixels(left, right) {
  assert.equal(left.length, right.length);
  let changed = 0;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) changed += 1;
  }
  return changed;
}

for (const [assetName, config] of Object.entries(ASSETS)) {
  test(`Palimpsest Archivist ${assetName} atlas is RGBA, crop-safe, and chroma-clean`, async () => {
    const png = await readFile(path.join(root, config.path));
    assert.ok(
      png.length <= config.maximumBytes,
      `${config.path} grew to ${png.length.toLocaleString()} bytes`,
    );
    const image = decodeRgbaPng(png, config.path);
    assert.deepEqual([image.width, image.height], [config.width, config.height]);

    const frameHashes = new Set();
    for (let row = 0; row < config.rows; row += 1) {
      for (let column = 0; column < config.columns; column += 1) {
        const label = `${assetName} row ${row} frame ${column}`;
        const metrics = cellMetrics(
          image,
          column,
          row,
          config.columns,
          config.rows,
          label,
        );
        assert.ok(
          metrics.opaquePixels >= config.minimumOpaquePixels,
          `${label} has only ${metrics.opaquePixels} readable pixels`,
        );
        for (const edge of ["left", "right", "top", "bottom"]) {
          assert.ok(
            metrics[edge] >= config.minimumGutter[edge],
            `${label} ${edge} gutter is ${metrics[edge]}px`,
          );
        }
        frameHashes.add(
          sha256(cellBytes(image, column, row, config.columns, config.rows)),
        );
      }
    }
    assert.equal(
      frameHashes.size,
      config.columns * config.rows,
      `${assetName} contains duplicate RGBA frames`,
    );
    assertTransparentCorners(image, config.columns, config.rows, assetName);

    const chroma = countBrightChromaPixels(image);
    assert.ok(chroma.green <= 4, `${assetName} retains ${chroma.green} bright green-key pixels`);
    assert.ok(chroma.blue <= 4, `${assetName} retains ${chroma.blue} bright blue-key pixels`);
  });
}

test("Palimpsest Archivist has four distinct lower-body gait phases in every direction", async () => {
  const config = ASSETS.walk;
  const image = decodeRgbaPng(
    await readFile(path.join(root, config.path)),
    config.path,
  );

  const globalLowerBodyHashes = new Set();
  for (let row = 0; row < 8; row += 1) {
    const phases = Array.from({ length: 4 }, (_, column) =>
      lowerBodyAlpha(image, column, row),
    );
    const hashes = phases.map(sha256);
    assert.equal(
      new Set(hashes).size,
      4,
      `direction row ${row} repeats a lower-body gait phase`,
    );
    for (const hash of hashes) globalLowerBodyHashes.add(hash);

    for (let first = 0; first < phases.length; first += 1) {
      for (let second = first + 1; second < phases.length; second += 1) {
        assert.ok(
          changedAlphaPixels(phases[first], phases[second]) >= 2_500,
          `direction row ${row} phases ${first}/${second} do not visibly advance`,
        );
      }
    }
    assert.ok(
      changedAlphaPixels(phases[0], phases[2]) >= 3_000,
      `direction row ${row} does not alternate its two contact poses`,
    );
    assert.ok(
      changedAlphaPixels(phases[1], phases[3]) >= 3_000,
      `direction row ${row} repeats its two passing poses`,
    );
  }
  assert.equal(
    globalLowerBodyHashes.size,
    32,
    "a direction reuses another direction's lower-body animation frame",
  );
});
