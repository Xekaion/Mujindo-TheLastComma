"""Build crop-safe persistent loot pillars for every active V3 tier.

The old V3 builder sliced tightly stacked source rows.  That preserved a flat
cut at the top of high-tier pillars and enlarged the next rarity's tip below
the floor flare.  V5 has two explicit source paths:

* common, magic and superior keep their approved V3 art, but remove only the
  foreign below-floor row fragment before one fixed sequence transform;
* rare, legendary, mythic and cosmic use dedicated ImageGen four-frame strips
  with recorded chroma-key provenance.

Every sequence is scaled uniformly, registered to one authored floor row and
validated for tapered tips, safe gutters and detached below-floor fragments.
"""

from __future__ import annotations

from collections import deque
import hashlib
import json
from pathlib import Path

import numpy as np
from PIL import Image


ROOT = Path(__file__).resolve().parents[1]
EFFECT_ROOT = ROOT / "public/assets/effects"
IMAGEGEN_ROOT = ROOT / "asset-sources/imagegen"
LEGACY_V3_OUTPUT_ROOT = ROOT / "asset-sources/legacy-arpg/loot-pillar-v3/output"
PROMPT_METADATA = IMAGEGEN_ROOT / "loot-pillar-v5.prompt.json"
REPORT = EFFECT_ROOT / "loot-pillar-v5.build.json"

FRAME_COUNT = 4
CELL_WIDTH = 256
CELL_HEIGHT = 512
TARGET_FLARE_Y = 475
MIN_TOP_PADDING = 24
MIN_SIDE_PADDING = 8
MIN_BOTTOM_PADDING = 8
VISIBLE_ALPHA_THRESHOLD = 64
TRANSPARENT_ALPHA_CUTOFF = 8
BRIGHT_LUMINANCE_THRESHOLD = 205.0
MAX_FIRST_VISIBLE_RUN = 4
TOP_PROFILE_ROWS = 12
FLAT_PLATEAU_RUN = 12
PIXEL_DIFFERENCE_THRESHOLD = 16
LEGACY_TAIL_FULL_ALPHA_ROWS = 12
LEGACY_TAIL_FADE_ROWS = 8
IMAGEGEN_TAIL_FULL_ALPHA_ROWS = 20
IMAGEGEN_TAIL_FADE_ROWS = 18

SOURCE_SPECS = {
    "common": {
        "kind": "legacy-tail-cleanup",
        "path": LEGACY_V3_OUTPUT_ROOT / "loot-pillar-common-v3.png",
    },
    "magic": {
        "kind": "legacy-tail-cleanup",
        "path": LEGACY_V3_OUTPUT_ROOT / "loot-pillar-magic-v3.png",
    },
    "superior": {
        "kind": "legacy-tail-cleanup",
        "path": LEGACY_V3_OUTPUT_ROOT / "loot-pillar-superior-v3.png",
    },
    "rare": {
        "kind": "imagegen-four-frame",
        "path": IMAGEGEN_ROOT / "loot-pillar-rare-v5-keyed.png",
        "generated": IMAGEGEN_ROOT / "loot-pillar-rare-v5-source.png",
    },
    "legendary": {
        "kind": "imagegen-four-frame",
        "path": IMAGEGEN_ROOT / "loot-pillar-legendary-v5-keyed.png",
        "generated": IMAGEGEN_ROOT / "loot-pillar-legendary-v5-source.png",
    },
    "mythic": {
        "kind": "imagegen-four-frame",
        "path": IMAGEGEN_ROOT / "loot-pillar-mythic-v5-keyed.png",
        "generated": IMAGEGEN_ROOT / "loot-pillar-mythic-v5-source.png",
    },
    "cosmic": {
        "kind": "imagegen-four-frame",
        "path": IMAGEGEN_ROOT / "loot-pillar-cosmic-v5-keyed.png",
        "generated": IMAGEGEN_ROOT / "loot-pillar-cosmic-v5-source.png",
    },
}


def digest_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def digest(path: Path) -> str:
    return digest_bytes(path.read_bytes())


def relative(path: Path) -> str:
    return path.relative_to(ROOT).as_posix()


def rounded(value: float) -> float:
    return round(float(value), 6)


def proportional_edges(length: int, segments: int) -> list[int]:
    return [round(index * length / segments) for index in range(segments + 1)]


def clear_hidden_rgb(image: Image.Image) -> Image.Image:
    rgba = np.asarray(image.convert("RGBA"), dtype=np.uint8).copy()
    alpha = rgba[:, :, 3]
    alpha[alpha < TRANSPARENT_ALPHA_CUTOFF] = 0
    rgba[alpha == 0, :3] = 0
    rgba[:, :, 3] = alpha
    return Image.fromarray(rgba, "RGBA")


def premultiplied_resize(image: Image.Image, size: tuple[int, int]) -> Image.Image:
    return image.convert("RGBa").resize(size, Image.Resampling.LANCZOS).convert("RGBA")


def luminance_array(rgba: np.ndarray) -> np.ndarray:
    return np.sum(
        rgba[:, :, :3].astype(np.float32)
        * np.array((0.299, 0.587, 0.114), dtype=np.float32),
        axis=2,
    )


def alpha_bbox(image: Image.Image, threshold: int) -> tuple[int, int, int, int]:
    alpha = np.asarray(image.convert("RGBA"), dtype=np.uint8)[:, :, 3]
    support = Image.fromarray(np.where(alpha >= threshold, 255, 0).astype(np.uint8), "L")
    bbox = support.getbbox()
    if bbox is None:
        raise ValueError(f"empty loot pillar frame at threshold {threshold}")
    return bbox


def measure_flare_y(image: Image.Image) -> int:
    rgba = np.asarray(image.convert("RGBA"), dtype=np.uint8)
    alpha = rgba[:, :, 3].astype(np.float32) / 255.0
    row_energy = np.sum(luminance_array(rgba) * alpha, axis=1)
    start = min(image.height - 1, round(image.height * 0.55))
    return start + int(np.argmax(row_energy[start:]))


def clean_legacy_tail(image: Image.Image) -> tuple[Image.Image, dict[str, int]]:
    """Remove only the next-row point below an approved low-tier floor flare."""
    image = clear_hidden_rgb(image)
    flare_y = measure_flare_y(image)
    rgba = np.asarray(image.convert("RGBA"), dtype=np.uint8).copy()
    alpha = rgba[:, :, 3].astype(np.float32)
    fade_start = flare_y + LEGACY_TAIL_FULL_ALPHA_ROWS
    clear_start = fade_start + LEGACY_TAIL_FADE_ROWS
    for y in range(max(0, fade_start + 1), min(image.height, clear_start + 1)):
        remaining = (clear_start - y) / max(1, LEGACY_TAIL_FADE_ROWS)
        alpha[y] *= max(0.0, remaining)
    if clear_start + 1 < image.height:
        alpha[clear_start + 1 :] = 0
    rgba[:, :, 3] = np.clip(np.rint(alpha), 0, 255).astype(np.uint8)
    rgba[rgba[:, :, 3] == 0, :3] = 0
    return clear_hidden_rgb(Image.fromarray(rgba, "RGBA")), {
        "sourceFlareY": flare_y,
        "fadeStartY": fade_start,
        "clearAfterY": clear_start,
    }


def clean_imagegen_tail(image: Image.Image) -> tuple[Image.Image, dict[str, int]]:
    """Keep the authored floor burst while discarding reflection/noise below it."""
    image = clear_hidden_rgb(image)
    flare_y = measure_flare_y(image)
    rgba = np.asarray(image.convert("RGBA"), dtype=np.uint8).copy()
    alpha = rgba[:, :, 3].astype(np.float32)
    fade_start = flare_y + IMAGEGEN_TAIL_FULL_ALPHA_ROWS
    clear_start = fade_start + IMAGEGEN_TAIL_FADE_ROWS
    for y in range(max(0, fade_start + 1), min(image.height, clear_start + 1)):
        remaining = (clear_start - y) / max(1, IMAGEGEN_TAIL_FADE_ROWS)
        alpha[y] *= max(0.0, remaining)
    if clear_start + 1 < image.height:
        alpha[clear_start + 1 :] = 0
    rgba[:, :, 3] = np.clip(np.rint(alpha), 0, 255).astype(np.uint8)
    rgba[rgba[:, :, 3] == 0, :3] = 0
    return clear_hidden_rgb(Image.fromarray(rgba, "RGBA")), {
        "sourceFlareY": flare_y,
        "fadeStartY": fade_start,
        "clearAfterY": clear_start,
    }


def split_frames(source: Image.Image, kind: str) -> tuple[list[Image.Image], list[dict[str, int]]]:
    edges = proportional_edges(source.width, FRAME_COUNT)
    frames: list[Image.Image] = []
    cleanup: list[dict[str, int]] = []
    for index in range(FRAME_COUNT):
        frame = source.crop((edges[index], 0, edges[index + 1], source.height))
        frame = clear_hidden_rgb(frame)
        if kind == "legacy-tail-cleanup":
            frame, cleanup_record = clean_legacy_tail(frame)
        else:
            frame, cleanup_record = clean_imagegen_tail(frame)
        frames.append(frame)
        cleanup.append(cleanup_record)
    return frames, cleanup


def sequence_scale(frames: list[Image.Image]) -> tuple[float, list[dict[str, float]]]:
    records: list[dict[str, float]] = []
    for frame in frames:
        left, top, right, bottom = alpha_bbox(frame, VISIBLE_ALPHA_THRESHOLD)
        flare_y = measure_flare_y(frame)
        records.append(
            {
                "left": left,
                "top": top,
                "right": right,
                "bottom": bottom,
                "flareY": flare_y,
                "upperSpan": max(1, flare_y - top),
                "lowerSpan": max(1, bottom - 1 - flare_y),
                "width": right - left,
                "centreX": (left + right - 1) / 2,
            }
        )

    # Two pixels of build slack protect the contract against LANCZOS fringe.
    upper_scale = (TARGET_FLARE_Y - MIN_TOP_PADDING - 2) / max(
        record["upperSpan"] for record in records
    )
    lower_scale = (
        CELL_HEIGHT - MIN_BOTTOM_PADDING - 2 - TARGET_FLARE_Y
    ) / max(record["lowerSpan"] for record in records)
    width_scale = (CELL_WIDTH - (MIN_SIDE_PADDING + 2) * 2) / max(
        record["width"] for record in records
    )
    scale = min(1.0, upper_scale, lower_scale, width_scale)
    if not 0.05 <= scale <= 1.0:
        raise ValueError(f"invalid fixed loot-pillar sequence scale {scale}")
    return scale, records


def translate_frame(image: Image.Image, dx: int, dy: int) -> Image.Image:
    translated = Image.new("RGBA", image.size, (0, 0, 0, 0))
    translated.alpha_composite(image, (dx, dy))
    return clear_hidden_rgb(translated)


def restore_tapered_tip(image: Image.Image) -> Image.Image:
    """Reconstruct a tiny pointed cap when a legacy crop starts on a flat row."""
    rgba = np.asarray(image.convert("RGBA"), dtype=np.uint8)
    support = rgba[:, :, 3] >= VISIBLE_ALPHA_THRESHOLD
    bbox = alpha_bbox(image, VISIBLE_ALPHA_THRESHOLD)
    top = bbox[1]
    first_run = maximum_horizontal_run(support[top])
    if first_run <= MAX_FIRST_VISIBLE_RUN:
        return image

    xs = np.flatnonzero(support[top])
    if not len(xs):
        return image
    centre = int(round(float(np.mean(xs))))
    sample_top = top
    sample_bottom = min(image.height, top + 6)
    sample_left = max(0, centre - 2)
    sample_right = min(image.width, centre + 3)
    sample = rgba[sample_top:sample_bottom, sample_left:sample_right]
    sample_alpha = sample[:, :, 3]
    if not np.count_nonzero(sample_alpha):
        return image
    weighted = sample[:, :, :3].astype(np.float32) * sample_alpha[:, :, None]
    colour = np.sum(weighted, axis=(0, 1)) / max(1.0, float(np.sum(sample_alpha)))

    restored = rgba.copy()
    cap_height = min(14, top - MIN_TOP_PADDING)
    if cap_height <= 1:
        return image
    for offset in range(1, cap_height + 1):
        y = top - offset
        progress = (cap_height + 1 - offset) / cap_height
        half_width = max(0, round(progress * 3.5))
        peak_alpha = round(220 * progress)
        for x in range(max(0, centre - half_width), min(image.width, centre + half_width + 1)):
            distance = abs(x - centre) / max(1, half_width + 1)
            alpha = round(peak_alpha * (1.0 - distance * 0.55))
            if alpha > restored[y, x, 3]:
                restored[y, x, :3] = np.clip(np.rint(colour), 0, 255).astype(np.uint8)
                restored[y, x, 3] = alpha
    return clear_hidden_rgb(Image.fromarray(restored, "RGBA"))


def remove_detached_below_floor(image: Image.Image) -> Image.Image:
    """Clear isolated keyed specks below the floor without touching the floor burst."""
    rgba = np.asarray(image.convert("RGBA"), dtype=np.uint8).copy()
    support = rgba[:, :, 3] >= VISIBLE_ALPHA_THRESHOLD
    flare_y = measure_flare_y(image)
    height, width = support.shape
    visited = np.zeros_like(support, dtype=np.bool_)
    for start_y in range(flare_y + 5, height):
        for start_x in range(width):
            if not support[start_y, start_x] or visited[start_y, start_x]:
                continue
            queue = deque(((start_x, start_y),))
            visited[start_y, start_x] = True
            pixels: list[tuple[int, int]] = []
            touches_floor_band = False
            while queue:
                x, y = queue.popleft()
                pixels.append((x, y))
                touches_floor_band |= flare_y - 4 <= y <= flare_y + 4
                for nx, ny in ((x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)):
                    if (
                        0 <= nx < width
                        and 0 <= ny < height
                        and support[ny, nx]
                        and not visited[ny, nx]
                    ):
                        visited[ny, nx] = True
                        queue.append((nx, ny))
            if not touches_floor_band:
                for x, y in pixels:
                    rgba[y, x] = 0
    return clear_hidden_rgb(Image.fromarray(rgba, "RGBA"))


def register_sequence(frames: list[Image.Image]) -> tuple[list[Image.Image], float, list[dict[str, object]]]:
    scale, source_records = sequence_scale(frames)
    built: list[Image.Image] = []
    registrations: list[dict[str, object]] = []
    for frame, source_record in zip(frames, source_records, strict=True):
        soft_bbox = alpha_bbox(frame, TRANSPARENT_ALPHA_CUTOFF)
        motif = frame.crop(soft_bbox)
        size = (
            max(1, round(motif.width * scale)),
            max(1, round(motif.height * scale)),
        )
        motif = premultiplied_resize(motif, size)
        source_centre_in_motif = source_record["centreX"] - soft_bbox[0]
        source_flare_in_motif = source_record["flareY"] - soft_bbox[1]
        x = round(CELL_WIDTH / 2 - source_centre_in_motif * scale)
        y = round(TARGET_FLARE_Y - source_flare_in_motif * scale)
        output = Image.new("RGBA", (CELL_WIDTH, CELL_HEIGHT), (0, 0, 0, 0))
        output.alpha_composite(motif, (x, y))
        output = clear_hidden_rgb(output)

        measured_flare = measure_flare_y(output)
        correction_y = TARGET_FLARE_Y - measured_flare
        if correction_y:
            output = translate_frame(output, 0, correction_y)
        output = restore_tapered_tip(output)
        output = remove_detached_below_floor(output)
        measured_flare = measure_flare_y(output)
        if measured_flare != TARGET_FLARE_Y:
            raise ValueError(f"floor registration failed: {measured_flare}")

        built.append(output)
        registrations.append(
            {
                "sourceStrongBbox": [
                    int(source_record["left"]),
                    int(source_record["top"]),
                    int(source_record["right"]),
                    int(source_record["bottom"]),
                ],
                "sourceFlareY": int(source_record["flareY"]),
                "sourceSoftBbox": list(soft_bbox),
                "paste": [x, y + correction_y],
                "correctionY": correction_y,
            }
        )
    return built, scale, registrations


def maximum_horizontal_run(row: np.ndarray) -> int:
    maximum = 0
    current = 0
    for value in row:
        if value:
            current += 1
            maximum = max(maximum, current)
        else:
            current = 0
    return maximum


def detached_bottom_components(support: np.ndarray, flare_y: int) -> tuple[int, int]:
    height, width = support.shape
    visited = np.zeros_like(support, dtype=np.bool_)
    detached_components = 0
    detached_pixels = 0
    for start_y in range(height):
        for start_x in range(width):
            if not support[start_y, start_x] or visited[start_y, start_x]:
                continue
            queue = deque(((start_x, start_y),))
            visited[start_y, start_x] = True
            pixels = 0
            touches_floor_band = False
            reaches_below_floor = False
            while queue:
                x, y = queue.popleft()
                pixels += 1
                touches_floor_band |= flare_y - 4 <= y <= flare_y + 4
                reaches_below_floor |= y > flare_y + 4
                for nx, ny in ((x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)):
                    if (
                        0 <= nx < width
                        and 0 <= ny < height
                        and support[ny, nx]
                        and not visited[ny, nx]
                    ):
                        visited[ny, nx] = True
                        queue.append((nx, ny))
            if reaches_below_floor and not touches_floor_band:
                detached_components += 1
                detached_pixels += pixels
    return detached_components, detached_pixels


def colour_family_ratios(colours: np.ndarray) -> dict[str, float]:
    rgb = colours.astype(np.float32) / 255.0
    maximum = np.max(rgb, axis=1)
    minimum = np.min(rgb, axis=1)
    delta = maximum - minimum
    saturation = np.divide(delta, maximum, out=np.zeros_like(delta), where=maximum > 1e-7)
    hue = np.zeros_like(maximum)
    chromatic = delta > 1e-7
    red, green, blue = rgb[:, 0], rgb[:, 1], rgb[:, 2]
    red_max = chromatic & (maximum == red)
    green_max = chromatic & (maximum == green)
    blue_max = chromatic & (maximum == blue)
    hue[red_max] = 60.0 * np.mod((green[red_max] - blue[red_max]) / delta[red_max], 6.0)
    hue[green_max] = 60.0 * ((blue[green_max] - red[green_max]) / delta[green_max] + 2.0)
    hue[blue_max] = 60.0 * ((red[blue_max] - green[blue_max]) / delta[blue_max] + 4.0)
    gold = (hue >= 35) & (hue <= 66) & (saturation >= 0.34) & (maximum >= 0.32)
    cyan = (hue >= 165) & (hue <= 205) & (saturation >= 0.28) & (maximum >= 0.35)
    orange = (hue >= 8) & (hue < 35) & (saturation >= 0.42) & (maximum >= 0.38)
    magenta = ((hue >= 290) | (hue <= 8)) & (saturation >= 0.28) & (maximum >= 0.35)
    white = (saturation <= 0.18) & (maximum >= 0.78)
    count = max(1, len(colours))
    return {
        "goldPixelRatio": rounded(np.count_nonzero(gold) / count),
        "cyanPixelRatio": rounded(np.count_nonzero(cyan) / count),
        "orangePixelRatio": rounded(np.count_nonzero(orange) / count),
        "magentaPixelRatio": rounded(np.count_nonzero(magenta) / count),
        "whitePixelRatio": rounded(np.count_nonzero(white) / count),
    }


def frame_metrics(frame: Image.Image, index: int) -> dict[str, object]:
    rgba = np.asarray(frame.convert("RGBA"), dtype=np.uint8)
    alpha = rgba[:, :, 3]
    support = alpha >= VISIBLE_ALPHA_THRESHOLD
    visible_count = int(np.count_nonzero(support))
    if not visible_count:
        raise ValueError(f"V5 frame {index} is empty")
    left, top, right, bottom = alpha_bbox(frame, VISIBLE_ALPHA_THRESHOLD)
    row_runs = [maximum_horizontal_run(row) for row in support]
    first_visible_run = row_runs[top]
    top_runs = row_runs[top : top + TOP_PROFILE_ROWS]
    flat_plateau_rows: list[list[int]] = []
    for offset in range(max(0, len(top_runs) - 3)):
        plateau = top_runs[offset : offset + 4]
        if min(plateau) >= FLAT_PLATEAU_RUN and max(plateau) - min(plateau) <= 2:
            flat_plateau_rows.append([top + offset, *plateau])
    flare_y = measure_flare_y(frame)
    detached_components, detached_pixels = detached_bottom_components(support, flare_y)
    colours = rgba[:, :, :3][support]
    luminance = np.sum(
        colours.astype(np.float32)
        * np.array((0.299, 0.587, 0.114), dtype=np.float32),
        axis=1,
    )
    metrics: dict[str, object] = {
        "index": index,
        "bbox": [left, top, right, bottom],
        "padding": [left, top, CELL_WIDTH - right, CELL_HEIGHT - bottom],
        "firstVisibleRowMaxRun": first_visible_run,
        "top24MaxHorizontalRun": max(top_runs),
        "flatPlateauRows": flat_plateau_rows,
        "flareY": flare_y,
        "tailDepth": bottom - 1 - flare_y,
        "detachedBottomComponents": detached_components,
        "detachedBottomPixels": detached_pixels,
        "visiblePixels": visible_count,
        "coverage": rounded(visible_count / (CELL_WIDTH * CELL_HEIGHT)),
        "alphaMass": rounded(np.sum(alpha) / (255.0 * CELL_WIDTH * CELL_HEIGHT)),
        "brightPixelRatio": rounded(
            np.count_nonzero(luminance >= BRIGHT_LUMINANCE_THRESHOLD) / visible_count
        ),
        "meanRgb": [rounded(value) for value in np.mean(colours, axis=0)],
        "pixelHash": digest_bytes(frame.tobytes()),
        **colour_family_ratios(colours),
    }

    if top < MIN_TOP_PADDING:
        raise ValueError(f"V5 frame {index} top padding is only {top}px")
    if CELL_HEIGHT - bottom < MIN_BOTTOM_PADDING:
        raise ValueError(f"V5 frame {index} bottom padding is only {CELL_HEIGHT - bottom}px")
    if min(left, CELL_WIDTH - right) < MIN_SIDE_PADDING:
        raise ValueError(f"V5 frame {index} touches a side gutter: {metrics['padding']}")
    if first_visible_run > MAX_FIRST_VISIBLE_RUN:
        raise ValueError(f"V5 frame {index} starts with a {first_visible_run}px flat cut")
    if flat_plateau_rows:
        raise ValueError(f"V5 frame {index} retains a flat top plateau: {flat_plateau_rows}")
    if flare_y != TARGET_FLARE_Y:
        raise ValueError(f"V5 frame {index} flare moved to {flare_y}")
    if detached_components:
        raise ValueError(
            f"V5 frame {index} retains {detached_components} detached below-floor components"
        )
    if metrics["brightPixelRatio"] < 0.05:
        raise ValueError(f"V5 frame {index} lacks a bright core")
    return metrics


def temporal_difference(first: Image.Image, second: Image.Image, start: int, end: int) -> dict[str, object]:
    a = np.asarray(first.convert("RGBA"), dtype=np.int16)
    b = np.asarray(second.convert("RGBA"), dtype=np.int16)
    support_a = a[:, :, 3] >= VISIBLE_ALPHA_THRESHOLD
    support_b = b[:, :, 3] >= VISIBLE_ALPHA_THRESHOLD
    union = support_a | support_b
    intersection = support_a & support_b
    difference = np.abs(a - b)
    changed = np.any(difference >= PIXEL_DIFFERENCE_THRESHOLD, axis=2) & union
    union_count = max(1, int(np.count_nonzero(union)))
    return {
        "from": start,
        "to": end,
        "alphaSupportIou": rounded(np.count_nonzero(intersection) / union_count),
        "changedPixelRatio": rounded(np.count_nonzero(changed) / union_count),
        "meanAbsoluteRgbDelta": rounded(np.mean(difference[:, :, :3][union])),
        "meanAbsoluteAlphaDelta": rounded(np.mean(difference[:, :, 3][union])),
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


def build_rarity(rarity: str, spec: dict[str, object]) -> dict[str, object]:
    source_path = spec["path"]
    if not isinstance(source_path, Path) or not source_path.exists():
        raise FileNotFoundError(source_path)
    source = Image.open(source_path).convert("RGBA")
    frames, cleanup = split_frames(source, str(spec["kind"]))
    frames, scale, registrations = register_sequence(frames)
    frame_records = [frame_metrics(frame, index) for index, frame in enumerate(frames)]
    if len({record["pixelHash"] for record in frame_records}) != FRAME_COUNT:
        raise ValueError(f"{rarity} V5 frames are not unique")
    temporal = [
        temporal_difference(frames[index], frames[(index + 1) % FRAME_COUNT], index, (index + 1) % FRAME_COUNT)
        for index in range(FRAME_COUNT)
    ]
    if rarity == "rare":
        if min(float(record["coverage"]) for record in frame_records) < 0.20:
            raise ValueError("rare V5 is still too sparse at gameplay scale")
        if min(float(record["goldPixelRatio"]) for record in frame_records) < 0.12:
            raise ValueError("rare V5 lost its yellow-gold identity")
        if min(float(item["alphaSupportIou"]) for item in temporal) < 0.55:
            raise ValueError("rare V5 frames replace the motif instead of animating it")

    atlas = Image.new("RGBA", (CELL_WIDTH * FRAME_COUNT, CELL_HEIGHT), (0, 0, 0, 0))
    for index, frame in enumerate(frames):
        atlas.alpha_composite(frame, (index * CELL_WIDTH, 0))
    atlas = clear_hidden_rgb(atlas)
    output = EFFECT_ROOT / f"loot-pillar-{rarity}-v5.png"
    atlas.save(output, optimize=True, compress_level=9)
    if output.stat().st_size > 1_000_000:
        raise ValueError(f"{relative(output)} exceeds the 1 MB decode budget")

    source_records = {"productionSource": image_record(source_path)}
    generated_path = spec.get("generated")
    if isinstance(generated_path, Path):
        if not generated_path.exists():
            raise FileNotFoundError(generated_path)
        source_records["generatedSource"] = image_record(generated_path)
    return {
        "kind": spec["kind"],
        "sources": source_records,
        "fixedSequenceScale": rounded(scale),
        "cleanup": cleanup,
        "registrations": registrations,
        "output": {
            "path": relative(output),
            "sha256": digest(output),
            "bytes": output.stat().st_size,
            "groundAnchor": rounded(TARGET_FLARE_Y / CELL_HEIGHT),
        },
        "frames": frame_records,
        "temporalDifferences": temporal,
    }


def main() -> None:
    if not PROMPT_METADATA.exists():
        raise FileNotFoundError(PROMPT_METADATA)
    prompt_metadata = json.loads(PROMPT_METADATA.read_text(encoding="utf-8"))
    EFFECT_ROOT.mkdir(parents=True, exist_ok=True)
    rarities = {
        rarity: build_rarity(rarity, spec)
        for rarity, spec in SOURCE_SPECS.items()
    }
    report = {
        "version": 5,
        "builder": relative(Path(__file__)),
        "format": "rgba-png",
        "atlas": {
            "columns": FRAME_COUNT,
            "rows": 1,
            "cell": [CELL_WIDTH, CELL_HEIGHT],
            "size": [CELL_WIDTH * FRAME_COUNT, CELL_HEIGHT],
        },
        "contract": {
            "targetFlareY": TARGET_FLARE_Y,
            "minimumTopPadding": MIN_TOP_PADDING,
            "minimumSidePadding": MIN_SIDE_PADDING,
            "minimumBottomPadding": MIN_BOTTOM_PADDING,
            "visibleAlphaThreshold": VISIBLE_ALPHA_THRESHOLD,
            "maximumFirstVisibleRun": MAX_FIRST_VISIBLE_RUN,
            "detachedBottomComponents": 0,
            "resize": "one uniform scale per four-frame sequence in premultiplied-alpha LANCZOS space",
            "legacyTailCleanup": {
                "fullAlphaRowsAfterFlare": LEGACY_TAIL_FULL_ALPHA_ROWS,
                "fadeRows": LEGACY_TAIL_FADE_ROWS,
            },
            "imagegenTailCleanup": {
                "fullAlphaRowsAfterFlare": IMAGEGEN_TAIL_FULL_ALPHA_ROWS,
                "fadeRows": IMAGEGEN_TAIL_FADE_ROWS,
            },
        },
        "promptMetadata": {
            "path": relative(PROMPT_METADATA),
            "sha256": digest(PROMPT_METADATA),
            "tool": prompt_metadata["tool"],
            "assets": prompt_metadata["assets"],
        },
        "rarities": rarities,
    }
    REPORT.write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(relative(REPORT))
    for rarity, record in rarities.items():
        summary = [
            (frame["padding"], frame["firstVisibleRowMaxRun"], frame["tailDepth"])
            for frame in record["frames"]
        ]
        print(rarity, record["output"]["bytes"], record["fixedSequenceScale"], summary)


if __name__ == "__main__":
    main()
