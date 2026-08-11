#pragma once

/*
 * ble_firmware_mapping — choose which firmware bundle to send to a peer,
 * based on the name it advertises.
 *
 * Lets one updater carry several zips and pick per target, which is the point
 * of the auto-flash path (trigger_dfu with no path). Flashing a specific zip
 * from the file browser bypasses this entirely and sends exactly that zip.
 *
 * Rule syntax, mirroring the '|'-delimited style of `ble_name`:
 *
 *     ble_firmware_mapping=RAK:rak4631*.zip | XIAO:xiao_*.zip
 *
 * Rules are tried left to right; the first whose name part appears as a
 * substring of the peer's advertised name wins. Whitespace around either part
 * is trimmed, so the spaces above are cosmetic.
 */

#include <stddef.h>
#include <stdbool.h>

/* Longest glob pattern accepted in a single rule. */
#define FIRMWARE_MAP_PAT_MAX 64

/* Resolve `peer_name` to a bundle path inside `dir`.
 *
 * On success returns 0 and writes an absolute path into `out_path`. On
 * failure returns a negative errno and writes a human-readable reason into
 * `err` (safe to pass NULL):
 *
 *   -EINVAL   no mapping configured, or a malformed rule
 *   -ENOENT   a rule matched the name but no file in `dir` matched its glob,
 *             or no rule matched the name at all
 *
 * Matching is case-sensitive on both halves — LittleFS is case-sensitive, and
 * silently accepting the wrong case is how a config ends up doing nothing.
 *
 * When several files match a rule's glob the lexicographically greatest wins,
 * so `rak*.zip` prefers `rak_v2.zip` over `rak_v1.zip`.
 */
int firmware_map_resolve(const char *peer_name, const char *mapping,
			 const char *dir, char *out_path, size_t out_sz,
			 char *err, size_t err_sz);

/* Glob matcher used above. Supports '*' (any run) and '?' (one char).
 * Exposed for testing.
 */
bool firmware_map_glob(const char *pat, const char *str);
