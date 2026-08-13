"""Build persistent tall loot-pillar atlases from two ImageGen sprite sheets."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

import numpy as np
from PIL import Image, ImageEnhance


ROOT = Path(__file__).resolve().parents[1]
SOURCE_ROOT = ROOT / "asset-sources" / "legacy-arpg" / "loot-pillar-v2"
OUTPUT_ROOT = ROOT / "public" / "assets" / "effects"
REPORT = OUTPUT_ROOT / "loot-pillar-v2.build.json"

GROUPS = (
    ("low-rarities-source.png", ("common", "magic", "superior", "rare")),
    ("high-rarities-source.png", ("epic", "legendary", "mythic", "cosmic")),
)
FRAME_COUNT = 4
ROW_COUNT = 4
CELL_WIDTH = 256
CELL_HEIGHT = 512
LOGICAL_WIDTH = CELL_WIDTH // 2
LOGICAL_HEIGHT = CELL_HEIGHT // 2
MIN_X_PADDING = 8
MIN_Y_PADDING = 4
ALPHA_LEVELS = np.array((0, 64, 128, 192, 255), dtype=np.uint8)
MAX_PALETTE_COLOURS = 96


def digest_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def digest(path: Path) -> str:
    return digest_bytes(path.read_bytes())


def edges(length: int, segments: int) -> list[int]:
    return [round(index * length / segments) for index in range(segments + 1)]


def clean_generated_alpha(image: Image.Image) -> Image.Image:
    rgba = np.asarray(image.convert("RGBA"), dtype=np.uint8).copy()
    alpha = rgba[:, :, 3]
    # ImageGen already emitted alpha. Remove compression mist and edge speckles
    # without touching the white-hot core.
    alpha[alpha < 18] = 0
    rgba[:, :, 3] = alpha
    return Image.fromarray(rgba, "RGBA")


def crop_frame(source: Image.Image, row: int, column: int) -> Image.Image:
    xs = edges(source.width, FRAME_COUNT)
    ys = edges(source.height, ROW_COUNT)
    cell = source.crop((xs[column], ys[row], xs[column + 1], ys[row + 1]))
    return clean_generated_alpha(cell)


def visible_bbox(image: Image.Image) -> tuple[int, int, int, int]:
    bbox = image.getchannel("A").point(lambda value: 255 if value >= 32 else 0).getbbox()
    if bbox is None:
        raise ValueError("generated loot pillar contains an empty frame")
    return bbox


def build_frame(cell: Image.Image) -> Image.Image:
    bbox = visible_bbox(cell)
    motif = cell.crop(bbox)
    max_width = LOGICAL_WIDTH - MIN_X_PADDING * 2
    max_height = LOGICAL_HEIGHT - MIN_Y_PADDING * 2
    # The generated grid uses square source cells.  Registering those with a
    # uniform scale recreates the short campfire silhouette the user rejected.
    # The production atlas is intentionally portrait: keep the authored wedge
    # width but stretch its vertical light trail to the full beacon height.
    target_width = min(max_width, max(76, round(max_width * 0.94)))
    size = (target_width, max_height)
    motif = motif.resize(size, Image.Resampling.LANCZOS)
    motif = ImageEnhance.Contrast(motif).enhance(1.08)
    frame = Image.new("RGBA", (LOGICAL_WIDTH, LOGICAL_HEIGHT), (0, 0, 0, 0))
    x = (LOGICAL_WIDTH - motif.width) // 2
    y = LOGICAL_HEIGHT - MIN_Y_PADDING - motif.height
    frame.alpha_composite(motif, (x, y))

    rgba = np.asarray(frame, dtype=np.uint8).copy()
    alpha = rgba[:, :, 3].astype(np.int16)
    alpha = ALPHA_LEVELS[np.argmin(np.abs(alpha[:, :, None] - ALPHA_LEVELS[None, None, :]), axis=2)]
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
    rgb = rgba[:, :, :3]
    luminance = rgb[:, :, 0] * 0.299 + rgb[:, :, 1] * 0.587 + rgb[:, :, 2] * 0.114
    bright = int(np.count_nonzero(visible & (luminance >= 205)))
    visible_count = int(np.count_nonzero(visible))
    if right - left < 68 or bottom - top < 390:
        raise ValueError(f"pillar frame {index} is not tall/full enough: {bbox}")
    if min(left, CELL_WIDTH - right) < MIN_X_PADDING * 2:
        raise ValueError(f"pillar frame {index} horizontal gutter failure: {bbox}")
    if CELL_HEIGHT - bottom < MIN_Y_PADDING * 2:
        raise ValueError(f"pillar frame {index} bottom anchor failure: {bbox}")
    if bright < 120:
        raise ValueError(f"pillar frame {index} lacks a bright core")
    return {
        "frame": index,
        "bbox": list(bbox),
        "visiblePixels": visible_count,
        "brightPixelRatio": round(bright / max(1, visible_count), 6),
        "pixelHash": digest_bytes(frame.tobytes()),
    }


def build_rarity(source: Image.Image, source_name: str, rarity: str, row: int) -> dict[str, object]:
    frames = [build_frame(crop_frame(source, row, column)) for column in range(FRAME_COUNT)]
    metrics = [frame_metrics(frame, index) for index, frame in enumerate(frames)]
    if len({item["pixelHash"] for item in metrics}) != FRAME_COUNT:
        raise ValueError(f"{rarity}: temporal frames are not unique")
    atlas = Image.new("RGBA", (CELL_WIDTH * FRAME_COUNT, CELL_HEIGHT), (0, 0, 0, 0))
    for index, frame in enumerate(frames):
        atlas.alpha_composite(frame, (index * CELL_WIDTH, 0))
    output = OUTPUT_ROOT / f"loot-pillar-{rarity}-v2.png"
    atlas.save(output, optimize=True)
    return {
        "source": f"asset-sources/legacy-arpg/loot-pillar-v2/{source_name}",
        "output": f"public/assets/effects/{output.name}",
        "outputSha256": digest(output),
        "bytes": output.stat().st_size,
        "frames": metrics,
    }


def main() -> None:
    OUTPUT_ROOT.mkdir(parents=True, exist_ok=True)
    results: dict[str, object] = {}
    sources: dict[str, object] = {}
    for source_name, rarities in GROUPS:
        source_path = SOURCE_ROOT / source_name
        source = Image.open(source_path).convert("RGBA")
        sources[source_name] = {
            "sha256": digest(source_path),
            "size": list(source.size),
        }
        for row, rarity in enumerate(rarities):
            results[rarity] = build_rarity(source, source_name, rarity, row)
            print(rarity, results[rarity]["bytes"])
    report = {
        "version": 2,
        "builder": "scripts/build_loot_pillar_v2_assets.py",
        "format": "RGBA PNG",
        "atlas": {"columns": FRAME_COUNT, "rows": 1, "cell": [CELL_WIDTH, CELL_HEIGHT]},
        "pipeline": {
            "logicalCell": [LOGICAL_WIDTH, LOGICAL_HEIGHT],
            "upscale": "nearest-neighbour-2x",
            "alphaLevels": ALPHA_LEVELS.tolist(),
            "maxPaletteColours": MAX_PALETTE_COLOURS,
            "anchor": "bottom-centre",
        },
        "sources": sources,
        "rarities": results,
    }
    REPORT.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(REPORT.relative_to(ROOT))


if __name__ == "__main__":
    main()
