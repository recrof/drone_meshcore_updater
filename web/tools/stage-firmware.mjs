#!/usr/bin/env node
/*
 * Stage firmware artifacts where the web client's flashers can find them.
 *
 *   node web/tools/stage-firmware.mjs --board TARGET [--out DIR] [--tag NAME]
 *                                     [--hex FILE] [--uf2 FILE] [--dfu FILE]
 *                                     [--part FILE@OFFSET]...
 *
 * Defaults: DIR = web/firmware, tag = "local", and --hex/--uf2/--dfu fall back
 * to the conventional names inside the board's build directory.
 *
 * ---------------------------------------------------------------------------
 * Multi-board, and why the shape is what it is.
 *
 * Each board owns a *subdirectory* and one *entry* in a shared manifest.json.
 * Staging a board rewrites only its own entry and leaves every other board's
 * alone, so building one board never invalidates another's staged artifacts —
 * which is what `build.sh` used to avoid by refusing to stage anything but the
 * default board at all.
 *
 * The subdirectory is not decoration: all three boards produce a file called
 * merged.hex and a file called dfu_application.zip. Staged flat, the second
 * board silently overwrites the first and the manifest still describes both.
 * That is the same failure the "every build restages" rule in CLAUDE.md exists
 * to prevent, one level up.
 *
 * Both CI and a local checkout call this same script, so the manifest has
 * exactly one producer — the schema used to be inline shell in web.yml, which
 * is precisely the kind of second copy that drifts away from its reader.
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
import { readUpdateImage, parseImageHeader, versionString, IMAGE_MAGIC }
  from "../js/lib/mcuboot-image.js";
import { parseIntelHex } from "../js/lib/intel-hex.js";

const WEB = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = resolve(WEB, "..");

/* The manifest schema version. Bumped when an entry's shape changes in a way
 * a client cannot read past; the client refuses a format it does not know
 * rather than guessing at half-understood fields. */
export const FORMAT = 2;

/*
 * How each board is written over USB.
 *
 * This is the one board fact that genuinely cannot be derived from the build.
 * Everything else `build.sh` needs it reads out of the image's own .config —
 * whether the board wants UF2, which family ID — but "is there a debug probe
 * on the other end of this USB cable" is a property of the *carrier board*,
 * and Zephyr does not model it. The nRF54L XIAO's SAMD11 running CMSIS-DAP is
 * a fact about the dev board, not about the nRF54L.
 *
 * So it is a table, and `stage-firmware.test.mjs` fails if a board this repo
 * can build is missing from it — the drift is detected rather than documented.
 *
 * The client dispatches on this string, which is why it goes in the manifest
 * rather than living in the UI: which board it is belongs on the wire as data
 * (see the board-identity section of notes/transports.md).
 */
export const USB_METHODS = {
  /* SWD through the carrier board's SAMD11, which enumerates as CMSIS-DAP.
   * The only board here that can be flashed with no bootloader present, and
   * therefore the only recovery path from a bad image. */
  xiao_nrf54lm20a: "cmsis-dap",

  /* The Adafruit nRF52 bootloader. Takes a .uf2 by drag-and-drop onto the
   * mass-storage device it exposes after a double-tap of reset, and speaks
   * Nordic Legacy DFU over its CDC port after a 1200-baud touch. */
  xiao_ble: "nordic-serial-dfu",

  /* The Espressif ROM loader over USB-Serial-JTAG. Note neither of these has
   * a single-file artifact at all — see `parts` below. */
  xiao_esp32s3: "esptool",
  xiao_esp32c5: "esptool",
};

/*
 * Boards with no single-file image: which images go where.
 *
 * The Espressif build produces two separate binaries that are flashed at two
 * separate offsets, and **those offsets are the partition table**. They are
 * written here because the staging step in CI works from release assets and
 * has no build directory to read a devicetree out of — but a copy of a number
 * that lives somewhere else is exactly the thing this repo makes a test hold
 * down, so `stage-firmware.test.mjs` parses `dtsi` below and fails if the two
 * disagree.
 *
 * Getting this wrong is silent and expensive. `SPI_FLASH_MD5` verifies what
 * was written *at the offset it was written to*, so a stale offset here
 * flashes clean, reads back clean, and produces a board that does not boot —
 * with the bootloader's own console gone (Trap 6), there is nothing to see.
 *
 *   name       what it is called once staged. Both images are `zephyr*.bin`
 *              inside their own build subdirectory and would collide in one
 *              staging directory.
 *   from       where the local build leaves it, relative to the build dir.
 *   offset     flash offset, and must equal `partition`'s address in `dtsi`.
 */
export const PART_LAYOUT = {
  xiao_esp32s3: {
    dtsi: "updater/esp32s3_partitions.dtsi",
    parts: [
      { name: "mcuboot.bin", from: ["mcuboot", "zephyr", "zephyr.bin"],
        offset: 0x0, partition: "boot_partition" },
      { name: "app.signed.bin", from: ["updater", "zephyr", "zephyr.signed.bin"],
        offset: 0x20000, partition: "slot0_partition" },
    ],
  },

  /*
   * **The C5's bootloader is at 0x2000, not 0x0.** Its ROM reserves the first
   * two flash sectors for the Key Manager, so the second-stage bootloader is
   * loaded from 0x2000 — the one number that differs between the two Espressif
   * boards, whose tables are otherwise identical from slot0 onwards.
   *
   * This is the single most copy-and-paste-hazardous line in this file, and it
   * is why `partition` is carried next to `offset` rather than the offset
   * standing alone: the test resolves the label in `dtsi` and compares, so
   * pasting the S3's 0x0 here fails immediately instead of at the point where
   * someone's board stops booting with its console already off.
   */
  xiao_esp32c5: {
    dtsi: "updater/esp32c5_partitions.dtsi",
    parts: [
      { name: "mcuboot.bin", from: ["mcuboot", "zephyr", "zephyr.bin"],
        offset: 0x2000, partition: "boot_partition" },
      { name: "app.signed.bin", from: ["updater", "zephyr", "zephyr.signed.bin"],
        offset: 0x20000, partition: "slot0_partition" },
    ],
  },
};

/** Staged name for a build artifact, e.g. "zephyr.signed.bin" ->
 *  "app.signed.bin". Derived from PART_LAYOUT so the rename and the layout
 *  cannot describe different files. */
export const STAGED_PART_NAME = Object.fromEntries(
  Object.values(PART_LAYOUT).flatMap(b =>
    b.parts.map(p => [p.from[p.from.length - 1], p.name])));

/** The board *name* out of a full target: "xiao_ble/nrf52840" -> "xiao_ble". */
export const boardName = (target) => String(target).split("/")[0];

/** Where a board's artifacts live under the staging directory.
 *  Underscores, matching the `build_<target>` convention in build.sh. */
export const boardDir = (target) => String(target).replace(/\//g, "_");

/** Which USB flasher can write this board, or null if we have no table entry. */
export function usbMethod(target) {
  return USB_METHODS[boardName(target)] ?? null;
}

/* The exact keys a client reads out of one board entry. Exported so a test can
 * hold the two sides together. */
export const ENTRY_KEYS = [
  /* `board` is the Zephyr board target this was built for, e.g.
   * "xiao_ble/nrf52840". The client compares it against what the device
   * reports over os_mgmt before sending an update: MCUboot validates a
   * signature and not an architecture, and every board here signs with the
   * same key, so an image for the wrong part verifies, swaps in and then does
   * not boot. With one entry per board the client can now *select* the right
   * image instead of only refusing the wrong one. */
  "board",
  /* Which USB flasher applies, and the subdirectory the files are in. */
  "usb", "dir",
  "tag", "published",
  /* The single-file USB artifact (merged.hex). Absent on Espressif, where a
   * flat address->byte merge is meaningless — that board uses `parts`. */
  "file", "bytes", "sha256", "version",
  /* The signed application, for updating over Bluetooth. Every board has one. */
  "dfu", "dfuBytes", "dfuSha256", "dfuVersion",
  /* The drag-and-drop artifact, where the bootloader takes one. */
  "uf2", "uf2Bytes", "uf2Sha256",
  /* Espressif: [{ file, offset, bytes, sha256 }], each written at its own
   * flash offset. There is no merged image to fall back on. */
  "parts",
];

/* Top-level keys. Deliberately tiny: everything that varies per board belongs
 * in the entry, so there is no second place for a board fact to disagree. */
export const INDEX_KEYS = ["format", "published", "boards"];

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
const nowZ = () => new Date().toISOString().replace(/\.\d+Z$/, "Z");

/*
 * Pull the firmware version out of a merged hex.
 *
 * Worth doing at staging time rather than in the browser: the client would
 * otherwise have to download the whole image before it could say what version
 * it is, which is precisely the information you want *before* deciding to
 * spend 30 s uploading it.
 *
 * Slot 0 is found by looking for MCUboot's header magic rather than by
 * hard-coding an address. It used to be a constant 0x10000, which is the
 * nRF54L's slot0 and nobody else's — the nRF52840 links its at 0x33000, so
 * the constant did not merely fail there, it read 32 bytes of *bootloader* and
 * reported whatever version that happened to look like.
 */
export function versionOfHex(bytes) {
  const chunks = parseIntelHex(new TextDecoder().decode(bytes));
  for (const c of chunks.slice().sort((a, b) => a.address - b.address)) {
    /* The application chunk starts exactly at slot0, with its header first. */
    if (c.bytes.length < 32) continue;
    const v = new DataView(c.bytes.buffer, c.bytes.byteOffset, 4);
    if (v.getUint32(0, true) !== IMAGE_MAGIC) continue;
    return versionString(parseImageHeader(c.bytes.subarray(0, 32)));
  }
  return null;
}

/*
 * Build one board's entry.
 *
 * `hex`, `uf2`, `dfu` and `parts` are each optional, because which of them
 * exists is a property of the board: Espressif produces no merged.hex, only
 * the nRF52840 produces a .uf2, and a release predating MCUboot has no OTA
 * zip at all.
 */
export function buildEntry({ board, tag, hex = null, uf2 = null, dfu = null, parts = null }) {
  const e = {
    board,
    usb: usbMethod(board),
    dir: boardDir(board),
    tag,
    published: nowZ(),
  };
  if (hex) {
    e.file = hex.name;
    e.bytes = hex.bytes.length;
    e.sha256 = sha256(hex.bytes);
    if (hex.version) e.version = hex.version;
  }
  if (dfu) {
    e.dfu = dfu.name;
    e.dfuBytes = dfu.bytes.length;
    e.dfuSha256 = sha256(dfu.bytes);
    if (dfu.version) e.dfuVersion = dfu.version;
  }
  if (uf2) {
    e.uf2 = uf2.name;
    e.uf2Bytes = uf2.bytes.length;
    e.uf2Sha256 = sha256(uf2.bytes);
  }
  if (parts?.length) {
    e.parts = parts.map(p => ({
      file: p.name, offset: p.offset, bytes: p.bytes.length, sha256: sha256(p.bytes),
    }));
  }
  return e;
}

/*
 * Read an existing index, tolerating the flat single-board manifest this tool
 * used to write. A v1 file names its artifacts at the top level with no board
 * subdirectory, so it cannot be merged with a v2 entry — it is dropped, with
 * a note, rather than half-converted into an entry whose `dir` is a lie.
 */
export function readIndex(path) {
  if (!existsSync(path)) return { format: FORMAT, published: nowZ(), boards: [] };
  let m;
  try {
    m = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    console.error(`note: ${path} is not readable JSON — starting a fresh manifest`);
    return { format: FORMAT, published: nowZ(), boards: [] };
  }
  if (!Array.isArray(m.boards)) {
    console.error("note: replacing a pre-multi-board manifest.json " +
                  "(its artifacts were staged flat, with no board subdirectory)");
    return { format: FORMAT, published: nowZ(), boards: [] };
  }
  return { format: FORMAT, published: m.published ?? nowZ(), boards: m.boards };
}

/** Replace this board's entry, keeping every other board's. Sorted so the file
 *  does not churn on rewrite. */
export function mergeIndex(index, entry) {
  const boards = index.boards.filter(b => b.board !== entry.board).concat([entry]);
  boards.sort((a, b) => String(a.board).localeCompare(String(b.board)));
  return { format: FORMAT, published: nowZ(), boards };
}

function readIfPresent(path) {
  return path && existsSync(path) ? readFileSync(path) : null;
}

function main(argv) {
  let board = null, out = join(WEB, "firmware"), tag = "local";
  let hexPath = null, uf2Path = null, dfuPath = null, buildDir = null;
  const partArgs = [];
  let emitParts = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--out") out = resolve(argv[++i]);
    else if (a === "--board") board = argv[++i];
    else if (a === "--tag") tag = argv[++i];
    else if (a === "--hex") hexPath = resolve(argv[++i]);
    else if (a === "--uf2") uf2Path = resolve(argv[++i]);
    else if (a === "--dfu") dfuPath = resolve(argv[++i]);
    else if (a === "--build-dir") buildDir = resolve(argv[++i]);
    else if (a === "--part") partArgs.push(argv[++i]);
    else if (a === "--emit-parts") emitParts = true;
    else if (!hexPath) hexPath = resolve(a);   /* positional hex, as before */
    else { console.error(`error: unexpected argument ${a}`); process.exit(1); }
  }

  if (!board) {
    console.error("error: --board is required (e.g. --board xiao_ble/nrf52840).");
    console.error("It is what stops the client offering an image to a device it would brick.");
    process.exit(1);
  }
  if (!usbMethod(board)) {
    console.error(`error: no USB flashing method known for board '${boardName(board)}'.`);
    console.error(`Add it to USB_METHODS in ${basename(fileURLToPath(import.meta.url))}.`);
    process.exit(1);
  }

  /* `--emit-parts` prints this board's parts layout and exits, one TSV row
   * per image:
   *
   *     mcuboot/zephyr/zephyr.bin<TAB>mcuboot.bin<TAB>0x0
   *
   * It exists so the release workflow can publish a parts board without
   * writing any offset down. CI stages from release assets and has no build
   * tree to read a devicetree out of, so the offsets have to travel — and the
   * alternative, a copy of them in the YAML, is a third place to forget.
   * Nothing is printed for a board with a single-file image, which is how the
   * caller tells the two kinds apart.
   */
  if (emitParts) {
    for (const part of PART_LAYOUT[boardName(board)]?.parts ?? []) {
      process.stdout.write(`${part.from.join("/")}\t${part.name}\t0x${part.offset.toString(16)}\n`);
    }
    return;
  }

  /* Conventional artifact names inside the build directory, so the caller only
   * has to say which board it built. */
  if (buildDir) {
    hexPath ??= join(buildDir, "merged.hex");
    uf2Path ??= join(buildDir, "merged.uf2");
    dfuPath ??= join(buildDir, "dfu_application.zip");
    const layout = PART_LAYOUT[boardName(board)];
    if (!partArgs.length && layout) {
      for (const part of layout.parts) {
        partArgs.push(`${join(buildDir, ...part.from)}@${part.offset}`);
      }
    }
  }

  const dir = join(out, boardDir(board));
  mkdirSync(dir, { recursive: true });

  /* --- the merged image, for a probe-based flasher --------------------- */
  let hex = null;
  const hexBytes = readIfPresent(hexPath);
  if (hexBytes) {
    /* Always land as merged.hex regardless of the source name: the release
     * asset is drone_meshcore_updater-<tag>-<board>-merged.hex, and the client
     * should not have to guess a filename. The manifest names it either way. */
    hex = { name: "merged.hex", bytes: hexBytes };
    try {
      hex.version = versionOfHex(hexBytes);
    } catch (e) {
      console.error(`note: could not read the image version from ${basename(hexPath)}: ${e.message}`);
    }
    writeFileSync(join(dir, hex.name), hexBytes);
  } else if (!PART_LAYOUT[boardName(board)]) {
    /* Asked of PART_LAYOUT rather than naming a board: "has no single-file
     * image" is exactly what having a `parts` entry means, so a second
     * Espressif board must not have to be remembered here as well. It was
     * `!== "xiao_esp32s3"`, which would have warned about a missing merged.hex
     * on the C5 — a file that board never produces. */
    console.error(`note: ${hexPath} missing — "Flash newest" over USB will be unavailable`);
  }

  /* --- the OTA image, for the Bluetooth route -------------------------- */
  let dfu = null;
  const dfuBytes = readIfPresent(dfuPath);
  if (dfuBytes) {
    dfu = { name: "dfu_application.zip", bytes: dfuBytes };
    try {
      dfu.version = versionString(readUpdateImage(new Uint8Array(dfuBytes), dfu.name).header);
    } catch (e) {
      /* Not fatal — the file still uploads and the device validates it. The
       * client just cannot say what version it is beforehand. */
      console.error(`note: could not read the OTA image version: ${e.message}`);
    }
    writeFileSync(join(dir, dfu.name), dfuBytes);
  } else {
    console.error(`note: ${dfuPath} missing — "Update over Bluetooth" will be unavailable`);
  }

  /* --- the UF2, where the bootloader takes one ------------------------- */
  let uf2 = null;
  const uf2Bytes = readIfPresent(uf2Path);
  if (uf2Bytes) {
    uf2 = { name: "merged.uf2", bytes: uf2Bytes };
    writeFileSync(join(dir, uf2.name), uf2Bytes);
  }

  /* --- Espressif: separate images at separate offsets ------------------ */
  const parts = [];
  for (const spec of partArgs) {
    const at = spec.lastIndexOf("@");
    if (at < 0) { console.error(`error: --part wants FILE@OFFSET, got ${spec}`); process.exit(1); }
    const p = resolve(spec.slice(0, at));
    const offset = Number(spec.slice(at + 1));
    if (!Number.isInteger(offset) || offset < 0) {
      console.error(`error: --part offset is not a number: ${spec}`); process.exit(1);
    }
    const bytes = readIfPresent(p);
    if (!bytes) { console.error(`note: ${p} missing — skipping that part`); continue; }
    /* Both images are called zephyr*.bin in their own build subdirectory and
     * would collide in one staging directory; the names they land under say
     * which is which. A part handed over already named — which is what CI
     * does, staging from release assets rather than from a build tree —
     * keeps the name it arrived with. */
    const name = STAGED_PART_NAME[basename(p)] ?? basename(p);
    writeFileSync(join(dir, name), bytes);
    parts.push({ name, offset, bytes });
  }

  const entry = buildEntry({ board, tag, hex, uf2, dfu, parts });
  const index = mergeIndex(readIndex(join(out, "manifest.json")), entry);
  writeFileSync(join(out, "manifest.json"), JSON.stringify(index, null, 2) + "\n");

  console.error(`staged ${board} -> ${dir}`);
  console.error(`  usb    ${entry.usb}`);
  console.error(`  tag    ${entry.tag}`);
  if (hex) console.error(`  hex    ${entry.file} (${entry.bytes} bytes, v${entry.version ?? "?"})`);
  if (dfu) console.error(`  dfu    ${entry.dfu} (${entry.dfuBytes} bytes, v${entry.dfuVersion ?? "?"})`);
  if (uf2) console.error(`  uf2    ${entry.uf2} (${entry.uf2Bytes} bytes)`);
  for (const p of entry.parts ?? []) {
    console.error(`  part   ${p.file} @ 0x${p.offset.toString(16)} (${p.bytes} bytes)`);
  }
  console.error(`  manifest now lists: ${index.boards.map(b => b.board).join(", ")}`);
}

/* Importable for tests; runs only when invoked directly. */
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}
