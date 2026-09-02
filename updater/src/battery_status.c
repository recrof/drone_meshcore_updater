/*
 * Battery notifications over GATT. See battery_status.h for the contract and
 * for why this is neither a faster poll nor Zephyr's standard Battery Service.
 *
 * The notify discipline is dfu_status.c's, for the same reason: at most one
 * notification in flight, because CONFIG_BT_BUF_ACL_TX_COUNT is 3 and those
 * buffers are shared with the DFU stream. Battery events are rare enough that
 * this almost never bites — but "almost never" is the wrong thing to rely on
 * during the one transfer that must not be slowed down.
 */

#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>
#include <zephyr/bluetooth/bluetooth.h>
#include <zephyr/bluetooth/conn.h>
#include <zephyr/bluetooth/gatt.h>
#include <zephyr/bluetooth/uuid.h>
#include <zephyr/sys/atomic.h>
#include <zephyr/sys/byteorder.h>

#include <string.h>

#include "battery_status.h"

LOG_MODULE_REGISTER(battery_status, LOG_LEVEL_INF);

static struct bt_uuid_128 svc_uuid = BT_UUID_INIT_128(
	BT_UUID_128_ENCODE(0x8d53dc21, 0x1db7, 0x4cd3, 0x868b, 0x8a527460aa84));
static struct bt_uuid_128 batt_uuid = BT_UUID_INIT_128(
	BT_UUID_128_ENCODE(0xda2e782d, 0xfbce, 0x4e01, 0xae9e, 0x261174997c48));

static struct bt_conn *peer;            /* peripheral link only, never a target */
static atomic_t subscribed = ATOMIC_INIT(0);
static atomic_t in_flight = ATOMIC_INIT(0);
static atomic_t dirty = ATOMIC_INIT(0);

static void push_fn(struct k_work *work);
static K_WORK_DEFINE(push_work, push_fn);

static uint16_t encode(uint8_t *out)
{
	struct battery_status st;
	uint8_t flags = 0;

	/* The cached sample, never a fresh read: this runs inside the
	 * Bluetooth stack for a GATT read, and on the PMIC boards a fresh read
	 * is a bit-banged I2C transaction. Blocking there to be 10 s more
	 * current is a bad trade. */
	if (!battery_last(&st)) {
		memset(&st, 0, sizeof(st));
		st.source = BATTERY_SOURCE_NONE;
	}

	if (st.charging_known) {
		flags |= BATTERY_ST_CHARGING_KNOWN;
		if (st.charging) {
			flags |= BATTERY_ST_CHARGING;
		}
	}
	if (st.external_power_known) {
		flags |= BATTERY_ST_EXTERNAL_KNOWN;
		if (st.external_power) {
			flags |= BATTERY_ST_EXTERNAL;
		}
	}

	out[0] = BATTERY_STATUS_PAYLOAD_VERSION;
	out[1] = (uint8_t)st.source;
	out[2] = st.percent;
	out[3] = flags;
	sys_put_le16(st.millivolts, &out[4]);

	return BATTERY_STATUS_LEN;
}

static ssize_t read_battery(struct bt_conn *conn, const struct bt_gatt_attr *attr,
			    void *buf, uint16_t len, uint16_t offset)
{
	uint8_t payload[BATTERY_STATUS_LEN];
	uint16_t n = encode(payload);

	return bt_gatt_attr_read(conn, attr, buf, len, offset, payload, n);
}

static void on_ccc(const struct bt_gatt_attr *attr, uint16_t value)
{
	ARG_UNUSED(attr);
	const bool on = (value == BT_GATT_CCC_NOTIFY);

	atomic_set(&subscribed, on ? 1 : 0);
	if (on) {
		/* Send the current reading straight away. Otherwise a client
		 * that subscribes sees nothing until the battery happens to
		 * move, which on a device sitting on a charger could be the
		 * rest of the session. */
		atomic_set(&dirty, 1);
		k_work_submit(&push_work);
	}
}

BT_GATT_SERVICE_DEFINE(battery_status_svc,
	BT_GATT_PRIMARY_SERVICE(&svc_uuid),
	BT_GATT_CHARACTERISTIC(&batt_uuid.uuid,
			       BT_GATT_CHRC_READ | BT_GATT_CHRC_NOTIFY,
			       BT_GATT_PERM_READ, read_battery, NULL, NULL),
	BT_GATT_CCC(on_ccc, BT_GATT_PERM_READ | BT_GATT_PERM_WRITE),
);

/* [0] service, [1] char decl, [2] char value — what notify targets. */
#define BATTERY_VALUE_ATTR_IDX 2

static void on_connected(struct bt_conn *conn, uint8_t err)
{
	struct bt_conn_info info;

	if (err || bt_conn_get_info(conn, &info) != 0) {
		return;
	}
	/* Peripheral only. Latching whichever connection happened last would
	 * pick up the DFU target — the same bug dfu_status.c and log_stream.c
	 * both guard against. */
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

BT_CONN_CB_DEFINE(battery_status_conn_cb) = {
	.connected = on_connected,
	.disconnected = on_disconnected,
};

static void sent_cb(struct bt_conn *conn, void *user_data)
{
	ARG_UNUSED(conn);
	ARG_UNUSED(user_data);

	atomic_set(&in_flight, 0);
	if (atomic_get(&dirty)) {
		k_work_submit(&push_work);
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
		return;         /* sent_cb will come back for it */
	}
	atomic_set(&dirty, 0);

	static uint8_t payload[BATTERY_STATUS_LEN];
	uint16_t n = encode(payload);

	struct bt_gatt_notify_params params = {
		.attr = &battery_status_svc.attrs[BATTERY_VALUE_ATTR_IDX],
		.data = payload,
		.len = n,
		.func = sent_cb,
	};

	if (bt_gatt_notify_cb(peer, &params) != 0) {
		/* Put it back rather than dropping it: the whole point of this
		 * service is that a charger event arrives, and a failed send
		 * that is silently forgotten is worse than a slow poll. */
		atomic_set(&dirty, 1);
		atomic_set(&in_flight, 0);
	}
}

static void on_battery_change(const struct battery_status *now)
{
	ARG_UNUSED(now);

	atomic_set(&dirty, 1);
	k_work_submit(&push_work);
}

void battery_status_init(void)
{
	battery_monitor_start(on_battery_change);
}
