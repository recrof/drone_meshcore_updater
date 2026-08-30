/*
 * Live DFU progress over GATT. See dfu_status.h for the wire format and the
 * reasoning behind the design; this file is the mechanism.
 *
 * Three rules, the first two borrowed from log_stream.c because they come
 * from the same constraint (three TX buffers, shared with the DFU link):
 *
 *   1. At most one notification in flight, gated on the completion callback.
 *   2. Never block a caller. Producers touch a snapshot under a spinlock and
 *      leave; the radio work happens on the system workqueue.
 *   3. Coalesce. A progress update that is superseded before it goes out is
 *      simply dropped — unlike a log line, a stale percentage is worth
 *      nothing. This is why there is a `dirty` flag and no queue.
 *
 * Producers run on the DFU runner thread and, for the library's observer
 * callbacks, potentially on the BT RX thread. Hence a spinlock rather than a
 * mutex: it is valid from any context and the critical sections are a few
 * stores long.
 *
 * Nothing here logs. It would be logged through the backend that streams to
 * the same link this file is trying not to saturate, and a status update that
 * complains about being unable to send status updates is a feedback loop.
 */

#include <zephyr/kernel.h>
#include <zephyr/init.h>
#include <zephyr/sys/atomic.h>
#include <zephyr/bluetooth/bluetooth.h>
#include <zephyr/bluetooth/conn.h>
#include <zephyr/bluetooth/gatt.h>
#include <zephyr/bluetooth/uuid.h>
#include <string.h>

#include "dfu_status.h"
#include "dfu_client.h"

static struct bt_uuid_128 svc_uuid = BT_UUID_INIT_128(
	BT_UUID_128_ENCODE(0x8d53dc20, 0x1db7, 0x4cd3, 0x868b, 0x8a527460aa84));
static struct bt_uuid_128 status_uuid = BT_UUID_INIT_128(
	BT_UUID_128_ENCODE(0xda2e782c, 0xfbce, 0x4e01, 0xae9e, 0x261174997c48));

/* Upload progress is the only high-rate producer: a 30 s transfer crosses a
 * percentage point roughly three times a second, and every one of those would
 * otherwise be a notification competing with the DFU stream for a TX buffer.
 * State changes bypass this and go out immediately — those are the events a
 * watcher actually reacts to. */
#define STATUS_PROGRESS_MIN_MS 400

#define STATUS_MAX_LEN (DFU_STATUS_HEADER_LEN + DFU_STATUS_NAME_MAX + \
			DFU_STATUS_FILE_MAX)

static struct k_spinlock lock;

static struct {
	uint8_t  state;
	uint8_t  percent;
	uint8_t  result;
	uint8_t  attempt;
	uint8_t  retries;
	uint8_t  name_len;
	uint8_t  file_len;
	char     name[DFU_STATUS_NAME_MAX];
	char     file[DFU_STATUS_FILE_MAX];
	uint32_t sent;
	uint32_t total;
	uint32_t t0;          /* uptime at dfu_status_begin() */
	uint32_t frozen_ms;   /* elapsed at dfu_status_finish() */
	bool     running;
} snap = {
	.state = DFU_STATUS_IDLE,
	.result = DFU_STATUS_RESULT_NONE,
};

static struct bt_conn *peer;            /* peripheral link only, never the target */
static atomic_t subscribed = ATOMIC_INIT(0);
static atomic_t in_flight = ATOMIC_INIT(0);
static atomic_t dirty = ATOMIC_INIT(0);

static void push_fn(struct k_work *work);
static K_WORK_DELAYABLE_DEFINE(push_work, push_fn);

/* --- snapshot -> wire --------------------------------------------------- */

static void put_le32(uint8_t *p, uint32_t v)
{
	p[0] = (uint8_t)v;
	p[1] = (uint8_t)(v >> 8);
	p[2] = (uint8_t)(v >> 16);
	p[3] = (uint8_t)(v >> 24);
}

static uint16_t encode(uint8_t *out)
{
	k_spinlock_key_t key = k_spin_lock(&lock);

	uint32_t elapsed = snap.running ? (k_uptime_get_32() - snap.t0)
					: snap.frozen_ms;

	out[0] = DFU_STATUS_PAYLOAD_VERSION;
	out[1] = snap.state;
	out[2] = snap.percent;
	out[3] = snap.result;
	out[4] = snap.attempt;
	out[5] = snap.retries;
	out[6] = snap.file_len;
	out[7] = snap.name_len;
	put_le32(&out[8], snap.sent);
	put_le32(&out[12], snap.total);
	put_le32(&out[16], elapsed);
	memcpy(&out[DFU_STATUS_HEADER_LEN], snap.name, snap.name_len);
	memcpy(&out[DFU_STATUS_HEADER_LEN + snap.name_len], snap.file, snap.file_len);

	uint16_t len = DFU_STATUS_HEADER_LEN + snap.name_len + snap.file_len;

	k_spin_unlock(&lock, key);
	return len;
}

/* `now` distinguishes a state change (send it) from a progress tick (batch
 * it). k_work_schedule is a no-op when the work is already scheduled, which
 * is exactly the throttle wanted: the first tick after a quiet period sets
 * the deadline and every tick until then just updates the snapshot. */
static void mark_dirty(bool now)
{
	atomic_set(&dirty, 1);
	if (!atomic_get(&subscribed)) {
		return;
	}
	if (now) {
		k_work_reschedule(&push_work, K_NO_WAIT);
	} else {
		k_work_schedule(&push_work, K_MSEC(STATUS_PROGRESS_MIN_MS));
	}
}

/* --- GATT --------------------------------------------------------------- */

static ssize_t read_status(struct bt_conn *conn, const struct bt_gatt_attr *attr,
			   void *buf, uint16_t len, uint16_t offset)
{
	ARG_UNUSED(conn);
	ARG_UNUSED(attr);

	/* Readable, not only notified: a browser that connects mid-transfer
	 * would otherwise show nothing until the next change, which during an
	 * upload can be most of a minute. */
	uint8_t payload[STATUS_MAX_LEN];
	uint16_t n = encode(payload);

	return bt_gatt_attr_read(conn, attr, buf, len, offset, payload, n);
}

static void on_ccc(const struct bt_gatt_attr *attr, uint16_t value)
{
	ARG_UNUSED(attr);
	const bool on = (value == BT_GATT_CCC_NOTIFY);

	atomic_set(&subscribed, on ? 1 : 0);
	if (on) {
		/* Send the current state straight away rather than leaving the
		 * subscriber to guess until something changes. */
		mark_dirty(true);
	}
}

BT_GATT_SERVICE_DEFINE(dfu_status_svc,
	BT_GATT_PRIMARY_SERVICE(&svc_uuid),
	BT_GATT_CHARACTERISTIC(&status_uuid.uuid,
			       BT_GATT_CHRC_READ | BT_GATT_CHRC_NOTIFY,
			       BT_GATT_PERM_READ, read_status, NULL, NULL),
	BT_GATT_CCC(on_ccc, BT_GATT_PERM_READ | BT_GATT_PERM_WRITE),
);

/* [0] service, [1] char decl, [2] char value — what notify targets. */
#define STATUS_VALUE_ATTR_IDX 2

/* --- connection tracking ------------------------------------------------ */

static void on_connected(struct bt_conn *conn, uint8_t err)
{
	struct bt_conn_info info;

	if (err || bt_conn_get_info(conn, &info) != 0) {
		return;
	}
	/* Peripheral only. Latching whichever connection happened last would
	 * pick up the DFU target — the bug that makes Zephyr's stock BLE log
	 * backend unusable on this device (see log_stream.c). */
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
}

static struct bt_conn_cb conn_cbs = {
	.connected = on_connected,
	.disconnected = on_disconnected,
};

/* --- sending ------------------------------------------------------------ */

static uint8_t tx_buf[STATUS_MAX_LEN];

static void sent_cb(struct bt_conn *conn, void *user_data)
{
	ARG_UNUSED(conn);
	ARG_UNUSED(user_data);
	atomic_set(&in_flight, 0);
	/* Anything that changed while that one was on the wire goes now. */
	if (atomic_get(&dirty)) {
		k_work_schedule(&push_work, K_NO_WAIT);
	}
}

static void push_fn(struct k_work *work)
{
	ARG_UNUSED(work);

	if (!atomic_get(&subscribed) || peer == NULL) {
		return;
	}
	if (!atomic_get(&dirty)) {
		return;
	}
	if (atomic_cas(&in_flight, 0, 1) == false) {
		return;                 /* sent_cb will come back for it */
	}
	atomic_set(&dirty, 0);

	uint16_t n = encode(tx_buf);

	struct bt_gatt_notify_params params = {
		.attr = &dfu_status_svc.attrs[STATUS_VALUE_ATTR_IDX],
		.data = tx_buf,
		.len = n,
		.func = sent_cb,
	};

	/* From the system workqueue this returns -ENOMEM rather than blocking
	 * when the three shared TX buffers are all spoken for, which is the
	 * behaviour wanted: the DFU stream outranks a progress update. */
	if (bt_gatt_notify_cb(peer, &params) != 0) {
		atomic_set(&dirty, 1);
		atomic_set(&in_flight, 0);
		k_work_schedule(&push_work, K_MSEC(20));
	}
}

/* --- producer API ------------------------------------------------------- */

void dfu_status_begin(uint8_t retries)
{
	k_spinlock_key_t key = k_spin_lock(&lock);
	snap.state = DFU_STATUS_SCANNING;
	snap.percent = 0;
	snap.result = DFU_STATUS_RESULT_NONE;
	snap.attempt = 0;
	snap.retries = retries;
	snap.name_len = 0;
	snap.file_len = 0;
	snap.sent = 0;
	snap.total = 0;
	snap.t0 = k_uptime_get_32();
	snap.frozen_ms = 0;
	snap.running = true;
	k_spin_unlock(&lock, key);

	mark_dirty(true);
}

void dfu_status_bundle(const char *path)
{
	/* Basename: everything this device flashes lives in /lfs1, so the
	 * directory is noise in a record whose whole virtue is being small. */
	const char *base = "";
	if (path != NULL) {
		const char *slash = strrchr(path, '/');
		base = slash ? slash + 1 : path;
	}
	size_t n = strnlen(base, DFU_STATUS_FILE_MAX);

	k_spinlock_key_t key = k_spin_lock(&lock);
	memcpy(snap.file, base, n);
	snap.file_len = (uint8_t)n;
	k_spin_unlock(&lock, key);

	mark_dirty(true);
}

void dfu_status_attempt(uint8_t attempt)
{
	k_spinlock_key_t key = k_spin_lock(&lock);
	snap.attempt = attempt;
	/* Each attempt streams the whole image again — Legacy DFU cannot
	 * resume (Trap 2), so carrying the previous attempt's byte count
	 * forward would misreport the transfer as further along than it is. */
	snap.percent = 0;
	snap.sent = 0;
	k_spin_unlock(&lock, key);

	mark_dirty(true);
}

void dfu_status_set_state(enum dfu_status_state state)
{
	k_spinlock_key_t key = k_spin_lock(&lock);
	bool changed = (snap.state != (uint8_t)state);
	snap.state = (uint8_t)state;
	k_spin_unlock(&lock, key);

	if (changed) {
		mark_dirty(true);
	}
}

void dfu_status_target(const char *name)
{
	k_spinlock_key_t key = k_spin_lock(&lock);
	size_t n = 0;
	if (name != NULL) {
		n = strnlen(name, DFU_STATUS_NAME_MAX);
	}
	memcpy(snap.name, name ? name : "", n);
	snap.name_len = (uint8_t)n;
	k_spin_unlock(&lock, key);

	mark_dirty(true);
}

void dfu_status_progress(uint8_t percent, uint32_t sent, uint32_t total)
{
	k_spinlock_key_t key = k_spin_lock(&lock);
	snap.percent = percent;
	snap.sent = sent;
	snap.total = total;
	k_spin_unlock(&lock, key);

	mark_dirty(false);
}

void dfu_status_finish(enum dfu_status_result result)
{
	k_spinlock_key_t key = k_spin_lock(&lock);
	snap.result = (uint8_t)result;
	snap.state = (result == DFU_STATUS_RESULT_OK) ? DFU_STATUS_DONE
						      : DFU_STATUS_FAILED;
	snap.frozen_ms = k_uptime_get_32() - snap.t0;
	snap.running = false;
	k_spin_unlock(&lock, key);

	mark_dirty(true);
}

void dfu_status_reset(void)
{
	k_spinlock_key_t key = k_spin_lock(&lock);
	snap.state = DFU_STATUS_IDLE;
	snap.result = DFU_STATUS_RESULT_NONE;
	snap.percent = 0;
	snap.attempt = 0;
	snap.retries = 0;
	snap.name_len = 0;
	snap.file_len = 0;
	snap.sent = 0;
	snap.total = 0;
	snap.t0 = k_uptime_get_32();
	snap.frozen_ms = 0;
	snap.running = false;
	k_spin_unlock(&lock, key);

	mark_dirty(true);
}

enum dfu_status_result dfu_status_from_dfu_result(int dfu_result)
{
	switch (dfu_result) {
	case DFU_OK:                   return DFU_STATUS_RESULT_OK;
	case DFU_CONNECT_FAILED:       return DFU_STATUS_RESULT_CONNECT_FAILED;
	case DFU_SERVICE_MISSING:      return DFU_STATUS_RESULT_SERVICE_MISSING;
	case DFU_CHAR_MISSING:         return DFU_STATUS_RESULT_CHAR_MISSING;
	case DFU_DISCONNECTED_EARLY:   return DFU_STATUS_RESULT_DISCONNECTED;
	case DFU_TIMEOUT:              return DFU_STATUS_RESULT_TIMEOUT;
	case DFU_REMOTE_ERROR:         return DFU_STATUS_RESULT_REMOTE_ERROR;
	case DFU_FS_ERROR:             return DFU_STATUS_RESULT_FS_ERROR;
	case DFU_TARGET_REJECTED:      return DFU_STATUS_RESULT_TARGET_REJECTED;
	/* DFU_BUTTONLESS_TRIGGERED is not terminal — the runner rescans — so
	 * it never reaches here. Anything unexpected is a remote error rather
	 * than a silent success. */
	default:                       return DFU_STATUS_RESULT_REMOTE_ERROR;
	}
}

static int dfu_status_setup(void)
{
	bt_conn_cb_register(&conn_cbs);
	return 0;
}
SYS_INIT(dfu_status_setup, APPLICATION, 92);
