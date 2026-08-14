"""Build the Silent Librarian's component-based echo VFX atlas.

The ImageGen source is a 2 x 2 sheet on a removable chroma background.  The
checked-in keyed source preserves the soft authored edge, while this builder
normalizes every component to a crop-safe cell and reduces it to the coarse,
restrained palette used by the game's pre-rendered dark-ARPG effects.
"""

from __future__ import annotations

from hashlib import sha256
import json
from pathlib import Path

from PIL import Image


ROOT = Path(__file__).resolve().parents[1]
ORIGINAL_SOURCE = (
    ROOT / "asset-sources/imagegen/silent-librarian-echo-components-v3-source.png"
)
KEYED_SOURCE = (
    ROOT / "asset-sources/imagegen/silent-librarian-echo-components-v3-keyed.png"
)
PROMPT_METADATA = (
    ROOT / "asset-sources/imagegen/silent-librarian-echo-components-v3.prompt.json"
)
OUTPUT = ROOT / "public/assets/effects/silent-librarian-echo-v3.png"
REPORT = ROOT / "public/assets/effects/silent-librarian-echo-v3.build.json"

SHEET_SIZE = (1254, 1254)
CELL_SIZE = (627, 627)
CELL_PADDING = 24
ALPHA_LEVELS = (0, 48, 96, 144, 192, 224, 255)
FRAME_ROLES = (
    "sealed-forbidden-book",
    "ruptured-forbidden-book",
    "travelling-broken-arc",
    "dissipating-arc-fragments",
)

# Soot, old bronze, vellum, dried ink, and only restrained corpse-cyan light.
VFX_PALETTE = (
    (2, 2, 3), (6, 5, 5), (10, 8, 7), (15, 12, 10),
    (21, 16, 13), (29, 22, 17), (39, 29, 21), (51, 37, 25),
    (66, 47, 29), (83, 58, 34), (103, 72, 39), (126, 89, 47),
    (151, 108, 60), (178, 132, 77), (204, 159, 101), (227, 191, 139),
    (239, 219, 179), (248, 239, 210),
    (30, 9, 9), (48, 13, 12), (69, 18, 15), (92, 25, 19),
    (119, 35, 25), (148, 51, 33), (178, 72, 44),
    (7, 16, 17), (10, 27, 29), (13, 39, 41), (17, 54, 56),
    (23, 72, 73), (31, 91, 90), (44, 112, 107), (61, 136, 127),
    (85, 160, 148), (116, 184, 169), (153, 207, 190), (194, 229, 211),
    (225, 243, 226), (240, 250, 239),
    (27, 26, 25), (43, 40, 37), (61, 56, 50), (83, 75, 65),
    (109, 97, 81), (139, 124, 101), (173, 155, 126), (207, 188, 155),
)


def digest(path: Path) -> str:
    return sha256(path.read_bytes()).hexdigest()


def nearest_alpha(value: int) -> int:
    return min(ALPHA_LEVELS, key=lambda level: abs(level - value))


def palette_image() -> Image.Image:
    palette = [component for colour in VFX_PALETTE for component in colour]
    palette.extend([0] * (768 - len(palette)))
    image = Image.new("P", (1, 1))
    image.putpalette(palette)
    return image


def quantize_rgba(image: Image.Image) -> Image.Image:
    source = image.convert("RGBA")
    alpha = source.getchannel("A").point(nearest_alpha)
    rgb = source.convert("RGB").quantize(
        palette=palette_image(),
        dither=Image.Dither.FLOYDSTEINBERG,
    ).convert("RGB")
    rgb.putalpha(alpha)
    return rgb


def normalize_component(component: Image.Image) -> Image.Image:
    bounds = component.getchannel("A").getbbox()
    if bounds is None:
        raise ValueError("ImageGen component cell is empty")
    crop = component.crop(bounds)
    maximum_width = CELL_SIZE[0] - CELL_PADDING * 2
    maximum_height = CELL_SIZE[1] - CELL_PADDING * 2
    scale = min(1.0, maximum_width / crop.width, maximum_height / crop.height)
    if scale < 1:
        crop = crop.resize(
            (max(1, round(crop.width * scale)), max(1, round(crop.height * scale))),
            Image.Resampling.LANCZOS,
        )
    framed = Image.new("RGBA", CELL_SIZE, (0, 0, 0, 0))
    framed.alpha_composite(
        crop,
        ((CELL_SIZE[0] - crop.width) // 2, (CELL_SIZE[1] - crop.height) // 2),
    )
    # Author at half resolution before returning with nearest-neighbour so the
    # detailed source becomes a crunchy, readable combat sprite at 60-140 px.
    low = framed.resize(
        ((CELL_SIZE[0] + 1) // 2, (CELL_SIZE[1] + 1) // 2),
        Image.Resampling.LANCZOS,
    )
    pixelated = low.resize(CELL_SIZE, Image.Resampling.NEAREST)
    return quantize_rgba(pixelated)


def frame_metrics(frame: Image.Image, role: str) -> dict[str, object]:
    alpha = frame.getchannel("A")
    bounds = alpha.getbbox()
    if bounds is None:
        raise ValueError(f"{role} output frame is empty")
    pixels = list(alpha.get_flattened_data())
    return {
        "role": role,
        "alphaBounds": list(bounds),
        "padding": [
            bounds[0],
            bounds[1],
            frame.width - bounds[2],
            frame.height - bounds[3],
        ],
        "visiblePixels": sum(1 for value in pixels if value > 0),
        "alphaLevels": sorted(set(pixels)),
        "pixelHash": sha256(frame.tobytes()).hexdigest(),
    }


def main() -> None:
    source = Image.open(KEYED_SOURCE).convert("RGBA")
    if source.size != SHEET_SIZE:
        raise ValueError(f"{KEYED_SOURCE} must be {SHEET_SIZE}, got {source.size}")
    suspicious_magenta = sum(
        1
        for red, green, blue, alpha in source.get_flattened_data()
        if alpha > 0 and red > 180 and blue > 180 and green < 90
    )
    if suspicious_magenta:
        raise ValueError(f"keyed source retains {suspicious_magenta} magenta pixels")

    output = Image.new("RGBA", SHEET_SIZE, (0, 0, 0, 0))
    frames: list[dict[str, object]] = []
    for frame_index, role in enumerate(FRAME_ROLES):
        column = frame_index % 2
        row = frame_index // 2
        box = (
            column * CELL_SIZE[0],
            row * CELL_SIZE[1],
            (column + 1) * CELL_SIZE[0],
            (row + 1) * CELL_SIZE[1],
        )
        frame = normalize_component(source.crop(box))
        output.alpha_composite(frame, box[:2])
        frames.append({"index": frame_index, **frame_metrics(frame, role)})

    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    output.save(OUTPUT, optimize=True)
    report = {
        "version": 3,
        "format": "RGBA PNG",
        "sheet": {"columns": 2, "rows": 2, "size": list(SHEET_SIZE)},
        "sourceOriginal": str(ORIGINAL_SOURCE.relative_to(ROOT)).replace("\\", "/"),
        "sourceOriginalSha256": digest(ORIGINAL_SOURCE),
        "sourceKeyed": str(KEYED_SOURCE.relative_to(ROOT)).replace("\\", "/"),
        "sourceKeyedSha256": digest(KEYED_SOURCE),
        "promptMetadata": str(PROMPT_METADATA.relative_to(ROOT)).replace("\\", "/"),
        "promptMetadataSha256": digest(PROMPT_METADATA),
        "output": str(OUTPUT.relative_to(ROOT)).replace("\\", "/"),
        "outputSha256": digest(OUTPUT),
        "pipeline": {
            "cellPadding": CELL_PADDING,
            "paletteSize": len(VFX_PALETTE),
            "alphaLevels": list(ALPHA_LEVELS),
            "halfResolutionAuthoring": True,
        },
        "frames": frames,
    }
    REPORT.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(REPORT)


if __name__ == "__main__":
    main()
