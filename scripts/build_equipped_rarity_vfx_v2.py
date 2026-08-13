"""Build late-1990s/early-2000s ARPG equipped-rarity aura atlases.

The authored source is deliberately generated on a saturated blue backing so
the two painted motifs can be recovered without inventing a smooth procedural
halo at runtime.  This builder removes/despills that backing, reduces every
motif to a shared hand-picked dark palette, steps alpha, and performs all
animation transforms at half resolution before nearest-neighbour enlargement.
The result keeps coarse pre-rendered pixels and dither in all four frames.
"""

from __future__ import annotations

from collections import Counter
from hashlib import sha256
import json
from pathlib import Path

from PIL import Image, ImageEnhance


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "asset-sources/legacy-arpg/equipped-rarity-legacy-source-v2.png"
OUTPUTS = {
    "mythic": ROOT / "public/assets/effects/equipped-mythic-aura-v2.png",
    "cosmic": ROOT / "public/assets/effects/equipped-cosmic-aura-v2.png",
}
REPORT = ROOT / "public/assets/effects/equipped-rarity-aura-v2.build.json"
CELL = 256
LOW_CELL = CELL // 2
FRAME_COUNT = 4
MIN_PADDING = 12
ALPHA_LEVELS = (0, 72, 128, 192, 255)

# Fixed palettes prevent per-frame color drift.  They intentionally favor
# soot, tarnished metal and muted rarity accents rather than full-spectrum
# modern neon bloom.
PALETTES = {
    "mythic": (
        (4, 4, 7), (10, 7, 12), (18, 9, 18), (29, 11, 25),
        (43, 14, 32), (61, 17, 40), (82, 21, 49), (108, 29, 59),
        (138, 39, 70), (168, 55, 82), (198, 77, 98), (219, 108, 124),
        (38, 36, 38), (67, 62, 61), (103, 94, 88), (146, 132, 119),
        (190, 172, 151), (224, 207, 183),
    ),
    "cosmic": (
        (3, 4, 8), (5, 7, 15), (8, 10, 25), (11, 15, 37),
        (14, 21, 51), (19, 29, 67), (24, 40, 82), (29, 54, 98),
        (35, 72, 112), (43, 94, 125), (56, 119, 136), (78, 143, 148),
        (31, 28, 49), (48, 40, 72), (70, 55, 95), (98, 78, 116),
        (43, 42, 45), (78, 74, 74), (121, 113, 106), (174, 160, 145),
        (216, 201, 182),
    ),
}


def digest(path: Path) -> str:
    return sha256(path.read_bytes()).hexdigest()


def nearest_level(value: int, levels: tuple[int, ...]) -> int:
    return min(levels, key=lambda level: abs(level - value))


def chroma_alpha(red: int, green: int, blue: int) -> int:
    """Return coverage based on distance from the sampled pure-blue key.

    The generated backing varies by a few channel values, so exact comparison
    leaves a rectangle.  Distance protects the motif's near-black navy while a
    short ramp retains its intentionally jagged anti-aliased silhouette.
    """

    distance = ((red - 0) ** 2 + (green - 2) ** 2 + (blue - 253) ** 2) ** 0.5
    if distance <= 20:
        return 0
    if distance >= 76:
        return 255
    return round((distance - 20) / 56 * 255)


def remove_chroma_and_despill(source: Image.Image) -> Image.Image:
    rgba = source.convert("RGBA")
    output = Image.new("RGBA", rgba.size, (0, 0, 0, 0))
    result: list[tuple[int, int, int, int]] = []
    for red, green, blue, _ in rgba.get_flattened_data():
        alpha = chroma_alpha(red, green, blue)
        if alpha == 0:
            result.append((0, 0, 0, 0))
            continue
        # Only partial edge pixels are despilled. Fully covered cosmic blues
        # are authored color and must not be mistaken for the backing.
        if alpha < 240:
            blue = min(blue, round(max(red, green) * 1.35 + 12))
        result.append((red, green, blue, nearest_level(alpha, ALPHA_LEVELS)))
    output.putdata(result)
    return output


def crop_visible(image: Image.Image, margin: int = 4) -> Image.Image:
    bounds = image.getchannel("A").getbbox()
    if bounds is None:
        raise ValueError("chroma removal erased the full motif")
    left, top, right, bottom = bounds
    return image.crop((
        max(0, left - margin),
        max(0, top - margin),
        min(image.width, right + margin),
        min(image.height, bottom + margin),
    ))


def palette_image(colors: tuple[tuple[int, int, int], ...]) -> Image.Image:
    palette = [component for color in colors for component in color]
    palette.extend([0] * (768 - len(palette)))
    image = Image.new("P", (1, 1))
    image.putpalette(palette)
    return image


def quantize_rgba(image: Image.Image, rarity: str) -> Image.Image:
    alpha = image.getchannel("A").point(
        lambda value: nearest_level(value, ALPHA_LEVELS),
    )
    rgb = image.convert("RGB").quantize(
        palette=palette_image(PALETTES[rarity]),
        dither=Image.Dither.FLOYDSTEINBERG,
    ).convert("RGB")
    rgb.putalpha(alpha)
    return rgb


def alpha_bounds(image: Image.Image) -> tuple[int, int, int, int]:
    bounds = image.getchannel("A").getbbox()
    if bounds is None:
        raise ValueError("frame has no visible pixels")
    return bounds


def center_on_cell(image: Image.Image) -> Image.Image:
    canvas = Image.new("RGBA", (LOW_CELL, LOW_CELL), (0, 0, 0, 0))
    left, top, right, bottom = alpha_bounds(image)
    center_x = (left + right) / 2
    center_y = (top + bottom) / 2
    x = round(LOW_CELL / 2 - center_x)
    y = round(LOW_CELL / 2 - center_y)
    canvas.alpha_composite(image, (x, y))
    return canvas


def frame_metrics(frame: Image.Image) -> dict[str, object]:
    left, top, right, bottom = alpha_bounds(frame)
    alpha = frame.getchannel("A")
    visible = sum(1 for value in alpha.get_flattened_data() if value > 0)
    alpha_values = sorted(set(alpha.get_flattened_data()))
    luminance = frame.convert("RGB").convert("L")
    bright = sum(
        1
        for light, coverage in zip(
            luminance.get_flattened_data(),
            alpha.get_flattened_data(),
        )
        if coverage > 0 and light >= 220
    )
    colors = Counter(
        pixel[:3]
        for pixel in frame.get_flattened_data()
        if pixel[3] > 0
    )
    return {
        "alphaBounds": [left, top, right, bottom],
        "padding": [left, top, CELL - right, CELL - bottom],
        "visiblePixels": visible,
        "alphaLevels": alpha_values,
        "uniqueVisibleColors": len(colors),
        "brightPixelRatio": round(bright / visible, 6),
        "pixelHash": sha256(frame.tobytes()).hexdigest(),
    }


def build_strip(motif: Image.Image, rarity: str) -> tuple[Image.Image, list[dict[str, object]]]:
    strip = Image.new("RGBA", (CELL * FRAME_COUNT, CELL), (0, 0, 0, 0))
    # Work at 128x128 and enlarge with nearest-neighbour. This is the authored
    # animation itself, not a CSS filter, so runtime scaling cannot reintroduce
    # smooth vector-like gradients.
    specs = (
        (94, -4, 0.88, -1, 1),
        (102, -1, 0.96, 1, 0),
        (110, 3, 1.04, 0, -1),
        (100, 1, 0.92, -1, 0),
    )
    metrics: list[dict[str, object]] = []
    for index, (diameter, angle, brightness, shift_x, shift_y) in enumerate(specs):
        scale = min(diameter / motif.width, diameter / motif.height)
        resized = motif.resize(
            (max(1, round(motif.width * scale)), max(1, round(motif.height * scale))),
            Image.Resampling.LANCZOS,
        )
        resized = ImageEnhance.Brightness(resized).enhance(brightness)
        resized = quantize_rgba(resized, rarity)
        rotated = resized.rotate(
            angle,
            resample=Image.Resampling.NEAREST,
            expand=True,
        )
        low_frame = center_on_cell(rotated)
        if shift_x or shift_y:
            shifted = Image.new("RGBA", low_frame.size, (0, 0, 0, 0))
            shifted.alpha_composite(low_frame, (shift_x, shift_y))
            low_frame = shifted
        frame = low_frame.resize((CELL, CELL), Image.Resampling.NEAREST)
        frame = quantize_rgba(frame, rarity)
        bounds = alpha_bounds(frame)
        padding = (bounds[0], bounds[1], CELL - bounds[2], CELL - bounds[3])
        if min(padding) < MIN_PADDING:
            raise ValueError(f"{rarity} frame {index} padding is {padding}")
        strip.alpha_composite(frame, (index * CELL, 0))
        frame_report = frame_metrics(frame)
        frame_report.update({
            "frame": index,
            "lowResolutionDiameter": diameter,
            "rotationDegrees": angle,
        })
        metrics.append(frame_report)
    return strip, metrics


def main() -> None:
    source = Image.open(SOURCE).convert("RGBA")
    midpoint = source.width // 2
    halves = {
        "mythic": source.crop((0, 0, midpoint, source.height)),
        "cosmic": source.crop((midpoint, 0, source.width, source.height)),
    }
    report: dict[str, object] = {
        "source": str(SOURCE.relative_to(ROOT)).replace("\\", "/"),
        "sourceSha256": digest(SOURCE),
        "format": "RGBA PNG",
        "atlas": {"columns": FRAME_COUNT, "rows": 1, "cell": [CELL, CELL]},
        "pipeline": {
            "chromaKey": [0, 2, 253],
            "alphaLevels": list(ALPHA_LEVELS),
            "lowResolutionCell": [LOW_CELL, LOW_CELL],
            "upscale": "nearest-neighbour",
            "minimumPadding": MIN_PADDING,
        },
        "rarities": {},
    }
    for rarity, half in halves.items():
        motif = crop_visible(remove_chroma_and_despill(half))
        strip, frames = build_strip(motif, rarity)
        output = OUTPUTS[rarity]
        output.parent.mkdir(parents=True, exist_ok=True)
        strip.save(output, optimize=True)
        report["rarities"][rarity] = {
            "output": str(output.relative_to(ROOT)).replace("\\", "/"),
            "outputSha256": digest(output),
            "paletteSize": len(PALETTES[rarity]),
            "frames": frames,
        }
    REPORT.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(REPORT)


if __name__ == "__main__":
    main()
