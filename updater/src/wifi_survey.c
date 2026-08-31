/*
 * WiFi access-point survey — see wifi_survey.h for the contract.
 *
 * Note on sharing the radio with the ElegantOTA transport: both register their
 * own net_mgmt callback for the same events, which Zephyr allows, and both are
 * never active at once because survey.c stops a survey before a DFU can begin.
 * The transport's own scan_for_ap() therefore never sees results meant for
 * this table and vice versa — they are simply two listeners on one event.
 */

#include "wifi_survey.h"

#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>
#include <zephyr/net/net_if.h>
#include <zephyr/net/net_mgmt.h>
#include <zephyr/net/wifi_mgmt.h>

#include <string.h>

LOG_MODULE_REGISTER(wifi_survey, LOG_LEVEL_INF);

/* Matches the Bluetooth survey's, and for the same reason: a client that has
 * gone away must not leave the radio sweeping. Longer than the BLE one because
 * a sweep itself takes seconds — timing out mid-sweep would stop a survey that
 * is working. */
#define SURVEY_IDLE_TIMEOUT_MS 12000

static struct {
	struct net_mgmt_event_callback cb;
	struct wifi_survey_ap          tbl[WIFI_SURVEY_MAX];
	size_t                         n;
	struct k_spinlock              lock;
	bool                           registered;
	bool                           active;
	bool                           sweeping;
	/* Set at the start of each sweep, cleared as APs are re-seen. What it
	 * buys is an accurate `count`: without it a single sweep reporting the
	 * same BSSID twice (which happens) would inflate the number that is
	 * supposed to mean "sweeps it appeared in". */
	bool                           seen_this_sweep[WIFI_SURVEY_MAX];
} s;

static void idle_fn(struct k_work *work);
static K_WORK_DELAYABLE_DEFINE(s_idle, idle_fn);

static int start_sweep(void);

static void survey_evt(struct net_mgmt_event_callback *cb, uint64_t event,
		       struct net_if *iface)
{
	ARG_UNUSED(iface);

	if (event == NET_EVENT_WIFI_SCAN_RESULT) {
		const struct wifi_scan_result *r =
			(const struct wifi_scan_result *)cb->info;

		k_spinlock_key_t key = k_spin_lock(&s.lock);

		size_t idx = SIZE_MAX;
		for (size_t i = 0; i < s.n; i++) {
			if (!memcmp(s.tbl[i].bssid, r->mac, sizeof(s.tbl[i].bssid))) {
				idx = i;
				break;
			}
		}
		if (idx == SIZE_MAX && s.n < ARRAY_SIZE(s.tbl)) {
			idx = s.n++;
			memset(&s.tbl[idx], 0, sizeof(s.tbl[idx]));
			s.tbl[idx].best = -128;
			memcpy(s.tbl[idx].bssid, r->mac, sizeof(s.tbl[idx].bssid));
		}
		if (idx == SIZE_MAX) {
			/* Table full. Unlike the Bluetooth side there is no
			 * eviction score worth computing: every row here is an
			 * access point, so none of them is less relevant than
			 * another the way a stray beacon is. */
			k_spin_unlock(&s.lock, key);
			return;
		}

		struct wifi_survey_ap *ap = &s.tbl[idx];
		size_t sl = MIN((size_t)r->ssid_length, sizeof(ap->ssid) - 1);
		if (sl > 0) {
			memcpy(ap->ssid, r->ssid, sl);
			ap->ssid[sl] = '\0';
		}
		ap->rssi    = (int8_t)r->rssi;
		if (r->rssi > ap->best) ap->best = (int8_t)r->rssi;
		ap->channel = r->channel;
		ap->band    = r->band;
		ap->secure  = (r->security != WIFI_SECURITY_TYPE_NONE);
		if (!s.seen_this_sweep[idx]) {
			s.seen_this_sweep[idx] = true;
			if (ap->count < UINT16_MAX) ap->count++;
		}
		k_spin_unlock(&s.lock, key);
		return;
	}

	if (event == NET_EVENT_WIFI_SCAN_DONE) {
		s.sweeping = false;
		/* Rolling: the next sweep is what keeps the list live. Checked
		 * against `active` rather than started unconditionally, or a
		 * stop would never take effect. */
		if (s.active) {
			(void)start_sweep();
		}
	}
}

static int start_sweep(void)
{
	struct net_if *iface = net_if_get_first_wifi();
	if (!iface) return -ENODEV;
	if (s.sweeping) return 0;

	k_spinlock_key_t key = k_spin_lock(&s.lock);
	memset(s.seen_this_sweep, 0, sizeof(s.seen_this_sweep));
	k_spin_unlock(&s.lock, key);

	int rc = net_mgmt(NET_REQUEST_WIFI_SCAN, iface, NULL, 0);
	if (rc) {
		LOG_WRN("scan request rc=%d", rc);
		return rc;
	}
	s.sweeping = true;
	return 0;
}

static void idle_fn(struct k_work *work)
{
	ARG_UNUSED(work);
	if (!s.active) return;
	LOG_INF("survey: no client for %d ms — stopping", SURVEY_IDLE_TIMEOUT_MS);
	wifi_survey_stop();
}

int wifi_survey_start(void)
{
	if (s.active) {
		k_work_reschedule(&s_idle, K_MSEC(SURVEY_IDLE_TIMEOUT_MS));
		return 0;
	}
	if (!net_if_get_first_wifi()) return -ENODEV;

	if (!s.registered) {
		net_mgmt_init_event_callback(&s.cb, survey_evt,
			NET_EVENT_WIFI_SCAN_RESULT | NET_EVENT_WIFI_SCAN_DONE);
		net_mgmt_add_event_callback(&s.cb);
		s.registered = true;
	}

	k_spinlock_key_t key = k_spin_lock(&s.lock);
	s.n = 0;
	k_spin_unlock(&s.lock, key);

	s.active = true;
	int rc = start_sweep();
	if (rc) {
		s.active = false;
		return rc;
	}
	k_work_reschedule(&s_idle, K_MSEC(SURVEY_IDLE_TIMEOUT_MS));
	LOG_INF("survey: started");
	return 0;
}

void wifi_survey_stop(void)
{
	k_work_cancel_delayable(&s_idle);
	if (!s.active) return;
	s.active = false;
	LOG_INF("survey: stopped");
	/* A sweep in flight is left alone. There is no cancel in the WiFi
	 * management API, and forcing a disconnect to end one would be a far
	 * bigger hammer than the problem — its results land in a table that
	 * nobody is going to read. */
}

bool wifi_survey_active(void)
{
	return s.active;
}

size_t wifi_survey_get(struct wifi_survey_ap *out, size_t max, size_t off,
		       size_t *total)
{
	k_spinlock_key_t key = k_spin_lock(&s.lock);
	size_t held = s.n;
	size_t n = 0;
	for (size_t i = off; i < held && n < max; i++) {
		out[n++] = s.tbl[i];
	}
	k_spin_unlock(&s.lock, key);
	if (total) *total = held;
	return n;
}
