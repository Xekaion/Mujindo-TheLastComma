"""Build the bright four-frame legacy ARPG cosmic equipped flash atlas."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

import numpy as np
from PIL import Image, ImageEnhance


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "asset-sources" / "legacy-arpg" / "equipped-cosmic-flash-source-v3.png"
OUTPUT = ROOT / "public" / "assets" / "effects" / "equipped-cosmic-flash-v3.png"
REPORT = ROOT / "public" / "assets" / "effects" / "equipped-cosmic-flash-v3.build.json"
FRAME_COUNT = 4
CELL = 256
LOGICAL = CELL // 2
MIN_PADDING = 10
ALPHA_LEVELS = np.array((0, 72, 128, 192, 255), dtype=np.uint8)


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def crop_source_frame(source: Image.Image, index: int) -> Image.Image:
    left = round(index * source.width / FRAME_COUNT)
    right = round((index + 1) * source.width / FRAME_COUNT)
    frame = source.crop((left, 0, right, source.height)).convert("RGBA")
    rgba = np.asarray(frame, dtype=np.uint8).copy()
    rgba[rgba[:, :, 3] < 18, 3] = 0
    return Image.fromarray(rgba, "RGBA")


def hollow_centre(frame: Image.Image) -> Image.Image:
    rgba = np.asarray(frame, dtype=np.uint8).copy()
    yy, xx = np.indices((LOGICAL, LOGICAL))
    cx = cy = (LOGICAL - 1) / 2
    distance = np.sqrt((xx - cx) ** 2 + (yy - cy) ** 2)
    feather = np.clip((distance - 20) / 13, 0, 1)
    rgba[:, :, 3] = np.round(rgba[:, :, 3] * feather).astype(np.uint8)
    return Image.fromarray(rgba, "RGBA")


def build_frame(source_frame: Image.Image, index: int) -> Image.Image:
    bbox = source_frame.getchannel("A").point(lambda value: 255 if value >= 32 else 0).getbbox()
    if bbox is None:
        raise ValueError(f"cosmic source frame {index} is empty")
    motif = source_frame.crop(bbox)
    limit = LOGICAL - MIN_PADDING
    scale = min(limit / motif.width, limit / motif.height)
    motif = motif.resize(
        (max(1, round(motif.width * scale)), max(1, round(motif.height * scale))),
        Image.Resampling.LANCZOS,
    )
    motif = ImageEnhance.Brightness(motif).enhance((0.9, 1.03, 1.15, 0.98)[index])
    frame = Image.new("RGBA", (LOGICAL, LOGICAL), (0, 0, 0, 0))
    frame.alpha_composite(motif, ((LOGICAL - motif.width) // 2, (LOGICAL - motif.height) // 2))
    frame = hollow_centre(frame)
    rgba = np.asarray(frame, dtype=np.uint8).copy()
    alpha = rgba[:, :, 3].astype(np.int16)
    alpha = ALPHA_LEVELS[np.argmin(np.abs(alpha[:, :, None] - ALPHA_LEVELS[None, None, :]), axis=2)]
    rgba[alpha == 0, :3] = 0
    rgba[:, :, 3] = alpha
    return Image.fromarray(rgba, "RGBA").resize((CELL, CELL), Image.Resampling.NEAREST)


def metrics(frame: Image.Image, index: int) -> dict[str, object]:
    rgba = np.asarray(frame, dtype=np.uint8)
    alpha = rgba[:, :, 3]
    bbox = Image.fromarray(alpha, "L").getbbox()
    if bbox is None:
        raise ValueError(f"cosmic frame {index} empty after build")
    left, top, right, bottom = bbox
    if min(left, top, CELL - right, CELL - bottom) < MIN_PADDING:
        raise ValueError(f"cosmic frame {index} padding failure: {bbox}")
    visible = alpha >= 72
    rgb = rgba[:, :, :3]
    luminance = rgb[:, :, 0] * 0.299 + rgb[:, :, 1] * 0.587 + rgb[:, :, 2] * 0.114
    bright = visible & (luminance >= 205)
    cyan = visible & (rgb[:, :, 1] >= rgb[:, :, 0] * 1.08) & (rgb[:, :, 2] >= rgb[:, :, 0] * 1.12)
    violet = visible & (rgb[:, :, 0] >= 110) & (rgb[:, :, 2] >= rgb[:, :, 1] * 1.03)
    count = max(1, int(np.count_nonzero(visible)))
    centre = visible[CELL // 2 - 34 : CELL // 2 + 34, CELL // 2 - 34 : CELL // 2 + 34]
    centre_ratio = float(np.count_nonzero(centre) / centre.size)
    if np.count_nonzero(bright) / count < 0.025:
        raise ValueError(f"cosmic frame {index} is not visibly bright")
    if centre_ratio > 0.22:
        raise ValueError(f"cosmic frame {index} obscures equipped item centre")
    return {
        "frame": index,
        "bbox": list(bbox),
        "visiblePixels": count,
        "brightRatio": round(float(np.count_nonzero(bright) / count), 6),
        "cyanRatio": round(float(np.count_nonzero(cyan) / count), 6),
        "violetRatio": round(float(np.count_nonzero(violet) / count), 6),
        "centreCoverage": round(centre_ratio, 6),
        "pixelHash": hashlib.sha256(frame.tobytes()).hexdigest(),
    }


def main() -> None:
    source = Image.open(SOURCE).convert("RGBA")
    frames = [build_frame(crop_source_frame(source, index), index) for index in range(FRAME_COUNT)]
    frame_metrics = [metrics(frame, index) for index, frame in enumerate(frames)]
    if len({entry["pixelHash"] for entry in frame_metrics}) != FRAME_COUNT:
        raise ValueError("cosmic animation needs four distinct frames")
    atlas = Image.new("RGBA", (CELL * FRAME_COUNT, CELL), (0, 0, 0, 0))
    for index, frame in enumerate(frames):
        atlas.alpha_composite(frame, (index * CELL, 0))
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    atlas.save(OUTPUT, optimize=True)
    report = {
        "version": 3,
        "builder": "scripts/build_equipped_cosmic_flash_v3.py",
        "source": str(SOURCE.relative_to(ROOT)).replace("\\", "/"),
        "sourceSha256": digest(SOURCE),
        "output": str(OUTPUT.relative_to(ROOT)).replace("\\", "/"),
        "outputSha256": digest(OUTPUT),
        "format": "RGBA PNG",
        "atlas": {"columns": FRAME_COUNT, "rows": 1, "cell": [CELL, CELL]},
        "pipeline": {
            "logicalCell": [LOGICAL, LOGICAL],
            "upscale": "nearest-neighbour-2x",
            "alphaLevels": ALPHA_LEVELS.tolist(),
            "centreTreatment": "transparent radial core",
        },
        "frames": frame_metrics,
    }
    REPORT.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(REPORT.relative_to(ROOT))


if __name__ == "__main__":
    main()
