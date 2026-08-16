import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const importTypeScriptModule = async (url) => {
  const source = await readFile(url, "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: url.pathname,
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);
};

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

test("authored projectile frames are temporally blended instead of held as discrete cells", async () => {
  const { drawGameplayVfxFrame } = await importTypeScriptModule(
    new URL("../app/augment-vfx.ts", import.meta.url),
  );
  const drawCalls = [];
  let alpha = 1;
  const context = {
    save() {},
    restore() {},
    translate() {},
    rotate() {},
    set globalAlpha(value) {
      alpha = value;
    },
    get globalAlpha() {
      return alpha;
    },
    set globalCompositeOperation(_value) {},
    set imageSmoothingEnabled(_value) {},
    drawImage(...args) {
      drawCalls.push({ args, alpha });
    },
  };
  const image = { complete: true, naturalWidth: 512, naturalHeight: 512 };
  const definition = {
    columns: 4,
    rows: 4,
    frames: 16,
    anchorY: 0.5,
    scale: 3.5,
    blendMode: "lighter",
  };

  assert.equal(
    drawGameplayVfxFrame(context, image, definition, {
      x: 20,
      y: 30,
      size: 12,
      // Frame 5 plus one quarter of the way to frame 6.
      progress: 5.25 / 16,
      alpha: 0.8,
      interpolateFrames: true,
    }),
    true,
  );
  assert.equal(drawCalls.length, 2, "interpolation must sample adjacent atlas cells");
  assert.deepEqual(
    drawCalls.map(({ args }) => args.slice(1, 3)),
    [[128, 128], [256, 128]],
    "frame 5 must blend into frame 6",
  );
  assert.ok(Math.abs(drawCalls[0].alpha - 0.6) < 1e-9);
  assert.ok(Math.abs(drawCalls[1].alpha - 0.2) < 1e-9);
  assert.ok(Math.abs(drawCalls[0].alpha + drawCalls[1].alpha - 0.8) < 1e-9);

  drawCalls.length = 0;
  drawGameplayVfxFrame(context, image, definition, {
    x: 20,
    y: 30,
    size: 12,
    progress: 5.25 / 16,
    alpha: 0.8,
  });
  assert.equal(drawCalls.length, 1, "stationary effects retain the single-frame path");
  assert.ok(Math.abs(drawCalls[0].alpha - 0.8) < 1e-9);
});

test("chain arcs preserve authored frame proportions with three-slice or tiled rendering", async () => {
  const { drawGameplayVfxFrame, GAMEPLAY_VFX_MANIFEST } = await importTypeScriptModule(
    new URL("../app/augment-vfx.ts", import.meta.url),
  );
  const image = { complete: true, naturalWidth: 512, naturalHeight: 512 };
  const render = (id) => {
    const drawCalls = [];
    const context = {
      save() {},
      restore() {},
      translate() {},
      rotate() {},
      set globalAlpha(_value) {},
      set globalCompositeOperation(_value) {},
      set imageSmoothingEnabled(_value) {},
      drawImage(...args) {
        drawCalls.push(args);
      },
    };
    assert.equal(
      drawGameplayVfxFrame(context, image, GAMEPLAY_VFX_MANIFEST[id], {
        x: 10,
        y: 20,
        endX: 250,
        endY: 20,
        size: 14,
        progress: 0,
      }),
      true,
    );
    return drawCalls;
  };

  const stormCalls = render("augment:storm");
  const ricochetCalls = render("augment:ricochet");
  assert.equal(GAMEPLAY_VFX_MANIFEST["augment:storm"].beamMode, "three-slice");
  assert.equal(GAMEPLAY_VFX_MANIFEST["augment:ricochet"].beamMode, "tile");
  assert.ok(stormCalls.length > 3, "storm must keep two caps and repeat its lightning core");
  assert.ok(ricochetCalls.length > 1, "ricochet must repeat square crests along the link");

  for (const [label, drawCalls] of [
    ["storm", stormCalls],
    ["ricochet", ricochetCalls],
  ]) {
    let coveredLength = 0;
    for (const args of drawCalls) {
      const sourceScaleX = args[7] / args[3];
      const sourceScaleY = args[8] / args[4];
      assert.ok(
        Math.abs(sourceScaleX - sourceScaleY) < 1e-9,
        `${label} cell may be cropped but must never be stretched on one axis`,
      );
      coveredLength += args[7];
    }
    assert.ok(
      Math.abs(coveredLength - 240) < 1e-9,
      `${label} slices must cover the complete endpoint distance`,
    );
  }
});

test("every moving projectile uses its 16-frame affinity core while keeping its unique impact VFX", () => {
  assert.match(
    gameSource,
    /if \(layer === "core"[\s\S]{0,900}projectileVfxId\(projectile\.affinity\)[\s\S]{0,1800}interpolateFrames:\s*interpolateArtwork/,
  );
  assert.match(
    gameSource,
    /const interpolateArtwork =\s*projectile\.hostile \|\|[\s\S]{0,300}projectileCount <= 120/,
    "hostile and ordinary-density shots must always retain temporal blending",
  );
  assert.match(
    gameSource,
    /spawnCombatEffect\([\s\S]{0,500}projectile\.vfxId/,
    "the distinct augment or legendary VFX must remain available for impacts",
  );
});

test("runtime renders authored artwork first and keeps primitives as load-failure fallback", () => {
  assert.match(gameSource, /if \(authoredDrawn\) return true;/);
  assert.match(gameSource, /if \(authoredDrawn\) return;/);
  assert.match(gameSource, /legendaryVfxId\("phantomMarch"\)/);
  assert.match(gameSource, /legendaryVfxId\("hunterSigil"\)/);
  assert.match(gameSource, /augmentVfxId\("ward"\)/);
  assert.match(gameSource, /vfxId: projectileVfxId\(affinity\)/);
});

test("player-attached augment and legendary VFX use the paperdoll body centre", () => {
  assert.match(
    gameSource,
    /const combatPlayerBodyCenterY = \(playerY: number\) =>\s*paperdollVisualCenterY\(\s*playerY \+ PLAYER_SPRITE_GROUND_OFFSET_Y,\s*PAPERDOLL_WORLD_RENDER_HEIGHT/,
  );
  for (const kind of ["mirrorWave", "ashboundShield", "bloodwovenBurst", "starfallBurst"]) {
    assert.match(
      gameSource,
      new RegExp(`"${kind}",\\s*player\\.x,\\s*combatPlayerBodyCenterY\\(player\\.y\\)`),
      `${kind} must originate at the player's visual body centre`,
    );
  }
  assert.match(
    gameSource,
    /"playerImpact",\s*player\.x,\s*combatPlayerBodyCenterY\(player\.y\),[\s\S]{0,180}?augmentVfxId\("void"\)/,
    "the self-cast void burst must not remain pinned to the feet",
  );
  assert.match(
    gameSource,
    /"muzzle",\s*player\.x,\s*combatPlayerBodyCenterY\(player\.y\),[\s\S]{0,180}?attackVfxId/,
    "augment-powered weapon flashes must originate on the player silhouette",
  );
  assert.match(
    gameSource,
    /"muzzle",\s*player\.x,\s*combatPlayerBodyCenterY\(player\.y\),[\s\S]{0,180}?legendaryVfxId\("commaResonance"\)/,
    "item-powered resonance flashes must originate on the player silhouette",
  );
  assert.equal(
    (gameSource.match(/y: playerBodyCenterY,/g) ?? []).length,
    3,
    "mirror, ward/ashbound, and starfall persistent layers must share one body anchor",
  );
  assert.equal(
    (gameSource.match(/combatPlayerBodyCenterY\(player\.y\) \+\s*Math\.sin\(angle\)/g) ?? []).length,
    2,
    "orbit collision and rendering must use the same body-centred ellipse",
  );
  assert.match(
    gameSource,
    /legendaryVfxId\("riftStride"\)/,
    "the ground-bound dash trail remains a distinct effect",
  );
  assert.match(
    gameSource,
    /"phantomTrail",\s*previousPlayerX,\s*previousPlayerY \+ 8/,
    "the ground-bound phantom trail must stay at the player's previous foot point",
  );
});
