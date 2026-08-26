#pragma once

/*
 * DFU-target configuration loaded from /lfs1/config.txt.
 *
 * See the per-field comments below for what each key does. Read the moment
 * storage is mounted and applied to the BLE scanner, the DFU retry loop, and
 * tx-power on init. Runtime edits (upload a new config.txt via
 * SMP / fsx_stream) take effect at the *next* DFU sequence.
 */

#include <zephyr/kernel.h>
#include <stdbool.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif


/* Canonical config path. Deliberately lowercase, and lowercase everywhere
 * that creates or updates it: LittleFS is case-sensitive, so a file uploaded
 * as "config.txt" is one this firmware silently never reads. One agreed
 * spelling is what prevents that. `web/test/config-file.test.mjs` reads this
 * line and fails if the web client disagrees with it.
 */
#define APP_CONFIG_PATH   "/lfs1/config.txt"
#define APP_CONFIG_NAME_MAX 24

/* ble_firmware_mapping holds several "name:file" rules, so it needs far more
 * room than a single name. Bounded well under the 1023-byte parse buffer so a
 * long mapping can't push other keys off the end of the file.
 */
#define APP_CONFIG_MAPPING_MAX 192

struct app_config {
	/* Substring filter for advertised BLE name. Empty = accept any peer
	 * that exposes the Legacy DFU service. Multiple substrings may be
	 * OR'd with '|', useful when an app and its bootloader advertise
	 * under different names (e.g. "RAK4631_OTA | 4631_DFU").
	 */
	char     ble_name[APP_CONFIG_NAME_MAX];

	/* Rules mapping an advertised BLE name to the firmware bundle to send
	 * it, so one updater can carry several zips and pick per target.
	 *
	 *   ble_firmware_mapping=RAK:rak4631*.zip | XIAO:xiao_*.zip
	 *
	 * Rules are '|'-separated and tried in order; the first whose name
	 * part is a substring of the peer's advertised name wins. The file
	 * part is a filename glob ('*' and '?') resolved against /lfs1.
	 * Whitespace around either part is trimmed.
	 *
	 * Only consulted by the auto-flash path (trigger_dfu with no path).
	 * Flashing a specific zip still sends exactly that zip.
	 */
	char     ble_firmware_mapping[APP_CONFIG_MAPPING_MAX];

	/* Packet Receipt Notification cadence (writes between PRN callbacks).
	 * 10 is safe for SDK 6.0 bootloaders; modern ones tolerate ~32. 0
	 * disables PRNs entirely — faster but no flow control (risky).
	 */
	uint16_t prn;

	/* Negotiate ATT MTU up to 247 B after connect. When false, falls back
	 * to the default MTU of 23. Some older bootloaders may not honour MTU
	 * exchange — set to false if a target stalls immediately after connect.
	 */
	bool     high_mtu;

	/* Number of DFU attempts before giving up. */
	uint8_t  retries;

	/* Minimum RSSI (dBm, negative). Ads weaker than this are rejected
	 * during scan. -127 = no minimum. Refuses flashing when the signal
	 * isn't strong enough to reliably stream.
	 */
	int8_t   min_rssi;

	/* Cooldown between failed attempts (seconds). The DFU bootloader
	 * needs time to settle after a reset before it'll accept another
	 * START_DFU.
	 */
	uint16_t retry_cooldown;

	/* Extended cooldown used after a *post-connect* failure (response
	 * timeout, protocol error, mid-stream link drop). SDK 11-era stock
	 * Adafruit bootloaders that wedge mid-DFU only unstick when their
	 * internal inactivity watchdog fires — usually 60-120 s. Pre-connect
	 * failures use the short retry_cooldown.
	 */
	uint16_t wedge_cooldown;

	/* BLE transmit power in dBm. nRF54L allowed values:
	 *   -40, -20, -16, -12, -8, -4, 0, 3, 6, 8
	 * (nRF54L has fewer allowed levels than nRF52840.) Anything not in
	 * the list is silently clipped by the SoftDevice.
	 */
	int8_t   tx_power;

	/* Per-scan timeout (seconds). 0 = scan forever (default, intended for
	 * drone use). Non-zero caps the wait; on expiry the sequence gives up
	 * without consuming a DFU retry.
	 */
	uint16_t scan_timeout;

	/* If true, log every rejected advertisement (weak / name / UUID
	 * mismatch). Useful when diagnosing why a target isn't picked up.
	 * Off by default to keep the field log quiet.
	 */
	bool     scan_debug;

	/* Idle gap inserted between consecutive firmware packets, in
	 * milliseconds. 0 = send back-to-back.
	 *
	 * This is the single most important reliability knob when streaming
	 * with a negotiated 247 B MTU. ATT Write Commands carry no flow
	 * control, so a burst fired back-to-back arrives faster than an
	 * SDK 11-era bootloader can drain it: while it is committing to
	 * flash, its SoftDevice has no free RX buffer and silently discards
	 * whatever lands. Nothing surfaces at the link layer — the loss only
	 * shows up as a missing packet receipt, by which point the peer's
	 * image is already corrupt (it wrote the surviving packets of the
	 * burst into the hole left by the dropped ones).
	 *
	 * Legacy DFU has no in-session resume, so a dropped packet costs a
	 * full restart. Spacing packets out is far cheaper than retrying a
	 * 500 KB transfer. Raise this if a target keeps failing mid-stream.
	 */
	uint16_t pkt_gap_ms;

	/* Pause inserted after the one packet per flash page that makes the
	 * target erase, in milliseconds. 0 disables erase-aware pacing, and
	 * then pkt_gap_ms alone has to be large enough for the worst packet
	 * (measured floor 18 ms, ~12 KB/s).
	 *
	 * With it set, pkt_gap_ms only has to cover the target's flash *write*
	 * rate for the other ~16 packets in the page, so it can be small. That
	 * is where the throughput is: one expensive packet per 4 KB instead of
	 * pricing every packet as if it were the expensive one.
	 */
	uint16_t erase_pause_ms;

	/* Packets allowed into the target's buffer during a page erase before
	 * waiting out the rest of it. 0 stops dead at the boundary.
	 *
	 * The erase pauses are the single biggest cost once the connection
	 * interval is tuned — measured at 44% of a transfer, with the target's
	 * 8-slot ring sitting empty throughout. Overlapping a few packets with
	 * the erase reclaims most of that. Measured, 6 is too many: the ring is
	 * still draining the previous erase, so the failure lands on the second
	 * page and drifts. 2-3 is the usable range.
	 */
	uint8_t  erase_inflight;
};

/* Reset to compile-time defaults, then overlay whatever config.txt
 * exists on the filesystem. Returns true if config.txt was found +
 * parsed (any subset of keys), false if defaults were used unmodified.
 * Never fails destructively.
 */
bool app_config_load(void);

/* Read-only handle to the currently loaded config. Valid for the
 * lifetime of the process; safe to keep pointers into it.
 */
const struct app_config *app_config_current(void);

#ifdef __cplusplus
}
#endif
