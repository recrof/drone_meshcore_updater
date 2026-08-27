#!/usr/bin/env node
/*
 * Generate the PWA icons — web/icons/*.png.
 *
 *   node web/tools/make-icons.mjs
 *
 * The icons are committed, so this only needs re-running when the mark
 * changes. It exists because the project has no build step and no npm
 * dependencies: rather than check in a binary nobody can regenerate, the
 * mark is described here as geometry and rasterised with node's own zlib.
 *
 * The mark is the updater's job in one glyph: an arrow rising off a base
 * line — firmware leaving this device for the target.
 */

import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

const ICONS = resolve(dirname(fileURLToPath(import.meta.url)), "..", "icons");

/* --- minimal PNG writer ------------------------------------------------ */

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/* rgba: Uint8Array of w*h*4, no interlacing, filter type 0 per scanline. */
function encodePng(w, h, rgba) {
  const raw = Buffer.alloc(h * (1 + w * 4));
  for (let y = 0; y < h; y++) {
    const o = y * (1 + w * 4);
    raw[o] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * w * 4, w * 4).copy(raw, o + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;      // bit depth
  ihdr[9] = 6;      // colour type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/* --- the mark, in unit coordinates ------------------------------------- */

/* tokens.css --accent / --accent-fg, so the icon matches the running app. */
const GREEN = [0x2e, 0x9e, 0x6b];
const WHITE = [0xff, 0xff, 0xff];

const inRect = (x, y, x0, y0, x1, y1) => x >= x0 && x <= x1 && y >= y0 && y <= y1;

/* Rounded rect via the corner-circle trick: inside the inset cross, or
 * within r of the nearest corner centre. */
function inRoundRect(x, y, x0, y0, x1, y1, r) {
  if (!inRect(x, y, x0, y0, x1, y1)) return false;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  const dx = x - cx, dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

/* Isosceles triangle, apex up. */
function inArrowHead(x, y, apexX, apexY, baseY, halfW) {
  if (y < apexY || y > baseY) return false;
  const t = (y - apexY) / (baseY - apexY);
  return Math.abs(x - apexX) <= halfW * t;
}

/* `scale` shrinks the glyph about the centre — maskable icons must keep
 * their content inside the safe zone, since launchers crop to a circle. */
function markAt(x, y, scale) {
  const gx = 0.5 + (x - 0.5) / scale;
  const gy = 0.5 + (y - 0.5) / scale;
  return inArrowHead(gx, gy, 0.5, 0.15, 0.45, 0.255)
      || inRoundRect(gx, gy, 0.435, 0.42, 0.565, 0.70, 0.03)
      || inRoundRect(gx, gy, 0.275, 0.775, 0.725, 0.855, 0.04);
}

/* 4x4 supersampling — the shapes are hard-edged predicates, so the only
 * anti-aliasing available is coverage. */
const SS = 4;

function render(size, { maskable }) {
  const px = new Uint8Array(size * size * 4);
  const scale = maskable ? 0.72 : 1;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let bg = 0, fg = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const u = (x + (sx + 0.5) / SS) / size;
          const v = (y + (sy + 0.5) / SS) / size;
          /* Maskable icons bleed to the edges; the plain icon is a rounded
           * square so it reads as an app tile on its own. */
          const on = maskable ? true : inRoundRect(u, v, 0, 0, 1, 1, 0.22);
          if (!on) continue;
          bg++;
          if (markAt(u, v, scale)) fg++;
        }
      }
      const n = SS * SS;
      const a = bg / n;
      const m = fg / n;
      const o = (y * size + x) * 4;
      /* Composite white over green first, then apply the tile's own alpha,
       * so the glyph never bleeds outside the rounded corners. */
      for (let c = 0; c < 3; c++) {
        px[o + c] = Math.round((GREEN[c] * (a - m) + WHITE[c] * m) / (a || 1));
      }
      px[o + 3] = Math.round(a * 255);
    }
  }
  return encodePng(size, size, px);
}

mkdirSync(ICONS, { recursive: true });
for (const [name, size, opts] of [
  ["icon-192.png", 192, { maskable: false }],
  ["icon-512.png", 512, { maskable: false }],
  ["icon-maskable-512.png", 512, { maskable: true }],
]) {
  const buf = render(size, opts);
  writeFileSync(join(ICONS, name), buf);
  console.error(`wrote icons/${name} (${size}x${size}, ${buf.length} B)`);
}
