"""Build the unclipped heroic V4 persistent loot-pillar atlas.

The accepted ImageGen source repairs the four violet pillar tips on a green
chroma background.  This builder keeps every proportional source cell at one
fixed full-cell scale, removes only residual green/cyan key spill, registers
the lower flare and energy centroid, and validates that no flat top survives.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

import numpy as np
from PIL import Image


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "asset-sources/imagegen/loot-pillar-epic-v4-source.png"
KEYED_SOURCE = ROOT / "asset-sources/imagegen/loot-pillar-epic-v4-keyed.png"
PROMPT_METADATA = ROOT / "asset-sources/imagegen/loot-pillar-epic-v4.prompt.json"
REFERENCE_INPUT = ROOT / "public/assets/effects/loot-pillar-epic-v3.png"
OUTPUT = ROOT / "public/assets/effects/loot-pillar-epic-v4.png"
REPORT = ROOT / "public/assets/effects/loot-pillar-epic-v4.build.json"

FRAME_COUNT = 4
CELL_WIDTH = 256
CELL_HEIGHT = 512
TARGET_FLARE_Y = 475
TARGET_LOWER_ENERGY_CENTROID_X = 128
LOWER_ENERGY_START_Y = round(CELL_HEIGHT * 0.68)
FLARE_SEARCH_START_Y = round(CELL_HEIGHT * 0.72)
VISIBLE_ALPHA_THRESHOLD = 64
TRANSPARENT_ALPHA_CUTOFF = 8
MIN_TOP_PADDING = 24
MIN_BOTTOM_PADDING = 8
MIN_HORIZONTAL_PADDING = 8
TOP_PROFILE_ROWS = 24
MAX_FIRST_VISIBLE_RUN = 4
FLAT_PLATEAU_RUN = 10
MAX_CENTROID_ERROR = 0.75
PIXEL_DIFFERENCE_THRESHOLD = 16
BRIGHT_LUMINANCE_THRESHOLD = 205.0


def digest_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def digest(path: Path) -> str:
    return digest_bytes(path.read_bytes())


def relative(path: Path) -> str:
    return path.relative_to(ROOT).as_posix()


def proportional_edges(length: int, segments: int) -> list[int]:
    return [round(index * length / segments) for index in range(segments + 1)]


def premultiplied_resize(image: Image.Image, size: tuple[int, int]) -> Image.Image:
    """Resize translucent glow without blending transparent RGB into its edge."""
    return image.convert("RGBa").resize(size, Image.Resampling.LANCZOS).convert("RGBA")


def clear_hidden_rgb(image: Image.Image) -> Image.Image:
    rgba = np.asarray(image.convert("RGBA"), dtype=np.uint8).copy()
    alpha = rgba[:, :, 3]
    alpha[alpha < TRANSPARENT_ALPHA_CUTOFF] = 0
    rgba[alpha == 0, :3] = 0
    rgba[:, :, 3] = alpha
    return Image.fromarray(rgba, "RGBA")


def clean_green_cyan_key_spill(image: Image.Image) -> tuple[Image.Image, int]:
    """Rotate only saturated green/cyan fringe into the authored violet family."""
    rgba = np.asarray(image.convert("RGBA"), dtype=np.uint8).copy()
    hsv = np.asarray(
        Image.fromarray(rgba[:, :, :3], "RGB").convert("HSV"),
        dtype=np.uint8,
    ).copy()
    hue_degrees = hsv[:, :, 0].astype(np.float32) * (360.0 / 255.0)
    saturation = hsv[:, :, 1].astype(np.float32) / 255.0
    value = hsv[:, :, 2].astype(np.float32) / 255.0
    alpha = rgba[:, :, 3]
    spill = (
        (alpha > 0)
        # Use a slightly wider cleanup gate than the report classifier so
        # RGB/HSV rounding cannot leave a one-pixel green or cyan fringe.
        & (hue_degrees >= 45.0)
        & (hue_degrees <= 230.0)
        & (saturation >= 0.12)
        & (value >= 0.08)
    )

    # Preserve saturation/value texture and change hue only.  The small range
    # variation avoids replacing nuanced edge pixels with one flat purple.
    violet_hue = 280.0 + np.clip(
        (hue_degrees - 45.0) / (230.0 - 45.0),
        0.0,
        1.0,
    ) * 12.0
    hsv[:, :, 0][spill] = np.rint(violet_hue[spill] * (255.0 / 360.0)).astype(
        np.uint8
    )
    corrected_rgb = np.asarray(Image.fromarray(hsv, "HSV").convert("RGB"))
    rgba[:, :, :3][spill] = corrected_rgb[spill]
    return clear_hidden_rgb(Image.fromarray(rgba, "RGBA")), int(np.count_nonzero(spill))


def luminance_array(rgba: np.ndarray) -> np.ndarray:
    return np.sum(
        rgba[:, :, :3].astype(np.float32)
        * np.array((0.299, 0.587, 0.114), dtype=np.float32),
        axis=2,
    )


def energy_array(image: Image.Image) -> np.ndarray:
    rgba = np.asarray(image.convert("RGBA"), dtype=np.uint8)
    return luminance_array(rgba) * (rgba[:, :, 3].astype(np.float32) / 255.0)


def measure_flare_y(image: Image.Image) -> int:
    row_energy = np.sum(energy_array(image), axis=1)
    return FLARE_SEARCH_START_Y + int(np.argmax(row_energy[FLARE_SEARCH_START_Y:]))


def measure_lower_energy_centroid_x(image: Image.Image) -> float:
    energy = energy_array(image)[LOWER_ENERGY_START_Y:, :]
    total = float(np.sum(energy))
    if total <= 0.0:
        raise ValueError("heroic V4 frame has no lower-half energy")
    x_coordinates = np.arange(CELL_WIDTH, dtype=np.float32)[None, :]
    return float(np.sum(energy * x_coordinates) / total)


def translate_frame(image: Image.Image, dx: int, dy: int) -> Image.Image:
    frame = Image.new("RGBA", (CELL_WIDTH, CELL_HEIGHT), (0, 0, 0, 0))
    frame.alpha_composite(image, (dx, dy))
    return frame


def reserve_bottom_padding(image: Image.Image) -> Image.Image:
    rgba = np.asarray(image.convert("RGBA"), dtype=np.uint8).copy()
    rgba[CELL_HEIGHT - MIN_BOTTOM_PADDING :, :, :] = 0
    return clear_hidden_rgb(Image.fromarray(rgba, "RGBA"))


def register_frame(cell: Image.Image) -> tuple[Image.Image, dict[str, object]]:
    resized = premultiplied_resize(cell, (CELL_WIDTH, CELL_HEIGHT))
    cleaned, spill_pixels = clean_green_cyan_key_spill(resized)
    source_flare_y = measure_flare_y(cleaned)
    dy = TARGET_FLARE_Y - source_flare_y

    vertically_registered = reserve_bottom_padding(
        translate_frame(cleaned, 0, dy)
    )
    source_lower_centroid_x = measure_lower_energy_centroid_x(vertically_registered)
    dx = round(TARGET_LOWER_ENERGY_CENTROID_X - source_lower_centroid_x)
    frame = reserve_bottom_padding(translate_frame(vertically_registered, dx, 0))
    return frame, {
        "sourceFlareYAfterFullCellResize": source_flare_y,
        "sourceLowerEnergyCentroidXAfterYRegistration": round(
            source_lower_centroid_x, 6
        ),
        "translation": [dx, dy],
        "correctedGreenCyanPixels": spill_pixels,
    }


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
    hue[red_max] = 60.0 * np.mod(
        (green[red_max] - blue[red_max]) / delta[red_max], 6.0
    )
    hue[green_max] = 60.0 * (
        (blue[green_max] - red[green_max]) / delta[green_max] + 2.0
    )
    hue[blue_max] = 60.0 * (
        (red[blue_max] - green[blue_max]) / delta[blue_max] + 4.0
    )
    saturation = np.divide(
        delta,
        maximum,
        out=np.zeros_like(delta),
        where=maximum > 1e-7,
    )
    return hue, saturation, maximum


def max_contiguous_run(row: np.ndarray) -> int:
    padded = np.pad(row.astype(np.int8), (1, 1))
    transitions = np.diff(padded)
    starts = np.flatnonzero(transitions == 1)
    ends = np.flatnonzero(transitions == -1)
    if not len(starts):
        return 0
    return int(np.max(ends - starts))


def rounded(value: float) -> float:
    return round(float(value), 6)


def frame_metrics(
    frame: Image.Image,
    index: int,
    registration: dict[str, object],
) -> dict[str, object]:
    rgba = np.asarray(frame.convert("RGBA"), dtype=np.uint8)
    alpha = rgba[:, :, 3]
    visible = alpha >= VISIBLE_ALPHA_THRESHOLD
    visible_count = int(np.count_nonzero(visible))
    if visible_count == 0:
        raise ValueError(f"heroic V4 frame {index} is empty")

    support = Image.fromarray(np.where(visible, 255, 0).astype(np.uint8), "L")
    bbox = support.getbbox()
    if bbox is None:
        raise ValueError(f"heroic V4 frame {index} lacks an alpha bbox")
    left, top, right, bottom = bbox
    top_profile = visible[top : min(CELL_HEIGHT, top + TOP_PROFILE_ROWS)]
    top_runs = [max_contiguous_run(row) for row in top_profile]
    first_visible_run = top_runs[0]
    flat_plateau_rows = [
        top + offset
        for offset, run in enumerate(top_runs)
        if run >= FLAT_PLATEAU_RUN
    ]

    colours = rgba[:, :, :3][visible]
    hue, saturation, value = rgb_to_hsv(colours)
    luminance = np.sum(
        colours.astype(np.float32)
        * np.array((0.299, 0.587, 0.114), dtype=np.float32),
        axis=1,
    )
    purple = (
        (hue >= 245.0)
        & (hue <= 335.0)
        & (saturation >= 0.28)
        & (value >= 0.22)
    )
    magenta_core = (
        (hue >= 285.0)
        & (hue <= 345.0)
        & (saturation >= 0.35)
        & (value >= 0.40)
    )
    white_core = (saturation <= 0.20) & (value >= 0.78)
    green_cyan = (
        (hue >= 55.0)
        & (hue <= 220.0)
        & (saturation >= 0.18)
        & (value >= 0.12)
    )
    bright = luminance >= BRIGHT_LUMINANCE_THRESHOLD
    lower_centroid_x = measure_lower_energy_centroid_x(frame)
    flare_y = measure_flare_y(frame)

    metrics: dict[str, object] = {
        "index": index,
        **registration,
        "flareY": flare_y,
        "lowerEnergyCentroidX": rounded(lower_centroid_x),
        "bbox": [left, top, right, bottom],
        "padding": [left, top, CELL_WIDTH - right, CELL_HEIGHT - bottom],
        "topPadding": top,
        "bottomPadding": CELL_HEIGHT - bottom,
        "firstVisibleRow": top,
        "firstVisibleRowMaxRun": first_visible_run,
        "top24MaxHorizontalRun": max(top_runs),
        "top24HorizontalRuns": top_runs,
        "flatPlateauRows": flat_plateau_rows,
        "visiblePixels": visible_count,
        "alphaLevelCount": int(len(np.unique(alpha))),
        "meanRgb": [rounded(component) for component in np.mean(colours, axis=0)],
        "meanLuminance": rounded(np.mean(luminance)),
        "brightPixelRatio": rounded(np.count_nonzero(bright) / visible_count),
        "purplePixelRatio": rounded(np.count_nonzero(purple) / visible_count),
        "magentaCorePixelRatio": rounded(
            np.count_nonzero(magenta_core) / visible_count
        ),
        "whiteCorePixelRatio": rounded(np.count_nonzero(white_core) / visible_count),
        "greenCyanSpillRatio": rounded(np.count_nonzero(green_cyan) / visible_count),
        "pixelHash": digest_bytes(frame.tobytes()),
    }

    if flare_y != TARGET_FLARE_Y:
        raise ValueError(f"heroic V4 frame {index} flare drifted to {flare_y}")
    if abs(lower_centroid_x - TARGET_LOWER_ENERGY_CENTROID_X) > MAX_CENTROID_ERROR:
        raise ValueError(
            f"heroic V4 frame {index} lower centroid drifted to {lower_centroid_x:.3f}"
        )
    if top < MIN_TOP_PADDING:
        raise ValueError(f"heroic V4 frame {index} top padding is only {top}px")
    if CELL_HEIGHT - bottom < MIN_BOTTOM_PADDING:
        raise ValueError(f"heroic V4 frame {index} bottom padding is too small")
    if min(left, CELL_WIDTH - right) < MIN_HORIZONTAL_PADDING:
        raise ValueError(f"heroic V4 frame {index} touches a horizontal cell edge")
    if first_visible_run > MAX_FIRST_VISIBLE_RUN:
        raise ValueError(
            f"heroic V4 frame {index} starts with a {first_visible_run}px flat run"
        )
    if flat_plateau_rows:
        raise ValueError(
            f"heroic V4 frame {index} retains a broad top plateau at {flat_plateau_rows}"
        )
    if metrics["purplePixelRatio"] < 0.60:
        raise ValueError(f"heroic V4 frame {index} lost its purple identity")
    if metrics["magentaCorePixelRatio"] < 0.08:
        raise ValueError(f"heroic V4 frame {index} lost its magenta core")
    if metrics["whiteCorePixelRatio"] < 0.06:
        raise ValueError(f"heroic V4 frame {index} lost its white-hot core")
    if metrics["brightPixelRatio"] < 0.10:
        raise ValueError(f"heroic V4 frame {index} is not bright enough")
    if metrics["greenCyanSpillRatio"] > 0.005:
        raise ValueError(f"heroic V4 frame {index} retains green/cyan key spill")
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
        "alphaSupportIou": rounded(
            np.count_nonzero(intersection) / max(1, union_count)
        ),
        "changedPixelRatio": rounded(
            np.count_nonzero(changed) / max(1, union_count)
        ),
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
    for required in (SOURCE, KEYED_SOURCE, PROMPT_METADATA, REFERENCE_INPUT):
        if not required.exists():
            raise FileNotFoundError(required)

    keyed = Image.open(KEYED_SOURCE).convert("RGBA")
    if keyed.width < FRAME_COUNT or keyed.height < 2:
        raise ValueError(f"invalid heroic V4 keyed source size {keyed.size}")
    source_edges = proportional_edges(keyed.width, FRAME_COUNT)
    frames: list[Image.Image] = []
    registrations: list[dict[str, object]] = []
    for index in range(FRAME_COUNT):
        cell = keyed.crop(
            (source_edges[index], 0, source_edges[index + 1], keyed.height)
        )
        frame, registration = register_frame(cell)
        frames.append(frame)
        registrations.append(registration)

    frame_records = [
        frame_metrics(frame, index, registrations[index])
        for index, frame in enumerate(frames)
    ]
    if len({record["pixelHash"] for record in frame_records}) != FRAME_COUNT:
        raise ValueError("heroic V4 frames are not unique")

    differences = [
        temporal_difference(
            frames[index],
            frames[(index + 1) % FRAME_COUNT],
            index,
            (index + 1) % FRAME_COUNT,
        )
        for index in range(FRAME_COUNT)
    ]
    if min(float(item["changedPixelRatio"]) for item in differences) < 0.25:
        raise ValueError("heroic V4 loop frames are not visually distinct enough")

    atlas = Image.new(
        "RGBA",
        (CELL_WIDTH * FRAME_COUNT, CELL_HEIGHT),
        (0, 0, 0, 0),
    )
    for index, frame in enumerate(frames):
        atlas.alpha_composite(frame, (index * CELL_WIDTH, 0))
    atlas = clear_hidden_rgb(atlas)

    output_rgba = np.asarray(atlas, dtype=np.uint8)
    transparent_rgb_leak = int(
        np.count_nonzero(
            (output_rgba[:, :, 3] == 0)
            & np.any(output_rgba[:, :, :3] != 0, axis=2)
        )
    )
    sub_threshold_rgb_leak = int(
        np.count_nonzero(
            (output_rgba[:, :, 3] < TRANSPARENT_ALPHA_CUTOFF)
            & np.any(output_rgba[:, :, :3] != 0, axis=2)
        )
    )
    if transparent_rgb_leak or sub_threshold_rgb_leak:
        raise ValueError("heroic V4 output retains hidden RGB")

    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    atlas.save(OUTPUT, optimize=True, compress_level=9)

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
            "referenceInput": image_record(REFERENCE_INPUT),
            "promptMetadata": {
                "path": relative(PROMPT_METADATA),
                "sha256": digest(PROMPT_METADATA),
                "tool": prompt_record["tool"],
                "generationPrompt": prompt_record["generationPrompt"],
                "builtInOriginalPath": prompt_record["outputs"][
                    "builtInOriginalPath"
                ],
            },
        },
        "chromaRemoval": prompt_record["chromaRemoval"],
        "pipeline": {
            "split": "four proportional horizontal cells with rounded source edges",
            "sourceFrameEdges": source_edges,
            "resize": "each complete source cell resized once to 256x512 in premultiplied-alpha LANCZOS space",
            "registration": {
                "targetFlareY": TARGET_FLARE_Y,
                "targetLowerEnergyCentroidX": TARGET_LOWER_ENERGY_CENTROID_X,
                "lowerEnergyStartY": LOWER_ENERGY_START_Y,
                "translation": "integer-only; no post-resize scale or stretch",
            },
            "colourGrade": "HSV hue-local green/cyan key-spill rotation into violet; saturation and value preserved",
            "palette": "truecolour; no palette quantization",
            "alpha": "continuous authored alpha; values below 8 cleared with hidden RGB",
            "visibleAlphaThreshold": VISIBLE_ALPHA_THRESHOLD,
            "topProfile": {
                "rows": TOP_PROFILE_ROWS,
                "maxFirstVisibleRun": MAX_FIRST_VISIBLE_RUN,
                "flatPlateauRun": FLAT_PLATEAU_RUN,
            },
            "pixelDifferenceThreshold": PIXEL_DIFFERENCE_THRESHOLD,
        },
        "output": {
            "path": relative(OUTPUT),
            "sha256": digest(OUTPUT),
            "bytes": OUTPUT.stat().st_size,
            "groundAnchor": round(TARGET_FLARE_Y / CELL_HEIGHT, 4),
            "transparentRgbLeak": transparent_rgb_leak,
            "subThresholdRgbLeak": sub_threshold_rgb_leak,
        },
        "frames": frame_records,
        "temporalDifferences": differences,
        "summary": {
            "topPadding": range_summary(frame_records, "topPadding"),
            "bottomPadding": range_summary(frame_records, "bottomPadding"),
            "firstVisibleRowMaxRun": range_summary(
                frame_records, "firstVisibleRowMaxRun"
            ),
            "top24MaxHorizontalRun": range_summary(
                frame_records, "top24MaxHorizontalRun"
            ),
            "flareY": range_summary(frame_records, "flareY"),
            "lowerEnergyCentroidX": range_summary(
                frame_records, "lowerEnergyCentroidX"
            ),
            "brightPixelRatio": range_summary(frame_records, "brightPixelRatio"),
            "purplePixelRatio": range_summary(frame_records, "purplePixelRatio"),
            "magentaCorePixelRatio": range_summary(
                frame_records, "magentaCorePixelRatio"
            ),
            "whiteCorePixelRatio": range_summary(
                frame_records, "whiteCorePixelRatio"
            ),
            "greenCyanSpillRatio": range_summary(
                frame_records, "greenCyanSpillRatio"
            ),
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

    print(relative(OUTPUT), OUTPUT.stat().st_size, digest(OUTPUT)[:12])
    print(relative(REPORT))
    for frame in frame_records:
        print(
            frame["index"],
            "padding", frame["padding"],
            "tipRun", frame["firstVisibleRowMaxRun"],
            "top24Max", frame["top24MaxHorizontalRun"],
            "flare", frame["flareY"],
            "centroidX", frame["lowerEnergyCentroidX"],
            "purple", frame["purplePixelRatio"],
            "bright", frame["brightPixelRatio"],
            "spill", frame["greenCyanSpillRatio"],
        )


if __name__ == "__main__":
    main()
