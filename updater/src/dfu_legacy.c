/*
 * Nordic Legacy DFU client — Zephyr side. See dfu_legacy.h for the
 * public contract and per-phase roadmap.
 *
 * This file grows in-place across phases 4a → 4d. Right now (4a) only
 * connect + service/characteristic discovery are implemented; the
 * dfu_legacy_run() function reports what it found and returns without
 * actually flashing.
 *
 * ---- Zephyr central primer (for anyone porting from Bluefruit) ------
 *
 *   Bluefruit's BLEClientService/BLEClientCharacteristic gave you a
 *   synchronous "discover()" call and blocking write_resp(). Zephyr's
 *   bt_gatt_discover is *asynchronous*: you fill in a struct,
 *   bt_gatt_discover() returns immediately, and results arrive via a
 *   callback. To chain "find service → find ctrl char → find packet
 *   char → find version char" you either recurse from the callback or
 *   drive it as a state machine.
 *
 *   We use a small state machine + a k_sem to convert the async flow
 *   back into synchronous-looking code that dfu_legacy_run() can wait
 *   on. Same pattern will extend into 4b/4c/4d for start/stream/finish.
 */

#include "dfu_legacy.h"

#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>
#include <zephyr/bluetooth/bluetooth.h>
#include <zephyr/bluetooth/conn.h>
#include <zephyr/bluetooth/gatt.h>
#include <zephyr/bluetooth/uuid.h>
#include <string.h>

LOG_MODULE_REGISTER(dfu_legacy, LOG_LEVEL_INF);

/* ---- Nordic Legacy DFU opcodes (mirrors LegacyDfuImpl.java) --------- */
#define OP_START_DFU              0x01
#define OP_INIT_DFU_PARAMS        0x02
#define OP_RECEIVE_FW             0x03
#define OP_VALIDATE               0x04
#define OP_ACTIVATE_AND_RESET     0x05
#define OP_RESET                  0x06
#define OP_PKT_RECEIPT_NOTIF_REQ  0x08
#define OP_RESPONSE_CODE          0x10
#define OP_PKT_RECEIPT_NOTIF      0x11

/* Buttonless trigger payload — a write to the app-mode DFU service ctrl
 * char that asks the app to reboot into its bootloader. Byte 0x01 =
 * START_DFU opcode; byte 0x04 = "application" image type. Together they
 * form the "prepare to receive an application update" request that a
 * buttonless-enabled Nordic app translates into a jump-to-bootloader.
 */
#define BUTTONLESS_TRIGGER_B0     OP_START_DFU
#define BUTTONLESS_TRIGGER_B1     0x04

#define STATUS_SUCCESS            0x01

/* Version characteristic value that flags app-mode-with-buttonless.
 * Real bootloaders report 0x0005 or higher.
 */
#define VERSION_APP_BUTTONLESS    0x0001

/* ---- Nordic Legacy DFU UUIDs (little-endian byte order) --------------
 *   Service        00001530-1212-EFDE-1523-785FEABCD123
 *   Control Point  00001531-1212-EFDE-1523-785FEABCD123
 *   Packet         00001532-1212-EFDE-1523-785FEABCD123
 *   Version        00001534-1212-EFDE-1523-785FEABCD123
 */
static const struct bt_uuid_128 dfu_svc_uuid = BT_UUID_INIT_128(
	0x23, 0xD1, 0xBC, 0xEA, 0x5F, 0x78, 0x23, 0x15,
	0xDE, 0xEF, 0x12, 0x12, 0x30, 0x15, 0x00, 0x00);
static const struct bt_uuid_128 dfu_ctrl_uuid = BT_UUID_INIT_128(
	0x23, 0xD1, 0xBC, 0xEA, 0x5F, 0x78, 0x23, 0x15,
	0xDE, 0xEF, 0x12, 0x12, 0x31, 0x15, 0x00, 0x00);
static const struct bt_uuid_128 dfu_pkt_uuid = BT_UUID_INIT_128(
	0x23, 0xD1, 0xBC, 0xEA, 0x5F, 0x78, 0x23, 0x15,
	0xDE, 0xEF, 0x12, 0x12, 0x32, 0x15, 0x00, 0x00);
static const struct bt_uuid_128 dfu_ver_uuid = BT_UUID_INIT_128(
	0x23, 0xD1, 0xBC, 0xEA, 0x5F, 0x78, 0x23, 0x15,
	0xDE, 0xEF, 0x12, 0x12, 0x34, 0x15, 0x00, 0x00);

/* ---- Session state ---------------------------------------------------
 * Only one DFU sequence runs at a time; the state machine is process-
 * scoped rather than per-call. Mirrors the nRF52 sibling.
 */
static struct {
	struct bt_conn *conn;

	/* Discovered attribute handles + value handles. `_val_handle` is
	 * what we hand to bt_gatt_write / bt_gatt_read; the plain handle
	 * is the discovery cursor (attribute handle of the char decl).
	 */
	uint16_t svc_start_handle;
	uint16_t svc_end_handle;
	uint16_t ctrl_val_handle;
	uint16_t pkt_val_handle;
	uint16_t ver_val_handle;
	uint16_t ctrl_ccc_handle;

	/* Async signaling. connect_sem posts on connected/disconnected.
	 * discover_sem posts when the current bt_gatt_discover completes.
	 * op_sem posts when the current bt_gatt_read/write completes.
	 * notif_sem posts when a CTRL notification arrives.
	 */
	struct k_sem connect_sem;
	struct k_sem discover_sem;
	struct k_sem op_sem;
	struct k_sem notif_sem;
	bool         connected;
	bool         disc_ok;

	struct bt_gatt_discover_params disc_params;

	/* Notification landing buffer + last-seen length. Overwritten on
	 * each ctrl notification; consumers latch a copy before allowing
	 * further ops.
	 */
	uint8_t  notif_buf[20];
	uint8_t  notif_len;
	bool     notif_pending;

	/* Read landing buffer (version char content). */
	uint8_t  read_buf[8];
	uint16_t read_len;
	uint8_t  read_err;

	/* Write completion status. */
	uint8_t  write_err;

	/* Kept alive for the subscription's lifetime — Zephyr stores the
	 * pointer, so it must not be on-stack.
	 */
	struct bt_gatt_subscribe_params sub_params;
} s;

static dfu_progress_cb s_progress_cb;
void dfu_legacy_set_progress_callback(dfu_progress_cb cb) { s_progress_cb = cb; }

/* ---- BT connection callbacks ----------------------------------------
 * Registered once (BT_CONN_CB_DEFINE). We only care about events on our
 * own connection handle; other peers (SMP phone client) reuse the same
 * callback slot but pass a different conn.
 */
static void on_connected(struct bt_conn *conn, uint8_t err)
{
	if (conn != s.conn) return;
	if (err) {
		LOG_WRN("dfu: connect err=0x%02x", err);
		s.connected = false;
	} else {
		char a[BT_ADDR_LE_STR_LEN];
		bt_addr_le_to_str(bt_conn_get_dst(conn), a, sizeof(a));
		LOG_INF("dfu: connected to %s", a);
		s.connected = true;
	}
	k_sem_give(&s.connect_sem);
}

static void on_disconnected(struct bt_conn *conn, uint8_t reason)
{
	if (conn != s.conn) return;
	LOG_INF("dfu: disconnected reason=0x%02x", reason);
	s.connected = false;
	k_sem_give(&s.connect_sem);
}

BT_CONN_CB_DEFINE(dfu_conn_cb) = {
	.connected    = on_connected,
	.disconnected = on_disconnected,
};

/* ---- Discovery state machine ---------------------------------------- */
static uint8_t discover_ver_cb(struct bt_conn *conn,
			       const struct bt_gatt_attr *attr,
			       struct bt_gatt_discover_params *params)
{
	ARG_UNUSED(conn); ARG_UNUSED(params);
	if (attr) {
		const struct bt_gatt_chrc *c = attr->user_data;
		s.ver_val_handle = c->value_handle;
		LOG_INF("dfu: version char at handle 0x%04x", c->value_handle);
	}
	s.disc_ok = true;
	k_sem_give(&s.discover_sem);
	return BT_GATT_ITER_STOP;
}

static uint8_t discover_ccc_cb(struct bt_conn *conn,
			       const struct bt_gatt_attr *attr,
			       struct bt_gatt_discover_params *params)
{
	ARG_UNUSED(params);
	/* End-of-iteration marker. If we never latched a CCC by now, warn
	 * and proceed — a target without a CCC would break notifications
	 * later; better to fail cleanly at that point than silently.
	 */
	if (!attr) {
		if (!s.ctrl_ccc_handle) {
			LOG_WRN("dfu: ctrl CCC not found — cannot enable notifications");
		}
		goto chain_version;
	}

	/* DISCOVER_ATTRIBUTE returns every attribute in the range; filter
	 * for the 16-bit CCC UUID (0x2902) ourselves.
	 */
	if (attr->uuid->type == BT_UUID_TYPE_16 &&
	    BT_UUID_16(attr->uuid)->val == BT_UUID_GATT_CCC_VAL) {
		s.ctrl_ccc_handle = attr->handle;
		LOG_INF("dfu: ctrl CCC at handle 0x%04x", attr->handle);
		goto chain_version;
	}
	return BT_GATT_ITER_CONTINUE;

chain_version:
	/* Discover version char (optional — SDK <11 targets don't have it). */
	s.disc_params.uuid         = &dfu_ver_uuid.uuid;
	s.disc_params.func         = discover_ver_cb;
	s.disc_params.start_handle = s.svc_start_handle;
	s.disc_params.end_handle   = s.svc_end_handle;
	s.disc_params.type         = BT_GATT_DISCOVER_CHARACTERISTIC;
	int rc = bt_gatt_discover(conn, &s.disc_params);
	if (rc) {
		LOG_WRN("dfu: discover version rc=%d", rc);
		s.disc_ok = true;   /* version is optional; still proceed */
		k_sem_give(&s.discover_sem);
	}
	return BT_GATT_ITER_STOP;
}

static uint8_t discover_pkt_cb(struct bt_conn *conn,
			       const struct bt_gatt_attr *attr,
			       struct bt_gatt_discover_params *params)
{
	ARG_UNUSED(conn); ARG_UNUSED(params);
	if (attr) {
		const struct bt_gatt_chrc *c = attr->user_data;
		s.pkt_val_handle = c->value_handle;
		LOG_INF("dfu: packet char at handle 0x%04x", c->value_handle);
	} else {
		LOG_INF("dfu: packet char absent (buttonless-only target)");
	}

	/* Discover the CCC descriptor for the ctrl char.
	 *
	 * BT_GATT_DISCOVER_DESCRIPTOR with the whole-service range +
	 * UUID filter proved unreliable on this Zephyr / SDC combo —
	 * observed on RAK4631_OTA it returned "no more" without ever
	 * hitting the CCC that clearly exists at ctrl_val_handle + 1.
	 * Switching to DISCOVER_ATTRIBUTE with a tight range covering
	 * just the ctrl char's descriptor slot (immediately after the
	 * value handle) and manually matching the CCC UUID in the
	 * callback — this pattern is what the smp_client sample uses
	 * and works reliably.
	 */
	s.disc_params.uuid         = NULL;                       /* no filter — we match in cb */
	s.disc_params.func         = discover_ccc_cb;
	s.disc_params.start_handle = s.ctrl_val_handle + 1;
	s.disc_params.end_handle   = s.ctrl_val_handle + 3;      /* CCC is always right here */
	s.disc_params.type         = BT_GATT_DISCOVER_ATTRIBUTE;
	int rc = bt_gatt_discover(conn, &s.disc_params);
	if (rc) {
		LOG_WRN("dfu: discover CCC rc=%d", rc);
		s.disc_ok = true;
		k_sem_give(&s.discover_sem);
	}
	return BT_GATT_ITER_STOP;
}

static uint8_t discover_ctrl_cb(struct bt_conn *conn,
				const struct bt_gatt_attr *attr,
				struct bt_gatt_discover_params *params)
{
	ARG_UNUSED(conn); ARG_UNUSED(params);
	if (!attr) {
		LOG_WRN("dfu: control point char not found");
		s.disc_ok = false;
		k_sem_give(&s.discover_sem);
		return BT_GATT_ITER_STOP;
	}
	const struct bt_gatt_chrc *c = attr->user_data;
	s.ctrl_val_handle = c->value_handle;
	LOG_INF("dfu: ctrl char at handle 0x%04x", c->value_handle);

	s.disc_params.uuid         = &dfu_pkt_uuid.uuid;
	s.disc_params.func         = discover_pkt_cb;
	s.disc_params.start_handle = s.svc_start_handle;
	s.disc_params.end_handle   = s.svc_end_handle;
	s.disc_params.type         = BT_GATT_DISCOVER_CHARACTERISTIC;
	int rc = bt_gatt_discover(conn, &s.disc_params);
	if (rc) {
		LOG_WRN("dfu: discover packet rc=%d", rc);
		s.disc_ok = false;
		k_sem_give(&s.discover_sem);
	}
	return BT_GATT_ITER_STOP;
}

static uint8_t discover_svc_cb(struct bt_conn *conn,
			       const struct bt_gatt_attr *attr,
			       struct bt_gatt_discover_params *params)
{
	ARG_UNUSED(conn); ARG_UNUSED(params);
	if (!attr) {
		LOG_WRN("dfu: Legacy DFU service not found on peer");
		s.disc_ok = false;
		k_sem_give(&s.discover_sem);
		return BT_GATT_ITER_STOP;
	}

	const struct bt_gatt_service_val *svc = attr->user_data;
	s.svc_start_handle = attr->handle;
	s.svc_end_handle   = svc->end_handle;
	LOG_INF("dfu: service found handles 0x%04x..0x%04x",
		s.svc_start_handle, s.svc_end_handle);

	s.disc_params.uuid         = &dfu_ctrl_uuid.uuid;
	s.disc_params.func         = discover_ctrl_cb;
	s.disc_params.start_handle = s.svc_start_handle;
	s.disc_params.end_handle   = s.svc_end_handle;
	s.disc_params.type         = BT_GATT_DISCOVER_CHARACTERISTIC;
	int rc = bt_gatt_discover(conn, &s.disc_params);
	if (rc) {
		LOG_WRN("dfu: discover ctrl rc=%d", rc);
		s.disc_ok = false;
		k_sem_give(&s.discover_sem);
	}
	return BT_GATT_ITER_STOP;
}

/* Kick off the discovery chain: service → ctrl → packet → CCC → version.
 * Blocks the calling thread on discover_sem; the callbacks above chain
 * the next step from within each other, then the last one gives the sem.
 */
static int discover_all(void)
{
	memset(&s.disc_params, 0, sizeof(s.disc_params));
	s.svc_start_handle = 0;
	s.svc_end_handle   = 0;
	s.ctrl_val_handle  = 0;
	s.pkt_val_handle   = 0;
	s.ver_val_handle   = 0;
	s.ctrl_ccc_handle  = 0;
	s.disc_ok          = false;
	k_sem_reset(&s.discover_sem);

	s.disc_params.uuid         = &dfu_svc_uuid.uuid;
	s.disc_params.func         = discover_svc_cb;
	s.disc_params.start_handle = BT_ATT_FIRST_ATTRIBUTE_HANDLE;
	s.disc_params.end_handle   = BT_ATT_LAST_ATTRIBUTE_HANDLE;
	s.disc_params.type         = BT_GATT_DISCOVER_PRIMARY;

	int rc = bt_gatt_discover(s.conn, &s.disc_params);
	if (rc) return rc;

	if (k_sem_take(&s.discover_sem, K_SECONDS(15)) < 0) {
		return -ETIMEDOUT;
	}
	return s.disc_ok ? 0 : -ENOENT;
}

/* =====================================================================
 * Phase 4b helpers — subscribe + read + write, async→sync via sems.
 * ===================================================================== */

/* Packet Receipt Notification latch. s_prn_bytes always holds the most
 * recent running byte count the peer reported; s_prn_sem is only a
 * wake-up hint, never a count of outstanding notifications. Readers
 * compare the latched value against the last one they consumed, so a
 * duplicated, coalesced or dropped semaphore post cannot desynchronise
 * the stream.
 */
static atomic_t     s_prn_bytes;
static struct k_sem s_prn_sem;

/* Block until the peer reports a byte count strictly greater than
 * `last_seen`, or the timeout expires. Returns 0 and stores the new
 * count in *out, or -ETIMEDOUT.
 */
static int wait_prn(uint32_t timeout_ms, uint32_t last_seen, uint32_t *out)
{
	uint32_t deadline = k_uptime_get_32() + timeout_ms;

	for (;;) {
		uint32_t v = (uint32_t)atomic_get(&s_prn_bytes);
		if (v > last_seen) {
			if (out) *out = v;
			return 0;
		}
		int32_t remain = (int32_t)(deadline - k_uptime_get_32());
		if (remain <= 0) return -ETIMEDOUT;
		/* Return value deliberately ignored — the latched value is
		 * the source of truth, the semaphore only avoids a busy
		 * wait. A spurious wake just re-reads s_prn_bytes.
		 */
		(void)k_sem_take(&s_prn_sem, K_MSEC(remain));
	}
}

/* CTRL notification handler — Zephyr calls this on every notification
 * from the ctrl characteristic. Latch bytes into notif_buf and post the
 * notif_sem so wait_notif() can wake.
 */
static uint8_t on_ctrl_notify(struct bt_conn *conn,
			      struct bt_gatt_subscribe_params *params,
			      const void *data, uint16_t length)
{
	ARG_UNUSED(conn); ARG_UNUSED(params);
	if (!data) {
		/* NULL data = unsubscribed. Nothing to do here. */
		return BT_GATT_ITER_STOP;
	}

	/* Packet Receipt Notifications get their own latch and never touch
	 * notif_buf / notif_sem. Two reasons:
	 *
	 *  1. notif_sem is a binary semaphore (limit 1). If the peer emits
	 *     two notifications before the streaming loop consumes one, the
	 *     second k_sem_give is silently discarded while notif_buf is
	 *     overwritten. The next wait then hands back a value that has
	 *     already been consumed — which shows up as a PRN mismatch that
	 *     is an exact multiple of the PRN period (observed: gaps of
	 *     1952 / 3904 / 5856 B with prn=8 and a 244 B payload, i.e.
	 *     exactly 1, 2 and 3 periods). Latching the *value* instead of
	 *     counting semaphore posts makes duplicate or coalesced
	 *     notifications harmless.
	 *
	 *  2. It keeps a straggling PRN from being mistaken for the final
	 *     RECEIVE_FW response at the end of the stream.
	 */
	const uint8_t *b = data;
	if (length >= 5 && b[0] == OP_PKT_RECEIPT_NOTIF) {
		uint32_t recv = (uint32_t)b[1]
			     | ((uint32_t)b[2] << 8)
			     | ((uint32_t)b[3] << 16)
			     | ((uint32_t)b[4] << 24);
		atomic_set(&s_prn_bytes, (atomic_val_t)recv);
		k_sem_give(&s_prn_sem);
		return BT_GATT_ITER_CONTINUE;
	}

	uint16_t n = length > sizeof(s.notif_buf) ? sizeof(s.notif_buf) : length;
	memcpy(s.notif_buf, data, n);
	s.notif_len     = (uint8_t)n;
	s.notif_pending = true;
	k_sem_give(&s.notif_sem);
	return BT_GATT_ITER_CONTINUE;
}

/* Subscribe (CCC write) with retry on the common transient errors.
 * bt_gatt_subscribe fires .subscribe callback on completion — we key
 * off op_sem for that.
 */
static void on_subscribe_done(struct bt_conn *conn, uint8_t err,
			      struct bt_gatt_subscribe_params *params)
{
	ARG_UNUSED(conn); ARG_UNUSED(params);
	s.write_err = err;
	k_sem_give(&s.op_sem);
}

static int subscribe_ctrl(void)
{
	if (!s.ctrl_ccc_handle || !s.ctrl_val_handle) return -ENOENT;

	memset(&s.sub_params, 0, sizeof(s.sub_params));
	s.sub_params.notify       = on_ctrl_notify;
	s.sub_params.subscribe    = on_subscribe_done;
	s.sub_params.value        = BT_GATT_CCC_NOTIFY;
	s.sub_params.value_handle = s.ctrl_val_handle;
	s.sub_params.ccc_handle   = s.ctrl_ccc_handle;

	k_sem_reset(&s.op_sem);
	int rc = bt_gatt_subscribe(s.conn, &s.sub_params);
	if (rc == -EALREADY) return 0;   /* already subscribed */
	if (rc)              return rc;
	if (k_sem_take(&s.op_sem, K_SECONDS(5)) < 0) return -ETIMEDOUT;
	return s.write_err ? -EIO : 0;
}

/* Async read → sync via op_sem. */
static uint8_t on_read_done(struct bt_conn *conn, uint8_t err,
			    struct bt_gatt_read_params *params,
			    const void *data, uint16_t length)
{
	ARG_UNUSED(conn); ARG_UNUSED(params);
	s.read_err = err;
	if (err || !data) {
		s.read_len = 0;
	} else {
		uint16_t n = length > sizeof(s.read_buf) ? sizeof(s.read_buf) : length;
		memcpy(s.read_buf, data, n);
		s.read_len = n;
	}
	k_sem_give(&s.op_sem);
	return BT_GATT_ITER_STOP;
}

static int read_char(uint16_t handle, uint16_t *out_len)
{
	static struct bt_gatt_read_params rp;
	memset(&rp, 0, sizeof(rp));
	rp.func          = on_read_done;
	rp.handle_count  = 1;
	rp.single.handle = handle;
	rp.single.offset = 0;

	k_sem_reset(&s.op_sem);
	s.read_len = 0; s.read_err = 0;
	int rc = bt_gatt_read(s.conn, &rp);
	if (rc) return rc;
	if (k_sem_take(&s.op_sem, K_SECONDS(5)) < 0) return -ETIMEDOUT;
	if (s.read_err) return -EIO;
	if (out_len) *out_len = s.read_len;
	return 0;
}

/* Async write-with-response → sync via op_sem. */
static void on_write_done(struct bt_conn *conn, uint8_t err,
			  struct bt_gatt_write_params *params)
{
	ARG_UNUSED(conn); ARG_UNUSED(params);
	s.write_err = err;
	k_sem_give(&s.op_sem);
}

static int write_ctrl_req_to(const void *data, uint16_t len, uint32_t timeout_ms)
{
	static struct bt_gatt_write_params wp;
	memset(&wp, 0, sizeof(wp));
	wp.func   = on_write_done;
	wp.handle = s.ctrl_val_handle;
	wp.offset = 0;
	wp.data   = data;
	wp.length = len;

	k_sem_reset(&s.op_sem);
	int rc = bt_gatt_write(s.conn, &wp);
	if (rc) return rc;
	if (k_sem_take(&s.op_sem, K_MSEC(timeout_ms)) < 0) return -ETIMEDOUT;
	return s.write_err ? -EIO : 0;
}

static int write_ctrl_req(const void *data, uint16_t len)
{
	return write_ctrl_req_to(data, len, 15000);
}

/* Fire-and-forget write to the packet characteristic — with a callback
 * that lets us track how many writes the host has actually handed off
 * to the LL. Without this, bt_gatt_write_without_response returns as
 * soon as the buffer is queued in the host, and a busy central can
 * pile up dozens of packets ahead of what the peer's ATT layer can
 * absorb. When the queue eventually overflows on the peer side, ATT
 * drops packets silently — LL still ACKs — and the DFU PRN count
 * silently drifts behind our sent count.
 *
 * The callback increments s_pkt_sent_by_host; the streaming loop uses
 * it to throttle when we're too far ahead of what's actually gone out.
 */
static atomic_t s_pkt_sent_by_host;

static void on_pkt_sent(struct bt_conn *conn, void *user_data)
{
	ARG_UNUSED(conn); ARG_UNUSED(user_data);
	atomic_inc(&s_pkt_sent_by_host);
}

static int write_pkt(const void *data, uint16_t len)
{
	if (!s.pkt_val_handle) return -ENOENT;
	return bt_gatt_write_without_response_cb(s.conn, s.pkt_val_handle,
						 data, len, false,
						 on_pkt_sent, NULL);
}

/* Consume the next CTRL notification. Times out if none arrives.
 * Returns 0 on success (buffer copied into `out`, length in `*out_len`),
 * -ETIMEDOUT if none arrives within timeout_ms.
 */
static int wait_notif(uint32_t timeout_ms, uint8_t *out, uint8_t *out_len)
{
	if (k_sem_take(&s.notif_sem, K_MSEC(timeout_ms)) < 0) return -ETIMEDOUT;
	if (out) memcpy(out, s.notif_buf, s.notif_len);
	if (out_len) *out_len = s.notif_len;
	s.notif_pending = false;
	return 0;
}

/* Parse a Nordic Legacy DFU response notification.
 *   Layout: [0x10, <op>, <status>]
 * Returns the status byte, or 0xFF on protocol error.
 */
static uint8_t consume_response(uint8_t expected_op)
{
	uint8_t buf[20]; uint8_t len;
	if (wait_notif(15000, buf, &len) < 0) {
		LOG_WRN("dfu: response timeout (op=0x%02x)", expected_op);
		return 0xFF;
	}
	if (len < 3 || buf[0] != OP_RESPONSE_CODE || buf[1] != expected_op) {
		LOG_WRN("dfu: bad response len=%u [0]=0x%02x [1]=0x%02x",
			len, len ? buf[0] : 0, len > 1 ? buf[1] : 0);
		return 0xFF;
	}
	return buf[2];
}

/* Read the DFU Version characteristic value. Returns the 16-bit LE-decoded
 * value on success, 0xFFFF if the char isn't present or the read fails.
 * Note: 0xFFFF is a valid sentinel because real versions are 0x0001-0x00FF.
 */
static uint16_t read_dfu_version(void)
{
	if (!s.ver_val_handle) return 0xFFFF;
	uint16_t rl;
	if (read_char(s.ver_val_handle, &rl) < 0 || rl < 2) return 0xFFFF;
	return (uint16_t)s.read_buf[0] | ((uint16_t)s.read_buf[1] << 8);
}

static void put_u32le(uint8_t *p, uint32_t v)
{
	p[0] = (uint8_t)v;
	p[1] = (uint8_t)(v >> 8);
	p[2] = (uint8_t)(v >> 16);
	p[3] = (uint8_t)(v >> 24);
}

/* ---- ATT MTU negotiation --------------------------------------------- */
/* The default MTU of 23 means 20 B/packet writes — for a 500 KB firmware
 * that's ~25,000 write ops. Negotiating MTU 247 drops that ~12x to
 * ~2100 write ops, cutting the wall-clock time from minutes to well
 * under a minute. Zephyr's central initiates the exchange via
 * bt_gatt_exchange_mtu(); the peer either accepts, negotiates down, or
 * refuses. We proceed either way — a refused exchange just falls back
 * to the default MTU and streams slowly.
 */
static void on_mtu_exchanged(struct bt_conn *conn, uint8_t err,
			     struct bt_gatt_exchange_params *params)
{
	ARG_UNUSED(conn); ARG_UNUSED(params);
	s.write_err = err;
	k_sem_give(&s.op_sem);
}

static int negotiate_mtu(void)
{
	static struct bt_gatt_exchange_params ex = { .func = on_mtu_exchanged };
	k_sem_reset(&s.op_sem);
	int rc = bt_gatt_exchange_mtu(s.conn, &ex);
	if (rc == -EALREADY) return 0;
	if (rc) return rc;
	if (k_sem_take(&s.op_sem, K_SECONDS(3)) < 0) return -ETIMEDOUT;
	return s.write_err ? -EIO : 0;
}

/* ---- entry point ------------------------------------------------------ */
enum dfu_result dfu_legacy_run(const struct ble_scanner_target *target,
			       const struct firmware_bundle *bundle,
			       const struct app_config *cfg)
{
	ARG_UNUSED(bundle);
	ARG_UNUSED(cfg);

	/* One-time sem init on first call. */
	static bool sems_ready;
	if (!sems_ready) {
		k_sem_init(&s.connect_sem,  0, 1);
		k_sem_init(&s.discover_sem, 0, 1);
		k_sem_init(&s.op_sem,       0, 1);
		k_sem_init(&s.notif_sem,    0, 1);
		k_sem_init(&s_prn_sem,      0, 1);
		sems_ready = true;
	}

	if (s.conn) {
		bt_conn_unref(s.conn);
		s.conn = NULL;
	}

	char addr_s[BT_ADDR_LE_STR_LEN];
	bt_addr_le_to_str(&target->addr, addr_s, sizeof(addr_s));
	LOG_INF("dfu: connecting to %s", addr_s);

	/* Central-side connection params for the DFU target link:
	 *   min/max interval 12..24 (15..30 ms) — fast enough for streaming
	 *   latency 0 — always listen every event
	 *   timeout 3000 (30 s) — must be generous because SDK-11-era
	 *       Nordic bootloaders occasionally stall for seconds during
	 *       erase-block boundaries or flash commit, and losing the
	 *       link mid-stream means restarting from byte 0 (observed:
	 *       78% into a 506 KB image, peer took ~4.5 s to ACK a
	 *       receipt and the default 4 s supervision timeout kicked
	 *       in and dropped the link).
	 */
	/* 6-12 (7.5-15 ms). We are the central here, so the peripheral either
	 * accepts or counter-proposes — there is no downside to asking. The
	 * interval directly sets the round-trip cost of a packet receipt,
	 * which is the rate limiter whenever prn is small.
	 */
	struct bt_le_conn_param conn_param = BT_LE_CONN_PARAM_INIT(6, 12, 0, 3000);
	struct bt_conn_le_create_param create_param = BT_CONN_LE_CREATE_PARAM_INIT(
		BT_CONN_LE_OPT_NONE, BT_GAP_SCAN_FAST_INTERVAL, BT_GAP_SCAN_FAST_WINDOW);

	k_sem_reset(&s.connect_sem);
	int rc = bt_conn_le_create(&target->addr, &create_param, &conn_param, &s.conn);
	if (rc) {
		LOG_ERR("dfu: bt_conn_le_create rc=%d", rc);
		return DFU_CONNECT_FAILED;
	}
	if (k_sem_take(&s.connect_sem, K_SECONDS(10)) < 0 || !s.connected) {
		LOG_ERR("dfu: connect timed out or failed");
		if (s.conn) { bt_conn_disconnect(s.conn, BT_HCI_ERR_REMOTE_USER_TERM_CONN);
			      bt_conn_unref(s.conn); s.conn = NULL; }
		return DFU_CONNECT_FAILED;
	}

	/* Brief settle window — the LL can succeed then immediately drop
	 * with reason 0x3E on weak signal. Mirror the nRF52 sibling's
	 * 300 ms guard.
	 */
	k_sleep(K_MSEC(300));
	if (!s.connected) {
		LOG_WRN("dfu: link dropped immediately after connect");
		if (s.conn) { bt_conn_unref(s.conn); s.conn = NULL; }
		return DFU_CONNECT_FAILED;
	}

	/* Discover the service + chars. */
	rc = discover_all();
	if (rc == -ENOENT) {
		LOG_WRN("dfu: service or chars missing");
		bt_conn_disconnect(s.conn, BT_HCI_ERR_REMOTE_USER_TERM_CONN);
		k_sem_take(&s.connect_sem, K_SECONDS(3));
		bt_conn_unref(s.conn); s.conn = NULL;
		return s.svc_start_handle ? DFU_CHAR_MISSING : DFU_SERVICE_MISSING;
	}
	if (rc) {
		LOG_WRN("dfu: discovery rc=%d", rc);
		bt_conn_disconnect(s.conn, BT_HCI_ERR_REMOTE_USER_TERM_CONN);
		k_sem_take(&s.connect_sem, K_SECONDS(3));
		bt_conn_unref(s.conn); s.conn = NULL;
		return DFU_DISCONNECTED_EARLY;
	}

	LOG_INF("dfu: discover complete — chars: ctrl=%s packet=%s version=%s ccc=%s",
		s.ctrl_val_handle ? "yes" : "no",
		s.pkt_val_handle  ? "yes" : "no",
		s.ver_val_handle  ? "yes" : "no",
		s.ctrl_ccc_handle ? "yes" : "no");

	if (!s.ctrl_val_handle || !s.ctrl_ccc_handle) {
		LOG_ERR("dfu: ctrl+CCC required — cannot proceed");
		rc = -ENOENT;
		goto disconnect;
	}

	/* --- Phase 4b: subscribe → detect mode → trigger/start --- */

	/* Enable ctrl-char notifications so we can hear peer responses. */
	k_sem_reset(&s.notif_sem);
	rc = subscribe_ctrl();
	if (rc) {
		LOG_ERR("dfu: subscribe ctrl rc=%d", rc);
		goto disconnect;
	}
	LOG_INF("dfu: subscribed to ctrl notifications");

	/* Push ATT MTU up so streaming writes carry MTU-3 bytes each
	 * instead of the default 20. Optional per config.high_mtu — a
	 * misbehaving old bootloader can be bypassed by setting
	 * high_mtu=0 in config.txt.
	 */
	if (cfg->high_mtu) {
		int mrc = negotiate_mtu();
		uint16_t mtu = bt_gatt_get_mtu(s.conn);
		if (mrc) {
			LOG_WRN("dfu: mtu exchange rc=%d (peer rejected?)", mrc);
		}
		LOG_INF("dfu: MTU negotiated = %u (payload=%u)",
			mtu, mtu > 3 ? mtu - 3 : 20);
	}

	/* Read the DFU Version characteristic. Nordic convention:
	 *   0x0001 = app-mode with buttonless (RAK4631_OTA, wio, etc.)
	 *   0x0005+ = real bootloader
	 * Missing / read-fail (0xFFFF): fall back to "packet char absent
	 * means app-mode" heuristic — some very old app-mode firmwares
	 * skip the packet char.
	 */
	uint16_t peer_ver = read_dfu_version();
	bool is_app_mode;
	if (peer_ver == 0xFFFF) {
		is_app_mode = !s.pkt_val_handle;
		LOG_INF("dfu: peer version unknown, falling back to "
			"packet-char heuristic → %s mode",
			is_app_mode ? "app" : "bootloader");
	} else {
		is_app_mode = (peer_ver == VERSION_APP_BUTTONLESS);
		LOG_INF("dfu: peer DFU version = %u.%u (raw 0x%04x) → %s mode",
			peer_ver >> 8, peer_ver & 0xFF, peer_ver,
			is_app_mode ? "app" : "bootloader");
	}

	if (is_app_mode) {
		/* Buttonless trigger: write [0x01, 0x04] to ctrl. The peer
		 * usually disconnects mid-response as it reboots, so we
		 * ignore write failures and just wait for the link drop.
		 * The next scan should find the same peer (or MAC+1) in
		 * bootloader mode.
		 */
		LOG_INF("dfu: sending buttonless trigger");
		uint8_t trig[2] = { BUTTONLESS_TRIGGER_B0, BUTTONLESS_TRIGGER_B1 };
		/* Short timeout by design: the app reboots into the bootloader
		 * as it processes this write, so the ATT response usually never
		 * arrives. Waiting the standard 15 s for a reply we don't expect
		 * just delays the rescan — and on a drone flyover that dead time
		 * is the difference between catching the target and not.
		 */
		(void)write_ctrl_req_to(trig, sizeof(trig), 2000);

		/* Wait for the peer to tear the link down as it reboots — then
		 * make sure it actually did.
		 *
		 * bt_conn_unref() only releases *our reference*; it does not
		 * close the link. If the peer stays up (it doesn't always
		 * reboot promptly), the abandoned central link keeps occupying
		 * one of CONFIG_BT_MAX_CONN slots. With the SMP client holding
		 * the other, the very next bt_conn_le_create fails -ENOMEM:
		 * observed as two attempts burned on "bt_conn_le_create rc=-12"
		 * while the stale link to the app-mode peer lingered until its
		 * own ATT timeout dropped it 30 s later.
		 */
		k_sem_reset(&s.connect_sem);
		if (s.connected) {
			k_sem_take(&s.connect_sem, K_SECONDS(5));
		}
		if (s.connected && s.conn) {
			LOG_INF("dfu: peer still up after trigger — closing link");
			bt_conn_disconnect(s.conn, BT_HCI_ERR_REMOTE_USER_TERM_CONN);
			k_sem_take(&s.connect_sem, K_SECONDS(5));
		}
		if (s.conn) { bt_conn_unref(s.conn); s.conn = NULL; }

		/* Return the buttonless-triggered result so the runner rescans
		 * without consuming a retry.
		 */
		return DFU_BUTTONLESS_TRIGGERED;
	}

	/* Bootloader mode: START_DFU + size packet. */
	uint8_t start_cmd[2] = { OP_START_DFU, bundle->type };
	rc = write_ctrl_req(start_cmd, sizeof(start_cmd));
	if (rc) {
		LOG_ERR("dfu: START_DFU write rc=%d", rc);
		goto disconnect;
	}
	LOG_INF("dfu: sent START_DFU type=0x%02x", bundle->type);

	/* 3 × uint32 LE image sizes: SD, BL, App. Even zero fields must
	 * be present (per LegacyDfuImpl.java).
	 */
	uint8_t sizes[12] = { 0 };
	put_u32le(sizes + 0, bundle->sd_size);
	put_u32le(sizes + 4, bundle->bl_size);
	put_u32le(sizes + 8, (bundle->type & FW_TYPE_APPLICATION) ? bundle->bin.size : 0);
	rc = write_pkt(sizes, sizeof(sizes));
	if (rc < 0) {
		LOG_ERR("dfu: size packet write rc=%d", rc);
		goto disconnect;
	}
	LOG_INF("dfu: sent sizes sd=%u bl=%u app=%u",
		bundle->sd_size, bundle->bl_size,
		(bundle->type & FW_TYPE_APPLICATION) ? bundle->bin.size : 0);

	uint8_t status = consume_response(OP_START_DFU);
	LOG_INF("dfu: START_DFU response status=0x%02x", status);
	if (status != STATUS_SUCCESS) {
		rc = -EIO;
		goto disconnect;
	}

	/* --- Phase 4c: init packet + PRN + firmware stream --- */

	/* INIT_DFU_PARAMS start marker → stream .dat → complete marker → wait ACK. */
	{
		uint8_t init_start[2] = { OP_INIT_DFU_PARAMS, 0x00 };
		rc = write_ctrl_req(init_start, sizeof(init_start));
		if (rc) {
			LOG_ERR("dfu: INIT_DFU_PARAMS start rc=%d", rc);
			goto disconnect;
		}
	}

	/* Stream the init packet (.dat) on the packet char. Typical size
	 * is 14 B, always fits in one write regardless of MTU.
	 */
	{
		uint16_t mtu = bt_gatt_get_mtu(s.conn);
		uint16_t payload = mtu > 3 ? mtu - 3 : 20;
		if (payload > 244) payload = 244;

		uint8_t chunk[244];
		uint32_t off = 0;
		while (off < bundle->dat.size) {
			uint32_t want = bundle->dat.size - off;
			if (want > payload) want = payload;
			int n = firmware_zip_read(&bundle->dat, off, chunk, want);
			if (n != (int)want) {
				LOG_ERR("dfu: dat read short off=%u n=%d", off, n);
				rc = -EIO;
				goto disconnect;
			}
			int wrc = write_pkt(chunk, n);
			if (wrc < 0) {
				LOG_ERR("dfu: dat write rc=%d", wrc);
				rc = -EIO;
				goto disconnect;
			}
			off += n;
		}
		LOG_INF("dfu: sent init packet (%u B)", bundle->dat.size);
	}

	/* Small drain gap between fire-and-forget packet writes and the
	 * next write-with-response on ctrl — the SoftDevice's TX queue is
	 * finite and the WRITE_REQ can be silently dropped if it lands
	 * while the WRITE_CMDs are still draining.
	 */
	k_sleep(K_MSEC(50));

	{
		uint8_t init_complete[2] = { OP_INIT_DFU_PARAMS, 0x01 };
		rc = write_ctrl_req(init_complete, sizeof(init_complete));
		if (rc) {
			LOG_ERR("dfu: INIT_DFU_PARAMS complete rc=%d", rc);
			goto disconnect;
		}
	}
	status = consume_response(OP_INIT_DFU_PARAMS);
	LOG_INF("dfu: INIT_DFU_PARAMS response status=0x%02x", status);
	if (status != STATUS_SUCCESS) { rc = -EIO; goto disconnect; }

	/* Set Packet Receipt Notification cadence. prn=0 disables PRN
	 * entirely — faster but no flow control (some bootloaders can't
	 * keep up and drop packets silently).
	 */
	{
		uint16_t prn = cfg->prn;
		uint8_t prn_cmd[3] = { OP_PKT_RECEIPT_NOTIF_REQ,
				       (uint8_t)(prn & 0xff),
				       (uint8_t)(prn >> 8) };
		rc = write_ctrl_req(prn_cmd, sizeof(prn_cmd));
		if (rc) {
			LOG_ERR("dfu: PRN set rc=%d", rc);
			goto disconnect;
		}
		LOG_INF("dfu: PRN set to %u", prn);
	}

	/* Ask the bootloader to enter RECEIVE state. */
	{
		uint8_t recv_cmd[1] = { OP_RECEIVE_FW };
		rc = write_ctrl_req(recv_cmd, sizeof(recv_cmd));
		if (rc) {
			LOG_ERR("dfu: RECEIVE_FW rc=%d", rc);
			goto disconnect;
		}
	}

	/* Reset the notification path + PRN latch + host-drain counter right
	 * before streaming, so nothing left over from the setup opcodes can
	 * satisfy the first wait with stale data.
	 */
	k_sem_reset(&s.notif_sem);
	k_sem_reset(&s_prn_sem);
	atomic_set(&s_prn_bytes, 0);
	atomic_set(&s_pkt_sent_by_host, 0);

	LOG_INF("dfu: streaming %u B...", bundle->bin.size);

	/* --- streaming loop --- */
	{
		uint16_t prn      = cfg->prn;
		uint16_t mtu      = bt_gatt_get_mtu(s.conn);
		uint16_t payload  = mtu > 3 ? mtu - 3 : 20;
		if (payload > 244) payload = 244;

		uint8_t  fw_chunk[244];
		uint32_t sent             = 0;
		uint32_t packets_sent     = 0;    /* count of write_pkt calls issued */
		uint16_t packets_in_burst = 0;
		uint32_t next_log_pct     = 5;
		uint32_t t_start          = k_uptime_get_32();
		uint32_t last_prn         = 0;    /* highest peer count consumed */

		/* Bound the prn=1 resume path. Retrying the same offset
		 * indefinitely can only mean the peer has stopped acknowledging
		 * for a reason resending won't cure, and an unbounded loop is
		 * worse than a failed attempt: the runner can retry a run, but
		 * nothing rescues a wedged thread.
		 */
		uint32_t resends_here     = 0;
		const uint32_t MAX_RESENDS_PER_OFFSET = 5;

		/* Inter-packet pacing. See config.h for why this exists; the
		 * short version is that ATT Write Commands have no flow
		 * control and the peer drops silently when its RX buffers are
		 * starved during a flash commit.
		 */
		const uint32_t pkt_gap_ms = cfg->pkt_gap_ms;

		/* Host-drain throttle: never let more than this many writes sit
		 * queued in the host TX pool without having been handed to the
		 * LL (bt_gatt_write_without_response returns on queue insert,
		 * not on transmit).
		 *
		 * With PRN enabled this never actually engages — blocking on
		 * the receipt notification every `prn` packets already caps
		 * outstanding writes at `prn`. It exists as the sole backpressure
		 * for the prn=0 configuration, where nothing else would stop us
		 * from queueing the whole image.
		 */
		const uint32_t MAX_HOST_INFLIGHT = 8;

		if (s_progress_cb) s_progress_cb(0);

		while (sent < bundle->bin.size) {
			uint32_t want = bundle->bin.size - sent;
			if (want > payload) want = payload;

			int n = firmware_zip_read(&bundle->bin, sent, fw_chunk, want);
			if (n != (int)want) {
				LOG_ERR("dfu: bin read short sent=%u n=%d", sent, n);
				rc = -EIO;
				goto disconnect;
			}

			/* Retry the write briefly on -ENOMEM (SoftDevice TX
			 * queue full). Bail if it stays full — link is dead
			 * or the peer stopped ACKing.
			 */
			int tries = 0;
			int wrc;
			while ((wrc = write_pkt(fw_chunk, n)) == -ENOMEM) {
				if (++tries > 200) {
					LOG_ERR("dfu: TX queue stall at sent=%u", sent);
					rc = -EIO;
					goto disconnect;
				}
				k_sleep(K_MSEC(5));
				if (!s.connected) {
					LOG_ERR("dfu: link dropped at sent=%u", sent);
					rc = -EIO;
					goto disconnect;
				}
			}
			if (wrc < 0) {
				LOG_ERR("dfu: packet write rc=%d at sent=%u", wrc, sent);
				rc = -EIO;
				goto disconnect;
			}

			sent             += n;
			packets_sent     += 1;
			packets_in_burst += 1;

			/* Throttle: wait for the host TX pool to drain if
			 * we're more than MAX_HOST_INFLIGHT writes ahead
			 * of what the LL has consumed. Yields the CPU (via
			 * short k_sleep) rather than busy-spinning so
			 * on_pkt_sent gets scheduled promptly.
			 */
			while ((packets_sent - (uint32_t)atomic_get(&s_pkt_sent_by_host))
			       > MAX_HOST_INFLIGHT) {
				k_sleep(K_MSEC(1));
				if (!s.connected) {
					LOG_ERR("dfu: link dropped mid-throttle at sent=%u", sent);
					rc = -EIO;
					goto disconnect;
				}
			}

			uint32_t pct = (uint32_t)((uint64_t)sent * 100 / bundle->bin.size);
			if (s_progress_cb) s_progress_cb((uint8_t)pct);
			if (pct >= next_log_pct) {
				LOG_INF("dfu: progress %u%% (%u / %u B)",
					pct, sent, bundle->bin.size);
				next_log_pct = pct + 5;
			}

			/* PRN: every `prn` packets, the peer sends a receipt
			 * notification with its running byte count. Blocking
			 * here gives the SoftDevice queue room to drain and
			 * lets us catch de-sync before we overshoot.
			 */
			/* ...but never after the final packet. Once the bytes we
			 * just sent complete the image size declared in
			 * START_DFU, the bootloader answers with the RECEIVE_FW
			 * *response* rather than a receipt — and responses are
			 * routed to notif_buf, not the PRN latch, so waiting for
			 * a receipt here can only ever time out. We fall out of
			 * the loop and wait for that response instead.
			 *
			 * With prn>1 this was masked whenever the image didn't
			 * end on a burst boundary (2074 packets % 8 = 2, so the
			 * last burst never reached the threshold). At prn=1 every
			 * packet is a boundary, so the timeout fired on the final
			 * packet and the resume path resent the 96-byte tail
			 * forever, against a peer that already had the whole
			 * image.
			 */
			if (prn > 0 && packets_in_burst >= prn &&
			    sent < bundle->bin.size) {
				packets_in_burst = 0;

				uint32_t peer_recv;
				bool     timed_out = false;

				/* Tight on purpose. A burst of `prn` packets is
				 * acknowledged in ~200 ms at a 15 ms interval,
				 * so 800 ms is already 4x headroom — and since
				 * a timeout is the *normal* way we learn about
				 * a dropped burst, every extra second here is
				 * pure dead air on a lossy link. At 2 s the
				 * recovery cost dominated the transfer.
				 */
				if (wait_prn(800, last_prn, &peer_recv) < 0) {
					/* Silence here is itself a loss report.
					 * The bootloader emits a receipt only
					 * once it has actually received `prn`
					 * more packets, so if a burst was
					 * dropped above the link layer we
					 * deadlock: it waits for packets we
					 * believe we already sent. Fall through
					 * to the rewind path using the last
					 * count it confirmed.
					 */
					timed_out = true;
					peer_recv = last_prn;
				} else {
					last_prn = peer_recv;
				}

				if (peer_recv != sent) {
					/* Resume is sound at prn=1 and only at
					 * prn=1. With one receipt per packet the
					 * peer can never hold a partially
					 * received burst: its count is always a
					 * clean packet boundary, whatever it has
					 * is contiguous, and the missing bytes
					 * are exactly the ones we just sent. At
					 * prn>1 none of that holds — see below.
					 */
					if (prn == 1 && peer_recv < sent &&
					    peer_recv >= last_prn &&
					    resends_here < MAX_RESENDS_PER_OFFSET) {
						resends_here++;
						LOG_WRN("dfu: packet lost at %u "
							"(peer at %u) — resending "
							"(%u/%u)", sent, peer_recv,
							resends_here,
							MAX_RESENDS_PER_OFFSET);
						sent = peer_recv;
						continue;
					}

					/* Abort. There is deliberately no resume
					 * path here for prn > 1.
					 *
					 * It is tempting to rewind `sent` to the
					 * peer's count and carry on — the counts
					 * even realign perfectly afterwards. They
					 * lie. The bootloader writes what it
					 * receives sequentially, so when it drops
					 * packet 5 of a burst it writes 6,7,8
					 * into the hole where 5 belonged. The
					 * image is already corrupt at that point
					 * and resending only appends more data
					 * past the damage. Measured: a 506 KB
					 * transfer completed with 39 such
					 * "recoveries" and every byte count
					 * matching, then failed RECEIVE_FW with
					 * status 0x06.
					 *
					 * Legacy DFU has no per-packet ack, so we
					 * cannot tell "lost the tail of the
					 * burst" (resumable) from "lost the
					 * middle" (not). Any loss therefore means
					 * restart the whole image — which is what
					 * dfu_runner's retry loop does. Raise
					 * pkt_gap_ms to stop it happening.
					 */
					LOG_ERR("dfu: PRN %s sent=%u peer=%u — "
						"packet loss on the target, image "
						"would be corrupt; aborting. "
						"Raise pkt_gap_ms (now %u ms), or "
						"set prn=1 for lossless resume",
						timed_out ? "timeout" : "mismatch",
						sent, peer_recv, pkt_gap_ms);
					rc = -EIO;
					goto disconnect;
				}

				/* Receipt matched — the peer is keeping up, so
				 * the resend budget for this offset resets.
				 */
				resends_here = 0;
			}

			/* Pace the stream. Deliberately after the PRN block so
			 * the gap applies uniformly to every packet, including
			 * the first of each burst — that one lands while the
			 * peer is busiest, having just committed the previous
			 * burst to flash.
			 */
			if (pkt_gap_ms) k_sleep(K_MSEC(pkt_gap_ms));
		}
		if (s_progress_cb) s_progress_cb(100);

		uint32_t elapsed = k_uptime_get_32() - t_start;
		LOG_INF("dfu: stream done in %u ms (%u B/s)",
			elapsed, elapsed ? (uint32_t)((uint64_t)bundle->bin.size * 1000 / elapsed) : 0);
	}

	/* Wait for the final RECEIVE_FW response — bootloader ACKs after
	 * the last byte lands and it has verified crc/checksum.
	 */
	{
		uint8_t st = consume_response(OP_RECEIVE_FW);
		LOG_INF("dfu: RECEIVE_FW final status=0x%02x", st);
		if (st != STATUS_SUCCESS) { rc = -EIO; goto disconnect; }
	}

	/* --- Phase 4d: validate + activate + await peer reset --- */
	{
		uint8_t validate_cmd[1] = { OP_VALIDATE };
		rc = write_ctrl_req(validate_cmd, sizeof(validate_cmd));
		if (rc) {
			LOG_ERR("dfu: VALIDATE write rc=%d", rc);
			goto disconnect;
		}
		uint8_t st = consume_response(OP_VALIDATE);
		LOG_INF("dfu: VALIDATE status=0x%02x", st);
		if (st != STATUS_SUCCESS) { rc = -EIO; goto disconnect; }
	}

	{
		/* ACTIVATE_AND_RESET: peer copies staged image into its final
		 * region and reboots. Two important behaviours:
		 *
		 *  1. The peer may disconnect during the ATT write's response
		 *     window (some bootloaders skip the response), so we
		 *     ignore write failure here and treat the following link
		 *     drop as success.
		 *
		 *  2. Do NOT locally-disconnect after ACTIVATE. On some
		 *     bootloaders that tears down the link before flash-erase
		 *     completes and leaves the peer running the old firmware.
		 *     Wait for the peer to drop the link itself.
		 *
		 * 120 s covers SD+BL bundles that erase multiple banks
		 * before booting the new image.
		 */
		uint8_t activate_cmd[1] = { OP_ACTIVATE_AND_RESET };
		(void)write_ctrl_req(activate_cmd, sizeof(activate_cmd));
		LOG_INF("dfu: ACTIVATE sent, waiting for peer reset...");

		if (k_sem_take(&s.connect_sem, K_SECONDS(120)) < 0) {
			LOG_ERR("dfu: peer did not reset within 120 s — forcing disconnect");
			rc = -ETIMEDOUT;
			goto disconnect;
		}
	}

	/* Success path — peer disconnected itself as it rebooted into
	 * the new firmware. Release our conn ref (on_disconnected already
	 * cleared the connected flag) and report DONE without going
	 * through the RESET-on-disconnect cleanup, because there's no
	 * link left to send RESET on and no state to clear.
	 */
	LOG_INF("dfu: DONE — peer rebooted into new image");
	if (s.conn) { bt_conn_unref(s.conn); s.conn = NULL; }
	return DFU_OK;

disconnect:
	if (s.conn) {
		/* Send OP_RESET before hanging up. The bootloader interprets
		 * it as "throw away whatever DFU state I've accumulated and
		 * reboot to idle", which is exactly what we want on both
		 * failure (so the next attempt finds a clean bootloader
		 * instead of INVALID_STATE) and on the current partial-flow
		 * success (until Phase 4d wires up VALIDATE + ACTIVATE, we
		 * mustn't leave the bootloader stuck expecting more bytes).
		 *
		 * Best-effort — a failed write here doesn't change the
		 * outcome, and letting the peer drop the link itself is
		 * cleaner than our local disconnect first (nRF52 project
		 * learned this the hard way: local-disconnect-first left
		 * some bootloaders wedged because they never processed the
		 * RESET before their link went away).
		 */
		if (s.ctrl_val_handle) {
			uint8_t reset_cmd[1] = { OP_RESET };
			(void)write_ctrl_req(reset_cmd, sizeof(reset_cmd));
			/* Give the bootloader up to 3 s to drop the link
			 * itself as a side-effect of processing RESET.
			 */
			if (k_sem_take(&s.connect_sem, K_SECONDS(3)) == 0) {
				goto conn_gone;
			}
		}
		bt_conn_disconnect(s.conn, BT_HCI_ERR_REMOTE_USER_TERM_CONN);
		k_sem_take(&s.connect_sem, K_SECONDS(3));
conn_gone:
		bt_conn_unref(s.conn);
		s.conn = NULL;
	}
	if (rc == 0) return DFU_OK;
	if (rc == -EIO) return DFU_REMOTE_ERROR;
	return DFU_DISCONNECTED_EARLY;
}
