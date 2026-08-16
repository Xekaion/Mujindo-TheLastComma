"""Build the active paperdoll rig's deterministic audit and runtime anchors.

The runtime frame is registered at a fixed foot pivot, while equipment VFX
belong at the centre of the pixels painted for their slot.  For every runtime
direction and gait frame this builder measures the alpha-visible bounding box
of all manifest variants, takes the coordinate-wise median of their pivots,
and records that visual point both in frame space and relative to the foot.

No source raster is modified.  The full report preserves every atlas hash and
geometry diagnostic, while the compact runtime payload contains only the data
needed to attach effects. ``--check`` regenerates both canonical payloads in
memory and byte-compares them with the checked-in files.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
from statistics import median
from typing import Any

from PIL import Image


ROOT = Path(__file__).resolve().parents[1]
MANIFEST_PATH = ROOT / "app" / "paperdoll-rig-manifest.json"
GENERATOR_PATH = "scripts/build_paperdoll_anchor_report.py"


def canonical_json(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def stable_number(value: float) -> int | float:
    """Keep exact quarter pixels while avoiding unstable JSON ``12.0`` values."""

    rounded = round(value * 4) / 4
    if rounded.is_integer():
        return int(rounded)
    return rounded


def visible_geometry(
    atlas: Image.Image,
    crop: tuple[int, int, int, int],
    alpha_threshold: int,
) -> dict[str, object]:
    alpha = atlas.crop(crop).getchannel("A")
    visible = alpha.point(lambda value: 255 if value > alpha_threshold else 0)
    bbox = visible.getbbox()
    if bbox is None:
        raise ValueError(f"empty alpha geometry at crop {crop}")
    histogram = visible.histogram()
    left, top, right, bottom = bbox
    return {
        "visibleBBox": [left, top, right, bottom],
        "visibleBBoxPivot": [
            stable_number((left + right) / 2),
            stable_number((top + bottom) / 2),
        ],
        "visibleAlphaPixels": histogram[255],
    }


def input_record(role: str, relative_path: str, expected_size: tuple[int, int]) -> dict[str, object]:
    path = ROOT / relative_path
    payload = path.read_bytes()
    with Image.open(path) as image:
        size = image.size
        mode = image.mode
    if size != expected_size:
        raise ValueError(f"{relative_path}: expected {expected_size}, got {size}")
    if mode != "RGBA":
        raise ValueError(f"{relative_path}: expected RGBA, got {mode}")
    return {
        "role": role,
        "path": relative_path.replace("\\", "/"),
        "bytes": len(payload),
        "mode": mode,
        "sha256": sha256_bytes(payload),
    }


def build_reports() -> tuple[
    Path,
    dict[str, object],
    Path,
    dict[str, object],
]:
    manifest_bytes = MANIFEST_PATH.read_bytes()
    manifest: dict[str, Any] = json.loads(manifest_bytes)
    frame = manifest["frame"]
    width = int(frame["width"])
    height = int(frame["height"])
    columns = int(frame["columns"])
    direction_rows = [int(value) for value in frame["directionRows"]]
    slots = [str(value) for value in manifest["slots"]]
    variant_names = [str(value) for value in manifest["variantNames"]]
    anchor_config = manifest["anchorReport"]
    alpha_threshold = int(anchor_config["alphaThreshold"])
    audit_output_path = MANIFEST_PATH.parent / str(anchor_config["auditPath"])
    runtime_output_path = MANIFEST_PATH.parent / str(anchor_config["runtimePath"])

    if audit_output_path == runtime_output_path:
        raise ValueError("audit and runtime anchor reports must use different paths")

    if len(slots) != 10 or len(set(slots)) != len(slots):
        raise ValueError("the active rig must declare ten unique equipment slots")
    if len(variant_names) != 10 or len(set(variant_names)) != len(variant_names):
        raise ValueError("the active rig must declare ten unique equipment variants")
    if len(direction_rows) != 8 or len(set(direction_rows)) != len(direction_rows):
        raise ValueError("the active rig must declare eight unique authored direction rows")
    if not 0 <= alpha_threshold < 255:
        raise ValueError("anchor alpha threshold must be between 0 and 254")

    atlas_size = (width * columns, height * len(direction_rows))
    foot_pivot = [stable_number(width / 2), int(frame["groundBaseline"])]
    public_root = ROOT / "public"
    body_relative = f"public/{str(manifest['bodyPath']).lstrip('/')}"
    body_path = ROOT / body_relative
    layer_relative_root = f"public/{str(manifest['layerRoot']).lstrip('/')}"
    layer_root = ROOT / layer_relative_root

    asset_files: list[dict[str, object]] = [
        input_record("body", body_relative, atlas_size)
    ]
    for slot in slots:
        slot_root = layer_root / slot
        actual_names = sorted(path.name for path in slot_root.iterdir())
        expected_names = [
            f"{index:02d}-{variant_name}.png"
            for index, variant_name in enumerate(variant_names)
        ]
        if actual_names != expected_names:
            raise ValueError(
                f"{slot}: expected atlases {expected_names}, got {actual_names}"
            )
        for index, variant_name in enumerate(variant_names):
            relative_path = (
                f"{layer_relative_root}/{slot}/{index:02d}-{variant_name}.png"
            )
            asset_files.append(
                input_record(f"slot:{slot}:{variant_name}", relative_path, atlas_size)
            )

    with Image.open(body_path) as source_body:
        body = source_body.convert("RGBA")
    body_frames: list[list[dict[str, object]]] = []
    for direction, source_row in enumerate(direction_rows):
        direction_frames: list[dict[str, object]] = []
        for gait_frame in range(columns):
            crop = (
                gait_frame * width,
                source_row * height,
                (gait_frame + 1) * width,
                (source_row + 1) * height,
            )
            geometry = visible_geometry(body, crop, alpha_threshold)
            body_alpha = body.crop(crop).getchannel("A")
            raw_bbox = body_alpha.getbbox()
            if raw_bbox is None:
                raise ValueError(f"body direction {direction} frame {gait_frame} is empty")
            raw_support_bottom = raw_bbox[3]
            visible_bbox = geometry["visibleBBox"]
            assert isinstance(visible_bbox, list)
            visible_foot_gap = int(frame["groundBaseline"]) - int(visible_bbox[3])
            if raw_support_bottom != int(frame["groundBaseline"]):
                raise ValueError(
                    f"body direction {direction} frame {gait_frame}: raw alpha bottom "
                    f"{raw_support_bottom} does not meet ground baseline {frame['groundBaseline']}"
                )
            if visible_foot_gap not in (1, 2):
                raise ValueError(
                    f"body direction {direction} frame {gait_frame}: visible foot gap "
                    f"{visible_foot_gap} is outside the v1 contract"
                )
            direction_frames.append(
                {
                    "direction": direction,
                    "frame": gait_frame,
                    "sourceRow": source_row,
                    **geometry,
                    "rawSupportBBox": list(raw_bbox),
                    "rawSupportBottomEdge": raw_support_bottom,
                    "visibleFootGap": visible_foot_gap,
                }
            )
        body_frames.append(direction_frames)

    slot_reports: dict[str, list[list[dict[str, object]]]] = {}
    for slot in slots:
        samples: list[list[list[dict[str, object]]]] = [
            [[] for _ in range(columns)] for _ in direction_rows
        ]
        for index, variant_name in enumerate(variant_names):
            atlas_path = layer_root / slot / f"{index:02d}-{variant_name}.png"
            with Image.open(atlas_path) as source_atlas:
                atlas = source_atlas.convert("RGBA")
            for direction, source_row in enumerate(direction_rows):
                for gait_frame in range(columns):
                    crop = (
                        gait_frame * width,
                        source_row * height,
                        (gait_frame + 1) * width,
                        (source_row + 1) * height,
                    )
                    geometry = visible_geometry(atlas, crop, alpha_threshold)
                    samples[direction][gait_frame].append(
                        {"variant": variant_name, **geometry}
                    )

        direction_reports: list[list[dict[str, object]]] = []
        for direction, source_row in enumerate(direction_rows):
            frame_reports: list[dict[str, object]] = []
            for gait_frame in range(columns):
                cell_samples = samples[direction][gait_frame]
                bboxes = [sample["visibleBBox"] for sample in cell_samples]
                pivots = [sample["visibleBBoxPivot"] for sample in cell_samples]
                alpha_pixels = [int(sample["visibleAlphaPixels"]) for sample in cell_samples]
                median_bbox = [
                    stable_number(float(median([bbox[edge] for bbox in bboxes])))
                    for edge in range(4)
                ]
                visual_anchor = [
                    stable_number(float(median([pivot[axis] for pivot in pivots])))
                    for axis in range(2)
                ]
                pivot_range = [
                    stable_number(float(min(pivot[0] for pivot in pivots))),
                    stable_number(float(max(pivot[0] for pivot in pivots))),
                    stable_number(float(min(pivot[1] for pivot in pivots))),
                    stable_number(float(max(pivot[1] for pivot in pivots))),
                ]
                attachment_from_foot = [
                    stable_number(float(visual_anchor[axis]) - float(foot_pivot[axis]))
                    for axis in range(2)
                ]
                frame_reports.append(
                    {
                        "direction": direction,
                        "frame": gait_frame,
                        "sourceRow": source_row,
                        "variantCount": len(cell_samples),
                        "medianVisibleBBox": median_bbox,
                        "visualAnchor": visual_anchor,
                        "visibleBBoxPivotRange": pivot_range,
                        "attachmentFromFoot": attachment_from_foot,
                        "visibleAlphaPixelRange": [min(alpha_pixels), max(alpha_pixels)],
                        "lowSupportVariantCount": sum(
                            pixel_count <= 16 for pixel_count in alpha_pixels
                        ),
                        "sourceGeometrySha256": sha256_bytes(
                            canonical_json(cell_samples).encode("utf-8")
                        ),
                    }
                )
            direction_reports.append(frame_reports)
        slot_reports[slot] = direction_reports

    manifest_record = {
        "path": "app/paperdoll-rig-manifest.json",
        "bytes": len(manifest_bytes),
        "sha256": sha256_bytes(manifest_bytes),
    }
    report: dict[str, object] = {
        "schemaVersion": int(anchor_config["schemaVersion"]),
        "algorithmVersion": str(anchor_config["algorithmVersion"]),
        "generator": GENERATOR_PATH,
        "generatorSha256": sha256_bytes((ROOT / GENERATOR_PATH).read_bytes()),
        "rigVersion": str(manifest["version"]),
        "manifest": manifest_record,
        "frame": {
            "width": width,
            "height": height,
            "columns": columns,
            "directionRows": direction_rows,
            "groundBaseline": int(frame["groundBaseline"]),
            "footPivot": foot_pivot,
        },
        "contract": {
            "coordinateSpace": "frame-local pixel-edge coordinates from top-left",
            "visibleAlpha": f"alpha > {alpha_threshold}",
            "visibleBBox": "[left, top, rightExclusive, bottomExclusive]",
            "visibleBBoxPivot": "[(left + rightExclusive) / 2, (top + bottomExclusive) / 2]",
            "visualAnchor": "coordinate-wise median visibleBBoxPivot across every manifest variant for one slot, runtime direction, and frame",
            "footPivot": "fixed frame-to-world registration point [frame.width / 2, manifest.frame.groundBaseline]",
            "bodyVisibleFootEdge": "raw alpha bottomExclusive must equal the ground baseline; alpha-threshold visible bottomExclusive must stay 1-2px above it",
            "attachmentFromFoot": "visualAnchor - frame.footPivot",
            "lowSupportVariant": "visibleAlphaPixels <= 16; diagnostic only, never an attachment hard gate",
            "precision": "exact quarter-pixel values",
        },
        "variants": variant_names,
        "assets": {
            "atlasSize": list(atlas_size),
            "files": asset_files,
        },
        "bodyFrames": body_frames,
        "slots": slot_reports,
    }
    geometry_payload = {"bodyFrames": body_frames, "slots": slot_reports}
    input_payload = {"manifest": manifest_record, "assets": asset_files}
    report["integrity"] = {
        "inputSha256": sha256_bytes(canonical_json(input_payload).encode("utf-8")),
        "geometrySha256": sha256_bytes(
            canonical_json(geometry_payload).encode("utf-8")
        ),
    }
    integrity = report["integrity"]
    assert isinstance(integrity, dict)
    integrity["payloadSha256"] = sha256_bytes(canonical_json(report).encode("utf-8"))

    # The client only needs one frame-local visual point per slot/gait cell.
    # Keep all 101 asset hashes, body geometry, per-variant diagnostics and
    # provenance in the audit report above so none of that bulk reaches the
    # browser bundle.
    runtime_report: dict[str, object] = {
        "schemaVersion": report["schemaVersion"],
        "algorithmVersion": report["algorithmVersion"],
        "rigVersion": report["rigVersion"],
        "frame": report["frame"],
        "slots": {
            slot: [
                [cell["visualAnchor"] for cell in direction_frames]
                for direction_frames in slot_reports[slot]
            ]
            for slot in slots
        },
        "sourceReportIntegrity": {
            "inputSha256": integrity["inputSha256"],
            "geometrySha256": integrity["geometrySha256"],
            "payloadSha256": integrity["payloadSha256"],
        },
    }
    return audit_output_path, report, runtime_output_path, runtime_report


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--check",
        action="store_true",
        help="fail unless the checked-in report exactly matches every current input",
    )
    args = parser.parse_args()
    audit_output_path, report, runtime_output_path, runtime_report = build_reports()
    outputs = [
        (
            audit_output_path,
            (json.dumps(report, ensure_ascii=False, indent=2) + "\n").encode("utf-8"),
        ),
        (
            runtime_output_path,
            (canonical_json(runtime_report) + "\n").encode("utf-8"),
        ),
    ]
    if args.check:
        stale_outputs = [
            str(path.relative_to(ROOT))
            for path, serialized in outputs
            if not path.exists() or path.read_bytes() != serialized
        ]
        if stale_outputs:
            raise SystemExit(
                "stale paperdoll anchor output(s) "
                f"{', '.join(stale_outputs)}: run {GENERATOR_PATH}"
            )
        print(
            json.dumps(
                {
                    "passed": True,
                    "rigVersion": report["rigVersion"],
                    "slots": len(report["slots"]),
                    "cells": sum(
                        len(frames)
                        for directions in report["slots"].values()
                        for frames in directions
                    ),
                    "payloadSha256": report["integrity"]["payloadSha256"],
                    "runtimeBytes": len(outputs[1][1]),
                },
                separators=(",", ":"),
            )
        )
        return
    for output_path, serialized in outputs:
        output_path.write_bytes(serialized)
        print(f"wrote {output_path.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
