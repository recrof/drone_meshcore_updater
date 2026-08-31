/*
 * Program an EFR32 Series 2 (XIAO MG24) over SWD, from a browser.
 *
 * The counterpart to nrf54l-flash.js, and it works in a completely different
 * way for a reason that had to be found on hardware.
 *
 * ---- Why this cannot poke registers the way the nRF54L one does ---------
 *
 * The nRF54L flasher writes its RRAM controller straight over SWD. The
 * obvious thing here was the same with the MSC, and **it is not possible: on
 * this part the debug AP cannot reach the peripheral bus at all.** Measured
 * on a XIAO MG24, with the CPU halted at reset and again with Zephyr running
 * so every clock was already on:
 *
 *     0x20000000  SRAM      OK
 *     0xe000ed00  CPUID     OK
 *     0x08000000  flash     OK
 *     0x0fe08000  DEVINFO   OK
 *     0x50030000  MSC       REFUSED
 *     0x5005c000  USART0    REFUSED
 *     0x40030000  MSC (secure alias)  REFUSED
 *
 * Forcing CSW.HNONSEC clear (Secure access) changes nothing. That is why
 * OpenOCD and pyOCD download an algorithm into RAM for this family, and why
 * this file does too: `updater/tools/efr32-loader/msc_loader.S`, 128 bytes,
 * assembled and embedded below.
 *
 * So the division of labour is:
 *
 *   host (here)   parses the hex, uploads a page of data into SRAM, sets four
 *                 argument registers, resumes the core, waits for the `bkpt`,
 *                 reads the result back out of r0.
 *   target        does every MSC access, from code running in SRAM with
 *                 interrupts off.
 *
 * ---- What was measured, so nobody re-derives it -------------------------
 *
 *  - **CMU_CLKEN1.MSC is 0 out of reset**, so the very first MSC access
 *    double-faults into lockup (pc=0xeffffffe) with nothing naming a clock.
 *    The loader turns it on first. This cost a debugging round.
 *  - **MSC_STATUS.TIMEOUT is set at the end of every successful write.** The
 *    MSC closes its own programming window; it does not mean a word was lost.
 *    An 8192-byte page came back byte-for-byte identical with that bit set.
 *    Silicon Labs' own driver never reads the bit either.
 *  - A full page per loader call is proven; the host never asks for more.
 */

import { DapError, TAR_WRAP } from "./cmsis-dap.js";
import { splitForWrite, padToWords } from "./intel-hex.js";
import {
  SwdTarget, sleep, hex, toWords, DHCSR, DBGKEY, C_DEBUGEN, C_HALT, S_HALT,
} from "./swd-target.js";

/* EFR32MG24: 1536 KB of flash mapped at 0x08000000, in 8192-byte pages. */
export const FLASH_BASE = 0x08000000;
export const FLASH_SIZE = 1536 * 1024;
export const PAGE_SIZE = 8192;

/*
 * updater/tools/efr32-loader/msc_loader.S, assembled for Cortex-M33.
 *
 * Position-independent — every constant is a pc-relative literal in the pool
 * at the end — so it runs wherever it is placed. `swd-flash.test.mjs`
 * re-assembles the source and compares, when an ARM assembler is available,
 * so the source and these bytes cannot drift apart in silence.
 */
export const LOADER = Uint8Array.from(
  ("72b61c4dae6e46f48036ae661a4c41f6" +
   "7135e5630125e560002b07d160610225" +
   "256100f022f800f020f816e06061e669" +
   "124d2e4211d152b1e6692e420dd116f0" +
   "080ff9d051f8047ba761013af3e70425" +
   "256100f00af800f008f8e069074d2840" +
   "0025e560e56300befee7e66916f0210f" +
   "fbd17047008000500000035006000100").match(/../g).map(b => parseInt(b, 16)));

/*
 * Where things go in the target's SRAM (256 KB at 0x20000000).
 *
 * The loader pushes nothing — it starts with `cpsid i` and never touches the
 * stack — so SP only has to be valid and aligned, for the fault frame that a
 * bug would stack. It points at the top of the gap between the code and the
 * buffer, which is 3.9 KB of nothing.
 */
const SRAM = 0x20000000;
const CODE_ADDR = SRAM;                 // 128 bytes
const STACK_TOP = SRAM + 0x1000;
const BUF_ADDR  = SRAM + 0x1000;        // one page
const CMD_ERASE = 0, CMD_WRITE = 1;

/* Debug core-register access. These are in the PPB, which the AP *can* reach
 * — the peripheral bus is the part it cannot. */
const DCRSR = 0xe000edf4, DCRDR = 0xe000edf8;
const S_REGRDY = 1 << 16;
const C_MASKINTS = 1 << 3;
const REG = { r0: 0, r1: 1, r2: 2, r3: 3, sp: 13, pc: 15, xpsr: 16 };
const XPSR_THUMB = 0x01000000;

/** Decode the loader's r0 into something a person can act on. */
function loaderProblem(status) {
  if (status & 0x00000004) return "invalid address (STATUS.INVADDR) — outside flash, or not page-aligned";
  if (status & 0x00010000) return "MSC registers are locked (STATUS.REGLOCK) — the unlock key was not accepted";
  if (status & 0x00000002) return "this page is write-protected (STATUS.LOCKED) — see MSC_PAGELOCKn";
  return `MSC reported 0x${hex(status)}`;
}

export class Efr32Flasher extends SwdTarget {
  static PART = "EFR32MG24";
  static MEMORY = "flash";
  /* The same value the nRF54L answers. It is a generic ARM debug-port ID and
   * identifies nothing about the vendor — which is exactly why probe-targets.js
   * chooses the algorithm from the board name and never from this. */
  static EXPECTED_DPIDR = 0x6ba02477;
  /* The MSC is not reachable from the AP in either security state, so there is
   * no equivalent of the nRF54L's HNONSEC trap to guard against — and no way
   * to guard against it if there were. */
  static SECURE_ONLY = false;
  /* Flash is not at 0 here; the reset vector lives at the base of the flash
   * window. Reading 0x00000000 on this part answers, and answers rubbish. */
  static VECTORS = FLASH_BASE;
  static ERASED_HINT =
    "reads as erased — the page was erased but the word never landed";

  /* --- core registers --------------------------------------------------- */

  async writeReg(sel, value) {
    await this.writeWord(DCRDR, value >>> 0);
    await this.writeWord(DCRSR, (1 << 16) | sel);
    await this.awaitRegReady(`writing core register ${sel}`);
  }

  async readReg(sel) {
    await this.writeWord(DCRSR, sel);
    await this.awaitRegReady(`reading core register ${sel}`);
    return this.readWord(DCRDR);
  }

  async awaitRegReady(what) {
    for (let i = 0; ; i++) {
      if ((await this.readWord(DHCSR)) & S_REGRDY) return;
      if (i > 100) throw new DapError(`${what}: DHCSR.S_REGRDY never set`);
      await sleep(1);
    }
  }

  /* --- the loader ------------------------------------------------------- */

  /** Put the algorithm in SRAM. Called once per program() run. */
  async loadLoader() {
    const words = toWords(LOADER);
    await this.uploadRam(CODE_ADDR, words);
    const back = await this.readWords(CODE_ADDR, words.length);
    for (let i = 0; i < words.length; i++) {
      if (back[i] !== words[i]) {
        throw new DapError(
          `the flash loader did not survive the trip into SRAM ` +
          `(word ${i}: wrote 0x${hex(words[i])}, read 0x${hex(back[i])}). ` +
          `Nothing has been erased.`);
      }
    }
  }

  /*
   * Block-write into SRAM, split at the MEM-AP's TAR auto-increment window.
   *
   * `writeWords` sets TAR once and streams; TAR wraps at 1 KB (the
   * architectural minimum, and what this client assumes), so a single 8 KB
   * call would silently write the same kilobyte eight times. That failure
   * would show up much later as a page of flash whose second kilobyte is a
   * copy of the first.
   */
  async uploadRam(addr, words) {
    const perChunk = TAR_WRAP / 4;
    for (let i = 0; i < words.length; i += perChunk) {
      await this.writeWords(addr + i * 4, words.subarray(i, Math.min(i + perChunk, words.length)));
    }
  }

  /**
   * Run the loader once and return. Throws with the MSC's own reason on
   * failure.
   *
   * The core is masked against interrupts for the duration (DHCSR.C_MASKINTS)
   * as well as by the loader's own `cpsid i`: the loader disables them on its
   * first instruction, but there is a window between "resume" and that
   * instruction, and the vector table is in flash — which is being erased.
   */
  async runLoader(cmd, addr, src, count, what) {
    await this.writeReg(REG.r0, addr);
    await this.writeReg(REG.r1, src);
    await this.writeReg(REG.r2, count);
    await this.writeReg(REG.r3, cmd);
    await this.writeReg(REG.sp, STACK_TOP);
    await this.writeReg(REG.pc, CODE_ADDR);
    await this.writeReg(REG.xpsr, XPSR_THUMB);

    await this.writeWord(DHCSR, DBGKEY | C_DEBUGEN | C_MASKINTS);   // resume
    for (let i = 0; ; i++) {
      const dhcsr = await this.readWord(DHCSR);
      if (dhcsr & S_HALT) break;
      /* A page erase is a few milliseconds and a page write a few more; 2 s is
       * far beyond either, and a loader that has not stopped by then has hung
       * rather than being slow. */
      if (i > 400) {
        await this.writeWord(DHCSR, DBGKEY | C_DEBUGEN | C_HALT);
        throw new DapError(`${what}: the flash loader did not finish (DHCSR=0x${hex(dhcsr)})`);
      }
      await sleep(5);
    }
    const status = await this.readReg(REG.r0);
    if (status !== 0) throw new DapError(`${what}: ${loaderProblem(status)}`);
  }

  /* --- programming ------------------------------------------------------ */

  /**
   * Program `chunks` (from parseIntelHex) into flash.
   *
   * Erase everything first, then write. Not interleaved, because a failure
   * part way then leaves the part blank rather than half-old and half-new,
   * which is the better of two bad outcomes on a device that is about to be
   * sent somewhere unreachable.
   *
   * **verify() is not optional here**, as on the nRF54L and for a comparable
   * reason: the read-back is what turns "a word did not land" into a named
   * address instead of a device that does not boot.
   */
  async program(chunks, onProgress = () => {}) {
    /* One page per loader call, and never crossing a page boundary — the
     * loader writes within a single page and the caller is the one that has to
     * respect it. A page is also the proven burst size. */
    const pieces = splitForWrite(chunks, PAGE_SIZE, PAGE_SIZE).map(padToWords);
    const total = pieces.reduce((n, p) => n + p.bytes.length, 0);
    if (!total) return 0;

    for (const p of pieces) {
      const end = p.address + p.bytes.length;
      if (p.address < FLASH_BASE || end > FLASH_BASE + FLASH_SIZE) {
        throw new DapError(
          `image piece 0x${hex(p.address)}..0x${hex(end)} is outside flash ` +
          `(0x${hex(FLASH_BASE)}..0x${hex(FLASH_BASE + FLASH_SIZE)})`);
      }
    }

    await this.loadLoader();

    const pages = new Set();
    for (const p of pieces) {
      const first = Math.floor((p.address - FLASH_BASE) / PAGE_SIZE);
      const last = Math.floor((p.address + p.bytes.length - 1 - FLASH_BASE) / PAGE_SIZE);
      for (let i = first; i <= last; i++) pages.add(i);
    }
    const ordered = [...pages].sort((a, b) => a - b);

    /* The erase reports in the same units as the write — bytes of image — so
     * the bar advances once rather than filling twice. */
    let erased = 0;
    for (const page of ordered) {
      const addr = FLASH_BASE + page * PAGE_SIZE;
      await this.runLoader(CMD_ERASE, addr, 0, 0, `erasing page 0x${hex(addr)}`);
      erased++;
      onProgress(Math.round(total * (erased / ordered.length) * ERASE_SHARE), total);
    }

    let done = 0;
    for (const piece of pieces) {
      const words = toWords(piece.bytes);
      await this.uploadRam(BUF_ADDR, words);
      await this.runLoader(CMD_WRITE, piece.address, BUF_ADDR, words.length,
                           `writing 0x${hex(piece.address)}`);
      done += piece.bytes.length;
      /* Continues from where the erase left the bar rather than restarting at
       * zero — a progress bar that goes backwards reads as a fault. */
      onProgress(Math.round(total * (ERASE_SHARE + (done / total) * (1 - ERASE_SHARE))), total);
    }
    return total;
  }
}

/* How much of the progress bar the erase phase is given. A page erase is a few
 * milliseconds and there are ~39 of them for a full image, against ~39 page
 * writes each preceded by an 8 KB upload. A third means the bar moves during
 * the erase instead of sitting at zero while the operator wonders whether it
 * has hung. */
const ERASE_SHARE = 0.33;
