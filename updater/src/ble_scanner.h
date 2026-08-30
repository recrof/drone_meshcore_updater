#pragma once

/*
 * BLE central scanner — finds a Nordic Legacy DFU peer and returns its
 * address to the DFU state machine. Blocking: it owns the scan for its
 * duration and returns the first advertisement that passes the name, RSSI
 * and service-UUID filters.
 */

#include <zephyr/kernel.h>
#include <zephyr/bluetooth/addr.h>
#include <stdbool.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif


#define BLE_SCANNER_NAME_MAX 24

struct ble_scanner_target {
	bt_addr_le_t addr;                       /* peer address, ready for bt_conn_le_create */
	int8_t       rssi;                       /* strongest RSSI seen at match time */
	char         name[BLE_SCANNER_NAME_MAX]; /* advertised name or "" */
	bool         dfu_uuid;                   /* the ad carried the Legacy DFU service UUID */
};

/* Toggle per-advertisement debug logging. When on, every rejected ad
 * gets one line with reason (weak / name-mismatch / uuid-mismatch) and
 * MAC. De-duplicated per (mac, reason) to keep the log manageable in
 * dense BLE environments.
 */
void ble_scanner_set_debug(bool on);

/* Scan for any device advertising the Legacy DFU service UUID or
 * matching the configured name filter. Blocks until a match or timeout.
 *
 * name_filter — pipe-delimited substring OR ("RAK4631 | 4631_DFU"),
 *               empty/NULL = fall back to Legacy DFU service UUID match.
 * min_rssi    — reject ads weaker than this (dBm, negative; -127 = no filter).
 * prefer_mac  — when non-NULL, ads from this MAC or MAC+1 are also
 *               accepted regardless of name (Nordic app→bootloader
 *               transition; use after a buttonless trigger).
 * timeout_ms  — 0 = scan forever (drone use), otherwise wall-clock cap.
 *
 * Returns 0 on match (out populated), -ETIMEDOUT on scan timeout,
 * negative errno on scan/start failure.
 */
int ble_scanner_find_first(struct ble_scanner_target *out,
			   uint32_t timeout_ms,
			   const char *name_filter,
			   int8_t min_rssi,
			   const bt_addr_le_t *prefer_mac);

/* Is this exact peer on the air right now?
 *
 * A different question from find_first(): that one asks "is there anything
 * worth flashing", this one asks about one address and takes no other answer.
 * Name, service UUID and RSSI are all ignored — a faint sighting of the right
 * address is still a sighting, and applying min_rssi here would turn a
 * still-advertising bootloader at the edge of range into a false "it rebooted
 * into the application".
 *
 * `timeout_ms` must be non-zero: waiting forever for a peer that is supposed
 * to be *gone* never returns.
 *
 * Returns 0 if seen (and fills `out`, which may be NULL), -ETIMEDOUT if it was
 * not seen in the window, -ECANCELED if a stop arrived, negative errno if the
 * radio would not scan.
 */
int ble_scanner_seen_at(const bt_addr_le_t *addr, uint32_t timeout_ms,
			struct ble_scanner_target *out);

#ifdef __cplusplus
}
#endif

/* Make a ble_scanner_find_first() that is currently waiting give up, and stop
 * the radio scanning.
 *
 * Returns nothing because there is nothing useful to say: the caller that owns
 * the scan is the one that learns about it, as -ECANCELED from find_first().
 * Safe to call from any thread, and safe to call when no scan is running — the
 * flag is cleared at the start of the next find_first().
 *
 * A scan with `timeout_ms == 0` waits K_FOREVER, which is the normal setting
 * for drone use. Without this there is no way to end one short of a reboot.
 */
void ble_scanner_cancel(void);
