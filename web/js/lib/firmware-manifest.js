/*
 * Reading the staged firmware index.
 *
 * web/firmware/manifest.json describes every board a release published, one
 * entry each, written by web/tools/stage-firmware.mjs. Both the USB flasher
 * and the Bluetooth updater select an entry out of it, by different criteria —
 * the USB side by which flashing method it can actually speak, the Bluetooth
 * side by which board the connected device says it is — so the reading lives
 * here rather than twice in two components that could drift apart.
 *
 * No DOM dependency, so node can test it directly.
 */

/* Staged by CI from the newest published release — see web.yml. Relative, so
 * it works under a GitHub Pages sub-path and from a local checkout alike. */
export const FIRMWARE_DIR = "firmware/";
export const MANIFEST_URL = `${FIRMWARE_DIR}manifest.json`;

/* The schema this client understands. An index announcing a newer format is
 * refused rather than half-read: the failure of guessing at fields you do not
 * understand is an image written to the wrong offset, which is exactly the
 * class of mistake the manifest exists to prevent. */
export const SUPPORTED_FORMAT = 2;

/** Absolute-ish URL of one artifact inside a board's staging subdirectory. */
export function assetUrl(entry, name) {
  return `${FIRMWARE_DIR}${entry.dir}/${name}`;
}

/**
 * Parse and validate an index. Throws with a reason the UI can show.
 */
export function parseIndex(m) {
  if (!m || typeof m !== "object") throw new Error("manifest is not an object");
  if (!Array.isArray(m.boards)) {
    /* A pre-multi-board manifest named its artifacts at the top level. There
     * is no board subdirectory to find them in, so it cannot be read as an
     * entry — say so plainly instead of producing 404s later. */
    throw new Error("manifest predates multi-board staging — rebuild or redeploy");
  }
  if (m.format > SUPPORTED_FORMAT) {
    throw new Error(`manifest format ${m.format} is newer than this client understands ` +
                    `(${SUPPORTED_FORMAT}) — reload the page to pick up a newer client`);
  }
  return m;
}

/** Fetch and validate. `fetchImpl` is injectable so tests need no network. */
export async function loadIndex(fetchImpl = fetch) {
  const res = await fetchImpl(MANIFEST_URL, { cache: "no-cache" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return parseIndex(await res.json());
}

/**
 * The entry for a specific board target, e.g. "xiao_ble/nrf52840".
 *
 * Exact match only. A near-match is not a safe default here: MCUboot validates
 * a signature and not an architecture, and every board in this repo signs with
 * the same key, so a wrong image verifies, installs, and then does not boot.
 */
export function entryForBoard(index, board) {
  if (!board) return null;
  return index.boards.find(b => b.board === board) ?? null;
}

/** Every entry a given USB flashing method can write, newest staged first. */
export function entriesForUsb(index, method) {
  return index.boards
    .filter(b => b.usb === method && (b.file || b.parts?.length))
    .sort((a, b) => String(b.published ?? "").localeCompare(String(a.published ?? "")));
}

/** Entries that carry an OTA image, i.e. can be sent over Bluetooth. */
export const entriesWithDfu = (index) => index.boards.filter(b => b.dfu);

/*
 * Human names for the boards, keyed by the first segment of the board target.
 *
 * The manifest carries Zephyr's qualified target — `xiao_esp32s3/esp32s3/
 * procpu` — because that is the string the firmware reports over SMP and the
 * one thing that can be matched exactly. It is not a thing to show a person
 * choosing which board is in front of them.
 *
 * Keyed on the board name rather than the full target on purpose: a variant
 * (`.../sense`) is the same physical thing to a user and the same artifact to
 * a flasher, and it should not need an entry here to get a name.
 *
 * stage-firmware.test.mjs holds this to the same board list as `USB_METHODS`
 * in the stager, so a fourth board cannot arrive with a raw target string as
 * its name.
 */
export const BOARD_LABELS = {
  xiao_nrf54lm20a: "XIAO nRF54LM20A",
  xiao_ble: "XIAO nRF52840",
  rak4631: "RAK4631",
  xiao_esp32s3: "XIAO ESP32-S3",
  xiao_esp32c5: "XIAO ESP32-C5",
  xiao_mg24: "XIAO MG24",
};

export const boardName = (target) => String(target ?? "").split("/")[0];

/** A name to show. Falls back to the raw target rather than to nothing: an
 *  unlabelled board is still selectable, just ugly. */
export const boardLabel = (target) => BOARD_LABELS[boardName(target)] ?? String(target ?? "");

/** Every entry a USB flasher could write, given a set of method names. */
export function usbEntries(index, methods) {
  return index.boards
    .filter(b => methods.includes(b.usb) && (b.file || b.parts?.length))
    .sort((a, b) => boardLabel(a.board).localeCompare(boardLabel(b.board)));
}
