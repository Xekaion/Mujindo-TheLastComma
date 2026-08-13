#!/usr/bin/env python3
"""Register the generated Inkbound Magistrate into legacy ARPG atlases.

The walk source has a smooth brown generation matte instead of a flat key.
Each cell is therefore segmented with a border-safe local-edge flood,
cleaned to its central connected silhouette, palette-reduced and registered to
the same 256x192 baseline used by every authored eight-direction enemy.
The attack source uses a removable cobalt key and becomes eight 512x512 cells.
"""

from __future__ import annotations

from collections import deque
from hashlib import sha256
import json
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter


ROOT = Path(__file__).resolve().parents[1]
SOURCE_ROOT = ROOT / "asset-sources/legacy-arpg"
WALK_SOURCE = SOURCE_ROOT / "inkbound-magistrate-walk-source-v1.png"
VFX_SOURCE = SOURCE_ROOT / "inkbound-magistrate-vfx-source-v1.png"
WALK_OUTPUT = ROOT / "public/assets/walk/inkbound-magistrate-walk-v1.png"
VFX_OUTPUT = ROOT / "public/assets/effects/inkbound-magistrate-patterns-v1.png"
REPORT = ROOT / "public/assets/effects/inkbound-magistrate-v1.build.json"

WALK_CELL = (256, 192)
WALK_SIZE = (1024, 1536)
VFX_SOURCE_CELL = (384, 512)
VFX_CELL = (512, 512)
VFX_OUTPUT_SIZE = (2048, 1024)
WALK_BASELINE_EXCLUSIVE = 185
WALK_TARGET_HEIGHTS = (176, 173, 170, 176, 178, 176, 170, 173)
ALPHA_LEVELS = (0, 72, 128, 192, 255)

PALETTE = (
    (3, 3, 4), (7, 6, 6), (12, 10, 9), (18, 15, 13),
    (25, 20, 17), (34, 27, 22), (45, 35, 27), (58, 44, 32),
    (72, 54, 38), (89, 66, 43), (108, 80, 48), (130, 98, 57),
    (153, 119, 71), (178, 145, 94), (205, 176, 126), (231, 211, 170),
    (30, 8, 9), (49, 11, 12), (71, 15, 16), (96, 21, 20),
    (124, 30, 25), (154, 44, 31), (188, 65, 40), (222, 99, 57),
    (22, 20, 20), (37, 34, 32), (56, 51, 47), (80, 72, 64),
    (109, 97, 84), (142, 127, 106), (178, 160, 133), (212, 195, 164),
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


def connected_silhouette(mask: np.ndarray) -> np.ndarray:
    """Keep the actor and its immediately attached equipment, never cell seams."""
    height, width = mask.shape
    cleaned = mask.copy()
    # Generated atlas cells have faint separator seams. They are not part of a
    # sprite and must never be allowed to become a closed flood-fill contour.
    cleaned[:4, :] = False
    cleaned[-4:, :] = False
    cleaned[:, :4] = False
    cleaned[:, -4:] = False

    visited = np.zeros_like(cleaned, dtype=bool)
    components: list[list[tuple[int, int]]] = []
    for seed_y, seed_x in zip(*np.nonzero(cleaned)):
        if visited[seed_y, seed_x]:
            continue
        pixels: list[tuple[int, int]] = []
        queue: deque[tuple[int, int]] = deque([(int(seed_x), int(seed_y))])
        visited[seed_y, seed_x] = True
        while queue:
            x, y = queue.popleft()
            pixels.append((x, y))
            for next_x, next_y in (
                (x - 1, y - 1), (x, y - 1), (x + 1, y - 1),
                (x - 1, y),                 (x + 1, y),
                (x - 1, y + 1), (x, y + 1), (x + 1, y + 1),
            ):
                if (
                    0 <= next_x < width and 0 <= next_y < height
                    and cleaned[next_y, next_x]
                    and not visited[next_y, next_x]
                ):
                    visited[next_y, next_x] = True
                    queue.append((next_x, next_y))
        components.append(pixels)

    if not components:
        return cleaned

    # The complete armoured boss silhouette is the dominant closed component.
    # Retaining only it also rejects the long, thin residual frame borders and
    # isolated brown-gradient islands without eating the chained slab or blade.
    primary = max(components, key=len)
    result = np.zeros_like(cleaned, dtype=bool)
    for x, y in primary:
        result[y, x] = True
    return result


def remove_brown_matte(cell: Image.Image) -> Image.Image:
    rgb = np.asarray(cell.convert("RGB"), dtype=np.int16)
    height, width, _ = rgb.shape
    # A smooth generated background has almost no local edge energy. Build an
    # edge barrier, then flood only the background reachable from the four cell
    # borders. The closed character contour remains inside even where black
    # armour happens to share the backdrop's luminance.
    edge_strength = np.zeros((height, width), dtype=np.float64)

    def register_edges(delta: np.ndarray, first: tuple[slice, slice], second: tuple[slice, slice]) -> None:
        edge_strength[first] = np.maximum(edge_strength[first], delta)
        edge_strength[second] = np.maximum(edge_strength[second], delta)

    # Compare only true neighbours. np.roll would wrap opposite cell edges
    # together and manufacture the rectangular outlines this pipeline removes.
    register_edges(np.linalg.norm(rgb[:, 1:] - rgb[:, :-1], axis=2),
                   (slice(None), slice(1, None)), (slice(None), slice(None, -1)))
    register_edges(np.linalg.norm(rgb[1:, :] - rgb[:-1, :], axis=2),
                   (slice(1, None), slice(None)), (slice(None, -1), slice(None)))
    register_edges(np.linalg.norm(rgb[1:, 1:] - rgb[:-1, :-1], axis=2),
                   (slice(1, None), slice(1, None)), (slice(None, -1), slice(None, -1)))
    register_edges(np.linalg.norm(rgb[1:, :-1] - rgb[:-1, 1:], axis=2),
                   (slice(1, None), slice(None, -1)), (slice(None, -1), slice(1, None)))
    barrier = np.asarray(
        Image.fromarray(np.where(edge_strength >= 14, 255, 0).astype(np.uint8), mode="L")
        .filter(ImageFilter.MaxFilter(3)),
    ) > 0
    background = np.zeros((height, width), dtype=bool)
    queue: deque[tuple[int, int]] = deque()
    for x in range(width):
        for y in (0, height - 1):
            if not barrier[y, x] and not background[y, x]:
                background[y, x] = True
                queue.append((x, y))
    for y in range(height):
        for x in (0, width - 1):
            if not barrier[y, x] and not background[y, x]:
                background[y, x] = True
                queue.append((x, y))
    while queue:
        x, y = queue.popleft()
        for next_x, next_y in ((x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)):
            if (
                0 <= next_x < width and 0 <= next_y < height
                and not barrier[next_y, next_x]
                and not background[next_y, next_x]
            ):
                background[next_y, next_x] = True
                queue.append((next_x, next_y))
    foreground = connected_silhouette(~background).astype(np.uint8) * 255
    alpha = Image.fromarray(foreground, mode="L").filter(ImageFilter.MaxFilter(3))
    alpha = alpha.point(nearest_alpha)
    result = cell.convert("RGBA")
    result.putalpha(alpha)
    # The source's warm matte bleeds into two or three antialiased contour
    # pixels. Contracting once removes that halo; nearest-neighbour registration
    # then restores a crisp, deliberately pixelated outline.
    result.putalpha(result.getchannel("A").filter(ImageFilter.MinFilter(3)))
    return result


def fit_walk_cell(source: Image.Image, target_height: int) -> Image.Image:
    bounds = source.getchannel("A").getbbox()
    if bounds is None:
        raise ValueError("walk cell became empty")
    crop = source.crop(bounds)
    scale = min(target_height / crop.height, 226 / crop.width)
    resized = crop.resize(
        (max(1, round(crop.width * scale)), max(1, round(crop.height * scale))),
        Image.Resampling.NEAREST,
    )
    output = Image.new("RGBA", WALK_CELL, (0, 0, 0, 0))
    output.alpha_composite(
        resized,
        ((WALK_CELL[0] - resized.width) // 2, WALK_BASELINE_EXCLUSIVE - resized.height),
    )
    return quantize_rgba(output)


def remove_blue_matte(source: Image.Image) -> Image.Image:
    output: list[tuple[int, int, int, int]] = []
    for red, green, blue in source.convert("RGB").get_flattened_data():
        distance = ((red - 0) ** 2 + (green - 2) ** 2 + (blue - 253) ** 2) ** 0.5
        alpha = 0 if distance <= 20 else 255 if distance >= 76 else nearest_alpha(round((distance - 20) / 56 * 255))
        if alpha == 0:
            output.append((0, 0, 0, 0))
        else:
            if alpha < 255:
                blue = min(blue, round(max(red, green) * 1.25 + 9))
            output.append((red, green, blue, alpha))
    result = Image.new("RGBA", source.size)
    result.putdata(output)
    return result


def fit_vfx_cell(source: Image.Image) -> Image.Image:
    bounds = source.getchannel("A").getbbox()
    if bounds is None:
        raise ValueError("VFX cell became empty")
    crop = source.crop(bounds)
    scale = min(472 / crop.width, 472 / crop.height)
    resized = crop.resize(
        (max(1, round(crop.width * scale)), max(1, round(crop.height * scale))),
        Image.Resampling.NEAREST,
    )
    output = Image.new("RGBA", VFX_CELL, (0, 0, 0, 0))
    output.alpha_composite(
        resized,
        ((VFX_CELL[0] - resized.width) // 2, (VFX_CELL[1] - resized.height) // 2),
    )
    low = output.resize((256, 256), Image.Resampling.NEAREST)
    return quantize_rgba(low.resize(VFX_CELL, Image.Resampling.NEAREST))


def metrics(cell: Image.Image) -> dict[str, object]:
    alpha = cell.getchannel("A")
    bounds = alpha.getbbox()
    if bounds is None:
        raise ValueError("registered cell is empty")
    return {
        "alphaBounds": list(bounds),
        "padding": [bounds[0], bounds[1], cell.width - bounds[2], cell.height - bounds[3]],
        "visiblePixels": sum(value > 0 for value in alpha.get_flattened_data()),
        "alphaLevels": sorted(set(alpha.get_flattened_data())),
        "pixelHash": sha256(cell.tobytes()).hexdigest(),
    }


def build_walk() -> list[dict[str, object]]:
    source = Image.open(WALK_SOURCE).convert("RGBA")
    if source.size != WALK_SIZE:
        raise ValueError(f"unexpected walk source size: {source.size}")
    output = Image.new("RGBA", WALK_SIZE, (0, 0, 0, 0))
    frames: list[dict[str, object]] = []
    for row in range(8):
        for column in range(4):
            box = (column * 256, row * 192, (column + 1) * 256, (row + 1) * 192)
            frame = fit_walk_cell(remove_brown_matte(source.crop(box)), WALK_TARGET_HEIGHTS[row])
            output.alpha_composite(frame, box[:2])
            frames.append({"row": row, "column": column, **metrics(frame)})
    WALK_OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    output.save(WALK_OUTPUT, optimize=True)
    return frames


def build_vfx() -> list[dict[str, object]]:
    source = Image.open(VFX_SOURCE).convert("RGB")
    if source.size != (1536, 1024):
        raise ValueError(f"unexpected VFX source size: {source.size}")
    keyed = remove_blue_matte(source)
    output = Image.new("RGBA", VFX_OUTPUT_SIZE, (0, 0, 0, 0))
    frames: list[dict[str, object]] = []
    for row in range(2):
        for column in range(4):
            source_box = (
                column * VFX_SOURCE_CELL[0], row * VFX_SOURCE_CELL[1],
                (column + 1) * VFX_SOURCE_CELL[0], (row + 1) * VFX_SOURCE_CELL[1],
            )
            frame = fit_vfx_cell(keyed.crop(source_box))
            output.alpha_composite(frame, (column * 512, row * 512))
            frames.append({"row": row, "column": column, **metrics(frame)})
    VFX_OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    output.save(VFX_OUTPUT, optimize=True)
    return frames


def main() -> None:
    walk_frames = build_walk()
    vfx_frames = build_vfx()
    report = {
        "format": "RGBA PNG",
        "rowOrder": ["south", "south-east", "east", "north-west", "north", "north-east", "west", "south-west"],
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
            "walkMatte": "non-wrapping local-edge barrier + border-connected background flood + dominant silhouette",
            "vfxMatte": "cobalt distance key + despill",
            "paletteSize": len(PALETTE),
            "alphaLevels": list(ALPHA_LEVELS),
            "runtimeResampling": "nearest-neighbour",
        },
    }
    REPORT.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(REPORT)


if __name__ == "__main__":
    main()
