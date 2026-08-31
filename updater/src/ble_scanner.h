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

/* Does `name` match a `ble_name`-style filter?
 *
 * Pipe-delimited substring OR: "RAK4631 | 4631_DFU" matches either. Exported
 * because the scanner panel marks the rows auto-flash *would* have picked, and
 * re-implementing this rule in the client would be a drift pair with nothing
 * checking it — the grammar is not obvious enough to reproduce by eye.
 *
 * Empty filter or empty name is false: a filter that matches everything is not
 * what an empty `ble_name` means.
 */
bool ble_scanner_name_matches(const char *name, const char *filter);

/* Find one *specific* peer, ready to flash it.
 *
 * The manual counterpart to find_first(): the operator picked this device out
 * of a survey, so the configured `ble_name` and `min_rssi` are not applied.
 * Both would be wrong here — the name filter is how you find a target you did
 * not choose, and refusing a weak one is the opposite of useful to someone who
 * opened the scanner precisely because the link is marginal.
 *
 * `addr` **or `addr` + 1** matches, and nothing else does. The +1 is not a
 * convenience: a Nordic peer with buttonless DFU advertises its bootloader one
 * MAC above its application, so an operator who pins the application address
 * would otherwise lose the device the moment the jump succeeds. Accepting only
 * those two is what separates this from find_first() with `prefer_mac`, which
 * also takes any DFU-UUID advertiser and is therefore too loose to honour a
 * deliberate choice.
 *
 * Returns 0 on match, -ETIMEDOUT, -ECANCELED, or a radio errno.
 */
int ble_scanner_find_pinned(struct ble_scanner_target *out,
			    uint32_t timeout_ms,
			    const bt_addr_le_t *addr);

/* ---- Survey: every advertiser, not the first useful one ------------------
 *
 * find_first() answers "is there something to flash". A survey answers "what
 * can this radio hear, and how well" — the question you have when an update
 * fails at range and you cannot tell a deaf antenna from an absent target.
 *
 * It applies no filters at all, on purpose. A target that fails `min_rssi` is
 * exactly the one worth showing, and a scan that finds nothing but a phone
 * still proves the receiver works.
 *
 * **One radio, one user.** A survey and a DFU cannot both own the scanner, so
 * survey_start() refuses with -EBUSY while a find is in flight, and starting a
 * DFU stops a survey rather than queueing behind it — the transfer is the
 * operation that matters and the operator asking for it is the one watching.
 */

#define BLE_SCANNER_SURVEY_MAX 32

struct ble_scanner_seen {
	bt_addr_le_t addr;
	int8_t   rssi;                           /* most recent sighting */
	int8_t   best;                           /* strongest this survey */
	uint16_t count;                          /* advertisements seen */
	char     name[BLE_SCANNER_NAME_MAX];
	bool     dfu_uuid;
};

/* Begin (or restart the watchdog on) a survey. Idempotent: calling it while
 * one is already running just refreshes the idle timer, which is how a polling
 * client keeps it alive. Returns 0, or -EBUSY if a DFU owns the radio. */
int ble_scanner_survey_start(void);

/* End a survey and stop the radio. Safe when none is running. */
void ble_scanner_survey_stop(void);

/* Is a survey running right now? */
bool ble_scanner_survey_active(void);

/* Copy up to `max` entries starting at `off` into `out`. `*total` receives the
 * number held, so a caller can paginate and know whether more remain. Returns
 * the number copied.
 *
 * **Insertion order, not signal order.** Sorting here would be the obvious
 * courtesy and would break pagination: RSSI changes between one request and
 * the next, so a sorted table renumbers itself under the client and `off`
 * would skip and repeat rows. The order is therefore stable and boring, and
 * the client — which holds the whole list anyway — does the sorting. */
size_t ble_scanner_survey_get(struct ble_scanner_seen *out, size_t max,
			      size_t off, size_t *total);

/* ---- Lending the radio out ----------------------------------------------
 *
 * Run `fn` with the scanner stopped, whoever owns it, and put it back exactly
 * as it was. Returns whatever `fn` returned; a scan that will not resume is
 * logged, and a *find* that loses its radio is cancelled rather than left to
 * wait out a timeout it can no longer meet.
 *
 * **There is exactly one caller and it is not a convenience.** Restarting a
 * connectable advertiser makes the host issue HCI LE Set Random Address (to
 * put the identity address back over whatever NRPA the active scan is using),
 * and that command is Command Disallowed while a scan is enabled. So on a
 * controller without extended advertising — every board here but the MG24 —
 * bt_le_adv_start() *cannot succeed while this file is scanning*.
 *
 * The consequence was that a client disconnecting during a scan left the
 * device off the air for good: the one restart attempt failed, nothing
 * retried, and the survey's idle timeout released the radio a few seconds
 * later with nobody left to notice. Recovery was a power cycle, on a device
 * whose whole purpose is being somewhere you cannot reach. See main.c, and
 * Trap 14 in notes/traps.md.
 *
 * Being reachable outranks scanning for the few milliseconds this takes, so
 * the pause is unconditional rather than something a DFU can refuse. It costs
 * a find one blind interval; it is the difference between an operator getting
 * their device back and not. */
int ble_scanner_with_radio_paused(int (*fn)(void));

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

#ifdef __cplusplus
}
#endif
