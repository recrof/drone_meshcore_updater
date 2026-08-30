/*
 * The ESP32-S3 ROM loader, against a ROM model that checks its inputs.
 *
 *   node web/test/esptool.test.mjs
 *
 * This board cannot be watched while it is being flashed. In download mode
 * there is no console at all — Trap 6 in notes/traps.md is the whole story of
 * finding that out — so every mistake in this protocol presents as "nothing
 * happened", and a board that boots nothing afterwards presents the same way
 * as a board that was never written.
 *
 * The fake ROM below therefore refuses what the real one refuses: a block that
 * is not 0x400 bytes, a data checksum that does not match, a sequence number
 * out of order, a write outside the region FLASH_BEGIN declared. Each of those
 * is silent on hardware.
 */
import {
  EspRomLoader, enterDownloadMode, checksum, commandPacket, CMD, FLASH_WRITE_SIZE,
} from "../js/lib/esptool.js";
import { md5Hex } from "../js/lib/md5.js";
import { SerialLink } from "../js/lib/serial.js";
import { FakePort, FrameSplitter, frameSlip, u32 } from "./harness/fake-serial.mjs";

let bad = 0;
const t = (name, ok, extra = "") => {
  console.log(`${ok ? "  ok  " : "  FAIL"} ${name}${extra ? `  [${extra}]` : ""}`);
  if (!ok) bad++;
};

const FLASH_SIZE = 8 * 1024 * 1024;

/**
 * A model of the ESP32-S3 ROM loader.
 *
 * `faults` turns individual checks into behaviour a real chip can also
 * exhibit: `corrupt` writes one byte wrong, which is what a marginal flash
 * part does and what the MD5 read-back exists to catch.
 */
class FakeRom {
  /* `chipId` null models a ROM with no GET_SECURITY_INFO — the ESP32 and
   * S2 — which is what forces the loader back onto the magic register. */
  constructor({ magic = 0x09, chipId = 9, faults = {} } = {}) {
    this.magic = magic;
    this.chipId = chipId;
    this.faults = faults;
    this.flash = new Uint8Array(FLASH_SIZE).fill(0xff);
    this.split = new FrameSplitter();
    this.attached = false;
    this.region = null;        // { offset, size, blocks, nextSeq }
    this.blockSizes = [];
    this.complaints = [];
    this.ranUserCode = false;
  }

  handle(chunk, push) {
    for (const frame of this.split.push(chunk)) this.request(frame, push);
  }

  reply(push, op, value = 0, data = new Uint8Array(0)) {
    const pkt = new Uint8Array(8 + data.length + 4);
    const v = new DataView(pkt.buffer);
    pkt[0] = 0x01;
    pkt[1] = op;
    v.setUint16(2, data.length + 4, true);
    v.setUint32(4, value >>> 0, true);
    pkt.set(data, 8);
    /* Four status bytes, which is what an ESP32-S2-or-later ROM sends; only
     * the first two mean anything. */
    push(frameSlip(pkt));
  }

  fail(push, op, why) {
    this.complaints.push(why);
    const pkt = new Uint8Array(12);
    pkt[0] = 0x01; pkt[1] = op;
    new DataView(pkt.buffer).setUint16(2, 4, true);
    pkt[8] = 0x01;                    // status: failed
    pkt[9] = 0x06;                    // some error code
    push(frameSlip(pkt));
  }

  request(frame, push) {
    if (frame[0] !== 0x00) return this.complaints.push("frame is not a request");
    const op = frame[1];
    const len = frame[2] | (frame[3] << 8);
    const chk = u32(frame, 4);
    const data = frame.subarray(8);
    if (data.length !== len) return this.complaints.push(`length says ${len}, got ${data.length}`);

    switch (op) {
      case CMD.SYNC:
        /* The ROM answers a single SYNC eight times. A client that does not
         * consume the extra seven mistakes one of them for the reply to
         * whatever it sends next. */
        for (let i = 0; i < 8; i++) this.reply(push, op, 0x12345678);
        return;

      case CMD.READ_REG:
        return this.reply(push, op, u32(data, 0) === 0x40001000 ? this.magic : 0);

      /* 4 bytes of flags, 7 key-purpose bytes and one reserved, then the u32
       * chip id. A real part appends an API version after it, so this replies
       * with 20 bytes rather than 16 — if the loader ever reads the id from
       * the end of the payload instead of from offset 12, that difference is
       * what catches it. */
      case CMD.GET_SECURITY_INFO: {
        if (this.chipId === null) {
          return this.fail(push, op, `unimplemented op 0x${op.toString(16)}`);
        }
        const info = new Uint8Array(20);
        new DataView(info.buffer).setUint32(12, this.chipId, true);
        return this.reply(push, op, 0, info);
      }

      case CMD.SPI_ATTACH:
        if (data.length !== 8) return this.fail(push, op, `SPI_ATTACH wants 8 bytes, got ${data.length}`);
        this.attached = true;
        return this.reply(push, op);

      case CMD.FLASH_BEGIN: {
        if (data.length !== 20) return this.fail(push, op, `FLASH_BEGIN wants 20 bytes, got ${data.length}`);
        const size = u32(data, 0), blocks = u32(data, 4);
        const blockSize = u32(data, 8), offset = u32(data, 12);
        if (blockSize !== FLASH_WRITE_SIZE) {
          return this.fail(push, op, `block size ${blockSize} is not the ROM's ${FLASH_WRITE_SIZE}`);
        }
        if (offset + size > FLASH_SIZE) return this.fail(push, op, "region runs past the end of flash");
        this.flash.fill(0xff, offset, offset + size);
        this.region = { offset, size, blocks, nextSeq: 0 };
        return this.reply(push, op);
      }

      case CMD.FLASH_DATA: {
        if (!this.region) return this.fail(push, op, "FLASH_DATA with no FLASH_BEGIN");
        const dlen = u32(data, 0), seq = u32(data, 4);
        const payload = data.subarray(16);
        if (dlen !== payload.length) return this.fail(push, op, "declared length disagrees with payload");
        if (checksum(payload) !== chk) return this.fail(push, op, `checksum wrong for block ${seq}`);
        if (seq !== this.region.nextSeq) {
          return this.fail(push, op, `block ${seq} out of order, expected ${this.region.nextSeq}`);
        }
        const at = this.region.offset + seq * FLASH_WRITE_SIZE;
        if (at + payload.length > this.region.offset + Math.max(this.region.size, payload.length)) {
          /* A block may run past the declared size only by the padding of the
           * last one; anything more is writing outside the erased region. */
          if (at >= this.region.offset + this.region.size) {
            return this.fail(push, op, `block ${seq} starts outside the declared region`);
          }
        }
        this.blockSizes.push(payload.length);
        this.flash.set(payload, at);
        if (this.faults.corrupt && seq === 0) this.flash[at + 3] ^= 0xff;
        this.region.nextSeq++;
        return this.reply(push, op);
      }

      case CMD.SPI_FLASH_MD5: {
        const addr = u32(data, 0), size = u32(data, 4);
        const hex = md5Hex(this.flash.subarray(addr, addr + size));
        return this.reply(push, op, 0, new TextEncoder().encode(hex));
      }

      case CMD.FLASH_END:
        this.ranUserCode = u32(data, 0) === 1;
        return this.reply(push, op);

      default:
        return this.fail(push, op, `unimplemented op 0x${op.toString(16)}`);
    }
  }
}

async function loaderOver(rom, opts) {
  const port = new FakePort((chunk, push) => rom.handle(chunk, push), opts);
  const link = new SerialLink(port);
  await link.open();
  return { port, link, loader: new EspRomLoader(link, () => {}) };
}

/* --- a normal run ------------------------------------------------------ */

const image = Uint8Array.from({ length: 4600 }, (_, i) => (i * 31 + 7) & 0xff);
/* Deliberately not a multiple of the block size, and deliberately containing
 * both bytes SLIP has to escape — firmware contains every byte value, and the
 * pair that needs escaping is common in real instruction streams. */
image[100] = 0xc0; image[101] = 0xdb; image[102] = 0xc0; image[103] = 0xc0;

{
  const rom = new FakeRom();
  const { port, link, loader } = await loaderOver(rom);

  const chip = await loader.connect();
  t("syncs and identifies the chip", chip === "ESP32-S3", chip);
  /* Connecting resets the board into download mode by itself — the port
   * survives it on this chip, so it is one step and not a button. */
  t("connecting resets into download mode first",
    port.signalTrace() === "00 10 11 01 00", port.signalTrace());
  port.signals.length = 0;

  await loader.spiAttach();
  t("SPI pins are configured before any write", rom.attached);

  const seen = [];
  await loader.writeImage(0x20000, image, (done, total) => seen.push([done, total]));

  t("the ROM accepted every block", rom.complaints.length === 0, rom.complaints.join(" | "));
  t("blocks are the ROM's 0x400, not the stub's 0x4000",
    rom.blockSizes.every(n => n === FLASH_WRITE_SIZE),
    [...new Set(rom.blockSizes)].join(","));
  t("the image landed byte for byte",
    Buffer.compare(Buffer.from(rom.flash.subarray(0x20000, 0x20000 + image.length)),
                   Buffer.from(image)) === 0);
  /* The last block is padded to a full block. 0xFF is the erased value, so the
   * padding must be indistinguishable from untouched flash. */
  t("padding past the image is erased, not garbage",
    rom.flash.subarray(0x20000 + image.length, 0x20000 + image.length + 64).every(b => b === 0xff));
  t("progress reaches the end", seen.at(-1)?.[0] === image.length);
  t("progress never overshoots", seen.every(([d, total]) => d <= total));

  /* The board did not restart on FLASH_END alone — observed on hardware, with
   * a write that had otherwise completed and verified. RTS drives EN through
   * the USB-Serial-JTAG peripheral, which is a real reset; esptool's own
   * default is `--after hard_reset` for the same reason. */
  await loader.runUserCode();
  t("leaving the loader pulses EN on RTS", port.signalTrace() === "01 00",
    port.signalTrace());
  t("BOOT is never asserted, so it comes up running the application",
    port.signals.every(s => s.dtr === false));
  t("and it does not fall back to FLASH_END when the reset worked", !rom.ranUserCode);
  await link.close();
}

/* --- the reset is skippable and non-fatal ------------------------------- */

{
  /* A board the user already put into download mode by hand, on a port whose
   * control lines do not work. Connecting must still succeed rather than
   * refusing because it could not do something it did not need to do. */
  const rom = new FakeRom();
  const { link, loader } = await loaderOver(rom, { signals: false });
  const chip = await loader.connect();
  t("a port with no control lines still connects", chip === "ESP32-S3");
  await link.close();
}

{
  const rom = new FakeRom();
  const { port, link, loader } = await loaderOver(rom);
  await loader.connect({ reset: false });
  t("the reset can be turned off", port.signals.length === 0, port.signalTrace());
  await link.close();
}

/* --- a port with no control lines -------------------------------------- */

/* Not every serial port exposes DTR/RTS. Falling back to the ROM's own "run
 * user code" is worse — it is what left the board sitting in the loader — but
 * it is better than not trying. */
{
  const rom = new FakeRom();
  const { link, loader } = await loaderOver(rom, { signals: false });
  await loader.connect();
  await loader.spiAttach();
  await loader.runUserCode();
  t("a port with no control lines falls back to FLASH_END", rom.ranUserCode);
  await link.close();
}

/* --- rebooting into download mode, with no buttons --------------------- */

/* The counterpart of the nRF52840's 1200-baud touch, and unlike it this needs
 * nothing on the device: DTR and RTS are wired to BOOT and EN inside the
 * USB-Serial-JTAG peripheral. The ordering is transcribed from esptool-js's
 * `UsbJtagSerialReset` and is not guessable — releasing both, asserting BOOT,
 * pulsing EN with BOOT still held, then releasing. */
{
  const rom = new FakeRom();
  const { port, link } = await loaderOver(rom);
  await enterDownloadMode(link);
  /* The whole trace, not the endpoints. The version that did not work on
   * hardware had identical endpoints and identical delays — it was missing
   * the (1,1) state, which the peripheral decodes as part of the sequence.
   * Measured: "00 10 01 00" gets no answer, "00 10 11 01 00" works. */
  t("the download-mode sequence goes through (1,1), as the chip requires",
    port.signalTrace() === "00 10 11 01 00", port.signalTrace());
  await link.close();
}

{
  const rom = new FakeRom();
  const { link } = await loaderOver(rom, { signals: false });
  let err = null;
  try { await enterDownloadMode(link); } catch (e) { err = e; }
  t("a port with no control lines says so rather than silently doing nothing",
    /control lines/.test(err?.message ?? ""), err?.message);
  await link.close();
}

/* --- the read-back check does its job ---------------------------------- */

{
  const rom = new FakeRom({ faults: { corrupt: true } });
  const { link, loader } = await loaderOver(rom);
  await loader.connect();
  await loader.spiAttach();
  let err = null;
  try { await loader.writeImage(0x20000, image); } catch (e) { err = e; }
  t("a single wrong byte fails the digest check", !!err);
  t("the failure says not to reset into it", /do not reset/i.test(err?.message ?? ""),
    (err?.message ?? "").slice(0, 90));
  await link.close();
}

/* --- identifying the chip ----------------------------------------------
 *
 * Two methods, and the order matters. GET_SECURITY_INFO carries an
 * IMAGE_CHIP_ID and is the only method that names the newer parts — the
 * ESP32-C5 has no chip-magic value at all, which is why its Flash button
 * could previously only fail. The magic register stays as the fallback
 * because it is the only method on the ESP32 and S2.
 */

{
  /* The C5: no magic value (0 is not in CHIP_MAGIC), identified by id 23.
   * This is the case the whole change exists for. */
  const rom = new FakeRom({ magic: 0, chipId: 23 });
  const { link, loader } = await loaderOver(rom);
  const chip = await loader.connect({ expect: "ESP32-C5" });
  t("a C5 is identified by chip id, with no magic value", chip === "ESP32-C5", chip);
  await link.close();
}

{
  /* And the board target is what says which chip to expect, so the S3's
   * loader still refuses a C5 rather than flashing an S3 image into it. */
  const rom = new FakeRom({ magic: 0, chipId: 23 });
  const { link, loader } = await loaderOver(rom);
  let err = null;
  try { await loader.connect({ expect: "ESP32-S3" }); } catch (e) { err = e; }
  t("a C5 is refused when an S3 was expected",
    /ESP32-C5/.test(err?.message ?? "") && /ESP32-S3/.test(err?.message ?? ""), err?.message);
  t("and nothing was written", rom.region === null);
  await link.close();
}

/* --- a board that is not an S3 ----------------------------------------- */

{
  /* chipId null models a ROM without the command, so this also covers the
   * fallback to the magic register still working. */
  const rom = new FakeRom({ magic: 0x000007c6, chipId: null });    // ESP32-S2
  const { link, loader } = await loaderOver(rom);
  let err = null;
  try { await loader.connect(); } catch (e) { err = e; }
  t("a different Espressif chip is refused by name", /ESP32-S2/.test(err?.message ?? ""),
    err?.message);
  t("and nothing was written", rom.region === null);
  await link.close();
}

{
  const rom = new FakeRom({ magic: 0xdeadbeef, chipId: null });
  const { link, loader } = await loaderOver(rom);
  let err = null;
  try { await loader.connect(); } catch (e) { err = e; }
  t("an unknown chip is refused with its magic", /deadbeef/.test(err?.message ?? ""), err?.message);
  await link.close();
}

/* --- a chip that is not in download mode -------------------------------- */

{
  /* The application is running and printing, but nothing answers the loader.
   * This is by far the most common failure, so the error has to name the
   * cause rather than report a timeout. */
  const port = new FakePort((chunk, push) => {
    push(new TextEncoder().encode("*** Booting Zephyr OS build v4.3.0 ***\n"));
  });
  const link = new SerialLink(port);
  await link.open();
  const loader = new EspRomLoader(link, () => {});
  let err = null;
  try { await loader.connect({ attempts: 2 }); } catch (e) { err = e; }
  t("a chip that is not in download mode says so", /download mode/.test(err?.message ?? ""));
  t("and quotes what the board actually said", /Booting Zephyr/.test(err?.message ?? ""),
    (err?.message ?? "").slice(0, 120));
  await link.close();
}

/* --- the command encoding ---------------------------------------------- */

{
  const pkt = commandPacket(CMD.FLASH_DATA, Uint8Array.from([1, 2, 3]), 0xef);
  t("a command frame is direction, op, length, checksum, payload",
    pkt[0] === 0 && pkt[1] === CMD.FLASH_DATA && pkt[2] === 3 && pkt[3] === 0 &&
    pkt[4] === 0xef && pkt.length === 11);
  t("the data checksum is an XOR seeded 0xEF",
    checksum(Uint8Array.from([0xef])) === 0x00 && checksum(new Uint8Array(0)) === 0xef);
}

console.log(bad ? `\n${bad} FAILURES` : "\nall esptool tests passed");
process.exit(bad ? 1 : 0);
