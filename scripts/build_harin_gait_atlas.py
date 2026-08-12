"""Compose Harin's eight-direction walk from anatomically audited poses.

The ImageGen QA sheet identifies Harin's anatomical left boot/wrist in blue
and right boot/wrist in yellow.  We use those markers to choose one true
left-foot contact and one true right-foot contact for every authored
direction.  Neutral in-between poses then form a conventional four phase
cycle:

    left contact -> passing -> right contact -> passing

All cells are registered to the same torso anchor and floor baseline before
they are handed to the paperdoll layer retargeter.  The south-west row is
synthesised from the audited south-east row because the generated south-west
source contains no right-foot contact at all.
"""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path

import numpy as np
from PIL import Image


CELL_W = 256
CELL_H = 192
COLS = 4
ROWS = 8
ATLAS_SIZE = (CELL_W * COLS, CELL_H * ROWS)
FLOOR_Y = 183
TORSO_X = 128
MIN_ALPHA = 24
AUTHORED_DIRECTIONS = (
    ("south", (0.0, 1.0)),
    ("south-east", (1.0, 1.0)),
    ("east", (1.0, 0.0)),
    ("north-west", (-1.0, -1.0)),
    ("north", (0.0, -1.0)),
    ("north-east", (1.0, -1.0)),
    ("west", (-1.0, 0.0)),
    ("south-west", (-1.0, 1.0)),
)
SYNTHESISED_ROWS = {
    # Opposite horizontal directions share one audited source so their body
    # angle, stride length and equipment anchors cannot disagree.
    5: 3,  # north-east = mirrored north-west
    6: 2,  # west = mirrored east
    7: 1,  # south-west = mirrored south-east
}
# Chosen by visual inspection of the colour-coded contact sheet.  Each pair is
# the two opposite planted-foot poses; the generated source is not consistent
# enough for a simple global column rule.
CONTACT_SOURCE_COLUMNS = (
    (3, 1),
    (1, 0),
    (1, 0),
    (2, 0),
    (0, 3),
    (2, 0),
    (1, 0),
    (1, 0),
)
PASSING_SOURCE_COLUMNS = (
    (0, 2),
    (0, 2),
    (0, 2),
    (0, 2),
    (0, 2),
    (2, 0),
    (2, 0),
    (2, 0),
)


def cell_box(row: int, column: int) -> tuple[int, int, int, int]:
    return (
        column * CELL_W,
        row * CELL_H,
        (column + 1) * CELL_W,
        (row + 1) * CELL_H,
    )


def source_cell(
    atlas: Image.Image,
    row: int,
    column: int,
) -> tuple[Image.Image, int, bool]:
    source_row = SYNTHESISED_ROWS.get(row, row)
    image = atlas.crop(cell_box(source_row, column))
    mirrored = source_row != row
    if mirrored:
        image = image.transpose(Image.Transpose.FLIP_LEFT_RIGHT)
    return image, source_row, mirrored


def marker_projection(cell: Image.Image, vector: tuple[float, float]) -> float:
    rgba = np.asarray(cell.convert("RGBA"), dtype=np.uint8)
    red = rgba[:, :, 0].astype(np.float32)
    green = rgba[:, :, 1].astype(np.float32)
    blue = rgba[:, :, 2].astype(np.float32)
    alpha = rgba[:, :, 3] > 32
    occupied_y, _ = np.where(alpha)
    if len(occupied_y) < 48:
        raise ValueError("coded gait cell is empty")
    lower_limit = occupied_y.min() + (occupied_y.max() - occupied_y.min()) * 0.52
    lower_body = np.indices((CELL_H, CELL_W))[0] >= lower_limit
    # The QA artist painted Harin's anatomical left side blue and right side
    # yellow. Keeping those identities explicit prevents a visually plausible
    # horizontal flip from silently reversing the gait phase.
    anatomical_left = (
        alpha
        & lower_body
        & (blue > 115)
        & (blue > red * 1.28)
        & (blue > green * 1.12)
    )
    anatomical_right = (
        alpha
        & lower_body
        & (red > 125)
        & (green > 80)
        & (red > blue * 1.35)
        & (green > blue * 1.12)
    )
    left_y, left_x = np.where(anatomical_left)
    right_y, right_x = np.where(anatomical_right)
    if len(left_x) < 8 or len(right_x) < 8:
        raise ValueError("coded gait cell is missing a boot marker")
    length = math.hypot(*vector)
    direction_x = vector[0] / length
    direction_y = vector[1] / length
    return float(
        (left_x.mean() - right_x.mean()) * direction_x
        + (left_y.mean() - right_y.mean()) * direction_y
    )


def alpha_bounds(cell: Image.Image) -> tuple[int, int, int, int]:
    bounds = cell.getchannel("A").point(lambda value: 255 if value > MIN_ALPHA else 0).getbbox()
    if bounds is None:
        raise ValueError("gait frame is empty")
    return bounds


def torso_anchor_x(cell: Image.Image) -> float:
    alpha = np.asarray(cell.getchannel("A"), dtype=np.uint8)
    y, x = np.where(alpha > MIN_ALPHA)
    top = int(y.min())
    bottom = int(y.max())
    torso = (
        (alpha > MIN_ALPHA)
        & (np.indices(alpha.shape)[0] >= top + (bottom - top) * 0.12)
        & (np.indices(alpha.shape)[0] <= top + (bottom - top) * 0.50)
    )
    torso_y, torso_x = np.where(torso)
    if len(torso_x) < 24:
        return float((x.min() + x.max()) / 2)
    # Quantiles keep a hand, cape tail, or weapon-like silhouette from pulling
    # the body anchor away from the spine.
    return float((np.quantile(torso_x, 0.08) + np.quantile(torso_x, 0.92)) / 2)


def register_cell(cell: Image.Image, target_height: int) -> Image.Image:
    bounds = alpha_bounds(cell)
    anchor_x = torso_anchor_x(cell)
    crop = cell.crop(bounds)
    source_height = max(1, bounds[3] - bounds[1])
    scale = target_height / source_height
    width = max(1, round(crop.width * scale))
    height = max(1, round(crop.height * scale))
    resized = crop.resize((width, height), Image.Resampling.LANCZOS)
    anchor_in_crop = (anchor_x - bounds[0]) * scale
    paste_x = round(TORSO_X - anchor_in_crop)
    paste_y = FLOOR_Y - height + 1
    paste_x = min(max(2, paste_x), CELL_W - width - 2)
    paste_y = min(max(2, paste_y), CELL_H - height - 2)
    output = Image.new("RGBA", (CELL_W, CELL_H), (0, 0, 0, 0))
    output.alpha_composite(resized, (paste_x, paste_y))
    return output


def clean_transparent_matte(cell: Image.Image) -> Image.Image:
    """Remove chroma spill that is visible only in antialiased edge pixels."""

    rgba = np.asarray(cell, dtype=np.uint8).copy()
    red = rgba[:, :, 0].astype(np.float32)
    green = rgba[:, :, 1].astype(np.float32)
    blue = rgba[:, :, 2].astype(np.float32)
    alpha = rgba[:, :, 3]
    spill = (
        (alpha <= 150)
        & (green > red * 1.16 + 7)
        & (green > blue * 1.08 + 5)
    )
    # Edge RGB is irrelevant after alpha is zero; removing it entirely avoids
    # bilinear green halos without erasing opaque cloth or future jade gear.
    rgba[spill] = (0, 0, 0, 0)
    return Image.fromarray(rgba, mode="RGBA")


def lower_body_iou(first: Image.Image, second: Image.Image) -> float:
    first_alpha = np.asarray(first.getchannel("A"), dtype=np.uint8) > MIN_ALPHA
    second_alpha = np.asarray(second.getchannel("A"), dtype=np.uint8) > MIN_ALPHA
    combined = first_alpha | second_alpha
    occupied_y, _ = np.where(combined)
    cutoff = int(occupied_y.min() + (occupied_y.max() - occupied_y.min()) * 0.52)
    lower = np.indices(first_alpha.shape)[0] >= cutoff
    intersection = np.logical_and(first_alpha, second_alpha) & lower
    union = combined & lower
    return float(intersection.sum() / max(1, union.sum()))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--coded", type=Path, required=True)
    parser.add_argument("--final", type=Path, required=True)
    parser.add_argument("--passing", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--report", type=Path, required=True)
    args = parser.parse_args()

    coded = Image.open(args.coded).convert("RGBA")
    final = Image.open(args.final).convert("RGBA")
    passing = Image.open(args.passing).convert("RGBA")
    if coded.size != ATLAS_SIZE or final.size != ATLAS_SIZE or passing.size != ATLAS_SIZE:
        raise ValueError("all gait atlases must be 1024x1536")

    output = Image.new("RGBA", ATLAS_SIZE, (0, 0, 0, 0))
    report: dict[str, object] = {
        "phase_contract": [
            "left-contact",
            "neutral-passing",
            "right-contact",
            "neutral-return",
        ],
        "directions": {},
    }
    failures: list[str] = []

    for row, (name, vector) in enumerate(AUTHORED_DIRECTIONS):
        coded_cells = [source_cell(coded, row, column)[0] for column in range(COLS)]
        projections = [marker_projection(cell, vector) for cell in coded_cells]
        left_contact, right_contact = CONTACT_SOURCE_COLUMNS[row]
        passing_to_right, passing_to_left = PASSING_SOURCE_COLUMNS[row]
        contact_projections = (projections[left_contact], projections[right_contact])
        if contact_projections[0] <= 3 or contact_projections[1] >= -3:
            failures.append(
                f"{name}: contact poses do not contain opposite foot leads "
                f"{contact_projections} from {projections}"
            )

        final_left = source_cell(final, row, left_contact)[0]
        final_right = source_cell(final, row, right_contact)[0]
        passing_right = source_cell(passing, row, passing_to_right)[0]
        passing_left = source_cell(passing, row, passing_to_left)[0]
        raw_frames = [final_left, passing_right, final_right, passing_left]
        contact_heights = [
            alpha_bounds(final_left)[3] - alpha_bounds(final_left)[1],
            alpha_bounds(final_right)[3] - alpha_bounds(final_right)[1],
        ]
        target_height = round(sum(contact_heights) / len(contact_heights))
        frames = [clean_transparent_matte(register_cell(frame, target_height)) for frame in raw_frames]

        contact_iou = lower_body_iou(frames[0], frames[2])
        passing_iou = lower_body_iou(frames[1], frames[3])
        # Back-facing legs overlap heavily in projection even when the colour
        # IDs prove that the planted anatomical foot changed.  0.94 still
        # rejects the old near-duplicate 0.96+ cells without false-failing N.
        if contact_iou >= 0.94:
            failures.append(f"{name}: opposite contacts are too similar ({contact_iou:.3f})")
        if passing_iou >= 0.9995:
            failures.append(f"{name}: passing poses are pixel duplicates ({passing_iou:.3f})")

        floor_pixels: list[int] = []
        torso_residuals: list[float] = []
        for column, composed in enumerate(frames):
            bounds = alpha_bounds(composed)
            floor_pixels.append(bounds[3] - 1)
            torso_residuals.append(abs(torso_anchor_x(composed) - TORSO_X))
            if bounds[0] <= 0 or bounds[2] >= CELL_W or bounds[1] <= 0 or bounds[3] >= CELL_H:
                failures.append(f"{name} phase {column}: edge clipping risk {bounds}")
            output.alpha_composite(composed, (column * CELL_W, row * CELL_H))

        if any(floor != FLOOR_Y for floor in floor_pixels):
            failures.append(f"{name}: inconsistent floor baseline {floor_pixels}")
        if max(torso_residuals) > 2.0:
            failures.append(f"{name}: torso anchor drift {torso_residuals}")

        report["directions"][name] = {
            "source_row": SYNTHESISED_ROWS.get(row, row),
            "mirrored": row in SYNTHESISED_ROWS,
            "marker_projections": projections,
            "left_contact_source_column": left_contact,
            "right_contact_source_column": right_contact,
            "passing_source_columns": [passing_to_right, passing_to_left],
            "target_height": target_height,
            "floor_pixels": floor_pixels,
            "torso_anchor_residuals": torso_residuals,
            "contact_lower_body_iou": contact_iou,
            "passing_lower_body_iou": passing_iou,
        }

    report["failures"] = failures
    report["passed"] = not failures
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    if failures:
        print(json.dumps({"passed": False, "failures": failures}, ensure_ascii=False))
        raise SystemExit(1)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    output.save(args.output, optimize=True)
    print(json.dumps({"passed": True, "output": str(args.output)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
