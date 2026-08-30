/*
 * Web Serial: one port, one read loop, a byte buffer, and SLIP framing.
 *
 * Two of the three boards are flashed over a serial port rather than through a
 * debug probe — the XIAO nRF52840 through the Adafruit bootloader's Nordic
 * Legacy DFU, the XIAO ESP32-S3 through the ROM loader — and both wrap their
 * packets in the *same* SLIP framing (RFC 1055 escapes, 0xC0 delimiters).
 * That is the whole reason this file is shared: the protocols above it have
 * nothing in common, the framing below it is byte-identical.
 *
 * ---- Why a persistent read loop, and not a reader per read ---------------
 *
 * `port.readable.getReader()` takes an exclusive lock, and **releasing it
 * discards whatever the stream had already buffered**. Taking a fresh reader
 * for each request therefore drops any bytes that arrived between requests —
 * which, for a device that answers faster than the next call is made, is the
 * reply you were about to wait for. It fails as an intermittent timeout under
 * load and never in a test, so: one reader, held open for the life of the
 * connection, appending into a buffer that the protocol layers consume from.
 *
 * ---- Noise is kept, not dropped -----------------------------------------
 *
 * Anything that arrives before the first 0xC0 is not part of a frame, but it
 * is not worthless: on the ESP32-S3 it is the ROM banner
 * ("ESP-ROM:esp32s3-...", "waiting for download"), which is the difference
 * between "the chip is in download mode and ignoring us" and "the chip is
 * running the application". `takeNoise()` hands it to the caller to log.
 *
 * No DOM dependency beyond `navigator.serial` itself, and the framing helpers
 * take plain byte arrays, so web/test/serial.test.mjs drives all of it in
 * node with no browser and no hardware.
 */

/** Chrome and Edge on desktop. Firefox, Safari and all of iOS have none. */
export function webSerialAvailable() {
  return typeof navigator !== "undefined" && !!navigator.serial;
}

export const SLIP_END = 0xc0;
export const SLIP_ESC = 0xdb;
export const SLIP_ESC_END = 0xdc;
export const SLIP_ESC_ESC = 0xdd;

/** Wrap `data` in a SLIP frame: escape, then delimit at both ends. */
export function slipEncode(data) {
  const out = [SLIP_END];
  for (const b of data) {
    if (b === SLIP_END) out.push(SLIP_ESC, SLIP_ESC_END);
    else if (b === SLIP_ESC) out.push(SLIP_ESC, SLIP_ESC_ESC);
    else out.push(b);
  }
  out.push(SLIP_END);
  return Uint8Array.from(out);
}

/**
 * Un-escape the *contents* of one frame — the bytes between the delimiters.
 *
 * A stray 0xC0 inside is treated as a delimiter that should not be here and
 * skipped rather than thrown on: both bootloaders emit back-to-back frames,
 * and a run of delimiters is how that looks when the reader is a byte behind.
 */
export function slipDecode(data) {
  const out = [];
  for (let i = 0; i < data.length; i++) {
    const b = data[i];
    if (b === SLIP_ESC) {
      const next = data[++i];
      if (next === SLIP_ESC_END) out.push(SLIP_END);
      else if (next === SLIP_ESC_ESC) out.push(SLIP_ESC);
      else throw new Error(`bad SLIP escape 0xDB 0x${(next ?? 0).toString(16)}`);
    } else if (b !== SLIP_END) {
      out.push(b);
    }
  }
  return Uint8Array.from(out);
}

export class SerialTimeout extends Error {
  constructor(what) {
    super(`timed out waiting for ${what}`);
    this.name = "SerialTimeout";
  }
}

/**
 * A serial port with a read loop attached.
 *
 * `port` is anything with the Web Serial shape, which is what lets the tests
 * substitute a fake device: open/close, readable/writable, setSignals,
 * getInfo. Nothing here reaches for `navigator`.
 */
export class SerialLink {
  constructor(port) {
    this.port = port;
    this.buf = new Uint8Array(0);
    this.noise = [];
    this.closed = false;
    this.readError = null;
    this._reader = null;
    this._writer = null;
    this._waiters = [];
    this._loop = null;
    /*
     * Optional (dir, bytes) sink for every frame in and out.
     *
     * Both bootloaders on the other end of this file are opaque: one has no
     * console at all in download mode, the other resets instead of reporting
     * an error. When a transfer fails, the exchange itself is the only
     * evidence there is — so it can be handed to the browser console rather
     * than reconstructed from guesses.
     */
    this.trace = null;
  }

  /** Prompt for a port. Filters are advisory — the user can always pick any. */
  static async request(filters = []) {
    if (!webSerialAvailable()) throw new Error("this browser has no Web Serial");
    const port = await navigator.serial.requestPort(filters.length ? { filters } : {});
    return new SerialLink(port);
  }

  async open(options = { baudRate: 115200 }) {
    await this.port.open(options);
    this.closed = false;
    this.readError = null;
    this._loop = this._readLoop();
  }

  async _readLoop() {
    try {
      this._reader = this.port.readable.getReader();
      for (;;) {
        const { value, done } = await this._reader.read();
        if (done) break;
        if (value && value.length) this._push(value);
      }
    } catch (e) {
      /* A port yanked mid-transfer lands here. Recorded rather than thrown,
       * because nothing is awaiting this loop — the waiter sees it instead. */
      if (!this.closed) this.readError = e;
    } finally {
      try { this._reader?.releaseLock(); } catch { /* already gone */ }
      this._reader = null;
      this.closed = true;
      this._notify();
    }
  }

  _push(chunk) {
    const merged = new Uint8Array(this.buf.length + chunk.length);
    merged.set(this.buf, 0);
    merged.set(chunk, this.buf.length);
    this.buf = merged;
    this._notify();
  }

  _notify() {
    const waiting = this._waiters;
    this._waiters = [];
    for (const w of waiting) w();
  }

  /** Resolve on the next arrival, or reject when the deadline passes. */
  _arrival(deadline, what) {
    if (this.closed) {
      return Promise.reject(this.readError ?? new Error("serial port closed"));
    }
    return new Promise((resolve, reject) => {
      const fire = () => { clearTimeout(timer); resolve(); };
      const timer = setTimeout(() => {
        this._waiters = this._waiters.filter(w => w !== fire);
        reject(new SerialTimeout(what));
      }, Math.max(0, deadline - Date.now()));
      this._waiters.push(fire);
    });
  }

  async write(bytes) {
    if (!this._writer) this._writer = this.port.writable.getWriter();
    await this._writer.write(bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes));
  }

  /** Frame and send in one step — every caller of `write` wants this. */
  writeFrame(data) {
    this.trace?.("tx", data);
    return this.write(slipEncode(data));
  }

  async setSignals(signals) {
    if (this.port.setSignals) await this.port.setSignals(signals);
  }

  getInfo() {
    return this.port.getInfo ? this.port.getInfo() : {};
  }

  /** Everything received so far that was not inside a frame, as a string. */
  takeNoise() {
    const text = this.noise.join("");
    this.noise = [];
    return text;
  }

  /**
   * Drop buffered input, keeping it as noise.
   *
   * Called before a sync so a stale reply from a previous attempt cannot be
   * mistaken for the answer to this one. What it discards is *not* thrown
   * away: when nothing ever answers — which is what a board that is not in
   * bootloader mode looks like — the bytes sitting here are the board's own
   * boot log, and that is the entire diagnosis. Dropping them left the
   * ESP32-S3 flasher reporting "no answer from the chip" while holding the
   * proof that the application was running.
   */
  flush() {
    if (this.buf.length) this.noise.push(bytesToText(this.buf));
    this.buf = new Uint8Array(0);
  }

  /**
   * Read one complete SLIP frame, decoded.
   *
   * Bytes before the opening delimiter are moved to `noise` rather than
   * silently dropped; empty frames (two delimiters in a row, which is how a
   * back-to-back pair reads) are consumed and the scan continues.
   */
  async readFrame(timeoutMs, what = "a reply") {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const start = this.buf.indexOf(SLIP_END);
      if (start > 0) {
        this.noise.push(bytesToText(this.buf.subarray(0, start)));
        this.buf = this.buf.subarray(start);
        continue;
      }
      if (start === 0) {
        const end = this.buf.indexOf(SLIP_END, 1);
        if (end > 0) {
          const body = this.buf.subarray(1, end);
          this.buf = this.buf.subarray(end + 1);
          if (body.length === 0) continue;      // C0 C0 — an empty frame
          const frame = slipDecode(body);
          this.trace?.("rx", frame);
          return frame;
        }
      }
      await this._arrival(deadline, what);
    }
  }

  /** Wait until at least `n` bytes are buffered, then take them. */
  async readBytes(n, timeoutMs, what = "data") {
    const deadline = Date.now() + timeoutMs;
    while (this.buf.length < n) await this._arrival(deadline, what);
    const out = this.buf.subarray(0, n);
    this.buf = this.buf.subarray(n);
    return out;
  }

  /** Give the device a moment to say something; never throws. */
  async drain(ms) {
    try { await this._arrival(Date.now() + ms, "anything"); } catch { /* quiet is fine */ }
  }

  async close() {
    this.closed = true;
    try { await this._reader?.cancel(); } catch { /* already gone */ }
    try { this._writer?.releaseLock(); } catch { /* already gone */ }
    this._writer = null;
    try { await this._loop; } catch { /* recorded, not thrown */ }
    try { await this.port.close(); } catch { /* already gone */ }
    this._notify();
  }
}

/* Latin-1 rather than UTF-8: this is a boot banner that may be cut mid-word
 * and may contain line noise, and a decoder that throws on it would turn
 * useful diagnostics into an error. */
function bytesToText(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return s;
}

export const sleep = (ms) => new Promise(r => setTimeout(r, ms));
