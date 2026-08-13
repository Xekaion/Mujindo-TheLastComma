#!/usr/bin/env python3
"""Extract the newest Chromium DOMStorage save value from a copied LevelDB WAL.

This utility is intentionally read-only with respect to the browser profile. Point it
at a copied ``.log`` file and it writes an ordinary UTF-8 JSON save plus a compact
integrity manifest.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import struct
from typing import Iterator


BLOCK_SIZE = 32 * 1024
FULL_RECORD = 1
FIRST_RECORD = 2
MIDDLE_RECORD = 3
LAST_RECORD = 4
VALUE_ENTRY = 1


def read_varint(data: bytes, offset: int) -> tuple[int, int]:
    value = 0
    shift = 0
    while True:
        byte = data[offset]
        offset += 1
        value |= (byte & 0x7F) << shift
        if byte < 0x80:
            return value, offset
        shift += 7
        if shift > 35:
            raise ValueError("invalid varint32")


def iter_logical_records(data: bytes) -> Iterator[bytes]:
    pending = bytearray()
    offset = 0
    while offset < len(data):
        block_end = min(((offset // BLOCK_SIZE) + 1) * BLOCK_SIZE, len(data))
        while offset + 7 <= block_end:
            _crc, length, record_type = struct.unpack_from("<IHB", data, offset)
            offset += 7
            if length == 0 and record_type == 0:
                offset = block_end
                break
            if offset + length > block_end:
                offset = block_end
                break
            fragment = data[offset : offset + length]
            offset += length
            if record_type == FULL_RECORD:
                pending.clear()
                yield fragment
            elif record_type == FIRST_RECORD:
                pending = bytearray(fragment)
            elif record_type == MIDDLE_RECORD:
                pending.extend(fragment)
            elif record_type == LAST_RECORD:
                pending.extend(fragment)
                yield bytes(pending)
                pending.clear()
        if offset < block_end:
            offset = block_end


def newest_value(wal_bytes: bytes, target_key: bytes) -> tuple[int, bytes, bytes]:
    best: tuple[int, bytes, bytes] | None = None
    for batch in iter_logical_records(wal_bytes):
        if len(batch) < 12:
            continue
        base_sequence = struct.unpack_from("<Q", batch, 0)[0]
        entry_count = struct.unpack_from("<I", batch, 8)[0]
        offset = 12
        try:
            for index in range(entry_count):
                tag = batch[offset]
                offset += 1
                key_length, offset = read_varint(batch, offset)
                key = batch[offset : offset + key_length]
                offset += key_length
                value: bytes | None = None
                if tag == VALUE_ENTRY:
                    value_length, offset = read_varint(batch, offset)
                    value = batch[offset : offset + value_length]
                    offset += value_length
                sequence = base_sequence + index
                if (
                    tag == VALUE_ENTRY
                    and value is not None
                    and target_key in key
                    and (best is None or sequence > best[0])
                ):
                    best = (sequence, key, value)
        except (IndexError, struct.error, ValueError):
            continue
    if best is None:
        raise RuntimeError(f"save key not found: {target_key.decode('utf-8')}")
    return best


def decode_dom_storage_value(value: bytes) -> str:
    if not value:
        raise ValueError("empty DOMStorage value")
    if value[0] == 0:
        return value[1:].decode("utf-16le")
    if value[0] == 1:
        return value[1:].decode("utf-8")
    raise ValueError(f"unknown Chromium DOMStorage encoding marker: {value[0]}")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--wal", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--manifest", required=True, type=Path)
    parser.add_argument(
        "--key", default="mujindo:last-comma:save-v2:slot:1"
    )
    parser.add_argument("--expect-level", type=int)
    args = parser.parse_args()

    wal_bytes = args.wal.read_bytes()
    sequence, encoded_key, encoded_value = newest_value(
        wal_bytes, args.key.encode("utf-8")
    )
    save_text = decode_dom_storage_value(encoded_value)
    save_data = json.loads(save_text)
    player = save_data.get("player", {})
    if args.expect_level is not None and player.get("level") != args.expect_level:
        raise RuntimeError(
            f"level mismatch: expected {args.expect_level}, got {player.get('level')}"
        )

    equipment = list((player.get("equipment") or {}).values())
    inventory = list(player.get("inventory") or [])
    items = [item for item in equipment + inventory if isinstance(item, dict)]
    rarity_counts: dict[str, int] = {}
    for item in items:
        rarity = str(item.get("rarity", "unknown"))
        rarity_counts[rarity] = rarity_counts.get(rarity, 0) + 1

    args.out.parent.mkdir(parents=True, exist_ok=True)
    # Preserve the decoded localStorage JSON text byte-for-byte in UTF-8.  A
    # pretty re-serialization would be semantically valid, but the raw string
    # is the strongest independent restore artifact and matches forensic hashes.
    extracted_bytes = save_text.encode("utf-8")
    args.out.write_bytes(extracted_bytes)

    manifest = {
        "format": "mujindo-edge-local-save-backup-v1",
        "sourceWal": str(args.wal.resolve()),
        "sourceWalSha256": hashlib.sha256(wal_bytes).hexdigest(),
        "storageKey": args.key,
        "encodedLevelDbKeyHex": encoded_key.hex(),
        "sequence": sequence,
        "encodedValueSha256": hashlib.sha256(encoded_value).hexdigest(),
        "extractedJsonSha256": hashlib.sha256(extracted_bytes).hexdigest(),
        "player": {
            "level": player.get("level"),
            "rooms": player.get("rooms"),
            "kills": player.get("kills"),
            "profession": player.get("profession"),
            "equipmentCount": len([item for item in equipment if item]),
            "inventoryCount": len(inventory),
            "rarityCounts": rarity_counts,
        },
    }
    args.manifest.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print(json.dumps(manifest, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
