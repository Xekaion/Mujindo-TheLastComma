"""Register an ImageGen 4x8 atlas to the paperdoll cell pivot safely.

Image generators sometimes let neighboring-row artwork bleed across the
nominal cell boundary.  A plain rectangular crop then mistakes that bleed for
the next pose.  This script selects the connected alpha component nearest each
cell centre, preserving only the intended actor before baseline registration.
"""

from __future__ import annotations

import argparse
from collections import deque
from pathlib import Path

import numpy as np
from PIL import Image


CELL_W, CELL_H = 256, 192
ROWS, COLS = 8, 4
ATLAS_SIZE = (CELL_W * COLS, CELL_H * ROWS)
VISIBLE_ALPHA = 16
GUTTER = 8
BASELINE = CELL_H - GUTTER


def connected_components(mask: np.ndarray) -> list[tuple[np.ndarray, np.ndarray]]:
    height, width = mask.shape
    visited = np.zeros_like(mask, dtype=bool)
    components: list[tuple[np.ndarray, np.ndarray]] = []
    for start_y, start_x in zip(*np.where(mask & ~visited)):
        if visited[start_y, start_x]:
            continue
        queue = deque([(int(start_y), int(start_x))])
        visited[start_y, start_x] = True
        xs: list[int] = []
        ys: list[int] = []
        while queue:
            y, x = queue.popleft()
            xs.append(x)
            ys.append(y)
            for dy, dx in ((-1, 0), (1, 0), (0, -1), (0, 1)):
                ny, nx = y + dy, x + dx
                if (
                    0 <= ny < height
                    and 0 <= nx < width
                    and mask[ny, nx]
                    and not visited[ny, nx]
                ):
                    visited[ny, nx] = True
                    queue.append((ny, nx))
        if len(xs) >= 48:
            components.append((np.asarray(ys), np.asarray(xs)))
    return components


def extract_actor(source: Image.Image, row: int, column: int) -> Image.Image:
    centre_x = column * CELL_W + CELL_W / 2
    centre_y = row * CELL_H + CELL_H / 2
    rgba = np.asarray(source, dtype=np.uint8)
    components = connected_components(rgba[:, :, 3] > VISIBLE_ALPHA)
    candidates: list[tuple[float, int, np.ndarray, np.ndarray]] = []
    for ys, xs in components:
        component_x = float(np.median(xs))
        component_y = float(np.median(ys))
        distance = ((component_x - centre_x) / CELL_W) ** 2 + ((component_y - centre_y) / CELL_H) ** 2
        if abs(component_x - centre_x) <= CELL_W * 0.48 and abs(component_y - centre_y) <= CELL_H * 0.72:
            candidates.append((distance, -len(xs), ys, xs))
    if not candidates:
        raise ValueError(f"no actor component near cell {row},{column}")
    _, _, ys, xs = min(candidates, key=lambda item: (item[0], item[1]))
    left, top, right, bottom = int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1
    actor = Image.new("RGBA", source.size, (0, 0, 0, 0))
    actor_array = np.asarray(actor).copy()
    source_array = np.asarray(source)
    actor_array[ys, xs] = source_array[ys, xs]
    actor = Image.fromarray(actor_array, mode="RGBA").crop((left, top, right, bottom))
    return actor


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    source = Image.open(args.input).convert("RGBA")
    if source.size != ATLAS_SIZE:
        raise ValueError(f"expected {ATLAS_SIZE}, got {source.size}")
    output = Image.new("RGBA", ATLAS_SIZE, (0, 0, 0, 0))
    report: list[str] = []
    for row in range(ROWS):
        for column in range(COLS):
            actor = extract_actor(source, row, column)
            scale = min(1.0, (CELL_W - GUTTER * 2) / actor.width, (CELL_H - GUTTER * 2) / actor.height)
            if scale < 1:
                actor = actor.resize(
                    (max(1, round(actor.width * scale)), max(1, round(actor.height * scale))),
                    Image.Resampling.LANCZOS,
                )
            x = column * CELL_W + round((CELL_W - actor.width) / 2)
            y = row * CELL_H + BASELINE - actor.height
            output.alpha_composite(actor, (x, y))
            report.append(f"{row},{column}:{actor.width}x{actor.height}@{x-column*CELL_W},{y-row*CELL_H}")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    output.save(args.output, optimize=True)
    print("\n".join(report))


if __name__ == "__main__":
    main()
