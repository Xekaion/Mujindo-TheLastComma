import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = "asset-sources/paperdoll/held-gear-v1";
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

const pngSize = (bytes, label) => {
  assert.equal(bytes.subarray(1, 4).toString("ascii"), "PNG", `${label} is not a PNG`);
  return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
};

test("active v1 held gear is rebuilt from preserved originals with rigid integer offsets", async () => {
  const [alignment, audit, generator] = await Promise.all([
    readFile(path.join(root, sourceRoot, "alignment-report.json"), "utf8").then(JSON.parse),
    readFile(path.join(root, sourceRoot, "audit-report.json"), "utf8").then(JSON.parse),
    readFile(path.join(root, "scripts/align_paperdoll_held_gear.py"), "utf8"),
  ]);

  assert.equal(alignment.schemaVersion, 1);
  assert.equal(alignment.generator, "scripts/align_paperdoll_held_gear.py");
  assert.equal(alignment.contract, "integer-rigid-translate-only");
  assert.equal(alignment.summary.cells, 640);
  assert.equal(alignment.summary.atlases, 20);
  assert.equal(alignment.summary.alphaMassPreservedCells, 640);
  assert.equal(alignment.summary.emptyCells, 0);
  assert.equal(alignment.summary.clippedCells, 0);
  assert.ok(alignment.summary.classifications["aligned-visible"] >= 500);
  assert.equal(alignment.summary.classifications["unresolved-visible"] ?? 0, 0);
  assert.match(generator, /shared red-hood landmark/);
  assert.match(generator, /integer rigid translation/);
  assert.match(generator, /alphaMassBefore/);
  assert.doesNotMatch(generator, /Image\.Transform/);

  assert.equal(Object.keys(alignment.inputs).length, 20);
  assert.equal(Object.keys(alignment.outputs).length, 20);
  for (const [key, input] of Object.entries(alignment.inputs)) {
    const output = alignment.outputs[key];
    assert.ok(output, `${key} is missing its aligned output record`);
    assert.match(input.path, /^asset-sources\/paperdoll\/held-gear-v1\/original\/(?:weapon|offhand)\//);
    assert.match(output.path, /^public\/assets\/paperdoll\/v1\/(?:weapon|offhand)\//);
    const [inputBytes, outputBytes] = await Promise.all([
      readFile(path.join(root, input.path)),
      readFile(path.join(root, output.path)),
    ]);
    assert.equal(sha256(inputBytes), input.sha256, `${key} original hash drifted`);
    assert.equal(sha256(outputBytes), output.sha256, `${key} output hash drifted`);
    assert.deepEqual(pngSize(inputBytes, `${key} original`), [1024, 1536]);
    assert.deepEqual(pngSize(outputBytes, `${key} output`), [1024, 1536]);
  }

  for (const cell of alignment.perCell) {
    assert.equal(cell.alphaMassPreserved, true, `${cell.cell} lost authored alpha`);
    assert.equal(cell.clipped, false, `${cell.cell} clipped at its atlas edge`);
    assert.ok(cell.visiblePixels > 0, `${cell.cell} became empty`);
    assert.ok(cell.finalOffset.every(Number.isInteger), `${cell.cell} used a non-integer transform`);
    assert.ok(cell.refinementOffset.every(Number.isInteger), `${cell.cell} used a non-integer refinement`);
    assert.ok(cell.bounds[0] >= 2 && cell.bounds[1] >= 2, `${cell.cell} lost its leading gutter`);
    assert.ok(cell.bounds[2] <= 254 && cell.bounds[3] <= 190, `${cell.cell} lost its trailing gutter`);
  }

  assert.equal(audit.passed, true);
  assert.equal(audit.summary.cells, 640);
  assert.ok(audit.summary.contactEligibleCells >= 500);
  assert.ok(audit.summary.occlusionExemptCells >= 100);
  assert.ok(audit.summary.beforeContactFailures >= 450);
  assert.equal(audit.summary.afterContactFailures, 0);
  assert.equal(audit.summary.emptyCells, 0);
  assert.equal(audit.summary.edgeRiskCells, 0);
  assert.equal(audit.summary.alphaMassPreservedCells, 640);
  assert.ok(audit.summary.worstFootCoreRatioGrowth <= 0.25);
});

test("held-gear alignment preview covers every variant, direction and gait phase", async () => {
  const preview = await readFile(path.join(root, sourceRoot, "alignment-preview.png"));
  assert.deepEqual(pngSize(preview, "held-gear alignment preview"), [2048, 1120]);

  const builder = await readFile(
    path.join(root, "scripts/build_layered_paperdoll_assets.py"),
    "utf8",
  );
  assert.match(builder, /align_held_gear_assets/);
  assert.match(builder, /alignment-preview\.png/);
});
