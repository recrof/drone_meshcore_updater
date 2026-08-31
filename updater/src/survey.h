#pragma once

/*
 * The scanner's one entry point, and the thing that decides who owns a radio.
 *
 * There are two surveys — Bluetooth advertisers (ble_scanner.c) and WiFi
 * access points (wifi_survey.c) — and **at most one of them may ever be
 * running, and neither while a DFU is in flight.** Three reasons, in
 * increasing order of how expensive they are to learn the hard way:
 *
 *   1. On the ESP32 parts Bluetooth and WiFi are one 2.4 GHz radio, time-
 *      sliced by the coexistence layer. Two surveys do not fail; they each
 *      make the other slower and less complete, which reads as "the scanner
 *      misses devices" and is nearly impossible to attribute.
 *   2. A DFU is the operation that matters and it is already sharing that
 *      radio with the browser's own SMP link. Adding a scan to that is how a
 *      transfer that would have completed does not — and Legacy DFU has no
 *      resume, so the cost is the whole image (Trap 2).
 *   3. The WiFi transport associates with the target's own access point.
 *      Scanning across that is not merely noisy, it competes with the
 *      association the transport is trying to hold.
 *
 * So this file owns the arbitration rather than leaving it to callers, who
 * reach it from three different threads for three unrelated reasons. The rule
 * is stated once here and nowhere else:
 *
 *     a DFU beats a survey, and a survey of one kind replaces the other.
 *
 * The kind is chosen by the operator (two tabs in the scanner panel), which is
 * the honest interface for something that genuinely cannot do both at once.
 */

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

enum survey_kind {
	SURVEY_NONE = 0,
	SURVEY_BLE  = 1,
	SURVEY_WIFI = 2,
};

/* Flags on a row. Deliberately one field rather than two optional ones: the
 * two kinds have different interesting properties and a client renders one
 * column per tab, so a shared bitfield keeps the wire format from growing a
 * union it would have to explain. */
#define SURVEY_F_DFU    BIT(0)   /* BLE: advertises the Legacy DFU service */
#define SURVEY_F_SECURE BIT(1)   /* WiFi: anything other than an open network */
/* This row is one an *automatic* run would have gone for: a Bluetooth name
 * matching `ble_name`, or the ElegantOTA access point. Computed on the device
 * because both rules live there — `ble_name`'s pipe-delimited grammar and the
 * AP's name — and a client that reproduced either would be a drift pair.
 *
 * It is what the panel highlights, and what its "only what I could flash"
 * filter keeps. Note it is *not* the same as SURVEY_F_DFU: a peer already in
 * its bootloader advertises the DFU service under a name the filter may not
 * match, and is still very much a target. The UI treats either as interesting. */
#define SURVEY_F_MATCH  BIT(2)

#define SURVEY_ID_MAX   32       /* "AA:BB:CC:DD:EE:FF (random)" and slack */
#define SURVEY_NAME_MAX 33       /* a 32-octet SSID outgrows a BLE adv name */

/* One found thing, whichever radio found it. */
struct survey_row {
	char     id[SURVEY_ID_MAX];     /* BLE address, or WiFi BSSID */
	char     name[SURVEY_NAME_MAX]; /* advertised name, or SSID */
	int8_t   rssi;
	int8_t   best;
	uint16_t count;
	uint8_t  channel;               /* WiFi only; 0 for Bluetooth */
	uint8_t  flags;                 /* SURVEY_F_* */
};

/* Start `kind`, stopping whatever else was running. Repeat calls with the same
 * kind refresh the idle watchdog — which is how a polling client keeps a
 * survey alive — and do **not** clear the table: `best` and the sighting count
 * are accumulated history and a poll must not throw them away.
 *
 * `reset` asks for the opposite, and exists because that accumulation is
 * exactly wrong for a manual refresh. A survey that has been running holds
 * devices that were heard once and may be long gone, each showing the signal
 * it had when it was last heard. Someone who presses Refresh is asking "what
 * is out there *now*", and answering with a minute of history — indefinitely,
 * since nothing ever ages out — makes the button look broken.
 *
 * Returns 0, -EBUSY if a DFU owns the radio, -ENOTSUP if this build has no
 * radio of that kind, or a driver errno. */
int survey_start(enum survey_kind kind, bool reset);

/* Stop whatever is running. Safe when nothing is. */
void survey_stop(void);

/* What is running now, SURVEY_NONE if nothing. */
enum survey_kind survey_active(void);

/* Which kinds this build could ever run, as a bitmask of `1 << survey_kind`.
 * Asked by the client so it offers a WiFi tab only where there is a WiFi
 * radio — the same reasoning as fsxCaps(): a fact that exists once cannot
 * drift from a copy of itself. */
uint8_t survey_kinds_available(void);

/* Copy up to `max` rows from `off`, in insertion order. `*total` receives how
 * many are held. Returns the number copied. */
size_t survey_get(struct survey_row *out, size_t max, size_t off, size_t *total);
