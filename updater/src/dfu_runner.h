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
 *
 * `pin` NULL or "" selects the usual search. Otherwise it names one specific
 * peer — the operator picked it out of a scan — and the run reaches that peer
 * or fails, with `ble_name` and `min_rssi` not applied. The string is opaque
 * here and is parsed by whichever transport claims it; see dfu_transport.h.
 * A pinned run uses a single transport, since a pin belongs to one of them or
 * to none.
 */
int dfu_runner_start(const char *zip_path, const char *pin);

/* True if a DFU sequence is currently active. */
bool dfu_runner_busy(void);

/* Stop whatever is running and clear the status back to IDLE.
 *
 * Ends a K_FOREVER scan, aborts a transfer in progress, and cuts short a
 * retry/wedge cooldown — the cooldowns being the reason this exists, since a
 * wedged run can otherwise sit for a minute before it will look at a new
 * config.txt.
 *
 * Returns 0 if a run was stopped, -EALREADY if nothing was running. Both are
 * successful outcomes and leave the same state behind; -EALREADY is reported
 * only so a caller can tell the two apart. In particular calling it while idle
 * is useful: it clears the sticky DONE/FAILED from the previous run.
 *
 * Returns as soon as the stop has been *requested*. The run thread unwinds on
 * its own — it may still be disconnecting for a moment afterwards — so
 * dfu_runner_busy() can briefly stay true. dfu_runner_start() will return
 * -EBUSY during that window; retry.
 */
int dfu_runner_stop(void);
