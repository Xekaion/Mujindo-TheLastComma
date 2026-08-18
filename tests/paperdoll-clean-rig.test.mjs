import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const auditScript = path.join(root, "scripts/audit_clean_paperdoll_rig.py");
const slots = [
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
];
const variants = [
  ["iron", "harin-equipped-iron-v1.png"],
  ["frost", "harin-equipped-frost-v2.png"],
  ["jade", "harin-equipped-jade-v1.png"],
  ["blood", "harin-equipped-blood-v1.png"],
  ["arcane", "harin-equipped-arcane-v1.png"],
  ["waraxe", "harin-equipped-waraxe-v1.png"],
  ["celestial", "harin-equipped-celestial-v1.png"],
  ["void", "harin-equipped-void-v1.png"],
  ["sealed", "harin-equipped-sealed-v1.png"],
  ["cosmic", "harin-equipped-cosmic-v1.png"],
];

function findPython() {
  const candidates = [process.env.PYTHON, "python", "python3"].filter(Boolean);
  for (const command of candidates) {
    const probe = spawnSync(command, ["--version"], {
      cwd: root,
      encoding: "utf8",
      windowsHide: true,
    });
    if (probe.status === 0) return command;
  }
  assert.fail(
    `clean paperdoll audit requires Python with Pillow and NumPy; tried ${candidates.join(", ")}`,
  );
}

async function fileSha256(relativePath) {
  return createHash("sha256")
    .update(await readFile(path.join(root, relativePath)))
    .digest("hex");
}

async function verifyInventory(inventory, expectedPaths) {
  const entries = Object.entries(inventory.sha256).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  const sortedExpectedPaths = [...expectedPaths].sort();
  assert.equal(inventory.count, sortedExpectedPaths.length);
  assert.deepEqual(
    entries.map(([relativePath]) => relativePath),
    sortedExpectedPaths,
  );
  for (const [relativePath, expectedSha256] of entries) {
    assert.equal(await fileSha256(relativePath), expectedSha256, relativePath);
  }
  const payload = entries
    .map(([relativePath, digest]) => `${relativePath}:${digest}\n`)
    .join("");
  assert.equal(
    createHash("sha256").update(payload, "utf8").digest("hex"),
    inventory.aggregateSha256,
  );
}

test("the clean rig build report pins every deterministic input", async () => {
  const [report, prompt] = await Promise.all(
    [
      "asset-sources/paperdoll/v6/build-report.json",
      "asset-sources/imagegen/harin-neutral-paperdoll-v6.prompt.json",
    ].map(async (relativePath) =>
      JSON.parse(await readFile(path.join(root, relativePath), "utf8")),
    ),
  );
  for (const [relativePath, expectedSha256] of [
    [prompt.originalReference, prompt.originalReferenceSha256],
    [prompt.referencedImage, prompt.referencedImageSha256],
    [prompt.outputs.keyedSource, prompt.outputs.keyedSourceSha256],
    [
      prompt.outputs.bareWalkTransparent,
      prompt.outputs.bareWalkTransparentSha256,
    ],
    [
      prompt.outputs.idleEditTransparent,
      prompt.outputs.idleEditTransparentSha256,
    ],
    [prompt.outputs.transparentSource, prompt.outputs.transparentSourceSha256],
    ...prompt.edits.flatMap((edit) => [
      [edit.referencedImage, edit.referencedImageSha256],
      [edit.output, edit.outputSha256],
    ]),
    [prompt.postprocess.script, prompt.postprocess.scriptSha256],
    [prompt.postprocess.compositor.script, prompt.postprocess.compositor.scriptSha256],
  ]) {
    assert.equal(await fileSha256(relativePath), expectedSha256, relativePath);
  }
  assert.equal(prompt.schemaVersion, 3);
  assert.equal(prompt.edits.length, 3);
  for (const edit of prompt.edits) {
    assert.equal(edit.mode, "precise-object-edit");
    assert.match(edit.callId, /^exec-[0-9a-f-]{36}$/);
    assert.match(edit.prompt, /^Use case: precise-object-edit/);
  }
  assert.equal(prompt.edits[0].referencedImage, prompt.originalReference);
  assert.equal(prompt.edits[0].output, prompt.edits[1].referencedImage);
  assert.equal(prompt.edits[1].output, prompt.edits[2].referencedImage);
  assert.equal(prompt.edits[2].referencedImage, prompt.referencedImage);
  assert.equal(report.inputs.algorithm, "relative-path-sha256-lines-v1");
  for (const input of [
    report.inputs.legacyBody,
    report.inputs.cleanBodySource,
    report.inputs.equipmentAtlas,
  ]) {
    assert.equal(await fileSha256(input.path), input.sha256, input.path);
  }
  assert.equal(report.inputs.equipmentAtlas.helmetColumn, 2);
  await verifyInventory(
    report.inputs.profileAtlases,
    variants.map(([, filename]) => `public/assets/walk/${filename}`),
  );
  await verifyInventory(
    report.inputs.sourceLayers,
    variants.flatMap(([variant], index) =>
      slots.map(
        (slot) =>
          `public/assets/paperdoll/v1/${slot}/${String(index).padStart(2, "0")}-${variant}.png`,
      ),
    ),
  );
  await verifyInventory(report.inputs.dependencies, [
    "scripts/align_paperdoll_held_gear.py",
    "scripts/audit_paperdoll_slot_regions.py",
    "scripts/build_clean_paperdoll_rig.py",
    "scripts/build_layered_paperdoll_assets.py",
    "scripts/paperdoll_semantic_held.py",
    "scripts/remap_paperdoll_gait.py",
  ]);
  assert.equal(
    await fileSha256(report.body.output),
    report.body.sha256,
    report.body.output,
  );
  assert.equal(Object.keys(report.outputSha256).length, 100);
  for (const [relativePath, expectedSha256] of Object.entries(
    report.outputSha256,
  )) {
    assert.equal(
      await fileSha256(`public/assets/paperdoll/v6/${relativePath}`),
      expectedSha256,
      relativePath,
    );
  }
  assert.equal(report.summary.heldRecoveredCells, 0);
  assert.equal(report.summary.heldCanonicalEquipmentCells, 640);
  assert.equal(report.held.length, 640);
  for (const cell of report.held) {
    assert.equal(cell.method, "canonical-equipment-icon");
    assert.equal(cell.canonicalEquipmentIcon, true);
    assert.equal(cell.legacyHumanRecovered, false);
    assert.equal(cell.legacyHumanRowSanitized, false);
    assert.equal(cell.legacyHumanContaminated, false);
    assert.equal(cell.sourceRow, null);
    assert.equal(cell.sourceColumn, null);
    assert.ok(cell.actualBodyAlphaContactPixels >= 3);
    assert.ok(cell.actualHandAlphaContactPixels >= 3);
  }
  assert.equal(report.summary.heldActualAlphaContactZeroCells, 0);
  assert.equal(report.summary.heldActualAlphaContactUnderThreeCells, 0);
  assert.equal(report.summary.heldPalmSupportContactFailureCells, 0);
  assert.ok(report.summary.minimumHeldActualAlphaContactPixels >= 3);
  assert.ok(report.summary.minimumHeldPalmSupportContactPixels >= 3);
});

test("the active clean gameplay rig passes all 6,816 equipment poses", async (t) => {
  const temporaryDirectory = await mkdtemp(
    path.join(os.tmpdir(), "paperdoll-clean-rig-audit-"),
  );
  t.after(() => rm(temporaryDirectory, { recursive: true, force: true }));
  const reportPath = path.join(temporaryDirectory, "report.json");
  const result = spawnSync(
    findPython(),
    [auditScript, "--report", reportPath, "--strict"],
    {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
    },
  );
  const diagnostics = [result.stdout, result.stderr].filter(Boolean).join("\n");
  assert.equal(result.status, 0, `clean paperdoll audit failed\n${diagnostics}`);

  const report = JSON.parse(await readFile(reportPath, "utf8"));
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.generator, "scripts/audit_clean_paperdoll_rig.py");
  assert.equal(report.rigVersion, "v6");
  assert.equal(report.passed, true);
  assert.deepEqual(report.failures, []);
  assert.deepEqual(
    {
      atlases: report.summary.atlases,
      singleCells: report.summary.singleCells,
      heldCells: report.summary.heldCells,
      heldPairCells: report.summary.heldPairCells,
      compositeCells: report.summary.compositeCells,
      compositeRenderedCells: report.summary.compositeRenderedCells,
      totalQaPoses: report.summary.totalQaPoses,
    },
    {
      atlases: 100,
      singleCells: 3_200,
      heldCells: 640,
      heldPairCells: 3_200,
      compositeCells: 416,
      compositeRenderedCells: 416,
      totalQaPoses: 6_816,
    },
  );
  for (const field of [
    "emptyCells",
    "edgeRiskCells",
    "legacyRedHoodPixels",
    "legacyRedHoodLargestComponent",
    "heldPrimaryMissingCells",
    "heldMultiplePrimaryCells",
    "heldContactFailureCells",
    "heldActualAlphaContactZeroCells",
    "heldActualAlphaContactUnderThreeCells",
    "heldPalmSupportContactFailureCells",
    "heldBodyCorePixels",
    "heldFootCorePixels",
    "heldCanonicalSilhouetteMismatchCells",
    "heldCanonicalMissingPixels",
    "heldCanonicalExtraPixels",
    "heldSourcePersonResidualCells",
    "maximumHeldSourcePersonResidualPixels",
    "heldAreaFailureCells",
    "heldPhaseAreaOutlierCells",
    "heldLegacyHumanFailureCells",
    "heldPairOverlapCells",
    "maximumHeldPairOverlapPixels",
    "redHoodCells",
    "bareHeadFailureCells",
    "idleStanceFailureDirections",
    "compositeRenderFailureCells",
    "compositeSlotVisibilityFailureCells",
    "helmetUpperTorsoOverreachCells",
    "helmetRectangularLowerContourFailureCells",
    "helmetRectangularLowerContourIdleFailureCells",
    "lowerWearableDetachedFragmentFailureCells",
    "lowerWearableDetachedLegFragmentFailureCells",
    "lowerWearableDetachedBootFragmentFailureCells",
    "lowerWearableDetachedFragmentComponents",
    "lowerWearableDetachedFragmentPixels",
    "maximumLowerWearableDetachedFragmentPixels",
    "bootPerFootDetailFailureCells",
    "wearableLegacyLowerClothLeakCells",
    "wearableLegacyLowerClothLeakPixels",
    "maximumWearableLegacyLowerClothLeakPixels",
    "wearableNonRedLegacyClothPixels",
    "wearableNonRedLegacyClothExteriorPixels",
    "gloveSemanticFragmentFailureCells",
    "gloveSemanticFragmentComponents",
    "gloveSemanticFragmentPixels",
    "maximumGloveSemanticFragmentPixels",
  ]) {
    assert.equal(report.summary[field], 0, field);
  }
  assert.match(report.summary.compositeAggregateSha256, /^[a-f0-9]{64}$/);
  assert.equal(report.summary.minimumBootFootCoverage, 1);
  assert.equal(report.summary.bootSeparatedFootCells, 290);
  assert.equal(report.summary.bootMergedOcclusionFallbackCells, 30);
  assert.ok(report.summary.minimumBootDetailPixelsPerFoot >= 64);
  assert.equal(report.summary.minimumRequiredBootDetailPixelsPerFoot, 64);
  assert.equal(report.summary.minimumLowerWearableDetachedFragmentPixels, 1);
  assert.equal(report.summary.minimumGloveSemanticFragmentPixels, 1);
  assert.equal(report.summary.legacyLowerNonRedVariantDilation, 31);
  assert.equal(report.summary.nonRedLegacyClothVariantCount, 7);
  assert.equal(report.summary.minimumLegacyClothResidualComponentPixels, 24);
  assert.ok(report.summary.minimumArmorTorsoCoverage >= 0.5);
  assert.ok(report.summary.minimumFullBodyCoverage >= 0.65);
  assert.ok(report.summary.minimumHelmetHeadCoverage >= 0.92);
  assert.equal(report.summary.maximumAllowedHelmetUpperTorsoOverreachPixels, 12);
  assert.ok(
    report.summary.maximumHelmetUpperTorsoOverreachPixels <=
      report.summary.maximumAllowedHelmetUpperTorsoOverreachPixels,
  );
  assert.equal(report.summary.maximumAllowedHelmetLowerFlatRunPixels, 6);
  assert.equal(report.summary.maximumAllowedHelmetLowerVerticalEdgeRunPixels, 4);
  assert.equal(report.summary.minimumHelmetVisualVariants, 10);
  assert.ok(report.summary.minimumHelmetAlphaVariants >= 8);
  assert.equal(report.summary.minimumIdleLegVisualVariants, 10);
  assert.equal(report.summary.minimumIdleBootVisualVariants, 10);
  assert.ok(report.summary.minimumHeldVisiblePixels >= 128);
  assert.ok(report.summary.minimumHeldVariantMedianRatio >= 0.15);
  assert.ok(report.summary.maximumHeldRowMedianRatio <= 1.9);
  assert.ok(report.summary.minimumHeldActualAlphaContactPixels >= 3);
  assert.ok(report.summary.minimumHeldPalmSupportContactPixels >= 3);
  assert.ok(report.summary.minimumBareHeadSkinRatio >= 0.45);
  assert.ok(report.summary.maximumIdleFootBottomDifference <= 10);
  assert.ok(report.summary.minimumIdleLegAuthoredDetailPixels >= 128);
  assert.ok(report.summary.minimumIdleBootAuthoredDetailPixels >= 128);
  assert.ok(report.summary.minimumCompositeSlotVisibleDifferencePixels >= 4);
});

test("the expedition fallback cannot restore the legacy hood and duplicate weapon", async () => {
  const [canvas, renderer, legacyBuilder] = await Promise.all([
    readFile(path.join(root, "app/GameCanvas.tsx"), "utf8"),
    readFile(path.join(root, "scripts/render_layered_paperdoll_qa.py"), "utf8"),
    readFile(path.join(root, "scripts/build_layered_paperdoll_assets.py"), "utf8"),
  ]);
  assert.match(canvas, /walkHarinLegacy:\s*PAPERDOLL_BODY_PATH/);
  assert.doesNotMatch(canvas, /walkHarinLegacy:\s*["']\/assets\/walk\/harin-walk\.png/);
  assert.match(renderer, /tile_w \* len\(builds\)/);
  assert.doesNotMatch(renderer, /tile_w \* 5/);
  assert.match(
    legacyBuilder,
    /asset-sources\/paperdoll\/v1\/paperdoll-rig-manifest\.json/,
  );
  assert.doesNotMatch(
    legacyBuilder,
    /rig_manifest_path\s*=\s*workspace\s*\/\s*["']app\/paperdoll-rig-manifest\.json/,
  );
});
