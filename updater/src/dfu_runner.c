/*
 * Dedicated worker for the DFU sequence.
 *
 * Runs on a private thread (not the system workqueue) because a full
 * DFU can take tens of seconds to minutes, and we don't want to block
 * whatever else the system workqueue is doing (mcumgr transport work,
 * logging FS backend, etc.). Own stack sized generously — the DFU client
 * runs bt_gatt_discover callbacks, fs_read, and non-trivial buffer
 * manipulation on this thread.
 */

#include "dfu_runner.h"

#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>
#include <string.h>
#include <strings.h>   /* strcasecmp */
#include <zephyr/fs/fs.h>
#include <stdio.h>

#include "config.h"
#include "ble_scanner.h"
#include "dfu_transport.h"
#include "firmware_zip.h"
#include "firmware_map.h"
#include "dfu_client.h"
#include "dfu_status.h"
#include "survey.h"
#include "app.h"

LOG_MODULE_REGISTER(dfu_runner, LOG_LEVEL_INF);

/*
 * **8192, and 4096 was measured overflowing.** Caught by CONFIG_STACK_SENTINEL
 * on the ESP32-S3, 22.5 s into a flash:
 *
 *   >>> ZEPHYR FATAL ERROR 2: Stack overflow on CPU 0
 *   Current thread: 0x3fcbd170 (dfu_runner)
 *
 * The thread's own work is modest. What is not modest is everything it reaches:
 * app_config_load() and firmware_zip reads go through littlefs, the C++ session
 * carries a packet buffer, the WiFi transport adds a TCP send path and an MD5
 * pass, and on Xtensa an arriving exception frame is pushed onto whichever
 * thread was running. Walking the direct-call graph of the linked images gives
 * 2384 B (Xtensa) and **5000 B (ARM)** — the second already over the old size,
 * and both are floors, since a call graph cannot follow the vtable into the
 * network stack or the GATT callbacks.
 *
 * That the nRF boards had not tripped their MPU guard means the deepest path is
 * rare, not that it is absent: it runs through a littlefs directory commit that
 * itself emits a log line. See notes/traps.md — this is the third thread in this
 * firmware to overflow for the same reason, which is that **everything here
 * touches littlefs and littlefs is deep.**
 */
#define DFU_STACK_SIZE 8192
#define DFU_PATH_MAX   128

/*
 * Resolve a path into whatever shape it actually is.
 *
 * A `.zip` is a legacy package and gets parsed; anything else is taken as a
 * bare application image and only measured. The extension is the whole test,
 * deliberately: firmware_inspect() is the thorough check and it runs when the
 * file *arrives*, which is where a bad file should be caught. Doing that work
 * again here would re-read half a megabyte from flash at the top of every
 * run, to answer a question already answered.
 *
 * `path_out` holds a copy the caller owns, because `payload.path` outlives
 * the caller's own buffer in the auto-flash case.
 */
static int open_payload(const char *path, struct dfu_payload *out,
			char *path_out, size_t path_out_sz,
			char *err, size_t err_sz)
{
	strncpy(path_out, path, path_out_sz - 1);
	path_out[path_out_sz - 1] = '\0';
	out->path = path_out;

	size_t n = strlen(path);
	bool is_zip = n >= 4 && !strcasecmp(path + n - 4, ".zip");

	if (is_zip) {
		out->kind = DFU_PAYLOAD_ZIP;
		return firmware_zip_open(path, &out->zip, err, err_sz);
	}

	struct fs_dirent st;
	int rc = fs_stat(path, &st);
	if (rc < 0) {
		snprintf(err, err_sz, "%s not found", path);
		return rc;
	}
	if (st.size == 0) {
		snprintf(err, err_sz, "%s is empty", path);
		return -EINVAL;
	}
	out->kind = DFU_PAYLOAD_RAW;
	out->size = (uint32_t)st.size;
	return 0;
}

/* Directory auto-flash searches for bundles. Same mount the config lives on. */
#define DFU_BUNDLE_DIR "/lfs1"

K_THREAD_STACK_DEFINE(s_stack, DFU_STACK_SIZE);
static struct k_thread s_thread;
static k_tid_t         s_tid;

static struct k_mutex   s_lock;
static bool             s_busy;

/*
 * Stop support.
 *
 * s_cancel is the authority — every transport abort() is best-effort, so the
 * runner never trusts one to have worked and re-checks this flag itself at
 * each point it could otherwise commit to another long wait.
 *
 * s_wake exists because the cooldowns are the *worst* thing to sit through:
 * wedge_cooldown defaults to 10 s and is the whole reason a stop button was
 * asked for. Waiting on a semaphore instead of k_sleep() makes them end the
 * instant a stop arrives, without polling.
 */
static atomic_t         s_cancel = ATOMIC_INIT(0);
static K_SEM_DEFINE(s_wake, 0, 1);

static bool cancelled(void)
{
	return atomic_get(&s_cancel) != 0;
}

/* Sleep unless a stop arrives first. Returns true if it was cut short, which
 * every caller treats as "leave now". */
static bool runner_sleep(k_timeout_t d)
{
	if (cancelled()) {
		return true;
	}
	return k_sem_take(&s_wake, d) == 0;
}
static char             s_path[DFU_PATH_MAX + 1];
/* The peer the operator picked, opaque to this file — see dfu_transport.h.
 * Empty means the usual search. Sized for "AA:BB:CC:DD:EE:FF (random)" with
 * room to spare, since a future transport may pin something longer. */
#define DFU_PIN_MAX 40
static char             s_pin[DFU_PIN_MAX + 1];

/* How long a single transport gets to look, when there is more than one to
 * share the window with. Only used in that case — see find_target(). */
#define SCAN_SLICE_MS 10000

/*
 * Which payload shapes could this mapping select?
 *
 * In auto-flash the bundle is only chosen *after* a peer is named, so the
 * runner does not know what it is about to send when it starts scanning. But
 * the mapping rules do say which files are candidates, and a file's extension
 * decides its transport — so the rules narrow the transports even though they
 * do not pick one.
 *
 * A pattern this cannot classify (`rak*`, no extension) means both, because
 * guessing wrong here removes a transport that was needed. Returns a mask of
 * `1 << enum dfu_payload_kind`.
 */
#define KIND_BIT(k) (1u << (k))
#define KIND_ANY (KIND_BIT(DFU_PAYLOAD_ZIP) | KIND_BIT(DFU_PAYLOAD_RAW))

static uint8_t mapping_kind_mask(const char *mapping)
{
	uint8_t mask = 0;
	const char *p = mapping;

	if (!p || !*p) return KIND_ANY;

	while (*p) {
		/* Each rule is NAME:pattern, rules split on '|'. Only the
		 * pattern half matters here. */
		const char *end = strchr(p, '|');
		const char *stop = end ? end : p + strlen(p);
		const char *colon = memchr(p, ':', (size_t)(stop - p));

		if (colon) {
			const char *pat = colon + 1;
			/* Trim trailing space so ".zip " still classifies. */
			const char *e = stop;
			while (e > pat && (e[-1] == ' ' || e[-1] == '\t')) e--;

			size_t len = (size_t)(e - pat);
			if (len >= 4 && !strncasecmp(e - 4, ".zip", 4)) {
				mask |= KIND_BIT(DFU_PAYLOAD_ZIP);
			} else if (len >= 4 && !strncasecmp(e - 4, ".bin", 4)) {
				mask |= KIND_BIT(DFU_PAYLOAD_RAW);
			} else {
				return KIND_ANY;   /* unclassifiable: try both */
			}
		}
		if (!end) break;
		p = end + 1;
	}
	return mask ? mask : KIND_ANY;
}

/* Ask each available transport in turn until one finds something.
 *
 * The timeout policy is the fiddly part. `scan_timeout=0` means "scan
 * forever", which is the drone default and cannot be handed to two transports
 * at once — the first would never return. So:
 *
 *   one transport   -> it gets the configured window verbatim, including 0.
 *                      This is the single-transport case behaving exactly as
 *                      it did before there was an interface here at all.
 *   two or more     -> each gets a slice and the loop goes round, so "forever"
 *                      becomes "keep alternating". A restart costs the tail of
 *                      an advertising interval, which is why it is not done
 *                      when there is nothing to alternate with.
 *
 * Returns 0 with `out` populated, -ETIMEDOUT if every transport's window
 * expired quietly, or the last real error if one of them actually failed.
 */
static int find_target(struct dfu_target *out, const struct app_config *cfg,
		       uint8_t kind_mask, const char *pin)
{
	size_t count;
	const struct dfu_transport *const *all = dfu_transport_list(&count);

	const struct dfu_transport *usable[8];
	size_t n = 0;
	for (size_t i = 0; i < count && n < ARRAY_SIZE(usable); i++) {
		/* Two filters. `available()` asks whether the transport can
		 * run at all; the mask asks whether it could carry the file we
		 * are about to send.
		 *
		 * The second is what makes an explicit flash deterministic:
		 * pressing Flash on a .zip is a Bluetooth job and there is no
		 * reason to spend a scan slice associating with a WiFi AP —
		 * the file already answered the question. */
		if (!(kind_mask & KIND_BIT(all[i]->payload_kind))) continue;
		if (all[i]->available == NULL || all[i]->available(cfg)) {
			usable[n++] = all[i];
		}
	}
	if (n == 0) {
		LOG_ERR("no usable transport for this file — nothing can be reached");
		return -ENOTSUP;
	}

	/* A pinned target names one peer, so alternating transports to look
	 * for it makes no sense: the pin either belongs to one of them or to
	 * none. Slicing the window would only delay the -EINVAL. */
	if (pin != NULL && pin[0] != '\0' && n > 1) {
		LOG_INF("pinned target — %zu transports offered, trying %s only",
			n, usable[0]->name);
		n = 1;
	}

	const uint32_t configured = (uint32_t)cfg->scan_timeout * 1000u;
	const bool forever = (cfg->scan_timeout == 0);

	int last_err = -ETIMEDOUT;
	uint32_t spent = 0;

	for (;;) {
		for (size_t i = 0; i < n; i++) {
			uint32_t slice;
			if (n == 1) {
				slice = configured;      /* 0 stays 0: forever */
			} else if (forever) {
				slice = SCAN_SLICE_MS;
			} else {
				uint32_t left = (spent < configured) ? configured - spent : 0;
				slice = MIN(left, (uint32_t)SCAN_SLICE_MS);
				if (slice == 0) {
					return last_err;
				}
			}

			memset(out, 0, sizeof(*out));
			out->tp = usable[i];

			if (n > 1) {
				LOG_INF("scanning via %s (%u ms)", usable[i]->name, slice);
			}
			int rc = usable[i]->find(out, cfg, slice, pin);
			if (rc == -ECANCELED) {
				return rc;   /* stopped — not a transport fault */
			}
			if (rc == 0) {
				LOG_INF("found '%s' via %s", out->name, usable[i]->name);
				return 0;
			}
			if (rc != -ETIMEDOUT) {
				/* A radio that failed to start is worth reporting,
				 * but not worth abandoning the other transport
				 * over — keep the error and carry on. */
				LOG_WRN("%s find rc=%d", usable[i]->name, rc);
				last_err = rc;
			}
			spent += slice;
		}
		if (n == 1) {
			return last_err;     /* its one window is the whole budget */
		}
	}
}

static void run_thread(void *a, void *b, void *c)
{
	ARG_UNUSED(a); ARG_UNUSED(b); ARG_UNUSED(c);

	if (s_pin[0]) {
		LOG_INF("DFU runner: begin path=%s pinned=%s", s_path, s_pin);
	} else {
		LOG_INF("DFU runner: begin path=%s", s_path);
	}
	led_set_state(LED_STATE_DFU_RUNNING);

	/* Reload config.txt — users edit + re-upload it while the device
	 * is running, and we want those changes to apply without a
	 * power-cycle. Cheap (<1 KB read + a few strcmps).
	 */
	app_config_load();
	const struct app_config *cfg = app_config_current();
	LOG_INF("DFU runner: cfg ble_name='%s' min_rssi=%d retries=%u",
		cfg->ble_name, cfg->min_rssi, cfg->retries);

	/* Publish over GATT from here on. A browser watching this device has no
	 * other way to tell a running transfer from a wedged one — the log
	 * stream carries the detail, but only while someone is subscribed to it,
	 * and it is far too much to read at a glance. */
	dfu_status_begin(cfg->retries);
	dfu_status_bundle(s_path);

	/* Whatever ends the run, reported to the client. Overwritten by each
	 * attempt so an exhausted retry budget reports *why* the last attempt
	 * failed rather than the tautology that there were no attempts left. */
	enum dfu_status_result status_result = DFU_STATUS_RESULT_RETRIES_EXHAUSTED;

	struct dfu_payload payload;
	char path_held[DFU_PATH_MAX + 1];
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
			status_result = DFU_STATUS_RESULT_BAD_BUNDLE;
			goto fail;
		}
		LOG_INF("DFU runner: auto-flash, mapping='%s'",
			cfg->ble_firmware_mapping);
	} else {
		rc = open_payload(s_path, &payload, path_held, sizeof(path_held),
				  err, sizeof(err));
		if (rc < 0) {
			LOG_ERR("bundle: %s (rc=%d)", err, rc);
			status_result = DFU_STATUS_RESULT_BAD_BUNDLE;
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

		if (cancelled()) {
			goto stopped;
		}

		dfu_status_attempt(attempt + 1);
		dfu_status_set_state(DFU_STATUS_SCANNING);

		struct dfu_target target;
		/* Explicit path: the file is already open, so its shape picks
		 * the transport outright. Auto path: narrow by what the
		 * mapping rules could select, which is usually still one. */
		const uint8_t kinds = bundle_open ? KIND_BIT(payload.kind)
						  : mapping_kind_mask(cfg->ble_firmware_mapping);
		if (kinds != KIND_ANY) {
			LOG_DBG("scanning for %s targets only",
				kinds == KIND_BIT(DFU_PAYLOAD_ZIP) ? "packaged" : "raw-image");
		}
		rc = find_target(&target, cfg, kinds, s_pin);
		if (rc == -ECANCELED || cancelled()) {
			goto stopped;
		}
		if (rc == -ETIMEDOUT) {
			LOG_ERR("scan timed out (no target)");
			status_result = DFU_STATUS_RESULT_NO_TARGET;
			goto fail;
		}
		if (rc < 0) {
			LOG_ERR("scan rc=%d", rc);
			status_result = DFU_STATUS_RESULT_SCAN_ERROR;
			goto fail;
		}
		dfu_status_target(target.name);

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
				status_result = DFU_STATUS_RESULT_BAD_BUNDLE;
				goto fail;
			}
			rc = open_payload(picked, &payload, path_held,
					  sizeof(path_held), err, sizeof(err));
			if (rc < 0) {
				LOG_ERR("bundle: %s (rc=%d)", err, rc);
				status_result = DFU_STATUS_RESULT_BAD_BUNDLE;
				goto fail;
			}
			dfu_status_bundle(picked);
			bundle_open = true;
		}

		/* The file and the transport have to agree about shape. A
		 * legacy package cannot go to an ElegantOTA peer and a bare
		 * image cannot go to a Legacy DFU one, and either mistake is
		 * only discovered by the target after the whole transfer. */
		if (target.tp->payload_kind != payload.kind) {
			LOG_ERR("%s takes a %s payload, but %s is a %s",
				target.tp->name,
				target.tp->payload_kind == DFU_PAYLOAD_ZIP ? "packaged" : "raw",
				path_held,
				payload.kind == DFU_PAYLOAD_ZIP ? "package" : "raw image");
			status_result = DFU_STATUS_RESULT_BAD_BUNDLE;
			target.tp->release(&target);
			goto fail;
		}

		enum dfu_result r = target.tp->run(&target, &payload, cfg);
		target.tp->release(&target);
		/* Checked before the result is interpreted: an aborted transfer
		 * reports whatever error its own path produced, and recording
		 * that as a genuine failure would be a lie about a run the
		 * operator ended on purpose. */
		if (cancelled()) {
			goto stopped;
		}

		/*
		 * A transport that can tell "took every byte" from "is running
		 * it" gets to overturn its own success here. Deliberately after
		 * release() and before the switch below, so a verify() failure
		 * takes the ordinary retry path — which is the whole point: the
		 * peer that rejected the image is sitting in DFU mode waiting
		 * for another try, and the next attempt will find it there.
		 */
		if (r == DFU_OK && target.tp->verify != NULL) {
			dfu_status_set_state(DFU_STATUS_VERIFYING);
			r = target.tp->verify(&target, cfg);
			if (cancelled()) {
				goto stopped;
			}
		}
		switch (r) {
		case DFU_OK:
			LOG_INF("DFU runner: SUCCESS");
			led_set_state(LED_STATE_DONE_OK);
			dfu_status_finish(DFU_STATUS_RESULT_OK);
			goto done;
		case DFU_BUTTONLESS_TRIGGERED:
			LOG_INF("DFU runner: buttonless triggered, rescanning");
			if (runner_sleep(K_SECONDS(2))) {
				goto stopped;
			}
			continue;    /* doesn't consume a retry */
		case DFU_CONNECT_FAILED:
			LOG_WRN("DFU runner: connect failed — short cooldown");
			status_result = dfu_status_from_dfu_result((int)r);
			attempt++;
			if (attempt < cfg->retries && cfg->retry_cooldown) {
				dfu_status_set_state(DFU_STATUS_COOLDOWN);
				if (runner_sleep(K_SECONDS(cfg->retry_cooldown))) {
					goto stopped;
				}
			}
			break;
		case DFU_TARGET_REJECTED:
			/* Not a wedge and not a lost link: the peer is awake,
			 * in DFU mode, at a known address, and the only useful
			 * thing to do is send it again. Retried on the short
			 * cooldown for that reason. */
			LOG_WRN("DFU runner: target rejected the image — retrying");
			status_result = DFU_STATUS_RESULT_TARGET_REJECTED;
			attempt++;
			if (attempt < cfg->retries && cfg->retry_cooldown) {
				dfu_status_set_state(DFU_STATUS_COOLDOWN);
				if (runner_sleep(K_SECONDS(cfg->retry_cooldown))) {
					goto stopped;
				}
			}
			break;
		default:
			LOG_WRN("DFU runner: attempt %u/%u result=%d — wedge cooldown",
				attempt + 1, cfg->retries, (int)r);
			status_result = dfu_status_from_dfu_result((int)r);
			attempt++;
			if (attempt < cfg->retries && cfg->wedge_cooldown) {
				dfu_status_set_state(DFU_STATUS_COOLDOWN);
				if (runner_sleep(K_SECONDS(cfg->wedge_cooldown))) {
					goto stopped;
				}
			}
			break;
		}
	}
	LOG_ERR("DFU runner: FAILED after %u attempts", cfg->retries);

	goto fail;

stopped:
	/* Not a failure, so no red LED and no sticky terminal state — the
	 * point of Stop is to leave a clean slate to retry from. */
	LOG_WRN("DFU runner: stopped by request after %u attempt(s)", attempt + 1);
	led_set_state(LED_STATE_IDLE);
	dfu_status_reset();
	goto done;

fail:
	led_set_state(LED_STATE_DONE_FAIL);
	dfu_status_finish(status_result);
done:
	/* One close for every exit path — auto mode can bail before a bundle
	 * was ever opened, so it has to be conditional.
	 */
	if (bundle_open && payload.kind == DFU_PAYLOAD_ZIP) firmware_zip_close();
	k_mutex_lock(&s_lock, K_FOREVER);
	s_busy = false;
	k_mutex_unlock(&s_lock);
}

int dfu_runner_start(const char *zip_path, const char *pin)
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
	snprintf(s_pin,  sizeof(s_pin),  "%s", pin ? pin : "");
	s_busy = true;

	/* The radio is ours from here. survey_start() refuses while we are
	 * busy, but a survey that began a moment *before* this call would
	 * otherwise keep sweeping across the whole transfer — on the ESP32
	 * parts that is the same radio, and a scan alongside a DFU costs the
	 * image (Trap 2: no resume). Belt and braces on purpose: the check
	 * there and the stop here close opposite halves of the same race. */
	survey_stop();
	/* Cleared here rather than at the end of run_thread: a stop that lands
	 * while the previous thread is still unwinding must not leak into the
	 * next run, and this is the point where the next run is committed to.
	 * The stale give is drained for the same reason. */
	atomic_clear(&s_cancel);
	k_sem_reset(&s_wake);
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

int dfu_runner_stop(void)
{
	k_mutex_lock(&s_lock, K_FOREVER);
	bool busy = s_busy;
	k_mutex_unlock(&s_lock);

	if (!busy) {
		/* Idle, but DONE/FAILED are sticky, so there is still something
		 * to do: clear the last run's verdict. This is what makes Stop
		 * a "reset" as well, and it means the button never has to be
		 * disabled — pressing it always leaves the same clean state. */
		dfu_status_reset();
		LOG_INF("DFU runner: stop requested while idle — status cleared");
		return -EALREADY;
	}

	atomic_set(&s_cancel, 1);
	LOG_WRN("DFU runner: stop requested");

	/* Wake a cooldown, then interrupt whichever transport is blocked. Both
	 * are best-effort; s_cancel is what actually ends the run. */
	k_sem_give(&s_wake);

	size_t n = 0;
	const struct dfu_transport *const *tps = dfu_transport_list(&n);
	for (size_t i = 0; i < n; i++) {
		if (tps[i]->abort != NULL) {
			tps[i]->abort();
		}
	}
	return 0;
}

bool dfu_runner_busy(void)
{
	k_mutex_lock(&s_lock, K_FOREVER);
	bool b = s_busy;
	k_mutex_unlock(&s_lock);
	return b;
}
