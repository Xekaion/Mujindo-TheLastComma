from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


ROOT = Path(__file__).resolve().parents[1]
MAPS = ROOT / "public" / "assets" / "maps"
DOORS = ROOT / "public" / "assets" / "effects" / "room-doors-v2"
OUTPUT = ROOT / "tmp" / "door-qa" / "room-door-perspective-v2.png"
CELL = (256, 192)
DISPLAY = (480, 270)
ROOMS = [
    "room-battle",
    "room-horde",
    "room-elite",
    "room-memory",
    "room-shelter",
    "room-boss",
    "room-drowned-archive",
    "room-rootbound-ossuary",
    "room-shattered-astrarium",
]
ARCHWAY_CROPS = ((718, 0, 164, 128), (1444, 374, 156, 152), (706, 770, 188, 130), (0, 374, 156, 152))
CROPS = {room: ARCHWAY_CROPS for room in ROOMS}


def composite(room: str, frame: int) -> Image.Image:
    background = Image.open(MAPS / f"{room}.webp").convert("RGBA")
    atlas = Image.open(DOORS / f"{room}-doors-v2.webp").convert("RGBA")
    for row, (x, y, width, height) in enumerate(CROPS[room]):
        cell = atlas.crop((frame * CELL[0], row * CELL[1], (frame + 1) * CELL[0], (row + 1) * CELL[1]))
        cell = cell.resize((width, height), Image.Resampling.LANCZOS)
        background.alpha_composite(cell, (x, y))
    return background.convert("RGB").resize(DISPLAY, Image.Resampling.LANCZOS)


def main() -> None:
    margin = 38
    canvas = Image.new("RGB", (DISPLAY[0] * 2, (DISPLAY[1] + margin) * len(ROOMS)), (8, 8, 10))
    draw = ImageDraw.Draw(canvas)
    font = ImageFont.load_default()
    for row, room in enumerate(ROOMS):
        y = row * (DISPLAY[1] + margin)
        canvas.paste(composite(room, 0), (0, y))
        canvas.paste(composite(room, 3), (DISPLAY[0], y))
        draw.text((8, y + DISPLAY[1] + 8), f"{room} | CLOSED", fill=(240, 222, 185), font=font)
        draw.text((DISPLAY[0] + 8, y + DISPLAY[1] + 8), "FRAME 4 / 6", fill=(135, 232, 240), font=font)
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(OUTPUT, optimize=True)
    print(OUTPUT)


if __name__ == "__main__":
    main()
