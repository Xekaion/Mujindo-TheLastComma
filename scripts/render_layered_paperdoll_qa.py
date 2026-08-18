"""Render and quantify same-family/mixed-family paperdoll composites."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

from PIL import Image, ImageDraw


ROOT = Path(__file__).resolve().parents[1]
RIG_MANIFEST_PATH = ROOT / "app" / "paperdoll-rig-manifest.json"
RIG_MANIFEST = json.loads(RIG_MANIFEST_PATH.read_text(encoding="utf-8"))
FRAME = RIG_MANIFEST["frame"]
CELL_W, CELL_H = FRAME["width"], FRAME["height"]
SLOTS = ("weapon", "offhand", "helm", "shoulders", "armor", "gloves", "belt", "legs", "boots", "relic")
DRAW_ORDER = ("relic", "offhand", "weapon", "legs", "boots", "armor", "belt", "shoulders", "gloves", "helm")
NAMES = tuple(RIG_MANIFEST["variantNames"])
RUNTIME_TO_AUTHORED_DIRECTION = tuple(FRAME["directionRows"])
ROWS = tuple(range(len(RUNTIME_TO_AUTHORED_DIRECTION)))
PHASES = tuple(range(FRAME["columns"]))
AUTHORED_TO_RUNTIME_DIRECTION = tuple(
    RUNTIME_TO_AUTHORED_DIRECTION.index(authored_row) for authored_row in ROWS
)
DIRECTION_LABELS = ("S", "SW", "W", "NW", "N", "NE", "E", "SE")


def crop(atlas: Image.Image, column: int, row: int) -> Image.Image:
    return atlas.crop((column * CELL_W, row * CELL_H, (column + 1) * CELL_W, (row + 1) * CELL_H))


def crop_alpha(alpha: Image.Image, column: int, row: int) -> Image.Image:
    return alpha.crop((column * CELL_W, row * CELL_H, (column + 1) * CELL_W, (row + 1) * CELL_H))


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def layer_pass(slot: str, runtime_direction: int) -> str:
    if slot == "relic":
        return "front"
    if slot == "weapon":
        return "rear" if 2 <= runtime_direction <= 5 else "front"
    if slot == "offhand":
        return "rear" if 4 <= runtime_direction <= 7 else "front"
    return "body"


def composite_single_piece(
    body_frame: Image.Image,
    layer_frame: Image.Image,
    slot: str,
    runtime_direction: int,
) -> Image.Image:
    output = Image.new("RGBA", (CELL_W, CELL_H), (0, 0, 0, 0))
    if layer_pass(slot, runtime_direction) == "rear":
        output.alpha_composite(layer_frame)
        output.alpha_composite(body_frame)
    else:
        output.alpha_composite(body_frame)
        output.alpha_composite(layer_frame)
    return output


def render_all_individual_equipment(
    mannequin: Image.Image,
    layers: dict[tuple[str, int], Image.Image],
    layer_root: Path,
    output: Path,
    version: str,
) -> dict[str, object]:
    """Render every slot/variant through all 32 runtime animation cells."""

    frame_size = (80, 60)
    label_height = 22
    tile_width = frame_size[0] * len(RUNTIME_TO_AUTHORED_DIRECTION)
    tile_height = label_height + frame_size[1] * len(PHASES)
    tile_columns = 5
    item_count = len(SLOTS) * len(NAMES)
    tile_rows = (item_count + tile_columns - 1) // tile_columns
    sheet = Image.new(
        "RGBA",
        (tile_width * tile_columns, tile_height * tile_rows),
        (11, 12, 15, 255),
    )
    draw = ImageDraw.Draw(sheet)
    per_item: list[dict[str, object]] = []
    failed_items: list[str] = []
    expected_cells_per_item = len(RUNTIME_TO_AUTHORED_DIRECTION) * len(PHASES)
    item_index = 0
    for slot in SLOTS:
        for variant, variant_name in enumerate(NAMES):
            atlas = layers[(slot, variant)]
            tile_x = (item_index % tile_columns) * tile_width
            tile_y = (item_index // tile_columns) * tile_height
            draw.rectangle(
                (tile_x, tile_y, tile_x + tile_width - 1, tile_y + tile_height - 1),
                outline=(66, 58, 46, 255),
            )
            draw.text(
                (tile_x + 5, tile_y + 5),
                f"{slot}/{variant:02d}-{variant_name} | 8 directions x 4 phases",
                fill=(244, 229, 190, 255),
            )
            visible_cells = 0
            for phase in PHASES:
                for runtime_direction, authored_row in enumerate(
                    RUNTIME_TO_AUTHORED_DIRECTION
                ):
                    body_frame = crop(mannequin, phase, authored_row)
                    layer_frame = crop(atlas, phase, authored_row)
                    if layer_frame.getchannel("A").getbbox() is not None:
                        visible_cells += 1
                    rendered = composite_single_piece(
                        body_frame,
                        layer_frame,
                        slot,
                        runtime_direction,
                    ).resize(frame_size, Image.Resampling.NEAREST)
                    destination = (
                        tile_x + runtime_direction * frame_size[0],
                        tile_y + label_height + phase * frame_size[1],
                    )
                    sheet.alpha_composite(rendered, destination)
                    if phase == 0:
                        draw.text(
                            (destination[0] + 3, destination[1] + 2),
                            DIRECTION_LABELS[runtime_direction],
                            fill=(118, 229, 214, 255),
                        )
            per_item.append(
                {
                    "item": f"{slot}/{variant:02d}-{variant_name}",
                    "cells": expected_cells_per_item,
                    "visible_cells": visible_cells,
                    "passed": visible_cells == expected_cells_per_item,
                    "atlas_sha256": sha256(
                        layer_root / slot / f"{variant:02d}-{variant_name}.png"
                    ),
                }
            )
            if visible_cells != expected_cells_per_item:
                failed_items.append(f"{slot}/{variant:02d}-{variant_name}")
            item_index += 1

    output.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(output, optimize=True)
    report = {
        "schema_version": 2,
        "rig_version": version,
        "passed": not failed_items,
        "items": item_count,
        "directions": len(RUNTIME_TO_AUTHORED_DIRECTION),
        "phases": len(PHASES),
        "rendered_cells": item_count
        * len(RUNTIME_TO_AUTHORED_DIRECTION)
        * len(PHASES),
        "sheet": str(output.resolve()),
        "failed_items": failed_items,
        "per_item": per_item,
    }
    report_path = output.with_suffix(".json")
    report_path.write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(output)
    print(report_path)
    if failed_items:
        raise RuntimeError(
            "paperdoll individual QA contains non-visible cells: "
            + ", ".join(failed_items)
        )
    return report


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--version",
        help="Historical rig override. Defaults to the active runtime manifest.",
    )
    parser.add_argument("--body", type=Path)
    parser.add_argument("--output", type=Path)
    parser.add_argument(
        "--individual-output",
        type=Path,
        help=(
            "100-item x 8-direction x 4-phase single-equipment sheet; "
            "defaults to artifacts/paperdoll-all-equipment-qa.png"
        ),
    )
    args = parser.parse_args()
    active_version = RIG_MANIFEST["version"]
    version = args.version or active_version
    uses_active_manifest = version == active_version
    body_path = args.body or (
        ROOT / "public" / RIG_MANIFEST["bodyPath"].lstrip("/")
        if uses_active_manifest
        else ROOT / f"public/assets/walk/harin-mannequin-{version}.png"
    )
    mannequin = Image.open(body_path).convert("RGBA")
    layer_root = (
        ROOT / "public" / RIG_MANIFEST["layerRoot"].lstrip("/")
        if uses_active_manifest
        else ROOT / f"public/assets/paperdoll/{version}"
    )
    layers = {
        (slot, variant): Image.open(layer_root / slot / f"{variant:02d}-{NAMES[variant]}.png").convert("RGBA")
        for slot in SLOTS
        for variant in range(10)
    }
    scale = 2
    tile_w, tile_h = CELL_W * scale, CELL_H * scale
    builds = [
        (str(build["label"]), list(build["variants"]))
        for build in RIG_MANIFEST["qaCompositeBuilds"]
    ]
    sheet = Image.new(
        "RGBA",
        (tile_w * len(builds), tile_h * len(ROWS) * len(PHASES)),
        (16, 17, 20, 255),
    )
    draw = ImageDraw.Draw(sheet)
    for row_index, authored_row in enumerate(ROWS):
        for phase in PHASES:
            qa_row = row_index * len(PHASES) + phase
            for build_index, (label, variants) in enumerate(builds):
                runtime_direction = AUTHORED_TO_RUNTIME_DIRECTION[authored_row]
                body_frame = crop(mannequin, phase, authored_row)
                frame = Image.new("RGBA", (CELL_W, CELL_H), (0, 0, 0, 0))
                resolved_layers: list[tuple[str, Image.Image]] = []
                variant_by_slot = dict(zip(SLOTS, variants))
                for slot in DRAW_ORDER:
                    variant = variant_by_slot[slot]
                    layer = crop(layers[(slot, variant)], phase, authored_row)
                    resolved_layers.append((layer_pass(slot, runtime_direction), layer))
                for pass_name, layer in resolved_layers:
                    if pass_name == "rear":
                        frame.alpha_composite(layer)
                frame.alpha_composite(body_frame)
                for pass_name, layer in resolved_layers:
                    if pass_name == "body":
                        frame.alpha_composite(layer)
                for pass_name, layer in resolved_layers:
                    if pass_name == "front":
                        frame.alpha_composite(layer)
                frame = frame.resize((tile_w, tile_h), Image.Resampling.NEAREST)
                sheet.alpha_composite(frame, (build_index * tile_w, qa_row * tile_h))
                draw.text((build_index * tile_w + 10, qa_row * tile_h + 8), f"{label} / row {authored_row} / phase {phase}", fill=(255, 240, 196, 255))
    out = args.output or ROOT / f"tmp/paperdoll-layer-qa-{version}.png"
    out.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(out)
    print(out)

    # Machine-readable asset integrity check.  The build script owns detailed
    # restoration metrics; this pass catches damaged/cropped output atlases.
    empty: list[str] = []
    wrong_size: list[str] = []
    edge_risk: list[str] = []
    for (slot, variant), atlas in layers.items():
        key = f"{slot}/{variant:02d}-{NAMES[variant]}"
        if atlas.size != (CELL_W * 4, CELL_H * 8):
            wrong_size.append(key)
        alpha = atlas.getchannel("A")
        if alpha.getbbox() is None:
            empty.append(key)
        for row in range(8):
            for column in range(4):
                bounds = crop_alpha(alpha, column, row).getbbox()
                if bounds and (
                    bounds[0] <= 1
                    or bounds[1] <= 1
                    or bounds[2] >= CELL_W - 1
                    or bounds[3] >= CELL_H - 1
                ):
                    edge_risk.append(f"{key}@{row},{column}")
    integrity = {
        "rig_version": version,
        "active_manifest": str(RIG_MANIFEST_PATH.relative_to(ROOT)),
        "atlas_count": len(layers),
        "wrong_size": wrong_size,
        "empty_atlases": empty,
        "cell_edge_crop_risks": edge_risk,
    }
    integrity_path = ROOT / "tmp/paperdoll-layer-integrity.json"
    integrity_path.write_text(json.dumps(integrity, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(integrity, ensure_ascii=False, indent=2))
    if wrong_size or empty or edge_risk:
        raise SystemExit(1)

    individual_output = args.individual_output or (
        ROOT / "artifacts" / "paperdoll-all-equipment-qa.png"
    )
    render_all_individual_equipment(
        mannequin,
        layers,
        layer_root,
        individual_output,
        version,
    )


if __name__ == "__main__":
    main()
