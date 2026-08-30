/*
 * The ESP32-S3 ROM loader, over Web Serial — the esptool protocol.
 *
 * This is the only way a user can put firmware on the XIAO ESP32-S3. Unlike
 * both nRF boards there is no fallback: no CMSIS-DAP probe (that is the
 * nRF54L board's SAMD11), no UF2 mass-storage bootloader (that is the
 * nRF52840's), and Bluetooth OTA cannot install the *bootloader*, only the
 * application above it. Without this file the board is flashable from a
 * command line and nowhere else.
 *
 * ---- ROM only, no stub --------------------------------------------------
 *
 * esptool normally uploads a "stub loader" into RAM and talks to that: it is
 * faster, and it answers a richer command set. This does not, and the
 * simplification is worth naming because it is the main way this file differs
 * from esptool-js:
 *
 *  - **The stub is a per-chip, per-revision blob** that would have to be
 *    vendored, kept in step with the chip revisions Seeed ships, and included
 *    in the service worker's precache. All of that to save a few seconds on a
 *    500 KB write over a USB CDC link that is not the bottleneck anyway.
 *  - **The ROM writes each block to flash before it ACKs**, where the stub
 *    ACKs on receipt and writes behind your back. That makes the ROM *slower*
 *    and *simpler*: there is no window in which the loader has accepted more
 *    than it has written, which is the same class of hazard as Trap 4 on the
 *    Bluetooth side, and here it simply does not exist.
 *
 * The ROM's own quirks are therefore what this file has to get right, and
 * they are all size-related: blocks are 0x400 bytes, not the stub's 0x4000,
 * and FLASH_BEGIN takes one more word from the ROM than it does from a stub.
 * Both are silent when wrong.
 *
 * ---- Verification is not optional ---------------------------------------
 *
 * The ROM offers `SPI_FLASH_MD5`, and it is used on every image. See the
 * header of md5.js for why this project treats an unverified flash write as
 * an unfinished one.
 *
 * ---- Getting the chip into download mode --------------------------------
 *
 * `connect()` does it, on the port it already has, and the user presses
 * nothing. `enterDownloadMode()` pulses BOOT and EN through DTR and RTS, which
 * this chip exposes over USB.
 *
 * **The port survives**, which is the whole reason this can be one step.
 * Resetting a board reached through a USB-to-serial *bridge* takes the bridge
 * down with it; here the USB device is implemented by the USB-Serial-JTAG
 * peripheral, which is built to stay enumerated across a CPU reset. Measured
 * on a XIAO ESP32-S3: the device node never disappears, and a SYNC on the
 * original handle is answered on the first attempt — from the application,
 * from download mode, and repeatedly.
 *
 * This file previously asserted the opposite and made the user hold BOOT and
 * tap RESET. That is now only the fallback, for a port with no control lines.
 *
 * Reference: esptool-js 0.6.1 (`lib/esploader.js`), which is where the
 * numbers below were read from rather than remembered.
 *
 * No DOM dependency — `link` is anything with the shape serial.js exposes, so
 * web/test/esptool.test.mjs drives the whole thing against a fake ROM.
 */

import { md5Hex } from "./md5.js";
import { sleep } from "./serial.js";

/* --- commands ---------------------------------------------------------- */

export const CMD = {
  FLASH_BEGIN: 0x02,
  FLASH_DATA: 0x03,
  FLASH_END: 0x04,
  SYNC: 0x08,
  READ_REG: 0x0a,
  SPI_ATTACH: 0x0d,
  SPI_FLASH_MD5: 0x13,
  GET_SECURITY_INFO: 0x14,
};

/** XOR seed for the data checksum carried in the command header. */
const CHECKSUM_MAGIC = 0xef;

/** The ROM's error code for a command it does not implement. */
const ROM_INVALID_RECV_MSG = 0x05;

/**
 * Block size for FLASH_DATA.
 *
 * 0x400 for the ROM. The stub raises it to 0x4000, which is the number that
 * appears in most code reading on the subject — including esptool-js, whose
 * default it is, because esptool-js always runs the stub. Sending a 0x4000
 * block to the ROM does not fail cleanly.
 */
export const FLASH_WRITE_SIZE = 0x400;

/** Where the ROM parks a word identifying the silicon. */
const CHIP_DETECT_MAGIC_REG = 0x40001000;

/** Magic values by chip, so a wrong board is refused before anything is
 *  written. Only the S3 is buildable here; the rest are named so the error
 *  can say what *was* plugged in. */
export const CHIP_MAGIC = {
  0x00000009: "ESP32-S3",
  0x000007c6: "ESP32-S2",
  0x00f01d83: "ESP32",
  0x6921506f: "ESP32-C3",
  0x1b31506f: "ESP32-C3",
  0x2ce0806f: "ESP32-C6",
  0xd7b73e80: "ESP32-H2",
  0xfff0c101: "ESP8266",
};

/*
 * Chip identity by `GET_SECURITY_INFO`, which is how esptool identifies
 * anything newer than the ESP32-S2 — and the only way to identify some parts
 * at all.
 *
 * **The ESP32-C5 has no chip-magic value.** In esptool v5 `ESP32C5ROM`
 * inherits `USES_MAGIC_VALUE = False` from `ESP32C3ROM`, so the magic
 * register above simply does not name it, and reading that register was this
 * loader's only detection method. The result was a board published in the
 * manifest with a Flash button that could only ever fail, with the honest but
 * useless message "an unrecognised chip (magic 0x...), not an ESP32-S3".
 *
 * These are `IMAGE_CHIP_ID`, read out of esptool's own target classes rather
 * than transcribed from documentation.
 */
export const CHIP_ID = {
  0:  "ESP32",
  2:  "ESP32-S2",
  5:  "ESP32-C3",
  9:  "ESP32-S3",
  12: "ESP32-C2",
  13: "ESP32-C6",
  16: "ESP32-H2",
  23: "ESP32-C5",
};

/** Which chip a board target should turn out to be. The manifest carries the
 *  Zephyr target ("xiao_esp32c5/esp32c5/hpcore"), so the expected silicon is
 *  derivable from it and does not need a fifth table to fall out of step.
 *  Null means "any chip this loader recognises", which is what the tests use. */
export function chipForBoard(target) {
  const m = /esp32(s[23]|c[2356]|h2|p4)?/i.exec(String(target ?? ""));
  if (!m) return null;
  return m[1] ? `ESP32-${m[1].toUpperCase()}` : "ESP32";
}

/** Kept as the default for callers that name no board — every current caller
 *  does name one, so this is the fallback rather than the policy. */
export const EXPECTED_CHIP = "ESP32-S3";

/* Espressif's native USB-Serial-JTAG, which is what the XIAO ESP32-S3's USB-C
 * is wired to. Reported, never enforced: the port chooser is left unfiltered
 * because a filter that is wrong hides the right port with no way to say so,
 * and the chip magic below is a far better check than a VID ever was. */
export const USB_JTAG_SERIAL = { vendorId: 0x303a, productId: 0x1001 };

const DEFAULT_TIMEOUT = 3000;
const ERASE_REGION_TIMEOUT_PER_MB = 30000;
const ERASE_WRITE_TIMEOUT_PER_MB = 40000;
const MD5_TIMEOUT_PER_MB = 8000;

/** esptool's pause either side of a hard reset on a natively-USB part. */
const USB_RESET_MS = 200;

/** Time for the ROM to come up and start listening after a reset. */
const SETTLE_MS = 200;

const timeoutPerMb = (perMb, bytes) => Math.max(DEFAULT_TIMEOUT, perMb * (bytes / 1e6));

/* --- packet helpers ---------------------------------------------------- */

const u32le = (...values) => {
  const out = new Uint8Array(values.length * 4);
  const v = new DataView(out.buffer);
  values.forEach((n, i) => v.setUint32(i * 4, n >>> 0, true));
  return out;
};

/** Command frame: direction, op, payload length, checksum, payload. */
export function commandPacket(op, data = new Uint8Array(0), chk = 0) {
  const pkt = new Uint8Array(8 + data.length);
  const v = new DataView(pkt.buffer);
  pkt[0] = 0x00;                 // 0 = request, 1 = response
  pkt[1] = op;
  v.setUint16(2, data.length, true);
  v.setUint32(4, chk >>> 0, true);
  pkt.set(data, 8);
  return pkt;
}

/** XOR of the payload, seeded — carried in the header for the DATA commands
 *  and ignored for every other one. */
export function checksum(data, state = CHECKSUM_MAGIC) {
  for (const b of data) state ^= b;
  return state >>> 0;
}

export class EspError extends Error {
  constructor(message) { super(message); this.name = "EspError"; }
}

export class EspRomLoader {
  constructor(link, log = () => {}) {
    this.link = link;
    this.log = log;
    this.chip = null;
  }

  /**
   * Send a command and return `[value, payload]` from its reply.
   *
   * Replies that are not for this op are skipped rather than treated as
   * errors: the ROM answers SYNC eight times, and a stale one of those is
   * otherwise indistinguishable from a protocol fault.
   */
  async command(op, data = new Uint8Array(0), chk = 0, timeout = DEFAULT_TIMEOUT) {
    await this.link.writeFrame(commandPacket(op, data, chk));
    return this.readReply(op, timeout);
  }

  async readReply(op, timeout) {
    const deadline = Date.now() + timeout;
    for (;;) {
      const left = Math.max(1, deadline - Date.now());
      const frame = await this.link.readFrame(left, `a reply to command 0x${op.toString(16)}`);
      if (frame.length < 8 || frame[0] !== 0x01) continue;
      if (frame[1] !== op) continue;
      const value = new DataView(frame.buffer, frame.byteOffset).getUint32(4, true);
      return [value, frame.subarray(8)];
    }
  }

  /**
   * Command, plus the status check every caller wants.
   *
   * The two bytes after any response data are `status, error`. The ROM sends
   * four; only these two carry anything, which is why `dataLength` selects
   * where they start rather than being read from the end.
   */
  async check(what, op, data, chk = 0, dataLength = 0, timeout = DEFAULT_TIMEOUT) {
    const [value, payload] = await this.command(op, data, chk, timeout);
    if (payload.length < dataLength + 2) {
      throw new EspError(`${what}: reply too short (${payload.length} bytes)`);
    }
    const status = payload[dataLength], error = payload[dataLength + 1];
    if (status !== 0) {
      const why = error === ROM_INVALID_RECV_MSG
        ? "the ROM does not implement this command"
        : `error 0x${error.toString(16)}`;
      throw new EspError(`${what} failed — ${why}`);
    }
    return dataLength > 0 ? payload.subarray(0, dataLength) : value;
  }

  /**
   * Handshake. The ROM answers a single SYNC eight times over; the extra
   * seven are consumed here so they cannot be mistaken for the reply to
   * whatever is sent next.
   */
  async sync() {
    const payload = new Uint8Array(36).fill(0x55);
    payload.set([0x07, 0x07, 0x12, 0x20], 0);
    const reply = await this.command(CMD.SYNC, payload, 0, 200);
    for (let i = 0; i < 7; i++) {
      try { await this.readReply(CMD.SYNC, 100); } catch { break; }
    }
    return reply;
  }

  /**
   * Sync, retrying, then identify the silicon.
   *
   * Anything the chip said before the first frame is surfaced: in download
   * mode it is the ROM banner, and in *not* download mode it is the
   * application's own boot log — which is the actual diagnosis nine times out
   * of ten, and is otherwise thrown away.
   */
  async connect({ attempts = 7, reset = true , expect = null } = {}) {
    /*
     * Reset into download mode before syncing, which is what esptool does by
     * default (`--before default-reset`) and what makes flashing one step
     * rather than two. Harmless when the board is already in download mode —
     * it simply lands there again — so there is no state to detect first.
     *
     * Failure here is not fatal: a port with no control lines still reaches a
     * board the user put into download mode by hand, so fall through and try
     * to sync with whatever is there.
     */
    if (reset && this.link.port?.setSignals) {
      try {
        await enterDownloadMode(this.link);
        await sleep(SETTLE_MS);
        this.log("reset into download mode");
      } catch {
        this.log("could not drive the reset lines — expecting the board to be " +
                 "in download mode already", "warn");
      }
    }

    let last = null;
    for (let i = 0; i < attempts; i++) {
      this.link.flush();
      try {
        await this.sync();
        last = null;
        break;
      } catch (e) {
        last = e;
        await sleep(50);
      }
    }
    const banner = this.link.takeNoise().replace(/[^\x20-\x7e\n]+/g, " ").trim();
    if (banner) this.log(banner);
    if (last) {
      throw new EspError(
        banner
          ? `the chip is talking but not answering the loader — the reset did not ` +
            `put it in download mode. It said: ${banner.split("\n")[0].slice(0, 120)}`
          : `no answer from the chip. If the reset lines are not reaching it, put ` +
            `it in download mode by hand — hold BOOT, tap RESET, release BOOT — ` +
            `and try again.`);
    }

    /*
     * Ask for the chip ID first and fall back to the magic register.
     *
     * That order, and not the reverse, because the ID is the method that
     * covers the newer parts: the C5 has no magic value at all. The magic
     * register still answers on everything up to the S3 and is the only
     * method on the ESP32/S2, so it stays as the fallback rather than being
     * replaced.
     */
    const want = expect ?? EXPECTED_CHIP;
    let how = "chip id";
    let detail = "";

    this.chip = CHIP_ID[await this.chipId()] ?? null;
    if (this.chip === null) {
      const magic = (await this.readReg(CHIP_DETECT_MAGIC_REG)) >>> 0;
      this.chip = CHIP_MAGIC[magic] ?? null;
      how = "chip magic";
      detail = ` (magic 0x${magic.toString(16)})`;
    }

    if (this.chip !== want) {
      throw new EspError(
        `this is ${this.chip ?? `an unrecognised chip${detail}`}, not an ` +
        `${want}. Nothing has been written.`);
    }
    this.log(`identified by ${how}`);
    return this.chip;
  }

  /**
   * The chip's `IMAGE_CHIP_ID`, or null if this ROM cannot tell us.
   *
   * Layout of the GET_SECURITY_INFO payload: 4 bytes of flags, 7 key-purpose
   * bytes and one reserved, then the u32 chip ID. Newer parts append an API
   * version, which is why the ID is read from a fixed offset rather than from
   * the end — the payload length is not the same on every chip.
   *
   * Anything unexpected returns null rather than throwing, because the only
   * caller has a second method to try. The ESP32-S2 lands here legitimately:
   * it implements the command but its reply carries no chip ID, so the reply
   * is too short and it falls through to the magic register, which does name
   * it.
   */
  async chipId() {
    try {
      const [, payload] = await this.command(CMD.GET_SECURITY_INFO);
      if (payload.length < 16) return null;
      return new DataView(payload.buffer, payload.byteOffset).getUint32(12, true);
    } catch {
      return null;
    }
  }

  async readReg(addr) {
    const [value] = await this.command(CMD.READ_REG, u32le(addr));
    return value;
  }

  /**
   * Point the ROM at the default SPI flash pins.
   *
   * The second word is the ROM's "is legacy" argument. A stub takes four
   * bytes here and the ROM takes eight; sending four to the ROM is one of the
   * ways this protocol fails without saying so.
   */
  async spiAttach() {
    await this.check("configure SPI flash pins", CMD.SPI_ATTACH, u32le(0, 0));
  }

  /**
   * Erase the destination and enter flash-download mode.
   *
   * The trailing zero word is the encrypted-write flag, which only the ROM
   * expects. Erase is synchronous and unannounced, hence the size-scaled
   * timeout.
   */
  async flashBegin(size, offset) {
    const blocks = Math.floor((size + FLASH_WRITE_SIZE - 1) / FLASH_WRITE_SIZE);
    const timeout = timeoutPerMb(ERASE_REGION_TIMEOUT_PER_MB, size);
    await this.check("enter flash download mode", CMD.FLASH_BEGIN,
                     u32le(size, blocks, FLASH_WRITE_SIZE, offset, 0),
                     0, 0, timeout);
    return blocks;
  }

  /** One block. Padded by the caller; the ROM insists on a full block. */
  async flashBlock(data, seq, timeout) {
    const pkt = new Uint8Array(16 + data.length);
    pkt.set(u32le(data.length, seq, 0, 0), 0);
    pkt.set(data, 16);
    await this.check(`write block ${seq}`, CMD.FLASH_DATA, pkt, checksum(data), 0, timeout);
  }

  /**
   * Read back the digest of a region of flash.
   *
   * The ROM answers with 32 bytes of lower-case hex; the stub answers with 16
   * raw bytes. Ours is the ROM, so this is a string already.
   */
  async flashMd5(addr, size) {
    const timeout = timeoutPerMb(MD5_TIMEOUT_PER_MB, size);
    const out = await this.check("read back the flash digest", CMD.SPI_FLASH_MD5,
                                 u32le(addr, size, 0, 0), 0, 32, timeout);
    return new TextDecoder().decode(out);
  }

  /**
   * Write one image at one offset, then prove it landed.
   *
   * The last block is padded to a full block with 0xFF — the erased value, so
   * padding writes nothing the erase did not already leave there. The digest
   * is taken over the *unpadded* image, because that is the region the next
   * image (or the bootloader) will read.
   */
  async writeImage(offset, image, onProgress = () => {}) {
    this.log(`writing ${image.length} bytes at 0x${offset.toString(16)}…`);
    const blocks = await this.flashBegin(image.length, offset);

    const blockTimeout = timeoutPerMb(ERASE_WRITE_TIMEOUT_PER_MB, FLASH_WRITE_SIZE);
    for (let seq = 0, at = 0; at < image.length; seq++, at += FLASH_WRITE_SIZE) {
      const slice = image.subarray(at, Math.min(at + FLASH_WRITE_SIZE, image.length));
      let block = slice;
      if (slice.length < FLASH_WRITE_SIZE) {
        block = new Uint8Array(FLASH_WRITE_SIZE).fill(0xff);
        block.set(slice);
      }
      await this.flashBlock(block, seq, blockTimeout);
      onProgress(Math.min(at + FLASH_WRITE_SIZE, image.length), image.length);
    }

    const want = md5Hex(image);
    const got = await this.flashMd5(offset, image.length);
    if (got !== want) {
      throw new EspError(
        `flash read-back does not match at 0x${offset.toString(16)}: the chip holds ` +
        `${got.slice(0, 16)}…, the image is ${want.slice(0, 16)}…. The write did not ` +
        `land; do not reset the board into it.`);
    }
    this.log(`verified 0x${offset.toString(16)} — digest matches`, "ok");
    return blocks;
  }

  /**
   * Leave the loader and run what was just written.
   *
   * Two mechanisms, in the order esptool trusts them, because the first one
   * demonstrably does not restart this board:
   *
   *  1. **A hard reset on RTS.** esptool's default `--after hard_reset`, and
   *     the one that works. RTS drives EN through the USB-Serial-JTAG
   *     peripheral, so pulsing it is a real power-on reset — which also means
   *     the USB device re-enumerates and the port we are holding dies. That is
   *     fine here and only here: it is the last thing the flasher does.
   *  2. **`FLASH_BEGIN(0, 0)` then `FLASH_END(1)`**, esptool's soft reset for
   *     a stub-less ROM. Kept as the fallback for a port that cannot drive the
   *     control lines. It was the only mechanism at first and left the board
   *     sitting in the loader after a perfectly good write — the ROM appears
   *     to accept it and stay put. The argument reads backwards (1 runs user
   *     code) because esptool's wrapper is named `flash_finish(reboot=False)`.
   *
   * Neither replies, because a chip that restarted cannot; a timeout here is
   * the success case.
   */
  async runUserCode() {
    if (await this.hardReset()) return;

    this.log("no control lines on this port — asking the ROM to run user code");
    await this.flashBegin(0, 0);
    await this.link.writeFrame(commandPacket(CMD.FLASH_END, u32le(1)));
    try { await this.readReply(CMD.FLASH_END, 500); } catch { /* already gone */ }
  }

  /**
   * Pulse EN through RTS: `RTS high` drives EN low, releasing it starts the
   * chip. DTR is held low throughout so BOOT is *not* asserted and the chip
   * comes up running the application rather than back in the loader.
   *
   * Returns false when the port has no control lines, so the caller can fall
   * back rather than report success it did not achieve.
   */
  async hardReset() {
    if (!this.link.port?.setSignals) return false;
    try {
      await this.link.setSignals({ dataTerminalReady: false, requestToSend: true });
      /* 200 ms, not 100: esptool uses the longer pause for parts reached over
       * native USB, "to give the chip some time to come out of reset, to be
       * able to handle further DTR/RTS transitions". The line is driving the
       * peripheral that also implements the USB device. */
      await sleep(USB_RESET_MS);
      await this.link.setSignals({ dataTerminalReady: false, requestToSend: false });
      await sleep(USB_RESET_MS);
      this.log("reset via RTS", "ok");
      return true;
    } catch {
      /* Some platforms refuse setSignals on a USB-JTAG-Serial port. */
      return false;
    }
  }
}

/**
 * Reboot an ESP32-S3 *into* download mode, with no buttons.
 *
 * The counterpart of the nRF52840's 1200-baud touch, and it needs nothing on
 * the device: the USB-Serial-JTAG peripheral maps DTR and RTS onto BOOT and
 * EN, so the whole sequence is host-side.
 *
 * ---- The (1,1) state is load-bearing -----------------------------------
 *
 * The peripheral decodes the *sequence of states* the two lines pass through,
 * not their final value, and the path from "BOOT asserted" to "EN asserted"
 * must go via **both lines high**. esptool.py says so in a comment on the two
 * calls that do it — "Calls inverted to go through (1,1) instead of (0,0)" —
 * and it is the only reason those two lines are in that order.
 *
 * This is easy to lose in translation, and was: pyserial sets each line with
 * its own ioctl, so the intermediate falls out of the call order for free,
 * whereas Web Serial's `setSignals` sets both at once and goes straight from
 * (1,0) to (0,1) — through neither. Measured on a XIAO ESP32-S3, same
 * endpoints and same delays:
 *
 *     00 -> 10 -> 01 -> 00           no serial data received
 *     00 -> 10 -> 11 -> 01 -> 00     download mode
 *
 * So (1,1) is emitted as a state of its own here. `esptool.test.mjs` asserts
 * the whole trace rather than the endpoints, because the endpoints were right
 * in the version that did not work.
 *
 * **This re-enumerates the USB device**, so the port dies under the caller and
 * a fresh one has to be chosen afterwards. That is exactly why it is a button
 * of its own and not a step inside flashing.
 */
export async function enterDownloadMode(link) {
  if (!link.port?.setSignals) throw new EspError("this port has no control lines to reset with");
  const sig = (dtr, rts) => link.setSignals({ dataTerminalReady: dtr, requestToSend: rts });

  await sig(false, false);    // idle
  await sleep(100);
  await sig(true, false);     // BOOT asserted
  await sleep(100);
  await sig(true, true);      // the intermediate the peripheral requires
  await sig(false, true);     // EN asserted — the chip is now in reset
  await sleep(100);
  await sig(false, false);    // released, and it comes up in download mode
}
