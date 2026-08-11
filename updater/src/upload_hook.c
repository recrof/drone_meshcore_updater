/*
 * SMP fs_mgmt file-upload hook.
 *
 * mcumgr fs_mgmt exposes two callback events:
 *   MGMT_EVT_OP_FS_MGMT_FILE_ACCESS       - fires on every authorization
 *       check (per chunk, plus reads / status / hash queries). Handlers
 *       can approve or deny; we don't use it.
 *   MGMT_EVT_OP_FS_MGMT_FILE_ACCESS_DONE  - fires once per completed
 *       transfer with `struct fs_mgmt_file_access` carrying `access` and
 *       `filename`. This is the one we want.
 *
 * We register on _DONE, filter for WRITE access (upload from the client's
 * perspective) on a path under /lfs/ that ends in ".zip", and arm the
 * main-loop state machine to run DFU against it.
 *
 * The hook runs from mcumgr's workqueue and MUST return quickly — we
 * only touch a small atomic + string buffer; the actual DFU sequence
 * runs from main().
 */

#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>
#include <zephyr/mgmt/mcumgr/mgmt/callbacks.h>
#include <zephyr/mgmt/mcumgr/grp/fs_mgmt/fs_mgmt_callbacks.h>
#include <string.h>
#include <stdbool.h>
#include "app.h"

LOG_MODULE_REGISTER(upload_hook, LOG_LEVEL_INF);

/* Guarded by s_lock; the main loop reads atomically via pending_dfu_zip(). */
static struct k_spinlock s_lock;
static char              s_pending_path[128];
static bool              s_pending;

static bool ends_with_ci(const char *s, const char *suffix)
{
	size_t sn = strlen(s), suf = strlen(suffix);
	if (sn < suf) return false;
	const char *t = s + sn - suf;
	for (size_t i = 0; i < suf; i++) {
		char a = t[i], b = suffix[i];
		if (a >= 'A' && a <= 'Z') a += 32;
		if (b >= 'A' && b <= 'Z') b += 32;
		if (a != b) return false;
	}
	return true;
}

void arm_dfu_from_upload(const char *path)
{
	/* No-op — trigger is now explicit via fsx_mgmt.TRIGGER_DFU (client
	 * hits the "flash" button in the web UI). Kept as an ABI-stable
	 * symbol so fsx_stream / SMP upload hook don't need conditional
	 * compilation; if auto-arm is wanted again in the future, restore
	 * the pending-flag body and re-enable pending_dfu_zip polling.
	 */
	ARG_UNUSED(path);
}

const char *pending_dfu_zip(char *out, size_t out_len)
{
	if (!out || out_len == 0) return NULL;

	k_spinlock_key_t key = k_spin_lock(&s_lock);
	if (!s_pending) {
		k_spin_unlock(&s_lock, key);
		return NULL;
	}
	strncpy(out, s_pending_path, out_len - 1);
	out[out_len - 1] = '\0';
	s_pending = false;
	k_spin_unlock(&s_lock, key);
	return out;
}

/* mcumgr fires this once per completed transfer. `access` distinguishes
 * upload (WRITE) from download (READ) / status query / hash. We only care
 * about completed WRITEs; everything else is ignored.
 */
static enum mgmt_cb_return fs_access_done_cb(uint32_t event,
					     enum mgmt_cb_return prev_status,
					     int32_t *rc, uint16_t *group,
					     bool *abort_more, void *data,
					     size_t data_size)
{
	ARG_UNUSED(prev_status); ARG_UNUSED(rc); ARG_UNUSED(group);
	ARG_UNUSED(abort_more);  ARG_UNUSED(data_size);

	if (event != MGMT_EVT_OP_FS_MGMT_FILE_ACCESS_DONE) {
		return MGMT_CB_OK;
	}

	struct fs_mgmt_file_access *ev = data;
	if (ev->access == FS_MGMT_FILE_ACCESS_WRITE) {
		arm_dfu_from_upload(ev->filename);
	}
	return MGMT_CB_OK;
}

static struct mgmt_callback fs_cb = {
	.callback = fs_access_done_cb,
	.event_id = MGMT_EVT_OP_FS_MGMT_FILE_ACCESS_DONE,
};

static int register_fs_hook(void)
{
	mgmt_callback_register(&fs_cb);
	LOG_INF("fs_mgmt upload hook registered");
	return 0;
}
SYS_INIT(register_fs_hook, APPLICATION, 90);
