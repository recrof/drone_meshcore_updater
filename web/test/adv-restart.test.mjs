/*
 * The updater must never be left unable to advertise. Dependency-free:
 *
 *   node web/test/adv-restart.test.mjs
 *
 * This is a *structural* test, and the reason it is worth having is that the
 * bug it locks out was invisible in every functional sense: the firmware
 * built, booted, connected, scanned, flashed, and logged one line before
 * disappearing off the air for good.
 *
 * ---- what actually went wrong -------------------------------------------
 *
 * Restarting a connectable advertiser makes Zephyr's host put the identity
 * address back with HCI LE Set Random Address (bt_id_set_adv_own_addr(), the
 * "If Static Random address is used as Identity address we need to restore it
 * before advertising is enabled" branch). That command is Command Disallowed
 * while a scan is enabled, because the active scan is using an NRPA. So on any
 * controller without extended advertising — every board here but the MG24 —
 *
 *     bt_le_adv_start() cannot succeed while ble_scanner.c is scanning.
 *
 * on_disconnected() made exactly one attempt and logged the failure. A user
 * who disconnected with the scanner panel open therefore got a device that
 * was not advertising and never would again: the survey released the radio
 * six seconds later, with nothing left to notice. The recovery is a power
 * cycle, on hardware chosen for being out of reach.
 *
 * ---- what is enforced here ----------------------------------------------
 *
 * Three invariants, each of which was false before the fix:
 *
 *   1. Advertising is started from ONE place in main.c. A second bare
 *      bt_le_adv_start() somewhere is how the retry gets bypassed.
 *   2. The disconnect path schedules that work; it does not attempt the
 *      start itself. It runs in the host's own context and the start may now
 *      need synchronous HCI either side of it.
 *   3. The retry reschedules itself on failure, so "the radio is busy right
 *      now" is a delay and not a permanent state.
 *
 * Plus the scanner side: one shared set of scan parameters, because
 * ble_scanner_with_radio_paused() restarts a scan that somebody else started
 * and has to put back what was there.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SRC = join(ROOT, "updater", "src");

let bad = 0;
const t = (name, cond, extra = "") => {
  console.log(`${cond ? "  ok  " : "  FAIL"} ${name}${extra ? `  [${extra}]` : ""}`);
  if (!cond) bad++;
};

/* Comments here quote the very calls being counted — see the header above,
 * which names bt_le_adv_start() four times. */
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const main = strip(readFileSync(join(SRC, "main.c"), "utf8"));
const scanner = strip(readFileSync(join(SRC, "ble_scanner.c"), "utf8"));
const scannerH = strip(readFileSync(join(SRC, "ble_scanner.h"), "utf8"));

/* The body of a top-level function, by brace matching from its opening `{`.
 * Enough for this file: these are all plain C functions at column 0. */
function body(src, signature) {
  const at = src.indexOf(signature);
  if (at < 0) return null;
  const open = src.indexOf("{", at);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(open, i + 1);
  }
  return null;
}

console.log("advertising restart");

/* ---- 1. one start site ------------------------------------------------- */
const advStarts = [...main.matchAll(/bt_le_adv_start\s*\(/g)].length;
t("bt_le_adv_start() is called from exactly one place in main.c",
  advStarts === 1, `${advStarts} call sites`);

const raw = body(main, "static int adv_start_raw(void)");
t("...and that place is adv_start_raw()",
  raw !== null && /bt_le_adv_start\s*\(/.test(raw));

/* -EALREADY means we are already advertising, which is the success this is
 * asking about — treating it as failure would retry forever against a device
 * that is on the air. */
t("adv_start_raw() treats -EALREADY as success",
  raw !== null && /EALREADY/.test(raw));

/* ---- 2. the disconnect path schedules, it does not attempt -------------- */
const disc = body(main, "static void on_disconnected(struct bt_conn *conn, uint8_t reason)");
t("on_disconnected() exists", disc !== null);
t("on_disconnected() schedules the restart work",
  disc !== null && /k_work_reschedule\s*\(\s*&s_adv_restart/.test(disc));
t("on_disconnected() does not start advertising inline",
  disc !== null && !/bt_le_adv_start/.test(disc));

/* ---- 3. the retry retries ---------------------------------------------- */
const fn = body(main, "static void adv_restart_fn(struct k_work *work)");
t("adv_restart_fn() exists", fn !== null);
t("adv_restart_fn() reschedules itself when the start fails",
  fn !== null && /k_work_reschedule\s*\(\s*&s_adv_restart/.test(fn));
t("adv_restart_fn() falls back to borrowing the radio off the scanner",
  fn !== null && /ble_scanner_with_radio_paused/.test(fn));

/* The helper is the whole fix for the case the scanner is running, so a
 * declaration and a definition that drift apart would take it out silently. */
t("ble_scanner_with_radio_paused() is declared in the header",
  /int\s+ble_scanner_with_radio_paused\s*\(\s*int\s*\(\s*\*\s*fn\s*\)\s*\(\s*void\s*\)\s*\)\s*;/.test(scannerH));
t("...and defined in ble_scanner.c",
  /int\s+ble_scanner_with_radio_paused\s*\(\s*int\s*\(\s*\*\s*fn\s*\)\s*\(\s*void\s*\)\s*\)\s*\n?\s*\{/.test(scanner));

console.log("scanner radio");

/* ---- 4. one set of scan parameters -------------------------------------- */
const scanStarts = [...scanner.matchAll(/bt_le_scan_start\s*\(\s*([^,]+),/g)].map(m => m[1].trim());
t("every bt_le_scan_start() uses the shared parameters",
  scanStarts.length > 0 && scanStarts.every(a => a === "&s_scan_params"),
  scanStarts.join(", "));

/* A scan start that fails must hand the radio back. It did not, and the
 * consequence was a device that answered -EBUSY to every later survey and
 * blamed a DFU that was not running. */
const wait = body(scanner, "static int scan_and_wait(uint32_t timeout_ms)");
t("scan_and_wait() releases the radio when the scan will not start",
  wait !== null &&
  /bt_le_scan_start[\s\S]*?if\s*\(rc\)\s*\{[\s\S]*?atomic_set\s*\(\s*&s_radio\s*,\s*RADIO_IDLE\s*\)/.test(wait));

const survey = body(scanner, "int ble_scanner_survey_start(void)");
t("ble_scanner_survey_start() releases the radio when the scan will not start",
  survey !== null &&
  /bt_le_scan_start[\s\S]*?if\s*\(rc\)\s*\{[\s\S]*?atomic_set\s*\(\s*&s_radio\s*,\s*RADIO_IDLE\s*\)/.test(survey));

/* ---- 5. the client stops the survey before it drops the link ------------ */
const store = readFileSync(join(ROOT, "web", "js", "store.js"), "utf8");
const disconnectFn = body(store, "export async function disconnect()");
t("the client's disconnect() closes the scanner first",
  disconnectFn !== null &&
  disconnectFn.indexOf("closeScanner") >= 0 &&
  disconnectFn.indexOf("closeScanner") < disconnectFn.indexOf("smp.disconnect"));

console.log(bad === 0 ? "\nPASS" : `\n${bad} FAILED`);
process.exit(bad === 0 ? 0 : 1);
