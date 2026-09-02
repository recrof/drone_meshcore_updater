/*
 * Application state + actions.
 *
 * The SmpClient instance is deliberately NOT wrapped in reactive() — it holds
 * live GATT objects, and proxying those breaks identity comparisons inside the
 * Web Bluetooth stack. State that the UI renders is mirrored into refs here.
 */

import { reactive, ref, computed, watch } from "./vue.js";
import { SmpClient, SURVEY_KIND } from "./lib/smp-client.js";
import {
  registerServiceWorker, applyUpdate,
  watchInstall, promptInstall, runningInstalled,
} from "./lib/pwa.js";
import { fmtSize, fmtRate, timestamp, joinPath } from "./lib/format.js";
import {
  CONFIG_PATH, CONFIG_MAX_BYTES, isConfigPath, canonicalUploadPath,
  parseConfig, serializeConfig, encodedSize, defaults as configDefaults,
} from "./lib/config-file.js";
import { inspectFirmware, isFirmwareName, TRANSPORT, transportForName,
         transportsFromMask, unsupportedReason }
  from "./lib/firmware-image.js";
import { isLogPath } from "./lib/log-file.js";
import { idleStatus, STATE as DFU_STATE, RESULT as DFU_RESULT, NEEDS_PIN }
  from "./lib/dfu-status.js";

export const smp = new SmpClient();

/* ---- state ------------------------------------------------------------ */
export const connected  = ref(false);
/* True from the moment Connect is pressed until the link is up and the device
 * has answered. It exists because the header is one toggle now rather than two
 * buttons: with a pair, the disabled half carried the state and the gap between
 * "picker dismissed" and "connected" was merely quiet. With a toggle, that gap
 * is a button still reading "Connect" and still enabled, which is a button that
 * looks like it did nothing. */
export const connecting = ref(false);
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

/* The battery, or null where the device has no way to measure one — which is
 * three of the six boards and a hardware fact, so the indicator is absent
 * rather than empty. Shape is fsxBattery()'s response: { src, mv, pct, chg?,
 * ext? }, where a missing `chg`/`ext` means the device cannot tell and must
 * not be drawn as false. */
export const battery = ref(null);

/*
 * **Pushed where the firmware can push, polled only where it cannot.**
 *
 * The device notifies when the reading actually moves — a charger in or out,
 * or a voltage step past its own threshold — so the events that happen in an
 * instant arrive in an instant. That is the whole reason the GATT service
 * exists: making a poll fast enough to feel immediate would spend an SMP
 * round trip over the DFU's own radio (Trap 4) many times a minute, almost
 * always to learn that nothing changed.
 *
 * The poll stays as the fallback for firmware predating src/battery_status.c,
 * and as the thing that tracks slow drift on a device whose level is falling
 * by less than the notify threshold. It is deliberately slow — a cell moves
 * over tens of minutes — and it is skipped entirely while a run is in flight.
 *
 * When notifications are working the poll is stretched rather than stopped:
 * a subscription that dies quietly (a dropped CCC, a firmware fault) would
 * otherwise freeze the indicator at its last value with nothing to say so.
 */
const BATTERY_POLL_MS = 60000;
const BATTERY_POLL_PUSHED_MS = 300000;
let batteryTimer = null;
let batteryPushed = false;

async function readBattery() {
  if (!connected.value) return;
  try {
    const b = await smp.fsxBattery();
    /* src 0 is "no hardware" — a complete answer, and the same outcome as
     * firmware too old to have the command. Both mean: show nothing. */
    battery.value = (b && b.src) ? b : null;
  } catch {
    battery.value = null;
  }
}

function startBatteryPoll() {
  stopBatteryPoll();
  batteryTimer = setInterval(() => {
    /* Not during a run. See BATTERY_POLL_MS. */
    if (!dfuActive.value) readBattery();
  }, batteryPushed ? BATTERY_POLL_PUSHED_MS : BATTERY_POLL_MS);
}

/* A pushed reading. `null` means the device says it cannot measure one, or
 * sent something this client cannot read — both render as no indicator, so
 * they are one case here. */
smp.addEventListener("battery", (e) => {
  battery.value = e.detail;
});

function stopBatteryPoll() {
  if (batteryTimer) { clearInterval(batteryTimer); batteryTimer = null; }
}
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
  battery.value = null;
  batteryPushed = false;
  stopBatteryPoll();
  dfuStatus.value = idleStatus();
  dfuRate.value = 0;
  /* A retry needs a link to be triggered over. Leaving the ask up would give
   * the operator a dialog whose Send button cannot do anything. */
  pinRequest.value = null;
  lastRun = null;
  /* Stops the poll timer as well as the panel. Without this the interval
   * keeps firing against a dead link forever — harmless per tick, but it is
   * the poll that would otherwise silently keep running for the rest of the
   * session. */
  closeScanner();
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
  const ended = next.terminal && !prev.terminal;

  if (ended) {
    log(`DFU ${next.ok ? "succeeded" : "failed"}: ${next.resultLabel}`,
        next.ok ? "ok" : "err");
  }

  const asking = next.state === DFU_STATE.AWAITING_PIN &&
                 prev.state !== DFU_STATE.AWAITING_PIN;

  dfuStatus.value = next;

  /* Both asks are set *after* the assignment above, so the banner and the
   * scanner panel have the run's real state before anything is rendered over
   * them. Neither needs a macrotask boundary any more — the setTimeout that
   * used to be here existed only to let the page paint before prompt() froze
   * the main thread, and there is no prompt() on this path now.
   *
   * The live path renders off the state itself.
   * What is logged is the moment this client *heard*, so a report of "the
   * dialog was late" can be split into device-side and browser-side latency
   * by comparing this line's timestamp with the device's own. */
  if (asking) {
    log(`${next.name || "the target"} is waiting for a PIN`, "warn");
    /* A pairing held open now beats an offer to retry a run that is over:
     * the digits on the target's screen belong to *this* pairing. */
    pinRequest.value = null;
  }
  if (ended) offerPin(next);
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
  if (connecting.value || connected.value) return;
  connecting.value = true;
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

    /* Once at connect, then on the slow timer. Asked after the transport
     * caps so that a device with neither answers both questions in one
     * exchange rather than delaying the file listing. */
    /* Subscribe first: the firmware pushes the current reading on subscribe,
     * so this usually fills the indicator without a separate round trip. The
     * read below then only does work on firmware too old to have the
     * service. */
    batteryPushed = false;
    try {
      batteryPushed = await smp.startBatteryStatus();
    } catch { batteryPushed = false; }
    if (!batteryPushed) await readBattery();
    if (battery.value) {
      const b = battery.value;
      log(`battery: ${b.mv} mV (~${b.pct}%)` +
          (b.chg === undefined ? "" : b.chg ? ", charging" : ", not charging"));
    }
    startBatteryPoll();

    await refresh();
  } catch (e) {
    log(`connect failed: ${e.message}`, "err");
  } finally {
    /* finally, not the end of try: the browser's device picker throws when it
     * is dismissed, and that is the most common way this function ends. A
     * header stuck on "Connecting…" after someone changed their mind would be
     * a dead control with no way back. */
    connecting.value = false;
  }
}

export async function disconnect() {
  /* The survey is stopped *before* the link goes, not left to the device's
   * idle timeout. closeScanner() sends that stop over the very link this
   * function is about to drop, so the order is the whole point — after
   * smp.disconnect() there is nothing to send it on.
   *
   * The firmware no longer depends on this (a disconnect that leaves a scan
   * running used to leave the device unable to advertise, and it now borrows
   * the radio back), but it is still the honest order: it frees the radio
   * immediately rather than seconds later, and it means the common case never
   * exercises the recovery path at all. */
  await closeScanner();
  smp.disconnect();
}

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
    /* A stable base order only. What the user sees is grouped — config, then
     * flashable files, then logs — and that lives in FileListing.js, which is
     * where a file's kind is worked out. Sorted at all so that anything else
     * reading `entries` (the mapping editor's file suggestions) gets a
     * predictable list rather than device order. */
    all.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
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

/*
 * The run this browser started, so a PIN can be offered for exactly that one.
 *
 * Kept here rather than passed through the status notification because the
 * device does not know who asked: an auto_flash run, another browser, or this
 * one all look identical on the wire. Cleared as soon as a terminal status is
 * read, so a stale entry from an earlier flash cannot be re-triggered by
 * somebody else's failure half an hour later.
 */
let lastRun = null;

const rememberRun = (path, addr, label, pin = "") => {
  lastRun = { path, addr, label, pin };
};

/*
 * The target is displaying a PIN right now. PinDialog.js asks for it.
 *
 * These two are the whole client half of the live path: the dialog opens off
 * `dfuStatus.state === AWAITING_PIN` on its own, so nothing here has to push
 * it. That is deliberate — the first version called prompt() from the status
 * handler, and a native modal is shown when the *browser* feels like it. From
 * the field: the target displayed a PIN, no prompt, the PIN expired, and only
 * then did the prompt appear, asking for a number that was already gone.
 *
 * A component renders on the frame it is asked to, cannot be deferred by a
 * background tab, and does not block the main thread — which matters because
 * this question has a 30 s clock that has to keep running behind it.
 */
export async function submitPin(pin) {
  try {
    const r = await smp.fsxSubmitPin(pin);
    log(r?.taken === false ? "PIN was too late — the target stopped waiting"
                           : "PIN sent", r?.taken === false ? "err" : "ok");
    return r;
  } catch (e) {
    log(`PIN: ${e.message}`, "err");
    return null;
  }
}

/* Dismissing the dialog ends the pairing now rather than leaving the target
 * displaying digits into a timeout nobody is watching. */
export async function cancelPin() {
  try {
    await smp.fsxSubmitPin("");
    log("PIN entry cancelled", "warn");
  } catch (e) {
    log(`PIN: ${e.message}`, "err");
  }
}

/*
 * A target refused the link. Ask for the PIN and run it again.
 *
 * Reactive on purpose: the device says whether a PIN is wanted, so nobody is
 * asked for one when the target does not care — which is every target this
 * project has flashed so far. The cost is one failed attempt before the
 * question, and the firmware does not spend the retry budget on it (an
 * authentication result is terminal), so that attempt is a single connection.
 *
 * Only for a run this browser started. A device flashing on its own has nobody
 * at the keyboard by definition, and popping a prompt at whoever happens to be
 * connected would be asking the wrong person.
 */
function offerPin(status) {
  const run = lastRun;
  lastRun = null;
  if (!run || !NEEDS_PIN.has(status.result)) return;

  /* A ref, not prompt().
   *
   * **This was the last prompt() on the PIN path and it was still firing**,
   * over the top of the dialog that had replaced it. Two questions about the
   * same six digits, from two different rendering systems, arriving in an
   * order nobody could predict — the native one whenever the browser felt
   * like showing it, which is the whole reason the live path stopped using
   * it (see PinDialog.js). It read as random because it *was*: which one you
   * saw first depended on whether the tab was frontmost.
   *
   * Both questions now go through the one dialog. */
  pinRequest.value = {
    ...run,
    rejected: status.result === DFU_RESULT.AUTH_FAILED,
  };
}

/*
 * The retry ask: a run that ended asking for authentication, as opposed to a
 * pairing being held open right now. PinDialog renders whichever is set.
 *
 * Kept apart from `dfuStatus` because it is this client's own bookkeeping —
 * the device has finished and moved on, and a second browser watching the
 * same device must not be asked to answer for a run it did not start.
 */
export const pinRequest = ref(null);

/* Re-run the last flash with a PIN. */
export async function submitRetryPin(pin) {
  const run = pinRequest.value;
  /* The dialog checks this too. Both, because the rule is the firmware's
   * (`ble_pairing.c` accepts one to six digits and nothing else) and this is
   * the last place it can be enforced before a run is spent finding out. */
  if (!/^[0-9]{1,6}$/.test(pin)) {
    log(`"${pin}" is not a PIN — one to six digits`, "err");
    return;
  }
  pinRequest.value = null;
  if (!run) return;

  /* Before the trigger, not after: the run could in principle reach a terminal
   * state while we are still awaiting the response, and a second rejection has
   * to find this recorded or the operator gets one try and silence. */
  rememberRun(run.path, run.addr, run.label, pin);
  try {
    await smp.fsxTriggerDfu(run.path, run.addr, pin);
    log(`DFU re-triggered with a PIN: ${run.label}`, "ok");
  } catch (e) {
    lastRun = null;
    log(`DFU trigger: ${e.message}`, "err");
  }
}

export function cancelRetryPin() {
  pinRequest.value = null;
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
  rememberRun(fullpath, "", name);
  try {
    await smp.fsxTriggerDfu(fullpath);
    log(`DFU triggered: ${fullpath}`, "ok");
  } catch (e) {
    lastRun = null;
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

/* ---- the scanner -------------------------------------------------------
 *
 * A survey of what the updater's radios can hear, with signal strength. It
 * exists because "the update failed" and "there is nothing to update" look
 * identical from here, and so do a deaf antenna and an absent target.
 *
 * Two radios, one at a time — see updater/src/survey.h, which owns that rule.
 * The device says which kinds it has (`kinds`), so the WiFi tab appears only
 * where there is a WiFi radio.
 *
 * The firmware stops a survey nobody has polled for a few seconds, so this
 * poll loop is not a refresh — it is what keeps the scan alive. Closing the
 * panel therefore ends the scan by ceasing to ask, and the explicit stop is
 * just the tidy version of that.
 */
export const scannerOpen  = ref(false);
export const scanEntries  = ref([]);
export const scanning     = ref(false);
export const scanError    = ref("");
export const scanKind     = ref(SURVEY_KIND.BLE);
/* Live updates, on by default — watching the number move while an antenna is
 * aimed is the main thing this screen is for. Turning it off freezes the list
 * so a row can be clicked without it moving. */
export const scanAuto     = ref(true);
/* True from the moment Refresh is pressed until the settle poll lands. It is
 * what stops the button being hammered, and what lets the table say it is
 * rebuilding rather than showing an empty list that reads as "nothing here". */
export const scanRefreshing = ref(false);
/* Bitmask of survey kinds the device has a radio for; null until it answers. */
export const scanKinds    = ref(null);

/* 2.5 s, up from 1.5.
 *
 * The faster rate made the panel unusable for its second job: rows re-sorted
 * under the pointer between a decision and a click, so aiming at a device and
 * pressing Flash hit whichever row had drifted into that spot. Signal is worth
 * watching continuously; a list you are about to click is not.
 *
 * It also has to stay comfortably under the firmware's idle timeout — polling
 * IS the keep-alive (survey.h), so a period longer than that would stop the
 * scan between refreshes. The Bluetooth watchdog is 6 s. */
const SCAN_POLL_MS = 2500;
/* One extra poll after a manual refresh, so a single press produces results
 * rather than arming an empty survey the operator then has to press again. */
const SCAN_SETTLE_MS = 1500;
let scanTimer = null;
let scanSettleTimer = null;
/* The in-flight request itself, not a boolean: a reset has to *wait* for a
 * poll that is already talking to the device, where a periodic tick is right
 * to drop. A flag can only express the second. */
let scanInFlight = null;

async function pollScan({ reset = false } = {}) {
  if (!connected.value || !scannerOpen.value) return;

  /* One request at a time. A slow round trip must not queue a second poll
   * behind it — on a busy link that compounds into a backlog the device
   * answers long after the panel has closed.
   *
   * A reset is the exception and must not be dropped: dropping it leaves the
   * device's table intact, so the settle poll that follows returns the very
   * history the refresh was meant to clear. It waits its turn instead. */
  if (scanInFlight) {
    if (!reset) return;
    await scanInFlight.catch(() => {});
  }

  const run = (async () => {
    const r = await smp.fsxScanAll(true, scanKind.value, reset);
    scanEntries.value = r.entries ?? [];
    scanning.value = !!r.scanning;
    if (typeof r.kinds === "number") scanKinds.value = r.kinds;
    scanError.value = "";
  })();

  scanInFlight = run;
  try {
    await run;
  } catch (e) {
    /* Both refusals are expected states, not faults, and neither should read
     * as an error the operator could act on by retrying. */
    scanning.value = false;
    scanEntries.value = [];
    scanError.value = /busy/i.test(e.message)
      ? "The radio is busy with a transfer — scanning resumes when it finishes."
      : /notsup|not supported/i.test(e.message)
      ? "This board has no radio of that kind."
      : e.message;
  } finally {
    if (scanInFlight === run) scanInFlight = null;
  }
}

/* Switching tabs. The device throws its table away when the kind changes —
 * the two surveys hold different things — so this does too rather than
 * leaving stale rows on screen while the first sweep of the other radio
 * runs. */
export function setScanKind(kind) {
  if (scanKind.value === kind) return;
  if (scanSettleTimer) { clearTimeout(scanSettleTimer); scanSettleTimer = null; }
  scanKind.value = kind;
  scanEntries.value = [];
  scanning.value = false;
  scanError.value = "";
  refreshScan();
}

/* A run starting closes the scanner, from wherever it was started.
 *
 * The device refuses to scan during a DFU (survey.h) and the runner stops any
 * survey when it begins, so leaving the panel open would show a frozen list
 * quietly filling with "the radio is busy" — an accurate message that reads
 * as a malfunction. Watching `dfuActive` rather than closing at each trigger
 * site covers the ones that are not this client: an auto-flash, a run
 * triggered from another browser, or one the device started on its own.
 */
watch(dfuActive, (active) => {
  if (active && scannerOpen.value) {
    log("scan stopped — the radio is needed for the update", "warn");
    closeScanner();
  }
});

/* One sweep, on demand.
 *
 * Three things have to happen here and each fixes a way the button looked
 * broken:
 *
 *   1. **The table is emptied on screen straight away.** Otherwise the old
 *      rows sit there for the whole settle delay and the press appears to do
 *      nothing for a second or two.
 *   2. **The device is told to reset**, not merely polled. A survey that is
 *      still running keeps its table by design — `best` and the sighting
 *      counts are accumulated history — so without this the refresh returns
 *      everything heard since the survey started, including devices long gone,
 *      each showing the signal it had when it was last heard. Nothing ages
 *      out, so that only gets worse the longer the panel is open.
 *   3. **A pending settle poll is cancelled.** Pressing twice in quick
 *      succession otherwise leaves the first press's timer to land after the
 *      second press cleared the table, refilling it with the earlier sweep.
 */
export function refreshScan() {
  if (scanSettleTimer) { clearTimeout(scanSettleTimer); scanSettleTimer = null; }
  scanEntries.value = [];
  scanError.value = "";
  scanRefreshing.value = true;

  pollScan({ reset: true });
  scanSettleTimer = setTimeout(async () => {
    scanSettleTimer = null;
    await pollScan();
    scanRefreshing.value = false;
  }, SCAN_SETTLE_MS);
}

export function setScanAuto(on) {
  scanAuto.value = on;
  if (on) {
    if (!scanTimer) scanTimer = setInterval(pollScan, SCAN_POLL_MS);
    pollScan();
  } else if (scanTimer) {
    clearInterval(scanTimer);
    scanTimer = null;
    /* The survey is left running: its own idle timeout ends it a few seconds
     * later, which is what freezes the list. Stopping it here would be
     * indistinguishable to the operator and would throw away the table. */
  }
}

export function openScanner() {
  scannerOpen.value = true;
  scanEntries.value = [];
  scanError.value = "";
  scanning.value = false;
  pollScan();
  if (scanAuto.value && !scanTimer) {
    scanTimer = setInterval(pollScan, SCAN_POLL_MS);
  }
}

export function closeScanner() {
  const wasOpen = scannerOpen.value;
  scannerOpen.value = false;
  if (scanTimer) { clearInterval(scanTimer); scanTimer = null; }
  if (scanSettleTimer) { clearTimeout(scanSettleTimer); scanSettleTimer = null; }
  scanRefreshing.value = false;
  scanning.value = false;
  /* Best-effort, and only if something was actually started: the firmware's
   * idle timeout is the real guarantee, and this request is exactly the kind
   * that fails when a link has just dropped — which is one of the ways this
   * function gets called. */
  return (wasOpen && connected.value)
    ? smp.fsxScan(false, scanKind.value).catch(() => {})
    : Promise.resolve();
}

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
/* Flash one named file at one specific peer, chosen from the scanner.
 *
 * Deliberately not routed through flashFile(): that one asks the device to
 * pick a target using `ble_name` and `min_rssi`, and the entire point here is
 * that the operator has overruled both. The confirm therefore says which
 * device, not which rules.
 */
export async function flashToTarget(fullpath, addr, label) {
  const name = fullpath.split("/").pop();
  const who = label || addr;
  if (!confirm(`Flash "${name}" to ${who}?\n\n` +
               `The updater will look for this exact device — the name filter ` +
               `and minimum-signal setting do not apply — connect, and start ` +
               `the Legacy DFU sequence.\n\n` +
               `Progress appears here as it happens; the device log has the detail.`)) {
    return false;
  }
  rememberRun(fullpath, addr, who);
  try {
    await smp.fsxTriggerDfu(fullpath, addr);
    log(`DFU triggered: ${name} -> ${who}`, "ok");
    /* The run owns the radio from here, so the survey is over whether we say
     * so or not. Closing the panel makes that visible instead of leaving a
     * frozen list that quietly fills with "radio is busy". */
    closeScanner();
    return true;
  } catch (e) {
    lastRun = null;
    log(`DFU trigger: ${e.message}`, "err");
    return false;
  }
}

export async function autoFlash() {
  if (!confirm(`Auto-flash the next matching target?\n\n` +
               `The updater will scan for a BLE peer, match its advertised name ` +
               `against the rules in ble_firmware_mapping, and flash whichever ` +
               `bundle those rules select. Set the rules under Config… first.\n\n` +
               `Progress appears here as it happens; the device log has the detail.`)) return;
  rememberRun("", "", "the target");
  try {
    await smp.fsxTriggerDfu("");
    log("auto-flash triggered — bundle chosen by ble_firmware_mapping", "ok");
  } catch (e) {
    lastRun = null;
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

/* Set when the browser has offered us an install and we have not used it.
 *
 * It starts false and stays false on everything that cannot install: Firefox,
 * every browser on iOS, and a page that is already running installed. That is
 * why the header shows a button only when this is true rather than a disabled
 * one with a reason — the usual preference here — since on those platforms
 * there is no reason to give and nothing the user could do about it. */
export const installReady = ref(false);

export async function installApp() {
  const outcome = await promptInstall();
  /* Single-use either way: Chrome fires a fresh beforeinstallprompt if the
   * page becomes installable again, and leaving the button up after a
   * dismissal would give us one that does nothing on the second press. */
  installReady.value = false;
  if (outcome === "dismissed") log("install dismissed");
}

export function initOffline() {
  watchInstall({
    onAvailable: (v) => { installReady.value = v && !runningInstalled(); },
    onInstalled: () => log("installed — the updater now opens as its own app", "ok"),
  });
  return registerServiceWorker({
    onLog: log,
    onUpdate: () => { updateReady.value = true; },
  });
}
