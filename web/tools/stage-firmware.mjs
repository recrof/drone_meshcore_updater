#!/usr/bin/env node
/*
 * Stage a firmware image where the web client's "Flash newest" can find it.
 *
 *   node web/tools/stage-firmware.mjs [hexfile] [--out DIR] [--tag NAME]
 *
 * Defaults: hexfile = updater/build/merged.hex, DIR = web/firmware,
 * tag = "local".
 *
 * Writes DIR/merged.hex and DIR/manifest.json. Both CI and a local checkout
 * call this same script, so the manifest has exactly one producer — the
 * schema used to be inline shell in web.yml, which is precisely the kind of
 * second copy that drifts away from its reader.
 *
 * web/firmware/ is gitignored: the deployed copy comes from a release, and a
 * stale hex committed next to the sources would be flashed by anyone who
 * pressed the button.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, resolve, join, basename } from "node:path";
import { fileURLToPath } from "node:url";

/* The same parsers the browser uses. They are plain ES modules with no DOM
 * dependency, so node can import them directly — which means the version the
 * manifest advertises is read by exactly the code that will later validate
 * the download, rather than by a second implementation that can disagree. */
import { readUpdateImage, parseImageHeader, versionString } from "../js/lib/mcuboot-image.js";
import { parseIntelHex } from "../js/lib/intel-hex.js";

const WEB = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = resolve(WEB, "..");

/* The exact keys FlashDialog.js reads. Exported so a test can hold the two
 * sides together. */
export const MANIFEST_KEYS = [
  "tag", "file", "bytes", "sha256", "published", "version",
  "dfu", "dfuBytes", "dfuSha256", "dfuVersion",
];

/* Slot 0's base address — rram_partitions.dtsi. The application image inside
 * merged.hex starts here, with its MCUboot header first. */
const SLOT0 = 0x10000;

/*
 * Pull the firmware version out of an artifact.
 *
 * Worth doing at staging time rather than in the browser: the client would
 * otherwise have to download the whole image before it could say what version
 * it is, which is precisely the information you want *before* deciding to
 * spend 30 s uploading it.
 */
function versionOfHex(bytes) {
  const chunks = parseIntelHex(new TextDecoder().decode(bytes));
  const chunk = chunks.find(c => c.address <= SLOT0 && c.end > SLOT0);
  if (!chunk) return null;
  const off = SLOT0 - chunk.address;
  return versionString(parseImageHeader(chunk.bytes.subarray(off, off + 32)));
}

/* `file` is the full-chip merged.hex for the USB flasher; `dfu` is the signed
 * application for updating over Bluetooth. Two artifacts for two routes, and
 * confusing them is a real hazard — merged.hex uploaded as an image writes a
 * bootloader into the spare slot and does nothing. The manifest names them
 * separately so the client never has to guess. */
export function buildManifest(bytes, { tag, file, version = null }, dfu = null) {
  const m = {
    tag,
    file,
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    published: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
  };
  if (version) m.version = version;
  if (dfu) {
    m.dfu = dfu.name;
    m.dfuBytes = dfu.bytes.length;
    m.dfuSha256 = createHash("sha256").update(dfu.bytes).digest("hex");
    if (dfu.version) m.dfuVersion = dfu.version;
  }
  return m;
}

function main(argv) {
  let hex = null, out = join(WEB, "firmware"), tag = "local", dfuPath = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--out") out = resolve(argv[++i]);
    else if (argv[i] === "--tag") tag = argv[++i];
    else if (argv[i] === "--dfu") dfuPath = resolve(argv[++i]);
    else hex = resolve(argv[i]);
  }
  hex ??= join(ROOT, "updater", "build", "merged.hex");
  dfuPath ??= join(ROOT, "updater", "build", "dfu_application.zip");

  if (!existsSync(hex)) {
    console.error(`error: ${hex} does not exist.`);
    console.error("Build it first:  ./build.sh   (produces updater/build/merged.hex)");
    process.exit(1);
  }

  const bytes = readFileSync(hex);
  /* Always land as merged.hex regardless of the source name: the release
   * asset is xiao_nrf54_updater-<tag>-merged.hex, and the client should not
   * have to guess a filename. The manifest names it either way. */
  const file = "merged.hex";

  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, file), bytes);

  /* The OTA image is optional: a release may predate MCUboot being enabled,
   * and the USB route still works without it. */
  let dfu = null;
  if (existsSync(dfuPath)) {
    dfu = { name: "dfu_application.zip", bytes: readFileSync(dfuPath) };
    try {
      const img = readUpdateImage(new Uint8Array(dfu.bytes), dfu.name);
      dfu.version = versionString(img.header);
    } catch (e) {
      /* Not fatal — the file still uploads and the device validates it. The
       * client just cannot say what version it is beforehand. */
      console.error(`note: could not read the OTA image version: ${e.message}`);
    }
    writeFileSync(join(out, dfu.name), dfu.bytes);
  } else {
    console.error(`note: ${dfuPath} missing — "Update over Bluetooth" will be unavailable`);
  }

  let version = null;
  try {
    version = versionOfHex(bytes);
  } catch (e) {
    console.error(`note: could not read the image version from ${basename(hex)}: ${e.message}`);
  }

  const manifest = buildManifest(bytes, { tag, file, version }, dfu);
  writeFileSync(join(out, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");

  console.error(`staged ${basename(hex)} -> ${join(out, file)}`);
  console.error(`  tag    ${manifest.tag}`);
  console.error(`  bytes  ${manifest.bytes}`);
  console.error(`  sha256 ${manifest.sha256}`);
  if (manifest.version) console.error(`  version ${manifest.version}`);
  if (dfu) console.error(`  dfu    ${dfu.name} (${manifest.dfuBytes} bytes, v${manifest.dfuVersion ?? "?"})`);
}

/* Importable for tests; runs only when invoked directly. */
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}
