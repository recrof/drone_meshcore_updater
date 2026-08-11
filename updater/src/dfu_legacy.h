#pragma once

/*
 * Nordic Legacy DFU client — target-facing state machine that flashes a
 * firmware bundle to a nearby nRF5x peer over BLE.
 *
 * Port of the nRF52 sibling's dfu_legacy.cpp onto Zephyr's bt_conn +
 * bt_gatt_discover + bt_gatt_write primitives. Ships in phases:
 *
 *   4a (current) — connect + service/characteristic discovery
 *   4b — buttonless trigger + START_DFU + size packet
 *   4c — stream firmware + PRN handling
 *   4d — validate + activate + await peer reset
 *
 * Callers pass a fully-parsed bundle + a scanner target + the live app
 * config; the run function handles the whole session and returns a
 * `dfu_result` enum that the top-level state machine (main.c) uses to
 * decide retry / cooldown / LED colour.
 */

#include <zephyr/kernel.h>
#include <stdint.h>

#include "ble_scanner.h"
#include "firmware_zip.h"
#include "config.h"

enum dfu_result {
	DFU_OK,                    /* full DFU cycle succeeded, peer rebooted */
	DFU_BUTTONLESS_TRIGGERED,  /* peer was in app mode; we asked it to reboot into DFU */
	DFU_CONNECT_FAILED,        /* couldn't hold a connection long enough to talk */
	DFU_SERVICE_MISSING,       /* connected but peer doesn't expose Legacy DFU service */
	DFU_CHAR_MISSING,          /* service present but ctrl/packet char absent */
	DFU_DISCONNECTED_EARLY,    /* link dropped mid-sequence */
	DFU_TIMEOUT,               /* waited too long for a peer response */
	DFU_REMOTE_ERROR,          /* peer rejected a request via non-SUCCESS status */
	DFU_FS_ERROR,              /* couldn't read the local .bin/.dat */
};

/* Progress callback fired from within the streaming loop; `pct` is 0..100.
 * Called frequently — keep it fast and avoid blocking I/O.
 */
typedef void (*dfu_progress_cb)(uint8_t pct);

void dfu_legacy_set_progress_callback(dfu_progress_cb cb);

/* Run the full DFU sequence against `target`, sourcing firmware from
 * `bundle`. Blocks the calling thread until success or terminal failure.
 * Meant to be called from a workqueue (never from the BT-RX thread or
 * from the mcumgr handler thread).
 */
enum dfu_result dfu_legacy_run(const struct ble_scanner_target *target,
			       const struct firmware_bundle *bundle,
			       const struct app_config *cfg);
