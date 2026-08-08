import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const root = process.cwd();
const audioRoot = path.join(root, "public", "assets", "audio");
const sfxRoot = path.join(audioRoot, "sfx");

function parsePcmWav(bytes, name) {
  assert.equal(bytes.subarray(0, 4).toString("ascii"), "RIFF", `${name}: RIFF`);
  assert.equal(bytes.readUInt32LE(4), bytes.length - 8, `${name}: RIFF size`);
  assert.equal(bytes.subarray(8, 12).toString("ascii"), "WAVE", `${name}: WAVE`);

  let cursor = 12;
  let format = null;
  let pcm = null;
  while (cursor + 8 <= bytes.length) {
    const chunkId = bytes.subarray(cursor, cursor + 4).toString("ascii");
    const size = bytes.readUInt32LE(cursor + 4);
    const start = cursor + 8;
    const end = start + size;
    assert.ok(end <= bytes.length, `${name}: truncated ${chunkId}`);
    if (chunkId === "fmt ") {
      assert.ok(size >= 16, `${name}: short fmt chunk`);
      format = {
        code: bytes.readUInt16LE(start),
        channels: bytes.readUInt16LE(start + 2),
        sampleRate: bytes.readUInt32LE(start + 4),
        byteRate: bytes.readUInt32LE(start + 8),
        blockAlign: bytes.readUInt16LE(start + 12),
        bits: bytes.readUInt16LE(start + 14),
      };
    }
    if (chunkId === "data") pcm = bytes.subarray(start, end);
    cursor = end + (size & 1);
  }

  assert.ok(format, `${name}: missing fmt chunk`);
  assert.ok(pcm, `${name}: missing data chunk`);
  assert.deepEqual(format, {
    code: 1,
    channels: 2,
    sampleRate: 44_100,
    byteRate: 176_400,
    blockAlign: 4,
    bits: 16,
  });
  assert.equal(pcm.length % format.blockAlign, 0, `${name}: incomplete frame`);
  return { ...format, pcm, frames: pcm.length / format.blockAlign };
}

test("the owner-supplied main BGM is preserved byte-for-byte", async () => {
  const mp3Path = path.join(audioRoot, "music", "the-last-comma.mp3");
  const bytes = await readFile(mp3Path);
  assert.equal(bytes.length, 4_116_913);
  assert.equal(bytes.subarray(0, 3).toString("ascii"), "ID3");
  assert.equal(
    createHash("sha256").update(bytes).digest("hex"),
    "e97a2416aef3f7d200fc9450e2b4e03fe9a700723057d176ebd2c3c8fd327c37",
  );
});

test("every generated SFX is valid, audible, unclipped stereo PCM", async () => {
  const filenames = (await readdir(sfxRoot)).filter((file) => file.endsWith(".wav")).sort();
  assert.equal(filenames.length, 25);
  let totalBytes = 0;

  for (const filename of filenames) {
    const bytes = await readFile(path.join(sfxRoot, filename));
    totalBytes += bytes.length;
    const wav = parsePcmWav(bytes, filename);
    const duration = wav.frames / wav.sampleRate;
    assert.ok(duration >= 0.18 && duration <= 1.7, `${filename}: duration ${duration}`);

    let peak = 0;
    let sum = 0;
    let clipped = 0;
    for (let offset = 0; offset < wav.pcm.length; offset += 2) {
      const sample = wav.pcm.readInt16LE(offset);
      peak = Math.max(peak, Math.abs(sample));
      sum += sample;
      if (Math.abs(sample) >= 32_767) clipped += 1;
    }
    const sampleCount = wav.pcm.length / 2;
    assert.ok(peak >= 8_000, `${filename}: unexpectedly quiet`);
    assert.equal(clipped, 0, `${filename}: clipped samples`);
    assert.ok(Math.abs(sum / sampleCount) < 180, `${filename}: excessive DC offset`);

    const edgeFrames = Math.min(32, wav.frames);
    let startPeak = 0;
    let endPeak = 0;
    for (let frame = 0; frame < edgeFrames; frame += 1) {
      for (let channel = 0; channel < 2; channel += 1) {
        startPeak = Math.max(startPeak, Math.abs(wav.pcm.readInt16LE(frame * 4 + channel * 2)));
        const endOffset = (wav.frames - edgeFrames + frame) * 4 + channel * 2;
        endPeak = Math.max(endPeak, Math.abs(wav.pcm.readInt16LE(endOffset)));
      }
    }
    assert.ok(startPeak < peak * 0.72, `${filename}: hard leading edge`);
    assert.ok(endPeak < peak * 0.3, `${filename}: hard trailing edge`);
  }

  assert.ok(totalBytes < 4_000_000, `SFX pack is too large: ${totalBytes}`);
});

test("the manifest is complete, unique, SSR-safe, and performance bounded", async () => {
  const [engine, provider, layout, game, generator] = await Promise.all([
    readFile(path.join(root, "app", "game-audio.ts"), "utf8"),
    readFile(path.join(root, "app", "GameAudioProvider.tsx"), "utf8"),
    readFile(path.join(root, "app", "layout.tsx"), "utf8"),
    readFile(path.join(root, "app", "GameCanvas.tsx"), "utf8"),
    readFile(path.join(root, "scripts", "generate_audio_assets.py"), "utf8"),
  ]);

  const manifestPaths = [...engine.matchAll(/path:\s*"(\/assets\/audio\/sfx\/[^"]+\.wav)"/g)]
    .map((match) => match[1]);
  assert.equal(manifestPaths.length, 25);
  assert.equal(new Set(manifestPaths).size, manifestPaths.length);
  for (const publicPath of manifestPaths) {
    const filePath = path.join(root, "public", ...publicPath.split("/").filter(Boolean));
    assert.ok((await stat(filePath)).size > 1_000, publicPath);
  }

  assert.match(engine, /const MAX_ACTIVE_VOICES = 24/);
  assert.match(engine, /cooldownMs:/);
  assert.match(engine, /maxVoices:/);
  assert.match(engine, /maxLatencyMs:/);
  assert.match(engine, /typeof window === "undefined"/);
  assert.match(engine, /new Audio\(MAIN_BGM_URL\)/);
  assert.match(engine, /context\.decodeAudioData/);
  assert.match(engine, /document\.hidden/);
  assert.match(engine, /window\.localStorage\.setItem\(GAME_AUDIO_SETTINGS_KEY/);
  assert.doesNotMatch(engine.split("class GameAudioEngine")[0], /new Audio\(|new AudioContext/);

  assert.match(layout, /<GameAudioProvider>\{children\}<\/GameAudioProvider>/);
  assert.match(provider, /document\.addEventListener\("pointerdown", unlock/);
  assert.match(provider, /document\.addEventListener\("keydown", unlock/);
  assert.match(provider, /aria-label="배경음악 볼륨"/);
  assert.match(provider, /aria-label="효과음 볼륨"/);

  for (const cue of [
    "playerShot",
    "playerHit",
    "playerDash",
    "enemyShot",
    "enemyDeath",
    "enemySummon",
    "enemyTeleport",
    "timeRift",
    "memoryPickup",
    "roomClear",
    "bossAppear",
    "enhanceSuccess",
    "enhanceFail",
    "enhanceDestroy",
    "shelterRest",
    "salvage",
  ]) {
    assert.match(game, new RegExp(`"${cue}"`), `missing ${cue} event`);
  }
  assert.match(game, /playGearRaritySfx\(rarity\)/);
  assert.match(game, /playGearRaritySfx\(drop\.item\.rarity\)/);
  assert.doesNotMatch(game, /new Audio\(|new AudioContext/);
  assert.match(generator, /random\.Random\(seed\)/);
  assert.match(generator, /SOUNDS = \{/);
});
