#pragma once

#ifdef __cplusplus
extern "C" {
#endif

/*
 * Confirm an over-the-air update once the firmware has shown it can still be
 * reached. See selfconfirm.c for why the criterion is Bluetooth specifically.
 *
 * Both are no-ops in a build without MCUboot, and after the image is already
 * confirmed.
 */

/** Advertising has started. Arms the fallback grace period. */
void selfconfirm_ble_ready(void);

/** A peer connected — the recovery path is proven. Confirms immediately. */
void selfconfirm_peer_connected(void);

#ifdef __cplusplus
}
#endif
