"""Build legacy dark-ARPG enemy and skill atlases from generated sources.

The walk sources are already registered to the runtime's canonical 4 x 8
contract.  This builder keeps that geometry byte-for-byte stable while
reducing smooth generated colour/alpha ramps to the coarse, dithered palette
used by the game's pre-rendered sprites.  Skill sources arrive on a blue key;
they are keyed, despilled, cell-clipped, palette reduced, and alpha-stepped.
"""

from __future__ import annotations

from hashlib import sha256
import json
from pathlib import Path

from PIL import Image


ROOT = Path(__file__).resolve().parents[1]
WALK_INPUTS = {
    "silent-librarian": ROOT / "asset-sources/legacy-arpg/silent-librarian-walk-registered-v2.png",
    "margin-severer": ROOT / "asset-sources/legacy-arpg/margin-severer-walk-registered-v2.png",
}
WALK_OUTPUTS = {
    name: ROOT / f"public/assets/walk/{name}-walk-v2.png" for name in WALK_INPUTS
}
EFFECT_INPUTS = {
    "silent-librarian-echo": ROOT / "asset-sources/legacy-arpg/silent-librarian-echo-legacy-source-v2.png",
    "margin-sever-line": ROOT / "asset-sources/legacy-arpg/margin-sever-line-legacy-source-v2.png",
}
EFFECT_OUTPUTS = {
    name: ROOT / f"public/assets/effects/{name}-v2.png" for name in EFFECT_INPUTS
}
REPORT = ROOT / "public/assets/effects/legacy-enemy-assets-v2.build.json"

WALK_SIZE = (1024, 1536)
WALK_CELL = (256, 192)
EFFECT_SIZE = (1254, 1254)
EFFECT_CELL = (627, 627)
ALPHA_LEVELS = (0, 72, 128, 192, 255)

# A shared, deliberately small palette prevents modern full-spectrum gradients
# and per-frame colour drift.  Cyan is kept only for the Librarian's mask and
# echo runes; everything else lives in soot, leather, blood and old metal.
LEGACY_PALETTE = (
    (3, 3, 4), (7, 6, 6), (12, 10, 9), (18, 15, 13),
    (25, 20, 17), (34, 27, 22), (45, 35, 27), (58, 44, 32),
    (72, 54, 38), (89, 66, 43), (108, 80, 48), (130, 98, 57),
    (153, 119, 71), (178, 145, 94), (205, 176, 126), (231, 211, 170),
    (36, 12, 12), (57, 16, 15), (81, 21, 18), (109, 29, 22),
    (141, 42, 29), (173, 62, 39), (205, 89, 52), (232, 130, 75),
    (8, 17, 18), (11, 29, 31), (15, 43, 45), (21, 61, 62),
    (29, 83, 83), (42, 108, 105), (65, 137, 130), (95, 169, 158),
    (134, 199, 185), (181, 225, 208), (221, 242, 222),
    (27, 27, 27), (46, 44, 42), (70, 65, 60), (99, 91, 81),
    (133, 120, 103), (169, 153, 130), (202, 186, 160),
)


def digest(path: Path) -> str:
    return sha256(path.read_bytes()).hexdigest()


def nearest_level(value: int) -> int:
    return min(ALPHA_LEVELS, key=lambda level: abs(level - value))


def palette_image() -> Image.Image:
    palette = [component for colour in LEGACY_PALETTE for component in colour]
    palette.extend([0] * (768 - len(palette)))
    image = Image.new("P", (1, 1))
    image.putpalette(palette)
    return image


def quantize_rgba(image: Image.Image) -> Image.Image:
    source = image.convert("RGBA")
    alpha = source.getchannel("A").point(nearest_level)
    rgb = source.convert("RGB").quantize(
        palette=palette_image(),
        dither=Image.Dither.FLOYDSTEINBERG,
    ).convert("RGB")
    rgb.putalpha(alpha)
    return rgb


def chroma_alpha(red: int, green: int, blue: int) -> int:
    distance = ((red - 0) ** 2 + (green - 2) ** 2 + (blue - 253) ** 2) ** 0.5
    if distance <= 20:
        return 0
    if distance >= 76:
        return 255
    return nearest_level(round((distance - 20) / 56 * 255))


def remove_blue_chroma(source: Image.Image) -> Image.Image:
    pixels: list[tuple[int, int, int, int]] = []
    for red, green, blue, _ in source.convert("RGBA").get_flattened_data():
        alpha = chroma_alpha(red, green, blue)
        if alpha == 0:
            pixels.append((0, 0, 0, 0))
            continue
        if alpha < 255:
            blue = min(blue, round(max(red, green) * 1.28 + 10))
        pixels.append((red, green, blue, alpha))
    result = Image.new("RGBA", source.size)
    result.putdata(pixels)
    return result


def keep_inside_cell(image: Image.Image, cell: tuple[int, int], padding: int) -> Image.Image:
    bounds = image.getchannel("A").getbbox()
    if bounds is None:
        raise ValueError("generated effect cell is empty")
    crop = image.crop(bounds)
    maximum = (cell[0] - padding * 2, cell[1] - padding * 2)
    scale = min(1.0, maximum[0] / crop.width, maximum[1] / crop.height)
    if scale < 1:
        crop = crop.resize(
            (max(1, round(crop.width * scale)), max(1, round(crop.height * scale))),
            Image.Resampling.NEAREST,
        )
    output = Image.new("RGBA", cell, (0, 0, 0, 0))
    output.alpha_composite(
        crop,
        ((cell[0] - crop.width) // 2, (cell[1] - crop.height) // 2),
    )
    return output


def frame_metrics(frame: Image.Image) -> dict[str, object]:
    alpha = frame.getchannel("A")
    bounds = alpha.getbbox()
    if bounds is None:
        raise ValueError("output frame is empty")
    return {
        "alphaBounds": list(bounds),
        "padding": [bounds[0], bounds[1], frame.width - bounds[2], frame.height - bounds[3]],
        "visiblePixels": sum(1 for value in alpha.get_flattened_data() if value > 0),
        "alphaLevels": sorted(set(alpha.get_flattened_data())),
        "pixelHash": sha256(frame.tobytes()).hexdigest(),
    }


def build_walk(source_path: Path, output_path: Path) -> list[dict[str, object]]:
    source = Image.open(source_path).convert("RGBA")
    if source.size != WALK_SIZE:
        raise ValueError(f"{source_path} must be {WALK_SIZE}, got {source.size}")
    output = Image.new("RGBA", WALK_SIZE, (0, 0, 0, 0))
    frames: list[dict[str, object]] = []
    for row in range(8):
        for column in range(4):
            box = (
                column * WALK_CELL[0], row * WALK_CELL[1],
                (column + 1) * WALK_CELL[0], (row + 1) * WALK_CELL[1],
            )
            # Quantise per authored cell so dithering can never cross a crop.
            frame = quantize_rgba(source.crop(box))
            output.alpha_composite(frame, box[:2])
            frames.append({"row": row, "column": column, **frame_metrics(frame)})
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output.save(output_path, optimize=True)
    return frames


def build_effect(source_path: Path, output_path: Path) -> list[dict[str, object]]:
    source = Image.open(source_path).convert("RGBA")
    if source.size != EFFECT_SIZE:
        raise ValueError(f"{source_path} must be {EFFECT_SIZE}, got {source.size}")
    keyed = remove_blue_chroma(source)
    output = Image.new("RGBA", EFFECT_SIZE, (0, 0, 0, 0))
    frames: list[dict[str, object]] = []
    for row in range(2):
        for column in range(2):
            box = (
                column * EFFECT_CELL[0], row * EFFECT_CELL[1],
                (column + 1) * EFFECT_CELL[0], (row + 1) * EFFECT_CELL[1],
            )
            frame = keyed.crop(box)
            frame = keep_inside_cell(frame, EFFECT_CELL, 20)
            # Author at half resolution and return with nearest-neighbour to
            # keep broad rings/lines crunchy when the canvas downsizes them.
            low = frame.resize((EFFECT_CELL[0] // 2, EFFECT_CELL[1] // 2), Image.Resampling.NEAREST)
            frame = low.resize(EFFECT_CELL, Image.Resampling.NEAREST)
            frame = quantize_rgba(frame)
            output.alpha_composite(frame, box[:2])
            frames.append({"row": row, "column": column, **frame_metrics(frame)})
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output.save(output_path, optimize=True)
    return frames


def main() -> None:
    report: dict[str, object] = {
        "format": "RGBA PNG",
        "rowOrder": ["south", "south-east", "east", "north-west", "north", "north-east", "west", "south-west"],
        "phaseOrder": ["left-contact", "passing", "right-contact", "return"],
        "alphaLevels": list(ALPHA_LEVELS),
        "paletteSize": len(LEGACY_PALETTE),
        "walk": {},
        "effects": {},
    }
    for name, source in WALK_INPUTS.items():
        output = WALK_OUTPUTS[name]
        frames = build_walk(source, output)
        report["walk"][name] = {
            "source": str(source.relative_to(ROOT)).replace("\\", "/"),
            "sourceSha256": digest(source),
            "output": str(output.relative_to(ROOT)).replace("\\", "/"),
            "outputSha256": digest(output),
            "frames": frames,
        }
    for name, source in EFFECT_INPUTS.items():
        output = EFFECT_OUTPUTS[name]
        frames = build_effect(source, output)
        report["effects"][name] = {
            "source": str(source.relative_to(ROOT)).replace("\\", "/"),
            "sourceSha256": digest(source),
            "output": str(output.relative_to(ROOT)).replace("\\", "/"),
            "outputSha256": digest(output),
            "frames": frames,
        }
    REPORT.parent.mkdir(parents=True, exist_ok=True)
    REPORT.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(REPORT)


if __name__ == "__main__":
    main()
