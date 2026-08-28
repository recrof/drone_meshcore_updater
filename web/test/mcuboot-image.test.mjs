/*
 * MCUboot image headers and the DFU zip. Dependency-free:
 *
 *   node web/test/mcuboot-image.test.mjs
 *
 * Cross-checks against real build artifacts when they exist, because the
 * header layout is the kind of thing that is easy to write plausibly and get
 * subtly wrong — and the consequence is uploading a wrong-but-accepted image
 * over a multi-minute BLE transfer.
 */
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import {
  IMAGE_MAGIC, parseImageHeader, versionString, readZipEntries, readUpdateImage,
  normalizeVersion, sameVersion,
} from "../js/lib/mcuboot-image.js";
import { describeSmpError } from "../js/lib/smp-client.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const BUILD = join(ROOT, "updater", "build");

let bad = 0;
const t = (name, cond, extra = "") => {
  console.log(`${cond ? "  ok  " : "  FAIL"} ${name}${extra ? `  [${extra}]` : ""}`);
  if (!cond) bad++;
};
const throws = (name, fn, re) => {
  try { fn(); t(name, false, "did not throw"); }
  catch (e) { t(name, re.test(e.message), e.message.slice(0, 90)); }
};

/* --- header ------------------------------------------------------------- */
function header({ magic = IMAGE_MAGIC, load = 0x10000, hdr = 512, img = 1024,
                  flags = 0, ver = [1, 2, 3, 4] } = {}) {
  const b = new Uint8Array(32);
  const v = new DataView(b.buffer);
  v.setUint32(0, magic, true);
  v.setUint32(4, load, true);
  v.setUint16(8, hdr, true);
  v.setUint16(10, 0, true);
  v.setUint32(12, img, true);
  v.setUint32(16, flags, true);
  v.setUint8(20, ver[0]); v.setUint8(21, ver[1]);
  v.setUint16(22, ver[2], true); v.setUint32(24, ver[3], true);
  return b;
}

{
  const h = parseImageHeader(header());
  t("magic accepted", h.magic === IMAGE_MAGIC);
  t("load address parsed", h.loadAddr === 0x10000, "0x" + h.loadAddr.toString(16));
  t("header size parsed", h.hdrSize === 512);
  t("image size parsed", h.imgSize === 1024);
  t("version parsed", versionString(h) === "1.2.3+4", versionString(h));
  t("build 0 is omitted from the version",
    versionString(parseImageHeader(header({ ver: [1, 0, 0, 0] }))) === "1.0.0");
}

/* The whole point of the check: the two artifacts this project publishes are
 * both "the firmware", and only one is an image. */
throws("a non-image is refused", () => parseImageHeader(new Uint8Array(32)), /not an MCUboot image/);
throws("the error names the right files to use",
  () => parseImageHeader(new Uint8Array(32)), /dfu_application\.zip|zephyr\.signed\.bin/);
throws("a short buffer is refused", () => parseImageHeader(new Uint8Array(8)), /too short/);
throws("a byte-swapped magic is refused",
  () => parseImageHeader(header({ magic: 0x3db8f396 })), /not an MCUboot image/);

/* --- zip ---------------------------------------------------------------- */
function storedZip(files) {
  const parts = [];
  for (const [name, data] of files) {
    const nameB = new TextEncoder().encode(name);
    const h = new Uint8Array(30 + nameB.length);
    const v = new DataView(h.buffer);
    v.setUint32(0, 0x04034b50, true);
    v.setUint16(8, 0, true);                 // method = STORED
    v.setUint32(18, data.length, true);
    v.setUint32(22, data.length, true);
    v.setUint16(26, nameB.length, true);
    v.setUint16(28, 0, true);
    h.set(nameB, 30);
    parts.push(h, data);
  }
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

{
  const img = new Uint8Array(64); img.set(header());
  const zip = storedZip([["app.signed.bin", img], ["manifest.json", new TextEncoder().encode("{}")]]);
  const entries = readZipEntries(zip);
  t("reads both entries", entries.length === 2, entries.map(e => e.name).join(", "));
  t("entry names decoded", entries[0].name === "app.signed.bin");
  t("entry payload sliced", entries[0].bytes.length === 64);

  const r = readUpdateImage(zip, "dfu_application.zip");
  t("picks the .bin out of the archive", r.bytes.length === 64);
  t("source names both files", /dfu_application\.zip → app\.signed\.bin/.test(r.source), r.source);
}
{
  const zip = storedZip([["manifest.json", new TextEncoder().encode("{}")]]);
  throws("an archive with no .bin is refused", () => readUpdateImage(zip, "x.zip"), /no \.bin/);
}
{
  /* A compressed member must fail loudly, not silently hand back deflate
   * bytes that would then fail the header check for the wrong reason. */
  const z = storedZip([["a.bin", new Uint8Array(8)]]);
  new DataView(z.buffer).setUint16(8, 8, true);   // method = DEFLATE
  throws("a compressed entry is refused", () => readZipEntries(z), /compressed/);
}
{
  const z = storedZip([["a.bin", new Uint8Array(8)]]);
  throws("a truncated archive is refused",
    () => readZipEntries(z.subarray(0, z.length - 4)), /past the end|truncated/);
}

/* --- against real build artifacts ---------------------------------------- */
const zipPath = join(BUILD, "dfu_application.zip");
const binPath = join(BUILD, "updater", "zephyr", "zephyr.signed.bin");
if (!existsSync(zipPath) || !existsSync(binPath)) {
  console.log("  skip  no build artifacts (./build.sh)");
} else {
  const fromZip = readUpdateImage(new Uint8Array(readFileSync(zipPath)), "dfu_application.zip");
  const fromBin = readUpdateImage(new Uint8Array(readFileSync(binPath)), "zephyr.signed.bin");
  t("real dfu_application.zip parses", fromZip.bytes.length > 0);
  t("real zephyr.signed.bin parses", fromBin.bytes.length > 0);
  t("the zip contains exactly that binary",
    fromZip.bytes.length === fromBin.bytes.length,
    `${fromZip.bytes.length} vs ${fromBin.bytes.length}`);
  /* rram_partitions.dtsi puts slot0 at 0x10000; an image built for a
   * different layout would be accepted by the device and then not boot. */
  t("image is linked for slot0 (0x10000)",
    fromZip.header.loadAddr === 0x10000, "0x" + fromZip.header.loadAddr.toString(16));

  const merged = join(BUILD, "merged.hex");
  if (existsSync(merged)) {
    throws("merged.hex is refused as an OTA image",
      () => readUpdateImage(new Uint8Array(readFileSync(merged)), "merged.hex"),
      /not an MCUboot image/);
  }
}

/* --- version spellings ---------------------------------------------------
 *
 * The device and imgtool disagree about the separator, and the whole point of
 * comparing versions is to catch the identical-image upload before it costs a
 * 30 s transfer. A false "different" wastes that; a false "same" blocks a real
 * update. Both directions matter.
 *
 *   img_mgmt_util.c:  "%hu.%hu.%hu" then ".%u" when iv_build_num != 0
 *   imgtool / this file:  "major.minor.revision+build"
 */
t("device spelling normalises", normalizeVersion("1.0.0.1") === "1.0.0+1", normalizeVersion("1.0.0.1"));
t("imgtool spelling normalises", normalizeVersion("1.0.0+1") === "1.0.0+1");
t("a zero build is dropped, both ways",
  normalizeVersion("1.0.0.0") === "1.0.0" && normalizeVersion("1.0.0+0") === "1.0.0");
t("no build number is left alone", normalizeVersion("1.0.0") === "1.0.0");
t("multi-digit fields survive", normalizeVersion("2.10.3.45") === "2.10.3+45");
t("leading zeros are canonicalised", normalizeVersion("01.02.03") === "1.2.3");
t("garbage passes through unchanged", normalizeVersion("not-a-version") === "not-a-version");
t("empty is empty", normalizeVersion(null) === "" && normalizeVersion(undefined) === "");

t("device and manifest spellings compare equal", sameVersion("1.0.0.1", "1.0.0+1"));
t("a zero build matches an absent one", sameVersion("1.0.0", "1.0.0+0"));
t("genuinely different versions differ", !sameVersion("1.0.0", "1.0.1"));
t("different build numbers differ", !sameVersion("1.0.0+1", "1.0.0+2"));
/* An unknown version must never read as "same as running" — that would
 * disable the update button for no reason. */
t("empty never matches", !sameVersion("", "1.0.0") && !sameVersion(null, null));

/* --- img_mgmt error table ------------------------------------------------
 *
 * The client's table is indexed by enum value, so a single inserted entry in
 * Zephyr silently shifts every message after it — you would get a confident,
 * wrong explanation, which is worse than "rc=1". Read the enum back out of
 * the header and check the order.
 */
{
  const hdr = join(ROOT, "zephyr", "include", "zephyr", "mgmt", "mcumgr",
                   "grp", "img_mgmt", "img_mgmt.h");
  if (!existsSync(hdr)) {
    console.log("  skip  Zephyr tree not present (west update)");
  } else {
    const src = readFileSync(hdr, "utf8");
    const block = src.slice(src.indexOf("enum img_mgmt_err_code_t"));
    const names = block.slice(0, block.indexOf("};"))
      .match(/IMG_MGMT_ERR_[A-Z_0-9]+/g) ?? [];
    t("read the enum from the header", names.length > 30, String(names.length));

    /* Spot-check the values this client reasons about by name, so a shift
     * shows up as a mismatch rather than a plausible wrong string. */
    const at = (name) => names.indexOf(name);
    const text = (i) => describeSmpError(1, 0, { rc: 1, err: { group: 1, rc: i } });

    t("HASH_NOT_FOUND maps to a hash message",
      /hash/.test(text(at("IMG_MGMT_ERR_HASH_NOT_FOUND"))),
      text(at("IMG_MGMT_ERR_HASH_NOT_FOUND")));
    t("NO_IMAGE maps to an empty-slot message",
      /no image/.test(text(at("IMG_MGMT_ERR_NO_IMAGE"))));
    t("IMAGE_ALREADY_PENDING maps to a pending message",
      /pending/.test(text(at("IMG_MGMT_ERR_IMAGE_ALREADY_PENDING"))));
    /* The one that actually bit: uploading the image already running. */
    t("SETTING_TEST_TO_ACTIVE_DENIED explains the identical-image case",
      /identical to the one already running/.test(
        text(at("IMG_MGMT_ERR_IMAGE_SETTING_TEST_TO_ACTIVE_DENIED"))),
      text(at("IMG_MGMT_ERR_IMAGE_SETTING_TEST_TO_ACTIVE_DENIED")).slice(0, 70));
    t("CONFIRMATION_DENIED maps to a confirmation message",
      /confirmation/.test(text(at("IMG_MGMT_ERR_IMAGE_CONFIRMATION_DENIED"))));
    t("INVALID_IMAGE_HEADER_MAGIC mentions signing",
      /signed image/.test(text(at("IMG_MGMT_ERR_INVALID_IMAGE_HEADER_MAGIC"))));
  }
}

console.log(bad ? `\n${bad} FAILURES` : "\nall mcuboot-image tests passed");
process.exit(bad ? 1 : 0);
