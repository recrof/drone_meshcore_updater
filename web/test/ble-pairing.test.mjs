/*
 * The BLE PIN path, held together across the five files that have to agree.
 * No dependencies — run with:  node web/test/ble-pairing.test.mjs
 *
 * Everything here is a *silent* failure. A target that wants a PIN is rare,
 * none of the five boards in this project is one, and the whole feature is
 * dormant until somebody points the updater at a MeshCore repeater in a field.
 * So none of these defects can be noticed by using the thing:
 *
 *  - Lose CONFIG_BT_SMP and the callbacks compile, register, and are never
 *    called; the target fails as though its DFU characteristic were missing,
 *    which is the exact misdiagnosis this feature was written to end.
 *  - Swap dfu_runner_start's `pin` and `passkey` — two adjacent `const char *`
 *    that mean an address and a credential — and every board still builds.
 *  - Turn the auth verdict's `goto fail` into a `break` and an unattended run
 *    asks the same peer the same question five times.
 *  - Drop a `rememberRun()` and one of the three ways to start a flash quietly
 *    loses the ability to be retried with a PIN.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { CONFIG_SCHEMA } from "../js/lib/config-file.js";
import { RESULT, RESULT_LABEL, NEEDS_PIN } from "../js/lib/dfu-status.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (p) => readFileSync(join(ROOT, p), "utf8");

const prj       = read("updater/prj.conf");
const pairingC  = read("updater/src/ble_pairing.c");
const pairingH  = read("updater/src/ble_pairing.h");
const configH   = read("updater/src/config.h");
const configC   = read("updater/src/config.c");
const runnerC   = read("updater/src/dfu_runner.c");
const runnerH   = read("updater/src/dfu_runner.h");
const fsxC      = read("updater/src/fsx_mgmt.c");
const mainC     = read("updater/src/main.c");
const storeJs   = read("web/js/store.js");
const smpJs     = read("web/js/lib/smp-client.js");

/*
 * Source with comments removed.
 *
 * Three checks in this file have already passed or failed on prose rather than
 * code — a block that *explains* why it no longer calls bt_conn_auth_cancel(),
 * a log message containing the word "passkey", a comment saying "it was
 * prompt()". Every one of those is a comment doing its job. Search the code.
 */
const codeOf = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "");

let bad = 0;
const t = (name, cond, extra = "") => {
  console.log(`${cond ? "  ok  " : "  FAIL"} ${name}${cond ? "" : "  " + extra}`);
  if (!cond) bad++;
};

/* --- the Kconfig the feature is entirely built on ----------------------- */

/* A Kconfig line in prj.conf is a request, not a fact — but its *absence* is
 * decisive, and that is the half worth testing here. ble_pairing.c carries a
 * BUILD_ASSERT for the other half. */
t("prj.conf enables CONFIG_BT_SMP",
  /^CONFIG_BT_SMP=y$/m.test(prj));

/* Legacy pairing, and the reason it has to be spelled out: BT_SMP_SC_PAIR_ONLY
 * is `default y` upstream, so it arrives with BT_SMP and silently refuses every
 * peer that does not do LE Secure Connections. The targets here run Nordic
 * Legacy DFU — old nRF5 firmware — which is exactly that set. It failed on
 * hardware as "authentication requirements not met" with no passkey callback,
 * because no pairing method was ever chosen. */
t("prj.conf re-enables legacy pairing",
  /^CONFIG_BT_SMP_SC_PAIR_ONLY=n$/m.test(prj));

/* **Not** BONDABLE=n. That does not mean "forget the key afterwards" — it means
 * telling the peer we refuse to bond, which a peer that requires bonding
 * rejects at the same feature exchange. Not keeping keys is BT_SETTINGS=n,
 * below, which is a different setting entirely. */
t("prj.conf does not refuse to bond",
  !/^CONFIG_BT_BONDABLE=n$/m.test(prj));

/* The half that actually keeps keys off this device: without it the LTK is
 * written to settings and survives a reboot, and a stale bond then fails
 * pairing in a way that reads as a wrong PIN. */
t("...and keeps them out of flash instead",
  !/^CONFIG_BT_SETTINGS=y$/m.test(prj));

t("ble_pairing.c asserts BT_SMP at compile time",
  /BUILD_ASSERT\(IS_ENABLED\(CONFIG_BT_SMP\)/.test(pairingC));

/* The elevate-and-retry is Zephyr's, and it is the part that does the work:
 * without it an ATT request refused for security is failed rather than held,
 * so supplying a passkey would change nothing. */
t("ble_pairing.c asserts BT_ATT_RETRY_ON_SEC_ERR at compile time",
  /BUILD_ASSERT\(IS_ENABLED\(CONFIG_BT_ATT_RETRY_ON_SEC_ERR\)/.test(pairingC));

/* --- nothing pairs unless the peer asks --------------------------------- */

/* The property that made this safe to switch on for five boards that already
 * complete DFUs: no security procedure is ever *started* by us, so a target
 * that asks for nothing sees no change at all. One bt_conn_set_security() call
 * anywhere in the firmware would quietly retire that guarantee. */
const sources = [pairingC, runnerC, fsxC, mainC, read("updater/src/dfu_client.cpp"),
                 read("updater/src/transport_ble.c"), read("updater/src/ble_scanner.c")];
t("nothing initiates security — elevation is left to Zephyr's ATT retry",
  sources.every((s) => !/bt_conn_set_security\s*\(/.test(s)));

/* --- dfu_runner_start's two same-typed neighbours ----------------------- */

/*
 * `pin` is an address and `passkey` is a credential, they are adjacent, and
 * they are both `const char *`. Swapping them compiles, links, and produces a
 * run that looks for a peer named "123456" while offering a PIN of
 * "E9:52:9F:23:87:4A (random)". Nothing in a build or a boot would say so.
 */
const startDecl = runnerH.match(/int\s+dfu_runner_start\s*\(([^;]*)\)\s*;/s);
t("dfu_runner_start is declared once", !!startDecl);
if (startDecl) {
  const params = startDecl[1].split(",").map((p) => p.trim());
  t("dfu_runner_start takes (zip_path, pin, passkey) in that order",
    params.length === 3 &&
    /\bzip_path$/.test(params[0]) && /\bpin$/.test(params[1]) &&
    /\bpasskey$/.test(params[2]),
    JSON.stringify(params));
}

const startDef = runnerC.match(/int\s+dfu_runner_start\s*\(([^)]*)\)\s*\n?\{/s);
t("the definition's parameter order matches the declaration",
  !!startDef && /zip_path[\s\S]*\bpin\b[\s\S]*\bpasskey\b/.test(startDef[1]),
  startDef ? startDef[1].replace(/\s+/g, " ") : "not found");

/* Both strings are copied into their own buffers, and into the *right* one. */
t("zip_path, pin and passkey are each stored separately",
  /snprintf\(s_path,[^;]*zip_path/.test(runnerC) &&
  /snprintf\(s_pin,[^;]*\bpin\b/.test(runnerC) &&
  /snprintf\(s_passkey,[^;]*\bpasskey\b/.test(runnerC));

/* Every call site passes three arguments. A two-argument call would not
 * compile, but a call that passes the *same* string twice would. */
for (const [file, src] of [["fsx_mgmt.c", fsxC], ["main.c", mainC]]) {
  /* `dfu_runner_start()` also appears in prose in both files, with no
   * arguments at all. Those are mentions, not calls. */
  const calls = [...src.matchAll(/dfu_runner_start\(([^)]*)\)/g)]
    .map((m) => m[1].trim())
    .filter((a) => a !== "");
  t(`${file} calls dfu_runner_start with three arguments`,
    calls.length > 0 && calls.every((a) => a.split(",").length === 3),
    JSON.stringify(calls));
  /* An unattended run passes NULL three times, which is correct and is the
   * one case where repeating an argument is not a swap. Everything else must
   * pass three different expressions — the failure being guarded against is
   * an address handed to the passkey parameter, or the reverse. */
  t(`${file} never passes the same non-NULL expression twice`,
    calls.every((a) => {
      const args = a.split(",").map((x) => x.trim()).filter((x) => x !== "NULL");
      return new Set(args).size === args.length;
    }),
    JSON.stringify(calls));
}

/* --- the fleet default, and the per-run override ------------------------ */

t("the runner prefers a per-run PIN over config.txt's ble_pin",
  /ble_pairing_set_passkey\(s_passkey\[0\]\s*\?\s*s_passkey\s*:\s*cfg->ble_pin\)/
    .test(runnerC));

t("config.h declares ble_pin and config.c parses the key",
  /char\s+ble_pin\[APP_CONFIG_PIN_MAX\];/.test(configH) &&
  /!strcmp\(key,\s*"ble_pin"\)/.test(configC));

/*
 * The field is deliberately wider than a legal passkey.
 *
 * Six digits plus a terminator would hold every valid value — and would turn
 * an invalid one into a valid lookalike, because config.c's snprintf() clips
 * "1234567" to "123456" and hands ble_pairing.c a PIN nobody chose, which the
 * peer then rejects as an authentication failure that reads like a typo.
 * Tidying this constant down to 7 is the whole defect.
 */
const pinMax = Number(configH.match(/#define\s+APP_CONFIG_PIN_MAX\s+(\d+)/)?.[1]);
t("APP_CONFIG_PIN_MAX leaves room for an over-long value to be refused",
  pinMax > 7, `APP_CONFIG_PIN_MAX=${pinMax}`);

/* --- an authentication verdict is terminal, not retried ----------------- */

/*
 * The point of the override is one connection instead of five. `break` here
 * instead of `goto fail` puts an unattended auto_flash run back into the retry
 * loop to ask the same peer the same question, once per cooldown, for as long
 * as `retries` allows — and every one of those attempts looks, in the log,
 * exactly like the first.
 */
const verdictAt = runnerC.indexOf("int auth = ble_pairing_verdict();");
t("the runner reads ble_pairing_verdict() after a failed attempt",
  verdictAt > 0);
/* Bounded at the `switch (r)` that follows, because that switch is full of the
 * `break;`s this test is looking for the absence of. */
const switchAt = runnerC.indexOf("switch (r) {", verdictAt);
const verdictBlock = verdictAt > 0 && switchAt > verdictAt
  ? runnerC.slice(verdictAt, switchAt) : "";
t("an authentication verdict ends the run instead of retrying",
  /goto fail;/.test(verdictBlock) && !/\bbreak;/.test(verdictBlock) &&
  !/\bcontinue;/.test(verdictBlock),
  verdictBlock.replace(/\s+/g, " ").slice(0, 200));

/* --- the wire ----------------------------------------------------------- */

/* Both halves of one CBOR key. A rename on either side is accepted, decodes to
 * nothing, and the device falls back to `ble_pin` — so the PIN the operator
 * typed is silently ignored and the failure is identical to not having typed
 * one. */
t("fsx_mgmt.c decodes a `pin` key on TRIGGER_DFU",
  /ZCBOR_MAP_DECODE_KEY_DECODER\("pin",\s*zcbor_tstr_decode/.test(fsxC));
t("smp-client.js sends the same `pin` key",
  /fsxTriggerDfu\(path,\s*addr\s*=\s*"",\s*pin\s*=\s*""\)/.test(smpJs) &&
  /if \(pin\) req\.pin = pin;/.test(smpJs));

/* The three arguments stay in the operator's order on the wire too. */
t("smp-client.js passes addr and pin to distinct request keys",
  /req\.addr = addr;/.test(smpJs) && /req\.pin = pin;/.test(smpJs));

/* --- the PIN does not end up in a log ----------------------------------- */

/*
 * The device log is streamed live over GATT *and* written to /lfs1/LOG.NNNN,
 * which is downloadable by anyone who can connect. A credential that exists in
 * config.txt is in one place; one that also exists in three log files is in
 * four, and only the first can be changed by editing anything.
 */
/* The message text is allowed to say "passkey" — it has to, to be readable.
 * What must never appear is the *value*, so the string literals are stripped
 * first and only the format arguments are searched. */
const stripLiterals = (s) => s.replace(/"(?:[^"\\]|\\.)*"/g, '""');
const logsPasskey = [...pairingC.matchAll(/LOG_(?:ERR|WRN|INF|DBG)\(([\s\S]*?)\);/g)]
  .map((m) => stripLiterals(m[1]))
  .filter((args) => /\b(s_passkey|passkey|key|val)\b/.test(args));
t("ble_pairing.c never logs the passkey value",
  logsPasskey.length === 0, JSON.stringify(logsPasskey));

t("fsx_mgmt.c logs whether a PIN was sent, not what it was",
  /pin=%s[\s\S]{0,200}pin\[0\] \? "yes" : "no"/.test(fsxC));

/* --- one digits rule, stated in three languages ------------------------- */

/*
 * The firmware refuses anything that is not one to six digits; the config
 * editor refuses to save it; the retry prompt refuses to send it. Three
 * independent implementations of the same sentence, and the two client-side
 * ones exist to fail *before* a round trip rather than after one — so they
 * have to agree with the firmware or they reject something it would accept.
 */
t("ble_pairing.c accepts at most six digits",
  /len <= 6/.test(pairingC) && /isdigit\(/.test(pairingC));

/* A pairing that fails before a method is chosen never runs passkey_entry, so
 * the verdict cannot be inferred from whether that callback fired. It has to
 * ask what we were holding — otherwise a run that offered no PIN reports that
 * the target rejected one. That is what the first hardware run did. */
t("a pairing failure with no PIN in hand reports AUTH_REQUIRED",
  /atomic_get\(&s_passkey\) < 0\) \{\s*record\(DFU_STATUS_RESULT_AUTH_REQUIRED\);/
    .test(pairingC));

/* Silence meant two different things in the first field log: no PIN set, and
 * the line scrolled off. Only one of them is worth acting on. */
t("and the no-PIN case says so at the start of the run",
  /no PIN configured for this run/.test(pairingC));

const pinField = CONFIG_SCHEMA.find((f) => f.key === "ble_pin");
t("the config schema has a ble_pin field", !!pinField);
if (pinField) {
  t("the schema caps ble_pin at six characters", pinField.maxLength === 6);
  t("the schema's check accepts a valid PIN and empty",
    pinField.check("123456") === null && pinField.check("0") === null &&
    pinField.check("") === null);
  t("the schema's check refuses non-digits and over-long values",
    pinField.check("12x") !== null && pinField.check("1234567") !== null);
  /* type="text", not "number": a PIN is a string of digits, not a quantity,
   * and a number input drops a leading zero on the way to the device. */
  t("ble_pin is a text field", pinField.type === "text");
}

const storeRe = storeJs.match(/if \(!(\/\^\[0-9\]\{1,6\}\$\/)\.test\(pin\)\)/);
t("store.js validates the typed PIN with the same rule",
  !!storeRe, "no /^[0-9]{1,6}$/ test in the retry path");

/* --- the parked pairing: the display must survive being asked about ----- */

/*
 * The reported bug, and the only thing that fixes it.
 *
 * A peer that *displays* a passkey generates it for that pairing, and stops
 * displaying it the moment the pairing ends. The first version called
 * bt_conn_auth_cancel() the instant it found no PIN configured — so it
 * destroyed the number at the exact moment it asked somebody to read it, and
 * the retry that followed was answering a question about a number that no
 * longer existed. Reported from the field as "the PIN goes away too quickly".
 *
 * A `bt_conn_auth_cancel()` anywhere in on_passkey_entry's no-key branch puts
 * that back.
 */
{
  const fn = pairingC.match(/static void on_passkey_entry[\s\S]*?\n\}/);
  t("on_passkey_entry exists", !!fn);
  const noKey = fn && fn[0].match(/if \(key < 0\) \{[\s\S]*?\n\t\}/);
  t("the no-PIN branch was found", !!noKey);
  const code = codeOf(noKey?.[0] ?? "");
  t("...and it parks the pairing instead of cancelling it",
    !!noKey && !/bt_conn_auth_cancel\s*\(/.test(code) &&
    /s_waiting = bt_conn_ref\(conn\)/.test(code), code.replace(/\s+/g, " ").slice(0, 160));
  t("...and publishes AWAITING_PIN so a client can prompt in time",
    !!noKey && /dfu_status_set_state\(DFU_STATUS_AWAITING_PIN\)/.test(noKey[0]));
}

/* The parked reference is held across threads, so it has to be released on
 * every way out or the conn leaks — and a leaked central link is Trap 11, the
 * one that stops the target advertising for good. */
t("the parked pairing is released when it completes",
  /on_pairing_complete[\s\S]{0,300}forget_waiting\(\)/.test(pairingC));
t("...and when it fails",
  /on_pairing_failed[\s\S]{0,300}forget_waiting\(\)/.test(pairingC));

/* Dismissing the prompt has to end the pairing now, not leave the target
 * displaying digits into a 30 s timeout. */
t("an empty submission cancels the parked pairing",
  /passkey\[0\] == '\\0'\) \{[\s\S]{0,300}bt_conn_auth_cancel\(s_waiting\)/
    .test(pairingC));

/* A malformed PIN must not burn the pairing: the operator gets another go
 * inside the same window rather than restarting a whole run for a typo. */
t("a malformed submission leaves the pairing alone",
  /submitted PIN is not one to six digits/.test(pairingC) &&
  !/submitted PIN is not one to six digits[\s\S]{0,200}forget_waiting/.test(pairingC));

/* The BT RX thread carries the SMP state machine now, on top of the fs path it
 * already had. 2048 was measured crashing on the ESP32-S3 — EXCCAUSE 5, the
 * Xtensa windowed-ABI stack exception — on the one board with no hardware
 * stack guard. */
{
  const rx = Number(prj.match(/^CONFIG_BT_RX_STACK_SIZE=(\d+)$/m)?.[1]);
  t("the BT RX stack has room for SMP as well as the filesystem",
    rx >= 4096, `CONFIG_BT_RX_STACK_SIZE=${rx}`);
}

/* --- what bonding does to a GATT subscription ---------------------------- */

/*
 * **The first DFU that pairs must not be the last.**
 *
 * Zephyr only takes a subscription off its list at disconnect when the peer is
 * *not* bonded (gatt.c, remove_subscriptions()):
 *
 *   if (!bt_le_bond_exists(conn->id, &conn->le.dst) ||
 *       atomic_test_bit(params->flags, BT_GATT_SUBSCRIBE_FLAG_VOLATILE))
 *
 * That is the spec — a bonded client's CCC is meant to persist server-side.
 * For this project it is wrong twice: the peer is a bootloader about to reset,
 * which remembers nothing, and the removal callback is the only thing that
 * ever releases our params. Without the flag, the run after the one that
 * paired fails at `could not enable Control Point notifications (-16)`, and so
 * does every run after that:
 *
 *   ble_pairing: paired with C1:DB:7B:EB:7A:0C (bonded, in RAM only)
 *   nordic_dfu:  the host still holds the last subscription after 3 s
 *
 * **Only a reboot cleared it**, which is the tell — CONFIG_BT_SETTINGS is off,
 * so the keys are in RAM and bt_le_bond_exists() goes false at boot. A device
 * that has to be power-cycled is the one thing this operator cannot do.
 */
const gattCpp2 = read("updater/modules/nordic-legacy-dfu/src/gatt_link.cpp");
t("the DFU subscription is marked VOLATILE",
  /atomic_set_bit\(sub_params_\.flags, BT_GATT_SUBSCRIBE_FLAG_VOLATILE\);/
    .test(codeOf(gattCpp2)));

/* The keys are deliberately RAM-only, which is what made the wedge survive
 * every retry but not a reboot. If this ever becomes persistent, the flag
 * above stops being an optimisation and starts being the only thing standing
 * between a bond and a permanently unusable updater. */
t("bonds are still RAM-only", !/^CONFIG_BT_SETTINGS=y$/m.test(prj));

/* The host's own bits live in the same struct, which is now static and
 * outlives the connection that set them. */
t("...and the host's transient flags are cleared before reuse",
  /atomic_clear_bit\(sub_params_\.flags, BT_GATT_SUBSCRIBE_FLAG_WRITE_PENDING\);/
    .test(gattCpp2) &&
  /atomic_clear_bit\(sub_params_\.flags, BT_GATT_SUBSCRIBE_FLAG_SENT\);/
    .test(gattCpp2));

/* Trap 14's rule: a failure whose consequence is "this device cannot flash
 * anything until someone power-cycles it" gets a recovery path, not a log
 * line. bt_gatt_unsubscribe() works by pointer identity on this connection's
 * list alone, so it reclaims the entry when it is ours and is a no-op when it
 * is not. */
t("a subscription the host will not release is reclaimed, not surrendered",
  /bt_gatt_unsubscribe\(conn_, &sub_params_\) == 0[\s\S]{0,120}?sub_linked_ = false;/
    .test(gattCpp2));

/* --- the client asks while the digits are still on screen --------------- */

const pinDialog = read("web/js/components/PinDialog.js");
const appJs     = read("web/js/App.js");

/*
 * **Not prompt().** It was, and the reported failure is exactly what a native
 * modal does: the browser decides when to show one, so a tab that is not
 * frontmost defers it — the target displayed a PIN, no prompt appeared, the
 * PIN expired, and only then did the dialog arrive, asking for a number that
 * was already gone. A component renders on the frame it is asked to.
 *
 * It also blocks the main thread, which is fatal for a question with a 30 s
 * clock: nothing behind it can count down or notice the window closing.
 */
t("the live PIN question is not a native prompt",
  !/\bprompt\(/.test(codeOf(pinDialog)));
t("...and the status handler does not raise one either",
  !/if \(asking\)[\s\S]{0,120}prompt\(/.test(codeOf(storeJs)));

/*
 * **Neither does the retry ask, and that one was still firing.**
 *
 * The live path stopped using prompt(); offerPin() did not, so a target that
 * displayed a PIN and then gave up produced this dialog *and* a native modal
 * asking the same thing, in whichever order the browser felt like. Reported
 * as the prompt appearing at random, which is what a modal scheduled by the
 * browser rather than the page looks like from outside.
 *
 * Checked over the whole of the PIN path rather than over offerPin() alone:
 * the defect was one function still holding the old tool, and naming that one
 * function is how the next one gets missed.
 */
const pinPath = codeOf(storeJs)
  .slice(codeOf(storeJs).indexOf("export async function submitPin"));
t("the retry ask is not a native prompt either", !/\bprompt\(/.test(pinPath));
t("...it sets a ref the dialog renders", /pinRequest\.value = \{/.test(pinPath));
t("...and the dialog renders both asks",
  /pinRequest/.test(pinDialog) && /submitRetryPin/.test(pinDialog));

/* Two questions about the same digits must not be on screen at once, and the
 * live one wins: those digits belong to the pairing being held open. */
t("a live ask clears a stale retry ask",
  /if \(asking\) \{[\s\S]{0,300}?pinRequest\.value = null;/.test(storeJs));
t("...and the dialog will not show a retry while one is live",
  /const retry = computed\(\(\) => !live\.value && pinRequest\.value\)/.test(pinDialog));

/* A retry needs a link to trigger over, so a dropped connection has to take
 * the ask with it rather than leave a Send button that cannot do anything. */
t("disconnecting drops a pending retry ask",
  /addEventListener\("disconnected"[\s\S]{0,700}?pinRequest\.value = null;/.test(storeJs));

/* No clock on the retry: nothing is counting down, and an invented deadline
 * would be worse than none. */
t("only the live ask runs a countdown",
  /if \(!isOpen \|\| !live\.value\) return;/.test(pinDialog));

/* Driven by the device's state, not by a local flag: another client, or the
 * device itself, can end the pairing, and a dialog outliving it would collect
 * digits nothing is waiting for. */
t("the dialog opens off AWAITING_PIN itself",
  /dfuStatus\.value\.state === STATE\.AWAITING_PIN/.test(pinDialog));
t("...and is mounted with no `open` prop for that reason",
  /<PinDialog \/>/.test(appJs));

/* The clock is the point — these digits belong to this pairing and the target
 * regenerates them next attempt, so a stale reading is worse than none. */
t("the dialog shows how long is left", /pin-clock/.test(pinDialog) &&
  /left before the target stops waiting/.test(pinDialog));

/* Dismissing has to end the pairing now, not leave the target displaying into
 * a timeout nobody is watching. Escape included — it is the same action. */
t("cancelling submits an empty PIN rather than just closing",
  /export async function cancelPin\(\)[\s\S]{0,200}fsxSubmitPin\(""\)/.test(storeJs));
t("...and Escape cancels rather than hiding",
  /onEscape\(\(\) => open\.value, \(\) => cancel\(\)\)/.test(pinDialog));

/* So a "the dialog was late" report can be split into device-side and
 * browser-side latency instead of guessed at again. */
t("the client logs when it heard about the pairing",
  /is waiting for a PIN/.test(storeJs));

/* --- the client only offers a PIN for a run it started ------------------ */

/*
 * A device flashing on its own — auto_flash, or another browser — has nobody
 * at this keyboard by definition, and a prompt in front of whoever happens to
 * be connected is asking the wrong person about a run they did not start.
 */
t("offerPin() does nothing without a remembered run",
  /const run = lastRun;[\s\S]{0,200}if \(!run \|\| !NEEDS_PIN\.has\(status\.result\)\) return;/
    .test(storeJs));

t("offerPin() is reached when a run reaches a terminal state",
  /const ended = next\.terminal && !prev\.terminal;/.test(storeJs) &&
  /if \(ended\) offerPin\(next\);/.test(storeJs));

/* The banner and the scanner panel have to hold the run's real state before
 * anything is rendered over them. (This used to need a macrotask boundary as
 * well, because prompt() froze the main thread before the page could paint;
 * a component does not, so the setTimeout went with the prompt.) */
t("...after the status is published",
  storeJs.indexOf("dfuStatus.value = next;") <
    storeJs.indexOf("if (ended) offerPin(next);"));

/*
 * Every way to start a flash has to record what it started, or that one route
 * silently loses the retry. There are three — a named file, a file at a peer
 * chosen from the scanner, and auto-flash — plus offerPin()'s own re-trigger.
 */
const triggerCalls = [...storeJs.matchAll(/smp\.fsxTriggerDfu\(/g)];
t("store.js has the four expected trigger sites", triggerCalls.length === 4,
  `found ${triggerCalls.length}`);
for (const m of triggerCalls) {
  const before = storeJs.slice(Math.max(0, m.index - 400), m.index);
  t(`the trigger at offset ${m.index} remembers the run first`,
    /rememberRun\(/.test(before));
}

/* --- the two results the operator can act on ---------------------------- */

t("the client knows both authentication results",
  RESULT.AUTH_REQUIRED === 14 && RESULT.AUTH_FAILED === 15);

/* Two, not one. "Supply a PIN" and "that PIN was wrong" send the operator to
 * do different things, and a single "authentication error" would ask someone
 * to correct a PIN they had never entered. */
t("NEEDS_PIN is exactly the two authentication results",
  NEEDS_PIN.size === 2 && NEEDS_PIN.has(RESULT.AUTH_REQUIRED) &&
  NEEDS_PIN.has(RESULT.AUTH_FAILED));
t("their labels say different things",
  RESULT_LABEL[RESULT.AUTH_REQUIRED] !== RESULT_LABEL[RESULT.AUTH_FAILED] &&
  /ble_pin/.test(RESULT_LABEL[RESULT.AUTH_REQUIRED]));

/* --- the naming trap is written down where it is dangerous -------------- */

/* `pin` means an address in dfu_runner.h and a passkey in config.txt, and the
 * two are one comma apart in dfu_runner_start(). The note is the mitigation. */
t("dfu_runner.h warns that pin and passkey are unrelated",
  /pin.{0,40}passkey.{0,200}unrelated|unrelated.{0,200}names/is.test(runnerH));
t("ble_pairing.h explains why the config key is nevertheless ble_pin",
  /passkey/.test(pairingH) && /ble_pin/.test(pairingH));

/* --- the field actually reaches the screen ------------------------------
 *
 * ConfigDialog's template gained an :inputmode binding for this key, and a
 * Vue template error is a blank panel that no grep can see — the same reason
 * scanner.test.mjs renders its dialog rather than reading it. A schema entry
 * that never renders is a setting the operator cannot reach, which is
 * indistinguishable from not having added it.
 */
let JSDOM;
try {
  ({ JSDOM } = await import("jsdom"));
} catch {
  console.log("  skip  jsdom not installed (npm install --no-save jsdom)");
  console.log(bad === 0 ? "\nall ok" : `\n${bad} failure(s)`);
  process.exit(bad === 0 ? 0 : 1);
}


/* --- the PIN dialog has to render, and render *fast* -------------------
 *
 * A Vue template error is a blank panel, which here means the operator sees
 * nothing while a 30 s window closes — the exact failure this component was
 * written to end, arriving by a different route. Rendered rather than grepped,
 * for the reason scanner.test.mjs gives.
 */
{
  const dom = new JSDOM("<!doctype html><div id=app></div>", { pretendToBeVisual: true });
  for (const k of ["window", "document", "navigator", "HTMLElement", "SVGElement",
                   "Node", "Element", "MouseEvent", "requestAnimationFrame"]) {
    Object.defineProperty(globalThis, k, {
      configurable: true, writable: true, value: dom.window[k],
    });
  }
  const warnings = [];
  const realWarn = console.warn, realErr = console.error;
  console.warn = (...a) => warnings.push(a.join(" "));
  console.error = (...a) => warnings.push(a.join(" "));

  const Vue = await import("../js/vue.js");
  const store = await import("../js/store.js");
  const { STATE } = await import("../js/lib/dfu-status.js");
  const PinDialog = (await import("../js/components/PinDialog.js")).default;

  /* The device says a pairing is parked. Nothing else should be needed to put
   * the dialog on screen — that is the whole point of it not taking a prop. */
  store.dfuStatus.value = {
    ...store.dfuStatus.value,
    state: STATE.AWAITING_PIN, name: "XIAO_NRF52_OTA",
  };

  let err = null;
  const app = Vue.createApp(PinDialog);
  try { app.mount(dom.window.document.getElementById("app")); }
  catch (e) { err = e; }
  console.warn = realWarn; console.error = realErr;

  t("PinDialog renders from the device state alone", !err, String(err));
  t("...with no Vue warnings", warnings.length === 0, warnings.join(" | "));

  const html = dom.window.document.getElementById("app").innerHTML;
  t("it names the target being paired with", /XIAO_NRF52_OTA/.test(html), html.slice(0, 200));
  const input = dom.window.document.querySelector(".pin-input");
  t("it offers a numeric input capped at six digits",
    !!input && input.getAttribute("inputmode") === "numeric" &&
    input.getAttribute("maxlength") === "6");
  t("and it shows the countdown", /left before the target stops waiting/.test(html));

  /* Closing the pairing device-side must take the dialog with it, or it keeps
   * collecting digits for something that ended. */
  store.dfuStatus.value = { ...store.dfuStatus.value, state: STATE.FAILED };
  await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
  t("it closes when the device stops waiting",
    !dom.window.document.querySelector(".pin-input"));

  app.unmount();
}

{
  const dom = new JSDOM("<!doctype html><div id=app></div>", { pretendToBeVisual: true });
  for (const k of ["window", "document", "navigator", "HTMLElement", "SVGElement",
                   "Node", "Element", "MouseEvent", "requestAnimationFrame"]) {
    Object.defineProperty(globalThis, k, {
      configurable: true, writable: true, value: dom.window[k],
    });
  }
  const warnings = [];
  const realWarn = console.warn, realErr = console.error;
  console.warn = (...a) => warnings.push(a.join(" "));
  console.error = (...a) => warnings.push(a.join(" "));

  const Vue = await import("../js/vue.js");
  const ConfigDialog = (await import("../js/components/ConfigDialog.js")).default;

  let err = null;
  const app = Vue.createApp({
    components: { ConfigDialog },
    template: `<ConfigDialog :open="true"/>`,
  });
  try { app.mount(dom.window.document.getElementById("app")); }
  catch (e) { err = e; }
  console.warn = realWarn; console.error = realErr;

  t("ConfigDialog renders", !err, String(err));
  /* A binding whose name does not exist on setup()'s return resolves to
   * undefined and warns rather than throwing, so a silent panel is caught
   * here and not by the mount above. */
  t("...with no Vue warnings", warnings.length === 0, warnings.join(" | "));

  const input = dom.window.document.getElementById("cfg-ble_pin");
  t("the ble_pin field is on the screen", !!input);
  t("it is a text box, not a number spinner",
    input?.getAttribute("type") === "text", input?.getAttribute("type"));
  /* A phone shows letters for a six-digit PIN without this. */
  t("it asks for a numeric keypad",
    input?.getAttribute("inputmode") === "numeric", input?.getAttribute("inputmode"));
  t("and caps what can be typed at six digits",
    input?.getAttribute("maxlength") === "6", input?.getAttribute("maxlength"));

  /* Every other text field must be unaffected: :inputmode binds to undefined
   * where the schema does not set one, and Vue drops the attribute. A default
   * of "numeric" would put a keypad in front of ble_name. */
  const nameInput = dom.window.document.getElementById("cfg-ble_name");
  t("other text fields did not inherit the keypad",
    !!nameInput && !nameInput.hasAttribute("inputmode"),
    nameInput?.getAttribute("inputmode") ?? "field missing");
}

console.log(bad === 0 ? "\nall ok" : `\n${bad} failure(s)`);
process.exit(bad === 0 ? 0 : 1);
