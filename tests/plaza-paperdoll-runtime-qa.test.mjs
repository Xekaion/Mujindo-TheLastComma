import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
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

const equipmentUrl = await transpiledModuleUrl("app/equipment.ts");
const rigManifest = JSON.parse(
  await readFile(path.join(root, "app/paperdoll-rig-manifest.json"), "utf8"),
);
const rigManifestUrl = moduleUrl(`export default ${JSON.stringify(rigManifest)};`);
const equipment = await import(equipmentUrl);
const runtimeQa = await import(
  await transpiledModuleUrl("app/paperdoll-runtime-qa.ts", {
    "./equipment": equipmentUrl,
    "./paperdoll-rig-manifest.json": rigManifestUrl,
  })
);
const characterPaperdoll = await import(
  await transpiledModuleUrl("app/character-paperdoll.ts", {
    "./equipment": equipmentUrl,
    "./paperdoll-rig-manifest.json": rigManifestUrl,
  })
);
const runtimePixels = await import(
  await transpiledModuleUrl("app/paperdoll-runtime-pixels.ts")
);

test("runtime, browser fixture, and static renderer share one layer-pass map", async () => {
  const fixture = await readFile(
    path.join(root, "tests/fixtures/paperdoll-visual-qa.html"),
    "utf8",
  );
  const fixtureStart = fixture.indexOf("function layerPass(");
  const fixtureEnd = fixture.indexOf("function layerPath(", fixtureStart);
  assert.ok(fixtureStart >= 0 && fixtureEnd > fixtureStart);
  const fixtureLayerPass = Function(
    `"use strict";${fixture.slice(fixtureStart, fixtureEnd)};return layerPass;`,
  )();
  const pythonProbe = String.raw`
import importlib.util
import json
from pathlib import Path
import sys
path = Path(sys.argv[1])
spec = importlib.util.spec_from_file_location("paperdoll_static_renderer", path)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
print(json.dumps({
    slot: [module.layer_pass(slot, direction) for direction in range(8)]
    for slot in module.SLOTS
}))
`;
  const python = spawnSync(
    process.env.PYTHON || "python",
    ["-c", pythonProbe, path.join(root, "scripts/render_layered_paperdoll_qa.py")],
    { cwd: root, encoding: "utf8", windowsHide: true },
  );
  assert.equal(python.status, 0, [python.stdout, python.stderr].join("\n"));
  const staticPassMap = JSON.parse(python.stdout);

  for (const slot of equipment.EQUIPMENT_SLOTS) {
    const runtimePasses = Array.from({ length: 8 }, (_, direction) =>
      characterPaperdoll.resolvePaperdollLayer(slot, direction),
    );
    const fixturePasses = Array.from({ length: 8 }, (_, direction) =>
      fixtureLayerPass(slot, direction),
    );
    assert.deepEqual(fixturePasses, runtimePasses, `${slot} fixture pass drift`);
    assert.deepEqual(staticPassMap[slot], runtimePasses, `${slot} static pass drift`);
  }
  assert.deepEqual(
    Array.from({ length: 8 }, (_, direction) =>
      characterPaperdoll.resolvePaperdollLayer("relic", direction),
    ),
    Array(8).fill("front"),
  );
});

test("runtime paperdoll pixel probes reject transparent draws and compare RGBA", () => {
  assert.equal(
    runtimePixels.countPaperdollAlphaPixels(
      new Uint8ClampedArray([255, 255, 255, 0, 0, 0, 0, 1]),
    ),
    1,
    "only destination pixels with non-zero alpha count as contributions",
  );
  assert.equal(
    runtimePixels.countPaperdollAlphaPixels(new Uint8ClampedArray(8)),
    0,
  );
  assert.equal(
    runtimePixels.countPaperdollChangedPixels(
      new Uint8ClampedArray([10, 20, 30, 255, 0, 0, 0, 0]),
      new Uint8ClampedArray([11, 20, 30, 255, 0, 0, 0, 0]),
    ),
    1,
    "opaque RGB replacement must be detected even when alpha is unchanged",
  );
  assert.equal(
    runtimePixels.countPaperdollChangedPixels(
      new Uint8ClampedArray([10, 20, 30, 255]),
      new Uint8ClampedArray([10, 20, 30, 255]),
    ),
    0,
  );
  assert.throws(
    () => runtimePixels.countPaperdollAlphaPixels(new Uint8ClampedArray(3)),
    RangeError,
  );
  assert.throws(
    () =>
      runtimePixels.countPaperdollChangedPixels(
        new Uint8ClampedArray(4),
        new Uint8ClampedArray(8),
      ),
    RangeError,
  );
});

test("runtime plaza QA enumerates every single-item direction and gait frame once", () => {
  assert.equal(runtimeQa.PAPERDOLL_RUNTIME_QA_ITEM_COUNT, 100);
  assert.equal(runtimeQa.PAPERDOLL_RUNTIME_QA_TOTAL, 3_200);
  assert.equal(equipment.EQUIPMENT_SLOTS.length, 10);
  for (const slot of equipment.EQUIPMENT_SLOTS) {
    assert.equal(equipment.GEAR_BASE_NAMES[slot].length, 10, `${slot} visual bases`);
  }

  const keys = new Set();
  const directionGroups = new Map();
  for (let index = 0; index < runtimeQa.PAPERDOLL_RUNTIME_QA_TOTAL; index += 1) {
    const state = runtimeQa.paperdollRuntimeQaStateAt(index);
    assert.equal(state.index, index);
    assert.equal(
      runtimeQa.paperdollRuntimeQaIndexFor(
        state.slot,
        state.variant,
        state.direction,
        state.frame,
      ),
      index,
    );
    assert.ok(state.variant >= 0 && state.variant < 10);
    assert.ok(state.direction >= 0 && state.direction < 8);
    assert.ok(state.frame >= 0 && state.frame < 4);
    keys.add(state.key);
    const directionGroup = `${state.slot}/${state.variant}/${state.direction}`;
    directionGroups.set(
      directionGroup,
      (directionGroups.get(directionGroup) ?? 0) + 1,
    );
  }
  assert.equal(keys.size, 3_200);
  assert.equal(directionGroups.size, 800);
  assert.deepEqual(new Set(directionGroups.values()), new Set([4]));
  assert.equal(runtimeQa.paperdollRuntimeQaStateAt(0).key, "weapon/00/0/0");
  assert.equal(runtimeQa.paperdollRuntimeQaStateAt(3_199).key, "relic/09/7/3");

  const autorunKeys = new Set();
  let autorunIndex = 0;
  while (autorunIndex !== null) {
    const state = runtimeQa.paperdollRuntimeQaStateAt(autorunIndex);
    assert.equal(autorunKeys.has(state.key), false, `duplicate autorun key ${state.key}`);
    autorunKeys.add(state.key);
    autorunIndex = runtimeQa.nextPaperdollRuntimeQaIndex(autorunIndex);
  }
  assert.equal(autorunKeys.size, 3_200);
  assert.deepEqual(autorunKeys, keys);
});

test("each runtime QA item is canonical common +0 equipment in exactly one slot", () => {
  for (let itemIndex = 0; itemIndex < 100; itemIndex += 1) {
    const state = runtimeQa.paperdollRuntimeQaStateAt(itemIndex * 32);
    const loadout = runtimeQa.createPaperdollRuntimeQaEquipment(
      state.slot,
      state.variant,
    );
    const equipped = equipment.EQUIPMENT_SLOTS.flatMap((slot) =>
      loadout[slot] ? [[slot, loadout[slot]]] : [],
    );
    assert.equal(equipped.length, 1, state.key);
    const [[slot, item]] = equipped;
    assert.equal(slot, state.slot);
    assert.equal(item.slot, state.slot);
    assert.equal(item.rarity, "common");
    assert.equal(item.enhancement, 0);
    assert.equal(item.baseName, equipment.GEAR_BASE_NAMES[state.slot][state.variant]);
    assert.equal(
      item.iconIndex,
      state.variant * equipment.GEAR_ICON_COLUMNS + state.slotIndex,
    );
    assert.equal(equipment.isGearItem(item), true, `${state.slot}/${state.variant}`);
  }
});

test("runtime plaza QA also covers full and mixed ten-slot loadouts", () => {
  assert.equal(runtimeQa.PAPERDOLL_RUNTIME_QA_COMPOSITE_BUILDS.length, 5);
  assert.deepEqual(
    runtimeQa.PAPERDOLL_RUNTIME_QA_COMPOSITE_BUILDS,
    rigManifest.qaCompositeBuilds,
  );
  assert.equal(runtimeQa.PAPERDOLL_RUNTIME_QA_COMPOSITE_TOTAL, 160);
  const keys = new Set();
  for (
    let index = 0;
    index < runtimeQa.PAPERDOLL_RUNTIME_QA_COMPOSITE_TOTAL;
    index += 1
  ) {
    const state = runtimeQa.paperdollRuntimeQaCompositeStateAt(index);
    assert.equal(state.index, index);
    assert.equal(
      runtimeQa.paperdollRuntimeQaCompositeIndexFor(
        state.buildIndex,
        state.direction,
        state.frame,
      ),
      index,
    );
    const loadout = runtimeQa.createPaperdollRuntimeQaCompositeEquipment(
      state.variants,
    );
    const equipped = equipment.EQUIPMENT_SLOTS.map((slot) => loadout[slot]);
    assert.equal(equipped.filter(Boolean).length, 10, state.key);
    equipped.forEach((item, slotIndex) => {
      assert.equal(item.slot, equipment.EQUIPMENT_SLOTS[slotIndex]);
      assert.equal(item.rarity, "common");
      assert.equal(item.enhancement, 0);
      assert.equal(
        item.baseName,
        equipment.GEAR_BASE_NAMES[item.slot][state.variants[slotIndex]],
      );
    });
    keys.add(state.key);
  }
  assert.equal(keys.size, 160);
  assert.equal(
    runtimeQa.paperdollRuntimeQaCompositeStateAt(0).key,
    "full/00-00-00-00-00-00-00-00-00-00/0/0",
  );
  assert.equal(
    runtimeQa.paperdollRuntimeQaCompositeStateAt(159).key,
    "full/09-00-08-01-07-02-06-03-05-04/7/3",
  );
});

test("runtime QA request parsing is localhost-only and deterministically addressable", () => {
  for (const host of [
    "localhost",
    "localhost:4318",
    "127.0.0.1:4318",
    "[::1]:4318",
    "::1",
    "LOCALHOST:3000, proxy.internal",
  ]) {
    assert.equal(runtimeQa.isLocalPaperdollRuntimeQaHost(host), true, host);
  }
  for (const host of [null, "", "mujindo.example", "localhost.example:443"] ) {
    assert.equal(runtimeQa.isLocalPaperdollRuntimeQaHost(host), false, String(host));
  }

  assert.equal(runtimeQa.resolvePaperdollRuntimeQaInitialIndex({ index: "3199" }), 3_199);
  assert.equal(runtimeQa.resolvePaperdollRuntimeQaInitialIndex({ index: "9999" }), 3_199);
  assert.equal(
    runtimeQa.resolvePaperdollRuntimeQaInitialIndex({
      slot: "boots",
      variant: "4",
      direction: "6",
      frame: "2",
    }),
    runtimeQa.paperdollRuntimeQaIndexFor("boots", 4, 6, 2),
  );
  assert.equal(runtimeQa.resolvePaperdollRuntimeQaInitialIndex({ slot: "invalid" }), 0);
  assert.equal(runtimeQa.resolvePaperdollRuntimeQaAutorun({ autorun: "1" }), true);
  assert.equal(runtimeQa.resolvePaperdollRuntimeQaAutorun({ autorun: "0" }), false);
  assert.equal(runtimeQa.resolvePaperdollRuntimeQaAutorun({}), false);
  assert.equal(runtimeQa.resolvePaperdollRuntimeQaMode({}), "single");
  assert.equal(
    runtimeQa.resolvePaperdollRuntimeQaMode({ mode: "composite" }),
    "composite",
  );
  assert.equal(
    runtimeQa.resolvePaperdollRuntimeQaCompositeInitialIndex({ index: "159" }),
    159,
  );
});

test("the localhost route drives the actual PlazaHub renderer with exact ready keys", async () => {
  const [plaza, component, page, css, entryFlow, rootPage] = await Promise.all([
    readFile(path.join(root, "app/PlazaHub.tsx"), "utf8"),
    readFile(
      path.join(root, "app/paperdoll-runtime-qa/PaperdollRuntimeQa.tsx"),
      "utf8",
    ),
    readFile(path.join(root, "app/paperdoll-runtime-qa/page.tsx"), "utf8"),
    readFile(
      path.join(root, "app/paperdoll-runtime-qa/paperdoll-runtime-qa.css"),
      "utf8",
    ),
    readFile(path.join(root, "app/GameEntryFlow.tsx"), "utf8"),
    readFile(path.join(root, "app/page.tsx"), "utf8"),
  ]);

  assert.match(page, /isLocalPaperdollRuntimeQaHost\(host\)/);
  assert.match(page, /if \(!isLocalPaperdollRuntimeQaHost\(host\)\) notFound\(\)/);
  assert.match(page, /initialAutorun=\{resolvePaperdollRuntimeQaAutorun\(query\)\}/);
  assert.match(page, /mode=\{mode\}/);
  assert.match(component, /<PlazaHub/);
  assert.match(component, /equipment=\{equipment\}/);
  assert.match(component, /paperdollQaPose=\{pose\}/);
  assert.match(component, /data-qa-total=\{total\}/);
  assert.match(component, /data-qa-expected-key=\{state\.key\}/);
  assert.match(component, /data-qa-prev="true"/);
  assert.match(component, /data-qa-next="true"/);
  assert.match(component, /data-qa-jump="true"/);
  assert.match(component, /data-qa-start-full-pass="true"/);
  assert.match(component, /data-qa-stop-full-pass="true"/);
  assert.match(component, /data-qa-verified-count=\{pass\.verifiedCount\}/);
  assert.match(component, /data-qa-pass-complete=\{pass\.status === "complete" \? "true" : "false"\}/);
  assert.match(component, /data-qa-pass-failed=\{pass\.status === "failed" \? "true" : "false"\}/);
  assert.match(component, /data-qa-duplicate-count=\{pass\.duplicateCount\}/);
  assert.match(component, /data-qa-timeout-count=\{pass\.timeoutCount\}/);
  assert.match(component, /data-qa-pass-failure=\{pass\.failure \|\| "none"\}/);
  assert.match(component, /new MutationObserver\(verifyCurrentPose\)/);
  assert.match(component, /root\.dataset\.qaExpectedKey !== expectedKey/);
  assert.match(component, /plaza\.dataset\.paperdollQaExpectedKey !== expectedKey/);
  assert.match(component, /plaza\.dataset\.paperdollQaReady !== "true"/);
  assert.match(component, /plaza\.dataset\.paperdollQaRenderedKey !== expectedKey/);
  assert.match(component, /String\(expectedLayerCount\)/);
  assert.match(
    component,
    /paperdollQaDestinationVerifiedLayerCount !==\s*String\(expectedLayerCount\)/,
  );
  assert.match(component, /paperdollQaDestinationAlphaPixelCount/);
  assert.match(component, /destinationAlphaPixelCount <= 0/);
  assert.match(
    component,
    /paperdollQaBodyComparisonComplete !== "true"/,
  );
  assert.match(component, /paperdollQaBodyDiffPixelCount/);
  assert.match(component, /bodyDiffPixelCount <= 0/);
  assert.doesNotMatch(
    component,
    /if \(compositeMode\) \{\s*if \(bodyDiffPixelCount <= 0\)/,
    "every single and composite pose must change the body destination",
  );
  assert.match(component, /visibleDirectionGroupsRef\.current = new Set<string>\(\)/);
  assert.match(component, /activeRunIdRef\.current !== runId/);
  assert.match(component, /visibleDirectionGroups\.add\(/);
  assert.match(
    component,
    /visibleDirectionGroups\.size !== PAPERDOLL_RUNTIME_QA_DIRECTION_GROUP_TOTAL/,
  );
  assert.match(component, /data-qa-visible-direction-groups=/);
  assert.match(component, /data-qa-expected-direction-groups=/);
  assert.match(component, /data-qa-missing-direction-groups=/);
  assert.match(component, /PAPERDOLL_RUNTIME_QA_COMPOSITE_TOTAL/);
  assert.match(component, /createPaperdollRuntimeQaCompositeEquipment/);
  assert.doesNotMatch(
    component,
    /\[compositeState, singleState\]/,
    "pose-only direction/frame changes must not reroll identical equipment",
  );
  assert.match(component, /verifiedKeys\.has\(expectedKey\)/);
  assert.match(component, /verifiedKeys\.size !== expectedIndex/);
  assert.match(component, /nextPaperdollRuntimeQaIndex\(expectedIndex\)/);
  assert.match(component, /fail\(`timeout:\$\{expectedKey\}`, "timeout"\)/);
  assert.match(component, /stopFullPass\("manual-selection"\)/);
  assert.doesNotMatch(component, /paperdollLoadoutFromVisualGear|appearance:\s*\{[^}]*gear/);

  assert.match(plaza, /export type PlazaPaperdollQaPose/);
  assert.match(plaza, /frameOverride\?: number/);
  assert.match(plaza, /player\.frameOverride \?\?/);
  assert.match(plaza, /facing: localQaPose\?\.direction \?\? facingRef\.current/);
  assert.match(plaza, /frameOverride: localQaPose\?\.frame/);
  assert.match(plaza, /isPaperdollBodyAtlasReady\(bodyImage\)/);
  assert.match(plaza, /resolvePaperdollLayerInfo\(/);
  assert.match(plaza, /resolvedLayers\.every\(\(layer\) => layer\.ready\)/);
  assert.match(plaza, /context\.getImageData\(/);
  assert.match(plaza, /blankBodyAtlas:\s*createPaperdollQaCanvas\(\s*PAPERDOLL_BODY_ATLAS_WIDTH,\s*PAPERDOLL_BODY_ATLAS_HEIGHT/);
  assert.match(plaza, /function renderPaperdollQaDestination\(/);
  assert.match(plaza, /PAPERDOLL_WORLD_RENDER_HEIGHT \* PAPERDOLL_GROUND_ANCHOR_RATIO/);
  assert.match(plaza, /probeCanvases\.blankBodyAtlas/);
  assert.match(plaza, /destinationRender\.pixels/);
  assert.match(plaza, /countPaperdollAlphaPixels\(/);
  assert.match(plaza, /destinationVerifiedLayerCount === expectedLayerCount/);
  assert.match(plaza, /destinationAlphaPixelCount > 0/);
  assert.match(plaza, /bodyComparisonComplete &&/);
  assert.match(plaza, /paperdollQaBodyComparisonComplete = String\(/);
  assert.match(plaza, /bodyBaseline = renderPaperdollQaDestination\(/);
  assert.match(plaza, /compositeDestination = renderPaperdollQaDestination\(/);
  assert.match(plaza, /countPaperdollChangedPixels\(/);
  assert.match(plaza, /bodyDiffPixelCount > 0/);
  assert.doesNotMatch(
    plaza,
    /expectedLayerCount === 1 \|\| bodyDiffPixelCount > 0/,
    "single-item poses must contribute final pixels just like composite poses",
  );
  assert.match(plaza, /paperdollQaBodyDiffPixelCount = String\(/);
  assert.match(plaza, /drawPaperdollCharacterDirectReport\(/);
  assert.match(plaza, /appearanceDrawResult\.complete/);
  assert.match(
    plaza,
    /appearanceDrawResult\.drawnLayerCount === expectedLayerCount/,
  );
  assert.match(
    plaza,
    /root\?\.dataset\.paperdollQaExpectedKey === localQaPose\.key/,
  );
  assert.match(plaza, /function paperdollQaRenderedKey\(/);
  assert.match(plaza, /renderedKey === localQaPose\.key/);
  assert.match(plaza, /root\.dataset\.paperdollQaRenderedKey = renderedKey/);
  assert.doesNotMatch(
    plaza,
    /root\.dataset\.paperdollQaRenderedKey = localQaPose\.key/,
  );
  assert.match(plaza, /paperdollImages\.reconcile\(immediatePaths\)/);
  assert.match(plaza, /paperdollPathSignatureRef\.current = ""/);
  assert.match(page, /process\.env\.NODE_ENV !== "development"/);
  assert.match(page, /const host = requestHeaders\.get\("host"\)/);
  assert.doesNotMatch(page, /x-forwarded-host/);
  assert.match(plaza, /data-paperdoll-qa-canvas=\{paperdollQaPose \? "true" : undefined\}/);

  const localDrawStart = plaza.indexOf("const localQaPose = paperdollQaPoseRef.current;");
  const localDrawEnd = plaza.indexOf("players.sort", localDrawStart);
  assert.ok(localDrawStart >= 0 && localDrawEnd > localDrawStart);
  assert.doesNotMatch(
    plaza.slice(localDrawStart, localDrawEnd),
    /facingRef\.current\s*=/,
    "the QA pose must not mutate movement/network authority",
  );
  assert.doesNotMatch(entryFlow, /paperdoll-runtime-qa/);
  assert.doesNotMatch(rootPage, /paperdoll-runtime-qa/);
  assert.match(css, /\.paperdoll-runtime-qa__controls/);
});
