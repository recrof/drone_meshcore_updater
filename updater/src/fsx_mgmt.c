/*
 * fsx_mgmt handlers — see fsx_mgmt.h for the wire protocol contract.
 *
 * Implementation notes:
 *  - We register on MGMT_GROUP_ID_PERUSER (64). Zephyr's group table
 *    is keyed by ID; only one handler can occupy 64 per build, so
 *    a downstream user who also wants a custom group must pick a
 *    different ID.
 *  - Filesystem errors are surfaced via smp_add_cmd_err() with the
 *    negated Zephyr errno. Returning MGMT_ERR_EOK from a handler
 *    that already added a cmd_err still yields a successful SMP
 *    response frame carrying the fs error — that's the pattern
 *    stock fs_mgmt uses and matches what clients expect.
 *  - Path length is capped at FSX_PATH_MAX; larger paths get
 *    MGMT_ERR_EINVAL back. Bump if LittleFS ever grows deeper
 *    directory hierarchies.
 */

#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>
#include <zephyr/fs/fs.h>
#include <zephyr/mgmt/mcumgr/mgmt/mgmt.h>
#include <zephyr/mgmt/mcumgr/mgmt/handlers.h>
#include <zephyr/mgmt/mcumgr/smp/smp.h>

#include <zcbor_common.h>
#include <zcbor_decode.h>
#include <zcbor_encode.h>
#include <mgmt/mcumgr/util/zcbor_bulk.h>

#include <errno.h>
#include <string.h>
#include <stdio.h>

#include "fsx_mgmt.h"
#include "firmware_inspect.h"
#include "config.h"      /* APP_CONFIG_PIN_MAX */
#include "ble_pairing.h"
#include "dfu_runner.h"
#include "survey.h"
#include "battery.h"

#include <zephyr/bluetooth/addr.h>

LOG_MODULE_REGISTER(fsx_mgmt, LOG_LEVEL_INF);

#define FSX_PATH_MAX          128
/* Upper bound on entries returned in a single `list` response. Also the
 * value we advertise to zcbor as the list capacity — needed for CBOR
 * indefinite-length container hinting. Clients that want more must
 * paginate using `off` + `count`.
 */
#define FSX_LIST_MAX_ENTRIES  32

/* Longest pinned address a client may send to TRIGGER_DFU. Sized for what
 * bt_addr_le_to_str() emits — "E9:52:9F:23:87:4A (random)" — with slack. */
#define FSX_ADDR_MAX          40

/* Entries per SCAN response.
 *
 * Bounded by CONFIG_MCUMGR_TRANSPORT_NETBUF_SIZE (1024), not by the survey
 * table: a row costs roughly 60 bytes encoded — a 26-character address
 * string, a name up to BLE_SCANNER_NAME_MAX, four small integers and their
 * keys — so a dozen is the most that reliably fits with the envelope. The
 * client paginates with `off` exactly as it does for `list`, and gets the
 * whole table across two round trips.
 */
#define FSX_SCAN_MAX_ENTRIES  12

/* Copy a zcbor tstr into `dst` (null-terminated). Returns false on
 * empty/too-long input.
 */
static bool copy_path(char *dst, size_t dst_sz, const struct zcbor_string *s)
{
	if (s->len == 0 || s->len >= dst_sz) {
		return false;
	}
	memcpy(dst, s->value, s->len);
	dst[s->len] = '\0';
	return true;
}

/* ---------- list ---------- */
static int fsx_list(struct smp_streamer *ctxt)
{
	zcbor_state_t *zse = ctxt->writer->zs;
	zcbor_state_t *zsd = ctxt->reader->zs;

	struct zcbor_string path_str = { 0 };
	uint32_t off = 0;
	uint32_t count = FSX_LIST_MAX_ENTRIES;
	size_t decoded;

	struct zcbor_map_decode_key_val dec[] = {
		ZCBOR_MAP_DECODE_KEY_DECODER("path",  zcbor_tstr_decode,   &path_str),
		ZCBOR_MAP_DECODE_KEY_DECODER("off",   zcbor_uint32_decode, &off),
		ZCBOR_MAP_DECODE_KEY_DECODER("count", zcbor_uint32_decode, &count),
	};
	if (zcbor_map_decode_bulk(zsd, dec, ARRAY_SIZE(dec), &decoded) != 0) {
		return MGMT_ERR_EINVAL;
	}

	char path[FSX_PATH_MAX + 1];
	if (!copy_path(path, sizeof(path), &path_str)) {
		return MGMT_ERR_EINVAL;
	}
	if (count == 0 || count > FSX_LIST_MAX_ENTRIES) {
		count = FSX_LIST_MAX_ENTRIES;
	}

	struct fs_dir_t dir;
	fs_dir_t_init(&dir);
	int rc = fs_opendir(&dir, path);
	if (rc < 0) {
		smp_add_cmd_err(zse, FSX_MGMT_GROUP_ID, (uint16_t)-rc);
		return MGMT_ERR_EOK;
	}

	/* Skip `off` entries so the client can paginate without keeping
	 * a directory handle open across requests.
	 */
	struct fs_dirent ent;
	for (uint32_t i = 0; i < off; i++) {
		rc = fs_readdir(&dir, &ent);
		if (rc < 0 || ent.name[0] == '\0') {
			break;
		}
	}

	bool ok = zcbor_tstr_put_lit(zse, "entries")
	       && zcbor_list_start_encode(zse, FSX_LIST_MAX_ENTRIES);

	uint32_t emitted = 0;
	for (; ok && emitted < count; ) {
		rc = fs_readdir(&dir, &ent);
		if (rc < 0 || ent.name[0] == '\0') {
			break;
		}
		size_t nl = strnlen(ent.name, sizeof(ent.name));
		ok = zcbor_map_start_encode(zse, 3)
		  && zcbor_tstr_put_lit(zse, "name")
		  && zcbor_tstr_encode_ptr(zse, ent.name, nl)
		  && zcbor_tstr_put_lit(zse, "size")
		  && zcbor_uint64_put(zse, (uint64_t)ent.size)
		  && zcbor_tstr_put_lit(zse, "type")
		  && zcbor_uint32_put(zse,
		       ent.type == FS_DIR_ENTRY_DIR ? FSX_ENTRY_DIR : FSX_ENTRY_FILE)
		  && zcbor_map_end_encode(zse, 3);
		emitted++;
	}

	/* Peek one more to decide if there's more the client didn't
	 * receive — surface that so the UI can offer "load more".
	 */
	bool truncated = false;
	if (ok) {
		rc = fs_readdir(&dir, &ent);
		if (rc == 0 && ent.name[0] != '\0') {
			truncated = true;
		}
	}
	fs_closedir(&dir);

	ok = ok
	  && zcbor_list_end_encode(zse, FSX_LIST_MAX_ENTRIES)
	  && zcbor_tstr_put_lit(zse, "truncated")
	  && zcbor_bool_put(zse, truncated);

	return ok ? MGMT_ERR_EOK : MGMT_ERR_EMSGSIZE;
}

/* ---------- mkdir ---------- */
static int fsx_mkdir(struct smp_streamer *ctxt)
{
	zcbor_state_t *zse = ctxt->writer->zs;
	zcbor_state_t *zsd = ctxt->reader->zs;

	struct zcbor_string path_str = { 0 };
	size_t decoded;

	struct zcbor_map_decode_key_val dec[] = {
		ZCBOR_MAP_DECODE_KEY_DECODER("path", zcbor_tstr_decode, &path_str),
	};
	if (zcbor_map_decode_bulk(zsd, dec, ARRAY_SIZE(dec), &decoded) != 0) {
		return MGMT_ERR_EINVAL;
	}

	char path[FSX_PATH_MAX + 1];
	if (!copy_path(path, sizeof(path), &path_str)) {
		return MGMT_ERR_EINVAL;
	}

	int rc = fs_mkdir(path);
	if (rc < 0) {
		smp_add_cmd_err(zse, FSX_MGMT_GROUP_ID, (uint16_t)-rc);
	}
	return MGMT_ERR_EOK;
}

/* ---------- rmdir (with optional recursive delete) ---------- */
/*
 * Bounded, because this runs on the mcumgr SMP workqueue thread and each level
 * costs ~430 bytes of it (an fs_dir_t, an fs_dirent with its name buffer, and
 * a full child path). Nothing else limits the depth: it is whatever the
 * directory tree happens to be, and FSX_PATH_MAX permits ~60 levels, which is
 * 26 KB of stack on a thread that has 8. That is the same overflow the
 * transport stack size was just raised for, reachable by a single `rmdir`
 * request — so it is capped rather than left to the stack size to absorb.
 *
 * The depth is far beyond anything this filesystem is used for (bundles and a
 * config file live at the root), so hitting it means a malformed or hostile
 * tree, and -ELOOP says so rather than pretending the delete succeeded.
 */
#define RMDIR_MAX_DEPTH 8

static int rmdir_recursive_at(const char *path, unsigned int depth)
{
	if (depth > RMDIR_MAX_DEPTH) {
		LOG_WRN("rmdir: %s is deeper than %d levels — refusing",
			path, RMDIR_MAX_DEPTH);
		return -ELOOP;
	}

	struct fs_dir_t dir;
	fs_dir_t_init(&dir);
	int rc = fs_opendir(&dir, path);
	if (rc < 0) {
		/* If it's a plain file, just unlink it. */
		return fs_unlink(path);
	}

	struct fs_dirent ent;
	int walk_rc = 0;
	while (walk_rc >= 0) {
		walk_rc = fs_readdir(&dir, &ent);
		if (walk_rc < 0 || ent.name[0] == '\0') {
			break;
		}

		char child[FSX_PATH_MAX + 1];
		int n = snprintf(child, sizeof(child), "%s/%s", path, ent.name);
		if (n < 0 || n >= (int)sizeof(child)) {
			walk_rc = -ENAMETOOLONG;
			break;
		}

		if (ent.type == FS_DIR_ENTRY_DIR) {
			walk_rc = rmdir_recursive_at(child, depth + 1);
		} else {
			walk_rc = fs_unlink(child);
		}
	}
	fs_closedir(&dir);

	if (walk_rc >= 0) {
		walk_rc = fs_unlink(path);
	}
	return walk_rc;
}

static int rmdir_recursive(const char *path)
{
	return rmdir_recursive_at(path, 0);
}

static int fsx_rmdir(struct smp_streamer *ctxt)
{
	zcbor_state_t *zse = ctxt->writer->zs;
	zcbor_state_t *zsd = ctxt->reader->zs;

	struct zcbor_string path_str = { 0 };
	bool recursive = false;
	size_t decoded;

	struct zcbor_map_decode_key_val dec[] = {
		ZCBOR_MAP_DECODE_KEY_DECODER("path",      zcbor_tstr_decode, &path_str),
		ZCBOR_MAP_DECODE_KEY_DECODER("recursive", zcbor_bool_decode, &recursive),
	};
	if (zcbor_map_decode_bulk(zsd, dec, ARRAY_SIZE(dec), &decoded) != 0) {
		return MGMT_ERR_EINVAL;
	}

	char path[FSX_PATH_MAX + 1];
	if (!copy_path(path, sizeof(path), &path_str)) {
		return MGMT_ERR_EINVAL;
	}

	int rc = recursive ? rmdir_recursive(path) : fs_unlink(path);
	if (rc < 0) {
		smp_add_cmd_err(zse, FSX_MGMT_GROUP_ID, (uint16_t)-rc);
	}
	return MGMT_ERR_EOK;
}

/* ---------- move / rename ---------- */
static int fsx_move(struct smp_streamer *ctxt)
{
	zcbor_state_t *zse = ctxt->writer->zs;
	zcbor_state_t *zsd = ctxt->reader->zs;

	struct zcbor_string src_str = { 0 };
	struct zcbor_string dst_str = { 0 };
	size_t decoded;

	struct zcbor_map_decode_key_val dec[] = {
		ZCBOR_MAP_DECODE_KEY_DECODER("src", zcbor_tstr_decode, &src_str),
		ZCBOR_MAP_DECODE_KEY_DECODER("dst", zcbor_tstr_decode, &dst_str),
	};
	if (zcbor_map_decode_bulk(zsd, dec, ARRAY_SIZE(dec), &decoded) != 0) {
		return MGMT_ERR_EINVAL;
	}

	char src[FSX_PATH_MAX + 1];
	char dst[FSX_PATH_MAX + 1];
	if (!copy_path(src, sizeof(src), &src_str) ||
	    !copy_path(dst, sizeof(dst), &dst_str)) {
		return MGMT_ERR_EINVAL;
	}

	int rc = fs_rename(src, dst);
	if (rc < 0) {
		smp_add_cmd_err(zse, FSX_MGMT_GROUP_ID, (uint16_t)-rc);
	}
	return MGMT_ERR_EOK;
}

/* ---------- statvfs ---------- */
static int fsx_statvfs(struct smp_streamer *ctxt)
{
	zcbor_state_t *zse = ctxt->writer->zs;
	zcbor_state_t *zsd = ctxt->reader->zs;

	struct zcbor_string path_str = { 0 };
	size_t decoded;

	struct zcbor_map_decode_key_val dec[] = {
		ZCBOR_MAP_DECODE_KEY_DECODER("path", zcbor_tstr_decode, &path_str),
	};
	if (zcbor_map_decode_bulk(zsd, dec, ARRAY_SIZE(dec), &decoded) != 0) {
		return MGMT_ERR_EINVAL;
	}

	char path[FSX_PATH_MAX + 1];
	if (!copy_path(path, sizeof(path), &path_str)) {
		return MGMT_ERR_EINVAL;
	}

	struct fs_statvfs st;
	int rc = fs_statvfs(path, &st);
	if (rc < 0) {
		smp_add_cmd_err(zse, FSX_MGMT_GROUP_ID, (uint16_t)-rc);
		return MGMT_ERR_EOK;
	}

	bool ok = zcbor_tstr_put_lit(zse, "bsize")  && zcbor_uint32_put(zse, (uint32_t)st.f_bsize)
	       && zcbor_tstr_put_lit(zse, "frsize") && zcbor_uint32_put(zse, (uint32_t)st.f_frsize)
	       && zcbor_tstr_put_lit(zse, "blocks") && zcbor_uint32_put(zse, (uint32_t)st.f_blocks)
	       && zcbor_tstr_put_lit(zse, "bfree")  && zcbor_uint32_put(zse, (uint32_t)st.f_bfree);
	return ok ? MGMT_ERR_EOK : MGMT_ERR_EMSGSIZE;
}

/* ---------- inspect ---------- */
static int fsx_inspect(struct smp_streamer *ctxt)
{
	zcbor_state_t *zse = ctxt->writer->zs;
	zcbor_state_t *zsd = ctxt->reader->zs;

	struct zcbor_string path_str = { 0 };
	size_t decoded;

	struct zcbor_map_decode_key_val dec[] = {
		ZCBOR_MAP_DECODE_KEY_DECODER("path", zcbor_tstr_decode, &path_str),
	};
	if (zcbor_map_decode_bulk(zsd, dec, ARRAY_SIZE(dec), &decoded) != 0) {
		return MGMT_ERR_EINVAL;
	}

	char path[FSX_PATH_MAX + 1];
	if (!copy_path(path, sizeof(path), &path_str)) {
		return MGMT_ERR_EINVAL;
	}

	struct fw_inspect info;
	int rc = firmware_inspect(path, &info);
	if (rc == -EBUSY) {
		return MGMT_ERR_EBUSY;
	}
	/* Any other read failure still produced a verdict — "not found" is an
	 * answer, not a protocol error — so it is encoded like the rest. */

	bool ok = zcbor_tstr_put_lit(zse, "kind")      && zcbor_uint32_put(zse, info.kind)
	       && zcbor_tstr_put_lit(zse, "transport") && zcbor_uint32_put(zse, info.transport)
	       && zcbor_tstr_put_lit(zse, "ok")        && zcbor_bool_put(zse, info.ok)
	       && zcbor_tstr_put_lit(zse, "flashable") && zcbor_bool_put(zse, info.flashable)
	       && zcbor_tstr_put_lit(zse, "bytes")     && zcbor_uint32_put(zse, info.image_bytes)
	       && zcbor_tstr_put_lit(zse, "devtype")   && zcbor_uint32_put(zse, info.device_type)
	       && zcbor_tstr_put_lit(zse, "reason")    && zcbor_tstr_put_term(zse, info.reason, sizeof(info.reason))
	       && zcbor_tstr_put_lit(zse, "name")      && zcbor_tstr_put_term(zse, info.name, sizeof(info.name))
	       && zcbor_tstr_put_lit(zse, "version")   && zcbor_tstr_put_term(zse, info.version, sizeof(info.version))
	       && zcbor_tstr_put_lit(zse, "chip")      && zcbor_tstr_put_term(zse, info.chip, sizeof(info.chip));
	return ok ? MGMT_ERR_EOK : MGMT_ERR_EMSGSIZE;
}

/* ---------- caps ---------- */
static int fsx_caps(struct smp_streamer *ctxt)
{
	zcbor_state_t *zse = ctxt->writer->zs;

	bool ok = zcbor_tstr_put_lit(zse, "transports")
	       && zcbor_uint32_put(zse, firmware_transports());
	return ok ? MGMT_ERR_EOK : MGMT_ERR_EMSGSIZE;
}

/* ---------- battery ---------- */
static int fsx_battery(struct smp_streamer *ctxt)
{
	zcbor_state_t *zse = ctxt->writer->zs;
	struct battery_status st;

	int rc = battery_read(&st);

	/* -ENOTSUP is the answer, not an error: this board has no battery
	 * hardware, which the client renders by omitting the indicator. Any
	 * other failure is a board that *should* have answered and did not, and
	 * that must not be reported as "no battery" — a broken sensor and an
	 * absent one look identical from the outside otherwise. */
	if (rc == -ENOTSUP) {
		return zcbor_tstr_put_lit(zse, "src") &&
		       zcbor_uint32_put(zse, (uint32_t)BATTERY_SOURCE_NONE)
			       ? MGMT_ERR_EOK : MGMT_ERR_EMSGSIZE;
	}
	if (rc != 0) {
		smp_add_cmd_err(zse, FSX_MGMT_GROUP_ID, (uint16_t)-rc);
		return MGMT_ERR_EOK;
	}

	bool ok = zcbor_tstr_put_lit(zse, "src") && zcbor_uint32_put(zse, (uint32_t)st.source)
	       && zcbor_tstr_put_lit(zse, "mv")  && zcbor_uint32_put(zse, st.millivolts)
	       && zcbor_tstr_put_lit(zse, "pct") && zcbor_uint32_put(zse, st.percent);

	/* Omitted rather than sent false where the board cannot tell. See the
	 * command's contract in fsx_mgmt.h. */
	if (ok && st.charging_known) {
		ok = zcbor_tstr_put_lit(zse, "chg") && zcbor_bool_put(zse, st.charging);
	}
	if (ok && st.external_power_known) {
		ok = zcbor_tstr_put_lit(zse, "ext") && zcbor_bool_put(zse, st.external_power);
	}

	return ok ? MGMT_ERR_EOK : MGMT_ERR_EMSGSIZE;
}

/* ---------- trigger_dfu ---------- */
static int fsx_trigger_dfu(struct smp_streamer *ctxt)
{
	zcbor_state_t *zse = ctxt->writer->zs;
	zcbor_state_t *zsd = ctxt->reader->zs;

	struct zcbor_string path_str = { 0 };
	struct zcbor_string addr_str = { 0 };
	struct zcbor_string pin_str = { 0 };
	size_t decoded;
	struct zcbor_map_decode_key_val dec[] = {
		ZCBOR_MAP_DECODE_KEY_DECODER("path", zcbor_tstr_decode, &path_str),
		ZCBOR_MAP_DECODE_KEY_DECODER("addr", zcbor_tstr_decode, &addr_str),
		/* `pin` here is the *passkey*, while `addr` is what the rest of
		 * the firmware calls a pin. The wire keys are named for what an
		 * operator would call each — an address and a PIN — and the C
		 * side keeps the two apart by never using the word twice in one
		 * call; see ble_pairing.h. */
		ZCBOR_MAP_DECODE_KEY_DECODER("pin", zcbor_tstr_decode, &pin_str),
	};
	if (zcbor_map_decode_bulk(zsd, dec, ARRAY_SIZE(dec), &decoded) != 0) {
		return MGMT_ERR_EINVAL;
	}
	/* An absent or empty `path` is not an error — it requests auto-flash,
	 * where the bundle is chosen from ble_firmware_mapping once a target
	 * has been found. Only a present-but-unusable path is rejected.
	 */
	char path[FSX_PATH_MAX + 1] = { 0 };
	if (path_str.len != 0 && !copy_path(path, sizeof(path), &path_str)) {
		return MGMT_ERR_EINVAL;
	}

	/* Absent `addr` is the ordinary scan-and-pick run. Present-but-oversized
	 * is a client bug and is refused here rather than silently truncated
	 * into an address that would match some *other* device. */
	char addr[FSX_ADDR_MAX + 1] = { 0 };
	if (addr_str.len != 0 && !copy_path(addr, sizeof(addr), &addr_str)) {
		return MGMT_ERR_EINVAL;
	}

	/* Absent `pin` falls back to config.txt's `ble_pin`. Oversized is
	 * refused rather than clipped: a truncated PIN is a *wrong* PIN, and
	 * the peer reports that as an authentication failure, which reads as
	 * the operator having mistyped something they typed correctly. */
	char pin[APP_CONFIG_PIN_MAX] = { 0 };
	if (pin_str.len != 0 && !copy_path(pin, sizeof(pin), &pin_str)) {
		return MGMT_ERR_EINVAL;
	}

	/* dfu_runner_start spawns a thread; returns quickly. Failures
	 * (already busy, bad path) surface through the standard fs-error
	 * `rc` field so the client can display them.
	 */
	int rc = dfu_runner_start(path, addr, pin);
	/* The PIN is reported as present-or-not, never echoed. It reaches the
	 * live log stream and the flash-backed log file, and there is no
	 * reason for a credential to exist in either. */
	LOG_INF("TRIGGER_DFU path='%s' addr='%s' pin=%s -> rc=%d", path, addr,
		pin[0] ? "yes" : "no", rc);
	if (rc < 0) {
		smp_add_cmd_err(zse, FSX_MGMT_GROUP_ID, (uint16_t)-rc);
	}
	return MGMT_ERR_EOK;
}

/* ---------- submit_pin ---------- */
static int fsx_submit_pin(struct smp_streamer *ctxt)
{
	zcbor_state_t *zse = ctxt->writer->zs;
	zcbor_state_t *zsd = ctxt->reader->zs;

	struct zcbor_string pin_str = { 0 };
	size_t decoded;
	struct zcbor_map_decode_key_val dec[] = {
		ZCBOR_MAP_DECODE_KEY_DECODER("pin", zcbor_tstr_decode, &pin_str),
	};
	if (zcbor_map_decode_bulk(zsd, dec, ARRAY_SIZE(dec), &decoded) != 0) {
		return MGMT_ERR_EINVAL;
	}

	/* Absent or empty means "cancel", which is what the operator dismissing
	 * the prompt means. Oversized is refused rather than clipped, for the
	 * same reason as everywhere else here: a truncated PIN is a wrong PIN,
	 * and it burns the one pairing the target is displaying for. */
	char pin[APP_CONFIG_PIN_MAX] = { 0 };
	if (pin_str.len != 0 && !copy_path(pin, sizeof(pin), &pin_str)) {
		return MGMT_ERR_EINVAL;
	}

	int rc = ble_pairing_submit(pin);

	/* Never the digits. See fsx_trigger_dfu. */
	LOG_INF("SUBMIT_PIN pin=%s -> rc=%d", pin[0] ? "yes" : "cancel", rc);

	if (rc == -EINVAL) {
		return MGMT_ERR_EINVAL;
	}
	/* -EALREADY is "nothing was waiting", which the client reads from
	 * `taken` rather than from an error: the window closing is an ordinary
	 * outcome, not a malformed request. */
	return zcbor_tstr_put_lit(zse, "taken") && zcbor_bool_put(zse, rc == 0)
		? MGMT_ERR_EOK : MGMT_ERR_EMSGSIZE;
}

/* ---------- stop_dfu ---------- */
static int fsx_stop_dfu(struct smp_streamer *ctxt)
{
	zcbor_state_t *zse = ctxt->writer->zs;

	/* No request fields to decode. Deliberately not rejecting a request
	 * that carries some anyway: a client that learns to send options later
	 * should not be refused by an older device that ignores them. */
	int rc = dfu_runner_stop();

	/* "Nothing was running" is reported as `stopped: false`, NOT as an
	 * error rc. It is a normal, useful outcome — the status was still
	 * cleared — and making it an error would put an errno value on the
	 * wire for the client to recognise, which is a coupling this protocol
	 * does not otherwise have. Genuine failures still use `rc`; there are
	 * currently none, because stopping cannot fail. */
	LOG_INF("STOP_DFU -> rc=%d", rc);
	bool ok = zcbor_tstr_put_lit(zse, "stopped") && zcbor_bool_put(zse, rc == 0);
	return ok ? MGMT_ERR_EOK : MGMT_ERR_EMSGSIZE;
}

/* ---------- registration ---------- */

/* SCAN — see fsx_mgmt.h for the contract. */
static int fsx_scan(struct smp_streamer *ctxt)
{
	zcbor_state_t *zse = ctxt->writer->zs;
	zcbor_state_t *zsd = ctxt->reader->zs;

	bool on = true;
	bool reset = false;
	uint32_t kind = SURVEY_BLE;
	uint32_t off = 0;
	uint32_t count = FSX_SCAN_MAX_ENTRIES;
	size_t decoded;

	struct zcbor_map_decode_key_val dec[] = {
		ZCBOR_MAP_DECODE_KEY_DECODER("on",    zcbor_bool_decode,   &on),
		ZCBOR_MAP_DECODE_KEY_DECODER("reset", zcbor_bool_decode,   &reset),
		ZCBOR_MAP_DECODE_KEY_DECODER("kind",  zcbor_uint32_decode, &kind),
		ZCBOR_MAP_DECODE_KEY_DECODER("off",   zcbor_uint32_decode, &off),
		ZCBOR_MAP_DECODE_KEY_DECODER("count", zcbor_uint32_decode, &count),
	};
	if (zcbor_map_decode_bulk(zsd, dec, ARRAY_SIZE(dec), &decoded) != 0) {
		return MGMT_ERR_EINVAL;
	}
	if (count == 0 || count > FSX_SCAN_MAX_ENTRIES) {
		count = FSX_SCAN_MAX_ENTRIES;
	}
	if (kind != SURVEY_BLE && kind != SURVEY_WIFI) {
		return MGMT_ERR_EINVAL;
	}

	if (!on) {
		survey_stop();
	} else {
		/* -EBUSY (a DFU owns the radio) and -ENOTSUP (this board has no
		 * such radio) are both honest answers rather than failures, and
		 * both are reported through the same `rc` channel as a
		 * filesystem error so they render like every other refusal. */
		int rc = survey_start((enum survey_kind)kind, reset);
		if (rc < 0) {
			smp_add_cmd_err(zse, FSX_MGMT_GROUP_ID, (uint16_t)-rc);
			return MGMT_ERR_EOK;
		}
	}

	/* One page at a time on the stack. This runs on the mcumgr thread,
	 * where several KB have been lost to littlefs before now, so the
	 * survey table is read through a window rather than copied whole. */
	struct survey_row page[FSX_SCAN_MAX_ENTRIES];
	size_t total = 0;
	size_t n = survey_get(page, count, off, &total);

	bool ok = zcbor_tstr_put_lit(zse, "kind")
	       && zcbor_uint32_put(zse, (uint32_t)survey_active())
	       && zcbor_tstr_put_lit(zse, "kinds")
	       && zcbor_uint32_put(zse, survey_kinds_available())
	       && zcbor_tstr_put_lit(zse, "scanning")
	       && zcbor_bool_put(zse, survey_active() != SURVEY_NONE)
	       && zcbor_tstr_put_lit(zse, "total")
	       && zcbor_uint32_put(zse, (uint32_t)total)
	       && zcbor_tstr_put_lit(zse, "entries")
	       && zcbor_list_start_encode(zse, FSX_SCAN_MAX_ENTRIES);

	for (size_t i = 0; ok && i < n; i++) {
		const struct survey_row *e = &page[i];

		/* `id` is whatever that radio calls a device, rendered by the
		 * firmware — a Bluetooth address in bt_addr_le_to_str()'s own
		 * format, which is also what bt_addr_le_from_str() parses. So
		 * the string a client hands back to TRIGGER_DFU needs no
		 * reformatting at either end, and there is no second address
		 * format to keep in step. */
		ok = zcbor_map_start_encode(zse, 7)
		  && zcbor_tstr_put_lit(zse, "id")
		  && zcbor_tstr_encode_ptr(zse, e->id, strlen(e->id))
		  && zcbor_tstr_put_lit(zse, "name")
		  && zcbor_tstr_encode_ptr(zse, e->name, strlen(e->name))
		  && zcbor_tstr_put_lit(zse, "rssi")
		  && zcbor_int32_put(zse, e->rssi)
		  && zcbor_tstr_put_lit(zse, "best")
		  && zcbor_int32_put(zse, e->best)
		  && zcbor_tstr_put_lit(zse, "n")
		  && zcbor_uint32_put(zse, e->count)
		  && zcbor_tstr_put_lit(zse, "ch")
		  && zcbor_uint32_put(zse, e->channel)
		  && zcbor_tstr_put_lit(zse, "fl")
		  && zcbor_uint32_put(zse, e->flags)
		  && zcbor_map_end_encode(zse, 7);
	}

	ok = ok
	  && zcbor_list_end_encode(zse, FSX_SCAN_MAX_ENTRIES)
	  && zcbor_tstr_put_lit(zse, "truncated")
	  && zcbor_bool_put(zse, (off + n) < total);

	return ok ? MGMT_ERR_EOK : MGMT_ERR_EMSGSIZE;
}

static const struct mgmt_handler fsx_handlers[] = {
	[FSX_MGMT_ID_LIST]        = { .mh_read = fsx_list,        .mh_write = NULL            },
	[FSX_MGMT_ID_MKDIR]       = { .mh_read = NULL,            .mh_write = fsx_mkdir       },
	[FSX_MGMT_ID_RMDIR]       = { .mh_read = NULL,            .mh_write = fsx_rmdir       },
	[FSX_MGMT_ID_MOVE]        = { .mh_read = NULL,            .mh_write = fsx_move        },
	[FSX_MGMT_ID_STATVFS]     = { .mh_read = fsx_statvfs,     .mh_write = NULL            },
	[FSX_MGMT_ID_TRIGGER_DFU] = { .mh_read = NULL,            .mh_write = fsx_trigger_dfu },
	[FSX_MGMT_ID_STOP_DFU]    = { .mh_read = NULL,            .mh_write = fsx_stop_dfu    },
	[FSX_MGMT_ID_INSPECT]     = { .mh_read = fsx_inspect,     .mh_write = NULL            },
	[FSX_MGMT_ID_CAPS]        = { .mh_read = fsx_caps,        .mh_write = NULL            },
	[FSX_MGMT_ID_SCAN]        = { .mh_read = NULL,            .mh_write = fsx_scan        },
	[FSX_MGMT_ID_SUBMIT_PIN]  = { .mh_read = NULL,            .mh_write = fsx_submit_pin  },
	[FSX_MGMT_ID_BATTERY]     = { .mh_read = fsx_battery,     .mh_write = NULL            },
};

static struct mgmt_group fsx_group = {
	.mg_handlers        = fsx_handlers,
	.mg_handlers_count  = ARRAY_SIZE(fsx_handlers),
	.mg_group_id        = FSX_MGMT_GROUP_ID,
};

static void fsx_register(void)
{
	mgmt_register_group(&fsx_group);
	/* Counted, not written down: this line used to say "6 cmds" as a
	 * literal and would have kept saying it after a seventh was added. */
	LOG_INF("fsx_mgmt group %u registered (%u cmds)", FSX_MGMT_GROUP_ID,
		(unsigned)ARRAY_SIZE(fsx_handlers));
}
MCUMGR_HANDLER_DEFINE(fsx_mgmt, fsx_register);
