/*
 * BLE transport + SMP framing for the Drone MeshCore Updater.
 *
 * This module knows nothing about the DOM. It emits events instead of
 * touching UI:
 *   "log"          detail { msg, cls }   — human-readable progress/errors
 *   "disconnected"                       — GATT link dropped
 *   "stream"       detail { available }  — fsx_stream discovery result
 *   "dfustatus"    detail { status }     — live DFU progress from the device
 *
 * Protocol layers, innermost first:
 *   ATT Write Command  →  SMP frame (8-B header + CBOR)  →  mgmt group/cmd
 * plus an optional side-channel (`fsx_stream`) for bulk file writes that
 * bypasses SMP's serialized request/response.
 */

import * as CBOR from "./cbor.js";
import {
  DFU_STATUS_SERVICE, DFU_STATUS_CHAR, parseDfuStatus,
} from "./dfu-status.js";

export const SMP_SERVICE = "8d53dc1d-1db7-4cd3-868b-8a527460aa84";
export const SMP_CHAR    = "da2e7828-fbce-4e01-ae9e-261174997c48";

/* fsx_stream — optional fast-upload path. Bypasses SMP's serialized
 * request/response for large file writes. Callers fall back to SMP
 * fs_mgmt upload if the service isn't present.
 */
export const STREAM_SERVICE   = "8d53dc1e-1db7-4cd3-868b-8a527460aa84";
export const STREAM_CTRL_CHAR = "da2e7829-fbce-4e01-ae9e-261174997c48";
export const STREAM_DATA_CHAR = "da2e782a-fbce-4e01-ae9e-261174997c48";

/* Live log streaming — src/log_stream.c. Separate service so it can be absent
 * on older firmware without breaking discovery of the others. */
export const LOG_SERVICE = "8d53dc1f-1db7-4cd3-868b-8a527460aa84";
export const LOG_CHAR    = "da2e782b-fbce-4e01-ae9e-261174997c48";

/* Live DFU progress — src/dfu_status.h. Re-exported so callers have one
 * import for the transport; the layout and labels live in dfu-status.js. */
export { DFU_STATUS_SERVICE, DFU_STATUS_CHAR };

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
/* img_mgmt (group 1). STATE reads the slot table and writes test/confirm
 * flags; UPLOAD streams an image into the spare slot. */
export const IMG_ID = { STATE: 0, UPLOAD: 1, ERASE: 5 };

/* mcumgr's generic result codes (mgmt_defines.h, enum mcumgr_err_t). "rc=1"
 * on its own is unactionable, and this layer is where a user meets it. */
const MGMT_ERR = [
  "ok", "unknown error", "out of memory", "invalid argument", "timeout",
  "not found", "bad state", "response too large", "not supported",
  "corrupt", "busy", "access denied", "protocol version too old",
  "protocol version too new",
];

/* Group-specific codes, sent alongside rc in an `err` map. Far more precise
 * than the generic rc, and mcumgr sends both — reading only rc throws the
 * useful half away. img_mgmt.h, enum img_mgmt_err_code_t. */
const GRP_ERR = {
  /* enum img_mgmt_err_code_t, img_mgmt.h — index is the enum value. Order
   * matters and is asserted against the header by mcuboot-image.test.mjs. */
  [1 /* IMG */]: [
    "ok",
    "unknown error",
    "flash config query failed",
    "no image in that slot",
    "image has no TLVs",
    "invalid TLV",
    "image has multiple hash TLVs",
    "invalid TLV size",
    "image has no hash TLV",
    "no free slot",
    "flash area open failed",
    "flash area read failed",
    "flash write failed",
    "flash erase failed",
    "invalid slot",
    "out of memory",
    "flash context already set",
    "flash context not set",
    "flash area device is null",
    "invalid page offset",
    "invalid offset",
    "invalid length",
    "invalid image header",
    "invalid image header magic — is this a signed image?",
    "invalid hash",
    "invalid flash address",
    "could not read the image version",
    "the running version is newer",
    "an image is already pending",
    "invalid image vector table",
    "image too large for the slot",
    "image data overran the declared length",
    "confirmation denied",
    "cannot mark the running slot for test — the uploaded image is identical " +
      "to the one already running, so there is nothing to swap",
    "active slot not known",
  ],
};

/* Human-readable text for an SMP failure. `body.err` is `{ group, rc }`. */
export function describeSmpError(group, cmd, body) {
  const rc = body?.rc;
  const g = body?.err?.group;
  const grc = body?.err?.rc;
  const specific = (g !== undefined && GRP_ERR[g]?.[grc]) || null;
  const generic = MGMT_ERR[rc] ?? `rc=${rc}`;
  const detail = specific ? `${specific} (${generic})` : generic;
  return `${detail} [group ${group}, cmd ${cmd}]`;
}
export const OS_ID  = { ECHO: 0, RESET: 5, INFO: 7 };
export const FSX_ID = {
  LIST: 0, MKDIR: 1, RMDIR: 2, MOVE: 3, STATVFS: 4, TRIGGER_DFU: 5, STOP_DFU: 6,
  INSPECT: 7, CAPS: 8,
};

/* enum fw_transport_id in updater/src/firmware_inspect.h, as a bitmask. */
export const TRANSPORT_BIT = { BLE: 1, WIFI: 2 };

/* enum fw_kind, same file. Numerically stable: these cross the wire. */
export const FW_KIND = {
  UNKNOWN: 0, NORDIC_ZIP: 1, NCS_ZIP: 2, ESP_APP: 3, ESP_MERGED: 4,
};

/* Chunk size for the stock-SMP upload fallback. */
const SMP_UPLOAD_CHUNK = 800;

/* SMP protocol version to declare in the header. See the note where the
 * header is built — version 1 is what preserves group-specific error codes. */
const SMP_VERSION = 1;

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

    this.logChar = null;           // live log stream, while subscribed
    this._logSink = null;
    this._onLogValue = null;

    this.dfuStatusChar = null;     // live DFU progress, subscribed on connect
    this._onDfuStatusValue = null;
    this._dfuStatusWarned = false;
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
      optionalServices: [SMP_SERVICE, STREAM_SERVICE, LOG_SERVICE,
                         DFU_STATUS_SERVICE],
    });
    this.device.addEventListener("gattserverdisconnected", () => {
      this.log("disconnected", "err");
      this.char = null;
      this.streamCtrl = null;
      this.streamData = null;
      /* Drop the handle without calling stopNotifications — the link is gone
       * and the call would only throw. The firmware disables its backend on
       * disconnect anyway. */
      this.logChar = null;
      this._logSink = null;
      this.dfuStatusChar = null;
      this._onDfuStatusValue = null;
      this.dispatchEvent(new CustomEvent("disconnected"));
    });

    const gatt = await this.device.gatt.connect();
    this.gatt = gatt;
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

    /* Subscribed for the whole session, unlike the log stream. It costs one
     * notification per step and answers the question a connected browser
     * otherwise cannot: is this device in the middle of a DFU right now? */
    this._dfuStatusWarned = false;
    await this.startDfuStatus();

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
        const err = new Error(describeSmpError(hdr.group, hdr.cmd, body));
        err.rc = body.rc;
        err.groupRc = body.err?.rc;
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
    /*
     * Byte 0 is [res:3][version:2][op:3]. Declaring **version 1** is what
     * makes group-specific errors readable.
     *
     * With CONFIG_MCUMGR_SMP_SUPPORT_ORIGINAL_PROTOCOL=y the device writes
     * `err: {group, rc}` and then, if the client spoke version 0, rewrites it
     * to a bare legacy `rc` on the way out — collapsing every img_mgmt reason
     * into rc=1, "unknown error". Sending version 1 keeps the detail, turning
     * "unknown error" into "setting test to active denied".
     *
     * Safe against older firmware: a device that does not understand version 1
     * answers MGMT_ERR_UNSUPPORTED_TOO_NEW, which is a clear message rather
     * than a wrong one.
     */
    hdr[0] = (op & 0x07) | (SMP_VERSION << 3);
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
  /* What is this file, is it intact, and could this device flash it?
   *
   * Resolves to { kind, transport, ok, flashable, reason, bytes, devtype,
   * name, version, chip }. The device reads the whole file to checksum it, so
   * this is not free — call it when a file arrives or when the user asks
   * about one, not while rendering a list. It answers MGMT_ERR_EBUSY (10)
   * during a DFU, which the caller should treat as "ask later", not "bad
   * file". */
  fsxInspect(path) {
    return this.request(MGMT_OP.READ_REQ, GRP.FSX, FSX_ID.INSPECT, { path });
  }
  /* Which transports this build has, as a bitmask of TRANSPORT_BIT.
   *
   * Asked rather than tabulated. The client used to carry its own copy of the
   * firmware's transport table, kept honest by a test; a copy that cannot
   * exist cannot drift. Firmware without this command answers with an error,
   * which the caller reads as "Bluetooth only" — every build ever shipped has
   * had BLE, and that assumption warns rather than falsely reassures. */
  fsxCaps() {
    return this.request(MGMT_OP.READ_REQ, GRP.FSX, FSX_ID.CAPS, {});
  }
  fsxTriggerDfu(path) {
    return this.request(MGMT_OP.WRITE_REQ, GRP.FSX, FSX_ID.TRIGGER_DFU, { path });
  }
  /* Stop a run and clear the status back to IDLE. Resolves to
   * `{ stopped: bool }` — false meaning nothing was running, which is a
   * normal outcome and not an error, so callers never have to check first. */
  fsxStopDfu() {
    return this.request(MGMT_OP.WRITE_REQ, GRP.FSX, FSX_ID.STOP_DFU, {});
  }
  /* --- live log stream ------------------------------------------------
   *
   * Subscribing is what switches the firmware backend on; it emits nothing
   * while nobody is listening. Notifications carry raw text, split at
   * whatever boundary fits an ATT payload — NOT at line boundaries — so the
   * caller has to reassemble. Doing that here keeps every consumer from
   * getting it subtly wrong.
   */
  async startLogStream(onText) {
    if (this.logChar) return true;
    if (!this.gatt?.connected) throw new Error("not connected");
    try {
      const svc = await this.gatt.getPrimaryService(LOG_SERVICE);
      this.logChar = await svc.getCharacteristic(LOG_CHAR);
    } catch {
      /* Firmware predating log_stream.c. Not an error — the viewer offers to
       * re-read the file instead. */
      this.logChar = null;
      return false;
    }
    this._logSink = onText;
    this._onLogValue = (e) => {
      const text = new TextDecoder("utf-8", { fatal: false })
        .decode(e.target.value.buffer ?? e.target.value);
      this._logSink?.(text);
    };
    this.logChar.addEventListener("characteristicvaluechanged", this._onLogValue);
    await this.logChar.startNotifications();
    this.log("live log stream started", "ok");
    return true;
  }

  async stopLogStream() {
    const c = this.logChar;
    if (!c) return;
    this.logChar = null;
    this._logSink = null;
    try { await c.stopNotifications(); } catch { /* link already gone */ }
    if (this._onLogValue) c.removeEventListener("characteristicvaluechanged", this._onLogValue);
    this._onLogValue = null;
  }

  /* --- live DFU status -------------------------------------------------
   *
   * Unlike the log stream, this is subscribed for the whole session: it is
   * cheap (one small notification per step, throttled by the firmware) and
   * it is the only thing that tells a connected browser whether the device
   * is mid-transfer. Absent on firmware predating src/dfu_status.c, which is
   * not an error — the UI simply shows nothing.
   */
  async startDfuStatus() {
    if (this.dfuStatusChar) return true;
    if (!this.gatt?.connected) throw new Error("not connected");
    try {
      const svc = await this.gatt.getPrimaryService(DFU_STATUS_SERVICE);
      this.dfuStatusChar = await svc.getCharacteristic(DFU_STATUS_CHAR);
    } catch {
      this.dfuStatusChar = null;
      return false;
    }
    this._onDfuStatusValue = (e) => this._emitDfuStatus(e.target.value);
    this.dfuStatusChar.addEventListener("characteristicvaluechanged",
      this._onDfuStatusValue);
    await this.dfuStatusChar.startNotifications();

    /* Read once. A DFU can sit in one state for most of a minute, so a
     * browser that connects mid-transfer would otherwise show nothing at all
     * until the step changed. This is why the characteristic is readable. */
    try {
      this._emitDfuStatus(await this.dfuStatusChar.readValue());
    } catch { /* notifications will fill it in */ }
    return true;
  }

  async stopDfuStatus() {
    const c = this.dfuStatusChar;
    if (!c) return;
    this.dfuStatusChar = null;
    try { await c.stopNotifications(); } catch { /* link already gone */ }
    if (this._onDfuStatusValue) {
      c.removeEventListener("characteristicvaluechanged", this._onDfuStatusValue);
    }
    this._onDfuStatusValue = null;
  }

  _emitDfuStatus(dv) {
    const bytes = new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength);
    let status;
    try {
      status = parseDfuStatus(bytes);
    } catch (e) {
      /* Once per connection. A version mismatch would otherwise repeat the
       * same message for every notification of a whole transfer. */
      if (!this._dfuStatusWarned) {
        this._dfuStatusWarned = true;
        this.log(e.message, "err");
      }
      return;
    }
    this.dispatchEvent(new CustomEvent("dfustatus", { detail: { status } }));
  }

  /* Which board is this?
   *
   * `format: "i"` asks os_mgmt's info command for the hardware platform alone,
   * and since Zephyr 4.3 that is the **full board target** — "xiao_ble/nrf52840",
   * "xiao_nrf54lm20a/nrf54lm20a/cpuapp" — the same string the build knows itself
   * by. No custom protocol, and nRF Connect Device Manager can read it too.
   *
   * This is what stops a cross-board update. MCUboot validates an image's
   * signature, not its architecture, and every board here signs with the same
   * key, so an image for the wrong part verifies, swaps in, and fails to boot.
   * Nothing on the device side can catch that; the client has to.
   *
   * Returns null on firmware without CONFIG_MCUMGR_GRP_OS_INFO rather than
   * throwing — that is an older build, not an error.
   */
  async osBoard() {
    try {
      const r = await this.request(MGMT_OP.READ_REQ, GRP.OS, OS_ID.INFO, { format: "i" });
      const out = (r?.output ?? "").trim();
      return out || null;
    } catch {
      return null;
    }
  }

  /* Standard mcumgr OS group reset. Available whenever the firmware is built
   * with CONFIG_REBOOT=y, which registers OS_MGMT_ID_RESET. */
  osReset() {
    return this.request(MGMT_OP.WRITE_REQ, GRP.OS, OS_ID.RESET, {});
  }
  /* --- img_mgmt: updating this device's own firmware -------------------
   *
   * MCUboot does not do BLE DFU — it is a bootloader that swaps slots at
   * reset. The over-the-air half is this group riding the same SMP transport
   * everything else here uses.
   *
   * The sequence, and why it is four steps rather than one:
   *
   *   1. imgUpload()      streams the signed image into the spare slot
   *   2. imgSetPending()  marks it "test": MCUboot swaps it in on next boot
   *   3. osReset()        reboot into it
   *   4. imgConfirm()     make it permanent
   *
   * Step 4 is the safety net and must stay a separate, deliberate act. An
   * image that boots but never gets confirmed is **reverted** by MCUboot on
   * the following reset, so an update that comes up broken enough to lose
   * Bluetooth undoes itself. Confirming during step 2 would throw that away.
   */
  imgState() {
    return this.request(MGMT_OP.READ_REQ, GRP.IMG, IMG_ID.STATE, {});
  }

  /* `hash` is the image's SHA-256 as reported by imgState(). Omitting it
   * confirms the currently running image, which is how step 4 works after a
   * reboot has already made the new image active. */
  imgSetState(hash, confirm) {
    const req = { confirm: !!confirm };
    if (hash) req.hash = hash;
    return this.request(MGMT_OP.WRITE_REQ, GRP.IMG, IMG_ID.STATE, req);
  }
  imgSetPending(hash) { return this.imgSetState(hash, false); }
  imgConfirm(hash = null) { return this.imgSetState(hash, true); }
  imgErase(slot = 1) {
    return this.request(MGMT_OP.WRITE_REQ, GRP.IMG, IMG_ID.ERASE, { slot });
  }

  imgUploadChunk(off, data, total, sha) {
    const req = { image: 0, off, data };
    if (off === 0) {
      req.len = total;
      /* Lets the target detect a resumed or mismatched upload itself rather
       * than trusting our offset bookkeeping. */
      if (sha) req.sha = sha;
    }
    return this.request(MGMT_OP.WRITE_REQ, GRP.IMG, IMG_ID.UPLOAD, req);
  }

  /**
   * Stream a signed image into the spare slot.
   *
   * Always plain SMP, never fsx_stream: that service writes to the
   * filesystem, and this has to land in a flash partition through the
   * device's own image manager. Roughly 10 KB/s, so ~30 s for a 280 KB image.
   *
   * The target dictates progress — it replies with the offset it wants next,
   * which is how a rejected or re-sent chunk self-corrects.
   */
  async imgUpload(bytes, onProgress = null) {
    const sha = await sha256(bytes);
    let off = 0;
    let stalls = 0;
    while (off < bytes.length) {
      const slice = bytes.subarray(off, Math.min(off + SMP_UPLOAD_CHUNK, bytes.length));
      const r = await this.imgUploadChunk(off, slice, bytes.length, off === 0 ? sha : null);
      const next = typeof r.off === "number" ? r.off : off + slice.length;
      /* A target that keeps asking for the same offset will otherwise spin
       * here forever, looking like a very slow upload. */
      if (next <= off) {
        if (++stalls > 3) {
          throw new Error(`upload stuck at offset ${off} — the target keeps asking for the same chunk`);
        }
      } else {
        stalls = 0;
      }
      off = next;
      if (onProgress) onProgress(off / bytes.length);
    }
    return off;
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

/* SHA-256 as a Uint8Array. Web Crypto needs a secure context, which Web
 * Bluetooth already requires, so this is always available here. */
async function sha256(bytes) {
  const d = await crypto.subtle.digest("SHA-256", bytes);
  return new Uint8Array(d);
}
