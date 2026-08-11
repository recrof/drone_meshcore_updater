/*
 * Dedicated worker for the DFU sequence.
 *
 * Runs on a private thread (not the system workqueue) because a full
 * DFU can take tens of seconds to minutes, and we don't want to block
 * whatever else the system workqueue is doing (mcumgr transport work,
 * logging FS backend, etc.). Own stack sized generously — dfu_legacy_run
 * internally calls into bt_gatt_discover callbacks, fs_read, and CBOR-
 * free but non-trivial buffer manipulation.
 */

#include "dfu_runner.h"

#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>
#include <string.h>
#include <stdio.h>

#include "config.h"
#include "ble_scanner.h"
#include "firmware_zip.h"
#include "firmware_map.h"
#include "dfu_legacy.h"
#include "app.h"

LOG_MODULE_REGISTER(dfu_runner, LOG_LEVEL_INF);

#define DFU_STACK_SIZE 4096
#define DFU_PATH_MAX   128

/* Directory auto-flash searches for bundles. Same mount the config lives on. */
#define DFU_BUNDLE_DIR "/lfs1"

K_THREAD_STACK_DEFINE(s_stack, DFU_STACK_SIZE);
static struct k_thread s_thread;
static k_tid_t         s_tid;

static struct k_mutex   s_lock;
static bool             s_busy;
static char             s_path[DFU_PATH_MAX + 1];

static void run_thread(void *a, void *b, void *c)
{
	ARG_UNUSED(a); ARG_UNUSED(b); ARG_UNUSED(c);

	LOG_INF("DFU runner: begin path=%s", s_path);
	led_set_state(LED_STATE_DFU_RUNNING);

	/* Reload config.txt — users edit + re-upload it while the device
	 * is running, and we want those changes to apply without a
	 * power-cycle. Cheap (<1 KB read + a few strcmps).
	 */
	app_config_load();
	const struct app_config *cfg = app_config_current();
	LOG_INF("DFU runner: cfg ble_name='%s' min_rssi=%d retries=%u",
		cfg->ble_name, cfg->min_rssi, cfg->retries);
	struct firmware_bundle bundle;
	char err[96];
	int  rc;

	/* Empty path = auto-flash: scan first, then let ble_firmware_mapping
	 * pick the bundle from the peer's advertised name.
	 */
	const bool auto_mode  = (s_path[0] == '\0');
	bool       bundle_open = false;

	if (auto_mode) {
		if (!cfg->ble_firmware_mapping[0]) {
			LOG_ERR("auto-flash requested but ble_firmware_mapping "
				"is empty — nothing to choose from");
			goto fail;
		}
		LOG_INF("DFU runner: auto-flash, mapping='%s'",
			cfg->ble_firmware_mapping);
	} else {
		rc = firmware_zip_open(s_path, &bundle, err, sizeof(err));
		if (rc < 0) {
			LOG_ERR("zip parse failed: %s (rc=%d)", err, rc);
			goto fail;
		}
		bundle_open = true;
	}

	uint8_t attempt = 0;
	while (attempt < cfg->retries) {
		/* Re-read config on *every* attempt, not just once per run.
		 * A run can span many minutes — five attempts separated by
		 * 60 s wedge cooldowns — and reloading only at the top makes
		 * the reload nearly useless: an operator who uploads a tweaked
		 * config.txt mid-run sees it ignored for the rest of the run.
		 * Observed exactly that with a prn=1 file uploaded during a
		 * cooldown; the remaining attempts kept using prn=8.
		 *
		 * cfg points at the module-static struct, so it stays valid
		 * across reloads. Re-evaluating cfg->retries in the loop
		 * condition is intentional too — lowering it should be able to
		 * cut a grinding retry loop short.
		 */
		if (attempt > 0) {
			app_config_load();
			LOG_INF("DFU runner: attempt %u cfg prn=%u pkt_gap_ms=%u "
				"min_rssi=%d", attempt + 1, cfg->prn,
				cfg->pkt_gap_ms, cfg->min_rssi);
		}

		struct ble_scanner_target target;
		rc = ble_scanner_find_first(&target,
					     (uint32_t)cfg->scan_timeout * 1000,
					     cfg->ble_name, cfg->min_rssi, NULL);
		if (rc == -ETIMEDOUT) {
			LOG_ERR("scan timed out (no target)");
			goto fail;
		}
		if (rc < 0) {
			LOG_ERR("scan rc=%d", rc);
			goto fail;
		}

		/* Resolve the bundle once, from the first peer we find, and
		 * keep it for the rest of the run. Re-resolving per attempt
		 * would break the buttonless flow: the peer reboots into its
		 * bootloader advertising a *different* name (OTA -> DFU), so a
		 * mapping written for the app-mode name would stop matching
		 * halfway through its own DFU.
		 */
		if (auto_mode && !bundle_open) {
			char picked[DFU_PATH_MAX + 1];
			rc = firmware_map_resolve(target.name,
						  cfg->ble_firmware_mapping,
						  DFU_BUNDLE_DIR,
						  picked, sizeof(picked),
						  err, sizeof(err));
			if (rc < 0) {
				LOG_ERR("auto-flash: %s (rc=%d)", err, rc);
				goto fail;
			}
			rc = firmware_zip_open(picked, &bundle, err, sizeof(err));
			if (rc < 0) {
				LOG_ERR("zip parse failed: %s (rc=%d)", err, rc);
				goto fail;
			}
			bundle_open = true;
		}

		enum dfu_result r = dfu_legacy_run(&target, &bundle, cfg);
		switch (r) {
		case DFU_OK:
			LOG_INF("DFU runner: SUCCESS");
			led_set_state(LED_STATE_DONE_OK);
			goto done;
		case DFU_BUTTONLESS_TRIGGERED:
			LOG_INF("DFU runner: buttonless triggered, rescanning");
			k_sleep(K_SECONDS(2));
			continue;    /* doesn't consume a retry */
		case DFU_CONNECT_FAILED:
			LOG_WRN("DFU runner: connect failed — short cooldown");
			attempt++;
			if (attempt < cfg->retries && cfg->retry_cooldown) {
				k_sleep(K_SECONDS(cfg->retry_cooldown));
			}
			break;
		default:
			LOG_WRN("DFU runner: attempt %u/%u result=%d — wedge cooldown",
				attempt + 1, cfg->retries, (int)r);
			attempt++;
			if (attempt < cfg->retries && cfg->wedge_cooldown) {
				k_sleep(K_SECONDS(cfg->wedge_cooldown));
			}
			break;
		}
	}
	LOG_ERR("DFU runner: FAILED after %u attempts", cfg->retries);

fail:
	led_set_state(LED_STATE_DONE_FAIL);
done:
	/* One close for every exit path — auto mode can bail before a bundle
	 * was ever opened, so it has to be conditional.
	 */
	if (bundle_open) firmware_zip_close();
	k_mutex_lock(&s_lock, K_FOREVER);
	s_busy = false;
	k_mutex_unlock(&s_lock);
}

int dfu_runner_start(const char *zip_path)
{
	/* NULL or "" selects auto-flash — the bundle is chosen from
	 * ble_firmware_mapping once a target has been found.
	 */
	static bool inited;
	if (!inited) {
		k_mutex_init(&s_lock);
		inited = true;
	}

	k_mutex_lock(&s_lock, K_FOREVER);
	if (s_busy) {
		k_mutex_unlock(&s_lock);
		return -EBUSY;
	}
	snprintf(s_path, sizeof(s_path), "%s", zip_path ? zip_path : "");
	s_busy = true;
	k_mutex_unlock(&s_lock);

	/* Abandon any previous thread — Zephyr threads are lightweight, we
	 * just create a fresh one per DFU cycle. Stack is static so no
	 * allocation.
	 */
	s_tid = k_thread_create(&s_thread, s_stack, DFU_STACK_SIZE,
				run_thread, NULL, NULL, NULL,
				K_PRIO_PREEMPT(7), 0, K_NO_WAIT);
	k_thread_name_set(s_tid, "dfu_runner");
	return 0;
}

bool dfu_runner_busy(void)
{
	k_mutex_lock(&s_lock, K_FOREVER);
	bool b = s_busy;
	k_mutex_unlock(&s_lock);
	return b;
}
