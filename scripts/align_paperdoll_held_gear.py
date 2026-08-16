"""Rigidly register Harin's authored held-item layers to the active v1 hands.

The original ``weapon`` and ``offhand`` atlases were partitioned from ten
fully-equipped source sheets.  Those source avatars do not share the neutral
mannequin's per-frame origin, so otherwise valid swords and shields can float
several pixels away from Harin while walking.  This tool corrects only that
registration error:

* a shared red-hood landmark estimates each source-frame/body translation;
* old fitted-profile alpha identifies the authored grip edge;
* active mannequin alpha provides a side- and anatomy-bounded hand target;
* every variant silhouette receives one integer rigid translation per cell;
* no scaling, rotation, interpolation, repainting, or alpha synthesis occurs.

Tiny/fully occluded authoring fragments are recorded explicitly and are not
forced onto an arbitrary torso pixel.  Every visible source pixel must survive
the translation, and a build fails on clipping, an empty cell, or alpha-mass
change.  Keep the unregistered atlases under
``asset-sources/paperdoll/held-gear-v1/original`` so the production assets can
be rebuilt repeatedly without applying the translation twice.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from collections import deque
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter


CELL_W, CELL_H = 256, 192
ROWS, COLS = 8, 4
ATLAS_SIZE = (CELL_W * COLS, CELL_H * ROWS)
VISIBLE_ALPHA = 8
BODY_ALPHA = 16
HELD_SLOTS = ("weapon", "offhand")
VARIANTS = (
    ("00-iron.png", "harin-equipped-iron-v1.png"),
    ("01-frost.png", "harin-equipped-frost-v2.png"),
    ("02-jade.png", "harin-equipped-jade-v1.png"),
    ("03-blood.png", "harin-equipped-blood-v1.png"),
    ("04-arcane.png", "harin-equipped-arcane-v1.png"),
    ("05-waraxe.png", "harin-equipped-waraxe-v1.png"),
    ("06-celestial.png", "harin-equipped-celestial-v1.png"),
    ("07-void.png", "harin-equipped-void-v1.png"),
    ("08-sealed.png", "harin-equipped-sealed-v1.png"),
    ("09-cosmic.png", "harin-equipped-cosmic-v1.png"),
)


@dataclass(frozen=True)
class Registration:
    offset_x: int
    offset_y: int
    confidence: float
    hood_intersection: int
    method: str


@dataclass(frozen=True)
class HandMasks:
    zone: np.ndarray
    near_three: np.ndarray
    near_seven: np.ndarray
    body_near_three: np.ndarray
    body_core: np.ndarray
    foot_core: np.ndarray


def frame_box(row: int, column: int) -> tuple[int, int, int, int]:
    return (
        column * CELL_W,
        row * CELL_H,
        (column + 1) * CELL_W,
        (row + 1) * CELL_H,
    )


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def alpha_mass(image: Image.Image) -> int:
    return int(np.asarray(image.getchannel("A"), dtype=np.uint64).sum())


def image_mask(image: Image.Image, threshold: int) -> np.ndarray:
    return np.asarray(image.getchannel("A"), dtype=np.uint8) > threshold


def red_hood_mask(frame: Image.Image, zone: np.ndarray) -> np.ndarray:
    pixels = np.asarray(frame, dtype=np.uint8).astype(np.int16)
    red, green, blue, alpha = (pixels[:, :, index] for index in range(4))
    return (
        (alpha > 24)
        & (red > 50)
        & (red > green * 1.25)
        & (red > blue * 1.10)
        & ((red - green) > 18)
        & zone
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
    torso_y, torso_x = np.where(mask[torso_start : torso_end + 1])
    if len(torso_x):
        center_x = float(np.median(torso_x))
    else:
        center_x = (left + right) / 2
    return left, top, right, bottom, center_x, max(1.0, (right - left + 1) / 2)


def overlap_for_translation(
    source: np.ndarray,
    destination: np.ndarray,
    offset_x: int,
    offset_y: int,
) -> int:
    source_y0 = max(0, -offset_y)
    source_y1 = min(CELL_H, CELL_H - offset_y)
    source_x0 = max(0, -offset_x)
    source_x1 = min(CELL_W, CELL_W - offset_x)
    if source_y0 >= source_y1 or source_x0 >= source_x1:
        return 0
    source_window = source[source_y0:source_y1, source_x0:source_x1]
    destination_window = destination[
        source_y0 + offset_y : source_y1 + offset_y,
        source_x0 + offset_x : source_x1 + offset_x,
    ]
    return int(np.logical_and(source_window, destination_window).sum())


def estimate_registration(source_profile: Image.Image, body: Image.Image) -> Registration:
    left, top, right, bottom, _center_x, _half_width = body_geometry(body)
    height = bottom - top + 1
    # The fitted sources all retain Harin's red hood.  Limit the matcher to a
    # generous upper-body window so red armour cannot drag the registration
    # toward a leg or weapon, while still covering the largest source offset.
    hood_zone = np.zeros((CELL_H, CELL_W), dtype=bool)
    hood_zone[
        max(0, top - 18) : min(CELL_H, round(top + height * 0.56)),
        max(0, left - 48) : min(CELL_W, right + 49),
    ] = True
    destination_hood = red_hood_mask(body, hood_zone)
    source_hood = red_hood_mask(source_profile, hood_zone)
    destination_y, destination_x = np.where(destination_hood)
    source_y, source_x = np.where(source_hood)

    if len(source_x) >= 24 and len(destination_x) >= 24:
        initial_x = round(float(np.median(destination_x) - np.median(source_x)))
        initial_y = round(float(np.median(destination_y) - np.median(source_y)))
        best: tuple[int, int, int, int] | None = None
        for offset_y in range(initial_y - 10, initial_y + 11):
            for offset_x in range(initial_x - 10, initial_x + 11):
                intersection = overlap_for_translation(
                    source_hood,
                    destination_hood,
                    offset_x,
                    offset_y,
                )
                deviation = (offset_x - initial_x) ** 2 + (offset_y - initial_y) ** 2
                candidate = (intersection, -deviation, offset_x, offset_y)
                if best is None or candidate > best:
                    best = candidate
        assert best is not None
        confidence = best[0] / max(1, min(len(source_x), len(destination_x)))
        if confidence >= 0.22:
            return Registration(
                offset_x=best[2],
                offset_y=best[3],
                confidence=float(confidence),
                hood_intersection=best[0],
                method="shared-red-hood",
            )

    # Defensive fallback for any future material variant that completely hides
    # the hood: register the upper-body alpha medians.  The low-confidence flag
    # also limits the later hand refinement radius.
    body_mask = image_mask(body, BODY_ALPHA)
    source_mask = image_mask(source_profile, BODY_ALPHA)
    upper_zone = hood_zone.copy()
    destination_y, destination_x = np.where(body_mask & upper_zone)
    source_y, source_x = np.where(source_mask & upper_zone)
    if not len(source_x) or not len(destination_x):
        return Registration(0, 0, 0.0, 0, "unresolved")
    return Registration(
        offset_x=round(float(np.median(destination_x) - np.median(source_x))),
        offset_y=round(float(np.median(destination_y) - np.median(source_y))),
        confidence=0.0,
        hood_intersection=0,
        method="upper-alpha-fallback",
    )


def weapon_is_left(authored_row: int) -> bool:
    # Authored rows: S, SE, E, NW, N, NE, W, SW.
    return authored_row in (0, 1, 2, 6, 7)


def expected_left(slot: str, authored_row: int) -> bool:
    return weapon_is_left(authored_row) if slot == "weapon" else not weapon_is_left(authored_row)


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


def hand_masks(body: Image.Image, slot: str, authored_row: int) -> HandMasks:
    body_mask = image_mask(body, BODY_ALPHA)
    left, top, right, bottom, center_x, half_width = body_geometry(body)
    height = bottom - top + 1
    zone = np.zeros_like(body_mask)
    zone[
        max(0, round(top + height * 0.27)) : min(CELL_H, round(top + height * 0.78)),
        :,
    ] = True
    if expected_left(slot, authored_row):
        zone[:, round(center_x - half_width * 0.05) :] = False
    else:
        zone[:, : round(center_x + half_width * 0.05)] = False
    hand_body = body_mask & zone
    foot_zone = np.zeros_like(body_mask)
    foot_zone[max(0, round(top + height * 0.78)) :, :] = True
    return HandMasks(
        zone=zone,
        near_three=dilate(hand_body, 7),
        near_seven=dilate(hand_body, 15),
        body_near_three=dilate(body_mask, 7),
        body_core=erode(body_mask, 7),
        foot_core=erode(body_mask, 5) & foot_zone,
    )


def safe_offset_range(frame: Image.Image, margin: int = 2) -> tuple[int, int, int, int]:
    bounds = frame.getchannel("A").getbbox()
    if bounds is None:
        raise ValueError("held layer frame is empty")
    left, top, right, bottom = bounds
    return (
        margin - left,
        CELL_W - margin - right,
        margin - top,
        CELL_H - margin - bottom,
    )


def clamp(value: int, minimum: int, maximum: int) -> int:
    return max(minimum, min(maximum, value))


def projected_values(mask: np.ndarray, x: np.ndarray, y: np.ndarray) -> int:
    valid = (x >= 0) & (x < CELL_W) & (y >= 0) & (y < CELL_H)
    if not np.any(valid):
        return 0
    return int(mask[y[valid], x[valid]].sum())


def source_grip_points(
    layer: Image.Image,
    source_profile: Image.Image,
    masks: HandMasks,
    base_x: int,
    base_y: int,
) -> tuple[np.ndarray, np.ndarray, str]:
    layer_mask = image_mask(layer, VISIBLE_ALPHA)
    profile_mask = image_mask(source_profile, BODY_ALPHA)
    # Pixels in the fitted profile but outside this slot form the old avatar
    # and neighbouring equipment.  Their boundary is the authored grip edge.
    source_residual = profile_mask & ~layer_mask
    near_residual = dilate(source_residual, 7)
    grip = layer_mask & near_residual
    y, x = np.where(grip)
    if len(x):
        projected_x = x + base_x
        projected_y = y + base_y
        valid = (
            (projected_x >= 0)
            & (projected_x < CELL_W)
            & (projected_y >= 0)
            & (projected_y < CELL_H)
        )
        valid_indices = np.where(valid)[0]
        if len(valid_indices):
            in_zone = masks.zone[projected_y[valid], projected_x[valid]]
            selected = valid_indices[in_zone]
            if len(selected) >= 3:
                return x[selected], y[selected], "source-profile-contact"

    # If the partition hid the exact grip pixels, retain only silhouette pixels
    # that the source registration already predicts near the correct hand.
    y, x = np.where(layer_mask)
    projected_x = x + base_x
    projected_y = y + base_y
    valid = (
        (projected_x >= 0)
        & (projected_x < CELL_W)
        & (projected_y >= 0)
        & (projected_y < CELL_H)
    )
    valid_indices = np.where(valid)[0]
    if len(valid_indices):
        near_hand = masks.near_seven[projected_y[valid], projected_x[valid]]
        selected = valid_indices[near_hand]
        if len(selected) >= 3:
            return x[selected], y[selected], "registered-near-hand"
    return np.empty(0, dtype=int), np.empty(0, dtype=int), "hidden-grip"


def translate_frame(frame: Image.Image, offset_x: int, offset_y: int) -> Image.Image:
    output = Image.new("RGBA", (CELL_W, CELL_H), (0, 0, 0, 0))
    output.alpha_composite(frame, (offset_x, offset_y))
    return output


def largest_component_geometry(mask: np.ndarray) -> tuple[int, int, int, int]:
    """Return count/width/height/component-count for 8-connected alpha."""

    seen = np.zeros(mask.shape, dtype=bool)
    largest_count = largest_width = largest_height = component_count = 0
    for start_y, start_x in zip(*np.where(mask)):
        if seen[start_y, start_x]:
            continue
        component_count += 1
        queue: deque[tuple[int, int]] = deque([(int(start_y), int(start_x))])
        seen[start_y, start_x] = True
        count = 0
        minimum_x = minimum_y = 1_000
        maximum_x = maximum_y = -1
        while queue:
            y, x = queue.popleft()
            count += 1
            minimum_x, maximum_x = min(minimum_x, x), max(maximum_x, x)
            minimum_y, maximum_y = min(minimum_y, y), max(maximum_y, y)
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
        if count > largest_count:
            largest_count = count
            largest_width = maximum_x - minimum_x + 1
            largest_height = maximum_y - minimum_y + 1
    return largest_count, largest_width, largest_height, component_count


def align_frame(
    layer: Image.Image,
    source_profile: Image.Image,
    body: Image.Image,
    slot: str,
    authored_row: int,
    registration: Registration,
    resolved_hand_masks: HandMasks | None = None,
) -> tuple[Image.Image, dict[str, object]]:
    source_mass = alpha_mass(layer)
    layer_mask = image_mask(layer, VISIBLE_ALPHA)
    layer_y, layer_x = np.where(layer_mask)
    visible_pixels = len(layer_x)
    (
        largest_component_pixels,
        largest_component_width,
        largest_component_height,
        component_count,
    ) = largest_component_geometry(layer_mask)
    tiny_fragment = visible_pixels < 48
    compact_fragment = (
        visible_pixels < 200
        and largest_component_width < 10
        and largest_component_height < 20
    )
    minimum_x, maximum_x, minimum_y, maximum_y = safe_offset_range(layer)
    base_x = clamp(registration.offset_x, minimum_x, maximum_x)
    base_y = clamp(registration.offset_y, minimum_y, maximum_y)
    base_clamped = (base_x, base_y) != (registration.offset_x, registration.offset_y)
    masks = resolved_hand_masks or hand_masks(body, slot, authored_row)
    preliminary_body_contact = projected_values(
        masks.body_near_three,
        layer_x + base_x,
        layer_y + base_y,
    )
    preliminary_foot_core = projected_values(
        masks.foot_core,
        layer_x + base_x,
        layer_y + base_y,
    )
    preliminary_outside_ratio = 1.0 - preliminary_body_contact / max(1, visible_pixels)
    preliminary_foot_ratio = preliminary_foot_core / max(1, visible_pixels)
    lower_body_overlay = (
        visible_pixels < 640
        and preliminary_outside_ratio < 0.24
        and preliminary_foot_ratio > 0.28
    )
    # Sparse authoring residue does not expose a reliable hilt.  Preserve it
    # byte-for-byte in place instead of making a decorative spark chase a hand
    # or foot contour.
    if tiny_fragment or compact_fragment or lower_body_overlay:
        base_x = base_y = 0
    grip_x, grip_y, grip_method = source_grip_points(
        layer,
        source_profile,
        masks,
        base_x,
        base_y,
    )
    # Deterministic sampling keeps dense shield boundaries fast without
    # changing their spatial extent or the output pixels.
    if len(grip_x) > 640:
        stride = max(1, len(grip_x) // 640)
        grip_x = grip_x[::stride]
        grip_y = grip_y[::stride]

    base_contact_three = projected_values(
        masks.near_three,
        grip_x + base_x,
        grip_y + base_y,
    )
    source_contact_three = projected_values(
        masks.near_three,
        grip_x,
        grip_y,
    )
    refinement_radius = 8 if registration.confidence >= 0.22 else 4
    final_x, final_y = base_x, base_y
    best_score = float("-inf")
    best_contact_three = base_contact_three
    best_contact_seven = projected_values(
        masks.near_seven,
        grip_x + base_x,
        grip_y + base_y,
    )

    # A sub-48-pixel fragment is normally an occluded hilt sparkle.  Preserve
    # source registration, but do not invent a visible hand contact for it.
    can_refine = (
        not tiny_fragment
        and not compact_fragment
        and not lower_body_overlay
        and len(grip_x) >= 3
    )
    if can_refine:
        for candidate_y in range(
            max(minimum_y, base_y - refinement_radius),
            min(maximum_y, base_y + refinement_radius) + 1,
        ):
            target_grip_y = grip_y + candidate_y
            for candidate_x in range(
                max(minimum_x, base_x - refinement_radius),
                min(maximum_x, base_x + refinement_radius) + 1,
            ):
                target_grip_x = grip_x + candidate_x
                contact_three = projected_values(
                    masks.near_three,
                    target_grip_x,
                    target_grip_y,
                )
                contact_seven = projected_values(
                    masks.near_seven,
                    target_grip_x,
                    target_grip_y,
                )
                target_layer_x = layer_x + candidate_x
                target_layer_y = layer_y + candidate_y
                deep_body = projected_values(
                    masks.body_core,
                    target_layer_x,
                    target_layer_y,
                )
                deviation = (candidate_x - base_x) ** 2 + (candidate_y - base_y) ** 2
                score = (
                    contact_three * 12.0
                    + contact_seven * 2.0
                    - deep_body * 0.18
                    - deviation * 0.90
                )
                candidate = (
                    score,
                    contact_three,
                    contact_seven,
                    -deviation,
                    -deep_body,
                    candidate_x,
                    candidate_y,
                )
                best = (
                    best_score,
                    best_contact_three,
                    best_contact_seven,
                    -((final_x - base_x) ** 2 + (final_y - base_y) ** 2),
                    0,
                    final_x,
                    final_y,
                )
                if candidate > best:
                    (
                        best_score,
                        best_contact_three,
                        best_contact_seven,
                        _negative_deviation,
                        _negative_deep,
                        final_x,
                        final_y,
                    ) = candidate

    aligned = translate_frame(layer, final_x, final_y)
    output_mass = alpha_mass(aligned)
    output_bounds = aligned.getchannel("A").getbbox()
    clipped = output_mass != source_mass
    if output_bounds is None:
        raise ValueError("rigid alignment produced an empty held layer")
    if clipped:
        raise ValueError(f"rigid alignment changed alpha mass {source_mass}->{output_mass}")

    target_layer_x = layer_x + final_x
    target_layer_y = layer_y + final_y
    body_contact = projected_values(
        masks.body_near_three,
        target_layer_x,
        target_layer_y,
    )
    hand_contact = projected_values(
        masks.near_three,
        target_layer_x,
        target_layer_y,
    )
    body_core = projected_values(masks.body_core, target_layer_x, target_layer_y)
    foot_core = projected_values(masks.foot_core, target_layer_x, target_layer_y)
    outside_ratio = 1.0 - body_contact / max(1, visible_pixels)

    if tiny_fragment:
        classification = "occluded-tiny-fragment"
    elif compact_fragment:
        classification = "occluded-compact-fragment"
    elif lower_body_overlay:
        classification = "occluded-body-overlay"
    elif len(grip_x) < 3 and outside_ratio < 0.24:
        classification = "occluded-body-overlay"
    elif len(grip_x) < 3:
        classification = "occluded-hidden-grip"
    elif best_contact_three < 3 and outside_ratio < 0.24:
        classification = "occluded-body-overlay"
    elif best_contact_three < 3 and grip_method == "source-profile-contact":
        # The partition retained a visible blade/shield fragment but assigned
        # its actual hilt/hand bridge to another wearable layer.  Moving that
        # fragment until it touches an arbitrary body pixel would be the very
        # false-positive correction this pipeline is designed to avoid.
        classification = "occluded-authored-grip"
    elif best_contact_three < 3:
        classification = "unresolved-visible"
    else:
        classification = "aligned-visible"

    return aligned, {
        "registration": {
            "method": registration.method,
            "confidence": round(registration.confidence, 6),
            "hoodIntersection": registration.hood_intersection,
            "requestedOffset": [registration.offset_x, registration.offset_y],
            "baseOffset": [base_x, base_y],
            "baseClampedForCell": base_clamped,
            "translationSuppressedAsFragment": (
                tiny_fragment or compact_fragment or lower_body_overlay
            ),
            "preliminaryOutsideBodyRatio": round(preliminary_outside_ratio, 6),
            "preliminaryFootCoreRatio": round(preliminary_foot_ratio, 6),
        },
        "gripMethod": grip_method,
        "gripSamplePixels": len(grip_x),
        "gripContactPixelsBefore": source_contact_three,
        "gripContactPixelsAfterBodyRegistration": base_contact_three,
        "refinementOffset": [final_x - base_x, final_y - base_y],
        "finalOffset": [final_x, final_y],
        "classification": classification,
        "visiblePixels": visible_pixels,
        "components": component_count,
        "largestComponentPixels": largest_component_pixels,
        "largestComponentBounds": [largest_component_width, largest_component_height],
        "alphaMassBefore": source_mass,
        "alphaMassAfter": output_mass,
        "alphaMassPreserved": source_mass == output_mass,
        "handContactPixels": hand_contact,
        "gripContactPixels": best_contact_three,
        "bodyNearPixels": body_contact,
        "bodyCorePixels": body_core,
        "footCorePixels": foot_core,
        "outsideBodyRatio": round(outside_ratio, 6),
        "bounds": list(output_bounds),
        "clipped": clipped,
    }


def composite_frame(
    body: Image.Image,
    weapon: Image.Image,
    offhand: Image.Image,
) -> Image.Image:
    output = Image.new("RGBA", (CELL_W, CELL_H), (0, 0, 0, 0))
    output.alpha_composite(offhand)
    output.alpha_composite(body)
    output.alpha_composite(weapon)
    return output


def render_preview(
    body_atlas: Image.Image,
    before: dict[tuple[str, str], Image.Image],
    after: dict[tuple[str, str], Image.Image],
    output_path: Path,
) -> None:
    # Ten variants x eight directions.  Each tile shows all four gait phases:
    # source on the upper row, aligned result on the lower row.
    scale = 0.25
    mini_w, mini_h = round(CELL_W * scale), round(CELL_H * scale)
    label_h = 16
    tile_w = mini_w * COLS
    tile_h = label_h + mini_h * 2
    sheet = Image.new("RGBA", (tile_w * ROWS, tile_h * len(VARIANTS)), (8, 9, 12, 255))
    draw = ImageDraw.Draw(sheet)
    for variant_index, (atlas_name, _profile_name) in enumerate(VARIANTS):
        for row in range(ROWS):
            tile_x = row * tile_w
            tile_y = variant_index * tile_h
            draw.rectangle(
                (tile_x, tile_y, tile_x + tile_w - 1, tile_y + tile_h - 1),
                outline=(64, 57, 45, 255),
            )
            draw.text(
                (tile_x + 3, tile_y + 2),
                f"{atlas_name[3:-4]}  row {row}  B / A",
                fill=(229, 213, 175, 255),
            )
            for column in range(COLS):
                box = frame_box(row, column)
                body_frame = body_atlas.crop(box)
                before_frame = composite_frame(
                    body_frame,
                    before[("weapon", atlas_name)].crop(box),
                    before[("offhand", atlas_name)].crop(box),
                )
                after_frame = composite_frame(
                    body_frame,
                    after[("weapon", atlas_name)].crop(box),
                    after[("offhand", atlas_name)].crop(box),
                )
                before_frame = before_frame.resize((mini_w, mini_h), Image.Resampling.NEAREST)
                after_frame = after_frame.resize((mini_w, mini_h), Image.Resampling.NEAREST)
                sheet.alpha_composite(
                    before_frame,
                    (tile_x + column * mini_w, tile_y + label_h),
                )
                sheet.alpha_composite(
                    after_frame,
                    (tile_x + column * mini_w, tile_y + label_h + mini_h),
                )
    output_path.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(output_path, optimize=True)


def build(
    workspace: Path,
    input_layers: Path,
    output_layers: Path,
    report_path: Path,
    preview_path: Path,
) -> dict[str, object]:
    body_path = workspace / "public/assets/walk/harin-mannequin-v1.png"
    walk_root = workspace / "public/assets/walk"
    body_atlas = Image.open(body_path).convert("RGBA")
    if body_atlas.size != ATLAS_SIZE:
        raise ValueError(f"body atlas has invalid size {body_atlas.size}")

    input_atlases: dict[tuple[str, str], Image.Image] = {}
    output_atlases: dict[tuple[str, str], Image.Image] = {}
    input_records: dict[str, dict[str, object]] = {}
    source_records: dict[str, dict[str, object]] = {}
    cells: list[dict[str, object]] = []
    hand_mask_cache = {
        (slot, row, column): hand_masks(
            body_atlas.crop(frame_box(row, column)),
            slot,
            row,
        )
        for slot in HELD_SLOTS
        for row in range(ROWS)
        for column in range(COLS)
    }

    for atlas_name, profile_name in VARIANTS:
        profile_path = walk_root / profile_name
        source_records[profile_name] = {
            "path": str(profile_path.relative_to(workspace)).replace("\\", "/"),
            "sha256": sha256(profile_path),
        }
        profile_atlas = Image.open(profile_path).convert("RGBA")
        if profile_atlas.size != ATLAS_SIZE:
            raise ValueError(f"source profile has invalid size: {profile_path}")
        registrations = {
            (row, column): estimate_registration(
                profile_atlas.crop(frame_box(row, column)),
                body_atlas.crop(frame_box(row, column)),
            )
            for row in range(ROWS)
            for column in range(COLS)
        }
        for slot in HELD_SLOTS:
            input_path = input_layers / slot / atlas_name
            atlas = Image.open(input_path).convert("RGBA")
            if atlas.size != ATLAS_SIZE:
                raise ValueError(f"held atlas has invalid size: {input_path}")
            input_atlases[(slot, atlas_name)] = atlas
            input_records[f"{slot}/{atlas_name}"] = {
                "path": str(input_path.relative_to(workspace)).replace("\\", "/")
                if input_path.is_relative_to(workspace)
                else str(input_path),
                "sha256": sha256(input_path),
            }
            aligned_atlas = Image.new("RGBA", ATLAS_SIZE, (0, 0, 0, 0))
            for row in range(ROWS):
                for column in range(COLS):
                    box = frame_box(row, column)
                    source_frame = atlas.crop(box)
                    source_profile = profile_atlas.crop(box)
                    body_frame = body_atlas.crop(box)
                    aligned_frame, metrics = align_frame(
                        source_frame,
                        source_profile,
                        body_frame,
                        slot,
                        row,
                        registrations[(row, column)],
                        hand_mask_cache[(slot, row, column)],
                    )
                    aligned_atlas.alpha_composite(
                        aligned_frame,
                        (column * CELL_W, row * CELL_H),
                    )
                    cells.append(
                        {
                            "cell": f"{slot}/{atlas_name}@{row},{column}",
                            "slot": slot,
                            "variant": atlas_name[3:-4],
                            "row": row,
                            "column": column,
                            **metrics,
                        }
                    )
            output_atlases[(slot, atlas_name)] = aligned_atlas

    output_records: dict[str, dict[str, object]] = {}
    for (slot, atlas_name), atlas in output_atlases.items():
        output_path = output_layers / slot / atlas_name
        output_path.parent.mkdir(parents=True, exist_ok=True)
        atlas.save(output_path, optimize=True)
        output_records[f"{slot}/{atlas_name}"] = {
            "path": str(output_path.relative_to(workspace)).replace("\\", "/")
            if output_path.is_relative_to(workspace)
            else str(output_path),
            "sha256": sha256(output_path),
        }

    render_preview(
        body_atlas,
        input_atlases,
        output_atlases,
        preview_path,
    )
    classifications: dict[str, int] = {}
    for cell in cells:
        classification = str(cell["classification"])
        classifications[classification] = classifications.get(classification, 0) + 1
    report: dict[str, object] = {
        "schemaVersion": 1,
        "generator": "scripts/align_paperdoll_held_gear.py",
        "contract": "integer-rigid-translate-only",
        "body": {
            "path": str(body_path.relative_to(workspace)).replace("\\", "/"),
            "sha256": sha256(body_path),
        },
        "sourceProfiles": source_records,
        "inputs": input_records,
        "outputs": output_records,
        "preview": str(preview_path.relative_to(workspace)).replace("\\", "/")
        if preview_path.is_relative_to(workspace)
        else str(preview_path),
        "summary": {
            "cells": len(cells),
            "atlases": len(output_atlases),
            "classifications": classifications,
            "translatedCells": sum(
                1 for cell in cells if cell["finalOffset"] != [0, 0]
            ),
            "refinedCells": sum(
                1 for cell in cells if cell["refinementOffset"] != [0, 0]
            ),
            "alphaMassPreservedCells": sum(
                1 for cell in cells if cell["alphaMassPreserved"]
            ),
            "emptyCells": sum(1 for cell in cells if int(cell["visiblePixels"]) == 0),
            "clippedCells": sum(1 for cell in cells if cell["clipped"]),
            "bodyCorePixels": sum(int(cell["bodyCorePixels"]) for cell in cells),
            "footCorePixels": sum(int(cell["footCorePixels"]) for cell in cells),
        },
        "perCell": cells,
    }
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    summary = report["summary"]
    assert isinstance(summary, dict)
    if summary["emptyCells"] or summary["clippedCells"]:
        raise ValueError(f"held alignment integrity failed: {summary}")
    if summary["alphaMassPreservedCells"] != len(cells):
        raise ValueError(f"held alignment changed alpha mass: {summary}")
    return report


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--workspace",
        type=Path,
        default=Path(__file__).resolve().parents[1],
    )
    parser.add_argument(
        "--input-layers",
        type=Path,
        help="Unregistered weapon/offhand root. Defaults to the preserved source root.",
    )
    parser.add_argument(
        "--output-layers",
        type=Path,
        help="Aligned weapon/offhand root. Defaults to active public v1 assets.",
    )
    parser.add_argument("--report", type=Path)
    parser.add_argument("--preview", type=Path)
    args = parser.parse_args()
    workspace = args.workspace.resolve()
    source_root = (
        args.input_layers.resolve()
        if args.input_layers
        else workspace / "asset-sources/paperdoll/held-gear-v1/original"
    )
    output_root = (
        args.output_layers.resolve()
        if args.output_layers
        else workspace / "public/assets/paperdoll/v1"
    )
    report_path = (
        args.report.resolve()
        if args.report
        else workspace / "asset-sources/paperdoll/held-gear-v1/alignment-report.json"
    )
    preview_path = (
        args.preview.resolve()
        if args.preview
        else workspace / "asset-sources/paperdoll/held-gear-v1/alignment-preview.png"
    )
    report = build(
        workspace,
        source_root,
        output_root,
        report_path,
        preview_path,
    )
    print(json.dumps(report["summary"], ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
