"""Register an ImageGen walk sheet into Mujindo's canonical 4x8 atlas.

The generator sometimes spaces rows unevenly even when the canvas dimensions
are correct.  This tool discovers eight opaque row bands first, extracts all
32 complete figures, then fits them into 256x192 cells without slicing limbs
at a nominal row boundary.
"""

from __future__ import annotations

import argparse
from pathlib import Path

from PIL import Image


CANVAS_SIZE = (1024, 1536)
CELL_WIDTH = 256
CELL_HEIGHT = 192
ROW_COUNT = 8
COLUMN_COUNT = 4
GROUND_BASELINE = 184
TOP_GUTTER = 6
SIDE_GUTTER = 8
MAX_ART_HEIGHT = GROUND_BASELINE - TOP_GUTTER
MAX_ART_WIDTH = CELL_WIDTH - SIDE_GUTTER * 2


def occupied_row_bands(alpha: Image.Image) -> list[tuple[int, int]]:
    pixels = alpha.load()
    active: list[bool] = []
    for y in range(alpha.height):
        occupied = sum(1 for x in range(alpha.width) if pixels[x, y] > 20)
        active.append(occupied > 5)

    bands: list[tuple[int, int]] = []
    start: int | None = None
    for y, is_active in enumerate([*active, False]):
        if is_active and start is None:
            start = y
        elif not is_active and start is not None:
            bands.append((start, y))
            start = None
    return bands


def prune_tiny_islands(image: Image.Image, maximum_area: int = 11) -> int:
    alpha = image.getchannel("A")
    pixels = alpha.load()
    seen: set[tuple[int, int]] = set()
    removed = 0

    for y in range(image.height):
        for x in range(image.width):
            if (x, y) in seen or pixels[x, y] <= 4:
                continue
            stack = [(x, y)]
            seen.add((x, y))
            component: list[tuple[int, int]] = []
            while stack:
                current_x, current_y = stack.pop()
                component.append((current_x, current_y))
                for offset_y in (-1, 0, 1):
                    for offset_x in (-1, 0, 1):
                        if offset_x == 0 and offset_y == 0:
                            continue
                        next_x = current_x + offset_x
                        next_y = current_y + offset_y
                        point = (next_x, next_y)
                        if (
                            0 <= next_x < image.width
                            and 0 <= next_y < image.height
                            and point not in seen
                            and pixels[next_x, next_y] > 4
                        ):
                            seen.add(point)
                            stack.append(point)
            if len(component) <= maximum_area:
                for component_x, component_y in component:
                    image.putpixel((component_x, component_y), (0, 0, 0, 0))
                    removed += 1
    return removed


def register(
    source_path: Path,
    output_path: Path,
    synthesize_west_from_east: bool = False,
) -> None:
    source = Image.open(source_path).convert("RGBA")
    if source.size != CANVAS_SIZE:
        source = source.resize(CANVAS_SIZE, Image.Resampling.LANCZOS)

    bands = occupied_row_bands(source.getchannel("A"))
    if len(bands) == 7 and synthesize_west_from_east:
        # ImageGen occasionally omits the pure-west row while preserving the
        # other seven authored directions in S,SE,E,NW,N,NE,SW order.  A
        # horizontal flip of the complete east pose is geometrically exact,
        # keeps all four gait phases, and is safer than accepting a malformed
        # seven-row sheet.  The synthesized row is inserted before SW so the
        # canonical output remains S,SE,E,NW,N,NE,W,SW.
        row_sources: list[tuple[tuple[int, int], bool]] = [
            *((band, False) for band in bands[:6]),
            (bands[2], True),
            (bands[6], False),
        ]
    elif len(bands) == ROW_COUNT:
        row_sources = [(band, False) for band in bands]
    else:
        raise ValueError(
            f"Expected exactly {ROW_COUNT} separated direction rows; found "
            f"{len(bands)}: {bands}. Reject and regenerate this source."
        )

    output = Image.new("RGBA", CANVAS_SIZE, (0, 0, 0, 0))
    for row, ((band_start, band_end), flip_horizontal) in enumerate(row_sources):
        source_y = max(0, band_start - 3)
        source_bottom = min(CANVAS_SIZE[1], band_end + 3)
        for column in range(COLUMN_COUNT):
            source_x = column * CELL_WIDTH
            region = source.crop(
                (source_x, source_y, source_x + CELL_WIDTH, source_bottom)
            )
            if flip_horizontal:
                region = region.transpose(Image.Transpose.FLIP_LEFT_RIGHT)
            bounds = region.getchannel("A").getbbox()
            if bounds is None:
                raise ValueError(f"Empty generated frame at row {row}, column {column}")

            art = region.crop(bounds)
            scale = min(
                1.0,
                MAX_ART_HEIGHT / art.height,
                MAX_ART_WIDTH / art.width,
            )
            if scale < 0.9999:
                art = art.resize(
                    (
                        max(1, round(art.width * scale)),
                        max(1, round(art.height * scale)),
                    ),
                    Image.Resampling.LANCZOS,
                )

            authored_center = (bounds[0] + bounds[2]) / 2
            target_x = round(authored_center - art.width / 2)
            target_x = max(
                SIDE_GUTTER,
                min(CELL_WIDTH - SIDE_GUTTER - art.width, target_x),
            )
            target_y = GROUND_BASELINE - art.height
            cell = Image.new("RGBA", (CELL_WIDTH, CELL_HEIGHT), (0, 0, 0, 0))
            cell.alpha_composite(art, (target_x, target_y))
            prune_tiny_islands(cell)

            final_bounds = cell.getchannel("A").getbbox()
            if final_bounds is None or final_bounds[3] != GROUND_BASELINE:
                raise ValueError(
                    f"Frame {row},{column} missed baseline: {final_bounds}"
                )
            if (
                final_bounds[0] < SIDE_GUTTER
                or final_bounds[2] > CELL_WIDTH - SIDE_GUTTER
                or final_bounds[1] < TOP_GUTTER
            ):
                raise ValueError(f"Frame {row},{column} violates gutter: {final_bounds}")
            output.alpha_composite(cell, (source_x, row * CELL_HEIGHT))

    # Chroma removal can leave nearly transparent green specks.  Opaque green
    # is never erased because jade/cosmic equipment may legitimately use it.
    output_pixels = output.load()
    for y in range(output.height):
        for x in range(output.width):
            red, green, blue, alpha = output_pixels[x, y]
            if (
                alpha <= 16
                and green > 180
                and green > red * 1.8
                and green > blue * 1.8
            ):
                output_pixels[x, y] = (0, 0, 0, 0)

    output_path.parent.mkdir(parents=True, exist_ok=True)
    output.save(output_path, optimize=True)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("input", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument(
        "--synthesize-west-from-east",
        action="store_true",
        help="accept S,SE,E,NW,N,NE,SW and insert a mirrored E row as W",
    )
    args = parser.parse_args()
    register(
        args.input,
        args.output,
        synthesize_west_from_east=args.synthesize_west_from_east,
    )
    print(f"registered 32 frames: {args.output}")


if __name__ == "__main__":
    main()
