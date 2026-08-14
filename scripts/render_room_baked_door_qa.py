"""Render contact sheets from the production v3 room-baked door atlases."""

from pathlib import Path

from PIL import Image, ImageDraw


ROOT = Path(__file__).resolve().parents[1]
MAPS = ROOT / "public" / "assets" / "maps"
DOORS = ROOT / "public" / "assets" / "effects" / "room-doors-v3"
OUTPUT = ROOT / "tmp" / "door-qa"
SIDES = ("north", "east", "south", "west")
CROPS = {
    "north": (718, 0, 164, 128),
    "east": (1444, 374, 156, 152),
    "south": (706, 770, 188, 130),
    "west": (0, 374, 156, 152),
}
CELL = (188, 152)


def composite(stem: str, frame: int) -> Image.Image:
    room = Image.open(MAPS / f"{stem}.webp").convert("RGB")
    atlas = Image.open(DOORS / f"{stem}-doors-v3.webp").convert("RGB")
    for row, side in enumerate(SIDES):
        x, y, width, height = CROPS[side]
        patch = atlas.crop(
            (
                frame * CELL[0],
                row * CELL[1],
                frame * CELL[0] + width,
                row * CELL[1] + height,
            )
        )
        room.paste(patch, (x, y))
    return room


def build() -> None:
    OUTPUT.mkdir(parents=True, exist_ok=True)
    stems = sorted(path.stem for path in MAPS.glob("room-*.webp"))
    thumb = (480, 270)
    header = 24
    contact = Image.new("RGB", (thumb[0] * 3, (thumb[1] + header) * len(stems)), "#090a0c")
    draw = ImageDraw.Draw(contact)
    for row, stem in enumerate(stems):
        y = row * (thumb[1] + header)
        draw.text((8, y + 5), stem, fill="#e8dfc8")
        for column, frame in enumerate((0, 2, 5)):
            room = composite(stem, frame).resize(thumb, Image.Resampling.LANCZOS)
            contact.paste(room, (column * thumb[0], y + header))
            draw.text((column * thumb[0] + 8, y + header + 7), f"frame {frame}", fill="#fff1c5")
    contact.save(OUTPUT / "room-door-v3-all-backplates.png")

    detail = Image.new("RGB", (1280, 720 * 3), "black")
    for row, frame in enumerate((0, 2, 5)):
        room = composite("room-battle", frame).resize((1280, 720), Image.Resampling.LANCZOS)
        detail.paste(room, (0, row * 720))
    detail.save(OUTPUT / "room-battle-door-v3-detail.png")
    print(OUTPUT / "room-door-v3-all-backplates.png")
    print(OUTPUT / "room-battle-door-v3-detail.png")


if __name__ == "__main__":
    build()
