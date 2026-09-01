/*
 * Two defects that only fire when a DFU runs more than once.
 * No dependencies — run with:  node web/test/dfu-loop.test.mjs
 *
 * Both were found in a single field log: a RAK4631 that had been flashed
 * *successfully* was declared a failure, retried, flashed again, declared a
 * failure again — and the board doing the flashing eventually crashed. One
 * ordinary single-shot DFU exercises neither.
 *
 *  1. `ble_verify()` decided "the target rejected the image" from the fact
 *     that *something* was advertising at the target's address. On a target
 *     whose bootloader and application share an address, the something is the
 *     new application. It is a race — the same log has an earlier transfer to
 *     the same board pass, purely because the target rebooted more slowly.
 *  2. `subscribe_control_point()` memset a `bt_gatt_subscribe_params` that the
 *     Bluetooth host still had on its own list, so the next disconnect called
 *     a NULL `notify` and branched to address zero.
 *  3. ...and the same crash came straight back, on four boards and two
 *     architectures, because the struct itself lived in a `Session` on the
 *     dfu_runner thread's stack. Not zeroing a thing that has ceased to exist
 *     is no improvement. The GattLink holding it now has static storage.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (p) => readFileSync(join(ROOT, p), "utf8");

/* Comments explain what the code no longer does, so searching the source with
 * them left in finds the prose and passes on a regression. */
const codeOf = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "");

const transport = read("updater/src/transport_ble.c");
const scannerH  = read("updater/src/ble_scanner.h");
const gattCpp   = read("updater/modules/nordic-legacy-dfu/src/gatt_link.cpp");
const gattHpp   = read("updater/modules/nordic-legacy-dfu/src/gatt_link.hpp");

let bad = 0;
const t = (name, cond, extra = "") => {
  console.log(`${cond ? "  ok  " : "  FAIL"} ${name}${cond ? "" : "  " + extra}`);
  if (!cond) bad++;
};

/* --- 1. verify must ask *what* is advertising, not merely whether --------- */

/* The flag exists and means what the check relies on. */
t("the scanner reports whether an ad carried the DFU service",
  /bool\s+dfu_uuid;/.test(scannerH));

const verify = transport.slice(transport.indexOf("static enum dfu_result ble_verify"));
const verifyCode = codeOf(verify);

/*
 * The whole defect in one line: `dfu_uuid` was collected, and *logged in the
 * rejection message*, and never used to decide anything. A verify that reads
 * the flag only to print it is the bug, not the fix.
 */
t("verify branches on dfu_uuid rather than only printing it",
  /if\s*\(!seen\.dfu_uuid\)/.test(verifyCode), verifyCode.slice(0, 200));

/* An advertiser with no DFU service is the application, so the image took. */
t("...and no DFU service means the new image is running",
  /if\s*\(!seen\.dfu_uuid\)\s*\{[\s\S]{0,400}?return DFU_OK;/.test(verifyCode));

/* And only a DFU service still on the air is a rejection. */
t("only a still-advertised DFU service counts as a rejection",
  /return DFU_TARGET_REJECTED;/.test(verifyCode) &&
  verifyCode.indexOf("DFU_TARGET_REJECTED") > verifyCode.indexOf("seen.dfu_uuid"));

/* Being unseen entirely is still success — the peer rebooted into something
 * that is not advertising yet. That path predates this fix and must survive
 * it, since it is the one that used to make the race look fine. */
t("an address that goes quiet is still a success",
  /rc == -ETIMEDOUT[\s\S]{0,300}?return DFU_OK;/.test(verifyCode));

/* --- 2. the host's subscription list is not ours to zero ----------------- */

/*
 * `sub_params_` is reused for every attempt. Zephyr
 * keeps `&sub_params_.node` on its own list until the *previous* connection's
 * ATT channel detaches, which lags our disconnect by up to ATT's 30 s timeout
 * (Trap 3). memset in between zeroes `notify`, and the host's next
 * `gatt_sub_remove()` calls it: pc=0x00000000, lr inside gatt.c:3443.
 */
const subFn = gattCpp.slice(gattCpp.indexOf("int GattLink::subscribe_control_point"));
t("subscribe_control_point does not zero the params it reuses",
  !/memset\s*\(\s*&sub_params_/.test(codeOf(subFn)));

/* notify must always point at a real function, precisely so that a removal
 * arriving late calls something rather than address zero. */
t("notify and subscribe are always assigned",
  /sub_params_\.notify\s*=\s*notify_cb;/.test(subFn) &&
  /sub_params_\.subscribe\s*=\s*subscribe_cb;/.test(subFn));

/* Whether the host still holds it is a separate question from whether *we*
 * think we are subscribed, and only the host can answer it. */
t("the module tracks host ownership separately from its own state",
  /sub_linked_/.test(gattHpp) && /bool subscribed_/.test(gattHpp));
t("...set when a subscription is accepted",
  /sub_linked_ = true;/.test(gattCpp));
t("...and cleared when the host announces removal",
  /data == nullptr[\s\S]{0,300}?sub_linked_ = false;/.test(gattCpp));

/*
 * The removal callback arrives after detach() has cleared s_active, so the
 * object has to be recovered from `params`. Keying on s_active would miss the
 * single call that matters and leave the flag set for good — which would then
 * fail every subsequent attempt with -EBUSY instead of crashing, but still
 * break the device.
 */
t("the object is recovered from params, not from s_active",
  /CONTAINER_OF\(params, GattLink, sub_params_\)/.test(gattCpp));

/* Reuse waits for the host, bounded, and refuses rather than forcing it. */
t("reuse waits for the previous subscription to be released",
  /for \(int i = 0; sub_linked_[\s\S]{0,300}?k_sleep/.test(subFn));
t("...and gives up with -EBUSY rather than corrupting the list",
  /if \(sub_linked_\)\s*\{[\s\S]{0,300}?return -EBUSY;/.test(subFn));

/*
 * A clean unsubscribe takes the node off the list itself and, on the
 * last-subscription path, without calling notify() — so nothing else would
 * ever clear the flag. Left set, the tidy path wedges every later run on the
 * -EBUSY above: a permanent failure caused by the DFU that went well.
 */
const unsubFn = gattCpp.slice(gattCpp.indexOf("void GattLink::unsubscribe_control_point"));
t("a clean unsubscribe clears the ownership flag itself",
  /bt_gatt_unsubscribe\([\s\S]{0,80}?\)\s*==\s*0[\s\S]{0,200}?sub_linked_ = false;/
    .test(codeOf(unsubFn)));

/* --- 3. the params must outlive the run that created them ---------------- */

/*
 * The half that the memset fix missed, and the reason the crash survived it.
 *
 * `Session` is a local — `Session session(...)` in both run() and detect(),
 * on the dfu_runner thread's stack. With GattLink as an ordinary member, every
 * pointer the Bluetooth host was handed died with the frame, `sub_linked_`
 * included: the flag meant to notice that the host still owns the struct was
 * itself in the freed memory. remove_subscriptions() then walked into it.
 *
 *   PREVIOUS RUN CRASHED: usage: illegal EPSR (reason 35) in thread BT RX WQ
 *     pc=0x00000000 lr=0x0003a44d          -> gatt.c:3446
 *
 * Structural, because there is no way to observe this from a single run and
 * nothing about it fails to compile.
 */
const legacy = read("updater/modules/nordic-legacy-dfu/src/legacy_dfu.cpp");
const legacyCode = codeOf(legacy);

t("Session is still a stack local (so the point below is not moot)",
  /Session session\(/.test(legacyCode));
t("the GattLink it borrows has static storage",
  /\bstatic GattLink link_;/.test(legacyCode) &&
  /^GattLink Session::link_;/m.test(legacyCode));
t("...and nothing else declares one that could shadow it",
  legacyCode.match(/\bGattLink\s+\w+\s*;/g).length === 1);

/* The rule, written where someone adding a bt_gatt_* params member will meet
 * it. Zephyr holds disc_/read_/write_/mtu_params_ across an operation too, and
 * a timed-out operation returns while it still does. */
t("the header says a GattLink may not live on a stack",
  /may not live on a stack/i.test(gattHpp));

console.log(bad === 0 ? "\nall ok" : `\n${bad} failure(s)`);
process.exit(bad === 0 ? 0 : 1);
