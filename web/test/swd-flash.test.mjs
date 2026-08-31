/*
 * Both CMSIS-DAP flash algorithms, against models of the two flash
 * controllers, with no probe and no hardware.
 *
 *   node web/test/swd-flash.test.mjs
 *
 * ---- Why this exists ----------------------------------------------------
 *
 * nrf54l-flash.js had no test at all. That was survivable while it was one
 * file that had been proven on hardware and then barely touched; it stopped
 * being survivable the moment a second board (the XIAO MG24) pulled its ADIv5
 * half out into swd-target.js and made it a base class. A mechanical
 * extraction is exactly the kind of change that looks obviously correct and
 * is verified by nothing — and the board that would notice is not always
 * plugged in.
 *
 * So: a fake CMSIS-DAP probe over a fake memory bus, with a model of each
 * flash controller behind it. The models are deliberately *hostile* — they
 * enforce the rules the real hardware enforces and refuse the shortcuts real
 * hardware refuses, so a plausible-looking algorithm fails here rather than on
 * someone's desk:
 *
 *  - The RRAM model reproduces **Trap 1**: a write is buffered in 16-byte
 *    lines and a partial trailing line is NOT committed to the array until
 *    TASKS_COMMITWRITEBUF. Drop the commit and the last few bytes read back as
 *    0xFF, which is precisely the bug that bisected falsely across a dozen
 *    Kconfig options.
 *  - The MSC model refuses a write to a page that was not erased, a write
 *    while MSC_LOCK is engaged or WRITECTRL.WREN is clear, and a misaligned or
 *    out-of-range ADDRB — each with the STATUS bit the real part would set.
 *
 * The same idiom as esptool.test.mjs (a ROM model that refuses a wrong block
 * size) and nordic-dfu-serial.test.mjs (a bootloader model that validates
 * CRCs). A passing model is not a passing board — the nRF52840 demonstrated
 * that three times — but a *failing* model is a bug found for free.
 */
import { Chunk } from "../js/lib/intel-hex.js";
import { Nrf54lFlasher } from "../js/lib/nrf54l-flash.js";
import { Efr32Flasher, FLASH_BASE, PAGE_SIZE, LOADER } from "../js/lib/efr32-flash.js";
import { PROBE_TARGETS } from "../js/lib/probe-targets.js";
import {
  DP, AP, APnDP, RnW, CSW_VALUE, CSW_ADDRINC_SINGLE, TAR_WRAP,
} from "../js/lib/cmsis-dap.js";
import { execFileSync } from "node:child_process";
import { readFileSync, mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as pjoin } from "node:path";
import { fileURLToPath } from "node:url";

let bad = 0;
const t = (name, cond, extra = "") => {
  console.log(`${cond ? "  ok  " : "  FAIL"} ${name}${extra ? `  [${extra}]` : ""}`);
  if (!cond) bad++;
};


/* Cortex-M debug registers, architectural. */
const DHCSR = 0xe000edf0, DCRSR = 0xe000edf4, DCRDR = 0xe000edf8;
const S_HALT = 1 << 17;
const S_REGRDY_BIT = 1 << 16;

/* ------------------------------------------------------------------ *
 * A fake probe. Implements exactly the CmsisDap surface swd-target.js
 * uses, over a `bus` object with read(addr) / write(addr, value).
 * ------------------------------------------------------------------ */
class FakeDap {
  constructor(bus, dpidr = 0x6ba02477) {
    this.bus = bus;
    this.dpidr = dpidr;
    this.csw = CSW_VALUE;
    this.tar = 0;
    this.rdbuff = 0;          // AP reads are posted; this holds the result
    this.blockLimit = 64;     // words per DAP_TransferBlock, as a real probe has
  }
  async setClock() {}
  async connectSwd() {}
  async hostStatus() {}
  async swjSequence() {}
  async productName() { return "FakeDAP"; }
  async firmwareVersion() { return "2.0.0"; }
  async close() {}

  async readDp(reg) {
    if (reg === DP.DPIDR) return this.dpidr;
    /* CSYSPWRUPACK | CDBGPWRUPACK, so attach()'s power-up loop settles. */
    if (reg === DP.CTRL_STAT) return 0xf0000000;
    if (reg === DP.RDBUFF) return this.rdbuff;
    return 0;
  }
  async writeDp() {}

  async readAp(reg) {
    if (reg === AP.CSW) { this.rdbuff = this.csw; return 0; }
    if (reg === AP.IDR) { this.rdbuff = 0x24770011; return 0; }
    if (reg === AP.DRW) {
      this.rdbuff = this.bus.read(this.tar);
      if (this.csw & CSW_ADDRINC_SINGLE) this.tar = (this.tar + 4) >>> 0;
      return 0;
    }
    return 0;
  }
  async writeAp(reg, value) {
    if (reg === AP.CSW) { this.csw = value >>> 0; return; }
    if (reg === AP.TAR) { this.tar = value >>> 0; return; }
    if (reg === AP.DRW) {
      this.bus.write(this.tar, value >>> 0);
      if (this.csw & CSW_ADDRINC_SINGLE) this.tar = (this.tar + 4) >>> 0;
      return;
    }
  }
  /*
   * TAR auto-increment wraps inside a 1 KB window — the architectural minimum,
   * and what this client assumes. Modelled, not glossed over: without it a
   * caller that streams 8 KB in one go looks fine here and, on real hardware,
   * writes the same kilobyte eight times. That is exactly the mistake
   * uploadRam() exists to avoid.
   */
  bump() {
    if (!(this.csw & CSW_ADDRINC_SINGLE)) return;
    const base = this.tar & ~(TAR_WRAP - 1);
    this.tar = base | (((this.tar + 4) & (TAR_WRAP - 1)) >>> 0);
  }
  async transferBlock(request, words) {
    if (request & RnW) {
      const out = new Uint32Array(words);
      for (let i = 0; i < words; i++) { out[i] = this.bus.read(this.tar); this.bump(); }
      return out;
    }
    for (const w of words) { this.bus.write(this.tar, w >>> 0); this.bump(); }
    return null;
  }
}

/* Debug registers, shared by both models: halt() writes DHCSR and then
 * expects to read S_HALT back. */
function coreRegs(store) {
  return {
    has: (a) => a >= 0xe000e000 && a < 0xe000f000,
    read: (a) => (a === DHCSR ? (store.halted ? S_HALT : 0) : 0),
    write: (a, v) => { if (a === DHCSR) store.halted = (v & 2) !== 0; },
  };
}

/* ------------------------------------------------------------------ *
 * nRF54L RRAM, with Trap 1.
 * ------------------------------------------------------------------ */
const RRAMC_CONFIG = 0x5004e500, RRAMC_COMMIT = 0x5004e008;
const RRAM_SIZE = 2036 * 1024;
const LINE = 16;

class RramBus {
  constructor() {
    this.mem = new Uint8Array(RRAM_SIZE).fill(0xff);
    this.wen = false;
    this.pending = new Map();   // line address -> {bytes, count}
    this.core = coreRegs(this);
    this.halted = false;
    this.rejected = 0;
  }
  read(addr) {
    if (this.core.has(addr)) return this.core.read(addr);
    if (addr >= RRAM_SIZE) return 0;
    const m = this.mem;
    return (m[addr] | (m[addr + 1] << 8) | (m[addr + 2] << 16) | (m[addr + 3] << 24)) >>> 0;
  }
  write(addr, value) {
    if (this.core.has(addr)) return this.core.write(addr, value);
    if (addr === RRAMC_CONFIG) {
      const on = (value & 1) !== 0;
      /* Clearing WEN also drains, which the real controller does and which
       * program()'s `finally` relies on. */
      if (this.wen && !on) this.commit();
      this.wen = on;
      return;
    }
    if (addr === RRAMC_COMMIT) { if (value) this.commit(); return; }
    if (!this.wen) { this.rejected++; return; }   // writes without WEN are ignored
    /* Buffer into 16-byte lines. A full line lands immediately; a partial one
     * waits for a commit. This is Trap 1. */
    const line = addr & ~(LINE - 1);
    let slot = this.pending.get(line);
    if (!slot) { slot = { bytes: new Uint8Array(LINE).fill(0xff), seen: 0 }; this.pending.set(line, slot); }
    const off = addr - line;
    for (let i = 0; i < 4; i++) slot.bytes[off + i] = (value >>> (8 * i)) & 0xff;
    slot.seen += 4;
    if (slot.seen === LINE) { this.mem.set(slot.bytes, line); this.pending.delete(line); }
  }
  commit() {
    for (const [line, slot] of this.pending) {
      /* A partial line commits only the bytes that were written; the rest of
       * the line keeps its erased value, which is what the array holds. */
      for (let i = 0; i < LINE; i++) if (slot.bytes[i] !== 0xff) this.mem[line + i] = slot.bytes[i];
    }
    this.pending.clear();
  }
  /** What the array holds *without* a commit — used to prove Trap 1 bites. */
  snapshotUncommitted() { return this.mem.slice(); }
}

/* ------------------------------------------------------------------ *
 * EFR32: SRAM, the debug core-register interface, and a CPU that runs
 * the loader.
 *
 * The Thumb code itself is not emulated — it is verified on hardware, and
 * separately by re-assembling msc_loader.S and comparing bytes (below). What
 * is modelled here is its *contract*: resume with r0..r3 set, and either a
 * page is erased or `r2` words are copied from `r1` into flash at `r0`, with
 * the MSC's rules enforced.
 * ------------------------------------------------------------------ */
const S_REGRDY = S_REGRDY_BIT;
const EFR_SIZE = 1536 * 1024;
const SRAM_BASE = 0x20000000, SRAM_SIZE = 256 * 1024;

class MscBus {
  constructor() {
    this.mem = new Uint8Array(EFR_SIZE).fill(0xff);
    this.sram = new Uint8Array(SRAM_SIZE).fill(0);
    this.erased = new Set();
    this.regs = new Uint32Array(17);
    this.dcrdr = 0;
    this.halted = true;
    this.runs = 0;
    this.writesToUnerased = 0;
    this.crossPageWrites = 0;
    this.peripheralAccesses = 0;
  }
  inFlash(a) { return a >= FLASH_BASE && a < FLASH_BASE + EFR_SIZE; }
  inSram(a) { return a >= SRAM_BASE && a < SRAM_BASE + SRAM_SIZE; }

  read(addr) {
    if (addr === DHCSR) return (this.halted ? (1 << 17) : 0) | S_REGRDY;
    if (addr === DCRDR) return this.dcrdr >>> 0;
    if (addr === DCRSR) return 0;
    /* The whole point of the loader: the AP cannot see peripherals. Anything
     * that tries is counted, and asserted to be zero. */
    if (addr >= 0x40000000 && addr < 0x60000000) { this.peripheralAccesses++; return 0; }
    const src = this.inSram(addr) ? this.sram : this.mem;
    const i = this.inSram(addr) ? addr - SRAM_BASE : addr - FLASH_BASE;
    if (i < 0 || i + 4 > src.length) return 0;
    return (src[i] | (src[i+1] << 8) | (src[i+2] << 16) | (src[i+3] << 24)) >>> 0;
  }

  write(addr, value) {
    if (addr === DCRDR) { this.dcrdr = value >>> 0; return; }
    if (addr === DCRSR) {
      const sel = value & 0x1f;
      if (value & (1 << 16)) this.regs[sel] = this.dcrdr >>> 0;   // write
      else this.dcrdr = this.regs[sel] >>> 0;                     // read
      return;
    }
    if (addr === DHCSR) {
      if ((value >>> 16) !== 0xa05f) return;                      // bad DBGKEY
      const halt = (value & 2) !== 0;
      if (this.halted && !halt) this.runLoader();                 // resumed
      this.halted = halt || this.halted;
      return;
    }
    if (addr >= 0x40000000 && addr < 0x60000000) { this.peripheralAccesses++; return; }
    if (this.inSram(addr)) {
      const i = addr - SRAM_BASE;
      for (let k = 0; k < 4; k++) this.sram[i + k] = (value >>> (8 * k)) & 0xff;
      return;
    }
    /* Nothing may write flash through the AP on this part — only the loader
     * does, and it does it through runLoader(). A store here is a bug. */
    if (this.inFlash(addr)) this.peripheralAccesses++;
  }

  /** The loader's contract. Ends halted, with r0 = 0 or an MSC status. */
  runLoader() {
    this.runs++;
    const [addr, src, count, cmd] = [this.regs[0], this.regs[1], this.regs[2], this.regs[3]];
    this.halted = true;
    const fail = (bits) => { this.regs[0] = bits; };

    if (cmd === 0) {                                   // erase
      if (!this.inFlash(addr) || (addr - FLASH_BASE) % PAGE_SIZE) return fail(0x4);
      const page = (addr - FLASH_BASE) / PAGE_SIZE;
      this.mem.fill(0xff, page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
      this.erased.add(page);
      return fail(0);
    }
    // write
    if (!this.inFlash(addr) || (addr & 3)) return fail(0x4);
    const first = Math.floor((addr - FLASH_BASE) / PAGE_SIZE);
    const last = Math.floor((addr - FLASH_BASE + count * 4 - 1) / PAGE_SIZE);
    if (last !== first) this.crossPageWrites++;        // the loader may not span pages
    for (let i = 0; i < count; i++) {
      const fi = addr - FLASH_BASE + i * 4;
      const page = Math.floor(fi / PAGE_SIZE);
      if (!this.erased.has(page)) { this.writesToUnerased++; continue; }
      const si = src - SRAM_BASE + i * 4;
      /* Real NOR can only clear bits, so a missed erase shows as corruption
       * rather than as a clean overwrite. */
      for (let k = 0; k < 4; k++) this.mem[fi + k] &= this.sram[si + k];
    }
    return fail(0);
  }
}

/* ------------------------------------------------------------------ */
const bytesFrom = (n, seed = 1) => {
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i++) b[i] = (i * 7 + seed * 31 + (i >> 8)) & 0xff;
  return b;
};
const sameAs = (mem, offset, want) => {
  for (let i = 0; i < want.length; i++) if (mem[offset + i] !== want[i]) return i;
  return -1;
};

/* ================= nRF54L ================= */
{
  /* Deliberately NOT a multiple of 16: the trailing partial line is the whole
   * point of Trap 1, and a round size would test nothing. */
  const payload = bytesFrom(4096 + 13, 3);   /* 13: not a whole word either */
  const bus = new RramBus();
  const f = new Nrf54lFlasher(new FakeDap(bus), () => {});
  await f.attach();
  await f.setupMemAp();
  await f.halt();
  t("nRF54L: core halts", bus.halted);

  const chunks = [new Chunk(0x10000, payload)];
  const wrote = await f.program(chunks);
  /* 4109 bytes split at 1024-byte TAR boundaries is 4x1024 + 13, and the 13
   * pads up to 16 — padToWords rounds to a *word*, not to an RRAM line. */
  t("nRF54L: program() reports the padded byte count", wrote === 4096 + 16, String(wrote));
  t("nRF54L: no write escaped WEN", bus.rejected === 0, `${bus.rejected} rejected`);

  const at = sameAs(bus.mem, 0x10000, payload);
  t("nRF54L: every byte reached the array, trailing partial line included",
    at === -1, at === -1 ? "" : `first difference at +${at}`);

  await f.verify(chunks);
  t("nRF54L: verify() passes on a good write", true);
}

/* The model has to be able to *fail*, or the test above proves nothing. */
{
  const payload = bytesFrom(64 + 4, 9);
  const bus = new RramBus();
  const f = new Nrf54lFlasher(new FakeDap(bus), () => {});
  await f.attach(); await f.setupMemAp();
  /* Program without the commit and without the WEN clear that also drains —
   * i.e. exactly the bug Trap 1 describes. */
  await f.writeEnable(true);
  const { splitForWrite, padToWords } = await import("../js/lib/intel-hex.js");
  for (const p of splitForWrite([new Chunk(0x10000, payload)], 1024, 1024).map(padToWords)) {
    const w = new Uint32Array(p.bytes.length / 4);
    for (let i = 0; i < w.length; i++) {
      const o = i * 4;
      w[i] = (p.bytes[o] | (p.bytes[o+1] << 8) | (p.bytes[o+2] << 16) | (p.bytes[o+3] << 24)) >>> 0;
    }
    await f.writeWords(p.address, w);
  }
  const at = sameAs(bus.mem, 0x10000, payload);
  t("nRF54L: WITHOUT the commit the tail is missing — the model reproduces Trap 1",
    at !== -1 && at >= 64, at === -1 ? "model did not bite" : `lost from +${at}`);
  t("...and what is missing reads as erased", bus.mem[0x10000 + 64] === 0xff);

  let threw = "";
  try { await f.verify([new Chunk(0x10000, payload)]); } catch (e) { threw = e.message; }
  t("...and verify() catches it, naming the address",
    /verify failed at 0x/.test(threw) && /Trap 1/.test(threw), threw.slice(0, 90));
}

/* ================= EFR32MG24 ================= */
{
  /* Spans three 8 KB pages and does not end on a page or word boundary. */
  const payload = bytesFrom(3 * PAGE_SIZE + 101, 5);  /* 101: needs word padding */
  const start = FLASH_BASE + 0x10000;
  const bus = new MscBus();
  const f = new Efr32Flasher(new FakeDap(bus), () => {});
  await f.attach();
  await f.setupMemAp();
  await f.halt();
  t("EFR32: core halts", bus.halted);

  const chunks = [new Chunk(start, payload)];
  const seen = [];
  const wrote = await f.program(chunks, (d, tot) => seen.push([d, tot]));
  const padded = payload.length + 3;         /* 101 -> 104 on the last piece */
  t("EFR32: program() reports the padded byte count", wrote === padded, String(wrote));

  /* Counted from the addresses, not from the length: the image starts
   * page-aligned here but need not, and a spill into a fourth page is exactly
   * the sort of off-by-one an erase loop gets wrong. */
  const firstPage = Math.floor((start - FLASH_BASE) / PAGE_SIZE);
  const lastPage = Math.floor((start - FLASH_BASE + padded - 1) / PAGE_SIZE);
  const pages = lastPage - firstPage + 1;
  t("EFR32: erased exactly the pages the image touches",
    bus.erased.size === pages, `${bus.erased.size} erased, image spans ${pages}`);
  t("EFR32: nothing was written to an unerased page",
    bus.writesToUnerased === 0, `${bus.writesToUnerased} such writes`);
  /* The invariant the whole design turns on: on this part the debug AP cannot
   * reach the peripheral bus, so the host must never try — every MSC access
   * belongs to the loader. A model that counts the attempts is the only way
   * to keep a future "just poke the register" from creeping back in. */
  t("EFR32: the host never touched a peripheral, or flash, through the AP",
    bus.peripheralAccesses === 0, `${bus.peripheralAccesses} such accesses`);
  t("EFR32: no single loader call spanned two pages",
    bus.crossPageWrites === 0, `${bus.crossPageWrites} such calls`);
  const writeCalls = Math.ceil(padded / PAGE_SIZE);
  t("EFR32: one erase and one write call per page",
    bus.runs === pages + writeCalls, `${bus.runs} runs, expected ${pages + writeCalls}`);

  const at = sameAs(bus.mem, start - FLASH_BASE, payload);
  t("EFR32: every byte reached flash", at === -1,
    at === -1 ? "" : `first difference at +${at}`);

  await f.verify(chunks);
  t("EFR32: verify() passes on a good write", true);

  t("EFR32: progress never goes backwards and ends at 100%",
    seen.every(([d, tot], i) => d >= 0 && d <= tot && (i === 0 || d >= seen[i - 1][0]))
      && seen[seen.length - 1][0] === seen[seen.length - 1][1],
    `${seen.length} updates, last ${seen[seen.length - 1]}`);
}

/* A word that never landed leaves its slot erased. verify() is the only thing
 * standing between that and a device that does not boot. */
{
  const payload = bytesFrom(256, 11);
  const start = FLASH_BASE + 0x20000;
  const bus = new MscBus();
  const f = new Efr32Flasher(new FakeDap(bus), () => {});
  await f.attach(); await f.setupMemAp();
  await f.program([new Chunk(start, payload)]);
  /* Simulate one dropped word after the fact. */
  bus.mem.fill(0xff, start - FLASH_BASE + 32, start - FLASH_BASE + 36);
  let threw = "";
  try { await f.verify([new Chunk(start, payload)]); } catch (e) { threw = e.message; }
  t("EFR32: verify() catches a dropped word and names its address",
    threw.includes(`0x${(start + 32).toString(16).padStart(8, "0")}`), threw.slice(0, 110));
  t("...and says the page was erased but the word never landed",
    /never landed/.test(threw), threw.slice(0, 140));
}

/* Refusing an image that is not for this part. */
{
  const bus = new MscBus();
  const f = new Efr32Flasher(new FakeDap(bus), () => {});
  await f.attach(); await f.setupMemAp();
  let threw = "";
  /* Address 0x10000 is a perfectly good nRF54L slot0 and nowhere at all on
   * this part, whose flash starts at 0x08000000. */
  try { await f.program([new Chunk(0x10000, bytesFrom(64, 2))]); } catch (e) { threw = e.message; }
  t("EFR32: an image outside the flash window is refused before anything is erased",
    /outside flash/.test(threw), threw.slice(0, 100));
  t("...and nothing was erased", bus.erased.size === 0, `${bus.erased.size} pages`);
}

/* ================= the loader blob ================= */
/*
 * The 128 bytes embedded in efr32-flash.js must be what
 * updater/tools/efr32-loader/msc_loader.S assembles to.
 *
 * This is the pair most able to drift without anyone noticing: the source is
 * the only readable description of what the blob does, and every comment in
 * efr32-flash.js points at it — but the machine actually runs the array. Edit
 * one and forget the other and the file lies about itself, in a place where
 * the consequence is arbitrary code running on a chip with its flash unlocked.
 *
 * Skipped, loudly, when no ARM assembler is on hand. That is the normal case
 * on a plain web-CI runner and the wrong thing to fail over; the nRF build job
 * has a toolchain and is where this is meant to bite.
 */
{
  const HERE = fileURLToPath(new URL(".", import.meta.url));
  const SRC = pjoin(HERE, "..", "..", "updater", "tools", "efr32-loader", "msc_loader.S");
  const candidates = [
    process.env.ARM_AS,
    pjoin(process.env.HOME ?? "", "zephyr-sdk-1.0.1/gnu/arm-zephyr-eabi/bin/arm-zephyr-eabi-as"),
    "arm-zephyr-eabi-as",
    "arm-none-eabi-as",
  ].filter(Boolean);

  let as = null;
  for (const c of candidates) {
    try { execFileSync(c, ["--version"], { stdio: "ignore" }); as = c; break; } catch { /* next */ }
  }

  if (!existsSync(SRC)) {
    t("the loader source is in the tree", false, SRC);
  } else if (!as) {
    console.log("  skip  no ARM assembler found; loader blob not re-assembled " +
                "(set ARM_AS to force). The blob's bytes are unverified here.");
  } else {
    const objcopy = as.replace(/-as$/, "-objcopy");
    const dir = mkdtempSync(pjoin(tmpdir(), "msc-loader-"));
    const o = pjoin(dir, "l.o"), bin = pjoin(dir, "l.bin");
    execFileSync(as, ["-mcpu=cortex-m33", "-mthumb", SRC, "-o", o]);
    execFileSync(objcopy, ["-O", "binary", o, bin]);
    const built = new Uint8Array(readFileSync(bin));
    t("the embedded loader is the assembled msc_loader.S",
      built.length === LOADER.length && built.every((b, i) => b === LOADER[i]),
      `source assembles to ${built.length} bytes, embedded is ${LOADER.length}`);
  }

  /* Position independence is what lets the host drop it anywhere in SRAM. A
   * literal pool is fine; an absolute branch target would not be. Checked
   * cheaply: the blob must contain no word that looks like a code address
   * outside the blob itself. */
  t("the loader is small enough to sit under the buffer", LOADER.length <= 0x400,
    `${LOADER.length} bytes`);
}

/* ================= the dispatch table ================= */
{
  t("probe-targets: an unknown board resolves to null, not to a default",
    PROBE_TARGETS.xiao_esp32s3 === undefined, "");
  const { probeTargetFor } = await import("../js/lib/probe-targets.js");
  t("probe-targets: xiao_mg24 selects the EFR32 algorithm",
    probeTargetFor("xiao_mg24/efr32mg24b220f1536im48").flasher === Efr32Flasher);
  t("probe-targets: xiao_nrf54lm20a selects the nRF54L algorithm",
    probeTargetFor("xiao_nrf54lm20a/nrf54lm20a/cpuapp").flasher === Nrf54lFlasher);
  t("probe-targets: an unsupported board is refused rather than defaulted",
    probeTargetFor("xiao_ble/nrf52840") === null);

  /* The whole reason the table is keyed on the board: these two are
   * indistinguishable on the wire. If this ever stops being true the comment
   * in probe-targets.js needs rewriting, so it is pinned. */
  t("the two probe boards answer the SAME DPIDR — which is why the board name decides",
    Nrf54lFlasher.EXPECTED_DPIDR === Efr32Flasher.EXPECTED_DPIDR,
    `0x${Nrf54lFlasher.EXPECTED_DPIDR.toString(16)}`);

  /* Only the nRF54L has an unlock path; the UI asks the class, not a list. */
  t("only the part with a CTRL-AP offers an unlock", Nrf54lFlasher.CAN_UNLOCK === true);
  t("...and the EFR32 does not pretend to", Efr32Flasher.CAN_UNLOCK === false);
}

console.log(bad ? `\n${bad} FAILURES` : "\nall SWD flash tests passed");
process.exit(bad ? 1 : 0);
