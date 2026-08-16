#!/usr/bin/env python3
"""Build the canonical audio control and shared gothic scrollbar assets.

The generated sources and their keyed intermediates remain versioned.  This
builder only performs deterministic alpha-safe cropping, fitting, rotation and
validation; it does not repaint or reinterpret the generated artwork.
"""

from __future__ import annotations

from hashlib import sha256
import json
from pathlib import Path

from PIL import Image


ROOT = Path(__file__).resolve().parents[1]
SOURCE_ROOT = ROOT / "asset-sources" / "imagegen"
AUDIO_KEYED = SOURCE_ROOT / "audio-dock-medallion-v1-keyed.png"
SCROLL_KEYED = SOURCE_ROOT / "gothic-scrollbar-v1-keyed.png"
AUDIO_PROMPT = SOURCE_ROOT / "audio-dock-medallion-v1.prompt.json"
SCROLL_PROMPT = SOURCE_ROOT / "gothic-scrollbar-v1.prompt.json"
AUDIO_OUT = ROOT / "public" / "assets" / "ui" / "audio" / "audio-dock-medallion-v1.png"
SCROLL_OUT = ROOT / "public" / "assets" / "ui" / "scrollbars"
BUILD_RECORD = SOURCE_ROOT / "investor-ui-assets-v1.build.json"


def digest(path: Path) -> str:
    return sha256(path.read_bytes()).hexdigest()


def visible_bbox(image: Image.Image, threshold: int = 8) -> tuple[int, int, int, int]:
    alpha = image.getchannel("A").point(lambda value: 255 if value > threshold else 0)
    bbox = alpha.getbbox()
    if bbox is None:
        raise ValueError(f"{image!r} has no visible alpha support")
    return bbox


def crop_with_padding(image: Image.Image, padding: int) -> Image.Image:
    left, top, right, bottom = visible_bbox(image)
    return image.crop(
        (
            max(0, left - padding),
            max(0, top - padding),
            min(image.width, right + padding),
            min(image.height, bottom + padding),
        )
    )


def premultiplied_resize(image: Image.Image, size: tuple[int, int]) -> Image.Image:
    return image.convert("RGBa").resize(size, Image.Resampling.LANCZOS).convert("RGBA")


def contain(image: Image.Image, size: tuple[int, int], gutter: tuple[int, int]) -> Image.Image:
    max_width = size[0] - gutter[0] * 2
    max_height = size[1] - gutter[1] * 2
    scale = min(max_width / image.width, max_height / image.height)
    resized = premultiplied_resize(
        image,
        (max(1, round(image.width * scale)), max(1, round(image.height * scale))),
    )
    canvas = Image.new("RGBA", size, (0, 0, 0, 0))
    offset = ((size[0] - resized.width) // 2, (size[1] - resized.height) // 2)
    canvas.alpha_composite(resized, offset)
    return canvas


def key_residual_count(image: Image.Image) -> int:
    raw = image.convert("RGBA").tobytes()
    count = 0
    for offset in range(0, len(raw), 4):
        red, green, blue, alpha = raw[offset : offset + 4]
        if alpha > 0 and abs(red - 0) <= 28 and abs(green - 255) <= 28 and abs(blue - 0) <= 28:
            count += 1
    return count


def clear_key_residuals(image: Image.Image) -> Image.Image:
    """Clear subpixel key remnants introduced by the final Lanczos resize."""
    raw = bytearray(image.convert("RGBA").tobytes())
    for offset in range(0, len(raw), 4):
        red, green, blue, alpha = raw[offset : offset + 4]
        if alpha > 0 and red <= 28 and green >= 227 and blue <= 28:
            raw[offset : offset + 4] = b"\x00\x00\x00\x00"
    return Image.frombytes("RGBA", image.size, bytes(raw))


def describe(path: Path) -> dict[str, object]:
    image = Image.open(path).convert("RGBA")
    bbox = visible_bbox(image)
    alphas = image.getchannel("A")
    alpha_bytes = alphas.tobytes()
    return {
        "path": path.relative_to(ROOT).as_posix(),
        "sha256": digest(path),
        "bytes": path.stat().st_size,
        "size": [image.width, image.height],
        "visibleBbox": list(bbox),
        "alphaLevels": len(set(alpha_bytes)),
        "transparentPixels": alpha_bytes.count(0),
        "chromaResidualPixels": key_residual_count(image),
    }


def build_audio() -> None:
    source = Image.open(AUDIO_KEYED).convert("RGBA")
    cropped = crop_with_padding(source, 22)
    side = max(cropped.width, cropped.height)
    square = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    square.alpha_composite(cropped, ((side - cropped.width) // 2, (side - cropped.height) // 2))
    output = clear_key_residuals(contain(square, (320, 320), (8, 8)))
    AUDIO_OUT.parent.mkdir(parents=True, exist_ok=True)
    output.save(AUDIO_OUT, optimize=True)


def build_scrollbars() -> list[Path]:
    source = Image.open(SCROLL_KEYED).convert("RGBA")
    edges = [round(index * source.width / 3) for index in range(4)]
    names = ["gothic-track-v1", "gothic-thumb-gold-v1", "gothic-thumb-aether-v1"]
    outputs: list[Path] = []
    SCROLL_OUT.mkdir(parents=True, exist_ok=True)
    for index, name in enumerate(names):
        third = source.crop((edges[index], 0, edges[index + 1], source.height))
        motif = crop_with_padding(third, 8)
        vertical = clear_key_residuals(contain(motif, (96, 576), (8, 12)))
        vertical_path = SCROLL_OUT / f"{name}.png"
        horizontal_path = SCROLL_OUT / f"{name.replace('-v1', '-horizontal-v1')}.png"
        vertical.save(vertical_path, optimize=True)
        clear_key_residuals(vertical.rotate(90, expand=True)).save(horizontal_path, optimize=True)
        outputs.extend((vertical_path, horizontal_path))
    return outputs


def main() -> None:
    for required in (AUDIO_KEYED, SCROLL_KEYED, AUDIO_PROMPT, SCROLL_PROMPT):
        if not required.exists():
            raise FileNotFoundError(required)

    build_audio()
    scrollbar_outputs = build_scrollbars()
    outputs = [AUDIO_OUT, *scrollbar_outputs]

    records = [describe(path) for path in outputs]
    for record in records:
        if record["chromaResidualPixels"] != 0:
            raise ValueError(f"residual chroma in {record['path']}: {record['chromaResidualPixels']}")
        if record["alphaLevels"] < 16:
            raise ValueError(f"insufficient soft-alpha detail in {record['path']}")

    build = {
        "version": 1,
        "builder": "scripts/build_investor_ui_assets_v1.py",
        "generator": "OpenAI built-in image_gen",
        "inputs": [
            describe(AUDIO_KEYED),
            describe(SCROLL_KEYED),
            {
                "path": AUDIO_PROMPT.relative_to(ROOT).as_posix(),
                "sha256": digest(AUDIO_PROMPT),
            },
            {
                "path": SCROLL_PROMPT.relative_to(ROOT).as_posix(),
                "sha256": digest(SCROLL_PROMPT),
            },
        ],
        "pipeline": {
            "crop": "alpha bbox with transparent safety padding",
            "resize": "premultiplied-alpha LANCZOS contain; no axis distortion",
            "audioCanvas": [320, 320],
            "scrollbarCanvas": [96, 576],
            "horizontalVariants": "deterministic 90 degree rotation of each authored vertical component",
            "cssContract": "three-slice/nine-slice caps; 112 source pixels at each long-axis end",
        },
        "outputs": records,
    }
    BUILD_RECORD.write_text(json.dumps(build, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Built {len(outputs)} investor UI assets")
    for record in records:
        print(f"  {record['path']} {record['size']} alpha={record['alphaLevels']}")
    print(f"Wrote {BUILD_RECORD.relative_to(ROOT).as_posix()}")


if __name__ == "__main__":
    main()
