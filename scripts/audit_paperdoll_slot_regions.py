#!/usr/bin/env python3
"""Audit all 3,200 paperdoll cells for absolute slot isolation.

The audit reads the neutral mannequin and one or two paperdoll layer roots,
then emits a deterministic JSON report.  It never rewrites production art.

The important distinction from ``scripts/audit_paperdoll_held_gear.py`` is
that absolute anatomical limits always apply.  A polluted baseline can be
useful for before/after deltas, but can never make a polluted candidate pass.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from collections import deque
from pathlib import Path
from typing import Any

import numpy as np
from PIL import Image, ImageFilter


CELL_W = 256
CELL_H = 192
ROWS = 8
COLS = 4
ATLAS_SIZE = (CELL_W * COLS, CELL_H * ROWS)
VISIBLE_ALPHA = 8
BODY_ALPHA = 16
AUDIT_ALGORITHM_VERSION = "paperdoll-slot-region-v2"
SOURCE_OWNER_ALGORITHM_VERSION = "layered-paperdoll-owner-v1"
ALIGNMENT_REPORT_GENERATOR = "scripts/align_paperdoll_held_gear.py"
ALIGNMENT_REPORT_SCHEMA = 2
ALIGNMENT_REPORT_CONTRACT = "registered-delta-hand-connected-v2"
WARNING_ALLOWLIST_CONTRACT = "paperdoll-slot-region-warning-allowlist-v2"
SILHOUETTE_REFERENCE_CONTRACT = "registered-source-silhouette-reference-v2"
SLOTS = (
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
)
VARIANTS = (
    "00-iron.png",
    "01-frost.png",
    "02-jade.png",
    "03-blood.png",
    "04-arcane.png",
    "05-waraxe.png",
    "06-celestial.png",
    "07-void.png",
    "08-sealed.png",
    "09-cosmic.png",
)
RIG_SCHEMA_VERSION = 1
RIG_VERSION = "v1"
RIG_DIRECTION_ROWS = (0, 7, 6, 3, 4, 5, 2, 1)
RIG_GROUND_BASELINE = 184
RIG_WORLD_RENDER = {"width": 136, "height": 102}
RIG_VARIANT_NAMES = tuple(
    filename.removesuffix(".png").split("-", 1)[1] for filename in VARIANTS
)
RIG_QA_COMPOSITE_BUILDS = (
    {"label": "same-iron", "variants": [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]},
    {"label": "same-cosmic", "variants": [9, 9, 9, 9, 9, 9, 9, 9, 9, 9]},
    {"label": "mixed-ascending", "variants": [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]},
    {"label": "mixed-descending", "variants": [9, 8, 7, 6, 5, 4, 3, 2, 1, 0]},
    {"label": "mixed-alternating", "variants": [9, 0, 8, 1, 7, 2, 6, 3, 5, 4]},
)
RIG_ANCHOR_REPORT = {
    "auditPath": "paperdoll-rig-anchors.generated.json",
    "runtimePath": "paperdoll-rig-anchors.runtime.generated.json",
    "schemaVersion": 1,
    "algorithmVersion": "visible-bbox-median-v1",
    "alphaThreshold": 16,
}
SOURCE_PROFILE_FILENAMES = {
    "00-iron.png": "harin-equipped-iron-v1.png",
    "01-frost.png": "harin-equipped-frost-v2.png",
    "02-jade.png": "harin-equipped-jade-v1.png",
    "03-blood.png": "harin-equipped-blood-v1.png",
    "04-arcane.png": "harin-equipped-arcane-v1.png",
    "05-waraxe.png": "harin-equipped-waraxe-v1.png",
    "06-celestial.png": "harin-equipped-celestial-v1.png",
    "07-void.png": "harin-equipped-void-v1.png",
    "08-sealed.png": "harin-equipped-sealed-v1.png",
    "09-cosmic.png": "harin-equipped-cosmic-v1.png",
}
HELD_SLOTS = frozenset(("weapon", "offhand"))
WEAPON_LEFT_AUTHORED_ROWS = frozenset((0, 1, 6))
ALIGNMENT_CLASSIFICATIONS = frozenset(("aligned-visible",))

# Broad pose-normalised envelopes.  They intentionally leave room for crests,
# pauldrons, skirt hems and the 2-3 px partition fringe, while excluding the
# next anatomical slot.  A failure requires both a pixel-count leak and an
# alpha-mass leak so a faint antialias fringe cannot fail the build.
REGION_ENVELOPES: dict[str, dict[str, float]] = {
    "helm": {"ryMin": -0.16, "ryMax": 0.34, "axMax": 1.55},
    "shoulders": {"ryMin": 0.10, "ryMax": 0.56, "axMax": 1.60},
    "armor": {"ryMin": 0.18, "ryMax": 0.73, "axMax": 1.25},
    "gloves": {"ryMin": 0.23, "ryMax": 0.82, "axMax": 1.65},
    "belt": {"ryMin": 0.46, "ryMax": 0.73, "axMax": 1.15},
    "legs": {"ryMin": 0.50, "ryMax": 0.94, "axMax": 1.25},
    "boots": {"ryMin": 0.69, "ryMax": 1.08, "axMax": 1.45},
    "relic": {"ryMin": 0.18, "ryMax": 0.70, "axMax": 0.90},
}

THRESHOLDS: dict[str, Any] = {
    "emptyVisiblePixels": 0,
    # Every non-empty cell must carry a real silhouette, not merely enough
    # alpha to satisfy the direction aggregate.  These are warnings (and thus
    # fail without an exact atlas/body-hash-bound allowlist) because a few
    # deliberately occluded authored ornaments are genuinely tiny.
    "minimumSilhouette": {
        "visiblePixels": 48,
        "width": 10,
        "height": 10,
        "bodyOrSlotSignalPixels": 8,
        "bodyNearDilationPixels": 11,
    },
    "referencePreservation": {
        "visiblePixelsRatio": 0.35,
        "widthRatio": 0.50,
        "heightRatio": 0.50,
        "largestComponentPixelsRatio": 0.30,
        "bodyOrSlotSignalPixelsRatio": 0.35,
        "coarseOccupiedTileRetention": 0.35,
        "coarseGridColumns": 8,
        "coarseGridRows": 6,
    },
    "sourceOcclusion": {
        "maximumStrongOwnedPixels": 8,
        "maximumOwnedAlphaMass": 512,
    },
    "directionVisibility": {
        "minimumStrongPhaseVisiblePixels": 16,
        "minimumFourPhaseVisiblePixels": 48,
        "minimumStrongPhaseAlphaMass": 2048,
        "minimumFourPhaseAlphaMass": 6144,
    },
    "minimumTransparentPaddingPixels": 2,
    "regionLeak": {
        "visiblePixelRatio": 0.08,
        "alphaMassRatio": 0.04,
        "catastrophicEitherRatio": 0.18,
    },
    "held": {
        "weaponBodyCore": {"pixels": 320, "ratio": 0.18},
        # A shield may legitimately cover more torso than a weapon.
        "offhandBodyCore": {"pixels": 900, "ratio": 0.34},
        "footCore": {"pixels": 64, "ratio": 0.04},
        "wrongSide": {"pixels": 96, "ratio": 0.25},
        "requiredBroadHandContactPixels": 3,
    },
    "comparison": {
        "regionPixelRatioGrowth": 0.03,
        "regionAlphaRatioGrowth": 0.02,
        "bodyCoreRatioGrowth": 0.05,
        "bodyCorePixelGrowth": 128,
        "footCoreRatioGrowth": 0.02,
        "footCorePixelGrowth": 32,
        "allowedAlphaRetentionFail": 0.35,
        "allowedAlphaRetentionWarning": 0.60,
        "allowedAlphaGrowthWarning": 1.75,
    },
}


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def sha256_lines(records: list[tuple[str, str]]) -> str:
    payload = "".join(f"{name}:{digest}\n" for name, digest in records)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def paperdoll_atlas_digest(root: Path) -> tuple[str, int]:
    records = [
        (f"{slot}/{variant}", sha256(root / slot / variant))
        for slot in SLOTS
        for variant in VARIANTS
        if (root / slot / variant).is_file()
    ]
    return sha256_lines(sorted(records)), len(records)


def paperdoll_source_digest(
    body_path: Path, source_profile_root: Path
) -> str:
    records = [("body/harin-mannequin-v1.png", sha256(body_path))]
    records.extend(
        (f"profile/{filename}", sha256(source_profile_root / filename))
        for filename in SOURCE_PROFILE_FILENAMES.values()
    )
    return sha256_lines(records)


def expected_public_route(record_workspace: Path, target: Path) -> str | None:
    """Return the one canonical public URL for an audited filesystem target."""

    public_root = (record_workspace.resolve() / "public").resolve()
    try:
        relative = target.resolve().relative_to(public_root)
    except ValueError:
        return None
    return f"/{relative.as_posix()}"


def expected_workspace_relative_path(
    record_workspace: Path, target: Path | None
) -> str | None:
    """Return the canonical record-workspace-relative path for a pinned file."""

    if target is None:
        return None
    workspace = record_workspace.resolve()
    try:
        relative = target.resolve().relative_to(workspace)
    except ValueError:
        return None
    return relative.as_posix()


def verify_integrity_manifest(
    manifest_path: Path,
    record_workspace: Path,
    candidate_root: Path,
    body_path: Path,
    source_profile_root: Path,
    silhouette_reference_path: Path,
    warning_allowlist_path: Path | None,
) -> tuple[dict[str, Any], list[str]]:
    """Pin candidate, provenance reports, body, and sources outside reports."""

    metadata: dict[str, Any] = {
        "path": str(manifest_path.resolve()),
        "verified": False,
    }
    if not manifest_path.is_file():
        return metadata, [f"missing-integrity-manifest:{manifest_path.resolve()}"]
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as error:
        return metadata, [f"invalid-integrity-manifest-json:{error.msg}"]
    failures: list[str] = []
    expected_body_route = expected_public_route(record_workspace, body_path)
    expected_layer_route = expected_public_route(record_workspace, candidate_root)
    if expected_body_route is None:
        failures.append("paperdoll-body-outside-record-workspace-public")
    elif manifest.get("bodyPath") != expected_body_route:
        failures.append("paperdoll-rig-body-path-mismatch")
    if expected_layer_route is None:
        failures.append("paperdoll-layer-root-outside-record-workspace-public")
    elif manifest.get("layerRoot") != expected_layer_route:
        failures.append("paperdoll-rig-layer-root-mismatch")

    frame = manifest.get("frame")
    expected_frame_fields = {
        "width": CELL_W,
        "height": CELL_H,
        "columns": COLS,
        "groundBaseline": RIG_GROUND_BASELINE,
    }
    frame_fields = (
        {key: frame.get(key) for key in expected_frame_fields}
        if isinstance(frame, dict)
        else None
    )
    if (
        manifest.get("schemaVersion") != RIG_SCHEMA_VERSION
        or type(manifest.get("schemaVersion")) is not int
    ):
        failures.append("paperdoll-rig-schema-contract-mismatch")
    if manifest.get("version") != RIG_VERSION:
        failures.append("paperdoll-rig-version-contract-mismatch")
    if (
        frame_fields != expected_frame_fields
        or not isinstance(frame, dict)
        or set(frame) != set(expected_frame_fields) | {"directionRows"}
    ):
        failures.append("paperdoll-rig-frame-contract-mismatch")
    if not isinstance(frame, dict) or frame.get("directionRows") != list(
        RIG_DIRECTION_ROWS
    ):
        failures.append("paperdoll-rig-direction-rows-contract-mismatch")
    if manifest.get("worldRender") != RIG_WORLD_RENDER:
        failures.append("paperdoll-rig-world-render-contract-mismatch")
    if manifest.get("slots") != list(SLOTS):
        failures.append("paperdoll-rig-slots-contract-mismatch")
    if manifest.get("variantNames") != list(RIG_VARIANT_NAMES):
        failures.append("paperdoll-rig-variants-contract-mismatch")
    if manifest.get("qaCompositeBuilds") != list(RIG_QA_COMPOSITE_BUILDS):
        failures.append("paperdoll-rig-qa-composite-builds-contract-mismatch")
    if manifest.get("anchorReport") != RIG_ANCHOR_REPORT:
        failures.append("paperdoll-rig-anchor-report-contract-mismatch")

    metadata["runtimeContract"] = {
        "recordWorkspace": str(record_workspace.resolve()),
        "bodyPath": {
            "approved": manifest.get("bodyPath"),
            "expected": expected_body_route,
        },
        "layerRoot": {
            "approved": manifest.get("layerRoot"),
            "expected": expected_layer_route,
        },
        "schemaVersion": RIG_SCHEMA_VERSION,
        "version": RIG_VERSION,
        "frame": {**expected_frame_fields, "directionRows": list(RIG_DIRECTION_ROWS)},
        "worldRender": RIG_WORLD_RENDER,
        "slots": list(SLOTS),
        "variantNames": list(RIG_VARIANT_NAMES),
        "qaCompositeBuilds": list(RIG_QA_COMPOSITE_BUILDS),
        "anchorReport": RIG_ANCHOR_REPORT,
    }
    integrity = manifest.get("assetIntegrity")
    if not isinstance(integrity, dict):
        failures.append("missing-paperdoll-asset-integrity-pins")
        return metadata, failures
    expected_reference_path = expected_workspace_relative_path(
        record_workspace, silhouette_reference_path
    )
    expected_allowlist_path = expected_workspace_relative_path(
        record_workspace, warning_allowlist_path
    )
    if expected_reference_path is None:
        failures.append("paperdoll-silhouette-reference-outside-record-workspace")
    elif integrity.get("silhouetteReferencePath") != expected_reference_path:
        failures.append("paperdoll-silhouette-reference-path-mismatch")
    if warning_allowlist_path is not None and expected_allowlist_path is None:
        failures.append("paperdoll-warning-allowlist-outside-record-workspace")
    elif integrity.get("warningAllowlistPath") != expected_allowlist_path:
        failures.append("paperdoll-warning-allowlist-path-mismatch")
    algorithm = str(integrity.get("algorithm", ""))
    if algorithm != "relative-path-sha256-lines-v1":
        failures.append("paperdoll-integrity-algorithm-mismatch")
    atlas_digest, atlas_count = paperdoll_atlas_digest(candidate_root)
    source_digest = paperdoll_source_digest(body_path, source_profile_root)
    reference_digest = (
        sha256(silhouette_reference_path)
        if silhouette_reference_path.is_file()
        else ""
    )
    allowlist_digest = (
        sha256(warning_allowlist_path)
        if warning_allowlist_path is not None and warning_allowlist_path.is_file()
        else ""
    )
    approved_asset_revision = str(manifest.get("assetRevision", ""))
    checks = (
        (
            approved_asset_revision == atlas_digest,
            "paperdoll-asset-revision-mismatch",
        ),
        (
            integrity.get("atlasCount") == atlas_count == 100,
            "paperdoll-atlas-count-pin-mismatch",
        ),
        (
            integrity.get("sourceAggregateSha256") == source_digest,
            "paperdoll-source-aggregate-pin-mismatch",
        ),
        (
            integrity.get("bodySha256") == sha256(body_path),
            "paperdoll-body-pin-mismatch",
        ),
        (
            integrity.get("silhouetteReferenceSha256") == reference_digest,
            "paperdoll-silhouette-reference-pin-mismatch",
        ),
        (
            integrity.get("warningAllowlistSha256") == allowlist_digest,
            "paperdoll-warning-allowlist-pin-mismatch",
        ),
    )
    failures.extend(failure for passed, failure in checks if not passed)
    metadata.update(
        {
            "algorithm": algorithm,
            "assetRevision": {
                "approved": approved_asset_revision,
                "computed": atlas_digest,
            },
            "atlasCount": atlas_count,
            "sourceAggregateSha256": {
                "approved": integrity.get("sourceAggregateSha256"),
                "computed": source_digest,
            },
            "bodySha256": {
                "approved": integrity.get("bodySha256"),
                "computed": sha256(body_path),
            },
            "silhouetteReferenceSha256": {
                "approved": integrity.get("silhouetteReferenceSha256"),
                "computed": reference_digest,
            },
            "silhouetteReferencePath": {
                "approved": integrity.get("silhouetteReferencePath"),
                "expected": expected_reference_path,
            },
            "warningAllowlistSha256": {
                "approved": integrity.get("warningAllowlistSha256"),
                "computed": allowlist_digest,
            },
            "warningAllowlistPath": {
                "approved": integrity.get("warningAllowlistPath"),
                "expected": expected_allowlist_path,
            },
            "verified": not failures,
        }
    )
    return metadata, failures


def frame_box(row: int, column: int) -> tuple[int, int, int, int]:
    return (
        column * CELL_W,
        row * CELL_H,
        (column + 1) * CELL_W,
        (row + 1) * CELL_H,
    )


def binary_filter(mask: np.ndarray, size: int, *, erode: bool) -> np.ndarray:
    image = Image.fromarray((mask * 255).astype(np.uint8), mode="L")
    filtered = image.filter(
        ImageFilter.MinFilter(size) if erode else ImageFilter.MaxFilter(size)
    )
    return np.asarray(filtered, dtype=np.uint8) > 0


def body_geometry(body: Image.Image) -> dict[str, Any]:
    body_mask = np.asarray(body.getchannel("A"), dtype=np.uint8) > BODY_ALPHA
    y, x = np.where(body_mask)
    if len(x) < 48:
        raise ValueError("mannequin frame is empty or too sparse")
    left, right = int(x.min()), int(x.max())
    top, bottom = int(y.min()), int(y.max())
    torso_top = top + round((bottom - top) * 0.18)
    torso_bottom = top + round((bottom - top) * 0.66)
    torso_y, torso_x = np.where(body_mask[torso_top : torso_bottom + 1])
    center_x = (
        float(np.median(torso_x))
        if len(torso_x)
        else float((left + right) / 2)
    )
    half_width = max(1.0, (right - left + 1) / 2)
    height = max(1.0, bottom - top + 1)
    yy, xx = np.indices((CELL_H, CELL_W))
    rx = (xx - center_x) / half_width
    ry = (yy - top) / height
    core = binary_filter(body_mask, 7, erode=True)
    near = binary_filter(
        body_mask,
        THRESHOLDS["minimumSilhouette"]["bodyNearDilationPixels"] * 2 + 1,
        erode=False,
    )
    return {
        "body": body_mask,
        "core": core,
        "near": near,
        "top": top,
        "bottom": bottom,
        "centerX": center_x,
        "halfWidth": half_width,
        "height": height,
        "rx": rx,
        "ry": ry,
    }


def expected_left(slot: str, row: int) -> bool:
    weapon_left = row in WEAPON_LEFT_AUTHORED_ROWS
    return weapon_left if slot == "weapon" else not weapon_left


def allowed_region(slot: str, geometry: dict[str, Any]) -> np.ndarray:
    if slot in HELD_SLOTS:
        return np.ones((CELL_H, CELL_W), dtype=bool)
    rule = REGION_ENVELOPES[slot]
    ry = geometry["ry"]
    ax = np.abs(geometry["rx"])
    return (
        (ry >= rule["ryMin"])
        & (ry <= rule["ryMax"])
        & (ax <= rule["axMax"])
    )


def component_sizes(mask: np.ndarray) -> list[int]:
    """Return 8-connected component sizes for visible alpha."""

    seen = np.zeros(mask.shape, dtype=bool)
    sizes: list[int] = []
    for start_y, start_x in zip(*np.where(mask)):
        if seen[start_y, start_x]:
            continue
        queue: deque[tuple[int, int]] = deque([(int(start_x), int(start_y))])
        seen[start_y, start_x] = True
        size = 0
        while queue:
            x, y = queue.popleft()
            size += 1
            for ny in range(max(0, y - 1), min(CELL_H, y + 2)):
                for nx in range(max(0, x - 1), min(CELL_W, x + 2)):
                    if not seen[ny, nx] and mask[ny, nx]:
                        seen[ny, nx] = True
                        queue.append((nx, ny))
        sizes.append(size)
    return sorted(sizes, reverse=True)


def safe_ratio(numerator: int | float, denominator: int | float) -> float:
    return float(numerator) / max(1.0, float(denominator))


def mask_metrics(
    layer: Image.Image,
    geometry: dict[str, Any],
    slot: str,
    row: int,
) -> dict[str, Any]:
    rgba = np.asarray(layer.convert("RGBA"), dtype=np.uint8)
    alpha = np.asarray(layer.getchannel("A"), dtype=np.uint8)
    visible = alpha > VISIBLE_ALPHA
    raw = alpha > 0
    visible_pixels = int(visible.sum())
    alpha_mass = int(alpha.astype(np.uint64).sum())
    visible_y, visible_x = np.where(visible)
    if visible_pixels:
        visible_bounds = [
            int(visible_x.min()),
            int(visible_y.min()),
            int(visible_x.max()) + 1,
            int(visible_y.max()) + 1,
        ]
        visible_width = visible_bounds[2] - visible_bounds[0]
        visible_height = visible_bounds[3] - visible_bounds[1]
    else:
        visible_bounds = None
        visible_width = 0
        visible_height = 0
    allowed = allowed_region(slot, geometry)
    outside = ~allowed
    allowed_visible_pixels = int((visible & allowed).sum())
    outside_visible_pixels = int((visible & outside).sum())
    allowed_alpha_mass = int(alpha[allowed].astype(np.uint64).sum())
    outside_alpha_mass = int(alpha[outside].astype(np.uint64).sum())

    raw_bounds = layer.getchannel("A").getbbox()
    if raw_bounds is None:
        padding = None
    else:
        padding = [
            int(raw_bounds[0]),
            int(raw_bounds[1]),
            int(CELL_W - raw_bounds[2]),
            int(CELL_H - raw_bounds[3]),
        ]
    edge_mask = np.zeros((CELL_H, CELL_W), dtype=bool)
    edge_mask[:2, :] = True
    edge_mask[-2:, :] = True
    edge_mask[:, :2] = True
    edge_mask[:, -2:] = True
    edge_alpha_pixels = int((raw & edge_mask).sum())
    edge_alpha_mass = int(alpha[edge_mask].astype(np.uint64).sum())

    core = geometry["core"]
    ry = geometry["ry"]
    body_near_visible_pixels = int((visible & geometry["near"]).sum())
    body_or_slot_signal_pixels = (
        body_near_visible_pixels
        if slot in HELD_SLOTS
        else allowed_visible_pixels
    )
    body_core_pixels = int((visible & core).sum())
    foot_core_mask = core & (ry >= 0.76)
    foot_core_pixels = int((visible & foot_core_mask).sum())
    head_core_pixels = int((visible & core & (ry < 0.25)).sum())
    torso_core_pixels = int((visible & core & (ry >= 0.25) & (ry < 0.64)).sum())
    leg_core_pixels = int((visible & core & (ry >= 0.64) & (ry < 0.84)).sum())

    band_specs = (
        ("head", -10.0, 0.24),
        ("upper", 0.24, 0.42),
        ("torso", 0.42, 0.58),
        ("waist", 0.58, 0.68),
        ("legs", 0.68, 0.84),
        ("feet", 0.84, 10.0),
    )
    bands: dict[str, dict[str, Any]] = {}
    for name, minimum, maximum in band_specs:
        band = (ry >= minimum) & (ry < maximum)
        pixels = int((visible & band).sum())
        bands[name] = {
            "pixels": pixels,
            "ratio": safe_ratio(pixels, visible_pixels),
        }

    components = component_sizes(visible)
    largest_component_pixels = components[0] if components else 0
    tiny_component_pixels = sum(size for size in components if size < 8)
    preservation = THRESHOLDS["referencePreservation"]
    grid_columns = int(preservation["coarseGridColumns"])
    grid_rows = int(preservation["coarseGridRows"])
    occupied_tiles: list[int] = []
    for grid_y in range(grid_rows):
        y0 = grid_y * CELL_H // grid_rows
        y1 = (grid_y + 1) * CELL_H // grid_rows
        for grid_x in range(grid_columns):
            x0 = grid_x * CELL_W // grid_columns
            x1 = (grid_x + 1) * CELL_W // grid_columns
            if bool(visible[y0:y1, x0:x1].any()):
                occupied_tiles.append(grid_y * grid_columns + grid_x)

    held: dict[str, Any] | None = None
    if slot in HELD_SLOTS:
        rx = geometry["rx"]
        if expected_left(slot, row):
            wrong_side = rx > 0.08
            hand_side = rx <= 0.05
        else:
            wrong_side = rx < -0.08
            hand_side = rx >= -0.05
        hand_zone = (
            geometry["body"]
            & (ry >= 0.27)
            & (ry <= 0.78)
            & hand_side
        )
        near_hand = binary_filter(hand_zone, 15, erode=False)
        near_hand_tight = binary_filter(hand_zone, 7, erode=False)
        wrong_side_pixels = int((visible & wrong_side).sum())
        held = {
            "expectedSide": "left" if expected_left(slot, row) else "right",
            "wrongSidePixels": wrong_side_pixels,
            "wrongSideRatio": safe_ratio(wrong_side_pixels, visible_pixels),
            "tightHandContactPixels": int((visible & near_hand_tight).sum()),
            "broadHandContactPixels": int((visible & near_hand).sum()),
        }

    return {
        "visiblePixels": visible_pixels,
        "alphaMass": alpha_mass,
        "rgbaSha256": hashlib.sha256(rgba.tobytes()).hexdigest(),
        "visibleBounds": visible_bounds,
        "visibleWidth": visible_width,
        "visibleHeight": visible_height,
        "bounds": list(raw_bounds) if raw_bounds else None,
        "transparentPadding": padding,
        "empty": visible_pixels == 0,
        "edgeAlphaPixels": edge_alpha_pixels,
        "edgeAlphaMass": edge_alpha_mass,
        "allowedVisiblePixels": allowed_visible_pixels,
        "allowedAlphaMass": allowed_alpha_mass,
        "bodyNearVisiblePixels": body_near_visible_pixels,
        "bodyOrSlotSignalPixels": body_or_slot_signal_pixels,
        "outOfRegionPixels": outside_visible_pixels,
        "outOfRegionPixelRatio": safe_ratio(outside_visible_pixels, visible_pixels),
        "outOfRegionAlphaMass": outside_alpha_mass,
        "outOfRegionAlphaRatio": safe_ratio(outside_alpha_mass, alpha_mass),
        "bodyCorePixels": body_core_pixels,
        "bodyCoreRatio": safe_ratio(body_core_pixels, visible_pixels),
        "headCorePixels": head_core_pixels,
        "torsoCorePixels": torso_core_pixels,
        "legCorePixels": leg_core_pixels,
        "footCorePixels": foot_core_pixels,
        "footCoreRatio": safe_ratio(foot_core_pixels, visible_pixels),
        "normalisedVerticalBands": bands,
        "componentCount": len(components),
        "largestComponentPixels": largest_component_pixels,
        "largestComponentRatio": safe_ratio(largest_component_pixels, visible_pixels),
        "coarseOccupiedTiles": occupied_tiles,
        "coarseOccupiedTileCount": len(occupied_tiles),
        "tinyComponentPixels": tiny_component_pixels,
        "tinyComponentRatio": safe_ratio(tiny_component_pixels, visible_pixels),
        "held": held,
    }


REFERENCE_METRIC_FIELDS = (
    "visiblePixels",
    "visibleWidth",
    "visibleHeight",
    "largestComponentPixels",
    "bodyOrSlotSignalPixels",
    "coarseOccupiedTiles",
)


def reference_metric_record(metrics: dict[str, Any]) -> dict[str, Any]:
    """Keep only independently reproducible silhouette evidence."""

    return {field: metrics[field] for field in REFERENCE_METRIC_FIELDS}


def source_profile_records(
    workspace: Path, source_profile_root: Path
) -> dict[str, dict[str, str]]:
    records: dict[str, dict[str, str]] = {}
    for variant, filename in SOURCE_PROFILE_FILENAMES.items():
        path = (source_profile_root / filename).resolve()
        if not path.is_file():
            raise ValueError(f"missing source profile: {path}")
        records[variant] = {
            "filename": filename,
            "path": str(path.relative_to(workspace)).replace("\\", "/")
            if path.is_relative_to(workspace)
            else str(path),
            "sha256": sha256(path),
        }
    return records


def write_silhouette_reference(
    path: Path,
    workspace: Path,
    candidate_root: Path,
    body_path: Path,
    source_profile_root: Path,
) -> dict[str, Any]:
    """Write a source-hash-bound exact-cell reference after a clean build.

    Each RGBA cell digest is an exact commitment; the additional metrics make
    loss modes independently diagnosable.  The absolute audit recomputes both
    from the current PNG and never trusts the numeric report values alone.
    """

    workspace = workspace.resolve()
    candidate_root = candidate_root.resolve()
    body_path = body_path.resolve()
    body_atlas = Image.open(body_path).convert("RGBA")
    if body_atlas.size != ATLAS_SIZE:
        raise ValueError(f"invalid mannequin size: {body_atlas.size}")
    body_frames = {
        (row, column): body_geometry(body_atlas.crop(frame_box(row, column)))
        for row in range(ROWS)
        for column in range(COLS)
    }
    profiles = source_profile_records(workspace, source_profile_root.resolve())
    atlases: dict[str, dict[str, str]] = {}
    cells: dict[str, dict[str, Any]] = {}
    for slot in SLOTS:
        for variant in VARIANTS:
            relative = f"{slot}/{variant}"
            atlas_path = (candidate_root / slot / variant).resolve()
            atlas = Image.open(atlas_path).convert("RGBA")
            if atlas.size != ATLAS_SIZE:
                raise ValueError(f"invalid reference atlas size: {atlas_path}")
            atlas_hash = sha256(atlas_path)
            atlases[relative] = {
                "path": str(atlas_path.relative_to(workspace)).replace("\\", "/")
                if atlas_path.is_relative_to(workspace)
                else str(atlas_path),
                "sha256": atlas_hash,
            }
            profile = profiles[variant]
            for row in range(ROWS):
                for column in range(COLS):
                    cell = f"{relative}@{row},{column}"
                    layer = atlas.crop(frame_box(row, column))
                    metrics = mask_metrics(
                        layer, body_frames[(row, column)], slot, row
                    )
                    cells[cell] = {
                        "sourceProfile": profile["filename"],
                        "sourceProfileSha256": profile["sha256"],
                        "atlasSha256": atlas_hash,
                        "rgbaSha256": metrics["rgbaSha256"],
                        "metrics": reference_metric_record(metrics),
                    }
    report = {
        "schemaVersion": 2,
        "contract": SILHOUETTE_REFERENCE_CONTRACT,
        "algorithmVersion": AUDIT_ALGORITHM_VERSION,
        "generator": "scripts/build_layered_paperdoll_assets.py",
        "body": {
            "path": str(body_path.relative_to(workspace)).replace("\\", "/")
            if body_path.is_relative_to(workspace)
            else str(body_path),
            "sha256": sha256(body_path),
        },
        "sourceProfiles": profiles,
        "atlases": atlases,
        "summary": {
            "atlases": len(atlases),
            "cells": len(cells),
            "metricFields": list(REFERENCE_METRIC_FIELDS),
        },
        "cells": cells,
    }
    output_path = path.resolve()
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    return report


def load_silhouette_reference(
    path: Path | None,
    workspace: Path,
    body_path: Path,
    candidate_root: Path,
    source_profile_root: Path,
    approved_sha256: str | None = None,
) -> tuple[dict[str, dict[str, Any]], list[str], dict[str, Any]]:
    """Verify source provenance and load exact expected per-cell evidence."""

    metadata: dict[str, Any] = {
        "enabled": path is not None,
        "verified": False,
        "contract": SILHOUETTE_REFERENCE_CONTRACT,
    }
    if path is None:
        return {}, ["missing-silhouette-reference-configuration"], metadata
    report_path = path.resolve()
    metadata["path"] = str(report_path)
    if not report_path.is_file():
        return {}, [f"missing-silhouette-reference:{report_path}"], metadata
    metadata["sha256"] = sha256(report_path)
    try:
        report = json.loads(report_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as error:
        return {}, [f"invalid-silhouette-reference-json:{error.msg}"], metadata
    failures: list[str] = []
    if not approved_sha256:
        failures.append("missing-approved-silhouette-reference-sha256")
    elif metadata["sha256"] != approved_sha256:
        failures.append("silhouette-reference-approved-sha256-mismatch")
    metadata["approvedSha256"] = approved_sha256
    if report.get("schemaVersion") != 2:
        failures.append("silhouette-reference-schema-mismatch")
    if report.get("contract") != SILHOUETTE_REFERENCE_CONTRACT:
        failures.append("silhouette-reference-contract-mismatch")
    if report.get("algorithmVersion") != AUDIT_ALGORITHM_VERSION:
        failures.append("silhouette-reference-algorithm-mismatch")
    if report.get("generator") != "scripts/build_layered_paperdoll_assets.py":
        failures.append("silhouette-reference-generator-mismatch")
    actual_body_hash = sha256(body_path.resolve())
    if str(report.get("body", {}).get("sha256", "")) != actual_body_hash:
        failures.append("silhouette-reference-body-hash-mismatch")

    expected_profiles = source_profile_records(
        workspace.resolve(), source_profile_root.resolve()
    )
    reported_profiles = report.get("sourceProfiles")
    if not isinstance(reported_profiles, dict):
        failures.append("invalid-silhouette-reference-source-profiles")
        reported_profiles = {}
    for variant, expected in expected_profiles.items():
        record = reported_profiles.get(variant)
        if not isinstance(record, dict):
            failures.append(f"missing-silhouette-reference-profile:{variant}")
        elif (
            record.get("filename") != expected["filename"]
            or record.get("sha256") != expected["sha256"]
        ):
            failures.append(f"silhouette-reference-profile-mismatch:{variant}")

    reported_atlases = report.get("atlases")
    if not isinstance(reported_atlases, dict):
        failures.append("invalid-silhouette-reference-atlases")
        reported_atlases = {}
    expected_atlases = {
        f"{slot}/{variant}" for slot in SLOTS for variant in VARIANTS
    }
    atlas_hash_matches = 0
    for relative in expected_atlases:
        record = reported_atlases.get(relative)
        if not isinstance(record, dict) or not isinstance(record.get("sha256"), str):
            failures.append(f"missing-silhouette-reference-atlas:{relative}")
            continue
        candidate_path = candidate_root / relative
        if candidate_path.is_file() and sha256(candidate_path) == record["sha256"]:
            atlas_hash_matches += 1
    for extra in sorted(set(reported_atlases) - expected_atlases):
        failures.append(f"unexpected-silhouette-reference-atlas:{extra}")

    rows = report.get("cells")
    if not isinstance(rows, dict):
        failures.append("invalid-silhouette-reference-cells")
        rows = {}
    expected_cells = {
        f"{slot}/{variant}@{row},{column}"
        for slot in SLOTS
        for variant in VARIANTS
        for row in range(ROWS)
        for column in range(COLS)
    }
    verified: dict[str, dict[str, Any]] = {}
    for cell in sorted(expected_cells):
        record = rows.get(cell)
        if not isinstance(record, dict):
            failures.append(f"missing-silhouette-reference-cell:{cell}")
            continue
        relative = cell.split("@", 1)[0]
        variant = relative.split("/", 1)[1]
        atlas_record = reported_atlases.get(relative, {})
        profile_record = expected_profiles[variant]
        metrics = record.get("metrics")
        if (
            record.get("sourceProfile") != profile_record["filename"]
            or record.get("sourceProfileSha256") != profile_record["sha256"]
            or record.get("atlasSha256") != atlas_record.get("sha256")
            or not isinstance(record.get("rgbaSha256"), str)
            or not isinstance(metrics, dict)
            or set(metrics) != set(REFERENCE_METRIC_FIELDS)
        ):
            failures.append(f"invalid-silhouette-reference-cell:{cell}")
            continue
        verified[cell] = record
    for extra in sorted(set(rows) - expected_cells):
        failures.append(f"unexpected-silhouette-reference-cell:{extra}")

    summary = report.get("summary")
    if not isinstance(summary, dict) or (
        summary.get("atlases") != len(expected_atlases)
        or summary.get("cells") != len(expected_cells)
        or summary.get("metricFields") != list(REFERENCE_METRIC_FIELDS)
    ):
        failures.append("silhouette-reference-summary-mismatch")
    metadata.update(
        {
            "verified": not failures,
            "verifiedCells": len(verified),
            "verifiedSourceProfiles": len(expected_profiles),
            "candidateAtlasHashMatches": atlas_hash_matches,
            "expectedAtlases": len(expected_atlases),
        }
    )
    return (verified if not failures else {}), failures, metadata


def resolved_record_path(workspace: Path, value: Any) -> Path | None:
    if not isinstance(value, str) or not value.strip():
        return None
    path = Path(value)
    return (path if path.is_absolute() else workspace / path).resolve()


def validate_hashed_records(
    report: dict[str, Any],
    section_name: str,
    expected_paths: dict[str, Path],
    workspace: Path,
    failures: list[str],
) -> int:
    """Bind a report section to exact files, paths and SHA-256 values."""

    section = report.get(section_name)
    if not isinstance(section, dict):
        failures.append(f"invalid-occlusion-{section_name}")
        return 0
    expected_keys = set(expected_paths)
    actual_keys = {str(key) for key in section}
    for missing in sorted(expected_keys - actual_keys):
        failures.append(f"missing-occlusion-{section_name}-record:{missing}")
    for extra in sorted(actual_keys - expected_keys):
        failures.append(f"unexpected-occlusion-{section_name}-record:{extra}")
    verified = 0
    for key, expected_path_value in expected_paths.items():
        record = section.get(key)
        if not isinstance(record, dict):
            continue
        expected_path = expected_path_value.resolve()
        reported_path = resolved_record_path(workspace, record.get("path"))
        if reported_path != expected_path:
            failures.append(f"occlusion-{section_name}-path-mismatch:{key}")
            continue
        if not expected_path.is_file():
            failures.append(f"missing-occlusion-{section_name}-file:{key}")
            continue
        actual_hash = sha256(expected_path)
        reported_hash = str(record.get("sha256", ""))
        if reported_hash != actual_hash:
            failures.append(
                f"occlusion-{section_name}-hash-mismatch:{key}:"
                f"{reported_hash or 'missing'}!={actual_hash}"
            )
            continue
        verified += 1
    return verified


def load_occlusion_contract(
    path: Path | None,
    workspace: Path,
    body_path: Path,
    candidate_root: Path,
    input_root: Path,
    source_profile_root: Path,
) -> tuple[dict[str, str], list[str], dict[str, Any]]:
    """Verify alignment provenance without granting geometry exemptions.

    The report is useful provenance, but every absolute pixel/contact rule is
    recomputed from the current PNGs.  No report-authored classification can
    waive those rules.
    """

    if path is None:
        return {}, [], {
            "enabled": False,
            "verified": True,
            "geometryExemptionsAllowed": False,
            "exemptCells": 0,
        }
    report_path = path.resolve()
    metadata: dict[str, Any] = {
        "enabled": True,
        "path": str(report_path),
        "verified": False,
        "geometryExemptionsAllowed": False,
        "exemptCells": 0,
    }
    if not report_path.is_file():
        return {}, [f"missing-occlusion-report:{report_path}"], metadata
    metadata["sha256"] = sha256(report_path)
    try:
        report = json.loads(report_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as error:
        metadata["parseError"] = error.msg
        return {}, [f"invalid-occlusion-report-json:{error.msg}"], metadata
    failures: list[str] = []
    if report.get("schemaVersion") != ALIGNMENT_REPORT_SCHEMA:
        failures.append("occlusion-report-schema-mismatch")
    if report.get("generator") != ALIGNMENT_REPORT_GENERATOR:
        failures.append("occlusion-report-generator-mismatch")
    if report.get("contract") != ALIGNMENT_REPORT_CONTRACT:
        failures.append("occlusion-report-contract-mismatch")

    body_record = report.get("body")
    if not isinstance(body_record, dict):
        failures.append("invalid-occlusion-body-record")
    else:
        expected_body_path = body_path.resolve()
        reported_body_path = resolved_record_path(workspace, body_record.get("path"))
        if reported_body_path != expected_body_path:
            failures.append("occlusion-body-path-mismatch")
        elif not expected_body_path.is_file():
            failures.append(f"missing-occlusion-body-file:{expected_body_path}")
        else:
            actual_body_hash = sha256(expected_body_path)
            if body_record.get("sha256") != actual_body_hash:
                failures.append("occlusion-body-hash-mismatch")

    held_keys = {
        f"{slot}/{variant}": (slot, variant)
        for slot in HELD_SLOTS
        for variant in VARIANTS
    }
    verified_inputs = validate_hashed_records(
        report,
        "inputs",
        {
            key: input_root / slot / variant
            for key, (slot, variant) in held_keys.items()
        },
        workspace,
        failures,
    )
    verified_outputs = validate_hashed_records(
        report,
        "outputs",
        {
            key: candidate_root / slot / variant
            for key, (slot, variant) in held_keys.items()
        },
        workspace,
        failures,
    )
    profile_names = tuple(SOURCE_PROFILE_FILENAMES.values())
    verified_profiles = validate_hashed_records(
        report,
        "sourceProfiles",
        {name: source_profile_root / name for name in profile_names},
        workspace,
        failures,
    )

    rows = report.get("perCell")
    classes: dict[str, str] = {}
    known_classes = set(ALIGNMENT_CLASSIFICATIONS)
    if not isinstance(rows, list):
        failures.append("invalid-occlusion-perCell")
        rows = []
    for row in rows:
        if not isinstance(row, dict) or not isinstance(row.get("cell"), str):
            failures.append("invalid-occlusion-cell-record")
            continue
        cell = str(row["cell"])
        classification = str(row.get("classification", ""))
        if cell in classes:
            failures.append(f"duplicate-occlusion-cell:{cell}")
            continue
        if classification not in known_classes:
            failures.append(f"unknown-occlusion-classification:{cell}:{classification}")
            continue
        classes[cell] = classification
    expected_cells = {
        f"{slot}/{variant}@{row},{column}"
        for slot in HELD_SLOTS
        for variant in VARIANTS
        for row in range(ROWS)
        for column in range(COLS)
    }
    for missing in sorted(expected_cells - set(classes)):
        failures.append(f"missing-occlusion-cell:{missing}")
    for extra in sorted(set(classes) - expected_cells):
        failures.append(f"unexpected-occlusion-cell:{extra}")

    classification_counts: dict[str, int] = {}
    for classification in classes.values():
        classification_counts[classification] = (
            classification_counts.get(classification, 0) + 1
        )
    summary = report.get("summary")
    if not isinstance(summary, dict):
        failures.append("invalid-occlusion-summary")
    else:
        if summary.get("cells") != len(expected_cells):
            failures.append("occlusion-summary-cell-count-mismatch")
        if summary.get("atlases") != len(held_keys):
            failures.append("occlusion-summary-atlas-count-mismatch")
        if summary.get("classifications") != classification_counts:
            failures.append("occlusion-summary-classification-count-mismatch")

    metadata.update(
        {
            "schemaVersion": report.get("schemaVersion"),
            "generator": report.get("generator"),
            "contract": report.get("contract"),
            "verifiedInputs": verified_inputs,
            "verifiedOutputs": verified_outputs,
            "verifiedSourceProfiles": verified_profiles,
            "verifiedCells": len(classes),
            "exemptCells": 0,
            "verified": not failures,
        }
    )
    return (classes if not failures else {}), failures, metadata


def load_source_visibility(
    path: Path | None, body_sha256: str, source_profile_root: Path
) -> tuple[dict[str, dict[str, Any]], list[str], dict[str, Any] | None]:
    """Load generator-owned evidence that a slot is absent in its source cell.

    An empty output is never excused by the candidate or by a historical
    baseline.  The only per-cell exception is a source-visibility record tied
    to the exact mannequin hash and carrying very small hard-owner evidence.
    The generator report is optional because today's shipped atlases contain
    no empty cells; a future builder must emit it before using empty cells.
    """

    if path is None:
        return {}, [], None
    if not path.exists():
        return {}, [f"missing-source-visibility-report:{path}"], None
    report = json.loads(path.read_text(encoding="utf-8"))
    failures: list[str] = []
    owner_algorithm = str(report.get("ownerMaskAlgorithmVersion", ""))
    if owner_algorithm != SOURCE_OWNER_ALGORITHM_VERSION:
        failures.append(
            "source-visibility-owner-algorithm-mismatch:"
            f"{owner_algorithm or 'missing'}!={SOURCE_OWNER_ALGORITHM_VERSION}"
        )
    report_body_hash = str(report.get("body", {}).get("sha256", ""))
    if report_body_hash != body_sha256:
        failures.append(
            "source-visibility-body-hash-mismatch:"
            f"{report_body_hash or 'missing'}!={body_sha256}"
        )
        return {}, failures, report
    report_profiles = report.get("profiles", {})
    if not isinstance(report_profiles, dict):
        return {}, ["invalid-source-visibility-profiles"], report
    verified_profile_hashes: dict[str, str] = {}
    for variant, filename in SOURCE_PROFILE_FILENAMES.items():
        profile_path = source_profile_root / filename
        record = report_profiles.get(variant)
        if not profile_path.exists():
            failures.append(f"missing-source-profile:{profile_path}")
            continue
        actual_hash = sha256(profile_path)
        verified_profile_hashes[variant] = actual_hash
        reported_hash = str(record.get("sha256", "")) if isinstance(record, dict) else ""
        if reported_hash != actual_hash:
            failures.append(
                f"source-profile-hash-mismatch:{variant}:"
                f"{reported_hash or 'missing'}!={actual_hash}"
            )
    if failures:
        return {}, failures, report
    rows = report.get("perCell", [])
    if not isinstance(rows, list):
        return {}, ["invalid-source-visibility-perCell"], report
    result: dict[str, dict[str, Any]] = {}
    for row in rows:
        if not isinstance(row, dict) or not isinstance(row.get("cell"), str):
            failures.append("invalid-source-visibility-cell-record")
            continue
        cell = str(row["cell"])
        try:
            variant = cell.split("/", 1)[1].split("@", 1)[0]
        except IndexError:
            failures.append(f"invalid-source-visibility-cell-key:{cell}")
            continue
        if row.get("sourceProfileSha256") != verified_profile_hashes.get(variant):
            failures.append(f"source-visibility-cell-profile-hash-mismatch:{cell}")
            continue
        if cell in result:
            failures.append(f"duplicate-source-visibility-cell:{cell}")
            continue
        result[cell] = row
    expected_cells = {
        f"{slot}/{variant}@{row},{column}"
        for slot in SLOTS
        for variant in VARIANTS
        for row in range(ROWS)
        for column in range(COLS)
    }
    for missing in sorted(expected_cells - set(result)):
        failures.append(f"missing-source-visibility-cell:{missing}")
    for extra in sorted(set(result) - expected_cells):
        failures.append(f"unexpected-source-visibility-cell:{extra}")
    if failures:
        return {}, failures, report
    return result, failures, report


def source_occlusion_is_valid(record: dict[str, Any] | None) -> bool:
    if not record or record.get("classification") != "source-occluded":
        return False
    limits = THRESHOLDS["sourceOcclusion"]
    try:
        strong_pixels = int(record["sourceStrongOwnedPixels"])
        alpha_mass = int(record["sourceOwnedAlphaMass"])
    except (KeyError, TypeError, ValueError):
        return False
    return (
        0 <= strong_pixels <= limits["maximumStrongOwnedPixels"]
        and 0 <= alpha_mass <= limits["maximumOwnedAlphaMass"]
    )


def evaluate_reference_preservation(
    metrics: dict[str, Any], reference: dict[str, Any]
) -> tuple[list[str], dict[str, Any]]:
    """Compare current pixels to the exact registered-source build cell."""

    failures: list[str] = []
    expected = reference["metrics"]
    current_hash = str(metrics["rgbaSha256"])
    expected_hash = str(reference["rgbaSha256"])
    if current_hash != expected_hash:
        failures.append("source-reference-cell-rgba-mismatch")
    elif reference_metric_record(metrics) != expected:
        # The exact RGBA digest determines every metric.  A mismatch here
        # proves that the JSON's numeric reference was edited or corrupted.
        failures.append("source-reference-metrics-mismatch")

    limits = THRESHOLDS["referencePreservation"]
    ratios = {
        "visiblePixelsRatio": safe_ratio(
            metrics["visiblePixels"], expected["visiblePixels"]
        ),
        "widthRatio": safe_ratio(metrics["visibleWidth"], expected["visibleWidth"]),
        "heightRatio": safe_ratio(
            metrics["visibleHeight"], expected["visibleHeight"]
        ),
        "largestComponentPixelsRatio": safe_ratio(
            metrics["largestComponentPixels"],
            expected["largestComponentPixels"],
        ),
        "bodyOrSlotSignalPixelsRatio": safe_ratio(
            metrics["bodyOrSlotSignalPixels"],
            expected["bodyOrSlotSignalPixels"],
        ),
    }
    expected_tiles = {int(value) for value in expected["coarseOccupiedTiles"]}
    current_tiles = {int(value) for value in metrics["coarseOccupiedTiles"]}
    ratios["coarseOccupiedTileRetention"] = safe_ratio(
        len(current_tiles & expected_tiles), len(expected_tiles)
    )
    gates = (
        ("visiblePixelsRatio", "source-shape-visible-mass-loss"),
        ("widthRatio", "source-shape-width-collapse"),
        ("heightRatio", "source-shape-height-collapse"),
        (
            "largestComponentPixelsRatio",
            "source-shape-primary-component-loss",
        ),
        (
            "bodyOrSlotSignalPixelsRatio",
            "source-shape-body-or-slot-signal-loss",
        ),
        (
            "coarseOccupiedTileRetention",
            "source-shape-spatial-distribution-loss",
        ),
    )
    for ratio_name, failure in gates:
        if ratios[ratio_name] < float(limits[ratio_name]):
            failures.append(failure)
    return failures, {
        "expectedRgbaSha256": expected_hash,
        "hashMatch": current_hash == expected_hash,
        "ratios": ratios,
    }


def evaluate_absolute(
    cell: str,
    slot: str,
    metrics: dict[str, Any],
    _alignment_classes: dict[str, str],
    source_visibility: dict[str, dict[str, Any]],
    silhouette_reference: dict[str, Any] | None = None,
) -> tuple[list[str], list[str]]:
    failures: list[str] = []
    warnings: list[str] = []
    if silhouette_reference is not None:
        reference_failures, preservation = evaluate_reference_preservation(
            metrics, silhouette_reference
        )
        failures.extend(reference_failures)
        metrics["sourceReference"] = preservation
    if metrics["empty"]:
        if source_occlusion_is_valid(source_visibility.get(cell)):
            warnings.append("source-occluded-empty-cell-allowed")
        else:
            failures.append("unexpected-empty-cell")
    else:
        silhouette = THRESHOLDS["minimumSilhouette"]
        if (
            metrics["visiblePixels"] < silhouette["visiblePixels"]
            or metrics["visibleWidth"] < silhouette["width"]
            or metrics["visibleHeight"] < silhouette["height"]
            or metrics["bodyOrSlotSignalPixels"]
            < silhouette["bodyOrSlotSignalPixels"]
        ):
            warnings.append("undersized-or-detached-silhouette")

    padding = metrics["transparentPadding"]
    if metrics["edgeAlphaPixels"] > 0 or (
        padding is not None
        and min(padding) < THRESHOLDS["minimumTransparentPaddingPixels"]
    ):
        failures.append("cell-edge-clipping-risk")

    if slot not in HELD_SLOTS:
        leak = THRESHOLDS["regionLeak"]
        pixel_ratio = metrics["outOfRegionPixelRatio"]
        alpha_ratio = metrics["outOfRegionAlphaRatio"]
        if (
            pixel_ratio > leak["catastrophicEitherRatio"]
            or alpha_ratio > leak["catastrophicEitherRatio"]
            or (
                pixel_ratio > leak["visiblePixelRatio"]
                and alpha_ratio > leak["alphaMassRatio"]
            )
        ):
            failures.append("slot-region-leak")
        elif pixel_ratio > 0.04 or alpha_ratio > 0.02:
            warnings.append("slot-region-fringe-growth")
    else:
        held = metrics["held"]
        assert held is not None
        body_limit = THRESHOLDS["held"][
            "weaponBodyCore" if slot == "weapon" else "offhandBodyCore"
        ]
        if (
            metrics["bodyCorePixels"] > body_limit["pixels"]
            and metrics["bodyCoreRatio"] > body_limit["ratio"]
        ):
            failures.append("held-item-body-core-pollution")
        foot_limit = THRESHOLDS["held"]["footCore"]
        if (
            metrics["footCorePixels"] > foot_limit["pixels"]
            and metrics["footCoreRatio"] > foot_limit["ratio"]
        ):
            failures.append("held-item-foot-core-pollution")
        side_limit = THRESHOLDS["held"]["wrongSide"]
        if (
            held["wrongSidePixels"] > side_limit["pixels"]
            and held["wrongSideRatio"] > side_limit["ratio"]
        ):
            failures.append("held-item-wrong-side-pollution")
        if (
            not metrics["empty"]
            and held["broadHandContactPixels"]
            < THRESHOLDS["held"]["requiredBroadHandContactPixels"]
        ):
            failures.append("held-item-misses-hand")

    # Multi-panel armour, floating relic motes, and helm fringes are expected
    # to be disconnected.  Fragmentation is actionable only for held pieces,
    # where it indicates a broken blade/shield extraction.
    if slot in HELD_SLOTS:
        if (
            metrics["visiblePixels"] >= 96
            and metrics["largestComponentRatio"] < 0.45
        ):
            warnings.append("fragmented-silhouette")
        if metrics["tinyComponentRatio"] > 0.10:
            warnings.append("detached-speckle-risk")
    return failures, warnings


def audit_dataset(
    root: Path,
    body_frames: dict[tuple[int, int], dict[str, Any]],
    occlusion_classes: dict[str, str],
    source_visibility: dict[str, dict[str, Any]],
    silhouette_reference: dict[str, dict[str, Any]] | None = None,
) -> dict[str, Any]:
    dataset_failures: list[str] = []
    atlases: list[dict[str, Any]] = []
    cells: dict[str, dict[str, Any]] = {}
    expected_paths = {f"{slot}/{variant}" for slot in SLOTS for variant in VARIANTS}
    actual_paths = {
        str(path.relative_to(root)).replace("\\", "/")
        for slot in SLOTS
        if (root / slot).exists()
        for path in (root / slot).glob("*.png")
    }
    for missing in sorted(expected_paths - actual_paths):
        dataset_failures.append(f"missing-atlas:{missing}")
    for extra in sorted(actual_paths - expected_paths):
        dataset_failures.append(f"unexpected-atlas:{extra}")

    for slot in SLOTS:
        for variant in VARIANTS:
            relative = f"{slot}/{variant}"
            path = root / slot / variant
            if not path.exists():
                continue
            atlas = Image.open(path).convert("RGBA")
            atlas_record = {
                "atlas": relative,
                "size": list(atlas.size),
                "sha256": sha256(path),
            }
            atlases.append(atlas_record)
            if atlas.size != ATLAS_SIZE:
                dataset_failures.append(
                    f"invalid-atlas-size:{relative}:{atlas.width}x{atlas.height}"
                )
                continue
            for row in range(ROWS):
                for column in range(COLS):
                    key = f"{relative}@{row},{column}"
                    metrics = mask_metrics(
                        atlas.crop(frame_box(row, column)),
                        body_frames[(row, column)],
                        slot,
                        row,
                    )
                    failures, warnings = evaluate_absolute(
                        key,
                        slot,
                        metrics,
                        occlusion_classes,
                        source_visibility,
                        silhouette_reference.get(key)
                        if silhouette_reference is not None
                        else None,
                    )
                    cells[key] = {
                        "slot": slot,
                        "variant": variant,
                        "directionRow": row,
                        "gaitColumn": column,
                        "metrics": metrics,
                        "failures": failures,
                        "warnings": warnings,
                    }

    # A source-occluded individual phase may be empty, but a whole facing may
    # never disappear.  Require one clearly visible phase and enough aggregate
    # evidence across every slot/variant/direction quartet.
    direction_visibility_failures = 0
    direction_limits = THRESHOLDS["directionVisibility"]
    for slot in SLOTS:
        for variant in VARIANTS:
            for row in range(ROWS):
                phase_keys = [
                    f"{slot}/{variant}@{row},{column}" for column in range(COLS)
                ]
                if any(key not in cells for key in phase_keys):
                    continue
                visible = [cells[key]["metrics"]["visiblePixels"] for key in phase_keys]
                alpha_mass = [cells[key]["metrics"]["alphaMass"] for key in phase_keys]
                if (
                    max(visible) < direction_limits["minimumStrongPhaseVisiblePixels"]
                    or sum(visible) < direction_limits["minimumFourPhaseVisiblePixels"]
                    or max(alpha_mass)
                    < direction_limits["minimumStrongPhaseAlphaMass"]
                    or sum(alpha_mass)
                    < direction_limits["minimumFourPhaseAlphaMass"]
                ):
                    direction_visibility_failures += 1
                    dataset_failures.append(
                        f"invisible-direction:{slot}/{variant}@{row}:"
                        f"phaseVisiblePixels={visible}:phaseAlphaMass={alpha_mass}"
                    )

    all_failures = [
        f"{cell}:{failure}"
        for cell, record in cells.items()
        for failure in record["failures"]
    ]
    all_warnings = [
        f"{cell}:{warning}"
        for cell, record in cells.items()
        for warning in record["warnings"]
    ]
    return {
        "root": str(root.resolve()),
        "passed": not dataset_failures and not all_failures,
        "summary": {
            "expectedAtlases": len(expected_paths),
            "actualAtlases": len(actual_paths),
            "expectedCells": len(expected_paths) * ROWS * COLS,
            "auditedCells": len(cells),
            "failedCells": sum(bool(record["failures"]) for record in cells.values()),
            "failureCount": len(dataset_failures) + len(all_failures),
            "warningCount": len(all_warnings),
            "emptyCells": sum(record["metrics"]["empty"] for record in cells.values()),
            "clippingRiskCells": sum(
                "cell-edge-clipping-risk" in record["failures"]
                for record in cells.values()
            ),
            "slotRegionLeakCells": sum(
                "slot-region-leak" in record["failures"]
                for record in cells.values()
            ),
            "heldBodyPollutionCells": sum(
                "held-item-body-core-pollution" in record["failures"]
                for record in cells.values()
            ),
            "heldFootPollutionCells": sum(
                "held-item-foot-core-pollution" in record["failures"]
                for record in cells.values()
            ),
            "heldWrongSideCells": sum(
                "held-item-wrong-side-pollution" in record["failures"]
                for record in cells.values()
            ),
            "heldContactFailureCells": sum(
                "held-item-misses-hand" in record["failures"]
                for record in cells.values()
            ),
            "invisibleDirectionGroups": direction_visibility_failures,
            "sourceOccludedEmptyCells": sum(
                "source-occluded-empty-cell-allowed" in record["warnings"]
                for record in cells.values()
            ),
            "silhouetteWarningCells": sum(
                "undersized-or-detached-silhouette" in record["warnings"]
                for record in cells.values()
            ),
            "sourceReferenceHashMismatchCells": sum(
                "source-reference-cell-rgba-mismatch" in record["failures"]
                for record in cells.values()
            ),
            "sourceShapeLossCells": sum(
                any(
                    failure.startswith("source-shape-")
                    for failure in record["failures"]
                )
                for record in cells.values()
            ),
        },
        "datasetFailures": dataset_failures,
        "failures": all_failures,
        "warnings": all_warnings,
        "atlases": atlases,
        "cells": cells,
    }


def observed_warning_tokens(
    candidate: dict[str, Any], comparison: dict[str, Any] | None
) -> set[tuple[str, str, str]]:
    tokens = {
        ("candidate", cell, str(warning))
        for cell, record in candidate["cells"].items()
        for warning in record["warnings"]
    }
    if comparison:
        tokens.update(
            ("comparison", str(row["cell"]), str(warning))
            for row in comparison["perCell"]
            for warning in row.get("warnings", [])
        )
    return tokens


def warning_token_record(token: tuple[str, str, str]) -> dict[str, str]:
    scope, cell, warning = token
    return {"scope": scope, "cell": cell, "warning": warning}


def warning_source_profile(
    cell: str, source_profile_hashes: dict[str, str]
) -> tuple[str, str]:
    variant = cell.split("@", 1)[0].split("/", 1)[1]
    filename = SOURCE_PROFILE_FILENAMES[variant]
    return filename, source_profile_hashes[variant]


def write_warning_allowlist(
    path: Path,
    candidate: dict[str, Any],
    comparison: dict[str, Any] | None,
    body_sha256: str,
    source_profile_hashes: dict[str, str] | None = None,
) -> dict[str, Any]:
    """Write the exact currently observed warning set as a hash-bound contract."""

    atlas_hashes = {
        str(record["atlas"]): str(record["sha256"])
        for record in candidate["atlases"]
    }
    source_profile_hashes = source_profile_hashes or {}
    entries: list[dict[str, str]] = []
    for token in sorted(observed_warning_tokens(candidate, comparison)):
        scope, cell, warning = token
        atlas = cell.split("@", 1)[0]
        atlas_hash = atlas_hashes.get(atlas)
        if atlas_hash is None:
            raise ValueError(f"cannot hash-bind warning for unknown atlas: {cell}")
        source_filename, source_hash = warning_source_profile(
            cell, source_profile_hashes
        )
        entries.append(
            {
                "scope": scope,
                "cell": cell,
                "warning": warning,
                "atlas": atlas,
                "atlasSha256": atlas_hash,
                "sourceProfile": source_filename,
                "sourceProfileSha256": source_hash,
            }
        )
    report = {
        "schemaVersion": 1,
        "contract": WARNING_ALLOWLIST_CONTRACT,
        "algorithmVersion": AUDIT_ALGORITHM_VERSION,
        "generator": "scripts/audit_paperdoll_slot_regions.py",
        "bodySha256": body_sha256,
        "entries": entries,
    }
    output_path = path.resolve()
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    return report


def evaluate_warning_contract(
    path: Path | None,
    candidate: dict[str, Any],
    comparison: dict[str, Any] | None,
    body_sha256: str,
    source_profile_hashes: dict[str, str] | None = None,
    approved_allowlist_sha256: str | None = None,
) -> tuple[dict[str, Any], list[str]]:
    """Require zero warnings or an exact body/atlas-hash-bound allowlist."""

    observed = observed_warning_tokens(candidate, comparison)
    atlas_hashes = {
        str(record["atlas"]): str(record["sha256"])
        for record in candidate["atlases"]
    }
    configuration_failures: list[str] = []
    source_profile_hashes = source_profile_hashes or {}
    allowed: set[tuple[str, str, str]] = set()
    metadata: dict[str, Any] = {
        "mode": "zero-warning" if path is None else "hash-bound-allowlist",
        "contract": WARNING_ALLOWLIST_CONTRACT,
        "algorithmVersion": AUDIT_ALGORITHM_VERSION,
    }
    if path is not None:
        allowlist_path = path.resolve()
        metadata["path"] = str(allowlist_path)
        if not allowlist_path.is_file():
            configuration_failures.append(
                f"missing-warning-allowlist:{allowlist_path}"
            )
        else:
            metadata["sha256"] = sha256(allowlist_path)
            metadata["approvedSha256"] = approved_allowlist_sha256
            if not approved_allowlist_sha256:
                configuration_failures.append(
                    "missing-approved-warning-allowlist-sha256"
                )
            elif metadata["sha256"] != approved_allowlist_sha256:
                configuration_failures.append(
                    "warning-allowlist-approved-sha256-mismatch"
                )
            try:
                report = json.loads(allowlist_path.read_text(encoding="utf-8"))
            except json.JSONDecodeError as error:
                configuration_failures.append(
                    f"invalid-warning-allowlist-json:{error.msg}"
                )
                report = {}
            if report.get("schemaVersion") != 1:
                configuration_failures.append("warning-allowlist-schema-mismatch")
            if report.get("contract") != WARNING_ALLOWLIST_CONTRACT:
                configuration_failures.append("warning-allowlist-contract-mismatch")
            if report.get("algorithmVersion") != AUDIT_ALGORITHM_VERSION:
                configuration_failures.append("warning-allowlist-algorithm-mismatch")
            if report.get("bodySha256") != body_sha256:
                configuration_failures.append("warning-allowlist-body-hash-mismatch")
            entries = report.get("entries")
            if not isinstance(entries, list):
                configuration_failures.append("invalid-warning-allowlist-entries")
                entries = []
            seen: set[tuple[str, str, str]] = set()
            for index, entry in enumerate(entries):
                if not isinstance(entry, dict):
                    configuration_failures.append(
                        f"invalid-warning-allowlist-entry:{index}"
                    )
                    continue
                scope = str(entry.get("scope", ""))
                cell = str(entry.get("cell", ""))
                warning = str(entry.get("warning", ""))
                token = (scope, cell, warning)
                if scope not in ("candidate", "comparison") or not cell or not warning:
                    configuration_failures.append(
                        f"invalid-warning-allowlist-entry:{index}"
                    )
                    continue
                if token in seen:
                    configuration_failures.append(
                        f"duplicate-warning-allowlist-entry:{scope}:{cell}:{warning}"
                    )
                    continue
                seen.add(token)
                atlas = cell.split("@", 1)[0]
                if entry.get("atlas") != atlas:
                    configuration_failures.append(
                        f"warning-allowlist-atlas-mismatch:{scope}:{cell}:{warning}"
                    )
                    continue
                actual_atlas_hash = atlas_hashes.get(atlas)
                if actual_atlas_hash is None:
                    configuration_failures.append(
                        f"warning-allowlist-unknown-atlas:{scope}:{cell}:{warning}"
                    )
                    continue
                if entry.get("atlasSha256") != actual_atlas_hash:
                    configuration_failures.append(
                        f"warning-allowlist-atlas-hash-mismatch:"
                        f"{scope}:{cell}:{warning}"
                    )
                    continue
                try:
                    expected_source_filename, expected_source_hash = (
                        warning_source_profile(cell, source_profile_hashes)
                    )
                except (KeyError, IndexError):
                    configuration_failures.append(
                        f"warning-allowlist-missing-source-profile:{scope}:{cell}:{warning}"
                    )
                    continue
                if (
                    entry.get("sourceProfile") != expected_source_filename
                    or entry.get("sourceProfileSha256") != expected_source_hash
                ):
                    configuration_failures.append(
                        f"warning-allowlist-source-profile-hash-mismatch:"
                        f"{scope}:{cell}:{warning}"
                    )
                    continue
                if token not in observed:
                    configuration_failures.append(
                        f"unused-warning-allowlist-entry:{scope}:{cell}:{warning}"
                    )
                    continue
                allowed.add(token)

    unallowed = observed - allowed
    metadata.update(
        {
            "passed": not configuration_failures and not unallowed,
            "observedCount": len(observed),
            "allowedCount": len(allowed),
            "unallowedCount": len(unallowed),
            "observed": [
                warning_token_record(token) for token in sorted(observed)
            ],
            "allowed": [warning_token_record(token) for token in sorted(allowed)],
            "unallowed": [
                warning_token_record(token) for token in sorted(unallowed)
            ],
        }
    )
    return metadata, configuration_failures


def comparison_delta(
    baseline: dict[str, Any], candidate: dict[str, Any], slot: str
) -> tuple[dict[str, Any], list[str], list[str]]:
    before = baseline["metrics"]
    after = candidate["metrics"]
    names = (
        "visiblePixels",
        "alphaMass",
        "allowedAlphaMass",
        "outOfRegionPixelRatio",
        "outOfRegionAlphaRatio",
        "bodyCorePixels",
        "bodyCoreRatio",
        "footCorePixels",
        "footCoreRatio",
    )
    delta: dict[str, Any] = {
        name: float(after[name]) - float(before[name]) for name in names
    }
    delta["allowedAlphaRetention"] = safe_ratio(
        after["allowedAlphaMass"], before["allowedAlphaMass"]
    )
    failures: list[str] = []
    warnings: list[str] = []
    comparison = THRESHOLDS["comparison"]
    if (
        delta["outOfRegionPixelRatio"] > comparison["regionPixelRatioGrowth"]
        and delta["outOfRegionAlphaRatio"] > comparison["regionAlphaRatioGrowth"]
    ):
        failures.append("slot-region-leak-regression")
    if slot in HELD_SLOTS:
        if (
            delta["bodyCoreRatio"] > comparison["bodyCoreRatioGrowth"]
            and delta["bodyCorePixels"] > comparison["bodyCorePixelGrowth"]
        ):
            failures.append("held-body-pollution-regression")
        if (
            delta["footCoreRatio"] > comparison["footCoreRatioGrowth"]
            and delta["footCorePixels"] > comparison["footCorePixelGrowth"]
        ):
            failures.append("held-foot-pollution-regression")
    else:
        retention = delta["allowedAlphaRetention"]
        if retention < comparison["allowedAlphaRetentionFail"]:
            failures.append("allowed-region-alpha-loss")
        elif retention < comparison["allowedAlphaRetentionWarning"]:
            warnings.append("allowed-region-alpha-loss-risk")
        elif retention > comparison["allowedAlphaGrowthWarning"]:
            warnings.append("allowed-region-alpha-growth-risk")
    if after["edgeAlphaPixels"] > 0 and before["edgeAlphaPixels"] == 0:
        failures.append("new-cell-edge-clipping-risk")
    return delta, failures, warnings


def compare_datasets(
    baseline: dict[str, Any], candidate: dict[str, Any]
) -> dict[str, Any]:
    rows: list[dict[str, Any]] = []
    failures: list[str] = []
    warnings: list[str] = []
    keys = sorted(set(baseline["cells"]) | set(candidate["cells"]))
    for key in keys:
        before = baseline["cells"].get(key)
        after = candidate["cells"].get(key)
        if before is None or after is None:
            failure = "missing-baseline-cell" if before is None else "missing-candidate-cell"
            failures.append(f"{key}:{failure}")
            rows.append({"cell": key, "failures": [failure]})
            continue
        delta, row_failures, row_warnings = comparison_delta(
            before, after, str(after["slot"])
        )
        failures.extend(f"{key}:{failure}" for failure in row_failures)
        warnings.extend(f"{key}:{warning}" for warning in row_warnings)
        rows.append(
            {
                "cell": key,
                "slot": after["slot"],
                "delta": delta,
                "failures": row_failures,
                "warnings": row_warnings,
            }
        )
    return {
        "passed": not failures,
        "summary": {
            "comparedCells": len(rows),
            "failedCells": sum(bool(row["failures"]) for row in rows),
            "failureCount": len(failures),
            "warningCount": len(warnings),
        },
        "failures": failures,
        "warnings": warnings,
        "perCell": rows,
    }


def main() -> None:
    workspace = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--record-workspace",
        type=Path,
        default=workspace,
        help="base directory used to resolve relative paths in provenance reports",
    )
    parser.add_argument(
        "--integrity-manifest",
        type=Path,
        default=workspace / "app/paperdoll-rig-manifest.json",
        help="external approval pins for assets, sources, reference, and allowlist",
    )
    parser.add_argument(
        "--body",
        type=Path,
        default=workspace / "public/assets/walk/harin-mannequin-v1.png",
    )
    parser.add_argument(
        "--candidate",
        type=Path,
        default=workspace / "public/assets/paperdoll/v1",
    )
    parser.add_argument("--baseline", type=Path)
    parser.add_argument(
        "--occlusion-report",
        type=Path,
        default=workspace
        / "asset-sources/paperdoll/held-gear-v1/alignment-report.json",
    )
    parser.add_argument(
        "--occlusion-input-root",
        type=Path,
        default=workspace / "asset-sources/paperdoll/held-gear-v1/original",
        help="exact held-input root whose PNG hashes must match the alignment report",
    )
    parser.add_argument(
        "--source-visibility-report",
        type=Path,
        help=(
            "generator evidence for source-occluded cells; required only when "
            "the candidate intentionally contains an empty phase"
        ),
    )
    parser.add_argument(
        "--source-profile-root",
        type=Path,
        default=workspace / "public/assets/walk",
        help="root containing the ten fitted source profiles hashed by the visibility report",
    )
    parser.add_argument(
        "--silhouette-reference",
        type=Path,
        default=workspace
        / "asset-sources/paperdoll/paperdoll-slot-silhouette-reference-v2.json",
        help=(
            "source-profile-bound exact 3,200-cell reference generated by the "
            "layer builder"
        ),
    )
    parser.add_argument(
        "--report",
        type=Path,
        default=workspace / "tmp/paperdoll-slot-region-audit.json",
    )
    warning_allowlist_group = parser.add_mutually_exclusive_group()
    warning_allowlist_group.add_argument(
        "--warning-allowlist",
        type=Path,
        default=workspace
        / "asset-sources/paperdoll/paperdoll-slot-region-warning-allowlist-v2.json",
        help=(
            "optional hash-bound warning allowlist; without it every warning "
            "fails the audit"
        ),
    )
    warning_allowlist_group.add_argument(
        "--write-warning-allowlist",
        type=Path,
        help=(
            "write the exact observed warnings as a hash-bound allowlist and "
            "verify it in the same run"
        ),
    )
    parser.add_argument(
        "--strict",
        action="store_true",
        help="exit non-zero for candidate, comparison, or warning-contract failures",
    )
    args = parser.parse_args()

    record_workspace = args.record_workspace.resolve()
    integrity_manifest_path = args.integrity_manifest.resolve()
    try:
        integrity_manifest_payload = json.loads(
            integrity_manifest_path.read_text(encoding="utf-8")
        )
    except (OSError, json.JSONDecodeError):
        integrity_manifest_payload = {}
    integrity_pins = integrity_manifest_payload.get("assetIntegrity", {})
    if not isinstance(integrity_pins, dict):
        integrity_pins = {}
    body_path = args.body.resolve()
    candidate_root = args.candidate.resolve()
    source_profile_root = args.source_profile_root.resolve()
    current_source_profile_hashes = {
        variant: sha256(source_profile_root / filename)
        for variant, filename in SOURCE_PROFILE_FILENAMES.items()
    }
    body_atlas = Image.open(body_path).convert("RGBA")
    if body_atlas.size != ATLAS_SIZE:
        raise ValueError(f"invalid mannequin size: {body_atlas.size}")
    body_frames = {
        (row, column): body_geometry(body_atlas.crop(frame_box(row, column)))
        for row in range(ROWS)
        for column in range(COLS)
    }
    body_hash = sha256(body_path)
    silhouette_reference, silhouette_reference_failures, silhouette_contract = (
        load_silhouette_reference(
            args.silhouette_reference,
            record_workspace,
            body_path,
            candidate_root,
            source_profile_root,
            str(integrity_pins.get("silhouetteReferenceSha256", "")) or None,
        )
    )
    occlusion_classes, occlusion_failures, occlusion_contract = (
        load_occlusion_contract(
            args.occlusion_report,
            record_workspace,
            body_path,
            candidate_root,
            args.occlusion_input_root.resolve(),
            source_profile_root,
        )
    )
    source_visibility, source_visibility_failures, source_visibility_report = (
        load_source_visibility(
            args.source_visibility_report,
            body_hash,
            source_profile_root,
        )
    )
    warning_allowlist_for_integrity = (
        args.write_warning_allowlist.resolve()
        if args.write_warning_allowlist
        else args.warning_allowlist.resolve()
        if args.warning_allowlist
        else None
    )
    integrity_contract, integrity_failures = verify_integrity_manifest(
        integrity_manifest_path,
        record_workspace,
        candidate_root,
        body_path,
        source_profile_root,
        args.silhouette_reference.resolve(),
        warning_allowlist_for_integrity,
    )
    configuration_failures = (
        occlusion_failures
        + source_visibility_failures
        + silhouette_reference_failures
        + integrity_failures
    )
    candidate = audit_dataset(
        candidate_root,
        body_frames,
        occlusion_classes,
        source_visibility,
        silhouette_reference,
    )
    baseline = None
    if args.baseline:
        baseline_root = args.baseline.resolve()
        baseline = (
            candidate
            if baseline_root == candidate_root
            else audit_dataset(
                baseline_root,
                body_frames,
                {},
                source_visibility,
            )
        )
    comparison = compare_datasets(baseline, candidate) if baseline else None
    warning_allowlist_path = args.warning_allowlist
    generated_warning_allowlist = False
    if args.write_warning_allowlist:
        if configuration_failures:
            configuration_failures.append(
                "cannot-write-warning-allowlist-with-invalid-configuration"
            )
        else:
            write_warning_allowlist(
                args.write_warning_allowlist,
                candidate,
                comparison,
                body_hash,
                current_source_profile_hashes,
            )
            warning_allowlist_path = args.write_warning_allowlist
            generated_warning_allowlist = True
    warning_contract, warning_configuration_failures = evaluate_warning_contract(
        warning_allowlist_path,
        candidate,
        comparison,
        body_hash,
        current_source_profile_hashes,
        str(integrity_pins.get("warningAllowlistSha256", "")) or None,
    )
    warning_contract["generated"] = generated_warning_allowlist
    configuration_failures.extend(warning_configuration_failures)
    report = {
        "schemaVersion": 1,
        "algorithmVersion": AUDIT_ALGORITHM_VERSION,
        "generator": "scripts/audit_paperdoll_slot_regions.py",
        "body": {
            "path": str(body_path),
            "sha256": body_hash,
            "size": list(body_atlas.size),
        },
        "configuration": {
            "cell": [CELL_W, CELL_H],
            "rows": ROWS,
            "columns": COLS,
            "slots": list(SLOTS),
            "variants": list(VARIANTS),
            "visibleAlphaExclusive": VISIBLE_ALPHA,
            "bodyAlphaExclusive": BODY_ALPHA,
            "regionEnvelopes": REGION_ENVELOPES,
            "thresholds": THRESHOLDS,
            "heldWeaponLeftAuthoredRows": sorted(WEAPON_LEFT_AUTHORED_ROWS),
            "occlusionReport": str(args.occlusion_report.resolve())
            if args.occlusion_report
            else None,
            "occlusionInputRoot": str(args.occlusion_input_root.resolve()),
            "occlusionClassCount": len(occlusion_classes),
            "sourceVisibilityReport": str(args.source_visibility_report.resolve())
            if args.source_visibility_report
            else None,
            "sourceVisibilityCellCount": len(source_visibility),
            "sourceProfileRoot": str(source_profile_root),
            "requiredSourceOwnerAlgorithmVersion": SOURCE_OWNER_ALGORITHM_VERSION,
            "recordWorkspace": str(record_workspace),
            "silhouetteReference": str(args.silhouette_reference.resolve())
            if args.silhouette_reference
            else None,
            "silhouetteReferenceCellCount": len(silhouette_reference),
        },
        "passed": (
            not configuration_failures
            and candidate["passed"]
            and (comparison is None or comparison["passed"])
            and warning_contract["passed"]
        ),
        "candidate": candidate,
        "baseline": baseline,
        "comparison": comparison,
        "occlusionContract": occlusion_contract,
        "sourceVisibility": source_visibility_report,
        "silhouetteReference": silhouette_contract,
        "assetIntegrity": integrity_contract,
        "warningContract": warning_contract,
        "configurationFailures": configuration_failures,
    }
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print(
        json.dumps(
            {
                "passed": report["passed"],
                "candidate": candidate["summary"],
                "comparison": comparison["summary"] if comparison else None,
                "warnings": {
                    "mode": warning_contract["mode"],
                    "observed": warning_contract["observedCount"],
                    "allowed": warning_contract["allowedCount"],
                    "unallowed": warning_contract["unallowedCount"],
                },
                "configurationFailures": configuration_failures,
                "report": str(args.report.resolve()),
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    if configuration_failures:
        raise SystemExit(2)
    if args.strict and not report["passed"]:
        raise SystemExit(1)


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except (FileNotFoundError, json.JSONDecodeError, KeyError, TypeError, ValueError) as error:
        print(
            json.dumps(
                {
                    "passed": False,
                    "configurationError": f"{type(error).__name__}: {error}",
                },
                ensure_ascii=False,
                indent=2,
            ),
            file=sys.stderr,
        )
        raise SystemExit(2) from error
