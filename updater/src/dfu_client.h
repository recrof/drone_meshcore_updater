#pragma once

/*
 * The app's Legacy DFU client: connect to a scanned peer, stream a firmware
 * bundle, hand back a result the runner can act on.
 *
 * The protocol itself lives in modules/nordic-legacy-dfu, a port of the
 * Android DFU Library. This header is the C-facing boundary: it owns the
 * result enum the state machine switches on, and the one entry point.
 * dfu_client.cpp supplies the connection and adapts firmware_zip entries to
 * the module's Stream interface.
 */

#include <zephyr/kernel.h>
#include <stdint.h>

#include "ble_scanner.h"
#include "firmware_zip.h"
#include "config.h"

#ifdef __cplusplus
extern "C" {
#endif

enum dfu_result {
	DFU_OK,                    /* full DFU cycle succeeded, peer rebooted */
	DFU_BUTTONLESS_TRIGGERED,  /* peer rebooted; rescan and run again */
	DFU_CONNECT_FAILED,        /* couldn't hold a connection long enough to talk */
	DFU_SERVICE_MISSING,       /* connected but peer doesn't expose Legacy DFU service */
	DFU_CHAR_MISSING,          /* service present but ctrl/packet char absent */
	DFU_DISCONNECTED_EARLY,    /* link dropped mid-sequence */
	DFU_TIMEOUT,               /* waited too long for a peer response */
	DFU_REMOTE_ERROR,          /* peer rejected a request via non-SUCCESS status */
	DFU_FS_ERROR,              /* couldn't read the local .bin/.dat */
};

/* Connect to `target`, run one Legacy DFU session, disconnect. Blocks the
 * calling thread for the whole transfer — call it from the DFU runner's
 * thread, never from the BT RX thread or a GATT callback.
 *
 * A buttonless jump returns DFU_BUTTONLESS_TRIGGERED; the caller is expected
 * to rescan and call again without consuming a retry.
 *
 * Config mapping: prn -> packets_before_notification, high_mtu -> whether to
 * exchange MTU at all, pkt_gap_ms -> Parameters::packet_interval_us,
 * erase_pause_ms / erase_inflight -> the erase-aware pacing. See Trap 4 in
 * CLAUDE.md for why those values are what they are.
 */
enum dfu_result dfu_client_run(const struct ble_scanner_target *target,
			       const struct firmware_bundle *bundle,
			       const struct app_config *cfg);

#ifdef __cplusplus
}
#endif
