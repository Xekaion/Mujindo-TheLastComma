"""Render and quantify same-family/mixed-family paperdoll composites."""

from __future__ import annotations

from pathlib import Path

import json

from PIL import Image, ImageDraw


CELL_W, CELL_H = 256, 192
SLOTS = ("weapon", "offhand", "helm", "shoulders", "armor", "gloves", "belt", "legs", "boots", "relic")
NAMES = ("iron", "frost", "jade", "blood", "arcane", "waraxe", "celestial", "void", "sealed", "cosmic")
ROWS = (0, 2, 4, 6)


def crop(atlas: Image.Image, column: int, row: int) -> Image.Image:
    return atlas.crop((column * CELL_W, row * CELL_H, (column + 1) * CELL_W, (row + 1) * CELL_H))


def crop_alpha(alpha: Image.Image, column: int, row: int) -> Image.Image:
    return alpha.crop((column * CELL_W, row * CELL_H, (column + 1) * CELL_W, (row + 1) * CELL_H))


def main() -> None:
    root = Path(__file__).resolve().parents[1]
    mannequin = Image.open(root / "public/assets/walk/harin-mannequin-v1.png").convert("RGBA")
    layer_root = root / "public/assets/paperdoll/v1"
    layers = {
        (slot, variant): Image.open(layer_root / slot / f"{variant:02d}-{NAMES[variant]}.png").convert("RGBA")
        for slot in SLOTS
        for variant in range(10)
    }
    scale = 2
    tile_w, tile_h = CELL_W * scale, CELL_H * scale
    sheet = Image.new("RGBA", (tile_w * 5, tile_h * 4), (16, 17, 20, 255))
    draw = ImageDraw.Draw(sheet)
    builds = [
        ("same iron", [0] * 10),
        ("same cosmic", [9] * 10),
        ("mixed ascending", list(range(10))),
        ("mixed descending", list(reversed(range(10)))),
        ("mixed alternating", [9, 0, 8, 1, 7, 2, 6, 3, 5, 4]),
    ]
    for row_index, authored_row in enumerate(ROWS):
        for build_index, (label, variants) in enumerate(builds):
            frame = crop(mannequin, 1, authored_row)
            for slot, variant in zip(SLOTS, variants):
                layer = crop(layers[(slot, variant)], 1, authored_row)
                # Match runtime semantics: an authored equipment pixel replaces
                # the undersuit at the same coordinate instead of blending its
                # alpha over clothing that should be occluded.
                frame.paste(layer, (0, 0), layer)
            frame = frame.resize((tile_w, tile_h), Image.Resampling.NEAREST)
            sheet.alpha_composite(frame, (build_index * tile_w, row_index * tile_h))
            draw.text((build_index * tile_w + 10, row_index * tile_h + 8), f"{label} / row {authored_row}", fill=(255, 240, 196, 255))
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
