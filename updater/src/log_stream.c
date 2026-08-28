/*
 * Live log streaming over BLE — a Zephyr log backend that pushes lines to a
 * subscribed GATT client as they are emitted.
 *
 * The point is watching a DFU happen. The updater holds two links at once —
 * peripheral to the browser, central to the DFU target — and that combination
 * is already proven: a browser has held its SMP link through an entire
 * transfer, and radio contention was measured and ruled out as a cause of
 * failure (see Trap 4 in CLAUDE.md).
 *
 * ---- Why not CONFIG_LOG_BACKEND_BLE -------------------------------------
 *
 * Zephyr ships one. It cannot work here, for a reason specific to this device
 * being both roles at once:
 *
 *     static void log_backend_ble_connect(struct bt_conn *conn, uint8_t err)
 *     { if (err == 0) { ble_backend_conn = conn; } }
 *
 * It latches *any* connection. Ours would be the central link to the DFU
 * target, and it would then try to notify a NUS characteristic that target
 * does not have — and its disconnect handler clears the pointer
 * unconditionally, so the target going away would also kill logging to the
 * browser. It additionally ignores the result of bt_gatt_notify_cb, so there
 * is no drop accounting.
 *
 * ---- The constraint that shapes everything else -------------------------
 *
 * CONFIG_BT_BUF_ACL_TX_COUNT=3, CONFIG_BT_CONN_TX_MAX=3. **Three TX buffers,
 * shared between both links.** The DFU stream keeps one write outstanding and
 * already treats -ENOMEM TX-buffer retries as a starvation signature worth
 * warning about.
 *
 * So this backend must never take more than it needs, and there is a feedback
 * loop waiting for anyone who gets it wrong: the DFU client logs a warning
 * when it needs >=5 TX-buffer retries, that warning becomes a log line, the
 * line consumes a TX buffer, which causes more retries. Three rules keep it
 * bounded:
 *
 *   1. **At most one notification in flight**, gated on the completion
 *      callback — the same discipline the DFU client uses. That caps this
 *      feature at 1 of the 3 buffers no matter how much is logged.
 *   2. **Never block the log thread.** Lines go into a ring buffer; when it
 *      is full they are dropped and counted, never queued behind the radio.
 *   3. **Drops are reported, not hidden** — a marker line goes out so the
 *      viewer shows a gap rather than a plausible-looking but incomplete log.
 *
 * The file backend (/lfs1/LOG.NNNN) keeps running regardless: this is a live
 * view, not the record.
 *
 * ---- Service UUIDs ------------------------------------------------------
 *   Service : 8d53dc1f-1db7-4cd3-868b-8a527460aa84   (SMP UUID +2)
 *   LOG     : da2e782b-fbce-4e01-ae9e-261174997c48   (SMP char +3)
 */

#include <zephyr/kernel.h>
#include <zephyr/init.h>
#include <zephyr/sys/ring_buffer.h>
#include <zephyr/logging/log.h>
#include <zephyr/logging/log_backend.h>
#include <zephyr/logging/log_output.h>
#include <zephyr/logging/log_ctrl.h>
#include <zephyr/bluetooth/bluetooth.h>
#include <zephyr/bluetooth/conn.h>
#include <zephyr/bluetooth/gatt.h>
#include <zephyr/bluetooth/uuid.h>
#include <stdio.h>
#include <string.h>

#include "log_stream.h"

/* Not LOG_MODULE_REGISTER: this file must not log through the backend it
 * implements. Anything it emitted while draining would re-enter the ring and
 * turn one dropped line into a stream of complaints about dropped lines. */

static struct bt_uuid_128 svc_uuid = BT_UUID_INIT_128(
	BT_UUID_128_ENCODE(0x8d53dc1f, 0x1db7, 0x4cd3, 0x868b, 0x8a527460aa84));
static struct bt_uuid_128 log_uuid = BT_UUID_INIT_128(
	BT_UUID_128_ENCODE(0xda2e782b, 0xfbce, 0x4e01, 0xae9e, 0x261174997c48));

/* Sized to hold a burst of DFU progress lines across one connection interval.
 * Bigger would only defer drops that the radio cannot clear anyway. */
#define LOG_STREAM_RING_SIZE 2048
/* One notification payload. ATT_MTU-3 at the negotiated 247 leaves 244. */
#define LOG_STREAM_LINE_MAX 244

RING_BUF_DECLARE(tx_ring, LOG_STREAM_RING_SIZE);
static uint8_t line_buf[LOG_STREAM_LINE_MAX];

static const struct bt_gatt_attr *log_attr;
static struct bt_conn *peer;            /* the peripheral link, not the target */
static atomic_t subscribed = ATOMIC_INIT(0);
static atomic_t in_flight = ATOMIC_INIT(0);
static atomic_t dropped_bytes = ATOMIC_INIT(0);

static void drain_fn(struct k_work *work);
static K_WORK_DELAYABLE_DEFINE(drain_work, drain_fn);

/* --- GATT ------------------------------------------------------------- */

static void on_ccc(const struct bt_gatt_attr *attr, uint16_t value)
{
	const bool on = (value == BT_GATT_CCC_NOTIFY);

	if (on == (atomic_get(&subscribed) != 0)) {
		return;
	}
	atomic_set(&subscribed, on ? 1 : 0);

	if (on) {
		/* Start from empty: replaying whatever happened to be buffered
		 * before anyone was listening is confusing, not helpful. */
		ring_buf_reset(&tx_ring);
		atomic_set(&dropped_bytes, 0);
		log_backend_enable(log_stream_backend_get(), NULL, LOG_LEVEL_INF);
	} else {
		log_backend_disable(log_stream_backend_get());
		ring_buf_reset(&tx_ring);
	}
}

BT_GATT_SERVICE_DEFINE(log_stream_svc,
	BT_GATT_PRIMARY_SERVICE(&svc_uuid),
	BT_GATT_CHARACTERISTIC(&log_uuid.uuid,
			       BT_GATT_CHRC_NOTIFY,
			       BT_GATT_PERM_NONE, NULL, NULL, NULL),
	BT_GATT_CCC(on_ccc, BT_GATT_PERM_READ | BT_GATT_PERM_WRITE),
);

/* [0] service, [1] char decl, [2] char value — what notify targets. */
#define LOG_VALUE_ATTR_IDX 2

/* --- connection tracking ----------------------------------------------- */

/* Only the peripheral link may receive log notifications. Latching whichever
 * connection happened last is the exact bug that makes the stock backend
 * unusable here. */
static void on_connected(struct bt_conn *conn, uint8_t err)
{
	struct bt_conn_info info;

	if (err || bt_conn_get_info(conn, &info) != 0) {
		return;
	}
	if (info.role == BT_CONN_ROLE_PERIPHERAL && peer == NULL) {
		peer = conn;
	}
}

static void on_disconnected(struct bt_conn *conn, uint8_t reason)
{
	ARG_UNUSED(reason);
	if (conn != peer) {
		return;                 /* the DFU target going away is normal */
	}
	peer = NULL;
	atomic_set(&subscribed, 0);
	atomic_set(&in_flight, 0);
	log_backend_disable(log_stream_backend_get());
	ring_buf_reset(&tx_ring);
}

static struct bt_conn_cb conn_cbs = {
	.connected = on_connected,
	.disconnected = on_disconnected,
};

/* --- draining ----------------------------------------------------------- */

static void sent_cb(struct bt_conn *conn, void *user_data)
{
	ARG_UNUSED(conn);
	ARG_UNUSED(user_data);
	atomic_set(&in_flight, 0);
	k_work_schedule(&drain_work, K_NO_WAIT);
}

static void drain_fn(struct k_work *work)
{
	ARG_UNUSED(work);

	if (!atomic_get(&subscribed) || peer == NULL) {
		return;
	}
	if (atomic_cas(&in_flight, 0, 1) == false) {
		return;                 /* one at a time — see rule 1 above */
	}

	/* Report a gap before the lines that follow it, so the viewer never
	 * shows a plausible-looking log that is quietly missing the middle. */
	uint32_t lost = atomic_set(&dropped_bytes, 0);
	if (lost > 0) {
		char note[64];
		int n = snprintf(note, sizeof(note),
				 "\n--- %u bytes dropped (link too slow) ---\n",
				 (unsigned)lost);
		if (n > 0 && ring_buf_put(&tx_ring, note, MIN((size_t)n, sizeof(note))) == 0) {
			/* No room even for the marker; put the debt back. */
			atomic_add(&dropped_bytes, lost);
		}
	}

	uint16_t mtu = bt_gatt_get_mtu(peer);
	size_t cap = (mtu > 3) ? MIN((size_t)(mtu - 3), sizeof(line_buf)) : 20;
	uint32_t n = ring_buf_get(&tx_ring, line_buf, cap);
	if (n == 0) {
		atomic_set(&in_flight, 0);
		return;
	}

	struct bt_gatt_notify_params params = {
		.attr = &log_stream_svc.attrs[LOG_VALUE_ATTR_IDX],
		.data = line_buf,
		.len = (uint16_t)n,
		.func = sent_cb,
	};

	/* bt_gatt_notify_cb copies into the ACL buffer, so line_buf is free
	 * again on return; the callback only gates the next send. Called from
	 * the system workqueue it returns -ENOMEM rather than blocking, which
	 * is what keeps the DFU stream's buffers available. */
	int rc = bt_gatt_notify_cb(peer, &params);
	if (rc != 0) {
		atomic_add(&dropped_bytes, n);
		atomic_set(&in_flight, 0);
		/* Back off: the radio is busy, and this is the lower priority. */
		k_work_schedule(&drain_work, K_MSEC(20));
	}
}

/* --- log backend -------------------------------------------------------- */

static int line_out(uint8_t *data, size_t length, void *ctx)
{
	ARG_UNUSED(ctx);

	if (!atomic_get(&subscribed) || peer == NULL) {
		return length;
	}
	uint32_t put = ring_buf_put(&tx_ring, data, length);
	if (put < length) {
		atomic_add(&dropped_bytes, length - put);
	}
	k_work_schedule(&drain_work, K_NO_WAIT);
	return length;              /* never report short: log_output would spin */
}

static uint8_t out_buf[LOG_STREAM_LINE_MAX];
LOG_OUTPUT_DEFINE(log_stream_output, line_out, out_buf, sizeof(out_buf));

static uint32_t log_format = LOG_OUTPUT_TEXT;

static void process(const struct log_backend *const backend, union log_msg_generic *msg)
{
	ARG_UNUSED(backend);

	if (!atomic_get(&subscribed)) {
		return;
	}
	log_format_func_t out = log_format_func_t_get(log_format);

	out(&log_stream_output, &msg->log,
	    LOG_OUTPUT_FLAG_LEVEL | LOG_OUTPUT_FLAG_TIMESTAMP |
	    LOG_OUTPUT_FLAG_FORMAT_TIMESTAMP);
}

static int format_set(const struct log_backend *const backend, uint32_t type)
{
	ARG_UNUSED(backend);
	log_format = type;
	return 0;
}

static void panic(struct log_backend const *const backend)
{
	ARG_UNUSED(backend);
	/* A fault is exactly when a live view is least trustworthy: the radio
	 * may be gone and the workqueue will not run again. Stop rather than
	 * pretend. The file backend and the UART still have the message. */
	atomic_set(&subscribed, 0);
}

static void dropped(const struct log_backend *const backend, uint32_t cnt)
{
	ARG_UNUSED(backend);
	/* The logging core dropped messages before they reached us — count
	 * them the same way so the viewer shows one honest gap. */
	atomic_add(&dropped_bytes, cnt);
}

static const struct log_backend_api log_stream_api = {
	.process = process,
	.panic = panic,
	.dropped = dropped,
	.format_set = format_set,
};

/* autostart = false: nothing is emitted until a client subscribes, so the
 * feature costs nothing when nobody is watching. */
LOG_BACKEND_DEFINE(log_stream_backend, log_stream_api, false);

const struct log_backend *log_stream_backend_get(void)
{
	return &log_stream_backend;
}

bool log_stream_active(void)
{
	return atomic_get(&subscribed) != 0;
}

static int log_stream_setup(void)
{
	log_attr = &log_stream_svc.attrs[LOG_VALUE_ATTR_IDX];
	bt_conn_cb_register(&conn_cbs);
	return 0;
}
SYS_INIT(log_stream_setup, APPLICATION, 92);
