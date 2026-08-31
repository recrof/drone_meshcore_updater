/*
 * The part of "program a chip over SWD from a browser" that is not about any
 * particular chip.
 *
 * Extracted from nrf54l-flash.js when a second CMSIS-DAP board arrived (the
 * XIAO MG24). Everything here — JTAG-to-SWD, debug power-up, MEM-AP setup,
 * word and block access, halt, reset, read-back verification — is ARM ADIv5
 * and identical on both parts. What is *not* here is the flash controller,
 * which is the whole of the difference: nRF54L RRAM is memory-mapped and
 * directly writable, EFR32 flash is a peripheral you feed words to.
 *
 * **Why a base class rather than two copies.** The two files would have shared
 * ~150 lines of the fiddliest code in this client, including the CSW value
 * whose one wrong nibble cost a hardware round trip (see cmsis-dap.test.mjs).
 * Two copies of that is two chances to fix a bug once.
 *
 * ---- The one thing a subclass must not get wrong ------------------------
 *
 * `EXPECTED_DPIDR` is **not** a part number. Both boards here answer
 * 0x6ba02477, which is a generic ARM debug-port ID shared across Cortex-M
 * parts from different vendors. So it cannot be used to decide which flash
 * algorithm to run, and nothing in this file tries to: the algorithm is chosen
 * from the *board* the manifest names (see probe-targets.js), and the DPIDR is
 * only ever a sanity check that something ARM-shaped is on the other end.
 *
 * Getting that backwards would not be a failed flash. It would be one part's
 * flash-controller registers written into another part's address space, which
 * on the nRF54L is 0x5004e500 and on the EFR32 is a live peripheral window.
 */

import {
  CmsisDap, DapError, DP, AP, TAR_WRAP, CSW_LOW_BITS, CSW_LOW_MASK,
  CSW_VALUE, CSW_HNONSEC,
  APnDP, RnW, CSYSPWRUPREQ, CDBGPWRUPREQ, CSYSPWRUPACK, CDBGPWRUPACK,
} from "./cmsis-dap.js";
import { splitForWrite, padToWords } from "./intel-hex.js";

/* Cortex-M debug registers. Architectural, so they belong here. */
export const DHCSR = 0xe000edf0, DEMCR = 0xe000edfc, AIRCR = 0xe000ed0c;
export const DBGKEY = 0xa05f0000;
export const C_DEBUGEN = 1 << 0, C_HALT = 1 << 1;
export const S_HALT = 1 << 17;

export const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export const hex = (n) => (n >>> 0).toString(16).padStart(8, "0");

/** Little-endian bytes -> words. Length must already be a multiple of 4. */
export function toWords(bytes) {
  const words = new Uint32Array(bytes.length / 4);
  for (let i = 0; i < words.length; i++) {
    const o = i * 4;
    words[i] = (bytes[o] | (bytes[o + 1] << 8) | (bytes[o + 2] << 16) | (bytes[o + 3] << 24)) >>> 0;
  }
  return words;
}

export class SwdTarget {
  /* Subclasses override these three. They are used for messages and for one
   * sanity check; none of them selects behaviour. */
  static PART = "target";          // "nRF54L", "EFR32MG24"
  static MEMORY = "flash";         // what the program area is called in logs
  static EXPECTED_DPIDR = 0;       // 0 = do not comment on the DPIDR
  /* True when the part's flash controller is Secure-only, so a Non-secure
   * MEM-AP would fault on the first register write rather than at a sensible
   * place. The nRF54L is; the EFR32 is not. */
  static SECURE_ONLY = false;

  /** @param {(msg: string, cls?: string) => void} log */
  constructor(dap, log = () => {}) {
    this.dap = dap;
    this.log = log;
    this.selectedApBank = null;
    this.selectedAp = null;
  }

  /** Ask the user for a probe and open it. `this` is the subclass. */
  static async connect(log) {
    const dap = await CmsisDap.request();
    await dap.open();
    const flasher = new this(dap, log);
    log(`probe: ${await dap.productName()} (${await dap.firmwareVersion()})`);
    return flasher;
  }

  async close() { await this.dap.close(); }

  /* --- SWD bring-up ---------------------------------------------------- */

  /** Connect, reset the line, and power up the debug domain. Returns DPIDR. */
  async attach(clockHz = 1_000_000) {
    await this.dap.setClock(clockHz);
    await this.dap.connectSwd();
    await this.dap.hostStatus(1, true);          // "connected" LED on the probe

    /* JTAG-to-SWD: >50 clocks high, the 0xE79E switch word, >50 high again,
     * then idle. Belt and braces — a probe that was left mid-transaction only
     * resynchronises after the full sequence. */
    const ones = [0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff];
    await this.dap.swjSequence(56, ones);
    await this.dap.swjSequence(16, [0x9e, 0xe7]);
    await this.dap.swjSequence(56, ones);
    await this.dap.swjSequence(8, [0x00]);

    const dpidr = await this.dap.readDp(DP.DPIDR);
    if (dpidr === 0 || dpidr === 0xffffffff) {
      throw new DapError("no SWD response — the target may be unpowered or held in reset");
    }
    const expected = this.constructor.EXPECTED_DPIDR;
    /* Deliberately worded as "as expected" and not as an identification. This
     * value is shared between the parts this client supports; see the header. */
    this.log(`DPIDR = 0x${hex(dpidr)}${dpidr === expected ? " (as expected)" : ""}`);

    await this.dap.writeDp(DP.ABORT, 0x1e);      // clear sticky errors
    this.selectedAp = null;
    this.selectedApBank = null;
    await this.selectAp(0, 0);

    /* Power up debug + system domains and wait for both acks. Without this
     * every MEM-AP access faults. */
    await this.dap.writeDp(DP.CTRL_STAT, CSYSPWRUPREQ | CDBGPWRUPREQ);
    for (let i = 0; ; i++) {
      const stat = await this.dap.readDp(DP.CTRL_STAT);
      if ((stat & (CSYSPWRUPACK | CDBGPWRUPACK)) === (CSYSPWRUPACK | CDBGPWRUPACK)) break;
      if (i > 100) throw new DapError(`debug power-up not acknowledged (CTRL/STAT = 0x${hex(stat)})`);
      await sleep(10);
    }
    return dpidr;
  }

  /* SELECT holds both the AP number and the register bank, so every access
   * outside the current window has to rewrite it. Cached, because this is on
   * the hot path of every single memory write. */
  async selectAp(apsel, bank) {
    if (this.selectedAp === apsel && this.selectedApBank === bank) return;
    await this.dap.writeDp(DP.SELECT, ((apsel & 0xff) << 24) | ((bank & 0x0f) << 4));
    this.selectedAp = apsel;
    this.selectedApBank = bank;
  }

  /** True when the debug port answers but the MEM-AP is locked out. */
  async isProtected() {
    try {
      await this.selectAp(0, 0x0f);
      const idr = await this.readApSettled(AP.IDR);
      await this.selectAp(0, 0);
      this.log(`MEM-AP IDR = 0x${hex(idr)}`);
      return idr === 0;
    } catch {
      return true;
    }
  }

  /** Erase-and-unlock a protected part, where the part offers a way.
   *  The base class has none, and says so rather than appearing to work. */
  async massErase() {
    throw new DapError(
      `${this.constructor.PART}: this client has no unlock path for this part.`);
  }

  /** Whether the UI should offer the unlock button at all. */
  static get CAN_UNLOCK() { return this.prototype.massErase !== SwdTarget.prototype.massErase; }

  /* --- MEM-AP ---------------------------------------------------------- */

  async setupMemAp() {
    await this.selectAp(0, 0);
    /* AP reads are posted: the value for this read lands in RDBUFF, and the
     * read itself returns whatever the *previous* AP read posted. Collecting
     * it explicitly rather than trusting the probe to append RDBUFF — reading
     * CSW wrong here writes nonsense straight back into CSW, which then
     * faults every later access far from the cause. */
    const before = await this.readApSettled(AP.CSW);
    /* Written whole, not merged into the reset value: the Prot field decides
     * whether the AP speaks Secure, and inheriting it left HNONSEC set. */
    await this.dap.writeAp(AP.CSW, CSW_VALUE);

    const got = await this.readApSettled(AP.CSW);
    if ((got & CSW_LOW_MASK) !== CSW_LOW_BITS) {
      throw new DapError(
        `MEM-AP refused the access size: wrote CSW low bits 0x${(CSW_LOW_BITS).toString(16)}, ` +
        `reads back 0x${(got & CSW_LOW_MASK).toString(16)} (CSW=0x${hex(got)}). ` +
        `The AP may not support 32-bit auto-incrementing access.`);
    }
    if (this.constructor.SECURE_ONLY && (got & CSW_HNONSEC)) {
      throw new DapError(
        `MEM-AP is stuck in Non-secure mode (CSW=0x${hex(got)}, HNONSEC set). ` +
        `The ${this.constructor.PART}'s flash controller is Secure-only, so ` +
        `programming would fault. This usually means the part has secure ` +
        `debug disabled.`);
    }
    if (before !== got) this.log(`CSW 0x${hex(before)} -> 0x${hex(got)}`);
    return got;
  }

  /*
   * Prove the system bus is reachable before touching anything that matters.
   *
   * The PPB (DHCSR and friends) answers even when every system-bus access is
   * being refused, so halting the core is not evidence that programming will
   * work — that is exactly how the HNONSEC bug presented. Reading the vector
   * table costs one round trip and turns "FAULT while writing 0x5004e500"
   * into a failure that names its own cause.
   *
   * `VECTORS` is where the reset vector actually lives, which is 0 on a part
   * whose flash is mapped there and 0x08000000 on one whose is not.
   */
  async checkSystemBus() {
    const base = this.constructor.VECTORS ?? 0;
    let sp, pc;
    try {
      sp = await this.readWord(base);
      pc = await this.readWord(base + 4);
    } catch (e) {
      throw new DapError(
        `${e.message}. The debug port works but the system bus does not answer — ` +
        `Secure access (CSW.HNONSEC) or device protection is the usual cause.`);
    }
    if (sp === 0xffffffff && pc === 0xffffffff) {
      this.log(`${this.constructor.MEMORY} reads as erased — the part is blank`, "warn");
    } else {
      this.log(`vector table: SP=0x${hex(sp)} reset=0x${hex(pc)}`);
    }
    return { sp, pc };
  }

  /* An AP read, collected through RDBUFF so the value belongs to this read. */
  async readApSettled(reg) {
    await this.dap.readAp(reg);
    return this.dap.readDp(DP.RDBUFF);
  }

  /* Every memory access names its address on failure. A bare "FAULT" is
   * unactionable; "FAULT while writing 0xe000edf0" points straight at the
   * debug registers, and "0x5004e500" straight at the RRAM controller. */
  async at(addr, what, fn) {
    try {
      return await fn();
    } catch (e) {
      throw new DapError(`${e.message} — while ${what} 0x${hex(addr)}`);
    }
  }

  readWord(addr) {
    return this.at(addr, "reading", async () => {
      await this.selectAp(0, 0);
      await this.dap.writeAp(AP.TAR, addr);
      await this.dap.readAp(AP.DRW);               // posted; result lands in RDBUFF
      return this.dap.readDp(DP.RDBUFF);
    });
  }

  writeWord(addr, value) {
    return this.at(addr, "writing", async () => {
      await this.selectAp(0, 0);
      await this.dap.writeAp(AP.TAR, addr);
      await this.dap.writeAp(AP.DRW, value);
    });
  }

  writeWords(addr, words) {
    return this.at(addr, `writing ${words.length} words at`, async () => {
      await this.selectAp(0, 0);
      await this.dap.writeAp(AP.TAR, addr);
      await this.dap.transferBlock(APnDP | (AP.DRW & 0x0c), words);
    });
  }

  readWords(addr, count) {
    return this.at(addr, `reading ${count} words at`, async () => {
      await this.selectAp(0, 0);
      await this.dap.writeAp(AP.TAR, addr);
      return this.dap.transferBlock(APnDP | RnW | (AP.DRW & 0x0c), count);
    });
  }

  /* --- core control ----------------------------------------------------- */

  async halt() {
    await this.writeWord(DHCSR, DBGKEY | C_DEBUGEN | C_HALT);
    for (let i = 0; ; i++) {
      if ((await this.readWord(DHCSR)) & S_HALT) return;
      if (i > 100) throw new DapError("core did not halt");
      await sleep(10);
    }
  }

  async resetAndRun() {
    await this.writeWord(DEMCR, 0);                       // no vector catch
    await this.writeWord(DHCSR, DBGKEY | C_DEBUGEN);      // leave halt
    await this.writeWord(AIRCR, 0x05fa0004);              // SYSRESETREQ
    /* The part drops SWD while it resets; the write above often never acks,
     * which is expected and not an error. */
  }

  /* --- programming ------------------------------------------------------ */

  /** Subclass duty: get `chunks` into the program memory. */
  async program(_chunks, _onProgress) {
    throw new DapError(`${this.constructor.PART}: no program() implementation`);
  }

  /**
   * Read back and compare. Throws on the first mismatch.
   *
   * Generic on purpose, and load-bearing on both parts for the same reason:
   * a write path that is fast is a write path that is optimistic, and this is
   * what turns an optimistic write into a loud failure instead of a device
   * that boots into whatever landed in the bytes that did not arrive. The
   * nRF54L's Trap 1 is the canonical case; the EFR32's is a WDATA word
   * overrunning the controller's handshake.
   */
  async verify(chunks, onProgress = () => {}) {
    const pieces = splitForWrite(chunks, TAR_WRAP, TAR_WRAP).map(padToWords);
    const total = pieces.reduce((n, p) => n + p.bytes.length, 0);
    let done = 0;

    for (const piece of pieces) {
      const want = toWords(piece.bytes);
      const got = await this.readWords(piece.address, want.length);
      for (let i = 0; i < want.length; i++) {
        if (got[i] !== want[i]) {
          const at = piece.address + i * 4;
          throw new DapError(
            `verify failed at 0x${hex(at)}: wrote 0x${hex(want[i])}, read 0x${hex(got[i])}` +
            (got[i] === 0xffffffff ? ` — ${this.constructor.ERASED_HINT ?? "reads as erased"}` : ""));
        }
      }
      done += piece.bytes.length;
      onProgress(done, total);
    }
    return total;
  }
}
