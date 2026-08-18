"""Hard-gate the active clean paperdoll rig across every rendered pose."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter

import paperdoll_semantic_held as semantic_held
from build_clean_paperdoll_rig import (
    ATLAS_SIZE,
    CELL_H,
    CELL_W,
    COLS,
    HELD_SLOTS,
    IDLE_COLUMN,
    MAX_HELD_ROW_MEDIAN_RATIO,
    MIN_HELD_ROW_EXCESS_PIXELS,
    MIN_HELD_VARIANT_MEDIAN_RATIO,
    MIN_HELD_VISIBLE_PIXELS,
    ROWS,
    SLOTS,
    clean_body_hygiene,
    fitted_canonical_held_layer,
    frame_box,
    idle_leg_transform,
    largest_component,
    prepare_canonical_held_icon,
    strong_red_mask,
    translate_cell,
)
from remap_paperdoll_gait import (
    legacy_hood_remove_region,
    legacy_lower_cloth_remove_region,
)


DRAW_ORDER = (
    "relic",
    "offhand",
    "weapon",
    "legs",
    "boots",
    "armor",
    "belt",
    "shoulders",
    "gloves",
    "helm",
)

# A copied hood retains a connected run of the legacy texture.  Requiring a
# small connected run avoids misclassifying an intentionally red metal helmet
# or breastplate that happens to cross isolated legacy-red coordinates.
LEGACY_HOOD_COLOR_DELTA = 16
LEGACY_HOOD_MIN_COMPONENT_PIXELS = 4

# The broad portrait/icon base that previously shipped as part of a helmet sat
# over the shoulders while still satisfying head coverage.  Treat the upper
# 15% of the body silhouette as the anatomical head and only permit a narrow
# neck guard below it.  Crests and horns remain unrestricted above the head;
# four horizontal pixels plus a twelve-pixel antialiasing budget preserve a
# fitted gorget without allowing a shoulder-width plate to pass.
HELMET_ANATOMICAL_HEAD_BOTTOM_RATIO = 0.15
HELMET_HEAD_COVERAGE_BOTTOM_RATIO = 0.20
HELMET_NECK_GUARD_BOTTOM_RATIO = 0.205
MAX_HELMET_UPPER_TORSO_OVERREACH_PIXELS = 12

# A fitted helmet may be wide (notably the sealed hood), but its lower alpha
# contour must not be the rectangular crop/support used by the former icon
# compositor.  Ignore the upper 45% so horns and crests cannot affect this
# check.  A failure requires both a seven-pixel-or-longer flat bottom contour
# and five-pixel-or-longer vertical walls on both sides; this preserves curved
# wide hoods and small pixel-art steps while rejecting the shared tin-can box.
HELMET_LOWER_CONTOUR_START_RATIO = 0.45
MAX_HELMET_LOWER_FLAT_RUN_PIXELS = 6
MAX_HELMET_LOWER_VERTICAL_EDGE_RUN_PIXELS = 4

# Ignore tiny antialias sparkles in the hard gate, but reject any shoe, shin,
# or sash-sized component that is not supported by either animated limb.
LOWER_WEARABLE_MIN_DETACHED_FRAGMENT_PIXELS = 1
LOWER_WEARABLE_MIN_ANATOMICAL_CONTACT_PIXELS = 3
MINIMUM_BOOT_DETAIL_PIXELS_PER_FOOT = 64
BOOT_DETAIL_HIGH_FREQUENCY_DELTA = 10

# The source sash/tails can shift several pixels during registration. In the
# seven non-red families, reject only strongly crimson pixels within a widened
# pose-derived old-cloth footprint. This catches the topmost red glove/tail
# panels without mistaking the deliberately shaded armor/leg/boot coverage
# underlays for the old garment. Red-dominant item families are audited by
# geometry and exterior support instead of a colour ban.
LEGACY_LOWER_NON_RED_VARIANT_DILATION = 31
LEGACY_LOWER_EXTERIOR_BODY_DILATION = 9
RED_DOMINANT_VARIANTS = frozenset({"blood", "waraxe", "sealed"})
LEGACY_CLOTH_TIGHT_RED_MINIMUM = 88
LEGACY_CLOTH_TIGHT_RED_GREEN_DELTA = 35
LEGACY_CLOTH_TIGHT_RED_BLUE_DELTA = 24
LEGACY_CLOTH_TIGHT_RED_MINIMUM_CHROMA = 50
LEGACY_CLOTH_MIN_RESIDUAL_COMPONENT_PIXELS = 24

# A gauntlet may project beyond the arm by a few pixels, but a sword, shield or
# coat-tail sized component outside the pose-local forearm corridor is not
# glove art.  This is intentionally independent of the builder's owner mask.
GLOVE_SEMANTIC_MIN_FRAGMENT_PIXELS = 1
GLOVE_SEMANTIC_SUPPORT_DILATION = 17


def layer_pass(slot: str, runtime_direction: int) -> str:
    if slot == "relic":
        return "front"
    if slot == "weapon":
        return "rear" if 2 <= runtime_direction <= 5 else "front"
    if slot == "offhand":
        return "rear" if 4 <= runtime_direction <= 7 else "front"
    return "body"


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def atlas_digest(paths: list[Path], root: Path) -> str:
    payload = "".join(
        f"{path.relative_to(root).as_posix()}:{sha256(path)}\n" for path in sorted(paths)
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def red_cloth_mask(image: Image.Image) -> np.ndarray:
    return strong_red_mask(image)


def legacy_lower_cloth_residual_masks(
    image: Image.Image,
    legacy_region: np.ndarray,
    clean_body_near: np.ndarray,
) -> tuple[np.ndarray, np.ndarray]:
    """Return tight-crimson legacy-tail pixels and their exterior subset."""

    rgba = np.asarray(image.convert("RGBA"), dtype=np.uint8)
    layer_rgb = rgba[:, :, :3].astype(np.int32)
    red, green, blue = [layer_rgb[:, :, channel] for channel in range(3)]
    chroma = (
        np.maximum.reduce((red, green, blue))
        - np.minimum.reduce((red, green, blue))
    )
    cloth_red = (
        (red >= LEGACY_CLOTH_TIGHT_RED_MINIMUM)
        & (red >= green + LEGACY_CLOTH_TIGHT_RED_GREEN_DELTA)
        & (red >= blue + LEGACY_CLOTH_TIGHT_RED_BLUE_DELTA)
        & (chroma >= LEGACY_CLOTH_TIGHT_RED_MINIMUM_CHROMA)
    )
    layer_visible = rgba[:, :, 3] > 8
    candidate = layer_visible & legacy_region & cloth_red
    # Canonical celestial boots intentionally contain tiny crimson gem/metal
    # highlights in this region. The retired cloth tails form connected runs
    # of at least 24 pixels (the smallest known tail was 26); retain only those
    # garment-sized components so legitimate eight-pixel accents do not weaken
    # the old-garment regression gate.
    residual = np.zeros_like(candidate)
    for component_y, component_x in semantic_held.connected_components(candidate):
        if len(component_x) >= LEGACY_CLOTH_MIN_RESIDUAL_COMPONENT_PIXELS:
            residual[component_y, component_x] = True
    exterior = residual & ~clean_body_near
    return residual, exterior


def glove_semantic_fragment_metrics(
    body: Image.Image,
    layer: Image.Image,
    authored_row: int,
) -> dict[str, int]:
    """Count sword/shield/tail-sized pixels outside the actual arm corridor."""

    body_mask = visible(body, 16)
    occupied_y, occupied_x = np.where(body_mask)
    if not len(occupied_y):
        raise ValueError("empty body frame")
    top = int(occupied_y.min())
    bottom = int(occupied_y.max())
    height = max(1, bottom - top)
    center_x = float(np.median(occupied_x))
    half_width = max(1.0, (float(occupied_x.max()) - float(occupied_x.min())) / 2.0)
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
        semantic_held.actual_palm_mask(body, "weapon", authored_row)
        | semantic_held.actual_palm_mask(body, "offhand", authored_row)
    )
    support = np.asarray(
        Image.fromarray(
            ((forearms | actual_palms) * 255).astype(np.uint8),
            mode="L",
        ).filter(ImageFilter.MaxFilter(GLOVE_SEMANTIC_SUPPORT_DILATION)),
        dtype=np.uint8,
    ) > 0
    fragments = [
        len(component_x)
        for _component_y, component_x in semantic_held.connected_components(
            visible(layer) & ~support
        )
        if len(component_x) >= GLOVE_SEMANTIC_MIN_FRAGMENT_PIXELS
    ]
    return {
        "components": len(fragments),
        "pixels": sum(fragments),
        "maximumPixels": max(fragments, default=0),
    }


def helmet_skull_geometry(
    body_mask: np.ndarray,
) -> tuple[int, int, int, float, float]:
    occupied_y, _occupied_x = np.where(body_mask)
    if not len(occupied_y):
        raise ValueError("empty body frame")
    top = int(occupied_y.min())
    bottom = int(occupied_y.max())
    height = max(1, bottom - top)
    y_grid = np.indices(body_mask.shape)[0]
    crown = body_mask & (y_grid <= top + height * 0.125)
    crown_x = np.where(crown)[1]
    if len(crown_x) < 8:
        raise ValueError("body frame lacks a stable crown silhouette")
    center_x = float(np.median(crown_x))
    lower_x, upper_x = np.quantile(crown_x.astype(np.float32), (0.02, 0.98))
    skull_half_width = max(
        11.0,
        float(max(center_x - lower_x, upper_x - center_x)) + 1.5,
    )
    return top, bottom, height, center_x, skull_half_width


def body_regions(body: Image.Image) -> dict[str, np.ndarray]:
    mask = np.asarray(body.getchannel("A"), dtype=np.uint8) > 16
    ys, _xs = np.where(mask)
    if not len(ys):
        raise ValueError("empty body frame")
    top, _bottom, height, center_x, skull_half_width = helmet_skull_geometry(mask)
    y_grid, x_grid = np.indices(mask.shape)
    anatomical_head_bottom = int(
        np.floor(top + height * HELMET_ANATOMICAL_HEAD_BOTTOM_RATIO)
    )
    coverage_bottom = int(
        np.floor(top + height * HELMET_HEAD_COVERAGE_BOTTOM_RATIO)
    )
    anatomical_head = (
        mask
        & (y_grid <= anatomical_head_bottom)
        & (np.abs(x_grid - center_x) <= skull_half_width + 3.0)
    )
    neck_half_width = max(8.0, skull_half_width * 0.72)
    neck_corridor = (
        (y_grid > anatomical_head_bottom)
        & (y_grid <= coverage_bottom)
        & (x_grid >= int(np.floor(center_x - neck_half_width)))
        & (x_grid <= int(np.ceil(center_x + neck_half_width)))
    )
    # The former blanket top-20% region included upper-shoulder pixels and
    # rewarded the broad icon plate that this audit now forbids.  Cover the
    # anatomical skull plus only the lower face/neck corridor instead.
    helmet_head = anatomical_head | (mask & neck_corridor)
    return {
        "body": mask,
        "head": helmet_head,
        "torso": mask & (y_grid >= top + height * 0.25) & (y_grid <= top + height * 0.64),
        "feet": mask & (y_grid >= top + height * 0.78),
    }


def visible(image: Image.Image, threshold: int = 8) -> np.ndarray:
    return np.asarray(image.getchannel("A"), dtype=np.uint8) > threshold


def lower_wearable_detached_fragment_metrics(
    body: Image.Image,
    layer: Image.Image,
    slot: str,
) -> dict[str, int]:
    """Independently count sizeable lower-layer pieces unsupported by anatomy."""

    body_mask = visible(body, 16)
    occupied_y, _occupied_x = np.where(body_mask)
    if not len(occupied_y):
        raise ValueError("empty body frame")
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
    support = np.asarray(
        Image.fromarray((anatomy * 255).astype(np.uint8), mode="L").filter(
            ImageFilter.MaxFilter(dilation_size)
        ),
        dtype=np.uint8,
    ) > 0
    detached = [
        len(component_x)
        for component_y, component_x in semantic_held.connected_components(
            visible(layer)
        )
        if len(component_x) >= LOWER_WEARABLE_MIN_DETACHED_FRAGMENT_PIXELS
        and int(support[component_y, component_x].sum())
        < min(LOWER_WEARABLE_MIN_ANATOMICAL_CONTACT_PIXELS, len(component_x))
    ]
    return {
        "components": len(detached),
        "pixels": sum(detached),
        "maximumPixels": max(detached, default=0),
    }


def exclusive_boot_regions(body: Image.Image) -> list[np.ndarray]:
    """Independently split the visible boot band between two planted feet."""

    body_mask = visible(body, 16)
    occupied_y, _occupied_x = np.where(body_mask)
    if not len(occupied_y):
        raise ValueError("empty body frame")
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
    distance_maps = [
        (y_grid - float(seed_y.mean())) ** 2
        + (x_grid - float(seed_x.mean())) ** 2
        for seed_y, seed_x in seeds
    ]
    owner = np.argmin(np.stack(distance_maps, axis=0), axis=0)
    boot_band = body_mask & (y_grid >= top + height * 0.755)
    expanded_band = np.asarray(
        Image.fromarray((boot_band * 255).astype(np.uint8), mode="L").filter(
            ImageFilter.MaxFilter(3)
        ),
        dtype=np.uint8,
    ) > 0
    regions = [expanded_band & (owner == index) for index in range(2)]
    return regions if all(int(region.sum()) >= 24 for region in regions) else []


def boot_per_foot_detail_metrics(
    body: Image.Image,
    layer: Image.Image,
) -> dict[str, object]:
    """Measure real high-frequency item detail independently on both feet."""

    regions = exclusive_boot_regions(body)
    if not regions:
        return {"separated": False, "counts": []}
    rgba = np.asarray(layer.convert("RGBA"), dtype=np.int16)
    blurred = np.asarray(
        layer.convert("RGBA").filter(ImageFilter.GaussianBlur(2.0)),
        dtype=np.int16,
    )
    rgb_delta = np.max(np.abs(rgba[:, :, :3] - blurred[:, :, :3]), axis=2)
    detail = (
        (rgba[:, :, 3] > 8)
        & (rgb_delta >= BOOT_DETAIL_HIGH_FREQUENCY_DELTA)
    )
    return {
        "separated": True,
        "counts": [int((detail & region).sum()) for region in regions],
    }


def ratio(signal: np.ndarray, region: np.ndarray) -> float:
    return float(np.logical_and(signal, region).sum() / max(1, region.sum()))


def helmet_upper_torso_overreach_mask(
    body: Image.Image,
    helmet_mask: np.ndarray,
) -> np.ndarray:
    """Return helmet pixels that extend below the head outside its neck corridor."""

    body_mask = visible(body, 16)
    ys, _xs = np.where(body_mask)
    if not len(ys):
        raise ValueError("empty body frame")
    top, _bottom, height, center_x, skull_half_width = helmet_skull_geometry(
        body_mask
    )
    y_grid, x_grid = np.indices(body_mask.shape)
    head_bottom = int(
        np.floor(top + height * HELMET_ANATOMICAL_HEAD_BOTTOM_RATIO)
    )
    neck_guard_bottom = int(
        np.floor(top + height * HELMET_NECK_GUARD_BOTTOM_RATIO)
    )
    neck_half_width = max(8.0, skull_half_width * 0.72)
    corridor_left = max(
        0,
        int(np.floor(center_x - neck_half_width)),
    )
    corridor_right = min(
        body_mask.shape[1] - 1,
        int(np.ceil(center_x + neck_half_width)),
    )
    neck_corridor = (
        (y_grid > head_bottom)
        & (y_grid <= neck_guard_bottom)
        & (x_grid >= corridor_left)
        & (x_grid <= corridor_right)
    )
    allowed_support = (y_grid <= head_bottom) | neck_corridor
    return helmet_mask & ~allowed_support


def longest_constant_contour_run(values: list[int | None]) -> int:
    """Return the longest adjacent run of one non-empty contour coordinate."""

    longest = 0
    current = 0
    previous: int | None = None
    for value in values:
        if value is not None and value == previous:
            current += 1
        else:
            current = 1 if value is not None else 0
        longest = max(longest, current)
        previous = value
    return longest


def helmet_lower_contour_metrics(helmet_mask: np.ndarray) -> dict[str, int]:
    """Measure flat bottom and box-wall runs in only the helmet's lower 55%."""

    ys, xs = np.where(helmet_mask)
    if not len(ys):
        raise ValueError("empty helmet frame")
    top = int(ys.min())
    bottom = int(ys.max())
    left = int(xs.min())
    right = int(xs.max())
    lower_start = int(
        np.floor(
            top + (bottom - top) * HELMET_LOWER_CONTOUR_START_RATIO
        )
    )

    bottom_contour: list[int | None] = []
    for x in range(left, right + 1):
        column_ys = np.where(helmet_mask[:, x])[0]
        column_bottom = int(column_ys.max()) if len(column_ys) else None
        # Columns belonging only to an upper crest/horn are not lower contour.
        bottom_contour.append(
            column_bottom
            if column_bottom is not None and column_bottom >= lower_start
            else None
        )

    left_contour: list[int | None] = []
    right_contour: list[int | None] = []
    for y in range(lower_start, bottom + 1):
        row_xs = np.where(helmet_mask[y])[0]
        left_contour.append(int(row_xs.min()) if len(row_xs) else None)
        right_contour.append(int(row_xs.max()) if len(row_xs) else None)

    return {
        "flatRunPixels": longest_constant_contour_run(bottom_contour),
        "leftVerticalRunPixels": longest_constant_contour_run(left_contour),
        "rightVerticalRunPixels": longest_constant_contour_run(right_contour),
    }


def audit(workspace: Path, manifest_path: Path, report_path: Path) -> dict[str, object]:
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    body_path = workspace / "public" / str(manifest["bodyPath"]).lstrip("/")
    layer_root = workspace / "public" / str(manifest["layerRoot"]).lstrip("/")
    legacy_body_path = workspace / "public/assets/walk/harin-mannequin-v1.png"
    body = Image.open(body_path).convert("RGBA")
    legacy_body = Image.open(legacy_body_path).convert("RGBA")
    equipment_atlas = Image.open(
        workspace / "public/assets/equipment/equipment-types-v4.png"
    ).convert("RGBA")
    if body.size != ATLAS_SIZE or legacy_body.size != ATLAS_SIZE:
        raise ValueError("paperdoll bodies must be 1024x1536")
    if equipment_atlas.size != (2800, 2800):
        raise ValueError("canonical equipment atlas must be 2800x2800")

    slot_names = tuple(str(slot) for slot in manifest["slots"])
    variant_names = tuple(str(name) for name in manifest["variantNames"])
    if slot_names != SLOTS or len(variant_names) != 10:
        raise ValueError("manifest slot or variant contract changed")

    build_report_path = workspace / str(
        manifest["assetIntegrity"]["silhouetteReferencePath"]
    )
    build_report = json.loads(build_report_path.read_text(encoding="utf-8"))
    offset_values: dict[tuple[int, int], set[int]] = {
        (row, column): set()
        for row in range(ROWS)
        for column in range(COLS)
    }
    for registration in build_report.get("registrations", []):
        key = (int(registration["row"]), int(registration["column"]))
        offset_values[key].add(int(registration["groundOffsetY"]))
    if any(len(values) != 1 for values in offset_values.values()):
        raise ValueError("build report does not define one ground offset per cell")
    ground_offsets = {key: next(iter(values)) for key, values in offset_values.items()}
    aligned_legacy_frames = {
        (row, column): translate_cell(
            legacy_body.crop(frame_box(row, column)),
            ground_offsets[(row, column)],
        )
        for row in range(ROWS)
        for column in range(COLS)
    }

    atlases: dict[tuple[str, int], Image.Image] = {}
    atlas_paths: list[Path] = []
    failures: list[str] = []
    edge_cells = 0
    empty_cells = 0
    for slot in slot_names:
        for variant, name in enumerate(variant_names):
            path = layer_root / slot / f"{variant:02d}-{name}.png"
            atlas_paths.append(path)
            atlas = Image.open(path).convert("RGBA")
            atlases[(slot, variant)] = atlas
            if atlas.size != ATLAS_SIZE:
                failures.append(f"wrong-size:{slot}/{variant:02d}")
                continue
            for row in range(ROWS):
                for column in range(COLS):
                    bounds = atlas.crop(frame_box(row, column)).getchannel("A").point(
                        lambda value: 255 if value > 8 else 0
                    ).getbbox()
                    if bounds is None:
                        empty_cells += 1
                        failures.append(f"empty:{slot}/{variant:02d}@{row},{column}")
                    elif (
                        bounds[0] < 2
                        or bounds[1] < 2
                        or bounds[2] > CELL_W - 2
                        or bounds[3] > CELL_H - 2
                    ):
                        edge_cells += 1
                        failures.append(f"edge:{slot}/{variant:02d}@{row},{column}")

    minimum_helmet_visual_variants = len(variant_names)
    minimum_helmet_alpha_variants = len(variant_names)
    minimum_idle_leg_visual_variants = len(variant_names)
    minimum_idle_boot_visual_variants = len(variant_names)
    for row in range(ROWS):
        for column in range(COLS):
            box = frame_box(row, column)
            helmet_frames = [
                atlases[("helm", variant)].crop(box)
                for variant in range(len(variant_names))
            ]
            minimum_helmet_visual_variants = min(
                minimum_helmet_visual_variants,
                len({hashlib.sha256(frame.tobytes()).digest() for frame in helmet_frames}),
            )
            minimum_helmet_alpha_variants = min(
                minimum_helmet_alpha_variants,
                len(
                    {
                        hashlib.sha256(frame.getchannel("A").tobytes()).digest()
                        for frame in helmet_frames
                    }
                ),
            )
        idle_box = frame_box(row, IDLE_COLUMN)
        for slot, label in (("legs", "leg"), ("boots", "boot")):
            variant_count = len(
                {
                    hashlib.sha256(
                        atlases[(slot, variant)].crop(idle_box).tobytes()
                    ).digest()
                    for variant in range(len(variant_names))
                }
            )
            if label == "leg":
                minimum_idle_leg_visual_variants = min(
                    minimum_idle_leg_visual_variants,
                    variant_count,
                )
            else:
                minimum_idle_boot_visual_variants = min(
                    minimum_idle_boot_visual_variants,
                    variant_count,
                )
    if minimum_helmet_visual_variants != len(variant_names):
        failures.append(
            f"helmet-visual-variants:{minimum_helmet_visual_variants}"
        )
    if minimum_helmet_alpha_variants < 8:
        failures.append(f"helmet-alpha-variants:{minimum_helmet_alpha_variants}")
    if minimum_idle_leg_visual_variants != len(variant_names):
        failures.append(
            f"idle-leg-visual-variants:{minimum_idle_leg_visual_variants}"
        )
    if minimum_idle_boot_visual_variants != len(variant_names):
        failures.append(
            f"idle-boot-visual-variants:{minimum_idle_boot_visual_variants}"
        )

    body_hygiene = clean_body_hygiene(body)
    minimum_boot_coverage = 1.0
    minimum_armor_coverage = 1.0
    minimum_full_coverage = 1.0
    minimum_helmet_coverage = 1.0
    helmet_upper_torso_overreach_cells = 0
    maximum_helmet_upper_torso_overreach_pixels = 0
    helmet_rectangular_lower_contour_failure_cells = 0
    helmet_rectangular_lower_contour_idle_failure_cells = 0
    maximum_helmet_lower_flat_run_pixels = 0
    maximum_helmet_lower_vertical_edge_run_pixels = 0
    lower_wearable_detached_fragment_failure_cells = 0
    lower_wearable_detached_leg_fragment_failure_cells = 0
    lower_wearable_detached_boot_fragment_failure_cells = 0
    lower_wearable_detached_fragment_components = 0
    lower_wearable_detached_fragment_pixels = 0
    maximum_lower_wearable_detached_fragment_pixels = 0
    wearable_legacy_lower_cloth_leak_cells = 0
    wearable_legacy_lower_cloth_leak_pixels = 0
    maximum_wearable_legacy_lower_cloth_leak_pixels = 0
    wearable_non_red_legacy_cloth_pixels = 0
    wearable_non_red_legacy_cloth_exterior_pixels = 0
    boot_separated_foot_cells = 0
    boot_merged_occlusion_fallback_cells = 0
    boot_per_foot_detail_failure_cells = 0
    minimum_boot_detail_pixels_per_foot = CELL_W * CELL_H
    glove_semantic_fragment_failure_cells = 0
    glove_semantic_fragment_components = 0
    glove_semantic_fragment_pixels = 0
    maximum_glove_semantic_fragment_pixels = 0
    legacy_red_pixels = 0
    legacy_red_largest = 0
    held_primary_missing = 0
    held_primary_multiple = 0
    held_contact_failures = 0
    held_actual_alpha_contact_zero_cells = 0
    held_actual_alpha_contact_under_three_cells = 0
    minimum_held_actual_alpha_contact_pixels = CELL_W * CELL_H
    held_palm_support_contact_failure_cells = 0
    minimum_held_palm_support_contact_pixels = CELL_W * CELL_H
    held_body_core_pixels = 0
    held_foot_core_pixels = 0
    held_canonical_mismatch_cells = 0
    held_canonical_missing_pixels = 0
    held_canonical_extra_pixels = 0
    held_source_person_residual_cells = 0
    maximum_held_source_person_residual_pixels = 0
    held_visible_by_variant: dict[tuple[str, int], list[int]] = {
        (slot, variant): []
        for slot in HELD_SLOTS
        for variant in range(len(variant_names))
    }
    held_visible_by_row: dict[tuple[str, int, int], list[int]] = {
        (slot, variant, row): []
        for slot in HELD_SLOTS
        for variant in range(len(variant_names))
        for row in range(ROWS)
    }

    canonical_prepared = {
        (slot, variant, row): prepare_canonical_held_icon(
            equipment_atlas.crop(
                (
                    SLOTS.index(slot) * 280,
                    variant * 280,
                    (SLOTS.index(slot) + 1) * 280,
                    (variant + 1) * 280,
                )
            ),
            slot,
            row,
        )
        for slot in HELD_SLOTS
        for variant in range(len(variant_names))
        for row in range(ROWS)
    }
    canonical_held_frames: dict[tuple[str, int, int, int], Image.Image] = {}
    wearable_slots = ("shoulders", "armor", "gloves", "belt", "legs", "boots")
    held_masks: dict[tuple[str, int, int, int], np.ndarray] = {}
    hand_union: dict[tuple[int, int], np.ndarray] = {}
    for row in range(ROWS):
        for column in range(COLS):
            box = frame_box(row, column)
            body_frame = body.crop(box)
            legacy_frame = aligned_legacy_frames[(row, column)]
            legacy_rgba = np.asarray(legacy_frame, dtype=np.int16)
            regions = body_regions(body_frame)
            hood = legacy_hood_remove_region(legacy_frame)
            legacy_red_hood = hood & red_cloth_mask(legacy_frame)
            legacy_lower_cloth = semantic_held.dilate(
                legacy_lower_cloth_remove_region(legacy_frame),
                LEGACY_LOWER_NON_RED_VARIANT_DILATION,
            )
            clean_body_near = semantic_held.dilate(
                visible(body_frame, 16),
                LEGACY_LOWER_EXTERIOR_BODY_DILATION,
            )
            hand_union[(row, column)] = (
                semantic_held.semantic_masks(body_frame, "weapon", row).hand.near_seven
                | semantic_held.semantic_masks(body_frame, "offhand", row).hand.near_seven
            )
            for variant in range(len(variant_names)):
                masks = {
                    slot: visible(atlases[(slot, variant)].crop(box)) for slot in slot_names
                }
                lower_fragment_cell_failure = False
                for lower_slot in ("legs", "boots"):
                    lower_fragment = lower_wearable_detached_fragment_metrics(
                        body_frame,
                        atlases[(lower_slot, variant)].crop(box),
                        lower_slot,
                    )
                    lower_slot_failure = bool(lower_fragment["components"])
                    lower_fragment_cell_failure |= lower_slot_failure
                    lower_wearable_detached_fragment_components += int(
                        lower_fragment["components"]
                    )
                    lower_wearable_detached_fragment_pixels += int(
                        lower_fragment["pixels"]
                    )
                    maximum_lower_wearable_detached_fragment_pixels = max(
                        maximum_lower_wearable_detached_fragment_pixels,
                        int(lower_fragment["maximumPixels"]),
                    )
                    if lower_slot == "legs":
                        lower_wearable_detached_leg_fragment_failure_cells += int(
                            lower_slot_failure
                        )
                    else:
                        lower_wearable_detached_boot_fragment_failure_cells += int(
                            lower_slot_failure
                        )
                lower_wearable_detached_fragment_failure_cells += int(
                    lower_fragment_cell_failure
                )
                boot_detail = boot_per_foot_detail_metrics(
                    body_frame,
                    atlases[("boots", variant)].crop(box),
                )
                if boot_detail["separated"]:
                    boot_separated_foot_cells += 1
                    detail_counts = [int(value) for value in boot_detail["counts"]]
                    minimum_boot_detail_pixels_per_foot = min(
                        minimum_boot_detail_pixels_per_foot,
                        *detail_counts,
                    )
                    boot_per_foot_detail_failure_cells += int(
                        min(detail_counts) < MINIMUM_BOOT_DETAIL_PIXELS_PER_FOOT
                    )
                else:
                    boot_merged_occlusion_fallback_cells += 1
                glove_fragment = glove_semantic_fragment_metrics(
                    body_frame,
                    atlases[("gloves", variant)].crop(box),
                    row,
                )
                glove_fragment_failure = bool(glove_fragment["components"])
                glove_semantic_fragment_failure_cells += int(
                    glove_fragment_failure
                )
                glove_semantic_fragment_components += int(
                    glove_fragment["components"]
                )
                glove_semantic_fragment_pixels += int(glove_fragment["pixels"])
                maximum_glove_semantic_fragment_pixels = max(
                    maximum_glove_semantic_fragment_pixels,
                    int(glove_fragment["maximumPixels"]),
                )
                for wearable_slot in wearable_slots:
                    if variant_names[variant] in RED_DOMINANT_VARIANTS:
                        legacy_leak = np.zeros((CELL_H, CELL_W), dtype=bool)
                        exterior_leak = legacy_leak
                    else:
                        legacy_leak, exterior_leak = (
                            legacy_lower_cloth_residual_masks(
                                atlases[(wearable_slot, variant)].crop(box),
                                legacy_lower_cloth,
                                clean_body_near,
                            )
                        )
                    wearable_non_red_legacy_cloth_pixels += int(
                        legacy_leak.sum()
                    )
                    wearable_non_red_legacy_cloth_exterior_pixels += int(
                        exterior_leak.sum()
                    )
                    leak_pixels = int(legacy_leak.sum())
                    wearable_legacy_lower_cloth_leak_cells += int(
                        leak_pixels > 0
                    )
                    wearable_legacy_lower_cloth_leak_pixels += leak_pixels
                    maximum_wearable_legacy_lower_cloth_leak_pixels = max(
                        maximum_wearable_legacy_lower_cloth_leak_pixels,
                        leak_pixels,
                    )
                minimum_boot_coverage = min(
                    minimum_boot_coverage,
                    ratio(masks["boots"], regions["feet"]),
                )
                minimum_armor_coverage = min(
                    minimum_armor_coverage,
                    ratio(masks["armor"], regions["torso"]),
                )
                minimum_helmet_coverage = min(
                    minimum_helmet_coverage,
                    ratio(masks["helm"], regions["head"]),
                )
                helmet_upper_torso_overreach_pixels = int(
                    helmet_upper_torso_overreach_mask(
                        body_frame,
                        masks["helm"],
                    ).sum()
                )
                maximum_helmet_upper_torso_overreach_pixels = max(
                    maximum_helmet_upper_torso_overreach_pixels,
                    helmet_upper_torso_overreach_pixels,
                )
                helmet_upper_torso_overreach_cells += int(
                    helmet_upper_torso_overreach_pixels
                    > MAX_HELMET_UPPER_TORSO_OVERREACH_PIXELS
                )
                helmet_contour = helmet_lower_contour_metrics(masks["helm"])
                helmet_flat_run = helmet_contour["flatRunPixels"]
                helmet_vertical_run = min(
                    helmet_contour["leftVerticalRunPixels"],
                    helmet_contour["rightVerticalRunPixels"],
                )
                maximum_helmet_lower_flat_run_pixels = max(
                    maximum_helmet_lower_flat_run_pixels,
                    helmet_flat_run,
                )
                maximum_helmet_lower_vertical_edge_run_pixels = max(
                    maximum_helmet_lower_vertical_edge_run_pixels,
                    helmet_vertical_run,
                )
                rectangular_lower_contour = (
                    helmet_flat_run > MAX_HELMET_LOWER_FLAT_RUN_PIXELS
                    and helmet_vertical_run
                    > MAX_HELMET_LOWER_VERTICAL_EDGE_RUN_PIXELS
                )
                helmet_rectangular_lower_contour_failure_cells += int(
                    rectangular_lower_contour
                )
                helmet_rectangular_lower_contour_idle_failure_cells += int(
                    rectangular_lower_contour and column == IDLE_COLUMN
                )
                minimum_full_coverage = min(
                    minimum_full_coverage,
                    ratio(
                        np.logical_or.reduce(
                            [masks[slot] for slot in slot_names if slot not in HELD_SLOTS]
                        ),
                        regions["body"],
                    ),
                )
                for slot in ("helm", "shoulders", "armor"):
                    layer = np.asarray(
                        atlases[(slot, variant)].crop(box),
                        dtype=np.int16,
                    )
                    leak = (
                        legacy_red_hood
                        & (layer[:, :, 3] > 8)
                        & (
                            np.max(
                                np.abs(layer[:, :, :3] - legacy_rgba[:, :, :3]),
                                axis=2,
                            )
                            <= LEGACY_HOOD_COLOR_DELTA
                        )
                    )
                    component = largest_component(leak)
                    if component >= LEGACY_HOOD_MIN_COMPONENT_PIXELS:
                        legacy_red_pixels += int(leak.sum())
                        legacy_red_largest = max(legacy_red_largest, component)

                for slot in HELD_SLOTS:
                    frame = atlases[(slot, variant)].crop(box)
                    semantic_masks = semantic_held.semantic_masks(body_frame, slot, row)
                    canonical_frame = fitted_canonical_held_layer(
                        body_frame,
                        canonical_prepared[(slot, variant, row)],
                        slot,
                        row,
                    )
                    canonical_held_frames[(slot, variant, row, column)] = (
                        canonical_frame
                    )
                    actual_visible = visible(frame)
                    canonical_visible = visible(canonical_frame)
                    missing_canonical = canonical_visible & ~actual_visible
                    extra_canonical = actual_visible & ~canonical_visible
                    missing_pixels = int(missing_canonical.sum())
                    extra_pixels = int(extra_canonical.sum())
                    held_canonical_missing_pixels += missing_pixels
                    held_canonical_extra_pixels += extra_pixels
                    held_canonical_mismatch_cells += int(
                        bool(missing_pixels or extra_pixels)
                    )
                    legacy_near = semantic_held.dilate(
                        semantic_held.image_mask(
                            legacy_frame,
                            semantic_held.BODY_ALPHA,
                        ),
                        21,
                    )
                    source_person_residual_pixels = int(
                        (extra_canonical & legacy_near).sum()
                    )
                    held_source_person_residual_cells += int(
                        source_person_residual_pixels > 0
                    )
                    maximum_held_source_person_residual_pixels = max(
                        maximum_held_source_person_residual_pixels,
                        source_person_residual_pixels,
                    )
                    _filtered, components = semantic_held.semantic_component_filter(
                        frame,
                        semantic_masks,
                    )
                    kept = int(components["keptComponents"])
                    held_primary_missing += int(kept == 0)
                    held_primary_multiple += int(kept > 1)
                    metrics = semantic_held.layer_metrics(frame, semantic_masks)
                    held_visible_by_variant[(slot, variant)].append(
                        int(metrics["visiblePixels"])
                    )
                    held_visible_by_row[(slot, variant, row)].append(
                        int(metrics["visiblePixels"])
                    )
                    held_contact_failures += int(int(metrics["handContactPixels"]) < 3)
                    palm_support_contact = semantic_held.actual_palm_contact_pixels(
                        frame,
                        body_frame,
                        slot,
                        row,
                    )
                    actual_alpha_contact = (
                        semantic_held.actual_body_alpha_contact_pixels(
                            frame,
                            body_frame,
                        )
                    )
                    minimum_held_actual_alpha_contact_pixels = min(
                        minimum_held_actual_alpha_contact_pixels,
                        actual_alpha_contact,
                    )
                    held_actual_alpha_contact_zero_cells += int(
                        actual_alpha_contact == 0
                    )
                    held_actual_alpha_contact_under_three_cells += int(
                        actual_alpha_contact < 3
                    )
                    minimum_held_palm_support_contact_pixels = min(
                        minimum_held_palm_support_contact_pixels,
                        palm_support_contact,
                    )
                    held_palm_support_contact_failure_cells += int(
                        palm_support_contact < 3
                    )
                    held_body_core_pixels += int(metrics["bodyCorePixels"])
                    held_foot_core_pixels += int(metrics["footCorePixels"])
                    held_masks[(slot, variant, row, column)] = visible(frame, 64)

    if minimum_boot_coverage < 0.95:
        failures.append(f"boots-foot-coverage:{minimum_boot_coverage:.6f}")
    if boot_per_foot_detail_failure_cells:
        failures.append(
            "boot-per-foot-item-detail:"
            f"cells={boot_per_foot_detail_failure_cells},"
            f"minimum={minimum_boot_detail_pixels_per_foot},"
            f"required={MINIMUM_BOOT_DETAIL_PIXELS_PER_FOOT}"
        )
    if lower_wearable_detached_fragment_failure_cells:
        failures.append(
            "lower-wearable-detached-fragments:"
            f"cells={lower_wearable_detached_fragment_failure_cells},"
            f"legs={lower_wearable_detached_leg_fragment_failure_cells},"
            f"boots={lower_wearable_detached_boot_fragment_failure_cells},"
            f"components={lower_wearable_detached_fragment_components},"
            f"pixels={lower_wearable_detached_fragment_pixels},"
            f"max={maximum_lower_wearable_detached_fragment_pixels}"
        )
    if wearable_legacy_lower_cloth_leak_cells:
        failures.append(
            "wearable-legacy-lower-cloth-leak:"
            f"cells={wearable_legacy_lower_cloth_leak_cells},"
            f"pixels={wearable_legacy_lower_cloth_leak_pixels},"
            f"max={maximum_wearable_legacy_lower_cloth_leak_pixels}"
        )
    if glove_semantic_fragment_failure_cells:
        failures.append(
            "glove-semantic-fragments:"
            f"cells={glove_semantic_fragment_failure_cells},"
            f"components={glove_semantic_fragment_components},"
            f"pixels={glove_semantic_fragment_pixels},"
            f"max={maximum_glove_semantic_fragment_pixels}"
        )
    if minimum_armor_coverage < 0.35:
        failures.append(f"armor-torso-coverage:{minimum_armor_coverage:.6f}")
    if minimum_full_coverage < 0.65:
        failures.append(f"full-body-coverage:{minimum_full_coverage:.6f}")
    if minimum_helmet_coverage < 0.92:
        failures.append(f"helmet-head-coverage:{minimum_helmet_coverage:.6f}")
    if helmet_upper_torso_overreach_cells:
        failures.append(
            "helmet-upper-torso-overreach:"
            f"cells={helmet_upper_torso_overreach_cells},"
            f"max={maximum_helmet_upper_torso_overreach_pixels},"
            f"limit={MAX_HELMET_UPPER_TORSO_OVERREACH_PIXELS}"
        )
    if helmet_rectangular_lower_contour_failure_cells:
        failures.append(
            "helmet-rectangular-lower-contour:"
            f"cells={helmet_rectangular_lower_contour_failure_cells},"
            f"idle={helmet_rectangular_lower_contour_idle_failure_cells},"
            f"flatMax={maximum_helmet_lower_flat_run_pixels},"
            f"verticalMax={maximum_helmet_lower_vertical_edge_run_pixels},"
            f"flatLimit={MAX_HELMET_LOWER_FLAT_RUN_PIXELS},"
            f"verticalLimit={MAX_HELMET_LOWER_VERTICAL_EDGE_RUN_PIXELS}"
        )
    if legacy_red_pixels or legacy_red_largest:
        failures.append(
            f"legacy-red-hood-leak:pixels={legacy_red_pixels},largest={legacy_red_largest}"
        )
    if held_primary_missing:
        failures.append(f"held-primary-missing:{held_primary_missing}")
    if held_primary_multiple:
        failures.append(f"held-primary-multiple:{held_primary_multiple}")
    if held_contact_failures:
        failures.append(f"held-contact-failures:{held_contact_failures}")
    if held_actual_alpha_contact_zero_cells:
        failures.append(
            "held-actual-alpha-contact-zero:"
            f"{held_actual_alpha_contact_zero_cells}"
        )
    if held_actual_alpha_contact_under_three_cells:
        failures.append(
            "held-actual-alpha-contact-under-three:"
            f"{held_actual_alpha_contact_under_three_cells}"
        )
    if held_palm_support_contact_failure_cells:
        failures.append(
            "held-palm-support-contact-failure:"
            f"{held_palm_support_contact_failure_cells}"
        )
    if held_body_core_pixels:
        failures.append(f"held-body-core-pixels:{held_body_core_pixels}")
    if held_foot_core_pixels:
        failures.append(f"held-foot-core-pixels:{held_foot_core_pixels}")
    if held_canonical_mismatch_cells:
        failures.append(
            "held-canonical-silhouette-mismatch:"
            f"cells={held_canonical_mismatch_cells},"
            f"missing={held_canonical_missing_pixels},"
            f"extra={held_canonical_extra_pixels}"
        )
    if held_source_person_residual_cells:
        failures.append(
            "held-source-person-residual:"
            f"cells={held_source_person_residual_cells},"
            f"max={maximum_held_source_person_residual_pixels}"
        )

    held_area_failure_cells = 0
    minimum_held_visible_pixels = CELL_W * CELL_H
    minimum_held_variant_median_ratio = 1.0
    for counts in held_visible_by_variant.values():
        median = float(np.median(counts))
        for count in counts:
            minimum_held_visible_pixels = min(minimum_held_visible_pixels, count)
            cell_ratio = count / max(1.0, median)
            minimum_held_variant_median_ratio = min(
                minimum_held_variant_median_ratio,
                cell_ratio,
            )
            held_area_failure_cells += int(
                count < MIN_HELD_VISIBLE_PIXELS
                or cell_ratio < MIN_HELD_VARIANT_MEDIAN_RATIO
            )
    if held_area_failure_cells:
        failures.append(f"held-area-failure-cells:{held_area_failure_cells}")

    held_phase_area_outlier_cells = 0
    maximum_held_row_median_ratio = 1.0
    for counts in held_visible_by_row.values():
        median = float(np.median(counts))
        maximum_area = max(
            int(np.ceil(median * MAX_HELD_ROW_MEDIAN_RATIO)),
            int(np.ceil(median + MIN_HELD_ROW_EXCESS_PIXELS)),
        )
        for count in counts:
            maximum_held_row_median_ratio = max(
                maximum_held_row_median_ratio,
                count / max(1.0, median),
            )
            held_phase_area_outlier_cells += int(count > maximum_area)
    if held_phase_area_outlier_cells:
        failures.append(
            f"held-phase-area-outlier-cells:{held_phase_area_outlier_cells}"
        )

    held_legacy_human_failure_cells = 0
    maximum_held_legacy_body_pixels = 0
    maximum_held_legacy_head_pixels = 0
    maximum_held_legacy_foot_pixels = 0
    for slot in HELD_SLOTS:
        for variant in range(len(variant_names)):
            variant_median = float(
                np.median(held_visible_by_variant[(slot, variant)])
            )
            for row in range(ROWS):
                for column in range(COLS):
                    box = frame_box(row, column)
                    body_frame = body.crop(box)
                    layer = atlases[(slot, variant)].crop(box)
                    semantic_masks = semantic_held.semantic_masks(
                        body_frame,
                        slot,
                        row,
                    )
                    legacy_metrics = semantic_held.legacy_human_metrics(
                        layer,
                        aligned_legacy_frames[(row, column)],
                        semantic_masks,
                        variant_median,
                        canonical_held_frames[(slot, variant, row, column)],
                    )
                    maximum_held_legacy_body_pixels = max(
                        maximum_held_legacy_body_pixels,
                        int(legacy_metrics["legacyBodyNear21NonHandPixels"]),
                    )
                    maximum_held_legacy_head_pixels = max(
                        maximum_held_legacy_head_pixels,
                        int(legacy_metrics["legacyHeadNear15NonHandPixels"]),
                    )
                    maximum_held_legacy_foot_pixels = max(
                        maximum_held_legacy_foot_pixels,
                        int(legacy_metrics["legacyFootNear15NonHandPixels"]),
                    )
                    held_legacy_human_failure_cells += int(
                        bool(legacy_metrics["legacyHumanContaminated"])
                    )
    if held_legacy_human_failure_cells:
        failures.append(
            "held-legacy-human-failure-cells:"
            f"{held_legacy_human_failure_cells}"
        )

    manifest_idle_column = int(manifest["frame"].get("idleColumn", -1))
    idle_stance_failure_directions = 0
    maximum_idle_foot_bottom_difference = 0
    idle_detail_rows = build_report.get("idleStance", {}).get(
        "authoredEquipmentDetail",
        [],
    )
    minimum_idle_leg_authored_detail_pixels = min(
        (
            int(row.get("legsAuthoredDetailPixels", 0))
            for row in idle_detail_rows
        ),
        default=0,
    )
    minimum_idle_boot_authored_detail_pixels = min(
        (
            int(row.get("bootsAuthoredDetailPixels", 0))
            for row in idle_detail_rows
        ),
        default=0,
    )
    expected_idle_detail_rows = len(variant_names) * ROWS
    if len(idle_detail_rows) != expected_idle_detail_rows:
        failures.append(
            "idle-equipment-detail-matrix:"
            f"{len(idle_detail_rows)}/{expected_idle_detail_rows}"
        )
    if minimum_idle_leg_authored_detail_pixels < 128:
        failures.append(
            "idle-leg-authored-detail:"
            f"{minimum_idle_leg_authored_detail_pixels}"
        )
    if minimum_idle_boot_authored_detail_pixels < 128:
        failures.append(
            "idle-boot-authored-detail:"
            f"{minimum_idle_boot_authored_detail_pixels}"
        )
    if manifest_idle_column != IDLE_COLUMN:
        failures.append(f"idle-column:{manifest_idle_column}")
        idle_stance_failure_directions = ROWS
    else:
        for row in range(ROWS):
            try:
                transform = idle_leg_transform(
                    body.crop(frame_box(row, manifest_idle_column)),
                    row,
                )
            except ValueError:
                idle_stance_failure_directions += 1
                continue
            bottoms = [int(value) for value in transform["sourceBottoms"]]
            difference = max(bottoms) - min(bottoms)
            maximum_idle_foot_bottom_difference = max(
                maximum_idle_foot_bottom_difference,
                difference,
            )
            idle_stance_failure_directions += int(
                difference > 10 or max(bottoms) < int(manifest["frame"]["groundBaseline"]) - 4
            )
    if idle_stance_failure_directions:
        failures.append(
            f"idle-stance-failure-directions:{idle_stance_failure_directions}"
        )

    pair_overlap_cells = 0
    maximum_pair_overlap = 0
    for weapon_variant in range(len(variant_names)):
        for offhand_variant in range(len(variant_names)):
            for row in range(ROWS):
                for column in range(COLS):
                    overlap = int(
                        (
                            held_masks[("weapon", weapon_variant, row, column)]
                            & held_masks[("offhand", offhand_variant, row, column)]
                            & ~hand_union[(row, column)]
                        ).sum()
                    )
                    maximum_pair_overlap = max(maximum_pair_overlap, overlap)
                    pair_overlap_cells += int(overlap > 4)
    if pair_overlap_cells:
        failures.append(f"held-pair-overlap-cells:{pair_overlap_cells}")

    builds = manifest["qaCompositeBuilds"]
    composite_cells = len(builds) * ROWS * COLS
    composite_render_failures = 0
    composite_slot_visibility_failure_cells = 0
    minimum_composite_slot_visible_difference_pixels = CELL_W * CELL_H
    composite_digest = hashlib.sha256()
    if len(builds) != 13 or composite_cells != 416:
        failures.append(f"composite-matrix:{len(builds)}/{composite_cells}")
    direction_rows = tuple(int(row) for row in manifest["frame"]["directionRows"])
    if sorted(direction_rows) != list(range(ROWS)):
        failures.append(f"composite-direction-map:{direction_rows}")
    else:
        for build_index, build in enumerate(builds):
            variants = tuple(int(value) for value in build.get("variants", []))
            if len(variants) != len(slot_names) or any(
                value < 0 or value >= len(variant_names) for value in variants
            ):
                composite_render_failures += ROWS * COLS
                failures.append(
                    f"composite-build-variants:{build_index}:{variants}"
                )
                continue
            variant_by_slot = dict(zip(slot_names, variants))
            for authored_row in range(ROWS):
                runtime_direction = direction_rows.index(authored_row)
                for column in range(COLS):
                    box = frame_box(authored_row, column)
                    body_frame = body.crop(box)
                    resolved: list[tuple[str, str, Image.Image]] = []
                    expected_support = np.asarray(
                        body_frame.getchannel("A"), dtype=np.uint8
                    ) > 0
                    for slot in DRAW_ORDER:
                        layer = atlases[(slot, variant_by_slot[slot])].crop(box)
                        resolved.append(
                            (slot, layer_pass(slot, runtime_direction), layer)
                        )
                        expected_support |= (
                            np.asarray(layer.getchannel("A"), dtype=np.uint8) > 0
                        )

                    def render_composite(
                        excluded_slot: str | None = None,
                    ) -> Image.Image:
                        rendered = Image.new(
                            "RGBA",
                            (CELL_W, CELL_H),
                            (0, 0, 0, 0),
                        )
                        for slot, pass_name, layer in resolved:
                            if pass_name == "rear" and slot != excluded_slot:
                                rendered.alpha_composite(layer)
                        rendered.alpha_composite(body_frame)
                        for slot, pass_name, layer in resolved:
                            if pass_name == "body" and slot != excluded_slot:
                                rendered.alpha_composite(layer)
                        for slot, pass_name, layer in resolved:
                            if pass_name == "front" and slot != excluded_slot:
                                rendered.alpha_composite(layer)
                        return rendered

                    composite = render_composite()

                    rgba = np.asarray(composite, dtype=np.uint8)
                    rendered_support = rgba[:, :, 3] > 0
                    visible_bounds = composite.getchannel("A").point(
                        lambda value: 255 if value > 8 else 0
                    ).getbbox()
                    body_rgba = np.asarray(body_frame, dtype=np.uint8)
                    color_difference = int(
                        np.any(rgba != body_rgba, axis=2).sum()
                    )
                    cell_failed = (
                        visible_bounds is None
                        or visible_bounds[0] < 2
                        or visible_bounds[1] < 2
                        or visible_bounds[2] > CELL_W - 2
                        or visible_bounds[3] > CELL_H - 2
                        or not np.array_equal(rendered_support, expected_support)
                        or color_difference < 32
                    )
                    composite_render_failures += int(cell_failed)
                    for slot in DRAW_ORDER:
                        without_slot = np.asarray(
                            render_composite(slot),
                            dtype=np.uint8,
                        )
                        visible_difference = int(
                            np.any(rgba != without_slot, axis=2).sum()
                        )
                        minimum_composite_slot_visible_difference_pixels = min(
                            minimum_composite_slot_visible_difference_pixels,
                            visible_difference,
                        )
                        composite_slot_visibility_failure_cells += int(
                            visible_difference < 4
                        )
                    composite_digest.update(
                        f"{build_index}/{authored_row}/{column}\n".encode("ascii")
                    )
                    composite_digest.update(rgba.tobytes())
    if composite_render_failures:
        failures.append(
            f"composite-render-failures:{composite_render_failures}"
        )
    if composite_slot_visibility_failure_cells:
        failures.append(
            "composite-slot-visibility-failure-cells:"
            f"{composite_slot_visibility_failure_cells}"
        )

    report: dict[str, object] = {
        "schemaVersion": 1,
        "generator": "scripts/audit_clean_paperdoll_rig.py",
        "rigVersion": manifest["version"],
        "assetRevision": manifest["assetRevision"],
        "passed": not failures,
        "summary": {
            "atlases": len(atlas_paths),
            "singleCells": len(atlas_paths) * ROWS * COLS,
            "heldCells": len(HELD_SLOTS) * len(variant_names) * ROWS * COLS,
            "heldPairCells": len(variant_names) ** 2 * ROWS * COLS,
            "compositeCells": composite_cells,
            "compositeRenderedCells": composite_cells
            - composite_render_failures,
            "compositeRenderFailureCells": composite_render_failures,
            "compositeSlotVisibilityFailureCells": (
                composite_slot_visibility_failure_cells
            ),
            "minimumCompositeSlotVisibleDifferencePixels": (
                minimum_composite_slot_visible_difference_pixels
            ),
            "compositeAggregateSha256": composite_digest.hexdigest(),
            "totalQaPoses": len(atlas_paths) * ROWS * COLS
            + len(variant_names) ** 2 * ROWS * COLS
            + composite_cells,
            "emptyCells": empty_cells,
            "edgeRiskCells": edge_cells,
            "legacyRedHoodPixels": legacy_red_pixels,
            "legacyRedHoodLargestComponent": legacy_red_largest,
            "minimumBootFootCoverage": round(minimum_boot_coverage, 8),
            "bootSeparatedFootCells": boot_separated_foot_cells,
            "bootMergedOcclusionFallbackCells": (
                boot_merged_occlusion_fallback_cells
            ),
            "bootPerFootDetailFailureCells": (
                boot_per_foot_detail_failure_cells
            ),
            "minimumBootDetailPixelsPerFoot": (
                minimum_boot_detail_pixels_per_foot
            ),
            "minimumRequiredBootDetailPixelsPerFoot": (
                MINIMUM_BOOT_DETAIL_PIXELS_PER_FOOT
            ),
            "lowerWearableDetachedFragmentFailureCells": (
                lower_wearable_detached_fragment_failure_cells
            ),
            "lowerWearableDetachedLegFragmentFailureCells": (
                lower_wearable_detached_leg_fragment_failure_cells
            ),
            "lowerWearableDetachedBootFragmentFailureCells": (
                lower_wearable_detached_boot_fragment_failure_cells
            ),
            "lowerWearableDetachedFragmentComponents": (
                lower_wearable_detached_fragment_components
            ),
            "lowerWearableDetachedFragmentPixels": (
                lower_wearable_detached_fragment_pixels
            ),
            "maximumLowerWearableDetachedFragmentPixels": (
                maximum_lower_wearable_detached_fragment_pixels
            ),
            "minimumLowerWearableDetachedFragmentPixels": (
                LOWER_WEARABLE_MIN_DETACHED_FRAGMENT_PIXELS
            ),
            "wearableLegacyLowerClothLeakCells": (
                wearable_legacy_lower_cloth_leak_cells
            ),
            "wearableLegacyLowerClothLeakPixels": (
                wearable_legacy_lower_cloth_leak_pixels
            ),
            "maximumWearableLegacyLowerClothLeakPixels": (
                maximum_wearable_legacy_lower_cloth_leak_pixels
            ),
            "wearableNonRedLegacyClothPixels": (
                wearable_non_red_legacy_cloth_pixels
            ),
            "wearableNonRedLegacyClothExteriorPixels": (
                wearable_non_red_legacy_cloth_exterior_pixels
            ),
            "legacyLowerNonRedVariantDilation": (
                LEGACY_LOWER_NON_RED_VARIANT_DILATION
            ),
            "nonRedLegacyClothVariantCount": (
                len(set(variant_names) - RED_DOMINANT_VARIANTS)
            ),
            "minimumLegacyClothResidualComponentPixels": (
                LEGACY_CLOTH_MIN_RESIDUAL_COMPONENT_PIXELS
            ),
            "gloveSemanticFragmentFailureCells": (
                glove_semantic_fragment_failure_cells
            ),
            "gloveSemanticFragmentComponents": (
                glove_semantic_fragment_components
            ),
            "gloveSemanticFragmentPixels": glove_semantic_fragment_pixels,
            "maximumGloveSemanticFragmentPixels": (
                maximum_glove_semantic_fragment_pixels
            ),
            "minimumGloveSemanticFragmentPixels": (
                GLOVE_SEMANTIC_MIN_FRAGMENT_PIXELS
            ),
            "minimumArmorTorsoCoverage": round(minimum_armor_coverage, 8),
            "minimumFullBodyCoverage": round(minimum_full_coverage, 8),
            "minimumHelmetHeadCoverage": round(minimum_helmet_coverage, 8),
            "helmetUpperTorsoOverreachCells": (
                helmet_upper_torso_overreach_cells
            ),
            "maximumHelmetUpperTorsoOverreachPixels": (
                maximum_helmet_upper_torso_overreach_pixels
            ),
            "maximumAllowedHelmetUpperTorsoOverreachPixels": (
                MAX_HELMET_UPPER_TORSO_OVERREACH_PIXELS
            ),
            "helmetRectangularLowerContourFailureCells": (
                helmet_rectangular_lower_contour_failure_cells
            ),
            "helmetRectangularLowerContourIdleFailureCells": (
                helmet_rectangular_lower_contour_idle_failure_cells
            ),
            "maximumHelmetLowerFlatRunPixels": (
                maximum_helmet_lower_flat_run_pixels
            ),
            "maximumHelmetLowerVerticalEdgeRunPixels": (
                maximum_helmet_lower_vertical_edge_run_pixels
            ),
            "maximumAllowedHelmetLowerFlatRunPixels": (
                MAX_HELMET_LOWER_FLAT_RUN_PIXELS
            ),
            "maximumAllowedHelmetLowerVerticalEdgeRunPixels": (
                MAX_HELMET_LOWER_VERTICAL_EDGE_RUN_PIXELS
            ),
            "minimumHelmetVisualVariants": minimum_helmet_visual_variants,
            "minimumHelmetAlphaVariants": minimum_helmet_alpha_variants,
            "minimumIdleLegVisualVariants": minimum_idle_leg_visual_variants,
            "minimumIdleBootVisualVariants": minimum_idle_boot_visual_variants,
            "heldPrimaryMissingCells": held_primary_missing,
            "heldMultiplePrimaryCells": held_primary_multiple,
            "heldContactFailureCells": held_contact_failures,
            "heldActualAlphaContactZeroCells": (
                held_actual_alpha_contact_zero_cells
            ),
            "heldActualAlphaContactUnderThreeCells": (
                held_actual_alpha_contact_under_three_cells
            ),
            "minimumHeldActualAlphaContactPixels": (
                minimum_held_actual_alpha_contact_pixels
            ),
            "heldPalmSupportContactFailureCells": (
                held_palm_support_contact_failure_cells
            ),
            "minimumHeldPalmSupportContactPixels": (
                minimum_held_palm_support_contact_pixels
            ),
            "heldBodyCorePixels": held_body_core_pixels,
            "heldFootCorePixels": held_foot_core_pixels,
            "heldCanonicalSilhouetteMismatchCells": (
                held_canonical_mismatch_cells
            ),
            "heldCanonicalMissingPixels": held_canonical_missing_pixels,
            "heldCanonicalExtraPixels": held_canonical_extra_pixels,
            "heldSourcePersonResidualCells": (
                held_source_person_residual_cells
            ),
            "maximumHeldSourcePersonResidualPixels": (
                maximum_held_source_person_residual_pixels
            ),
            "heldAreaFailureCells": held_area_failure_cells,
            "heldPhaseAreaOutlierCells": held_phase_area_outlier_cells,
            "minimumHeldVisiblePixels": minimum_held_visible_pixels,
            "minimumHeldVariantMedianRatio": round(
                minimum_held_variant_median_ratio,
                8,
            ),
            "maximumHeldRowMedianRatio": round(
                maximum_held_row_median_ratio,
                8,
            ),
            "heldLegacyHumanFailureCells": held_legacy_human_failure_cells,
            "maximumHeldLegacyBodyNear21NonHandPixels": (
                maximum_held_legacy_body_pixels
            ),
            "maximumHeldLegacyHeadNear15NonHandPixels": (
                maximum_held_legacy_head_pixels
            ),
            "maximumHeldLegacyFootNear15NonHandPixels": (
                maximum_held_legacy_foot_pixels
            ),
            "idleStanceFailureDirections": idle_stance_failure_directions,
            "maximumIdleFootBottomDifference": maximum_idle_foot_bottom_difference,
            "minimumIdleLegAuthoredDetailPixels": (
                minimum_idle_leg_authored_detail_pixels
            ),
            "minimumIdleBootAuthoredDetailPixels": (
                minimum_idle_boot_authored_detail_pixels
            ),
            "heldPairOverlapCells": pair_overlap_cells,
            "maximumHeldPairOverlapPixels": maximum_pair_overlap,
            **body_hygiene,
        },
        "body": {
            "path": body_path.relative_to(workspace).as_posix(),
            "sha256": sha256(body_path),
        },
        "layers": {
            "root": layer_root.relative_to(workspace).as_posix(),
            "aggregateSha256": atlas_digest(atlas_paths, layer_root),
        },
        "failures": failures,
    }
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
        newline="\n",
    )
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return report


def main() -> None:
    workspace = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--manifest",
        type=Path,
        default=workspace / "app/paperdoll-rig-manifest.json",
    )
    parser.add_argument(
        "--report",
        type=Path,
        default=workspace / "asset-sources/paperdoll/v6/qa-report.json",
    )
    parser.add_argument("--strict", action="store_true")
    args = parser.parse_args()
    report = audit(workspace, args.manifest.resolve(), args.report.resolve())
    if args.strict and not report["passed"]:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
