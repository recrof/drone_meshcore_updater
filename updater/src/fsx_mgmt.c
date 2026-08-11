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

#include <string.h>
#include <stdio.h>

#include "fsx_mgmt.h"
#include "dfu_runner.h"

LOG_MODULE_REGISTER(fsx_mgmt, LOG_LEVEL_INF);

#define FSX_PATH_MAX          128
/* Upper bound on entries returned in a single `list` response. Also the
 * value we advertise to zcbor as the list capacity — needed for CBOR
 * indefinite-length container hinting. Clients that want more must
 * paginate using `off` + `count`.
 */
#define FSX_LIST_MAX_ENTRIES  32

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
static int rmdir_recursive(const char *path)
{
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
			walk_rc = rmdir_recursive(child);
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

/* ---------- trigger_dfu ---------- */
static int fsx_trigger_dfu(struct smp_streamer *ctxt)
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
	/* An absent or empty `path` is not an error — it requests auto-flash,
	 * where the bundle is chosen from ble_firmware_mapping once a target
	 * has been found. Only a present-but-unusable path is rejected.
	 */
	char path[FSX_PATH_MAX + 1] = { 0 };
	if (path_str.len != 0 && !copy_path(path, sizeof(path), &path_str)) {
		return MGMT_ERR_EINVAL;
	}

	/* dfu_runner_start spawns a thread; returns quickly. Failures
	 * (already busy, bad path) surface through the standard fs-error
	 * `rc` field so the client can display them.
	 */
	int rc = dfu_runner_start(path);
	LOG_INF("TRIGGER_DFU path='%s' -> rc=%d", path, rc);
	if (rc < 0) {
		smp_add_cmd_err(zse, FSX_MGMT_GROUP_ID, (uint16_t)-rc);
	}
	return MGMT_ERR_EOK;
}

/* ---------- registration ---------- */
static const struct mgmt_handler fsx_handlers[] = {
	[FSX_MGMT_ID_LIST]        = { .mh_read = fsx_list,        .mh_write = NULL            },
	[FSX_MGMT_ID_MKDIR]       = { .mh_read = NULL,            .mh_write = fsx_mkdir       },
	[FSX_MGMT_ID_RMDIR]       = { .mh_read = NULL,            .mh_write = fsx_rmdir       },
	[FSX_MGMT_ID_MOVE]        = { .mh_read = NULL,            .mh_write = fsx_move        },
	[FSX_MGMT_ID_STATVFS]     = { .mh_read = fsx_statvfs,     .mh_write = NULL            },
	[FSX_MGMT_ID_TRIGGER_DFU] = { .mh_read = NULL,            .mh_write = fsx_trigger_dfu },
};

static struct mgmt_group fsx_group = {
	.mg_handlers        = fsx_handlers,
	.mg_handlers_count  = ARRAY_SIZE(fsx_handlers),
	.mg_group_id        = FSX_MGMT_GROUP_ID,
};

static void fsx_register(void)
{
	mgmt_register_group(&fsx_group);
	LOG_INF("fsx_mgmt group %u registered (6 cmds)", FSX_MGMT_GROUP_ID);
}
MCUMGR_HANDLER_DEFINE(fsx_mgmt, fsx_register);
