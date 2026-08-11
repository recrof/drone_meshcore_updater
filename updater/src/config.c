/*
 * config.txt parser — line-based `key=value` with `#`/`;` comments and
 * trimmed whitespace. Ported from the nRF52 sibling's config.cpp with
 * SdFat File replaced by Zephyr fs_read.
 *
 * Design notes:
 *  - Defaults live in apply_defaults(). Unknown keys are ignored so the
 *    file survives forwards/backwards compatibility with older builds.
 *  - Every key parses via a small handler function — adding a knob is
 *    "extend struct app_config + one line in apply_kv()" and nothing else.
 *  - Uses fs_read one line at a time (no fs_file_gets in this Zephyr
 *    revision, so we buffer + split ourselves).
 */

#include "config.h"

#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>
#include <zephyr/fs/fs.h>
#include <stdlib.h>
#include <string.h>
#include <ctype.h>

LOG_MODULE_REGISTER(app_config, LOG_LEVEL_INF);

static struct app_config s_current;

/* ---- defaults ---------------------------------------------------------- */
static void apply_defaults(struct app_config *c)
{
	memset(c, 0, sizeof(*c));
	/* Nordic Legacy DFU peers almost always advertise with "OTA" (app mode,
	 * buttonless service) or "DFU" (already in the bootloader). Tokens are
	 * substring-matched and whitespace-trimmed by name_matches(), so the
	 * spaces around the '|' are cosmetic.
	 */
	snprintf(c->ble_name, sizeof(c->ble_name), "OTA | DFU");
	/* Empty = auto-flash has nothing to choose from and refuses to run.
	 * Deliberately not guessed: flashing the wrong bundle to a board is
	 * expensive to undo.
	 */
	c->ble_firmware_mapping[0] = '\0';
	/* prn=1 is the only setting with a working mid-image resume: one receipt
	 * per packet means the peer can never hold a partially-received burst,
	 * so its byte count is always a clean packet boundary. Measured 0 loss
	 * in 2074 packets; at prn>1 any single drop costs a full retry.
	 */
	c->prn            = 1;
	c->high_mtu       = true;
	c->retries        = 5;
	/* -75 dBm rather than -90: a link weak enough to advertise is not
	 * necessarily strong enough to stream a 500 KB image without a
	 * mid-transfer failure, and a refusal up front is cheaper than a
	 * corrupt attempt plus its cooldown.
	 */
	c->min_rssi       = -75;
	c->retry_cooldown = 5;
	c->wedge_cooldown = 60;
	/* Must be one of the levels the nRF54L actually implements (see the
	 * list in config.h) — anything else is silently clipped by the
	 * SoftDevice, so a "default" that isn't on the list is a default the
	 * radio never runs at.
	 */
	c->tx_power       = 6;
	c->scan_timeout   = 0;
	c->scan_debug     = false;
	/* 5 ms ~= one packet every third connection event at a 15 ms
	 * interval. Empirically enough to keep an SDK 11 bootloader's RX
	 * buffers from overrunning while still leaving plenty of headroom
	 * over the ~8 KB/s a PRN-throttled stream achieves anyway.
	 */
	c->pkt_gap_ms     = 5;
}

/* ---- small string helpers --------------------------------------------- */
/* In-place trim of leading + trailing whitespace (including CR/LF). */
static void trim(char *s)
{
	size_t n = strlen(s);
	while (n > 0 && (s[n - 1] == ' ' || s[n - 1] == '\t' ||
			 s[n - 1] == '\r' || s[n - 1] == '\n')) {
		s[--n] = '\0';
	}
	size_t lead = 0;
	while (s[lead] == ' ' || s[lead] == '\t') lead++;
	if (lead) memmove(s, s + lead, n - lead + 1);
}

static bool parse_bool(const char *v)
{
	return v[0] == '1' || v[0] == 't' || v[0] == 'T' ||
	       v[0] == 'y' || v[0] == 'Y';
}

/* ---- key dispatch ----------------------------------------------------- */
static void apply_kv(struct app_config *c, const char *key, const char *val)
{
	if (!strcmp(key, "ble_name")) {
		snprintf(c->ble_name, sizeof(c->ble_name), "%s", val);
		return;
	}
	if (!strcmp(key, "ble_firmware_mapping")) {
		snprintf(c->ble_firmware_mapping,
			 sizeof(c->ble_firmware_mapping), "%s", val);
		return;
	}
	int n = atoi(val);
	if (!strcmp(key, "prn")) {
		if (n >= 0 && n <= 65535) c->prn = (uint16_t)n;
	} else if (!strcmp(key, "high_mtu")) {
		c->high_mtu = parse_bool(val);
	} else if (!strcmp(key, "retries")) {
		if (n >= 1 && n <= 255) c->retries = (uint8_t)n;
	} else if (!strcmp(key, "min_rssi")) {
		if (n >= -127 && n <= 0) c->min_rssi = (int8_t)n;
	} else if (!strcmp(key, "retry_cooldown")) {
		if (n >= 0 && n <= 600) c->retry_cooldown = (uint16_t)n;
	} else if (!strcmp(key, "wedge_cooldown")) {
		if (n >= 0 && n <= 600) c->wedge_cooldown = (uint16_t)n;
	} else if (!strcmp(key, "tx_power")) {
		/* Actual allowed values checked at Bluetooth apply time —
		 * the SoftDevice clips silently otherwise.
		 */
		if (n >= -40 && n <= 8) c->tx_power = (int8_t)n;
	} else if (!strcmp(key, "scan_timeout")) {
		if (n >= 0 && n <= 65535) c->scan_timeout = (uint16_t)n;
	} else if (!strcmp(key, "scan_debug")) {
		c->scan_debug = parse_bool(val);
	} else if (!strcmp(key, "pkt_gap_ms")) {
		if (n >= 0 && n <= 1000) c->pkt_gap_ms = (uint16_t)n;
	} else {
		LOG_DBG("ignoring unknown key '%s'", key);
	}
}

/* ---- file → lines helper ---------------------------------------------- */
/* Read the whole file into `dst`, chunked. Fails on files > `dst_sz - 1`
 * bytes (config.txt is expected to be <2 KB, we cap smaller). Returns
 * bytes read on success or -errno on failure.
 */
static int read_all(const char *path, char *dst, size_t dst_sz)
{
	struct fs_file_t f;
	fs_file_t_init(&f);
	int rc = fs_open(&f, path, FS_O_READ);
	if (rc < 0) return rc;

	ssize_t total = 0;
	while ((size_t)total < dst_sz - 1) {
		ssize_t n = fs_read(&f, &dst[total], (dst_sz - 1) - total);
		if (n < 0) { fs_close(&f); return (int)n; }
		if (n == 0) break;
		total += n;
	}
	fs_close(&f);
	dst[total] = '\0';
	return (int)total;
}

/* ---- entry points ----------------------------------------------------- */
bool app_config_load(void)
{
	apply_defaults(&s_current);

	char blob[1024];
	int n = read_all(APP_CONFIG_PATH, blob, sizeof(blob));
	if (n < 0) {
		LOG_INF("%s not present (rc=%d) — using defaults", APP_CONFIG_PATH, n);
		return false;
	}
	if (n == 0) {
		LOG_INF("%s is empty — using defaults", APP_CONFIG_PATH);
		return false;
	}

	/* Walk lines in place. picolibc lacks strsep(), so hand-roll:
	 * find each '\n', null-terminate at it, process the segment, advance.
	 * `blob` is already null-terminated at `blob[n]`.
	 */
	char *line = blob;
	while (line < &blob[n]) {
		char *nl = strchr(line, '\n');
		if (nl) *nl = '\0';

		trim(line);
		if (line[0] != '\0' && line[0] != '#' && line[0] != ';') {
			char *eq = strchr(line, '=');
			if (eq) {
				*eq = '\0';
				char *key = line;
				char *val = eq + 1;
				trim(key);
				trim(val);
				apply_kv(&s_current, key, val);
			}
		}

		if (!nl) break;
		line = nl + 1;
	}
	LOG_INF("loaded %s", APP_CONFIG_PATH);
	return true;
}

const struct app_config *app_config_current(void)
{
	return &s_current;
}
