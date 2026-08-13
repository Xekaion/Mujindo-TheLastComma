from __future__ import annotations

import argparse
import colorsys
import json
from pathlib import Path
from typing import Iterable

from PIL import Image, ImageChops, ImageDraw, ImageFont, ImageOps, ImageStat


ROOT = Path(__file__).resolve().parents[1]
GENERATED = Path.home() / ".codex" / "generated_images" / "019fa476-5f3c-7790-93ac-7af4d4cdeaad"


ICON_SHEETS = [
    (
        GENERATED / "exec-eb188919-fe16-4c67-82fe-763fe5c2d9a6.png",
        ["focus", "caliber", "homing", "ricochet", "execution", "giantbane", "overcharge", "shrapnel", "leech", "armor"],
    ),
    (
        GENERATED / "exec-7ff3f284-66cd-44f2-b02e-d860b8656378.png",
        ["resolve", "regeneration", "ward", "bulwark", "momentum", "reflex", "scholar", "scavenger", "conquest", "frenzy"],
    ),
    (
        GENERATED / "exec-73e5a992-be17-41f2-bb92-9ea520738acb.png",
        ["strength", "rapidfire", "range", "velocity", "expansion", "sprint", "defense", "recovery", "learning", "collection"],
    ),
]


EFFECT_SOURCES = {
    "mirrorAegis": "exec-04aac084-80e8-48c4-a712-abb3250c21a8.png",
    "phantomMarch": "exec-08c815e9-23ec-4f7d-8891-2e9c23671051.png",
    "friendlyProjectile": "exec-ba848459-f8c6-4f36-9cab-d0b30691db3b.png",
    "hostileProjectile": "exec-312ad670-7bfa-474c-833b-206eeaac632f.png",
    "mirrorWave": "exec-f127eb1e-9d71-4236-bb61-e6a83cc22d8e.png",
    "starfallMantle": "exec-676f289b-eac8-4ce8-b9c5-374c4007eb45.png",
    "bloodwovenGrip": "exec-77626b4f-05e2-4d85-a2fb-4a1ce158fdb5.png",
    "ashboundGirdle": "exec-1117b31c-8c9b-4766-8659-758f754bee02.png",
    "lastMemory": "exec-d70a0a66-f02a-40c4-ac8e-30a0031723bd.png",
    "hunterSigil": "exec-c5388420-a64d-4a36-ae48-fb38ee8dda15.png",
    "riftStride": "exec-4cd50928-2377-437b-a9a5-6e092e93f022.png",
    "commaResonance": "exec-f09bd0ff-82cf-4e08-9580-42d509b54298.png",
    "oil": "exec-d3d085df-0163-4940-aa91-ecc06860d9a8.png",
    "storm": "exec-5b991168-fead-416c-8ed3-9310ce8f3acf.png",
    "void": "exec-505de331-4498-4145-b724-8b5749308167.png",
    "orbit": "exec-bade087a-0c95-4ac7-88de-c544ade439d3.png",
    "frost": "exec-eed477c8-9c2c-43ad-a0c0-8b0d21da9999.png",
    "poison": "exec-a7e7597f-90b2-4171-b1e3-e56274c05e97.png",
    "shrapnel": "exec-a8404546-e11d-454c-9448-de43021e16a5.png",
    "genericImpact": "exec-0e6c8b38-f550-4797-a022-60ea0dba349d.png",
}


LEGENDARY_SOURCE = {
    "crescentEcho": "friendlyProjectile",
    "mirrorAegis": "mirrorAegis",
    "hunterSigil": "hunterSigil",
    "starfallMantle": "starfallMantle",
    "lastMemory": "lastMemory",
    "bloodwovenGrip": "bloodwovenGrip",
    "ashboundGirdle": "ashboundGirdle",
    "phantomMarch": "phantomMarch",
    "riftStride": "riftStride",
    "commaResonance": "commaResonance",
}


AUGMENT_SOURCE = {
    "ember": "genericImpact",
    "oil": "oil",
    "frost": "frost",
    "storm": "storm",
    "poison": "poison",
    "return": "friendlyProjectile",
    "void": "void",
    "orbit": "orbit",
    "time": "friendlyProjectile",
    "overcharge": "storm",
    "shrapnel": "shrapnel",
    "ricochet": "mirrorWave",
    "ward": "mirrorAegis",
}


PROJECTILE_SOURCE = {
    "arcane": ("friendlyProjectile", 0.48, 1.0),
    "blood": ("hostileProjectile", 0.98, 1.08),
    "ember": ("friendlyProjectile", 0.05, 1.15),
    "storm": ("friendlyProjectile", 0.70, 1.12),
    "frost": ("friendlyProjectile", 0.52, 1.08),
    "poison": ("friendlyProjectile", 0.31, 0.98),
    "echo": ("friendlyProjectile", 0.78, 0.98),
    "enemy": ("hostileProjectile", 0.99, 1.02),
    "witch": ("hostileProjectile", 0.80, 1.08),
    "boss": ("hostileProjectile", 0.08, 1.22),
}


def chroma_to_alpha(image: Image.Image) -> Image.Image:
    rgba = image.convert("RGBA")
    px = rgba.load()
    for y in range(rgba.height):
        for x in range(rgba.width):
            r, g, b, _ = px[x, y]
            # Generated green varies slightly near anti-aliased edges. Use a
            # soft key and remove green spill without erasing cyan highlights.
            dominance = g - max(r, b)
            if g > 115 and dominance > 28:
                alpha = max(0, min(255, int(255 * (1 - (dominance - 28) / 118))))
                if g > 175 and dominance > 74:
                    alpha = 0
                green_excess = max(0, g - max(r, b))
                g = max(max(r, b), g - green_excess)
                px[x, y] = (r, g, b, alpha)
            else:
                px[x, y] = (r, g, b, 255)
    return rgba


def premultiplied_resize(image: Image.Image, size: tuple[int, int]) -> Image.Image:
    rgba = image.convert("RGBA")
    alpha = rgba.getchannel("A")
    rgb = Image.new("RGB", rgba.size)
    rgb.paste(rgba.convert("RGB"), mask=alpha)
    rgb = rgb.resize(size, Image.Resampling.LANCZOS)
    alpha = alpha.resize(size, Image.Resampling.LANCZOS)
    result = Image.new("RGBA", size)
    result.paste(rgb, mask=alpha)
    result.putalpha(alpha)
    return result


def colorize(image: Image.Image, target_hue: float, saturation_scale: float) -> Image.Image:
    rgba = image.convert("RGBA")
    out = Image.new("RGBA", rgba.size)
    src = rgba.load()
    dst = out.load()
    for y in range(rgba.height):
        for x in range(rgba.width):
            r, g, b, a = src[x, y]
            if a == 0:
                continue
            h, s, v = colorsys.rgb_to_hsv(r / 255, g / 255, b / 255)
            if s > 0.16 and v > 0.12:
                h = target_hue
                s = min(1.0, max(0.22, s * saturation_scale))
                r1, g1, b1 = colorsys.hsv_to_rgb(h, s, v)
                dst[x, y] = (round(r1 * 255), round(g1 * 255), round(b1 * 255), a)
            else:
                dst[x, y] = (r, g, b, a)
    return out


def equal_cells(image: Image.Image, columns: int = 5, rows: int = 2) -> Iterable[Image.Image]:
    for row in range(rows):
        for column in range(columns):
            left = round(column * image.width / columns)
            right = round((column + 1) * image.width / columns)
            top = round(row * image.height / rows)
            bottom = round((row + 1) * image.height / rows)
            yield image.crop((left, top, right, bottom))


def trim_green_icon(cell: Image.Image) -> Image.Image:
    rgb = cell.convert("RGB")
    mask = Image.new("L", rgb.size, 0)
    mask_px = mask.load()
    source_px = rgb.load()
    for y in range(rgb.height):
        for x in range(rgb.width):
            r, g, b = source_px[x, y]
            if max(r, g, b) > 96 and not (g > 105 and g - max(r, b) > 24):
                mask_px[x, y] = 255
    bbox = mask.getbbox()
    if bbox is None:
        raise ValueError("empty generated icon cell")
    # Generated gutters sometimes occupy most of an equal grid cell. Remove
    # them before squaring so no chroma pixels can survive in the WebP icon.
    left, top, right, bottom = bbox
    width = right - left
    height = bottom - top
    # A generator may leave a dark studio backdrop rather than chroma green.
    # Ignore large equal-cell margins and keep a consistent padded square.
    left = max(0, left - round(width * 0.035))
    right = min(rgb.width, right + round(width * 0.035))
    top = max(0, top - round(height * 0.035))
    bottom = min(rgb.height, bottom + round(height * 0.035))
    trimmed = rgb.crop((left, top, right, bottom))
    keyed = trimmed.load()
    for y in range(trimmed.height):
        for x in range(trimmed.width):
            r, g, b = keyed[x, y]
            if g > 105 and g - max(r, b) > 24:
                keyed[x, y] = (7, 10, 11)
    side = max(trimmed.width, trimmed.height)
    canvas = Image.new("RGB", (side, side), (7, 10, 11))
    canvas.paste(trimmed, ((side - trimmed.width) // 2, (side - trimmed.height) // 2))
    return canvas.resize((256, 256), Image.Resampling.LANCZOS)


def build_icons() -> list[dict[str, object]]:
    output = ROOT / "public" / "assets" / "augments" / "icons"
    output.mkdir(parents=True, exist_ok=True)
    records: list[dict[str, object]] = []
    for source_path, ids in ICON_SHEETS:
        image = Image.open(source_path)
        cells = list(equal_cells(image))
        if len(cells) != len(ids):
            raise ValueError(f"icon cell mismatch: {source_path}")
        for augment_id, cell in zip(ids, cells, strict=True):
            icon = trim_green_icon(cell)
            destination = output / f"{augment_id}-v1.webp"
            icon.save(destination, "WEBP", quality=92, method=6)
            records.append({"id": augment_id, "path": destination.relative_to(ROOT).as_posix(), "size": list(icon.size)})
    return records


def load_effect(name: str) -> Image.Image:
    source = GENERATED / EFFECT_SOURCES[name]
    return premultiplied_resize(chroma_to_alpha(Image.open(source)), (512, 512))


def build_effects() -> list[dict[str, object]]:
    loaded = {name: load_effect(name) for name in EFFECT_SOURCES}
    records: list[dict[str, object]] = []
    groups = {
        "legendary": LEGENDARY_SOURCE,
        "augments": AUGMENT_SOURCE,
    }
    for group, mapping in groups.items():
        output = ROOT / "public" / "assets" / "effects" / group
        output.mkdir(parents=True, exist_ok=True)
        for effect_id, source_id in mapping.items():
            destination = output / f"{effect_id}-v1.png"
            loaded[source_id].save(destination, optimize=True)
            records.append(effect_record(group, effect_id, destination))

    output = ROOT / "public" / "assets" / "effects" / "projectiles"
    output.mkdir(parents=True, exist_ok=True)
    for affinity, (source_id, hue, saturation) in PROJECTILE_SOURCE.items():
        destination = output / f"{affinity}-v1.png"
        colorize(loaded[source_id], hue, saturation).save(destination, optimize=True)
        records.append(effect_record("projectiles", affinity, destination))
    return records


def effect_record(group: str, effect_id: str, path: Path) -> dict[str, object]:
    image = Image.open(path).convert("RGBA")
    alpha = image.getchannel("A")
    extrema = alpha.getextrema()
    transparent_ratio = 1 - (ImageStat.Stat(alpha).mean[0] / 255)
    return {
        "group": group,
        "id": effect_id,
        "path": path.relative_to(ROOT).as_posix(),
        "size": list(image.size),
        "mode": image.mode,
        "alphaExtrema": list(extrema),
        "transparentRatio": round(transparent_ratio, 4),
        "bytes": path.stat().st_size,
    }


def build_contact_sheet(icon_records: list[dict[str, object]], effect_records: list[dict[str, object]]) -> Path:
    qa_dir = ROOT / "tmp" / "vfx-qa"
    qa_dir.mkdir(parents=True, exist_ok=True)
    canvas = Image.new("RGB", (1280, 1340), (10, 12, 16))
    draw = ImageDraw.Draw(canvas)
    font = ImageFont.load_default()
    draw.text((24, 14), "NEW AUGMENT ICONS (legacy atlas untouched)", fill=(232, 210, 155), font=font)
    for index, record in enumerate(icon_records):
        image = Image.open(ROOT / str(record["path"])).convert("RGB").resize((112, 112), Image.Resampling.LANCZOS)
        x = 24 + (index % 10) * 124
        y = 42 + (index // 10) * 144
        canvas.paste(image, (x, y))
        draw.text((x, y + 115), str(record["id"])[:17], fill=(230, 235, 240), font=font)

    draw.text((24, 482), "AUTHORED COMBAT VFX (frame 1 of each 2x2 sheet)", fill=(232, 210, 155), font=font)
    for index, record in enumerate(effect_records):
        sheet = Image.open(ROOT / str(record["path"])).convert("RGBA")
        frame = sheet.crop((0, 0, sheet.width // 2, sheet.height // 2)).resize((118, 118), Image.Resampling.LANCZOS)
        checker = Image.new("RGB", frame.size, (22, 25, 30))
        cdraw = ImageDraw.Draw(checker)
        for yy in range(0, 118, 16):
            for xx in range(0, 118, 16):
                if (xx // 16 + yy // 16) % 2:
                    cdraw.rectangle((xx, yy, xx + 15, yy + 15), fill=(40, 44, 52))
        checker.paste(frame.convert("RGB"), mask=frame.getchannel("A"))
        x = 24 + (index % 10) * 124
        y = 512 + (index // 10) * 156
        canvas.paste(checker, (x, y))
        draw.text((x, y + 121), f"{record['group']}/{record['id']}"[:19], fill=(220, 225, 235), font=font)
    destination = qa_dir / "generated-vfx-contact-sheet.png"
    canvas.save(destination, optimize=True)
    return destination


def validate(icon_records: list[dict[str, object]], effect_records: list[dict[str, object]]) -> None:
    if len(icon_records) != 30 or len({record["id"] for record in icon_records}) != 30:
        raise ValueError("new augment icon manifest must contain exactly 30 unique ids")
    if len(effect_records) != 33:
        raise ValueError("gameplay VFX manifest must contain 33 assets")
    for record in icon_records:
        image = Image.open(ROOT / str(record["path"])).convert("RGB")
        colors = image.getcolors(maxcolors=image.width * image.height) or []
        for count, (r, g, b) in colors:
            if count > 2 and g > 105 and g - max(r, b) > 34:
                raise ValueError(f"chroma spill in generated icon: {record}")
    for record in effect_records:
        if record["size"] != [512, 512] or record["mode"] != "RGBA":
            raise ValueError(f"invalid VFX dimensions/mode: {record}")
        minimum, maximum = record["alphaExtrema"]
        if minimum != 0 or maximum != 255:
            raise ValueError(f"VFX alpha channel is not complete: {record}")
        ratio = float(record["transparentRatio"])
        if ratio < 0.35 or ratio > 0.98:
            raise ValueError(f"implausible transparent coverage: {record}")
        image = Image.open(ROOT / str(record["path"])).convert("RGBA")
        corners = [image.getpixel((0, 0))[3], image.getpixel((511, 0))[3], image.getpixel((0, 511))[3], image.getpixel((511, 511))[3]]
        if any(corner > 8 for corner in corners):
            raise ValueError(f"opaque VFX corner: {record}")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.parse_args()
    icon_records = build_icons()
    effect_records = build_effects()
    validate(icon_records, effect_records)
    contact_sheet = build_contact_sheet(icon_records, effect_records)
    manifest = {
        "generator": "built-in image_gen with local chroma-key removal",
        "legacyAtlasModified": False,
        "icons": icon_records,
        "effects": effect_records,
        "contactSheet": contact_sheet.relative_to(ROOT).as_posix(),
    }
    qa_path = ROOT / "tmp" / "vfx-qa" / "generated-vfx-report.json"
    qa_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"icons": len(icon_records), "effects": len(effect_records), "qa": str(contact_sheet)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
