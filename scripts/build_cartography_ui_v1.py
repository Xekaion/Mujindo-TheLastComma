from __future__ import annotations

import hashlib
import json
from pathlib import Path

from PIL import Image


ROOT = Path(__file__).resolve().parents[1]
SOURCE_DIR = ROOT / "asset-sources" / "imagegen"
OUTPUT_DIR = ROOT / "public" / "assets" / "ui" / "cartography"
PROMPT_PATH = SOURCE_DIR / "cartography-ui-v1.prompt.json"


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def alpha_box(image: Image.Image) -> tuple[int, int, int, int]:
    alpha = image.getchannel("A")
    bounds = alpha.getbbox()
    if bounds is None:
        raise ValueError("asset has no visible pixels")
    return bounds


def clear_hidden_rgb(image: Image.Image, alpha_threshold: int = 4) -> Image.Image:
    rgba = image.convert("RGBA")
    pixels = rgba.load()
    for y in range(rgba.height):
        for x in range(rgba.width):
            red, green, blue, alpha = pixels[x, y]
            if alpha <= alpha_threshold:
                pixels[x, y] = (0, 0, 0, 0)
    return rgba


def content_box(image: Image.Image, alpha_threshold: int = 24) -> tuple[int, int, int, int]:
    alpha = image.getchannel("A")
    rows = [
        sum(alpha.getpixel((x, y)) >= alpha_threshold for x in range(image.width))
        for y in range(image.height)
    ]
    columns = [
        sum(alpha.getpixel((x, y)) >= alpha_threshold for y in range(image.height))
        for x in range(image.width)
    ]
    occupied_rows = [index for index, count in enumerate(rows) if count >= max(4, image.width // 100)]
    occupied_columns = [index for index, count in enumerate(columns) if count >= max(4, image.height // 100)]
    if not occupied_rows or not occupied_columns:
        return alpha_box(image)
    return (
        min(occupied_columns),
        min(occupied_rows),
        max(occupied_columns) + 1,
        max(occupied_rows) + 1,
    )


def crop_with_gutter(image: Image.Image, gutter: int) -> Image.Image:
    left, top, right, bottom = content_box(image)
    crop = (
        max(0, left - gutter),
        max(0, top - gutter),
        min(image.width, right + gutter),
        min(image.height, bottom + gutter),
    )
    return image.crop(crop)


def fit_inside_transparent_canvas(
    image: Image.Image,
    size: tuple[int, int],
    moat: int,
) -> Image.Image:
    maximum_width = size[0] - moat * 2
    maximum_height = size[1] - moat * 2
    scale = min(maximum_width / image.width, maximum_height / image.height)
    fitted_size = (round(image.width * scale), round(image.height * scale))
    fitted = clear_hidden_rgb(image.resize(fitted_size, Image.Resampling.LANCZOS))
    canvas = Image.new("RGBA", size, (0, 0, 0, 0))
    offset = ((size[0] - fitted.width) // 2, (size[1] - fitted.height) // 2)
    canvas.alpha_composite(fitted, offset)
    return clear_hidden_rgb(canvas)


def describe(path: Path, role: str, image: Image.Image) -> dict[str, object]:
    alpha = image.getchannel("A")
    alpha_values = list(alpha.get_flattened_data())
    return {
        "path": path.relative_to(ROOT).as_posix(),
        "sha256": sha256(path),
        "bytes": path.stat().st_size,
        "size": [image.width, image.height],
        "mode": image.mode,
        "role": role,
        "visibleBbox": list(alpha_box(image)),
        "transparentPixels": sum(value == 0 for value in alpha_values),
        "partiallyTransparentPixels": sum(0 < value < 255 for value in alpha_values),
        "cornerAlpha": [
            alpha.getpixel((0, 0)),
            alpha.getpixel((image.width - 1, 0)),
            alpha.getpixel((0, image.height - 1)),
            alpha.getpixel((image.width - 1, image.height - 1)),
        ],
    }


def main() -> None:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    frame_source = SOURCE_DIR / "cartography-frame-v1-keyed.png"
    button_source = SOURCE_DIR / "cartography-command-button-v1-keyed.png"
    frame_output = OUTPUT_DIR / "cartography-frame-v1.png"
    button_output = OUTPUT_DIR / "cartography-command-button-v1.png"

    frame = fit_inside_transparent_canvas(
        clear_hidden_rgb(Image.open(frame_source)),
        (1536, 1024),
        24,
    )
    frame.save(frame_output, optimize=True)

    button = fit_inside_transparent_canvas(
        crop_with_gutter(clear_hidden_rgb(Image.open(button_source)), 2),
        (1200, 240),
        20,
    )
    button.save(button_output, optimize=True)

    inputs = []
    for input_path in [
        SOURCE_DIR / "cartography-frame-v1-source.png",
        frame_source,
        SOURCE_DIR / "cartography-command-button-v1-source.png",
        button_source,
        PROMPT_PATH,
    ]:
        size = None
        mode = None
        if input_path.suffix == ".png":
            with Image.open(input_path) as source_image:
                size = [source_image.width, source_image.height]
                mode = source_image.mode
        entry: dict[str, object] = {
            "path": input_path.relative_to(ROOT).as_posix(),
            "sha256": sha256(input_path),
            "bytes": input_path.stat().st_size,
        }
        if size is not None:
            entry["size"] = size
            entry["mode"] = mode
        inputs.append(entry)

    manifest = {
        "asset": "cartography-ui-v1",
        "version": 1,
        "builder": "scripts/build_cartography_ui_v1.py",
        "generator": "OpenAI built-in image_gen",
        "inputs": inputs,
        "pipeline": {
            "chromaRemoval": "remove_chroma_key.py --key-color #FF00FF --soft-matte --transparent-threshold 10 --opaque-threshold 160 --despill",
            "alphaThreshold": 4,
            "frameCanvas": "1536x1024 with >=24px transparent moat",
            "buttonCrop": "rows/columns with >=1% opaque occupancy",
            "buttonCanvas": "1200x240 with >=20px transparent moat",
            "resampling": "premultiplied-look RGBA Lanczos",
            "zeroAlphaRgbCleared": True,
        },
        "outputs": [
            describe(frame_output, "fixed-ratio full-map modal chrome", frame),
            describe(button_output, "neutral full-map continue-expedition action plate", button),
        ],
    }
    manifest_path = OUTPUT_DIR / "cartography-ui-v1.build.json"
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
