#!/usr/bin/env python3
"""Read DBF records directly from a FIRMS ZIP, without extracting it."""
import json
import hashlib
import os
import struct
import sys
import zipfile


def read_exact(stream, size):
    data = stream.read(size)
    if len(data) != size:
        raise ValueError("fichier DBF tronqué")
    return data


def selected(archive, member, row, percent):
    key = f"{os.path.basename(archive)}/{member}:{row}".encode("utf-8")
    number = int.from_bytes(hashlib.blake2b(key, digest_size=8).digest(), "big")
    return number < (1 << 64) * percent // 100


def records(archive, member, after, percent=100):
    with zipfile.ZipFile(archive) as source, source.open(member) as stream:
        header = read_exact(stream, 32)
        count = struct.unpack_from("<I", header, 4)[0]
        header_size, record_size = struct.unpack_from("<HH", header, 8)
        if header_size < 33 or record_size < 2:
            raise ValueError("en-tête DBF invalide")
        descriptors = read_exact(stream, header_size - 32)
        fields = []
        offset = 1
        for i in range(0, len(descriptors), 32):
            descriptor = descriptors[i:i + 32]
            if descriptor[0] == 13:
                break
            if len(descriptor) != 32:
                raise ValueError("descripteur DBF tronqué")
            name = descriptor[:11].split(b"\0", 1)[0].decode("ascii").lower()
            width = descriptor[16]
            if not name or not width:
                raise ValueError("champ DBF invalide")
            fields.append((name, offset, width))
            offset += width
        else:
            raise ValueError("fin d'en-tête DBF absente")
        if offset != record_size:
            raise ValueError("taille d'enregistrement DBF incohérente")
        for row in range(1, count + 1):
            data = read_exact(stream, record_size)
            if row <= after:
                continue
            if percent < 100 and not selected(archive, member, row, percent):
                continue
            if data[0:1] != b" ":
                raise ValueError(f"enregistrement DBF supprimé ou invalide : {row}")
            item = {name: data[start:start + width].decode("utf-8").strip()
                    for name, start, width in fields}
            print(json.dumps({"row": row, "fields": item}, ensure_ascii=False), flush=False)


if __name__ == "__main__":
    try:
        percent = int(sys.argv[4]) if len(sys.argv) > 4 else 100
        if not 1 <= percent <= 100:
            raise ValueError("pourcentage d'échantillonnage invalide")
        records(sys.argv[1], sys.argv[2], int(sys.argv[3]), percent)
    except (OSError, ValueError, UnicodeError, zipfile.BadZipFile, IndexError) as error:
        print(f"Lecture ZIP impossible : {error}", file=sys.stderr)
        sys.exit(1)
