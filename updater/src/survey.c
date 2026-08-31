/* The scanner's arbiter — see survey.h for the rule it enforces. */

#include "survey.h"
#include "ble_scanner.h"
#include "dfu_runner.h"
#include "config.h"

#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>
#include <zephyr/bluetooth/addr.h>

#include <stdio.h>
#include <string.h>

#if defined(CONFIG_WIFI)
#include "wifi_survey.h"
#include "elegantota.h"
#endif

LOG_MODULE_REGISTER(survey, LOG_LEVEL_INF);

static enum survey_kind s_kind;

uint8_t survey_kinds_available(void)
{
	uint8_t m = BIT(SURVEY_BLE);
#if defined(CONFIG_WIFI)
	m |= BIT(SURVEY_WIFI);
#endif
	return m;
}

void survey_stop(void)
{
	/* Both, unconditionally, rather than only the one we believe is
	 * running. s_kind is this file's opinion; the radios are the fact, and
	 * stopping one that is already stopped costs nothing. */
	ble_scanner_survey_stop();
#if defined(CONFIG_WIFI)
	wifi_survey_stop();
#endif
	s_kind = SURVEY_NONE;
}

int survey_start(enum survey_kind kind, bool reset)
{
	/* The DFU gate lives here and not in ble_scanner.c, which deliberately
	 * knows nothing about the runner. It is also not the only guard: the
	 * runner stops surveys when it starts, because a DFU triggered a
	 * moment after this check must still win. */
	if (dfu_runner_busy()) {
		return -EBUSY;
	}

	if (!(survey_kinds_available() & BIT(kind))) {
		return -ENOTSUP;
	}

	/* Switching kinds is a stop and a start, and the table goes with it —
	 * the two surveys hold entirely different things and merging them
	 * would produce a list where half the rows silently stopped updating.
	 *
	 * A reset is the same operation for a different reason, so it takes the
	 * same path rather than growing a second way to empty a table: starting
	 * a survey that is not running clears it, so stopping first is all a
	 * reset has to do. */
	if (reset || (s_kind != SURVEY_NONE && s_kind != kind)) {
		survey_stop();
	}

	int rc;
	switch (kind) {
	case SURVEY_BLE:
		rc = ble_scanner_survey_start();
		break;
#if defined(CONFIG_WIFI)
	case SURVEY_WIFI:
		rc = wifi_survey_start();
		break;
#endif
	default:
		return -ENOTSUP;
	}
	if (rc == 0) {
		s_kind = kind;
	}
	return rc;
}

enum survey_kind survey_active(void)
{
	if (ble_scanner_survey_active()) return SURVEY_BLE;
#if defined(CONFIG_WIFI)
	if (wifi_survey_active()) return SURVEY_WIFI;
#endif
	/* Neither radio is scanning, whatever s_kind last recorded — the idle
	 * watchdogs stop themselves and do not report back, so the radios are
	 * asked rather than trusted to a variable. */
	return SURVEY_NONE;
}

size_t survey_get(struct survey_row *out, size_t max, size_t off, size_t *total)
{
	if (total) *total = 0;

	/* Read once per call, not per row: it is a pointer to module state in
	 * config.c and re-reading it inside the loop would buy nothing. */
	const struct app_config *cfg = app_config_current();

	switch (s_kind) {
	case SURVEY_BLE: {
		struct ble_scanner_seen tmp[8];
		size_t written = 0;
		size_t held = 0;
		/* Pulled a few at a time so neither this stack frame nor the
		 * caller's has to hold the whole table. This runs on the
		 * mcumgr thread, which has lost several KB to littlefs before
		 * now and is the last place to put a 1 KB local array. */
		while (written < max) {
			size_t n = ble_scanner_survey_get(
				tmp, MIN(ARRAY_SIZE(tmp), max - written),
				off + written, &held);
			if (n == 0) break;
			for (size_t i = 0; i < n; i++) {
				struct survey_row *r = &out[written + i];
				memset(r, 0, sizeof(*r));
				bt_addr_le_to_str(&tmp[i].addr, r->id, sizeof(r->id));
				snprintf(r->name, sizeof(r->name), "%s", tmp[i].name);
				r->rssi  = tmp[i].rssi;
				r->best  = tmp[i].best;
				r->count = tmp[i].count;
				r->flags = tmp[i].dfu_uuid ? SURVEY_F_DFU : 0;
				/* Marked here rather than in the client: the
				 * filter's pipe-delimited grammar lives in
				 * ble_scanner.c and a second implementation of
				 * it would drift silently. */
				if (cfg != NULL &&
				    ble_scanner_name_matches(tmp[i].name, cfg->ble_name)) {
					r->flags |= SURVEY_F_MATCH;
				}
			}
			written += n;
		}
		if (total) *total = held;
		return written;
	}
#if defined(CONFIG_WIFI)
	case SURVEY_WIFI: {
		struct wifi_survey_ap tmp[6];
		size_t written = 0;
		size_t held = 0;
		while (written < max) {
			size_t n = wifi_survey_get(
				tmp, MIN(ARRAY_SIZE(tmp), max - written),
				off + written, &held);
			if (n == 0) break;
			for (size_t i = 0; i < n; i++) {
				struct survey_row *r = &out[written + i];
				memset(r, 0, sizeof(*r));
				snprintf(r->id, sizeof(r->id),
					 "%02X:%02X:%02X:%02X:%02X:%02X",
					 tmp[i].bssid[0], tmp[i].bssid[1],
					 tmp[i].bssid[2], tmp[i].bssid[3],
					 tmp[i].bssid[4], tmp[i].bssid[5]);
				/* A hidden network advertises a zero-length
				 * SSID. Saying so beats an empty cell, which
				 * reads as a rendering bug.
				 *
				 * Copied rather than snprintf'd through the
				 * ternary: joining a char[33] and a string
				 * literal yields a bare char *, GCC loses the
				 * array bound with it, and warns about a
				 * truncation that cannot happen. strnlen makes
				 * the bound visible again instead of hiding a
				 * real check behind a pragma. */
				const char *ssid = tmp[i].ssid[0] ? tmp[i].ssid
								 : "(hidden)";
				size_t sl = strnlen(ssid, sizeof(r->name) - 1);
				memcpy(r->name, ssid, sl);
				r->name[sl] = '\0';
				r->rssi    = tmp[i].rssi;
				r->best    = tmp[i].best;
				r->count   = tmp[i].count;
				r->channel = tmp[i].channel;
				r->flags   = tmp[i].secure ? SURVEY_F_SECURE : 0;
				/* The one network this updater can actually
				 * reach a target through. */
				if (!strcmp(tmp[i].ssid, OTA_SSID)) {
					r->flags |= SURVEY_F_MATCH;
				}
			}
			written += n;
		}
		if (total) *total = held;
		return written;
	}
#endif
	default:
		return 0;
	}
}
