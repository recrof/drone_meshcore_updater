/*
 * A Web Serial port backed by a function instead of hardware.
 *
 * Everything under web/js/lib/ is written to take a `link` rather than reach
 * for `navigator`, which is what makes this possible: the two serial flashers
 * can be driven end to end in node, against a device model that checks what we
 * send as strictly as the real bootloader does.
 *
 * That strictness is the point. A fake that only replays canned answers proves
 * the client can parse a reply; these fakes verify framing, checksums,
 * sequence numbers, block sizes and offsets, and refuse anything wrong — so a
 * protocol mistake fails here rather than on a board, where the symptom is a
 * device that no longer boots and a serial console that is now gone.
 */

/** Web Serial's shape, over a `handle(bytes) -> void` device model. */
export class FakePort {
  /**
   * @param handle  called with every chunk written; use `this.push(bytes)`
   *                (bound as the second argument) to send bytes back.
   * @param signals false models a port with no control lines, which is what a
   *                plain USB-CDC bridge looks like.
   */
  constructor(handle, { signals = true } = {}) {
    this.handle = handle;
    this.opened = null;
    this.closed = false;
    this._controller = null;
    this.written = [];
    /* Every DTR/RTS transition, in order. The reset sequences are pure
     * side-effect — nothing comes back to assert on — so the transitions are
     * the only observable behaviour there is. */
    this.signals = [];
    if (!signals) this.setSignals = undefined;

    this.readable = new ReadableStream({
      start: (c) => { this._controller = c; },
    });
    this.writable = new WritableStream({
      write: async (chunk) => {
        this.written.push(chunk);
        await this.handle(chunk, (bytes) => this.push(bytes));
      },
    });
  }

  push(bytes) {
    if (!this.closed) this._controller.enqueue(Uint8Array.from(bytes));
  }

  async open(options) { this.opened = options; }

  async close() {
    this.closed = true;
    try { this._controller.close(); } catch { /* already closed */ }
  }

  getInfo() { return { usbVendorId: 0x303a, usbProductId: 0x1001 }; }

  async setSignals({ dataTerminalReady = false, requestToSend = false } = {}) {
    this.signals.push({ dtr: dataTerminalReady, rts: requestToSend });
  }

  /** "dtr rts" per transition, e.g. "00 10 01 00" — compact enough to compare
   *  a whole reset sequence against the one esptool documents. */
  signalTrace() {
    return this.signals.map(s => `${s.dtr ? 1 : 0}${s.rts ? 1 : 0}`).join(" ");
  }
}

/**
 * Split a stream of bytes into SLIP frames, un-escaped.
 *
 * Deliberately a second implementation rather than an import of the one under
 * test: a framing bug that is symmetrical — encode and decode wrong in the
 * same way — round-trips perfectly through a single implementation and fails
 * only against real hardware.
 */
export class FrameSplitter {
  constructor() { this.buf = []; this.inFrame = false; }

  /** Returns however many complete frames `chunk` completed. */
  push(chunk) {
    const out = [];
    for (const b of chunk) {
      if (b === 0xc0) {
        if (this.inFrame && this.buf.length) out.push(unescapeSlip(this.buf));
        this.buf = [];
        this.inFrame = true;
      } else if (this.inFrame) {
        this.buf.push(b);
      }
    }
    return out;
  }
}

function unescapeSlip(bytes) {
  const out = [];
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 0xdb) {
      const next = bytes[++i];
      if (next === 0xdc) out.push(0xc0);
      else if (next === 0xdd) out.push(0xdb);
      else throw new Error(`bad SLIP escape 0xDB 0x${next.toString(16)}`);
    } else {
      out.push(bytes[i]);
    }
  }
  return Uint8Array.from(out);
}

export function frameSlip(bytes) {
  const out = [0xc0];
  for (const b of bytes) {
    if (b === 0xc0) out.push(0xdb, 0xdc);
    else if (b === 0xdb) out.push(0xdb, 0xdd);
    else out.push(b);
  }
  out.push(0xc0);
  return Uint8Array.from(out);
}

export const u32 = (buf, at) => new DataView(buf.buffer, buf.byteOffset).getUint32(at, true);
export const u16 = (buf, at) => new DataView(buf.buffer, buf.byteOffset).getUint16(at, true);
