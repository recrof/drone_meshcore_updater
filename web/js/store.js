/*
 * Application state + actions.
 *
 * The SmpClient instance is deliberately NOT wrapped in reactive() — it holds
 * live GATT objects, and proxying those breaks identity comparisons inside the
 * Web Bluetooth stack. State that the UI renders is mirrored into refs here.
 */

import { reactive, ref, computed } from "./vue.js";
import { SmpClient } from "./lib/smp-client.js";
import { registerServiceWorker, applyUpdate } from "./lib/pwa.js";
import { fmtSize, fmtRate, timestamp, joinPath } from "./lib/format.js";
import {
  CONFIG_PATH, CONFIG_MAX_BYTES, isConfigPath, canonicalUploadPath,
  parseConfig, serializeConfig, encodedSize, defaults as configDefaults,
} from "./lib/config-file.js";
import { isLogPath } from "./lib/log-file.js";

export const smp = new SmpClient();

/* ---- state ------------------------------------------------------------ */
export const connected  = ref(false);
export const deviceName = ref("");
/* Fixed: the folder controls were removed from the toolbar, so nothing
 * changes this. Kept as a ref because refresh() and FileListing both read
 * it, and because the firmware path could still become configurable. */
export const path       = ref("/lfs1");
export const entries    = ref([]);
export const listError  = ref("");
export const fsInfo     = ref("—");
export const mtuInfo    = ref("—");
export const logLines   = reactive([]);
export const busy       = ref(false);
/* Lives here rather than in App so both the toolbar button and a click on
 * config.txt in the listing can open the editor without an event chain. */
export const configOpen = ref(false);
/* Same reasoning as configOpen: the flasher is reachable from the toolbar and
 * (unlike everything else here) works with no device connected at all. */
export const flashOpen = ref(false);
export const logViewOpen = ref(false);
export const logViewPath = ref("");

export const progress = reactive({
  shown: false,
  label: "",
  pct: 0,
  indeterminate: false,
});

const LOG_LIMIT = 500;

export function log(msg, cls = "") {
  logLines.push({ ts: timestamp(), msg, cls, id: logLines.length });
  if (logLines.length > LOG_LIMIT) logLines.splice(0, logLines.length - LOG_LIMIT);
}

smp.addEventListener("log", (e) => log(e.detail.msg, e.detail.cls));
smp.addEventListener("disconnected", () => {
  connected.value = false;
  entries.value = [];
  listError.value = "Disconnected.";
  fsInfo.value = "—";
  mtuInfo.value = "—";
});
smp.addEventListener("stream", (e) => {
  mtuInfo.value = e.detail.available ? "fsx_stream: fast upload" : "fsx_stream: absent";
});

/* ---- progress helpers ---- */
function showProgress(label) {
  progress.label = label;
  progress.shown = true;
  progress.pct = 0;
  progress.indeterminate = false;
}
function setProgress(fraction) {
  progress.pct = Math.max(0, Math.min(100, Math.floor(fraction * 100)));
  progress.indeterminate = false;
}
function hideProgress() {
  progress.shown = false;
  progress.indeterminate = false;
  progress.pct = 0;
}

/* Wrap an async action with the progress bar + busy flag, logging failures
 * in one place instead of at every call site.
 */
async function task(label, fn, { errPrefix = label } = {}) {
  showProgress(label);
  busy.value = true;
  try {
    return await fn();
  } catch (e) {
    log(`${errPrefix}: ${e.message}`, "err");
    throw e;
  } finally {
    busy.value = false;
    hideProgress();
  }
}

/* ---- connection ------------------------------------------------------- */
export async function connect() {
  try {
    log("scanning…");
    const name = await smp.connect();
    deviceName.value = name;
    connected.value = true;
    log(`connected to ${name}`, "ok");
    await refresh();
  } catch (e) {
    log(`connect failed: ${e.message}`, "err");
  }
}

export function disconnect() { smp.disconnect(); }

/* ---- browsing --------------------------------------------------------- */
export async function refresh() {
  const p = currentPath();
  showProgress(`Listing ${p}…`);
  try {
    let all = [];
    let off = 0;
    for (;;) {
      const r = await smp.fsxList(p, off, 32);
      all = all.concat(r.entries || []);
      if (!r.truncated) break;
      off += (r.entries || []).length;
      if (off > 4096) break;   // sanity guard
    }
    all.sort((a, b) => {
      if (a.type !== b.type) return b.type - a.type;   // dirs first
      return a.name.localeCompare(b.name);
    });
    entries.value = all;
    listError.value = "";
    updateFsInfo(p);
  } catch (e) {
    log(`ls ${p}: ${e.message}`, "err");
    entries.value = [];
    listError.value = e.message;
  } finally {
    hideProgress();
  }
}

export const currentPath = () => path.value.replace(/\/+$/, "") || "/lfs1";


async function updateFsInfo(p) {
  try {
    const r = await smp.fsxStatvfs(p);
    const total = r.frsize * r.blocks;
    const free  = r.frsize * r.bfree;
    fsInfo.value = `${fmtSize(free)} free / ${fmtSize(total)}  (${fmtSize(total - free)} used)`;
  } catch (e) {
    fsInfo.value = `statvfs: ${e.message}`;
  }
}

/* ---- file operations -------------------------------------------------- */

export async function rename(fullpath) {
  const oldName = fullpath.split("/").pop();
  const nn = prompt(`Rename "${oldName}" to:`, oldName);
  if (!nn || nn === oldName) return;
  const dst = fullpath.replace(/\/[^/]+$/, `/${nn}`);
  try {
    await smp.fsxMove(fullpath, dst);
    log(`mv ${fullpath} ${dst}`, "ok");
    await refresh();
  } catch (e) { log(`mv: ${e.message}`, "err"); }
}

export async function remove(fullpath, isDir) {
  if (!confirm(`Delete "${fullpath}"${isDir ? " and everything inside?" : "?"}`)) return;
  try {
    /* fsxRmdir routes to fs_unlink for plain files (recursive=false) or
     * walks + unlinks children then the dir (recursive=true). One code path
     * for both — stock fs_mgmt has no delete opcode.
     */
    await smp.fsxRmdir(fullpath, isDir);
    log(`rm ${fullpath}`, "ok");
    await refresh();
  } catch (e) { log(`rm: ${e.message}`, "err"); }
}

export async function flashZip(fullpath) {
  if (!confirm(`Flash "${fullpath.split("/").pop()}" to the DFU target?\n\n` +
               `The updater will scan for a matching BLE peer, connect, and start ` +
               `the Legacy DFU sequence. Watch the LED (green = running) or the ` +
               `serial console for progress.`)) return;
  try {
    await smp.fsxTriggerDfu(fullpath);
    log(`DFU triggered: ${fullpath} — see LED / serial for progress`, "ok");
  } catch (e) {
    log(`DFU trigger: ${e.message}`, "err");
  }
}

export function openConfig() { configOpen.value = true; }
export function openFlash() { flashOpen.value = true; }

/* Opening with no path shows the newest log file. */
export function openLogView(path = "") {
  logViewPath.value = path;
  logViewOpen.value = true;
}

/* Reboot the updater itself (not the DFU target) via the standard mcumgr OS
 * group. The firmware already answers this: CONFIG_REBOOT=y registers the
 * OS_MGMT_ID_RESET handler, and CONFIG_MCUMGR_GRP_OS_RESET_MS=250 makes it
 * reply first and reset 250 ms later, so the response arrives before the link
 * drops. Losing the link is the expected outcome, not an error. */
export async function reboot() {
  if (!confirm("Reboot the updater?\n\n" +
               "The Bluetooth connection will drop and you will need to reconnect. " +
               "Do not do this while a DFU is running.")) return;
  try {
    await smp.osReset();
    log("reboot requested", "ok");
  } catch (e) {
    /* A device that resets before answering looks like a timeout here; say so
     * rather than reporting a failure that probably did not happen. */
    log(`reboot: ${e.message} (the device may have reset anyway)`, "warn");
  }
}

/* What a click on a listing row should do. config.txt opens the editor
 * instead of downloading — reading the raw file is still available from the
 * editor's own file preview.
 */
export function activateEntry(fullpath, isDir) {
  /* Directories are listed (so they can be renamed or deleted) but not
   * entered. With the "up" control gone there would be no way back out, and
   * nothing this device reads ever lives below the root. */
  if (isDir) return;
  if (isConfigPath(fullpath)) return openConfig();
  /* Log files open in the viewer. Downloading a 32 KB blob to read it in a
   * text editor is the thing the viewer exists to avoid; Save is still there
   * inside it. */
  if (isLogPath(fullpath)) return openLogView(fullpath);
  return download(fullpath);
}

/* Auto-flash: trigger with no path, so the device scans first and picks the
 * bundle itself from ble_firmware_mapping. An explicit empty string is sent
 * rather than omitting the key, so the request shape doesn't depend on how
 * the decoder treats a missing field.
 */
export async function autoFlash() {
  if (!confirm(`Auto-flash the next matching target?\n\n` +
               `The updater will scan for a BLE peer, match its advertised name ` +
               `against the rules in ble_firmware_mapping, and flash whichever ` +
               `bundle those rules select. Set the rules under Config… first.\n\n` +
               `Watch the LED (green = running) or the serial console for progress.`)) return;
  try {
    await smp.fsxTriggerDfu("");
    log("auto-flash triggered — bundle chosen by ble_firmware_mapping", "ok");
  } catch (e) {
    log(`auto-flash: ${e.message}`, "err");
  }
}

export async function download(fullpath) {
  const name = fullpath.split("/").pop();
  try {
    const bytes = await task(`Downloading ${name}…`,
      () => smp.readFile(fullpath, setProgress),
      { errPrefix: `download ${name}` });
    const url = URL.createObjectURL(new Blob([bytes]));
    const a = document.createElement("a");
    a.href = url; a.download = name; a.click();
    URL.revokeObjectURL(url);
    log(`downloaded ${name} (${fmtSize(bytes.length)})`, "ok");
  } catch { /* already logged */ }
}

export async function uploadFiles(files) {
  if (!files.length) return;
  log(`upload: ${files.length} file(s)`);
  for (const f of files) {
    let dst = joinPath(currentPath(), f.name);
    /* Force any config-file upload to the canonical lowercase name. Uploading
     * "config.txt" would otherwise sit next to config.txt as a file the
     * firmware never opens. Logged, not silent.
     */
    const canonical = canonicalUploadPath(dst);
    if (canonical) {
      log(`upload: writing ${f.name} as ${canonical} (config filename is always lowercase)`);
      dst = canonical;
    }
    const bytes = new Uint8Array(await f.arrayBuffer());
    const t0 = performance.now();
    const via = smp.hasStream() ? "stream" : "smp";
    try {
      await task(`Uploading ${f.name}…`,
        () => smp.writeFile(dst, bytes, setProgress),
        { errPrefix: `upload ${f.name}` });
      const dt = (performance.now() - t0) / 1000;
      log(`upload ${f.name} [${via}] (${fmtSize(bytes.length)} in ` +
          `${dt.toFixed(1)} s — ${fmtRate(bytes.length, dt)})`, "ok");
    } catch { /* already logged; continue with the remaining files */ }
  }
  await refresh();
}

/* ---- config.txt ------------------------------------------------------- */

/* Read and parse config.txt. A missing file is not an error — the firmware
 * falls back to compile-time defaults, so the editor opens showing exactly
 * what the device is running.
 */
export async function loadConfig() {
  try {
    const bytes = await smp.readFile(CONFIG_PATH);
    const parsed = parseConfig(new TextDecoder().decode(bytes));
    log(`loaded ${CONFIG_PATH} (${bytes.length} B)`, "ok");
    for (const ig of parsed.ignored) {
      log(`${CONFIG_PATH}: ${ig.key}=${ig.value} ignored by firmware — ${ig.reason}`, "err");
    }
    return { ...parsed, exists: true, size: bytes.length };
  } catch (e) {
    log(`${CONFIG_PATH} not readable (${e.message}) — showing firmware defaults`);
    return { values: configDefaults(), unknown: [], ignored: [], exists: false, size: 0 };
  }
}

export async function saveConfig(values, unknown) {
  const text = serializeConfig(values, unknown);
  const size = encodedSize(text);
  if (size > CONFIG_MAX_BYTES) {
    throw new Error(`${size} B exceeds the firmware's ${CONFIG_MAX_BYTES} B parse ` +
                    `buffer — keys past the cut-off would silently revert to defaults`);
  }
  const bytes = new TextEncoder().encode(text);
  await task(`Saving ${CONFIG_PATH}…`,
    () => smp.writeFile(CONFIG_PATH, bytes, setProgress),
    { errPrefix: "save config.txt" });

  /* Read back and compare. writeFile already fails on a short stream write,
   * but a verified round-trip is cheap at this size and catches anything the
   * filesystem did differently from what we asked for.
   */
  const readBack = new TextDecoder().decode(await smp.readFile(CONFIG_PATH));
  if (readBack !== text) {
    throw new Error("verification failed — file on device differs from what was sent");
  }
  log(`saved ${CONFIG_PATH} (${size} B, verified) — applies at the next DFU attempt`, "ok");
  await refresh();
}

/* ---- capability check ------------------------------------------------- */
export const bluetoothAvailable = computed(() => "bluetooth" in navigator);

/* ---- offline / PWA ---------------------------------------------------- */

/* Set once a newer service worker is installed and waiting. The header shows
 * a reload affordance rather than swapping the app out from under someone
 * mid-transfer — this page can be driving a DFU. */
export const updateReady = ref(false);
export const reloadForUpdate = applyUpdate;

export function initOffline() {
  return registerServiceWorker({
    onLog: log,
    onUpdate: () => { updateReady.value = true; },
  });
}
