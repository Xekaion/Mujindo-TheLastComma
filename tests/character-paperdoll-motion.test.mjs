import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { inflateSync } from "node:zlib";
import ts from "typescript";

const root = process.cwd();

async function importTypeScriptModule(relativePath) {
  const source = await readFile(path.join(root, relativePath), "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(output).toString("base64")}`);
}

function decodePng(buffer) {
  let offset = 8;
  let width = 0;
  let height = 0;
  const idat = [];
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.subarray(offset + 4, offset + 8).toString("ascii");
    const start = offset + 8;
    if (type === "IHDR") {
      width = buffer.readUInt32BE(start);
      height = buffer.readUInt32BE(start + 4);
      assert.equal(buffer[start + 8], 8);
      assert.equal(buffer[start + 9], 6);
      assert.equal(buffer[start + 12], 0);
    } else if (type === "IDAT") idat.push(buffer.subarray(start, start + length));
    offset = start + length + 4;
    if (type === "IEND") break;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * 4;
  const pixels = new Uint8Array(width * height * 4);
  const paeth = (a, b, c) => {
    const p = a + b - c;
    const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const input = y * (stride + 1) + 1;
    const output = y * stride;
    for (let x = 0; x < stride; x += 1) {
      const left = x >= 4 ? pixels[output + x - 4] : 0;
      const above = y ? pixels[output + x - stride] : 0;
      const diagonal = y && x >= 4 ? pixels[output + x - stride - 4] : 0;
      const predictor = filter === 0 ? 0 : filter === 1 ? left : filter === 2 ? above : filter === 3 ? Math.floor((left + above) / 2) : paeth(left, above, diagonal);
      pixels[output + x] = (raw[input + x] + predictor) & 255;
    }
  }
  return { width, height, pixels };
}

function alphaMask(image, row, column) {
  const mask = new Uint8Array(256 * 192);
  for (let y = 0; y < 192; y += 1) for (let x = 0; x < 256; x += 1) {
    const source = (((row * 192 + y) * image.width + column * 256 + x) * 4) + 3;
    mask[y * 256 + x] = image.pixels[source] > 16 ? 1 : 0;
  }
  return mask;
}

function mirrorIou(mask) {
  let intersection = 0, union = 0;
  for (let y = 0; y < 192; y += 1) for (let x = 0; x < 256; x += 1) {
    const a = mask[y * 256 + x], b = mask[y * 256 + (255 - x)];
    if (a || b) union += 1;
    if (a && b) intersection += 1;
  }
  return intersection / union;
}

function lowerIou(left, right) {
  let intersection = 0, union = 0;
  for (let y = 104; y < 192; y += 1) for (let x = 0; x < 256; x += 1) {
    const a = left[y * 256 + x], b = right[y * 256 + x];
    if (a || b) union += 1;
    if (a && b) intersection += 1;
  }
  return intersection / union;
}

test("halted characters always render the balanced standing frame", async () => {
  const motion = await importTypeScriptModule("app/character-motion.ts");
  assert.equal(motion.CHARACTER_IDLE_FRAME, 1);
  for (const cycle of [-11, 0, 0.75, 1.9, 3.99, 99, Number.NaN]) {
    assert.equal(motion.settleCharacterWalkCycle(cycle), 1);
    assert.equal(motion.characterWalkFrameIndex(cycle, false), 1);
  }
  assert.equal(motion.characterRenderFrameIndex(0, 3.2, false), 1);
  assert.equal(motion.characterRenderFrameIndex(4, 0.2, false), 1);
  for (const facing of [1, 2, 3, 5, 6, 7]) {
    assert.equal(
      motion.characterRenderFrameIndex(facing, 0.2, false),
      3,
      `facing ${facing} must retain its angled neutral stance`,
    );
  }
  assert.deepEqual([0, 1, 2, 3].map((cycle) => motion.characterWalkFrameIndex(cycle, true)), [0, 1, 2, 3]);
});

test("north and south stance art is straight while contact poses alternate", async () => {
  const image = decodePng(await readFile(path.join(root, "public/assets/walk/harin-mannequin-v5.png")));
  assert.deepEqual([image.width, image.height], [1024, 1536]);
  for (const row of [0, 4]) {
    const idle = alphaMask(image, row, 1);
    assert.ok(mirrorIou(idle) > 0.92, `cardinal row ${row} standing art leans diagonally`);
    const maximumContactIou = row === 4 ? 0.93 : 0.86;
    assert.ok(lowerIou(alphaMask(image, row, 0), alphaMask(image, row, 2)) < maximumContactIou, `cardinal row ${row} does not alternate feet`);
  }
});

test("expedition, plaza, and PVP share one corrected player scale", async () => {
  const [paperdoll, expedition, plaza, pvp] = await Promise.all([
    readFile(path.join(root, "app/character-paperdoll.ts"), "utf8"),
    readFile(path.join(root, "app/GameCanvas.tsx"), "utf8"),
    readFile(path.join(root, "app/PlazaHub.tsx"), "utf8"),
    readFile(path.join(root, "app/pvp/PvpArena.tsx"), "utf8"),
  ]);
  assert.match(paperdoll, /harin-mannequin-v1\.png/);
  assert.match(paperdoll, /paperdoll\/v1/);
  assert.match(paperdoll, /context\.imageSmoothingEnabled\s*=\s*false/g);
  assert.match(paperdoll, /PAPERDOLL_WORLD_RENDER_WIDTH\s*=\s*136/);
  assert.match(paperdoll, /PAPERDOLL_WORLD_RENDER_HEIGHT\s*=\s*102/);
  for (const source of [expedition, plaza, pvp]) {
    assert.match(source, /PAPERDOLL_WORLD_RENDER_WIDTH/);
    assert.match(source, /PAPERDOLL_WORLD_RENDER_HEIGHT/);
  }
  assert.doesNotMatch(`${expedition}\n${plaza}`, /width:\s*171[\s\S]{0,30}height:\s*128/);
  assert.doesNotMatch(pvp, /width:\s*157[\s\S]{0,30}height:\s*118/);
});
