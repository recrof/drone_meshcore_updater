/*
 * The BLE link teardown, and the sweep that breaks the advertise deadlock.
 *
 *   node web/test/ble-link.test.mjs
 *
 * ---- What this can and cannot check ------------------------------------
 *
 * This is firmware behaviour node cannot execute, so these are structural
 * checks on the source. That is a weaker thing than the round-trip tests
 * elsewhere in this directory and it is worth being explicit about: a passing
 * run here means the guards are still shaped the way the reasoning requires,
 * not that a link is actually torn down on hardware.
 *
 * They are still worth having, because both defects they encode are *absences*
 * — a missing disconnect and a missing role check — and an absence is exactly
 * what a reviewer's eye slides over.
 *
 * ---- The deadlock ------------------------------------------------------
 *
 * A BLE peripheral in a connection does not advertise. So a run that ends with
 * the target still holding the link leaves it silent: the next scan cannot see
 * it, every retry fails at the scan rather than at whatever actually broke,
 * and nothing short of power-cycling the target recovers it. For a repeater on
 * a mast that is a trip.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (p) => readFileSync(join(ROOT, p), "utf8");

let bad = 0;
const t = (name, ok, extra = "") => {
  console.log(`${ok ? "  ok  " : "  FAIL"} ${name}${extra ? `  [${extra}]` : ""}`);
  if (!ok) bad++;
};

const client = read("updater/src/dfu_client.cpp");
const tport  = read("updater/src/transport_ble.c");

/* --- the role discriminator, against Zephyr's own enum ------------------ */

let conn_h = "";
try { conn_h = read("zephyr/include/zephyr/bluetooth/conn.h"); } catch { /* not checked out */ }

if (!conn_h) {
  console.log("  skip  zephyr/ not checked out; role constants not cross-checked");
} else {
  const central = /BT_CONN_ROLE_CENTRAL\s*=\s*(\d+)/.exec(conn_h)?.[1];
  const periph  = /BT_CONN_ROLE_PERIPHERAL\s*=\s*(\d+)/.exec(conn_h)?.[1];
  t("Zephyr defines both roles", central === "0" && periph === "1",
    `central=${central} peripheral=${periph}`);
}

/* The safety-critical half. We are peripheral for exactly one thing — the
 * browser's SMP link, the one that asked for this run — and central for every
 * DFU target. Sweeping the wrong way round would drop the operator's own
 * connection on every attempt. */
t("the sweep closes central links only",
  /info\.role\s*!=\s*BT_CONN_ROLE_CENTRAL[\s\S]{0,60}return;/.test(tport));
t("and says why the other one is untouchable",
  /browser|SMP link/i.test(tport));
t("it is restricted to LE connections",
  /info\.type\s*!=\s*BT_CONN_TYPE_LE/.test(tport));

/* --- the sweep runs before every attempt -------------------------------- */

/* Compared by position inside ble_find's body rather than by a bounded
 * regex: the pin-parsing block sits between the two and a character budget
 * would have to be re-guessed every time that grows. */
{
  const fn = tport.slice(tport.indexOf("static int ble_find("));
  const body = fn.slice(0, fn.indexOf("\n}"));
  const swept = body.indexOf("ble_reset_stale_links()");
  const looked = body.search(/ble_scanner_find/);
  t("ble_find sweeps stale links", swept >= 0, String(swept));
  t("...before it looks for anything",
    swept >= 0 && looked >= 0 && swept < looked, `sweep@${swept} scan@${looked}`);
}
/* One disconnect request is not a disconnect: Trap 3 has a pending ATT
 * request holding a link open well past our own terminate. */
t("the sweep confirms the links actually went",
  /for \(int i = 0; i < \d+; i\+\+\)[\s\S]{0,300}bt_conn_foreach/.test(tport));
/* A peripheral does not resume advertising the instant a link drops. Scanning
 * through that window is not harmful but it is wasted, and on a short
 * scan_timeout it is the difference between finding the target and reporting
 * that there is none. */
t("and gives the peer time to advertise again",
  /k_sleep\(K_MSEC\(\d+\)\);[\s\S]{0,200}$|advertising again|resume advertising/i.test(tport));

/* --- the leak that caused it -------------------------------------------- */

const dar = client.slice(client.indexOf("void disconnect_and_release"));
const body = dar.slice(0, dar.indexOf("\n}"));

/* The original guard was `if (s_link.connected)` around the disconnect. On the
 * connect-timeout path `connected` is false *because the connection has not
 * completed yet* — there is an initiator running that unref alone does not
 * stop. If the peer answers just after our window closes, the link comes up
 * with nobody holding it and nothing ever terminates it. */
t("disconnect_and_release always terminates",
  /if \(s_link\.connected\)\s*\{[\s\S]{0,80}bt_conn_disconnect/.test(body) === false,
  "the disconnect must not be conditional on believing the link is up");
t("...and it does call disconnect", /bt_conn_disconnect\(/.test(body));
t("...before unref, not after",
  body.indexOf("bt_conn_disconnect(") < body.indexOf("bt_conn_unref("));
/* Already gone is a success, not a failure worth logging as one. */
t("a link that is already down is not an error", /ENOTCONN/.test(body));
t("it still waits for the link to actually go", /k_sem_take\(&s_link\.sem/.test(body));

console.log(bad ? `\n${bad} FAILURES` : "\nall ble-link tests passed");
process.exit(bad ? 1 : 0);
