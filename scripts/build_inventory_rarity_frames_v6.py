"""Build the square-window inventory rarity-frame atlas V6.

The V5 atlas already has a strict 320 x 320 cell and 304 x 304 painted-bound
contract for all eight rarities.  Its mythic artwork is the sole geometry
outlier: the centre-connected clear window is 173 x 148 and is shifted down by
the oversized top crown.  This source-preserving build keeps every horizontal
coordinate and every non-mythic cell pixel-identical, then performs a vertical
three-band resize inside the mythic cell so that its clear window becomes the
same 173 x 173 square as its original width.

This is intentionally a deterministic geometric correction, not a redraw.
The authored colour, spikes, crown, gems, and outer 304 px square stay intact.
"""

from __future__ import annotations

from collections import deque
from hashlib import sha256
import json
from pathlib import Path

from PIL import Image


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "public/assets/ui/rarity-frames.png"
OUTPUT = ROOT / "public/assets/ui/rarity-frames-v6.png"
REPORT = ROOT / "public/assets/ui/rarity-frames-v6.build.json"

RARITIES = (
    "common",
    "magic",
    "superior",
    "rare",
    "epic",
    "legendary",
    "mythic",
    "cosmic",
)
CELL_SIZE = 320
MYTHIC_INDEX = RARITIES.index("mythic")
ALPHA_CLEAR_THRESHOLD = 8

# Exclusive source/destination band boundaries.  The destination opening uses
# the mythic source opening's horizontal bounds (x=74..246), yielding a centred
# 173 x 173 clear window without changing any x coordinate.
SOURCE_OUTER_TOP = 8
SOURCE_WINDOW_TOP = 100
SOURCE_WINDOW_BOTTOM = 248
SOURCE_OUTER_BOTTOM = 312
TARGET_WINDOW_TOP = 74
TARGET_WINDOW_BOTTOM = 247


def digest(path: Path) -> str:
    return sha256(path.read_bytes()).hexdigest()


def pixel_digest(image: Image.Image) -> str:
    return sha256(image.convert("RGBA").tobytes()).hexdigest()


def centre_clear_component_bounds(
    frame: Image.Image,
    threshold: int = ALPHA_CLEAR_THRESHOLD,
) -> tuple[int, int, int, int]:
    """Return the exclusive bbox of the transparent component at cell centre."""

    alpha = frame.convert("RGBA").getchannel("A")
    pixels = alpha.load()
    centre = (frame.width // 2, frame.height // 2)
    if pixels[centre[0], centre[1]] > threshold:
        raise ValueError("frame centre is not part of the transparent equipment window")

    pending: deque[tuple[int, int]] = deque([centre])
    visited = {centre}
    while pending:
        x, y = pending.popleft()
        for neighbour in ((x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)):
            nx, ny = neighbour
            if not (0 <= nx < frame.width and 0 <= ny < frame.height):
                continue
            if neighbour in visited or pixels[nx, ny] > threshold:
                continue
            visited.add(neighbour)
            pending.append(neighbour)

    xs = [point[0] for point in visited]
    ys = [point[1] for point in visited]
    return min(xs), min(ys), max(xs) + 1, max(ys) + 1


def alpha_bounds(frame: Image.Image) -> tuple[int, int, int, int]:
    bounds = frame.convert("RGBA").getchannel("A").getbbox()
    if bounds is None:
        raise ValueError("rarity frame is empty")
    return bounds


def resize_vertical_band(frame: Image.Image, top: int, bottom: int, height: int) -> Image.Image:
    if bottom <= top or height <= 0:
        raise ValueError("invalid vertical band geometry")
    return frame.crop((0, top, frame.width, bottom)).resize(
        (frame.width, height),
        Image.Resampling.LANCZOS,
    )


def normalize_mythic(frame: Image.Image) -> Image.Image:
    frame = frame.convert("RGBA")
    source_window = centre_clear_component_bounds(frame)
    if source_window != (74, 100, 247, 248):
        raise ValueError(f"unexpected mythic source window: {source_window}")
    if alpha_bounds(frame) != (8, 8, 312, 312):
        raise ValueError(f"unexpected mythic outer bounds: {alpha_bounds(frame)}")

    output = Image.new("RGBA", frame.size, (0, 0, 0, 0))

    # Preserve transparent gutters and the outside edge rows byte-for-byte.
    output.alpha_composite(frame.crop((0, 0, CELL_SIZE, SOURCE_OUTER_TOP)), (0, 0))
    output.alpha_composite(
        resize_vertical_band(
            frame,
            SOURCE_OUTER_TOP,
            SOURCE_WINDOW_TOP,
            TARGET_WINDOW_TOP - SOURCE_OUTER_TOP,
        ),
        (0, SOURCE_OUTER_TOP),
    )
    output.alpha_composite(
        resize_vertical_band(
            frame,
            SOURCE_WINDOW_TOP,
            SOURCE_WINDOW_BOTTOM,
            TARGET_WINDOW_BOTTOM - TARGET_WINDOW_TOP,
        ),
        (0, TARGET_WINDOW_TOP),
    )
    output.alpha_composite(
        resize_vertical_band(
            frame,
            SOURCE_WINDOW_BOTTOM,
            SOURCE_OUTER_BOTTOM,
            SOURCE_OUTER_BOTTOM - TARGET_WINDOW_BOTTOM,
        ),
        (0, TARGET_WINDOW_BOTTOM),
    )
    output.alpha_composite(
        frame.crop((0, SOURCE_OUTER_BOTTOM, CELL_SIZE, CELL_SIZE)),
        (0, SOURCE_OUTER_BOTTOM),
    )
    return output


def main() -> None:
    source = Image.open(SOURCE).convert("RGBA")
    expected_size = (CELL_SIZE * len(RARITIES), CELL_SIZE)
    if source.size != expected_size:
        raise ValueError(f"unexpected source atlas size: {source.size}, expected {expected_size}")

    output = Image.new("RGBA", expected_size, (0, 0, 0, 0))
    cells: list[dict[str, object]] = []
    for index, rarity in enumerate(RARITIES):
        box = (index * CELL_SIZE, 0, (index + 1) * CELL_SIZE, CELL_SIZE)
        source_frame = source.crop(box)
        output_frame = normalize_mythic(source_frame) if index == MYTHIC_INDEX else source_frame.copy()
        output.alpha_composite(output_frame, (index * CELL_SIZE, 0))

        source_window = centre_clear_component_bounds(source_frame)
        output_window = centre_clear_component_bounds(output_frame)
        cells.append(
            {
                "index": index,
                "rarity": rarity,
                "sourcePixelSha256": pixel_digest(source_frame),
                "outputPixelSha256": pixel_digest(output_frame),
                "pixelIdentical": source_frame.tobytes() == output_frame.tobytes(),
                "sourceOuterBounds": list(alpha_bounds(source_frame)),
                "outputOuterBounds": list(alpha_bounds(output_frame)),
                "sourceClearWindow": list(source_window),
                "outputClearWindow": list(output_window),
                "outputClearWindowSize": [
                    output_window[2] - output_window[0],
                    output_window[3] - output_window[1],
                ],
            }
        )

    mythic = cells[MYTHIC_INDEX]
    if mythic["outputOuterBounds"] != [8, 8, 312, 312]:
        raise ValueError(f"mythic outer square moved: {mythic['outputOuterBounds']}")
    width, height = mythic["outputClearWindowSize"]
    if abs(width - height) > 2:
        raise ValueError(f"mythic clear window is not square: {width} x {height}")
    for cell in cells:
        if cell["rarity"] != "mythic" and not cell["pixelIdentical"]:
            raise ValueError(f"{cell['rarity']} changed during mythic-only normalization")

    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    output.save(OUTPUT, optimize=True)
    report = {
        "version": 6,
        "builder": "scripts/build_inventory_rarity_frames_v6.py",
        "format": "RGBA PNG",
        "sheet": {
            "columns": len(RARITIES),
            "rows": 1,
            "cell": [CELL_SIZE, CELL_SIZE],
            "size": list(expected_size),
        },
        "source": str(SOURCE.relative_to(ROOT)).replace("\\", "/"),
        "sourceSha256": digest(SOURCE),
        "output": str(OUTPUT.relative_to(ROOT)).replace("\\", "/"),
        "pipeline": {
            "mode": "source-preserving deterministic vertical three-band resize",
            "editedCells": ["mythic"],
            "alphaClearThreshold": ALPHA_CLEAR_THRESHOLD,
            "sourceVerticalBands": [
                SOURCE_OUTER_TOP,
                SOURCE_WINDOW_TOP,
                SOURCE_WINDOW_BOTTOM,
                SOURCE_OUTER_BOTTOM,
            ],
            "targetVerticalBands": [
                SOURCE_OUTER_TOP,
                TARGET_WINDOW_TOP,
                TARGET_WINDOW_BOTTOM,
                SOURCE_OUTER_BOTTOM,
            ],
            "horizontalCoordinatesChanged": False,
            "spectacleAssetsChanged": False,
        },
        "cells": cells,
    }
    report["outputSha256"] = digest(OUTPUT)
    REPORT.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
