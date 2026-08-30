/*
 * The staged firmware index, held together across four files. Run with plain
 * node:
 *
 *   node web/test/stage-firmware.test.mjs
 *
 * manifest.json is generated, never committed, so there is no fixture to
 * compare against — instead hold the producer and its consumers together:
 *
 *   stage-firmware.mjs   writes the entries
 *   firmware-manifest.js selects one
 *   usb-flashers.js      says how each method reaches its board
 *   ProbeFlash.js        writes it through a CMSIS-DAP probe
 *   SerialFlash.js       writes it through a bootloader or a ROM loader
 *   BleUpdate.js         sends it over Bluetooth
 *
 * Plus the three board facts that cannot be derived from a build: which USB
 * flashing method each board needs, what to call it on screen, and what the
 * user has to do to the hardware first. All three are hand-written tables in
 * different files, so this fails when a board is added to the repo and any
 * one of them is not updated — which would otherwise present as a board that
 * stages fine and is then quietly offered to no flasher at all.
 */
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";

const WEB = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = resolve(WEB, "..");

let bad = 0;
const t = (name, cond, extra = "") => {
  console.log(`${cond ? "  ok  " : "  FAIL"} ${name}${extra ? `  [${extra}]` : ""}`);
  if (!cond) bad++;
};

const {
  buildEntry, mergeIndex, readIndex, usbMethod, boardDir, boardName,
  USB_METHODS, ENTRY_KEYS, INDEX_KEYS, FORMAT, versionOfHex,
  PART_LAYOUT, STAGED_PART_NAME,
} = await import("../tools/stage-firmware.mjs");
const fm = await import("../js/lib/firmware-manifest.js");
const uf = await import("../js/lib/usb-flashers.js");

const buf = (s) => Buffer.from(s);

/* --- the board table vs the boards this repo can actually build --------- */

/* Sysbuild's CMakeLists.txt hard-errors without an MCUboot overlay per board,
 * so `updater/sysbuild/mcuboot_<board>.overlay` IS the list of supported
 * boards — there is no way to build one that is not there. */
const boards = readdirSync(join(ROOT, "updater", "sysbuild"))
  .map(f => f.match(/^mcuboot_(.+)\.overlay$/)?.[1])
  .filter(Boolean)
  .sort();

t("found the supported boards", boards.length >= 3, boards.join(", "));
for (const b of boards) {
  /* The failure this prevents: a new board builds, stages, and produces a
   * manifest entry whose `usb` is null — so the client silently offers it to
   * no flasher at all and the board looks unsupported rather than unmapped. */
  t(`USB_METHODS covers ${b}`, !!USB_METHODS[b], USB_METHODS[b] ?? "MISSING");
}
t("no USB_METHODS entry for a board that does not exist",
  Object.keys(USB_METHODS).every(b => boards.includes(b)),
  Object.keys(USB_METHODS).filter(b => !boards.includes(b)).join(", ") || "none");

/* Every method the stager can stamp on an entry must be one the client knows
 * how to run. A method with no flasher stages artifacts nothing can install —
 * which is exactly the state two of these three boards were in before the
 * serial flashers existed, and it reads as "unsupported hardware" rather than
 * as a missing case. */
for (const method of new Set(Object.values(USB_METHODS))) {
  t(`a flasher exists for "${method}"`, uf.SUPPORTED_METHODS.includes(method),
    uf.SUPPORTED_METHODS.join(", "));
}
t("no flasher for a method nothing is staged with",
  uf.SUPPORTED_METHODS.every(m => Object.values(USB_METHODS).includes(m)),
  uf.SUPPORTED_METHODS.filter(m => !Object.values(USB_METHODS).includes(m)).join(", ") || "none");

/* Each flasher must say which browser API it needs and — for the ones with a
 * button dance — what that dance is. An empty `prepare` on a board that needs
 * one is a user staring at a button that silently times out. */
for (const [method, f] of Object.entries(uf.FLASHERS)) {
  t(`${method} declares a browser API`, ["webusb", "webserial"].includes(f.api), f.api);
  t(`${method} explains itself`, !!f.summary && f.summary.length > 20);
  t(`${method} declares which artifact it writes`,
    Object.values(uf.ARTIFACT).includes(f.artifact), f.artifact);
  /* Web Serial means the browser hands us a port and nothing else: there is
   * no way in without the user having put the board in its bootloader first,
   * so the steps are not optional. */
  if (f.api === "webserial") {
    t(`${method} says how to reach the bootloader`, f.prepare.length > 0);
    t(`${method} says what to do when it fails`, !!f.recovery);
  }
}

/* Board names for humans. Without one, the chooser shows a Zephyr qualified
 * target — `xiao_esp32s3/esp32s3/procpu` — to someone deciding which of the
 * three things on their desk they are holding. */
for (const b of boards) {
  t(`BOARD_LABELS names ${b}`, !!fm.BOARD_LABELS[b], fm.BOARD_LABELS[b] ?? "MISSING");
}
t("no label for a board that does not exist",
  Object.keys(fm.BOARD_LABELS).every(b => boards.includes(b)),
  Object.keys(fm.BOARD_LABELS).filter(b => !boards.includes(b)).join(", ") || "none");
t("boardLabel takes a qualified target and drops the qualifiers",
  fm.boardLabel("xiao_ble/nrf52840") === fm.BOARD_LABELS.xiao_ble);
/* A variant is the same physical board and the same artifact; it must not
 * need its own entry to get a name. */
t("a board variant inherits its board's label",
  fm.boardLabel("xiao_ble/nrf52840/sense") === fm.BOARD_LABELS.xiao_ble);

/* --- entry shape -------------------------------------------------------- */

const e = buildEntry({
  board: "xiao_ble/nrf52840", tag: "v1.2.3",
  hex: { name: "merged.hex", bytes: buf("x"), version: "1.0.0" },
  dfu: { name: "dfu_application.zip", bytes: buf("yy"), version: "1.0.0+2" },
  uf2: { name: "merged.uf2", bytes: buf("zzz") },
});

const REQUIRED = ["board", "usb", "dir", "tag", "published"];
t("entry always writes the required keys", REQUIRED.every(k => k in e), Object.keys(e).join(", "));
t("entry writes no undeclared keys", Object.keys(e).every(k => ENTRY_KEYS.includes(k)));
t("every required key is declared", REQUIRED.every(k => ENTRY_KEYS.includes(k)));
t("entry carries a sha256 of the image", /^[0-9a-f]{64}$/.test(e.sha256), e.sha256);
t("entry byte count matches the image", e.bytes === 1, String(e.bytes));
t("entry timestamp is ISO-8601 Z",
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(e.published), e.published);
t("entry records the OTA image separately from the hex",
  e.dfu === "dfu_application.zip" && e.file === "merged.hex" && e.dfuBytes === 2);
t("entry records the UF2 separately again", e.uf2 === "merged.uf2" && e.uf2Bytes === 3);
/* The version is what the UI shows before downloading 280 KB, so it has to
 * survive into the entry. */
t("entry carries both versions", e.version === "1.0.0" && e.dfuVersion === "1.0.0+2");
t("entry names the USB method", e.usb === "nordic-serial-dfu", e.usb);

/* The board gate. MCUboot validates a signature and not an architecture, and
 * every board here signs with the same key, so this field is the only thing
 * between a cross-board update and a device that installs the image and then
 * does not boot. */
t("entry carries the board it was built for", e.board === "xiao_ble/nrf52840");

const bare = buildEntry({ board: "xiao_ble/nrf52840", tag: "v1" });
t("artifact fields are all optional",
  !("file" in bare) && !("dfu" in bare) && !("uf2" in bare) && !("parts" in bare));

/* Espressif produces no merged.hex at all — a flat address->byte merge of an
 * ESP image is meaningless — so its artifacts are separate images at separate
 * offsets, and an entry with `parts` and no `file` must be legal. */
const esp = buildEntry({
  board: "xiao_esp32s3/esp32s3/procpu", tag: "v1",
  parts: [{ name: "mcuboot.bin", offset: 0, bytes: buf("a") },
          { name: "app.signed.bin", offset: 0x20000, bytes: buf("bb") }],
});
t("an Espressif entry is legal with parts and no merged hex",
  !esp.file && esp.parts.length === 2 && esp.parts[1].offset === 0x20000);
t("each part carries its own digest", esp.parts.every(p => /^[0-9a-f]{64}$/.test(p.sha256)));

/* --- the subdirectory, which is what makes staging survivable ----------- */

/* All three boards produce a file called merged.hex and one called
 * dfu_application.zip. Staged flat, the second board silently overwrites the
 * first while the manifest still describes both. */
t("board directories are distinct",
  new Set(boards.map(b => boardDir(b))).size === boards.length);
t("board dir matches build.sh's build_<target> convention",
  boardDir("xiao_esp32s3/esp32s3/procpu") === "xiao_esp32s3_esp32s3_procpu");
t("board name is the first path element", boardName("xiao_ble/nrf52840") === "xiao_ble");

/* --- merging: staging one board must not disturb another ---------------- */

let ix = { format: FORMAT, published: "2020-01-01T00:00:00Z", boards: [] };
ix = mergeIndex(ix, buildEntry({ board: "xiao_ble/nrf52840", tag: "a" }));
ix = mergeIndex(ix, buildEntry({ board: "xiao_nrf54lm20a/nrf54lm20a/cpuapp", tag: "b" }));
t("merging adds boards", ix.boards.length === 2, ix.boards.map(b => b.board).join(", "));

ix = mergeIndex(ix, buildEntry({ board: "xiao_ble/nrf52840", tag: "c" }));
t("restaging a board replaces only its own entry",
  ix.boards.length === 2 &&
  ix.boards.find(b => b.board === "xiao_ble/nrf52840").tag === "c" &&
  ix.boards.find(b => b.board.startsWith("xiao_nrf54")).tag === "b");
t("entries are sorted, so the file does not churn",
  ix.boards.map(b => b.board).join() ===
  ix.boards.map(b => b.board).sort().join());
t("index writes no undeclared keys", Object.keys(ix).every(k => INDEX_KEYS.includes(k)));

/* --- the client reads what the tool writes ------------------------------ */

t("client and tool agree on the format number", fm.SUPPORTED_FORMAT === FORMAT,
  `${fm.SUPPORTED_FORMAT} vs ${FORMAT}`);
t("a newer format is refused rather than half-read", (() => {
  try { fm.parseIndex({ format: FORMAT + 1, boards: [] }); return false; }
  catch { return true; }
})());
t("a pre-multi-board manifest is refused with a reason", (() => {
  try { fm.parseIndex({ file: "merged.hex", sha256: "x" }); return false; }
  catch (err) { return /multi-board/.test(err.message); }
})());

t("entryForBoard matches exactly, never approximately",
  fm.entryForBoard(ix, "xiao_ble/nrf52840")?.tag === "c" &&
  fm.entryForBoard(ix, "xiao_ble") === null &&
  fm.entryForBoard(ix, "") === null);

const usbIx = { format: FORMAT, published: "z", boards: [
  { board: "a/x", usb: "cmsis-dap", dir: "a_x", file: "merged.hex", published: "2020-01-01T00:00:00Z" },
  { board: "b/y", usb: "esptool", dir: "b_y", parts: [{ file: "m.bin", offset: 0 }], published: "2021-01-01T00:00:00Z" },
  { board: "c/z", usb: "cmsis-dap", dir: "c_z", published: "2022-01-01T00:00:00Z" },
]};
t("entriesForUsb filters by method", fm.entriesForUsb(usbIx, "esptool").map(b => b.board).join() === "b/y");
/* An entry with no flashable artifact is not offered: the button would fetch
 * `undefined` and fail after the user committed to a write. */
t("entriesForUsb skips entries with nothing to write",
  fm.entriesForUsb(usbIx, "cmsis-dap").map(b => b.board).join() === "a/x");
t("assetUrl points inside the board's subdirectory",
  fm.assetUrl({ dir: "xiao_ble_nrf52840" }, "merged.hex") ===
  "firmware/xiao_ble_nrf52840/merged.hex");

/* The dialog offers every board it can flash, not one method's worth. */
t("usbEntries gathers every method the client speaks",
  fm.usbEntries(usbIx, ["cmsis-dap", "esptool"]).map(b => b.board).join() === "a/x,b/y");
t("usbEntries still skips entries with nothing to write",
  !fm.usbEntries(usbIx, ["cmsis-dap"]).some(b => b.board === "c/z"));
t("entryIsFlashable wants parts for a parts-based method",
  uf.entryIsFlashable({ usb: "esptool", parts: [{ file: "m.bin", offset: 0 }] }) &&
  !uf.entryIsFlashable({ usb: "esptool", file: "merged.hex" }) &&
  !uf.entryIsFlashable({ usb: "nordic-serial-dfu", parts: [{}] }));

/* --- the components actually use those fields --------------------------- */

const flash  = readFileSync(join(WEB, "js/components/FlashDialog.js"), "utf8");
const probe  = readFileSync(join(WEB, "js/components/ProbeFlash.js"), "utf8");
const serial = readFileSync(join(WEB, "js/components/SerialFlash.js"), "utf8");
const ble    = readFileSync(join(WEB, "js/components/BleUpdate.js"), "utf8");
const usb = flash + probe + serial;
const dialog = usb + ble;

/* `file` is dereferenced to build the URL and `sha256` gates the write, so
 * those two are load-bearing rather than cosmetic. A key written by the
 * stager that nothing reads is either dead weight or a missed check. */
for (const key of ["file", "sha256", "tag", "bytes", "dfu", "dfuVersion", "board", "usb"]) {
  t(`a component reads entry.${key}`,
    new RegExp(`(newest|entry)(\\.value)?\\.${key}\\b`).test(dialog));
}
/* The ESP32-S3 has no single-file artifact at all, so these two are the whole
 * of what its flasher writes and where. */
for (const key of ["parts", "offset"]) {
  t(`the serial flasher reads entry.${key}`, new RegExp(`\\.${key}\\b`).test(serial));
}
t("no component builds a firmware URL by hand",
  !/FIRMWARE_DIR\s*\+/.test(dialog) &&
  /assetUrl\(/.test(probe) && /assetUrl\(/.test(serial) && /assetUrl\(/.test(ble));
t("every consumer reads the index through the shared module",
  /firmware-manifest\.js/.test(flash) && /firmware-manifest\.js/.test(ble));
/* The dialog offers whatever it has a flasher for, rather than naming one
 * method. Hard-coding `cmsis-dap` here is what left two boards published and
 * uninstallable. */
t("the USB dialog offers every method the client speaks",
  /usbEntries\(/.test(flash) && /SUPPORTED_METHODS/.test(flash) &&
  !/=\s*"cmsis-dap"/.test(flash));
t("the dialog dispatches on the entry's own method",
  /entry\.usb\s*===\s*'cmsis-dap'/.test(flash) && /flasherFor\(/.test(flash));
/* The whole point of the board dimension: the Bluetooth route now picks the
 * image for the board the device reports, instead of refusing a mismatch. */
t("the Bluetooth route selects by the device's reported board",
  /entryForBoard\(index, deviceBoard\.value\)/.test(ble));
t("a late-arriving board re-selects",
  /watch\(deviceBoard/.test(ble));

/* --- versionOfHex is board-independent ---------------------------------- */

/* It used to hard-code slot0 at 0x10000, which is the nRF54L's and nobody
 * else's; the nRF52840 links its at 0x33000, so the constant did not merely
 * fail there, it read 32 bytes of bootloader and reported whatever version
 * that looked like. */
t("versionOfHex does not hard-code a slot address",
  !/0x10000|65536/.test(readFileSync(join(WEB, "tools/stage-firmware.mjs"), "utf8")
    .split("export function versionOfHex")[1].split("\n}")[0]));

/* Build a tiny Intel hex holding an MCUboot header at a non-nRF54L slot0. */
{
  const { IMAGE_MAGIC } = await import("../js/lib/mcuboot-image.js");
  const hdr = Buffer.alloc(32);
  hdr.writeUInt32LE(IMAGE_MAGIC, 0);
  hdr.writeUInt32LE(0, 4);          // ih_load_addr
  hdr.writeUInt16LE(32, 8);         // ih_hdr_size
  hdr.writeUInt32LE(100, 12);       // ih_img_size
  hdr[20] = 7; hdr[21] = 8;         // major, minor
  hdr.writeUInt16LE(9, 22);         // revision

  const lines = [];
  const base = 0x33000;
  /* One record builder for both kinds, so the checksum is computed rather
   * than typed — a wrong one here fails as "checksum mismatch" and looks like
   * a bug in the parser under test. */
  const rec = (type, addr, data) => {
    const b = [data.length, (addr >> 8) & 0xff, addr & 0xff, type, ...data];
    b.push((256 - (b.reduce((a, x) => a + x, 0) & 0xff)) & 0xff);
    return ":" + b.map(x => x.toString(16).padStart(2, "0")).join("").toUpperCase();
  };
  lines.push(rec(4, 0, [(base >> 24) & 0xff, (base >> 16) & 0xff]));
  for (let off = 0; off < 32; off += 16) {
    lines.push(rec(0, (base + off) & 0xffff, [...hdr.subarray(off, off + 16)]));
  }
  lines.push(":00000001FF");
  const v = versionOfHex(Buffer.from(lines.join("\n") + "\n"));
  t("versionOfHex finds slot0 by header magic, at any address", v === "7.8.9", String(v));
}

/* --- part offsets vs the partition table they claim to describe ----------
 *
 * A board with no single-file image is flashed as separate binaries at
 * separate offsets, and those offsets ARE the partition table. The stager
 * carries its own copy because CI stages from release assets and has no build
 * tree to read a devicetree out of — so the copy has to be held down.
 *
 * This is worth a test rather than a comment because every mechanism that
 * would normally catch it is blind here. `SPI_FLASH_MD5` verifies what was
 * written at the offset it was written to, so a stale offset flashes clean
 * AND reads back clean; MCUboot then finds no valid image where it looks, and
 * its console is off on this part anyway (Trap 6). The whole failure is
 * invisible from end to end.
 *
 * It has already happened once in this file's neighbourhood: versionOfHex
 * hard-coded slot0 at 0x10000, which was the nRF54L's and nobody else's.
 */
for (const [boardKey, layout] of Object.entries(PART_LAYOUT)) {
  const dtsi = readFileSync(join(ROOT, layout.dtsi), "utf8");
  for (const part of layout.parts) {
    /* `boot_partition: partition@0 {` — the label carries the meaning, the
     * unit address carries the offset, and DT requires them to agree. */
    const m = new RegExp(`${part.partition}:\\s*partition@([0-9a-fA-F]+)`).exec(dtsi);
    t(`${boardKey}: ${part.name} sits at ${part.partition} in ${layout.dtsi}`,
      m !== null && parseInt(m[1], 16) === part.offset,
      m ? `dtsi 0x${m[1]} vs layout 0x${part.offset.toString(16)}`
        : `no ${part.partition} in ${layout.dtsi}`);
  }
  /* An offset the flasher writes to but the table never mentions would be a
   * part landing in whatever happens to follow. */
  t(`${boardKey}: every part names a partition`,
    layout.parts.every(p => p.partition && Number.isInteger(p.offset)));
  t(`${boardKey}: part names are distinct`,
    new Set(layout.parts.map(p => p.name)).size === layout.parts.length,
    layout.parts.map(p => p.name).join(","));
}

/* Every board the stager knows a parts layout for must be one the client can
 * flash by that route, and vice versa — a layout for a board whose USB method
 * is not `esptool` would stage `parts` that no flasher reads. */
{
  const partsBoards = Object.keys(PART_LAYOUT).sort();
  const espBoards = Object.entries(USB_METHODS)
    .filter(([, m]) => m === "esptool").map(([b]) => b).sort();
  t("PART_LAYOUT covers exactly the boards flashed as parts",
    JSON.stringify(partsBoards) === JSON.stringify(espBoards),
    `layout: ${partsBoards.join(",")} vs esptool: ${espBoards.join(",")}`);
}

/* The rename map is generated from the layout, so this asserts the generation
 * rather than a second hand-written table — it would catch a layout entry
 * whose `from` and `name` were swapped, or two boards disagreeing about what
 * one build artifact is called. */
t("STAGED_PART_NAME is derived from PART_LAYOUT",
  Object.values(PART_LAYOUT).flatMap(b => b.parts)
    .every(p => STAGED_PART_NAME[p.from[p.from.length - 1]] === p.name),
  JSON.stringify(STAGED_PART_NAME));

/* --- the release workflow vs the boards this repo can build --------------
 *
 * `updater/sysbuild/` is the definition of "supported board" everywhere else
 * in this test, and every client-side table is held to it. Nothing held the
 * *build* to it, and that gap had already been paid for: the ESP32-S3 could
 * be built locally, staged locally, and flashed from a locally-served client,
 * while every published release silently omitted it. Nobody was wrong at any
 * point — it just was not anybody's file.
 *
 * The workflow builds a board in two shapes: a matrix row (`- board: X`) and
 * a direct invocation (`west build -b X`), because the Espressif board needs
 * its own job rather than a row. Both are matched, so which shape a board
 * uses stays a CI concern and not a thing this test has an opinion about.
 */
{
  let workflow = null;
  try {
    workflow = readFileSync(join(ROOT, ".github/workflows/build.yml"), "utf8");
  } catch { /* not checked out */ }

  if (!workflow) {
    console.log("  skip  build.yml not readable; CI board coverage not cross-checked");
  } else {
    const targets = new Set();
    for (const m of workflow.matchAll(/(?:^\s*-\s*board:\s*|west build\s+-b\s+)([a-z0-9_]+\/[a-z0-9_/]+)/gm)) {
      targets.add(boardName(m[1]));
    }
    const built = [...targets].sort();
    t("every supported board is built by the release workflow",
      JSON.stringify(built) === JSON.stringify(boards),
      `build.yml: ${built.join(",")} vs sysbuild: ${boards.join(",")}`);

    /* A board whose images are flashed as parts must publish where they go,
     * or the staging side has nothing to pass to --part and quietly drops it
     * from the index. */
    t("the workflow publishes a parts manifest",
      /-parts\.txt/.test(workflow),
      "a parts board needs its offsets published alongside its images");
    t("...and web.yml consumes one",
      /-parts\.txt/.test(readFileSync(join(ROOT, ".github/workflows/web.yml"), "utf8")));

    /* The offsets themselves must not appear in either workflow: they live in
     * PART_LAYOUT, held to the devicetree above. A literal here would be a
     * copy nothing checks — which is the exact defect this pair of tests was
     * added to close. */
    for (const wf of ["build.yml", "web.yml"]) {
      const text = readFileSync(join(ROOT, ".github/workflows", wf), "utf8");
      const offsets = Object.values(PART_LAYOUT).flatMap(b => b.parts)
        .map(p => `0x${p.offset.toString(16)}`)
        .filter(o => o !== "0x0" && text.includes(o));
      t(`${wf} writes down no part offsets of its own`, offsets.length === 0,
        offsets.join(","));
    }
  }
}

console.log(bad ? `\n${bad} FAILURES` : "\nall stage-firmware tests passed");
process.exit(bad ? 1 : 0);
