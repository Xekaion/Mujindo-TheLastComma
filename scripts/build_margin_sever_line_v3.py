"""Build the Margin Severer's eight-stage, aspect-safe sever-line atlas.

The ImageGen source is a 2 x 4 storyboard on a removable magenta background.
Every frame is cropped independently, registered to the same centerline, and
fitted into a wide output cell without changing its authored aspect ratio.
"""

from __future__ import annotations

from hashlib import sha256
import json
from pathlib import Path

from PIL import Image


ROOT = Path(__file__).resolve().parents[1]
ORIGINAL_SOURCE = ROOT / "asset-sources/imagegen/margin-sever-line-storyboard-v3-source.png"
KEYED_SOURCE = ROOT / "asset-sources/imagegen/margin-sever-line-storyboard-v3-keyed.png"
PROMPT_METADATA = ROOT / "asset-sources/imagegen/margin-sever-line-storyboard-v3.prompt.json"
OUTPUT = ROOT / "public/assets/effects/margin-sever-line-v3.png"
REPORT = ROOT / "public/assets/effects/margin-sever-line-v3.build.json"

SOURCE_COLUMNS = 2
SOURCE_ROWS = 4
OUTPUT_CELL = (768, 160)
OUTPUT_SIZE = (OUTPUT_CELL[0] * SOURCE_COLUMNS, OUTPUT_CELL[1] * SOURCE_ROWS)
HORIZONTAL_PADDING = 20
VERTICAL_PADDING = 12
ALPHA_CUTOFF = 28
ALPHA_LEVELS = (0, 48, 96, 144, 192, 224, 255)
FRAME_ROLES = (
    "endpoint-seals-and-ink-stitches",
    "parchment-guideline-clusters",
    "taut-fractured-seam",
    "left-cut-spark-ignition",
    "travelling-cut-front-left",
    "travelling-cut-front-right",
    "ruptured-seam-and-debris",
    "dissipating-seals-and-scraps",
)

# Soot, old bronze, bone/vellum, dried blood, and restrained corpse-cyan ink.
VFX_PALETTE = (
    (2, 2, 3), (6, 5, 5), (10, 8, 7), (15, 12, 10),
    (21, 16, 13), (29, 22, 17), (39, 29, 21), (51, 37, 25),
    (66, 47, 29), (83, 58, 34), (103, 72, 39), (126, 89, 47),
    (151, 108, 60), (178, 132, 77), (204, 159, 101), (227, 191, 139),
    (239, 219, 179), (248, 239, 210),
    (30, 9, 9), (48, 13, 12), (69, 18, 15), (92, 25, 19),
    (119, 35, 25), (148, 51, 33), (178, 72, 44), (210, 108, 61),
    (7, 16, 17), (10, 27, 29), (13, 39, 41), (17, 54, 56),
    (23, 72, 73), (31, 91, 90), (44, 112, 107), (61, 136, 127),
    (85, 160, 148), (116, 184, 169), (153, 207, 190), (194, 229, 211),
    (225, 243, 226), (240, 250, 239),
    (27, 26, 25), (43, 40, 37), (61, 56, 50), (83, 75, 65),
    (109, 97, 81), (139, 124, 101), (173, 155, 126), (207, 188, 155),
)


def digest(path: Path) -> str:
    return sha256(path.read_bytes()).hexdigest()


def nearest_alpha(value: int) -> int:
    if value < ALPHA_CUTOFF:
        return 0
    return min(ALPHA_LEVELS[1:], key=lambda level: abs(level - value))


def palette_image() -> Image.Image:
    palette = [component for colour in VFX_PALETTE for component in colour]
    palette.extend([0] * (768 - len(palette)))
    image = Image.new("P", (1, 1))
    image.putpalette(palette)
    return image


def quantize_rgba(image: Image.Image) -> Image.Image:
    source = image.convert("RGBA")
    alpha = source.getchannel("A").point(nearest_alpha)
    rgb = source.convert("RGB").quantize(
        palette=palette_image(),
        dither=Image.Dither.FLOYDSTEINBERG,
    ).convert("RGB")
    rgb.putalpha(alpha)
    return rgb


def source_cell_box(source: Image.Image, column: int, row: int) -> tuple[int, int, int, int]:
    return (
        round(column * source.width / SOURCE_COLUMNS),
        round(row * source.height / SOURCE_ROWS),
        round((column + 1) * source.width / SOURCE_COLUMNS),
        round((row + 1) * source.height / SOURCE_ROWS),
    )


def normalize_frame(component: Image.Image) -> Image.Image:
    component = component.convert("RGBA")
    component.putalpha(component.getchannel("A").point(lambda value: 0 if value < ALPHA_CUTOFF else value))
    bounds = component.getchannel("A").getbbox()
    if bounds is None:
        raise ValueError("ImageGen storyboard cell is empty")
    crop = component.crop(bounds)

    maximum_width = OUTPUT_CELL[0] - HORIZONTAL_PADDING * 2
    maximum_height = OUTPUT_CELL[1] - VERTICAL_PADDING * 2
    scale = min(maximum_width / crop.width, maximum_height / crop.height)
    resized = crop.resize(
        (max(1, round(crop.width * scale)), max(1, round(crop.height * scale))),
        Image.Resampling.LANCZOS,
    )
    if resized.width != maximum_width:
        raise ValueError(
            "every authored frame must retain the fixed endpoint span; "
            f"got {resized.size} from {crop.size}"
        )

    framed = Image.new("RGBA", OUTPUT_CELL, (0, 0, 0, 0))
    framed.alpha_composite(
        resized,
        ((OUTPUT_CELL[0] - resized.width) // 2, (OUTPUT_CELL[1] - resized.height) // 2),
    )
    return quantize_rgba(framed)


def hot_pixel_centroid_x(frame: Image.Image) -> float | None:
    weighted_x = 0.0
    weight = 0.0
    for y in range(frame.height):
        for x in range(round(frame.width * 0.12), round(frame.width * 0.88)):
            red, green, blue, alpha = frame.getpixel((x, y))
            luminance = red * 0.2126 + green * 0.7152 + blue * 0.0722
            if alpha >= 144 and luminance >= 175 and red >= 170 and green >= 125:
                pixel_weight = alpha / 255
                weighted_x += x * pixel_weight
                weight += pixel_weight
    return None if weight == 0 else round(weighted_x / weight, 3)


def frame_metrics(frame: Image.Image, role: str) -> dict[str, object]:
    alpha = frame.getchannel("A")
    bounds = alpha.getbbox()
    if bounds is None:
        raise ValueError(f"{role} output frame is empty")
    alpha_pixels = list(alpha.get_flattened_data())
    visible_colours = {
        (red, green, blue)
        for red, green, blue, value in frame.get_flattened_data()
        if value > 0
    }
    return {
        "role": role,
        "alphaBounds": list(bounds),
        "padding": [
            bounds[0],
            bounds[1],
            frame.width - bounds[2],
            frame.height - bounds[3],
        ],
        "visiblePixels": sum(1 for value in alpha_pixels if value > 0),
        "uniqueVisibleColours": len(visible_colours),
        "alphaLevels": sorted(set(alpha_pixels)),
        "hotPixelCentroidX": hot_pixel_centroid_x(frame),
        "pixelHash": sha256(frame.tobytes()).hexdigest(),
    }


def main() -> None:
    source = Image.open(KEYED_SOURCE).convert("RGBA")
    suspicious_magenta = sum(
        1
        for red, green, blue, alpha in source.get_flattened_data()
        if alpha > ALPHA_CUTOFF and red > 180 and blue > 180 and green < 90
    )
    if suspicious_magenta:
        raise ValueError(f"keyed source retains {suspicious_magenta} magenta pixels")

    output = Image.new("RGBA", OUTPUT_SIZE, (0, 0, 0, 0))
    frames: list[dict[str, object]] = []
    for frame_index, role in enumerate(FRAME_ROLES):
        column = frame_index % SOURCE_COLUMNS
        row = frame_index // SOURCE_COLUMNS
        source_box = source_cell_box(source, column, row)
        frame = normalize_frame(source.crop(source_box))
        destination = (column * OUTPUT_CELL[0], row * OUTPUT_CELL[1])
        output.alpha_composite(frame, destination)
        frames.append(
            {
                "index": frame_index,
                "sourceCell": list(source_box),
                **frame_metrics(frame, role),
            }
        )

    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    output.save(OUTPUT, optimize=True)
    report = {
        "version": 3,
        "format": "RGBA PNG",
        "sheet": {
            "columns": SOURCE_COLUMNS,
            "rows": SOURCE_ROWS,
            "size": list(OUTPUT_SIZE),
            "cell": list(OUTPUT_CELL),
        },
        "phaseFrames": {"inscribe": [0, 1, 2], "sever": [3, 4, 5, 6, 7]},
        "sourceOriginal": str(ORIGINAL_SOURCE.relative_to(ROOT)).replace("\\", "/"),
        "sourceOriginalSha256": digest(ORIGINAL_SOURCE),
        "sourceKeyed": str(KEYED_SOURCE.relative_to(ROOT)).replace("\\", "/"),
        "sourceKeyedSha256": digest(KEYED_SOURCE),
        "promptMetadata": str(PROMPT_METADATA.relative_to(ROOT)).replace("\\", "/"),
        "promptMetadataSha256": digest(PROMPT_METADATA),
        "output": str(OUTPUT.relative_to(ROOT)).replace("\\", "/"),
        "outputSha256": digest(OUTPUT),
        "pipeline": {
            "horizontalPadding": HORIZONTAL_PADDING,
            "verticalPadding": VERTICAL_PADDING,
            "endpointSpanRatio": (OUTPUT_CELL[0] - HORIZONTAL_PADDING * 2) / OUTPUT_CELL[0],
            "paletteSize": len(VFX_PALETTE),
            "alphaCutoff": ALPHA_CUTOFF,
            "alphaLevels": list(ALPHA_LEVELS),
            "preserveAspectRatio": True,
            "centerEveryFrame": True,
        },
        "frames": frames,
    }
    REPORT.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(REPORT)


if __name__ == "__main__":
    main()
