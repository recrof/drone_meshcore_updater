/*
 * CMSIS-DAP over WebUSB, and just enough SWD to program an nRF54L.
 *
 * Why this is possible at all: the XIAO nRF54LM20A's USB-C goes to an on-board
 * SAMD11 running CMSIS-DAP, not to the nRF54. That is normally the thing
 * standing between a user and a one-click flash — but the SAMD11 exposes a
 * *v2* (vendor-class, bulk) interface alongside the v1 HID one, and a
 * vendor-class interface is exactly what WebUSB is allowed to claim. Verified
 * on hardware:
 *
 *   Seeed Studio XIAO nRF54LM20A CMSIS-DAP   VID 0x2886  PID 0x0068
 *     if 0   class 3    (HID)     "CMSIS-DAP v1 Adapter"
 *     if 1   class 255  (vendor)  "CMSIS-DAP v2 Adapter"   <- this one
 *     if 2/3 class 2/10 (CDC)     the serial console
 *
 * Only v2 is implemented. v1 needs WebHID and a report-ID byte on every
 * packet; adding it is mechanical if a probe ever turns up without v2.
 */

/* --- CMSIS-DAP command IDs (subset) ------------------------------------ */
const CMD = {
  INFO: 0x00, HOST_STATUS: 0x01, CONNECT: 0x02, DISCONNECT: 0x03,
  TRANSFER_CONFIGURE: 0x04, TRANSFER: 0x05, TRANSFER_BLOCK: 0x06,
  WRITE_ABORT: 0x08, SWJ_CLOCK: 0x11, SWJ_SEQUENCE: 0x12, SWD_CONFIGURE: 0x13,
};

const PORT_SWD = 1;

/* DAP_Transfer request bits. */
const APnDP = 1 << 0;
const RnW   = 1 << 1;

/* ACK values in a transfer response. */
const ACK_OK = 0x01, ACK_WAIT = 0x02, ACK_FAULT = 0x04;

/* Debug Port registers (A[3:2] selects, banked through SELECT). */
export const DP = { DPIDR: 0x00, ABORT: 0x00, CTRL_STAT: 0x04, SELECT: 0x08, RDBUFF: 0x0c };
/* MEM-AP registers. */
export const AP = { CSW: 0x00, TAR: 0x04, DRW: 0x0c, IDR: 0xfc };

const CSYSPWRUPREQ = 1 << 30, CDBGPWRUPREQ = 1 << 28;
const CSYSPWRUPACK = 1 << 31, CDBGPWRUPACK = 1 << 29;

/* MEM-AP auto-increment is only guaranteed inside a 1 KB window. */
export const TAR_WRAP = 1024;

/*
 * CSW low bits: Size = 32-bit (bits[2:0] = 0b010) and AddrInc = increment
 * single (bits[5:4] = 0b01).
 *
 * This was 0x22 and cost a hardware round trip to find. 0x22 puts bits[5:4]
 * at 0b10, which is *packed* increment — an optional MEM-AP feature this part
 * does not implement, so the very first DRW access came back FAULT while
 * everything up to and including the CSW write looked healthy. The digits are
 * one bit apart and the failure lands nowhere near the mistake, so
 * cmsis-dap.test.mjs decodes these fields rather than comparing a magic
 * number.
 */
export const CSW_SIZE32 = 0x02;         // bits[2:0]
export const CSW_ADDRINC_SINGLE = 0x10; // bits[5:4]
export const CSW_LOW_BITS = CSW_SIZE32 | CSW_ADDRINC_SINGLE;   // 0x12
export const CSW_LOW_MASK = 0x3f;

/*
 * CSW.Prot — the access attributes the AP presents on the bus.
 *
 * HNONSEC is the one that matters on this part, and it cost a second hardware
 * round trip. **1 = Non-secure, 0 = Secure**, and the nRF54L's RRAM controller
 * is Secure-only: `nrf54lm20a_global.h` defines NRF_RRAMC_S_BASE and no _NS_
 * alias, where 188 other peripherals have one. A Non-secure write to
 * 0x5004E500 is refused by the SPU and comes back as CTRL/STAT STICKYERR.
 *
 * What made it confusing: halting the core first (DHCSR at 0xE000EDF0) works
 * regardless, because the PPB is internal to the debug port and never crosses
 * the SPU. So the failure looked like "RRAM is unreachable" when it was
 * "everything on the system bus is unreachable".
 *
 * These are set explicitly rather than preserved from the CSW reset value.
 * Preserving them is how HNONSEC stayed at 1 in the first place.
 */
export const CSW_DBGSWENABLE    = 0x80000000; // bit 31
export const CSW_HNONSEC        = 0x40000000; // bit 30 — 1 = Non-secure
export const CSW_MASTERTYPE_DBG = 0x20000000; // bit 29 — HMASTER = debug
export const CSW_HPROT_PRIV     = 0x02000000; // bit 25 — privileged
export const CSW_HPROT_DATA     = 0x01000000; // bit 24 — data access
export const CSW_PROT_MASK      = 0xff000000;

/* Secure, privileged, debug-master. Same shape openocd uses on this board. */
export const CSW_PROT_BITS =
  CSW_DBGSWENABLE | CSW_MASTERTYPE_DBG | CSW_HPROT_PRIV | CSW_HPROT_DATA;

/** The complete CSW this flasher programs: 0xA3000012. */
export const CSW_VALUE = (CSW_PROT_BITS | CSW_LOW_BITS) >>> 0;

export const webUsbAvailable = () =>
  typeof navigator !== "undefined" && !!navigator.usb;

export class DapError extends Error {}

export class CmsisDap {
  constructor(device) {
    this.device = device;
    this.iface = -1;
    this.epIn = 0;
    this.epOut = 0;
    this.packetSize = 64;          // USB endpoint max packet size
    this.dapPacketSize = 64;       // probe command-buffer size (DAP_Info 0xFF)
    this._diagnosing = false;
    /* CMSIS-DAP is strictly request/response on one pair of endpoints, so
     * every command has to be serialised or two callers interleave and each
     * reads the other's reply. */
    this.lock = Promise.resolve();
  }

  static async request() {
    if (!webUsbAvailable()) throw new DapError("this browser has no WebUSB (use Chrome or Edge on desktop)");
    const device = await navigator.usb.requestDevice({
      filters: [
        { vendorId: 0x2886 },        // Seeed
        { classCode: 0xff },         // any CMSIS-DAP v2 probe
      ],
    });
    return new CmsisDap(device);
  }

  async open() {
    await this.device.open();
    if (!this.device.configuration) await this.device.selectConfiguration(1);

    /* Pick the vendor-class interface with a bulk pair. WebUSB exposes no
     * interface strings, so the class plus the endpoint shape is all we have
     * to go on — which is the same test every other CMSIS-DAP v2 host uses. */
    for (const iface of this.device.configuration.interfaces) {
      for (const alt of iface.alternates) {
        if (alt.interfaceClass !== 0xff) continue;
        const inEp  = alt.endpoints.find(e => e.direction === "in"  && e.type === "bulk");
        const outEp = alt.endpoints.find(e => e.direction === "out" && e.type === "bulk");
        if (!inEp || !outEp) continue;
        this.iface = iface.interfaceNumber;
        this.epIn = inEp.endpointNumber;
        this.epOut = outEp.endpointNumber;
        this.packetSize = inEp.packetSize || 64;
      }
    }
    if (this.iface < 0) {
      throw new DapError("no CMSIS-DAP v2 interface on this device — it may be a v1 (HID-only) probe");
    }
    await this.device.claimInterface(this.iface);

    /*
     * The probe's command buffer, which is NOT the USB endpoint packet size —
     * it is typically far larger (the endpoint here is 64 B). Everything that
     * batches has to respect it: a DAP_TransferBlock longer than this is
     * truncated by the probe, which on a write means the tail of a 1 KB run
     * never reaches RRAM and surfaces much later as a verify mismatch looking
     * exactly like the Trap 1 write-buffer bug.
     */
    try {
      const size = await this.infoNumber(0xff);
      if (size >= 64) this.dapPacketSize = size;
    } catch { /* keep the conservative default */ }
  }

  async close() {
    try { await this.device.releaseInterface(this.iface); } catch { /* already gone */ }
    try { await this.device.close(); } catch { /* already gone */ }
  }

  /* --- raw command plumbing ------------------------------------------- */

  cmd(bytes) {
    const run = async () => {
      const out = Uint8Array.from(bytes);
      await this.device.transferOut(this.epOut, out);
      /* Ask for the probe's whole buffer, not one USB packet: WebUSB
       * reassembles a multi-packet bulk reply only if we asked for that much. */
      const res = await this.device.transferIn(this.epIn, Math.max(this.dapPacketSize, this.packetSize));
      if (!res.data || res.data.byteLength === 0) throw new DapError("probe returned an empty packet");
      const reply = new Uint8Array(res.data.buffer, res.data.byteOffset, res.data.byteLength);
      if (reply[0] !== out[0]) {
        throw new DapError(`probe replied to command 0x${reply[0].toString(16)}, expected 0x${out[0].toString(16)}`);
      }
      return reply;
    };
    /* Chain onto the lock, and keep the lock un-rejected so one failure does
     * not poison every later command. */
    const result = this.lock.then(run, run);
    this.lock = result.then(() => {}, () => {});
    return result;
  }

  async info(id) {
    const r = await this.cmd([CMD.INFO, id]);
    const len = r[1];
    return new TextDecoder().decode(r.subarray(2, 2 + len)).replace(/\0+$/, "");
  }

  firmwareVersion() { return this.info(0x04); }
  productName() { return this.info(0x02); }

  /* DAP_Info values that are numbers, not strings (0xFE packet count,
   * 0xFF packet size). */
  async infoNumber(id) {
    const r = await this.cmd([CMD.INFO, id]);
    const len = r[1];
    if (len === 1) return r[2];
    if (len === 2) return r[2] | (r[3] << 8);
    if (len === 4) return (r[2] | (r[3] << 8) | (r[4] << 16) | (r[5] << 24)) >>> 0;
    return 0;
  }

  async setClock(hz) {
    await this.cmd([CMD.SWJ_CLOCK, hz & 0xff, (hz >>> 8) & 0xff, (hz >>> 16) & 0xff, (hz >>> 24) & 0xff]);
  }

  async hostStatus(kind, on) {
    await this.cmd([CMD.HOST_STATUS, kind, on ? 1 : 0]);
  }

  async connectSwd() {
    const r = await this.cmd([CMD.CONNECT, PORT_SWD]);
    if (r[1] !== PORT_SWD) throw new DapError("probe refused SWD mode");
    /* idle cycles = 0, wait retries = 64, match retries = 0 */
    await this.cmd([CMD.TRANSFER_CONFIGURE, 0, 0x40, 0x00, 0x00, 0x00]);
    await this.cmd([CMD.SWD_CONFIGURE, 0]);
  }

  async disconnect() { await this.cmd([CMD.DISCONNECT]); }

  async swjSequence(bitCount, bytes) {
    await this.cmd([CMD.SWJ_SEQUENCE, bitCount & 0xff, ...bytes]);
  }

  /* --- DP/AP transfers -------------------------------------------------- */

  async transfer(request, value) {
    const isWrite = (request & RnW) === 0;
    const payload = [CMD.TRANSFER, 0, 1, request];
    if (isWrite) payload.push(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff);
    const r = await this.cmd(payload);
    await this.check(r[2], r[1], describeTransfer(request));
    if (isWrite) return 0;
    return (r[3] | (r[4] << 8) | (r[5] << 16) | (r[6] << 24)) >>> 0;
  }

  /*
   * Turn an ACK into a message naming the operation and the DP's own account
   * of what went wrong, then clear the sticky bits so the next command is not
   * answered from a poisoned state. Without this a FAULT reads as "target
   * fault (FAULT) after 1 transfer(s)" and says nothing at all — which is
   * exactly how the CSW bug above presented.
   */
  async check(ack, count, what) {
    const base = ackMessage(ack, count, what);
    if (!base) return;
    throw new DapError(base + (await this.diagnose()));
  }

  async diagnose() {
    if (this._diagnosing) return "";
    this._diagnosing = true;
    try {
      const stat = await this.transfer(RnW | DP.CTRL_STAT, 0);
      const flags = STAT_BITS.filter(([m]) => stat & m).map(([, n]) => n);
      if (!(stat & CDBGPWRUPACK)) flags.push("debug domain not powered");
      if (!(stat & CSYSPWRUPACK)) flags.push("system domain not powered");
      await this.transfer(DP.ABORT, 0x1e);          // clear the sticky bits
      const h = (stat >>> 0).toString(16).padStart(8, "0");
      return `. CTRL/STAT=0x${h}${flags.length ? " — " + flags.join(", ") : " — no sticky error flagged"}`;
    } catch {
      return "";
    } finally {
      this._diagnosing = false;
    }
  }

  readDp(reg)         { return this.transfer(RnW | (reg & 0x0c), 0); }
  writeDp(reg, value) { return this.transfer(reg & 0x0c, value); }
  readAp(reg)         { return this.transfer(APnDP | RnW | (reg & 0x0c), 0); }
  writeAp(reg, value) { return this.transfer(APnDP | (reg & 0x0c), value); }

  /** Largest word count one DAP_TransferBlock can carry, in each direction. */
  maxBlockWords(isWrite) {
    /* request: 5 header bytes + 4/word. response: 4 header bytes + 4/word. */
    const budget = this.dapPacketSize - (isWrite ? 5 : 4);
    return Math.max(1, Math.floor(budget / 4));
  }

  /* Block transfer — one request repeated `count` times. This is what makes
   * flashing tolerable: many words per USB round trip instead of one.
   * Splits at the probe's buffer size; TAR keeps auto-incrementing across the
   * split, so the caller still sees one contiguous transfer. */
  async transferBlock(request, words) {
    const isWrite = (request & RnW) === 0;
    const limit = this.maxBlockWords(isWrite);
    if (isWrite && words.length > limit) {
      for (let i = 0; i < words.length; i += limit) {
        await this.transferBlockRaw(request, words.subarray(i, Math.min(i + limit, words.length)));
      }
      return null;
    }
    if (!isWrite && words > limit) {
      const out = new Uint32Array(words);
      for (let i = 0; i < words; i += limit) {
        out.set(await this.transferBlockRaw(request, Math.min(limit, words - i)), i);
      }
      return out;
    }
    return this.transferBlockRaw(request, words);
  }

  async transferBlockRaw(request, words) {
    const isWrite = (request & RnW) === 0;
    const count = isWrite ? words.length : words;
    const head = [CMD.TRANSFER_BLOCK, 0, count & 0xff, (count >>> 8) & 0xff, request];
    if (isWrite) {
      for (const w of words) head.push(w & 0xff, (w >>> 8) & 0xff, (w >>> 16) & 0xff, (w >>> 24) & 0xff);
    }
    const r = await this.cmd(head);
    const done = r[1] | (r[2] << 8);
    await this.check(r[3], done, `block ${isWrite ? "write" : "read"} of ${count} words`);
    if (done !== count) throw new DapError(`block transfer stopped after ${done} of ${count} words`);
    if (isWrite) return null;
    const out = new Uint32Array(count);
    for (let i = 0; i < count; i++) {
      const o = 4 + i * 4;
      out[i] = (r[o] | (r[o + 1] << 8) | (r[o + 2] << 16) | (r[o + 3] << 24)) >>> 0;
    }
    return out;
  }
}

export function ackMessage(ack, count, what) {
  const code = ack & 0x07;
  if (code === ACK_OK) return null;
  const where = `${what} (after ${count} transfer${count === 1 ? "" : "s"})`;
  if (code === ACK_WAIT) return `target busy — WAIT on ${where}`;
  if (code === ACK_FAULT) return `target fault — FAULT on ${where}`;
  if (ack & 0x08) return `SWD protocol error on ${where} — check the probe and target power`;
  return `unexpected SWD ack 0x${ack.toString(16)} on ${where}`;
}

/* Human-readable name for a DAP_Transfer request byte, so an error says what
 * was being attempted rather than only that something was. */
export function describeTransfer(request) {
  const bank = request & 0x0c;
  const rw = (request & RnW) ? "read" : "write";
  if (request & APnDP) {
    const names = { 0x00: "AP CSW", 0x04: "AP TAR", 0x0c: "AP DRW" };
    return `${rw} ${names[bank] ?? `AP 0x${bank.toString(16)}`}`;
  }
  const names = { 0x00: "DP DPIDR/ABORT", 0x04: "DP CTRL/STAT", 0x08: "DP SELECT", 0x0c: "DP RDBUFF" };
  return `${rw} ${names[bank] ?? `DP 0x${bank.toString(16)}`}`;
}

/* ADIv5 CTRL/STAT sticky-error bits. */
const STAT_BITS = [
  [1 << 1, "STICKYORUN"],
  [1 << 4, "STICKYCMP"],
  [1 << 5, "STICKYERR"],
  [1 << 7, "WDATAERR"],
];

export { CMD, APnDP, RnW, CSYSPWRUPREQ, CDBGPWRUPREQ, CSYSPWRUPACK, CDBGPWRUPACK, ACK_OK };
