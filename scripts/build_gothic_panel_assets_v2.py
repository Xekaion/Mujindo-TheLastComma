"""Validate and publish the generated gothic panel V2 production assets."""

from __future__ import annotations

import hashlib
import json
import shutil
from pathlib import Path

from PIL import Image


ROOT = Path(__file__).resolve().parents[1]
PROMPT = ROOT / "asset-sources/imagegen/gothic-panel-assets-v2.prompt.json"
REPORT = ROOT / "public/assets/ui/gothic-panel-assets-v2.build.json"

ASSETS = (
    {
        "role": "fixed-aspect 3:2 modal plate",
        "source": ROOT / "asset-sources/imagegen/gothic-modal-panel-v2-source.png",
        "keyed": ROOT / "asset-sources/imagegen/gothic-modal-panel-v2-keyed.png",
        "output": ROOT / "public/assets/ui/gothic-modal-panel-v2.png",
        "size": (1536, 1024),
    },
    {
        "role": "transparent modular nine-slice frame",
        "source": ROOT / "asset-sources/imagegen/gothic-nine-slice-frame-v2-source.png",
        "keyed": ROOT / "asset-sources/imagegen/gothic-nine-slice-frame-v2-keyed.png",
        "output": ROOT / "public/assets/ui/gothic-nine-slice-frame-v2.png",
        "size": (1254, 1254),
    },
)


def relative(path: Path) -> str:
    return path.relative_to(ROOT).as_posix()


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def record(path: Path) -> dict[str, object]:
    result: dict[str, object] = {
        "path": relative(path),
        "sha256": digest(path),
        "bytes": path.stat().st_size,
    }
    if path.suffix.lower() == ".png":
        with Image.open(path) as image:
            result.update({"size": list(image.size), "mode": image.mode})
    return result


def alpha_stats(path: Path) -> dict[str, object]:
    with Image.open(path).convert("RGBA") as image:
        alpha = image.getchannel("A")
        bbox = alpha.getbbox()
        histogram = alpha.histogram()
        hidden_rgb = 0
        chroma_residual = 0
        pixels = image.get_flattened_data()
        for red, green, blue, value in pixels:
            if value == 0 and (red or green or blue):
                hidden_rgb += 1
            if value > 8 and green > red * 1.45 and green > blue * 1.45 and green > 150:
                chroma_residual += 1
        return {
            "visibleBbox": list(bbox) if bbox else None,
            "transparentPixels": histogram[0],
            "partiallyTransparentPixels": sum(histogram[1:255]),
            "hiddenRgbPixels": hidden_rgb,
            "chromaResidualPixels": chroma_residual,
            "cornerAlpha": [
                alpha.getpixel((0, 0)),
                alpha.getpixel((image.width - 1, 0)),
                alpha.getpixel((0, image.height - 1)),
                alpha.getpixel((image.width - 1, image.height - 1)),
            ],
        }


def main() -> None:
    outputs: list[dict[str, object]] = []
    inputs: list[dict[str, object]] = [record(PROMPT)]
    for asset in ASSETS:
        source = asset["source"]
        keyed = asset["keyed"]
        output = asset["output"]
        expected_size = asset["size"]
        for path in (source, keyed):
            if not path.is_file():
                raise FileNotFoundError(path)
        with Image.open(source) as source_image, Image.open(keyed) as keyed_image:
            if source_image.size != expected_size or keyed_image.size != expected_size:
                raise ValueError(f"Unexpected geometry for {keyed}: {keyed_image.size}")
            if keyed_image.mode != "RGBA":
                raise ValueError(f"{keyed} must remain RGBA")
        stats = alpha_stats(keyed)
        if any(stats["cornerAlpha"]):
            raise ValueError(f"{keyed} lost its transparent gutter")
        if stats["hiddenRgbPixels"] or stats["chromaResidualPixels"]:
            raise ValueError(f"{keyed} has unsafe transparent/chroma pixels: {stats}")
        if asset["role"].startswith("transparent"):
            with Image.open(keyed).convert("RGBA") as image:
                center = image.getpixel((image.width // 2, image.height // 2))[3]
            if center != 0:
                raise ValueError("Nine-slice frame center must remain transparent")
        output.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(keyed, output)
        inputs.extend((record(source), record(keyed)))
        output_record = record(output)
        output_record.update({"role": asset["role"], **stats})
        outputs.append(output_record)

    report = {
        "version": 2,
        "builder": relative(Path(__file__).resolve()),
        "generator": "OpenAI built-in image_gen",
        "pipeline": {
            "chromaRemoval": "remove_chroma_key.py --auto-key border --soft-matte --transparent-threshold 12 --opaque-threshold 220 --despill",
            "modalContract": "fixed 3:2 geometry; contain/no-repeat; uniform downscale only",
            "frameContract": "transparent center; 16% nine-slice; decorated corners fixed; straight rails repeat",
        },
        "inputs": inputs,
        "outputs": outputs,
    }
    REPORT.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(REPORT.relative_to(ROOT))


if __name__ == "__main__":
    main()
