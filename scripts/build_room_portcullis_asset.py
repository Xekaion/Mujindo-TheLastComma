"""Build the deterministic four-cell room portcullis atlas.

The source is an original ImageGen asset.  Keeping one canonical door leaf and
raising that exact painting inside a fixed cell avoids the shape, perspective,
and anchor jitter that independently generated animation frames introduce.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

from PIL import Image


CELL = 256
FRAME_COUNT = 4
SOURCE_BBOX = (177, 134, 1396, 861)
GATE_SIZE = (228, 150)
GATE_X = (CELL - GATE_SIZE[0]) // 2
GATE_CLOSED_Y = 100
GATE_FRAME_Y = (100, 42, -36, -126)


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def build(source: Path, output: Path, report: Path) -> None:
    image = Image.open(source).convert("RGBA")
    gate = image.crop(SOURCE_BBOX)
    gate.thumbnail(GATE_SIZE, Image.Resampling.LANCZOS)

    atlas = Image.new("RGBA", (CELL * FRAME_COUNT, CELL), (0, 0, 0, 0))
    frames: list[dict[str, int | str]] = []
    for frame in range(FRAME_COUNT):
        progress = frame / (FRAME_COUNT - 1)
        y = GATE_FRAME_Y[frame]
        cell = Image.new("RGBA", (CELL, CELL), (0, 0, 0, 0))
        cell.alpha_composite(gate, (GATE_X, y))
        atlas.alpha_composite(cell, (frame * CELL, 0))
        frames.append(
            {
                "frame": frame,
                "progressPercent": round(progress * 100),
                "gateY": y,
                "pixelHash": hashlib.sha256(cell.tobytes()).hexdigest(),
            }
        )

    output.parent.mkdir(parents=True, exist_ok=True)
    atlas.save(output, optimize=True)
    report.parent.mkdir(parents=True, exist_ok=True)
    report.write_text(
        json.dumps(
            {
                "source": source.name,
                "sourceSha256": sha256(source),
                "output": output.name,
                "outputSha256": sha256(output),
                "format": "RGBA PNG",
                "atlas": {"width": CELL * FRAME_COUNT, "height": CELL},
                "cell": {"width": CELL, "height": CELL},
                "frameOrder": "closed to fully raised",
                "frames": frames,
            },
            ensure_ascii=False,
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )


def main() -> None:
    root = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--source",
        type=Path,
        default=root / "asset-sources" / "legacy-arpg" / "room-portcullis-source-v1.png",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=root / "public" / "assets" / "effects" / "room-portcullis-v1.png",
    )
    parser.add_argument(
        "--report",
        type=Path,
        default=root / "public" / "assets" / "effects" / "room-portcullis-v1.build.json",
    )
    args = parser.parse_args()
    build(args.source.resolve(), args.output.resolve(), args.report.resolve())


if __name__ == "__main__":
    main()
