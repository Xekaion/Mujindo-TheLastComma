"""Audit active weapon/offhand grip contact without penalising hidden cells.

The old audit treated every transparent authoring fragment as a fully visible
weapon and measured contact against the entire torso.  That produced both
false failures (a hilt hidden behind Harin) and false passes (a detached blade
touching a boot).  This audit uses the same side-bounded mannequin hand masks
as the deterministic alignment pipeline, preserves explicit occlusion labels,
and compares alpha mass, clipping, body-core and foot-core pollution before
and after alignment.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
from PIL import Image

from align_paperdoll_held_gear import (
    BODY_ALPHA,
    CELL_H,
    CELL_W,
    COLS,
    HELD_SLOTS,
    ROWS,
    VISIBLE_ALPHA,
    HandMasks,
    alpha_mass,
    frame_box,
    hand_masks,
)


OCCLUDED_CLASSIFICATIONS = frozenset(
    {
        "occluded-tiny-fragment",
        "occluded-compact-fragment",
        "occluded-body-overlay",
        "occluded-hidden-grip",
        "occluded-authored-grip",
    }
)


def frame(atlas: Image.Image, row: int, column: int) -> Image.Image:
    return atlas.crop(frame_box(row, column))


def cell_metrics(
    layer: Image.Image,
    body: Image.Image,
    slot: str,
    row: int,
    resolved_hand_masks: HandMasks | None = None,
) -> dict[str, object]:
    mask = np.asarray(layer.getchannel("A"), dtype=np.uint8) > VISIBLE_ALPHA
    y, x = np.where(mask)
    visible_pixels = len(x)
    masks = resolved_hand_masks or hand_masks(body, slot, row)
    if visible_pixels:
        hand_contact = int(masks.near_three[y, x].sum())
        broad_hand_contact = int(masks.near_seven[y, x].sum())
        body_contact = int(masks.body_near_three[y, x].sum())
        body_core = int(masks.body_core[y, x].sum())
        foot_core = int(masks.foot_core[y, x].sum())
    else:
        hand_contact = broad_hand_contact = body_contact = body_core = foot_core = 0
    bounds = layer.getchannel("A").getbbox()
    edge_risk = bool(
        bounds
        and (
            bounds[0] <= 0
            or bounds[1] <= 0
            or bounds[2] >= CELL_W
            or bounds[3] >= CELL_H
        )
    )
    return {
        "visiblePixels": visible_pixels,
        "alphaMass": alpha_mass(layer),
        "handContactPixels": hand_contact,
        "broadHandContactPixels": broad_hand_contact,
        "handContactRatio": hand_contact / max(1, visible_pixels),
        "bodyNearPixels": body_contact,
        "bodyCorePixels": body_core,
        "bodyCoreRatio": body_core / max(1, visible_pixels),
        "footCorePixels": foot_core,
        "footCoreRatio": foot_core / max(1, visible_pixels),
        "bounds": list(bounds) if bounds else None,
        "empty": bounds is None,
        "edgeRisk": edge_risk,
    }


def load_alignment_cells(report_path: Path | None) -> dict[str, dict[str, object]]:
    if report_path is None:
        return {}
    report = json.loads(report_path.read_text(encoding="utf-8"))
    return {
        str(cell["cell"]): cell
        for cell in report.get("perCell", [])
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--body", type=Path, required=True)
    parser.add_argument("--layers", type=Path, required=True)
    parser.add_argument("--baseline-layers", type=Path)
    parser.add_argument("--alignment-report", type=Path)
    parser.add_argument("--report", type=Path, required=True)
    args = parser.parse_args()

    body_atlas = Image.open(args.body).convert("RGBA")
    if body_atlas.size != (CELL_W * COLS, CELL_H * ROWS):
        raise ValueError(f"invalid mannequin atlas size: {body_atlas.size}")
    alignment_cells = load_alignment_cells(args.alignment_report)
    rows: list[dict[str, object]] = []
    failures: list[str] = []
    before_contact_failures = 0
    after_contact_failures = 0
    hand_mask_cache = {
        (slot, row, column): hand_masks(
            frame(body_atlas, row, column),
            slot,
            row,
        )
        for slot in HELD_SLOTS
        for row in range(ROWS)
        for column in range(COLS)
    }

    for slot in HELD_SLOTS:
        for layer_path in sorted((args.layers / slot).glob("*.png")):
            atlas = Image.open(layer_path).convert("RGBA")
            baseline_atlas = (
                Image.open(args.baseline_layers / slot / layer_path.name).convert("RGBA")
                if args.baseline_layers
                else None
            )
            for row in range(ROWS):
                for column in range(COLS):
                    body = frame(body_atlas, row, column)
                    resolved_masks = hand_mask_cache[(slot, row, column)]
                    current = cell_metrics(
                        frame(atlas, row, column),
                        body,
                        slot,
                        row,
                        resolved_masks,
                    )
                    baseline = (
                        cell_metrics(
                            frame(baseline_atlas, row, column),
                            body,
                            slot,
                            row,
                            resolved_masks,
                        )
                        if baseline_atlas
                        else None
                    )
                    key = f"{slot}/{layer_path.name}@{row},{column}"
                    alignment = alignment_cells.get(key)
                    classification = (
                        str(alignment["classification"])
                        if alignment is not None
                        else (
                            "occluded-tiny-fragment"
                            if int(current["visiblePixels"]) < 48
                            else "visible-unclassified"
                        )
                    )
                    contact_exempt = classification in OCCLUDED_CLASSIFICATIONS
                    audited_after_grip = (
                        int(alignment["gripContactPixels"])
                        if alignment is not None
                        else int(current["handContactPixels"])
                    )
                    audited_before_grip = (
                        int(alignment["gripContactPixelsBefore"])
                        if alignment is not None
                        else int(baseline["handContactPixels"])
                        if baseline is not None
                        else 0
                    )
                    current_contact_failure = (
                        not contact_exempt
                        and audited_after_grip < 3
                    )
                    if current_contact_failure:
                        after_contact_failures += 1
                        failures.append(
                            f"{key}: visible held silhouette misses the {slot} hand "
                            f"({audited_after_grip} audited grip pixels)"
                        )
                    if bool(current["empty"]):
                        failures.append(f"{key}: empty output cell")
                    if bool(current["edgeRisk"]):
                        failures.append(f"{key}: output touches the cell crop edge")

                    comparison: dict[str, object] | None = None
                    if baseline is not None:
                        baseline_contact_failure = (
                            not contact_exempt
                            and audited_before_grip < 3
                        )
                        before_contact_failures += int(baseline_contact_failure)
                        mass_preserved = current["alphaMass"] == baseline["alphaMass"]
                        if not mass_preserved:
                            failures.append(
                                f"{key}: alpha mass changed "
                                f"{baseline['alphaMass']}->{current['alphaMass']}"
                            )
                        body_growth = float(current["bodyCoreRatio"]) - float(
                            baseline["bodyCoreRatio"]
                        )
                        foot_growth = float(current["footCoreRatio"]) - float(
                            baseline["footCoreRatio"]
                        )
                        # A held item may legitimately overlap the torso after
                        # attachment.  Reject only catastrophic migration into
                        # the lower body, not a shield covering the forearm.
                        if (
                            not contact_exempt
                            and int(current["visiblePixels"]) >= 96
                            and float(current["footCoreRatio"]) > 0.48
                            and foot_growth > 0.28
                        ):
                            failures.append(
                                f"{key}: excessive foot-core migration "
                                f"({baseline['footCoreRatio']:.3f}->"
                                f"{current['footCoreRatio']:.3f})"
                            )
                        comparison = {
                            "alphaMassPreserved": mass_preserved,
                            "handContactPixelGain": int(current["handContactPixels"])
                            - int(baseline["handContactPixels"]),
                            "auditedGripContactPixelGain": audited_after_grip
                            - audited_before_grip,
                            "broadHandContactPixelGain": int(
                                current["broadHandContactPixels"]
                            )
                            - int(baseline["broadHandContactPixels"]),
                            "bodyCoreRatioGrowth": body_growth,
                            "footCoreRatioGrowth": foot_growth,
                        }
                    rows.append(
                        {
                            "cell": key,
                            "classification": classification,
                            "contactExempt": contact_exempt,
                            "before": baseline,
                            "after": current,
                            "comparison": comparison,
                        }
                    )

    aligned_rows = [row for row in rows if not row["contactExempt"]]
    comparisons = [
        row["comparison"] for row in rows if row["comparison"] is not None
    ]
    report = {
        "schemaVersion": 1,
        "generator": "scripts/audit_paperdoll_held_gear.py",
        "passed": not failures,
        "summary": {
            "cells": len(rows),
            "contactEligibleCells": len(aligned_rows),
            "occlusionExemptCells": len(rows) - len(aligned_rows),
            "beforeContactFailures": before_contact_failures
            if args.baseline_layers
            else None,
            "afterContactFailures": after_contact_failures,
            "contactFailuresFixed": before_contact_failures - after_contact_failures
            if args.baseline_layers
            else None,
            "emptyCells": sum(bool(row["after"]["empty"]) for row in rows),
            "edgeRiskCells": sum(bool(row["after"]["edgeRisk"]) for row in rows),
            "alphaMassPreservedCells": sum(
                bool(comparison["alphaMassPreserved"]) for comparison in comparisons
            )
            if comparisons
            else None,
            "beforeBodyCorePixels": sum(
                int(row["before"]["bodyCorePixels"])
                for row in rows
                if row["before"] is not None
            ),
            "afterBodyCorePixels": sum(int(row["after"]["bodyCorePixels"]) for row in rows),
            "beforeFootCorePixels": sum(
                int(row["before"]["footCorePixels"])
                for row in rows
                if row["before"] is not None
            ),
            "afterFootCorePixels": sum(int(row["after"]["footCorePixels"]) for row in rows),
            "worstBodyCoreRatioGrowth": max(
                (float(comparison["bodyCoreRatioGrowth"]) for comparison in comparisons),
                default=0.0,
            ),
            "worstFootCoreRatioGrowth": max(
                (float(comparison["footCoreRatioGrowth"]) for comparison in comparisons),
                default=0.0,
            ),
        },
        "failures": failures,
        "perCell": rows,
    }
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(
        json.dumps(
            {
                "passed": report["passed"],
                **report["summary"],
                "failureCount": len(failures),
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    if failures:
        print("\n".join(failures[:24]))
        raise SystemExit(1)


if __name__ == "__main__":
    main()
