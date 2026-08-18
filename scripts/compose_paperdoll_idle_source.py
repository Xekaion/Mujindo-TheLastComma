"""Splice ImageGen's balanced idle legs into the approved bare-body atlas.

ImageGen correctly authored the eight second-column standing poses, but a
whole-atlas edit may repaint unrelated gait cells or turn the upper body.  This
deterministic compositor preserves every non-idle cell byte-for-byte and keeps
the approved head/torso of each idle direction, blending only from the hips
down into the newly authored two-foot stance.
"""

from __future__ import annotations

import argparse
from pathlib import Path

import numpy as np
from PIL import Image


CELL_W = 256
CELL_H = 192
ROWS = 8
IDLE_COLUMN = 1
MIRRORED_IDLE_SOURCE_ROWS = {5: 3, 6: 2, 7: 1}


def cell_box(row: int) -> tuple[int, int, int, int]:
    return (
        IDLE_COLUMN * CELL_W,
        row * CELL_H,
        (IDLE_COLUMN + 1) * CELL_W,
        (row + 1) * CELL_H,
    )


def pose_anchor(image: Image.Image) -> tuple[int, float]:
    alpha = np.asarray(image.convert("RGBA"), dtype=np.uint8)[:, :, 3] > 16
    visible_y, _visible_x = np.where(alpha)
    if not len(visible_y):
        raise ValueError("paperdoll source cell is empty")
    top = int(visible_y.min())
    bottom = int(visible_y.max())
    y_grid = np.indices(alpha.shape)[0]
    torso = alpha & (
        (y_grid >= top + (bottom - top) * 0.25)
        & (y_grid <= top + (bottom - top) * 0.52)
    )
    _torso_y, torso_x = np.where(torso)
    return top, float(np.median(torso_x))


def align_edited_pose(approved: Image.Image, edited: Image.Image) -> Image.Image:
    approved_top, approved_x = pose_anchor(approved)
    edited_top, edited_x = pose_anchor(edited)
    output = Image.new("RGBA", approved.size, (0, 0, 0, 0))
    output.alpha_composite(
        edited,
        (round(approved_x - edited_x), approved_top - edited_top),
    )
    return output


def blend_idle_cell(approved: Image.Image, edited: Image.Image) -> Image.Image:
    old = np.asarray(approved.convert("RGBA"), dtype=np.float32)
    new = np.asarray(edited.convert("RGBA"), dtype=np.float32)
    visible_y, _visible_x = np.where(old[:, :, 3] > 16)
    if not len(visible_y):
        raise ValueError("approved idle source cell is empty")
    top = int(visible_y.min())
    bottom = int(visible_y.max())
    hip_y = int(round(top + (bottom - top) * 0.50))
    blend_start = hip_y - 3
    blend_end = hip_y + 3

    old_alpha = old[:, :, 3:4] / 255.0
    new_alpha = new[:, :, 3:4] / 255.0
    old_premultiplied = old[:, :, :3] * old_alpha
    new_premultiplied = new[:, :, :3] * new_alpha
    output_alpha = old_alpha.copy()
    output_premultiplied = old_premultiplied.copy()
    output_alpha[blend_end + 1 :] = new_alpha[blend_end + 1 :]
    output_premultiplied[blend_end + 1 :] = new_premultiplied[blend_end + 1 :]
    for y in range(blend_start, blend_end + 1):
        weight = (y - blend_start + 1) / (blend_end - blend_start + 2)
        output_alpha[y] = old_alpha[y] * (1.0 - weight) + new_alpha[y] * weight
        output_premultiplied[y] = (
            old_premultiplied[y] * (1.0 - weight)
            + new_premultiplied[y] * weight
        )
    output_rgb = np.divide(
        output_premultiplied,
        output_alpha,
        out=np.zeros_like(output_premultiplied),
        where=output_alpha > 0,
    )
    output = np.concatenate((output_rgb, output_alpha * 255.0), axis=2)
    return Image.fromarray(np.clip(output, 0, 255).astype(np.uint8), mode="RGBA")


def compose(approved_path: Path, edited_path: Path, output_path: Path) -> None:
    approved = Image.open(approved_path).convert("RGBA")
    edited = Image.open(edited_path).convert("RGBA")
    if approved.size != (CELL_W * 4, CELL_H * ROWS) or edited.size != approved.size:
        raise ValueError("paperdoll source atlases must both be 1024x1536")
    output = approved.copy()
    for row in range(ROWS):
        box = cell_box(row)
        source_row = MIRRORED_IDLE_SOURCE_ROWS.get(row, row)
        edited_cell = edited.crop(cell_box(source_row))
        if source_row != row:
            edited_cell = edited_cell.transpose(Image.Transpose.FLIP_LEFT_RIGHT)
        edited_cell = align_edited_pose(approved.crop(box), edited_cell)
        output.paste(
            blend_idle_cell(approved.crop(box), edited_cell),
            box[:2],
        )
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output.save(output_path, optimize=True)


def main() -> None:
    workspace = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--approved",
        type=Path,
        default=workspace / "asset-sources/imagegen/harin-neutral-paperdoll-v6-bare-walk.png",
    )
    parser.add_argument(
        "--edited",
        type=Path,
        default=workspace / "asset-sources/imagegen/harin-neutral-paperdoll-v6-idle-edit.png",
    )
    parser.add_argument(
        "--out",
        type=Path,
        default=workspace / "asset-sources/imagegen/harin-neutral-paperdoll-v6.png",
    )
    args = parser.parse_args()
    compose(args.approved.resolve(), args.edited.resolve(), args.out.resolve())


if __name__ == "__main__":
    main()
