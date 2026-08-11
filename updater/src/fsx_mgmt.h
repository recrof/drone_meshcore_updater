#pragma once

/*
 * fsx_mgmt — SMP "filesystem extensions" group.
 *
 * A custom mcumgr group that fills the gaps left by stock fs_mgmt
 * (group 8) — specifically: directory listing, mkdir, rmdir, move,
 * and statvfs. Runs alongside fs_mgmt; both are safe to enable at
 * the same time. Existing SMP clients (nRF Connect Device Manager,
 * AuTerm, mcumgr CLI) that don't know this group are unaffected —
 * they keep using fs_mgmt for upload/download as normal.
 *
 * Group ID: MGMT_GROUP_ID_PERUSER (64) — the canonical starting
 * point Zephyr reserves for vendor/application groups.
 *
 * Wire format is CBOR, same as every other SMP group.
 *
 * ---- Command reference ---------------------------------------
 *
 *   ID 0  READ   list      { path:tstr, off:uint?, count:uint? }
 *                      ->  { entries: [ { name:tstr, size:uint,
 *                                         type:uint }, ... ],
 *                            truncated:bool }
 *                          type: 0 = regular file, 1 = directory
 *                          `off`/`count` paginate large directories.
 *
 *   ID 1  WRITE  mkdir     { path:tstr }
 *                      ->  {}
 *
 *   ID 2  WRITE  rmdir     { path:tstr, recursive:bool? }
 *                      ->  {}
 *                          recursive=true also unlinks children
 *                          (equivalent to rm -rf).
 *
 *   ID 3  WRITE  move      { src:tstr, dst:tstr }
 *                      ->  {}
 *                          rename or move; both paths on same FS.
 *
 *   ID 4  READ   statvfs   { path:tstr }
 *                      ->  { bsize:uint, frsize:uint,
 *                            blocks:uint, bfree:uint }
 *                          bytes_free = frsize * bfree
 *                          bytes_total = frsize * blocks
 *
 * All handlers return standard MGMT_ERR_* codes for framing errors;
 * filesystem errors surface as an "rc" field via smp_add_cmd_err()
 * with the negated Zephyr errno as the value (matches how stock
 * fs_mgmt reports errors so clients handle them uniformly).
 */

#include <zephyr/mgmt/mcumgr/mgmt/mgmt_defines.h>

#define FSX_MGMT_GROUP_ID MGMT_GROUP_ID_PERUSER

enum fsx_mgmt_cmd {
	FSX_MGMT_ID_LIST        = 0,
	FSX_MGMT_ID_MKDIR       = 1,
	FSX_MGMT_ID_RMDIR       = 2,
	FSX_MGMT_ID_MOVE        = 3,
	FSX_MGMT_ID_STATVFS     = 4,
	/* WRITE { path:tstr } — arm the DFU state machine to flash the
	 * zip at `path`. Handler returns immediately after queueing; the
	 * actual scan → connect → discover → stream runs on a dedicated
	 * workqueue. Progress is via serial log; the LED state indicates
	 * running / done / fail.
	 */
	FSX_MGMT_ID_TRIGGER_DFU = 5,
};

/* Directory entry type constants used in `list` response. */
enum fsx_entry_type {
	FSX_ENTRY_FILE = 0,
	FSX_ENTRY_DIR  = 1,
};
