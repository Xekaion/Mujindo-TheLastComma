#!/usr/bin/env python3
"""Register the generated Forbidden Indexer walk and pattern atlases.

The image generator authored seven walk-facing bands on a softly varying green
matte.  This pipeline keys that matte, associates each nominal walk cell with
its centered actor silhouette, registers the seven authored rows, and creates
the missing south-east row as an exact mirror of south-west.  VFX deliberately
keep their detached shards, so those cells are keyed without component
filtering before being fitted to the canonical 4x2 runtime atlas.
"""

from __future__ import annotations

from collections import deque
from hashlib import sha256
import json
from pathlib import Path

import numpy as np
from PIL import Image


ROOT = Path(__file__).resolve().parents[1]
SOURCE_ROOT = ROOT / "asset-sources/legacy-arpg"
WALK_SOURCE = SOURCE_ROOT / "forbidden-indexer-walk-source-v1.png"
VFX_SOURCE = SOURCE_ROOT / "forbidden-indexer-vfx-source-v1.png"
WALK_OUTPUT = ROOT / "public/assets/walk/forbidden-indexer-walk-v1.png"
VFX_OUTPUT = ROOT / "public/assets/effects/forbidden-indexer-patterns-v1.png"
REPORT = ROOT / "public/assets/effects/forbidden-indexer-v1.build.json"

WALK_CELL = (256, 192)
WALK_OUTPUT_SIZE = (1024, 1536)
VFX_CELL = (512, 512)
VFX_OUTPUT_SIZE = (2048, 1024)
WALK_BASELINE_EXCLUSIVE = 185
WALK_TARGET_HEIGHTS = (176, 176, 174, 178, 176, 174, 174, 176)
WALK_BANDS = (
    (17, 225),
    (249, 457),
    (479, 685),
    (714, 926),
    (942, 1145),
    (1169, 1379),
    (1414, 1631),
)
ROW_ORDER = ("south", "south-west", "west", "north-west", "north", "north-east", "east", "south-east")
ALPHA_LEVELS = (0, 72, 128, 192, 255)

# A dedicated Indexer palette keeps the generated navy/violet identity while
# retaining the tarnished brass and soot ramps shared by the existing bosses.
PALETTE = (
    (0, 0, 0), (4, 5, 9), (7, 8, 15), (10, 11, 22),
    (13, 13, 30), (16, 15, 39), (20, 18, 49), (25, 21, 61),
    (31, 25, 74), (39, 29, 88), (48, 35, 103), (59, 42, 119),
    (18, 18, 20), (27, 27, 30), (38, 37, 41), (51, 49, 54),
    (66, 63, 68), (83, 79, 84), (104, 98, 101), (129, 121, 119),
    (46, 17, 72), (59, 19, 91), (73, 23, 111), (89, 28, 132),
    (108, 35, 155), (130, 46, 180), (154, 61, 202), (179, 82, 220),
    (202, 112, 235), (221, 151, 246), (237, 193, 253), (249, 228, 255),
    (40, 28, 14), (55, 38, 17), (72, 49, 21), (91, 62, 26),
    (112, 77, 32), (135, 94, 40), (160, 114, 51), (185, 138, 66),
    (207, 162, 85), (225, 187, 111), (239, 211, 148), (249, 232, 190),
    (49, 43, 40), (77, 67, 59), (111, 96, 81), (151, 132, 107),
    (190, 170, 139), (222, 207, 177), (239, 230, 205), (250, 245, 229),
)


def digest(path: Path) -> str:
    return sha256(path.read_bytes()).hexdigest()


def nearest_alpha(value: int) -> int:
    return min(ALPHA_LEVELS, key=lambda level: abs(level - value))


def palette_image() -> Image.Image:
    values = [channel for colour in PALETTE for channel in colour]
    values.extend([0] * (768 - len(values)))
    palette = Image.new("P", (1, 1))
    palette.putpalette(values)
    return palette


def quantize_rgba(image: Image.Image) -> Image.Image:
    rgba = image.convert("RGBA")
    alpha = rgba.getchannel("A").point(nearest_alpha)
    rgb = rgba.convert("RGB").quantize(
        palette=palette_image(),
        dither=Image.Dither.FLOYDSTEINBERG,
    ).convert("RGB")
    rgb.putalpha(alpha)
    return rgb


def proportional_bounds(length: int, index: int, count: int) -> tuple[int, int]:
    return round(index * length / count), round((index + 1) * length / count)


def remove_green_matte(source: Image.Image) -> Image.Image:
    """Convert the generated near-green matte to stepped alpha with despill."""
    rgb = np.asarray(source.convert("RGB"), dtype=np.float64)
    red = rgb[:, :, 0]
    green = rgb[:, :, 1]
    blue = rgb[:, :, 2]
    dominance = green - np.maximum(red, blue)
    # The generated key varies around (3..24, 241..249, 2..17).  Dominance is
    # more reliable than distance to one corner and leaves gold/violet intact.
    alpha = np.clip((118.0 - dominance) / (118.0 - 28.0) * 255.0, 0, 255)
    strong_key = (green > 175) & (dominance > 82)
    alpha[strong_key] = 0
    opaque_subject = dominance < 24
    alpha[opaque_subject] = 255
    stepped = np.vectorize(nearest_alpha, otypes=[np.uint8])(alpha.astype(np.uint8))

    output = rgb.copy()
    fringe = (stepped > 0) & (stepped < 255)
    output[:, :, 1][fringe] = np.minimum(
        output[:, :, 1][fringe],
        np.maximum(output[:, :, 0][fringe], output[:, :, 2][fringe]) * 1.12 + 8,
    )
    output[stepped == 0] = 0
    rgba = np.dstack((np.clip(output, 0, 255).astype(np.uint8), stepped))
    return Image.fromarray(rgba, mode="RGBA")


def component_mask_near_cell_center(image: Image.Image) -> Image.Image:
    """Keep the centered actor plus nearby detached tags, rejecting neighbour spill."""
    alpha = np.asarray(image.getchannel("A")) > 0
    height, width = alpha.shape
    visited = np.zeros_like(alpha, dtype=bool)
    components: list[dict[str, object]] = []
    for seed_y, seed_x in zip(*np.nonzero(alpha)):
        if visited[seed_y, seed_x]:
            continue
        queue: deque[tuple[int, int]] = deque([(int(seed_x), int(seed_y))])
        visited[seed_y, seed_x] = True
        pixels: list[tuple[int, int]] = []
        while queue:
            x, y = queue.popleft()
            pixels.append((x, y))
            for next_x, next_y in (
                (x - 1, y - 1), (x, y - 1), (x + 1, y - 1),
                (x - 1, y),                 (x + 1, y),
                (x - 1, y + 1), (x, y + 1), (x + 1, y + 1),
            ):
                if (
                    0 <= next_x < width
                    and 0 <= next_y < height
                    and alpha[next_y, next_x]
                    and not visited[next_y, next_x]
                ):
                    visited[next_y, next_x] = True
                    queue.append((next_x, next_y))
        xs = [pixel[0] for pixel in pixels]
        ys = [pixel[1] for pixel in pixels]
        components.append({
            "pixels": pixels,
            "size": len(pixels),
            "box": (min(xs), min(ys), max(xs) + 1, max(ys) + 1),
            "center": (sum(xs) / len(xs), sum(ys) / len(ys)),
        })

    if not components:
        return image
    center_x = width / 2
    center_y = height * 0.56
    primary = max(
        components,
        key=lambda component: float(component["size"])
        - 2.4 * abs(component["center"][0] - center_x)
        - 0.7 * abs(component["center"][1] - center_y),
    )
    left, top, right, bottom = primary["box"]

    def box_distance(box: tuple[int, int, int, int]) -> float:
        other_left, other_top, other_right, other_bottom = box
        dx = max(left - other_right, other_left - right, 0)
        dy = max(top - other_bottom, other_top - bottom, 0)
        return float(np.hypot(dx, dy))

    kept = np.zeros_like(alpha)
    for component in components:
        component_center_x = component["center"][0]
        associated = (
            component is primary
            or (
                int(component["size"]) >= 3
                and box_distance(component["box"]) <= 22
                and width * 0.04 <= component_center_x <= width * 0.96
            )
        )
        if associated:
            for x, y in component["pixels"]:
                kept[y, x] = True
    rgba = np.asarray(image.convert("RGBA")).copy()
    rgba[~kept] = 0
    return Image.fromarray(rgba, mode="RGBA")


def fit_cell(source: Image.Image, cell_size: tuple[int, int], maximum: tuple[int, int], baseline: int | None = None) -> Image.Image:
    bounds = source.getchannel("A").getbbox()
    if bounds is None:
        raise ValueError("generated atlas cell became empty")
    crop = source.crop(bounds)
    scale = min(maximum[0] / crop.width, maximum[1] / crop.height)
    resized = crop.resize(
        (max(1, round(crop.width * scale)), max(1, round(crop.height * scale))),
        Image.Resampling.NEAREST,
    )
    output = Image.new("RGBA", cell_size, (0, 0, 0, 0))
    x = (cell_size[0] - resized.width) // 2
    y = (baseline - resized.height) if baseline is not None else (cell_size[1] - resized.height) // 2
    output.alpha_composite(resized, (x, y))
    return quantize_rgba(output)


def metrics(cell: Image.Image) -> dict[str, object]:
    alpha = cell.getchannel("A")
    bounds = alpha.getbbox()
    if bounds is None:
        raise ValueError("registered atlas cell is empty")
    values = list(alpha.get_flattened_data())
    return {
        "alphaBounds": list(bounds),
        "padding": [bounds[0], bounds[1], cell.width - bounds[2], cell.height - bounds[3]],
        "visiblePixels": sum(value > 0 for value in values),
        "alphaLevels": sorted(set(values)),
        "pixelHash": sha256(cell.tobytes()).hexdigest(),
    }


def build_walk() -> list[dict[str, object]]:
    source = remove_green_matte(Image.open(WALK_SOURCE))
    if source.size != (910, 1728):
        raise ValueError(f"unexpected walk source size: {source.size}")
    authored_rows: list[list[Image.Image]] = []
    for row, (top, bottom) in enumerate(WALK_BANDS):
        frames: list[Image.Image] = []
        for column in range(4):
            left, right = proportional_bounds(source.width, column, 4)
            raw = source.crop((left, top, right, bottom))
            associated = component_mask_near_cell_center(raw)
            frames.append(
                fit_cell(
                    associated,
                    WALK_CELL,
                    (232, WALK_TARGET_HEIGHTS[row]),
                    WALK_BASELINE_EXCLUSIVE,
                )
            )
        authored_rows.append(frames)

    # The source contains S through E.  SE is the exact horizontal reflection
    # of SW, matching the runtime's canonical eight-facing table.
    authored_rows.append([
        frame.transpose(Image.Transpose.FLIP_LEFT_RIGHT)
        for frame in authored_rows[1]
    ])
    output = Image.new("RGBA", WALK_OUTPUT_SIZE, (0, 0, 0, 0))
    report: list[dict[str, object]] = []
    for row, frames in enumerate(authored_rows):
        for column, frame in enumerate(frames):
            output.alpha_composite(frame, (column * WALK_CELL[0], row * WALK_CELL[1]))
            report.append({"row": row, "column": column, **metrics(frame)})
    WALK_OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    output.save(WALK_OUTPUT, optimize=True)
    return report


def build_vfx() -> list[dict[str, object]]:
    source = remove_green_matte(Image.open(VFX_SOURCE))
    if source.size != (1774, 887):
        raise ValueError(f"unexpected VFX source size: {source.size}")
    output = Image.new("RGBA", VFX_OUTPUT_SIZE, (0, 0, 0, 0))
    report: list[dict[str, object]] = []
    for row in range(2):
        top, bottom = proportional_bounds(source.height, row, 2)
        for column in range(4):
            left, right = proportional_bounds(source.width, column, 4)
            frame = fit_cell(
                source.crop((left, top, right, bottom)),
                VFX_CELL,
                (472, 472),
            )
            output.alpha_composite(frame, (column * VFX_CELL[0], row * VFX_CELL[1]))
            report.append({"row": row, "column": column, **metrics(frame)})
    VFX_OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    output.save(VFX_OUTPUT, optimize=True)
    return report


def main() -> None:
    walk_frames = build_walk()
    vfx_frames = build_vfx()
    report = {
        "format": "RGBA PNG",
        "rowOrder": list(ROW_ORDER),
        "phaseOrder": ["left-contact", "passing", "right-contact", "return"],
        "walk": {
            "source": str(WALK_SOURCE.relative_to(ROOT)).replace("\\", "/"),
            "sourceSha256": digest(WALK_SOURCE),
            "output": str(WALK_OUTPUT.relative_to(ROOT)).replace("\\", "/"),
            "outputSha256": digest(WALK_OUTPUT),
            "frames": walk_frames,
        },
        "vfx": {
            "source": str(VFX_SOURCE.relative_to(ROOT)).replace("\\", "/"),
            "sourceSha256": digest(VFX_SOURCE),
            "output": str(VFX_OUTPUT.relative_to(ROOT)).replace("\\", "/"),
            "outputSha256": digest(VFX_OUTPUT),
            "frames": vfx_frames,
        },
        "pipeline": {
            "walkMatte": "green-dominance key + centered component association + despill",
            "missingFacing": "south-east is the exact horizontal mirror of south-west",
            "vfxMatte": "green-dominance key + despill; detached fragments retained",
            "paletteSize": len(PALETTE),
            "alphaLevels": list(ALPHA_LEVELS),
            "runtimeResampling": "nearest-neighbour",
        },
    }
    REPORT.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(REPORT)


if __name__ == "__main__":
    main()
