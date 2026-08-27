/*
 * Program an nRF54L over SWD, from a browser.
 *
 * The whole reason this is a few hundred lines rather than a port of pyOCD:
 * nRF54L RRAM is directly memory-mapped and directly writable. There is no
 * sector erase, no flash algorithm to download into target RAM, no page
 * buffer to poke. Set a write-enable bit, write the words, commit. The
 * sequence is exactly the one in
 * updater/boards/seeed/xiao_nrf54lm20a/support/openocd.cfg:
 *
 *     mww 0x5004e500 0x101   ; CONFIG: WEN=1, WRITEBUFSIZE=1
 *     load_image $file       ; ordinary memory writes
 *     mww 0x5004e008 0x1     ; TASKS_COMMITWRITEBUF
 *     mww 0x5004e500 0x0     ; WEN=0
 *
 * **Trap 1 applies here in full.** The RRAM controller commits to the array
 * only when its 128-bit write buffer fills, so the final partial 16-byte line
 * of an image is left sitting in the buffer and never programmed — it reads
 * back as 0xFF. That produced a fault that bisected perfectly and falsely
 * across a dozen unrelated Kconfig options. Hence COMMITWRITEBUF, and hence
 * verify() is not optional: it is the difference between a loud failure here
 * and a silent one on the user's desk three weeks later.
 */

import {
  CmsisDap, DapError, DP, AP, TAR_WRAP, CSW_LOW_BITS, CSW_LOW_MASK,
  CSW_VALUE, CSW_HNONSEC,
  APnDP, RnW, CSYSPWRUPREQ, CDBGPWRUPREQ, CSYSPWRUPACK, CDBGPWRUPACK,
} from "./cmsis-dap.js";
import { splitForWrite, padToWords } from "./intel-hex.js";

/* From openocd.cfg: `set _CPUTAPID 0x6ba02477`. */
export const EXPECTED_DPIDR = 0x6ba02477;

/* CTRL-AP — Nordic's proprietary AP for unlocking a protected part. */
const CTRL_AP = 2;
const CTRL_AP_IDR_EXPECTED = 0x32880000;
const CTRL_AP_RESET = 0x000, CTRL_AP_ERASEALL = 0x004, CTRL_AP_ERASEALLSTATUS = 0x008;

/* Cortex-M debug registers. */
const DHCSR = 0xe000edf0, DEMCR = 0xe000edfc, AIRCR = 0xe000ed0c;
const DBGKEY = 0xa05f0000;
const C_DEBUGEN = 1 << 0, C_HALT = 1 << 1;
const S_HALT = 1 << 17;

/* RRAM controller. */
const RRAMC_CONFIG = 0x5004e500;
const RRAMC_TASKS_COMMITWRITEBUF = 0x5004e008;
const RRAMC_CONFIG_WEN = 0x101;          // WEN=1, WRITEBUFSIZE=1

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export class Nrf54lFlasher {
  /** @param {(msg: string, cls?: string) => void} log */
  constructor(dap, log = () => {}) {
    this.dap = dap;
    this.log = log;
    this.selectedApBank = null;
    this.selectedAp = null;
  }

  static async connect(log) {
    const dap = await CmsisDap.request();
    await dap.open();
    const flasher = new Nrf54lFlasher(dap, log);
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
    this.log(`DPIDR = 0x${hex(dpidr)}${dpidr === EXPECTED_DPIDR ? " (nRF54L, as expected)" : ""}`);

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

  /** True when the debug port answers but the MEM-AP is locked out (APPROTECT). */
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
    if (got & CSW_HNONSEC) {
      throw new DapError(
        `MEM-AP is stuck in Non-secure mode (CSW=0x${hex(got)}, HNONSEC set). ` +
        `The nRF54L's RRAM controller is Secure-only, so programming would ` +
        `fault. This usually means the part has secure debug disabled.`);
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
   */
  async checkSystemBus() {
    let sp, pc;
    try {
      sp = await this.readWord(0x00000000);
      pc = await this.readWord(0x00000004);
    } catch (e) {
      throw new DapError(
        `${e.message}. The debug port works but the system bus does not answer — ` +
        `Secure access (CSW.HNONSEC) or device protection is the usual cause.`);
    }
    if (sp === 0xffffffff && pc === 0xffffffff) {
      this.log("RRAM reads as erased — the part is blank", "warn");
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

  /* --- RRAM ------------------------------------------------------------- */

  async writeEnable(on) {
    await this.writeWord(RRAMC_CONFIG, on ? RRAMC_CONFIG_WEN : 0);
  }

  async commitWriteBuffer() {
    await this.writeWord(RRAMC_TASKS_COMMITWRITEBUF, 1);
  }

  /**
   * Program `chunks` (from parseIntelHex) into RRAM.
   * `onProgress(done, total)` is called as bytes land.
   */
  async program(chunks, onProgress = () => {}) {
    const pieces = splitForWrite(chunks, TAR_WRAP, TAR_WRAP).map(padToWords);
    const total = pieces.reduce((n, p) => n + p.bytes.length, 0);
    let done = 0;

    await this.writeEnable(true);
    try {
      for (const piece of pieces) {
        await this.writeWords(piece.address, toWords(piece.bytes));
        done += piece.bytes.length;
        onProgress(done, total);
      }
      /* Trap 1. The last partial 128-bit line is still in the controller's
       * write buffer at this point and is not in the array until told. */
      await this.commitWriteBuffer();
    } finally {
      await this.writeEnable(false);              // clearing WEN also drains
    }
    return total;
  }

  /** Read back and compare. Throws on the first mismatch. */
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
            (got[i] === 0xffffffff
              ? " — reads as erased, which is the RRAM write-buffer bug (Trap 1)"
              : ""));
        }
      }
      done += piece.bytes.length;
      onProgress(done, total);
    }
    return total;
  }

  /* --- recovery --------------------------------------------------------- */

  /**
   * Mass-erase and unlock via CTRL-AP. This is the only way back from a part
   * with APPROTECT engaged, and it destroys everything in RRAM.
   */
  async massErase() {
    await this.selectAp(CTRL_AP, 0x0f);
    const idr = await this.dap.readAp(AP.IDR);
    if (idr !== CTRL_AP_IDR_EXPECTED) {
      throw new DapError(`CTRL-AP not found (IDR = 0x${hex(idr)}, expected 0x${hex(CTRL_AP_IDR_EXPECTED)})`);
    }
    await this.selectAp(CTRL_AP, 0);
    await this.dap.writeAp(CTRL_AP_ERASEALL, 0);
    await this.dap.writeAp(CTRL_AP_ERASEALL, 1);

    /* 1 = READYTORESET, 2 = BUSY, 3 = ERROR. */
    for (let i = 0; ; i++) {
      const status = await this.dap.readAp(CTRL_AP_ERASEALLSTATUS);
      if (status === 1) break;
      if (status === 3) throw new DapError("mass erase reported ERROR");
      if (i > 300) throw new DapError("mass erase timed out");
      await sleep(100);
    }
    await this.dap.writeAp(CTRL_AP_RESET, 2);
    await sleep(10);
    await this.dap.writeAp(CTRL_AP_RESET, 0);
    await this.dap.writeAp(CTRL_AP_ERASEALL, 0);
    await sleep(200);
    this.selectedAp = null;
    this.selectedApBank = null;
  }
}

function toWords(bytes) {
  const words = new Uint32Array(bytes.length / 4);
  for (let i = 0; i < words.length; i++) {
    const o = i * 4;
    words[i] = (bytes[o] | (bytes[o + 1] << 8) | (bytes[o + 2] << 16) | (bytes[o + 3] << 24)) >>> 0;
  }
  return words;
}

const hex = (n) => (n >>> 0).toString(16).padStart(8, "0");
