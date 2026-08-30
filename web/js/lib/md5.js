/*
 * MD5, because the ESP32-S3 ROM loader only offers MD5 for read-back.
 *
 * Nothing here is security-relevant and nothing here should be reused as if
 * it were: MD5 is used exactly once, to ask the chip "what is the digest of
 * the region I just wrote" and compare it with the digest of what we meant to
 * write. `crypto.subtle` has no MD5 — deliberately, and rightly — so this is
 * the only way to take the ROM up on the offer.
 *
 * **Why bother verifying at all.** Trap 1 in notes/traps.md is a flash write
 * whose final partial line was never committed: the write reported success,
 * the device booted wrong, and the cause was mis-attributed to a list of
 * unrelated Kconfig options for days. The lesson written down there is that a
 * flash write is not done until it has been read back. The nRF54L probe
 * flasher verifies word by word over SWD; here the chip does it for us for
 * the cost of one command per image.
 *
 * Straight RFC 1321. web/test/md5.test.mjs checks it against the RFC's own
 * test suite plus a long input, which is the only part with any subtlety —
 * the length is appended as a 64-bit count of *bits*.
 */

const S = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];

/* K[i] = floor(2^32 * abs(sin(i + 1))), computed rather than tabulated so a
 * transcription error is not possible. */
const K = Array.from({ length: 64 }, (_, i) =>
  Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) >>> 0);

const rotl = (x, c) => ((x << c) | (x >>> (32 - c))) >>> 0;

/** MD5 of a byte array, as a 32-character lower-case hex string. */
export function md5Hex(bytes) {
  const input = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes);
  const bitLen = input.length * 8;

  /* Pad to 56 mod 64, then eight bytes of little-endian bit count. */
  const padded = new Uint8Array(((input.length + 8) >> 6 << 6) + 64);
  padded.set(input);
  padded[input.length] = 0x80;
  const view = new DataView(padded.buffer);
  /* Split rather than using BigInt: an image large enough to overflow 32 bits
   * of bit-count is 512 MB, which no flash here can hold, but writing both
   * halves costs nothing and keeps the function honest for any input. */
  view.setUint32(padded.length - 8, bitLen >>> 0, true);
  view.setUint32(padded.length - 4, Math.floor(bitLen / 4294967296), true);

  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  const m = new Uint32Array(16);

  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) m[i] = view.getUint32(off + i * 4, true);

    let a = a0, b = b0, c = c0, d = d0;
    for (let i = 0; i < 64; i++) {
      let f, g;
      if (i < 16)      { f = (b & c) | (~b & d);          g = i; }
      else if (i < 32) { f = (d & b) | (~d & c);          g = (5 * i + 1) & 15; }
      else if (i < 48) { f = b ^ c ^ d;                   g = (3 * i + 5) & 15; }
      else             { f = c ^ (b | ~d);                g = (7 * i) & 15; }

      const tmp = d;
      d = c;
      c = b;
      b = (b + rotl((a + f + K[i] + m[g]) >>> 0, S[i])) >>> 0;
      a = tmp;
    }
    a0 = (a0 + a) >>> 0;
    b0 = (b0 + b) >>> 0;
    c0 = (c0 + c) >>> 0;
    d0 = (d0 + d) >>> 0;
  }

  return [a0, b0, c0, d0].map(leHex).join("");
}

/* Each word goes out little-endian, which is what makes MD5 digests read the
 * way they do. */
function leHex(w) {
  let s = "";
  for (let i = 0; i < 4; i++) s += ((w >>> (i * 8)) & 0xff).toString(16).padStart(2, "0");
  return s;
}
