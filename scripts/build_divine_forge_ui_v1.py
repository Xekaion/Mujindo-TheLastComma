"""Extract reproducible transparent divine-forge UI chrome from ImageGen source."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

import numpy as np
from PIL import Image


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "asset-sources/imagegen/divine-forge-ui-v1-source.png"
KEYED = ROOT / "asset-sources/imagegen/divine-forge-ui-v1-keyed.png"
PROMPT = ROOT / "asset-sources/imagegen/divine-forge-ui-v1.prompt.json"
OUTPUT_ROOT = ROOT / "public/assets/ui"
REPORT = OUTPUT_ROOT / "divine-forge-ui-v1.build.json"

ALPHA_THRESHOLD = 4
GUTTER = 10

# The generator returned native transparency. Regions isolate the four authored
# objects; extraction then tightens each one to its alpha bounds plus 10 px.
ASSETS = {
    "crest": {
        "path": "divine-forge-crest-v1.png",
        "role": "forge emblem",
        "cssConsumer": ".inventory-screen-divine-forge-crest",
        "renderMode": "contain",
        "region": (24, 0, 620, 493),
        "maxWidth": 460,
    },
    "title": {
        "path": "divine-forge-title-v1.png",
        "role": "modal title plaque",
        "cssConsumer": ".inventory-screen-divine-forge-heading::before",
        "renderMode": "contain",
        "region": (630, 18, 1668, 486),
        "maxWidth": 700,
    },
    "socket": {
        "path": "divine-forge-socket-v1.png",
        "role": "sacrificial material socket",
        "cssConsumer": ".inventory-screen-divine-forge-material-art",
        "renderMode": "contain",
        "region": (48, 490, 620, 936),
        "maxWidth": 430,
    },
    "button": {
        "path": "divine-forge-button-v1.png",
        "role": "primary forge action plate",
        "cssConsumer": ".inventory-screen-divine-forge-action::before",
        "renderMode": "stretchable background",
        "region": (630, 520, 1668, 900),
        "maxWidth": 700,
    },
}


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


def describe(path: Path) -> dict[str, object]:
    with Image.open(path) as image:
        return {
            **describe_file(path),
            "size": list(image.size),
            "mode": image.mode,
        }


def clean_rgba(image: Image.Image) -> Image.Image:
    array = np.asarray(image.convert("RGBA"), dtype=np.uint8).copy()
    faint = array[..., 3] < ALPHA_THRESHOLD
    array[faint] = 0
    transparent = array[..., 3] == 0
    array[transparent, :3] = 0
    return Image.fromarray(array, "RGBA")


def resize_premultiplied(image: Image.Image, width: int) -> Image.Image:
    if image.width <= width:
        return image
    height = max(1, round(image.height * width / image.width))
    rgba = np.asarray(image, dtype=np.float32)
    alpha = rgba[..., 3:4] / 255.0
    premultiplied = np.concatenate((rgba[..., :3] * alpha, rgba[..., 3:4]), axis=2)
    resized = Image.fromarray(np.clip(premultiplied, 0, 255).astype(np.uint8), "RGBA").resize(
        (width, height), Image.Resampling.LANCZOS
    )
    resized_array = np.asarray(resized, dtype=np.float32)
    resized_alpha = resized_array[..., 3:4]
    rgb = np.divide(
        resized_array[..., :3] * 255.0,
        resized_alpha,
        out=np.zeros_like(resized_array[..., :3]),
        where=resized_alpha > 0,
    )
    straight = np.concatenate((np.clip(rgb, 0, 255), resized_alpha), axis=2)
    return clean_rgba(Image.fromarray(straight.astype(np.uint8), "RGBA"))


def extract(source: Image.Image, specification: dict[str, object], output: Path) -> dict[str, object]:
    region = tuple(int(value) for value in specification["region"])
    crop = clean_rgba(source.crop(region))
    alpha_box = crop.getchannel("A").getbbox()
    if alpha_box is None:
        raise RuntimeError(f"No visible pixels in source region {region}")
    tight = crop.crop(alpha_box)
    padded = Image.new("RGBA", (tight.width + GUTTER * 2, tight.height + GUTTER * 2))
    padded.alpha_composite(tight, (GUTTER, GUTTER))
    production = resize_premultiplied(padded, int(specification["maxWidth"]))
    production = clean_rgba(production)
    output.parent.mkdir(parents=True, exist_ok=True)
    production.save(output, format="PNG", optimize=True, compress_level=9)
    alpha = production.getchannel("A")
    final_box = alpha.getbbox()
    if final_box is None or final_box[0] < 6 or final_box[1] < 6:
        raise RuntimeError(f"{output.name} lost its transparent safety gutter")
    return {
        **describe(output),
        "role": specification["role"],
        "cssConsumer": specification["cssConsumer"],
        "renderMode": specification["renderMode"],
        "sourceRegion": list(region),
        "sourceAlphaBox": list(alpha_box),
        "productionAlphaBox": list(final_box),
    }


def main() -> None:
    prompt = json.loads(PROMPT.read_text(encoding="utf-8"))
    with Image.open(SOURCE) as loaded:
        source = loaded.convert("RGBA")
    if source.size != (1672, 941):
        raise RuntimeError(f"Unexpected ImageGen source size: {source.size}")
    if source.getchannel("A").getextrema()[0] != 0:
        raise RuntimeError("ImageGen source has no transparent background")

    outputs = []
    for name, specification in ASSETS.items():
        record = extract(source, specification, OUTPUT_ROOT / str(specification["path"]))
        record["name"] = name
        outputs.append(record)

    report = {
        "asset": prompt["asset"],
        "version": 1,
        "builder": "scripts/build_divine_forge_ui_v1.py",
        "inputs": [describe(SOURCE), describe(KEYED), describe_file(PROMPT)],
        "pipeline": {
            "nativeTransparentImageGenSource": True,
            "alphaThreshold": ALPHA_THRESHOLD,
            "transparentGutterPixels": GUTTER,
            "resampling": "premultiplied-alpha Lanczos",
            "zeroAlphaRgbCleared": True,
        },
        "outputs": outputs,
    }
    REPORT.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
