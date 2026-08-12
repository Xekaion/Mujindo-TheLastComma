"""Retarget Harin's mannequin and wearable layers to a corrected gait atlas.

The runtime paperdoll is a registered 4x8 raster rig.  A newly authored body
may improve the limb poses without requiring thousands of full equipment
combinations: each existing wearable cell is moved with a piecewise affine
warp estimated from the old and new body silhouettes in that same cell.

The operation is intentionally non-destructive by default.  It writes a new
body and layer root, validates all 3,200 layer cells, and only then can runtime
constants be switched to the new build.
"""

from __future__ import annotations

import argparse
import json
from collections import deque
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter


CELL_W = 256
CELL_H = 192
COLS = 4
ROWS = 8
ATLAS_SIZE = (CELL_W * COLS, CELL_H * ROWS)
GRID_X = 6
GRID_Y = 8
MIN_ALPHA = 16
VISIBLE_ALPHA = 8
SLOTS = (
    "weapon",
    "offhand",
    "helm",
    "shoulders",
    "armor",
    "gloves",
    "belt",
    "legs",
    "boots",
    "relic",
)
BODY_FOLLOWING_SLOTS = frozenset({"gloves", "legs", "boots"})
HELD_SLOTS = frozenset({"weapon", "offhand"})


def cell_box(row: int, column: int) -> tuple[int, int, int, int]:
    return (
        column * CELL_W,
        row * CELL_H,
        (column + 1) * CELL_W,
        (row + 1) * CELL_H,
    )


def silhouette_landmarks(frame: Image.Image) -> np.ndarray:
    alpha = np.asarray(frame.getchannel("A"), dtype=np.uint8)
    ys, xs = np.where(alpha > MIN_ALPHA)
    if len(xs) < 48:
        raise ValueError("body frame is empty or too sparse")
    top = int(ys.min())
    bottom = int(ys.max())
    rows: list[list[float]] = []
    centers: list[float] = []
    # Multiple boundary samples per height band follow hips, legs, arms and
    # head far better than one whole-frame scale/translation.
    for gy in range(GRID_Y):
        sample_y = round(top + (bottom - top) * gy / (GRID_Y - 1))
        radius = max(2, round((bottom - top) * 0.018))
        band_y, band_x = np.where(
            alpha[max(0, sample_y - radius) : min(CELL_H, sample_y + radius + 1)]
            > MIN_ALPHA
        )
        if len(band_x) == 0:
            nearest_index = int(np.argmin(np.abs(ys - sample_y)))
            occupied = np.array([xs[nearest_index]], dtype=float)
        else:
            occupied = band_x.astype(float)
        occupied_left = float(np.quantile(occupied, 0.04))
        occupied_right = float(np.quantile(occupied, 0.96))
        occupied_center = (occupied_left + occupied_right) / 2
        occupied_half_width = max(8.0, (occupied_right - occupied_left) / 2)
        rows.append(
            [
                occupied_center + occupied_half_width * scale
                for scale in np.linspace(-1.75, 1.75, GRID_X)
            ]
        )
        centers.append(occupied_center)
    center_x = float(np.median(centers))
    # Outer columns cover detached weapons/relics without letting those rigid
    # silhouettes distort the body-following inner columns.
    rows.insert(0, list(np.linspace(0.0, CELL_W - 1.0, GRID_X)))
    rows.append(list(np.linspace(0.0, CELL_W - 1.0, GRID_X)))
    points: list[tuple[float, float]] = []
    for gy, row in enumerate(rows):
        y = 0.0 if gy == 0 else CELL_H - 1.0 if gy == len(rows) - 1 else top + (bottom - top) * (gy - 1) / (GRID_Y - 1)
        for x in row:
            points.append((float(np.clip(x + (center_x - center_x), 0, CELL_W - 1)), float(y)))
    return np.asarray(points, dtype=np.float64)


def triangles() -> list[tuple[int, int, int]]:
    output: list[tuple[int, int, int]] = []
    total_rows = GRID_Y + 2
    for gy in range(total_rows - 1):
        for gx in range(GRID_X - 1):
            a = gy * GRID_X + gx
            b = a + 1
            c = (gy + 1) * GRID_X + gx
            d = c + 1
            output.extend(((a, b, d), (a, d, c)))
    return output


def mesh_warp(
    frame: Image.Image,
    source_points: np.ndarray,
    destination_points: np.ndarray,
) -> Image.Image:
    source_rgba = np.asarray(frame, dtype=np.uint8)
    output = np.zeros((CELL_H, CELL_W, 4), dtype=np.uint8)
    for indices in triangles():
        source_triangle = source_points[list(indices)]
        destination_triangle = destination_points[list(indices)]
        matrix = np.vstack(
            (
                destination_triangle.T,
                np.ones(3, dtype=np.float64),
            )
        )
        if abs(float(np.linalg.det(matrix))) < 1e-4:
            continue
        minimum_x = max(0, int(np.floor(destination_triangle[:, 0].min())))
        maximum_x = min(CELL_W - 1, int(np.ceil(destination_triangle[:, 0].max())))
        minimum_y = max(0, int(np.floor(destination_triangle[:, 1].min())))
        maximum_y = min(CELL_H - 1, int(np.ceil(destination_triangle[:, 1].max())))
        if maximum_x < minimum_x or maximum_y < minimum_y:
            continue
        grid_x, grid_y = np.meshgrid(
            np.arange(minimum_x, maximum_x + 1, dtype=np.float64),
            np.arange(minimum_y, maximum_y + 1, dtype=np.float64),
        )
        coordinates = np.stack(
            (grid_x.ravel(), grid_y.ravel(), np.ones(grid_x.size)),
            axis=1,
        )
        barycentric = (np.linalg.inv(matrix) @ coordinates.T).T
        inside = np.all(barycentric >= -1e-5, axis=1)
        if not np.any(inside):
            continue
        destination_coordinates = coordinates[inside, :2]
        source_coordinates = barycentric[inside] @ source_triangle
        source_x = np.clip(np.rint(source_coordinates[:, 0]).astype(int), 0, CELL_W - 1)
        source_y = np.clip(np.rint(source_coordinates[:, 1]).astype(int), 0, CELL_H - 1)
        destination_x = destination_coordinates[:, 0].astype(int)
        destination_y = destination_coordinates[:, 1].astype(int)
        output[destination_y, destination_x] = source_rgba[source_y, source_x]
    return Image.fromarray(output, mode="RGBA")


def body_bounds(frame: Image.Image) -> tuple[int, int, int, int]:
    bounds = frame.getchannel("A").point(
        lambda value: 255 if value > MIN_ALPHA else 0,
    ).getbbox()
    if bounds is None:
        raise ValueError("body frame is empty")
    return bounds


def rigid_retarget(
    frame: Image.Image,
    source_body: Image.Image,
    destination_body: Image.Image,
) -> Image.Image:
    """Preserve every authored equipment pixel while following body scale.

    Piecewise silhouette warps are useful for large opaque clothing, but they
    can collapse thin swords and tiny relics between mesh samples. A uniform
    body-registered transform is deterministic, keeps alpha mass, and avoids
    those holes while still matching Harin's corrected torso and floor.
    """

    source_bounds = body_bounds(source_body)
    destination_bounds = body_bounds(destination_body)
    source_center_x = (source_bounds[0] + source_bounds[2]) / 2
    destination_center_x = (destination_bounds[0] + destination_bounds[2]) / 2
    source_height = max(1, source_bounds[3] - source_bounds[1])
    destination_height = max(1, destination_bounds[3] - destination_bounds[1])
    scale = destination_height / source_height
    # Large per-frame scale swings make armor pulse. The generated bodies are
    # already registered, so only restrained correction is needed.
    scale = float(np.clip(scale, 0.96, 1.0))
    if abs(scale - 1.0) < 0.005:
        resized = frame
        scaled_center_x = source_center_x
        scaled_floor_y = source_bounds[3] - 1
    else:
        resized = frame.resize(
            (max(1, round(CELL_W * scale)), max(1, round(CELL_H * scale))),
            Image.Resampling.LANCZOS,
        )
        scaled_center_x = source_center_x * scale
        scaled_floor_y = (source_bounds[3] - 1) * scale
    target_floor_y = destination_bounds[3] - 1
    offset_x = round(destination_center_x - scaled_center_x)
    offset_y = round(target_floor_y - scaled_floor_y)
    content_bounds = resized.getchannel("A").point(
        lambda value: 255 if value > VISIBLE_ALPHA else 0,
    ).getbbox()
    if content_bounds is not None:
        offset_x = min(max(2 - content_bounds[0], offset_x), CELL_W - 2 - content_bounds[2])
        offset_y = min(max(2 - content_bounds[1], offset_y), CELL_H - 2 - content_bounds[3])
    output = Image.new("RGBA", (CELL_W, CELL_H), (0, 0, 0, 0))
    output.alpha_composite(resized, (offset_x, offset_y))
    return output


def nearest_body_displacement_field(
    source_body: Image.Image,
    destination_body: Image.Image,
) -> tuple[np.ndarray, np.ndarray]:
    """Estimate a dense nearest-silhouette flow without external CV packages."""

    source_alpha = np.asarray(source_body.getchannel("A"), dtype=np.uint8)
    destination_alpha = np.asarray(destination_body.getchannel("A"), dtype=np.uint8)
    source_y, source_x = np.where(source_alpha > MIN_ALPHA)
    destination_y, destination_x = np.where(destination_alpha > MIN_ALPHA)
    if len(source_x) < 48 or len(destination_x) < 48:
        raise ValueError("body frame is too sparse for layer retargeting")

    source_coordinates = np.column_stack((source_x, source_y)).astype(np.float32)
    destination_coordinates = np.column_stack((destination_x, destination_y)).astype(np.float32)
    chunk_size = 512
    reference_stride = max(1, len(destination_coordinates) // 900)
    destination_reference = destination_coordinates[::reference_stride]

    def nearest(query: np.ndarray, reference: np.ndarray) -> np.ndarray:
        output = np.empty_like(query)
        for start in range(0, len(query), chunk_size):
            section = query[start : start + chunk_size]
            distances = (
                (section[:, None, 0] - reference[None, :, 0]) ** 2
                + (section[:, None, 1] - reference[None, :, 1]) ** 2
            )
            output[start : start + len(section)] = reference[np.argmin(distances, axis=1)]
        return output

    # Mutual silhouette correspondences are far more stable than a one-way
    # nearest map around crossing legs and arms.
    source_to_destination = nearest(source_coordinates, destination_reference)
    displacement = source_to_destination - source_coordinates
    dx = np.zeros((CELL_H, CELL_W), dtype=np.float32)
    dy = np.zeros((CELL_H, CELL_W), dtype=np.float32)
    weight = np.zeros((CELL_H, CELL_W), dtype=np.float32)
    radius = 7
    sigma = 3.0
    source_stride = max(1, len(source_coordinates) // 900)
    for (source_point, delta) in zip(
        source_coordinates[::source_stride],
        displacement[::source_stride],
    ):
        px, py = int(source_point[0]), int(source_point[1])
        minimum_x = max(0, px - radius)
        maximum_x = min(CELL_W, px + radius + 1)
        minimum_y = max(0, py - radius)
        maximum_y = min(CELL_H, py + radius + 1)
        grid_y, grid_x = np.mgrid[minimum_y:maximum_y, minimum_x:maximum_x]
        local_weight = np.exp(-((grid_x - px) ** 2 + (grid_y - py) ** 2) / (2 * sigma * sigma))
        dx[minimum_y:maximum_y, minimum_x:maximum_x] += local_weight * delta[0]
        dy[minimum_y:maximum_y, minimum_x:maximum_x] += local_weight * delta[1]
        weight[minimum_y:maximum_y, minimum_x:maximum_x] += local_weight

    safe_weight = np.maximum(weight, 1e-5)
    dx /= safe_weight
    dy /= safe_weight
    # Fill detached weapon/relic regions with the torso-registered motion; gear
    # pixels near a limb still receive the local limb displacement below.
    source_bounds = body_bounds(source_body)
    destination_bounds = body_bounds(destination_body)
    fallback_x = ((destination_bounds[0] + destination_bounds[2]) - (source_bounds[0] + source_bounds[2])) / 2
    fallback_y = destination_bounds[3] - source_bounds[3]
    dx[weight <= 1e-5] = fallback_x
    dy[weight <= 1e-5] = fallback_y
    return dx, dy


def splat_retarget(
    frame: Image.Image,
    source_body: Image.Image,
    destination_body: Image.Image,
    flow: tuple[np.ndarray, np.ndarray] | None = None,
) -> Image.Image:
    source = np.asarray(frame, dtype=np.uint8)
    alpha = source[:, :, 3]
    visible_y, visible_x = np.where(alpha > 0)
    if len(visible_x) == 0:
        return frame.copy()
    dx, dy = flow or nearest_body_displacement_field(source_body, destination_body)
    target_x = np.clip(np.rint(visible_x + dx[visible_y, visible_x]).astype(int), 1, CELL_W - 2)
    target_y = np.clip(np.rint(visible_y + dy[visible_y, visible_x]).astype(int), 1, CELL_H - 2)
    output = np.zeros((CELL_H, CELL_W, 4), dtype=np.uint8)
    # Draw lower alpha first so opaque authored pixels win when the pose closes.
    order = np.argsort(alpha[visible_y, visible_x])
    for index in order:
        x = target_x[index]
        y = target_y[index]
        pixel = source[visible_y[index], visible_x[index]]
        if pixel[3] >= output[y, x, 3]:
            output[y, x] = pixel
    # Forward splatting may leave single-pixel holes after a limb stretches.
    image = Image.fromarray(output, mode="RGBA")
    dilated_alpha = image.getchannel("A").filter(ImageFilter.MaxFilter(3))
    hole_mask = np.asarray(dilated_alpha, dtype=np.uint8) > np.asarray(image.getchannel("A"), dtype=np.uint8)
    filled = np.asarray(image.filter(ImageFilter.MaxFilter(3)), dtype=np.uint8)
    output[hole_mask] = filled[hole_mask]
    return Image.fromarray(output, mode="RGBA")


def snap_attached_pixels_to_body(
    frame: Image.Image,
    destination_body: Image.Image,
    maximum_distance: float = 5.0,
) -> Image.Image:
    """Pull detached worn pixels back to the nearest new body silhouette."""

    source = np.asarray(frame, dtype=np.uint8)
    visible_y, visible_x = np.where(source[:, :, 3] > 0)
    body_alpha = np.asarray(destination_body.getchannel("A"), dtype=np.uint8)
    body_y, body_x = np.where(body_alpha > MIN_ALPHA)
    if len(visible_x) == 0 or len(body_x) == 0:
        return frame
    reference = np.column_stack((body_x, body_y)).astype(np.float32)
    query = np.column_stack((visible_x, visible_y)).astype(np.float32)
    reference = reference[:: max(1, len(reference) // 1200)]
    nearest_points = np.empty_like(query)
    nearest_distance = np.empty(len(query), dtype=np.float32)
    for start in range(0, len(query), 384):
        section = query[start : start + 384]
        squared = (
            (section[:, None, 0] - reference[None, :, 0]) ** 2
            + (section[:, None, 1] - reference[None, :, 1]) ** 2
        )
        indices = np.argmin(squared, axis=1)
        nearest_points[start : start + len(section)] = reference[indices]
        nearest_distance[start : start + len(section)] = np.sqrt(
            squared[np.arange(len(section)), indices]
        )
    far = nearest_distance > maximum_distance
    if not np.any(far):
        return frame
    direction = nearest_points[far] - query[far]
    scale = np.maximum(0.0, (nearest_distance[far] - maximum_distance) / nearest_distance[far])
    query[far] += direction * scale[:, None]
    target_x = np.clip(np.rint(query[:, 0]).astype(int), 1, CELL_W - 2)
    target_y = np.clip(np.rint(query[:, 1]).astype(int), 1, CELL_H - 2)
    output = np.zeros_like(source)
    order = np.argsort(source[visible_y, visible_x, 3])
    for index in order:
        pixel = source[visible_y[index], visible_x[index]]
        x = target_x[index]
        y = target_y[index]
        if pixel[3] >= output[y, x, 3]:
            output[y, x] = pixel
    return Image.fromarray(output, mode="RGBA")


def retarget_held_layer(
    frame: Image.Image,
    source_body: Image.Image,
    destination_body: Image.Image,
    flow: tuple[np.ndarray, np.ndarray],
) -> Image.Image:
    """Move an authored held silhouette with its old hand to the new hand.

    A sword must stay rigid. Dense limb splatting bends long blades and can
    split isolated glow pixels from their hilt, so weapon/offhand layers use a
    single translation sampled from the old layer/body contact pixels. A small
    local search then locks those same grip pixels to the new silhouette.
    """

    source = np.asarray(frame, dtype=np.uint8)
    layer_y, layer_x = np.where(source[:, :, 3] > VISIBLE_ALPHA)
    if len(layer_x) == 0:
        return frame.copy()
    source_bounds = body_bounds(source_body)
    source_height = max(1, source_bounds[3] - source_bounds[1])

    source_body_mask = np.asarray(source_body.getchannel("A"), dtype=np.uint8) > MIN_ALPHA
    source_near = np.asarray(
        Image.fromarray((source_body_mask * 255).astype(np.uint8), mode="L").filter(
            ImageFilter.MaxFilter(13)
        ),
        dtype=np.uint8,
    ) > 0
    hand_band = (
        (layer_y >= source_bounds[1] + source_height * 0.18)
        & (layer_y <= source_bounds[1] + source_height * 0.76)
    )
    contact = source_near[layer_y, layer_x] & hand_band
    if int(contact.sum()) < 3:
        contact = source_near[layer_y, layer_x]
    if int(contact.sum()) < 3:
        # Extremely detached authored glows still follow the torso rather than
        # being destroyed by a per-pixel warp.
        return rigid_retarget(frame, source_body, destination_body)

    grip_x = layer_x[contact]
    grip_y = layer_y[contact]
    dx, dy = flow
    base_x = int(round(float(np.median(dx[grip_y, grip_x]))))
    base_y = int(round(float(np.median(dy[grip_y, grip_x]))))

    frame_bounds = frame.getchannel("A").point(
        lambda value: 255 if value > VISIBLE_ALPHA else 0,
    ).getbbox()
    if frame_bounds is None:
        return frame.copy()
    minimum_x = 2 - frame_bounds[0]
    maximum_x = CELL_W - 2 - frame_bounds[2]
    minimum_y = 2 - frame_bounds[1]
    maximum_y = CELL_H - 2 - frame_bounds[3]

    destination_body_mask = np.asarray(
        destination_body.getchannel("A"),
        dtype=np.uint8,
    ) > MIN_ALPHA
    destination_near_three = np.asarray(
        Image.fromarray((destination_body_mask * 255).astype(np.uint8), mode="L").filter(
            ImageFilter.MaxFilter(7)
        ),
        dtype=np.uint8,
    ) > 0
    destination_near_six = np.asarray(
        Image.fromarray((destination_body_mask * 255).astype(np.uint8), mode="L").filter(
            ImageFilter.MaxFilter(13)
        ),
        dtype=np.uint8,
    ) > 0

    best: tuple[int, float, float, int, int, int] | None = None
    for adjustment_y in range(-9, 10):
        offset_y = int(np.clip(base_y + adjustment_y, minimum_y, maximum_y))
        target_y = grip_y + offset_y
        if np.any((target_y < 0) | (target_y >= CELL_H)):
            continue
        for adjustment_x in range(-9, 10):
            offset_x = int(np.clip(base_x + adjustment_x, minimum_x, maximum_x))
            target_x = grip_x + offset_x
            if np.any((target_x < 0) | (target_x >= CELL_W)):
                continue
            near_three = float(destination_near_three[target_y, target_x].mean())
            near_six = float(destination_near_six[target_y, target_x].mean())
            contact_pixels = int(destination_near_three[target_y, target_x].sum())
            deviation = (offset_x - base_x) ** 2 + (offset_y - base_y) ** 2
            candidate = (
                contact_pixels,
                near_three,
                near_six,
                -deviation,
                offset_x,
                offset_y,
            )
            if best is None or candidate > best:
                best = candidate
    if best is None:
        offset_x = int(np.clip(base_x, minimum_x, maximum_x))
        offset_y = int(np.clip(base_y, minimum_y, maximum_y))
    else:
        offset_x, offset_y = best[4], best[5]
    translated = Image.new("RGBA", (CELL_W, CELL_H), (0, 0, 0, 0))
    translated.alpha_composite(frame, (int(offset_x), int(offset_y)))
    return translated


def keep_better_attached_candidate(
    first: Image.Image,
    second: Image.Image,
    destination_body: Image.Image,
) -> Image.Image:
    """Choose the rigid held pose with the clearest grip, not shortest blade."""

    body_mask = np.asarray(destination_body.getchannel("A"), dtype=np.uint8) > MIN_ALPHA
    near_three = np.asarray(
        Image.fromarray((body_mask * 255).astype(np.uint8), mode="L").filter(
            ImageFilter.MaxFilter(7)
        ),
        dtype=np.uint8,
    ) > 0
    near_six = np.asarray(
        Image.fromarray((body_mask * 255).astype(np.uint8), mode="L").filter(
            ImageFilter.MaxFilter(13)
        ),
        dtype=np.uint8,
    ) > 0

    def score(candidate: Image.Image) -> tuple[int, float, float]:
        mask = np.asarray(candidate.getchannel("A"), dtype=np.uint8) > VISIBLE_ALPHA
        if not np.any(mask):
            return (-1, -1.0, -1.0)
        close_three = float(np.logical_and(mask, near_three).sum() / mask.sum())
        close_six = float(np.logical_and(mask, near_six).sum() / mask.sum())
        contact_pixels = int(np.logical_and(mask, near_three).sum())
        return (contact_pixels, close_six, close_three)

    first_score = score(first)
    second_score = score(second)
    # Prefer the candidate with materially more actual grip pixels.  Long
    # blades naturally have a low ratio even when the hilt is correctly held.
    if second_score[0] > first_score[0] + max(3, round(first_score[0] * 0.18)):
        return second
    return first


def attach_large_held_components(
    frame: Image.Image,
    destination_body: Image.Image,
) -> Image.Image:
    """Move only large detached weapon components back to the grip cluster."""

    source = np.asarray(frame, dtype=np.uint8)
    mask = source[:, :, 3] > MIN_ALPHA
    body_mask = np.asarray(destination_body.getchannel("A"), dtype=np.uint8) > MIN_ALPHA
    near_body = np.asarray(
        Image.fromarray((body_mask * 255).astype(np.uint8), mode="L").filter(
            ImageFilter.MaxFilter(11)
        ),
        dtype=np.uint8,
    ) > 0
    seen = np.zeros((CELL_H, CELL_W), dtype=bool)
    components: list[np.ndarray] = []
    for start_y, start_x in zip(*np.where(mask)):
        if seen[start_y, start_x]:
            continue
        queue: deque[tuple[int, int]] = deque([(int(start_y), int(start_x))])
        seen[start_y, start_x] = True
        points: list[tuple[int, int]] = []
        while queue:
            y, x = queue.popleft()
            points.append((y, x))
            for delta_y in (-1, 0, 1):
                for delta_x in (-1, 0, 1):
                    next_y, next_x = y + delta_y, x + delta_x
                    if (
                        0 <= next_y < CELL_H
                        and 0 <= next_x < CELL_W
                        and mask[next_y, next_x]
                        and not seen[next_y, next_x]
                    ):
                        seen[next_y, next_x] = True
                        queue.append((next_y, next_x))
        components.append(np.asarray(points, dtype=int))

    output = source.copy()
    for points in components:
        y = points[:, 0]
        x = points[:, 1]
        if len(points) < 48 or np.any(near_body[y, x]):
            continue
        best: tuple[int, int, int, int] | None = None
        for offset_y in range(-22, 23):
            target_y = y + offset_y
            if target_y.min() < 2 or target_y.max() >= CELL_H - 2:
                continue
            for offset_x in range(-22, 23):
                target_x = x + offset_x
                if target_x.min() < 2 or target_x.max() >= CELL_W - 2:
                    continue
                contact = int(near_body[target_y, target_x].sum())
                distance = offset_x * offset_x + offset_y * offset_y
                candidate = (contact, -distance, offset_x, offset_y)
                if best is None or candidate > best:
                    best = candidate
        if best is None or best[0] == 0:
            continue
        output[y, x] = 0
        target_x = x + best[2]
        target_y = y + best[3]
        for index in np.argsort(source[y, x, 3]):
            pixel = source[y[index], x[index]]
            tx, ty = target_x[index], target_y[index]
            if pixel[3] >= output[ty, tx, 3]:
                output[ty, tx] = pixel
    return Image.fromarray(output, mode="RGBA")


def atlas_landmarks(atlas: Image.Image) -> list[list[np.ndarray]]:
    return [
        [silhouette_landmarks(atlas.crop(cell_box(row, column))) for column in range(COLS)]
        for row in range(ROWS)
    ]


def remap_atlas(
    atlas: Image.Image,
    slot: str,
    old_body: Image.Image,
    new_body: Image.Image,
    old_points: list[list[np.ndarray]],
    new_points: list[list[np.ndarray]],
    flow_fields: list[list[tuple[np.ndarray, np.ndarray]]],
) -> Image.Image:
    output = Image.new("RGBA", ATLAS_SIZE, (0, 0, 0, 0))

    def held_candidate(
        source_frame: Image.Image,
        source_body_frame: Image.Image,
        destination_body_frame: Image.Image,
        row: int,
        column: int,
    ) -> Image.Image:
        local = retarget_held_layer(
            source_frame,
            source_body_frame,
            destination_body_frame,
            flow_fields[row][column],
        )
        torso = rigid_retarget(
            source_frame,
            source_body_frame,
            destination_body_frame,
        )
        return keep_better_attached_candidate(
            local,
            torso,
            destination_body_frame,
        )

    for row in range(ROWS):
        for column in range(COLS):
            frame = atlas.crop(cell_box(row, column))
            source_body = old_body.crop(cell_box(row, column))
            destination_body = new_body.crop(cell_box(row, column))
            if slot in HELD_SLOTS:
                warped = held_candidate(
                    frame,
                    source_body,
                    destination_body,
                    row,
                    column,
                )
                # The two neutral columns are mechanically passing poses. When
                # ImageGen changed the arm silhouette more than the legacy
                # layer can safely follow, reuse the same-direction held art
                # from the nearest true contact pose. This preserves a stable
                # hilt/hand connection while the body supplies the leg motion.
                if column in (1, 3):
                    contact_column = 0 if column == 3 else 2
                    contact_frame = atlas.crop(cell_box(row, contact_column))
                    contact_source_body = old_body.crop(cell_box(row, contact_column))
                    contact_candidate = held_candidate(
                        contact_frame,
                        contact_source_body,
                        destination_body,
                        row,
                        contact_column,
                    )
                    warped = keep_better_attached_candidate(
                        warped,
                        contact_candidate,
                        destination_body,
                    )
                warped = attach_large_held_components(warped, destination_body)
            else:
                warped = splat_retarget(
                    frame,
                    source_body,
                    destination_body,
                    flow_fields[row][column],
                )
            # Hands, knees and feet travel furthest between opposite contacts.
            # Constrain only those articulated overlays; rigid torso pieces and
            # decorative silhouettes must retain their authored outward shape.
            if slot in BODY_FOLLOWING_SLOTS:
                warped = snap_attached_pixels_to_body(warped, destination_body)
            # Keep the mesh implementation available for future joint maps,
            # but never accept it when it discards authored alpha mass.
            source_alpha = np.asarray(frame.getchannel("A"), dtype=np.uint8)
            warped_alpha = np.asarray(warped.getchannel("A"), dtype=np.uint8)
            source_mass = int(source_alpha.sum())
            warped_mass = int(warped_alpha.sum())
            if source_mass and warped_mass < source_mass * 0.72:
                # A sub-pixel forward splat can merge a thin translucent glow.
                # Preserve the authored alpha mass by raising only existing
                # warped coverage; geometry remains attached to the new pose.
                gain = min(3.0, source_mass / max(1, warped_mass))
                warped_array = np.asarray(warped, dtype=np.uint8).copy()
                warped_array[:, :, 3] = np.clip(
                    warped_array[:, :, 3].astype(np.float32) * gain,
                    0,
                    255,
                ).astype(np.uint8)
                warped = Image.fromarray(warped_array, mode="RGBA")
                warped_mass = int(warped_array[:, :, 3].sum())
            if source_mass and warped_mass < source_mass * 0.15:
                raise ValueError(
                    f"layer alpha mass collapsed at {row},{column}: "
                    f"{source_mass}->{warped_mass}"
                )
            output.alpha_composite(warped, (column * CELL_W, row * CELL_H))
    return output


def validate_layer_atlas(atlas: Image.Image, label: str) -> dict[str, int]:
    if atlas.size != ATLAS_SIZE:
        raise ValueError(f"{label}: wrong size {atlas.size}")
    nonempty = 0
    clipped = 0
    for row in range(ROWS):
        for column in range(COLS):
            alpha = atlas.crop(cell_box(row, column)).getchannel("A")
            bounds = alpha.point(
                lambda value: 255 if value > VISIBLE_ALPHA else 0,
            ).getbbox()
            if bounds is None:
                continue
            nonempty += 1
            if bounds[0] <= 0 or bounds[1] <= 0 or bounds[2] >= CELL_W or bounds[3] >= CELL_H:
                clipped += 1
    if nonempty != ROWS * COLS or clipped:
        raise ValueError(f"{label}: nonempty={nonempty}, clipped={clipped}")
    return {"nonempty_cells": nonempty, "clipped_cells": clipped}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--old-body", type=Path, required=True)
    parser.add_argument("--new-body", type=Path, required=True)
    parser.add_argument("--input-layers", type=Path, required=True)
    parser.add_argument("--output-layers", type=Path, required=True)
    parser.add_argument("--output-body", type=Path, required=True)
    args = parser.parse_args()

    old_body = Image.open(args.old_body).convert("RGBA")
    new_body = Image.open(args.new_body).convert("RGBA")
    if old_body.size != ATLAS_SIZE or new_body.size != ATLAS_SIZE:
        raise ValueError("old and new body atlases must both be 1024x1536")
    old_points = atlas_landmarks(old_body)
    new_points = atlas_landmarks(new_body)
    # Body-to-body motion is identical for every equipment family. Computing
    # the 32 dense fields once avoids repeating the expensive silhouette match
    # for all 100 atlases and also guarantees identical joint motion per slot.
    flow_fields = [
        [
            nearest_body_displacement_field(
                old_body.crop(cell_box(row, column)),
                new_body.crop(cell_box(row, column)),
            )
            for column in range(COLS)
        ]
        for row in range(ROWS)
    ]
    args.output_body.parent.mkdir(parents=True, exist_ok=True)
    new_body.save(args.output_body, optimize=True)

    report: dict[str, object] = {"atlases": {}, "atlas_count": 0}
    for slot in SLOTS:
        source_dir = args.input_layers / slot
        destination_dir = args.output_layers / slot
        destination_dir.mkdir(parents=True, exist_ok=True)
        sources = sorted(source_dir.glob("*.png"))
        if len(sources) != 10:
            raise ValueError(f"{slot}: expected 10 atlases, found {len(sources)}")
        for source_path in sources:
            atlas = Image.open(source_path).convert("RGBA")
            if atlas.size != ATLAS_SIZE:
                raise ValueError(f"{source_path}: wrong size {atlas.size}")
            remapped = remap_atlas(
                atlas,
                slot,
                old_body,
                new_body,
                old_points,
                new_points,
                flow_fields,
            )
            key = f"{slot}/{source_path.name}"
            report["atlases"][key] = validate_layer_atlas(remapped, key)
            remapped.save(destination_dir / source_path.name, optimize=True)
            report["atlas_count"] = int(report["atlas_count"]) + 1

    report_path = args.output_layers / "build-report.json"
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"body": str(args.output_body), "layers": report["atlas_count"]}, ensure_ascii=False))


if __name__ == "__main__":
    main()
