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
 *    find_first() is not re-entrant. That matches the nRF52 sibling.
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
	bool                      debug;
} s_ctx;

static bool s_debug;
static bool s_sem_inited;

void ble_scanner_set_debug(bool on) { s_debug = on; }

/* Pipe-delimited substring match. Returns true if `name` contains any of
 * the '|'-separated tokens in `filter`. Empty filter or empty name -> false.
 */
static bool name_matches(const char *name, const char *filter)
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

	/* RSSI threshold first — cheapest test. */
	if (rssi < s_ctx.min_rssi) {
		log_rejected(addr, ap.name, rssi, "weak");
		return;
	}

	bool mac_ok  = mac_match_or_plus_one(addr, s_ctx.prefer_mac);
	bool have_nf = (s_ctx.name_filter && s_ctx.name_filter[0]);
	bool name_ok = have_nf && name_matches(ap.name, s_ctx.name_filter);
	bool uuid_ok = (!mac_ok && !have_nf) ? ap.has_dfu_uuid : false;

	if (!(mac_ok || name_ok || uuid_ok)) {
		log_rejected(addr, ap.name, rssi,
			     have_nf ? "name?" : "uuid?");
		return;
	}

	bt_addr_le_copy(&s_ctx.match.addr, addr);
	s_ctx.match.rssi = rssi;
	memcpy(s_ctx.match.name, ap.name, sizeof(ap.name));
	s_ctx.found = true;
	k_sem_give(&s_ctx.found_sem);
}

int ble_scanner_find_first(struct ble_scanner_target *out,
			   uint32_t timeout_ms,
			   const char *name_filter,
			   int8_t min_rssi,
			   const bt_addr_le_t *prefer_mac)
{
	if (!out) return -EINVAL;

	if (!s_sem_inited) {
		k_sem_init(&s_ctx.found_sem, 0, 1);
		s_sem_inited = true;
	} else {
		k_sem_reset(&s_ctx.found_sem);
	}

	s_ctx.found       = false;
	s_ctx.name_filter = name_filter;
	s_ctx.min_rssi    = min_rssi;
	s_ctx.prefer_mac  = prefer_mac;
	s_ctx.debug       = s_debug;
	memset(&s_ctx.match, 0, sizeof(s_ctx.match));

	/* Active scan so we catch the scan response too (some devices put
	 * the name only in the scan response). Interval 160 * 0.625 = 100 ms,
	 * window 80 * 0.625 = 50 ms — same duty cycle the nRF52 sibling used.
	 */
	struct bt_le_scan_param params = {
		.type     = BT_LE_SCAN_TYPE_ACTIVE,
		.options  = BT_LE_SCAN_OPT_NONE,
		.interval = 160,
		.window   = 80,
	};

	int rc = bt_le_scan_start(&params, scan_rx_cb);
	if (rc) {
		LOG_ERR("bt_le_scan_start rc=%d", rc);
		return rc;
	}
	LOG_INF("scan started (name='%s' min_rssi=%d %s%s)",
		name_filter ? name_filter : "",
		min_rssi,
		prefer_mac ? "mac_fallback " : "",
		timeout_ms == 0 ? "no_timeout" : "with_timeout");

	rc = k_sem_take(&s_ctx.found_sem,
			timeout_ms == 0 ? K_FOREVER : K_MSEC(timeout_ms));
	int stop_rc = bt_le_scan_stop();
	if (stop_rc && stop_rc != -EALREADY) {
		LOG_WRN("bt_le_scan_stop rc=%d", stop_rc);
	}

	if (rc == -EAGAIN) return -ETIMEDOUT;
	if (rc) return rc;

	*out = s_ctx.match;
	char addr_s[BT_ADDR_LE_STR_LEN];
	bt_addr_le_to_str(&out->addr, addr_s, sizeof(addr_s));
	LOG_INF("scan match: %s rssi=%d name='%s'", addr_s, out->rssi, out->name);
	return 0;
}
