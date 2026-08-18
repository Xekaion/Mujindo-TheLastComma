"""Build the clean v6 gameplay paperdoll rig.

The legacy v1 mannequin already wore a red hood, coat and boots.  Its wearable
atlases were therefore sparse colour deltas and could never replace those
baked clothes.  This builder keeps the proven 4x8 registration, reconstructs
complete body-slot art from each fitted profile, removes the legacy hood from
helmet art, and reduces every held layer to one hand-connected silhouette.

The output is deterministic and intentionally writes a new versioned root so
the runtime manifest can switch body and all 100 atlases atomically.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

import numpy as np
from PIL import Image, ImageChops, ImageDraw, ImageEnhance, ImageFilter

import build_layered_paperdoll_assets as legacy_builder
import paperdoll_semantic_held as semantic_held
from remap_paperdoll_gait import (
    legacy_hood_remove_region,
    legacy_lower_cloth_remove_region,
    remove_legacy_hood,
    remove_legacy_lower_cloth,
)


CELL_W = 256
CELL_H = 192
COLS = 4
ROWS = 8
ATLAS_SIZE = (CELL_W * COLS, CELL_H * ROWS)
SLOTS = legacy_builder.SLOTS
VARIANTS = legacy_builder.VARIANTS
WEARABLE_SLOTS = (
    "helm",
    "shoulders",
    "armor",
    "gloves",
    "belt",
    "legs",
    "boots",
)
HELD_SLOTS = ("weapon", "offhand")
MIN_HELD_VISIBLE_PIXELS = 128
MIN_HELD_VARIANT_MEDIAN_RATIO = 0.15
MAX_HELD_ROW_MEDIAN_RATIO = 1.90
MIN_HELD_ROW_EXCESS_PIXELS = 512
IDLE_COLUMN = 1
GROUND_BASELINE = 184
ANCHOR_ALPHA_THRESHOLD = 8
LOWER_WEARABLE_ALPHA_THRESHOLD = 8
LOWER_WEARABLE_MIN_SUPPORT_CONTACT_PIXELS = 3
GLOVE_FRAGMENT_ALPHA_THRESHOLD = 8
GLOVE_FOREARM_SUPPORT_DILATION = 17
LEGACY_LOWER_EXTERIOR_BODY_DILATION = 9
LEGACY_LOWER_NON_RED_VARIANT_DILATION = 31
RED_DOMINANT_VARIANTS = frozenset({"blood", "waraxe", "sealed"})


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


def relative_path(path: Path, workspace: Path) -> str:
    return path.resolve().relative_to(workspace.resolve()).as_posix()


def hash_inventory(paths: list[Path], workspace: Path) -> dict[str, object]:
    hashes = {
        relative_path(path, workspace): sha256(path)
        for path in sorted((path.resolve() for path in paths), key=lambda item: item.as_posix())
    }
    payload = "".join(f"{path}:{digest}\n" for path, digest in sorted(hashes.items()))
    return {
        "count": len(hashes),
        "aggregateSha256": hashlib.sha256(payload.encode("utf-8")).hexdigest(),
        "sha256": hashes,
    }


def alpha_pixels(image: Image.Image, threshold: int = 8) -> np.ndarray:
    return np.asarray(image.getchannel("A"), dtype=np.uint8) > threshold


def translate_cell(frame: Image.Image, offset_y: int) -> Image.Image:
    output = Image.new("RGBA", (CELL_W, CELL_H), (0, 0, 0, 0))
    output.alpha_composite(frame, (0, offset_y))
    return output


def normalize_ground_support(
    clean_body: Image.Image,
) -> tuple[Image.Image, dict[tuple[int, int], int]]:
    """Keep every pose on one runtime pivot without rendering a hard bottom pixel.

    The anchor contract intentionally retains a sub-threshold alpha support pixel
    on the baseline row while the visible foot ends one pixel above it.  ImageGen
    produced a mixture of hard and absent bottom-row pixels, which makes otherwise
    identical poses appear to rise and sink as the gait changes.
    """

    normalized = clean_body.copy()
    offsets: dict[tuple[int, int], int] = {}
    for row in range(ROWS):
        for column in range(COLS):
            box = frame_box(row, column)
            source = normalized.crop(box)
            visible_bounds = source.getchannel("A").point(
                lambda value: 255 if value > ANCHOR_ALPHA_THRESHOLD else 0
            ).getbbox()
            if visible_bounds is None:
                raise ValueError(f"clean body frame {row},{column} is empty")
            offset_y = (GROUND_BASELINE - 2) - (visible_bounds[3] - 1)
            offsets[(row, column)] = offset_y
            source = translate_cell(source, offset_y)
            frame = np.asarray(source, dtype=np.uint8).copy()
            alpha = frame[:, :, 3]
            support_y = GROUND_BASELINE - 1
            hard_support = alpha[support_y] > ANCHOR_ALPHA_THRESHOLD
            alpha[support_y, hard_support] = ANCHOR_ALPHA_THRESHOLD
            if not np.any(alpha[support_y] > 0):
                occupied_y, occupied_x = np.where(alpha[:support_y] > 0)
                if not len(occupied_y):
                    raise ValueError(f"clean body frame {row},{column} is empty")
                lowest_y = int(occupied_y.max())
                lowest_x = occupied_x[occupied_y == lowest_y]
                support_x = int(np.median(lowest_x))
                frame[support_y, support_x, :3] = frame[lowest_y, support_x, :3]
                alpha[support_y, support_x] = 1
            frame[:, :, 3] = alpha
            normalized.paste(Image.fromarray(frame, "RGBA"), box[:2])
    return normalized, offsets


def idle_leg_transform(
    body_frame: Image.Image,
    authored_row: int,
) -> dict[str, object]:
    mask = alpha_pixels(body_frame, 16)
    occupied_y, occupied_x = np.where(mask)
    if not len(occupied_y):
        raise ValueError("cannot author an idle stance from an empty body frame")
    top = int(occupied_y.min())
    bottom = int(occupied_y.max())
    height = max(1, bottom - top)
    leg_start = int(round(top + height * 0.55))
    foot_start = int(round(top + height * 0.68))
    y_grid = np.indices(mask.shape)[0]
    lower = mask & (y_grid >= foot_start)
    components = sorted(
        (
            {
                "pixels": int(len(xs)),
                "centerX": round(float(np.median(xs)), 3),
                "sourceBottom": int(ys.max()),
                "bounds": [
                    int(xs.min()),
                    int(ys.min()),
                    int(xs.max()) + 1,
                    int(ys.max()) + 1,
                ],
            }
            for ys, xs in semantic_held.connected_components(lower)
            if len(xs) >= 64
        ),
        key=lambda component: int(component["pixels"]),
        reverse=True,
    )
    if authored_row in (2, 6):
        if not components or components[0]["bounds"][2] - components[0]["bounds"][0] < 30:
            raise ValueError("side-view idle stance lacks a two-foot silhouette")
        feet = components[:1]
        bottoms = [int(feet[0]["sourceBottom"]), int(feet[0]["sourceBottom"])]
        separation = int(feet[0]["bounds"][2] - feet[0]["bounds"][0])
    else:
        if len(components) < 2:
            raise ValueError("idle stance does not contain two lower-limb components")
        feet = sorted(components[:2], key=lambda component: float(component["centerX"]))
        if min(int(component["pixels"]) for component in feet) < 400:
            raise ValueError("idle stance has an undersized lower-limb component")
        separation = int(round(float(feet[1]["centerX"]) - float(feet[0]["centerX"])))
        if separation < 18:
            raise ValueError("idle stance feet are not visibly separated")
        bottoms = [int(component["sourceBottom"]) for component in feet]
    target_bottom = max(bottoms)
    if target_bottom < GROUND_BASELINE - 4 or max(bottoms) - min(bottoms) > 10:
        raise ValueError("idle stance feet do not share the authored ground plane")
    return {
        "legStart": leg_start,
        "footStart": foot_start,
        "targetBottom": target_bottom,
        "sourceBottoms": bottoms,
        "footComponentCount": len(components),
        "footComponentSeparation": separation,
        "footComponents": feet,
    }


def translate_profile_to_legacy_body(
    profile: Image.Image,
    legacy_body: Image.Image,
) -> tuple[Image.Image, dict[str, object]]:
    requested = legacy_builder.estimate_registration(profile, legacy_body)
    minimum_x, maximum_x, minimum_y, maximum_y = legacy_builder.safe_offset_range(
        profile
    )
    offset_x = legacy_builder.clamp_registration(
        requested.offset_x,
        minimum_x,
        maximum_x,
    )
    offset_y = legacy_builder.clamp_registration(
        requested.offset_y,
        minimum_y,
        maximum_y,
    )
    registered = legacy_builder.translate_registered_frame(
        profile,
        offset_x,
        offset_y,
    )
    return registered, {
        "method": requested.method,
        "confidence": round(requested.confidence, 6),
        "requestedOffset": [requested.offset_x, requested.offset_y],
        "appliedOffset": [offset_x, offset_y],
    }


def complete_wearable_layers(
    registered_profile: Image.Image,
    legacy_body: Image.Image,
    clean_body: Image.Image,
    sparse_atlases: dict[str, Image.Image],
    equipment_icons: dict[str, Image.Image],
    palette: tuple[np.ndarray, np.ndarray, np.ndarray],
    row: int,
    column: int,
    variant_name: str,
) -> tuple[dict[str, Image.Image], dict[str, int]]:
    # Keep the fitted profile's complete authored surfaces.  A colour-delta
    # alpha destroys dark iron detail that is intentionally close to the
    # under-suit and leaves only a flat coverage fill.  The recovered sparse
    # atlas also contains item-specific detail beyond the soft owner boundary,
    # so it must remain authored rather than being cropped a second time.  The
    # pose-derived hood/sash and disconnected-piece sanitizers below remove the
    # known legacy-body contamination explicitly.
    full_signal = Image.new("L", (CELL_W, CELL_H), 255)
    owners, _straightness = legacy_builder.build_owner_masks(
        registered_profile,
        legacy_body,
        row,
        column,
        full_signal,
    )
    profile_alpha = registered_profile.getchannel("A")
    hood_region = legacy_hood_remove_region(legacy_body)
    lower_cloth_region = legacy_lower_cloth_remove_region(legacy_body)
    # The fitted profiles can shift the old sash/tails by several pixels. For
    # non-red equipment families, widen the pose-derived footprint and reject
    # those displaced crimson remnants as well. Red-dominant sets retain their
    # authored colour outside the exact legacy footprint.
    lower_cloth_scrub_region = (
        lower_cloth_region
        if variant_name in RED_DOMINANT_VARIANTS
        else semantic_held.dilate(
            lower_cloth_region,
            LEGACY_LOWER_NON_RED_VARIANT_DILATION,
        )
    )
    output: dict[str, Image.Image] = {}
    idle_detail: dict[str, int] = {}
    for slot in WEARABLE_SLOTS:
        if slot == "helm":
            output[slot] = complete_helmet_layer(
                clean_body,
                registered_profile,
                equipment_icons["helm"],
                palette,
                row,
            )
            continue
        layer = registered_profile.copy()
        layer.putalpha(ImageChops.multiply(profile_alpha, owners[slot]))
        sparse = sparse_atlases[slot].crop(frame_box(row, column))
        layer = remove_legacy_lower_cloth(
            layer,
            legacy_body,
            lower_cloth_scrub_region,
        )
        sparse = remove_legacy_lower_cloth(
            sparse,
            legacy_body,
            lower_cloth_scrub_region,
        )
        if slot in ("shoulders", "armor"):
            layer = remove_legacy_hood(layer, legacy_body, hood_region)
            sparse = remove_legacy_hood(sparse, legacy_body, hood_region)
        layer.alpha_composite(sparse)
        if slot in ("legs", "boots"):
            # Retarget the canonical item illustration for every gait phase.
            # The old fitted profiles often carried detail for only one foot,
            # so palette-filling the other foot produced an obviously plain
            # mannequin shoe. Canonical art clipped to the exact two-leg/two-
            # foot silhouette keeps both sides recognisably equipped and also
            # eliminates the legacy coat-tail fragments from lower slots.
            layer = fitted_lower_equipment_icon(
                clean_body,
                equipment_icons[slot],
                slot,
                row,
            )
            if column == IDLE_COLUMN:
                idle_detail[slot] = int(
                    (np.asarray(layer.getchannel("A"), dtype=np.uint8) > 8).sum()
                )
        else:
            # Scrub again after the sparse authored detail is composited.  The
            # canonical idle lower layers are clean by construction and must
            # retain their legitimate item colours.
            layer = remove_legacy_lower_cloth(
                layer,
                legacy_body,
                lower_cloth_scrub_region,
            )
        if slot == "gloves":
            layer = remove_glove_semantic_fragments(clean_body, layer, row)
        if slot == "armor":
            layer = complete_armor_coverage(clean_body, layer)
        if slot == "legs":
            layer = complete_leg_coverage(clean_body, layer)
        if slot == "boots":
            layer = complete_boot_coverage(clean_body, layer)
        layer = remove_legacy_lower_exterior_fragments(
            clean_body,
            layer,
            lower_cloth_scrub_region,
        )
        if slot in ("legs", "boots"):
            # The legacy-cloth scrub can split a previously supported lower
            # detail into a tiny detached island. Make anatomy support the
            # final lower-layer gate so no third shoe, hand-height ornament,
            # or clipped gait remnant can survive the complete pipeline.
            layer = remove_detached_lower_wearable_fragments(
                clean_body,
                layer,
                slot,
            )
        if slot in ("shoulders", "armor"):
            layer = remove_legacy_hood(layer, legacy_body, hood_region)
        output[slot] = layer
    return output, idle_detail


def glove_forearm_support(
    clean_body: Image.Image,
    authored_row: int,
) -> np.ndarray:
    """Return a tolerant pose-local corridor around both hands and forearms."""

    body_mask = alpha_pixels(clean_body, 16)
    occupied_y, occupied_x = np.where(body_mask)
    if not len(occupied_y):
        raise ValueError("cannot fit gloves to an empty body frame")
    top = int(occupied_y.min())
    bottom = int(occupied_y.max())
    height = max(1, bottom - top)
    center_x = float(np.median(occupied_x))
    half_width = max(
        1.0,
        (float(occupied_x.max()) - float(occupied_x.min())) / 2.0,
    )
    y_grid, x_grid = np.indices(body_mask.shape)
    relative_y = (y_grid - top) / height
    relative_x = np.abs((x_grid - center_x) / half_width)
    forearms = (
        body_mask
        & (relative_y >= 0.22)
        & (relative_y <= 0.74)
        & (relative_x >= 0.32)
    )
    actual_palms = (
        semantic_held.actual_palm_mask(clean_body, "weapon", authored_row)
        | semantic_held.actual_palm_mask(clean_body, "offhand", authored_row)
    )
    return (
        np.asarray(
            Image.fromarray(
                ((forearms | actual_palms) * 255).astype(np.uint8),
                mode="L",
            ).filter(ImageFilter.MaxFilter(GLOVE_FOREARM_SUPPORT_DILATION)),
            dtype=np.uint8,
        )
        > 0
    )


def remove_glove_semantic_fragments(
    clean_body: Image.Image,
    authored_layer: Image.Image,
    authored_row: int,
) -> Image.Image:
    """Keep gauntlet art only around the pose's real hands and forearms."""

    support = glove_forearm_support(clean_body, authored_row)
    rgba = np.asarray(authored_layer.convert("RGBA"), dtype=np.uint8).copy()
    outside = (rgba[:, :, 3] > GLOVE_FRAGMENT_ALPHA_THRESHOLD) & ~support
    rgba[outside] = 0
    return Image.fromarray(rgba, mode="RGBA")


def remove_legacy_lower_exterior_fragments(
    clean_body: Image.Image,
    authored_layer: Image.Image,
    legacy_lower_region: np.ndarray,
) -> Image.Image:
    """Drop old coat-tail geometry that protrudes beyond the new mannequin."""

    body_near = semantic_held.dilate(
        alpha_pixels(clean_body, 16),
        LEGACY_LOWER_EXTERIOR_BODY_DILATION,
    )
    rgba = np.asarray(authored_layer.convert("RGBA"), dtype=np.uint8).copy()
    rgba[
        (rgba[:, :, 3] > LOWER_WEARABLE_ALPHA_THRESHOLD)
        & legacy_lower_region
        & ~body_near
    ] = 0
    return Image.fromarray(rgba, mode="RGBA")


def complete_leg_coverage(
    clean_body: Image.Image,
    authored_legs: Image.Image,
    include_authored: bool = True,
) -> Image.Image:
    """Fill both animated thighs and shins beneath authored greave details."""

    body = np.asarray(clean_body.convert("RGBA"), dtype=np.uint8)
    authored_legs = remove_detached_lower_wearable_fragments(
        clean_body,
        authored_legs,
        "legs",
    )
    authored = np.asarray(authored_legs.convert("RGBA"), dtype=np.uint8)
    body_mask = body[:, :, 3] > 16
    ys, _xs = np.where(body_mask)
    if not len(ys):
        return authored_legs
    top = int(ys.min())
    bottom = int(ys.max())
    y_grid = np.indices(body_mask.shape)[0]
    height = max(1, bottom - top)
    leg_mask = (
        body_mask
        & (y_grid >= top + height * 0.55)
        & (y_grid <= top + height * 0.82)
    )
    sample_mask = (authored[:, :, 3] > 32) & (
        np.asarray(
            Image.fromarray((leg_mask * 255).astype(np.uint8), mode="L").filter(
                ImageFilter.MaxFilter(11)
            ),
            dtype=np.uint8,
        )
        > 0
    )
    samples = authored[:, :, :3][sample_mask]
    palette = (
        np.quantile(samples, 0.58, axis=0)
        if len(samples) >= 20
        else np.asarray([84.0, 82.0, 82.0])
    )
    base_luma = (
        body[:, :, 0].astype(np.float32) * 0.24
        + body[:, :, 1].astype(np.float32) * 0.68
        + body[:, :, 2].astype(np.float32) * 0.08
    )
    shade = 0.40 + np.clip(base_luma / 150.0, 0.0, 1.0) * 0.60
    underlay = np.zeros_like(body)
    underlay[:, :, :3] = np.clip(
        palette[None, None, :] * shade[:, :, None],
        0,
        255,
    ).astype(np.uint8)
    underlay[:, :, 3] = np.where(leg_mask, body[:, :, 3], 0)
    output = Image.fromarray(underlay, mode="RGBA")
    if include_authored:
        output.alpha_composite(authored_legs)
    return output


def complete_armor_coverage(
    clean_body: Image.Image,
    authored_armor: Image.Image,
) -> Image.Image:
    """Fill the fitted torso and sleeves beneath authored armor details."""

    body = np.asarray(clean_body.convert("RGBA"), dtype=np.uint8)
    authored = np.asarray(authored_armor.convert("RGBA"), dtype=np.uint8)
    body_mask = body[:, :, 3] > 16
    ys, _xs = np.where(body_mask)
    if not len(ys):
        return authored_armor
    top = int(ys.min())
    bottom = int(ys.max())
    y_grid = np.indices(body_mask.shape)[0]
    height = max(1, bottom - top)
    armor_mask = (
        body_mask
        & (y_grid >= top + height * 0.23)
        & (y_grid <= top + height * 0.66)
    )
    sample_mask = (authored[:, :, 3] > 32) & (
        np.asarray(
            Image.fromarray((armor_mask * 255).astype(np.uint8), mode="L").filter(
                ImageFilter.MaxFilter(11)
            ),
            dtype=np.uint8,
        )
        > 0
    )
    samples = authored[:, :, :3][sample_mask]
    palette = (
        np.quantile(samples, 0.58, axis=0)
        if len(samples) >= 24
        else np.asarray([92.0, 88.0, 84.0])
    )
    base_luma = (
        body[:, :, 0].astype(np.float32) * 0.24
        + body[:, :, 1].astype(np.float32) * 0.68
        + body[:, :, 2].astype(np.float32) * 0.08
    )
    shade = 0.38 + np.clip(base_luma / 145.0, 0.0, 1.0) * 0.62
    underlay = np.zeros_like(body)
    underlay[:, :, :3] = np.clip(
        palette[None, None, :] * shade[:, :, None],
        0,
        255,
    ).astype(np.uint8)
    underlay[:, :, 3] = np.where(armor_mask, body[:, :, 3], 0)
    output = Image.fromarray(underlay, mode="RGBA")
    output.alpha_composite(authored_armor)
    return output


def complete_boot_coverage(
    clean_body: Image.Image,
    authored_boot: Image.Image,
    include_authored: bool = True,
) -> Image.Image:
    """Supply both animated feet with a fitted boot underlay.

    Several fitted source frames hide the rear shoe completely.  Copying the
    visible shoe to a different limb creates a skating duplicate, so the
    neutral body's own foot silhouette is colourised with the authored boot's
    palette and used only underneath the original detailed pixels.
    """

    body = np.asarray(clean_body.convert("RGBA"), dtype=np.uint8)
    authored_boot = remove_detached_lower_wearable_fragments(
        clean_body,
        authored_boot,
        "boots",
    )
    authored = np.asarray(authored_boot.convert("RGBA"), dtype=np.uint8)
    body_mask = body[:, :, 3] > 16
    ys, _xs = np.where(body_mask)
    if not len(ys):
        return authored_boot
    top = int(ys.min())
    bottom = int(ys.max())
    y_grid = np.indices(body_mask.shape)[0]
    foot_mask = body_mask & (y_grid >= top + (bottom - top) * 0.78)

    sample_mask = (authored[:, :, 3] > 32) & (
        np.asarray(
            Image.fromarray((foot_mask * 255).astype(np.uint8), mode="L").filter(
                ImageFilter.MaxFilter(15)
            ),
            dtype=np.uint8,
        )
        > 0
    )
    samples = authored[:, :, :3][sample_mask]
    if len(samples) >= 12:
        palette = np.quantile(samples, 0.62, axis=0)
    else:
        palette = np.asarray([104.0, 86.0, 72.0])

    base_luma = (
        body[:, :, 0].astype(np.float32) * 0.24
        + body[:, :, 1].astype(np.float32) * 0.68
        + body[:, :, 2].astype(np.float32) * 0.08
    )
    shade = 0.42 + np.clip(base_luma / 150.0, 0.0, 1.0) * 0.58
    underlay = np.zeros_like(body)
    underlay[:, :, :3] = np.clip(
        palette[None, None, :] * shade[:, :, None],
        0,
        255,
    ).astype(np.uint8)
    underlay[:, :, 3] = np.where(foot_mask, body[:, :, 3], 0)
    output = Image.fromarray(underlay, mode="RGBA")
    if include_authored:
        output.alpha_composite(authored_boot)
    return output


def lower_wearable_anatomical_support(
    clean_body: Image.Image,
    slot: str,
) -> np.ndarray:
    """Return a tolerant two-leg/two-foot support corridor for one body pose."""

    body_mask = alpha_pixels(clean_body, 16)
    occupied_y, _occupied_x = np.where(body_mask)
    if not len(occupied_y):
        raise ValueError("cannot fit lower equipment to an empty body frame")
    top = int(occupied_y.min())
    bottom = int(occupied_y.max())
    height = max(1, bottom - top)
    y_grid = np.indices(body_mask.shape)[0]
    if slot == "legs":
        anatomy = (
            body_mask
            & (y_grid >= top + height * 0.50)
            & (y_grid <= top + height * 0.87)
        )
        dilation_size = 9
    elif slot == "boots":
        anatomy = body_mask & (y_grid >= top + height * 0.76)
        dilation_size = 7
    else:
        raise ValueError(f"unsupported lower wearable slot: {slot}")
    return np.asarray(
        Image.fromarray((anatomy * 255).astype(np.uint8), mode="L").filter(
            ImageFilter.MaxFilter(dilation_size)
        ),
        dtype=np.uint8,
    ) > 0


def remove_detached_lower_wearable_fragments(
    clean_body: Image.Image,
    authored_layer: Image.Image,
    slot: str,
) -> Image.Image:
    """Drop decorative/body remnants not supported by either anatomical limb.

    Registration can leave a third shoe, sash, or shin fragment beside the two
    animated limbs.  Component connectivity to the pose's actual leg/foot
    corridor is a direction-, item-, and frame-independent discriminator.
    """

    support = lower_wearable_anatomical_support(clean_body, slot)
    rgba = np.asarray(authored_layer.convert("RGBA"), dtype=np.uint8).copy()
    authored_mask = rgba[:, :, 3] > LOWER_WEARABLE_ALPHA_THRESHOLD
    keep = np.zeros(authored_mask.shape, dtype=bool)
    for component_y, component_x in semantic_held.connected_components(
        authored_mask
    ):
        required_contact = min(
            LOWER_WEARABLE_MIN_SUPPORT_CONTACT_PIXELS,
            len(component_x),
        )
        if int(support[component_y, component_x].sum()) >= required_contact:
            keep[component_y, component_x] = True
    rgba[:, :, 3] = np.where(keep, rgba[:, :, 3], 0).astype(np.uint8)
    return Image.fromarray(rgba, mode="RGBA")


def mask_bounds(mask: np.ndarray) -> tuple[int, int, int, int] | None:
    occupied_y, occupied_x = np.where(mask)
    if not len(occupied_x):
        return None
    return (
        int(occupied_x.min()),
        int(occupied_y.min()),
        int(occupied_x.max()) + 1,
        int(occupied_y.max()) + 1,
    )


def canonical_boot_pieces(equipment_icon: Image.Image) -> list[Image.Image]:
    """Split a canonical two-boot illustration into stable left/right pieces."""

    rgba = np.asarray(equipment_icon.convert("RGBA"), dtype=np.uint8)
    pieces: list[tuple[float, Image.Image]] = []
    for component_y, component_x in semantic_held.connected_components(
        rgba[:, :, 3] > 8
    ):
        if len(component_x) < 64:
            continue
        left = int(component_x.min())
        top = int(component_y.min())
        right = int(component_x.max()) + 1
        bottom = int(component_y.max()) + 1
        crop = rgba[top:bottom, left:right].copy()
        component = np.zeros((bottom - top, right - left), dtype=bool)
        component[component_y - top, component_x - left] = True
        crop[:, :, 3] = np.where(component, crop[:, :, 3], 0).astype(np.uint8)
        pieces.append(
            (
                float(component_x.mean()),
                Image.fromarray(crop, mode="RGBA"),
            )
        )
    pieces.sort(key=lambda item: item[0])
    if len(pieces) == 2:
        return [piece for _center, piece in pieces]

    # A lace or shadow can join the two product-illustration silhouettes by a
    # pixel. Split at the least occupied column around the horizontal centre.
    mask = rgba[:, :, 3] > 8
    occupied_x = np.where(mask)[1]
    if not len(occupied_x):
        raise ValueError("canonical boot icon is empty")
    left_bound = int(occupied_x.min())
    right_bound = int(occupied_x.max()) + 1
    search_left = left_bound + round((right_bound - left_bound) * 0.40)
    search_right = left_bound + round((right_bound - left_bound) * 0.60)
    split = search_left + int(
        np.argmin(mask[:, search_left:search_right].sum(axis=0))
    )
    pieces = []
    for left, right in ((left_bound, split + 1), (split + 1, right_bound)):
        part_mask = mask[:, left:right]
        part_y, part_x = np.where(part_mask)
        if len(part_x) < 64:
            raise ValueError("canonical boot midpoint split produced an empty piece")
        top = int(part_y.min())
        bottom = int(part_y.max()) + 1
        crop = rgba[top:bottom, left:right].copy()
        crop[:, :, 3] = np.where(
            part_mask[top:bottom],
            crop[:, :, 3],
            0,
        ).astype(np.uint8)
        pieces.append((float(left + right) / 2.0, Image.fromarray(crop, mode="RGBA")))
    pieces.sort(key=lambda item: item[0])
    return [piece for _center, piece in pieces]


def exclusive_foot_regions(clean_body: Image.Image) -> list[np.ndarray]:
    """Return two exclusive boot regions, or none for a fully occluded pose."""

    body_mask = alpha_pixels(clean_body, 16)
    occupied_y, _occupied_x = np.where(body_mask)
    if not len(occupied_y):
        raise ValueError("cannot fit boots to an empty body frame")
    top = int(occupied_y.min())
    bottom = int(occupied_y.max())
    height = max(1, bottom - top)
    y_grid, x_grid = np.indices(body_mask.shape)
    seed_mask = body_mask & (y_grid >= top + height * 0.80)
    seeds = [
        (component_y, component_x)
        for component_y, component_x in semantic_held.connected_components(seed_mask)
        if len(component_x) >= 8
    ]
    seeds.sort(key=lambda item: float(item[1].mean()))
    if len(seeds) != 2:
        return []

    boot_band = body_mask & (y_grid >= top + height * 0.755)
    distance_maps = []
    for seed_y, seed_x in seeds:
        center_y = float(seed_y.mean())
        center_x = float(seed_x.mean())
        distance_maps.append((y_grid - center_y) ** 2 + (x_grid - center_x) ** 2)
    assignment = np.argmin(np.stack(distance_maps, axis=0), axis=0)
    expanded_band = mask_filter(boot_band, 3) & lower_wearable_anatomical_support(
        clean_body,
        "boots",
    )
    regions = [expanded_band & (assignment == index) for index in range(2)]
    return regions if all(int(region.sum()) >= 24 for region in regions) else []


def fit_boot_piece_to_region(
    icon_piece: Image.Image,
    region: np.ndarray,
    mirror: bool,
    dim: float,
) -> Image.Image:
    bounds = mask_bounds(region)
    if bounds is None:
        return Image.new("RGBA", (CELL_W, CELL_H), (0, 0, 0, 0))
    left, top, right, bottom = bounds
    piece = icon_piece.convert("RGBA")
    crop_top = int(round(piece.height * 0.30))
    piece = piece.crop((0, crop_top, piece.width, piece.height))
    if mirror:
        piece = piece.transpose(Image.Transpose.FLIP_LEFT_RIGHT)
    padding_x = 3
    padding_y = 3
    piece = piece.resize(
        (
            max(1, right - left + padding_x * 2),
            max(1, bottom - top + padding_y * 2),
        ),
        Image.Resampling.LANCZOS,
    )
    if dim != 1.0:
        piece_rgba = np.asarray(piece, dtype=np.uint8).copy()
        piece_rgba[:, :, :3] = np.clip(
            piece_rgba[:, :, :3].astype(np.float32) * dim,
            0,
            255,
        ).astype(np.uint8)
        piece = Image.fromarray(piece_rgba, mode="RGBA")
    canvas = Image.new("RGBA", (CELL_W, CELL_H), (0, 0, 0, 0))
    canvas.alpha_composite(piece, (left - padding_x, top - padding_y))
    fitted = np.asarray(canvas, dtype=np.uint8).copy()
    fitted[:, :, 3] = np.where(region, fitted[:, :, 3], 0).astype(np.uint8)
    return Image.fromarray(fitted, mode="RGBA")


def fitted_lower_equipment_icon(
    clean_body: Image.Image,
    equipment_icon: Image.Image,
    slot: str,
    authored_row: int,
) -> Image.Image:
    """Fit canonical greave/boot art to the current pose silhouette.

    The old authored cells often contain only one detailed limb or duplicate a
    gait fragment. Canonical slot illustrations are instead clipped to the
    exact current leg/foot silhouettes. This retains the item's pattern and
    colour on both limbs while the clean mannequin owns pose and support.
    """

    if slot == "boots":
        regions = exclusive_foot_regions(clean_body)
        if regions:
            pieces = canonical_boot_pieces(equipment_icon)
            mirror = authored_row == 2
            if mirror:
                pieces.reverse()
            dim = 0.78 if authored_row in (3, 4, 5) else 1.0
            fitted_pair = Image.new("RGBA", (CELL_W, CELL_H), (0, 0, 0, 0))
            for piece, region in zip(pieces, regions, strict=True):
                fitted_pair.alpha_composite(
                    fit_boot_piece_to_region(piece, region, mirror, dim)
                )
            return fitted_pair

    body = np.asarray(clean_body.convert("RGBA"), dtype=np.uint8)
    body_mask = body[:, :, 3] > 16
    occupied_y, _occupied_x = np.where(body_mask)
    if not len(occupied_y):
        raise ValueError("lower-body frame is empty")
    top = int(occupied_y.min())
    bottom = int(occupied_y.max())
    height = max(1, bottom - top)
    y_grid = np.indices(body_mask.shape)[0]
    if slot == "legs":
        region = (
            body_mask
            & (y_grid >= top + height * 0.54)
            & (y_grid <= top + height * 0.83)
        )
        crop_top_ratio, crop_bottom_ratio = 0.02, 0.86
    elif slot == "boots":
        region = body_mask & (y_grid >= top + height * 0.76)
        crop_top_ratio, crop_bottom_ratio = 0.38, 1.0
    else:
        raise ValueError(f"unsupported lower equipment slot: {slot}")

    region_bounds = Image.fromarray(
        (region * 255).astype(np.uint8), mode="L"
    ).getbbox()
    icon = equipment_icon.convert("RGBA")
    icon_bounds = icon.getchannel("A").point(
        lambda value: 255 if value > 8 else 0
    ).getbbox()
    if region_bounds is None or icon_bounds is None:
        raise ValueError(f"{slot} icon or body region is empty")
    icon = icon.crop(icon_bounds)
    crop_top = int(round(icon.height * crop_top_ratio))
    crop_bottom = max(crop_top + 1, int(round(icon.height * crop_bottom_ratio)))
    icon = icon.crop((0, crop_top, icon.width, crop_bottom))

    padding_x = 7 if slot == "legs" else 9
    padding_y = 4
    target_width = max(1, region_bounds[2] - region_bounds[0] + padding_x * 2)
    target_height = max(1, region_bounds[3] - region_bounds[1] + padding_y * 2)
    icon = icon.resize((target_width, target_height), Image.Resampling.LANCZOS)
    if authored_row == 2:
        icon = icon.transpose(Image.Transpose.FLIP_LEFT_RIGHT)
    if authored_row in (3, 4, 5):
        icon_rgba = np.asarray(icon, dtype=np.uint8).copy()
        icon_rgba[:, :, :3] = np.clip(
            icon_rgba[:, :, :3].astype(np.float32) * 0.78,
            0,
            255,
        ).astype(np.uint8)
        icon = Image.fromarray(icon_rgba, mode="RGBA")

    canvas = Image.new("RGBA", (CELL_W, CELL_H), (0, 0, 0, 0))
    canvas.alpha_composite(
        icon,
        (region_bounds[0] - padding_x, region_bounds[1] - padding_y),
    )
    fitted = np.asarray(canvas, dtype=np.uint8).copy()
    fitted[:, :, 3] = np.where(
        mask_filter(region, 3),
        fitted[:, :, 3],
        0,
    ).astype(np.uint8)
    return Image.fromarray(fitted, mode="RGBA")


def helmet_palette(icon: Image.Image) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    rgba = np.asarray(icon.convert("RGBA"), dtype=np.uint8)
    samples = rgba[:, :, :3][rgba[:, :, 3] > 24].astype(np.float32)
    samples = samples[np.mean(samples, axis=1) > 25]
    if len(samples) < 32:
        samples = np.asarray([[55, 58, 64], [112, 118, 128], [205, 210, 220]])
    return tuple(np.quantile(samples, value, axis=0) for value in (0.13, 0.55, 0.90))


def mask_filter(mask: np.ndarray, size: int, maximum: bool = True) -> np.ndarray:
    image = Image.fromarray((mask * 255).astype(np.uint8), mode="L")
    filtered = image.filter(
        ImageFilter.MaxFilter(size) if maximum else ImageFilter.MinFilter(size)
    )
    return np.asarray(filtered, dtype=np.uint8) > 0


def fill_enclosed_mask_holes(mask: np.ndarray) -> np.ndarray:
    """Fill enclosed visor/eye gaps while preserving open crest silhouettes."""

    filled = mask.copy()
    height, width = mask.shape
    for ys, xs in semantic_held.connected_components(~mask):
        touches_exterior = bool(
            np.any(xs == 0)
            or np.any(xs == width - 1)
            or np.any(ys == 0)
            or np.any(ys == height - 1)
        )
        if not touches_exterior:
            filled[ys, xs] = True
    return filled


def helmet_head_support(
    body_mask: np.ndarray,
    authored_row: int,
) -> tuple[np.ndarray, np.ndarray, int, int, float, float]:
    """Return a head-only shell and icon support, excluding shoulder pixels.

    The mannequin's shoulders begin inside the old ``top + height * .20`` head
    band.  Taking the x extent of that whole band therefore turned the helmet
    shell into a wide gorget that painted over equipped chest and shoulder art.
    Estimate the actual skull from the crown band first, then extend a tapered
    corridor only far enough to cover the jaw and neck.  The wider upper support
    deliberately leaves room for authored horns and crests while the lower
    support cannot reach either shoulder.
    """

    occupied_y, _occupied_x = np.where(body_mask)
    if not len(occupied_y):
        raise ValueError("cannot fit a helmet to an empty body frame")
    top = int(occupied_y.min())
    bottom = int(occupied_y.max())
    height = max(1, bottom - top)
    y_grid, x_grid = np.indices(body_mask.shape)

    crown = body_mask & (y_grid <= top + height * 0.125)
    _crown_y, crown_x = np.where(crown)
    if len(crown_x) < 8:
        raise ValueError("clean body frame lacks a stable crown silhouette")
    center_x = float(np.median(crown_x))
    lower_x, upper_x = np.quantile(crown_x.astype(np.float32), (0.02, 0.98))
    skull_half_width = max(
        11.0,
        float(max(center_x - lower_x, upper_x - center_x)) + 1.5,
    )

    anatomical_head_bottom = top + height * 0.15
    anatomical_head = body_mask & (y_grid <= anatomical_head_bottom)
    # Do not derive the neck width from the full top band: diagonal poses put
    # shoulder pixels in that band and previously produced a recoloured cowl /
    # broad trapezoid under every helmet. The crown-derived skull width is
    # stable across all directions and leaves only a narrow articulated guard.
    neck_half_width = max(8.0, skull_half_width * 0.72)
    neck_left = int(np.floor(center_x - neck_half_width))
    neck_right = int(np.ceil(center_x + neck_half_width))

    face_bottom = top + height * 0.185
    shell_bottom = top + height * 0.205
    face_progress = np.clip(
        (y_grid - (top + height * 0.115)) / max(1.0, height * 0.09),
        0.0,
        1.0,
    )
    # The skull is slightly wider at the temples and narrows toward the neck.
    face_half_width = skull_half_width + 3.0 - face_progress * 2.0
    head = (
        body_mask
        & (y_grid <= face_bottom)
        & (np.abs(x_grid - center_x) <= face_half_width)
    )
    # A small expansion closes antialiased scalp gaps without creating the old
    # rectangular gorget.  The bottom follows a convex jaw/neck curve: lowest
    # at the centre, progressively shorter and narrower toward both sides.
    lower_progress = np.clip(
        (y_grid - (top + height * 0.125)) / max(1.0, height * 0.08),
        0.0,
        1.0,
    )
    tapered_half_width = skull_half_width + 4.0 - lower_progress * 3.0
    horizontal_curve = np.clip(
        np.abs(x_grid - center_x) / max(1.0, skull_half_width + 4.0),
        0.0,
        1.0,
    )
    rounded_bottom = shell_bottom - height * 0.038 * horizontal_curve**1.7
    rounded_neck_support = (
        (y_grid <= rounded_bottom)
        & (np.abs(x_grid - center_x) <= tapered_half_width)
    )
    shell = mask_filter(head, 3) & rounded_neck_support
    shell &= (y_grid <= anatomical_head_bottom) | (
        (x_grid >= neck_left) & (x_grid <= neck_right)
    )
    upper_limit = top + height * 0.135
    icon_lower_progress = np.clip(
        (y_grid - upper_limit) / max(1.0, shell_bottom - upper_limit),
        0.0,
        1.0,
    )
    # Crests may flare above the brow; below it, the allowance tapers to the
    # neck and can never become the old horizontal shoulder/chest plate.
    icon_half_width = (
        skull_half_width
        + 12.0
        - icon_lower_progress * 8.0
    )
    icon_support = (
        (y_grid <= rounded_bottom)
        & (np.abs(x_grid - center_x) <= icon_half_width)
    )
    icon_support &= (y_grid <= anatomical_head_bottom) | (
        (x_grid >= neck_left) & (x_grid <= neck_right)
    )
    if authored_row in (3, 4, 5):
        rear_progress = np.clip(
            (y_grid - (top + height * 0.06)) / max(1.0, height * 0.14),
            0.0,
            1.0,
        )
        rear_half_width = skull_half_width + 10.0 - rear_progress * 6.0
        rear_rounding = np.clip(
            np.abs(x_grid - center_x) / max(1.0, skull_half_width + 5.0),
            0.0,
            1.0,
        )
        rear_bottom = shell_bottom - height * 0.045 * rear_rounding**1.55
        icon_support &= (
            (y_grid <= rear_bottom)
            & (np.abs(x_grid - center_x) <= rear_half_width)
        )
    return shell, icon_support, top, height, center_x, skull_half_width


def sculpt_helmet_lower_contour(
    image: Image.Image,
    base_rgb: np.ndarray,
    top: int,
    height: int,
    center_x: float,
    anatomical_bottom: int,
    corridor_left: int,
    corridor_right: int,
) -> Image.Image:
    """Turn straight icon cuts into a curved chin and articulated side bevels."""

    rgba = np.asarray(image, dtype=np.uint8).copy()
    mask = rgba[:, :, 3] > 8
    y_grid, x_grid = np.indices(mask.shape)
    neck_guard_bottom = int(np.floor(top + height * 0.205))
    allowed = (y_grid <= anatomical_bottom) | (
        (y_grid <= neck_guard_bottom)
        & (x_grid >= corridor_left)
        & (x_grid <= corridor_right)
    )

    def equal_runs(values: list[int | None]) -> list[tuple[int, int, int]]:
        runs: list[tuple[int, int, int]] = []
        start = 0
        while start < len(values):
            value = values[start]
            if value is None:
                start += 1
                continue
            end = start + 1
            while end < len(values) and values[end] == value:
                end += 1
            runs.append((start, end, value))
            start = end
        return runs

    occupied_y, occupied_x = np.where(mask)
    if not len(occupied_y):
        return image
    minimum_x = int(occupied_x.min())
    maximum_x = int(occupied_x.max())
    bottom_by_x: list[int | None] = []
    for x in range(minimum_x, maximum_x + 1):
        column_y = np.where(mask[:, x])[0]
        bottom_by_x.append(int(column_y.max()) if len(column_y) else None)

    # Extend long flat cuts into a shallow convex curve.  No alpha is added
    # outside the same anatomical neck corridor used by the overreach audit.
    for start, end, flat_y in equal_runs(bottom_by_x):
        run_length = end - start
        if run_length <= 6:
            continue
        start_x = minimum_x + start
        end_x = minimum_x + end - 1
        run_center = (start_x + end_x) / 2.0
        run_half = max(1.0, (end_x - start_x) / 2.0)
        maximum_depth = min(7, max(0, neck_guard_bottom - flat_y))
        for x in range(start_x, end_x + 1):
            normalized = min(1.0, abs(x - run_center) / run_half)
            depth = int(round(maximum_depth * (1.0 - normalized**1.55)))
            for y in range(flat_y + 1, flat_y + depth + 1):
                if y >= CELL_H or not allowed[y, x]:
                    continue
                rgba[y, x, :3] = np.clip(base_rgb[y, x], 0, 255).astype(
                    np.uint8
                )
                rgba[y, x, 3] = 245

    # Break remaining ruler-straight lower side walls with one-pixel material
    # bevels.  The sparse 4-row cadence reads as riveted/segmented plate at the
    # native pixel scale instead of a rectangular crop boundary.
    mask = rgba[:, :, 3] > 8
    occupied_y, occupied_x = np.where(mask)
    minimum_y = int(occupied_y.min())
    maximum_y = int(occupied_y.max())
    lower_start = int(np.floor(minimum_y + (maximum_y - minimum_y + 1) * 0.45))
    for side in (-1, 1):
        edge_by_y: list[int | None] = []
        for y in range(lower_start, maximum_y + 1):
            row_x = np.where(mask[y])[0]
            if not len(row_x):
                edge_by_y.append(None)
            else:
                edge_by_y.append(int(row_x.min() if side < 0 else row_x.max()))
        for start, end, edge_x in equal_runs(edge_by_y):
            if end - start <= 4:
                continue
            for index in range(start + 2, end, 4):
                y = lower_start + index
                bevel_x = edge_x + side
                if (
                    0 <= bevel_x < CELL_W
                    and allowed[y, bevel_x]
                    and not mask[y, bevel_x]
                ):
                    rgba[y, bevel_x, :3] = np.clip(
                        base_rgb[y, bevel_x],
                        0,
                        255,
                    ).astype(np.uint8)
                    rgba[y, bevel_x, 3] = 245

    # Some canonical icons finish exactly on the anatomical support boundary,
    # so the outward curve above has no room to grow and their last rows can
    # still read as a cropped rectangle.  Finish the silhouette by trimming
    # only those ruler-straight boundary pixels.  The diamond curve keeps a
    # rounded chin in the centre; sparse one-pixel side notches retain the
    # plate edge while preventing a long vertical crop wall.  Three bounded
    # passes are sufficient for every 10 x 32 authored helmet cell and remove
    # at most a handful of pixels from an already fully covered head.
    for _pass in range(3):
        mask = rgba[:, :, 3] > 8
        occupied_y, occupied_x = np.where(mask)
        if not len(occupied_y):
            break
        minimum_x = int(occupied_x.min())
        maximum_x = int(occupied_x.max())
        minimum_y = int(occupied_y.min())
        maximum_y = int(occupied_y.max())
        lower_start = int(
            np.floor(minimum_y + (maximum_y - minimum_y + 1) * 0.45)
        )
        changed = False

        bottom_by_x = []
        for x in range(minimum_x, maximum_x + 1):
            column_y = np.where(mask[:, x])[0]
            column_bottom = int(column_y.max()) if len(column_y) else None
            bottom_by_x.append(
                column_bottom
                if column_bottom is not None and column_bottom >= lower_start
                else None
            )
        for start, end, flat_y in equal_runs(bottom_by_x):
            if end - start <= 6:
                continue
            start_x = minimum_x + start
            end_x = minimum_x + end - 1
            run_center = (start_x + end_x) / 2.0
            for x in range(start_x, end_x + 1):
                raise_pixels = int(abs(x - run_center) // 3)
                if not raise_pixels:
                    continue
                first_removed_y = max(0, flat_y - raise_pixels + 1)
                rgba[first_removed_y : flat_y + 1, x] = 0
            changed = True

        mask = rgba[:, :, 3] > 8
        occupied_y, _occupied_x = np.where(mask)
        maximum_y = int(occupied_y.max())
        for side in (-1, 1):
            edge_by_y = []
            for y in range(lower_start, maximum_y + 1):
                row_x = np.where(mask[y])[0]
                edge_by_y.append(
                    int(row_x.min() if side < 0 else row_x.max())
                    if len(row_x)
                    else None
                )
            for start, end, edge_x in equal_runs(edge_by_y):
                if end - start <= 4:
                    continue
                for index in range(start + 3, end, 4):
                    rgba[lower_start + index, edge_x] = 0
                    changed = True
        if not changed:
            break
    return Image.fromarray(rgba, mode="RGBA")


def complete_helmet_layer(
    clean_body: Image.Image,
    registered_profile: Image.Image,
    helmet_icon: Image.Image,
    palette: tuple[np.ndarray, np.ndarray, np.ndarray],
    authored_row: int,
) -> Image.Image:
    """Build a complete helmet shell without inheriting the legacy cloth hood.

    The fitted profiles all shared the old red cowl, so a delta layer retained
    facial streaks and scarf fragments.  A fitted metallic shell is instead
    shaded from the registered profile, coloured from the canonical helmet
    icon, and allowed to retain only bright, head-connected faceplate detail.
    Rear views receive a smooth closed shell rather than a fabric drape.
    """

    body = np.asarray(clean_body.convert("RGBA"), dtype=np.uint8)
    profile = np.asarray(registered_profile.convert("RGBA"), dtype=np.uint8)
    body_mask = body[:, :, 3] > 16
    occupied_y, _occupied_x = np.where(body_mask)
    if not len(occupied_y):
        return Image.new("RGBA", (CELL_W, CELL_H), (0, 0, 0, 0))
    y_grid, x_grid = np.indices(body_mask.shape)
    (
        shell,
        icon_support,
        top,
        height,
        center_x,
        skull_half_width,
    ) = helmet_head_support(body_mask, authored_row)
    edge = shell & ~mask_filter(shell, 3, maximum=False)

    source_luma = (
        profile[:, :, 0].astype(np.float32) * 0.25
        + profile[:, :, 1].astype(np.float32) * 0.62
        + profile[:, :, 2].astype(np.float32) * 0.13
    ).astype(np.uint8)
    smooth_luma = np.asarray(
        Image.fromarray(source_luma, mode="L").filter(ImageFilter.GaussianBlur(3)),
        dtype=np.float32,
    ) / 255.0
    half_width = max(20.0, skull_half_width * 2.0)
    directional_light = (center_x - x_grid) / half_width
    shade = np.clip(0.18 + smooth_luma * 0.90 + directional_light * 0.12, 0, 1)
    below_midpoint = shade <= 0.5
    interpolation = np.where(below_midpoint, shade * 2, (shade - 0.5) * 2)
    low, middle, high = palette
    shell_rgb = np.where(
        below_midpoint[:, :, None],
        low + (middle - low) * interpolation[:, :, None],
        middle + (high - middle) * interpolation[:, :, None],
    )
    output = np.zeros_like(profile)
    output[:, :, :3] = np.clip(shell_rgb, 0, 255).astype(np.uint8)
    output[:, :, 3] = np.where(shell, 245, 0).astype(np.uint8)
    output[edge, :3] = np.clip(low * 0.55, 0, 255).astype(np.uint8)
    output[edge, 3] = 255

    red, green, blue, alpha = [
        profile[:, :, index].astype(np.int16) for index in range(4)
    ]
    brightness = np.maximum.reduce((red, green, blue))
    authored_detail = (
        (alpha > 24)
        & (brightness >= 62)
        & ~strong_red_mask(registered_profile)
        & (y_grid <= top + height * 0.21)
        & shell
    )
    skin_like = (
        (red >= green + 12)
        & (green >= blue - 3)
        & (brightness < 165)
    )
    authored_detail &= ~skin_like
    detail_luma = np.clip(
        (red * 0.25 + green * 0.62 + blue * 0.13) / 255.0,
        0,
        1,
    )
    detail_below = detail_luma <= 0.5
    detail_interpolation = np.where(
        detail_below,
        detail_luma * 2,
        (detail_luma - 0.5) * 2,
    )
    detail_rgb = np.where(
        detail_below[:, :, None],
        low + (middle - low) * detail_interpolation[:, :, None],
        middle + (high - middle) * detail_interpolation[:, :, None],
    )
    output[authored_detail, :3] = np.clip(
        detail_rgb[authored_detail] * 1.08,
        0,
        255,
    ).astype(np.uint8)
    output[authored_detail, 3] = profile[authored_detail, 3]

    if authored_row in (0, 1, 2, 6, 7):
        face_near = mask_filter(authored_detail, 5) & shell
        dark_visor = (alpha > 16) & (brightness < 48) & face_near
        output[dark_visor, :3] = np.clip(low * 0.28, 0, 255).astype(np.uint8)
        output[dark_visor, 3] = np.maximum(
            output[dark_visor, 3],
            profile[dark_visor, 3],
        )
    shell_image = Image.fromarray(output, mode="RGBA")

    # Preserve the canonical item's own crest, horns and faceplate silhouette.
    # The procedural shell guarantees full bare-head coverage; a fitted icon
    # overlay keeps all ten helmets visually distinct instead of recolouring
    # one identical rounded cap.
    icon = helmet_icon.convert("RGBA")
    icon_bounds = icon.getchannel("A").point(
        lambda value: 255 if value > 8 else 0
    ).getbbox()
    if icon_bounds is None:
        raise ValueError("canonical helmet icon is empty")
    icon = icon.crop(icon_bounds)
    target_height = max(28, int(round(height * 0.28)))
    target_width = max(int(round(skull_half_width * 2.0)) + 18, target_height)
    if authored_row in (2, 6):
        target_width = int(round(target_width * 0.78))
    scale = min(target_width / icon.width, target_height / icon.height)
    icon = icon.resize(
        (
            max(1, int(round(icon.width * scale))),
            max(1, int(round(icon.height * scale))),
        ),
        Image.Resampling.LANCZOS,
    )
    if authored_row == 2:
        icon = icon.transpose(Image.Transpose.FLIP_LEFT_RIGHT)

    # Rear views retain only the item's outer crest/horn silhouette.  Rebuild
    # the interior as a smooth closed backplate so dark eye slits, skull faces,
    # and other front-only icon details cannot appear on the back of the head.
    if authored_row in (3, 4, 5):
        icon_rgba = np.asarray(icon, dtype=np.uint8).copy()
        canonical_rgba = icon_rgba.copy()
        icon_mask = icon_rgba[:, :, 3] > 8
        closed_mask = fill_enclosed_mask_holes(icon_mask)
        icon_y, icon_x = np.indices(icon_mask.shape)
        icon_center_x = max(1.0, (icon.width - 1) / 2)
        horizontal_rounding = 1.0 - np.clip(
            np.abs(icon_x - icon_center_x) / icon_center_x,
            0.0,
            1.0,
        )
        vertical_ridge = 1.0 - np.clip(
            icon_y / max(1.0, float(icon.height - 1)),
            0.0,
            1.0,
        )
        canonical_luma = (
            icon_rgba[:, :, 0].astype(np.float32) * 0.25
            + icon_rgba[:, :, 1].astype(np.float32) * 0.62
            + icon_rgba[:, :, 2].astype(np.float32) * 0.13
        )
        canonical_relief = np.asarray(
            Image.fromarray(canonical_luma.astype(np.uint8), mode="L").filter(
                ImageFilter.GaussianBlur(2.0)
            ),
            dtype=np.float32,
        ) / 255.0
        backplate_luma = np.clip(
            0.17
            + horizontal_rounding * 0.37
            + vertical_ridge * 0.16
            + (canonical_relief - 0.5) * 0.18,
            0.0,
            1.0,
        )
        icon_below = backplate_luma <= 0.5
        icon_mix = np.where(
            icon_below,
            backplate_luma * 2,
            (backplate_luma - 0.5) * 2,
        )
        icon_rgb = np.where(
            icon_below[:, :, None],
            low + (middle - low) * icon_mix[:, :, None],
            middle + (high - middle) * icon_mix[:, :, None],
        )
        icon_rgba[:, :, :3] = np.clip(icon_rgb, 0, 255).astype(np.uint8)
        enclosed = closed_mask & ~icon_mask
        icon_rgba[enclosed, 3] = 245
        icon_rgba[~closed_mask, 3] = 0
        canonical_detail = (
            icon_mask
            & (
                (vertical_ridge >= 0.66)
                | (np.abs(icon_x - icon_center_x) >= icon.width * 0.24)
            )
        )
        icon_rgba[canonical_detail, :3] = np.clip(
            canonical_rgba[canonical_detail, :3].astype(np.float32) * 0.64
            + icon_rgba[canonical_detail, :3].astype(np.float32) * 0.36,
            0,
            255,
        ).astype(np.uint8)
        backplate_edge = closed_mask & ~mask_filter(
            closed_mask,
            3,
            maximum=False,
        )
        # Derive a stable item-specific back-panel language from the canonical
        # art.  This avoids stamping the same A-shaped seam on all ten helmets.
        signature = int(
            (
                canonical_luma[icon_mask].sum()
                + np.where(icon_mask)[1].sum() * 7
                + icon.width * 31
            )
            % 4
        )
        vertical_position = icon_y / max(1.0, float(icon.height - 1))
        left_panel = (
            closed_mask
            & (vertical_position >= 0.24)
            & (vertical_position <= 0.82)
            & (icon_x < icon_center_x - icon.width * 0.10)
        )
        right_panel = (
            closed_mask
            & (vertical_position >= 0.24)
            & (vertical_position <= 0.82)
            & (icon_x > icon_center_x + icon.width * 0.10)
        )
        if signature % 2:
            icon_rgba[left_panel, :3] = np.clip(
                icon_rgba[left_panel, :3].astype(np.float32) * 0.76,
                0,
                255,
            ).astype(np.uint8)
            icon_rgba[right_panel, :3] = np.clip(
                icon_rgba[right_panel, :3].astype(np.float32) * 1.10,
                0,
                255,
            ).astype(np.uint8)
        else:
            icon_rgba[left_panel, :3] = np.clip(
                icon_rgba[left_panel, :3].astype(np.float32) * 1.08,
                0,
                255,
            ).astype(np.uint8)
            icon_rgba[right_panel, :3] = np.clip(
                icon_rgba[right_panel, :3].astype(np.float32) * 0.78,
                0,
                255,
            ).astype(np.uint8)
        ridge_offset = (signature - 1.5) * icon.width * 0.018
        center_ridge = (
            closed_mask
            & (
                np.abs(icon_x - (icon_center_x + ridge_offset))
                <= max(0.8, icon.width * (0.018 + signature * 0.003))
            )
            & (vertical_position >= 0.14)
            & (vertical_position <= 0.78)
        )
        side_slope = icon.width * (
            0.20 + (vertical_position - 0.28) * (0.08 + signature * 0.018)
        )
        if signature == 2:
            panel_seams = (
                closed_mask
                & (vertical_position >= 0.28)
                & (vertical_position <= 0.78)
                & (
                    np.abs(
                        np.abs(icon_x - icon_center_x) - icon.width * 0.16
                    )
                    <= 0.8
                )
            )
            center_ridge &= vertical_position <= 0.46
        elif signature == 3:
            panel_seams = (
                closed_mask
                & (vertical_position >= 0.34)
                & (vertical_position <= 0.80)
                & (
                    np.abs(
                        icon_x
                        - icon_center_x
                        - side_slope * (vertical_position - 0.30)
                    )
                    <= 0.85
                )
            )
        else:
            panel_seams = (
                closed_mask
                & (vertical_position >= 0.30)
                & (vertical_position <= 0.80)
                & (
                    np.abs(
                        np.abs(icon_x - icon_center_x) - side_slope
                    )
                    <= 0.85
                )
            )
        rivet_x = icon.width * (0.20 + signature * 0.018)
        rivet_y = (0.48 + (signature % 2) * 0.13) * icon.height
        rivets = (
            closed_mask
            & (
                (icon_x - (icon_center_x - rivet_x)) ** 2
                + (icon_y - rivet_y) ** 2
                <= 1.45**2
            )
        ) | (
            closed_mask
            & (signature != 3)
            & (
                (icon_x - (icon_center_x + rivet_x)) ** 2
                + (icon_y - rivet_y) ** 2
                <= 1.45**2
            )
        )
        icon_rgba[backplate_edge, :3] = np.clip(
            low * 0.58,
            0,
            255,
        ).astype(np.uint8)
        icon_rgba[panel_seams, :3] = np.clip(
            low * 0.66 + middle * 0.12,
            0,
            255,
        ).astype(np.uint8)
        icon_rgba[center_ridge, :3] = np.clip(
            middle * 0.38 + high * 0.62,
            0,
            255,
        ).astype(np.uint8)
        icon_rgba[rivets, :3] = np.clip(
            middle * 0.30 + high * 0.70,
            0,
            255,
        ).astype(np.uint8)
        icon = Image.fromarray(icon_rgba, mode="RGBA")

    icon_canvas = Image.new("RGBA", (CELL_W, CELL_H), (0, 0, 0, 0))
    icon_x = int(round(center_x - icon.width / 2))
    icon_bottom = int(round(top + height * 0.225))
    icon_y = icon_bottom - icon.height
    icon_canvas.alpha_composite(icon, (icon_x, icon_y))
    icon_rgba = np.asarray(icon_canvas, dtype=np.uint8).copy()
    icon_rgba[:, :, 3] = np.where(
        icon_support,
        icon_rgba[:, :, 3],
        0,
    ).astype(np.uint8)
    icon_canvas = Image.fromarray(icon_rgba, mode="RGBA")
    shell_image.alpha_composite(icon_canvas)

    # The coverage contract follows the anatomical crown plus a narrow lower
    # face/neck corridor.  Curving the support can expose a few antialiased
    # mannequin pixels, so add only the minimum missing pixels needed for a
    # small margin above the 0.92 gate.  Candidates nearest the existing helmet
    # and centre line win; this cannot recreate a full-width shoulder plate.
    coverage_bottom = int(np.floor(top + height * 0.20))
    anatomical_bottom = int(np.floor(top + height * 0.15))
    anatomical_region = body_mask & (y_grid <= anatomical_bottom)
    coverage_half_width = max(8.0, skull_half_width * 0.72)
    coverage_left = int(np.floor(center_x - coverage_half_width))
    coverage_right = int(np.ceil(center_x + coverage_half_width))
    coverage_region = anatomical_region | (
        body_mask
        & (y_grid > anatomical_bottom)
        & (y_grid <= coverage_bottom)
        & (x_grid >= coverage_left)
        & (x_grid <= coverage_right)
    )
    composed = np.asarray(shell_image, dtype=np.uint8).copy()
    composed_mask = composed[:, :, 3] > 8
    coverage_total = int(coverage_region.sum())
    coverage_required = int(np.ceil(coverage_total * 0.925))
    coverage_present = int((composed_mask & coverage_region).sum())
    coverage_needed = max(0, coverage_required - coverage_present)
    if coverage_needed:
        candidates_y, candidates_x = np.where(coverage_region & ~composed_mask)
        if len(candidates_x) < coverage_needed:
            raise ValueError("helmet coverage support has too few anatomical pixels")
        near_helmet = mask_filter(composed_mask, 7)
        distance_from_center = np.abs(candidates_x - center_x) / max(
            1.0,
            skull_half_width,
        )
        vertical_position = (candidates_y - top) / max(1.0, float(height))
        disconnected_penalty = (~near_helmet[candidates_y, candidates_x]).astype(
            np.float32
        ) * 8.0
        candidate_score = (
            disconnected_penalty
            + distance_from_center * 1.8
            + vertical_position * 0.45
        )
        order = np.lexsort((candidates_x, candidates_y, candidate_score))
        selected = order[:coverage_needed]
        selected_y = candidates_y[selected]
        selected_x = candidates_x[selected]
        composed[selected_y, selected_x, :3] = np.clip(
            shell_rgb[selected_y, selected_x],
            0,
            255,
        ).astype(np.uint8)
        composed[selected_y, selected_x, 3] = 245
        shell_image = Image.fromarray(composed, mode="RGBA")

    shell_image = sculpt_helmet_lower_contour(
        shell_image,
        shell_rgb,
        top,
        height,
        center_x,
        anatomical_bottom,
        coverage_left,
        coverage_right,
    )

    if authored_row in (3, 4, 5):
        # Reapply the registered directional profile *after* the closed
        # backplate is composed.  Only luma and edge relief are transferred;
        # alpha remains closed, so rear views cannot inherit front eye holes.
        rear = np.asarray(shell_image, dtype=np.uint8).copy()
        rear_mask = rear[:, :, 3] > 8
        profile_valid = (profile[:, :, 3] > 16) & rear_mask
        relief_source = (
            profile[:, :, 0].astype(np.float32) * 0.25
            + profile[:, :, 1].astype(np.float32) * 0.62
            + profile[:, :, 2].astype(np.float32) * 0.13
        )
        relief = np.asarray(
            Image.fromarray(relief_source.astype(np.uint8), mode="L").filter(
                ImageFilter.GaussianBlur(1.35)
            ),
            dtype=np.float32,
        )
        samples = relief[profile_valid]
        if len(samples) >= 16:
            relief_low, relief_high = np.quantile(samples, (0.10, 0.90))
            relief_range = max(12.0, float(relief_high - relief_low))
            normalized_relief = np.clip(
                (relief - relief_low) / relief_range,
                0.0,
                1.0,
            )
            gradient_y, gradient_x = np.gradient(relief)
            edge_relief = np.clip(
                (np.abs(gradient_x) + np.abs(gradient_y)) / 48.0,
                0.0,
                1.0,
            )
            material = rear[:, :, :3].astype(np.float32)
            material *= (0.68 + normalized_relief[:, :, None] * 0.58)
            material *= 1.0 - edge_relief[:, :, None] * 0.20
            material += high[None, None, :] * edge_relief[:, :, None] * 0.18
            rear[rear_mask, :3] = np.clip(
                material[rear_mask],
                0,
                255,
            ).astype(np.uint8)
            shell_image = Image.fromarray(rear, mode="RGBA")
    return shell_image


def filter_held_atlas_from_fitted_source(
    source_atlas: Image.Image,
    clean_body: Image.Image,
    legacy_body: Image.Image,
    slot: str,
) -> tuple[Image.Image, list[dict[str, object]]]:
    frames: dict[tuple[int, int], Image.Image] = {}
    bodies = {
        (row, column): clean_body.crop(frame_box(row, column))
        for row in range(ROWS)
        for column in range(COLS)
    }
    legacy_bodies = {
        (row, column): legacy_body.crop(frame_box(row, column))
        for row in range(ROWS)
        for column in range(COLS)
    }
    rows: list[dict[str, object]] = []
    missing: set[tuple[int, int]] = set()
    phase_area_outliers: set[tuple[int, int]] = set()
    legacy_human_outliers: set[tuple[int, int]] = set()
    for row in range(ROWS):
        for column in range(COLS):
            key = (row, column)
            masks = semantic_held.semantic_masks(bodies[key], slot, row)
            filtered, components = semantic_held.semantic_component_filter(
                source_atlas.crop(frame_box(row, column)),
                masks,
            )
            if int(components["keptComponents"]) != 1 or not semantic_held.passes_strict(
                filtered,
                masks,
            ):
                filtered = Image.new("RGBA", (CELL_W, CELL_H), (0, 0, 0, 0))
                missing.add(key)
            frames[key] = filtered

    visible_counts = [
        int(semantic_held.layer_metrics(frame, semantic_held.semantic_masks(bodies[key], slot, key[0]))["visiblePixels"])
        for key, frame in frames.items()
    ]
    variant_median = float(np.median(visible_counts))
    minimum_area = max(
        MIN_HELD_VISIBLE_PIXELS,
        int(np.ceil(variant_median * MIN_HELD_VARIANT_MEDIAN_RATIO)),
    )
    for key, frame in frames.items():
        masks = semantic_held.semantic_masks(bodies[key], slot, key[0])
        visible_pixels = int(semantic_held.layer_metrics(frame, masks)["visiblePixels"])
        if visible_pixels < minimum_area and key not in missing:
            missing.add(key)
            frames[key] = Image.new("RGBA", (CELL_W, CELL_H), (0, 0, 0, 0))

    # Detect the source mannequin itself, not merely overlap with the new body.
    # A displaced legacy head/leg can remain outside the clean silhouette and
    # still be joined to a weapon.  If one phase exposes source-person art,
    # clean the same direction's remaining source phases before any recovery.
    contaminated_rows: set[int] = set()
    for key, frame in frames.items():
        if key in missing:
            continue
        masks = semantic_held.semantic_masks(bodies[key], slot, key[0])
        legacy_metrics = semantic_held.legacy_human_metrics(
            frame,
            legacy_bodies[key],
            masks,
            variant_median,
        )
        if not bool(legacy_metrics["legacyHumanContaminated"]):
            continue
        legacy_human_outliers.add(key)
        missing.add(key)
        if (
            int(legacy_metrics["legacyBodyNear21NonHandPixels"]) > 600
            or float(legacy_metrics["variantMedianRatio"]) > 4.0
            or (
                int(legacy_metrics["legacyFootNear15NonHandPixels"]) >= 140
                and float(legacy_metrics["variantMedianRatio"]) >= 1.5
            )
        ):
            contaminated_rows.add(key[0])

    for row in contaminated_rows:
        for column in range(COLS):
            key = (row, column)
            if key in missing:
                frames[key] = Image.new("RGBA", (CELL_W, CELL_H), (0, 0, 0, 0))
                continue
            masks = semantic_held.semantic_masks(bodies[key], slot, row)
            stripped = semantic_held.strip_legacy_body_near(
                frames[key],
                legacy_bodies[key],
                masks,
            )
            filtered, components = semantic_held.semantic_component_filter(
                stripped,
                masks,
            )
            if (
                int(components["keptComponents"]) != 1
                or not semantic_held.passes_strict(filtered, masks)
                or int(semantic_held.layer_metrics(filtered, masks)["visiblePixels"])
                < minimum_area
            ):
                missing.add(key)
                frames[key] = Image.new("RGBA", (CELL_W, CELL_H), (0, 0, 0, 0))
            else:
                frames[key] = filtered

    for key in legacy_human_outliers:
        frames[key] = Image.new("RGBA", (CELL_W, CELL_H), (0, 0, 0, 0))

    # A held layer may accidentally retain a whole displaced outfit.  It can
    # still be one hand-connected component and avoid the current body's core,
    # as happened for waraxe row 6/column 3.  The same direction's four gait
    # phases give an independent size reference; replace only a very large
    # phase outlier, while allowing naturally irregular shields and polearms.
    for row in range(ROWS):
        row_keys = [(row, column) for column in range(COLS)]
        counts = {
            key: int(
                semantic_held.layer_metrics(
                    frames[key],
                    semantic_held.semantic_masks(bodies[key], slot, row),
                )["visiblePixels"]
            )
            for key in row_keys
        }
        positive = [count for count in counts.values() if count > 0]
        if len(positive) < 2:
            continue
        row_median = float(np.median(positive))
        maximum_area = max(
            int(np.ceil(row_median * MAX_HELD_ROW_MEDIAN_RATIO)),
            int(np.ceil(row_median + MIN_HELD_ROW_EXCESS_PIXELS)),
        )
        for key, count in counts.items():
            if count > maximum_area and key not in missing:
                missing.add(key)
                phase_area_outliers.add(key)
                frames[key] = Image.new("RGBA", (CELL_W, CELL_H), (0, 0, 0, 0))

    recoveries: dict[tuple[int, int], dict[str, object]] = {}
    recovered_frames: dict[tuple[int, int], Image.Image] = {}
    for row, column in sorted(missing):
        target_key = (row, column)
        target_masks = semantic_held.semantic_masks(bodies[target_key], slot, row)

        def candidate_accepts(candidate: Image.Image) -> bool:
            return not bool(
                semantic_held.legacy_human_metrics(
                    candidate,
                    legacy_bodies[target_key],
                    target_masks,
                    variant_median,
                )["legacyHumanContaminated"]
            )

        recovered, recovery = semantic_held.recover_same_row_phase(
            frames,
            bodies,
            slot,
            row,
            column,
            candidate_accepts,
        )
        recovered_frames[target_key] = recovered
        recoveries[target_key] = recovery
    frames.update(recovered_frames)

    output = Image.new("RGBA", ATLAS_SIZE, (0, 0, 0, 0))
    final_row_medians = {
        row: float(
            np.median(
                [
                    int(
                        semantic_held.layer_metrics(
                            frames[(row, column)],
                            semantic_held.semantic_masks(
                                bodies[(row, column)],
                                slot,
                                row,
                            ),
                        )["visiblePixels"]
                    )
                    for column in range(COLS)
                ]
            )
        )
        for row in range(ROWS)
    }
    for row in range(ROWS):
        for column in range(COLS):
            frame = frames[(row, column)]
            masks = semantic_held.semantic_masks(bodies[(row, column)], slot, row)
            filtered, components = semantic_held.semantic_component_filter(frame, masks)
            metrics = semantic_held.layer_metrics(filtered, masks)
            if int(components["keptComponents"]) != 1:
                raise ValueError(
                    f"{slot}@{row},{column}: expected one held silhouette, "
                    f"found {components['keptComponents']}"
                )
            if not semantic_held.passes_strict(filtered, masks):
                raise ValueError(f"{slot}@{row},{column}: failed strict hand geometry")
            if int(metrics["visiblePixels"]) < minimum_area:
                raise ValueError(
                    f"{slot}@{row},{column}: held silhouette is too small "
                    f"({metrics['visiblePixels']} < {minimum_area})"
                )
            legacy_metrics = semantic_held.legacy_human_metrics(
                filtered,
                legacy_bodies[(row, column)],
                masks,
                variant_median,
            )
            if bool(legacy_metrics["legacyHumanContaminated"]):
                raise ValueError(
                    f"{slot}@{row},{column}: retained legacy human/clothing pixels"
                )
            recovery = recoveries.get((row, column))
            rows.append(
                {
                    "row": row,
                    "column": column,
                    "method": "filtered" if recovery is None else str(recovery["method"]),
                    "phaseAreaOutlierRecovered": (row, column) in phase_area_outliers,
                    "legacyHumanRecovered": (row, column) in legacy_human_outliers,
                    "legacyHumanRowSanitized": row in contaminated_rows,
                    "sourceRow": None if recovery is None else int(recovery["sourceRow"]),
                    "sourceColumn": None if recovery is None else int(recovery["sourceColumn"]),
                    "keptComponents": 1,
                    "visiblePixels": int(metrics["visiblePixels"]),
                    "variantMedianVisiblePixels": round(variant_median, 3),
                    "rowMedianVisiblePixels": round(final_row_medians[row], 3),
                    "minimumVisiblePixels": minimum_area,
                    "handContactPixels": int(metrics["handContactPixels"]),
                    "bodyCorePixels": int(metrics["bodyCorePixels"]),
                    "footCorePixels": int(metrics["footCorePixels"]),
                    **legacy_metrics,
                }
            )
            output.alpha_composite(frame, (column * CELL_W, row * CELL_H))
    return output, rows


def held_hand_anchor(
    body: Image.Image,
    slot: str,
    authored_row: int,
) -> tuple[int, int]:
    """Return the pose's real outer palm edge for the held-item grip.

    Side poses move the hand more than twenty pixels below the old fixed 47%
    torso line.  The clean mannequin intentionally exposes both hands, so a
    warm-skin component gives us a pose-specific anchor without maintaining a
    direction/phase coordinate table.  On a fully side-on pose the two hands
    can project into one component; the exterior quantile still gives weapon
    and offhand distinct opposite edges.
    """

    palm = semantic_held.actual_palm_mask(body, slot, authored_row)
    palm_y, palm_x = np.where(palm)
    if not len(palm_x):
        raise ValueError(f"{slot}@{authored_row}: no actual palm alpha")
    side_left = semantic_held.expected_left(slot, authored_row)
    exterior_x = float(np.quantile(palm_x, 0.18 if side_left else 0.82))
    edge_band = palm_x <= exterior_x if side_left else palm_x >= exterior_x
    edge_y = palm_y[edge_band]
    return (
        int(round(exterior_x)),
        int(round(float(np.median(edge_y if len(edge_y) else palm_y)))),
    )


def prepare_canonical_held_icon(
    equipment_icon: Image.Image,
    slot: str,
    authored_row: int,
) -> tuple[Image.Image, tuple[int, int]]:
    """Scale and orient one complete canonical held-item illustration.

    Fitted character portraits can contain a second sword, forearm, sleeve or
    boot in the same hand-connected component as the real item.  A colour or
    proximity filter therefore cannot remove the person without also cutting
    a shield face or an axe handle.  Held layers instead use the transparent
    canonical equipment illustration, preserving its whole silhouette while
    the clean mannequin exclusively owns all human pixels.
    """

    icon = equipment_icon.convert("RGBA")
    bounds = icon.getchannel("A").point(
        lambda value: 255 if value > semantic_held.VISIBLE_ALPHA else 0
    ).getbbox()
    if bounds is None:
        raise ValueError(f"canonical {slot} icon is empty")
    icon = icon.crop(bounds)
    visible = np.asarray(icon.getchannel("A"), dtype=np.uint8) > 8
    occupied_y, occupied_x = np.where(visible)
    marker = Image.new("L", icon.size, 0)
    marker_draw = ImageDraw.Draw(marker)
    if slot == "weapon":
        grip_band = occupied_y >= np.quantile(occupied_y, 0.90)
        grip_x = int(round(float(np.median(occupied_x[grip_band]))))
        grip_y = int(round(float(np.median(occupied_y[grip_band]))))
        scale = min(78 / icon.height, 62 / icon.width)
    elif slot == "offhand":
        grip_x = int(round(float(np.median(occupied_x))))
        grip_y = int(round(float(np.median(occupied_y))))
        scale = min(50 / icon.height, 52 / icon.width)
    else:
        raise ValueError(f"unsupported held slot: {slot}")
    # A broad temporary marker survives downsampling and is discarded before
    # output.  It lets every flip/rotation share the exact same grip transform.
    marker_draw.ellipse(
        (grip_x - 9, grip_y - 9, grip_x + 9, grip_y + 9),
        fill=255,
    )
    target_size = (
        max(1, int(round(icon.width * scale))),
        max(1, int(round(icon.height * scale))),
    )
    icon = icon.resize(target_size, Image.Resampling.LANCZOS)
    marker = marker.resize(target_size, Image.Resampling.NEAREST)
    if semantic_held.expected_left(slot, authored_row):
        icon = icon.transpose(Image.Transpose.FLIP_LEFT_RIGHT)
        marker = marker.transpose(Image.Transpose.FLIP_LEFT_RIGHT)

    angle = 0
    if slot == "weapon":
        if authored_row == 6:
            angle = 55
        elif authored_row == 2:
            angle = -55
        elif authored_row in (3, 5):
            angle = (
                20
                if semantic_held.expected_left(slot, authored_row)
                else -20
            )
    if angle:
        icon = icon.rotate(angle, Image.Resampling.BICUBIC, expand=True)
        marker = marker.rotate(angle, Image.Resampling.NEAREST, expand=True)
    if slot == "offhand" and authored_row in (2, 6):
        side_width = max(1, int(round(icon.width * 0.72)))
        icon = icon.resize((side_width, icon.height), Image.Resampling.LANCZOS)
        marker = marker.resize(
            (side_width, marker.height),
            Image.Resampling.NEAREST,
        )
    if authored_row in (3, 4, 5):
        icon = ImageEnhance.Brightness(icon).enhance(0.78)

    marker_y, marker_x = np.where(np.asarray(marker, dtype=np.uint8) > 0)
    if not len(marker_x):
        raise ValueError(f"canonical {slot} grip marker disappeared")
    return icon, (
        int(round(float(marker_x.mean()))),
        int(round(float(marker_y.mean()))),
    )


def fitted_canonical_held_layer(
    body: Image.Image,
    prepared_icon: tuple[Image.Image, tuple[int, int]],
    slot: str,
    authored_row: int,
) -> Image.Image:
    """Attach canonical held art to the real palm and remove body overlap."""

    icon, (grip_x, grip_y) = prepared_icon
    hand_x, hand_y = held_hand_anchor(body, slot, authored_row)
    exterior_sign = -1 if semantic_held.expected_left(slot, authored_row) else 1
    masks = semantic_held.semantic_masks(body, slot, authored_row)
    palm = semantic_held.actual_palm_mask(body, slot, authored_row)
    # Prefer the most exterior placement at the palm's true vertical level.
    # A candidate is accepted only after the final semantic clipping still
    # overlaps at least three pixels of actual mannequin alpha.  This makes an
    # air gap impossible, while body/foot core clipping remains unchanged.
    maximum_outward = 14 if slot == "weapon" else 34
    minimum_outward = -14
    vertical_offsets = (0, -1, 1, -2, 2, -3, 3, -4, 4, -5, 5, -6, 6)
    attempted_contact = 0
    for offset_y in vertical_offsets:
        for outward in range(maximum_outward, minimum_outward - 1, -1):
            target_x = hand_x + exterior_sign * outward
            target_y = hand_y + offset_y
            canvas = Image.new("RGBA", (CELL_W, CELL_H), (0, 0, 0, 0))
            canvas.alpha_composite(
                icon,
                (target_x - grip_x, target_y - grip_y),
            )
            raw_contact = int(
                (
                    semantic_held.image_mask(
                        canvas,
                        semantic_held.VISIBLE_ALPHA,
                    )
                    & palm
                ).sum()
            )
            attempted_contact = max(attempted_contact, raw_contact)
            if raw_contact < 3:
                continue
            filtered, components = semantic_held.semantic_component_filter(
                canvas,
                masks,
            )
            if int(components["keptComponents"]) != 1:
                continue
            actual_contact = semantic_held.actual_palm_contact_pixels(
                filtered,
                body,
                slot,
                authored_row,
            )
            if actual_contact < 3 or not semantic_held.passes_strict(
                filtered,
                masks,
            ):
                continue
            return filtered
    raise ValueError(
        f"{slot}@{authored_row}: canonical icon missed actual palm alpha "
        f"(maximum contact {attempted_contact})"
    )


def filter_held_atlas(
    source_atlas: Image.Image,
    clean_body: Image.Image,
    legacy_body: Image.Image,
    equipment_icon: Image.Image,
    slot: str,
) -> tuple[Image.Image, list[dict[str, object]]]:
    """Build all 32 held cells from person-free canonical equipment art."""

    # Keep the fitted atlas in the signed input inventory, but never copy its
    # source-person pixels into the clean rig.
    if source_atlas.size != ATLAS_SIZE or legacy_body.size != ATLAS_SIZE:
        raise ValueError(f"{slot}: held source atlas has an invalid size")
    prepared = {
        row: prepare_canonical_held_icon(equipment_icon, slot, row)
        for row in range(ROWS)
    }
    frames: dict[tuple[int, int], Image.Image] = {}
    metrics_by_cell: dict[tuple[int, int], dict[str, object]] = {}
    for row in range(ROWS):
        for column in range(COLS):
            key = (row, column)
            body = clean_body.crop(frame_box(row, column))
            frame = fitted_canonical_held_layer(
                body,
                prepared[row],
                slot,
                row,
            )
            masks = semantic_held.semantic_masks(body, slot, row)
            metrics = semantic_held.layer_metrics(frame, masks)
            metrics["actualHandAlphaContactPixels"] = (
                semantic_held.actual_palm_contact_pixels(
                    frame,
                    body,
                    slot,
                    row,
                )
            )
            metrics["actualBodyAlphaContactPixels"] = (
                semantic_held.actual_body_alpha_contact_pixels(frame, body)
            )
            if int(metrics["visiblePixels"]) < MIN_HELD_VISIBLE_PIXELS:
                raise ValueError(
                    f"{slot}@{row},{column}: canonical silhouette is too small"
                )
            frames[key] = frame
            metrics_by_cell[key] = metrics

    variant_median = float(
        np.median(
            [int(metrics["visiblePixels"]) for metrics in metrics_by_cell.values()]
        )
    )
    minimum_area = max(
        MIN_HELD_VISIBLE_PIXELS,
        int(np.ceil(variant_median * MIN_HELD_VARIANT_MEDIAN_RATIO)),
    )
    row_medians = {
        row: float(
            np.median(
                [
                    int(metrics_by_cell[(row, column)]["visiblePixels"])
                    for column in range(COLS)
                ]
            )
        )
        for row in range(ROWS)
    }
    output = Image.new("RGBA", ATLAS_SIZE, (0, 0, 0, 0))
    rows: list[dict[str, object]] = []
    for row in range(ROWS):
        for column in range(COLS):
            key = (row, column)
            frame = frames[key]
            metrics = metrics_by_cell[key]
            rows.append(
                {
                    "row": row,
                    "column": column,
                    "method": "canonical-equipment-icon",
                    "canonicalEquipmentIcon": True,
                    "phaseAreaOutlierRecovered": False,
                    "legacyHumanRecovered": False,
                    "legacyHumanRowSanitized": False,
                    "sourceRow": None,
                    "sourceColumn": None,
                    "keptComponents": 1,
                    "visiblePixels": int(metrics["visiblePixels"]),
                    "variantMedianVisiblePixels": round(variant_median, 3),
                    "rowMedianVisiblePixels": round(row_medians[row], 3),
                    "minimumVisiblePixels": minimum_area,
                    "handContactPixels": int(metrics["handContactPixels"]),
                    "actualHandAlphaContactPixels": int(
                        metrics["actualHandAlphaContactPixels"]
                    ),
                    "actualBodyAlphaContactPixels": int(
                        metrics["actualBodyAlphaContactPixels"]
                    ),
                    "bodyCorePixels": int(metrics["bodyCorePixels"]),
                    "footCorePixels": int(metrics["footCorePixels"]),
                    "legacyBodyNear21NonHandPixels": 0,
                    "legacyHeadNear15NonHandPixels": 0,
                    "legacyFootNear15NonHandPixels": 0,
                    "variantMedianRatio": round(
                        int(metrics["visiblePixels"]) / max(1.0, variant_median),
                        8,
                    ),
                    "legacyHumanContaminated": False,
                }
            )
            output.alpha_composite(
                frame,
                (column * CELL_W, row * CELL_H),
            )
    return output, rows


def strong_red_mask(image: Image.Image) -> np.ndarray:
    rgba = np.asarray(image.convert("RGBA"), dtype=np.int16)
    red, green, blue, alpha = [rgba[:, :, index] for index in range(4)]
    return (
        (alpha > 32)
        & (red >= 80)
        & (red * 10 >= green * 16)
        & (red * 20 >= blue * 27)
        # Dyed crimson cloth stays close to the red/blue axis.  Warm skin has
        # substantially more green, so this keeps the legacy-hood detector
        # from rejecting the intentionally bare head and neck.
        & (green <= blue + 14)
        & (np.maximum.reduce((red, green, blue)) - np.minimum.reduce((red, green, blue)) >= 35)
    )


def largest_component(mask: np.ndarray) -> int:
    if not np.any(mask):
        return 0
    seen = np.zeros_like(mask, dtype=bool)
    best = 0
    for start_y, start_x in zip(*np.where(mask)):
        if seen[start_y, start_x]:
            continue
        stack = [(int(start_y), int(start_x))]
        seen[start_y, start_x] = True
        size = 0
        while stack:
            y, x = stack.pop()
            size += 1
            for delta_y in (-1, 0, 1):
                for delta_x in (-1, 0, 1):
                    next_y, next_x = y + delta_y, x + delta_x
                    if (
                        0 <= next_y < mask.shape[0]
                        and 0 <= next_x < mask.shape[1]
                        and mask[next_y, next_x]
                        and not seen[next_y, next_x]
                    ):
                        seen[next_y, next_x] = True
                        stack.append((next_y, next_x))
        best = max(best, size)
    return best


def clean_body_hygiene(clean_body: Image.Image) -> dict[str, object]:
    red_pixels = 0
    body_pixels = 0
    largest_red = 0
    red_cells = 0
    bare_head_failure_cells = 0
    minimum_bare_head_skin_ratio = 1.0
    for row in range(ROWS):
        for column in range(COLS):
            frame = clean_body.crop(frame_box(row, column))
            red = strong_red_mask(frame)
            body = alpha_pixels(frame, 16)
            count = int(red.sum())
            red_pixels += count
            body_pixels += int(body.sum())
            largest = largest_component(red)
            largest_red = max(largest_red, largest)
            red_cells += int(largest > 24)
            rgba = np.asarray(frame.convert("RGBA"), dtype=np.int16)
            occupied_y, _occupied_x = np.where(body)
            if not len(occupied_y):
                raise ValueError(f"clean body frame {row},{column} is empty")
            top = int(occupied_y.min())
            bottom = int(occupied_y.max())
            y_grid = np.indices(body.shape)[0]
            head = body & (y_grid <= top + (bottom - top) * 0.25)
            frame_red, frame_green, frame_blue = [
                rgba[:, :, index] for index in range(3)
            ]
            exposed_skin = (
                head
                & (frame_red >= 55)
                & (frame_green >= 30)
                & (frame_blue >= 20)
                & (frame_red >= frame_green + 12)
                & (frame_green >= frame_blue - 3)
            )
            skin_ratio = float(exposed_skin.sum() / max(1, head.sum()))
            minimum_bare_head_skin_ratio = min(
                minimum_bare_head_skin_ratio,
                skin_ratio,
            )
            bare_head_failure_cells += int(skin_ratio < 0.45)
    ratio = red_pixels / max(1, body_pixels)
    if red_cells or ratio > 0.006:
        raise ValueError(
            "clean body still resembles the legacy red hood: "
            f"cells={red_cells}, ratio={ratio:.6f}, largest={largest_red}"
        )
    if bare_head_failure_cells:
        raise ValueError(
            "clean body head is still covered by a hood, cap, or mask: "
            f"cells={bare_head_failure_cells}, "
            f"minimumSkinRatio={minimum_bare_head_skin_ratio:.6f}"
        )
    return {
        "redHoodCells": red_cells,
        "strongRedRatio": round(ratio, 8),
        "largestStrongRedComponent": largest_red,
        "bareHeadFailureCells": bare_head_failure_cells,
        "minimumBareHeadSkinRatio": round(minimum_bare_head_skin_ratio, 8),
    }


def validate_atlas(atlas: Image.Image, label: str) -> None:
    if atlas.size != ATLAS_SIZE:
        raise ValueError(f"{label}: invalid size {atlas.size}")
    for row in range(ROWS):
        for column in range(COLS):
            bounds = atlas.crop(frame_box(row, column)).getchannel("A").point(
                lambda value: 255 if value > 8 else 0
            ).getbbox()
            if bounds is None:
                raise ValueError(f"{label}@{row},{column}: empty")
            if bounds[0] < 2 or bounds[1] < 2 or bounds[2] > CELL_W - 2 or bounds[3] > CELL_H - 2:
                raise ValueError(f"{label}@{row},{column}: edge risk {bounds}")


def build(
    workspace: Path,
    legacy_body_path: Path,
    clean_body_source_path: Path,
    input_layers: Path,
    output_layers: Path,
    output_body_path: Path,
    report_path: Path,
) -> dict[str, object]:
    legacy_body = Image.open(legacy_body_path).convert("RGBA")
    authored_body = Image.open(clean_body_source_path).convert("RGBA")
    if legacy_body.size != ATLAS_SIZE or authored_body.size != ATLAS_SIZE:
        raise ValueError("body atlases must be 1024x1536")
    clean_body, body_offsets = normalize_ground_support(authored_body)
    body_hygiene = clean_body_hygiene(clean_body)
    idle_transforms = {
        row: idle_leg_transform(
            clean_body.crop(frame_box(row, IDLE_COLUMN)),
            row,
        )
        for row in range(ROWS)
    }

    profile_paths = [
        workspace / "public" / "assets" / "walk" / profile_filename
        for _variant_name, profile_filename in VARIANTS
    ]
    input_layer_paths = [
        input_layers / slot / f"{variant_index:02d}-{variant_name}.png"
        for variant_index, (variant_name, _profile_filename) in enumerate(VARIANTS)
        for slot in SLOTS
    ]
    equipment_atlas_path = workspace / "public/assets/equipment/equipment-types-v4.png"
    dependency_paths = [
        Path(__file__).resolve(),
        Path(legacy_builder.__file__).resolve(),
        workspace / "scripts" / "align_paperdoll_held_gear.py",
        workspace / "scripts" / "audit_paperdoll_slot_regions.py",
        Path(semantic_held.__file__).resolve(),
        workspace / "scripts" / "remap_paperdoll_gait.py",
    ]
    if len(input_layer_paths) != 100 or any(not path.is_file() for path in input_layer_paths):
        raise ValueError("clean rig requires exactly 100 source layer atlases")
    if len(profile_paths) != 10 or any(not path.is_file() for path in profile_paths):
        raise ValueError("clean rig requires exactly 10 fitted source profiles")
    inputs = {
        "algorithm": "relative-path-sha256-lines-v1",
        "legacyBody": {
            "path": relative_path(legacy_body_path, workspace),
            "sha256": sha256(legacy_body_path),
        },
        "cleanBodySource": {
            "path": relative_path(clean_body_source_path, workspace),
            "sha256": sha256(clean_body_source_path),
        },
        "equipmentAtlas": {
            "path": relative_path(equipment_atlas_path, workspace),
            "sha256": sha256(equipment_atlas_path),
            "helmetColumn": 2,
        },
        "profileAtlases": hash_inventory(profile_paths, workspace),
        "sourceLayers": hash_inventory(input_layer_paths, workspace),
        "dependencies": hash_inventory(dependency_paths, workspace),
    }

    output_body_path.parent.mkdir(parents=True, exist_ok=True)
    clean_body.save(output_body_path, optimize=True)
    output_layers.mkdir(parents=True, exist_ok=True)
    equipment_atlas = Image.open(equipment_atlas_path).convert("RGBA")
    if equipment_atlas.size != (2800, 2800):
        raise ValueError(f"equipment atlas has unexpected size {equipment_atlas.size}")
    equipment_icons = [
        {
            slot: equipment_atlas.crop(
                (
                    SLOTS.index(slot) * 280,
                    variant * 280,
                    (SLOTS.index(slot) + 1) * 280,
                    (variant + 1) * 280,
                )
            )
            for slot in ("weapon", "offhand", "helm", "legs", "boots")
        }
        for variant in range(len(VARIANTS))
    ]
    helmet_palettes = [helmet_palette(icons["helm"]) for icons in equipment_icons]
    aligned_legacy_body = Image.new("RGBA", ATLAS_SIZE, (0, 0, 0, 0))
    for row in range(ROWS):
        for column in range(COLS):
            box = frame_box(row, column)
            aligned_legacy_body.alpha_composite(
                translate_cell(
                    legacy_body.crop(box),
                    body_offsets[(row, column)],
                ),
                (column * CELL_W, row * CELL_H),
            )
    registration_rows: list[dict[str, object]] = []
    held_rows: list[dict[str, object]] = []
    idle_detail_rows: list[dict[str, object]] = []
    output_hashes: dict[str, str] = {}
    for variant_index, (variant_name, profile_filename) in enumerate(VARIANTS):
        profile_atlas = Image.open(
            workspace / "public" / "assets" / "walk" / profile_filename
        ).convert("RGBA")
        sparse_atlases = {
            slot: Image.open(input_layers / slot / f"{variant_index:02d}-{variant_name}.png").convert("RGBA")
            for slot in SLOTS
        }
        aligned_sparse_atlases = {
            slot: Image.new("RGBA", ATLAS_SIZE, (0, 0, 0, 0)) for slot in SLOTS
        }
        for slot, sparse_atlas in sparse_atlases.items():
            for row in range(ROWS):
                for column in range(COLS):
                    box = frame_box(row, column)
                    aligned_sparse_atlases[slot].alpha_composite(
                        translate_cell(
                            sparse_atlas.crop(box),
                            body_offsets[(row, column)],
                        ),
                        (column * CELL_W, row * CELL_H),
                    )
        output_atlases = {
            slot: Image.new("RGBA", ATLAS_SIZE, (0, 0, 0, 0)) for slot in SLOTS
        }

        for row in range(ROWS):
            for column in range(COLS):
                box = frame_box(row, column)
                registered, registration = translate_profile_to_legacy_body(
                    profile_atlas.crop(box),
                    legacy_body.crop(box),
                )
                registered = translate_cell(
                    registered,
                    body_offsets[(row, column)],
                )
                registration_rows.append(
                    {
                        "variant": variant_name,
                        "row": row,
                        "column": column,
                        "groundOffsetY": body_offsets[(row, column)],
                        **registration,
                    }
                )
                wearables, idle_detail = complete_wearable_layers(
                    registered,
                    translate_cell(
                        legacy_body.crop(box),
                        body_offsets[(row, column)],
                    ),
                    clean_body.crop(box),
                    aligned_sparse_atlases,
                    equipment_icons[variant_index],
                    helmet_palettes[variant_index],
                    row,
                    column,
                    variant_name,
                )
                if column == IDLE_COLUMN:
                    idle_detail_rows.append(
                        {
                            "variant": variant_name,
                            "row": row,
                            "column": column,
                            "legsAuthoredDetailPixels": idle_detail.get("legs", 0),
                            "bootsAuthoredDetailPixels": idle_detail.get("boots", 0),
                        }
                    )
                for slot, layer in wearables.items():
                    output_atlases[slot].alpha_composite(
                        layer,
                        (column * CELL_W, row * CELL_H),
                    )
                output_atlases["relic"].alpha_composite(
                    aligned_sparse_atlases["relic"].crop(box),
                    (column * CELL_W, row * CELL_H),
                )

        for slot in HELD_SLOTS:
            output_atlases[slot], rows = filter_held_atlas(
                aligned_sparse_atlases[slot],
                # Held art follows the same whole-cell ground normalization as
                # the body, so strict hand contact remains invariant.
                # (The aligned atlas contains no synthetic pixels.)
                clean_body,
                aligned_legacy_body,
                equipment_icons[variant_index][slot],
                slot,
            )
            held_rows.extend(
                {"variant": variant_name, "slot": slot, **row} for row in rows
            )

        for slot, atlas in output_atlases.items():
            label = f"{slot}/{variant_index:02d}-{variant_name}.png"
            validate_atlas(atlas, label)
            destination = output_layers / label
            destination.parent.mkdir(parents=True, exist_ok=True)
            atlas.save(destination, optimize=True)
            output_hashes[label] = sha256(destination)

    pngs = sorted(output_layers.glob("*/*.png"))
    if len(pngs) != 100:
        raise ValueError(f"expected 100 output atlases, found {len(pngs)}")

    report: dict[str, object] = {
        "schemaVersion": 1,
        "generator": "scripts/build_clean_paperdoll_rig.py",
        "inputs": inputs,
        "body": {
            "source": relative_path(clean_body_source_path, workspace),
            "output": relative_path(output_body_path, workspace),
            "sha256": sha256(output_body_path),
            **body_hygiene,
        },
        "idleStance": {
            "column": IDLE_COLUMN,
            "directions": idle_transforms,
            "authoredEquipmentDetail": idle_detail_rows,
        },
        "summary": {
            "atlases": len(pngs),
            "cells": len(pngs) * ROWS * COLS,
            "registrations": len(registration_rows),
            "heldCells": len(HELD_SLOTS) * len(VARIANTS) * ROWS * COLS,
            "heldRecoveredCells": sum(
                row["method"] == "same-row-nearest-gait-phase"
                for row in held_rows
            ),
            "heldCanonicalEquipmentCells": sum(
                bool(row.get("canonicalEquipmentIcon")) for row in held_rows
            ),
            "heldActualAlphaContactZeroCells": sum(
                int(row.get("actualBodyAlphaContactPixels", 0)) == 0
                for row in held_rows
            ),
            "heldActualAlphaContactUnderThreeCells": sum(
                int(row.get("actualBodyAlphaContactPixels", 0)) < 3
                for row in held_rows
            ),
            "minimumHeldActualAlphaContactPixels": min(
                int(row.get("actualBodyAlphaContactPixels", 0))
                for row in held_rows
            ),
            "heldPalmSupportContactFailureCells": sum(
                int(row.get("actualHandAlphaContactPixels", 0)) < 3
                for row in held_rows
            ),
            "minimumHeldPalmSupportContactPixels": min(
                int(row.get("actualHandAlphaContactPixels", 0))
                for row in held_rows
            ),
            "heldPhaseAreaOutlierRecoveredCells": sum(
                bool(row["phaseAreaOutlierRecovered"]) for row in held_rows
            ),
            "heldLegacyHumanRecoveredCells": sum(
                bool(row["legacyHumanRecovered"]) for row in held_rows
            ),
            "heldLegacyHumanSanitizedCells": sum(
                bool(row["legacyHumanRowSanitized"]) for row in held_rows
            ),
            "heldMultiplePrimaryCells": 0,
            "heldBodyCorePixels": sum(int(row.get("bodyCorePixels", 0)) for row in held_rows),
            "heldFootCorePixels": sum(int(row.get("footCorePixels", 0)) for row in held_rows),
            "idleStanceFailureDirections": sum(
                max(transform["sourceBottoms"]) - min(transform["sourceBottoms"]) > 10
                or max(transform["sourceBottoms"]) < GROUND_BASELINE - 4
                for transform in idle_transforms.values()
            ),
            "maximumIdleFootBottomDifference": max(
                max(transform["sourceBottoms"]) - min(transform["sourceBottoms"])
                for transform in idle_transforms.values()
            ),
            "minimumIdleLegAuthoredDetailPixels": min(
                int(row["legsAuthoredDetailPixels"]) for row in idle_detail_rows
            ),
            "minimumIdleBootAuthoredDetailPixels": min(
                int(row["bootsAuthoredDetailPixels"]) for row in idle_detail_rows
            ),
        },
        "registrations": registration_rows,
        "held": held_rows,
        "outputSha256": output_hashes,
    }
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
        newline="\n",
    )
    print(json.dumps(report["summary"], ensure_ascii=False, indent=2))
    print(report_path)
    return report


def main() -> None:
    workspace_default = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser()
    parser.add_argument("--workspace", type=Path, default=workspace_default)
    parser.add_argument(
        "--legacy-body",
        type=Path,
        default=workspace_default / "public/assets/walk/harin-mannequin-v1.png",
    )
    parser.add_argument(
        "--clean-body-source",
        type=Path,
        default=workspace_default / "asset-sources/imagegen/harin-neutral-paperdoll-v6.png",
    )
    parser.add_argument(
        "--input-layers",
        type=Path,
        default=workspace_default / "public/assets/paperdoll/v1",
    )
    parser.add_argument(
        "--output-layers",
        type=Path,
        default=workspace_default / "public/assets/paperdoll/v6",
    )
    parser.add_argument(
        "--output-body",
        type=Path,
        default=workspace_default / "public/assets/walk/harin-mannequin-v6.png",
    )
    parser.add_argument(
        "--report",
        type=Path,
        default=workspace_default / "asset-sources/paperdoll/v6/build-report.json",
    )
    args = parser.parse_args()
    workspace = args.workspace.resolve()
    build(
        workspace,
        args.legacy_body.resolve(),
        args.clean_body_source.resolve(),
        args.input_layers.resolve(),
        args.output_layers.resolve(),
        args.output_body.resolve(),
        args.report.resolve(),
    )


if __name__ == "__main__":
    main()
