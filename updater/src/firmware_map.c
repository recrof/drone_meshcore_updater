/*
 * ble_firmware_mapping resolution — see firmware_map.h for the rule syntax.
 *
 * Kept out of dfu_runner.c so the "which file?" decision is testable and
 * loggable on its own; the runner just asks for a path.
 */

#include "firmware_map.h"

#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>
#include <zephyr/fs/fs.h>
#include <errno.h>
#include <string.h>
#include <stdio.h>
#include <stdarg.h>

LOG_MODULE_REGISTER(firmware_map, LOG_LEVEL_INF);

/* Mapping strings are short (APP_CONFIG_MAPPING_MAX), but strtok_r writes
 * into its input, so we always work on a copy.
 */
#define MAPPING_COPY_MAX 256

/* Classic iterative wildcard match with backtracking on '*'. Linear in the
 * common case and bounded even for pathological patterns, unlike the naive
 * recursive version.
 */
bool firmware_map_glob(const char *pat, const char *str)
{
	if (!pat || !str) return false;

	const char *star = NULL;
	const char *retry = str;

	while (*str) {
		if (*pat == '?' || *pat == *str) {
			pat++; str++;
		} else if (*pat == '*') {
			star = pat++;      /* remember where the '*' was */
			retry = str;
		} else if (star) {
			/* Mismatch after a '*': let the '*' swallow one more
			 * character and try again from there.
			 */
			pat = star + 1;
			str = ++retry;
		} else {
			return false;
		}
	}
	while (*pat == '*') pat++;
	return *pat == '\0';
}

/* In-place trim of leading/trailing spaces and tabs. Returns the new start. */
static char *trim(char *s)
{
	while (*s == ' ' || *s == '\t') s++;
	char *end = s + strlen(s);
	while (end > s && (end[-1] == ' ' || end[-1] == '\t')) *--end = '\0';
	return s;
}

static void set_err(char *err, size_t err_sz, const char *fmt, ...)
{
	if (!err || err_sz == 0) return;
	va_list ap;
	va_start(ap, fmt);
	vsnprintf(err, err_sz, fmt, ap);
	va_end(ap);
}

/* Scan `dir` for the lexicographically greatest entry matching `pat`.
 * Returns 0 and fills `best` (bare filename), or -ENOENT when nothing matched.
 */
static int best_match_in_dir(const char *dir, const char *pat,
			     char *best, size_t best_sz)
{
	struct fs_dir_t d;
	fs_dir_t_init(&d);

	int rc = fs_opendir(&d, dir);
	if (rc < 0) return rc;

	best[0] = '\0';
	for (;;) {
		struct fs_dirent ent;
		rc = fs_readdir(&d, &ent);
		if (rc < 0) break;
		if (ent.name[0] == '\0') break;          /* end of directory */
		if (ent.type != FS_DIR_ENTRY_FILE) continue;
		if (!firmware_map_glob(pat, ent.name)) continue;

		/* Greatest name wins, so rak_v2.zip beats rak_v1.zip. */
		if (best[0] == '\0' || strcmp(ent.name, best) > 0) {
			snprintf(best, best_sz, "%s", ent.name);
		}
	}
	fs_closedir(&d);

	return best[0] ? 0 : -ENOENT;
}

int firmware_map_resolve(const char *peer_name, const char *mapping,
			 const char *dir, char *out_path, size_t out_sz,
			 char *err, size_t err_sz)
{
	if (!out_path || out_sz == 0) return -EINVAL;
	out_path[0] = '\0';

	if (!peer_name || !peer_name[0]) {
		set_err(err, err_sz, "peer advertised no name");
		return -EINVAL;
	}
	if (!mapping || !mapping[0]) {
		set_err(err, err_sz, "ble_firmware_mapping is empty");
		return -EINVAL;
	}

	char buf[MAPPING_COPY_MAX];
	snprintf(buf, sizeof(buf), "%s", mapping);

	char *save = NULL;
	int rules = 0;
	for (char *rule = strtok_r(buf, "|", &save); rule;
	     rule = strtok_r(NULL, "|", &save)) {

		rule = trim(rule);
		if (!*rule) continue;

		char *colon = strchr(rule, ':');
		if (!colon) {
			LOG_WRN("mapping rule '%s' has no ':' — skipped", rule);
			continue;
		}
		*colon = '\0';
		char *namepat = trim(rule);
		char *filepat = trim(colon + 1);
		if (!*namepat || !*filepat) {
			LOG_WRN("mapping rule has an empty half — skipped");
			continue;
		}
		rules++;

		/* Substring match, same semantics as ble_name's tokens. */
		if (!strstr(peer_name, namepat)) continue;

		char best[FIRMWARE_MAP_PAT_MAX + 1];
		int rc = best_match_in_dir(dir, filepat, best, sizeof(best));
		if (rc < 0) {
			/* The rule matched the peer, so this is the answer —
			 * a later rule matching the same name would be a
			 * surprise. Report rather than falling through.
			 */
			set_err(err, err_sz,
				"rule '%s:%s' matched but no file in %s matches '%s'",
				namepat, filepat, dir, filepat);
			return -ENOENT;
		}

		snprintf(out_path, out_sz, "%s/%s", dir, best);
		LOG_INF("mapping: peer '%s' ~ '%s' -> %s",
			peer_name, namepat, out_path);
		return 0;
	}

	if (rules == 0) {
		set_err(err, err_sz, "no usable rules in ble_firmware_mapping");
		return -EINVAL;
	}
	set_err(err, err_sz, "no rule matches peer name '%s'", peer_name);
	return -ENOENT;
}
