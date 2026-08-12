"""Audit that every weapon/offhand frame retains a visible body contact."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter


CELL_W, CELL_H = 256, 192
ROWS, COLS = 8, 4
SLOTS = ("weapon", "offhand")


def frame(atlas: Image.Image, row: int, column: int) -> Image.Image:
    return atlas.crop(
        (
            column * CELL_W,
            row * CELL_H,
            (column + 1) * CELL_W,
            (row + 1) * CELL_H,
        )
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--body", type=Path, required=True)
    parser.add_argument("--layers", type=Path, required=True)
    parser.add_argument("--report", type=Path, required=True)
    args = parser.parse_args()

    body = Image.open(args.body).convert("RGBA")
    rows: list[dict[str, object]] = []
    failures: list[str] = []
    for slot in SLOTS:
        for layer_path in sorted((args.layers / slot).glob("*.png")):
            atlas = Image.open(layer_path).convert("RGBA")
            for row in range(ROWS):
                for column in range(COLS):
                    layer_mask = (
                        np.asarray(frame(atlas, row, column).getchannel("A"), dtype=np.uint8)
                        > 8
                    )
                    body_mask = frame(body, row, column).getchannel("A").point(
                        lambda value: 255 if value > 16 else 0
                    )
                    near_body = (
                        np.asarray(body_mask.filter(ImageFilter.MaxFilter(7)), dtype=np.uint8)
                        > 0
                    )
                    layer_pixels = int(layer_mask.sum())
                    contact_pixels = int(np.logical_and(layer_mask, near_body).sum())
                    contact_ratio = contact_pixels / max(1, layer_pixels)
                    key = f"{slot}/{layer_path.name}@{row},{column}"
                    # Tiny five-pixel authored ornaments cannot satisfy a ten
                    # pixel threshold; all substantial held silhouettes must.
                    required_pixels = min(10, layer_pixels)
                    if contact_pixels < required_pixels or contact_ratio < 0.05:
                        failures.append(
                            f"{key}: contact={contact_pixels}/{layer_pixels} "
                            f"({contact_ratio:.3f})"
                        )
                    rows.append(
                        {
                            "cell": key,
                            "layer_pixels": layer_pixels,
                            "contact_pixels": contact_pixels,
                            "contact_ratio": contact_ratio,
                        }
                    )

    report = {
        "passed": not failures,
        "cells": len(rows),
        "failures": failures,
        "minimum_contact_pixels": min(int(row["contact_pixels"]) for row in rows),
        "minimum_contact_ratio": min(float(row["contact_ratio"]) for row in rows),
        "per_cell": rows,
    }
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(
        json.dumps(
            {key: value for key, value in report.items() if key != "per_cell"},
            ensure_ascii=False,
        )
    )
    if failures:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
