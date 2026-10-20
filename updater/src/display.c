/*
 * display.c — optional status display (CONFIG_UPDATER_DISPLAY).
 *
 * SPDX-License-Identifier: Apache-2.0
 *
 * Two LVGL screens on the board's zephyr,display, switched by sw0:
 *
 *   DFU   state, attempt, target, bundle, progress bar
 *   Info  battery, BLE client, bundle count, free space
 *
 * Both carry a header line: BLE client / upload, auto_flash, battery.
 *
 * **Read-only.** Everything shown is polled from modules that already keep
 * it — dfu_status_get(), battery_last(), fs_statvfs() — on this thread, and
 * nothing here can start, stop or alter a run. The one input that cannot be
 * polled is a file upload in flight; the two upload paths report each chunk
 * through display_upload_activity().
 *
 * **Power.** After CONFIG_UPDATER_DISPLAY_TIMEOUT_S without anything changing
 * the panel is blanked (SSD1306 display-off, a few uA). A state change, a BLE
 * client, an upload or sw0 turns it back on; the first press only wakes it.
 * It never blanks while a DFU run is in progress.
 *
 * All LVGL calls are made from display_thread() only.
 */

#include <zephyr/kernel.h>
#include <zephyr/device.h>
#include <zephyr/drivers/display.h>
#include <zephyr/fs/fs.h>
#include <zephyr/sys/atomic.h>
#include <zephyr/bluetooth/conn.h>
#include <zephyr/logging/log.h>
#include <lvgl.h>
#include <string.h>
#include <stdio.h>

#ifdef CONFIG_INPUT
#include <zephyr/input/input.h>
#endif

#include "display.h"
#include "dfu_status.h"
#include "battery.h"
#include "config.h"

LOG_MODULE_REGISTER(display, LOG_LEVEL_INF);

#define MOUNT_POINT        "/lfs1"
#define TICK_MS            250
#define UPLOAD_IDLE_MS     2000   /* no chunk for this long = upload over */
#define STORAGE_REFRESH_MS 30000

static const struct device *const s_disp = DEVICE_DT_GET(DT_CHOSEN(zephyr_display));

/* ---- Inputs from other threads ------------------------------------------- */

static atomic_t s_upload_ms;    /* uptime of the last upload chunk, 0 = never */
static atomic_t s_peers;        /* peripheral-role connections (clients) */
static atomic_t s_button;       /* sw0 presses not yet handled */
static atomic_t s_poke;         /* "something happened", wakes the panel */

void display_upload_activity(void)
{
	atomic_set(&s_upload_ms, (atomic_val_t)k_uptime_get_32() | 1);
}

static void on_connected(struct bt_conn *conn, uint8_t err)
{
	struct bt_conn_info info;

	if (err || bt_conn_get_info(conn, &info) || info.role != BT_CONN_ROLE_PERIPHERAL) {
		return;
	}
	atomic_inc(&s_peers);
	atomic_set(&s_poke, 1);
}

static void on_disconnected(struct bt_conn *conn, uint8_t reason)
{
	struct bt_conn_info info;

	ARG_UNUSED(reason);
	if (bt_conn_get_info(conn, &info) || info.role != BT_CONN_ROLE_PERIPHERAL) {
		return;
	}
	if (atomic_get(&s_peers) > 0) {
		atomic_dec(&s_peers);
	}
	atomic_set(&s_poke, 1);
}

BT_CONN_CB_DEFINE(display_conn_cb) = {
	.connected = on_connected,
	.disconnected = on_disconnected,
};

#ifdef CONFIG_INPUT
static void on_input(struct input_event *evt, void *user_data)
{
	ARG_UNUSED(user_data);
	if (evt->type == INPUT_EV_KEY && evt->code == INPUT_KEY_0 && evt->value) {
		atomic_inc(&s_button);
	}
}
INPUT_CALLBACK_DEFINE(NULL, on_input, NULL);
#endif

/* ---- Text --------------------------------------------------------------- */

static const char *state_text(uint8_t st)
{
	switch (st) {
	case DFU_STATUS_IDLE:          return "Ready";
	case DFU_STATUS_SCANNING:      return "Scanning";
	case DFU_STATUS_CONNECTING:    return "Connecting";
	case DFU_STATUS_STARTING:      return "Starting";
	case DFU_STATUS_ENABLING:      return "Enter DFU";
	case DFU_STATUS_UPLOADING:     return "Flashing";
	case DFU_STATUS_VALIDATING:    return "Validating";
	case DFU_STATUS_DISCONNECTING: return "Activating";
	case DFU_STATUS_COOLDOWN:      return "Retry wait";
	case DFU_STATUS_DONE:          return "Done";
	case DFU_STATUS_FAILED:        return "Failed";
	case DFU_STATUS_VERIFYING:     return "Verifying";
	case DFU_STATUS_AWAITING_PIN:  return "Enter PIN";
	default:                       return "?";
	}
}

static const char *result_text(uint8_t r)
{
	switch (r) {
	case DFU_STATUS_RESULT_OK:                 return "OK";
	case DFU_STATUS_RESULT_NO_TARGET:          return "no target";
	case DFU_STATUS_RESULT_SCAN_ERROR:         return "scan error";
	case DFU_STATUS_RESULT_BAD_BUNDLE:         return "bad bundle";
	case DFU_STATUS_RESULT_CONNECT_FAILED:     return "connect failed";
	case DFU_STATUS_RESULT_SERVICE_MISSING:    return "no DFU service";
	case DFU_STATUS_RESULT_CHAR_MISSING:       return "no DFU char";
	case DFU_STATUS_RESULT_DISCONNECTED:       return "disconnected";
	case DFU_STATUS_RESULT_TIMEOUT:            return "timeout";
	case DFU_STATUS_RESULT_REMOTE_ERROR:       return "target error";
	case DFU_STATUS_RESULT_FS_ERROR:           return "storage error";
	case DFU_STATUS_RESULT_RETRIES_EXHAUSTED:  return "retries used up";
	case DFU_STATUS_RESULT_TARGET_REJECTED:    return "rejected";
	case DFU_STATUS_RESULT_AUTH_REQUIRED:      return "PIN required";
	case DFU_STATUS_RESULT_AUTH_FAILED:        return "PIN rejected";
	case DFU_STATUS_RESULT_UNREACHABLE_TARGET: return "unreachable";
	case DFU_STATUS_RESULT_NO_APP_RULE:        return "no app rule";
	default:                                   return "";
	}
}

static bool run_active(uint8_t st)
{
	return st != DFU_STATUS_IDLE && st != DFU_STATUS_DONE && st != DFU_STATUS_FAILED;
}

static const char *battery_symbol(uint8_t pct)
{
	if (pct >= 90) {
		return LV_SYMBOL_BATTERY_FULL;
	} else if (pct >= 65) {
		return LV_SYMBOL_BATTERY_3;
	} else if (pct >= 35) {
		return LV_SYMBOL_BATTERY_2;
	} else if (pct >= 10) {
		return LV_SYMBOL_BATTERY_1;
	}
	return LV_SYMBOL_BATTERY_EMPTY;
}

/* ---- Storage ------------------------------------------------------------- */

struct storage_info {
	uint32_t bundles;
	uint32_t free_kb;
	uint32_t total_kb;
	bool valid;
};

static bool is_bundle(const char *name)
{
	size_t n = strlen(name);

	return n > 4 && (name[n - 4] == '.') &&
	       (name[n - 3] | 0x20) == 'z' && (name[n - 2] | 0x20) == 'i' &&
	       (name[n - 1] | 0x20) == 'p';
}

static void storage_scan(struct storage_info *out)
{
	struct fs_statvfs st;
	struct fs_dir_t dir;
	struct fs_dirent ent;

	out->valid = false;
	if (fs_statvfs(MOUNT_POINT, &st) != 0) {
		return;
	}
	out->free_kb  = (uint32_t)((uint64_t)st.f_bfree * st.f_frsize / 1024);
	out->total_kb = (uint32_t)((uint64_t)st.f_blocks * st.f_frsize / 1024);
	out->bundles  = 0;

	fs_dir_t_init(&dir);
	if (fs_opendir(&dir, MOUNT_POINT) == 0) {
		while (fs_readdir(&dir, &ent) == 0 && ent.name[0] != '\0') {
			if (ent.type == FS_DIR_ENTRY_FILE && is_bundle(ent.name)) {
				out->bundles++;
			}
		}
		fs_closedir(&dir);
	}
	out->valid = true;
}

/* ---- Screens ------------------------------------------------------------- */

struct header {
	lv_obj_t *ble;
	lv_obj_t *mode;
	lv_obj_t *batt;
};

static struct {
	lv_obj_t *scr;
	struct header hdr;
	lv_obj_t *state;
	lv_obj_t *attempt;
	lv_obj_t *target;
	lv_obj_t *file;
	lv_obj_t *bar;
	lv_obj_t *pct;
} s_dfu;

static struct {
	lv_obj_t *scr;
	struct header hdr;
	lv_obj_t *line[4];
} s_info;

static void set_text(lv_obj_t *label, const char *text)
{
	/* Only redraw what changed: every invalidation is an I2C transfer. */
	if (strcmp(lv_label_get_text(label), text) != 0) {
		lv_label_set_text(label, text);
	}
}

static lv_obj_t *label_at(lv_obj_t *parent, const lv_font_t *font, lv_align_t align,
			  int32_t x, int32_t y)
{
	lv_obj_t *l = lv_label_create(parent);

	lv_obj_set_style_text_font(l, font, 0);
	lv_label_set_text(l, "");
	lv_obj_align(l, align, x, y);
	return l;
}

static lv_obj_t *screen_create(struct header *hdr)
{
	lv_obj_t *scr = lv_obj_create(NULL);
	lv_obj_t *rule = lv_obj_create(scr);

	lv_obj_set_size(rule, LV_PCT(100), 1);
	lv_obj_set_style_border_width(rule, 0, 0);
	lv_obj_set_style_radius(rule, 0, 0);
	lv_obj_set_style_bg_color(rule, lv_color_black(), 0);
	lv_obj_set_style_bg_opa(rule, LV_OPA_COVER, 0);
	lv_obj_align(rule, LV_ALIGN_TOP_LEFT, 0, 13);

	hdr->ble  = label_at(scr, &lv_font_montserrat_12, LV_ALIGN_TOP_LEFT, 0, 0);
	hdr->mode = label_at(scr, &lv_font_montserrat_12, LV_ALIGN_TOP_MID, 0, 0);
	hdr->batt = label_at(scr, &lv_font_montserrat_12, LV_ALIGN_TOP_RIGHT, 0, 0);
	return scr;
}

static void screens_create(void)
{
	s_dfu.scr     = screen_create(&s_dfu.hdr);
	s_dfu.state   = label_at(s_dfu.scr, &lv_font_montserrat_14, LV_ALIGN_TOP_LEFT, 0, 15);
	s_dfu.attempt = label_at(s_dfu.scr, &lv_font_montserrat_12, LV_ALIGN_TOP_RIGHT, 0, 17);
	s_dfu.target  = label_at(s_dfu.scr, &lv_font_montserrat_12, LV_ALIGN_TOP_LEFT, 0, 31);
	s_dfu.file    = label_at(s_dfu.scr, &lv_font_montserrat_12, LV_ALIGN_TOP_LEFT, 0, 43);
	lv_label_set_long_mode(s_dfu.target, LV_LABEL_LONG_CLIP);
	lv_label_set_long_mode(s_dfu.file, LV_LABEL_LONG_CLIP);
	lv_obj_set_width(s_dfu.target, LV_PCT(100));
	lv_obj_set_width(s_dfu.file, LV_PCT(100));

	s_dfu.bar = lv_bar_create(s_dfu.scr);
	lv_obj_set_size(s_dfu.bar, 96, 7);
	lv_obj_align(s_dfu.bar, LV_ALIGN_BOTTOM_LEFT, 0, -1);
	lv_obj_set_style_border_width(s_dfu.bar, 1, LV_PART_MAIN);
	lv_obj_set_style_border_color(s_dfu.bar, lv_color_black(), LV_PART_MAIN);
	lv_obj_set_style_radius(s_dfu.bar, 0, LV_PART_MAIN);
	lv_obj_set_style_radius(s_dfu.bar, 0, LV_PART_INDICATOR);
	lv_obj_set_style_bg_color(s_dfu.bar, lv_color_black(), LV_PART_INDICATOR);
	lv_bar_set_range(s_dfu.bar, 0, 100);
	s_dfu.pct = label_at(s_dfu.scr, &lv_font_montserrat_12, LV_ALIGN_BOTTOM_RIGHT, 0, 2);

	s_info.scr = screen_create(&s_info.hdr);
	for (int i = 0; i < ARRAY_SIZE(s_info.line); i++) {
		s_info.line[i] = label_at(s_info.scr, &lv_font_montserrat_12,
					  LV_ALIGN_TOP_LEFT, 0, 15 + 12 * i);
	}
}

/* ---- Rendering ----------------------------------------------------------- */

struct model {
	struct dfu_status_view dfu;
	struct battery_status batt;
	bool batt_valid;
	bool client;
	bool uploading;
	bool auto_flash;
	struct storage_info store;
};

static void render_header(const struct header *hdr, const struct model *m)
{
	char buf[24];

	snprintf(buf, sizeof(buf), "%s%s", m->client ? LV_SYMBOL_BLUETOOTH : "-",
		 m->uploading ? " " LV_SYMBOL_UPLOAD : "");
	set_text(hdr->ble, buf);
	set_text(hdr->mode, m->auto_flash ? "AUTO" : "");
	if (m->batt_valid) {
		snprintf(buf, sizeof(buf), "%u%% %s", m->batt.percent,
			 battery_symbol(m->batt.percent));
	} else {
		snprintf(buf, sizeof(buf), "%s", LV_SYMBOL_USB);
	}
	set_text(hdr->batt, buf);
}

static void render_dfu(const struct model *m)
{
	const struct dfu_status_view *d = &m->dfu;
	char buf[DFU_STATUS_NAME_MAX + 8];

	render_header(&s_dfu.hdr, m);

	if (d->state == DFU_STATUS_FAILED) {
		snprintf(buf, sizeof(buf), "Failed: %s", result_text(d->result));
	} else {
		snprintf(buf, sizeof(buf), "%s", state_text(d->state));
	}
	set_text(s_dfu.state, buf);

	if (d->retries > 0 && d->attempt > 0) {
		snprintf(buf, sizeof(buf), "%u/%u", d->attempt, d->retries);
	} else {
		buf[0] = '\0';
	}
	set_text(s_dfu.attempt, buf);

	if (d->name[0]) {
		set_text(s_dfu.target, d->name);
	} else if (d->state == DFU_STATUS_IDLE) {
		set_text(s_dfu.target, m->client ? "Client connected" : "Waiting for client");
	} else {
		set_text(s_dfu.target, "-");
	}

	if (d->file[0]) {
		set_text(s_dfu.file, d->file);
	} else if (m->store.valid) {
		snprintf(buf, sizeof(buf), "%u bundles stored", m->store.bundles);
		set_text(s_dfu.file, buf);
	} else {
		set_text(s_dfu.file, "");
	}

	uint8_t pct = d->state == DFU_STATUS_DONE ? 100 : d->percent;

	if (lv_bar_get_value(s_dfu.bar) != pct) {
		lv_bar_set_value(s_dfu.bar, pct, LV_ANIM_OFF);
	}
	snprintf(buf, sizeof(buf), "%u%%", pct);
	set_text(s_dfu.pct, buf);
}

static void render_info(const struct model *m)
{
	char buf[40];

	render_header(&s_info.hdr, m);

	if (m->batt_valid) {
		snprintf(buf, sizeof(buf), "Battery %u.%02u V  %u%%",
			 m->batt.millivolts / 1000, (m->batt.millivolts % 1000) / 10,
			 m->batt.percent);
	} else {
		snprintf(buf, sizeof(buf), "Battery: n/a");
	}
	set_text(s_info.line[0], buf);

	snprintf(buf, sizeof(buf), "BLE: %s", m->uploading ? "uploading" :
		 m->client ? "client connected" : "advertising");
	set_text(s_info.line[1], buf);

	if (m->store.valid) {
		snprintf(buf, sizeof(buf), "Bundles: %u", m->store.bundles);
		set_text(s_info.line[2], buf);
		snprintf(buf, sizeof(buf), "Free: %u.%u / %u.%u MB",
			 m->store.free_kb / 1024, (m->store.free_kb % 1024) * 10 / 1024,
			 m->store.total_kb / 1024, (m->store.total_kb % 1024) * 10 / 1024);
		set_text(s_info.line[3], buf);
	} else {
		set_text(s_info.line[2], "Storage: n/a");
		set_text(s_info.line[3], "");
	}
}

/* ---- Thread -------------------------------------------------------------- */

static void display_thread(void *a, void *b, void *c)
{
	ARG_UNUSED(a);
	ARG_UNUSED(b);
	ARG_UNUSED(c);

	if (!device_is_ready(s_disp)) {
		LOG_ERR("display %s not ready", s_disp->name);
		return;
	}

	screens_create();
	lv_screen_load(s_dfu.scr);

	struct model m = {0};
	struct dfu_status_view last_dfu = {0};
	bool on_info = false;
	bool blanked = false;
	bool was_uploading = false;
	uint32_t last_activity = k_uptime_get_32();
	uint32_t last_scan = 0;

	storage_scan(&m.store);
	last_scan = k_uptime_get_32();

	display_blanking_off(s_disp);
	LOG_INF("status display up (timeout %d s)", CONFIG_UPDATER_DISPLAY_TIMEOUT_S);

	while (true) {
		uint32_t now = k_uptime_get_32();
		bool activity = atomic_set(&s_poke, 0) != 0;

		/* -- gather -- */
		dfu_status_get(&m.dfu);
		m.batt_valid = battery_present() && battery_last(&m.batt);
		m.client = atomic_get(&s_peers) > 0;
		m.auto_flash = app_config_current()->auto_flash;

		uint32_t up = (uint32_t)atomic_get(&s_upload_ms);

		m.uploading = up != 0 && (now - up) < UPLOAD_IDLE_MS;
		if (m.uploading) {
			activity = true;
		}
		if ((was_uploading && !m.uploading) ||
		    (m.dfu.state != last_dfu.state && !run_active(m.dfu.state)) ||
		    (now - last_scan) >= STORAGE_REFRESH_MS) {
			storage_scan(&m.store);
			last_scan = now;
		}
		was_uploading = m.uploading;

		if (m.dfu.state != last_dfu.state || m.dfu.result != last_dfu.result ||
		    m.dfu.attempt != last_dfu.attempt || strcmp(m.dfu.name, last_dfu.name)) {
			activity = true;
			if (run_active(m.dfu.state) && !run_active(last_dfu.state)) {
				on_info = false;    /* a run starting brings its screen up */
				lv_screen_load(s_dfu.scr);
			}
		}
		if (m.dfu.percent != last_dfu.percent) {
			activity = true;
		}
		last_dfu = m.dfu;

		/* -- button -- */
		atomic_val_t presses = atomic_set(&s_button, 0);

		if (presses) {
			if (!blanked) {
				on_info = !on_info;
				lv_screen_load(on_info ? s_info.scr : s_dfu.scr);
			}
			activity = true;
		}

		/* -- power -- */
		if (activity || run_active(m.dfu.state)) {
			last_activity = now;
		}
		if (blanked && activity) {
			blanked = false;
			display_blanking_off(s_disp);
		}
		if (!blanked && CONFIG_UPDATER_DISPLAY_TIMEOUT_S > 0 &&
		    (now - last_activity) >= CONFIG_UPDATER_DISPLAY_TIMEOUT_S * 1000U) {
			blanked = true;
			display_blanking_on(s_disp);
		}

		/* -- draw -- */
		if (!blanked) {
			if (on_info) {
				render_info(&m);
			} else {
				render_dfu(&m);
			}
			lv_timer_handler();
		}
		k_msleep(TICK_MS);
	}
}

K_THREAD_DEFINE(display_tid, 4096, display_thread, NULL, NULL, NULL,
		K_LOWEST_APPLICATION_THREAD_PRIO, 0, 500);
