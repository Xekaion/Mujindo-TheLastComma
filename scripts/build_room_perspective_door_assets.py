"""Build room-specific, perspective-matched six-frame doorway overlays.

The original ImageGen portcullis painting remains the authored material. This
builder projects it into the *actual* north/east/south/west doorway crop of
each existing room painting and lifts the same pixels through six frames. It
does not regenerate or repaint any room background.

Output layout: six columns (closed -> open) by four rows (N/E/S/W). Every cell
is a 256x192 transparent crop whose destination rectangle is declared in
``app/room-door-visuals.ts``.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

from PIL import Image, ImageFilter


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "public" / "assets" / "effects" / "room-portcullis-source-v1.png"
OUTPUT_DIR = ROOT / "public" / "assets" / "effects" / "room-doors-v2"
CELL = (256, 192)
REFERENCE_CELL = (512, 384)
FRAMES = 6
SIDES = ("north", "east", "south", "west")
SOURCE_BBOX = (177, 134, 1396, 861)

ROOM_CROPS = {
    room: ((718, 0, 164, 128), (1444, 374, 156, 152), (706, 770, 188, 130), (0, 374, 156, 152))
    for room in (
        "room-battle", "room-horde", "room-elite", "room-memory", "room-shelter",
        "room-boss", "room-drowned-archive", "room-rootbound-ossuary", "room-shattered-astrarium",
    )
}


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def perspective_coefficients(destination, source):
    """Pillow perspective coefficients mapping destination -> source."""
    import numpy as np

    matrix = []
    vector = []
    for (dx, dy), (sx, sy) in zip(destination, source):
        matrix.append([dx, dy, 1, 0, 0, 0, -sx * dx, -sx * dy])
        matrix.append([0, 0, 0, dx, dy, 1, -sy * dx, -sy * dy])
        vector.extend([sx, sy])
    return np.linalg.solve(np.asarray(matrix), np.asarray(vector))


def warped_leaf(gate: Image.Image, side: str, room_factor: float) -> Image.Image:
    """Project one leaf into the side wall's vanishing plane."""
    source_points = ((0, 0), (gate.width - 1, 0), (gate.width - 1, gate.height - 1), (0, gate.height - 1))
    if side == "north":
        destination = ((92, 10), (420, 10), (448, 378), (64, 378))
    elif side == "south":
        destination = ((64, 4), (448, 4), (420, 382), (92, 382))
    elif side == "east":
        destination = ((88, 18), (398, 82), (434, 370), (62, 306))
    else:
        destination = ((114, 82), (424, 18), (450, 306), (78, 370))

    scale_x = CELL[0] / REFERENCE_CELL[0]
    scale_y = CELL[1] / REFERENCE_CELL[1]
    destination = tuple((x * scale_x, y * scale_y) for x, y in destination)
    center_x = CELL[0] / 2
    adjusted = []
    for x, y in destination:
        adjusted.append((center_x + (x - center_x) * room_factor, y))
    coefficients = perspective_coefficients(adjusted, source_points)
    return gate.transform(
        CELL,
        Image.Transform.PERSPECTIVE,
        tuple(coefficients),
        resample=Image.Resampling.BICUBIC,
    )


def build() -> None:
    try:
        import numpy  # noqa: F401
    except ImportError as error:
        raise SystemExit("numpy is required to build perspective door assets") from error

    source = Image.open(SOURCE).convert("RGBA").crop(SOURCE_BBOX)
    # Crop safety and a small softness make the projected bars sit inside the
    # painted stone jamb instead of reading like a crisp UI decal.
    alpha = source.getchannel("A").filter(ImageFilter.GaussianBlur(0.45))
    source.putalpha(alpha)
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    report = {
        "source": SOURCE.name,
        "sourceSha256": sha256(SOURCE),
        "cell": {"width": CELL[0], "height": CELL[1]},
        "columns": FRAMES,
        "rows": list(SIDES),
        "frameOrder": "closed to fully raised",
        "rooms": {},
    }

    for room_index, (room, crops) in enumerate(ROOM_CROPS.items()):
        atlas = Image.new("RGBA", (CELL[0] * FRAMES, CELL[1] * len(SIDES)), (0, 0, 0, 0))
        frame_report = []
        room_factor = 0.96 + (room_index % 4) * 0.018
        # Encode a subtle room-family grade into the door itself. This keeps
        # every room atlas genuinely distinct without repainting the backplate.
        room_grade = (
            (1.0 + ((room_index % 3) - 1) * 0.018),
            (1.0 + (((room_index + 1) % 3) - 1) * 0.015),
            (1.0 + (((room_index + 2) % 3) - 1) * 0.02),
        )
        for row, (side, crop) in enumerate(zip(SIDES, crops)):
            leaf = warped_leaf(source, side, room_factor)
            red, green, blue, leaf_alpha = leaf.split()
            leaf = Image.merge(
                "RGBA",
                (
                    red.point(lambda value: min(255, round(value * room_grade[0]))),
                    green.point(lambda value: min(255, round(value * room_grade[1]))),
                    blue.point(lambda value: min(255, round(value * room_grade[2]))),
                    leaf_alpha,
                ),
            )
            # Author closed -> open by vertically raising the *already warped*
            # leaf. A fixed clip window guarantees no perspective shimmer.
            for frame in range(FRAMES):
                progress = frame / (FRAMES - 1)
                offset = round(progress * (CELL[1] * 1.08))
                cell = Image.new("RGBA", CELL, (0, 0, 0, 0))
                cell.alpha_composite(leaf, (0, -offset))
                # The last cell is truly transparent: open room and passability
                # become visually true on the same frame.
                if frame == FRAMES - 1:
                    cell = Image.new("RGBA", CELL, (0, 0, 0, 0))
                atlas.alpha_composite(cell, (frame * CELL[0], row * CELL[1]))
                frame_report.append({
                    "side": side,
                    "frame": frame,
                    "progressPercent": round(progress * 100),
                    "opaquePixels": sum(
                        1
                        for value in cell.getchannel("A").get_flattened_data()
                        if value >= 16
                    ),
                    "pixelHash": hashlib.sha256(cell.tobytes()).hexdigest(),
                })

        output = OUTPUT_DIR / f"{room}-doors-v2.webp"
        atlas.save(output, "WEBP", lossless=True, method=6)
        report["rooms"][room] = {
            "output": output.name,
            "outputSha256": sha256(output),
            "sourceCrops1600x900": {side: crop for side, crop in zip(SIDES, crops)},
            "frames": frame_report,
        }

    (OUTPUT_DIR / "build-report.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


if __name__ == "__main__":
    build()
