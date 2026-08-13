"""Build the four-frame legacy ARPG mythic equipped flash atlas.

The ImageGen source already contains four transparent temporal poses.  This
builder registers those poses into fixed 256px cells, hollows the centre so an
equipped item stays readable, quantizes both colour and alpha, and authors the
animation at 128px before a nearest-neighbour 2x enlargement.
"""

from __future__ import annotations

from collections import Counter
from hashlib import sha256
import json
from pathlib import Path

from PIL import Image, ImageEnhance


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "asset-sources/legacy-arpg/equipped-mythic-flash-source-v3.png"
OUTPUT = ROOT / "public/assets/effects/equipped-mythic-flash-v3.png"
REPORT = ROOT / "public/assets/effects/equipped-mythic-flash-v3.build.json"

FRAME_COUNT = 4
CELL = 256
LOW_CELL = CELL // 2
MIN_PADDING = 12
ALPHA_LEVELS = (0, 72, 128, 192, 255)

# A deliberately narrow early-2000s pre-render palette: dried crimson and
# dirty magenta carry the body, with only sparse warm ivory at the flash peak.
PALETTE = (
    (34, 3, 20),
    (52, 4, 30),
    (73, 5, 39),
    (96, 7, 45),
    (122, 9, 54),
    (151, 12, 66),
    (181, 18, 79),
    (91, 4, 82),
    (119, 6, 106),
    (148, 10, 132),
    (178, 17, 153),
    (205, 29, 171),
    (226, 50, 185),
    (239, 79, 195),
    (244, 111, 201),
    (235, 143, 190),
    (230, 180, 190),
    (239, 205, 197),
    (247, 226, 211),
    (255, 244, 225),
    (255, 252, 239),
)

# Peak frame 2 is largest and brightest; frame 0/3 remain legible recovery
# poses.  Every diameter leaves more than the required six logical pixels of
# padding before the 2x nearest-neighbour enlargement.
LOW_DIAMETERS = (88, 104, 112, 98)
BRIGHTNESS = (0.76, 0.96, 1.16, 0.82)


def digest(path: Path) -> str:
    return sha256(path.read_bytes()).hexdigest()


def nearest_alpha(value: int) -> int:
    return min(ALPHA_LEVELS, key=lambda level: abs(level - value))


def palette_image() -> Image.Image:
    values = [component for colour in PALETTE for component in colour]
    values.extend([0] * (768 - len(values)))
    image = Image.new("P", (1, 1))
    image.putpalette(values)
    return image


def crop_visible(frame: Image.Image, margin: int = 4) -> Image.Image:
    bounds = frame.getchannel("A").getbbox()
    if bounds is None:
        raise ValueError("mythic flash source contains an empty frame")
    left, top, right, bottom = bounds
    return frame.crop((
        max(0, left - margin),
        max(0, top - margin),
        min(frame.width, right + margin),
        min(frame.height, bottom + margin),
    ))


def quantize_rgba(image: Image.Image) -> Image.Image:
    alpha = image.getchannel("A").point(nearest_alpha)
    rgb = image.convert("RGB").quantize(
        palette=palette_image(),
        dither=Image.Dither.FLOYDSTEINBERG,
    ).convert("RGB")
    rgb.putalpha(alpha)
    return rgb


def hollow_equipment_centre(image: Image.Image) -> Image.Image:
    """Keep the bright flash on the slot perimeter instead of over the item."""

    result = image.copy()
    pixels = result.load()
    centre = (LOW_CELL - 1) / 2
    inner_radius = 15.5
    outer_radius = 29.0
    for y in range(LOW_CELL):
        for x in range(LOW_CELL):
            red, green, blue, alpha = pixels[x, y]
            if alpha == 0:
                continue
            radius = ((x - centre) ** 2 + (y - centre) ** 2) ** 0.5
            if radius <= inner_radius:
                coverage = 0.0
            elif radius >= outer_radius:
                coverage = 1.0
            else:
                coverage = (radius - inner_radius) / (outer_radius - inner_radius)
            pixels[x, y] = (red, green, blue, nearest_alpha(round(alpha * coverage)))
    return result


def build_frame(source: Image.Image, index: int) -> Image.Image:
    motif = crop_visible(source)
    diameter = LOW_DIAMETERS[index]
    scale = min(diameter / motif.width, diameter / motif.height)
    resized = motif.resize(
        (max(1, round(motif.width * scale)), max(1, round(motif.height * scale))),
        Image.Resampling.LANCZOS,
    )
    resized = ImageEnhance.Brightness(resized).enhance(BRIGHTNESS[index])
    resized = quantize_rgba(resized)
    low = Image.new("RGBA", (LOW_CELL, LOW_CELL), (0, 0, 0, 0))
    low.alpha_composite(
        resized,
        ((LOW_CELL - resized.width) // 2, (LOW_CELL - resized.height) // 2),
    )
    low = hollow_equipment_centre(low)
    low = quantize_rgba(low)
    frame = low.resize((CELL, CELL), Image.Resampling.NEAREST)
    return quantize_rgba(frame)


def frame_metrics(frame: Image.Image, index: int) -> dict[str, object]:
    alpha = frame.getchannel("A")
    bounds = alpha.getbbox()
    if bounds is None:
        raise ValueError(f"mythic frame {index} is empty")
    left, top, right, bottom = bounds
    padding = [left, top, CELL - right, CELL - bottom]
    if min(padding) < MIN_PADDING:
        raise ValueError(f"mythic frame {index} padding is {padding}")

    visible = []
    bright = 0
    black = 0
    chroma = 0
    for red, green, blue, coverage in frame.get_flattened_data():
        if coverage == 0:
            continue
        visible.append((red, green, blue, coverage))
        luminance = red * 0.299 + green * 0.587 + blue * 0.114
        if luminance >= 210:
            bright += 1
        if luminance < 12:
            black += 1
        if blue > red * 1.35 and blue > green * 1.35:
            chroma += 1
    if not visible:
        raise ValueError(f"mythic frame {index} has no visible pixels")
    colours = Counter(pixel[:3] for pixel in visible)
    return {
        "frame": index,
        "alphaBounds": [left, top, right, bottom],
        "padding": padding,
        "visiblePixels": len(visible),
        "visibleColourCount": len(colours),
        "alphaLevels": sorted(set(alpha.get_flattened_data())),
        "brightPixelRatio": round(bright / len(visible), 6),
        "visibleBlackPixels": black,
        "chromaPixels": chroma,
        "pixelHash": sha256(frame.tobytes()).hexdigest(),
    }


def main() -> None:
    source = Image.open(SOURCE).convert("RGBA")
    if source.width % FRAME_COUNT != 0:
        raise ValueError(f"source width {source.width} is not divisible by {FRAME_COUNT}")
    source_cell = source.width // FRAME_COUNT
    atlas = Image.new("RGBA", (CELL * FRAME_COUNT, CELL), (0, 0, 0, 0))
    frames = []
    for index in range(FRAME_COUNT):
        source_frame = source.crop(
            (index * source_cell, 0, (index + 1) * source_cell, source.height),
        )
        frame = build_frame(source_frame, index)
        atlas.alpha_composite(frame, (index * CELL, 0))
        frames.append(frame_metrics(frame, index))

    if len({frame["pixelHash"] for frame in frames}) != FRAME_COUNT:
        raise ValueError("mythic flash animation must contain four distinct frames")
    if not (
        frames[2]["brightPixelRatio"] > frames[0]["brightPixelRatio"] * 1.6
        and frames[2]["brightPixelRatio"] > frames[3]["brightPixelRatio"] * 1.6
    ):
        raise ValueError("frame 2 does not read as the temporal brightness peak")

    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    atlas.save(OUTPUT, optimize=True)
    report = {
        "source": str(SOURCE.relative_to(ROOT)).replace("\\", "/"),
        "sourceSha256": digest(SOURCE),
        "output": str(OUTPUT.relative_to(ROOT)).replace("\\", "/"),
        "outputSha256": digest(OUTPUT),
        "format": "RGBA PNG",
        "atlas": {"columns": FRAME_COUNT, "rows": 1, "cell": [CELL, CELL]},
        "pipeline": {
            "logicalCell": [LOW_CELL, LOW_CELL],
            "upscale": "nearest-neighbour-2x",
            "minimumPadding": MIN_PADDING,
            "alphaLevels": list(ALPHA_LEVELS),
            "palette": [list(colour) for colour in PALETTE],
            "centreTreatment": "transparent core with stepped radial feather",
        },
        "frames": frames,
    }
    REPORT.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(REPORT)


if __name__ == "__main__":
    main()
