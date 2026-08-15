"""Build map-specific, full-room portcullis animation atlases.

Each input room owns an ImageGen-authored fully closed 16:9 room painting.
Only the four native passage interiors are taken from that matching painting;
the rest of every frame comes from the exact production room backplate.  The
authored passage content is raised along its doorway plane for the intermediate
states, then every state is baked as a complete 1280x720 room image.

Runtime atlas layout: two columns by three rows, frame 0 (closed) through frame
5 (open).  There are no standalone gate sprites or small doorway-patch atlases
in this pipeline.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFilter


ROOT = Path(__file__).resolve().parents[1]
MAP_DIR = ROOT / "public" / "assets" / "maps"
GENERATED_DIR = ROOT / "asset-sources" / "imagegen" / "room-doors-v4"
OUTPUT_DIR = MAP_DIR / "room-doors-v4"
PROMPT_METADATA = GENERATED_DIR / "room-doors-v4.prompt.json"

SOURCE_SIZE = (1600, 900)
FRAME_SIZE = (1280, 720)
FRAME_COUNT = 6
ATLAS_COLUMNS = 2
ATLAS_ROWS = 3

ROOM_STEMS = (
    "room-battle",
    "room-horde",
    "room-elite",
    "room-memory",
    "room-shelter",
    "room-boss",
    "room-drowned-archive",
    "room-rootbound-ossuary",
    "room-shattered-astrarium",
)

# Coordinates are on the authored 1600x900 room grid.  The masks follow the
# actual dark passage planes and keep the generated ironwork behind the native
# jambs.  The same camera rig is shared by the room family, while the pixels
# inside each mask come from that room's own ImageGen full-room edit.
DOOR_REGIONS = {
    "north": {
        "crop": (718, 0, 164, 128),
        "polygon": ((35, 8), (129, 8), (126, 125), (38, 125)),
        "lift": (0.0, 112.0),
    },
    "east": {
        "crop": (1444, 374, 156, 152),
        "polygon": ((55, 32), (131, 8), (139, 116), (63, 145)),
        "lift": (8.0, 102.0),
    },
    "south": {
        "crop": (706, 770, 188, 130),
        "polygon": ((35, 8), (153, 8), (159, 125), (29, 125)),
        "lift": (0.0, 117.0),
    },
    "west": {
        "crop": (0, 374, 156, 152),
        "polygon": ((24, 8), (100, 32), (92, 145), (16, 116)),
        "lift": (-8.0, 102.0),
    },
}


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def pixel_hash(image: Image.Image) -> str:
    return hashlib.sha256(image.convert("RGB").tobytes()).hexdigest()


def describe(path: Path) -> dict[str, object]:
    with Image.open(path) as image:
        return {
            "path": path.relative_to(ROOT).as_posix(),
            "sha256": sha256(path),
            "bytes": path.stat().st_size,
            "size": list(image.size),
            "mode": image.mode,
        }


def passage_mask(size: tuple[int, int], polygon) -> Image.Image:
    scale = 4
    mask = Image.new("L", (size[0] * scale, size[1] * scale), 0)
    ImageDraw.Draw(mask).polygon(
        [(x * scale, y * scale) for x, y in polygon],
        fill=255,
    )
    mask = mask.resize(size, Image.Resampling.LANCZOS)
    return mask.filter(ImageFilter.GaussianBlur(0.55))


def shifted_passage(
    generated_crop: Image.Image,
    fixed_mask: Image.Image,
    lift: tuple[float, float],
    frame: int,
) -> tuple[Image.Image, Image.Image]:
    if frame >= FRAME_COUNT - 1:
        return (
            Image.new("RGBA", generated_crop.size, (0, 0, 0, 0)),
            Image.new("L", generated_crop.size, 0),
        )

    progress = frame / (FRAME_COUNT - 1)
    offset = (
        round(-lift[0] * progress * 1.06),
        round(-lift[1] * progress * 1.06),
    )
    shifted = Image.new("RGBA", generated_crop.size, (0, 0, 0, 0))
    shifted.alpha_composite(generated_crop, offset)
    shifted_mask = Image.new("L", generated_crop.size, 0)
    shifted_mask.paste(fixed_mask, offset)
    return shifted, ImageChops.multiply(shifted_mask, fixed_mask)


def build_full_room_frame(
    base: Image.Image,
    generated_closed: Image.Image,
    frame: int,
) -> Image.Image:
    if frame >= FRAME_COUNT - 1:
        return base.convert("RGB")

    result = base.convert("RGBA")
    for definition in DOOR_REGIONS.values():
        x, y, width, height = definition["crop"]
        crop_box = (x, y, x + width, y + height)
        generated_crop = generated_closed.crop(crop_box).convert("RGBA")
        mask = passage_mask((width, height), definition["polygon"])
        shifted, shifted_mask = shifted_passage(
            generated_crop,
            mask,
            definition["lift"],
            frame,
        )
        layer = Image.new("RGBA", (width, height), (0, 0, 0, 0))
        layer = Image.composite(shifted, layer, shifted_mask)
        result.alpha_composite(layer, (x, y))
    return result.convert("RGB")


def changed_pixels(left: Image.Image, right: Image.Image) -> int:
    difference = ImageChops.difference(left.convert("RGB"), right.convert("RGB"))
    return sum(difference.convert("L").histogram()[1:])


def build_one(stem: str) -> dict[str, object]:
    map_path = MAP_DIR / f"{stem}.webp"
    generated_path = GENERATED_DIR / f"{stem}-closed-generated.png"
    if not map_path.exists():
        raise FileNotFoundError(map_path)
    if not generated_path.exists():
        raise FileNotFoundError(generated_path)

    base = Image.open(map_path).convert("RGB")
    if base.size != SOURCE_SIZE:
        raise RuntimeError(f"{map_path} must be {SOURCE_SIZE}, got {base.size}")
    generated = Image.open(generated_path).convert("RGB")
    generated_size = generated.size
    generated = generated.resize(SOURCE_SIZE, Image.Resampling.LANCZOS)

    source_frames = [
        build_full_room_frame(base, generated, frame)
        for frame in range(FRAME_COUNT)
    ]
    runtime_frames = [
        frame.resize(FRAME_SIZE, Image.Resampling.LANCZOS)
        for frame in source_frames
    ]
    open_frame = runtime_frames[-1]
    differences = [changed_pixels(frame, open_frame) for frame in runtime_frames]
    if differences[-1] != 0:
        raise RuntimeError(f"{stem} open frame does not match the production room")
    if any(
        differences[index] <= differences[index + 1]
        for index in range(FRAME_COUNT - 1)
    ):
        raise RuntimeError(
            f"{stem} changed pixels must strictly decrease toward open: {differences}"
        )

    atlas = Image.new(
        "RGB",
        (FRAME_SIZE[0] * ATLAS_COLUMNS, FRAME_SIZE[1] * ATLAS_ROWS),
    )
    frame_report = []
    for frame, image in enumerate(runtime_frames):
        column = frame % ATLAS_COLUMNS
        row = frame // ATLAS_COLUMNS
        atlas.paste(image, (column * FRAME_SIZE[0], row * FRAME_SIZE[1]))
        frame_report.append(
            {
                "frame": frame,
                "raisedPercent": frame * 20,
                "atlasCell": [column, row],
                "changedPixelsFromOpen": differences[frame],
                "pixelHash": pixel_hash(image),
            }
        )

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    output_path = OUTPUT_DIR / f"{stem}-doors-v4.webp"
    # Every cell repeats the same room outside the four authored passages.
    # Lossless encoding is intentional: independently quantized lossy cells
    # make the untouched walls and floor shimmer when the door frame changes.
    atlas.save(output_path, "WEBP", lossless=True, method=6)
    return {
        "source": describe(map_path),
        "generatedClosedSource": {
            **describe(generated_path),
            "normalizedSize": list(SOURCE_SIZE),
            "originalGeneratedSize": list(generated_size),
        },
        "frames": frame_report,
        "output": describe(output_path),
    }


def build() -> None:
    stems = tuple(
        stem
        for base_stem in ROOM_STEMS
        for stem in (base_stem, f"{base_stem}-stairs-v1")
    )
    report = {
        "version": 4,
        "assetType": "map-specific full-room portcullis animation atlases",
        "generator": Path(__file__).relative_to(ROOT).as_posix(),
        "promptMetadata": PROMPT_METADATA.relative_to(ROOT).as_posix(),
        "sourceSize": list(SOURCE_SIZE),
        "runtimeFrameSize": list(FRAME_SIZE),
        "frameOrder": "fully closed to fully open",
        "atlas": {
            "columns": ATLAS_COLUMNS,
            "rows": ATLAS_ROWS,
            "width": FRAME_SIZE[0] * ATLAS_COLUMNS,
            "height": FRAME_SIZE[1] * ATLAS_ROWS,
        },
        "encoding": {
            "format": "WEBP",
            "lossless": True,
            "reason": "keep every non-door room pixel stable across animation frames",
        },
        "productionContract": {
            "completeFrame": "every cell is a complete opaque room image",
            "perMapAuthorship": "every base and stairs room owns its ImageGen closed-room source",
            "motion": "authored passage content translates along its doorway-plane lift vector and is never scaled",
            "openFrame": "exact 1280x720 Lanczos render of the production room backplate",
            "runtime": "draw one complete room frame; no standalone gate sprite or doorway-patch atlas",
        },
        "doorRegions1600x900": DOOR_REGIONS,
        "rooms": {stem: build_one(stem) for stem in stems},
    }
    (OUTPUT_DIR / "build-report.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(OUTPUT_DIR)


if __name__ == "__main__":
    build()
