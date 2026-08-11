/*
 * fsx_stream — dedicated GATT service for fast file uploads.
 *
 * Runs alongside SMP. SMP still handles browse / delete / mkdir / rename /
 * download / DFU-of-the-updater-itself; only *large uploads* route through
 * here. The point is to beat SMP's throughput ceiling by:
 *
 *   1. Removing per-chunk request/response round-trips. Data bytes stream
 *      one-way on a write-without-response characteristic; BLE LL already
 *      guarantees in-order delivery, so we don't need an ACK per chunk.
 *   2. Removing CBOR + SMP framing overhead. Raw bytes on the DATA char;
 *      the CTRL char carries a tiny binary framing for session control only.
 *   3. Removing fs_mgmt's serializing semaphore. Only one upload session
 *      at a time is allowed (per-connection), but within that session
 *      writes are asynchronously appended without waiting for per-write
 *      confirmation.
 *
 * ---- Wire protocol ------------------------------------------------------
 *
 *   Client → server on CTRL (write-with-response):
 *     [0x01] START  <name_len:u8> <name:name_len bytes> <total:u32-le>
 *     [0x02] FINISH
 *     [0x03] ABORT
 *
 *   Server → client on CTRL (notification):
 *     [0x81] READY  <rc:u8> <max_data_bytes_per_write:u16-le> <ack_interval:u32-le>
 *                   `ack_interval` is the number of bytes after which the
 *                   server will emit an OP_ACK. Clients use this to bound
 *                   how far ahead they may stream before waiting for an
 *                   ACK — Chrome's writeValueWithoutResponse silently
 *                   drops writes when its platform queue overflows, so
 *                   flow control has to happen at the app layer.
 *     [0x83] ACK    <bytes_received:u32-le>
 *     [0x82] DONE   <rc:u8> <bytes_written:u32-le>
 *     [0x8F] ERROR  <rc:u8>
 *
 *   Client → server on DATA (write-without-response):
 *     raw bytes. Client MUST write consecutive file bytes; the server
 *     appends them in receive order without offset tracking.
 *     A single ATT Write Command carries at most (ATT_MTU - 3) bytes;
 *     the client learns that limit via the READY payload.
 *
 * ---- Service UUIDs ------------------------------------------------------
 *   Service : 8d53dc1e-1db7-4cd3-868b-8a527460aa84   (SMP UUID +1)
 *   CTRL    : da2e7829-fbce-4e01-ae9e-261174997c48   (SMP char +1)
 *   DATA    : da2e782a-fbce-4e01-ae9e-261174997c48   (SMP char +2)
 */

#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>
#include <zephyr/bluetooth/bluetooth.h>
#include <zephyr/bluetooth/conn.h>
#include <zephyr/bluetooth/gatt.h>
#include <zephyr/bluetooth/uuid.h>
#include <zephyr/fs/fs.h>
#include <string.h>

#include "app.h"

LOG_MODULE_REGISTER(fsx_stream, LOG_LEVEL_INF);

/* UUIDs (LE byte order for the 128-bit form).
 * 8d53dc1e-1db7-4cd3-868b-8a527460aa84 → last 4 bytes flipped for endianness.
 */
static struct bt_uuid_128 svc_uuid = BT_UUID_INIT_128(
	0x84, 0xaa, 0x60, 0x74, 0x52, 0x8a, 0x8b, 0x86,
	0xd3, 0x4c, 0xb7, 0x1d, 0x1e, 0xdc, 0x53, 0x8d);
static struct bt_uuid_128 ctrl_uuid = BT_UUID_INIT_128(
	0x48, 0x7c, 0x99, 0x74, 0x11, 0x26, 0x9e, 0xae,
	0x01, 0x4e, 0xce, 0xfb, 0x29, 0x78, 0x2e, 0xda);
static struct bt_uuid_128 data_uuid = BT_UUID_INIT_128(
	0x48, 0x7c, 0x99, 0x74, 0x11, 0x26, 0x9e, 0xae,
	0x01, 0x4e, 0xce, 0xfb, 0x2a, 0x78, 0x2e, 0xda);

/* CTRL opcodes. */
#define OP_START     0x01
#define OP_FINISH    0x02
#define OP_ABORT     0x03
#define OP_READY     0x81
#define OP_DONE      0x82
#define OP_ACK       0x83
#define OP_ERROR     0x8F

/* Emit an OP_ACK on CTRL every ACK_INTERVAL bytes received. The client
 * MUST NOT stream more than ~2× this ahead of the last-ACKed offset,
 * or Chrome's platform Bluetooth queue overflows and silently drops
 * writes (observed: a 2.2 MB upload delivered only 28 KB to the peer
 * before the client thought it was done). 4096 = 4 KB gives roughly one
 * ACK per BLE connection event at typical MTUs; small enough to keep
 * latency low, large enough not to be its own throughput sink.
 */
#define ACK_INTERVAL 4096

/* Status codes returned in READY/DONE/ERROR frames. */
#define RC_OK             0
#define RC_BUSY           1   /* another session already active */
#define RC_INVALID        2   /* malformed frame or bad path */
#define RC_OPEN_FAILED    3
#define RC_WRITE_FAILED   4
#define RC_NO_SESSION     5   /* FINISH / DATA without a prior START */

#define FSX_STREAM_PATH_MAX 128

/* One active session per BLE connection. Serialized (only one at a time)
 * because LittleFS + fs_write in Zephyr aren't safe for concurrent writers
 * to the same file, and we want a single monotonic file position anyway.
 */
static struct {
	struct k_mutex   lock;
	bool             active;
	struct bt_conn  *conn;
	struct fs_file_t file;
	char             path[FSX_STREAM_PATH_MAX + 1];
	uint32_t         expected;
	uint32_t         written;
	uint32_t         next_ack_at;    /* emit OP_ACK once `written` >= this */
} s_sess;

static ssize_t on_ctrl_write(struct bt_conn *conn, const struct bt_gatt_attr *attr,
			     const void *buf, uint16_t len, uint16_t offset, uint8_t flags);
static ssize_t on_data_write(struct bt_conn *conn, const struct bt_gatt_attr *attr,
			     const void *buf, uint16_t len, uint16_t offset, uint8_t flags);
static void    on_ctrl_ccc(const struct bt_gatt_attr *attr, uint16_t value);

/* Forward decl for the attribute the CTRL notifier points at. Populated
 * inside BT_GATT_SERVICE_DEFINE below. We store its index (2 = the char
 * value attribute) so bt_gatt_notify() can reference it later.
 */
static const struct bt_gatt_attr *ctrl_notify_attr;

BT_GATT_SERVICE_DEFINE(fsx_stream_svc,
	BT_GATT_PRIMARY_SERVICE(&svc_uuid),

	/* CTRL: write (with response) + notify. Notify used for READY / DONE
	 * / ERROR replies. Write path handles START / FINISH / ABORT.
	 */
	BT_GATT_CHARACTERISTIC(&ctrl_uuid.uuid,
			       BT_GATT_CHRC_WRITE | BT_GATT_CHRC_NOTIFY,
			       BT_GATT_PERM_WRITE,
			       NULL, on_ctrl_write, NULL),
	BT_GATT_CCC(on_ctrl_ccc, BT_GATT_PERM_READ | BT_GATT_PERM_WRITE),

	/* DATA: write-without-response only. Every ATT WriteCmd payload is
	 * appended verbatim to the current session's file. No response, no
	 * per-chunk framing.
	 */
	BT_GATT_CHARACTERISTIC(&data_uuid.uuid,
			       BT_GATT_CHRC_WRITE_WITHOUT_RESP,
			       BT_GATT_PERM_WRITE,
			       NULL, on_data_write, NULL),
);

/* Attribute index inside the service:
 *   [0] primary service decl
 *   [1] CTRL characteristic declaration
 *   [2] CTRL char VALUE (what notify targets)
 *   [3] CTRL CCC
 *   [4] DATA characteristic declaration
 *   [5] DATA char VALUE
 */
#define CTRL_VALUE_ATTR_IDX 2

static int fsx_stream_setup(void)
{
	k_mutex_init(&s_sess.lock);
	ctrl_notify_attr = &fsx_stream_svc.attrs[CTRL_VALUE_ATTR_IDX];
	LOG_INF("fsx_stream service registered (2 chars: CTRL + DATA)");
	return 0;
}
SYS_INIT(fsx_stream_setup, APPLICATION, 91);

/* ---- session lifecycle ------------------------------------------------- */
static void session_close(int rc)
{
	if (!s_sess.active) return;
	fs_close(&s_sess.file);
	if (rc != RC_OK) {
		/* Partially-written file → remove it so a retry can succeed
		 * without hitting a stale-size check on the next START.
		 */
		fs_unlink(s_sess.path);
	}
	s_sess.active   = false;
	s_sess.conn     = NULL;
	s_sess.written  = 0;
	s_sess.expected = 0;
	memset(s_sess.path, 0, sizeof(s_sess.path));
}

static void notify_reply(struct bt_conn *conn, const uint8_t *payload, uint16_t len)
{
	if (!conn || !ctrl_notify_attr) return;
	int rc = bt_gatt_notify(conn, ctrl_notify_attr, payload, len);
	if (rc < 0) {
		LOG_WRN("notify rc=%d", rc);
	}
}

static void reply_ready(struct bt_conn *conn, uint8_t rc, uint16_t max_data,
			uint32_t ack_interval)
{
	uint8_t f[8] = {
		OP_READY, rc,
		(uint8_t)(max_data),         (uint8_t)(max_data >> 8),
		(uint8_t)(ack_interval),     (uint8_t)(ack_interval >> 8),
		(uint8_t)(ack_interval >> 16), (uint8_t)(ack_interval >> 24),
	};
	notify_reply(conn, f, sizeof(f));
}
static void reply_ack(struct bt_conn *conn, uint32_t received)
{
	uint8_t f[5] = { OP_ACK,
			 (uint8_t)(received),         (uint8_t)(received >> 8),
			 (uint8_t)(received >> 16),   (uint8_t)(received >> 24) };
	notify_reply(conn, f, sizeof(f));
}
static void reply_done(struct bt_conn *conn, uint8_t rc, uint32_t written)
{
	uint8_t f[6] = { OP_DONE, rc,
			 (uint8_t)(written),        (uint8_t)(written >> 8),
			 (uint8_t)(written >> 16),  (uint8_t)(written >> 24) };
	notify_reply(conn, f, sizeof(f));
}
static void reply_error(struct bt_conn *conn, uint8_t rc)
{
	uint8_t f[2] = { OP_ERROR, rc };
	notify_reply(conn, f, sizeof(f));
}

/* ---- CTRL handler ------------------------------------------------------ */
static ssize_t on_ctrl_write(struct bt_conn *conn, const struct bt_gatt_attr *attr,
			     const void *buf, uint16_t len, uint16_t offset, uint8_t flags)
{
	ARG_UNUSED(attr); ARG_UNUSED(offset); ARG_UNUSED(flags);
	const uint8_t *p = buf;
	if (len < 1) return BT_GATT_ERR(BT_ATT_ERR_INVALID_ATTRIBUTE_LEN);

	k_mutex_lock(&s_sess.lock, K_FOREVER);

	uint8_t op = p[0];
	switch (op) {
	case OP_START: {
		if (s_sess.active) {
			reply_error(conn, RC_BUSY);
			LOG_WRN("start rejected: session already active");
			break;
		}
		/* [op][name_len][name...][total:u32-le] */
		if (len < 2) { reply_error(conn, RC_INVALID); break; }
		uint8_t name_len = p[1];
		if (name_len == 0 || name_len > FSX_STREAM_PATH_MAX) {
			reply_error(conn, RC_INVALID); break;
		}
		if (len < (uint16_t)(2 + name_len + 4)) {
			reply_error(conn, RC_INVALID); break;
		}
		memcpy(s_sess.path, &p[2], name_len);
		s_sess.path[name_len] = '\0';
		const uint8_t *sp = &p[2 + name_len];
		s_sess.expected = (uint32_t)sp[0] | ((uint32_t)sp[1] << 8)
				| ((uint32_t)sp[2] << 16) | ((uint32_t)sp[3] << 24);

		fs_file_t_init(&s_sess.file);
		int rc = fs_open(&s_sess.file, s_sess.path,
				 FS_O_CREATE | FS_O_WRITE | FS_O_TRUNC);
		if (rc < 0) {
			LOG_ERR("open %s rc=%d", s_sess.path, rc);
			reply_error(conn, RC_OPEN_FAILED);
			break;
		}
		s_sess.written      = 0;
		s_sess.next_ack_at  = ACK_INTERVAL;
		s_sess.conn         = conn;
		s_sess.active       = true;

		/* Advertise the connection's actual ATT payload capacity so
		 * the client can pick the biggest write it can send in one
		 * ATT WriteCmd — this is the single biggest throughput lever
		 * on the client side. bt_gatt_get_mtu() returns the current
		 * negotiated MTU; ATT payload = MTU - 3.
		 */
		uint16_t mtu = bt_gatt_get_mtu(conn);
		uint16_t max_data = mtu > 3 ? (uint16_t)(mtu - 3) : 20;

		reply_ready(conn, RC_OK, max_data, ACK_INTERVAL);
		LOG_INF("stream start: %s (%u B, mtu=%u → max_write=%u, ack_interval=%u)",
			s_sess.path, s_sess.expected, mtu, max_data, ACK_INTERVAL);
		break;
	}
	case OP_FINISH: {
		if (!s_sess.active) { reply_error(conn, RC_NO_SESSION); break; }
		uint32_t written = s_sess.written;
		char path_copy[FSX_STREAM_PATH_MAX + 1];
		strncpy(path_copy, s_sess.path, sizeof(path_copy) - 1);
		path_copy[sizeof(path_copy) - 1] = '\0';
		session_close(RC_OK);
		reply_done(conn, RC_OK, written);
		LOG_INF("stream finish: %s (%u B)", path_copy, written);
		/* Same DFU-arm hook as the SMP upload path — a completed .zip
		 * anywhere under /lfs1/ triggers the state machine.
		 */
		arm_dfu_from_upload(path_copy);
		break;
	}
	case OP_ABORT:
		LOG_INF("stream abort");
		session_close(RC_OK);   /* RC_OK avoids the auto-unlink */
		break;
	default:
		reply_error(conn, RC_INVALID);
		LOG_WRN("unknown ctrl opcode 0x%02x", op);
		break;
	}

	k_mutex_unlock(&s_sess.lock);
	return len;
}

/* ---- DATA handler ------------------------------------------------------ */
static ssize_t on_data_write(struct bt_conn *conn, const struct bt_gatt_attr *attr,
			     const void *buf, uint16_t len, uint16_t offset, uint8_t flags)
{
	ARG_UNUSED(attr); ARG_UNUSED(offset); ARG_UNUSED(flags);

	/* Reject cross-connection data — the session belongs to one client. */
	if (!s_sess.active || s_sess.conn != conn) {
		reply_error(conn, RC_NO_SESSION);
		return len;
	}

	/* fs_write in Zephyr's LittleFS backend is thread-safe under the
	 * internal per-mount lock, but *this* handler runs on the BT-RX
	 * thread and would race with a concurrent CTRL FINISH on the mcumgr
	 * thread if we didn't take our own session mutex.
	 */
	k_mutex_lock(&s_sess.lock, K_FOREVER);

	int rc = fs_write(&s_sess.file, buf, len);
	if (rc < 0) {
		LOG_ERR("fs_write off=%u len=%u rc=%d", s_sess.written, len, rc);
		session_close(RC_WRITE_FAILED);
		reply_error(conn, RC_WRITE_FAILED);
	} else {
		s_sess.written += (uint32_t)rc;
		/* Emit an ACK notification every ACK_INTERVAL bytes so the
		 * client can drain its send window and Chrome's platform BT
		 * queue doesn't back up and start dropping writes. Check-and-
		 * bump keeps a single ACK per interval crossing even if a
		 * write straddles the boundary.
		 */
		if (s_sess.written >= s_sess.next_ack_at) {
			reply_ack(conn, s_sess.written);
			s_sess.next_ack_at = s_sess.written + ACK_INTERVAL;
		}
	}

	k_mutex_unlock(&s_sess.lock);
	return len;
}

/* ---- CCC notification-enable hook (informational) --------------------- */
static void on_ctrl_ccc(const struct bt_gatt_attr *attr, uint16_t value)
{
	ARG_UNUSED(attr);
	LOG_DBG("ctrl CCC = 0x%04x", value);
}

/* ---- disconnect cleanup ---------------------------------------------- */
/* If the peer that owns the active session drops the link mid-upload,
 * close + unlink the partial file so the next attempt starts clean.
 * Zephyr allows multiple BT_CONN_CB_DEFINE()s — this one lives here so
 * fsx_stream is self-contained; main.c has its own copy for logging.
 */
static void on_disconnected(struct bt_conn *conn, uint8_t reason)
{
	k_mutex_lock(&s_sess.lock, K_FOREVER);
	if (s_sess.active && s_sess.conn == conn) {
		LOG_WRN("peer disconnected mid-stream (reason=0x%02x, %u/%u B) — discarding",
			reason, s_sess.written, s_sess.expected);
		session_close(RC_WRITE_FAILED);  /* triggers unlink */
	}
	k_mutex_unlock(&s_sess.lock);
}

BT_CONN_CB_DEFINE(fsx_stream_conn_cb) = {
	.disconnected = on_disconnected,
};
