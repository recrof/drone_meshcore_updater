#pragma once

/*
 * Passkey entry for targets that will not talk unencrypted.
 *
 * ---- What this file is, and what Zephyr already does ------------------
 *
 * MeshCore's own firmware — and it is not alone — protects its GATT
 * characteristics, so an unpaired central gets ATT "Insufficient
 * Authentication" (0x05) instead of an answer. Before this existed the
 * updater had no SMP at all, so such a peer looked exactly like one missing
 * the DFU characteristic, and the run failed reporting that.
 *
 * **Almost none of the fix is here.** `CONFIG_BT_SMP=y` brings
 * `CONFIG_BT_ATT_RETRY_ON_SEC_ERR` with it (default y, `depends on BT_SMP`),
 * and att.c's `att_change_security()` then owns the whole sequence: an ATT
 * request refused for security is *held* rather than failed, the link is
 * raised to the level the error implies, and the same request is reissued
 * once encryption is up. Nothing in dfu_client.cpp or
 * modules/nordic-legacy-dfu/ has to know pairing exists, and nothing does.
 *
 * All this file supplies is the one thing the host cannot know: the six
 * digits. It is a passive participant — it never *starts* a pairing, so a
 * target that asks for no security never sees a security procedure at all.
 * That is what made this safe to switch on for five boards that already
 * complete DFUs.
 *
 * ---- "pin" here means a passkey, and elsewhere it means an address ------
 *
 * Unfortunate but deliberate. `ble_pin` is what an operator calls the six
 * digits, and what MeshCore's own UI calls them, so that is the config key.
 * Everywhere inside the firmware the credential is called a **passkey**,
 * because `pin` was already taken: dfu_runner.h, dfu_transport.h and
 * pin_addr.c all use it for the *pinned address* of a peer chosen out of a
 * survey. Two unrelated things named `pin` in one call chain is a bug
 * waiting for a hurried afternoon, so the two names never meet.
 */

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/* Highest passkey the Bluetooth spec allows: six decimal digits. */
#define BLE_PASSKEY_MAX 999999u

/* Register the auth callbacks. Call once, after bt_enable(). */
int ble_pairing_init(void);

/*
 * Set the passkey offered for the run about to start, and clear the verdict
 * from the last one.
 *
 * `passkey` is the decimal string from config.txt's `ble_pin`, or the one the
 * operator typed for this specific target; NULL or "" means we have none,
 * which is not an error — it is the default, and the thing it changes is what
 * we can *report* when a peer asks.
 *
 * A malformed string (non-digits, too long, out of range) is treated as none
 * and logged. It cannot be a silent truncation: "1234567" clipped to "123456"
 * is a wrong PIN that fails as though the operator had mistyped it.
 */
void ble_pairing_set_passkey(const char *passkey);

/*
 * What, if anything, went wrong with authentication during the run.
 *
 * Returns one of DFU_STATUS_RESULT_NONE (nothing was asked, or pairing
 * succeeded), _AUTH_REQUIRED (a peer wanted a passkey and we had none) or
 * _AUTH_FAILED (we offered one and it was rejected).
 *
 * Deliberately a *status* result rather than a `dfu_result`: this is not
 * something a transport returned. The peer refused the link out from under a
 * transfer that reports its own, less specific, failure — so the runner
 * overrides the verdict rather than the transport producing it.
 */
int ble_pairing_verdict(void);

/*
 * Is a pairing parked, waiting for someone to type the digits the target is
 * displaying right now? Fills `addr` with the peer if so.
 *
 * A peer that *displays* a passkey generates it for that pairing. So the
 * obvious flow — fail, ask the operator, run again — cannot work: the second
 * attempt shows a different number, and the first one vanished the instant we
 * declined it. Worse, declining is what makes it vanish, so the operator
 * cannot even read it. The pairing therefore stays open and the question is
 * asked while the target is still showing the answer.
 *
 * Bounded by SMP's own 30 s timeout (`SMP_TIMEOUT` in smp.c), not by anything
 * here — which is the right budget and is not ours to choose.
 */
bool ble_pairing_awaiting(char *addr, size_t len);

/*
 * Hand the parked pairing the digits the operator read off the target.
 *
 * `passkey` NULL or "" cancels it instead, which is what the operator asking
 * for the prompt to go away means. Returns 0 if a pairing was waiting,
 * -EALREADY if none was (it timed out, or the peer gave up), -EINVAL if the
 * string is not one to six digits.
 */
int ble_pairing_submit(const char *passkey);

#ifdef __cplusplus
}
#endif
