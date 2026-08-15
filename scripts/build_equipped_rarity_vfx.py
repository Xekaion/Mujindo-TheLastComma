"""Build compact mythic/cosmic equipped-item aura atlases.

The generated source contains one authored circular motif per rarity. Runtime
draws the motif around individual paperdoll slot anchors, so one 4-frame strip
serves all ten slots without decoding twenty full character atlases.
"""

from __future__ import annotations

from hashlib import sha256
import json
from pathlib import Path

from PIL import Image, ImageEnhance


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "asset-sources/legacy-arpg/equipped-rarity-aura-source-v1.png"
OUTPUTS = {
    "mythic": ROOT / "public/assets/effects/equipped-mythic-aura-v1.png",
    "cosmic": ROOT / "public/assets/effects/equipped-cosmic-aura-v1.png",
}
REPORT = ROOT / "public/assets/effects/equipped-rarity-aura-v1.build.json"
CELL = 256
FRAME_COUNT = 4


def digest(path: Path) -> str:
    return sha256(path.read_bytes()).hexdigest()


def alpha_bounds(image: Image.Image) -> tuple[int, int, int, int]:
    bounds = image.getchannel("A").getbbox()
    if bounds is None:
        raise ValueError("source motif has no visible pixels")
    return bounds


def centered_square_crop(image: Image.Image, bounds: tuple[int, int, int, int]) -> Image.Image:
    left, top, right, bottom = bounds
    width, height = right - left, bottom - top
    side = max(width, height)
    center_x = (left + right) / 2
    center_y = (top + bottom) / 2
    crop_left = max(0, min(image.width - side, round(center_x - side / 2)))
    crop_top = max(0, min(image.height - side, round(center_y - side / 2)))
    return image.crop((crop_left, crop_top, crop_left + side, crop_top + side))


def multiply_alpha(image: Image.Image, amount: float) -> Image.Image:
    result = image.copy()
    alpha = result.getchannel("A").point(lambda value: round(value * amount))
    result.putalpha(alpha)
    return result


def build_strip(motif: Image.Image, rarity: str) -> tuple[Image.Image, list[dict[str, object]]]:
    strip = Image.new("RGBA", (CELL * FRAME_COUNT, CELL), (0, 0, 0, 0))
    frame_specs = (
        (0.78, -2.5, 0.86),
        (0.88, 1.5, 0.96),
        (0.98, 4.5, 1.08),
        # A distinct return pose keeps the loop alive instead of holding frame
        # 1 twice. Its smaller counter-rotation eases naturally back to frame 0.
        (0.85, -0.5, 0.93),
    )
    frames: list[dict[str, object]] = []
    for index, (scale, angle, brightness) in enumerate(frame_specs):
        size = max(1, round(220 * scale))
        resized = motif.resize((size, size), Image.Resampling.LANCZOS)
        rotated = resized.rotate(angle, resample=Image.Resampling.BICUBIC, expand=True)
        rotated = ImageEnhance.Brightness(rotated).enhance(brightness)
        rotated = multiply_alpha(rotated, 0.88 if rarity == "mythic" else 0.92)
        if rotated.width > CELL - 12 or rotated.height > CELL - 12:
            rotated.thumbnail((CELL - 12, CELL - 12), Image.Resampling.LANCZOS)
        # Centre the visible alpha, not the source rectangle. Image-generation
        # motifs often have long one-sided sparks; rectangle centring made the
        # apparent halo drift left of its anatomical paperdoll anchor.
        visible_left, visible_top, visible_right, visible_bottom = alpha_bounds(rotated)
        visible_center_x = (visible_left + visible_right) / 2
        visible_center_y = (visible_top + visible_bottom) / 2
        x = index * CELL + round(CELL / 2 - visible_center_x)
        y = round(CELL / 2 - visible_center_y)
        strip.alpha_composite(rotated, (x, y))
        cell = strip.crop((index * CELL, 0, (index + 1) * CELL, CELL))
        bounds = alpha_bounds(cell)
        frames.append({
            "frame": index,
            "scale": scale,
            "rotationDegrees": angle,
            "alphaBounds": list(bounds),
            "pixelHash": sha256(cell.tobytes()).hexdigest(),
        })
    return strip, frames


def main() -> None:
    source = Image.open(SOURCE).convert("RGBA")
    midpoint = source.width // 2
    halves = {
        "mythic": source.crop((0, 0, midpoint, source.height)),
        "cosmic": source.crop((midpoint, 0, source.width, source.height)),
    }
    report: dict[str, object] = {
        "source": SOURCE.name,
        "sourceSha256": digest(SOURCE),
        "format": "RGBA PNG",
        "atlas": {"columns": FRAME_COUNT, "rows": 1, "cell": [CELL, CELL]},
        "rarities": {},
    }
    for rarity, half in halves.items():
        motif = centered_square_crop(half, alpha_bounds(half))
        strip, frames = build_strip(motif, rarity)
        output = OUTPUTS[rarity]
        strip.save(output, optimize=True)
        report["rarities"][rarity] = {
            "output": output.name,
            "outputSha256": digest(output),
            "frames": frames,
        }
    REPORT.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(REPORT)


if __name__ == "__main__":
    main()
