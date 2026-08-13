from __future__ import annotations

import hashlib
import json
from collections import Counter, deque
from pathlib import Path

import numpy as np
from PIL import Image


ROOT = Path(__file__).resolve().parents[1]
SOURCE_ROOT = ROOT / "asset-sources" / "legacy-arpg" / "loot-drop-v6"
OUTPUT_ROOT = ROOT / "public" / "assets" / "effects"
MANIFEST_PATH = OUTPUT_ROOT / "loot-ground-v1.build.json"

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

SOURCE_COLUMNS = 4
SOURCE_ROWS = 3
OUTPUT_COLUMNS = 4
LOGICAL_CELL = 128
OUTPUT_SCALE = 2
OUTPUT_CELL = LOGICAL_CELL * OUTPUT_SCALE
CONTENT_LIMIT = 108
CONTENT_BOTTOM = 119
MIN_LOGICAL_GUTTER = 8
ALPHA_LEVELS = np.array([0, 64, 128, 192, 255], dtype=np.uint8)
PALETTE_COLORS = 60


def erase_border_touching_foreground(alpha: np.ndarray) -> np.ndarray:
    """Drop prior-row fragments that enter a source cell through its top edge."""
    visible = alpha >= 8
    # Bottom/side edge contact can be authored ground debris. Only remove
    # components whose connection is specifically through the top seam.
    top_seeds = np.zeros_like(visible)
    top_seeds[0, :] = visible[0, :]
    top_connected = flood_from_seeds(visible, top_seeds)
    cleaned = alpha.copy()
    cleaned[top_connected] = 0
    return cleaned


def erase_top_seam_islands(alpha: np.ndarray) -> np.ndarray:
    """Remove disconnected residue inherited from the row above the source cell."""
    visible = alpha >= 8
    height, width = visible.shape
    visited = np.zeros_like(visible, dtype=bool)
    cleaned = alpha.copy()
    cutoff = round(height * 0.09)
    for start_y, start_x in zip(*np.where(visible), strict=True):
        if visited[start_y, start_x]:
            continue
        queue = [(int(start_y), int(start_x))]
        visited[start_y, start_x] = True
        component: list[tuple[int, int]] = []
        maximum_y = int(start_y)
        while queue:
            y, x = queue.pop()
            component.append((y, x))
            maximum_y = max(maximum_y, y)
            for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                next_y, next_x = y + dy, x + dx
                if (
                    0 <= next_y < height
                    and 0 <= next_x < width
                    and visible[next_y, next_x]
                    and not visited[next_y, next_x]
                ):
                    visited[next_y, next_x] = True
                    queue.append((next_y, next_x))
        if maximum_y <= cutoff:
            for y, x in component:
                cleaned[y, x] = 0
    return cleaned


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def bottom_cells(image: Image.Image) -> list[Image.Image]:
    x_edges = [round(index * image.width / SOURCE_COLUMNS) for index in range(SOURCE_COLUMNS + 1)]
    y_edges = [round(index * image.height / SOURCE_ROWS) for index in range(SOURCE_ROWS + 1)]
    row = SOURCE_ROWS - 1
    return [
        image.crop((x_edges[column], y_edges[row], x_edges[column + 1], y_edges[row + 1]))
        for column in range(SOURCE_COLUMNS)
    ]


def dominant_border_key(rgb: np.ndarray) -> np.ndarray:
    strip = max(2, min(rgb.shape[:2]) // 80)
    border = np.concatenate(
        (
            rgb[:strip, :, :].reshape(-1, 3),
            rgb[-strip:, :, :].reshape(-1, 3),
            rgb[:, :strip, :].reshape(-1, 3),
            rgb[:, -strip:, :].reshape(-1, 3),
        ),
        axis=0,
    )
    bins = border // 8
    packed = (
        bins[:, 0].astype(np.int32) * 1024
        + bins[:, 1].astype(np.int32) * 32
        + bins[:, 2].astype(np.int32)
    )
    dominant = Counter(packed.tolist()).most_common(1)[0][0]
    return np.median(border[packed == dominant], axis=0).astype(np.float32)


def flood_from_border(candidate: np.ndarray) -> np.ndarray:
    height, width = candidate.shape
    connected = np.zeros_like(candidate, dtype=bool)
    queue: deque[tuple[int, int]] = deque()
    for x in range(width):
        if candidate[0, x]:
            queue.append((0, x))
        if candidate[height - 1, x]:
            queue.append((height - 1, x))
    for y in range(height):
        if candidate[y, 0]:
            queue.append((y, 0))
        if candidate[y, width - 1]:
            queue.append((y, width - 1))

    while queue:
        y, x = queue.popleft()
        if connected[y, x] or not candidate[y, x]:
            continue
        connected[y, x] = True
        if y:
            queue.append((y - 1, x))
        if y + 1 < height:
            queue.append((y + 1, x))
        if x:
            queue.append((y, x - 1))
        if x + 1 < width:
            queue.append((y, x + 1))
    return connected


def flood_from_seeds(candidate: np.ndarray, seeds: np.ndarray) -> np.ndarray:
    height, width = candidate.shape
    connected = np.zeros_like(candidate, dtype=bool)
    queue: deque[tuple[int, int]] = deque(
        (int(y), int(x)) for y, x in zip(*np.where(seeds), strict=True)
    )
    while queue:
        y, x = queue.popleft()
        if connected[y, x] or not candidate[y, x]:
            continue
        connected[y, x] = True
        if y:
            queue.append((y - 1, x))
        if y + 1 < height:
            queue.append((y + 1, x))
        if x:
            queue.append((y, x - 1))
        if x + 1 < width:
            queue.append((y, x + 1))
    return connected


def remove_background(cell: Image.Image) -> tuple[Image.Image, dict[str, object]]:
    rgba = np.asarray(cell.convert("RGBA"), dtype=np.uint8).copy()
    alpha = rgba[:, :, 3]
    transparent_fraction = float(np.count_nonzero(alpha < 16) / alpha.size)

    if transparent_fraction >= 0.08:
        connected = flood_from_border(alpha <= 16)
        alpha[connected] = 0
        alpha[alpha < 8] = 0
        rgba[:, :, 3] = alpha
        mode = "border-connected-alpha"
        key = None
    else:
        rgb = rgba[:, :, :3].astype(np.float32)
        key_value = dominant_border_key(rgba[:, :, :3])
        distance = np.linalg.norm(rgb - key_value[None, None, :], axis=2)
        connected = flood_from_border(distance <= 78.0)
        keyed_alpha = np.clip((distance - 42.0) * (255.0 / 82.0), 0, 255)
        keyed_alpha[connected] = 0
        keyed_alpha[distance <= 34.0] = 0
        rgba[:, :, 3] = keyed_alpha.astype(np.uint8)
        mode = "border-connected-chroma"
        key = [int(round(value)) for value in key_value.tolist()]

        # Remove blue/green spill remaining on antialiased foreground edges.
        red = rgba[:, :, 0].astype(np.int16)
        green = rgba[:, :, 1].astype(np.int16)
        blue = rgba[:, :, 2].astype(np.int16)
        key_blue = key_value[2] > key_value[1] * 1.35
        if key_blue:
            spill = np.maximum(0, blue - np.maximum(red, green))
            rgba[:, :, 2] = np.maximum(np.maximum(red, green), blue - spill).astype(np.uint8)
        else:
            spill = np.maximum(0, green - np.maximum(red, blue))
            rgba[:, :, 1] = np.maximum(np.maximum(red, blue), green - spill).astype(np.uint8)

    rgba[:, :, 3] = erase_top_seam_islands(
        erase_border_touching_foreground(rgba[:, :, 3])
    )

    return Image.fromarray(rgba, mode="RGBA"), {
        "backgroundMode": mode,
        "keyRgb": key,
        "sourceTransparentFraction": round(transparent_fraction, 6),
    }


def alpha_bbox(image: Image.Image, threshold: int = 8) -> tuple[int, int, int, int] | None:
    return image.getchannel("A").point(lambda value: 255 if value >= threshold else 0).getbbox()


def normalize_fixed_scale(cells: list[Image.Image]) -> list[Image.Image]:
    bboxes = [alpha_bbox(cell) for cell in cells]
    if any(bbox is None for bbox in bboxes):
        raise ValueError(f"empty source cells: {[i for i, bbox in enumerate(bboxes) if bbox is None]}")
    concrete = [bbox for bbox in bboxes if bbox is not None]
    maximum_width = max(bbox[2] - bbox[0] for bbox in concrete)
    maximum_height = max(bbox[3] - bbox[1] for bbox in concrete)
    scale = min(CONTENT_LIMIT / maximum_width, CONTENT_LIMIT / maximum_height)

    frames: list[Image.Image] = []
    for cell, bbox in zip(cells, concrete, strict=True):
        cropped = cell.crop(bbox).convert("RGBa")
        size = (max(1, round(cropped.width * scale)), max(1, round(cropped.height * scale)))
        resized = cropped.resize(size, Image.Resampling.LANCZOS).convert("RGBA")
        frame = Image.new("RGBA", (LOGICAL_CELL, LOGICAL_CELL), (0, 0, 0, 0))
        x = (LOGICAL_CELL - resized.width) // 2
        y = CONTENT_BOTTOM - resized.height
        if min(x, y, LOGICAL_CELL - x - resized.width, LOGICAL_CELL - y - resized.height) < MIN_LOGICAL_GUTTER:
            raise ValueError(f"fixed transform violates safe gutter: {(x, y, *resized.size)}")
        frame.alpha_composite(resized, (x, y))
        frames.append(frame)
    return frames


def build_atlas(frames: list[Image.Image]) -> Image.Image:
    logical = Image.new("RGBA", (LOGICAL_CELL * OUTPUT_COLUMNS, LOGICAL_CELL), (0, 0, 0, 0))
    for column, frame in enumerate(frames):
        logical.alpha_composite(frame, (column * LOGICAL_CELL, 0))

    rgba = np.asarray(logical, dtype=np.uint8).copy()
    source_alpha = rgba[:, :, 3].astype(np.int16)
    distances = np.abs(source_alpha[:, :, None] - ALPHA_LEVELS.astype(np.int16)[None, None, :])
    alpha = ALPHA_LEVELS[np.argmin(distances, axis=2)]
    rgba[alpha == 0, :3] = 0
    quantized = Image.fromarray(rgba[:, :, :3], mode="RGB").quantize(
        colors=PALETTE_COLORS,
        method=Image.Quantize.MEDIANCUT,
        dither=Image.Dither.FLOYDSTEINBERG,
    ).convert("RGBA")
    quantized.putalpha(Image.fromarray(alpha, mode="L"))
    return quantized.resize(
        (logical.width * OUTPUT_SCALE, logical.height * OUTPUT_SCALE),
        Image.Resampling.NEAREST,
    )


def validate_output(
    path: Path,
    backgrounds: list[dict[str, object]],
) -> dict[str, object]:
    atlas = Image.open(path).convert("RGBA")
    if atlas.size != (OUTPUT_CELL * OUTPUT_COLUMNS, OUTPUT_CELL):
        raise ValueError(f"{path.name}: invalid dimensions {atlas.size}")
    rgba = np.asarray(atlas, dtype=np.uint8)
    alpha_levels = sorted(np.unique(rgba[:, :, 3]).tolist())
    if any(level not in ALPHA_LEVELS.tolist() for level in alpha_levels):
        raise ValueError(f"{path.name}: invalid alpha levels {alpha_levels}")
    visible = rgba[:, :, 3] > 0
    colors = len({tuple(color) for color in rgba[:, :, :3][visible].tolist()})
    if colors > PALETTE_COLORS:
        raise ValueError(f"{path.name}: palette contains {colors} colors")

    cells: list[dict[str, object]] = []
    hashes: list[str] = []
    chroma_residual = 0
    for column in range(OUTPUT_COLUMNS):
        cell_image = atlas.crop((column * OUTPUT_CELL, 0, (column + 1) * OUTPUT_CELL, OUTPUT_CELL))
        bbox = alpha_bbox(cell_image, threshold=64)
        if bbox is None:
            raise ValueError(f"{path.name}: cell {column} is empty")
        left, top, right, bottom = bbox
        gutters = [left, top, OUTPUT_CELL - right, OUTPUT_CELL - bottom]
        if min(gutters) < MIN_LOGICAL_GUTTER * OUTPUT_SCALE:
            raise ValueError(f"{path.name}: cell {column} gutter failure {gutters}")
        cell = rgba[:, column * OUTPUT_CELL : (column + 1) * OUTPUT_CELL, :]
        hashes.append(hashlib.sha256(cell.tobytes()).hexdigest())
        key = backgrounds[column]["keyRgb"]
        if key is not None:
            key_distance = np.linalg.norm(
                cell[:, :, :3].astype(np.float32) - np.asarray(key, dtype=np.float32), axis=2
            )
            chroma_residual += int(np.count_nonzero((cell[:, :, 3] > 0) & (key_distance <= 34.0)))
        cells.append(
            {
                "index": column,
                "bbox": list(bbox),
                "gutters": {
                    "left": gutters[0],
                    "top": gutters[1],
                    "right": gutters[2],
                    "bottom": gutters[3],
                },
                "visiblePixels": int(np.count_nonzero(cell[:, :, 3] >= 64)),
            }
        )
    if len(set(hashes)) != OUTPUT_COLUMNS:
        raise ValueError(f"{path.name}: all four loop frames must differ")
    if chroma_residual:
        raise ValueError(f"{path.name}: {chroma_residual} chroma pixels remain")
    if path.stat().st_size > 650_000:
        raise ValueError(f"{path.name}: exceeds 650 KB decode budget")
    return {
        "width": atlas.width,
        "height": atlas.height,
        "bytes": path.stat().st_size,
        "sha256": sha256(path),
        "alphaLevels": alpha_levels,
        "visiblePaletteColors": colors,
        "chromaResidualPixels": chroma_residual,
        "cells": cells,
    }


def build_rarity(rarity: str) -> dict[str, object]:
    source_path = SOURCE_ROOT / f"{rarity}-source.png"
    output_path = OUTPUT_ROOT / f"loot-ground-{rarity}-v1.png"
    source = Image.open(source_path).convert("RGBA")
    cleaned: list[Image.Image] = []
    backgrounds: list[dict[str, object]] = []
    for cell in bottom_cells(source):
        cutout, metadata = remove_background(cell)
        cleaned.append(cutout)
        backgrounds.append(metadata)
    frames = normalize_fixed_scale(cleaned)
    atlas = build_atlas(frames)
    OUTPUT_ROOT.mkdir(parents=True, exist_ok=True)
    atlas.save(output_path, format="PNG", optimize=True)
    return {
        "source": source_path.relative_to(ROOT).as_posix(),
        "sourceSha256": sha256(source_path),
        "sourceWidth": source.width,
        "sourceHeight": source.height,
        "sourceRowsUsed": [2],
        "output": output_path.relative_to(ROOT).as_posix(),
        "background": backgrounds,
        **validate_output(output_path, backgrounds),
    }


def main() -> None:
    manifest: dict[str, object] = {
        "version": 1,
        "builder": "scripts/build_legacy_loot_ground_assets.py",
        "layout": {
            "columns": OUTPUT_COLUMNS,
            "rows": 1,
            "frames": 4,
            "logicalCellSize": LOGICAL_CELL,
            "outputCellSize": OUTPUT_CELL,
            "width": OUTPUT_CELL * OUTPUT_COLUMNS,
            "height": OUTPUT_CELL,
        },
        "pipeline": {
            "sourceSelection": "bottom row only; persistent ground-loop frames",
            "backgroundRemoval": "per-cell border-connected alpha or chroma segmentation",
            "logicalResize": "fixed scale per rarity at 128px cell resolution",
            "outputResize": "nearest-neighbor 2x",
            "alphaLevels": ALPHA_LEVELS.tolist(),
            "maximumVisiblePaletteColors": PALETTE_COLORS,
            "minimumOutputGutterPixels": MIN_LOGICAL_GUTTER * OUTPUT_SCALE,
        },
        "rarities": {},
    }
    rarities = manifest["rarities"]
    assert isinstance(rarities, dict)
    for rarity in RARITIES:
        result = build_rarity(rarity)
        rarities[rarity] = result
        print(
            f"{rarity:10s} {result['width']}x{result['height']} "
            f"{result['bytes']:,} bytes, {result['visiblePaletteColors']} colors"
        )
    MANIFEST_PATH.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(MANIFEST_PATH.relative_to(ROOT).as_posix())


if __name__ == "__main__":
    main()
