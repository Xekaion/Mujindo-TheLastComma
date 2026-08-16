"""Build authored mythic/cosmic world-announcement animation atlases.

Image generation supplies one clean, transparent ornamental frame per rarity.
This deterministic builder turns each source into eight subtly different
light/energy poses while preserving one exact 1024x128 runtime cell contract.
"""

from __future__ import annotations

from hashlib import sha256
import json
from pathlib import Path

from PIL import Image, ImageEnhance, ImageFilter


ROOT = Path(__file__).resolve().parents[1]
SOURCE_ROOT = ROOT / "asset-sources" / "imagegen"
OUTPUT_ROOT = ROOT / "public" / "assets" / "ui"
REPORT = OUTPUT_ROOT / "world-announcement-v1.build.json"
CELL_WIDTH = 1024
CELL_HEIGHT = 128
COLUMNS = 4
ROWS = 2
ALPHA_THRESHOLD = 8
SAFE_X = (218, 806)
# The live copy is centred between the authored top and bottom rails.  Measuring
# the whole inner opening made those intentional rails count as text overlap,
# even though neither can ever sit behind the copy baseline.  Keep this band
# deliberately narrower than a 32 px CSS text line after the 128 -> 96 px UI
# scale, while retaining generous ascender/descender clearance.
SAFE_Y = (46, 82)
ART_WIDTH = 992
ART_HEIGHT = 110


def visible_bounds(image: Image.Image) -> tuple[int, int, int, int]:
    mask = image.getchannel("A").point(
        lambda value: 255 if value >= ALPHA_THRESHOLD else 0
    )
    bounds = mask.getbbox()
    if bounds is None:
        raise ValueError("world announcement source has no visible pixels")
    return bounds


def normalize_source(path: Path) -> Image.Image:
    source = Image.open(path).convert("RGBA")
    bounds = visible_bounds(source)
    cropped = source.crop(bounds)
    scale = ART_HEIGHT / cropped.height
    compact_width = max(1, round(cropped.width * scale))
    compact = cropped.convert("RGBa").resize(
        (compact_width, ART_HEIGHT), Image.Resampling.LANCZOS
    ).convert("RGBA")

    # Preserve the circular end crests and the sharp central crown without
    # distorting them. Only the naturally horizontal rail sections are extended
    # to the production banner width, which acts like an authored five-slice.
    cap_width = max(1, round(compact.width * 0.31))
    crest_width = max(1, round(compact.width * 0.13))
    center = compact.width // 2
    rail_left = compact.crop(
        (round(compact.width * 0.23), 0, center - crest_width // 3, ART_HEIGHT)
    )
    rail_right = compact.crop(
        (center + crest_width // 3, 0, round(compact.width * 0.77), ART_HEIGHT)
    )
    left_cap = compact.crop((0, 0, cap_width, ART_HEIGHT))
    right_cap = compact.crop((compact.width - cap_width, 0, compact.width, ART_HEIGHT))
    crest = compact.crop(
        (center - crest_width // 2, 0, center + crest_width // 2, ART_HEIGHT)
    )
    rail_target = (ART_WIDTH - cap_width * 2 - crest_width) // 2 + 10
    rail_left = rail_left.convert("RGBa").resize(
        (rail_target, ART_HEIGHT), Image.Resampling.LANCZOS
    ).convert("RGBA")
    rail_right = rail_right.convert("RGBa").resize(
        (rail_target, ART_HEIGHT), Image.Resampling.LANCZOS
    ).convert("RGBA")

    result = Image.new("RGBA", (ART_WIDTH, ART_HEIGHT), (0, 0, 0, 0))
    result.alpha_composite(rail_left, (cap_width - 10, 0))
    result.alpha_composite(
        rail_right,
        (ART_WIDTH - cap_width - rail_target + 10, 0),
    )
    result.alpha_composite(left_cap, (0, 0))
    result.alpha_composite(right_cap, (ART_WIDTH - cap_width, 0))
    result.alpha_composite(crest, ((ART_WIDTH - crest.width) // 2, 0))
    return result


def alpha_scaled(image: Image.Image, amount: float) -> Image.Image:
    result = image.copy()
    result.putalpha(
        result.getchannel("A").point(
            lambda value: max(0, min(255, round(value * amount)))
        )
    )
    return result


def build_atlas(source: Image.Image, rarity: str) -> tuple[Image.Image, list[dict[str, object]]]:
    atlas = Image.new(
        "RGBA",
        (CELL_WIDTH * COLUMNS, CELL_HEIGHT * ROWS),
        (0, 0, 0, 0),
    )
    # Brightness/alpha/scale form a controlled ignition -> crown -> afterglow
    # loop. Geometry changes remain under two pixels so live text never shifts.
    poses = (
        (0.90, 0.82, 0.986),
        (1.00, 0.94, 0.994),
        (1.10, 1.00, 1.000),
        (1.22, 1.00, 1.004),
        (1.34, 1.00, 1.008),
        (1.18, 0.98, 1.004),
        (1.08, 0.94, 1.000),
        (0.98, 0.88, 0.992),
    )
    frames: list[dict[str, object]] = []
    for index, (brightness, alpha, scale) in enumerate(poses):
        width = max(1, round(source.width * scale))
        height = max(1, round(source.height * scale))
        frame_art = source.resize((width, height), Image.Resampling.LANCZOS)
        frame_art = ImageEnhance.Brightness(frame_art).enhance(brightness)
        frame_art = alpha_scaled(frame_art, alpha)

        frame = Image.new("RGBA", (CELL_WIDTH, CELL_HEIGHT), (0, 0, 0, 0))
        x = (CELL_WIDTH - frame_art.width) // 2
        y = (CELL_HEIGHT - frame_art.height) // 2
        frame.alpha_composite(frame_art, (x, y))

        # A faint rarity-coloured bloom is part of the authored animation but
        # remains outside the live-copy safe zone.
        bloom = frame.getchannel("A").filter(ImageFilter.GaussianBlur(2.2))
        bloom_color = (255, 32, 126, 34) if rarity == "mythic" else (80, 220, 255, 38)
        glow = Image.new("RGBA", frame.size, bloom_color)
        glow.putalpha(bloom.point(lambda value: round(value * bloom_color[3] / 255)))
        glow.alpha_composite(frame)
        frame = glow

        column = index % COLUMNS
        row = index // COLUMNS
        atlas.alpha_composite(frame, (column * CELL_WIDTH, row * CELL_HEIGHT))
        bounds = visible_bounds(frame)
        safe_alpha = frame.getchannel("A").crop(
            (SAFE_X[0], SAFE_Y[0], SAFE_X[1], SAFE_Y[1])
        )
        safe_occupancy = sum(
            value > 56 for value in safe_alpha.get_flattened_data()
        ) / (
            safe_alpha.width * safe_alpha.height
        )
        frames.append(
            {
                "frame": index,
                "brightness": brightness,
                "alphaScale": alpha,
                "scale": scale,
                "alphaBounds": list(bounds),
                "safeAreaBrightOccupancy": round(safe_occupancy, 6),
                "pixelHash": sha256(frame.tobytes()).hexdigest(),
            }
        )
    return atlas, frames


def measure_saved_frames(
    path: Path,
    frames: list[dict[str, object]],
) -> list[dict[str, object]]:
    """Replace provisional metrics with measurements from the encoded PNG.

    Alpha compositing into the atlas can normalize otherwise invisible RGB
    values.  Hashing the in-memory source frame would therefore describe a
    subtly different byte stream than the cell shipped to the browser.  The
    build report must be an audit of the actual runtime file.
    """
    atlas = Image.open(path).convert("RGBA")
    measured: list[dict[str, object]] = []
    for index, frame_spec in enumerate(frames):
        column = index % COLUMNS
        row = index // COLUMNS
        cell = atlas.crop(
            (
                column * CELL_WIDTH,
                row * CELL_HEIGHT,
                (column + 1) * CELL_WIDTH,
                (row + 1) * CELL_HEIGHT,
            )
        )
        safe_alpha = cell.getchannel("A").crop(
            (SAFE_X[0], SAFE_Y[0], SAFE_X[1], SAFE_Y[1])
        )
        safe_values = safe_alpha.get_flattened_data()
        safe_occupancy = sum(value > 56 for value in safe_values) / (
            safe_alpha.width * safe_alpha.height
        )
        measured.append(
            {
                **frame_spec,
                "alphaBounds": list(visible_bounds(cell)),
                "safeAreaBrightOccupancy": round(safe_occupancy, 6),
                "pixelHash": sha256(cell.tobytes()).hexdigest(),
            }
        )
    return measured


def validate(path: Path, frames: list[dict[str, object]]) -> None:
    image = Image.open(path)
    expected = (CELL_WIDTH * COLUMNS, CELL_HEIGHT * ROWS)
    if image.mode != "RGBA" or image.size != expected:
        raise ValueError(f"{path.name}: expected RGBA {expected}, got {image.mode} {image.size}")
    if image.info.get("interlace", 0) not in (0, None):
        raise ValueError(f"{path.name}: interlaced PNGs are not permitted")
    for frame in frames:
        left, top, right, bottom = frame["alphaBounds"]
        if left < 12 or top < 8 or right > CELL_WIDTH - 12 or bottom > CELL_HEIGHT - 8:
            raise ValueError(f"{path.name}: frame {frame['frame']} exceeds safe gutter")
        if frame["safeAreaBrightOccupancy"] > 0.22:
            raise ValueError(f"{path.name}: frame {frame['frame']} crowds live-copy safe area")
    rgba = image.convert("RGBA")
    corners = ((0, 0), (image.width - 1, 0), (0, image.height - 1), (image.width - 1, image.height - 1))
    if any(rgba.getpixel(point)[3] != 0 for point in corners):
        raise ValueError(f"{path.name}: atlas corners must remain fully transparent")
    if len({frame["pixelHash"] for frame in frames}) != 8:
        raise ValueError(f"{path.name}: animation frames must all be unique")
    if path.stat().st_size > 3_000_000:
        raise ValueError(f"{path.name}: exceeds 3 MB UI asset budget")


def main() -> None:
    report: dict[str, object] = {
        "version": 1,
        "builder": "scripts/build_world_announcement_assets.py",
        "format": "RGBA PNG",
        "atlas": {
            "columns": COLUMNS,
            "rows": ROWS,
            "cell": [CELL_WIDTH, CELL_HEIGHT],
            "safeCopyArea": [SAFE_X[0], SAFE_Y[0], SAFE_X[1], SAFE_Y[1]],
        },
        "rarities": {},
    }
    for rarity in ("mythic", "cosmic"):
        source_path = SOURCE_ROOT / f"world-announcement-{rarity}-v1-source.png"
        source = normalize_source(source_path)
        atlas, frames = build_atlas(source, rarity)
        output = OUTPUT_ROOT / f"world-announcement-{rarity}-v1.png"
        atlas.save(output, format="PNG", optimize=True)
        frames = measure_saved_frames(output, frames)
        validate(output, frames)
        report["rarities"][rarity] = {
            "source": str(source_path.relative_to(ROOT)).replace("\\", "/"),
            "sourceSha256": sha256(source_path.read_bytes()).hexdigest(),
            "output": str(output.relative_to(ROOT)).replace("\\", "/"),
            "outputSha256": sha256(output.read_bytes()).hexdigest(),
            "bytes": output.stat().st_size,
            "frames": frames,
        }
        print(f"{output.relative_to(ROOT)} ({output.stat().st_size:,} bytes)")
    REPORT.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(REPORT.relative_to(ROOT))


if __name__ == "__main__":
    main()
