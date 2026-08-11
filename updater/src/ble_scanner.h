#pragma once

/*
 * BLE central scanner — finds a Nordic Legacy DFU peer and returns its
 * address to the DFU state machine. Port of the nRF52 sibling's
 * ble_scanner::find_first() with the Bluefruit callback replaced by
 * Zephyr's bt_le_scan_start.
 */

#include <zephyr/kernel.h>
#include <zephyr/bluetooth/addr.h>
#include <stdbool.h>
#include <stdint.h>

#define BLE_SCANNER_NAME_MAX 24

struct ble_scanner_target {
	bt_addr_le_t addr;                       /* peer address, ready for bt_conn_le_create */
	int8_t       rssi;                       /* strongest RSSI seen at match time */
	char         name[BLE_SCANNER_NAME_MAX]; /* advertised name or "" */
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
