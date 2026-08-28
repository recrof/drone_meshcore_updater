/*
 * Self-confirmation of an over-the-air update.
 *
 * MCUboot boots a freshly swapped image in "test" mode and reverts it on the
 * next reset unless something marks it confirmed. Leaving that to the operator
 * means every wireless update ends with a chore that, if forgotten, silently
 * undoes itself the next time the battery is pulled.
 *
 * ---- What counts as "it works" -----------------------------------------
 *
 * This is the whole design, and getting it wrong is worse than not having it.
 * Confirming in main() would be trivial and would **destroy the safety net**:
 * an image that boots but cannot bring up Bluetooth would confirm itself and
 * make the wireless recovery path permanently unreachable. The revert exists
 * precisely for that image.
 *
 * So the criterion is the capability you would need in order to recover:
 * **Bluetooth**. If this firmware can be connected to, another update can
 * always be pushed, whatever else is broken. If it cannot, reverting is the
 * only way home that does not involve a cable.
 *
 * Two triggers, strongest first:
 *
 *   1. A peer connects. Proves the radio, the stack, the advertisement and
 *      connectability all work — the complete recovery path, demonstrated
 *      rather than assumed. This is the usual case: the browser that pushed
 *      the update reconnects moments later.
 *
 *   2. Advertising has been up for SELFCONFIRM_GRACE_MS with no fault. Weaker
 *      — it does not prove a peer *can* connect — but it covers the device
 *      that is updated and then left alone, which would otherwise revert on
 *      its next power cycle for no reason.
 *
 * A crash before either point means no confirmation, so the next reset brings
 * back the previous image. That is the behaviour we want and is why nothing
 * here runs from main() directly.
 *
 * Deliberately not configurable from config.txt: the only interesting value
 * is "sooner", and a knob whose wrong setting removes the safety net is not a
 * knob worth having.
 */

#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>

#include "selfconfirm.h"

LOG_MODULE_REGISTER(selfconfirm, LOG_LEVEL_INF);

#if defined(CONFIG_BOOTLOADER_MCUBOOT) && defined(CONFIG_MCUBOOT_IMG_MANAGER)

#include <zephyr/dfu/mcuboot.h>

/* Long enough that a boot loop or an early fault happens first; short enough
 * that a user watching the log sees it resolve. */
#define SELFCONFIRM_GRACE_MS 30000

static void grace_fn(struct k_work *work);
static K_WORK_DELAYABLE_DEFINE(grace_work, grace_fn);
static bool done;

static void confirm_now(const char *why)
{
	if (done) {
		return;
	}
	/* Already confirmed is the common case — a USB-flashed image, or the
	 * second boot after an update. Not an error, and not worth a line
	 * every time. */
	if (boot_is_img_confirmed()) {
		done = true;
		return;
	}

	int rc = boot_write_img_confirmed();
	if (rc) {
		/* The image keeps running; it simply reverts on the next reset.
		 * Loud, because the operator's update is about to disappear and
		 * the web client's Confirm button is the way to save it. */
		LOG_ERR("could not confirm this image (rc=%d) — it will REVERT on "
			"the next reset unless confirmed manually", rc);
		return;
	}
	done = true;
	LOG_INF("image confirmed (%s) — this update is now permanent", why);
}

void selfconfirm_ble_ready(void)
{
	if (done || boot_is_img_confirmed()) {
		done = true;
		return;
	}
	LOG_INF("running an unconfirmed image; confirming on the first connection, "
		"or in %d s if none arrives", SELFCONFIRM_GRACE_MS / 1000);
	k_work_schedule(&grace_work, K_MSEC(SELFCONFIRM_GRACE_MS));
}

void selfconfirm_peer_connected(void)
{
	if (done) {
		return;
	}
	/* Strongest evidence available, and it arrived early. */
	k_work_cancel_delayable(&grace_work);
	confirm_now("a peer connected");
}

static void grace_fn(struct k_work *work)
{
	ARG_UNUSED(work);
	confirm_now("advertising stable");
}

#else  /* built without MCUboot — nothing to confirm */

void selfconfirm_ble_ready(void) { }
void selfconfirm_peer_connected(void) { }

#endif
