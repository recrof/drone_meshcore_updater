/*
 * Firmware-file inspection: what it is, whether it is intact, and whether the
 * device in front of us can flash it.
 *
 *   node web/test/firmware-image.test.mjs
 *
 * Every fixture is built here, byte by byte, rather than checked in. Two
 * reasons, and the second is the important one:
 *
 *  1. A checked-in 500 KB package is a large binary in a repo that has none.
 *  2. **A fixture built by the code under test proves nothing.** These
 *     archives are assembled with their own header writer and their own CRC,
 *     so a symmetrical mistake — writing and reading the same field wrong —
 *     fails here instead of round-tripping cleanly and failing on a device.
 *
 * The real artifacts under web/firmware/ are used where they exist, because a
 * synthesised file only proves the parser handles what the test author
 * imagined. They are skipped when absent so this runs in a fresh checkout.
 */
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";

const WEB = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = resolve(WEB, "..");

const {
  inspectFirmware, crc32, crc16, walkZip, parseLegacyInitPacket,
  readEspHeader, readAppDesc, transportsFromMask, isFirmwareName,
  KIND, TRANSPORT, TRANSPORT_BIT, ESP_APP_DESC_MAGIC, ESP_APP_DESC_OFFSET,
} = await import("../js/lib/firmware-image.js");

let bad = 0;
const t = (name, cond, extra = "") => {
  console.log(`${cond ? "  ok  " : "  FAIL"} ${name}${cond ? "" : "  [" + extra + "]"}`);
  if (!cond) bad++;
};
const has = (rep, code) => rep.findings.some(f => f.code === code);
const codes = (rep) => rep.findings.map(f => `${f.level}:${f.code}`).join(",");

/* --- check values, so a wrong CRC variant cannot bless itself ----------- */
const enc = (s) => new TextEncoder().encode(s);
t("crc32 matches the IEEE check value", crc32(enc("123456789")) === 0xcbf43926);
t("crc16 matches the CCITT-FALSE check value", crc16(enc("123456789")) === 0x29b1);

/* --- a ZIP writer that is not the ZIP reader ---------------------------- */

function u16(n) { return [n & 0xff, (n >> 8) & 0xff]; }
function u32(n) { return [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]; }

/** @param files [{name, data, method?, crc?, streamed?}] */
function buildZip(files) {
  const out = [];
  for (const f of files) {
    const name = enc(f.name);
    out.push(...u32(0x04034b50), ...u16(20),
      ...u16(f.streamed ? 0x08 : 0), ...u16(f.method ?? 0),
      ...u16(0), ...u16(0),
      ...u32(f.crc ?? crc32(f.data)),
      ...u32(f.data.length), ...u32(f.data.length),
      ...u16(name.length), ...u16(0),
      ...name, ...f.data);
  }
  return Uint8Array.from(out);
}

/** The classic legacy init packet, built to the layout the parser expects. */
function initPacket(image, { deviceType = 0x0052, crcOverride = null } = {}) {
  const out = [...u16(deviceType), ...u16(0xffff), ...u32(0xffffffff), ...u16(1), ...u16(0xfffe)];
  out.push(...u16(crcOverride ?? crc16(image)));
  return Uint8Array.from(out);
}

const IMAGE = Uint8Array.from({ length: 512 }, (_, i) => (i * 7 + 3) & 0xff);

function nordicPackage(over = {}) {
  const image = over.image ?? IMAGE;
  const manifest = over.manifest ?? JSON.stringify({
    manifest: { application: { bin_file: "app.bin", dat_file: "app.dat" } },
  });
  return buildZip([
    { name: "manifest.json", data: enc(manifest) },
    { name: "app.bin", data: image, ...(over.binOpts ?? {}) },
    { name: "app.dat", data: over.dat ?? initPacket(image) },
  ]);
}

/* --- the happy path ------------------------------------------------------ */
{
  const rep = inspectFirmware(nordicPackage(), { name: "rak4631.zip" });
  t("a well-formed legacy package is recognised", rep.kind === KIND.NORDIC_ZIP, rep.kind);
  t("...and is flashable", rep.ok, codes(rep));
  t("...over Bluetooth", rep.transport === TRANSPORT.BLE, String(rep.transport));
  t("...and the init packet is confirmed against the image", has(rep, "dat-bin-match"));
  t("...reporting the image size", rep.details.imageBytes === 512, String(rep.details.imageBytes));
  t("...and the device type it names", rep.details.deviceType === 0x0052);
}

/* --- integrity ----------------------------------------------------------- */
{
  /* A single flipped byte, with the header CRC left alone — which is exactly
   * what a truncated or mangled download looks like. */
  const z = nordicPackage();
  const at = z.length - 12;
  z[at] ^= 0xff;
  const rep = inspectFirmware(z, { name: "rak4631.zip" });
  t("a flipped byte fails the CRC", has(rep, "zip-crc"), codes(rep));
  t("...and the file is refused", !rep.ok);
}
{
  const rep = inspectFirmware(nordicPackage({ binOpts: { method: 8 } }), { name: "x.zip" });
  t("a compressed entry is refused", has(rep, "zip-compressed"), codes(rep));
  t("...because the device's reader is STORE-only", !rep.ok);
}
{
  const rep = inspectFirmware(nordicPackage({ binOpts: { streamed: true } }), { name: "x.zip" });
  t("a streamed entry is refused", has(rep, "zip-streamed"), codes(rep));
}
{
  /* 64 is ZIP_NAME_MAX in firmware_zip.h; the device truncates to 63. */
  const long = "a".repeat(70) + ".bin";
  const z = buildZip([
    { name: "manifest.json", data: enc(JSON.stringify({ manifest: { application: { bin_file: long, dat_file: "a.dat" } } })) },
    { name: long, data: IMAGE },
    { name: "a.dat", data: initPacket(IMAGE) },
  ]);
  const rep = inspectFirmware(z, { name: "x.zip" });
  t("an over-long entry name is refused", has(rep, "zip-name-too-long"), codes(rep));
}
{
  const rep = inspectFirmware(Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]), { name: "x.zip" });
  t("a truncated archive is refused", has(rep, "zip-unreadable"), codes(rep));
}

/* --- the manifest must describe what is actually there ------------------- */
{
  const z = nordicPackage({
    manifest: JSON.stringify({ manifest: { application: { bin_file: "other.bin", dat_file: "app.dat" } } }),
  });
  const rep = inspectFirmware(z, { name: "x.zip" });
  t("a manifest naming an absent file is refused", has(rep, "manifest-missing-file"), codes(rep));
}
{
  const rep = inspectFirmware(nordicPackage({ manifest: "{not json" }), { name: "x.zip" });
  t("an unparsable manifest is refused", has(rep, "manifest-unparsable"), codes(rep));
}
{
  const z = buildZip([{ name: "app.bin", data: IMAGE }]);
  const rep = inspectFirmware(z, { name: "x.zip" });
  t("an archive with no manifest is refused", has(rep, "zip-no-manifest"), codes(rep));
}

/* --- the check nothing else makes: does the .dat match the .bin? --------
 *
 * Every other check here passes on a package whose init packet came from a
 * different build than its image — the archive is intact, the manifest is
 * consistent, both files are present. The target discovers it after receiving
 * the entire image, and Trap 2 says there is no resume, so the whole transfer
 * is spent to learn it. */
{
  const z = nordicPackage({ dat: initPacket(IMAGE, { crcOverride: 0x1234 }) });
  const rep = inspectFirmware(z, { name: "x.zip" });
  t("a .dat from another build is caught before the upload",
    has(rep, "dat-bin-mismatch"), codes(rep));
  t("...and refused", !rep.ok);
}
{
  /* An extended init packet carries a hash and has a different length. Not
   * something we can check — and saying so is not the same as failing. */
  const z = nordicPackage({ dat: Uint8Array.from({ length: 40 }, (_, i) => i) });
  const rep = inspectFirmware(z, { name: "x.zip" });
  t("an init packet we cannot verify is not an error", rep.ok, codes(rep));
  t("...but says so", has(rep, "dat-unverified"));
}

/* --- this project's own bundle, which shares the extension --------------- */
{
  const z = buildZip([{
    name: "manifest.json",
    data: enc(JSON.stringify({
      "format-version": 1,
      files: [{ file: "zephyr.signed.bin", type: "application", board: "xiao_ble/nrf52840", size: 12 }],
    })),
  }, { name: "zephyr.signed.bin", data: IMAGE }]);
  const rep = inspectFirmware(z, { name: "dfu_application.zip" });
  t("an NCS/MCUboot package is told apart from a legacy one",
    rep.kind === KIND.NCS_ZIP, rep.kind);
  t("...and refused as target firmware", !rep.ok);
  t("...naming the board it is actually for",
    rep.details.boards.includes("xiao_ble/nrf52840"), JSON.stringify(rep.details.boards));
}

/* --- ESP32 images -------------------------------------------------------- */

function espImage({ chipId = 0x0009, desc = true, project = "MeshCore", version = "1.2.3" } = {}) {
  const b = new Uint8Array(0x400);
  b[0] = 0xe9; b[1] = 1;
  new DataView(b.buffer).setUint16(12, chipId, true);
  if (desc) {
    const at = ESP_APP_DESC_OFFSET;
    new DataView(b.buffer).setUint32(at, ESP_APP_DESC_MAGIC, true);
    b.set(enc(version), at + 16);
    b.set(enc(project), at + 48);
    b.set(enc("v5.1.2"), at + 112);
  }
  return b;
}

{
  const rep = inspectFirmware(espImage(), { name: "firmware.bin" });
  t("a bare application image is recognised", rep.kind === KIND.ESP_APP, rep.kind);
  t("...as ElegantOTA's transport", rep.transport === TRANSPORT.WIFI);
  t("...naming the chip", rep.details.chip === "ESP32-S3", String(rep.details.chip));
  t("...the project", rep.details.project === "MeshCore", rep.details.project);
  t("...and the version", rep.details.version === "1.2.3", rep.details.version);
}
{
  /* The whole point of the .bin work: a merged image is the file that looks
   * right and is not. ElegantOTA accepts it and writes a bootloader into an
   * OTA slot. */
  const merged = new Uint8Array(0x10000 + 0x400);
  merged.set(espImage({ desc: false }), 0);          /* bootloader at 0 */
  merged.set(espImage({ project: "MeshCore" }), 0x10000);
  const rep = inspectFirmware(merged, { name: "firmware.bin" });
  t("a merged image is told apart from an application", rep.kind === KIND.ESP_MERGED, rep.kind);
  t("...and refused", !rep.ok, codes(rep));
  t("...saying where the application actually starts",
    rep.details.appOffset === 0x10000, String(rep.details.appOffset));
  t("...and what it is, so the right file can be found",
    rep.details.project === "MeshCore", String(rep.details.project));
  t("the message says why ElegantOTA cannot take it",
    /OTA slot/.test(rep.findings.find(f => f.code === "esp-merged").message));
}
{
  const rep = inspectFirmware(espImage({ desc: false }), { name: "bootloader.bin" });
  t("a bootloader on its own is refused", has(rep, "esp-no-app"), codes(rep));
}
{
  const rep = inspectFirmware(espImage({ chipId: 0x00ff }), { name: "x.bin" });
  t("an unrecognised chip id warns rather than fails", rep.ok, codes(rep));
  t("...and says which id it saw", has(rep, "unknown-chip"));
}
{
  const rep = inspectFirmware(Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]), { name: "x.bin" });
  t("something that is neither is refused", rep.kind === KIND.UNKNOWN && !rep.ok, codes(rep));
}

/* --- a name that disagrees with the content ----------------------------- */
{
  const rep = inspectFirmware(nordicPackage(), { name: "firmware.bin" });
  t("content wins over the extension", rep.kind === KIND.NORDIC_ZIP, rep.kind);
  t("...but the disagreement is reported", has(rep, "extension-mismatch"));
  t("...as a warning, not a failure", rep.ok, codes(rep));
}

/* --- can THIS device flash it? ------------------------------------------
 *
 * The transports come from the device (`fsxCaps`), not from a table here.
 * This module used to carry one mirroring dfu_transport.c, kept honest by a
 * test; asking removed the copy, and a fact that exists once cannot drift.
 * What is left to test is the decoding and the three cases that follow. */
{
  const bleOnly = transportsFromMask(TRANSPORT_BIT[TRANSPORT.BLE]);
  const both = transportsFromMask(TRANSPORT_BIT[TRANSPORT.BLE] | TRANSPORT_BIT[TRANSPORT.WIFI]);

  t("a BLE-only mask decodes to Bluetooth alone",
    JSON.stringify(bleOnly) === JSON.stringify([TRANSPORT.BLE]), bleOnly.join(","));
  t("a both-transports mask decodes to both", both.length === 2, both.join(","));
  /* Firmware too old to answer. Every build ever shipped has had BLE, so
   * assuming it warns on an ESP32 image rather than falsely reassuring. */
  t("no answer falls back to Bluetooth",
    JSON.stringify(transportsFromMask(null)) === JSON.stringify([TRANSPORT.BLE]));
  t("a zero mask claims nothing", transportsFromMask(0).length === 0);

  t("a legacy package is flashable on a Bluetooth updater",
    inspectFirmware(nordicPackage(), { transports: bleOnly }).ok);

  const espOnBle = inspectFirmware(espImage(), { transports: bleOnly });
  t("an ESP32 image is refused on a Bluetooth-only updater",
    has(espOnBle, "transport-unavailable"), codes(espOnBle));
  t("...and the reason is the transport, not the file",
    /WiFi/.test(espOnBle.findings.find(f => f.code === "transport-unavailable").message));

  t("...and accepted once the updater reports WiFi",
    inspectFirmware(espImage(), { transports: both }).ok,
    codes(inspectFirmware(espImage(), { transports: both })));

  /* A damaged file stays refused whatever the device can do — the two
   * questions are independent, and conflating them would let a good
   * transport excuse a bad image. */
  t("a transport that exists does not excuse a broken file",
    !inspectFirmware(nordicPackage({ dat: initPacket(IMAGE, { crcOverride: 1 }) }),
      { transports: both }).ok);

  t("without an answer from the device, no compatibility claim is made",
    !has(inspectFirmware(espImage(), {}), "transport-unavailable"));
}

/* --- only firmware files get an opinion --------------------------------- */
t("config.txt is not a firmware file", !isFirmwareName("config.txt"));
t("LOG.0000 is not a firmware file", !isFirmwareName("LOG.0000"));
t(".zip is", isFirmwareName("rak.zip"));
t(".bin is", isFirmwareName("firmware.bin"));
t("case does not matter", isFirmwareName("RAK.ZIP"));

/* --- against the real artifacts, where the tree has them ---------------- */
{
  const ncs = join(ROOT, "web/firmware/xiao_nrf54lm20a_nrf54lm20a_cpuapp/dfu_application.zip");
  if (existsSync(ncs)) {
    const rep = inspectFirmware(new Uint8Array(readFileSync(ncs)), { name: "dfu_application.zip" });
    t("a real NCS package is recognised as one", rep.kind === KIND.NCS_ZIP, rep.kind + " " + codes(rep));
    t("...and refused as target firmware", !rep.ok);
  } else {
    console.log("  skip  no staged dfu_application.zip to check against");
  }

  const boot = join(ROOT, "web/firmware/xiao_esp32s3_esp32s3_procpu/mcuboot.bin");
  if (existsSync(boot)) {
    const rep = inspectFirmware(new Uint8Array(readFileSync(boot)), { name: "mcuboot.bin" });
    t("a real ESP32 bootloader is not mistaken for an application",
      rep.kind !== KIND.ESP_APP && !rep.ok, rep.kind + " " + codes(rep));
    t("...and its chip is read off the header",
      rep.details.chip === "ESP32-S3", String(rep.details.chip));
  } else {
    console.log("  skip  no staged mcuboot.bin to check against");
  }
}

/* The transport table that used to be cross-checked here is gone: the device
 * answers for itself over FSX_MGMT_ID_CAPS, so there is no second copy left to
 * hold down. dfu-inspect.test.mjs checks the enums that cross that wire. */

console.log(bad ? `\n${bad} FAILURES` : "\nall firmware-image tests passed");
process.exit(bad ? 1 : 0);
