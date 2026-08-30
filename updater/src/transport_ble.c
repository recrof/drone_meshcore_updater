/*
 * BLE central -> Nordic Legacy DFU, behind the dfu_transport interface.
 *
 * Deliberately thin. All the scanning lives in ble_scanner.c and all the
 * protocol in dfu_client.cpp + modules/nordic-legacy-dfu; this file exists
 * only to present them in the shape dfu_runner now speaks.
 *
 * Note what it does NOT do: find() does not connect. The advertised name is in
 * the advertisement, so BLE can name a peer without touching it, and
 * dfu_client_run() opens and closes its own link. That is the half of the
 * interface the WiFi driver will use differently, and it is why find() is
 * merely *allowed* to leave a connection open rather than required to.
 */

#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>
#include <stdio.h>

#include "dfu_transport.h"
#include <zephyr/sys/__assert.h>

LOG_MODULE_REGISTER(transport_ble, LOG_LEVEL_INF);

static int ble_find(struct dfu_target *out, const struct app_config *cfg,
		    uint32_t timeout_ms)
{
	int rc = ble_scanner_find_first(&out->ble, timeout_ms, cfg->ble_name,
					cfg->min_rssi, NULL);
	if (rc < 0) {
		return rc;
	}
	snprintf(out->name, sizeof(out->name), "%s", out->ble.name);
	return 0;
}

static enum dfu_result ble_run(const struct dfu_target *t,
			       const struct dfu_payload *payload,
			       const struct app_config *cfg)
{
	/* The runner checks payload_kind before calling, so this is a
	 * programming error rather than a bad file. Streaming a bare image at
	 * a Legacy DFU peer would send it a headerless blob it cannot refuse
	 * until VALIDATE. */
	__ASSERT(payload->kind == DFU_PAYLOAD_ZIP,
		 "BLE transport handed a non-zip payload");
	return dfu_client_run(&t->ble, &payload->zip, cfg);
}

/*
 * Did the image actually take?
 *
 * ACTIVATE-and-Reset is acknowledged by the bootloader *before* it validates
 * anything, so a clean DFU_OK means "every byte arrived", not "the target is
 * running it". The bootloader checks the image's CRC on the way back up, and
 * if it fails there is no application to boot — oltaco's OTAFIX bootloader
 * re-arms BLE DFU instead, so the operator can simply try again. That is a
 * good behaviour and it makes our success report a lie: the peer is sitting in
 * DFU mode and we have gone home saying it is updated.
 *
 * The tell is the bootloader's own address. It is not the application's — a
 * Nordic bootloader entered from an app advertises at MAC+1, and one that was
 * already in DFU mode has its own — so *anything* advertising there is the
 * bootloader, still in DFU mode. A target that booted its new application is
 * silent at that address.
 *
 * Two numbers, both deliberately generous, because the cost of being wrong is
 * asymmetric. A false "rejected" costs one retry against a target that is
 * already fine; a false "confirmed" is the bug this exists to catch.
 *
 *   SETTLE  the peer has to reset, check the CRC and decide. Nothing useful
 *           can be concluded before it has.
 *   WATCH   how long to look. Scanning runs at a 50% duty cycle and a
 *           bootloader in DFU mode advertises continuously, so this is many
 *           times what it takes to see one.
 */
#define VERIFY_SETTLE_MS 2000
#define VERIFY_WATCH_MS  5000

static enum dfu_result ble_verify(const struct dfu_target *t,
				  const struct app_config *cfg)
{
	struct ble_scanner_target seen;

	ARG_UNUSED(cfg);

	k_sleep(K_MSEC(VERIFY_SETTLE_MS));

	int rc = ble_scanner_seen_at(&t->ble.addr, VERIFY_WATCH_MS, &seen);

	if (rc == -ETIMEDOUT) {
		LOG_INF("verify: %s is off the air — the new image is running",
			t->name);
		return DFU_OK;
	}
	if (rc == -ECANCELED) {
		/* Stopped by the operator. Not evidence either way, and the
		 * runner is about to unwind anyway. */
		return DFU_OK;
	}
	if (rc < 0) {
		/* The check failed, not the update. Saying "rejected" here
		 * would throw away a transfer that may well have worked. */
		LOG_WRN("verify: could not scan (%d) — leaving the transfer's "
			"own verdict alone", rc);
		return DFU_OK;
	}

	LOG_ERR("verify: the bootloader is still advertising at the same "
		"address (name='%s' dfu_service=%s) — it rejected the image, "
		"most likely on its own CRC check, and has re-armed DFU",
		seen.name, seen.dfu_uuid ? "yes" : "no");
	return DFU_TARGET_REJECTED;
}

/* Both halves, unconditionally: a stop can land while we are scanning, while
 * a transfer is running, or in the gap between them, and the caller has no way
 * to know which. Each is a no-op when its half is idle. */
static void ble_abort(void)
{
	ble_scanner_cancel();
	dfu_client_abort();
}

static void ble_release(struct dfu_target *t)
{
	ARG_UNUSED(t);
	/* dfu_client_run() disconnects on every path out of itself, including
	 * the buttonless jump and Reset-after-error. Nothing is left open. */
}

const struct dfu_transport dfu_transport_ble = {
	.name = "ble-legacy-dfu",
	.available = NULL,           /* the radio is always there */
	.find = ble_find,
	.run = ble_run,
	.payload_kind = DFU_PAYLOAD_ZIP,
	.verify = ble_verify,
	.abort = ble_abort,
	.release = ble_release,
};
