/*
 * Nordic Legacy DFU client for Zephyr.
 *
 * A direct port of the Legacy DFU protocol as implemented by the Android
 * DFU Library (no.nordicsemi.android.dfu.LegacyDfuImpl,
 * LegacyButtonlessDfuImpl, BaseCustomDfuImpl and BaseDfuImpl). The
 * intent is behavioural equivalence with the nRF Connect / DFU app: the
 * same op-code sequence, the same fallbacks, the same flow control, and
 * the same failure handling.
 *
 * Scope: the protocol only. Scanning, connecting and reconnecting are the
 * caller's job — pass in a connected bt_conn. The Android library owns the
 * connection because DfuBaseService also owns bonding and the bootloader
 * scan; neither belongs in a Zephyr library.
 *
 * SPDX-License-Identifier: BSD-3-Clause
 */
#pragma once

#include <stdint.h>
#include <zephyr/bluetooth/conn.h>

#include "nordic_dfu/stream.hpp"

namespace nordic {
namespace dfu {

/** Image type bitmask. Mirrors DfuBaseService.TYPE_*. */
enum ImageType : uint8_t {
	IMAGE_SOFT_DEVICE = 0x01,
	IMAGE_BOOTLOADER = 0x02,
	IMAGE_APPLICATION = 0x04,
	IMAGE_SOFT_DEVICE_BOOTLOADER = IMAGE_SOFT_DEVICE | IMAGE_BOOTLOADER,
};

/** Status codes returned by the DFU target. Mirrors LegacyDfuError. */
enum RemoteStatus : uint8_t {
	REMOTE_SUCCESS = 1,
	REMOTE_INVALID_STATE = 2,
	REMOTE_NOT_SUPPORTED = 3,
	REMOTE_DATA_SIZE_EXCEEDS_LIMIT = 4,
	REMOTE_CRC_ERROR = 5,
	REMOTE_OPERATION_FAILED = 6,
};

/** Outcome of a run(). */
enum class Result {
	/** Firmware uploaded, validated and activated; the target rebooted. */
	Success,
	/**
	 * The peer was an application exposing the legacy buttonless service.
	 * A jump to the bootloader was requested and the link is gone.
	 * Reconnect to the bootloader and run() again.
	 * @see JumpInfo for whether the address may be incremented.
	 */
	JumpedToBootloader,
	/**
	 * The SoftDevice and/or Bootloader were uploaded, but the target
	 * refused to take the application in the same connection (it answered
	 * NOT_SUPPORTED to a combined update). Reconnect to the new bootloader
	 * and run() again with IMAGE_APPLICATION only. This is what
	 * BaseCustomDfuImpl.finalize() does by restarting DfuService.
	 */
	ApplicationPending,
	/**
	 * The target reported INVALID_STATE: an earlier upload was interrupted.
	 * A Reset was sent and the target rebooted. Reconnect and run() again.
	 * Mirrors LegacyDfuImpl.resetAndRestart().
	 */
	RestartRequired,

	/** abort() was called. */
	Aborted,
	/** No DFU Service (00001530-…) on the peer. */
	ServiceNotFound,
	/** DFU Service present but Control Point, its CCCD, or Packet missing. */
	CharacteristicNotFound,
	/** Bootloader reports version >= 5 but no init packet was supplied. */
	InitPacketRequired,
	/** A notification did not match the expected response format. */
	InvalidResponse,
	/** The target answered with a non-success status. See Report::remote. */
	RemoteError,
	/** The link dropped before the sequence completed. */
	DeviceDisconnected,
	/** A Stream read failed or returned short. */
	FileError,
	/** A GATT operation failed. See Report::err for the errno. */
	GattError,
	/** An operation exceeded Parameters::operation_timeout_ms. */
	Timeout,
};

/** Progress phases. Mirrors DfuBaseService.PROGRESS_*. */
enum class State {
	Starting,
	EnablingDfuMode,
	Uploading,
	Validating,
	Disconnecting,
	Completed,
	Aborted,
};

/** Which mode the connected peer is in. Mirrors the isClientCompatible() chain. */
enum class PeerMode {
	/** No legacy DFU service, or no usable characteristics. */
	Unsupported,
	/** Application with legacy buttonless DFU (SDK 6.1 / 7.0+). */
	ApplicationButtonless,
	/** DFU bootloader, ready to receive an image. */
	Bootloader,
};

/** The firmware to send. */
struct Firmware {
	/** Bitmask of ImageType. */
	uint8_t type = IMAGE_APPLICATION;

	/**
	 * The bytes to stream to the Packet characteristic.
	 *
	 * For a multi-image bundle this is the concatenation in the order
	 * SoftDevice, Bootloader, Application — the order ArchiveInputStream
	 * yields them in (see ConcatStream). Its total length must equal the
	 * sum of the three sizes below.
	 */
	const Stream *image = nullptr;

	/**
	 * The init packet (.dat). Required by bootloaders reporting DFU
	 * Version >= 5; optional before that. nullptr means "not supplied".
	 */
	const Stream *init_packet = nullptr;

	/**
	 * Sizes announced in the Start DFU packet.
	 *
	 * Leave all three at 0 for a single-image bundle and they are derived
	 * from `type` and `image->size()`, matching what LegacyDfuImpl does
	 * when the source is not a distribution ZIP. A bundle with more than
	 * one type bit set must state them: the split cannot be recovered
	 * from one total.
	 */
	uint32_t softdevice_size = 0;
	uint32_t bootloader_size = 0;
	uint32_t application_size = 0;
};

/** Tunables. Defaults mirror DfuServiceInitiator. */
struct Parameters {
	/**
	 * Packets sent between Packet Receipt Notifications. 0 disables PRNs.
	 * DfuServiceInitiator.DEFAULT_PRN_VALUE is 12.
	 *
	 * Note: when the target turns out not to support the extended init
	 * packet (a pre-SDK-7 bootloader), the client force-enables PRNs and
	 * clamps this to 10, exactly as LegacyDfuImpl does — those
	 * bootloaders cannot absorb data as fast as it is sent.
	 */
	uint16_t packets_before_notification = 12;

	/**
	 * ATT MTU to request, or 0 to skip the exchange. Legacy DFU
	 * bootloaders before SDK 14.1 only support 23; asking for more is
	 * harmless (the peer negotiates down) but only useful on newer ones.
	 * The payload per packet is always min(MTU - 3,
	 * CONFIG_NORDIC_LEGACY_DFU_MAX_PACKET_SIZE).
	 */
	uint16_t mtu = 517;

	/**
	 * Minimum interval between consecutive Packet characteristic writes,
	 * in microseconds. 0 (the default) sends as fast as the link allows,
	 * which is what the Java does.
	 *
	 * The Java needs no such knob because Android's stack is the limiter:
	 * it lands near 12 ms/packet, which happens to sit just under what an
	 * SDK 11 bootloader can absorb. A Zephyr central is faster. Keeping one
	 * write outstanding does NOT throttle to one packet per connection
	 * event — the completion callback fires when the controller takes the
	 * buffer, not when the peer acknowledges it — so with Data Length
	 * Extension several packets leave per event.
	 *
	 * Measured against an Adafruit nRF52 bootloader: 244 B packets at
	 * 9.4 ms each (26 KB/s) overran its 8-slot pending-write ring during a
	 * page erase and the target answered OPERATION FAILED after 10 KB.
	 * That ring holds 8 writes across an ~85 ms erase, i.e. one packet per
	 * ~10.6 ms; 12000 here leaves margin.
	 */
	uint32_t packet_interval_us = 0;

	/**
	 * Flash page size of the target, in bytes, or 0 to pace uniformly.
	 *
	 * Legacy DFU bootloaders erase each page lazily, on the first write
	 * that touches it, and buffer arrivals meanwhile in a small ring. That
	 * makes the cost wildly uneven: one packet per page is followed by a
	 * ~100 ms stall, and the other ~16 are cheap. Pacing uniformly has to
	 * assume every packet is the expensive one, which throws away most of
	 * the link.
	 *
	 * Set this (4096 for nRF51/nRF52) and the client instead waits
	 * `erase_pause_us` after the packet that crosses into a new page, and
	 * only `packet_interval_us` after the rest. Measured on a RAK4631, that
	 * is the difference between ~12 KB/s and ~23 KB/s.
	 *
	 * Assumes the image begins on a page boundary, which it does: the
	 * bootloader writes from a page-aligned base address.
	 */
	uint32_t erase_page_size = 0;

	/**
	 * How long to wait after the packet that triggers a page erase, in
	 * microseconds. Ignored unless erase_page_size is non-zero.
	 *
	 * Should cover the erase itself; the ring drains behind it while we are
	 * paused. ~100000 suits an nRF52.
	 */
	uint32_t erase_pause_us = 0;

	/**
	 * How many packets may be sent *into* the erase before waiting out the
	 * rest of it. 0 (the default) stops dead at the boundary.
	 *
	 * The target buffers arrivals during an erase, so pausing outright
	 * wastes that buffer: measured, the pauses were 44% of a transfer while
	 * the ring sat empty. Sending a few packets first overlaps them with the
	 * erase and the client only waits for whatever is left.
	 *
	 * Far lower than the ring depth suggests. The ring is 8 and the
	 * triggering packet takes one, but the ring is **not empty** when the
	 * next erase begins: the target is still draining what was buffered
	 * into the previous one. Measured on an Adafruit nRF52 bootloader, 6
	 * failed at every attempt, on the *second* page rather than the first,
	 * with the failure point drifting — the signature of a queue that never
	 * recovers. Treat 2-3 as the usable range and 0 as safe.
	 */
	uint32_t erase_inflight_packets = 0;

	/**
	 * Mirrors DfuServiceInitiator.setForceDfu(). When the peer has no DFU
	 * Version characteristic, the library decides between application and
	 * bootloader mode by counting services: more than three primary
	 * services means an application supporting a buttonless jump. Set
	 * this to true to skip that heuristic and start DFU regardless.
	 */
	bool assume_dfu_mode = false;

	/**
	 * Per-operation timeout in milliseconds, or 0 for none.
	 *
	 * The Java implementation has no timeouts: every wait blocks until a
	 * notification arrives, the device disconnects, or an error is
	 * reported. That is the faithful behaviour and the default. Set a
	 * non-zero value if you would rather fail than hang when a target
	 * stops answering without dropping the link.
	 */
	uint32_t operation_timeout_ms = 0;

	/**
	 * How long to wait for the target to drop the link after a command
	 * that reboots it (Activate and Reset, Reset, or a buttonless jump).
	 * The Java implementation waits indefinitely
	 * (DfuBaseService.waitUntilDisconnected()); a bounded wait is safer on
	 * a device with no user to cancel it. 0 means wait indefinitely.
	 */
	uint32_t reset_timeout_ms = 120000;
};

/** Detail attached to a Result. */
struct Report {
	Result result = Result::Success;
	/** Set when result == RemoteError: the status byte from the target. */
	uint8_t remote = 0;
	/** Set when result == GattError / FileError: negative errno or ATT error. */
	int err = 0;
	/** DFU Version characteristic value, or 0 if the peer has none. */
	uint16_t version = 0;
	/** Bytes actually streamed to the Packet characteristic. */
	uint32_t bytes_sent = 0;
	/**
	 * Set when result == JumpedToBootloader: true if the bootloader may
	 * advertise with the address incremented by one, which is the case for
	 * SDK 6.1 targets (no DFU Version characteristic). Mirrors the
	 * `forceScanning || mVersion == 0` decision in LegacyButtonlessDfuImpl.
	 */
	bool address_may_change = false;
};

/** Notification sink. All calls come from the thread that called run(). */
class Observer {
public:
	virtual ~Observer() = default;

	virtual void on_state(State state) { (void)state; }

	/**
	 * @param percent    0..100 of the current image.
	 * @param bytes_sent bytes written to the Packet characteristic.
	 * @param image_size total size of the current image.
	 */
	virtual void on_progress(uint8_t percent, uint32_t bytes_sent, uint32_t image_size)
	{
		(void)percent;
		(void)bytes_sent;
		(void)image_size;
	}

	virtual void on_finished(const Report &report) { (void)report; }
};

/**
 * The Legacy DFU client.
 *
 * One instance drives one session at a time. run() blocks the calling
 * thread for the whole transfer, so call it from a dedicated thread or a
 * workqueue — never from the Bluetooth RX thread, and never from a GATT
 * callback.
 */
class LegacyDfuClient {
public:
	LegacyDfuClient() = default;
	LegacyDfuClient(const LegacyDfuClient &) = delete;
	LegacyDfuClient &operator=(const LegacyDfuClient &) = delete;

	void set_observer(Observer *observer) { observer_ = observer; }

	/**
	 * Discover the DFU service and work out which mode the peer is in.
	 *
	 * run() performs the same steps itself; call this separately only if
	 * you want to decide whether to proceed before committing to a
	 * transfer. Mirrors the isClientCompatible() chain in
	 * DfuServiceProvider, restricted to the two legacy implementations:
	 * the buttonless one is tried first and reads the DFU Version
	 * characteristic that the bootloader implementation then reuses.
	 */
	PeerMode detect(bt_conn *conn, const Parameters &params, Report *report = nullptr);

	/**
	 * Run the protocol against a connected peer.
	 *
	 * If the peer is an application with the buttonless service, this
	 * requests a jump to the bootloader and returns JumpedToBootloader
	 * without sending any firmware. Reconnect and call run() again.
	 */
	Report run(bt_conn *conn, const Firmware &firmware, const Parameters &params);

	/**
	 * Abort the session. Safe to call from any thread. The in-flight
	 * run() unwinds, sends Reset to the target where the Java
	 * implementation does, and returns Result::Aborted.
	 */
	void abort();

private:
	Observer *observer_ = nullptr;
	/* Opaque pointer to the running session, so abort() can reach it. */
	void *session_ = nullptr;
};

/** Human-readable name for a Result, for logging. */
const char *result_str(Result result);
/** Human-readable name for a target status byte. Mirrors LegacyDfuError.parse(). */
const char *remote_status_str(uint8_t status);

} /* namespace dfu */
} /* namespace nordic */
