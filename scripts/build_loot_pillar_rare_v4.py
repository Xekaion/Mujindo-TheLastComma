"""Build the rare V4 persistent loot pillar without flattening its source colour.

The ImageGen source already contains the intended antique-gold, ivory and
corpse-cyan separation.  This builder never collapses RGB to a scalar ramp or
reduces the palette.  It only removes residual magenta key spill, lifts soft
authored glow alpha, registers the four cells to one floor-contact row, and
downsamples in premultiplied-alpha space.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

import numpy as np
from PIL import Image


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "asset-sources/imagegen/loot-pillar-rare-v4-source.png"
KEYED_SOURCE = ROOT / "asset-sources/imagegen/loot-pillar-rare-v4-keyed.png"
PROMPT_METADATA = ROOT / "asset-sources/imagegen/loot-pillar-rare-v4.prompt.json"
OUTPUT = ROOT / "asset-sources/imagegen/loot-pillar-rare-v4-production.png"
REPORT = ROOT / "asset-sources/imagegen/loot-pillar-rare-v4.build.json"

FRAME_COUNT = 4
CELL_WIDTH = 256
CELL_HEIGHT = 512
TARGET_FLARE_Y = 472
VISIBLE_ALPHA_THRESHOLD = 64
FLARE_SEARCH_START_RATIO = 0.72
BRIGHT_LUMINANCE_THRESHOLD = 205.0
TRANSPARENT_ALPHA_CUTOFF = 8
PIXEL_DIFFERENCE_THRESHOLD = 16
SOFT_ALPHA_GAMMA = 0.68


def digest_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def digest(path: Path) -> str:
    return digest_bytes(path.read_bytes())


def relative(path: Path) -> str:
    return path.relative_to(ROOT).as_posix()


def proportional_edges(length: int, segments: int) -> list[int]:
    return [round(index * length / segments) for index in range(segments + 1)]


def premultiplied_resize(image: Image.Image, size: tuple[int, int]) -> Image.Image:
    """Resize translucent glow without pulling transparent black into its edge."""
    return image.convert("RGBa").resize(size, Image.Resampling.LANCZOS).convert("RGBA")


def clear_transparent_rgb(image: Image.Image) -> Image.Image:
    rgba = np.asarray(image.convert("RGBA"), dtype=np.uint8).copy()
    alpha = rgba[:, :, 3]
    alpha[alpha < TRANSPARENT_ALPHA_CUTOFF] = 0
    rgba[alpha == 0, :3] = 0
    rgba[:, :, 3] = alpha
    return Image.fromarray(rgba, "RGBA")


def clean_key_spill_and_lift_glow(image: Image.Image) -> Image.Image:
    """Warm only residual magenta-key fringe while preserving source texture."""
    rgba = np.asarray(image.convert("RGBA"), dtype=np.uint8).copy()
    rgb = rgba[:, :, :3].astype(np.float32)
    alpha = rgba[:, :, 3].astype(np.float32)
    red, green, blue = rgb[:, :, 0], rgb[:, :, 1], rgb[:, :, 2]
    shared_magenta = np.minimum(red, blue)
    spill = np.clip((shared_magenta - green - 12.0) / 92.0, 0.0, 1.0)
    spill *= (red >= 105.0) & (blue >= 85.0) & (alpha > 0.0)
    red_reflection = np.clip(
        (red - np.maximum(green, blue) - 8.0) / 86.0,
        0.0,
        1.0,
    )
    red_reflection *= (
        (red >= 110.0)
        & (red > green * 1.18)
        & (red > blue * 1.08)
        & (alpha > 0.0)
    )
    spill = np.maximum(spill, red_reflection)

    value = np.max(rgb, axis=2)
    warm_target = np.stack(
        (
            value,
            np.maximum(green, value * 0.70),
            np.minimum(blue, value * 0.13 + green * 0.06),
        ),
        axis=2,
    )
    rgb = rgb * (1.0 - spill[:, :, None]) + warm_target * spill[:, :, None]
    rgba[:, :, :3] = np.clip(np.rint(rgb), 0, 255).astype(np.uint8)

    visible = alpha > 0.0
    alpha[visible] = 255.0 * np.power(alpha[visible] / 255.0, SOFT_ALPHA_GAMMA)
    rgba[:, :, 3] = np.clip(np.rint(alpha), 0, 255).astype(np.uint8)
    return clear_transparent_rgb(Image.fromarray(rgba, "RGBA"))


def luminance_array(rgba: np.ndarray) -> np.ndarray:
    return np.sum(
        rgba[:, :, :3].astype(np.float32)
        * np.array((0.299, 0.587, 0.114), dtype=np.float32),
        axis=2,
    )


def measure_flare_y(image: Image.Image) -> int:
    rgba = np.asarray(image.convert("RGBA"), dtype=np.uint8)
    luminance = luminance_array(rgba)
    alpha = rgba[:, :, 3].astype(np.float32) / 255.0
    row_energy = np.sum(luminance * alpha, axis=1)
    start = min(image.height - 1, round(image.height * FLARE_SEARCH_START_RATIO))
    return start + int(np.argmax(row_energy[start:]))


def register_frame(cell: Image.Image) -> tuple[Image.Image, int]:
    cell = clean_key_spill_and_lift_glow(cell)
    source_flare_y = measure_flare_y(cell)
    if not 0 < source_flare_y < cell.height - 1:
        raise ValueError(f"invalid source flare row {source_flare_y} for {cell.size}")

    # The upper beam retains almost all of the vertical canvas.  Only the area
    # below the floor-contact flash is compressed into the remaining 39 rows,
    # which foreshortens the compass seal for the game's 3/4 floor perspective.
    upper = cell.crop((0, 0, cell.width, source_flare_y + 1))
    lower = cell.crop((0, source_flare_y + 1, cell.width, cell.height))
    upper = premultiplied_resize(upper, (CELL_WIDTH, TARGET_FLARE_Y + 1))
    lower = premultiplied_resize(
        lower,
        (CELL_WIDTH, CELL_HEIGHT - TARGET_FLARE_Y - 1),
    )
    frame = Image.new("RGBA", (CELL_WIDTH, CELL_HEIGHT), (0, 0, 0, 0))
    frame.paste(upper, (0, 0))
    frame.paste(lower, (0, TARGET_FLARE_Y + 1))
    return clear_transparent_rgb(frame), source_flare_y


def rgb_to_hsv(rgb: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    values = rgb.astype(np.float32) / 255.0
    red, green, blue = values[:, 0], values[:, 1], values[:, 2]
    maximum = np.max(values, axis=1)
    minimum = np.min(values, axis=1)
    delta = maximum - minimum
    hue = np.zeros_like(maximum)
    chromatic = delta > 1e-7

    red_max = chromatic & (maximum == red)
    green_max = chromatic & (maximum == green)
    blue_max = chromatic & (maximum == blue)
    hue[red_max] = 60.0 * np.mod((green[red_max] - blue[red_max]) / delta[red_max], 6.0)
    hue[green_max] = 60.0 * ((blue[green_max] - red[green_max]) / delta[green_max] + 2.0)
    hue[blue_max] = 60.0 * ((red[blue_max] - green[blue_max]) / delta[blue_max] + 4.0)
    saturation = np.divide(delta, maximum, out=np.zeros_like(delta), where=maximum > 1e-7)
    return hue, saturation, maximum


def rounded(value: float) -> float:
    return round(float(value), 6)


def frame_metrics(frame: Image.Image, index: int, source_flare_y: int) -> dict[str, object]:
    rgba = np.asarray(frame.convert("RGBA"), dtype=np.uint8)
    alpha = rgba[:, :, 3]
    visible = alpha >= VISIBLE_ALPHA_THRESHOLD
    visible_count = int(np.count_nonzero(visible))
    if visible_count == 0:
        raise ValueError(f"rare V4 frame {index} is empty")

    support = Image.fromarray(np.where(visible, 255, 0).astype(np.uint8), "L")
    bbox = support.getbbox()
    if bbox is None:
        raise ValueError(f"rare V4 frame {index} lacks an alpha bbox")
    left, top, right, bottom = bbox

    colours = rgba[:, :, :3][visible]
    unique_colours, counts = np.unique(colours, axis=0, return_counts=True)
    order = np.argsort(counts)[::-1]
    dominant_colours = [
        {
            "rgb": [int(component) for component in unique_colours[position]],
            "pixels": int(counts[position]),
            "ratio": rounded(counts[position] / visible_count),
        }
        for position in order[:5]
    ]
    probabilities = counts.astype(np.float64) / visible_count
    colour_entropy = -np.sum(probabilities * np.log2(probabilities))

    luminance = np.sum(
        colours.astype(np.float32)
        * np.array((0.299, 0.587, 0.114), dtype=np.float32),
        axis=1,
    )
    hue, saturation, value = rgb_to_hsv(colours)
    bright = luminance >= BRIGHT_LUMINANCE_THRESHOLD
    white = (saturation <= 0.18) & (value >= 0.78)
    gold = (
        (hue >= 30.0)
        & (hue <= 65.0)
        & (saturation >= 0.4)
        & (value >= 0.35)
    )
    cyan = (
        (hue >= 165.0)
        & (hue <= 205.0)
        & (saturation >= 0.3)
        & (value >= 0.35)
    )
    flare_y = measure_flare_y(frame)

    metrics: dict[str, object] = {
        "index": index,
        "sourceFlareY": source_flare_y,
        "flareY": flare_y,
        "bbox": [left, top, right, bottom],
        "padding": [left, top, CELL_WIDTH - right, CELL_HEIGHT - bottom],
        "visiblePixels": visible_count,
        "uniqueVisibleRgb": int(len(unique_colours)),
        "alphaLevelCount": int(len(np.unique(alpha))),
        "opaquePixelRatio": rounded(np.count_nonzero(alpha[visible] == 255) / visible_count),
        "meanRgb": [rounded(value) for value in np.mean(colours, axis=0)],
        "meanLuminance": rounded(np.mean(luminance)),
        "luminanceStdDev": rounded(np.std(luminance)),
        "brightPixelRatio": rounded(np.count_nonzero(bright) / visible_count),
        "whitePixelRatio": rounded(np.count_nonzero(white) / visible_count),
        "goldPixelRatio": rounded(np.count_nonzero(gold) / visible_count),
        "cyanPixelRatio": rounded(np.count_nonzero(cyan) / visible_count),
        "topColorRatio": rounded(counts[order[0]] / visible_count),
        "topTwoColorRatio": rounded(np.sum(counts[order[:2]]) / visible_count),
        "colourEntropyBits": rounded(colour_entropy),
        "dominantColors": dominant_colours,
        "pixelHash": digest_bytes(frame.tobytes()),
    }

    if abs(flare_y - TARGET_FLARE_Y) > 2:
        raise ValueError(f"rare V4 frame {index} flare drifted to {flare_y}")
    if metrics["uniqueVisibleRgb"] < 1_000:
        raise ValueError(f"rare V4 frame {index} lost colour detail")
    if not 0.12 <= metrics["brightPixelRatio"] <= 0.50:
        raise ValueError(f"rare V4 frame {index} brightness is out of range")
    if metrics["whitePixelRatio"] > 0.23:
        raise ValueError(f"rare V4 frame {index} contains a white flood")
    if metrics["goldPixelRatio"] < 0.18:
        raise ValueError(f"rare V4 frame {index} no longer reads as gold")
    if metrics["topColorRatio"] > 0.15 or metrics["topTwoColorRatio"] > 0.22:
        raise ValueError(f"rare V4 frame {index} collapsed toward a flat colour")
    return metrics


def temporal_difference(
    first: Image.Image,
    second: Image.Image,
    first_index: int,
    second_index: int,
) -> dict[str, object]:
    first_rgba = np.asarray(first.convert("RGBA"), dtype=np.int16)
    second_rgba = np.asarray(second.convert("RGBA"), dtype=np.int16)
    first_support = first_rgba[:, :, 3] >= VISIBLE_ALPHA_THRESHOLD
    second_support = second_rgba[:, :, 3] >= VISIBLE_ALPHA_THRESHOLD
    union = first_support | second_support
    intersection = first_support & second_support
    union_count = int(np.count_nonzero(union))
    difference = np.abs(first_rgba - second_rgba)
    changed = np.any(difference >= PIXEL_DIFFERENCE_THRESHOLD, axis=2) & union
    return {
        "from": first_index,
        "to": second_index,
        "alphaSupportIou": rounded(np.count_nonzero(intersection) / max(1, union_count)),
        "changedPixelRatio": rounded(np.count_nonzero(changed) / max(1, union_count)),
        "meanAbsoluteRgbDelta": rounded(np.mean(difference[:, :, :3][union])),
        "meanAbsoluteAlphaDelta": rounded(np.mean(difference[:, :, 3][union])),
    }


def range_summary(frames: list[dict[str, object]], key: str) -> dict[str, float]:
    values = [float(frame[key]) for frame in frames]
    return {
        "min": rounded(min(values)),
        "max": rounded(max(values)),
        "mean": rounded(sum(values) / len(values)),
    }


def image_record(path: Path) -> dict[str, object]:
    with Image.open(path) as image:
        return {
            "path": relative(path),
            "sha256": digest(path),
            "bytes": path.stat().st_size,
            "size": list(image.size),
            "mode": image.mode,
        }


def main() -> None:
    for required in (SOURCE, KEYED_SOURCE, PROMPT_METADATA):
        if not required.exists():
            raise FileNotFoundError(required)

    source = Image.open(KEYED_SOURCE).convert("RGBA")
    if source.width < FRAME_COUNT or source.height < 2:
        raise ValueError(f"invalid rare V4 keyed source size {source.size}")
    source_edges = proportional_edges(source.width, FRAME_COUNT)
    frames: list[Image.Image] = []
    source_flare_rows: list[int] = []
    for index in range(FRAME_COUNT):
        cell = source.crop(
            (source_edges[index], 0, source_edges[index + 1], source.height)
        )
        frame, source_flare_y = register_frame(cell)
        frames.append(frame)
        source_flare_rows.append(source_flare_y)

    atlas = Image.new(
        "RGBA",
        (CELL_WIDTH * FRAME_COUNT, CELL_HEIGHT),
        (0, 0, 0, 0),
    )
    for index, frame in enumerate(frames):
        atlas.paste(frame, (index * CELL_WIDTH, 0))
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    atlas.save(OUTPUT, optimize=True, compress_level=9)

    frame_records = [
        frame_metrics(frame, index, source_flare_rows[index])
        for index, frame in enumerate(frames)
    ]
    differences = [
        temporal_difference(frames[index], frames[(index + 1) % FRAME_COUNT], index, (index + 1) % FRAME_COUNT)
        for index in range(FRAME_COUNT)
    ]
    if min(float(item["changedPixelRatio"]) for item in differences) < 0.25:
        raise ValueError("rare V4 loop frames are not visually distinct enough")

    output_rgba = np.asarray(atlas, dtype=np.uint8)
    transparent_rgb_leak = int(
        np.count_nonzero(
            (output_rgba[:, :, 3] == 0)
            & np.any(output_rgba[:, :, :3] != 0, axis=2)
        )
    )
    if transparent_rgb_leak:
        raise ValueError(f"rare V4 output retains {transparent_rgb_leak} hidden RGB pixels")
    for x, y in (
        (0, 0),
        (atlas.width - 1, 0),
        (0, atlas.height - 1),
        (atlas.width - 1, atlas.height - 1),
    ):
        if atlas.getpixel((x, y))[3] != 0:
            raise ValueError(f"rare V4 output corner {(x, y)} is not transparent")

    prompt_record = json.loads(PROMPT_METADATA.read_text(encoding="utf-8"))
    report = {
        "version": 4,
        "builder": relative(Path(__file__)),
        "format": "rgba-png",
        "atlas": {
            "columns": FRAME_COUNT,
            "rows": 1,
            "cell": [CELL_WIDTH, CELL_HEIGHT],
            "size": list(atlas.size),
        },
        "source": {
            "generated": image_record(SOURCE),
            "keyed": image_record(KEYED_SOURCE),
            "promptMetadata": {
                "path": relative(PROMPT_METADATA),
                "sha256": digest(PROMPT_METADATA),
                "generationPrompt": prompt_record["generationPrompt"],
                "editPrompt": prompt_record["editPrompt"],
                "finalColourCorrectionPrompt": prompt_record["finalColourCorrectionPrompt"],
                "matteCleanupPrompt": prompt_record["matteCleanupPrompt"],
            },
        },
        "pipeline": {
            "split": "four proportional horizontal cells with rounded source edges",
            "sourceFrameEdges": source_edges,
            "resize": "premultiplied-alpha LANCZOS",
            "colourGrade": "hue-local residual magenta-key spill to warm amber; no scalar RGB ramp",
            "palette": "truecolour; no palette quantization",
            "alpha": f"continuous soft alpha gamma {SOFT_ALPHA_GAMMA}; values below 8 cleared",
            "targetFlareY": TARGET_FLARE_Y,
            "visibleAlphaThreshold": VISIBLE_ALPHA_THRESHOLD,
            "flareSearchStartRatio": FLARE_SEARCH_START_RATIO,
            "brightLuminanceThreshold": BRIGHT_LUMINANCE_THRESHOLD,
            "pixelDifferenceThreshold": PIXEL_DIFFERENCE_THRESHOLD,
            "classification": {
                "white": "HSV saturation <= 0.18 and value >= 0.78",
                "gold": "HSV hue 30..65, saturation >= 0.4, value >= 0.35",
                "cyan": "HSV hue 165..205, saturation >= 0.3, value >= 0.35",
            },
        },
        "output": {
            "path": relative(OUTPUT),
            "sha256": digest(OUTPUT),
            "bytes": OUTPUT.stat().st_size,
            "groundAnchor": round(TARGET_FLARE_Y / CELL_HEIGHT, 4),
            "transparentRgbLeak": transparent_rgb_leak,
        },
        "frames": frame_records,
        "temporalDifferences": differences,
        "summary": {
            "uniqueVisibleRgb": range_summary(frame_records, "uniqueVisibleRgb"),
            "alphaLevelCount": range_summary(frame_records, "alphaLevelCount"),
            "brightPixelRatio": range_summary(frame_records, "brightPixelRatio"),
            "whitePixelRatio": range_summary(frame_records, "whitePixelRatio"),
            "goldPixelRatio": range_summary(frame_records, "goldPixelRatio"),
            "cyanPixelRatio": range_summary(frame_records, "cyanPixelRatio"),
            "topColorRatio": range_summary(frame_records, "topColorRatio"),
            "topTwoColorRatio": range_summary(frame_records, "topTwoColorRatio"),
            "colourEntropyBits": range_summary(frame_records, "colourEntropyBits"),
            "flareY": range_summary(frame_records, "flareY"),
            "minimumTemporalChangedPixelRatio": rounded(
                min(float(item["changedPixelRatio"]) for item in differences)
            ),
            "maximumTemporalAlphaSupportIou": rounded(
                max(float(item["alphaSupportIou"]) for item in differences)
            ),
        },
    }
    REPORT.write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(relative(OUTPUT), OUTPUT.stat().st_size)
    print(relative(REPORT))
    for frame in frame_records:
        print(
            frame["index"],
            "flare", frame["flareY"],
            "bright", frame["brightPixelRatio"],
            "white", frame["whitePixelRatio"],
            "gold", frame["goldPixelRatio"],
            "cyan", frame["cyanPixelRatio"],
            "top2", frame["topTwoColorRatio"],
        )


if __name__ == "__main__":
    main()
