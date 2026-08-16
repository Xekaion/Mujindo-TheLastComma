"""Semantic ownership and alignment primitives for held paperdoll layers.

The fitted outfit atlases are authoring references, not rig-compatible layers.
This module turns their registered visual delta into weapon/offhand cells with
four hard properties:

* the authored E/SW side mapping is used (weapon is screen-left only on rows
  S, SE and W);
* a retained component must join the direction-correct hand silhouette to an
  exterior silhouette;
* body core, foot core and near-body head/boot contours are never held art;
* every final cell keeps a transparent two-pixel gutter.

Only original fitted pixels are retained.  Dilation is used for connectivity
labels and contact tests, never to synthesize output pixels.
"""

from __future__ import annotations

import math
from collections import deque
from dataclasses import dataclass

import numpy as np
from PIL import Image, ImageChops, ImageFilter


CELL_W, CELL_H = 256, 192
ROWS, COLS = 8, 4
VISIBLE_ALPHA = 8
BODY_ALPHA = 16
PADDING = 2
HELD_SLOTS = ("weapon", "offhand")
WEAPON_LEFT_AUTHORED_ROWS = frozenset((0, 1, 6))


@dataclass(frozen=True)
class SemanticHandMasks:
    zone: np.ndarray
    near_three: np.ndarray
    near_seven: np.ndarray
    body_near_three: np.ndarray
    body_core: np.ndarray
    foot_core: np.ndarray


@dataclass(frozen=True)
class SemanticMasks:
    hand: SemanticHandMasks
    head_near: np.ndarray
    foot_near: np.ndarray
    expected_side: np.ndarray
    exterior_side: np.ndarray


def frame_box(row: int, column: int) -> tuple[int, int, int, int]:
    return (
        column * CELL_W,
        row * CELL_H,
        (column + 1) * CELL_W,
        (row + 1) * CELL_H,
    )


def weapon_is_left(authored_row: int) -> bool:
    return authored_row in WEAPON_LEFT_AUTHORED_ROWS


def expected_left(slot: str, authored_row: int) -> bool:
    weapon_left = weapon_is_left(authored_row)
    return weapon_left if slot == "weapon" else not weapon_left


def image_mask(image: Image.Image, threshold: int) -> np.ndarray:
    return np.asarray(image.getchannel("A"), dtype=np.uint8) > threshold


def dilate(mask: np.ndarray, size: int) -> np.ndarray:
    return (
        np.asarray(
            Image.fromarray((mask * 255).astype(np.uint8), mode="L").filter(
                ImageFilter.MaxFilter(size)
            ),
            dtype=np.uint8,
        )
        > 0
    )


def erode(mask: np.ndarray, size: int) -> np.ndarray:
    return (
        np.asarray(
            Image.fromarray((mask * 255).astype(np.uint8), mode="L").filter(
                ImageFilter.MinFilter(size)
            ),
            dtype=np.uint8,
        )
        > 0
    )


def body_geometry(body: Image.Image) -> tuple[int, int, int, int, float, float]:
    mask = image_mask(body, BODY_ALPHA)
    y, x = np.where(mask)
    if len(x) < 48:
        raise ValueError("mannequin frame is empty or too sparse")
    left, right = int(x.min()), int(x.max())
    top, bottom = int(y.min()), int(y.max())
    torso_start = top + round((bottom - top) * 0.18)
    torso_end = top + round((bottom - top) * 0.66)
    _torso_y, torso_x = np.where(mask[torso_start : torso_end + 1])
    center_x = (
        float(np.median(torso_x))
        if len(torso_x)
        else float((left + right) / 2)
    )
    return left, top, right, bottom, center_x, max(1.0, (right - left + 1) / 2)


def strict_hand_masks(
    body: Image.Image,
    slot: str,
    authored_row: int,
) -> SemanticHandMasks:
    body_mask = image_mask(body, BODY_ALPHA)
    _left, top, _right, bottom, center_x, half_width = body_geometry(body)
    height = bottom - top + 1
    side_left = expected_left(slot, authored_row)

    # Follow the outer forearm/hand boundary in each gait pose.  This is much
    # narrower than treating an entire half torso as a hand target.
    boundary = np.zeros_like(body_mask)
    y0 = max(0, round(top + height * 0.30))
    y1 = min(CELL_H, round(top + height * 0.72))
    for y in range(y0, y1):
        occupied = np.where(body_mask[y])[0]
        if not len(occupied):
            continue
        side = occupied[occupied < center_x] if side_left else occupied[occupied >= center_x]
        if not len(side):
            continue
        edge = int(side.min() if side_left else side.max())
        if side_left:
            boundary[y, max(0, edge - 1) : min(CELL_W, edge + 3)] = True
        else:
            boundary[y, max(0, edge - 2) : min(CELL_W, edge + 2)] = True
    boundary &= dilate(body_mask, 3)

    zone = np.zeros_like(body_mask)
    zone[max(0, y0 - 6) : min(CELL_H, y1 + 7), :] = True
    if side_left:
        zone[:, round(center_x + half_width * 0.08) :] = False
    else:
        zone[:, : round(center_x - half_width * 0.08)] = False

    foot_zone = np.zeros_like(body_mask)
    foot_zone[max(0, round(top + height * 0.78)) :, :] = True
    return SemanticHandMasks(
        zone=zone,
        near_three=dilate(boundary, 7),
        near_seven=dilate(boundary, 15),
        body_near_three=dilate(body_mask, 7),
        body_core=erode(body_mask, 7),
        foot_core=erode(body_mask, 5) & foot_zone,
    )


def semantic_masks(body: Image.Image, slot: str, authored_row: int) -> SemanticMasks:
    hand = strict_hand_masks(body, slot, authored_row)
    body_mask = image_mask(body, BODY_ALPHA)
    _left, top, _right, bottom, center_x, half_width = body_geometry(body)
    height = bottom - top + 1
    near_body = dilate(body_mask, 13)
    head_band = np.zeros_like(body_mask)
    head_band[: min(CELL_H, round(top + height * 0.30)), :] = True
    foot_band = np.zeros_like(body_mask)
    foot_band[max(0, round(top + height * 0.77)) :, :] = True

    x_grid = np.broadcast_to(np.arange(CELL_W), body_mask.shape)
    if expected_left(slot, authored_row):
        side = x_grid <= round(center_x + half_width * 0.08)
        exterior_side = x_grid <= round(center_x - half_width * 0.18)
    else:
        side = x_grid >= round(center_x - half_width * 0.08)
        exterior_side = x_grid >= round(center_x + half_width * 0.18)
    return SemanticMasks(
        hand=hand,
        head_near=near_body & head_band,
        foot_near=near_body & foot_band,
        expected_side=side,
        exterior_side=exterior_side,
    )


def cleaned_profile(frame: Image.Image, minimum_component_area: int = 7) -> Image.Image:
    """Match the layer builder's isolated-sparkle cleanup exactly."""

    source = frame.convert("RGBA")
    alpha = source.getchannel("A")
    alpha_pixels = alpha.load()
    visited = bytearray(CELL_W * CELL_H)
    remove = Image.new("L", (CELL_W, CELL_H), 0)
    remove_pixels = remove.load()
    neighbours = (
        (-1, -1),
        (0, -1),
        (1, -1),
        (-1, 0),
        (1, 0),
        (-1, 1),
        (0, 1),
        (1, 1),
    )
    for y in range(CELL_H):
        for x in range(CELL_W):
            index = y * CELL_W + x
            if visited[index] or alpha_pixels[x, y] <= 10:
                continue
            queue: deque[tuple[int, int]] = deque([(x, y)])
            visited[index] = 1
            component: list[tuple[int, int]] = []
            while queue:
                px, py = queue.popleft()
                component.append((px, py))
                for ox, oy in neighbours:
                    nx, ny = px + ox, py + oy
                    if not (0 <= nx < CELL_W and 0 <= ny < CELL_H):
                        continue
                    neighbour_index = ny * CELL_W + nx
                    if visited[neighbour_index] or alpha_pixels[nx, ny] <= 10:
                        continue
                    visited[neighbour_index] = 1
                    queue.append((nx, ny))
            if len(component) < minimum_component_area:
                for px, py in component:
                    remove_pixels[px, py] = 255
    if remove.getbbox() is None:
        return source
    source.putalpha(ImageChops.subtract(alpha, remove))
    return source


def delta_mask(profile: Image.Image, mannequin: Image.Image) -> Image.Image:
    """Match the source layer builder's smooth fitted/mannequin delta."""

    profile_pixels = profile.load()
    mannequin_pixels = mannequin.load()
    result = Image.new("L", profile.size, 0)
    output = result.load()
    for y in range(CELL_H):
        for x in range(CELL_W):
            pr, pg, pb, pa = profile_pixels[x, y]
            mr, mg, mb, ma = mannequin_pixels[x, y]
            if pa <= 4:
                continue
            if ma <= 8:
                output[x, y] = 255
                continue
            colour_distance = math.sqrt(
                (pr - mr) ** 2 + (pg - mg) ** 2 + (pb - mb) ** 2
            )
            distance = max(colour_distance, abs(pa - ma) * 0.6)
            t = max(0.0, min(1.0, (distance - 12.0) / 42.0))
            t = t * t * (3.0 - 2.0 * t)
            output[x, y] = round(255 * t)
    return result


def registered_delta_alpha(profile: Image.Image, body: Image.Image) -> np.ndarray:
    clean = cleaned_profile(profile)
    alpha = ImageChops.multiply(clean.getchannel("A"), delta_mask(clean, body))
    return np.asarray(alpha, dtype=np.uint8)


def translate_frame(frame: Image.Image, offset_x: int, offset_y: int) -> Image.Image:
    output = Image.new("RGBA", (CELL_W, CELL_H), (0, 0, 0, 0))
    output.alpha_composite(frame, (offset_x, offset_y))
    return output


def translated_array(
    source: np.ndarray,
    offset_x: int,
    offset_y: int,
) -> tuple[np.ndarray, int]:
    height, width = source.shape
    output = np.zeros_like(source)
    source_x0 = max(0, -offset_x)
    source_y0 = max(0, -offset_y)
    source_x1 = min(width, width - offset_x)
    source_y1 = min(height, height - offset_y)
    if source_x0 < source_x1 and source_y0 < source_y1:
        output[
            source_y0 + offset_y : source_y1 + offset_y,
            source_x0 + offset_x : source_x1 + offset_x,
        ] = source[source_y0:source_y1, source_x0:source_x1]
    return output, int(np.count_nonzero(source) - np.count_nonzero(output))


def preliminary_held_layer(
    registered: Image.Image,
    full_delta_alpha: np.ndarray,
    masks: SemanticMasks,
) -> Image.Image:
    visible = full_delta_alpha > VISIBLE_ALPHA
    allowed = (
        visible
        & masks.expected_side
        & (~masks.hand.body_near_three | masks.hand.near_seven)
        & ~masks.hand.body_core
        & ~masks.hand.foot_core
        & ~masks.head_near
        & ~masks.foot_near
    )
    output = registered.copy()
    alpha = full_delta_alpha.copy()
    alpha[~allowed] = 0
    output.putalpha(Image.fromarray(alpha, mode="L"))
    return output


def alignment_score(
    mask: np.ndarray,
    masks: SemanticMasks,
    offset_x: int,
    offset_y: int,
) -> tuple[float, ...]:
    projected, clipped = translated_array(mask, offset_x, offset_y)
    hand_three = int(np.logical_and(projected, masks.hand.near_three).sum())
    hand_seven = int(np.logical_and(projected, masks.hand.near_seven).sum())
    body_core = int(np.logical_and(projected, masks.hand.body_core).sum())
    foot_core = int(np.logical_and(projected, masks.hand.foot_core).sum())
    head_near = int(np.logical_and(projected, masks.head_near).sum())
    foot_near = int(np.logical_and(projected, masks.foot_near).sum())
    exterior = int(
        np.logical_and(
            projected,
            ~masks.hand.body_near_three & masks.exterior_side,
        ).sum()
    )
    deviation = offset_x * offset_x + offset_y * offset_y
    score = (
        hand_three * 30.0
        + hand_seven * 2.0
        + min(exterior, 180) * 0.35
        - body_core * 7.0
        - foot_core * 14.0
        - head_near * 6.0
        - foot_near * 8.0
        - clipped * 10.0
        - deviation * 0.30
    )
    return (
        score,
        hand_three,
        hand_seven,
        -clipped,
        -deviation,
        -abs(offset_y),
        -abs(offset_x),
    )


def locally_align_held(
    frame: Image.Image,
    masks: SemanticMasks,
    residual_x: int,
    residual_y: int,
) -> tuple[Image.Image, dict[str, object]]:
    initial = translate_frame(frame, residual_x, residual_y)
    initial_mask = image_mask(initial, VISIBLE_ALPHA)
    best_offset = (0, 0)
    best_score: tuple[float, ...] | None = None
    for offset_y in range(-10, 11):
        for offset_x in range(-10, 11):
            score = alignment_score(initial_mask, masks, offset_x, offset_y)
            if best_score is None or score > best_score:
                best_score = score
                best_offset = (offset_x, offset_y)
    final = translate_frame(initial, best_offset[0], best_offset[1])
    return final, {
        "residualOffset": [residual_x, residual_y],
        "localOffset": list(best_offset),
        "score": round(float(best_score[0]), 3) if best_score else None,
    }


def connected_components(mask: np.ndarray) -> list[tuple[np.ndarray, np.ndarray]]:
    height, width = mask.shape
    seen = np.zeros_like(mask)
    components: list[tuple[np.ndarray, np.ndarray]] = []
    for start_y, start_x in zip(*np.where(mask)):
        if seen[start_y, start_x]:
            continue
        queue: deque[tuple[int, int]] = deque([(int(start_y), int(start_x))])
        seen[start_y, start_x] = True
        ys: list[int] = []
        xs: list[int] = []
        while queue:
            y, x = queue.popleft()
            ys.append(y)
            xs.append(x)
            for dy in (-1, 0, 1):
                for dx in (-1, 0, 1):
                    if not (dx or dy):
                        continue
                    next_y, next_x = y + dy, x + dx
                    if (
                        0 <= next_y < height
                        and 0 <= next_x < width
                        and mask[next_y, next_x]
                        and not seen[next_y, next_x]
                    ):
                        seen[next_y, next_x] = True
                        queue.append((next_y, next_x))
        components.append(
            (np.asarray(ys, dtype=np.int16), np.asarray(xs, dtype=np.int16))
        )
    return components


def alpha_with_mask(frame: Image.Image, mask: np.ndarray) -> Image.Image:
    alpha = np.asarray(frame.getchannel("A"), dtype=np.uint8).copy()
    alpha[~mask] = 0
    output = frame.copy()
    output.putalpha(Image.fromarray(alpha, mode="L"))
    return output


def semantic_component_filter(
    frame: Image.Image,
    masks: SemanticMasks,
) -> tuple[Image.Image, dict[str, object]]:
    visible = image_mask(frame, VISIBLE_ALPHA)
    allowed = (
        visible
        & masks.expected_side
        & ~masks.hand.body_core
        & ~masks.hand.foot_core
        & ~masks.head_near
        & ~masks.foot_near
    )
    label_mask = dilate(allowed, 7)
    retained = np.zeros_like(allowed)
    component_rows: list[dict[str, int | bool]] = []
    for ys, xs in connected_components(label_mask):
        label = np.zeros_like(allowed)
        label[ys, xs] = True
        original = allowed & label
        original_pixels = int(original.sum())
        if not original_pixels:
            continue
        hand_pixels = int(np.logical_and(original, masks.hand.near_three).sum())
        exterior_pixels = int(
            np.logical_and(
                original,
                ~masks.hand.body_near_three & masks.exterior_side,
            ).sum()
        )
        keep = hand_pixels >= 3 and exterior_pixels >= 8
        component_rows.append(
            {
                "pixels": original_pixels,
                "handPixels": hand_pixels,
                "exteriorPixels": exterior_pixels,
                "kept": keep,
            }
        )
        if keep:
            retained |= original
    return alpha_with_mask(frame, retained), {
        "inputVisiblePixels": int(visible.sum()),
        "retainedVisiblePixels": int(retained.sum()),
        "components": len(component_rows),
        "keptComponents": sum(bool(row["kept"]) for row in component_rows),
        "componentRows": component_rows,
    }


def layer_metrics(
    layer: Image.Image,
    masks: SemanticMasks,
) -> dict[str, object]:
    visible = image_mask(layer, VISIBLE_ALPHA)
    y, x = np.where(visible)
    visible_pixels = len(x)
    hand_contact = int(masks.hand.near_three[y, x].sum()) if visible_pixels else 0
    body_core = int(masks.hand.body_core[y, x].sum()) if visible_pixels else 0
    foot_core = int(masks.hand.foot_core[y, x].sum()) if visible_pixels else 0
    bounds = layer.getchannel("A").getbbox()
    return {
        "visiblePixels": visible_pixels,
        "alphaMass": int(np.asarray(layer.getchannel("A"), dtype=np.uint64).sum()),
        "handContactPixels": hand_contact,
        "bodyCorePixels": body_core,
        "footCorePixels": foot_core,
        "bounds": list(bounds) if bounds else None,
        "empty": bounds is None,
        "paddingTwoPass": has_padding(bounds),
    }


def has_padding(bounds: tuple[int, int, int, int] | None) -> bool:
    return bool(
        bounds
        and bounds[0] >= PADDING
        and bounds[1] >= PADDING
        and bounds[2] <= CELL_W - PADDING
        and bounds[3] <= CELL_H - PADDING
    )


def passes_strict(layer: Image.Image, masks: SemanticMasks) -> bool:
    metrics = layer_metrics(layer, masks)
    return bool(
        not metrics["empty"]
        and int(metrics["handContactPixels"]) >= 3
        and int(metrics["bodyCorePixels"]) == 0
        and int(metrics["footCorePixels"]) == 0
        and bool(metrics["paddingTwoPass"])
    )


def padded_candidate(
    candidate: Image.Image,
    masks: SemanticMasks,
) -> tuple[Image.Image | None, dict[str, object] | None]:
    best: tuple[tuple[int, int, int, int], Image.Image, dict[str, object]] | None = None
    for offset_y in range(-10, 11):
        for offset_x in range(-10, 11):
            translated = translate_frame(candidate, offset_x, offset_y)
            metrics = layer_metrics(translated, masks)
            if (
                bool(metrics["empty"])
                or int(metrics["handContactPixels"]) < 3
                or int(metrics["bodyCorePixels"]) != 0
                or int(metrics["footCorePixels"]) != 0
                or not bool(metrics["paddingTwoPass"])
            ):
                continue
            score = (
                offset_x * offset_x + offset_y * offset_y,
                -int(metrics["handContactPixels"]),
                -int(metrics["visiblePixels"]),
                abs(offset_y) + abs(offset_x),
            )
            if best is None or score < best[0]:
                best = (score, translated, metrics)
    if best is None:
        return None, None
    return best[1], best[2]


def recover_same_row_phase(
    frames: dict[tuple[int, int], Image.Image],
    bodies: dict[tuple[int, int], Image.Image],
    slot: str,
    row: int,
    target_column: int,
) -> tuple[Image.Image, dict[str, object]]:
    """Recover an empty cell without ever crossing the authored direction."""

    target_body = bodies[(row, target_column)]
    target_masks = semantic_masks(target_body, slot, row)
    candidates: list[tuple[int, int, Image.Image, dict[str, object]]] = []
    for source_column in range(COLS):
        if source_column == target_column:
            continue
        source = frames[(row, source_column)]
        if source.getchannel("A").getbbox() is None:
            continue
        cyclic_distance = min(
            (target_column - source_column) % COLS,
            (source_column - target_column) % COLS,
        )
        aligned, _alignment = locally_align_held(source, target_masks, 0, 0)
        filtered, _components = semantic_component_filter(aligned, target_masks)
        padded, metrics = padded_candidate(filtered, target_masks)
        if padded is None or metrics is None:
            continue
        candidates.append((cyclic_distance, source_column, padded, metrics))
    if not candidates:
        raise RuntimeError(f"no same-row held fallback for {slot}@{row},{target_column}")
    distance, source_column, output, metrics = min(
        candidates,
        key=lambda item: (
            item[0],
            -int(item[3]["handContactPixels"]),
            -int(item[3]["visiblePixels"]),
            item[1],
        ),
    )
    return output, {
        "method": "same-row-nearest-gait-phase",
        "sourceRow": row,
        "sourceColumn": source_column,
        "cyclicDistance": distance,
        "metrics": metrics,
    }
