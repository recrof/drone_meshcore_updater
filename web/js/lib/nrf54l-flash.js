/*
 * Program an nRF54L over SWD, from a browser.
 *
 * The whole reason this is a couple of hundred lines rather than a port of
 * pyOCD: nRF54L RRAM is directly memory-mapped and directly writable. There is
 * no sector erase, no flash algorithm to download into target RAM, no page
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
 *
 * The ADIv5 half — SWD bring-up, MEM-AP, halt, reset, verify — moved to
 * swd-target.js when the XIAO MG24 arrived and needed all of it and none of
 * the RRAM part. Nothing about the behaviour changed in that move.
 */

import { DapError, AP } from "./cmsis-dap.js";
import { splitForWrite, padToWords } from "./intel-hex.js";
import { SwdTarget, sleep, hex, toWords } from "./swd-target.js";
import { TAR_WRAP } from "./cmsis-dap.js";

/* From openocd.cfg: `set _CPUTAPID 0x6ba02477`.
 *
 * **Not an identification.** The XIAO MG24 answers the same value — it is a
 * generic ARM debug-port ID, not a part number — so nothing may branch on it.
 * Which flash algorithm to run is decided from the board the manifest names;
 * see probe-targets.js. */
export const EXPECTED_DPIDR = 0x6ba02477;

/* CTRL-AP — Nordic's proprietary AP for unlocking a protected part. */
const CTRL_AP = 2;
const CTRL_AP_IDR_EXPECTED = 0x32880000;
const CTRL_AP_RESET = 0x000, CTRL_AP_ERASEALL = 0x004, CTRL_AP_ERASEALLSTATUS = 0x008;

/* RRAM controller. */
const RRAMC_CONFIG = 0x5004e500;
const RRAMC_TASKS_COMMITWRITEBUF = 0x5004e008;
const RRAMC_CONFIG_WEN = 0x101;          // WEN=1, WRITEBUFSIZE=1

export class Nrf54lFlasher extends SwdTarget {
  static PART = "nRF54L";
  static MEMORY = "RRAM";
  static EXPECTED_DPIDR = EXPECTED_DPIDR;
  /* The RRAM controller lives at NRF_RRAMC_S_BASE with no _NS_ alias, where
   * 188 other peripherals have one, so a Non-secure AP write to 0x5004E500 is
   * refused by the SPU as STICKYERR. See cmsis-dap.test.mjs. */
  static SECURE_ONLY = true;
  static VECTORS = 0;
  static ERASED_HINT = "reads as erased, which is the RRAM write-buffer bug (Trap 1)";

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
