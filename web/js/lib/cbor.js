/*
 * Tiny CBOR encoder / decoder.
 *
 * Only implements the shapes SMP uses: unsigned ints, negative ints, byte
 * strings, text strings, arrays, and maps. All map keys we produce are tstr.
 * Response maps we consume may have uint keys too (for size fields) — the
 * decoder handles that.
 */

/* ---- encode ---- */
const chunks = () => {
  const parts = [];
  let len = 0;
  return {
    push(u8) { parts.push(u8); len += u8.length; },
    out() {
      const buf = new Uint8Array(len); let off = 0;
      for (const p of parts) { buf.set(p, off); off += p.length; }
      return buf;
    },
  };
};

const type = (major, val, ctx) => {
  const mt = major << 5;
  if (val < 24)          ctx.push(new Uint8Array([mt | val]));
  else if (val < 0x100)  ctx.push(new Uint8Array([mt | 24, val]));
  else if (val < 0x10000) {
    const b = new Uint8Array(3); b[0] = mt | 25;
    new DataView(b.buffer).setUint16(1, val); ctx.push(b);
  } else if (val < 0x100000000) {
    const b = new Uint8Array(5); b[0] = mt | 26;
    new DataView(b.buffer).setUint32(1, val); ctx.push(b);
  } else {
    // uint64 (rare here)
    const b = new Uint8Array(9); b[0] = mt | 27;
    const dv = new DataView(b.buffer);
    dv.setUint32(1, Math.floor(val / 0x100000000));
    dv.setUint32(5, val >>> 0);
    ctx.push(b);
  }
};

const encodeInto = (v, ctx) => {
  if (v === null || v === undefined) {
    ctx.push(new Uint8Array([0xf6])); return;
  }
  if (v === true)  { ctx.push(new Uint8Array([0xf5])); return; }
  if (v === false) { ctx.push(new Uint8Array([0xf4])); return; }
  if (typeof v === "number") {
    if (v < 0) type(1, -1 - v, ctx);
    else       type(0, v, ctx);
    return;
  }
  if (typeof v === "string") {
    const bytes = new TextEncoder().encode(v);
    type(3, bytes.length, ctx);
    ctx.push(bytes); return;
  }
  if (v instanceof Uint8Array) {
    type(2, v.length, ctx);
    ctx.push(v); return;
  }
  if (Array.isArray(v)) {
    type(4, v.length, ctx);
    for (const item of v) encodeInto(item, ctx);
    return;
  }
  if (typeof v === "object") {
    const keys = Object.keys(v);
    type(5, keys.length, ctx);
    for (const k of keys) {
      encodeInto(k, ctx);
      encodeInto(v[k], ctx);
    }
    return;
  }
  throw new Error("cbor: cannot encode " + typeof v);
};

export const encode = (v) => { const c = chunks(); encodeInto(v, c); return c.out(); };

/* ---- decode ----
 * Sentinel returned to signal "we hit an indefinite-length break byte
 * (0xff)". Only meaningful when decoding items INSIDE an indefinite-length
 * array/map/bstr/tstr — a break at top level is a protocol error.
 */
const BREAK = Symbol("cbor-break");

const decodeAt = (buf, off) => {
  const b = buf[off++];
  const major = b >> 5;
  const arg = b & 0x1f;

  /* Indefinite length? arg == 31 (0x1f). Handled per major type. */
  const indef = (arg === 31);
  let val = 0;

  if (!indef) {
    if (arg < 24) val = arg;
    else if (arg === 24) { val = buf[off]; off += 1; }
    else if (arg === 25) { val = (buf[off] << 8) | buf[off + 1]; off += 2; }
    else if (arg === 26) {
      val = ((buf[off] * 0x1000000) + (buf[off+1] * 0x10000)
           + (buf[off+2] * 0x100) + buf[off+3]) >>> 0;
      off += 4;
    } else if (arg === 27) {
      const hi = ((buf[off] * 0x1000000) + (buf[off+1] * 0x10000)
                + (buf[off+2] * 0x100) + buf[off+3]) >>> 0;
      const lo = ((buf[off+4] * 0x1000000) + (buf[off+5] * 0x10000)
                + (buf[off+6] * 0x100) + buf[off+7]) >>> 0;
      val = hi * 0x100000000 + lo;
      off += 8;
    } else {
      throw new Error("cbor: bad arg " + arg);
    }
  }

  switch (major) {
    case 0: return { v: val, off };
    case 1: return { v: -1 - val, off };
    case 2: {
      if (indef) {
        /* Concatenated definite-length byte strings until break. */
        const parts = [];
        for (;;) {
          const r = decodeAt(buf, off);
          if (r.v === BREAK) { off = r.off; break; }
          if (!(r.v instanceof Uint8Array)) throw new Error("cbor: bstr chunk expected");
          parts.push(r.v); off = r.off;
        }
        const total = parts.reduce((n, p) => n + p.length, 0);
        const out = new Uint8Array(total);
        let p = 0; for (const q of parts) { out.set(q, p); p += q.length; }
        return { v: out, off };
      }
      const bytes = buf.subarray(off, off + val);
      return { v: bytes, off: off + val };
    }
    case 3: {
      if (indef) {
        let s = "";
        for (;;) {
          const r = decodeAt(buf, off);
          if (r.v === BREAK) { off = r.off; break; }
          if (typeof r.v !== "string") throw new Error("cbor: tstr chunk expected");
          s += r.v; off = r.off;
        }
        return { v: s, off };
      }
      const bytes = buf.subarray(off, off + val);
      return { v: new TextDecoder().decode(bytes), off: off + val };
    }
    case 4: {
      const arr = [];
      if (indef) {
        for (;;) {
          const r = decodeAt(buf, off);
          if (r.v === BREAK) { off = r.off; break; }
          arr.push(r.v); off = r.off;
        }
        return { v: arr, off };
      }
      for (let i = 0; i < val; i++) {
        const r = decodeAt(buf, off); arr.push(r.v); off = r.off;
      }
      return { v: arr, off };
    }
    case 5: {
      const obj = {};
      if (indef) {
        for (;;) {
          const k = decodeAt(buf, off);
          if (k.v === BREAK) { off = k.off; break; }
          off = k.off;
          const v2 = decodeAt(buf, off);
          if (v2.v === BREAK) throw new Error("cbor: unexpected break in map value");
          obj[k.v] = v2.v; off = v2.off;
        }
        return { v: obj, off };
      }
      for (let i = 0; i < val; i++) {
        const k = decodeAt(buf, off); off = k.off;
        const v2 = decodeAt(buf, off); off = v2.off;
        obj[k.v] = v2.v;
      }
      return { v: obj, off };
    }
    case 7: {
      if (indef) return { v: BREAK, off };     /* 0xff */
      if (arg === 20) return { v: false, off };
      if (arg === 21) return { v: true,  off };
      if (arg === 22) return { v: null,  off };
      throw new Error("cbor: unsupported simple " + arg);
    }
  }
  throw new Error("cbor: unsupported major " + major);
};

export const decode = (buf) => decodeAt(buf, 0).v;
