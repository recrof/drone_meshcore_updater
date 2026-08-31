/*
 * BLE central scanner — see ble_scanner.h for the public contract.
 *
 * Implementation notes:
 *  - Zephyr calls the RX callback from the BT-RX thread. We match / filter
 *    in that context and signal via a semaphore rather than blocking there,
 *    so find_first() can wake up cleanly and stop the scan from its own
 *    thread (the API function's caller).
 *  - Advertisement data is TLV; walking it means iterating with
 *    bt_data_parse and picking out NAME + SVC_UUID128. We do both in one
 *    pass so a single ad match reads all fields at once.
 *  - `s_ctx` is process-wide (only one scan at a time is meaningful), so
 *    find_first() is not re-entrant. One scan at a time is all we need.
 */

#include "ble_scanner.h"

#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>
#include <zephyr/bluetooth/bluetooth.h>
#include <zephyr/bluetooth/uuid.h>
#include <zephyr/bluetooth/hci.h>
#include <string.h>

LOG_MODULE_REGISTER(ble_scanner, LOG_LEVEL_INF);

/* Nordic Legacy DFU service UUID: 00001530-1212-EFDE-1523-785FEABCD123
 * Bytes in Zephyr LE order (reverse of textual form).
 */
static const struct bt_uuid_128 legacy_dfu_uuid = BT_UUID_INIT_128(
	0x23, 0xD1, 0xBC, 0xEA, 0x5F, 0x78, 0x23, 0x15,
	0xDE, 0xEF, 0x12, 0x12, 0x30, 0x15, 0x00, 0x00);

/* Single-scan context. Not re-entrant. */
static struct {
	struct k_sem              found_sem;
	struct ble_scanner_target match;
	bool                      found;
	const char               *name_filter;
	int8_t                    min_rssi;
	const bt_addr_le_t       *prefer_mac;
	/* Non-NULL switches the callback into "this address and nothing else"
	 * mode: name, service UUID and RSSI are all ignored. Used to ask
	 * whether one specific peer is on the air, which is a different
	 * question from "find me something to flash". */
	const bt_addr_le_t       *exact_addr;
	/* Non-NULL restricts the match to this address or this address + 1,
	 * with every other filter off. The operator chose this peer out of a
	 * survey; the +1 keeps hold of it across a buttonless jump into the
	 * bootloader, which advertises one MAC above the application. */
	const bt_addr_le_t       *pinned_addr;
	bool                      debug;
} s_ctx;

static bool s_debug;
static bool s_sem_inited;

/*
 * Who owns the radio's single scan slot.
 *
 * Zephyr allows one bt_le_scan_start() at a time and one callback with it, so
 * the survey and the DFU search cannot coexist — and this is not a detail the
 * callers can be trusted to remember, because the two are started from
 * different threads for different reasons (an operator polling the scanner
 * panel, and a DFU run that began ten minutes ago). The rule is stated once,
 * here: a find takes the radio from a survey, and a survey will not take it
 * from a find.
 */
enum radio_user {
	RADIO_IDLE = 0,
	RADIO_FIND,
	RADIO_SURVEY,
};
static atomic_t s_radio = ATOMIC_INIT(RADIO_IDLE);

/* Serialises every bt_le_scan_start()/stop() in this file and every change of
 * s_radio with it.
 *
 * The atomic alone was enough while the only two users were the find and the
 * survey, because each of those *owns* the radio for its whole run. It stopped
 * being enough with ble_scanner_with_radio_paused(), which takes the radio away
 * from a run that is still going and gives it back — so it can interleave with
 * that run's own stop. Recursive by design (Zephyr's k_mutex counts re-locks by
 * the owning thread): scan_and_wait() holds it across the survey stop that a
 * find performs on its way in.
 *
 * The wait for a match is deliberately *outside* the lock. Holding it there
 * would make a pause block for the length of a scan, which for an auto_flash
 * run with scan_timeout=0 is forever — the exact case this exists to fix. */
static K_MUTEX_DEFINE(s_radio_lock);

/* One set of scan parameters for both users.
 *
 * They were duplicated, identically, in the two places that start a scan. That
 * is a drift pair with nothing checking it, and ble_scanner_with_radio_paused()
 * makes it a correctness matter rather than a tidiness one: it restarts a scan
 * that somebody else configured, so it has to know it is putting back what was
 * there.
 *
 * Active so scan responses are caught too — some peers put the name only
 * there. 160 * 0.625 = 100 ms interval, 80 * 0.625 = 50 ms window: a 50% duty
 * cycle. */
static const struct bt_le_scan_param s_scan_params = {
	.type     = BT_LE_SCAN_TYPE_ACTIVE,
	.options  = BT_LE_SCAN_OPT_NONE,
	.interval = 160,
	.window   = 80,
};

void ble_scanner_set_debug(bool on) { s_debug = on; }

/* Pipe-delimited substring match. Returns true if `name` contains any of
 * the '|'-separated tokens in `filter`. Empty filter or empty name -> false.
 */
bool ble_scanner_name_matches(const char *name, const char *filter)
{
	if (!name || !filter || !filter[0] || !name[0]) return false;

	char buf[BLE_SCANNER_NAME_MAX];
	size_t n = strnlen(filter, sizeof(buf) - 1);
	memcpy(buf, filter, n);
	buf[n] = '\0';

	char *save = NULL;
	for (char *tok = strtok_r(buf, "|", &save); tok; tok = strtok_r(NULL, "|", &save)) {
		/* Trim leading/trailing whitespace. */
		while (*tok == ' ' || *tok == '\t') tok++;
		char *end = tok + strlen(tok);
		while (end > tok && (end[-1] == ' ' || end[-1] == '\t')) *--end = '\0';
		if (*tok && strstr(name, tok)) return true;
	}
	return false;
}

/* True if `a` equals `ref` or `ref + 1` (byte-carry across all 6 bytes).
 * Nordic Legacy DFU bootloaders that boot out of an app-mode firmware
 * typically advertise from a MAC that's one higher than the app's MAC.
 */
static bool mac_match_or_plus_one(const bt_addr_le_t *a, const bt_addr_le_t *ref)
{
	if (!ref) return false;
	if (a->type != ref->type) return false;
	if (bt_addr_eq(&a->a, &ref->a)) return true;
	bt_addr_t plus_one = ref->a;
	for (int i = 0; i < 6; i++) {
		plus_one.val[i]++;
		if (plus_one.val[i] != 0) break;  /* no further carry */
	}
	return bt_addr_eq(&a->a, &plus_one);
}

/* Per-ad state assembled by bt_data_parse. */
struct ad_parse {
	char name[BLE_SCANNER_NAME_MAX];
	bool has_dfu_uuid;
};

static bool ad_data_cb(struct bt_data *data, void *user_data)
{
	struct ad_parse *ap = user_data;

	switch (data->type) {
	case BT_DATA_NAME_COMPLETE:
	case BT_DATA_NAME_SHORTENED: {
		size_t cap = sizeof(ap->name) - 1;
		size_t n = data->data_len > cap ? cap : data->data_len;
		memcpy(ap->name, data->data, n);
		ap->name[n] = '\0';
		return true;
	}
	case BT_DATA_UUID128_ALL:
	case BT_DATA_UUID128_SOME: {
		/* One or more 128-bit UUIDs concatenated. Scan for our
		 * Legacy DFU UUID in bytes.
		 */
		for (size_t off = 0; off + 16 <= data->data_len; off += 16) {
			if (memcmp(&data->data[off], legacy_dfu_uuid.val, 16) == 0) {
				ap->has_dfu_uuid = true;
				return false;   /* stop parse — we have what we need */
			}
		}
		return true;
	}
	default:
		return true;
	}
}

/* One-line summary of a rejected ad. De-duplicated per (MAC, reason)
 * so dense BLE environments don't flood the log.
 */
static void log_rejected(const bt_addr_le_t *addr, const char *name,
			 int8_t rssi, const char *reason)
{
	if (!s_ctx.debug) return;

	static uint8_t seen_macs[8][6];
	static char    seen_reasons[8][8];
	static uint8_t seen_count;
	for (uint8_t i = 0; i < seen_count; i++) {
		if (memcmp(seen_macs[i], addr->a.val, 6) == 0 &&
		    strncmp(seen_reasons[i], reason, sizeof(seen_reasons[0])) == 0) {
			return;
		}
	}
	if (seen_count < 8) {
		memcpy(seen_macs[seen_count], addr->a.val, 6);
		snprintf(seen_reasons[seen_count], sizeof(seen_reasons[0]), "%s", reason);
		seen_count++;
	}

	char addr_s[BT_ADDR_LE_STR_LEN];
	bt_addr_le_to_str(addr, addr_s, sizeof(addr_s));
	LOG_INF("reject %s: %s rssi=%d name='%s'", reason, addr_s, rssi, name);
}

/* RX callback fires per received advertisement. */
static void scan_rx_cb(const bt_addr_le_t *addr, int8_t rssi, uint8_t adv_type,
		       struct net_buf_simple *ad)
{
	ARG_UNUSED(adv_type);
	if (s_ctx.found) return;

	struct ad_parse ap = { .name = { 0 }, .has_dfu_uuid = false };
	bt_data_parse(ad, ad_data_cb, &ap);

	/* Pinned mode: a deliberate choice, so name, UUID and RSSI are all
	 * off. Weak is not a reason to refuse a device the operator pointed
	 * at — it is usually the thing they are trying to look at. */
	if (s_ctx.pinned_addr != NULL) {
		if (!mac_match_or_plus_one(addr, s_ctx.pinned_addr)) {
			return;
		}
		goto matched;
	}

	/* Exact-address mode answers a yes/no question about one peer, so
	 * every other filter is off — including RSSI. A faint sighting still
	 * means the peer is advertising, and that is the whole answer. */
	if (s_ctx.exact_addr != NULL) {
		if (!bt_addr_le_eq(addr, s_ctx.exact_addr)) {
			return;
		}
		goto matched;
	}

	/* RSSI threshold first — cheapest test. */
	if (rssi < s_ctx.min_rssi) {
		log_rejected(addr, ap.name, rssi, "weak");
		return;
	}

	bool mac_ok  = mac_match_or_plus_one(addr, s_ctx.prefer_mac);
	bool have_nf = (s_ctx.name_filter && s_ctx.name_filter[0]);
	bool name_ok = have_nf && ble_scanner_name_matches(ap.name, s_ctx.name_filter);
	bool uuid_ok = (!mac_ok && !have_nf) ? ap.has_dfu_uuid : false;

	if (!(mac_ok || name_ok || uuid_ok)) {
		log_rejected(addr, ap.name, rssi,
			     have_nf ? "name?" : "uuid?");
		return;
	}

matched:
	bt_addr_le_copy(&s_ctx.match.addr, addr);
	s_ctx.match.rssi = rssi;
	memcpy(s_ctx.match.name, ap.name, sizeof(ap.name));
	s_ctx.match.dfu_uuid = ap.has_dfu_uuid;
	s_ctx.found = true;
	k_sem_give(&s_ctx.found_sem);
}

/* Set by ble_scanner_cancel(), cleared at the top of every find_first(). Read
 * after the semaphore wakes, to tell "a peer matched" from "someone gave up on
 * our behalf" — both arrive as the same k_sem_give(). */
static atomic_t s_cancel = ATOMIC_INIT(0);

void ble_scanner_cancel(void)
{
	atomic_set(&s_cancel, 1);
	/* Only if the semaphore exists: cancelling before the first scan has
	 * ever run is legal and is a no-op. */
	if (s_sem_inited) {
		k_sem_give(&s_ctx.found_sem);
	}
}

/*
 * Arm s_ctx, run one scan, wait for a match or the timeout, stop.
 *
 * Shared by both public entry points because the radio half is identical and
 * only the acceptance test differs — which is a field in s_ctx, not a
 * different scan. Callers set the criteria; this owns the semaphore, the
 * start/stop pair, and the three ways a wait can end.
 */
static int scan_and_wait(uint32_t timeout_ms)
{
	if (!s_sem_inited) {
		k_sem_init(&s_ctx.found_sem, 0, 1);
		s_sem_inited = true;
	} else {
		k_sem_reset(&s_ctx.found_sem);
	}

	k_mutex_lock(&s_radio_lock, K_FOREVER);

	/* A find outranks a survey — see enum radio_user. Stopping it here
	 * rather than asking the caller to means every entry point gets this
	 * right, including the ones added later. */
	ble_scanner_survey_stop();
	atomic_set(&s_radio, RADIO_FIND);

	atomic_clear(&s_cancel);
	s_ctx.found = false;
	s_ctx.debug = s_debug;
	memset(&s_ctx.match, 0, sizeof(s_ctx.match));

	int rc = bt_le_scan_start(&s_scan_params, scan_rx_cb);
	if (rc) {
		/* Hand the radio back. Without this the failure is permanent
		 * and silent in a way the log does not show: s_radio stays
		 * RADIO_FIND, so every later survey answers -EBUSY and the
		 * scanner panel reports a DFU that is not running. */
		atomic_set(&s_radio, RADIO_IDLE);
		k_mutex_unlock(&s_radio_lock);
		LOG_ERR("bt_le_scan_start rc=%d", rc);
		return rc;
	}
	k_mutex_unlock(&s_radio_lock);

	rc = k_sem_take(&s_ctx.found_sem,
			timeout_ms == 0 ? K_FOREVER : K_MSEC(timeout_ms));

	k_mutex_lock(&s_radio_lock, K_FOREVER);
	int stop_rc = bt_le_scan_stop();
	if (stop_rc && stop_rc != -EALREADY) {
		LOG_WRN("bt_le_scan_stop rc=%d", stop_rc);
	}
	atomic_cas(&s_radio, RADIO_FIND, RADIO_IDLE);
	k_mutex_unlock(&s_radio_lock);

	/* Checked before rc, because a cancel wakes the semaphore exactly as a
	 * match does — rc is 0 either way and s_ctx.match is stale. */
	if (atomic_get(&s_cancel)) {
		LOG_INF("scan cancelled");
		return -ECANCELED;
	}
	if (rc == -EAGAIN) return -ETIMEDOUT;
	return rc;
}

int ble_scanner_find_first(struct ble_scanner_target *out,
			   uint32_t timeout_ms,
			   const char *name_filter,
			   int8_t min_rssi,
			   const bt_addr_le_t *prefer_mac)
{
	if (!out) return -EINVAL;

	s_ctx.name_filter = name_filter;
	s_ctx.min_rssi    = min_rssi;
	s_ctx.prefer_mac  = prefer_mac;
	s_ctx.exact_addr  = NULL;
	s_ctx.pinned_addr = NULL;

	LOG_INF("scan started (name='%s' min_rssi=%d %s%s)",
		name_filter ? name_filter : "",
		min_rssi,
		prefer_mac ? "mac_fallback " : "",
		timeout_ms == 0 ? "no_timeout" : "with_timeout");

	int rc = scan_and_wait(timeout_ms);
	if (rc) {
		return rc;
	}

	*out = s_ctx.match;
	char addr_s[BT_ADDR_LE_STR_LEN];
	bt_addr_le_to_str(&out->addr, addr_s, sizeof(addr_s));
	LOG_INF("scan match: %s rssi=%d name='%s'", addr_s, out->rssi, out->name);
	return 0;
}

int ble_scanner_find_pinned(struct ble_scanner_target *out,
			    uint32_t timeout_ms,
			    const bt_addr_le_t *addr)
{
	if (!out || !addr) return -EINVAL;

	s_ctx.name_filter = NULL;
	s_ctx.min_rssi    = -127;
	s_ctx.prefer_mac  = NULL;
	s_ctx.exact_addr  = NULL;
	s_ctx.pinned_addr = addr;

	char addr_s[BT_ADDR_LE_STR_LEN];
	bt_addr_le_to_str(addr, addr_s, sizeof(addr_s));
	LOG_INF("scan started (pinned to %s or +1, no name/rssi filter)", addr_s);

	int rc = scan_and_wait(timeout_ms);
	s_ctx.pinned_addr = NULL;   /* it points at the caller's storage */
	if (rc) {
		return rc;
	}

	*out = s_ctx.match;
	bt_addr_le_to_str(&out->addr, addr_s, sizeof(addr_s));
	LOG_INF("pinned match: %s rssi=%d name='%s'", addr_s, out->rssi, out->name);
	return 0;
}

int ble_scanner_seen_at(const bt_addr_le_t *addr, uint32_t timeout_ms,
			struct ble_scanner_target *out)
{
	if (!addr || timeout_ms == 0) return -EINVAL;

	s_ctx.name_filter = NULL;
	s_ctx.min_rssi    = -127;    /* no filter; see scan_rx_cb */
	s_ctx.prefer_mac  = NULL;
	s_ctx.exact_addr  = addr;
	s_ctx.pinned_addr = NULL;

	char addr_s[BT_ADDR_LE_STR_LEN];
	bt_addr_le_to_str(addr, addr_s, sizeof(addr_s));
	LOG_INF("watching for %s for %u ms", addr_s, timeout_ms);

	int rc = scan_and_wait(timeout_ms);
	s_ctx.exact_addr = NULL;     /* it points at the caller's stack */
	if (rc) {
		return rc;
	}

	LOG_INF("%s is advertising: rssi=%d name='%s' dfu_service=%s",
		addr_s, s_ctx.match.rssi, s_ctx.match.name,
		s_ctx.match.dfu_uuid ? "yes" : "no");
	if (out) {
		*out = s_ctx.match;
	}
	return 0;
}


/* ======================= survey =========================================
 *
 * A second scan mode that keeps a table instead of stopping at the first
 * match. See ble_scanner.h for why it filters nothing.
 */

static struct {
	struct ble_scanner_seen tbl[BLE_SCANNER_SURVEY_MAX];
	size_t                  n;
	struct k_spinlock       lock;
} s_survey;

/* Stops a survey nobody is watching any more.
 *
 * The client keeps a survey alive by polling it, so the failure this guards
 * against is a browser tab that closes mid-scan: without it the radio would
 * keep scanning until the next reboot, quietly costing power and — worse —
 * holding the slot a later DFU wants. An idle timer means the worst case is
 * bounded by one interval rather than by whether anyone thought to send a
 * stop.
 */
#define SURVEY_IDLE_TIMEOUT_MS 6000

static void survey_idle_fn(struct k_work *work);
static K_WORK_DELAYABLE_DEFINE(s_survey_idle, survey_idle_fn);

/* How much we want to keep an entry when the table is full. A named device
 * beats an anonymous one and a DFU advertiser beats both, because the table
 * exists to show targets and a dense environment is mostly beacons that will
 * never be one. RSSI only breaks ties. */
static int survey_score(const struct ble_scanner_seen *e)
{
	return (e->dfu_uuid ? 4 : 0) + (e->name[0] ? 2 : 0);
}

static void survey_rx_cb(const bt_addr_le_t *addr, int8_t rssi, uint8_t adv_type,
			 struct net_buf_simple *ad)
{
	ARG_UNUSED(adv_type);

	struct ad_parse ap = { .name = { 0 }, .has_dfu_uuid = false };
	bt_data_parse(ad, ad_data_cb, &ap);

	k_spinlock_key_t key = k_spin_lock(&s_survey.lock);

	/* Seen before? Update in place. Address is the identity, so a device
	 * that starts advertising a name (or moves from application to
	 * bootloader UUID) enriches its row rather than making a second one. */
	for (size_t i = 0; i < s_survey.n; i++) {
		struct ble_scanner_seen *e = &s_survey.tbl[i];
		if (!bt_addr_le_eq(&e->addr, addr)) {
			continue;
		}
		e->rssi = rssi;
		if (rssi > e->best) {
			e->best = rssi;
		}
		if (e->count < UINT16_MAX) {
			e->count++;
		}
		if (ap.name[0]) {
			memcpy(e->name, ap.name, sizeof(e->name));
		}
		if (ap.has_dfu_uuid) {
			e->dfu_uuid = true;
		}
		k_spin_unlock(&s_survey.lock, key);
		return;
	}

	struct ble_scanner_seen fresh = {
		.rssi = rssi, .best = rssi, .count = 1, .dfu_uuid = ap.has_dfu_uuid,
	};
	bt_addr_le_copy(&fresh.addr, addr);
	memcpy(fresh.name, ap.name, sizeof(fresh.name));

	if (s_survey.n < ARRAY_SIZE(s_survey.tbl)) {
		s_survey.tbl[s_survey.n++] = fresh;
		k_spin_unlock(&s_survey.lock, key);
		return;
	}

	/* Full. Evict the least interesting row, but only if this ad is worth
	 * more than it — otherwise a room full of beacons would churn the
	 * table forever and the one device the operator is looking for would
	 * take its turn being thrown out. */
	size_t worst = 0;
	for (size_t i = 1; i < s_survey.n; i++) {
		int a = survey_score(&s_survey.tbl[i]);
		int b = survey_score(&s_survey.tbl[worst]);
		if (a < b || (a == b && s_survey.tbl[i].rssi < s_survey.tbl[worst].rssi)) {
			worst = i;
		}
	}
	int fresh_score = survey_score(&fresh);
	int worst_score = survey_score(&s_survey.tbl[worst]);
	if (fresh_score > worst_score ||
	    (fresh_score == worst_score && fresh.rssi > s_survey.tbl[worst].rssi)) {
		s_survey.tbl[worst] = fresh;
	}
	k_spin_unlock(&s_survey.lock, key);
}

/* Caller holds s_radio_lock. */
static void survey_stop_locked(void)
{
	int rc = bt_le_scan_stop();
	if (rc && rc != -EALREADY) {
		LOG_WRN("survey: bt_le_scan_stop rc=%d", rc);
	}
	atomic_cas(&s_radio, RADIO_SURVEY, RADIO_IDLE);
}

static void survey_idle_fn(struct k_work *work)
{
	ARG_UNUSED(work);
	if (atomic_get(&s_radio) != RADIO_SURVEY) {
		return;
	}
	LOG_INF("survey: no client for %d ms — stopping", SURVEY_IDLE_TIMEOUT_MS);
	k_mutex_lock(&s_radio_lock, K_FOREVER);
	survey_stop_locked();
	k_mutex_unlock(&s_radio_lock);
}

int ble_scanner_survey_start(void)
{
	/* Already ours: this is a poll, not a start. Refresh the watchdog and
	 * keep the table — restarting would throw away exactly the history
	 * (best RSSI, sighting counts) that makes it worth reading. */
	if (atomic_get(&s_radio) == RADIO_SURVEY) {
		k_work_reschedule(&s_survey_idle, K_MSEC(SURVEY_IDLE_TIMEOUT_MS));
		return 0;
	}

	k_mutex_lock(&s_radio_lock, K_FOREVER);
	if (!atomic_cas(&s_radio, RADIO_IDLE, RADIO_SURVEY)) {
		k_mutex_unlock(&s_radio_lock);
		return -EBUSY;   /* a DFU search owns the radio */
	}

	k_spinlock_key_t key = k_spin_lock(&s_survey.lock);
	s_survey.n = 0;
	k_spin_unlock(&s_survey.lock, key);

	int rc = bt_le_scan_start(&s_scan_params, survey_rx_cb);
	if (rc) {
		LOG_ERR("survey: bt_le_scan_start rc=%d", rc);
		atomic_set(&s_radio, RADIO_IDLE);
		k_mutex_unlock(&s_radio_lock);
		return rc;
	}
	k_mutex_unlock(&s_radio_lock);

	k_work_reschedule(&s_survey_idle, K_MSEC(SURVEY_IDLE_TIMEOUT_MS));
	LOG_INF("survey: started");
	return 0;
}

void ble_scanner_survey_stop(void)
{
	k_work_cancel_delayable(&s_survey_idle);
	k_mutex_lock(&s_radio_lock, K_FOREVER);
	if (atomic_get(&s_radio) == RADIO_SURVEY) {
		LOG_INF("survey: stopped");
		survey_stop_locked();
	}
	k_mutex_unlock(&s_radio_lock);
}

/* ======================= lending the radio out ==========================
 *
 * See ble_scanner.h for what this is for and why the advertiser needs it.
 */
int ble_scanner_with_radio_paused(int (*fn)(void))
{
	k_mutex_lock(&s_radio_lock, K_FOREVER);

	/* Which callback to put back. Read under the lock, because the whole
	 * point is that the run that owns the radio is still going. */
	bt_le_scan_cb_t *cb = NULL;
	switch ((enum radio_user)atomic_get(&s_radio)) {
	case RADIO_FIND:   cb = scan_rx_cb;   break;
	case RADIO_SURVEY: cb = survey_rx_cb; break;
	default:           break;
	}

	if (cb != NULL) {
		int rc = bt_le_scan_stop();
		if (rc && rc != -EALREADY) {
			/* Nothing was stopped, so there is nothing to put
			 * back — and fn() is about to fail for whatever
			 * reason the scan is still up. Say so once. */
			LOG_WRN("radio pause: bt_le_scan_stop rc=%d", rc);
			cb = NULL;
		}
	}

	int ret = fn();

	if (cb != NULL) {
		int rc = bt_le_scan_start(&s_scan_params, cb);
		if (rc) {
			/* The borrower gave the radio back and the owner
			 * could not take it. Leaving s_radio as it was would
			 * describe a scan that is not running — and a find
			 * would then wait out its whole timeout, which for
			 * scan_timeout=0 is forever. Release it and cancel
			 * the find so the runner retries with a clean radio
			 * instead of hanging. */
			LOG_ERR("radio pause: scan did not resume rc=%d", rc);
			if (cb == scan_rx_cb) {
				ble_scanner_cancel();
			}
			atomic_set(&s_radio, RADIO_IDLE);
		}
	}

	k_mutex_unlock(&s_radio_lock);
	return ret;
}

bool ble_scanner_survey_active(void)
{
	return atomic_get(&s_radio) == RADIO_SURVEY;
}

size_t ble_scanner_survey_get(struct ble_scanner_seen *out, size_t max,
			      size_t off, size_t *total)
{
	k_spinlock_key_t key = k_spin_lock(&s_survey.lock);
	size_t held = s_survey.n;
	size_t n = 0;
	for (size_t i = off; i < held && n < max; i++) {
		out[n++] = s_survey.tbl[i];
	}
	k_spin_unlock(&s_survey.lock, key);
	if (total) {
		*total = held;
	}
	return n;
}
