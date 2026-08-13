#!/usr/bin/env python3
"""Normalize the generated Palimpsest Archivist sources into runtime atlases."""

from pathlib import Path
from PIL import Image, ImageChops, ImageFilter


ROOT = Path(__file__).resolve().parents[1]
WALK_SOURCE = ROOT / "asset-sources/palimpsest-archivist/walk-transparent.png"
EFFECT_SOURCE = ROOT / "asset-sources/palimpsest-archivist/patterns-source.png"
WALK_OUTPUT = ROOT / "public/assets/walk/palimpsest-archivist-walk-v1.png"
EFFECT_OUTPUT = ROOT / "public/assets/effects/palimpsest-archivist-patterns-v1.png"


def alpha_bbox(image: Image.Image) -> tuple[int, int, int, int]:
    bbox = image.getchannel("A").getbbox()
    if bbox is None:
        raise ValueError("source cell contains no visible pixels")
    return bbox


def remove_small_islands(image: Image.Image, minimum_area: int = 12) -> Image.Image:
    alpha = image.getchannel("A")
    mask = alpha.point(lambda value: 255 if value > 8 else 0)
    # A small median pass removes isolated chroma crumbs without softening the art.
    cleaned = mask.filter(ImageFilter.MedianFilter(3))
    image.putalpha(ImageChops.multiply(alpha, cleaned))
    return image


def fit_cell(
    source: Image.Image,
    size: tuple[int, int],
    inset: int,
    baseline: int,
    *,
    allow_upscale: bool = True,
) -> Image.Image:
    source = remove_small_islands(source.copy())
    left, top, right, bottom = alpha_bbox(source)
    crop = source.crop((left, top, right, bottom))
    max_width = size[0] - inset * 2
    max_height = baseline - inset
    scale = min(max_width / crop.width, max_height / crop.height)
    if not allow_upscale:
        scale = min(1, scale)
    resized = crop.resize(
        (max(1, round(crop.width * scale)), max(1, round(crop.height * scale))),
        Image.Resampling.LANCZOS,
    )
    cell = Image.new("RGBA", size, (0, 0, 0, 0))
    cell.alpha_composite(
        resized,
        ((size[0] - resized.width) // 2, baseline - resized.height),
    )
    return cell


def build_walk() -> None:
    source = Image.open(WALK_SOURCE).convert("RGBA")
    if source.size != (1024, 1536):
        raise ValueError(f"unexpected walk source size: {source.size}")
    output = Image.new("RGBA", (1024, 1536), (0, 0, 0, 0))
    row_ranges = [
        (0, 188),
        (194, 365),
        (372, 542),
        (550, 734),
        (740, 926),
        (934, 1112),
        (1119, 1299),
        (1307, 1536),
    ]
    row_bounds: list[tuple[int, int, int, int]] = []
    for source_start, source_end in row_ranges:
        band = source.crop((0, source_start, 1024, source_end))
        left, top, right, bottom = alpha_bbox(band)
        row_bounds.append((left, source_start + top, right, source_start + bottom))
    for row in range(8):
        for column in range(4):
            cell_left = column * 256
            cell_right = (column + 1) * 256
            source_left, source_top, source_right, source_bottom = row_bounds[row]
            # The generator keeps all four poses in a clean row, but a few back
            # silhouettes overlap the nominal horizontal guide by a handful of
            # pixels. Crop by row band first and then by each cell's x-range so
            # a neighboring frame can never appear as a black horizontal slice.
            cell = source.crop(
                (
                    max(cell_left, source_left),
                    source_top,
                    min(cell_right, source_right),
                    source_bottom,
                )
            )
            cell = cell.resize((cell.width, round(cell.height * 0.84)), Image.Resampling.LANCZOS)
            output.alpha_composite(
                fit_cell(cell, (256, 192), 14, 185, allow_upscale=False),
                (column * 256, row * 192),
            )
    WALK_OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    output.save(WALK_OUTPUT, optimize=True)


def build_effects() -> None:
    source = Image.open(EFFECT_SOURCE).convert("RGBA")
    source_width, source_height = source.size
    output = Image.new("RGBA", (2048, 1024), (0, 0, 0, 0))
    for row in range(2):
        for column in range(4):
            left = round(column * source_width / 4)
            right = round((column + 1) * source_width / 4)
            top = round(row * source_height / 2)
            bottom = round((row + 1) * source_height / 2)
            cell = source.crop((left, top, right, bottom))
            output.alpha_composite(fit_cell(cell, (512, 512), 42, 470), (column * 512, row * 512))
    EFFECT_OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    output.save(EFFECT_OUTPUT, optimize=True)


if __name__ == "__main__":
    build_walk()
    build_effects()
    print(WALK_OUTPUT)
    print(EFFECT_OUTPUT)
