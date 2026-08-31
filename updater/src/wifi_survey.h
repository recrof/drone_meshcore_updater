#pragma once

/*
 * WiFi access-point survey — the WiFi half of the scanner panel.
 *
 * Shaped after ble_scanner's survey and used through survey.h, which is what
 * enforces that only one of the two ever runs. The differences from the
 * Bluetooth side are not cosmetic and both come from the same fact: **a WiFi
 * scan is a one-shot operation that finishes, while a BLE scan is a state the
 * radio sits in.**
 *
 *   - Staying "live" therefore means re-issuing a scan each time the previous
 *     one reports done, rather than leaving the radio listening. A sweep takes
 *     a few seconds, so the list updates in steps and not continuously; the
 *     sighting count is how many sweeps an AP appeared in, which is the WiFi
 *     equivalent of "is this steady or intermittent".
 *   - RSSI is therefore also per sweep, not per packet, so `best` is a good
 *     deal more meaningful here than the instantaneous value someone is
 *     watching while they aim an antenna.
 *
 * Compiled only when CONFIG_WIFI is set; survey.c supplies the "no WiFi on
 * this board" answer otherwise, so nothing above has to know which boards
 * have a second radio.
 */

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define WIFI_SURVEY_MAX      24
#define WIFI_SURVEY_SSID_MAX 33   /* 32 octets + NUL */

struct wifi_survey_ap {
	char     ssid[WIFI_SURVEY_SSID_MAX];
	uint8_t  bssid[6];
	int8_t   rssi;      /* most recent sweep */
	int8_t   best;      /* strongest this survey */
	uint16_t count;     /* sweeps it appeared in */
	uint8_t  channel;
	uint8_t  band;      /* enum wifi_frequency_bands */
	bool     secure;    /* anything other than an open network */
};

/* Begin, or refresh the watchdog on, a rolling scan. Idempotent. Returns 0,
 * -ENODEV with no WiFi interface, or a driver errno. */
int wifi_survey_start(void);

/* Stop re-issuing. A sweep already in flight is left to finish — there is no
 * way to cancel one, and its results simply land in a table nobody reads. */
void wifi_survey_stop(void);

bool wifi_survey_active(void);

/* Copy up to `max` rows from `off`. Insertion order, for the same reason the
 * BLE survey uses it: signal order would renumber the table under a paginating
 * client. */
size_t wifi_survey_get(struct wifi_survey_ap *out, size_t max, size_t off,
		       size_t *total);
