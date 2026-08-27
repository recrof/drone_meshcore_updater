#!/usr/bin/env python3
"""
Merge Intel HEX files into one flashable image.

    python3 updater/tools/merge_hex.py out.hex mcuboot.hex app.signed.hex

Sysbuild does not produce a merged hex for a DTS-partitioned build: it emits
one image per domain and `west flash` programs them in the order given by
domains.yaml. That is fine at a developer's desk and wrong for everyone else —
a release artifact and a browser flasher both want exactly one file.

Deliberately dependency-free (no intelhex, no nrfutil / mergehex): this has to
run inside the NCS toolchain container and in whatever Python a contributor
happens to have. It parses to a flat address->byte map and re-emits, rather
than the usual trick of stripping EOF records and concatenating, so overlaps
are *detected* instead of silently producing two records for one address —
which a flasher may resolve in either order.
"""

import sys


def parse(path):
    """Return {absolute_address: byte}. Raises on a malformed or overlapping file."""
    data = {}
    base = 0                      # upper 16 bits from record type 04/02
    with open(path) as fh:
        for lineno, raw in enumerate(fh, 1):
            line = raw.strip()
            if not line:
                continue
            if not line.startswith(":"):
                raise ValueError(f"{path}:{lineno}: not an Intel HEX record")
            try:
                rec = bytes.fromhex(line[1:])
            except ValueError as e:
                raise ValueError(f"{path}:{lineno}: {e}") from None
            count, addr, rtype = rec[0], (rec[1] << 8) | rec[2], rec[3]
            payload = rec[4:4 + count]
            if len(rec) != count + 5:
                raise ValueError(f"{path}:{lineno}: length byte disagrees with record")
            if (sum(rec) & 0xFF) != 0:
                raise ValueError(f"{path}:{lineno}: checksum mismatch")

            if rtype == 0x00:                       # data
                for i, b in enumerate(payload):
                    data[base + addr + i] = b
            elif rtype == 0x01:                     # end of file
                break
            elif rtype == 0x02:                     # extended segment address
                base = ((payload[0] << 8) | payload[1]) << 4
            elif rtype == 0x04:                     # extended linear address
                base = ((payload[0] << 8) | payload[1]) << 16
            elif rtype in (0x03, 0x05):             # start address — no data
                continue
            else:
                raise ValueError(f"{path}:{lineno}: unsupported record type {rtype:#04x}")
    return data


def emit(data, width=16):
    """Render an address->byte map as Intel HEX records."""
    out = []
    upper = None

    def record(rtype, addr16, payload):
        rec = bytes([len(payload), (addr16 >> 8) & 0xFF, addr16 & 0xFF, rtype]) + payload
        return ":" + (rec + bytes([(-sum(rec)) & 0xFF])).hex().upper()

    addrs = sorted(data)
    i = 0
    while i < len(addrs):
        start = addrs[i]
        chunk = bytearray()
        # A record may not cross a 16-byte-aligned `width` boundary, may not
        # cross a 64K page (the upper address is separate), and may not skip a
        # gap — all three end the run.
        while (i < len(addrs) and len(chunk) < width
               and addrs[i] == start + len(chunk)
               and (start >> 16) == (addrs[i] >> 16)
               and (start + len(chunk)) % width == (start % width + len(chunk)) % width):
            if (start + len(chunk)) % width == 0 and chunk:
                break
            chunk.append(data[addrs[i]])
            i += 1
        page = start >> 16
        if page != upper:
            out.append(record(0x04, 0, bytes([(page >> 8) & 0xFF, page & 0xFF])))
            upper = page
        out.append(record(0x00, start & 0xFFFF, bytes(chunk)))
    out.append(":00000001FF")
    return "\n".join(out) + "\n"


def main(argv):
    if len(argv) < 4:
        sys.exit(__doc__.strip())
    out_path, inputs = argv[1], argv[2:]

    merged = {}
    owner = {}
    for path in inputs:
        chunk = parse(path)
        clash = merged.keys() & chunk.keys()
        if clash:
            at = min(clash)
            sys.exit(f"error: {path} overlaps {owner[at]} at {at:#010x} "
                     f"({len(clash)} bytes) — the partition table and the "
                     f"images disagree about the layout")
        merged.update(chunk)
        for a in chunk:
            owner[a] = path
        lo, hi = min(chunk), max(chunk)
        print(f"  {path}: {len(chunk)} bytes, {lo:#010x}..{hi:#010x}", file=sys.stderr)

    with open(out_path, "w") as fh:
        fh.write(emit(merged))
    lo, hi = min(merged), max(merged)
    print(f"wrote {out_path}: {len(merged)} bytes, {lo:#010x}..{hi:#010x}", file=sys.stderr)


if __name__ == "__main__":
    main(sys.argv)
