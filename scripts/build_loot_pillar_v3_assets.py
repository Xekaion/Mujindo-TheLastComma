"""Build bright, rarity-correct persistent loot-pillar atlases.

V3 keeps the authored V2 silhouettes for six tiers, moves the former rare
violet loop to epic, and builds rare from a dedicated ImageGen gold source.
The explicit source table prevents tier order from silently becoming a colour
mapping again.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

import numpy as np
from PIL import Image


ROOT = Path(__file__).resolve().parents[1]
LEGACY_SOURCE_ROOT = ROOT / "asset-sources" / "legacy-arpg" / "loot-pillar-v2"
SOURCE_ROOT = ROOT / "asset-sources" / "legacy-arpg" / "loot-pillar-v3"
OUTPUT_ROOT = SOURCE_ROOT / "output"
REPORT = OUTPUT_ROOT / "loot-pillar-v3.build.json"
GENERATION_RECORD = SOURCE_ROOT / "rare-gold-imagegen.json"

SOURCE_MAP = {
    "common": (LEGACY_SOURCE_ROOT / "low-rarities-source.png", 0, 4, "ivory"),
    "magic": (LEGACY_SOURCE_ROOT / "low-rarities-source.png", 1, 4, "blue"),
    "superior": (LEGACY_SOURCE_ROOT / "low-rarities-source.png", 2, 4, "green"),
    "rare": (SOURCE_ROOT / "rare-gold-source-contracted.png", 0, 1, "gold"),
    # The old rare row is the violet effect the user explicitly selected for epic.
    "epic": (LEGACY_SOURCE_ROOT / "low-rarities-source.png", 3, 4, "violet"),
    "legendary": (LEGACY_SOURCE_ROOT / "high-rarities-source.png", 1, 4, "orange"),
    "mythic": (LEGACY_SOURCE_ROOT / "high-rarities-source.png", 2, 4, "magenta"),
    "cosmic": (LEGACY_SOURCE_ROOT / "high-rarities-source.png", 3, 4, "prismatic"),
}

FRAME_COUNT = 4
CELL_WIDTH = 256
CELL_HEIGHT = 512
LOGICAL_WIDTH = CELL_WIDTH // 2
LOGICAL_HEIGHT = CELL_HEIGHT // 2
MIN_X_PADDING = 8
MIN_Y_PADDING = 4
ALPHA_LEVELS = np.array((0, 64, 128, 192, 255), dtype=np.uint8)
MAX_PALETTE_COLOURS = 112

# Lift the whole family out of the muted mid-tones while preserving its tier
# hues. Frame-specific gains make the persistent loop visibly flash instead of
# reading as a static, dim decal.
RGB_GAMMA = 0.78
ALPHA_GAMMA = 0.80
COLOUR_ENHANCE = 1.14
FRAME_FLASH_GAINS = (1.00, 1.10, 1.22, 1.07)
FRAME_ALPHA_GAINS = (1.00, 1.05, 1.12, 1.04)


def digest_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def digest(path: Path) -> str:
    return digest_bytes(path.read_bytes())


def relative(path: Path) -> str:
    return path.relative_to(ROOT).as_posix()


def edges(length: int, segments: int) -> list[int]:
    return [round(index * length / segments) for index in range(segments + 1)]


def clean_generated_alpha(image: Image.Image) -> Image.Image:
    rgba = np.asarray(image.convert("RGBA"), dtype=np.uint8).copy()
    alpha = rgba[:, :, 3]
    alpha[alpha < 18] = 0
    rgba[alpha == 0, :3] = 0
    rgba[:, :, 3] = alpha
    return Image.fromarray(rgba, "RGBA")


def crop_frame(
    source: Image.Image,
    row: int,
    row_count: int,
    column: int,
) -> Image.Image:
    xs = edges(source.width, FRAME_COUNT)
    ys = edges(source.height, row_count)
    cell = source.crop((xs[column], ys[row], xs[column + 1], ys[row + 1]))
    return clean_generated_alpha(cell)


def visible_bbox(image: Image.Image) -> tuple[int, int, int, int]:
    bbox = image.getchannel("A").point(lambda value: 255 if value >= 32 else 0).getbbox()
    if bbox is None:
        raise ValueError("generated loot pillar contains an empty frame")
    return bbox


def grade_rare_gold(image: Image.Image, frame_index: int) -> Image.Image:
    """Remove chroma-key residue and lock rare to a luminous gold ramp."""
    rgba = np.asarray(image.convert("RGBA"), dtype=np.uint8).copy()
    rgb = rgba[:, :, :3].astype(np.float32) / 255.0
    value = np.max(rgb, axis=2)
    value = np.power(value, 1.30) * (0.98 + (FRAME_FLASH_GAINS[frame_index] - 1.0) * 0.32)
    value = np.clip(value, 0.0, 1.0)
    stops = np.array((0.00, 0.42, 0.76, 0.94, 1.00), dtype=np.float32)
    colours = np.array(
        (
            (0.24, 0.07, 0.00),
            (0.70, 0.28, 0.00),
            (1.00, 0.60, 0.00),
            (1.00, 0.84, 0.00),
            (1.00, 0.93, 0.08),
        ),
        dtype=np.float32,
    )
    graded = np.empty_like(rgb)
    for channel in range(3):
        graded[:, :, channel] = np.interp(value, stops, colours[:, channel])
    rgba[:, :, :3] = np.clip(np.round(graded * 255.0), 0, 255).astype(np.uint8)
    height, width = value.shape
    x = np.arange(width, dtype=np.float32)[None, :]
    y = np.arange(height, dtype=np.float32)[:, None]
    centre_distance = np.abs(x - (width - 1) / 2)
    core = (value >= 0.82) & (centre_distance <= max(2.0, width * 0.035))
    core |= (
        (value >= 0.985)
        & (y >= height * 0.86)
        & (centre_distance <= width * 0.16)
    )
    rgba[core, 0] = 255
    rgba[core, 1] = 255
    rgba[core, 2] = 224
    alpha = rgba[:, :, 3].astype(np.float32) / 255.0
    alpha = np.power(alpha, ALPHA_GAMMA) * FRAME_ALPHA_GAINS[frame_index]
    rgba[:, :, 3] = np.clip(np.round(alpha * 255.0), 0, 255).astype(np.uint8)
    rgba[rgba[:, :, 3] == 0, :3] = 0
    return Image.fromarray(rgba, "RGBA")


def brighten_frame(image: Image.Image, frame_index: int) -> Image.Image:
    rgba = np.asarray(image.convert("RGBA"), dtype=np.uint8).copy()
    rgb = rgba[:, :, :3].astype(np.float32) / 255.0
    luminance = np.sum(
        rgb * np.array((0.299, 0.587, 0.114), dtype=np.float32),
        axis=2,
        keepdims=True,
    )
    rgb = luminance + (rgb - luminance) * COLOUR_ENHANCE
    rgb = np.power(np.clip(rgb, 0.0, 1.0), RGB_GAMMA)
    rgb *= FRAME_FLASH_GAINS[frame_index]
    rgba[:, :, :3] = np.clip(np.round(rgb * 255.0), 0, 255).astype(np.uint8)

    alpha = rgba[:, :, 3].astype(np.float32) / 255.0
    alpha = np.power(alpha, ALPHA_GAMMA) * FRAME_ALPHA_GAINS[frame_index]
    rgba[:, :, 3] = np.clip(np.round(alpha * 255.0), 0, 255).astype(np.uint8)
    rgba[rgba[:, :, 3] == 0, :3] = 0
    return Image.fromarray(rgba, "RGBA")


def build_frame(cell: Image.Image, rarity: str, frame_index: int) -> Image.Image:
    bbox = visible_bbox(cell)
    motif = cell.crop(bbox)
    max_width = LOGICAL_WIDTH - MIN_X_PADDING * 2
    max_height = LOGICAL_HEIGHT - MIN_Y_PADDING * 2
    target_width = min(max_width, max(76, round(max_width * 0.94)))
    motif = motif.resize((target_width, max_height), Image.Resampling.LANCZOS)
    if rarity == "rare":
        motif = grade_rare_gold(motif, frame_index)
    else:
        motif = brighten_frame(motif, frame_index)

    frame = Image.new("RGBA", (LOGICAL_WIDTH, LOGICAL_HEIGHT), (0, 0, 0, 0))
    x = (LOGICAL_WIDTH - motif.width) // 2
    y = LOGICAL_HEIGHT - MIN_Y_PADDING - motif.height
    frame.alpha_composite(motif, (x, y))

    rgba = np.asarray(frame, dtype=np.uint8).copy()
    alpha = rgba[:, :, 3].astype(np.int16)
    alpha = ALPHA_LEVELS[
        np.argmin(
            np.abs(alpha[:, :, None] - ALPHA_LEVELS[None, None, :]),
            axis=2,
        )
    ]
    rgba[alpha == 0, :3] = 0
    quantized = Image.fromarray(rgba[:, :, :3], "RGB").quantize(
        colors=MAX_PALETTE_COLOURS,
        method=Image.Quantize.MEDIANCUT,
        dither=Image.Dither.FLOYDSTEINBERG,
    ).convert("RGBA")
    quantized.putalpha(Image.fromarray(alpha, "L"))
    return quantized.resize((CELL_WIDTH, CELL_HEIGHT), Image.Resampling.NEAREST)


def frame_metrics(frame: Image.Image, index: int) -> dict[str, object]:
    bbox = visible_bbox(frame)
    left, top, right, bottom = bbox
    rgba = np.asarray(frame, dtype=np.uint8)
    visible = rgba[:, :, 3] >= 64
    rgb = rgba[:, :, :3].astype(np.float32)
    luminance = np.sum(
        rgb * np.array((0.299, 0.587, 0.114), dtype=np.float32),
        axis=2,
    )
    bright = int(np.count_nonzero(visible & (luminance >= 205)))
    visible_count = int(np.count_nonzero(visible))
    if right - left < 68 or bottom - top < 390:
        raise ValueError(f"pillar frame {index} is not tall/full enough: {bbox}")
    if min(left, CELL_WIDTH - right) < MIN_X_PADDING * 2:
        raise ValueError(f"pillar frame {index} horizontal gutter failure: {bbox}")
    if CELL_HEIGHT - bottom < MIN_Y_PADDING * 2:
        raise ValueError(f"pillar frame {index} bottom anchor failure: {bbox}")
    if bright < 240:
        raise ValueError(f"pillar frame {index} lacks a bright core")

    lower_start = round(CELL_HEIGHT * 0.55)
    row_energy = np.sum(luminance * (rgba[:, :, 3] / 255.0), axis=1)
    flare_y = lower_start + int(np.argmax(row_energy[lower_start:]))
    channel_means = np.mean(rgb[visible], axis=0)
    return {
        "frame": index,
        "bbox": list(bbox),
        "visiblePixels": visible_count,
        "brightPixelRatio": round(bright / max(1, visible_count), 6),
        "meanLuminance": round(float(np.mean(luminance[visible])), 3),
        "meanRgb": [round(float(value), 3) for value in channel_means],
        "flareY": flare_y,
        "pixelHash": digest_bytes(frame.tobytes()),
    }


def build_rarity(
    rarity: str,
    source_path: Path,
    row: int,
    row_count: int,
    colour_family: str,
) -> dict[str, object]:
    source = Image.open(source_path).convert("RGBA")
    frames = [
        build_frame(crop_frame(source, row, row_count, column), rarity, column)
        for column in range(FRAME_COUNT)
    ]
    metrics = [frame_metrics(frame, index) for index, frame in enumerate(frames)]
    if len({item["pixelHash"] for item in metrics}) != FRAME_COUNT:
        raise ValueError(f"{rarity}: temporal frames are not unique")

    atlas = Image.new("RGBA", (CELL_WIDTH * FRAME_COUNT, CELL_HEIGHT), (0, 0, 0, 0))
    for index, frame in enumerate(frames):
        atlas.alpha_composite(frame, (index * CELL_WIDTH, 0))
    output = OUTPUT_ROOT / f"loot-pillar-{rarity}-v3.png"
    atlas.save(output, optimize=True)
    return {
        "source": relative(source_path),
        "sourceRow": row,
        "sourceRows": row_count,
        "colourFamily": colour_family,
        "output": relative(output),
        "outputSha256": digest(output),
        "bytes": output.stat().st_size,
        "groundAnchor": round(
            float(np.median([frame["flareY"] for frame in metrics])) / CELL_HEIGHT,
            4,
        ),
        "frames": metrics,
    }


def main() -> None:
    OUTPUT_ROOT.mkdir(parents=True, exist_ok=True)
    generation = json.loads(GENERATION_RECORD.read_text(encoding="utf-8"))
    sources: dict[str, object] = {}
    for source_path, _row, _row_count, _colour_family in SOURCE_MAP.values():
        key = relative(source_path)
        if key not in sources:
            source = Image.open(source_path)
            sources[key] = {
                "sha256": digest(source_path),
                "size": list(source.size),
                "mode": source.mode,
            }

    results = {
        rarity: build_rarity(rarity, *spec)
        for rarity, spec in SOURCE_MAP.items()
    }
    report = {
        "version": 3,
        "builder": relative(Path(__file__)),
        "format": "RGBA PNG",
        "atlas": {"columns": FRAME_COUNT, "rows": 1, "cell": [CELL_WIDTH, CELL_HEIGHT]},
        "pipeline": {
            "logicalCell": [LOGICAL_WIDTH, LOGICAL_HEIGHT],
            "upscale": "nearest-neighbour-2x",
            "alphaLevels": ALPHA_LEVELS.tolist(),
            "maxPaletteColours": MAX_PALETTE_COLOURS,
            "anchor": "measured-lower-flare-centre",
            "rgbGamma": RGB_GAMMA,
            "alphaGamma": ALPHA_GAMMA,
            "colourEnhance": COLOUR_ENHANCE,
            "frameFlashGains": list(FRAME_FLASH_GAINS),
            "frameAlphaGains": list(FRAME_ALPHA_GAINS),
            "rareColourGrade": "white-hot lemon-gold-to-amber ramp",
        },
        "sources": sources,
        "imagegen": generation,
        "rarities": results,
    }
    REPORT.write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    for rarity, record in results.items():
        print(rarity, record["bytes"], record["groundAnchor"])
    print(relative(REPORT))


if __name__ == "__main__":
    main()
