"""Reject wearable cells that drift away from Harin after gait retargeting."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter


CELL_W = 256
CELL_H = 192
ROWS = 8
COLS = 4
ATTACHED_SLOTS = ("helm", "shoulders", "armor", "gloves", "belt", "legs", "boots")


def cell(atlas: Image.Image, row: int, column: int) -> Image.Image:
    return atlas.crop(
        (column * CELL_W, row * CELL_H, (column + 1) * CELL_W, (row + 1) * CELL_H)
    )


def attachment_metrics(layer: Image.Image, body: Image.Image) -> tuple[float, float]:
    layer_mask = np.asarray(layer.getchannel("A"), dtype=np.uint8) > 8
    body_mask = body.getchannel("A").point(lambda value: 255 if value > 16 else 0)
    within_five = np.asarray(body_mask.filter(ImageFilter.MaxFilter(11)), dtype=np.uint8) > 0
    if not np.any(layer_mask):
        return 0.0, float("inf")
    close_ratio = float(np.logical_and(layer_mask, within_five).sum() / layer_mask.sum())

    body_y, body_x = np.where(np.asarray(body_mask, dtype=np.uint8) > 0)
    layer_y, layer_x = np.where(layer_mask)
    reference = np.column_stack((body_x, body_y)).astype(np.float32)
    query = np.column_stack((layer_x, layer_y)).astype(np.float32)
    reference = reference[:: max(1, len(reference) // 900)]
    distances: list[np.ndarray] = []
    for start in range(0, len(query), 384):
        section = query[start : start + 384]
        squared = (
            (section[:, None, 0] - reference[None, :, 0]) ** 2
            + (section[:, None, 1] - reference[None, :, 1]) ** 2
        )
        distances.append(np.sqrt(np.min(squared, axis=1)))
    return close_ratio, float(np.concatenate(distances).mean())


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--old-body", type=Path, required=True)
    parser.add_argument("--new-body", type=Path, required=True)
    parser.add_argument("--old-layers", type=Path, required=True)
    parser.add_argument("--new-layers", type=Path, required=True)
    parser.add_argument("--report", type=Path, required=True)
    args = parser.parse_args()
    old_body = Image.open(args.old_body).convert("RGBA")
    new_body = Image.open(args.new_body).convert("RGBA")
    rows: list[dict[str, object]] = []
    failures: list[str] = []
    for slot in ATTACHED_SLOTS:
        for old_path in sorted((args.old_layers / slot).glob("*.png")):
            new_path = args.new_layers / slot / old_path.name
            old_atlas = Image.open(old_path).convert("RGBA")
            new_atlas = Image.open(new_path).convert("RGBA")
            for row in range(ROWS):
                for column in range(COLS):
                    old_close, old_distance = attachment_metrics(
                        cell(old_atlas, row, column),
                        cell(old_body, row, column),
                    )
                    new_close, new_distance = attachment_metrics(
                        cell(new_atlas, row, column),
                        cell(new_body, row, column),
                    )
                    close_drop = old_close - new_close
                    distance_growth = new_distance - old_distance
                    key = f"{slot}/{old_path.name}@{row},{column}"
                    if close_drop > 0.20 or distance_growth > 5.0:
                        failures.append(
                            f"{key}: close {old_close:.3f}->{new_close:.3f}, "
                            f"distance {old_distance:.2f}->{new_distance:.2f}"
                        )
                    rows.append(
                        {
                            "cell": key,
                            "old_close_ratio": old_close,
                            "new_close_ratio": new_close,
                            "close_ratio_drop": close_drop,
                            "old_mean_distance": old_distance,
                            "new_mean_distance": new_distance,
                            "distance_growth": distance_growth,
                        }
                    )
    report = {
        "passed": not failures,
        "cells": len(rows),
        "failures": failures,
        "worst_close_ratio_drop": max(float(row["close_ratio_drop"]) for row in rows),
        "worst_distance_growth": max(float(row["distance_growth"]) for row in rows),
        "per_cell": rows,
    }
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(
        json.dumps(
            {
                "passed": report["passed"],
                "cells": report["cells"],
                "failures": len(failures),
                "worst_close_ratio_drop": report["worst_close_ratio_drop"],
                "worst_distance_growth": report["worst_distance_growth"],
            },
            ensure_ascii=False,
        )
    )
    if failures:
        print("\n".join(failures[:20]))
        raise SystemExit(1)


if __name__ == "__main__":
    main()
