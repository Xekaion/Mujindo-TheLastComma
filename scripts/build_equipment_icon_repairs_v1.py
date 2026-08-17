"""Rebuild the two equipment-atlas cells whose source art was bottom-cropped.

The legacy 10x10 atlas already gives every cell a transparent gutter, but the
oath shield and memory-weaver gloves were copied from an older sheet after the
art itself had been cut along a horizontal row.  This builder keeps the other
98 cells byte-for-byte identical and replaces only those two cells with the
approved ImageGen repairs stored under asset-sources/imagegen.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from dataclasses import dataclass
from pathlib import Path

from PIL import Image


ROOT = Path(__file__).resolve().parents[1]
ATLAS_PATH = ROOT / "public/assets/equipment/equipment-types-v4.png"
SOURCE_DIR = ROOT / "asset-sources/imagegen/equipment-icon-repair-v1"
REPORT_PATH = SOURCE_DIR / "build-report.json"

CELL_SIZE = 280
ATLAS_SIZE = (2800, 2800)
BASELINE_ATLAS_SHA256 = "a1748ab0315ea40219aff021cd21c71a53bcafb900eaf1363fff6a1071a2099b"
EXPECTED_OUTPUT_ATLAS_SHA256 = "8bd249f94471b957c4a6e0c87a77c237599df7d0326c50786af7bcc8e114bf96"
ACCEPTED_INPUT_ATLAS_SHA256 = {
    BASELINE_ATLAS_SHA256,
    EXPECTED_OUTPUT_ATLAS_SHA256,
}


@dataclass(frozen=True)
class Repair:
    key: str
    display_name: str
    source: Path
    column: int
    row: int
    source_box: tuple[int, int, int, int]
    target_box: tuple[int, int, int, int]
    original_cell_sha256: str


REPAIRS = (
    Repair(
        key="oath-shield",
        display_name="심홍 맹세방패",
        source=SOURCE_DIR / "repaired-oath-shield-refined-v1.png",
        column=1,
        row=4,
        source_box=(259, 87, 1014, 1106),
        target_box=(31, 28, 249, 252),
        original_cell_sha256="329de4514bfef7f3c44b3fefca70677e42d96176745ab86eba427cd6ee70c41a",
    ),
    Repair(
        key="memory-gloves",
        display_name="각인된 기억직조 장갑",
        source=SOURCE_DIR / "repaired-memory-gloves-v1.png",
        column=5,
        row=2,
        source_box=(140, 184, 1109, 1131),
        target_box=(28, 28, 252, 252),
        original_cell_sha256="7b7666d107739b67bcc0246253c52369bf9d20bd308f7c1f57b8aaf404902274",
    ),
)


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str:
    return sha256_bytes(path.read_bytes())


def rgba_sha256(image: Image.Image) -> str:
    return sha256_bytes(image.convert("RGBA").tobytes())


def atlas_cell(atlas: Image.Image, repair: Repair) -> Image.Image:
    left = repair.column * CELL_SIZE
    top = repair.row * CELL_SIZE
    return atlas.crop((left, top, left + CELL_SIZE, top + CELL_SIZE))


def build_cell(repair: Repair) -> Image.Image:
    source = Image.open(repair.source).convert("RGBA")
    subject = source.crop(repair.source_box)
    left, top, right, bottom = repair.target_box
    resized = subject.resize(
        (right - left, bottom - top),
        Image.Resampling.LANCZOS,
    )
    cell = Image.new("RGBA", (CELL_SIZE, CELL_SIZE), (0, 0, 0, 0))
    cell.alpha_composite(resized, (left, top))
    return cell


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--atlas",
        type=Path,
        default=ATLAS_PATH,
        help="Atlas to update. Defaults to the production v4 atlas.",
    )
    parser.add_argument(
        "--report",
        type=Path,
        default=REPORT_PATH,
        help="Deterministic provenance report path.",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    atlas_path = args.atlas.resolve()
    report_path = args.report.resolve()
    input_atlas_sha256 = sha256_file(atlas_path)
    if input_atlas_sha256 not in ACCEPTED_INPUT_ATLAS_SHA256:
        raise ValueError(
            "atlas bytes drifted outside the approved baseline/output states: "
            f"{input_atlas_sha256}; refusing to overwrite"
        )
    atlas = Image.open(atlas_path).convert("RGBA")
    if atlas.size != ATLAS_SIZE:
        raise ValueError(f"unexpected atlas dimensions: {atlas.size}")

    output_cells: dict[str, Image.Image] = {}
    records: list[dict[str, object]] = []
    for repair in REPAIRS:
        if not repair.source.is_file():
            raise FileNotFoundError(repair.source)
        current_cell = atlas_cell(atlas, repair)
        output_cell = build_cell(repair)
        current_hash = rgba_sha256(current_cell)
        output_hash = rgba_sha256(output_cell)
        if current_hash not in {repair.original_cell_sha256, output_hash}:
            raise ValueError(
                f"{repair.key} cell drifted: {current_hash}; refusing to overwrite"
            )
        output_cells[repair.key] = output_cell
        records.append(
            {
                "key": repair.key,
                "displayName": repair.display_name,
                "atlasCell": {
                    "column": repair.column,
                    "row": repair.row,
                    "size": [CELL_SIZE, CELL_SIZE],
                },
                "source": str(repair.source.relative_to(ROOT)).replace("\\", "/"),
                "sourceSha256": sha256_file(repair.source),
                "sourceBox": list(repair.source_box),
                "targetBox": list(repair.target_box),
                "originalCellRgbaSha256": repair.original_cell_sha256,
                "outputCellRgbaSha256": output_hash,
            }
        )

    for repair in REPAIRS:
        atlas.paste(
            output_cells[repair.key],
            (repair.column * CELL_SIZE, repair.row * CELL_SIZE),
        )

    temporary_path = atlas_path.with_name(f"{atlas_path.stem}.building.png")
    atlas.save(temporary_path, optimize=True)
    output_atlas_sha256 = sha256_file(temporary_path)
    if output_atlas_sha256 != EXPECTED_OUTPUT_ATLAS_SHA256:
        temporary_path.unlink(missing_ok=True)
        raise ValueError(
            "rebuilt atlas bytes do not match the approved output: "
            f"{output_atlas_sha256}"
        )
    temporary_path.replace(atlas_path)

    report = {
        "version": 1,
        "builder": "scripts/build_equipment_icon_repairs_v1.py",
        "generator": "OpenAI built-in image_gen",
        "baselineAtlasSha256": BASELINE_ATLAS_SHA256,
        "acceptedInputAtlasSha256": sorted(ACCEPTED_INPUT_ATLAS_SHA256),
        "inputValidation": "full-file SHA-256 before decode",
        "outputAtlas": str(atlas_path.relative_to(ROOT)).replace("\\", "/"),
        "outputAtlasSha256": output_atlas_sha256,
        "unchangedCellCount": 98,
        "repairs": records,
    }
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


if __name__ == "__main__":
    main()
