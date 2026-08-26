/*
 * Nordic Legacy DFU client for Zephyr — GATT plumbing.
 *
 * SPDX-License-Identifier: BSD-3-Clause
 */

#include "gatt_link.hpp"

#include <string.h>
#include <errno.h>
#include <zephyr/logging/log.h>

LOG_MODULE_DECLARE(nordic_dfu, CONFIG_NORDIC_LEGACY_DFU_LOG_LEVEL);

namespace nordic {
namespace dfu {
namespace internal {

/*
 * Legacy DFU UUIDs, 128-bit little-endian.
 *   Service       00001530-1212-EFDE-1523-785FEABCD123
 *   Control Point 00001531-…
 *   Packet        00001532-…
 *   DFU Version   00001534-…
 * Mirrors LegacyDfuImpl.DEFAULT_DFU_*_UUID.
 */
#define DFU_UUID_BYTES(b12)                                                                        \
	{                                                                                          \
		0x23, 0xD1, 0xBC, 0xEA, 0x5F, 0x78, 0x23, 0x15, 0xDE, 0xEF, 0x12, 0x12, (b12),     \
			0x15, 0x00, 0x00                                                           \
	}

static const bt_uuid_128 kServiceUuid = {{BT_UUID_TYPE_128}, DFU_UUID_BYTES(0x30)};
static const bt_uuid_128 kControlPointUuid = {{BT_UUID_TYPE_128}, DFU_UUID_BYTES(0x31)};
static const bt_uuid_128 kPacketUuid = {{BT_UUID_TYPE_128}, DFU_UUID_BYTES(0x32)};
static const bt_uuid_128 kVersionUuid = {{BT_UUID_TYPE_128}, DFU_UUID_BYTES(0x34)};

/* Op code 0x11: Packet Receipt Notification. Mirrors
 * LegacyDfuImpl.OP_CODE_PACKET_RECEIPT_NOTIF_KEY. */
static constexpr uint8_t kOpCodePacketReceiptNotif = 0x11;

/*
 * The Bluetooth connection callbacks are process-wide, so the link object
 * registers itself as the active session and filters on the connection
 * handle. Other links (a peripheral role, another central) share the same
 * callback slot and must be ignored.
 */
static GattLink *s_active;
static bt_conn_cb s_conn_cb;
static bool s_conn_cb_registered;

void GattLink::connected_cb(bt_conn *conn, uint8_t err)
{
	GattLink *self = s_active;

	if (self == nullptr || conn != self->conn_) {
		return;
	}
	self->connected_ = (err == 0);
	if (err != 0) {
		k_sem_give(&self->link_sem_);
	}
}

void GattLink::disconnected_cb(bt_conn *conn, uint8_t reason)
{
	GattLink *self = s_active;

	if (self == nullptr || conn != self->conn_) {
		return;
	}
	LOG_INF("disconnected, reason 0x%02x", reason);
	self->connected_ = false;
	self->wake_all();
}

void GattLink::wake_all()
{
	k_sem_give(&op_sem_);
	k_sem_give(&tx_sem_);
	k_sem_give(&notify_sem_);
	k_sem_give(&receipt_sem_);
	k_sem_give(&link_sem_);
}

int GattLink::attach(bt_conn *conn)
{
	if (conn == nullptr) {
		return -EINVAL;
	}

	if (!sems_ready_) {
		k_sem_init(&op_sem_, 0, 1);
		k_sem_init(&tx_sem_, 0, 1);
		k_sem_init(&notify_sem_, 0, 1);
		k_sem_init(&receipt_sem_, 0, 1);
		k_sem_init(&link_sem_, 0, 1);
		sems_ready_ = true;
	}

	if (!s_conn_cb_registered) {
		memset(&s_conn_cb, 0, sizeof(s_conn_cb));
		s_conn_cb.connected = connected_cb;
		s_conn_cb.disconnected = disconnected_cb;
		int rc = bt_conn_cb_register(&s_conn_cb);
		if (rc != 0 && rc != -EEXIST) {
			return rc;
		}
		s_conn_cb_registered = true;
	}

	conn_ = bt_conn_ref(conn);
	if (conn_ == nullptr) {
		return -ENOTCONN;
	}
	s_active = this;

	connected_ = true;
	h_ = Handles{};
	att_err_ = 0;
	subscribed_ = false;
	response_pending_ = false;
	response_len_ = 0;
	atomic_clear(&aborted_);
	atomic_clear(&prn_bytes_);
	k_sem_reset(&op_sem_);
	k_sem_reset(&tx_sem_);
	k_sem_reset(&notify_sem_);
	k_sem_reset(&receipt_sem_);
	k_sem_reset(&link_sem_);

	/* A connection may already be gone by the time we are handed it. */
	bt_conn_info info;
	if (bt_conn_get_info(conn_, &info) == 0) {
		connected_ = (info.state == BT_CONN_STATE_CONNECTED);
	}

	return connected_ ? 0 : -ENOTCONN;
}

void GattLink::detach()
{
	if (conn_ != nullptr) {
		bt_conn_unref(conn_);
		conn_ = nullptr;
	}
	if (s_active == this) {
		s_active = nullptr;
	}
	connected_ = false;
}

int GattLink::wait(struct k_sem *sem, uint32_t timeout_ms)
{
	k_timeout_t timeout = (timeout_ms != 0) ? K_MSEC(timeout_ms) : K_FOREVER;
	int rc = k_sem_take(sem, timeout);

	if (aborted()) {
		return -ECANCELED;
	}
	if (!connected_) {
		return -ENOTCONN;
	}
	if (rc != 0) {
		return -ETIMEDOUT;
	}
	return 0;
}

void GattLink::abort()
{
	atomic_set(&aborted_, 1);
	if (sems_ready_) {
		wake_all();
	}
}

/* ------------------------------------------------------------------ */
/* Discovery                                                           */
/* ------------------------------------------------------------------ */

int GattLink::run_discovery(const bt_uuid *uuid, uint8_t type, uint16_t start, uint16_t end,
			    bt_gatt_discover_func_t func)
{
	memset(&disc_params_, 0, sizeof(disc_params_));
	disc_params_.uuid = uuid;
	disc_params_.func = func;
	disc_params_.start_handle = start;
	disc_params_.end_handle = end;
	disc_params_.type = type;

	k_sem_reset(&op_sem_);
	int rc = bt_gatt_discover(conn_, &disc_params_);
	if (rc != 0) {
		return rc;
	}
	return wait(&op_sem_, CONFIG_NORDIC_LEGACY_DFU_GATT_TIMEOUT_MS);
}

uint8_t GattLink::discover_services_cb(bt_conn *conn, const bt_gatt_attr *attr,
				       bt_gatt_discover_params *params)
{
	ARG_UNUSED(conn);
	ARG_UNUSED(params);
	GattLink *self = s_active;

	if (self == nullptr) {
		return BT_GATT_ITER_STOP;
	}
	if (attr == nullptr) {
		k_sem_give(&self->op_sem_);
		return BT_GATT_ITER_STOP;
	}

	const bt_gatt_service_val *svc = static_cast<const bt_gatt_service_val *>(attr->user_data);

	self->h_.primary_service_count++;
	if (bt_uuid_cmp(svc->uuid, &kServiceUuid.uuid) == 0) {
		self->h_.service_start = attr->handle;
		self->h_.service_end = svc->end_handle;
	}
	return BT_GATT_ITER_CONTINUE;
}

uint8_t GattLink::discover_chars_cb(bt_conn *conn, const bt_gatt_attr *attr,
				    bt_gatt_discover_params *params)
{
	ARG_UNUSED(conn);
	ARG_UNUSED(params);
	GattLink *self = s_active;

	if (self == nullptr) {
		return BT_GATT_ITER_STOP;
	}
	if (attr == nullptr) {
		k_sem_give(&self->op_sem_);
		return BT_GATT_ITER_STOP;
	}

	const bt_gatt_chrc *chrc = static_cast<const bt_gatt_chrc *>(attr->user_data);

	if (bt_uuid_cmp(chrc->uuid, &kControlPointUuid.uuid) == 0) {
		self->h_.control_point = chrc->value_handle;
		/* Whether this supports WRITE_WITHOUT_RESP decides if the 30 s
		 * ATT stalls after a buttonless jump and after Reset are fixable:
		 * a Write Command leaves no request outstanding to time out. */
		LOG_INF("control point props=0x%02x%s%s", chrc->properties,
			(chrc->properties & BT_GATT_CHRC_WRITE) ? " write" : "",
			(chrc->properties & BT_GATT_CHRC_WRITE_WITHOUT_RESP)
				? " write-without-resp" : "");
	} else if (bt_uuid_cmp(chrc->uuid, &kPacketUuid.uuid) == 0) {
		self->h_.packet = chrc->value_handle;
	} else if (bt_uuid_cmp(chrc->uuid, &kVersionUuid.uuid) == 0) {
		self->h_.version = chrc->value_handle;
	}
	return BT_GATT_ITER_CONTINUE;
}

uint8_t GattLink::discover_ccc_cb(bt_conn *conn, const bt_gatt_attr *attr,
				  bt_gatt_discover_params *params)
{
	ARG_UNUSED(conn);
	ARG_UNUSED(params);
	GattLink *self = s_active;

	if (self == nullptr) {
		return BT_GATT_ITER_STOP;
	}
	if (attr == nullptr) {
		k_sem_give(&self->op_sem_);
		return BT_GATT_ITER_STOP;
	}

	self->h_.control_point_ccc = attr->handle;
	k_sem_give(&self->op_sem_);
	return BT_GATT_ITER_STOP;
}

int GattLink::discover()
{
	/*
	 * All primary services in one pass: it yields the DFU service range
	 * and the service count that LegacyButtonlessDfuImpl needs to tell an
	 * application from a bootloader when there is no DFU Version
	 * characteristic.
	 */
	int rc = run_discovery(nullptr, BT_GATT_DISCOVER_PRIMARY, 0x0001, 0xffff,
			       discover_services_cb);
	if (rc != 0) {
		return rc;
	}
	if (h_.service_start == 0) {
		return -ENOENT;
	}

	rc = run_discovery(nullptr, BT_GATT_DISCOVER_CHARACTERISTIC,
			   static_cast<uint16_t>(h_.service_start + 1), h_.service_end,
			   discover_chars_cb);
	if (rc != 0) {
		return rc;
	}
	if (h_.control_point == 0) {
		return 0; /* caller decides; mirrors isClientCompatible() == false */
	}

	if (h_.control_point < h_.service_end) {
		/* Failure to find a CCCD is not a transport error: the Java
		 * implementation simply reports the peer as incompatible. */
		(void)run_discovery(BT_UUID_GATT_CCC, BT_GATT_DISCOVER_DESCRIPTOR,
				    static_cast<uint16_t>(h_.control_point + 1), h_.service_end,
				    discover_ccc_cb);
	}

	return 0;
}

/* ------------------------------------------------------------------ */
/* Subscription and notifications                                      */
/* ------------------------------------------------------------------ */

uint8_t GattLink::notify_cb(bt_conn *conn, bt_gatt_subscribe_params *params, const void *data,
			    uint16_t length)
{
	ARG_UNUSED(conn);
	ARG_UNUSED(params);
	GattLink *self = s_active;

	if (self == nullptr) {
		return BT_GATT_ITER_STOP;
	}
	if (data == nullptr) {
		/* Unsubscribed. */
		self->subscribed_ = false;
		return BT_GATT_ITER_STOP;
	}

	const uint8_t *value = static_cast<const uint8_t *>(data);

	/*
	 * LegacyDfuImpl.onCharacteristicChanged splits on the first byte:
	 * 0x11 is a Packet Receipt Notification carrying a uint32 count of
	 * bytes received, everything else is a response to a Control Point
	 * request.
	 *
	 * The receipt is latched as a value rather than counted, because a
	 * binary semaphore coalesces two notifications into one wake-up and
	 * the count is the only thing the protocol cares about.
	 */
	if (length >= 5 && value[0] == kOpCodePacketReceiptNotif) {
		uint32_t received = static_cast<uint32_t>(value[1]) |
				    (static_cast<uint32_t>(value[2]) << 8) |
				    (static_cast<uint32_t>(value[3]) << 16) |
				    (static_cast<uint32_t>(value[4]) << 24);
		atomic_set(&self->prn_bytes_, static_cast<atomic_val_t>(received));
		k_sem_give(&self->receipt_sem_);
		return BT_GATT_ITER_CONTINUE;
	}

	uint16_t n = (length > sizeof(self->response_)) ? sizeof(self->response_) : length;
	memcpy(self->response_, data, n);
	self->response_len_ = static_cast<uint8_t>(n);
	self->response_pending_ = true;
	k_sem_give(&self->notify_sem_);
	/* Also wake a receipt wait: a response arriving mid-upload ends the
	 * upload, exactly as mRemoteErrorOccurred / handleNotification do. */
	k_sem_give(&self->receipt_sem_);
	return BT_GATT_ITER_CONTINUE;
}

void GattLink::subscribe_cb(bt_conn *conn, uint8_t err, bt_gatt_subscribe_params *params)
{
	ARG_UNUSED(conn);
	ARG_UNUSED(params);
	GattLink *self = s_active;

	if (self == nullptr) {
		return;
	}
	self->att_err_ = err;
	k_sem_give(&self->op_sem_);
}

int GattLink::subscribe_control_point()
{
	if (h_.control_point == 0 || h_.control_point_ccc == 0) {
		return -ENOENT;
	}

	memset(&sub_params_, 0, sizeof(sub_params_));
	sub_params_.notify = notify_cb;
	sub_params_.subscribe = subscribe_cb;
	sub_params_.value = BT_GATT_CCC_NOTIFY;
	sub_params_.value_handle = h_.control_point;
	sub_params_.ccc_handle = h_.control_point_ccc;

	att_err_ = 0;
	k_sem_reset(&op_sem_);

	int rc = bt_gatt_subscribe(conn_, &sub_params_);
	if (rc == -EALREADY) {
		subscribed_ = true;
		return 0;
	}
	if (rc != 0) {
		return rc;
	}

	rc = wait(&op_sem_, CONFIG_NORDIC_LEGACY_DFU_GATT_TIMEOUT_MS);
	if (rc != 0) {
		return rc;
	}
	if (att_err_ != 0) {
		return -EIO;
	}
	subscribed_ = true;
	return 0;
}

void GattLink::unsubscribe_control_point()
{
	if (subscribed_ && conn_ != nullptr && connected_) {
		(void)bt_gatt_unsubscribe(conn_, &sub_params_);
	}
	subscribed_ = false;
}

void GattLink::clear_response()
{
	response_pending_ = false;
	response_len_ = 0;
	k_sem_reset(&notify_sem_);
}

int GattLink::wait_response(uint8_t *buf, uint8_t *len, uint32_t timeout_ms)
{
	if (!response_pending_) {
		int rc = wait(&notify_sem_, timeout_ms);
		if (rc != 0) {
			return rc;
		}
		if (!response_pending_) {
			return -EAGAIN;
		}
	}

	if (buf != nullptr) {
		memcpy(buf, response_, response_len_);
	}
	if (len != nullptr) {
		*len = response_len_;
	}
	response_pending_ = false;
	k_sem_reset(&notify_sem_);
	return 0;
}

void GattLink::clear_receipts()
{
	atomic_clear(&prn_bytes_);
	k_sem_reset(&receipt_sem_);
}

int GattLink::wait_receipt(uint32_t timeout_ms)
{
	if (response_pending_) {
		return -EPROTO;
	}
	int rc = wait(&receipt_sem_, timeout_ms);
	if (rc == -ETIMEDOUT) {
		/* Distinguishable from a packet-write stall: here the target
		 * owes us a receipt it never sent. */
		LOG_ERR("packet receipt timed out after %u ms — target owes a "
			"receipt for packets it has already taken", timeout_ms);
	}
	if (rc != 0) {
		return rc;
	}
	return response_pending_ ? -EPROTO : 0;
}

/* ------------------------------------------------------------------ */
/* Reads and writes                                                    */
/* ------------------------------------------------------------------ */

uint8_t GattLink::read_cb(bt_conn *conn, uint8_t err, bt_gatt_read_params *params, const void *data,
			  uint16_t length)
{
	ARG_UNUSED(conn);
	ARG_UNUSED(params);
	GattLink *self = s_active;

	if (self == nullptr) {
		return BT_GATT_ITER_STOP;
	}
	self->att_err_ = err;
	if (err != 0 || data == nullptr) {
		self->read_len_ = 0;
	} else {
		uint16_t n = (length > sizeof(self->read_buf_)) ? sizeof(self->read_buf_) : length;
		memcpy(self->read_buf_, data, n);
		self->read_len_ = n;
	}
	k_sem_give(&self->op_sem_);
	return BT_GATT_ITER_STOP;
}

int GattLink::read_version(uint16_t *out)
{
	*out = 0;

	if (h_.version == 0) {
		return 0; /* No DFU Version characteristic: version 0. */
	}

	memset(&read_params_, 0, sizeof(read_params_));
	read_params_.func = read_cb;
	read_params_.handle_count = 1;
	read_params_.single.handle = h_.version;
	read_params_.single.offset = 0;

	att_err_ = 0;
	read_len_ = 0;
	k_sem_reset(&op_sem_);

	int rc = bt_gatt_read(conn_, &read_params_);
	if (rc != 0) {
		return rc;
	}
	rc = wait(&op_sem_, CONFIG_NORDIC_LEGACY_DFU_GATT_TIMEOUT_MS);
	if (rc != 0) {
		return rc;
	}
	if (att_err_ != 0) {
		return -EIO;
	}
	if (read_len_ < 2) {
		return 0; /* Mirrors LegacyButtonlessDfuImpl.readVersion(). */
	}

	*out = static_cast<uint16_t>(read_buf_[0]) | static_cast<uint16_t>(read_buf_[1] << 8);
	return 0;
}

void GattLink::write_cb(bt_conn *conn, uint8_t err, bt_gatt_write_params *params)
{
	ARG_UNUSED(conn);
	ARG_UNUSED(params);
	GattLink *self = s_active;

	if (self == nullptr) {
		return;
	}
	self->att_err_ = err;
	k_sem_give(&self->op_sem_);
}

int GattLink::write_control_point(const void *data, uint16_t len, bool reset)
{
	if (h_.control_point == 0) {
		return -ENOENT;
	}
	if (aborted() && !reset) {
		return -ECANCELED;
	}

	memset(&write_params_, 0, sizeof(write_params_));
	write_params_.func = write_cb;
	write_params_.handle = h_.control_point;
	write_params_.offset = 0;
	write_params_.data = data;
	write_params_.length = len;

	att_err_ = 0;
	k_sem_reset(&op_sem_);

	int rc = bt_gatt_write(conn_, &write_params_);
	if (rc != 0) {
		/*
		 * A target that reboots on Reset or Activate may tear the link
		 * down before the request is even queued. BaseDfuImpl treats
		 * that as success via mResetRequestSent.
		 */
		return reset ? 0 : rc;
	}

	rc = wait(&op_sem_, CONFIG_NORDIC_LEGACY_DFU_GATT_TIMEOUT_MS);
	if (reset) {
		return 0;
	}
	if (rc != 0) {
		return rc;
	}
	return (att_err_ != 0) ? -EIO : 0;
}

void GattLink::packet_sent_cb(bt_conn *conn, void *user_data)
{
	ARG_UNUSED(conn);
	ARG_UNUSED(user_data);
	GattLink *self = s_active;

	if (self != nullptr) {
		k_sem_give(&self->tx_sem_);
	}
}

int GattLink::write_packet(const void *data, uint16_t len)
{
	if (h_.packet == 0) {
		return -ENOENT;
	}
	if (aborted()) {
		return -ECANCELED;
	}

	k_sem_reset(&tx_sem_);

	/*
	 * Android's gatt.writeCharacteristic() queues into a host-side buffer
	 * that never fills in practice, because the next packet is only
	 * written from onCharacteristicWrite. Zephyr surfaces the buffer
	 * shortage as -ENOMEM instead, so retry briefly rather than failing
	 * the transfer: this is a transport difference, not a protocol one.
	 */
	int rc;
	int attempts = 0;

	while ((rc = bt_gatt_write_without_response_cb(conn_, h_.packet, data, len, false,
						       packet_sent_cb, nullptr)) == -ENOMEM) {
		if (++attempts > CONFIG_NORDIC_LEGACY_DFU_TX_RETRY_COUNT) {
			LOG_ERR("packet write: TX buffers exhausted");
			return -ENOMEM;
		}
		if (!connected_) {
			return -ENOTCONN;
		}
		if (aborted()) {
			return -ECANCELED;
		}
		k_sleep(K_MSEC(CONFIG_NORDIC_LEGACY_DFU_TX_RETRY_DELAY_MS));
	}
	if (rc != 0) {
		return rc;
	}

	/* Needing retries at all means the host TX pool was empty, which is the
	 * signature of the radio being shared (a second link, or scanning)
	 * rather than of anything the target did. Worth seeing before the stall
	 * rather than after. */
	if (attempts >= 5) {
		LOG_WRN("packet write waited %d ms for a TX buffer (%d retries)",
			attempts * CONFIG_NORDIC_LEGACY_DFU_TX_RETRY_DELAY_MS, attempts);
	}

	rc = wait(&tx_sem_, CONFIG_NORDIC_LEGACY_DFU_GATT_TIMEOUT_MS);
	if (rc == -ETIMEDOUT) {
		/* The buffer was accepted but the controller never reported it
		 * sent. Either the peer stopped acknowledging at the link layer
		 * (a wedged bootloader), or our radio never got a slot. Naming
		 * the wait matters: a receipt timeout looks identical in the
		 * Result but means something completely different. */
		LOG_ERR("packet write completion timed out after %d ms "
			"(%u B packet, %d TX-buffer retries) — the controller "
			"never reported it sent",
			CONFIG_NORDIC_LEGACY_DFU_GATT_TIMEOUT_MS,
			(unsigned)len, attempts);
	}
	return rc;
}

/* ------------------------------------------------------------------ */
/* MTU and link                                                        */
/* ------------------------------------------------------------------ */

void GattLink::mtu_cb(bt_conn *conn, uint8_t err, bt_gatt_exchange_params *params)
{
	ARG_UNUSED(conn);
	ARG_UNUSED(params);
	GattLink *self = s_active;

	if (self == nullptr) {
		return;
	}
	self->att_err_ = err;
	k_sem_give(&self->op_sem_);
}

int GattLink::exchange_mtu(uint16_t mtu)
{
	ARG_UNUSED(mtu);

	/*
	 * Zephyr has no per-request MTU: the central offers
	 * CONFIG_BT_L2CAP_TX_MTU and the peer answers. Parameters::mtu is
	 * therefore only a request to perform the exchange at all, matching
	 * DfuServiceInitiator.setMtu() being an upper bound rather than a
	 * demand. A failed exchange is not fatal — the default 23 is used,
	 * as it is on Android when requestMtu() fails.
	 */
	memset(&mtu_params_, 0, sizeof(mtu_params_));
	mtu_params_.func = mtu_cb;

	att_err_ = 0;
	k_sem_reset(&op_sem_);

	int rc = bt_gatt_exchange_mtu(conn_, &mtu_params_);
	if (rc == -EALREADY) {
		return 0;
	}
	if (rc != 0) {
		return rc;
	}
	rc = wait(&op_sem_, CONFIG_NORDIC_LEGACY_DFU_GATT_TIMEOUT_MS);
	if (rc != 0) {
		return rc;
	}
	return (att_err_ != 0) ? -EIO : 0;
}

uint16_t GattLink::packet_payload_size() const
{
	uint16_t mtu = bt_gatt_get_mtu(conn_);
	uint16_t payload = (mtu > 3) ? static_cast<uint16_t>(mtu - 3) : 20;

	if (payload > CONFIG_NORDIC_LEGACY_DFU_MAX_PACKET_SIZE) {
		payload = CONFIG_NORDIC_LEGACY_DFU_MAX_PACKET_SIZE;
	}
	return payload;
}

int GattLink::wait_disconnected(uint32_t timeout_ms)
{
	if (!connected_) {
		return 0;
	}

	k_timeout_t timeout = (timeout_ms != 0) ? K_MSEC(timeout_ms) : K_FOREVER;
	uint32_t deadline = k_uptime_get_32() + timeout_ms;

	while (connected_) {
		if (aborted()) {
			return -ECANCELED;
		}
		if (k_sem_take(&link_sem_, timeout) != 0) {
			return -ETIMEDOUT;
		}
		if (timeout_ms != 0) {
			int32_t remaining = static_cast<int32_t>(deadline - k_uptime_get_32());
			if (remaining <= 0 && connected_) {
				return -ETIMEDOUT;
			}
			timeout = K_MSEC(remaining > 0 ? remaining : 0);
		}
	}
	return 0;
}

void GattLink::disconnect()
{
	if (conn_ != nullptr && connected_) {
		(void)bt_conn_disconnect(conn_, BT_HCI_ERR_REMOTE_USER_TERM_CONN);
	}
}

} /* namespace internal */
} /* namespace dfu */
} /* namespace nordic */
