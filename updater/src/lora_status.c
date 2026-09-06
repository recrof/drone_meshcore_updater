/*
 * See lora_status.h for the rate policy and why nothing here transmits.
 *
 * SPDX-License-Identifier: BSD-3-Clause
 */

#include "lora_status.h"
#include "lora_tx.h"
#include "meshcore_grp.h"
#include "config.h"

#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>
#include <stdio.h>
#include <string.h>

LOG_MODULE_REGISTER(lora_status, LOG_LEVEL_INF);

/* Long enough for a repeater's advertised name; deliberately shorter than
 * DFU_STATUS_NAME_MAX (64), which is sized for an ElegantOTA identity string
 * that would not fit in a status message anyway. Each queue slot carries one. */
#define LORA_NAME_MAX 24

enum evt_kind {
	EVT_HELLO = 0,
	EVT_TARGET,
	EVT_PROGRESS,
	EVT_VERIFY,
	EVT_DONE,
};

struct evt {
	uint8_t kind;
	uint8_t percent;
	uint8_t attempt;
	uint8_t retries;
	uint8_t result;
	uint32_t sent;
	uint32_t total;
	char name[LORA_NAME_MAX];
};

/* Six slots: a run produces at most target + three progress + verify + done,
 * and the thread drains far faster than a DFU generates them. */
K_MSGQ_DEFINE(s_q, sizeof(struct evt), 6, 4);

/* Run state. Only touched from the hooks, which are serialised by the fact
 * that a run is driven by one worker thread; the queue is the thread
 * boundary. */
static char s_name[LORA_NAME_MAX];
static uint8_t s_attempt;
static uint8_t s_retries;
static uint8_t s_high_pct;    /* high-water mark across the whole run */
static bool s_announced;      /* target announced once per run */
static bool s_verified;       /* VERIFYING announced once per run */
static uint32_t s_t0;

static bool enabled(uint32_t bit)
{
	const struct app_config *cfg = app_config_current();

	/* An empty channel name is the off switch: nothing is derived, nothing
	 * is queued, and the radio is never touched. */
	return cfg->lora_channel[0] != '\0' && (cfg->lora_events & bit) != 0U;
}

static void push(const struct evt *e)
{
	/* Drop the oldest rather than block or fail: these hooks run on the
	 * DFU worker and the Bluetooth RX thread, and neither may wait on a
	 * radio. A dropped progress update has already been superseded. */
	while (k_msgq_put(&s_q, e, K_NO_WAIT) == -ENOMSG) {
		struct evt discard;

		if (k_msgq_get(&s_q, &discard, K_NO_WAIT) != 0) {
			return;
		}
	}
}

void lora_status_boot(void)
{
	const struct app_config *cfg = app_config_current();
	struct evt e;

	/* Bind the radio here rather than lazily on the first message, so a
	 * missing or unready lora0 is reported at boot — in the log a person
	 * reads after a flight — instead of at the one moment there is
	 * something to say. */
	if (lora_tx_init() != 0) {
		return;
	}
	/* Said at boot, into the log a person reads after a flight, for the
	 * same reason the radio is bound here: "it never transmitted" is
	 * cheap to explain now and expensive to work out later. */
	if (cfg->lora_freq_hz == 0U) {
		LOG_WRN("lora_freq is not set — no status messages will be "
			"sent. Set it in config.txt for your own mesh.");
	}
	if (cfg->lora_channel[0] == '\0' || !cfg->lora_hello) {
		return;
	}

	memset(&e, 0, sizeof(e));
	e.kind = EVT_HELLO;
	push(&e);
}

void lora_status_begin(uint8_t retries)
{
	s_retries = retries;
	s_attempt = 0;
	s_high_pct = 0;
	s_announced = false;
	s_verified = false;
	s_name[0] = '\0';
	s_t0 = k_uptime_get_32();
}

void lora_status_attempt(uint8_t attempt)
{
	s_attempt = attempt;
}

void lora_status_target(const char *name)
{
	struct evt e;

	if (name == NULL || name[0] == '\0') {
		return;
	}
	strncpy(s_name, name, sizeof(s_name) - 1);
	s_name[sizeof(s_name) - 1] = '\0';

	if (s_announced || !enabled(LORA_EVT_TARGET)) {
		return;
	}
	s_announced = true;

	memset(&e, 0, sizeof(e));
	e.kind = EVT_TARGET;
	e.attempt = s_attempt;
	e.retries = s_retries;
	memcpy(e.name, s_name, sizeof(e.name));
	push(&e);
}

void lora_status_progress(uint8_t percent, uint32_t sent, uint32_t total)
{
	struct evt e;
	uint8_t bucket;

	if (!enabled(LORA_EVT_PROGRESS) || percent > 100U) {
		return;
	}
	/* 25/50/75 only. 100 is not a bucket: the done message carries it, and
	 * announcing both would put two transmissions back to back at the one
	 * moment the DFU is finishing its handshake. */
	bucket = (percent / 25U) * 25U;
	if (bucket == 0U || bucket > 75U || bucket <= s_high_pct) {
		return;
	}
	s_high_pct = bucket;

	memset(&e, 0, sizeof(e));
	e.kind = EVT_PROGRESS;
	e.percent = bucket;
	e.sent = sent;
	e.total = total;
	e.attempt = s_attempt;
	e.retries = s_retries;
	memcpy(e.name, s_name, sizeof(e.name));
	push(&e);
}

void lora_status_state(enum dfu_status_state state)
{
	struct evt e;

	if (state != DFU_STATUS_VERIFYING || s_verified || !enabled(LORA_EVT_VERIFY)) {
		return;
	}
	s_verified = true;

	memset(&e, 0, sizeof(e));
	e.kind = EVT_VERIFY;
	memcpy(e.name, s_name, sizeof(e.name));
	push(&e);
}

void lora_status_finish(enum dfu_status_result result)
{
	struct evt e;

	if (!enabled(LORA_EVT_DONE)) {
		return;
	}
	memset(&e, 0, sizeof(e));
	e.kind = EVT_DONE;
	e.result = (uint8_t)result;
	e.percent = s_high_pct;
	e.attempt = s_attempt;
	e.retries = s_retries;
	e.sent = k_uptime_get_32() - s_t0;
	memcpy(e.name, s_name, sizeof(e.name));
	push(&e);
}

/* ---- the TX thread ----------------------------------------------------- */

/* Short enough to stay inside one or two cipher blocks. The failure strings
 * are the ones an operator has to act on, so they say what to do next rather
 * than naming an enum: "no target" means fly closer, "auth" means a PIN is
 * missing, "rejected" means the image was wrong for the board. */
static const char *result_text(uint8_t r)
{
	switch (r) {
	case DFU_STATUS_RESULT_OK: return "ok";
	case DFU_STATUS_RESULT_NO_TARGET: return "no target";
	case DFU_STATUS_RESULT_SCAN_ERROR: return "scan error";
	case DFU_STATUS_RESULT_BAD_BUNDLE: return "bad bundle";
	case DFU_STATUS_RESULT_CONNECT_FAILED: return "connect failed";
	case DFU_STATUS_RESULT_SERVICE_MISSING: return "no DFU service";
	case DFU_STATUS_RESULT_CHAR_MISSING: return "no DFU char";
	case DFU_STATUS_RESULT_DISCONNECTED: return "link dropped";
	case DFU_STATUS_RESULT_TIMEOUT: return "timeout";
	case DFU_STATUS_RESULT_REMOTE_ERROR: return "peer error";
	case DFU_STATUS_RESULT_FS_ERROR: return "fs error";
	case DFU_STATUS_RESULT_RETRIES_EXHAUSTED: return "retries used up";
	case DFU_STATUS_RESULT_TARGET_REJECTED: return "peer rejected image";
	case DFU_STATUS_RESULT_AUTH_REQUIRED: return "needs PIN";
	case DFU_STATUS_RESULT_AUTH_FAILED: return "wrong PIN";
	default: return "failed";
	}
}

static void format(const struct evt *e, char *out, size_t cap)
{
	const char *name = (e->name[0] != '\0') ? e->name : "target";

	switch (e->kind) {
	case EVT_HELLO:
		snprintf(out, cap, "online");
		break;
	case EVT_TARGET:
		snprintf(out, cap, "found %s", name);
		break;
	case EVT_PROGRESS:
		snprintf(out, cap, "%s %u%% %uK/%uK", name, e->percent, e->sent / 1024U,
			 e->total / 1024U);
		break;
	case EVT_VERIFY:
		snprintf(out, cap, "%s verifying", name);
		break;
	case EVT_DONE:
	default:
		if (e->result == DFU_STATUS_RESULT_OK) {
			snprintf(out, cap, "%s DONE in %us", name, e->sent / 1000U);
		} else {
			/* The high-water percentage is the most useful number
			 * in a failure: it separates "never connected" from
			 * "died at 85%", which need different responses. */
			snprintf(out, cap, "%s FAILED %s at %u%% (try %u/%u)", name,
				 result_text(e->result), e->percent, e->attempt, e->retries);
		}
		break;
	}
}

static void tx_thread(void *a, void *b, void *c)
{
	uint8_t key[MESHCORE_KEY_LEN];
	char channel[APP_CONFIG_CHANNEL_MAX] = {0};
	uint8_t frame[MESHCORE_GRP_MAX_FRAME];
	struct evt e;
	char text[96];
	uint32_t last_tx;
	bool have_key = false;

	ARG_UNUSED(a); ARG_UNUSED(b); ARG_UNUSED(c);

	last_tx = 0;

	while (true) {
		const struct app_config *cfg;
		uint32_t now, gap;
		int len;

		k_msgq_get(&s_q, &e, K_FOREVER);
		cfg = app_config_current();

		/* Derive the channel key lazily, and again whenever the name
		 * changes: config.txt is re-read before every attempt, so the
		 * channel can move mid-run. sha256 is cheap but not free, and
		 * this is the only thread that needs it. */
		if (!have_key || strcmp(channel, cfg->lora_channel) != 0) {
			if (meshcore_channel_key_from_name(cfg->lora_channel, key) != 0) {
				LOG_ERR("lora_channel=\"%s\" is not a usable channel name",
					cfg->lora_channel);
				continue;
			}
			strncpy(channel, cfg->lora_channel, sizeof(channel) - 1);
			have_key = true;
			LOG_INF("channel %s, hash %02x", channel, meshcore_channel_hash(key));
		}

		/* The backstop. Enforced here rather than at the hooks so that
		 * an event is delayed instead of discarded — the queue already
		 * drops what is genuinely stale. */
		now = k_uptime_get_32();
		gap = now - last_tx;
		if (last_tx != 0U && gap < cfg->lora_min_gap_ms) {
			k_msleep(cfg->lora_min_gap_ms - gap);
		}

		format(&e, text, sizeof(text));

		/* ⚠ No RTC on this board. MeshCore treats the timestamp as
		 * "mostly an extra blob to help make packet_hash unique"
		 * (BaseChatMesh.cpp:488) and repeaters suppress duplicate
		 * hashes, so it must vary per message even when the wall clock
		 * is unknown. lora_epoch, when set, makes it a real time as
		 * well; unset, uptime alone still keeps every packet distinct.
		 */
		len = meshcore_grp_txt_encode(key, cfg->lora_epoch + (k_uptime_get_32() / 1000U),
					      cfg->lora_sender, text, cfg->lora_path_hash,
					      frame, sizeof(frame));
		if (len < 0) {
			LOG_ERR("encode: %d", len);
			continue;
		}

		LOG_INF("tx %d B: %s", len, text);
		if (lora_tx_send(frame, (size_t)len) == 0) {
			last_tx = k_uptime_get_32();
		}
	}
}

/* Priority 10 — below the Bluetooth threads and the DFU worker by a wide
 * margin. This thread blocks for a quarter of a second at a time inside
 * lora_send(); nothing that matters to the transfer may ever wait behind it.
 *
 * 3072 bytes of stack: snprintf, then software AES and HMAC-SHA256 under PSA,
 * then the LoRa driver. This project has lost four threads to stack overflow
 * already (see prj.conf's BT_RX_STACK_SIZE note), and on a board with a
 * hardware stack guard an overflow here is a reset in flight.
 */
K_THREAD_DEFINE(lora_status_tid, 3072, tx_thread, NULL, NULL, NULL, 10, 0, 0);
