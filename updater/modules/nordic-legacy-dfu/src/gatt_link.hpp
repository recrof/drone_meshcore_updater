/*
 * Nordic Legacy DFU client for Zephyr — GATT plumbing.
 *
 * Turns Zephyr's callback-driven GATT API back into the synchronous calls
 * the Java implementation is written against: BaseDfuImpl uses a lock and
 * a set of flags to block the DFU thread until onCharacteristicWrite,
 * onCharacteristicChanged or onDisconnected fires. The same shape is kept
 * here — one semaphore per event class — so the protocol code in
 * legacy_dfu.cpp reads like performDfu() does.
 *
 * SPDX-License-Identifier: BSD-3-Clause
 */
#pragma once

#include <stdint.h>
#include <zephyr/kernel.h>
#include <zephyr/bluetooth/conn.h>
#include <zephyr/bluetooth/gatt.h>
#include <zephyr/bluetooth/uuid.h>
#include <zephyr/sys/atomic.h>

namespace nordic {
namespace dfu {
namespace internal {

/** Everything discovery finds. */
struct Handles {
	uint16_t service_start = 0;
	uint16_t service_end = 0;
	uint16_t control_point = 0;
	uint16_t control_point_ccc = 0;
	uint16_t packet = 0;
	uint16_t version = 0;
	/**
	 * Number of primary services on the peer. LegacyButtonlessDfuImpl
	 * uses `gatt.getServices().size() > 3` to tell an application from a
	 * bootloader when the DFU Version characteristic is absent.
	 */
	uint16_t primary_service_count = 0;
};

class GattLink {
public:
	GattLink() = default;

	/** Bind to a connected peer and reset all session state. */
	int attach(bt_conn *conn);
	/** Release the peer. Does not disconnect. */
	void detach();

	bt_conn *conn() const { return conn_; }
	bool connected() const { return connected_; }
	const Handles &handles() const { return h_; }

	/* ---- discovery ---- */
	int discover();

	/* ---- setup ---- */
	int subscribe_control_point();
	void unsubscribe_control_point();
	int exchange_mtu(uint16_t mtu);
	/** Payload per Packet write: min(ATT_MTU - 3, Kconfig cap). */
	uint16_t packet_payload_size() const;

	/* ---- operations ---- */
	int read_version(uint16_t *out);

	/**
	 * Write to the Control Point and wait for the ATT response.
	 * Mirrors BaseDfuImpl.writeOpCode(characteristic, value, reset).
	 *
	 * @param reset true for op codes that make the target reboot
	 *              (Reset, Activate and Reset). Disconnects and ATT
	 *              errors are then not treated as failures, exactly as
	 *              the Java implementation does via mResetRequestSent.
	 */
	int write_control_point(const void *data, uint16_t len, bool reset);

	/**
	 * Write to the Packet characteristic without response and wait until
	 * the host has handed the buffer to the controller.
	 *
	 * This is the analogue of Android queueing a WRITE_TYPE_NO_RESPONSE
	 * write and continuing from onCharacteristicWrite: exactly one write
	 * is outstanding at a time, which is what paces the whole upload.
	 */
	int write_packet(const void *data, uint16_t len);

	/* ---- notifications ---- */
	/**
	 * Drop any latched response. BaseDfuImpl clears mReceivedData when a
	 * request is written, not when the response is read, so that a
	 * notification arriving before the DFU thread starts waiting is not
	 * lost. Same contract here.
	 */
	void clear_response();
	bool has_response() const { return response_pending_; }
	/** Blocks until a Control Point response notification is latched. */
	int wait_response(uint8_t *buf, uint8_t *len, uint32_t timeout_ms);

	/** Number of bytes the target reported in the last receipt notification. */
	uint32_t receipt_bytes() const { return static_cast<uint32_t>(atomic_get(&prn_bytes_)); }
	void clear_receipts();
	/** Blocks until a Packet Receipt Notification arrives, or a response does. */
	int wait_receipt(uint32_t timeout_ms);

	/* ---- link ---- */
	int wait_disconnected(uint32_t timeout_ms);
	void disconnect();

	/* ---- abort ---- */
	void abort();
	bool aborted() const { return atomic_get(&aborted_) != 0; }
	void clear_abort() { atomic_clear(&aborted_); }

	/** Last ATT error reported by a write/read/subscribe. */
	uint8_t att_error() const { return att_err_; }

private:
	int wait(struct k_sem *sem, uint32_t timeout_ms);
	void wake_all();

	static void connected_cb(bt_conn *conn, uint8_t err);
	static void disconnected_cb(bt_conn *conn, uint8_t reason);

	static uint8_t discover_services_cb(bt_conn *conn, const bt_gatt_attr *attr,
					    bt_gatt_discover_params *params);
	static uint8_t discover_chars_cb(bt_conn *conn, const bt_gatt_attr *attr,
					 bt_gatt_discover_params *params);
	static uint8_t discover_ccc_cb(bt_conn *conn, const bt_gatt_attr *attr,
				       bt_gatt_discover_params *params);
	static uint8_t notify_cb(bt_conn *conn, bt_gatt_subscribe_params *params,
				 const void *data, uint16_t length);
	static void subscribe_cb(bt_conn *conn, uint8_t err, bt_gatt_subscribe_params *params);
	static void write_cb(bt_conn *conn, uint8_t err, bt_gatt_write_params *params);
	static uint8_t read_cb(bt_conn *conn, uint8_t err, bt_gatt_read_params *params,
			       const void *data, uint16_t length);
	static void packet_sent_cb(bt_conn *conn, void *user_data);
	static void mtu_cb(bt_conn *conn, uint8_t err, bt_gatt_exchange_params *params);

	int run_discovery(const bt_uuid *uuid, uint8_t type, uint16_t start, uint16_t end,
			  bt_gatt_discover_func_t func);

	bt_conn *conn_ = nullptr;
	volatile bool connected_ = false;
	Handles h_{};

	struct k_sem op_sem_;      /* read / write-with-response / subscribe / MTU */
	struct k_sem tx_sem_;      /* write-without-response handed to controller */
	struct k_sem notify_sem_;  /* Control Point response notification */
	struct k_sem receipt_sem_; /* Packet Receipt Notification */
	struct k_sem link_sem_;    /* disconnected */
	bool sems_ready_ = false;

	atomic_t aborted_ = ATOMIC_INIT(0);
	atomic_t prn_bytes_ = ATOMIC_INIT(0);

	uint8_t att_err_ = 0;

	/* Latched Control Point response. Legacy DFU responses are 3 bytes;
	 * the buffer is oversized so a malformed one is still visible. */
	uint8_t response_[20]{};
	uint8_t response_len_ = 0;
	volatile bool response_pending_ = false;

	uint8_t read_buf_[8]{};
	uint16_t read_len_ = 0;

	/*
	 * Zephyr keeps pointers to these for the duration of each operation —
	 * and, for sub_params_, for as long after our disconnect as the ATT
	 * channel takes to detach (Trap 3: up to 30 s).
	 *
	 * **So a GattLink may not live on a stack.** The one instance is
	 * `Session::link_` in legacy_dfu.cpp, which is static for this reason
	 * and says so at length. It was an ordinary member of a stack-local
	 * Session once, and the host walked into the dead frame.
	 */
	bt_gatt_discover_params disc_params_{};
	bt_gatt_subscribe_params sub_params_{};
	/*
	 * Does the *host* still have sub_params_ on one of its lists?
	 *
	 * Not the same question as `subscribed_`, which is about this session.
	 * Zephyr removes a subscription when the connection's ATT channel
	 * detaches, which can lag our own disconnect by a long way (Trap 3: a
	 * pending ATT request outlives bt_conn_disconnect() by up to ATT's 30 s
	 * timeout). Until then it holds a pointer *into* this struct, and
	 * touching it is memory corruption in the host's own list.
	 *
	 * Cleared by notify_cb() when Zephyr calls it with data == NULL, which
	 * is exactly the host announcing it has let go.
	 */
	volatile bool sub_linked_ = false;
	bt_gatt_write_params write_params_{};
	bt_gatt_read_params read_params_{};
	bt_gatt_exchange_params mtu_params_{};
	bool subscribed_ = false;
};

} /* namespace internal */
} /* namespace dfu */
} /* namespace nordic */
