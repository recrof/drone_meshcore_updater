/*
 * Nordic Legacy DFU over the Adafruit bootloader's serial port.
 *
 * This is how the XIAO nRF52840 gets flashed from a browser. Its USB-C goes
 * straight to the nRF52840, so there is no CMSIS-DAP probe to talk to the way
 * there is on the nRF54L board — but the Adafruit UF2 bootloader it ships with
 * also exposes a CDC port speaking the SDK-11-era serial DFU protocol, and
 * Web Serial can reach that.
 *
 * ---- Where this came from -----------------------------------------------
 *
 * Ported from MeshCore's `flasher.meshcore.io/lib/dfu.js`, which is itself a
 * port of nrfutil's `dfu/dfu_transport_serial.py`, and which is the reference
 * to check against when something here misbehaves — it is the version with
 * real mileage on this exact bootloader. Three deliberate differences:
 *
 *  1. **No zip.** MeshCore's reads a *legacy nrfutil* package
 *     (`manifest.application.bin_file` plus a `.dat` init packet). Ours is an
 *     NCS/MCUboot package — same `dfu_application.zip` filename, completely
 *     unrelated schema (`files[]`, `load_address`), and it holds the OTA
 *     image rather than a full-flash one. Feeding one to the other produces a
 *     confident, wrong answer, so this file never opens a zip at all: it
 *     takes the bytes of `merged.hex` and synthesises the 14-byte init packet
 *     that nrfutil would have generated (see `initPacket`).
 *
 *  2. **One reader for the whole session** — see the header of serial.js.
 *     MeshCore's takes and releases a reader per ACK, which throws away
 *     anything the bootloader had already buffered.
 *
 *  3. **The framing is not re-implemented here.** SLIP lives in serial.js
 *     because the ESP32-S3 loader wants the identical thing.
 *
 * ---- Trap 2 applies, in a different costume -----------------------------
 *
 * Data packets carry no offset — the peer counts bytes and trusts the order —
 * which is exactly why the BLE client cannot resume a Legacy DFU mid-image
 * (notes/traps.md, Trap 2). The same is true here, and there is no retry
 * cleverness to be had: a failure costs the whole transfer. It is ~350 KB
 * over a local USB CDC link, so that is a few seconds, not a few minutes.
 *
 * No DOM dependency — the `link` argument is anything with the shape serial.js
 * exposes, which is what lets web/test/nordic-dfu-serial.test.mjs drive the
 * whole protocol against a fake bootloader.
 */

import { sleep } from "./serial.js";

/* --- protocol constants (dfu_transport_serial.py) ---------------------- */

/** The bootloader's CDC port. Rate is nominal over USB CDC but Web Serial
 *  requires one, and this is what nrfutil uses. */
export const DFU_BAUD = 115200;

/** The rate that means "reboot into DFU". Meaningless as a rate on a link
 *  with no UART behind it, which is what makes it usable as a signal. */
export const TOUCH_BAUD = 1200;

const DATA_INTEGRITY_CHECK_PRESENT = 1;
const RELIABLE_PACKET = 1;
const HCI_PACKET_TYPE = 14;

const DFU_INIT_PACKET = 1;
const DFU_START_PACKET = 3;
const DFU_DATA_PACKET = 4;
const DFU_STOP_DATA_PACKET = 5;

/** Update modes are a bit field; 4 is "application". */
export const DFU_UPDATE_MODE_APP = 4;

/** One data packet's payload. Not tunable: the bootloader's receive buffer. */
export const DFU_PACKET_MAX_SIZE = 512;

/* nRF52840 datasheet worst cases. The transfer is paced off these rather than
 * off flow control, because the protocol has none: a reliable packet is ACKed
 * when it is *received*, not when it has been written to flash. Same shape of
 * problem as Trap 4 on the BLE side, and paced the same way. */
const FLASH_PAGE_SIZE = 4096;
const FLASH_PAGE_ERASE_TIME_MS = 89.7;
const FLASH_PAGE_WRITE_TIME_MS = (FLASH_PAGE_SIZE / 4) * 0.1;

/** Packets per flash page — one pause per page rather than per packet. */
const PACKETS_PER_PAGE = FLASH_PAGE_SIZE / DFU_PACKET_MAX_SIZE;   // 8

const ACK_TIMEOUT_MS = 5000;

/** How often the erase wait checks the port is still there. */
const POLL_MS = 200;

/*
 * The application's start address, which is also where this image is written.
 *
 * The Adafruit bootloader hands the region above the MBR and SoftDevice to the
 * application: `CODE_REGION_1_START` is `is_sd_existed() ? SD_SIZE_GET(MBR_SIZE)
 * : MBR_SIZE`, decided at run time. The XIAO nRF52840 ships SoftDevice S140
 * 7.3.0, so that resolves to 0x27000 — the same number
 * `updater/nrf52840_partitions.dtsi` starts MCUboot at, which is why
 * `merged.hex` can be sent as-is.
 *
 * **It resolves to 0x1000 on a board whose SoftDevice has been erased**, and
 * then the image lands 0x26000 low, flashes cleanly and boots nothing. The
 * protocol carries no addresses, so nothing on the wire would say so; the
 * caller checks the image's own start address instead.
 */
export const APP_START = 0x27000;

/*
 * ---- This bootloader is single-bank ------------------------------------
 *
 * Version 0.6.1, which is what the XIAO nRF52840 ships (Nov 2021), has no
 * `dfu_dual_bank.c` at all — only `dfu_single_bank.c`. Two consequences, and
 * both matter more than they look:
 *
 *  - **The image is erased in place, before a byte of it has been sent.**
 *    `dfu_prepare_func_app_erase()` erases from `DFU_BANK_0_REGION_START`,
 *    which is the running application. So a transfer that fails part way does
 *    not leave the old firmware intact — it leaves nothing. UF2 is the way
 *    back, and it always works, because the bootloader itself is never
 *    touched.
 *  - **The size limit is `DFU_IMAGE_MAX_SIZE_FULL`, not the banked half.**
 *    There is no staging copy to find room for.
 */

/*
 * ---- Two size rules, and why they are checked here ---------------------
 *
 * `dfu_start_pkt_handle()` in the bootloader's `dfu_dual_bank.c` rejects a
 * START packet on either of these, and the transport that calls it does:
 *
 *     retval = dfu_start_pkt_handle(packet);
 *     APP_ERROR_CHECK(retval);
 *
 * **`APP_ERROR_CHECK` on a bootloader resets the chip.** So a rejected START
 * is not an error you can read: the HCI layer has *already* ACKed the packet
 * (the ACK goes out on receipt, before the scheduler runs the handler), the
 * client moves on to wait out the erase, and the device vanishes off USB
 * mid-wait. The browser reports "The device has been lost." — which describes
 * a yanked cable, and is what a perfectly seated cable also looks like here.
 *
 * That is why both of these are checked before a single byte goes out. The
 * device cannot tell us, so the client has to know.
 */

/** `IS_WORD_SIZED(SIZE)` — `((SIZE & 3) == 0)`, in `dfu_bank_internal.h`. */
export const IMAGE_ALIGNMENT = 4;

/**
 * `DFU_IMAGE_MAX_SIZE_FULL`, worked out for this board.
 *
 *     CODE_REGION_1_START       0x27000   (SoftDevice S140 7.3.0 is present)
 *     BOOTLOADER_REGION_START   0xF4000
 *     DFU_REGION_TOTAL_SIZE     0xCD000 = 839680
 *     DFU_APP_DATA_RESERVED      10*4096 =  40960   (nRF52840, from the Makefile)
 *     ..._MAX_SIZE_FULL                    798720
 *
 * This was 397312 for one revision of this file, which was the *dual-bank*
 * ceiling read out of `master`. The board runs 0.6.1, which has no dual-bank
 * mode; the number was wrong and comfortably too small, which is the harmless
 * direction but not a reason to have guessed at the version.
 */
export const MAX_IMAGE_SIZE = 798720;

/** Round up to a word with the erased value. The bootloader will not take a
 *  size that is not a multiple of four, and `merged.hex` ends wherever the
 *  signed image ends — which is word-aligned only by luck. */
export function padToWord(image) {
  const over = image.length % IMAGE_ALIGNMENT;
  if (over === 0) return image;
  const out = new Uint8Array(image.length + (IMAGE_ALIGNMENT - over)).fill(0xff);
  out.set(image);
  return out;
}

/* --- checksums --------------------------------------------------------- */

/**
 * CRC-16/CCITT as nrfutil computes it (`dfu/crc16.py`), seeded 0xFFFF.
 *
 * Used twice, for unrelated things: once per HCI packet as its trailer, and
 * once over the whole image as the last field of the init packet. Both must
 * agree with the bootloader bit for bit or the transfer is rejected.
 */
export function crc16(data, crc = 0xffff) {
  for (let i = 0; i < data.length; i++) {
    crc = ((crc >> 8) & 0x00ff) | ((crc << 8) & 0xff00);
    crc ^= data[i];
    crc ^= (crc & 0x00ff) >> 4;
    crc ^= (crc << 8) << 4;
    crc ^= ((crc & 0x00ff) << 4) << 1;
  }
  return crc & 0xffff;
}

/* --- the init packet --------------------------------------------------- */

/**
 * Adafruit's device type. **Not a wildcard, and not Nordic's default.**
 *
 * `dfu_init_prevalidate()` in the SDK 11 template treats `device_type` as
 * "0xFFFF matches anything", and that is what plain nrfutil emits. Adafruit
 * commented that check out and put an equality test in its place:
 *
 *     #define ADAFRUIT_DEVICE_TYPE  0x0052
 *     ...
 *     if ( p_init_packet->device_type != ADAFRUIT_DEVICE_TYPE )
 *         return NRF_ERROR_FORBIDDEN;
 *
 * with a comment at the top of the file saying so: "All firmware init data
 * must has Device Type ADAFRUIT_DEVICE_TYPE". Sending 0xFFFF is refused —
 * and `process_dfu_packet` wraps the result in `APP_ERROR_CHECK`, so the
 * refusal arrives as a reset, several hundred milliseconds after the packet
 * was already acknowledged.
 */
const ADAFRUIT_DEVICE_TYPE = 0x0052;

/**
 * The 14 bytes `adafruit-nrfutil` would have put in the `.dat` file.
 *
 *   device_type      2   0x0052  — Adafruit's, and checked for equality
 *   device_rev       2   0xFFFF  — only checked when updating the SoftDevice
 *                                  or the bootloader, which this never does
 *   app_version      4   0xFFFFFFFF
 *   sd_req count     2   1
 *   sd_req[0]        2   0xFFFE  "any SoftDevice" — this one *is* a wildcard
 *   image crc16      2   over the application image
 *
 * Two of these carry information. The CRC is checked in
 * `dfu_init_postvalidate()` at the end of the transfer, and getting it wrong
 * is a *safe* failure — the bootloader declines to activate. `device_type` is
 * checked at the start, and getting it wrong is not safe at all: the board
 * resets with the application already erased.
 *
 * Which is why "reconstructed from nrfutil's defaults" was not good enough
 * here. The vendor forked the validator.
 */
export function initPacket(image) {
  const p = new Uint8Array(14);
  const v = new DataView(p.buffer);
  v.setUint16(0, ADAFRUIT_DEVICE_TYPE, true);
  v.setUint16(2, 0xffff, true);          // device revision: unchecked for an app update
  v.setUint32(4, 0xffffffff, true);      // application version: any
  v.setUint16(8, 1, true);               // one entry in the SoftDevice list
  v.setUint16(10, 0xfffe, true);         // ... and it is the "any" wildcard
  v.setUint16(12, crc16(image), true);
  return p;
}

export { ADAFRUIT_DEVICE_TYPE };

/* --- HCI framing ------------------------------------------------------- */

/**
 * The four-byte reliable-packet header, then payload, then CRC16.
 *
 * Header, in order: this packet's sequence number and the one it acknowledges
 * (three bits each), the two flags that say "there is a CRC" and "this packet
 * is reliable", the packet type in the low nibble of byte 1 with the payload
 * length straddling bytes 1 and 2, and a byte-1..3 checksum that is the
 * two's complement of their sum.
 */
export function hciPacket(seq, payload) {
  const head = new Uint8Array(4);
  head[0] = seq | (((seq + 1) % 8) << 3) |
            (DATA_INTEGRITY_CHECK_PRESENT << 6) | (RELIABLE_PACKET << 7);
  head[1] = HCI_PACKET_TYPE | ((payload.length & 0x000f) << 4);
  head[2] = (payload.length & 0x0ff0) >> 4;
  head[3] = (~(head[0] + head[1] + head[2]) + 1) & 0xff;

  const body = new Uint8Array(head.length + payload.length + 2);
  body.set(head, 0);
  body.set(payload, head.length);
  const crc = crc16(body.subarray(0, head.length + payload.length));
  body[body.length - 2] = crc & 0xff;
  body[body.length - 1] = (crc >> 8) & 0xff;
  return body;
}

const u32 = (...values) => {
  const out = new Uint8Array(values.length * 4);
  const v = new DataView(out.buffer);
  values.forEach((n, i) => v.setUint32(i * 4, n >>> 0, true));
  return out;
};

const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
};

/* --- the transfer ------------------------------------------------------ */

/**
 * Ask a running application to reboot into the bootloader.
 *
 * Open the port at 1200 baud, close it. Arduino's convention, which Adafruit's
 * bootloader is built around: the *application* watches for the rate and
 * reboots with a magic byte in GPREGRET.
 *
 * **Nothing in Zephyr does this**, so the firmware in this repo implements it
 * — `updater/src/usb_dfu_touch.c`. Which means the button is only as good as
 * what is on the board: a XIAO nRF52840 running something else, or a build
 * from before that file existed, will sit there at 1200 baud and ignore it.
 * There is no acknowledgement to wait for and nothing to detect, so the caller
 * cannot report success — only that the request was sent.
 *
 * The port is taken and released rather than reused because the device
 * re-enumerates as the bootloader: a different USB device, and not one this
 * handle can follow.
 */
export async function touchReset(port, { openMs = 100, rebootMs = 1500 } = {}) {
  await port.open({ baudRate: TOUCH_BAUD });
  await sleep(openMs);
  await port.close();
  /* The bootloader takes about a second to enumerate. Waiting here means the
   * user is told to pick a port at a moment when the right one exists. */
  await sleep(rebootMs);
}

/*
 * Why the touch is a button and not a step inside flashing.
 *
 * When it works it re-enumerates the USB device, and the Web Serial port we
 * were handed does not survive that — so it cannot be folded into the flashing
 * sequence, which needs a live port immediately afterwards. As its own button
 * the re-enumeration is expected: the user picks the bootloader's port next,
 * exactly as they would after a double-tap of RESET.
 */

export class NordicSerialDfu {
  /**
   * @param link  a SerialLink (or anything with writeFrame/readFrame/flush)
   * @param log   optional (message, cls) sink
   */
  constructor(link, log = () => {}) {
    this.link = link;
    this.log = log;
    this.seq = 0;
    this.lastAck = null;
  }

  /**
   * Send one reliable packet and wait for its ACK.
   *
   * The ACK carries the *next* expected sequence number in bits 3..5. The
   * first is accepted unchecked — there is nothing to compare it against —
   * after which each must be one more than the last, modulo 8.
   *
   * **Relative to the previous ACK, not to the sequence number just sent**,
   * which is what nrfutil and MeshCore's port both do. The absolute check
   * would be stricter and would catch one more case (an ACK stream offset by
   * a constant, which this cannot see), but it would also fail every transfer
   * outright if the bootloader's convention differs from this reading of it —
   * and there is no hardware in the test suite to settle that. The case it
   * misses is caught anyway, at the end, by the image CRC in the init packet:
   * that is precisely what that CRC is for. What this check *does* catch is a
   * gap, which is what a dropped or duplicated packet actually looks like.
   */
  async send(payload, timeoutMs = ACK_TIMEOUT_MS, what = "an ACK") {
    this.seq = (this.seq + 1) % 8;
    await this.link.writeFrame(hciPacket(this.seq, payload));

    const frame = await this.link.readFrame(timeoutMs, what);
    if (frame.length < 2) throw new Error("truncated ACK from the bootloader");
    const ack = (frame[0] >> 3) & 0x07;
    if (this.lastAck !== null && ack !== (this.lastAck + 1) % 8) {
      throw new Error(`bootloader ACK out of sequence — expected ` +
                      `${(this.lastAck + 1) % 8}, got ${ack}. The transfer cannot ` +
                      `be resumed; start it again.`);
    }
    this.lastAck = ack;
    return ack;
  }

  /** START: declare the mode and the sizes, then wait out the erase. */
  async start(appSize, { mode = DFU_UPDATE_MODE_APP, softDeviceSize = 0, bootloaderSize = 0 } = {}) {
    await this.send(u32(DFU_START_PACKET, mode, softDeviceSize, bootloaderSize, appSize),
                    ACK_TIMEOUT_MS, "the start-packet ACK");
    /* The bootloader erases the destination before it will take data, and
     * says nothing while it does. Worst-case page erase times, matching
     * nrfutil, with a half-second floor for a tiny image. */
    const total = softDeviceSize + bootloaderSize + appSize;
    const eraseMs = Math.max(500, (total / FLASH_PAGE_SIZE + 1) * FLASH_PAGE_ERASE_TIME_MS);
    this.log(`erasing ${Math.ceil(total / FLASH_PAGE_SIZE)} pages (~${Math.round(eraseMs / 100) / 10}s)…`);
    await this.waitOutErase(eraseMs);
  }

  /**
   * Wait for the erase — watching the port, not just sleeping on it.
   *
   * This used to be a bare `sleep()`, and that threw away the one fact worth
   * having. The bootloader's only way to refuse a START packet is to reset
   * (see the size rules above), and the erase runs *inside* the packet
   * handler — `dfu_start_pkt_handle` calls `flash_nrf5x_erase()`
   * synchronously, and the bootloader's main loop is
   * `app_sched_execute(); tud_task();`, so USB gets no service at all until
   * every page is gone. Both of those end with the device off the bus.
   *
   * **When it disappears tells them apart**, and nothing else does:
   *
   *   immediately  the handler rejected the packet and reset — a size or
   *                state rule this client does not yet enforce
   *   part way     the CPU stalled in flash erase long enough that the host
   *                gave up on a device that had stopped answering
   *
   * So the wait polls, and the error carries the number.
   */
  async waitOutErase(totalMs) {
    const started = Date.now();
    while (Date.now() - started < totalMs) {
      await sleep(Math.min(POLL_MS, totalMs - (Date.now() - started)));
      if (!this.link.closed) continue;

      const at = (Date.now() - started) / 1000;
      const of = (totalMs / 1000).toFixed(1);
      throw new Error(
        at < 1
          ? `the board reset immediately after accepting the start packet ` +
            `(${at.toFixed(1)}s into a ${of}s erase). The bootloader resets rather ` +
            `than reporting an error, so it refused the image for a reason this ` +
            `client did not catch — not for anything that happens during the erase.`
          : `the board dropped off USB ${at.toFixed(1)}s into a ${of}s erase. It was ` +
            `erasing the whole time, and this bootloader erases inside the packet ` +
            `handler without servicing USB, so the host gave up on a device that had ` +
            `stopped answering. That is a limit of serial DFU on this board, not ` +
            `something to retry — use the .uf2 instead.`);
    }
  }

  async sendInit(image) {
    /* Trailing two zero bytes are part of the frame nrfutil sends, not
     * padding we invented — the bootloader reads a fixed-size record. */
    await this.send(concat(u32(DFU_INIT_PACKET), initPacket(image), new Uint8Array(2)),
                    ACK_TIMEOUT_MS, "the init-packet ACK");
  }

  /**
   * Stream the image, pausing once per flash page.
   *
   * The pause is the whole trick. Packets are ACKed on receipt, so the
   * bootloader will happily accept a ninth packet it has nowhere to put while
   * the eighth is still being written; one pause per page, sized to the
   * datasheet's worst-case page write, is what keeps that from happening.
   */
  async sendImage(image, onProgress = () => {}) {
    await sleep(FLASH_PAGE_WRITE_TIME_MS);
    let sent = 0;
    let n = 0;
    while (sent < image.length) {
      const chunk = image.subarray(sent, sent + DFU_PACKET_MAX_SIZE);
      await this.send(concat(u32(DFU_DATA_PACKET), chunk), ACK_TIMEOUT_MS,
                      `the ACK for bytes ${sent}..${sent + chunk.length}`);
      sent += chunk.length;
      onProgress(sent, image.length);
      if (++n % PACKETS_PER_PAGE === 0) await sleep(FLASH_PAGE_WRITE_TIME_MS);
    }
    await sleep(FLASH_PAGE_WRITE_TIME_MS);
  }

  /** STOP: the bootloader validates the CRC and, if it passes, activates. */
  async finish() {
    await this.send(u32(DFU_STOP_DATA_PACKET), ACK_TIMEOUT_MS, "the stop-packet ACK");
  }

  /** The whole transfer. `image` is the flat application image. */
  async flash(image, onProgress = () => {}) {
    const padded = padToWord(image);
    if (padded.length !== image.length) {
      this.log(`padded to a word: ${padded.length} bytes`);
    }
    if (padded.length > MAX_IMAGE_SIZE) {
      throw new Error(
        `the image is ${padded.length} bytes and this bootloader takes at most ` +
        `${MAX_IMAGE_SIZE} for an application update — it dual-banks, so it needs ` +
        `room for two copies. Nothing has been sent. Flash it with a probe, or ` +
        `by dropping merged.uf2 onto the bootloader's drive, which has no such limit.`);
    }
    image = padded;

    this.seq = 0;
    this.lastAck = null;
    this.log(`sending ${image.length} bytes to 0x${APP_START.toString(16)}`);
    /* Elapsed time is kept for the *failure* message. Every way this can go
     * wrong looks the same from here — the board stops answering — and where
     * in the sequence it happened is most of the diagnosis. */
    const t0 = Date.now();
    try {
      await this.start(image.length);
      await this.sendInit(image);

      const sending = Date.now();
      await this.sendImage(image, onProgress);
      const secs = (Date.now() - sending) / 1000;
      this.log(`sent in ${secs.toFixed(1)}s (${(image.length / 1024 / secs).toFixed(1)} KB/s)`, "ok");

      await this.finish();
    } catch (e) {
      throw new Error(`t+${((Date.now() - t0) / 1000).toFixed(1)}s: ${explain(e.message)}`);
    }
  }
}

/*
 * Turn a lost port into something a person can act on.
 *
 * The bootloader has exactly one way to say "no" to a START packet, and it is
 * to reset — so "The device has been lost." is not usually a cable, and
 * treating it as one sends people to check the wrong thing. The checks in
 * `flash()` catch the two rejections we know about; this covers the rest,
 * including whatever a future bootloader build rejects that this file has not
 * heard of.
 */
function explain(message) {
  if (!/lost|closed|disconnect|removed/i.test(message)) return message;
  return `${message}\n\nThe bootloader is untouched and the board is not bricked: ` +
         `double-tap RESET and the drive comes back. **The application is gone, ` +
         `though** — this bootloader is single-bank and erases the old firmware ` +
         `before the first byte arrives, so a failed transfer leaves nothing to fall ` +
         `back to. Recover by dropping merged.uf2 onto the drive.`;
}
