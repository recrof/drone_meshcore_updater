/*
 * BLE transport + SMP framing for the XIAO nRF54 updater.
 *
 * This module knows nothing about the DOM. It emits events instead of
 * touching UI:
 *   "log"          detail { msg, cls }   — human-readable progress/errors
 *   "disconnected"                       — GATT link dropped
 *   "stream"       detail { available }  — fsx_stream discovery result
 *
 * Protocol layers, innermost first:
 *   ATT Write Command  →  SMP frame (8-B header + CBOR)  →  mgmt group/cmd
 * plus an optional side-channel (`fsx_stream`) for bulk file writes that
 * bypasses SMP's serialized request/response.
 */

import * as CBOR from "./cbor.js";

export const SMP_SERVICE = "8d53dc1d-1db7-4cd3-868b-8a527460aa84";
export const SMP_CHAR    = "da2e7828-fbce-4e01-ae9e-261174997c48";

/* fsx_stream — optional fast-upload path. Bypasses SMP's serialized
 * request/response for large file writes. Callers fall back to SMP
 * fs_mgmt upload if the service isn't present.
 */
export const STREAM_SERVICE   = "8d53dc1e-1db7-4cd3-868b-8a527460aa84";
export const STREAM_CTRL_CHAR = "da2e7829-fbce-4e01-ae9e-261174997c48";
export const STREAM_DATA_CHAR = "da2e782a-fbce-4e01-ae9e-261174997c48";

export const STREAM_OP = {
  START: 0x01, FINISH: 0x02, ABORT: 0x03,
  READY: 0x81, DONE: 0x82, ACK: 0x83, ERROR: 0x8F,
};

export const MGMT_OP = { READ_REQ: 0, READ_RSP: 1, WRITE_REQ: 2, WRITE_RSP: 3 };

export const GRP = {
  OS: 0, IMG: 1, FS: 8,
  FSX: 64,                        // MGMT_GROUP_ID_PERUSER
};

/* NB: stock fs_mgmt has NO delete opcode in this NCS. IDs 0-4 are
 * FILE (upload/download), STAT, HASH_CHECKSUM, SUPPORTED_HASH_CHECKSUM,
 * OPENED_FILE (close). Deletion goes through our fsx_mgmt.rmdir with
 * recursive=false, which invokes fs_unlink() and works on plain files.
 */
export const FS_ID  = { FILE: 0, STAT: 1 };
export const OS_ID  = { ECHO: 0, RESET: 5 };
export const FSX_ID = { LIST: 0, MKDIR: 1, RMDIR: 2, MOVE: 3, STATVFS: 4, TRIGGER_DFU: 5 };

/* Chunk size for the stock-SMP upload fallback. */
const SMP_UPLOAD_CHUNK = 800;

export class SmpClient extends EventTarget {
  constructor() {
    super();
    this.device = null;
    this.char = null;
    this.mtu = 20;                 // conservative default; grows on first write
    this.pending = new Map();      // seq -> { resolve, reject, timeout }
    this.seq = 0;
    this.rxBuf = new Uint8Array(0);

    this.streamCtrl = null;
    this.streamData = null;
    this.streamMaxWrite = 20;
    this.streamPending = null;     // resolver awaiting next CTRL notification
    this.streamAckedBytes = 0;
    this.streamAckResolver = null;

    /* Serializes the writeValueWithoutResponse fragment stream when
     * multiple SMP requests are in flight concurrently. Without this,
     * two callers' fragments would interleave on L2CAP and the peer
     * would see a fragment mid-frame parsed as a new packet header
     * (the `unknown channel ID 0x00xx` warnings from earlier). Chained
     * promises + `.catch()` swallowing means a failed write doesn't
     * poison the queue for later requests.
     */
    this.writeQueue = Promise.resolve();
  }

  /* ---- event helpers ---- */
  log(msg, cls = "") {
    this.dispatchEvent(new CustomEvent("log", { detail: { msg, cls } }));
  }

  get connected() { return !!this.char; }

  /* ---- connection ---- */
  async connect() {
    this.device = await navigator.bluetooth.requestDevice({
      filters: [{ services: [SMP_SERVICE] }],
      optionalServices: [SMP_SERVICE, STREAM_SERVICE],
    });
    this.device.addEventListener("gattserverdisconnected", () => {
      this.log("disconnected", "err");
      this.char = null;
      this.streamCtrl = null;
      this.streamData = null;
      this.dispatchEvent(new CustomEvent("disconnected"));
    });

    const gatt = await this.device.gatt.connect();
    const svc = await gatt.getPrimaryService(SMP_SERVICE);
    this.char = await svc.getCharacteristic(SMP_CHAR);
    await this.char.startNotifications();
    this.char.addEventListener("characteristicvaluechanged",
      (e) => this._onNotify(e.target.value));

    /* Optional: discover the fsx_stream service. Absent on stock SMP
     * firmwares, present on ours — used to route large uploads through
     * a byte-stream path that beats SMP's ~20 KB/s ceiling.
     */
    this.streamCtrl = null;
    this.streamData = null;
    this.streamMaxWrite = 20;
    this.streamPending = null;
    try {
      const streamSvc = await gatt.getPrimaryService(STREAM_SERVICE);
      this.streamCtrl = await streamSvc.getCharacteristic(STREAM_CTRL_CHAR);
      this.streamData = await streamSvc.getCharacteristic(STREAM_DATA_CHAR);
      await this.streamCtrl.startNotifications();
      this.streamCtrl.addEventListener("characteristicvaluechanged",
        (e) => this._onStreamNotify(e.target.value));
      this.log("fsx_stream service found — fast upload enabled", "ok");
    } catch {
      this.log("fsx_stream absent, using SMP for uploads (slower)");
    }
    this.dispatchEvent(new CustomEvent("stream", {
      detail: { available: this.hasStream() },
    }));

    return this.device.name || "(unnamed)";
  }

  disconnect() {
    if (this.device?.gatt?.connected) this.device.gatt.disconnect();
  }

  hasStream() { return !!(this.streamCtrl && this.streamData); }

  /* ---- fsx_stream notifications ---- */
  _onStreamNotify(dv) {
    const bytes = new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength);
    const op = bytes[0];
    /* ACKs are asynchronous flow-control signals — never gate a CTRL
     * request (START/FINISH) on them. Track the newest ACKed byte count
     * in a field so the upload loop can consult it.
     */
    if (op === STREAM_OP.ACK) {
      if (bytes.length >= 5) {
        const dv2 = new DataView(bytes.buffer, bytes.byteOffset);
        this.streamAckedBytes = dv2.getUint32(1, true);
        if (this.streamAckResolver) {
          const r = this.streamAckResolver; this.streamAckResolver = null; r();
        }
      }
      return;
    }
    /* READY / DONE / ERROR: turn-based replies to a CTRL request. */
    if (this.streamPending) {
      const cb = this.streamPending;
      this.streamPending = null;
      cb(bytes);
    }
  }

  /* Resolves the next time an ACK notification arrives (or immediately if
   * the current ACKed count is already >= `target`). Used by the upload
   * loop to throttle when it's flown too far ahead.
   */
  streamWaitForAck(target, timeoutMs = 15000) {
    if ((this.streamAckedBytes ?? 0) >= target) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const to = setTimeout(() => {
        this.streamAckResolver = null;
        reject(new Error("stream ACK timeout — link stalled?"));
      }, timeoutMs);
      this.streamAckResolver = () => { clearTimeout(to); resolve(); };
    });
  }

  /* Fire a control frame and wait for the next CTRL notification.
   * Deliberately simple — the stream protocol is strictly turn-based on
   * CTRL (START → READY, FINISH → DONE), so one pending resolver is enough.
   */
  async streamCtrlCmd(frame, timeoutMs = 15000) {
    if (!this.streamCtrl) throw new Error("stream service not available");
    const p = new Promise((resolve, reject) => {
      const to = setTimeout(() => {
        this.streamPending = null;
        reject(new Error("stream ctrl timeout"));
      }, timeoutMs);
      this.streamPending = (bytes) => { clearTimeout(to); resolve(bytes); };
    });
    await this.streamCtrl.writeValueWithResponse(frame);
    return p;
  }

  /* ---- SMP notification reassembly ---- */
  _onNotify(dv) {
    const chunk = new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength);
    // Concatenate into the reassembly buffer.
    const merged = new Uint8Array(this.rxBuf.length + chunk.length);
    merged.set(this.rxBuf); merged.set(chunk, this.rxBuf.length);
    this.rxBuf = merged;

    // We might have zero, one, or multiple complete SMP messages queued.
    while (this.rxBuf.length >= 8) {
      const hdr = this._parseHdr(this.rxBuf);
      const total = 8 + hdr.length;
      if (this.rxBuf.length < total) return;   // wait for more fragments
      const payload = this.rxBuf.subarray(8, total);
      this.rxBuf = this.rxBuf.subarray(total);
      this._deliver(hdr, payload);
    }
  }

  _parseHdr(buf) {
    return {
      op:     buf[0] & 0x07,
      flags:  buf[1],
      length: (buf[2] << 8) | buf[3],
      group:  (buf[4] << 8) | buf[5],
      seq:    buf[6],
      cmd:    buf[7],
    };
  }

  _deliver(hdr, payload) {
    const p = this.pending.get(hdr.seq);
    if (!p) return;
    this.pending.delete(hdr.seq);
    clearTimeout(p.timeout);
    try {
      const body = CBOR.decode(payload);
      if (body && typeof body === "object" && "rc" in body && body.rc !== 0) {
        const err = new Error(`SMP rc=${body.rc} (group ${hdr.group}, cmd ${hdr.cmd})`);
        err.rc = body.rc;
        p.reject(err);
      } else {
        p.resolve(body ?? {});
      }
    } catch (e) {
      p.reject(e);
    }
  }

  async request(op, group, cmd, body = {}) {
    if (!this.char) throw new Error("not connected");
    const cbor = CBOR.encode(body);
    const seq = (this.seq++) & 0xff;

    const hdr = new Uint8Array(8);
    hdr[0] = op & 0x07;
    hdr[1] = 0;
    hdr[2] = (cbor.length >> 8) & 0xff;
    hdr[3] = cbor.length & 0xff;
    hdr[4] = (group >> 8) & 0xff;
    hdr[5] = group & 0xff;
    hdr[6] = seq;
    hdr[7] = cmd;

    const frame = new Uint8Array(8 + cbor.length);
    frame.set(hdr); frame.set(cbor, 8);

    const p = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(seq);
        reject(new Error(`timeout waiting for seq ${seq} (group ${group}, cmd ${cmd})`));
      }, 15000);
      this.pending.set(seq, { resolve, reject, timeout });
    });

    /* Zephyr's SMP characteristic advertises WRITE_WITHOUT_RESPONSE +
     * NOTIFY, no plain WRITE property, so we MUST use write-without-
     * response — writeValueWithResponse fails with "GATT operation failed
     * for unknown reason" on this peer.
     *
     * Chrome's writeValueWithoutResponse doesn't auto-fragment beyond a
     * single ATT Write Command, so we fragment the SMP frame here into
     * MTU-sized pieces. The device's MCUMGR_TRANSPORT_BT_REASSEMBLY config
     * stitches them back together based on the SMP header's length field.
     *
     * Chrome doesn't expose the negotiated ATT MTU to script, so we pick a
     * safe default. MAX_FRAG was bumped from 180 → 240 to send bigger ATT
     * WriteCmds and therefore fewer per-chunk Chrome calls: each
     * writeValueWithoutResponse on macOS has ~10 ms of platform-Bluetooth
     * queue latency, so 4 fragments-per-chunk instead of 5 saves ~10 ms per
     * round-trip. The 240 B cap is comfortably under the ~244 B Chrome
     * typically negotiates for ATT MTU minus the 3 B header.
     *
     * Push our fragment stream to the write queue so overlapping requests
     * (upload pipelining) don't interleave fragments on the L2CAP layer.
     */
    const MAX_FRAG = 240;
    const doWrites = async () => {
      for (let i = 0; i < frame.length; i += MAX_FRAG) {
        const piece = frame.subarray(i, Math.min(i + MAX_FRAG, frame.length));
        await this.char.writeValueWithoutResponse(piece);
        if (i + MAX_FRAG < frame.length) {
          await new Promise(r => setTimeout(r, 1));
        }
      }
    };
    const myWrite = this.writeQueue.then(doWrites, doWrites);
    /* Keep the chain alive but don't propagate errors — a failed write for
     * request A shouldn't block requests B, C from writing.
     */
    this.writeQueue = myWrite.catch(() => {});
    await myWrite;
    return p;
  }

  /* ---- convenience wrappers ---- */
  fsxList(path, off = 0, count = 32) {
    return this.request(MGMT_OP.READ_REQ, GRP.FSX, FSX_ID.LIST, { path, off, count });
  }
  fsxMkdir(path) {
    return this.request(MGMT_OP.WRITE_REQ, GRP.FSX, FSX_ID.MKDIR, { path });
  }
  fsxRmdir(path, recursive = false) {
    return this.request(MGMT_OP.WRITE_REQ, GRP.FSX, FSX_ID.RMDIR, { path, recursive });
  }
  fsxMove(src, dst) {
    return this.request(MGMT_OP.WRITE_REQ, GRP.FSX, FSX_ID.MOVE, { src, dst });
  }
  fsxStatvfs(path) {
    return this.request(MGMT_OP.READ_REQ, GRP.FSX, FSX_ID.STATVFS, { path });
  }
  fsxTriggerDfu(path) {
    return this.request(MGMT_OP.WRITE_REQ, GRP.FSX, FSX_ID.TRIGGER_DFU, { path });
  }
  /* Standard mcumgr OS group reset. Available whenever the firmware is built
   * with CONFIG_REBOOT=y, which registers OS_MGMT_ID_RESET. */
  osReset() {
    return this.request(MGMT_OP.WRITE_REQ, GRP.OS, OS_ID.RESET, {});
  }
  fsUploadChunk(name, off, data, len /* total file len, only on off==0 */) {
    const req = { name, off, data };
    if (off === 0) req.len = len;
    return this.request(MGMT_OP.WRITE_REQ, GRP.FS, FS_ID.FILE, req);
  }
  fsDownloadChunk(name, off) {
    return this.request(MGMT_OP.READ_REQ, GRP.FS, FS_ID.FILE, { name, off });
  }

  /* ---- whole-file helpers -----------------------------------------
   * These are the API the UI actually wants. Unlike the old inline
   * versions they *throw* on failure rather than logging and returning,
   * so callers can distinguish "saved" from "silently didn't".
   * ------------------------------------------------------------------ */

  /* Read an entire file. `onProgress(fraction 0..1)` is optional and only
   * fires once the peer has told us the total length.
   */
  async readFile(path, onProgress = null) {
    let off = 0;
    let total = null;
    const parts = [];
    for (;;) {
      const r = await this.fsDownloadChunk(path, off);
      if (r.data) parts.push(r.data);
      if (total === null && typeof r.len === "number") total = r.len;
      const nread = r.data ? r.data.length : 0;
      off += nread;
      if (total !== null && onProgress) onProgress(Math.min(1, off / total));
      if (total !== null && off >= total) break;
      if (nread === 0) break;
    }
    const merged = new Uint8Array(parts.reduce((n, c) => n + c.length, 0));
    let p = 0; for (const c of parts) { merged.set(c, p); p += c.length; }
    return merged;
  }

  /* Write an entire file, preferring fsx_stream when the peer offers it. */
  async writeFile(path, bytes, onProgress = null) {
    return this.hasStream()
      ? this._writeFileStream(path, bytes, onProgress)
      : this._writeFileSmp(path, bytes, onProgress);
  }

  /* --------- fast path: fsx_stream ---------
   * 1. START on CTRL, wait for READY (gets max_data_per_write from server).
   * 2. Fire DATA writes as fast as Chrome's write queue accepts them; each
   *    write carries up to max_data bytes of raw file content. No per-chunk
   *    ACK — BLE LL guarantees in-order delivery.
   * 3. FINISH on CTRL, wait for DONE.
   */
  async _writeFileStream(path, buf, onProgress) {
    /* Reset ACK tracking for this session so a stale value from a previous
     * upload doesn't confuse the throttle.
     */
    this.streamAckedBytes = 0;
    this.streamAckResolver = null;
    try {
      /* Build START frame: op(1) | name_len(1) | name | total(u32-le) */
      const nameBytes = new TextEncoder().encode(path);
      if (nameBytes.length > 128) throw new Error("path too long");
      const start = new Uint8Array(1 + 1 + nameBytes.length + 4);
      start[0] = STREAM_OP.START;
      start[1] = nameBytes.length;
      start.set(nameBytes, 2);
      new DataView(start.buffer).setUint32(2 + nameBytes.length, buf.length, true);

      const ready = await this.streamCtrlCmd(start);
      if (ready[0] !== STREAM_OP.READY || ready[1] !== 0) {
        throw new Error(`stream START rejected (op=0x${ready[0].toString(16)} rc=${ready[1]})`);
      }
      const readyDv = new DataView(ready.buffer, ready.byteOffset);
      const maxWrite    = readyDv.getUint16(2, true);
      const ackInterval = readyDv.getUint32(4, true);
      this.streamMaxWrite = maxWrite;

      /* Send window: how far ahead of the last ACK we're allowed to fly.
       * Larger = better link utilisation but higher risk of Chrome's
       * platform queue overflowing (writes silently dropped). 2× the
       * server's ACK interval means we'll queue up to ~2 ACK-worths of data
       * before pausing for an ACK — sits nicely between "always blocked"
       * and "flooding the queue."
       */
      const WINDOW = ackInterval * 2;

      let off = 0;
      while (off < buf.length) {
        /* Backpressure: don't get more than WINDOW bytes ahead of the last
         * ACK. When we're at the ceiling, wait for the next ACK before
         * firing more writes.
         */
        if (off - this.streamAckedBytes >= WINDOW) {
          await this.streamWaitForAck(off - WINDOW + ackInterval);
        }
        const slice = buf.subarray(off, Math.min(off + maxWrite, buf.length));
        await this.streamData.writeValueWithoutResponse(slice);
        off += slice.length;
        if (onProgress) onProgress(off / buf.length);
      }

      /* FINISH → DONE. The device flushes the file, unlinks on failure,
       * arms the DFU state machine if the path ends in .zip.
       * Long timeout: the last few writes may still be draining.
       */
      const done = await this.streamCtrlCmd(new Uint8Array([STREAM_OP.FINISH]), 30000);
      if (done[0] !== STREAM_OP.DONE || done[1] !== 0) {
        throw new Error(`stream FINISH failed (op=0x${done[0].toString(16)} rc=${done[1]})`);
      }
      const written = new DataView(done.buffer, done.byteOffset).getUint32(2, true);
      if (written !== buf.length) {
        /* A short write means the file on flash is truncated — that is
         * data loss, not a warning. Surface it as a failure so callers
         * don't report success for a corrupt file.
         */
        throw new Error(`short write: server stored ${written} of ${buf.length} B (lost fragment)`);
      }
      return written;
    } catch (e) {
      /* Best-effort ABORT so the server-side session doesn't linger. */
      try {
        await this.streamCtrl.writeValueWithoutResponse(new Uint8Array([STREAM_OP.ABORT]));
      } catch { /* ignore — link may already be gone */ }
      throw e;
    }
  }

  /* --------- fallback: stock SMP fs_mgmt ---------
   * Sequential 800-B chunks via SMP FILE/UPLOAD. Kept as fallback for any
   * peer that doesn't advertise the fsx_stream service (e.g. stock Zephyr
   * smp_svr sample).
   */
  async _writeFileSmp(path, buf, onProgress) {
    let off = 0;
    while (off < buf.length) {
      const slice = buf.subarray(off, Math.min(off + SMP_UPLOAD_CHUNK, buf.length));
      const r = await this.fsUploadChunk(path, off, slice, buf.length);
      if (typeof r.off === "number") off = r.off;
      else off += slice.length;
      if (onProgress) onProgress(off / buf.length);
    }
    return off;
  }
}
