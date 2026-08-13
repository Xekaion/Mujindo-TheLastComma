import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import test from "node:test";

const gameSource = await readFile(new URL("../app/GameCanvas.tsx", import.meta.url), "utf8");
const runtimeSource = await readFile(new URL("../app/augment-vfx.ts", import.meta.url), "utf8");

const legacyIds = [
  "fang", "haste", "split", "pierce", "eye", "return", "ember", "oil", "frost", "storm",
  "poison", "blood", "predator", "glass", "boots", "void", "orbit", "time", "magnet", "map",
];
const newIds = [
  "focus", "caliber", "homing", "ricochet", "execution", "giantbane", "overcharge", "shrapnel", "leech", "armor",
  "resolve", "regeneration", "ward", "bulwark", "momentum", "reflex", "scholar", "scavenger", "conquest", "frenzy",
  "strength", "rapidfire", "range", "velocity", "expansion", "sprint", "defense", "recovery", "learning", "collection",
];
const augmentVfxIds = ["ember", "oil", "frost", "storm", "poison", "return", "void", "orbit", "time", "overcharge", "shrapnel", "ricochet", "ward"];
const legendaryVfxIds = ["crescentEcho", "mirrorAegis", "hunterSigil", "starfallMantle", "lastMemory", "bloodwovenGrip", "ashboundGirdle", "phantomMarch", "riftStride", "commaResonance"];
const projectileVfxIds = ["arcane", "blood", "ember", "storm", "frost", "poison", "echo", "enemy", "witch", "boss"];

const sha256 = async (url) => createHash("sha256").update(await readFile(url)).digest("hex");
const pngDimensions = async (url) => {
  const bytes = await readFile(url);
  assert.equal(bytes.subarray(1, 4).toString("ascii"), "PNG");
  return {
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
  };
};

const pngFramePayloads = async (url) => {
  const sharp = (await import("sharp")).default;
  const image = sharp(await readFile(url)).ensureAlpha();
  const frames = [];
  for (let row = 0; row < 4; row += 1) {
    for (let column = 0; column < 4; column += 1) {
      frames.push(
        await image
          .clone()
          .extract({ left: column * 128, top: row * 128, width: 128, height: 128 })
          .raw()
          .toBuffer(),
      );
    }
  }
  return frames;
};

test("the shipped 20-icon atlas stays byte-identical and only later augments opt into new art", async () => {
  // Frozen value records the exact legacy atlas the user asked us not to alter.
  assert.equal(
    await sha256(new URL("../public/assets/augment-icons-v2.webp", import.meta.url)),
    "feb526a68884128d068b512f06b011029d21113a0d97cb3bb2212e8ffe78069a",
  );
  assert.match(gameSource, /const LEGACY_AUGMENT_ICON_COUNT = 20;/);
  assert.match(gameSource, /index < LEGACY_AUGMENT_ICON_COUNT\s*\? augment\s*:\s*\{ \.\.\.augment, iconAsset:/s);
  for (const id of legacyIds) assert.match(gameSource, new RegExp(`id: "${id}"`));
  for (const id of newIds) {
    await stat(new URL(`../public/assets/augments/icons/${id}-v1.webp`, import.meta.url));
  }
});

test("every effect-producing augment, legendary power, and projectile has an authored sheet", async () => {
  for (const id of augmentVfxIds) {
    await stat(new URL(`../public/assets/effects/augments/${id}-v1.png`, import.meta.url));
    assert.match(runtimeSource, new RegExp(`"${id}"`));
  }
  for (const id of legendaryVfxIds) {
    await stat(new URL(`../public/assets/effects/legendary/${id}-v1.png`, import.meta.url));
    assert.match(runtimeSource, new RegExp(`"${id}"`));
  }
  for (const id of projectileVfxIds) {
    const assetUrl = new URL(`../public/assets/effects/projectiles/${id}-v2.png`, import.meta.url);
    await stat(assetUrl);
    const dimensions = await pngDimensions(assetUrl);
    assert.equal(dimensions.width, 512, `${id} projectile atlas width`);
    assert.equal(dimensions.height, 512, `${id} projectile atlas height`);
    assert.equal(dimensions.width % 4, 0, `${id} projectile atlas columns`);
    assert.equal(dimensions.height % 4, 0, `${id} projectile atlas rows`);
    const frames = await pngFramePayloads(assetUrl);
    assert.equal(
      new Set(frames.map((frame) => createHash("sha256").update(frame).digest("hex"))).size,
      16,
      `${id} must contain sixteen genuinely distinct frames`,
    );
    assert.match(runtimeSource, new RegExp(`"${id}"`));
  }
});

test("projectile artwork uses a smooth 16-frame contract at a stable cadence", () => {
  assert.match(runtimeSource, /projectiles\/\$\{affinity\}-v2\.png/);
  assert.match(runtimeSource, /columns:\s*4/);
  assert.match(runtimeSource, /rows:\s*4/);
  assert.match(runtimeSource, /frames:\s*16/);
  assert.match(runtimeSource, /PROJECTILE_VFX_FRAMES_PER_SECOND\s*=\s*30/);
  assert.match(gameSource, /loopingGameplayVfxProgress\(projectile\.age, definition\)/);
  assert.doesNotMatch(gameSource, /positiveModulo\(projectile\.age \* 8, 1\)/);
});

test("runtime renders authored artwork first and keeps primitives as load-failure fallback", () => {
  assert.match(gameSource, /if \(authoredDrawn\) return true;/);
  assert.match(gameSource, /if \(authoredDrawn\) return;/);
  assert.match(gameSource, /legendaryVfxId\("phantomMarch"\)/);
  assert.match(gameSource, /legendaryVfxId\("hunterSigil"\)/);
  assert.match(gameSource, /augmentVfxId\("ward"\)/);
  assert.match(gameSource, /vfxId: projectileVfxId\(affinity\)/);
});
