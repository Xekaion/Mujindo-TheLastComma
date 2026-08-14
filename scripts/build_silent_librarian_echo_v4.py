"""Build the Silent Librarian's true eight-stage echo animation atlas.

The ImageGen source is an exact 4 x 2 storyboard on a removed chroma matte.
This builder performs one high-quality downsample per authored pose, keeps the
four book and four travelling-fragment silhouettes distinct, and frames them
inside fixed 128 px runtime cells.  It deliberately avoids the old
half-resolution/nearest-neighbour enlargement and coarse forced palette that
turned the travelling component into a dark repeated hook.
"""

from __future__ import annotations

from hashlib import sha256
import json
from pathlib import Path

from PIL import Image


ROOT = Path(__file__).resolve().parents[1]
ORIGINAL_SOURCE = ROOT / "asset-sources/imagegen/silent-librarian-echo-v4-source.png"
KEYED_SOURCE = ROOT / "asset-sources/imagegen/silent-librarian-echo-v4-keyed.png"
PROMPT_METADATA = ROOT / "asset-sources/imagegen/silent-librarian-echo-v4.prompt.json"
OUTPUT = ROOT / "public/assets/effects/silent-librarian-echo-v4.png"
REPORT = ROOT / "public/assets/effects/silent-librarian-echo-v4.build.json"

EXPECTED_SOURCE_SIZE = (1717, 916)
SHEET_COLUMNS = 4
SHEET_ROWS = 2
CELL_SIZE = 128
SHEET_SIZE = (SHEET_COLUMNS * CELL_SIZE, SHEET_ROWS * CELL_SIZE)
FRAME_ROLES = (
    "sealed-grimoire",
    "igniting-clasps",
    "opening-pages",
    "released-rune-pulse",
    "compact-echo-wedge",
    "unfurling-echo-slash",
    "splitting-page-slivers",
    "dissipating-glyph-fragments",
)

# The top row is readable above the caster.  The travelling fragments are
# authored substantially smaller inside the same 128 px cell so twelve fixed
# wave slots cannot merge into a black necklace at the 44 px start radius.
CONTENT_LIMITS = (
    (78, 88),
    (78, 88),
    (92, 88),
    (92, 88),
    (76, 72),
    (76, 56),
    (76, 56),
    (76, 56),
)


def digest(path: Path) -> str:
    return sha256(path.read_bytes()).hexdigest()


def source_boundaries(length: int, cells: int) -> list[int]:
    return [round(index * length / cells) for index in range(cells + 1)]


def sanitize_transparent_rgb(image: Image.Image) -> Image.Image:
    rgba = image.convert("RGBA")
    pixels = bytearray(rgba.tobytes())
    for index in range(0, len(pixels), 4):
        if pixels[index + 3] == 0:
            pixels[index] = 0
            pixels[index + 1] = 0
            pixels[index + 2] = 0
    return Image.frombytes("RGBA", rgba.size, bytes(pixels))


def normalize_pose(component: Image.Image, limit: tuple[int, int]) -> Image.Image:
    source = sanitize_transparent_rgb(component)
    bounds = source.getchannel("A").getbbox()
    if bounds is None:
        raise ValueError("ImageGen storyboard cell is empty")
    crop = source.crop(bounds)
    scale = min(limit[0] / crop.width, limit[1] / crop.height)
    target_size = (
        max(1, round(crop.width * scale)),
        max(1, round(crop.height * scale)),
    )
    # Exactly one resampling step from the cleaned ImageGen source to gameplay
    # resolution.  Never upscale this result again at runtime.
    resized = crop.resize(target_size, Image.Resampling.LANCZOS)
    resized = sanitize_transparent_rgb(resized)
    frame = Image.new("RGBA", (CELL_SIZE, CELL_SIZE), (0, 0, 0, 0))
    frame.alpha_composite(
        resized,
        ((CELL_SIZE - resized.width) // 2, (CELL_SIZE - resized.height) // 2),
    )
    return sanitize_transparent_rgb(frame)


def frame_metrics(frame: Image.Image, index: int, role: str) -> dict[str, object]:
    alpha_values = list(frame.getchannel("A").get_flattened_data())
    bounds = frame.getchannel("A").getbbox()
    if bounds is None:
        raise ValueError(f"{role} output frame is empty")
    visible_indices = [pixel_index for pixel_index, alpha in enumerate(alpha_values) if alpha > 0]
    rgba_values = list(frame.get_flattened_data())
    visible_rgb = {
        rgba_values[pixel_index][:3]
        for pixel_index in visible_indices
    }
    suspicious_magenta = sum(
        1
        for pixel_index in visible_indices
        if rgba_values[pixel_index][3] > 8
        and rgba_values[pixel_index][0] > 180
        and rgba_values[pixel_index][2] > 180
        and rgba_values[pixel_index][1] + 70
        < min(rgba_values[pixel_index][0], rgba_values[pixel_index][2])
    )
    weighted_alpha = sum(alpha_values[pixel_index] for pixel_index in visible_indices)
    centroid_x = (
        sum((pixel_index % CELL_SIZE) * alpha_values[pixel_index] for pixel_index in visible_indices)
        / weighted_alpha
    )
    centroid_y = (
        sum((pixel_index // CELL_SIZE) * alpha_values[pixel_index] for pixel_index in visible_indices)
        / weighted_alpha
    )
    row = index // SHEET_COLUMNS
    column = index % SHEET_COLUMNS
    return {
        "index": index,
        "row": row,
        "column": column,
        "role": role,
        "alphaBounds": list(bounds),
        "padding": [
            bounds[0],
            bounds[1],
            CELL_SIZE - bounds[2],
            CELL_SIZE - bounds[3],
        ],
        "visiblePixels": len(visible_indices),
        "opaquePixels": sum(1 for alpha in alpha_values if alpha >= 224),
        "alphaLevels": len(set(alpha_values)),
        "alphaLevelValues": sorted(set(alpha_values)),
        "uniqueVisibleRgb": len(visible_rgb),
        "suspiciousMagentaPixels": suspicious_magenta,
        "centroid": [round(centroid_x, 4), round(centroid_y, 4)],
        "aspectRatio": round((bounds[2] - bounds[0]) / (bounds[3] - bounds[1]), 4),
        "pixelHash": sha256(frame.tobytes()).hexdigest(),
    }


def main() -> None:
    source = Image.open(KEYED_SOURCE).convert("RGBA")
    if source.size != EXPECTED_SOURCE_SIZE:
        raise ValueError(
            f"{KEYED_SOURCE} must be {EXPECTED_SOURCE_SIZE}, got {source.size}"
        )
    source_pixels = list(source.get_flattened_data())
    suspicious_source_magenta = sum(
        1
        for red, green, blue, alpha in source_pixels
        if alpha > 8 and red > 180 and blue > 180 and green + 70 < min(red, blue)
    )
    if suspicious_source_magenta:
        raise ValueError(
            f"keyed source retains {suspicious_source_magenta} visible magenta pixels"
        )

    x_bounds = source_boundaries(source.width, SHEET_COLUMNS)
    y_bounds = source_boundaries(source.height, SHEET_ROWS)
    output = Image.new("RGBA", SHEET_SIZE, (0, 0, 0, 0))
    frames: list[dict[str, object]] = []
    for frame_index, (role, content_limit) in enumerate(
        zip(FRAME_ROLES, CONTENT_LIMITS, strict=True)
    ):
        row = frame_index // SHEET_COLUMNS
        column = frame_index % SHEET_COLUMNS
        source_box = (
            x_bounds[column],
            y_bounds[row],
            x_bounds[column + 1],
            y_bounds[row + 1],
        )
        frame = normalize_pose(source.crop(source_box), content_limit)
        output.alpha_composite(frame, (column * CELL_SIZE, row * CELL_SIZE))
        metrics = frame_metrics(frame, frame_index, role)
        if metrics["suspiciousMagentaPixels"]:
            raise ValueError(f"{role} retains visible magenta")
        if min(metrics["padding"]) < 8:
            raise ValueError(f"{role} lacks crop-safe padding: {metrics['padding']}")
        if metrics["alphaLevels"] < 12 or metrics["uniqueVisibleRgb"] < 96:
            raise ValueError(f"{role} lost authored colour or alpha detail")
        frames.append(metrics)

    output = sanitize_transparent_rgb(output)
    if len({frame["pixelHash"] for frame in frames}) != len(frames):
        raise ValueError("all eight chronological frames must remain distinct")
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    output.save(OUTPUT, optimize=True)

    report = {
        "version": 4,
        "format": "RGBA PNG",
        "sheet": {
            "columns": SHEET_COLUMNS,
            "rows": SHEET_ROWS,
            "cellSize": [CELL_SIZE, CELL_SIZE],
            "size": list(SHEET_SIZE),
        },
        "sourceOriginal": str(ORIGINAL_SOURCE.relative_to(ROOT)).replace("\\", "/"),
        "sourceOriginalSha256": digest(ORIGINAL_SOURCE),
        "sourceKeyed": str(KEYED_SOURCE.relative_to(ROOT)).replace("\\", "/"),
        "sourceKeyedSha256": digest(KEYED_SOURCE),
        "promptMetadata": str(PROMPT_METADATA.relative_to(ROOT)).replace("\\", "/"),
        "promptMetadataSha256": digest(PROMPT_METADATA),
        "output": str(OUTPUT.relative_to(ROOT)).replace("\\", "/"),
        "outputSha256": digest(OUTPUT),
        "pipeline": {
            "resampling": "one-pass LANCZOS",
            "runtimeScale": "1:1 fixed 128x128 cells",
            "forcedPalette": False,
            "nearestNeighbourUpscale": False,
            "contentLimits": [list(limit) for limit in CONTENT_LIMITS],
            "transparentRgb": [0, 0, 0],
        },
        "frames": frames,
    }
    REPORT.write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(json.dumps({"output": str(OUTPUT), "sha256": report["outputSha256"]}))


if __name__ == "__main__":
    main()
