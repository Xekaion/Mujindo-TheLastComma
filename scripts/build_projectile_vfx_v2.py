from __future__ import annotations

import hashlib
import json
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFont, ImageStat


ROOT = Path(__file__).resolve().parents[1]
PROJECTILE_DIR = ROOT / "public" / "assets" / "effects" / "projectiles"
QA_DIR = ROOT / "tmp" / "vfx-qa"
AFFINITIES = (
    "arcane",
    "blood",
    "ember",
    "storm",
    "frost",
    "poison",
    "echo",
    "enemy",
    "witch",
    "boss",
)


def split_keyframes(sheet: Image.Image) -> list[Image.Image]:
    rgba = sheet.convert("RGBA")
    if rgba.size != (512, 512):
        raise ValueError(f"expected a 512x512 v1 sheet, got {rgba.size}")
    return [
        rgba.crop((column * 256, row * 256, (column + 1) * 256, (row + 1) * 256)).resize(
            (128, 128), Image.Resampling.LANCZOS
        )
        for row in range(2)
        for column in range(2)
    ]


def premultiplied_blend(left: Image.Image, right: Image.Image, amount: float) -> Image.Image:
    """Cross-dissolve RGBA frames without dark fringes around soft particles."""
    left = left.convert("RGBA")
    right = right.convert("RGBA")
    left_alpha = left.getchannel("A")
    right_alpha = right.getchannel("A")

    def premultiply(image: Image.Image, alpha: Image.Image) -> Image.Image:
        channels = image.split()[:3]
        return Image.merge(
            "RGB",
            tuple(ImageChops.multiply(channel, alpha) for channel in channels),
        )

    left_pm = premultiply(left, left_alpha)
    right_pm = premultiply(right, right_alpha)
    alpha = Image.blend(left_alpha, right_alpha, amount)
    premultiplied = Image.blend(left_pm, right_pm, amount)
    output = Image.new("RGBA", left.size)
    output_pixels = output.load()
    pm_pixels = premultiplied.load()
    alpha_pixels = alpha.load()
    for y in range(output.height):
        for x in range(output.width):
            a = alpha_pixels[x, y]
            if a <= 0:
                continue
            r, g, b = pm_pixels[x, y]
            scale = 255 / a
            output_pixels[x, y] = (
                min(255, round(r * scale)),
                min(255, round(g * scale)),
                min(255, round(b * scale)),
                a,
            )
    return output


def build_sixteen_frames(keyframes: list[Image.Image]) -> list[Image.Image]:
    frames: list[Image.Image] = []
    for index, current in enumerate(keyframes):
        following = keyframes[(index + 1) % len(keyframes)]
        for subframe in range(4):
            frames.append(premultiplied_blend(current, following, subframe / 4))
    return frames


def pack_atlas(frames: list[Image.Image]) -> Image.Image:
    if len(frames) != 16:
        raise ValueError("projectile v2 requires exactly sixteen frames")
    atlas = Image.new("RGBA", (512, 512))
    for index, frame in enumerate(frames):
        atlas.alpha_composite(frame, ((index % 4) * 128, (index // 4) * 128))
    return atlas


def frame_digest(frame: Image.Image) -> str:
    return hashlib.sha256(frame.tobytes()).hexdigest()


def validate(atlas: Image.Image, affinity: str) -> dict[str, object]:
    if atlas.mode != "RGBA" or atlas.size != (512, 512):
        raise ValueError(f"{affinity}: invalid atlas contract {atlas.mode} {atlas.size}")
    frames = [
        atlas.crop((column * 128, row * 128, (column + 1) * 128, (row + 1) * 128))
        for row in range(4)
        for column in range(4)
    ]
    digests = [frame_digest(frame) for frame in frames]
    if len(set(digests)) != 16:
        raise ValueError(f"{affinity}: duplicated animation frames")
    alpha_coverages: list[float] = []
    for index, frame in enumerate(frames):
        alpha = frame.getchannel("A")
        if alpha.getextrema() != (0, 255):
            raise ValueError(f"{affinity}: frame {index} has incomplete alpha range")
        corners = (
            alpha.getpixel((0, 0)),
            alpha.getpixel((127, 0)),
            alpha.getpixel((0, 127)),
            alpha.getpixel((127, 127)),
        )
        if max(corners) > 8:
            raise ValueError(f"{affinity}: frame {index} clips a corner")
        alpha_coverages.append(round(ImageStat.Stat(alpha).mean[0] / 255, 4))
    return {
        "affinity": affinity,
        "frames": 16,
        "uniqueFrames": len(set(digests)),
        "alphaCoverage": alpha_coverages,
    }


def build_contact_sheet() -> Path:
    destination = QA_DIR / "projectile-v2-16-frame-contact-sheet.png"
    canvas = Image.new("RGB", (1120, 1460), (9, 12, 17))
    draw = ImageDraw.Draw(canvas)
    font = ImageFont.load_default()
    draw.text((24, 16), "PROJECTILE V2 - 16 UNIQUE FRAMES / 30 FPS", fill=(230, 213, 164), font=font)
    for affinity_index, affinity in enumerate(AFFINITIES):
        atlas = Image.open(PROJECTILE_DIR / f"{affinity}-v2.png").convert("RGBA")
        top = 48 + affinity_index * 140
        draw.text((24, top + 48), affinity, fill=(224, 230, 238), font=font)
        for frame_index in range(16):
            column = frame_index % 4
            row = frame_index // 4
            frame = atlas.crop((column * 128, row * 128, (column + 1) * 128, (row + 1) * 128))
            frame = frame.resize((60, 60), Image.Resampling.LANCZOS)
            x = 116 + frame_index * 61
            checker = Image.new("RGB", (60, 60), (20, 24, 31))
            checker_draw = ImageDraw.Draw(checker)
            for yy in range(0, 60, 10):
                for xx in range(0, 60, 10):
                    if (xx // 10 + yy // 10) % 2:
                        checker_draw.rectangle((xx, yy, xx + 9, yy + 9), fill=(35, 40, 49))
            checker.paste(frame.convert("RGB"), mask=frame.getchannel("A"))
            canvas.paste(checker, (x, top))
            draw.text((x + 22, top + 64), str(frame_index + 1), fill=(139, 151, 168), font=font)
    canvas.save(destination, optimize=True)
    return destination


def main() -> None:
    QA_DIR.mkdir(parents=True, exist_ok=True)
    report: list[dict[str, object]] = []
    for affinity in AFFINITIES:
        source = PROJECTILE_DIR / f"{affinity}-v1.png"
        destination = PROJECTILE_DIR / f"{affinity}-v2.png"
        atlas = pack_atlas(build_sixteen_frames(split_keyframes(Image.open(source))))
        report.append(validate(atlas, affinity))
        atlas.save(destination, optimize=True)
    contact_sheet = build_contact_sheet()
    report_path = QA_DIR / "projectile-v2-report.json"
    report_path.write_text(
        json.dumps(
            {
                "source": "imagegen-authored v1 keyframes",
                "method": "premultiplied RGBA in-betweening; no repeated frames",
                "layout": "4x4",
                "playbackFps": 30,
                "assets": report,
                "contactSheet": contact_sheet.relative_to(ROOT).as_posix(),
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )
    print(json.dumps({"assets": len(report), "contactSheet": str(contact_sheet)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
