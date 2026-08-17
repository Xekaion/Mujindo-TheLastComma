from __future__ import annotations

import hashlib
import shutil
from pathlib import Path

from PIL import Image, ImageEnhance, ImageOps


ROOT = Path(__file__).resolve().parents[1]
SOURCE_ROOT = ROOT / "work" / "imagegen" / "inventory-v4"
ARRIVAL_SOURCE_ROOT = ROOT / "work" / "imagegen" / "loot-arrivals-v5"
UI_ROOT = ROOT / "public" / "assets" / "ui"
EFFECT_ROOT = ROOT / "public" / "assets" / "effects"
CELL_SIZE = 384
SPECTACLE_SIZE = 352
FIELD_CELL_SIZE = 256
FIELD_CONTENT_SIZE = 224
FIELD_EDGE_FADE = 8
ALPHA_THRESHOLD = 8

RARITIES = (
    "common",
    "magic",
    "superior",
    "rare",
    "epic",
    "legendary",
    "mythic",
    "cosmic",
)

UI_TINTS = {
    "common": ((18, 20, 24), (126, 132, 143), (238, 242, 248), 1.0),
    "magic": ((5, 20, 52), (33, 125, 255), (224, 247, 255), 1.0),
    "superior": ((5, 32, 24), (48, 185, 123), (226, 255, 232), 1.0),
    "rare": ((49, 27, 2), (239, 180, 49), (255, 252, 211), 1.0),
    "epic": ((35, 6, 57), (177, 63, 255), (255, 225, 255), 1.0),
}

def frame_cells(image: Image.Image) -> list[Image.Image]:
    x_edges = [round(index * image.width / 4) for index in range(5)]
    y_edges = [round(index * image.height / 2) for index in range(3)]
    return [
        image.crop((x_edges[column], y_edges[row], x_edges[column + 1], y_edges[row + 1]))
        for row in range(2)
        for column in range(4)
    ]


def normalize_spectacle(
    source_path: Path,
    cell_size: int = CELL_SIZE,
    spectacle_size: int = SPECTACLE_SIZE,
) -> Image.Image:
    source = Image.open(source_path).convert("RGBA")
    atlas = Image.new("RGBA", (cell_size * 4, cell_size * 2), (0, 0, 0, 0))
    for index, cell in enumerate(frame_cells(source)):
        alpha = cell.getchannel("A")
        mask = alpha.point(lambda value: 255 if value >= ALPHA_THRESHOLD else 0)
        bbox = mask.getbbox()
        if bbox is None:
            raise ValueError(f"{source_path.name}: frame {index} is empty")
        cropped = cell.crop(bbox).convert("RGBa")
        scale = min(spectacle_size / cropped.width, spectacle_size / cropped.height)
        size = (
            max(1, round(cropped.width * scale)),
            max(1, round(cropped.height * scale)),
        )
        resized = cropped.resize(size, Image.Resampling.LANCZOS).convert("RGBA")
        frame = Image.new("RGBA", (cell_size, cell_size), (0, 0, 0, 0))
        frame.alpha_composite(
            resized,
            ((cell_size - size[0]) // 2, (cell_size - size[1]) // 2),
        )
        atlas.alpha_composite(
            frame,
            ((index % 4) * cell_size, (index // 4) * cell_size),
        )
    return atlas


def tint_atlas(
    source: Image.Image,
    shadow: tuple[int, int, int],
    mid: tuple[int, int, int],
    highlight: tuple[int, int, int],
    alpha_scale: float,
) -> Image.Image:
    rgba = source.convert("RGBA")
    grayscale = ImageOps.grayscale(rgba)
    colored = ImageOps.colorize(grayscale, shadow, highlight, mid=mid).convert("RGBA")
    alpha = rgba.getchannel("A").point(
        lambda value: max(0, min(255, round(value * alpha_scale)))
    )
    colored.putalpha(alpha)
    return ImageEnhance.Contrast(colored).enhance(1.04)


def resize_sequence_preserving_scale(
    source_path: Path,
    *,
    clear_top_row_cross_cell_bleed: bool = False,
) -> Image.Image:
    """Apply one fixed transform to every frame so relative growth stays intact."""
    source = Image.open(source_path).convert("RGBA")
    if abs(source.width / source.height - 2) > 0.01:
        raise ValueError(f"{source_path.name}: field sequence must have a 2:1 canvas")
    if clear_top_row_cross_cell_bleed:
        seam_y = round(source.height / 2)
        guard_height = max(24, round(source.height * 0.036))
        source.paste(
            Image.new("RGBA", (source.width, guard_height), (0, 0, 0, 0)),
            (0, seam_y - guard_height),
        )
    atlas = Image.new(
        "RGBA",
        (FIELD_CELL_SIZE * 4, FIELD_CELL_SIZE * 2),
        (0, 0, 0, 0),
    )
    inset = (FIELD_CELL_SIZE - FIELD_CONTENT_SIZE) // 2
    edge_mask = Image.new("L", (FIELD_CONTENT_SIZE, FIELD_CONTENT_SIZE), 255)
    edge_pixels = edge_mask.load()
    for y in range(FIELD_CONTENT_SIZE):
        for x in range(FIELD_CONTENT_SIZE):
            distance = min(x, y, FIELD_CONTENT_SIZE - 1 - x, FIELD_CONTENT_SIZE - 1 - y)
            if distance < FIELD_EDGE_FADE:
                edge_pixels[x, y] = round(255 * distance / FIELD_EDGE_FADE)

    for index, cell in enumerate(frame_cells(source)):
        resized = cell.convert("RGBa").resize(
            (FIELD_CONTENT_SIZE, FIELD_CONTENT_SIZE),
            Image.Resampling.LANCZOS,
        ).convert("RGBA")
        alpha = resized.getchannel("A")
        alpha = Image.composite(alpha, Image.new("L", alpha.size, 0), edge_mask)
        resized.putalpha(alpha)
        atlas.alpha_composite(
            resized,
            (
                (index % 4) * FIELD_CELL_SIZE + inset,
                (index // 4) * FIELD_CELL_SIZE + inset,
            ),
        )
    return atlas


def alpha_support_hash(path: Path) -> str:
    alpha = Image.open(path).convert("RGBA").getchannel("A")
    support = alpha.point(lambda value: 255 if value >= ALPHA_THRESHOLD else 0)
    return hashlib.sha256(support.tobytes()).hexdigest()


def validate_atlas(path: Path, expected_cell: int = CELL_SIZE) -> None:
    image = Image.open(path).convert("RGBA")
    expected_size = (expected_cell * 4, expected_cell * 2)
    if image.size != expected_size:
        raise ValueError(f"{path.name}: expected {expected_size}, got {image.size}")
    hashes: list[str] = []
    for index, cell in enumerate(frame_cells(image)):
        alpha = cell.getchannel("A")
        bbox = alpha.point(lambda value: 255 if value >= ALPHA_THRESHOLD else 0).getbbox()
        if bbox is None:
            raise ValueError(f"{path.name}: frame {index} is empty")
        if bbox[0] <= 0 or bbox[1] <= 0 or bbox[2] >= expected_cell or bbox[3] >= expected_cell:
            raise ValueError(f"{path.name}: frame {index} touches a cell boundary: {bbox}")
        hashes.append(hashlib.sha256(cell.tobytes()).hexdigest())
    if len(set(hashes)) != 8:
        raise ValueError(f"{path.name}: all eight animation frames must be unique")
    if path.stat().st_size > 3_000_000:
        raise ValueError(f"{path.name}: asset exceeds the 3 MB performance budget")


def save_png(image: Image.Image, path: Path, expected_cell: int = CELL_SIZE) -> None:
    image.save(path, format="PNG", optimize=True)
    validate_atlas(path, expected_cell)
    print(f"{path.relative_to(ROOT)} ({path.stat().st_size:,} bytes)")


def build_ui_assets() -> None:
    arcane = normalize_spectacle(SOURCE_ROOT / "arcane-spectacle-alpha.png")
    for rarity, tint in UI_TINTS.items():
        save_png(
            tint_atlas(arcane, *tint),
            UI_ROOT / f"inventory-rarity-spectacle-{rarity}-v4.png",
        )

    authored = {
        "legendary": UI_ROOT / "inventory-legendary-aura.png",
        "mythic": UI_ROOT / "inventory-mythic-aura.png",
    }
    for rarity, source in authored.items():
        destination = UI_ROOT / f"inventory-rarity-spectacle-{rarity}-v4.png"
        shutil.copyfile(source, destination)
        validate_atlas(destination)
        print(f"{destination.relative_to(ROOT)} ({destination.stat().st_size:,} bytes)")

    cosmic = normalize_spectacle(SOURCE_ROOT / "cosmic-spectacle-alpha.png")
    save_png(cosmic, UI_ROOT / "inventory-rarity-spectacle-cosmic-v4.png")


def build_field_assets() -> None:
    sources = {
        "common": ARRIVAL_SOURCE_ROOT / "common-alpha.png",
        "magic": ARRIVAL_SOURCE_ROOT / "magic-alpha.png",
        "superior": ARRIVAL_SOURCE_ROOT / "superior-alpha.png",
        "rare": ARRIVAL_SOURCE_ROOT / "rare-alpha.png",
        "epic": ARRIVAL_SOURCE_ROOT / "epic-alpha.png",
        "legendary": EFFECT_ROOT / "loot-awakening.png",
        "mythic": EFFECT_ROOT / "loot-mythic-awakening.png",
        "cosmic": ARRIVAL_SOURCE_ROOT / "cosmic-alpha.png",
    }
    destinations: list[Path] = []
    for rarity in RARITIES:
        destination = EFFECT_ROOT / f"loot-awakening-{rarity}-v5.png"
        save_png(
            resize_sequence_preserving_scale(
                sources[rarity],
                clear_top_row_cross_cell_bleed=rarity == "cosmic",
            ),
            destination,
            FIELD_CELL_SIZE,
        )
        if destination.stat().st_size > 1_250_000:
            raise ValueError(f"{destination.name}: exceeds the 1.25 MB field VFX budget")
        destinations.append(destination)

    support_hashes = [alpha_support_hash(path) for path in destinations]
    if len(set(support_hashes)) != len(RARITIES):
        raise ValueError("field rarity animations must have eight distinct silhouettes")


if __name__ == "__main__":
    build_ui_assets()
    build_field_assets()
