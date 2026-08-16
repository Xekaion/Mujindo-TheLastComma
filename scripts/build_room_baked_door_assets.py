"""Build six authored room-baked portcullis states for every room backplate.

Unlike the retired transparent v2 overlays, every valid atlas cell starts with
the exact crop from its matching normal or stairs room painting.  The gate is
then projected into that doorway's wall plane, moved along that same plane for
the intermediate states, clipped behind the original jamb, and baked into the
crop.  No animation frame scales or stretches the gate.

Atlas layout: six columns (closed -> open) by four rows (N/E/S/W).  Cells use a
188x152 stride, while each valid source rectangle retains its native room-crop
size.  Padding is never sampled by the runtime.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

import numpy as np
from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageOps


ROOT = Path(__file__).resolve().parents[1]
MAP_DIR = ROOT / "public" / "assets" / "maps"
# V3 is retained only as reproducible source material for the full-room V4 maps.
# Keeping the retired patch atlases outside public prevents them from inflating
# the production archive or being mistaken for runtime overlays.
OUTPUT_DIR = ROOT / "asset-sources" / "legacy-arpg" / "room-doors-v3-retired"
FRONT_SOURCE = ROOT / "asset-sources" / "legacy-arpg" / "room-portcullis-source-v1.png"
SIDE_SOURCE = ROOT / "asset-sources" / "imagegen" / "room-portcullis-v3-keyed.png"
PROMPT_METADATA = ROOT / "asset-sources" / "imagegen" / "room-portcullis-v3.prompt.json"

FRAME_COUNT = 6
CELL_WIDTH = 188
CELL_HEIGHT = 152
SIDES = ("north", "east", "south", "west")
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

# Exact coordinates in every 1600x900 authored backplate.
CROPS = {
    "north": (718, 0, 164, 128),
    "east": (1444, 374, 156, 152),
    "south": (706, 770, 188, 130),
    "west": (0, 374, 156, 152),
}

# Closed gate quadrilaterals in crop-local coordinates, ordered TL/TR/BR/BL.
# The side quads were registered against the ImageGen west-door edit. Their
# vertical vectors follow the wall plane rather than screen Y, which is what
# keeps the intermediate frames from turning into a growing diagonal shelf.
DESTINATION_QUADS = {
    "north": ((42, 12), (122, 12), (118, 124), (46, 124)),
    "east": ((61, 34), (125, 8), (133, 110), (69, 136)),
    "south": ((42, 7), (146, 7), (153, 124), (35, 124)),
    "west": ((30, 8), (94, 34), (86, 136), (22, 110)),
}

# Fixed doorway masks keep the metal behind the original stone jambs.
OPENING_POLYGONS = {
    "north": ((35, 8), (129, 8), (126, 125), (38, 125)),
    "east": ((55, 32), (131, 8), (139, 116), (63, 145)),
    "south": ((35, 8), (153, 8), (159, 125), (29, 125)),
    "west": ((24, 8), (100, 32), (92, 145), (16, 116)),
}


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def describe_source(path: Path) -> dict[str, object]:
    image = Image.open(path)
    return {
        "path": path.relative_to(ROOT).as_posix(),
        "sha256": sha256(path),
        "bytes": path.stat().st_size,
        "size": list(image.size),
        "mode": image.mode,
    }


def perspective_coefficients(destination, source) -> tuple[float, ...]:
    """Return Pillow destination-to-source perspective coefficients."""
    matrix: list[list[float]] = []
    vector: list[float] = []
    for (dx, dy), (sx, sy) in zip(destination, source):
        matrix.append([dx, dy, 1, 0, 0, 0, -sx * dx, -sx * dy])
        matrix.append([0, 0, 0, dx, dy, 1, -sy * dx, -sy * dy])
        vector.extend([sx, sy])
    return tuple(np.linalg.solve(np.asarray(matrix), np.asarray(vector)))


def alpha_bbox_crop(image: Image.Image) -> Image.Image:
    rgba = image.convert("RGBA")
    bbox = rgba.getchannel("A").getbbox()
    if bbox is None:
        raise RuntimeError("Portcullis source has no visible alpha")
    return rgba.crop(bbox)


def projected_gate(side: str, crop_size: tuple[int, int]) -> Image.Image:
    source_path = FRONT_SOURCE if side in {"north", "south"} else SIDE_SOURCE
    source = alpha_bbox_crop(Image.open(source_path))
    if side == "east":
        source = ImageOps.mirror(source)
    source_points = (
        (0, 0),
        (source.width - 1, 0),
        (source.width - 1, source.height - 1),
        (0, source.height - 1),
    )
    coefficients = perspective_coefficients(DESTINATION_QUADS[side], source_points)
    gate = source.transform(
        crop_size,
        Image.Transform.PERSPECTIVE,
        coefficients,
        resample=Image.Resampling.BICUBIC,
    )
    # A subpixel matte softens only the generated silhouette, not room pixels.
    alpha = gate.getchannel("A").filter(ImageFilter.GaussianBlur(0.24))
    gate.putalpha(alpha)
    return gate


def opening_mask(side: str, crop_size: tuple[int, int]) -> Image.Image:
    # Draw at 4x and downsample to anti-alias the jamb edge.
    scale = 4
    mask = Image.new("L", (crop_size[0] * scale, crop_size[1] * scale), 0)
    polygon = [(x * scale, y * scale) for x, y in OPENING_POLYGONS[side]]
    ImageDraw.Draw(mask).polygon(polygon, fill=255)
    return mask.resize(crop_size, Image.Resampling.LANCZOS)


def lift_vector(side: str) -> tuple[float, float]:
    tl, tr, br, bl = DESTINATION_QUADS[side]
    return ((bl[0] - tl[0] + br[0] - tr[0]) / 2, (bl[1] - tl[1] + br[1] - tr[1]) / 2)


def shifted_gate(gate: Image.Image, side: str, frame: int) -> Image.Image:
    if frame >= FRAME_COUNT - 1:
        return Image.new("RGBA", gate.size, (0, 0, 0, 0))
    progress = frame / (FRAME_COUNT - 1)
    down_x, down_y = lift_vector(side)
    # Move the unchanged gate upward along the doorway plane. A slight 1.06x
    # travel ensures frame five is wholly open without scaling prior frames.
    offset_x = round(-down_x * progress * 1.06)
    offset_y = round(-down_y * progress * 1.06)
    shifted = Image.new("RGBA", gate.size, (0, 0, 0, 0))
    shifted.alpha_composite(gate, (offset_x, offset_y))
    return shifted


def apply_gate(base_crop: Image.Image, gate: Image.Image, mask: Image.Image) -> Image.Image:
    clipped = gate.copy()
    clipped.putalpha(ImageChops.multiply(clipped.getchannel("A"), mask))
    result = base_crop.convert("RGBA")
    result.alpha_composite(clipped)
    return result.convert("RGB")


def border_mismatch_count(left: Image.Image, right: Image.Image, width: int = 3) -> int:
    left_array = np.asarray(left.convert("RGB"), dtype=np.int16)
    right_array = np.asarray(right.convert("RGB"), dtype=np.int16)
    border = np.zeros(left_array.shape[:2], dtype=bool)
    border[:width, :] = True
    border[-width:, :] = True
    border[:, :width] = True
    border[:, -width:] = True
    different = np.any(left_array != right_array, axis=2)
    return int(np.count_nonzero(different & border))


def changed_pixel_count(left: Image.Image, right: Image.Image) -> int:
    left_array = np.asarray(left.convert("RGB"), dtype=np.int16)
    right_array = np.asarray(right.convert("RGB"), dtype=np.int16)
    return int(np.count_nonzero(np.any(np.abs(left_array - right_array) >= 2, axis=2)))


def backplates() -> list[Path]:
    result: list[Path] = []
    for stem in ROOM_STEMS:
        result.append(MAP_DIR / f"{stem}.webp")
        result.append(MAP_DIR / f"{stem}-stairs-v1.webp")
    return result


def build() -> None:
    for required in (FRONT_SOURCE, SIDE_SOURCE, PROMPT_METADATA):
        if not required.exists():
            raise SystemExit(f"Missing required asset: {required}")

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    report: dict[str, object] = {
        "version": 3,
        "builder": "scripts/build_room_baked_door_assets.py",
        "format": "lossless RGB WebP room-baked patches",
        "atlas": {
            "columns": FRAME_COUNT,
            "rows": list(SIDES),
            "cellStride": [CELL_WIDTH, CELL_HEIGHT],
            "size": [CELL_WIDTH * FRAME_COUNT, CELL_HEIGHT * len(SIDES)],
            "frameOrder": "fully closed to fully open",
        },
        "sources": {
            "frontGate": describe_source(FRONT_SOURCE),
            "sideGate": describe_source(SIDE_SOURCE),
            "promptMetadata": {
                "path": PROMPT_METADATA.relative_to(ROOT).as_posix(),
                "sha256": sha256(PROMPT_METADATA),
            },
        },
        "geometry": {
            "crops1600x900": CROPS,
            "closedDestinationQuads": DESTINATION_QUADS,
            "openingPolygons": OPENING_POLYGONS,
            "motion": "unchanged projected gate translated along doorway-plane lift vector",
        },
        "backplates": {},
    }

    for map_path in backplates():
        room = Image.open(map_path).convert("RGB")
        if room.size != (1600, 900):
            raise RuntimeError(f"Unexpected backplate dimensions for {map_path}: {room.size}")
        atlas = Image.new(
            "RGB",
            (CELL_WIDTH * FRAME_COUNT, CELL_HEIGHT * len(SIDES)),
            (0, 0, 0),
        )
        room_report: dict[str, object] = {
            "source": describe_source(map_path),
            "sides": {},
        }
        for row, side in enumerate(SIDES):
            x, y, width, height = CROPS[side]
            original = room.crop((x, y, x + width, y + height))
            gate = projected_gate(side, (width, height))
            mask = opening_mask(side, (width, height))
            frames: list[dict[str, object]] = []
            change_counts: list[int] = []
            for frame in range(FRAME_COUNT):
                baked = apply_gate(original, shifted_gate(gate, side, frame), mask)
                atlas.paste(baked, (frame * CELL_WIDTH, row * CELL_HEIGHT))
                changes = changed_pixel_count(original, baked)
                change_counts.append(changes)
                frames.append(
                    {
                        "frame": frame,
                        "liftPercent": round(frame / (FRAME_COUNT - 1) * 100),
                        "changedPixelsFromOpen": changes,
                        "borderMismatchPixels": border_mismatch_count(original, baked),
                        "pixelHash": hashlib.sha256(baked.tobytes()).hexdigest(),
                    }
                )
            if change_counts[-1] != 0:
                raise RuntimeError(f"Open frame differs from {map_path.name} {side} crop")
            if any(left < right for left, right in zip(change_counts, change_counts[1:])):
                raise RuntimeError(
                    f"Non-monotonic door coverage for {map_path.name} {side}: {change_counts}"
                )
            if any(frame["borderMismatchPixels"] for frame in frames):
                raise RuntimeError(f"Door patch touches a crop border for {map_path.name} {side}")
            room_report["sides"][side] = {
                "crop1600x900": [x, y, width, height],
                "liftVector": [round(value, 3) for value in lift_vector(side)],
                "frames": frames,
            }

        output = OUTPUT_DIR / f"{map_path.stem}-doors-v3.webp"
        atlas.save(output, "WEBP", lossless=True, method=6, exact=True)
        room_report["output"] = {
            "path": output.relative_to(ROOT).as_posix(),
            "sha256": sha256(output),
            "bytes": output.stat().st_size,
        }
        report["backplates"][map_path.stem] = room_report

    report_path = OUTPUT_DIR / "build-report.json"
    report_path.write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(f"Built {len(report['backplates'])} room-baked door atlases in {OUTPUT_DIR}")


if __name__ == "__main__":
    build()
