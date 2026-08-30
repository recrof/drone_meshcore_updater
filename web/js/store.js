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
import { inspectFirmware, isFirmwareName, TRANSPORT, transportForName,
         transportsFromMask, unsupportedReason }
  from "./lib/firmware-image.js";
import { isLogPath } from "./lib/log-file.js";
import { idleStatus, STATE as DFU_STATE } from "./lib/dfu-status.js";

export const smp = new SmpClient();

/* ---- state ------------------------------------------------------------ */
export const connected  = ref(false);
export const deviceName = ref("");
/* The board target the device reports (os_mgmt info, format "i") — e.g.
 * "xiao_ble/nrf52840". Null on firmware that predates it. Not cosmetic: it is
 * what lets the client refuse an update built for a different board, which
 * MCUboot cannot do for itself (it checks the signature, not the
 * architecture, and every board here signs with the same key). */
export const deviceBoard = ref(null);
/* Transports the *device* says it has, asked once at connect (fsxCaps).
 * Null until answered, and on firmware too old to answer — which the
 * inspector reads as "make no compatibility claim" rather than as a guess. */
export const deviceTransports = ref(null);
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
/* Open the viewer already streaming rather than reading a file. Set by the
 * DFU banner: during a live transfer the interesting lines are the ones the
 * flash backend has not flushed yet, so reading LOG.NNNN shows everything
 * except what you opened it for. */
export const logViewLive = ref(false);

/* Live DFU progress, pushed by the device (src/dfu_status.c). Always a full
 * record — idleStatus() has the same shape as a parsed one — so nothing that
 * renders it has to null-check. */
export const dfuStatus = ref(idleStatus());
/* True while the device is actually working. DONE and FAILED are sticky, so
 * this is not "state !== IDLE". */
export const dfuActive = computed(() => dfuStatus.value.active);
/* Bytes/s, derived here rather than on the device: the firmware would have to
 * carry a second clock to report it, and the client already sees every sample. */
export const dfuRate = ref(0);

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
  deviceBoard.value = null;
  deviceTransports.value = null;
  dfuStatus.value = idleStatus();
  dfuRate.value = 0;
});
/* Smoothing factor for the transfer-rate estimate. Samples arrive a few times
 * a second and an unsmoothed rate flickers by several KB/s between them,
 * which reads as instability rather than as measurement noise. */
const RATE_ALPHA = 0.3;

smp.addEventListener("dfustatus", (e) => {
  const next = e.detail.status;
  const prev = dfuStatus.value;

  /* Between two UPLOADING samples only, and against the device's own elapsed
   * clock. Both halves matter: the clock is monotonic and free of whatever
   * the notification spent queued behind the DFU stream, and measuring from
   * the previous *step* would divide the bytes by the scan and handshake time
   * as well — measured, that understated a real 17.9 KB/s as 15.6. */
  const uploading = next.state === DFU_STATE.UPLOADING &&
                    prev.state === DFU_STATE.UPLOADING;
  const dBytes = next.sent - prev.sent;
  const dMs = next.elapsedMs - prev.elapsedMs;
  if (uploading && next.attempt === prev.attempt && dBytes > 0 && dMs > 0) {
    const sample = (dBytes * 1000) / dMs;
    dfuRate.value = dfuRate.value
      ? dfuRate.value + RATE_ALPHA * (sample - dfuRate.value)
      : sample;
  } else if (!next.active || next.attempt !== prev.attempt) {
    /* A new attempt restarts the image from zero (Legacy DFU cannot resume —
     * Trap 2), so carrying the old rate forward would be a fiction. */
    dfuRate.value = 0;
  }

  /* Two log lines per run, not one per step: the step is on screen in the
   * banner, and the page log is where the user's own actions are recorded. */
  if (next.active && !prev.active) {
    log(`DFU started on the device${next.file ? ` — ${next.file}` : ""}`);
  }
  if (next.terminal && !prev.terminal) {
    log(`DFU ${next.ok ? "succeeded" : "failed"}: ${next.resultLabel}`,
        next.ok ? "ok" : "err");
  }

  dfuStatus.value = next;
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
    deviceBoard.value = await smp.osBoard();
    log(`connected to ${name}${deviceBoard.value ? ` (${deviceBoard.value})` : ""}`, "ok");
    if (!deviceBoard.value) {
      log("this firmware does not report its board — an update built for a " +
          "different board cannot be detected before it is installed", "warn");
    }
    /* What can this build actually flash? Asked rather than inferred from
     * the board, so the client keeps no copy of the firmware's transport
     * table. Older firmware has no such command; that is not an error. */
    try {
      const caps = await smp.fsxCaps();
      deviceTransports.value = transportsFromMask(caps.transports);
      log(`updater transports: ${deviceTransports.value.join(", ")}`);
    } catch {
      log("this firmware does not report its transports — assuming Bluetooth only");
      deviceTransports.value = null;
    }

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

/*
 * Per-file verdicts from the device, keyed by path.
 *
 * Not fetched with the listing: the device reads the whole file to checksum
 * it, so an automatic pass would spend a second per firmware file on every
 * refresh. It is asked for on demand, and the answer is kept until the file's
 * size changes — which is what a re-upload looks like from here.
 */
export const fileInfo = reactive({});

export async function inspectFile(fullpath, size) {
  const held = fileInfo[fullpath];
  if (held && held.size === size && !held.pending) return held;

  fileInfo[fullpath] = { pending: true, size };
  try {
    const info = await smp.fsxInspect(fullpath);
    fileInfo[fullpath] = { ...info, size, pending: false };
  } catch (e) {
    /* Firmware without the command, or busy with a run. Both are "ask
     * later", not "bad file", and must not render as a verdict. */
    fileInfo[fullpath] = { size, pending: false, unavailable: e.message };
  }
  return fileInfo[fullpath];
}

export async function flashFile(fullpath) {
  /* A second, much cheaper check at flash time.
   *
   * The upload check is the thorough one, but it only ever saw files this
   * browser uploaded — a device may be carrying firmware put there by another
   * client, or before these checks existed. This one needs no bytes: the file
   * name says which transport it wants, and the device has already said which
   * board it is.
   */
  const name = fullpath.split("/").pop();

  /* Ask the device about the file it is holding. It is the authority — it
   * reads the actual bytes, and it knows what it was built with — and this
   * covers files this browser never saw: plain SMP uploads from nRF Connect
   * Device Manager never run the upload-time check.
   *
   * A device too old to answer, or busy with a run, is not a reason to
   * refuse: fall through and let the flash attempt report for itself.
   */
  try {
    const info = await smp.fsxInspect(fullpath);
    if (info.name || info.version) {
      log(`${name}: ${[info.name, info.version].filter(Boolean).join(" ")}` +
          `${info.chip ? ` (${info.chip})` : ""}`);
    }
    if (!info.flashable) {
      log(`${name}: ${info.reason || "the updater cannot flash this file"}`, "err");
      return;
    }
  } catch (e) {
    log(`${name}: could not be inspected (${e.message}) — flashing anyway`, "warn");
  }

  /* The confirm says what is about to happen on the radio, which differs per
   * transport and is the part a user can act on: a BLE run scans for a peer,
   * a WiFi run joins the target's own access point and drops this device off
   * anything else it was on. Naming the wrong one is worse than naming
   * neither, so an unrecognised extension gets the generic sentence. */
  const how = {
    [TRANSPORT.BLE]:
      "The updater will scan for a matching BLE peer, connect, and start the " +
      "Legacy DFU sequence.",
    [TRANSPORT.WIFI]:
      "The updater will join the target's own WiFi access point and POST the " +
      "image to its ElegantOTA endpoint. Its radio is shared with Bluetooth, " +
      "so anything else it was doing pauses.",
  }[transportForName(name)] ?? "The updater will pick a transport from the file.";

  if (!confirm(`Flash "${name}" to the DFU target?\n\n${how} ` +
               `Progress appears here as it happens; ` +
               `the device log has the detail.`)) return;
  try {
    await smp.fsxTriggerDfu(fullpath);
    log(`DFU triggered: ${fullpath}`, "ok");
  } catch (e) {
    log(`DFU trigger: ${e.message}`, "err");
  }
}

/*
 * Stop whatever the updater is doing and clear the status.
 *
 * No confirm(). Stop is the button you press *because* something is going
 * wrong, often while watching a retry loop grind, and putting a modal in front
 * of it would be the one dialog guaranteed to be dismissed without reading.
 * It is also cheap to get wrong — Legacy DFU has no resume, so an interrupted
 * transfer costs a retry either way, and re-triggering is one click.
 *
 * Safe to press at any time: the device treats "nothing was running" as a
 * successful clear of the previous run's sticky result.
 */
export const stopping = ref(false);

export async function stopDfu() {
  if (stopping.value) return;
  stopping.value = true;
  try {
    const r = await smp.fsxStopDfu();
    log(r?.stopped ? "stopped — counters and cooldowns cleared"
                   : "nothing was running; status cleared", "ok");
  } catch (e) {
    log(`stop: ${e.message}`, "err");
  } finally {
    stopping.value = false;
  }
}

export function openConfig() { configOpen.value = true; }
export function openFlash() { flashOpen.value = true; }

/* Opening with no path shows the newest log file; `live` opens the stream
 * instead of any file at all. */
export function openLogView(path = "", live = false) {
  logViewPath.value = path;
  logViewLive.value = live;
  logViewOpen.value = true;
}

/* Reboot the updater itself (not the DFU target) via the standard mcumgr OS
 * group. The firmware already answers this: CONFIG_REBOOT=y registers the
 * OS_MGMT_ID_RESET handler, and CONFIG_MCUMGR_GRP_OS_RESET_MS=250 makes it
 * reply first and reset 250 ms later, so the response arrives before the link
 * drops. Losing the link is the expected outcome, not an error. */
export async function reboot() {
  /* The banner knows whether a transfer is running, so the warning can name
   * the actual situation instead of leaving the operator to remember. */
  const mid = dfuActive.value ? "\n\nA DFU IS RUNNING — rebooting now abandons it " +
    "and leaves the target part-flashed." : "";
  if (!confirm("Reboot the updater?\n\n" +
               "The Bluetooth connection will drop and you will need to reconnect. " +
               "Do not do this while a DFU is running." + mid)) return;
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
               `Progress appears here as it happens; the device log has the detail.`)) return;
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

    /* Look at firmware before spending the transfer on it.
     *
     * The alternative is what used to happen: upload half a megabyte at BLE
     * speed, press flash, and find out from whatever the device's parser
     * tripped over first — which is rarely the thing that was actually wrong.
     * Everything checked here is checked from the bytes in hand, at no cost.
     *
     * Errors stop the upload; warnings do not. The line is whether the file
     * could ever be flashed by this device: a damaged archive or an image for
     * a transport this board does not have is a refusal, while a name that
     * disagrees with its contents is the user's business.
     */
    /* Formats nothing here can flash, refused by name before anything else
     * happens. The device refuses these too, on both upload paths — this copy
     * only saves the round trip. */
    const unsupported = unsupportedReason(f.name);
    if (unsupported) {
      log(`upload ${f.name}: refused — ${unsupported}`, "err");
      continue;
    }

    if (isFirmwareName(f.name) && !isConfigPath(dst)) {
      const rep = inspectFirmware(bytes, {
        name: f.name, transports: deviceTransports.value,
      });
      for (const finding of rep.findings) {
        log(`${f.name}: ${finding.message}`,
            finding.level === "error" ? "err" : finding.level === "warn" ? "warn" : "");
      }
      if (!rep.ok) {
        log(`upload ${f.name}: refused — nothing on this device could flash it`, "err");
        continue;
      }
    }

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
    /* The board matters: two of the pacing defaults differ per SoC family,
     * so a key the file omits has to be filled from the right one. */
    const parsed = parseConfig(new TextDecoder().decode(bytes), deviceBoard.value);
    log(`loaded ${CONFIG_PATH} (${bytes.length} B)`, "ok");
    for (const ig of parsed.ignored) {
      log(`${CONFIG_PATH}: ${ig.key}=${ig.value} ignored by firmware — ${ig.reason}`, "err");
    }
    return { ...parsed, exists: true, size: bytes.length };
  } catch (e) {
    log(`${CONFIG_PATH} not readable (${e.message}) — showing firmware defaults`);
    return { values: configDefaults(deviceBoard.value), unknown: [], ignored: [],
             exists: false, size: 0 };
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
