"""Build Harin's registered 4x8 wearable-layer atlases.

The ten fitted outfit sheets are *authoring references*, never runtime outfit
choices.  For every frame this tool extracts the visual delta from the neutral
mannequin, assigns that delta to a curved anatomical region, and writes ten
transparent, same-coordinate atlases.  A full outfit can consequently be
reconstructed, while arbitrary slot mixing does not inherit rectangular bands
of another outfit's base clothing.

Important properties of the generated assets:

* every atlas is 1024x1536 (4 gait phases x 8 directions);
* pixels close to the neutral mannequin are suppressed rather than copied;
* ownership boundaries follow head/shoulder/arm/waist/leg curves;
* the owning layer has full coverage, while neighbouring layers receive a
  narrow alpha fringe.  This preserves a same-family outfit and feathers mixed
  families without exposing a transparent seam;
* detached AI-generation specks are removed before partitioning.

Future hand-painted layers can replace any one output PNG without changing the
runtime contract or save data.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
from collections import deque
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from PIL import Image, ImageChops, ImageFilter

from align_paperdoll_held_gear import (
    build as align_held_gear_assets,
    clamp as clamp_registration,
    estimate_registration,
    safe_offset_range,
    translate_frame as translate_registered_frame,
)
import paperdoll_semantic_held as semantic_held
import audit_paperdoll_slot_regions as slot_region_audit


CELL_WIDTH = 256
CELL_HEIGHT = 192
COLUMNS = 4
ROWS = 8
ATLAS_SIZE = (CELL_WIDTH * COLUMNS, CELL_HEIGHT * ROWS)
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
VARIANTS = (
    ("iron", "harin-equipped-iron-v1.png"),
    ("frost", "harin-equipped-frost-v2.png"),
    ("jade", "harin-equipped-jade-v1.png"),
    ("blood", "harin-equipped-blood-v1.png"),
    ("arcane", "harin-equipped-arcane-v1.png"),
    ("waraxe", "harin-equipped-waraxe-v1.png"),
    ("celestial", "harin-equipped-celestial-v1.png"),
    ("void", "harin-equipped-void-v1.png"),
    ("sealed", "harin-equipped-sealed-v1.png"),
    ("cosmic", "harin-equipped-cosmic-v1.png"),
)


@dataclass(frozen=True)
class BodyGeometry:
    center_x: float
    top: int
    bottom: int
    half_width: float

    @property
    def height(self) -> float:
        return max(1.0, self.bottom - self.top)


def alpha_geometry(alpha: Image.Image) -> BodyGeometry:
    bounds = alpha.getbbox()
    if bounds is None:
        raise ValueError("empty mannequin frame")
    left, top, right, bottom = bounds
    torso_top = top + round((bottom - top) * 0.18)
    torso_bottom = top + round((bottom - top) * 0.68)
    centers: list[int] = []
    pixels = alpha.load()
    for y in range(torso_top, max(torso_top + 1, torso_bottom)):
        occupied = [x for x in range(alpha.width) if pixels[x, y] > 20]
        if occupied:
            centers.append((occupied[0] + occupied[-1]) // 2)
    center_x = sorted(centers)[len(centers) // 2] if centers else (left + right) / 2
    return BodyGeometry(
        center_x=float(center_x),
        top=top,
        bottom=bottom,
        half_width=max(12.0, (right - left) * 0.5),
    )


def weapon_is_left(authored_row: int) -> bool:
    # Authored rows: S, SE, E, NW, N, NE, W, SW.
    # The fitted source atlases put the weapon on screen-left only for S, SE,
    # and W.  E and SW were previously reversed, which classified boots and
    # lower-leg pixels as a weapon while the real blade migrated to offhand.
    return authored_row in (0, 1, 6)


def frame_box(row: int, column: int) -> tuple[int, int, int, int]:
    return (
        column * CELL_WIDTH,
        row * CELL_HEIGHT,
        (column + 1) * CELL_WIDTH,
        (row + 1) * CELL_HEIGHT,
    )


def alpha_mass(image: Image.Image) -> int:
    return sum(image.getchannel("A").get_flattened_data())


def translated_mask(mask: Image.Image, offset_x: int, offset_y: int) -> Image.Image:
    """Translate without ImageChops.offset's wrap-around behaviour."""

    translated = Image.new("L", mask.size, 0)
    translated.paste(mask, (offset_x, offset_y))
    return translated


def semantic_preservation_mask(
    slot: str,
    profile: Image.Image,
    mannequin: Image.Image,
    authored_row: int,
    gait_column: int,
) -> Image.Image:
    """Recover a slot directly from the current fitted frame.

    This deliberately samples real fitted pixels only.  It is a wider prior
    than the normal ownership mask, but remains curved/anatomical; it never
    inserts a marker pixel merely to satisfy an integrity check.
    """

    profile_alpha = profile.getchannel("A")
    mannequin_alpha = mannequin.getchannel("A")
    geometry = alpha_geometry(mannequin_alpha)
    body = mannequin_alpha.filter(ImageFilter.MaxFilter(7))
    current_delta = delta_mask(profile, mannequin)
    output = Image.new("L", profile.size, 0)
    op = output.load()
    pa = profile_alpha.load()
    ba = body.load()
    da = current_delta.load()
    phase = authored_row * 0.79 + gait_column * 1.37

    for y in range(CELL_HEIGHT):
        for x in range(CELL_WIDTH):
            if pa[x, y] <= 4:
                continue
            ry = (y - geometry.top) / geometry.height
            rx = (x - geometry.center_x) / geometry.half_width
            ax = abs(rx)
            strength = da[x, y]
            selected = False
            if slot in ("weapon", "offhand"):
                pixel_is_left = x < geometry.center_x
                expected_left = weapon_is_left(authored_row)
                if slot == "offhand":
                    expected_left = not expected_left
                # Preserve exterior held silhouettes and their grip.  A thin
                # connection into the hand is intentional and prevents an
                # otherwise correct sword from becoming a floating blade.
                selected = (
                    pixel_is_left == expected_left
                    and 0.15 <= ry <= 1.01
                    and ax >= 0.25
                    and (ba[x, y] <= 12 or ax >= 0.52)
                    and strength >= 6
                )
            elif slot == "belt":
                waist = 0.588 + 0.030 * min(1.0, rx * rx) + 0.009 * math.sin(x * 0.19 + phase)
                selected = ax <= 0.78 and abs(ry - waist) <= 0.052 and strength >= 5
            elif slot == "relic":
                selected = (
                    (rx / 0.27) ** 2 + ((ry - 0.425) / 0.145) ** 2 <= 1.0
                    and strength >= 7
                )
            else:
                # General safety path for any future fitted source whose
                # subtle material falls just under the normal delta threshold.
                selected = (
                    anatomical_owner(
                        x,
                        y,
                        geometry,
                        ba[x, y],
                        authored_row,
                        gait_column,
                        profile.getpixel((x, y))[:3],
                        strength,
                    )
                    == slot
                    and strength >= 4
                )
            if selected:
                op[x, y] = max(16, strength)

    # Soften only the outer two pixels; the fitted alpha supplies the true
    # silhouette.  The hard core remains fully represented.
    blurred = output.filter(ImageFilter.GaussianBlur(1.1)).point(lambda value: round(value * 0.52))
    return ImageChops.lighter(output, blurred)


def nearest_visible_frame(
    atlas: Image.Image,
    row: int,
    column: int,
) -> tuple[int, int, Image.Image] | None:
    """Find real authored layer art, preferring the same direction's gait."""

    candidates: list[tuple[int, int, int]] = []
    for other_row in range(ROWS):
        for other_column in range(COLUMNS):
            candidate = atlas.crop(frame_box(other_row, other_column))
            if candidate.getchannel("A").getbbox() is None:
                continue
            direction_penalty = 0 if other_row == row else 100 + min(
                (other_row - row) % ROWS,
                (row - other_row) % ROWS,
            ) * 12
            phase_penalty = abs(other_column - column)
            candidates.append((direction_penalty + phase_penalty, other_row, other_column))
    if not candidates:
        return None
    _, source_row, source_column = min(candidates)
    return source_row, source_column, atlas.crop(frame_box(source_row, source_column))


def preserve_slot_frames(
    atlases: dict[str, Image.Image],
    profile_atlas: Image.Image,
    mannequin_atlas: Image.Image,
) -> list[dict[str, object]]:
    """Guarantee visible authored art for every slot/gait cell.

    First recover from the *current* fitted source.  If the item is fully
    occluded in that exact gait pose, track the nearest real slot frame and use
    its registered mask as a prior over current fitted pixels.  Only as a final
    occlusion fallback is the nearest same-family layer translated to the
    current body anchor.  No synthetic pixels are introduced.
    """

    repairs: list[dict[str, object]] = []
    minimum_mass = 320
    for slot in SLOTS:
        atlas = atlases[slot]
        # Iterate until stable because a repaired same-direction gait frame is
        # a valid spatial prior for the next occluded frame.
        for _pass in range(2):
            for row in range(ROWS):
                for column in range(COLUMNS):
                    box = frame_box(row, column)
                    current = atlas.crop(box)
                    if current.getchannel("A").getbbox() is not None and alpha_mass(current) >= minimum_mass:
                        continue
                    profile = cleaned_profile(profile_atlas.crop(box))
                    mannequin = mannequin_atlas.crop(box)
                    preservation = semantic_preservation_mask(
                        slot,
                        profile,
                        mannequin,
                        row,
                        column,
                    )
                    candidate = profile.copy()
                    candidate.putalpha(
                        ImageChops.multiply(profile.getchannel("A"), preservation)
                    )
                    method = "current-fitted-semantic"

                    if alpha_mass(candidate) < minimum_mass:
                        nearest = nearest_visible_frame(atlas, row, column)
                        if nearest is not None:
                            source_row, source_column, source_layer = nearest
                            source_mannequin = mannequin_atlas.crop(frame_box(source_row, source_column))
                            source_geometry = alpha_geometry(source_mannequin.getchannel("A"))
                            target_geometry = alpha_geometry(mannequin.getchannel("A"))
                            offset_x = round(target_geometry.center_x - source_geometry.center_x)
                            offset_y = round(target_geometry.top - source_geometry.top)
                            prior = translated_mask(
                                source_layer.getchannel("A"),
                                offset_x,
                                offset_y,
                            ).filter(ImageFilter.MaxFilter(17))
                            current_delta = delta_mask(profile, mannequin)
                            tracked_alpha = ImageChops.multiply(
                                profile.getchannel("A"),
                                ImageChops.multiply(current_delta, prior),
                            )
                            tracked = profile.copy()
                            tracked.putalpha(tracked_alpha)
                            if alpha_mass(tracked) >= minimum_mass:
                                candidate = tracked
                                method = "current-fitted-tracked"
                            else:
                                # The fitted frame fully hides the slot.  Keep
                                # the actual item art from the closest authored
                                # gait pose registered to this frame's body.
                                translated = Image.new("RGBA", profile.size, (0, 0, 0, 0))
                                translated.alpha_composite(source_layer, (offset_x, offset_y))
                                candidate = translated
                                method = "nearest-authored-occlusion"

                    if candidate.getchannel("A").getbbox() is None:
                        continue
                    atlas.alpha_composite(candidate, (box[0], box[1]))
                    repairs.append(
                        {
                            "slot": slot,
                            "row": row,
                            "column": column,
                            "method": method,
                            "alpha_mass": alpha_mass(candidate),
                        }
                    )
    return repairs


def cleaned_profile(frame: Image.Image, minimum_component_area: int = 7) -> Image.Image:
    """Drop isolated sparkle/crop fragments while retaining equipment detail."""

    source = frame.convert("RGBA")
    alpha = source.getchannel("A")
    alpha_pixels = alpha.load()
    visited = bytearray(CELL_WIDTH * CELL_HEIGHT)
    remove = Image.new("L", (CELL_WIDTH, CELL_HEIGHT), 0)
    remove_pixels = remove.load()
    neighbours = ((-1, -1), (0, -1), (1, -1), (-1, 0), (1, 0), (-1, 1), (0, 1), (1, 1))

    for y in range(CELL_HEIGHT):
        for x in range(CELL_WIDTH):
            index = y * CELL_WIDTH + x
            if visited[index] or alpha_pixels[x, y] <= 10:
                continue
            queue = deque([(x, y)])
            visited[index] = 1
            component: list[tuple[int, int]] = []
            while queue:
                px, py = queue.popleft()
                component.append((px, py))
                for ox, oy in neighbours:
                    nx, ny = px + ox, py + oy
                    if not (0 <= nx < CELL_WIDTH and 0 <= ny < CELL_HEIGHT):
                        continue
                    neighbour_index = ny * CELL_WIDTH + nx
                    if visited[neighbour_index] or alpha_pixels[nx, ny] <= 10:
                        continue
                    visited[neighbour_index] = 1
                    queue.append((nx, ny))
            if len(component) < minimum_component_area:
                for px, py in component:
                    remove_pixels[px, py] = 255

    if remove.getbbox() is None:
        return source
    clean_alpha = ImageChops.subtract(alpha, remove)
    source.putalpha(clean_alpha)
    return source


def delta_mask(profile: Image.Image, mannequin: Image.Image) -> Image.Image:
    """Return how strongly the fitted pixel differs from the neutral underlayer.

    Near-identical hood/cloth pixels are allowed to fall through to the
    mannequin.  Pixels outside the mannequin silhouette are always preserved.
    The smooth threshold avoids a colour-key halo at equipment edges.
    """

    profile_pixels = profile.load()
    mannequin_pixels = mannequin.load()
    result = Image.new("L", profile.size, 0)
    output = result.load()
    for y in range(CELL_HEIGHT):
        for x in range(CELL_WIDTH):
            pr, pg, pb, pa = profile_pixels[x, y]
            mr, mg, mb, ma = mannequin_pixels[x, y]
            if pa <= 4:
                continue
            if ma <= 8:
                output[x, y] = 255
                continue
            colour_distance = math.sqrt((pr - mr) ** 2 + (pg - mg) ** 2 + (pb - mb) ** 2)
            alpha_distance = abs(pa - ma) * 0.6
            distance = max(colour_distance, alpha_distance)
            # Cubic smoothstep from imperceptible variation to authored gear.
            t = max(0.0, min(1.0, (distance - 12.0) / 42.0))
            t = t * t * (3.0 - 2.0 * t)
            output[x, y] = round(255 * t)
    return result


def anatomical_owner(
    x: int,
    y: int,
    geometry: BodyGeometry,
    mannequin_dilated_alpha: int,
    authored_row: int,
    gait_column: int,
    profile_rgb: tuple[int, int, int],
    delta_strength: int,
) -> str:
    """Assign a pixel with curved, pose-stable anatomical boundaries."""

    ry = (y - geometry.top) / geometry.height
    rx = (x - geometry.center_x) / geometry.half_width
    ax = abs(rx)
    outside_body = mannequin_dilated_alpha <= 8
    phase = authored_row * 0.79 + gait_column * 1.37
    micro_curve = 0.009 * math.sin(x * 0.19 + phase)

    # Head/helmet boundary drops around the face and rises beside the neck.
    helm_bottom = 0.214 + 0.060 * max(0.0, 1.0 - min(1.0, ax / 0.72)) + micro_curve
    if ry <= helm_bottom and ax <= 1.26:
        return "helm"

    # Shoulder plates are paired ellipses.  This replaces the old horizontal
    # 20-43% strip, which was the source of the most visible square patches.
    shoulder_x = 0.43
    shoulder_y = 0.305 + micro_curve
    shoulder_distance = ((ax - shoulder_x) / 0.34) ** 2 + ((ry - shoulder_y) / 0.145) ** 2
    if shoulder_distance <= 1.0 and ax >= 0.15:
        return "shoulders"

    # Exterior connected silhouettes beyond the padded mannequin are held
    # objects.  Above rule order keeps helmet crests and pauldrons attached to
    # their body slots instead of turning them into weapon fragments.
    if outside_body and ax > 0.36:
        is_left = x < geometry.center_x
        return "weapon" if is_left == weapon_is_left(authored_row) else "offhand"

    # Compact luminous chest focus.  Requiring strong colour delta and either
    # saturation or brightness prevents an arbitrary rectangle of tunic from
    # being mistaken for a relic.
    red, green, blue = profile_rgb
    saturation = max(red, green, blue) - min(red, green, blue)
    brightness = max(red, green, blue)
    relic_distance = (rx / 0.19) ** 2 + ((ry - 0.425 - micro_curve) / 0.105) ** 2
    if (
        relic_distance <= 1.0
        and delta_strength >= 108
        and (saturation >= 48 or brightness >= 170)
    ):
        return "relic"

    # Arm tubes follow the shoulder-to-hand sweep instead of using a vertical
    # rectangle.  The gait phase only adds a sub-pixel-looking curvature.
    arm_t = max(0.0, min(1.0, (ry - 0.33) / 0.36))
    arm_center_x = 0.42 + 0.15 * arm_t + 0.025 * math.sin(phase + arm_t * math.pi)
    arm_radius = 0.17 + 0.025 * arm_t
    if 0.32 <= ry <= 0.72 and abs(ax - arm_center_x) <= arm_radius:
        return "gloves"

    # The waist seam is a shallow anatomical arc; the belt owns only a narrow
    # curved band.  No boundary is a constant-y cut.
    waist_curve = 0.588 + 0.030 * min(1.0, rx * rx) + micro_curve
    if ax <= 0.64 and abs(ry - waist_curve) <= 0.030:
        return "belt"

    crotch_curve = 0.615 + 0.038 * math.cos(min(1.0, ax) * math.pi) + micro_curve
    boot_curve = 0.835 + 0.028 * math.cos((rx + 1.0) * math.pi) - micro_curve
    if ry >= boot_curve:
        return "boots"
    if ry >= crotch_curve:
        return "legs"
    return "armor"


def build_owner_masks(
    profile: Image.Image,
    mannequin: Image.Image,
    authored_row: int,
    gait_column: int,
    delta: Image.Image,
) -> tuple[dict[str, Image.Image], float]:
    profile_alpha = profile.getchannel("A")
    mannequin_alpha = mannequin.getchannel("A")
    geometry = alpha_geometry(mannequin_alpha)
    dilated = mannequin_alpha.filter(ImageFilter.MaxFilter(11))
    pa = profile_alpha.load()
    da = delta.load()
    dp = dilated.load()
    pp = profile.load()
    # ``L`` is intentional: there are only ten labels and Pillow's point
    # lookup on an ``I`` image does not provide a reliable 256-entry LUT.
    labels = Image.new("L", profile.size, 0)
    labels_pixels = labels.load()
    slot_index = {slot: index + 1 for index, slot in enumerate(SLOTS)}

    for y in range(CELL_HEIGHT):
        for x in range(CELL_WIDTH):
            if pa[x, y] <= 4 or da[x, y] <= 1:
                continue
            owner = anatomical_owner(
                x,
                y,
                geometry,
                dp[x, y],
                authored_row,
                gait_column,
                pp[x, y][:3],
                da[x, y],
            )
            labels_pixels[x, y] = slot_index[owner]

    masks: dict[str, Image.Image] = {}
    longest_horizontal_run = 0
    body_width = max(1, round(geometry.half_width * 2))
    # Boundary diagnostic: maximum straight cross-slot run on a scanline.
    for y in range(CELL_HEIGHT - 1):
        run = 0
        for x in range(CELL_WIDTH):
            here = labels_pixels[x, y]
            below = labels_pixels[x, y + 1]
            if here and below and here != below:
                run += 1
                longest_horizontal_run = max(longest_horizontal_run, run)
            else:
                run = 0

    for slot, index in slot_index.items():
        hard = labels.point([255 if value == index else 0 for value in range(256)], mode="L")
        soft = hard.filter(ImageFilter.GaussianBlur(1.35))
        # Preserve the owner at 100%, add a restrained 2-3 px cover fringe.
        soft = soft.point(lambda value: round(value * 0.58))
        masks[slot] = ImageChops.lighter(hard, soft)
    return masks, longest_horizontal_run / body_width


def partition_frame(
    profile: Image.Image,
    mannequin: Image.Image,
    authored_row: int,
    gait_column: int,
) -> tuple[dict[str, Image.Image], dict[str, float]]:
    profile = cleaned_profile(profile)
    mannequin = mannequin.convert("RGBA")
    delta = delta_mask(profile, mannequin)
    masks, straightness = build_owner_masks(
        profile,
        mannequin,
        authored_row,
        gait_column,
        delta,
    )
    profile_alpha = profile.getchannel("A")
    delta_alpha = ImageChops.multiply(profile_alpha, delta)
    layers: dict[str, Image.Image] = {}
    for slot, ownership in masks.items():
        layer = profile.copy()
        layer.putalpha(ImageChops.multiply(delta_alpha, ownership))
        layers[slot] = layer
    retained = sum(delta.get_flattened_data()) / max(
        1,
        sum(profile_alpha.get_flattened_data()),
    )
    return layers, {"straightness": straightness, "delta_retention": retained}


def composite_same_family(
    mannequin: Image.Image,
    layers: dict[str, Image.Image],
) -> Image.Image:
    result = mannequin.copy()
    for slot in SLOTS:
        result.alpha_composite(layers[slot])
    return result


def restoration_metrics(rendered: Image.Image, target: Image.Image, delta: Image.Image) -> dict[str, float]:
    rendered_pixels = rendered.load()
    target_pixels = target.load()
    delta_pixels = delta.load()
    colour_error = 0.0
    delta_error = 0.0
    alpha_error = 0.0
    samples = 0
    delta_samples = 0
    intersection = 0
    union = 0
    for y in range(CELL_HEIGHT):
        for x in range(CELL_WIDTH):
            rr, rg, rb, ra = rendered_pixels[x, y]
            tr, tg, tb, ta = target_pixels[x, y]
            if ra > 12 or ta > 12:
                union += 1
                if ra > 12 and ta > 12:
                    intersection += 1
            if ta > 12:
                error = (abs(rr - tr) + abs(rg - tg) + abs(rb - tb)) / 3
                colour_error += error
                alpha_error += abs(ra - ta)
                samples += 1
                if delta_pixels[x, y] >= 96:
                    delta_error += error
                    delta_samples += 1
    return {
        "rgb_mae": colour_error / max(1, samples),
        "delta_rgb_mae": delta_error / max(1, delta_samples),
        "alpha_mae": alpha_error / max(1, samples),
        "silhouette_iou": intersection / max(1, union),
    }


def near_body_ratio(layer: Image.Image, body: Image.Image, dilation: int = 11) -> float:
    layer_mask = semantic_held.image_mask(layer, 8)
    body_near = semantic_held.dilate(semantic_held.image_mask(body, 16), dilation)
    return float(np.logical_and(layer_mask, body_near).sum() / max(1, layer_mask.sum()))


def foot_anchor(body: Image.Image) -> tuple[float, float]:
    mask = semantic_held.image_mask(body, 16)
    ys, xs = np.where(mask)
    if not len(xs):
        return CELL_WIDTH / 2, CELL_HEIGHT - 1
    threshold = int(np.quantile(ys, 0.78))
    yy = np.indices(mask.shape)[0]
    lower_y, lower_x = np.where(mask & (yy >= threshold))
    return float(np.median(lower_x)), float(lower_y.max())


def weighted_rgba(
    first: Image.Image,
    second: Image.Image,
    first_weight: float,
) -> Image.Image:
    """Premultiplied-alpha blend for a last-resort same-row boot phase."""

    a = np.asarray(first, dtype=np.float32) / 255.0
    b = np.asarray(second, dtype=np.float32) / 255.0
    weight_a = max(0.0, min(1.0, first_weight))
    weight_b = 1.0 - weight_a
    alpha = a[:, :, 3] * weight_a + b[:, :, 3] * weight_b
    premultiplied = (
        a[:, :, :3] * a[:, :, 3:4] * weight_a
        + b[:, :, :3] * b[:, :, 3:4] * weight_b
    )
    rgb = np.zeros_like(premultiplied)
    nonzero = alpha > 1e-6
    rgb[nonzero] = premultiplied[nonzero] / alpha[nonzero, None]
    output = np.dstack((rgb, alpha))
    return Image.fromarray(
        np.clip(np.rint(output * 255), 0, 255).astype(np.uint8),
        "RGBA",
    )


def same_row_boot_phase(
    frames: dict[tuple[int, int], Image.Image],
    bodies: dict[tuple[int, int], Image.Image],
    row: int,
    column: int,
) -> tuple[Image.Image | None, dict[str, object]]:
    candidates = [
        other
        for other in range(COLUMNS)
        if other != column
        and frames[(row, other)].getchannel("A").getbbox() is not None
    ]
    if not candidates:
        return None, {"method": "same-row-unavailable"}
    left = min(candidates, key=lambda other: ((column - other) % COLUMNS, other))
    right = min(candidates, key=lambda other: ((other - column) % COLUMNS, other))
    target_x, target_y = foot_anchor(bodies[(row, column)])

    def registered(source_column: int) -> Image.Image:
        source_x, source_y = foot_anchor(bodies[(row, source_column)])
        return translate_registered_frame(
            frames[(row, source_column)],
            round(target_x - source_x),
            round(target_y - source_y),
        )

    left_frame = registered(left)
    right_frame = registered(right)
    if left == right:
        return left_frame, {"method": "same-row-single-phase", "sources": [left]}
    left_distance = (column - left) % COLUMNS
    right_distance = (right - column) % COLUMNS
    left_weight = right_distance / max(1, left_distance + right_distance)
    return weighted_rgba(left_frame, right_frame, left_weight), {
        "method": "same-row-bidirectional-phase",
        "sources": [left, right],
        "leftWeight": round(left_weight, 6),
    }


def recover_boot_frames(
    preregistered: dict[tuple[int, int], Image.Image],
    exact_fitted: dict[tuple[int, int], Image.Image],
    bodies: dict[tuple[int, int], Image.Image],
) -> tuple[dict[tuple[int, int], Image.Image], list[dict[str, object]]]:
    """Prefer exact-cell fitted boots; never borrow from another direction."""

    output: dict[tuple[int, int], Image.Image] = {}
    rows: list[dict[str, object]] = []
    for row in range(ROWS):
        for column in range(COLUMNS):
            key = (row, column)
            candidate = preregistered[key]
            candidate_ratio = near_body_ratio(candidate, bodies[key])
            if candidate.getchannel("A").getbbox() is not None and candidate_ratio >= 0.55:
                output[key] = candidate
                method = "preregistered"
            else:
                exact = exact_fitted[key]
                exact_ratio = near_body_ratio(exact, bodies[key])
                if exact.getchannel("A").getbbox() is not None and exact_ratio >= 0.55:
                    output[key] = exact
                    method = "exact-current-fitted"
                else:
                    interpolated, details = same_row_boot_phase(
                        exact_fitted,
                        bodies,
                        row,
                        column,
                    )
                    output[key] = interpolated or Image.new(
                        "RGBA",
                        (CELL_WIDTH, CELL_HEIGHT),
                        (0, 0, 0, 0),
                    )
                    method = str(details["method"])
            rows.append(
                {
                    "row": row,
                    "column": column,
                    "method": method,
                    "candidateNearBodyRatio": candidate_ratio,
                    "finalNearBodyRatio": near_body_ratio(output[key], bodies[key]),
                    "finalBounds": list(output[key].getchannel("A").getbbox() or ()),
                }
            )
    return output, rows


def build_assets(
    workspace: Path, *, approve_silhouette_reference: bool = False
) -> dict[str, object]:
    walk_dir = workspace / "public" / "assets" / "walk"
    output_root = workspace / "public" / "assets" / "paperdoll" / "v1"
    held_source_root = workspace / "asset-sources" / "paperdoll" / "held-gear-v1"
    held_original_root = held_source_root / "original"
    mannequin_path = walk_dir / "harin-mannequin-v1.png"
    if not mannequin_path.exists():
        neutral = Image.open(walk_dir / "harin-neutral-walk-v4.png").convert("RGBA")
        neutral.save(mannequin_path, optimize=True)
    mannequin_atlas = Image.open(mannequin_path).convert("RGBA")
    if mannequin_atlas.size != ATLAS_SIZE:
        raise ValueError(f"invalid mannequin size: {mannequin_atlas.size}")

    frame_metrics: list[dict[str, object]] = []
    registration_rows: list[dict[str, object]] = []
    boot_recovery_rows: list[dict[str, object]] = []
    for variant_index, (variant_name, filename) in enumerate(VARIANTS):
        profile_path = walk_dir / filename
        profile_atlas = Image.open(profile_path).convert("RGBA")
        if profile_atlas.size != ATLAS_SIZE:
            raise ValueError(f"invalid profile size {profile_path}: {profile_atlas.size}")
        atlases = {slot: Image.new("RGBA", ATLAS_SIZE, (0, 0, 0, 0)) for slot in SLOTS}
        preregistered_boots: dict[tuple[int, int], Image.Image] = {}
        exact_boots: dict[tuple[int, int], Image.Image] = {}
        body_frames: dict[tuple[int, int], Image.Image] = {}
        for row in range(ROWS):
            for column in range(COLUMNS):
                box = frame_box(row, column)
                source = profile_atlas.crop(box)
                mannequin = mannequin_atlas.crop(box)
                body_frames[(row, column)] = mannequin
                requested = estimate_registration(source, mannequin)
                minimum_x, maximum_x, minimum_y, maximum_y = safe_offset_range(source)
                applied_x = clamp_registration(
                    requested.offset_x,
                    minimum_x,
                    maximum_x,
                )
                applied_y = clamp_registration(
                    requested.offset_y,
                    minimum_y,
                    maximum_y,
                )
                registered = translate_registered_frame(source, applied_x, applied_y)
                if alpha_mass(source) != alpha_mass(registered):
                    raise ValueError(
                        f"clamped profile registration clipped {variant_name}@{row},{column}"
                    )
                layers, partition_metrics = partition_frame(
                    registered,
                    mannequin,
                    row,
                    column,
                )
                exact_layers, _ = partition_frame(source, mannequin, row, column)
                preregistered_boots[(row, column)] = layers["boots"]
                exact_boots[(row, column)] = exact_layers["boots"]
                delta = delta_mask(cleaned_profile(registered), mannequin)
                restored = composite_same_family(mannequin, layers)
                metrics = restoration_metrics(restored, registered, delta)
                frame_metrics.append(
                    {
                        "variant": variant_name,
                        "row": row,
                        "column": column,
                        **partition_metrics,
                        **metrics,
                    }
                )
                registration_rows.append(
                    {
                        "variant": variant_name,
                        "row": row,
                        "column": column,
                        "method": requested.method,
                        "confidence": round(requested.confidence, 6),
                        "requestedOffset": [requested.offset_x, requested.offset_y],
                        "appliedOffset": [applied_x, applied_y],
                        "residualOffset": [
                            requested.offset_x - applied_x,
                            requested.offset_y - applied_y,
                        ],
                        "clamped": [requested.offset_x, requested.offset_y]
                        != [applied_x, applied_y],
                        "alphaMassPreserved": True,
                    }
                )
                for slot, layer in layers.items():
                    atlases[slot].alpha_composite(layer, (column * CELL_WIDTH, row * CELL_HEIGHT))

        recovered_boots, recovered_rows = recover_boot_frames(
            preregistered_boots,
            exact_boots,
            body_frames,
        )
        boot_recovery_rows.extend(
            {"variant": variant_name, **row} for row in recovered_rows
        )
        boots_atlas = Image.new("RGBA", ATLAS_SIZE, (0, 0, 0, 0))
        for (row, column), boot_frame in recovered_boots.items():
            boots_atlas.alpha_composite(
                boot_frame,
                (column * CELL_WIDTH, row * CELL_HEIGHT),
            )
        atlases["boots"] = boots_atlas

        for slot, atlas in atlases.items():
            slot_dir = output_root / slot
            slot_dir.mkdir(parents=True, exist_ok=True)
            output_path = slot_dir / f"{variant_index:02d}-{variant_name}.png"
            atlas.save(output_path, optimize=True)
            print(output_path.relative_to(workspace))
            if slot in ("weapon", "offhand"):
                original_path = (
                    held_original_root
                    / slot
                    / f"{variant_index:02d}-{variant_name}.png"
                )
                original_path.parent.mkdir(parents=True, exist_ok=True)
                atlas.save(original_path, optimize=True)

    # Replace only held atlases with the audited semantic alignment.  The raw
    # direction-correct owned deltas remain hash-bound under asset-sources.
    alignment_report = align_held_gear_assets(
        workspace,
        held_original_root,
        output_root,
        held_source_root / "alignment-report.json",
        held_source_root / "alignment-preview.png",
    )
    silhouette_reference_path = (
        workspace
        / "asset-sources/paperdoll/paperdoll-slot-silhouette-reference-v2.json"
    )
    if approve_silhouette_reference:
        silhouette_reference = slot_region_audit.write_silhouette_reference(
            silhouette_reference_path,
            workspace,
            output_root,
            mannequin_path,
            walk_dir,
        )
        silhouette_reference_summary = silhouette_reference["summary"]
    else:
        rig_manifest_path = workspace / "app/paperdoll-rig-manifest.json"
        rig_manifest = json.loads(rig_manifest_path.read_text(encoding="utf-8"))
        approved_reference_sha256 = str(
            rig_manifest.get("assetIntegrity", {}).get(
                "silhouetteReferenceSha256", ""
            )
        )
        reference_cells, reference_failures, reference_metadata = (
            slot_region_audit.load_silhouette_reference(
                silhouette_reference_path,
                workspace,
                mannequin_path,
                output_root,
                walk_dir,
                approved_reference_sha256 or None,
            )
        )
        if reference_failures:
            raise ValueError(
                "silhouette reference approval required: "
                + "; ".join(reference_failures[:8])
            )
        reference_mismatches: list[str] = []
        for slot in SLOTS:
            for variant_index, (variant_name, _filename) in enumerate(VARIANTS):
                atlas_name = f"{variant_index:02d}-{variant_name}.png"
                atlas = Image.open(output_root / slot / atlas_name).convert("RGBA")
                for row in range(ROWS):
                    for column in range(COLUMNS):
                        cell = f"{slot}/{atlas_name}@{row},{column}"
                        rgba = np.asarray(atlas.crop(frame_box(row, column)), dtype=np.uint8)
                        digest = hashlib.sha256(rgba.tobytes()).hexdigest()
                        if digest != reference_cells[cell]["rgbaSha256"]:
                            reference_mismatches.append(cell)
        if reference_mismatches:
            raise ValueError(
                "generated cells differ from approved silhouette reference: "
                + ", ".join(reference_mismatches[:8])
            )
        silhouette_reference_summary = {
            "atlases": reference_metadata["expectedAtlases"],
            "cells": len(reference_cells),
            "approved": True,
            "sha256": reference_metadata["sha256"],
        }

    summary: dict[str, object] = {
        "frames": len(frame_metrics),
        "atlases": len(SLOTS) * len(VARIANTS),
        "atlas_size": list(ATLAS_SIZE),
        "mean_rgb_mae": sum(float(item["rgb_mae"]) for item in frame_metrics) / len(frame_metrics),
        "mean_delta_rgb_mae": sum(float(item["delta_rgb_mae"]) for item in frame_metrics) / len(frame_metrics),
        "mean_alpha_mae": sum(float(item["alpha_mae"]) for item in frame_metrics) / len(frame_metrics),
        "mean_silhouette_iou": sum(float(item["silhouette_iou"]) for item in frame_metrics) / len(frame_metrics),
        "max_horizontal_boundary_ratio": max(float(item["straightness"]) for item in frame_metrics),
        "mean_delta_retention": sum(float(item["delta_retention"]) for item in frame_metrics) / len(frame_metrics),
        "registrationCells": len(registration_rows),
        "clampedRegistrationCells": sum(bool(row["clamped"]) for row in registration_rows),
        "profileAlphaClippedCells": sum(
            not bool(row["alphaMassPreserved"]) for row in registration_rows
        ),
        "bootRecoveryMethods": {
            method: sum(row["method"] == method for row in boot_recovery_rows)
            for method in sorted({str(row["method"]) for row in boot_recovery_rows})
        },
        "heldAlignment": alignment_report["summary"],
        "silhouetteReference": silhouette_reference_summary,
        "remaining_empty_frames": sum(
            1
            for slot in SLOTS
            for variant_index, (variant_name, _filename) in enumerate(VARIANTS)
            for row in range(ROWS)
            for column in range(COLUMNS)
            if Image.open(
                output_root / slot / f"{variant_index:02d}-{variant_name}.png"
            ).convert("RGBA").getchannel("A").crop(frame_box(row, column)).getbbox()
            is None
        ),
    }
    report = {
        "summary": summary,
        "per_frame": frame_metrics,
        "registrations": registration_rows,
        "bootRecoveries": boot_recovery_rows,
    }
    report_path = workspace / "tmp" / "paperdoll-layer-metrics.json"
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    print(report_path)
    return report


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--workspace", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument(
        "--approve-silhouette-reference",
        action="store_true",
        help=(
            "explicitly replace the checked-in 3,200-cell reference after "
            "human review; normal builds only verify it"
        ),
    )
    arguments = parser.parse_args()
    build_assets(
        arguments.workspace.resolve(),
        approve_silhouette_reference=arguments.approve_silhouette_reference,
    )


if __name__ == "__main__":
    main()
