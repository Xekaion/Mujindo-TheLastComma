"""Build the native-ratio enhancement button from its keyed ImageGen source."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

import numpy as np
from PIL import Image


ROOT = Path(__file__).resolve().parents[1]
SOURCE_ROOT = ROOT / "asset-sources/imagegen"
SOURCE = SOURCE_ROOT / "inventory-enhancement-button-v1-source.png"
KEYED = SOURCE_ROOT / "inventory-enhancement-button-v1-keyed.png"
PROMPT = SOURCE_ROOT / "inventory-enhancement-button-v1.prompt.json"
REFERENCES = [
    SOURCE_ROOT / "inventory-enhancement-button-v1-problem-reference.png",
    ROOT / "public/assets/ui/inventory-chrome/primary-button.png",
]
DRAFTS = [
    SOURCE_ROOT / "inventory-enhancement-button-v1-draft-1.png",
    SOURCE_ROOT / "inventory-enhancement-button-v1-draft-2.png",
]
OUTPUT = ROOT / "public/assets/ui/inventory-chrome/enhancement-button-v1.png"
REPORT = ROOT / "public/assets/ui/inventory-chrome/enhancement-button-v1.build.json"

EXPECTED_SOURCE_SIZE = (1462, 1076)
ALPHA_THRESHOLD = 4
GUTTER = 2
MIN_VISIBLE_ASPECT = 13.0
MAX_VISIBLE_ASPECT = 14.0


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def describe_file(path: Path) -> dict[str, object]:
    return {
        "path": path.relative_to(ROOT).as_posix(),
        "sha256": sha256(path),
        "bytes": path.stat().st_size,
    }


def describe_image(path: Path) -> dict[str, object]:
    with Image.open(path) as image:
        return {
            **describe_file(path),
            "size": list(image.size),
            "mode": image.mode,
        }


def clean_rgba(image: Image.Image) -> Image.Image:
    rgba = np.asarray(image.convert("RGBA"), dtype=np.uint8).copy()
    rgba[rgba[..., 3] < ALPHA_THRESHOLD] = 0
    rgba[rgba[..., 3] == 0, :3] = 0
    return Image.fromarray(rgba, "RGBA")


def main() -> None:
    prompt = json.loads(PROMPT.read_text(encoding="utf-8"))
    with Image.open(SOURCE) as source:
        if source.size != EXPECTED_SOURCE_SIZE:
            raise RuntimeError(f"Unexpected ImageGen source size: {source.size}")
    with Image.open(KEYED) as loaded:
        keyed = clean_rgba(loaded)

    alpha_box = keyed.getchannel("A").getbbox()
    if alpha_box is None:
        raise RuntimeError("Keyed ImageGen source has no visible plaque")
    visible_width = alpha_box[2] - alpha_box[0]
    visible_height = alpha_box[3] - alpha_box[1]
    visible_aspect = visible_width / visible_height
    if not MIN_VISIBLE_ASPECT <= visible_aspect <= MAX_VISIBLE_ASPECT:
        raise RuntimeError(f"Plaque aspect {visible_aspect:.3f}:1 is not native to the target button")

    crop_box = (
        max(0, alpha_box[0] - GUTTER),
        max(0, alpha_box[1] - GUTTER),
        min(keyed.width, alpha_box[2] + GUTTER),
        min(keyed.height, alpha_box[3] + GUTTER),
    )
    production = clean_rgba(keyed.crop(crop_box))
    output_array = np.asarray(production, dtype=np.uint8)
    green_fringe = (
        (output_array[..., 3] >= 16)
        & (output_array[..., 1].astype(np.int16) - output_array[..., 0] >= 48)
        & (output_array[..., 1].astype(np.int16) - output_array[..., 2] >= 48)
    )
    green_fringe_pixels = int(np.count_nonzero(green_fringe))
    if green_fringe_pixels > 8:
        raise RuntimeError(f"Chroma-key fringe remains on {green_fringe_pixels} visible pixels")

    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    production.save(OUTPUT, format="PNG", optimize=True, compress_level=9)
    production_alpha_box = production.getchannel("A").getbbox()
    if production_alpha_box is None:
        raise RuntimeError("Production plaque became empty")
    corners = [
        production.getpixel((0, 0))[3],
        production.getpixel((production.width - 1, 0))[3],
        production.getpixel((0, production.height - 1))[3],
        production.getpixel((production.width - 1, production.height - 1))[3],
    ]
    if any(corners):
        raise RuntimeError(f"Production plaque lost its transparent corners: {corners}")

    report = {
        "asset": prompt["asset"],
        "version": prompt["version"],
        "builder": "scripts/build_inventory_enhancement_button_v1.py",
        "inputs": [
            describe_image(SOURCE),
            describe_image(KEYED),
            describe_file(PROMPT),
            *[describe_image(path) for path in REFERENCES],
            *[describe_image(path) for path in DRAFTS],
        ],
        "pipeline": {
            "generator": "built-in image_gen",
            "chromaRemoval": "remove_chroma_key.py --auto-key border --soft-matte --transparent-threshold 12 --opaque-threshold 220 --despill",
            "alphaThreshold": ALPHA_THRESHOLD,
            "transparentGutterPixels": GUTTER,
            "resampling": "none; native-ratio crop",
            "zeroAlphaRgbCleared": True,
        },
        "qa": {
            "sourceAlphaBox": list(alpha_box),
            "sourceVisibleAspect": round(visible_aspect, 4),
            "cropBox": list(crop_box),
            "productionAlphaBox": list(production_alpha_box),
            "transparentCornerAlpha": corners,
            "greenFringePixels": green_fringe_pixels,
        },
        "outputs": [
            {
                **describe_image(OUTPUT),
                "role": "native ultra-wide inventory enhancement action plate",
                "cssConsumer": ".inventory-screen-enhancement-button::before",
                "renderMode": "dedicated 9-slice background",
            }
        ],
    }
    REPORT.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
