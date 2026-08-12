"""Render and quantify same-family/mixed-family paperdoll composites."""

from __future__ import annotations

from pathlib import Path

import json

from PIL import Image, ImageDraw


CELL_W, CELL_H = 256, 192
SLOTS = ("weapon", "offhand", "helm", "shoulders", "armor", "gloves", "belt", "legs", "boots", "relic")
NAMES = ("iron", "frost", "jade", "blood", "arcane", "waraxe", "celestial", "void", "sealed", "cosmic")
ROWS = tuple(range(8))
PHASES = tuple(range(4))
AUTHORED_TO_RUNTIME_DIRECTION = (0, 7, 6, 3, 4, 5, 2, 1)


def crop(atlas: Image.Image, column: int, row: int) -> Image.Image:
    return atlas.crop((column * CELL_W, row * CELL_H, (column + 1) * CELL_W, (row + 1) * CELL_H))


def crop_alpha(alpha: Image.Image, column: int, row: int) -> Image.Image:
    return alpha.crop((column * CELL_W, row * CELL_H, (column + 1) * CELL_W, (row + 1) * CELL_H))


def main() -> None:
    root = Path(__file__).resolve().parents[1]
    mannequin = Image.open(root / "public/assets/walk/harin-mannequin-v2.png").convert("RGBA")
    layer_root = root / "public/assets/paperdoll/v2"
    layers = {
        (slot, variant): Image.open(layer_root / slot / f"{variant:02d}-{NAMES[variant]}.png").convert("RGBA")
        for slot in SLOTS
        for variant in range(10)
    }
    scale = 2
    tile_w, tile_h = CELL_W * scale, CELL_H * scale
    sheet = Image.new("RGBA", (tile_w * 5, tile_h * len(ROWS) * len(PHASES)), (16, 17, 20, 255))
    draw = ImageDraw.Draw(sheet)
    builds = [
        ("same iron", [0] * 10),
        ("same cosmic", [9] * 10),
        ("mixed ascending", list(range(10))),
        ("mixed descending", list(reversed(range(10)))),
        ("mixed alternating", [9, 0, 8, 1, 7, 2, 6, 3, 5, 4]),
    ]
    for row_index, authored_row in enumerate(ROWS):
        for phase in PHASES:
            qa_row = row_index * len(PHASES) + phase
            for build_index, (label, variants) in enumerate(builds):
                runtime_direction = AUTHORED_TO_RUNTIME_DIRECTION[authored_row]
                body_frame = crop(mannequin, phase, authored_row)
                frame = Image.new("RGBA", (CELL_W, CELL_H), (0, 0, 0, 0))
                resolved_layers: list[tuple[str, Image.Image]] = []
                for slot, variant in zip(SLOTS, variants):
                    layer = crop(layers[(slot, variant)], phase, authored_row)
                    back_facing = runtime_direction in (3, 4, 5)
                    if slot == "relic":
                        layer_pass = "rear" if back_facing else "front"
                    elif slot == "weapon":
                        layer_pass = "rear" if 2 <= runtime_direction <= 5 else "front"
                    elif slot == "offhand":
                        layer_pass = "rear" if 4 <= runtime_direction <= 7 else "front"
                    else:
                        layer_pass = "body"
                    resolved_layers.append((layer_pass, layer))
                for layer_pass, layer in resolved_layers:
                    if layer_pass == "rear":
                        frame.alpha_composite(layer)
                frame.alpha_composite(body_frame)
                for layer_pass, layer in resolved_layers:
                    if layer_pass == "body":
                        frame.alpha_composite(layer)
                for layer_pass, layer in resolved_layers:
                    if layer_pass == "front":
                        frame.alpha_composite(layer)
                frame = frame.resize((tile_w, tile_h), Image.Resampling.NEAREST)
                sheet.alpha_composite(frame, (build_index * tile_w, qa_row * tile_h))
                draw.text((build_index * tile_w + 10, qa_row * tile_h + 8), f"{label} / row {authored_row} / phase {phase}", fill=(255, 240, 196, 255))
    out = root / "tmp/paperdoll-layer-qa.png"
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
        "atlas_count": len(layers),
        "wrong_size": wrong_size,
        "empty_atlases": empty,
        "cell_edge_crop_risks": edge_risk,
    }
    integrity_path = root / "tmp/paperdoll-layer-integrity.json"
    integrity_path.write_text(json.dumps(integrity, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(integrity, ensure_ascii=False, indent=2))
    if wrong_size or empty or edge_risk:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
