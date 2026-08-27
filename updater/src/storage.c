/*
 * LittleFS bring-up on the external PY25Q64. The `automount` property on
 * the fstab node in DTS does most of the work — Zephyr mounts /lfs1 at
 * boot before main() runs. This module's job is only to (a) confirm the
 * mount succeeded, (b) seed a default /lfs1/config.txt on first boot so
 * the SMP fs_mgmt browser has something to show.
 */

#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>
#include <zephyr/fs/fs.h>
#include <zephyr/fs/littlefs.h>
#include <errno.h>
#include <string.h>
#include "app.h"

LOG_MODULE_REGISTER(storage, LOG_LEVEL_INF);

#define MOUNT_POINT "/lfs1"

/* Keep in step with APP_CONFIG_PATH in config.h — this file creates it, that
 * one reads it. Lowercase everywhere: LittleFS is case-sensitive, so one
 * agreed spelling is what stops a config from being silently ignored.
 */
#define CONFIG_PATH MOUNT_POINT "/config.txt"

static const char kDefaultConfig[] =
	"# xiao_nrf54_updater config.txt\n"
	"# Same key/value shape as the nRF52 project. See README for the full list.\n"
	"\n"
	"# BLE name filter for the target we flash (pipe-delimited OR).\n"
	"ble_name=OTA | DFU\n"
	"\n"
	"prn=32\n"
	"high_mtu=1\n"
	"retries=5\n"
	"min_rssi=-75\n"
	"retry_cooldown=5\n"
	"wedge_cooldown=10\n"
	"tx_power=8\n"
	"scan_timeout=0\n"
	"scan_debug=0\n";

static int seed_default_config(void)
{
	struct fs_dirent ent;
	int rc = fs_stat(CONFIG_PATH, &ent);
	if (rc == 0) return 0;  /* already present */
	if (rc != -ENOENT) {
		LOG_WRN("stat %s rc=%d", CONFIG_PATH, rc);
	}

	struct fs_file_t f;
	fs_file_t_init(&f);
	rc = fs_open(&f, CONFIG_PATH, FS_O_CREATE | FS_O_WRITE);
	if (rc) {
		LOG_ERR("open %s rc=%d", CONFIG_PATH, rc);
		return rc;
	}
	ssize_t w = fs_write(&f, kDefaultConfig, sizeof(kDefaultConfig) - 1);
	fs_close(&f);
	if (w != (ssize_t)(sizeof(kDefaultConfig) - 1)) {
		LOG_ERR("write %s short w=%d", CONFIG_PATH, (int)w);
		return -EIO;
	}
	LOG_INF("seeded default %s (%u B)", CONFIG_PATH,
		(unsigned)(sizeof(kDefaultConfig) - 1));
	return 0;
}

int storage_init(void)
{
	/* Confirm the automount worked — a `statvfs` on the mount point is
	 * the cheapest probe available.
	 */
	struct fs_statvfs st;
	int rc = fs_statvfs(MOUNT_POINT, &st);
	if (rc) {
		LOG_ERR("statvfs %s rc=%d — LittleFS mount failed", MOUNT_POINT, rc);
		return rc;
	}
	LOG_INF("LittleFS mounted at %s (blocks=%lu bfree=%lu bsize=%lu)",
		MOUNT_POINT, (unsigned long)st.f_blocks,
		(unsigned long)st.f_bfree, (unsigned long)st.f_bsize);

	return seed_default_config();
}
