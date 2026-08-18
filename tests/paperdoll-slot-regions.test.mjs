import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const auditScript = path.join(root, "scripts/audit_paperdoll_slot_regions.py");
const warningAllowlistPath = path.join(
  root,
  "asset-sources/paperdoll/paperdoll-slot-region-warning-allowlist-v2.json",
);
const historicalManifestPath = path.join(
  root,
  "asset-sources/paperdoll/v1/paperdoll-rig-manifest.json",
);

const findPython = () => {
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
    `paperdoll pixel audit requires Python with Pillow and NumPy; tried ${candidates.join(", ")}`,
  );
};

const contractProbe = String.raw`
import importlib.util
import json
from pathlib import Path
import sys

sys.dont_write_bytecode = True
script_path = Path(sys.argv[1])
spec = importlib.util.spec_from_file_location("paperdoll_slot_contract_probe", script_path)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
workspace = Path(sys.argv[4]).resolve()
source_hashes = {
    variant: module.sha256(
        workspace / "public/assets/walk" / filename
    )
    for variant, filename in module.SOURCE_PROFILE_FILENAMES.items()
}

def inspect_occlusion(report_path):
    classes, failures, metadata = module.load_occlusion_contract(
        Path(report_path),
        workspace,
        workspace / "public/assets/walk/harin-mannequin-v1.png",
        workspace / "public/assets/paperdoll/v1",
        workspace / "asset-sources/paperdoll/held-gear-v1/original",
        workspace / "public/assets/walk",
    )
    return {"classes": len(classes), "failures": failures, "metadata": metadata}

cell = "weapon/00-iron.png@0,0"
warning = "fragmented-silhouette"
candidate = {
    "atlases": [{"atlas": "weapon/00-iron.png", "sha256": "a" * 64}],
    "cells": {cell: {"warnings": [warning]}},
}
zero, zero_failures = module.evaluate_warning_contract(
    None, candidate, None, "b" * 64, source_hashes, None
)
allowed, allowed_failures = module.evaluate_warning_contract(
    Path(sys.argv[5]), candidate, None, "b" * 64, source_hashes,
    module.sha256(Path(sys.argv[5]))
)
stale, stale_failures = module.evaluate_warning_contract(
    Path(sys.argv[6]), candidate, None, "b" * 64, source_hashes,
    module.sha256(Path(sys.argv[6]))
)
generated_report = module.write_warning_allowlist(
    Path(sys.argv[7]), candidate, None, "b" * 64, source_hashes
)
generated, generated_failures = module.evaluate_warning_contract(
    Path(sys.argv[7]), candidate, None, "b" * 64, source_hashes,
    module.sha256(Path(sys.argv[7]))
)
unused, unused_failures = module.evaluate_warning_contract(
    Path(sys.argv[8]), candidate, None, "b" * 64, source_hashes,
    module.sha256(Path(sys.argv[8]))
)
stale_source, stale_source_failures = module.evaluate_warning_contract(
    Path(sys.argv[9]), candidate, None, "b" * 64, source_hashes,
    module.sha256(Path(sys.argv[9]))
)
stale_pin, stale_pin_failures = module.evaluate_warning_contract(
    Path(sys.argv[5]), candidate, None, "b" * 64, source_hashes, "0" * 64
)
reference_path = workspace / "asset-sources/paperdoll/paperdoll-slot-silhouette-reference-v2.json"
valid_reference = module.load_silhouette_reference(
    reference_path,
    workspace,
    workspace / "public/assets/walk/harin-mannequin-v1.png",
    workspace / "public/assets/paperdoll/v1",
    workspace / "public/assets/walk",
    module.sha256(reference_path),
)
stale_reference = module.load_silhouette_reference(
    reference_path,
    workspace,
    workspace / "public/assets/walk/harin-mannequin-v1.png",
    workspace / "public/assets/paperdoll/v1",
    workspace / "public/assets/walk",
    "0" * 64,
)
warning_path = workspace / "asset-sources/paperdoll/paperdoll-slot-region-warning-allowlist-v2.json"
valid_integrity = module.verify_integrity_manifest(
    workspace / "asset-sources/paperdoll/v1/paperdoll-rig-manifest.json",
    workspace,
    workspace / "public/assets/paperdoll/v1",
    workspace / "public/assets/walk/harin-mannequin-v1.png",
    workspace / "public/assets/walk",
    reference_path,
    warning_path,
)
stale_integrity = module.verify_integrity_manifest(
    Path(sys.argv[10]),
    workspace,
    workspace / "public/assets/paperdoll/v1",
    workspace / "public/assets/walk/harin-mannequin-v1.png",
    workspace / "public/assets/walk",
    reference_path,
    warning_path,
)
route_integrity = module.verify_integrity_manifest(
    Path(sys.argv[11]),
    workspace,
    workspace / "public/assets/paperdoll/v1",
    workspace / "public/assets/walk/harin-mannequin-v1.png",
    workspace / "public/assets/walk",
    reference_path,
    warning_path,
)
rig_integrity = module.verify_integrity_manifest(
    Path(sys.argv[12]),
    workspace,
    workspace / "public/assets/paperdoll/v1",
    workspace / "public/assets/walk/harin-mannequin-v1.png",
    workspace / "public/assets/walk",
    reference_path,
    warning_path,
)
outside_integrity = module.verify_integrity_manifest(
    workspace / "asset-sources/paperdoll/v1/paperdoll-rig-manifest.json",
    Path(sys.argv[13]),
    workspace / "public/assets/paperdoll/v1",
    workspace / "public/assets/walk/harin-mannequin-v1.png",
    workspace / "public/assets/walk",
    reference_path,
    warning_path,
)
print(json.dumps({
    "weaponLeftRows": [
        row for row in range(module.ROWS) if module.expected_left("weapon", row)
    ],
    "offhandLeftRows": [
        row for row in range(module.ROWS) if module.expected_left("offhand", row)
    ],
    "validOcclusion": inspect_occlusion(sys.argv[2]),
    "tamperedOcclusion": inspect_occlusion(sys.argv[3]),
    "zeroWarnings": {"contract": zero, "failures": zero_failures},
    "allowedWarning": {"contract": allowed, "failures": allowed_failures},
    "staleWarning": {"contract": stale, "failures": stale_failures},
    "generatedWarning": {
        "report": generated_report,
        "contract": generated,
        "failures": generated_failures,
    },
    "unusedWarning": {"contract": unused, "failures": unused_failures},
    "staleSourceWarning": {
        "contract": stale_source,
        "failures": stale_source_failures,
    },
    "stalePinWarning": {"contract": stale_pin, "failures": stale_pin_failures},
    "validReference": {
        "classes": len(valid_reference[0]),
        "failures": valid_reference[1],
        "metadata": valid_reference[2],
    },
    "staleReference": {
        "classes": len(stale_reference[0]),
        "failures": stale_reference[1],
        "metadata": stale_reference[2],
    },
    "validIntegrity": {"metadata": valid_integrity[0], "failures": valid_integrity[1]},
    "staleIntegrity": {"metadata": stale_integrity[0], "failures": stale_integrity[1]},
    "routeIntegrity": {"metadata": route_integrity[0], "failures": route_integrity[1]},
    "rigIntegrity": {"metadata": rig_integrity[0], "failures": rig_integrity[1]},
    "outsideIntegrity": {"metadata": outside_integrity[0], "failures": outside_integrity[1]},
}))
`;

const geometryProbe = String.raw`
import importlib.util
import json
from collections import deque
from pathlib import Path
from PIL import Image
import numpy as np
import sys

sys.dont_write_bytecode = True
script_path = Path(sys.argv[1])
spec = importlib.util.spec_from_file_location("paperdoll_geometry_contract_probe", script_path)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
workspace = Path(sys.argv[2]).resolve()
body_atlas = Image.open(
    workspace / "public/assets/walk/harin-mannequin-v1.png"
).convert("RGBA")
geometry = module.body_geometry(body_atlas.crop(module.frame_box(0, 0)))

def reference_for(slot, row=0, column=0):
    atlas = Image.open(
        workspace / "public/assets/paperdoll/v1" / slot / "00-iron.png"
    ).convert("RGBA")
    image = atlas.crop(module.frame_box(row, column))
    resolved_geometry = module.body_geometry(
        body_atlas.crop(module.frame_box(row, column))
    )
    metrics = module.mask_metrics(image, resolved_geometry, slot, row)
    return image, resolved_geometry, {
        "rgbaSha256": metrics["rgbaSha256"],
        "metrics": module.reference_metric_record(metrics),
    }

def dot_center(slot, resolved_geometry, reference_image):
    if slot in module.HELD_SLOTS:
        side = (
            resolved_geometry["rx"] <= 0.05
            if module.expected_left(slot, 0)
            else resolved_geometry["rx"] >= -0.05
        )
        zone = (
            resolved_geometry["body"]
            & (resolved_geometry["ry"] >= 0.27)
            & (resolved_geometry["ry"] <= 0.78)
            & side
        )
        y, x = np.where(zone)
    else:
        alpha = np.asarray(reference_image.getchannel("A"), dtype=np.uint8)
        y, x = np.where(alpha > module.VISIBLE_ALPHA)
    return int(np.median(x)), int(np.median(y))

dot_results = {}
for size in (4, 6, 8, 10):
    size_results = {}
    for slot in module.SLOTS:
        reference_image, resolved_geometry, reference = reference_for(slot)
        center_x, center_y = dot_center(slot, resolved_geometry, reference_image)
        x0 = max(2, min(module.CELL_W - size - 2, center_x - size // 2))
        y0 = max(2, min(module.CELL_H - size - 2, center_y - size // 2))
        dot = Image.new("RGBA", (module.CELL_W, module.CELL_H), (0, 0, 0, 0))
        for y in range(y0, y0 + size):
            for x in range(x0, x0 + size):
                dot.putpixel((x, y), (255, 255, 255, 255))
        metrics = module.mask_metrics(dot, resolved_geometry, slot, 0)
        failures, warnings = module.evaluate_absolute(
            f"{slot}/synthetic.png@0,0", slot, metrics, {}, {}, reference
        )
        size_results[slot] = {
            "metrics": {
                "visiblePixels": metrics["visiblePixels"],
                "visibleWidth": metrics["visibleWidth"],
                "visibleHeight": metrics["visibleHeight"],
                "bodyOrSlotSignalPixels": metrics["bodyOrSlotSignalPixels"],
                "broadHandContactPixels": (
                    metrics["held"]["broadHandContactPixels"]
                    if metrics["held"] is not None
                    else None
                ),
            },
            "failures": failures,
            "warnings": warnings,
        }
    dot_results[str(size)] = size_results

detached = Image.new("RGBA", (module.CELL_W, module.CELL_H), (0, 0, 0, 0))
for y in range(12, 24):
    for x in range(12, 24):
        detached.putpixel((x, y), (255, 255, 255, 255))
contact_cell = "weapon/synthetic.png@0,0"
contact_metrics = module.mask_metrics(detached, geometry, "weapon", 0)
aligned_failures, _ = module.evaluate_absolute(
    contact_cell,
    "weapon",
    contact_metrics,
    {contact_cell: "aligned-visible"},
    {},
)
forged_failures, _ = module.evaluate_absolute(
    contact_cell,
    "weapon",
    contact_metrics,
    {contact_cell: "occluded-hidden-grip"},
    {},
)

reference_image, weapon_geometry, weapon_reference = reference_for("weapon")
reference_rgba = np.asarray(reference_image, dtype=np.uint8)
reference_visible = reference_rgba[:, :, 3] > module.VISIBLE_ALPHA
seen = np.zeros(reference_visible.shape, dtype=bool)
components = []
for start_y, start_x in zip(*np.where(reference_visible)):
    if seen[start_y, start_x]:
        continue
    queue = deque([(int(start_x), int(start_y))])
    seen[start_y, start_x] = True
    component = []
    while queue:
        x, y = queue.popleft()
        component.append((x, y))
        for ny in range(max(0, y - 1), min(module.CELL_H, y + 2)):
            for nx in range(max(0, x - 1), min(module.CELL_W, x + 2)):
                if reference_visible[ny, nx] and not seen[ny, nx]:
                    seen[ny, nx] = True
                    queue.append((nx, ny))
    components.append(component)
largest = max(components, key=len)
partial_results = {}
for fraction in (0.10, 0.20, 0.30):
    retained = largest[:max(1, round(len(largest) * fraction))]
    partial_rgba = np.zeros_like(reference_rgba)
    for x, y in retained:
        partial_rgba[y, x] = reference_rgba[y, x]
    partial = Image.fromarray(partial_rgba, mode="RGBA")
    partial_metrics = module.mask_metrics(partial, weapon_geometry, "weapon", 0)
    partial_failures, _ = module.evaluate_absolute(
        "weapon/00-iron.png@0,0",
        "weapon",
        partial_metrics,
        {},
        {},
        weapon_reference,
    )
    partial_results[str(fraction)] = {
        "visibleRatio": partial_metrics["visiblePixels"] / max(
            1, weapon_reference["metrics"]["visiblePixels"]
        ),
        "failures": partial_failures,
    }

weapon_atlas = Image.open(
    workspace / "public/assets/paperdoll/v1/weapon/00-iron.png"
).convert("RGBA")
copied_phase = weapon_atlas.crop(module.frame_box(0, 1))
copied_metrics = module.mask_metrics(copied_phase, weapon_geometry, "weapon", 0)
copied_failures, _ = module.evaluate_absolute(
    "weapon/00-iron.png@0,0",
    "weapon",
    copied_metrics,
    {},
    {},
    weapon_reference,
)

forged_reference = json.loads(json.dumps(weapon_reference))
forged_reference["metrics"]["visiblePixels"] += 1
original_metrics = module.mask_metrics(
    reference_image, weapon_geometry, "weapon", 0
)
forged_reference_failures, _ = module.evaluate_absolute(
    "weapon/00-iron.png@0,0",
    "weapon",
    original_metrics,
    {},
    {},
    forged_reference,
)

print(json.dumps({
    "dotResults": dot_results,
    "contact": {
        "visiblePixels": contact_metrics["visiblePixels"],
        "broadHandContactPixels": contact_metrics["held"]["broadHandContactPixels"],
        "alignedFailures": aligned_failures,
        "forgedFailures": forged_failures,
    },
    "partialResults": partial_results,
    "copiedPhase": {
        "hashMatch": copied_metrics["rgbaSha256"] == weapon_reference["rgbaSha256"],
        "failures": copied_failures,
    },
    "forgedReferenceFailures": forged_reference_failures,
}))
`;

let geometryProbeCache;
function runGeometryProbe() {
  if (geometryProbeCache) return geometryProbeCache;
  const result = spawnSync(findPython(), ["-c", geometryProbe, auditScript, root], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
    windowsHide: true,
  });
  const diagnostics = [result.stdout, result.stderr].filter(Boolean).join("\n");
  assert.equal(result.status, 0, diagnostics);
  geometryProbeCache = JSON.parse(result.stdout);
  return geometryProbeCache;
}

test("4x4, 6x6, 8x8, and 10x10 dots fail source-shape provenance", () => {
  const probe = runGeometryProbe();
  assert.deepEqual(Object.keys(probe.dotResults), ["4", "6", "8", "10"]);
  for (const [size, slotResults] of Object.entries(probe.dotResults)) {
    for (const [slot, result] of Object.entries(slotResults)) {
      assert.equal(result.metrics.visiblePixels, Number(size) ** 2);
      assert.equal(result.metrics.visibleWidth, Number(size));
      assert.equal(result.metrics.visibleHeight, Number(size));
      assert.ok(
        result.failures.includes("source-reference-cell-rgba-mismatch"),
        `${slot} accepted a ${size}x${size} dot against exact provenance`,
      );
      if (Number(size) <= 8) {
        assert.ok(result.warnings.includes("undersized-or-detached-silhouette"));
      }
      if (slot === "weapon" || slot === "offhand") {
        assert.ok(
          result.metrics.broadHandContactPixels >= 3,
          `${slot} ${size}x${size} adversary must touch the hand`,
        );
      }
    }
  }
});

test("connected 10-30% silhouette remnants fail source-shape preservation", () => {
  const { partialResults } = runGeometryProbe();
  for (const [fraction, result] of Object.entries(partialResults)) {
    assert.ok(result.visibleRatio <= Number(fraction) + 0.01);
    assert.ok(result.failures.includes("source-reference-cell-rgba-mismatch"));
    assert.ok(result.failures.includes("source-shape-visible-mass-loss"));
  }
});

test("cross-frame cell copies fail exact source provenance", () => {
  const { copiedPhase } = runGeometryProbe();
  assert.equal(copiedPhase.hashMatch, false);
  assert.ok(copiedPhase.failures.includes("source-reference-cell-rgba-mismatch"));
});

test("forged numeric reference metrics cannot override exact RGBA provenance", () => {
  const { forgedReferenceFailures } = runGeometryProbe();
  assert.ok(forgedReferenceFailures.includes("source-reference-metrics-mismatch"));
});

test("alignment classifications cannot waive held-item hand contact", () => {
  const { contact } = runGeometryProbe();
  assert.equal(contact.visiblePixels, 144);
  assert.equal(contact.broadHandContactPixels, 0);
  assert.ok(contact.alignedFailures.includes("held-item-misses-hand"));
  assert.ok(contact.forgedFailures.includes("held-item-misses-hand"));
  assert.deepEqual(contact.forgedFailures, contact.alignedFailures);
});

test("alignment provenance and warning exceptions are current-PNG hash-bound", async (t) => {
  const temporaryDirectory = await mkdtemp(
    path.join(os.tmpdir(), "paperdoll-slot-contract-probe-"),
  );
  t.after(() => rm(temporaryDirectory, { recursive: true, force: true }));
  const alignmentPath = path.join(
    root,
    "asset-sources/paperdoll/held-gear-v1/alignment-report.json",
  );
  const alignment = JSON.parse(await readFile(alignmentPath, "utf8"));
  const rigManifest = JSON.parse(
    await readFile(historicalManifestPath, "utf8"),
  );
  const firstOutput = Object.keys(alignment.outputs).sort()[0];
  const tamperedAlignment = structuredClone(alignment);
  tamperedAlignment.outputs[firstOutput].sha256 = "0".repeat(64);
  const tamperedAlignmentPath = path.join(temporaryDirectory, "alignment-report.json");

  const warningEntry = {
    scope: "candidate",
    cell: "weapon/00-iron.png@0,0",
    warning: "fragmented-silhouette",
    atlas: "weapon/00-iron.png",
    atlasSha256: "a".repeat(64),
    sourceProfile: "harin-equipped-iron-v1.png",
    sourceProfileSha256:
      alignment.sourceProfiles["harin-equipped-iron-v1.png"].sha256,
  };
  const warningAllowlist = {
    schemaVersion: 1,
    contract: "paperdoll-slot-region-warning-allowlist-v2",
    algorithmVersion: "paperdoll-slot-region-v2",
    bodySha256: "b".repeat(64),
    entries: [warningEntry],
  };
  const probeWarningAllowlistPath = path.join(temporaryDirectory, "warning-allowlist.json");
  const staleWarningAllowlistPath = path.join(
    temporaryDirectory,
    "stale-warning-allowlist.json",
  );
  const generatedWarningAllowlistPath = path.join(
    temporaryDirectory,
    "generated-warning-allowlist.json",
  );
  const unusedWarningAllowlistPath = path.join(
    temporaryDirectory,
    "unused-warning-allowlist.json",
  );
  const staleSourceWarningAllowlistPath = path.join(
    temporaryDirectory,
    "stale-source-warning-allowlist.json",
  );
  const staleIntegrityManifestPath = path.join(
    temporaryDirectory,
    "stale-paperdoll-rig-manifest.json",
  );
  const routeIntegrityManifestPath = path.join(
    temporaryDirectory,
    "route-paperdoll-rig-manifest.json",
  );
  const rigIntegrityManifestPath = path.join(
    temporaryDirectory,
    "rig-paperdoll-rig-manifest.json",
  );
  const staleIntegrityManifest = structuredClone(rigManifest);
  staleIntegrityManifest.assetRevision = "0".repeat(64);
  const routeIntegrityManifest = structuredClone(rigManifest);
  routeIntegrityManifest.bodyPath = "/assets/walk/attacker.png";
  routeIntegrityManifest.layerRoot = "/assets/paperdoll/attacker";
  routeIntegrityManifest.assetIntegrity.silhouetteReferencePath =
    "asset-sources/paperdoll/attacker-reference.json";
  routeIntegrityManifest.assetIntegrity.warningAllowlistPath =
    "asset-sources/paperdoll/attacker-allowlist.json";
  const rigIntegrityManifest = structuredClone(rigManifest);
  rigIntegrityManifest.schemaVersion = 2;
  rigIntegrityManifest.version = "v-attacker";
  rigIntegrityManifest.frame.width = 255;
  rigIntegrityManifest.frame.groundBaseline = 183;
  rigIntegrityManifest.frame.directionRows = [7, 0, 6, 3, 4, 5, 2, 1];
  rigIntegrityManifest.worldRender = { width: 135, height: 101 };
  rigIntegrityManifest.slots = [...rigIntegrityManifest.slots].reverse();
  rigIntegrityManifest.variantNames = [...rigIntegrityManifest.variantNames].reverse();
  rigIntegrityManifest.qaCompositeBuilds[0].variants[0] = 9;
  rigIntegrityManifest.anchorReport.alphaThreshold = 15;
  await Promise.all([
    writeFile(tamperedAlignmentPath, `${JSON.stringify(tamperedAlignment)}\n`, "utf8"),
    writeFile(probeWarningAllowlistPath, `${JSON.stringify(warningAllowlist)}\n`, "utf8"),
    writeFile(
      staleWarningAllowlistPath,
      `${JSON.stringify({
        ...warningAllowlist,
        entries: [{ ...warningEntry, atlasSha256: "c".repeat(64) }],
      })}\n`,
      "utf8",
    ),
    writeFile(
      unusedWarningAllowlistPath,
      `${JSON.stringify({
        ...warningAllowlist,
        entries: [{ ...warningEntry, warning: "unused-warning" }],
      })}\n`,
      "utf8",
    ),
    writeFile(
      staleSourceWarningAllowlistPath,
      `${JSON.stringify({
        ...warningAllowlist,
        entries: [
          { ...warningEntry, sourceProfileSha256: "d".repeat(64) },
        ],
      })}\n`,
      "utf8",
    ),
    writeFile(
      staleIntegrityManifestPath,
      `${JSON.stringify(staleIntegrityManifest)}\n`,
      "utf8",
    ),
    writeFile(
      routeIntegrityManifestPath,
      `${JSON.stringify(routeIntegrityManifest)}\n`,
      "utf8",
    ),
    writeFile(
      rigIntegrityManifestPath,
      `${JSON.stringify(rigIntegrityManifest)}\n`,
      "utf8",
    ),
  ]);

  const python = findPython();
  const result = spawnSync(
    python,
    [
      "-c",
      contractProbe,
      auditScript,
      alignmentPath,
      tamperedAlignmentPath,
      root,
      probeWarningAllowlistPath,
      staleWarningAllowlistPath,
      generatedWarningAllowlistPath,
      unusedWarningAllowlistPath,
      staleSourceWarningAllowlistPath,
      staleIntegrityManifestPath,
      routeIntegrityManifestPath,
      rigIntegrityManifestPath,
      temporaryDirectory,
    ],
    {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true,
    },
  );
  const diagnostics = [result.stdout, result.stderr].filter(Boolean).join("\n");
  assert.equal(result.status, 0, diagnostics);
  const probe = JSON.parse(result.stdout);

  assert.equal(probe.validOcclusion.metadata.verified, true);
  assert.deepEqual(probe.weaponLeftRows, [0, 1, 6]);
  assert.deepEqual(probe.offhandLeftRows, [2, 3, 4, 5, 7]);
  assert.equal(probe.validOcclusion.classes, 640);
  assert.deepEqual(probe.validOcclusion.failures, []);
  assert.equal(probe.tamperedOcclusion.metadata.verified, false);
  assert.equal(probe.tamperedOcclusion.classes, 0);
  assert.ok(
    probe.tamperedOcclusion.failures.some((failure) =>
      failure.startsWith(`occlusion-outputs-hash-mismatch:${firstOutput}:`),
    ),
  );

  assert.equal(probe.zeroWarnings.contract.passed, false);
  assert.equal(probe.zeroWarnings.contract.unallowedCount, 1);
  assert.deepEqual(probe.zeroWarnings.failures, []);
  assert.equal(probe.allowedWarning.contract.passed, true);
  assert.equal(probe.allowedWarning.contract.allowedCount, 1);
  assert.deepEqual(probe.allowedWarning.failures, []);
  assert.equal(probe.staleWarning.contract.passed, false);
  assert.ok(
    probe.staleWarning.failures.some((failure) =>
      failure.startsWith("warning-allowlist-atlas-hash-mismatch:"),
    ),
  );
  assert.equal(probe.generatedWarning.contract.passed, true);
  assert.equal(probe.generatedWarning.contract.allowedCount, 1);
  assert.deepEqual(probe.generatedWarning.failures, []);
  assert.equal(probe.generatedWarning.report.entries.length, 1);
  assert.equal(probe.generatedWarning.report.entries[0].atlasSha256, "a".repeat(64));
  assert.equal(probe.unusedWarning.contract.passed, false);
  assert.ok(
    probe.unusedWarning.failures.some((failure) =>
      failure.startsWith("unused-warning-allowlist-entry:"),
    ),
  );
  assert.equal(probe.staleSourceWarning.contract.passed, false);
  assert.ok(
    probe.staleSourceWarning.failures.some((failure) =>
      failure.startsWith("warning-allowlist-source-profile-hash-mismatch:"),
    ),
  );
  assert.equal(probe.stalePinWarning.contract.passed, false);
  assert.ok(
    probe.stalePinWarning.failures.includes(
      "warning-allowlist-approved-sha256-mismatch",
    ),
  );
  assert.equal(probe.validReference.metadata.verified, true);
  assert.equal(probe.validReference.classes, 3_200);
  assert.deepEqual(probe.validReference.failures, []);
  assert.equal(probe.staleReference.metadata.verified, false);
  assert.ok(
    probe.staleReference.failures.includes(
      "silhouette-reference-approved-sha256-mismatch",
    ),
  );
  assert.equal(probe.validIntegrity.metadata.verified, true);
  assert.deepEqual(probe.validIntegrity.failures, []);
  assert.equal(probe.staleIntegrity.metadata.verified, false);
  assert.ok(
    probe.staleIntegrity.failures.includes("paperdoll-asset-revision-mismatch"),
  );
  assert.equal(probe.routeIntegrity.metadata.verified, false);
  assert.ok(
    probe.routeIntegrity.failures.includes("paperdoll-rig-body-path-mismatch"),
  );
  assert.ok(
    probe.routeIntegrity.failures.includes("paperdoll-rig-layer-root-mismatch"),
  );
  assert.ok(
    probe.routeIntegrity.failures.includes(
      "paperdoll-silhouette-reference-path-mismatch",
    ),
  );
  assert.ok(
    probe.routeIntegrity.failures.includes(
      "paperdoll-warning-allowlist-path-mismatch",
    ),
  );
  assert.equal(probe.rigIntegrity.metadata.verified, false);
  for (const failure of [
    "paperdoll-rig-schema-contract-mismatch",
    "paperdoll-rig-version-contract-mismatch",
    "paperdoll-rig-frame-contract-mismatch",
    "paperdoll-rig-direction-rows-contract-mismatch",
    "paperdoll-rig-world-render-contract-mismatch",
    "paperdoll-rig-slots-contract-mismatch",
    "paperdoll-rig-variants-contract-mismatch",
    "paperdoll-rig-qa-composite-builds-contract-mismatch",
    "paperdoll-rig-anchor-report-contract-mismatch",
  ]) {
    assert.ok(probe.rigIntegrity.failures.includes(failure), failure);
  }
  assert.equal(probe.outsideIntegrity.metadata.verified, false);
  assert.ok(
    probe.outsideIntegrity.failures.includes(
      "paperdoll-body-outside-record-workspace-public",
    ),
  );
  assert.ok(
    probe.outsideIntegrity.failures.includes(
      "paperdoll-layer-root-outside-record-workspace-public",
    ),
  );
});

test("all 3,200 paperdoll cells obey absolute slot-isolation limits", async (t) => {
  const temporaryDirectory = await mkdtemp(
    path.join(os.tmpdir(), "paperdoll-slot-region-audit-"),
  );
  t.after(() => rm(temporaryDirectory, { recursive: true, force: true }));
  const reportPath = path.join(temporaryDirectory, "report.json");
  const python = findPython();
  const result = spawnSync(
    python,
    [
      auditScript,
      "--integrity-manifest",
      historicalManifestPath,
      "--report",
      reportPath,
      "--warning-allowlist",
      warningAllowlistPath,
      "--strict",
    ],
    {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
    },
  );
  const diagnostics = [result.stdout, result.stderr].filter(Boolean).join("\n");
  assert.equal(
    result.status,
    0,
    `absolute paperdoll slot audit failed\n${diagnostics}`,
  );

  const report = JSON.parse(await readFile(reportPath, "utf8"));
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.algorithmVersion, "paperdoll-slot-region-v2");
  assert.equal(report.generator, "scripts/audit_paperdoll_slot_regions.py");
  assert.equal(report.passed, true);
  assert.deepEqual(report.configurationFailures, []);
  assert.equal(report.baseline, null, "a contaminated baseline must not waive absolute limits");
  assert.equal(report.comparison, null);
  assert.deepEqual(report.configuration.heldWeaponLeftAuthoredRows, [0, 1, 6]);

  assert.equal(report.occlusionContract.verified, true);
  assert.equal(report.occlusionContract.generator, "scripts/align_paperdoll_held_gear.py");
  assert.equal(report.occlusionContract.contract, "registered-delta-hand-connected-v2");
  assert.equal(report.occlusionContract.geometryExemptionsAllowed, false);
  assert.equal(report.occlusionContract.exemptCells, 0);
  assert.equal(report.occlusionContract.verifiedInputs, 20);
  assert.equal(report.occlusionContract.verifiedOutputs, 20);
  assert.equal(report.occlusionContract.verifiedSourceProfiles, 10);
  assert.equal(report.occlusionContract.verifiedCells, 640);
  assert.match(report.occlusionContract.sha256, /^[a-f0-9]{64}$/);

  assert.equal(report.warningContract.mode, "hash-bound-allowlist");
  assert.equal(report.warningContract.generated, false);
  assert.equal(report.warningContract.passed, true);
  assert.equal(report.warningContract.observedCount, 15);
  assert.equal(report.warningContract.allowedCount, 15);
  assert.equal(report.warningContract.unallowedCount, 0);
  assert.equal(report.warningContract.observed.length, 15);
  assert.equal(report.warningContract.allowed.length, 15);
  assert.deepEqual(report.warningContract.unallowed, []);

  const summary = report.candidate.summary;
  assert.equal(summary.expectedAtlases, 100);
  assert.equal(summary.actualAtlases, 100);
  assert.equal(summary.expectedCells, 3_200);
  assert.equal(summary.auditedCells, 3_200);
  assert.equal(summary.failedCells, 0);
  assert.equal(summary.failureCount, 0);
  assert.equal(summary.warningCount, 15);
  assert.equal(summary.clippingRiskCells, 0);
  assert.equal(summary.slotRegionLeakCells, 0);
  assert.equal(summary.heldBodyPollutionCells, 0);
  assert.equal(summary.heldFootPollutionCells, 0);
  assert.equal(summary.heldWrongSideCells, 0);
  assert.equal(summary.heldContactFailureCells, 0);
  assert.equal(summary.invisibleDirectionGroups, 0);
  assert.equal(summary.silhouetteWarningCells, 11);
  assert.equal(summary.sourceReferenceHashMismatchCells, 0);
  assert.equal(summary.sourceShapeLossCells, 0);

  assert.equal(report.silhouetteReference.verified, true);
  assert.equal(
    report.silhouetteReference.contract,
    "registered-source-silhouette-reference-v2",
  );
  assert.equal(report.silhouetteReference.verifiedCells, 3_200);
  assert.equal(report.silhouetteReference.verifiedSourceProfiles, 10);
  assert.equal(report.silhouetteReference.candidateAtlasHashMatches, 100);
  assert.match(report.silhouetteReference.sha256, /^[a-f0-9]{64}$/);
  assert.equal(report.assetIntegrity.verified, true);
  assert.equal(
    report.assetIntegrity.assetRevision.approved,
    report.assetIntegrity.assetRevision.computed,
  );
  assert.equal(report.assetIntegrity.atlasCount, 100);

  const thresholds = report.configuration.thresholds;
  assert.deepEqual(thresholds.held.weaponBodyCore, { pixels: 320, ratio: 0.18 });
  assert.deepEqual(thresholds.held.offhandBodyCore, { pixels: 900, ratio: 0.34 });
  assert.deepEqual(thresholds.held.footCore, { pixels: 64, ratio: 0.04 });
  assert.deepEqual(thresholds.directionVisibility, {
    minimumStrongPhaseVisiblePixels: 16,
    minimumFourPhaseVisiblePixels: 48,
    minimumStrongPhaseAlphaMass: 2_048,
    minimumFourPhaseAlphaMass: 6_144,
  });
  assert.deepEqual(thresholds.minimumSilhouette, {
    visiblePixels: 48,
    width: 10,
    height: 10,
    bodyOrSlotSignalPixels: 8,
    bodyNearDilationPixels: 11,
  });
  assert.deepEqual(thresholds.referencePreservation, {
    visiblePixelsRatio: 0.35,
    widthRatio: 0.5,
    heightRatio: 0.5,
    largestComponentPixelsRatio: 0.3,
    bodyOrSlotSignalPixelsRatio: 0.35,
    coarseOccupiedTileRetention: 0.35,
    coarseGridColumns: 8,
    coarseGridRows: 6,
  });
});
