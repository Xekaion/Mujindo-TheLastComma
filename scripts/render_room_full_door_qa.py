"""Render compact QA sheets from the production v4 full-room atlases."""

from pathlib import Path

from PIL import Image, ImageDraw, ImageOps


ROOT = Path(__file__).resolve().parents[1]
MAPS = ROOT / "public" / "assets" / "maps"
ATLASES = MAPS / "room-doors-v4"
OUTPUT = ROOT / "tmp" / "door-qa-v4"
FRAME_SIZE = (1280, 720)
THUMB = (480, 270)
HEADER = 24
DOOR_CROPS = {
    "north": (574, 0, 706, 103),
    "east": (1155, 299, 1280, 421),
    "south": (565, 616, 716, 720),
    "west": (0, 299, 125, 421),
}
DOOR_DETAIL = (300, 240)


def atlas_frame(atlas: Image.Image, frame: int) -> Image.Image:
    column = frame % 2
    row = frame // 2
    x = column * FRAME_SIZE[0]
    y = row * FRAME_SIZE[1]
    return atlas.crop((x, y, x + FRAME_SIZE[0], y + FRAME_SIZE[1]))


def build() -> None:
    OUTPUT.mkdir(parents=True, exist_ok=True)
    stems = sorted(
        path.name.removesuffix("-doors-v4.webp")
        for path in ATLASES.glob("room-*-doors-v4.webp")
    )
    sheet = Image.new(
        "RGB",
        (THUMB[0] * 3, (THUMB[1] + HEADER) * len(stems)),
        "#090a0c",
    )
    draw = ImageDraw.Draw(sheet)
    for row, stem in enumerate(stems):
        atlas = Image.open(ATLASES / f"{stem}-doors-v4.webp").convert("RGB")
        y = row * (THUMB[1] + HEADER)
        draw.text((8, y + 5), stem, fill="#e8dfc8")
        for column, frame in enumerate((0, 2, 5)):
            image = atlas_frame(atlas, frame).resize(THUMB, Image.Resampling.LANCZOS)
            sheet.paste(image, (column * THUMB[0], y + HEADER))
            draw.text(
                (column * THUMB[0] + 8, y + HEADER + 7),
                f"full frame {frame}",
                fill="#fff1c5",
            )
    output = OUTPUT / "room-door-v4-all-full-rooms.png"
    sheet.save(output)
    print(output)

    for frame in (0, 2):
        details = Image.new(
            "RGB",
            (
                DOOR_DETAIL[0] * len(DOOR_CROPS),
                (DOOR_DETAIL[1] + HEADER) * len(stems),
            ),
            "#090a0c",
        )
        detail_draw = ImageDraw.Draw(details)
        for row, stem in enumerate(stems):
            atlas = Image.open(ATLASES / f"{stem}-doors-v4.webp").convert("RGB")
            room = atlas_frame(atlas, frame)
            y = row * (DOOR_DETAIL[1] + HEADER)
            detail_draw.text((8, y + 5), stem, fill="#e8dfc8")
            for column, (side, crop) in enumerate(DOOR_CROPS.items()):
                doorway = room.crop(crop)
                doorway = ImageOps.contain(
                    doorway,
                    DOOR_DETAIL,
                    Image.Resampling.LANCZOS,
                )
                panel_x = column * DOOR_DETAIL[0]
                panel_y = y + HEADER
                paste_x = panel_x + (DOOR_DETAIL[0] - doorway.width) // 2
                paste_y = panel_y + (DOOR_DETAIL[1] - doorway.height) // 2
                details.paste(doorway, (paste_x, paste_y))
                detail_draw.text(
                    (panel_x + 8, panel_y + 7),
                    f"{side} / full frame {frame}",
                    fill="#fff1c5",
                )
        detail_output = OUTPUT / f"room-door-v4-frame-{frame}-door-details.png"
        details.save(detail_output)
        print(detail_output)


if __name__ == "__main__":
    build()
