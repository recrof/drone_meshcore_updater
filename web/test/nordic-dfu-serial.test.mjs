/*
 * Nordic Legacy DFU over serial, against a bootloader model that validates.
 *
 *   node web/test/nordic-dfu-serial.test.mjs
 *
 * The protocol has no addresses, no offsets and no resume (Trap 2): the
 * bootloader counts bytes and trusts the order, so every framing mistake in
 * here produces an image that is *accepted* and wrong. The only thing standing
 * between a bad packet and a device that will not boot is the CRC in the init
 * packet — so the fake below checks it exactly as the real bootloader does,
 * along with the per-packet CRC, the header checksum and the sequence numbers.
 *
 * The reference for all of it is nrfutil's `dfu_transport_serial.py` by way of
 * MeshCore's `flasher.meshcore.io/lib/dfu.js`.
 *
 * ---- What this fake missed the first time -------------------------------
 *
 * It accepted any image size. The real `dfu_start_pkt_handle()` does not: it
 * refuses a size that is not word-sized, or larger than the dual-bank ceiling,
 * and the transport wraps it in `APP_ERROR_CHECK` — which on a bootloader
 * **resets the chip**. So the first real transfer sent 346,987 bytes (`& 3 ==
 * 3`), was ACKed by the HCI layer, and then the board vanished off USB while
 * the client sat out the erase. "The device has been lost."
 *
 * The lesson is the one in the header of fake-serial.mjs, learned the
 * expensive way: a fake that accepts what the real device rejects is a fake
 * that certifies the bug. Both checks are modelled below, and violating
 * either drops the port exactly as the reset did.
 */
import {
  NordicSerialDfu, hciPacket, crc16, initPacket, padToWord, touchReset,
  ADAFRUIT_DEVICE_TYPE, BOOTLOADERS, bootloaderFor, DFU_PACKET_MAX_SIZE,
  IMAGE_ALIGNMENT, TOUCH_BAUD,
} from "../js/lib/nordic-dfu-serial.js";
import { SerialLink } from "../js/lib/serial.js";
import { FakePort, FrameSplitter, frameSlip, u32, u16 } from "./harness/fake-serial.mjs";

let bad = 0;
const t = (name, ok, extra = "") => {
  console.log(`${ok ? "  ok  " : "  FAIL"} ${name}${extra ? `  [${extra}]` : ""}`);
  if (!ok) bad++;
};

/* --- checksums, against published check values ------------------------- */

/* CRC-16/CCITT-FALSE's own check value. Anchoring to it rather than to a
 * number this implementation produced means a subtly wrong variant — there
 * are at least four in circulation, and they differ only in seeding and bit
 * order — cannot be blessed by its own output. */
t("crc16 matches the CCITT-FALSE check value",
  crc16(new TextEncoder().encode("123456789")) === 0x29b1,
  "0x" + crc16(new TextEncoder().encode("123456789")).toString(16));

/* --- the init packet --------------------------------------------------- */

{
  const image = Uint8Array.from({ length: 300 }, (_, i) => i & 0xff);
  const p = initPacket(image);
  t("the init packet is the 14 bytes nrfutil emits", p.length === 14);
  /* Not a wildcard. `dfu_init_prevalidate()` compares this for equality —
   * Adafruit replaced the SDK's "0xFFFF matches anything" with a hard check,
   * and refusing resets the board. */
  t("the device type is Adafruit's, not nrfutil's wildcard",
    u16(p, 0) === ADAFRUIT_DEVICE_TYPE && ADAFRUIT_DEVICE_TYPE === 0x0052,
    "0x" + u16(p, 0).toString(16).padStart(4, "0"));
  t("revision and version are wildcards — those checks were left alone",
    u16(p, 2) === 0xffff && u32(p, 4) === 0xffffffff);
  t("it requires any SoftDevice", u16(p, 8) === 1 && u16(p, 10) === 0xfffe);
  t("it carries the image CRC, which is the only field that says anything",
    u16(p, 12) === crc16(image));
}

/* --- the HCI header ---------------------------------------------------- */

{
  const pkt = hciPacket(3, Uint8Array.from([0xaa, 0xbb]));
  t("the header acknowledges the next sequence number",
    (pkt[0] & 0x07) === 3 && ((pkt[0] >> 3) & 0x07) === 4);
  t("it is flagged reliable and CRC-bearing", (pkt[0] & 0xc0) === 0xc0);
  t("the packet type is 14", (pkt[1] & 0x0f) === 14);
  t("the payload length straddles bytes 1 and 2",
    (((pkt[1] >> 4) & 0x0f) | (pkt[2] << 4)) === 2);
  t("the header checksum is the two's complement of the first three bytes",
    ((pkt[0] + pkt[1] + pkt[2] + pkt[3]) & 0xff) === 0);
  t("the sequence number wraps at 8",
    (hciPacket(7, new Uint8Array(0))[0] >> 3 & 0x07) === 0);
}

/* --- a bootloader that checks what it is sent -------------------------- */

const OP = { INIT: 1, START: 3, DATA: 4, STOP: 5 };

class FakeBootloader {
  constructor({ skipAckAfter = 0, port = null,
                maxImage = BOOTLOADERS.xiao_ble.maxImage } = {}) {
    /* DFU_IMAGE_MAX_SIZE_FULL, which the real bootloader computes from its
     * own CODE_REGION_1_START — so it is per board, not a constant. */
    this.maxImage = maxImage;
    /* Needed so a rejected START can do what the real one does: disappear. */
    this.port = port;
    this.reset = false;
    /* Skip an ACK number once the given number of packets have gone by — a
     * dropped or duplicated packet, which is the desync that actually
     * happens on a wire. */
    this.skipAckAfter = skipAckAfter;
    this.packets = 0;
    this.split = new FrameSplitter();
    this.lastSeq = null;
    this.received = [];
    this.declared = null;      // { mode, appSize }
    this.init = null;
    this.dataSizes = [];
    this.complaints = [];
    this.activated = false;
  }

  handle(chunk, push) {
    for (const frame of this.split.push(chunk)) this.packet(frame, push);
  }

  packet(frame, push) {
    if (frame.length < 6) return this.complaints.push("packet shorter than a header plus CRC");
    const head = frame.subarray(0, 4);
    const body = frame.subarray(4, frame.length - 2);
    const crc = frame[frame.length - 2] | (frame[frame.length - 1] << 8);

    if (((head[0] + head[1] + head[2] + head[3]) & 0xff) !== 0) {
      return this.complaints.push("header checksum wrong");
    }
    if ((head[0] & 0xc0) !== 0xc0) return this.complaints.push("not a reliable, CRC-bearing packet");
    if ((head[1] & 0x0f) !== 14) return this.complaints.push("wrong packet type");

    const declaredLen = ((head[1] >> 4) & 0x0f) | (head[2] << 4);
    if (declaredLen !== body.length) {
      return this.complaints.push(`length says ${declaredLen}, payload is ${body.length}`);
    }
    if (crc16(frame.subarray(0, frame.length - 2)) !== crc) {
      return this.complaints.push("packet CRC wrong");
    }

    const seq = head[0] & 0x07;
    if (this.lastSeq !== null && seq !== (this.lastSeq + 1) % 8) {
      return this.complaints.push(`sequence ${seq} out of order after ${this.lastSeq}`);
    }
    this.lastSeq = seq;

    /* The ACK is an unreliable, CRC-less packet whose only content is the
     * sequence number it expects next. */
    this.packets++;
    const skip = this.skipAckAfter && this.packets === this.skipAckAfter;
    const ack = (seq + (skip ? 2 : 1)) % 8;
    const reply = new Uint8Array(4);
    reply[0] = (ack << 3);
    reply[1] = 14;
    reply[2] = 0;
    reply[3] = (~(reply[0] + reply[1] + reply[2]) + 1) & 0xff;
    push(frameSlip(reply));

    /* **After** the ACK, deliberately. The real transport ACKs in
     * `rpc_transport_event_handler` on receipt and only then hands the packet
     * to the scheduler, so a packet the handler rejects has already been
     * acknowledged — which is why a fatal refusal looks like a healthy
     * transfer right up to the moment the board stops existing. */
    this.payload(body);
  }

  payload(body) {
    const op = u32(body, 0);
    if (op === OP.START) {
      const sizes = [u32(body, 8), u32(body, 12), u32(body, 16)];
      /* `dfu_start_pkt_handle()`, in order. Both of these return an error that
       * `APP_ERROR_CHECK` turns into a system reset, so neither is reportable
       * over the wire — the device just goes away. */
      if (sizes.some(n => n % 4 !== 0)) return this.die(`image size ${sizes[2]} is not word-sized`);
      if (sizes.reduce((a, b) => a + b, 0) > this.maxImage) {
        return this.die(`image is larger than DFU_IMAGE_MAX_SIZE_FULL`);
      }
      this.declared = { mode: u32(body, 4), appSize: sizes[2] };
    } else if (op === OP.INIT) {
      this.init = body.subarray(4, 18);
      /* `dfu_init_prevalidate()`, and it is another reset-shaped refusal:
       * `process_dfu_packet` does `APP_ERROR_CHECK(dfu_init_pkt_complete())`.
       * This fake accepted anything here, which is how a client that sent
       * nrfutil's 0xFFFF wildcard passed every test and reset the board on
       * the first real transfer. */
      if (u16(this.init, 0) !== ADAFRUIT_DEVICE_TYPE) {
        return this.die(`device type 0x${u16(this.init, 0).toString(16)} is not ` +
                        `Adafruit's 0x${ADAFRUIT_DEVICE_TYPE.toString(16)}`);
      }
      const sdList = u16(this.init, 8);
      if (sdList !== 1 || u16(this.init, 10) !== 0xfffe) {
        return this.die("no matching SoftDevice in the requirement list");
      }
    } else if (op === OP.DATA) {
      const chunk = body.subarray(4);
      this.dataSizes.push(chunk.length);
      this.received.push(...chunk);
    } else if (op === OP.STOP) {
      this.validate();
    } else {
      this.complaints.push(`unknown opcode ${op}`);
    }
  }

  /* APP_ERROR_CHECK on a bootloader is a reset. From the host that is a USB
   * device that stopped existing, with nothing said about why. */
  die(why) {
    this.complaints.push(why);
    this.reset = true;
    this.port?.close();
  }

  /* What the real bootloader does at the end, and the only check that can
   * catch a stream that was framed correctly but assembled wrong. */
  validate() {
    const image = Uint8Array.from(this.received);
    if (!this.declared) return this.complaints.push("STOP with no START");
    if (image.length !== this.declared.appSize) {
      return this.complaints.push(`got ${image.length} bytes, START declared ${this.declared.appSize}`);
    }
    if (!this.init) return this.complaints.push("no init packet");
    if (u16(this.init, 12) !== crc16(image)) {
      return this.complaints.push("image CRC does not match the init packet");
    }
    this.activated = true;
  }
}

async function dfuOver(boot) {
  const port = new FakePort((chunk, push) => boot.handle(chunk, push));
  boot.port = port;
  const link = new SerialLink(port);
  await link.open();
  return { link, dfu: new NordicSerialDfu(link, () => {}, BOOTLOADERS.xiao_ble) };
}

/* Long enough to wrap the three-bit sequence counter and to cross a flash
 * page, which is where the pacing pauses fall. Contains both bytes SLIP
 * escapes, because firmware does. */
const image = Uint8Array.from({ length: 6000 }, (_, i) => (i * 17 + 3) & 0xff);
image.set([0xc0, 0xdb, 0xc0, 0xdb], 1000);

{
  const boot = new FakeBootloader();
  const { link, dfu } = await dfuOver(boot);
  const seen = [];
  await dfu.flash(image, (done, total) => seen.push([done, total]));

  t("the bootloader accepted every packet", boot.complaints.length === 0,
    boot.complaints.join(" | "));
  t("START declares the application mode", boot.declared?.mode === 4);
  t("START declares the image size", boot.declared?.appSize === image.length);
  t("the bootloader did not reset", !boot.reset);
  t("the image arrived byte for byte",
    Buffer.compare(Buffer.from(boot.received), Buffer.from(padToWord(image))) === 0);
  t("the declared size is word-sized", boot.declared?.appSize % IMAGE_ALIGNMENT === 0);
  t("the image CRC in the init packet checks out", boot.activated);
  t("the init packet passed prevalidation", !boot.reset, boot.complaints.join(" | "));
  t("no data packet exceeds the bootloader's buffer",
    boot.dataSizes.every(n => n <= DFU_PACKET_MAX_SIZE),
    Math.max(...boot.dataSizes));
  /* More than eight packets, so the three-bit counter wrapped — the arithmetic
   * that is easiest to get wrong and hardest to notice, since the first eight
   * packets of any transfer look identical either way. */
  t("the sequence counter wrapped", boot.dataSizes.length > 8, boot.dataSizes.length);
  t("progress reaches the end", seen.at(-1)?.[0] === image.length);
  await link.close();
}

/* --- a desync is caught, and says it cannot be resumed ------------------ */

/* A skipped ACK, which is what a dropped packet looks like from this end. An
 * ACK stream offset by a *constant* is deliberately not detected here — see
 * the comment on `send` — and is caught by the image CRC at STOP instead. */

{
  const boot = new FakeBootloader({ skipAckAfter: 4 });
  const { link, dfu } = await dfuOver(boot);
  let err = null;
  try { await dfu.flash(image); } catch (e) { err = e; }
  t("an out-of-sequence ACK stops the transfer", /out of sequence/.test(err?.message ?? ""));
  /* Trap 2: rewinding to the peer's byte count realigns the counters and
   * corrupts the image, so the only honest advice is to start again. */
  t("and says to start again rather than resume", /start it again/.test(err?.message ?? ""),
    err?.message);
  await link.close();
}

/* --- the size rules the bootloader enforces by resetting ---------------- */

/* The real failure, reproduced: `merged.hex` for this board flattens to
 * 346,987 bytes, and 346987 & 3 == 3. */
{
  const odd = Uint8Array.from({ length: 4001 }, (_, i) => i & 0xff);
  t("the fixture is the shape that broke it", odd.length % IMAGE_ALIGNMENT !== 0);

  const boot = new FakeBootloader();
  const { link, dfu } = await dfuOver(boot);
  await dfu.flash(odd);
  t("an image that is not word-sized is padded, not sent as-is", !boot.reset,
    boot.complaints.join(" | "));
  t("the padding is the erased value, so it writes nothing new",
    boot.received.slice(odd.length).every(b => b === 0xff));
  t("and the padded image still passes the bootloader's CRC", boot.activated);
  await link.close();
}

t("padToWord leaves an already-aligned image alone", (() => {
  const a = new Uint8Array(8);
  return padToWord(a) === a;
})());

/* The other reset-shaped rejection. Not reachable by anything this repo
 * builds — see below — but it is enforced client-side anyway, because the
 * device's way of reporting it is to reset. */
{
  const boot = new FakeBootloader();
  const { link, dfu } = await dfuOver(boot);
  let err = null;
  try { await dfu.flash(new Uint8Array(BOOTLOADERS.xiao_ble.maxImage + 4)); }
  catch (e) { err = e; }
  t("an image past the board's ceiling is refused by the client", !!err);
  t("nothing was sent to the device", boot.declared === null && !boot.reset);
  t("and it names a route that has no such limit", /uf2|probe/i.test(err?.message ?? ""),
    (err?.message ?? "").slice(-80));
  await link.close();
}

/* Every image this repo can produce fits, because a single-bank bootloader
 * needs room for one copy and not two. This assertion is the record of a
 * mistake: the ceiling was briefly 397312, the *dual-bank* number read out of
 * the bootloader's `master` branch — but the shipped bootloader is 0.6.1,
 * which has no dual-bank mode. Reading the version the board actually runs is
 * not optional. */
for (const [name, bl] of Object.entries(BOOTLOADERS)) {
  t(`${name}: everything this repo builds fits under the single-bank ceiling`,
    (48 + 388) * 1024 < bl.maxImage,
    `slots ${(48 + 388) * 1024} vs ceiling ${bl.maxImage}`);
}

/* A profile is required, not defaulted. The two boards write the application
 * a flash page apart, so a default would put one board's image out of place on
 * the other — cleanly, and with nothing on the wire to say so. */
{
  let err = null;
  try { new NordicSerialDfu({}, () => {}); } catch (e) { err = e; }
  t("constructing without a bootloader profile is refused", !!err,
    (err?.message ?? "no error").slice(0, 60));
}

/* --- the init packet the vendor's fork requires ------------------------- */

/* The third hardware failure, and the one the fake had been certifying:
 * `initPacket()` sent nrfutil's 0xFFFF "any device" wildcard, which Adafruit's
 * `dfu_init_prevalidate()` refuses outright. */
{
  const boot = new FakeBootloader();
  const { link, dfu } = await dfuOver(boot);
  const realPayload = boot.payload.bind(boot);
  /* Rewrite the device type on the wire to what the client used to send. */
  boot.payload = (body) => {
    if (u32(body, 0) === OP.INIT) new DataView(body.buffer, body.byteOffset).setUint16(4, 0xffff, true);
    realPayload(body);
  };
  let err = null;
  try { await dfu.flash(new Uint8Array(2048)); } catch (e) { err = e; }
  t("the old wildcard device type is refused by the bootloader model", boot.reset);
  t("and the client sees the board go away", !!err);
  await link.close();
}

/* --- a board that vanishes during the erase ----------------------------- */

/* The bootloader has two ways to disappear and they need different advice, so
 * the error has to say *when* it happened. A blind sleep could not: the port
 * died, nothing was awaiting it, and the failure surfaced at the next write
 * with no timing attached. */
{
  /* Reset the instant the START packet lands — a rule the client did not
   * catch, which is what the first two hardware runs looked like. */
  const boot = new FakeBootloader();
  const { link, dfu } = await dfuOver(boot);
  const realPayload = boot.payload.bind(boot);
  boot.payload = (body) => { realPayload(body); if (u32(body, 0) === OP.START) boot.die("instant reset"); };

  let err = null;
  try { await dfu.flash(new Uint8Array(2048)); } catch (e) { err = e; }
  t("an immediate reset is reported as a refusal", /reset immediately/.test(err?.message ?? ""),
    (err?.message ?? "").slice(0, 70));
  t("and it says the erase is not to blame", /not for anything that happens during the erase/
    .test(err?.message ?? ""));
  await link.close();
}

{
  /* Dying part way through means the erase itself starved USB, which is a
   * property of the board and not something a retry fixes. */
  const boot = new FakeBootloader();
  const { link, dfu } = await dfuOver(boot);
  const realPayload = boot.payload.bind(boot);
  boot.payload = (body) => {
    realPayload(body);
    if (u32(body, 0) === OP.START) setTimeout(() => boot.die("stalled in erase"), 1200);
  };

  let err = null;
  /* Big enough that the computed erase wait outlasts the 1.2 s above. */
  try { await dfu.flash(new Uint8Array(120000)); } catch (e) { err = e; }
  t("a mid-erase disappearance is reported with its timing",
    /dropped off USB \d+\.\ds into a \d+\.\ds erase/.test(err?.message ?? ""),
    (err?.message ?? "").slice(0, 64));
  t("and it points at the route that has no such limit", /\.uf2/.test(err?.message ?? ""));
  await link.close();
}

/* --- the 1200-baud touch ------------------------------------------------ */

/* Open at 1200, close. That *is* the whole protocol: there is no reply, and
 * the device is expected to reboot — so the only thing to assert is that the
 * rate on the wire is the one the firmware watches for. The firmware half is
 * updater/src/usb_dfu_touch.c; Zephyr implements nothing of this itself. */
{
  const port = new FakePort(() => {});
  await touchReset(port, { openMs: 5, rebootMs: 5 });
  t("the touch opens the port at 1200 baud", port.opened?.baudRate === TOUCH_BAUD,
    String(port.opened?.baudRate));
  t("and closes it again, which is the signal", port.closed);
  t("the rate matches the one the firmware watches for", TOUCH_BAUD === 1200);
}

/* --- the address the image is written at ------------------------------- */

/*
 * The protocol carries no addresses at all, so these constants are the only
 * thing tying `merged.hex` to where the bootloader puts it. Each must agree
 * with its board's partition table, which is the file MCUboot is linked
 * against.
 *
 * **Two boards, one page apart.** The XIAO nRF52840's bootloader is built
 * against SoftDevice S140 7.3.0 and the RAK4631's against 6.1.1, so they start
 * the application at 0x27000 and 0x26000. Getting them the wrong way round
 * builds, flashes and verifies, and boots nothing.
 */
{
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const { dirname, resolve, join } = await import("node:path");
  const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

  const FRAGMENTS = {
    xiao_ble: "updater/nrf52840_partitions.dtsi",
    rak4631: "updater/rak4631_partitions.dtsi",
  };

  /* Every board with this usb method needs an entry, and vice versa: an entry
   * with no board is dead, and a board with no entry cannot be flashed. */
  t("a fragment is named for every bootloader profile",
    JSON.stringify(Object.keys(FRAGMENTS).sort()) ===
      JSON.stringify(Object.keys(BOOTLOADERS).sort()),
    `${Object.keys(FRAGMENTS)} vs ${Object.keys(BOOTLOADERS)}`);

  for (const [name, rel] of Object.entries(FRAGMENTS)) {
    const dtsi = readFileSync(join(ROOT, rel), "utf8");
    const boot = /boot_partition:\s*partition@([0-9a-f]+)/.exec(dtsi);
    const want = parseInt(boot?.[1] ?? "0", 16);
    t(`${name}: appStart matches where ${rel.split("/").pop()} starts MCUboot`,
      want === BOOTLOADERS[name].appStart,
      `dtsi 0x${boot?.[1]} vs profile 0x${BOOTLOADERS[name].appStart.toString(16)}`);
  }

  /* The two must not be the same number: if a refactor ever collapses them,
   * every assertion above still passes against one fragment read twice. */
  t("the two boards really are a flash page apart",
    BOOTLOADERS.xiao_ble.appStart - BOOTLOADERS.rak4631.appStart === 0x1000,
    `${BOOTLOADERS.xiao_ble.appStart} - ${BOOTLOADERS.rak4631.appStart}`);

  /* And the lookup refuses what it does not know rather than defaulting. */
  t("an unknown board gets no profile", bootloaderFor("some_other_board") === null);
  t("...and a known one does, by name from a full target",
    bootloaderFor("rak4631/nrf52840") === BOOTLOADERS.rak4631);
}

console.log(bad ? `\n${bad} FAILURES` : "\nall nordic-dfu-serial tests passed");
process.exit(bad ? 1 : 0);
