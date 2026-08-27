/*
 * Intel HEX parsing, for the release .hex the flasher writes to RRAM.
 *
 * Mirrors updater/tools/merge_hex.py — same record types, same overlap
 * refusal. The two exist separately because one runs in CI and one runs in a
 * browser; if you change how a record is interpreted, change both.
 *
 * Returns contiguous chunks rather than a flat map: the flasher writes through
 * a MEM-AP whose auto-increment wraps at a 1 KB boundary, so it needs runs of
 * addresses it can stream, and a gap in the image must become a new TAR write
 * rather than 0xFF padding it never asked for.
 */

/** One contiguous run of bytes. */
class Chunk {
  constructor(address, bytes) {
    this.address = address;
    this.bytes = bytes;
  }
  get end() { return this.address + this.bytes.length; }
}

export function parseIntelHex(text) {
  const map = new Map();
  let base = 0;                       // upper address bits, from type 02/04
  let sawEof = false;
  const lines = text.split(/\r?\n/);

  for (let n = 0; n < lines.length; n++) {
    const line = lines[n].trim();
    if (!line) continue;
    if (line[0] !== ":") throw new Error(`line ${n + 1}: not an Intel HEX record`);
    if (line.length % 2 !== 1) throw new Error(`line ${n + 1}: odd number of hex digits`);

    const rec = new Uint8Array((line.length - 1) / 2);
    for (let i = 0; i < rec.length; i++) {
      const byte = parseInt(line.substr(1 + i * 2, 2), 16);
      if (Number.isNaN(byte)) throw new Error(`line ${n + 1}: bad hex digit`);
      rec[i] = byte;
    }
    if (rec.length < 5) throw new Error(`line ${n + 1}: record too short`);

    const count = rec[0];
    const addr = (rec[1] << 8) | rec[2];
    const type = rec[3];
    if (rec.length !== count + 5) throw new Error(`line ${n + 1}: length byte disagrees with record`);
    if (rec.reduce((a, b) => (a + b) & 0xff, 0) !== 0) throw new Error(`line ${n + 1}: checksum mismatch`);

    const payload = rec.subarray(4, 4 + count);
    switch (type) {
      case 0x00:
        for (let i = 0; i < payload.length; i++) {
          const at = base + addr + i;
          if (map.has(at)) throw new Error(`line ${n + 1}: address 0x${at.toString(16)} written twice`);
          map.set(at, payload[i]);
        }
        break;
      case 0x01: sawEof = true; break;
      case 0x02: base = ((payload[0] << 8) | payload[1]) * 16; break;
      case 0x04: base = ((payload[0] << 8) | payload[1]) * 65536; break;
      case 0x03: case 0x05: break;               // start address — carries no data
      default: throw new Error(`line ${n + 1}: unsupported record type 0x${type.toString(16)}`);
    }
    if (sawEof) break;
  }

  if (!sawEof) throw new Error("no end-of-file record — the file is truncated");
  if (map.size === 0) throw new Error("no data records");
  return toChunks(map);
}

function toChunks(map) {
  const addrs = [...map.keys()].sort((a, b) => a - b);
  const chunks = [];
  let start = addrs[0];
  let run = [map.get(start)];

  for (let i = 1; i < addrs.length; i++) {
    if (addrs[i] === addrs[i - 1] + 1) {
      run.push(map.get(addrs[i]));
    } else {
      chunks.push(new Chunk(start, Uint8Array.from(run)));
      start = addrs[i];
      run = [map.get(start)];
    }
  }
  chunks.push(new Chunk(start, Uint8Array.from(run)));
  return chunks;
}

export const totalBytes = (chunks) => chunks.reduce((n, c) => n + c.bytes.length, 0);
export const lowAddress = (chunks) => Math.min(...chunks.map(c => c.address));
export const highAddress = (chunks) => Math.max(...chunks.map(c => c.end)) - 1;

/*
 * Split chunks so no piece crosses `boundary`, and none is longer than `max`.
 *
 * The MEM-AP's TAR auto-increments only within an implementation-defined
 * window — 1 KB is the architectural minimum and what we assume. Streaming
 * past it silently wraps back to the start of the window and corrupts what is
 * already there, so the address has to be rewritten at every boundary.
 */
export function splitForWrite(chunks, boundary = 1024, max = 1024) {
  const out = [];
  for (const c of chunks) {
    let off = 0;
    while (off < c.bytes.length) {
      const addr = c.address + off;
      const toBoundary = boundary - (addr % boundary);
      const n = Math.min(c.bytes.length - off, toBoundary, max);
      out.push(new Chunk(addr, c.bytes.subarray(off, off + n)));
      off += n;
    }
  }
  return out;
}

/*
 * RRAM is written a 128-bit line at a time. A chunk that does not end on a
 * 4-byte boundary cannot be written as whole words, so pad to a word. 0xFF is
 * the erased value, which is what the gap would have read as anyway.
 */
export function padToWords(chunk) {
  const rem = chunk.bytes.length % 4;
  if (rem === 0) return chunk;
  const padded = new Uint8Array(chunk.bytes.length + (4 - rem)).fill(0xff);
  padded.set(chunk.bytes);
  return new Chunk(chunk.address, padded);
}

export { Chunk };
