#pragma once

/*
 * Small workqueue wrapper around dfu_client_run(). fsx_mgmt's TRIGGER_DFU
 * handler must not block (it runs on mcumgr's workqueue and would starve
 * SMP), so we spawn the actual DFU sequence on a dedicated thread.
 *
 * One session at a time — a second TRIGGER_DFU while one is in flight
 * returns -EBUSY.
 */

#include <stddef.h>
#include <stdbool.h>

/* Kick off scan → parse → dfu on `zip_path`. Returns 0 if the job was
 * queued (async), -EBUSY if another DFU is already running,
 * -EINVAL / -errno on setup failure.
 *
 * `zip_path` NULL or "" selects **auto-flash**: scan first, then pick the
 * bundle by matching the peer's advertised name against the rules in
 * `ble_firmware_mapping` (see firmware_map.h). The bundle is resolved once,
 * from the first target found, and reused for every retry in that run.
 */
int dfu_runner_start(const char *zip_path);

/* True if a DFU sequence is currently active. */
bool dfu_runner_busy(void);
