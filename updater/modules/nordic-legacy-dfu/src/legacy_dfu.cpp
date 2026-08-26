/*
 * Nordic Legacy DFU client for Zephyr — protocol.
 *
 * Line-for-line port of no.nordicsemi.android.dfu.LegacyDfuImpl.performDfu()
 * together with the parts of LegacyButtonlessDfuImpl, BaseCustomDfuImpl and
 * BaseDfuImpl it relies on. Where this file departs from the Java, the
 * comment says so and why; everything else is deliberately identical,
 * including the order of operations and the fallback chain.
 *
 * SPDX-License-Identifier: BSD-3-Clause
 */

#include "nordic_dfu/legacy_dfu.hpp"
#include "gatt_link.hpp"

#include <string.h>
#include <errno.h>
#include <zephyr/logging/log.h>

LOG_MODULE_REGISTER(nordic_dfu, CONFIG_NORDIC_LEGACY_DFU_LOG_LEVEL);

namespace nordic {
namespace dfu {

using internal::GattLink;

namespace {

/* Op codes. Mirrors LegacyDfuImpl.OP_CODE_*_KEY. */
constexpr uint8_t OP_START_DFU = 0x01;
constexpr uint8_t OP_INIT_DFU_PARAMS = 0x02;
constexpr uint8_t OP_RECEIVE_FIRMWARE_IMAGE = 0x03;
constexpr uint8_t OP_VALIDATE = 0x04;
constexpr uint8_t OP_ACTIVATE_AND_RESET = 0x05;
constexpr uint8_t OP_RESET = 0x06;
constexpr uint8_t OP_PACKET_RECEIPT_NOTIF_REQ = 0x08;
constexpr uint8_t OP_RESPONSE_CODE = 0x10;

constexpr uint8_t DFU_STATUS_SUCCESS = 1;

/*
 * The DFU Version characteristic value that means "an application which can
 * jump to its bootloader". 5 and above mean a bootloader; 5 is also the
 * point from which the extended init packet becomes mandatory.
 * See the version table in LegacyButtonlessDfuImpl.isClientCompatible().
 */
constexpr uint16_t VERSION_APP_WITH_BUTTONLESS = 1;
constexpr uint16_t VERSION_EXTENDED_INIT_PACKET_REQUIRED = 5;

/*
 * A pre-SDK-7 bootloader (no extended init packet) cannot write incoming
 * data to flash as fast as a modern central sends it, so PRNs are
 * force-enabled and capped. Mirrors the comment and the expression in
 * LegacyDfuImpl.performDfu().
 */
constexpr uint16_t MAX_PRN_FOR_OLD_BOOTLOADER = 10;

void put_u32le(uint8_t *dst, uint32_t value)
{
	dst[0] = static_cast<uint8_t>(value);
	dst[1] = static_cast<uint8_t>(value >> 8);
	dst[2] = static_cast<uint8_t>(value >> 16);
	dst[3] = static_cast<uint8_t>(value >> 24);
}

/**
 * Thrown-equivalent: how an internal step failed.
 *
 * The Java implementation uses exceptions (RemoteDfuException,
 * UnknownResponseException, DeviceDisconnectedException, ...) to unwind
 * performDfu(). Zephyr builds without exceptions, so each step returns a
 * Failure and the driver short-circuits on the first one.
 */
struct Failure {
	Result result;
	uint8_t remote;
	int err;

	Failure() : result(Result::Success), remote(0), err(0) {}
	Failure(Result r, uint8_t rem, int e) : result(r), remote(rem), err(e) {}

	bool failed() const { return result != Result::Success; }

	static Failure ok() { return Failure(); }
	static Failure of(Result r, int e = 0) { return Failure(r, 0, e); }
	static Failure remote_error(uint8_t status)
	{
		return Failure(Result::RemoteError, status, 0);
	}
};

/**
 * One DFU session. Holds what BaseDfuImpl keeps in fields: the link, the
 * firmware, the progress counters and the flags that survive a retry.
 */
class Session {
public:
	Session(Observer *observer, const Firmware &firmware, const Parameters &params)
		: observer_(observer), fw_(firmware), params_(params)
	{
	}

	GattLink &link() { return link_; }

	Report run(bt_conn *conn);
	PeerMode detect(bt_conn *conn, Report *report);
	void abort() { link_.abort(); }

private:
	/* Setup */
	Failure open(bt_conn *conn, PeerMode *mode);

	/* Buttonless */
	Report jump_to_bootloader();

	/* Bootloader */
	Failure start_dfu();
	Failure send_start_request(uint8_t file_type, uint32_t sd, uint32_t bl, uint32_t app,
				   bool v1, uint8_t *status);
	Failure send_init_packet();
	Failure set_packet_receipt_notifications();
	Failure upload_firmware();
	Failure finish();

	/* Helpers, named after their Java counterparts */
	Failure write_op_code(const uint8_t *data, uint16_t len, bool reset = false);
	Failure read_notification_response(uint8_t request, uint8_t *status);
	Failure write_image_size(uint32_t sd, uint32_t bl, uint32_t app);
	Failure write_image_size(uint32_t app);
	Failure write_init_data();
	Failure write_packet_sync(const uint8_t *data, uint16_t len);

	void send_reset();
	Report terminate(const Failure &failure);
	void set_state(State state);
	void report_progress();

	static Failure map_gatt(int rc);

	Observer *observer_;
	Firmware fw_;
	Parameters params_;
	GattLink link_;

	uint16_t version_ = 0;
	uint8_t file_type_ = 0;
	uint32_t image_size_ = 0;
	uint32_t init_packet_size_ = 0;

	/*
	 * Set to false once the target answers NOT_SUPPORTED to the DFU v.2
	 * Start request and we fall back to v.1. It changes how the init
	 * packet is framed and forces PRNs on.
	 */
	bool extended_init_packet_supported_ = true;

	/*
	 * Set when the target refused a combined (SD/BL)+App update and the
	 * application bit was dropped. The caller must reconnect to the new
	 * bootloader and send the application on its own — what
	 * BaseCustomDfuImpl.finalize() achieves by restarting DfuService.
	 */
	bool application_pending_ = false;

	uint16_t packets_before_notification_ = 0;
	uint32_t bytes_sent_ = 0;
	uint8_t last_percent_ = 0xff;
	uint16_t payload_size_ = 20;

	uint8_t buffer_[CONFIG_NORDIC_LEGACY_DFU_MAX_PACKET_SIZE];
};

Failure Session::map_gatt(int rc)
{
	switch (rc) {
	case 0:
		return Failure::ok();
	case -ECANCELED:
		return Failure::of(Result::Aborted);
	case -ENOTCONN:
		return Failure::of(Result::DeviceDisconnected);
	case -ETIMEDOUT:
		return Failure::of(Result::Timeout);
	default:
		return Failure::of(Result::GattError, rc);
	}
}

void Session::set_state(State state)
{
	if (observer_ != nullptr) {
		observer_->on_state(state);
	}
}

void Session::report_progress()
{
	if (observer_ == nullptr || image_size_ == 0) {
		return;
	}
	uint8_t percent = static_cast<uint8_t>((static_cast<uint64_t>(bytes_sent_) * 100) /
					       image_size_);
	if (percent != last_percent_) {
		last_percent_ = percent;
		observer_->on_progress(percent, bytes_sent_, image_size_);
	}
}

/* ------------------------------------------------------------------ */
/* Primitives                                                          */
/* ------------------------------------------------------------------ */

/*
 * BaseDfuImpl.writeOpCode(): clear the latched response, write to the
 * Control Point with a response, and block until the write completes.
 * The response notification is collected separately by
 * read_notification_response().
 */
Failure Session::write_op_code(const uint8_t *data, uint16_t len, bool reset)
{
	link_.clear_response();
	return map_gatt(link_.write_control_point(data, len, reset));
}

/*
 * LegacyDfuImpl.getStatusCode(): a legacy response is exactly three bytes,
 * 0x10 followed by the request op code and a status in 1..6. Anything else
 * is an UnknownResponseException.
 */
Failure Session::read_notification_response(uint8_t request, uint8_t *status)
{
	uint8_t buf[20];
	uint8_t len = 0;

	int rc = link_.wait_response(buf, &len, params_.operation_timeout_ms);
	if (rc != 0) {
		return map_gatt(rc);
	}

	if (len != 3 || buf[0] != OP_RESPONSE_CODE || buf[1] != request || buf[2] < 1 ||
	    buf[2] > 6) {
		LOG_ERR("invalid response for op 0x%02x: len %u [%02x %02x %02x]", request, len,
			len > 0 ? buf[0] : 0, len > 1 ? buf[1] : 0, len > 2 ? buf[2] : 0);
		return Failure::of(Result::InvalidResponse);
	}

	*status = buf[2];
	return Failure::ok();
}

/* BaseCustomDfuImpl.writePacket(): one write without response, awaited. */
Failure Session::write_packet_sync(const uint8_t *data, uint16_t len)
{
	return map_gatt(link_.write_packet(data, len));
}

/*
 * LegacyDfuImpl.writeImageSize(characteristic, sd, bl, app): three uint32
 * little-endian sizes, always all three even when two of them are zero.
 */
Failure Session::write_image_size(uint32_t sd, uint32_t bl, uint32_t app)
{
	uint8_t value[12];

	put_u32le(value + 0, sd);
	put_u32le(value + 4, bl);
	put_u32le(value + 8, app);

	link_.clear_response();
	return write_packet_sync(value, sizeof(value));
}

/* LegacyDfuImpl.writeImageSize(characteristic, imageSize): DFU v.1 form. */
Failure Session::write_image_size(uint32_t app)
{
	uint8_t value[4];

	put_u32le(value, app);

	link_.clear_response();
	return write_packet_sync(value, sizeof(value));
}

/*
 * BaseCustomDfuImpl.writeInitData(): the init packet goes to the Packet
 * characteristic in MTU-sized chunks, each awaited individually. No CRC is
 * computed — Legacy DFU has the CRC inside the init packet itself, unlike
 * Secure DFU which checksums the transfer.
 */
Failure Session::write_init_data()
{
	uint32_t offset = 0;

	while (offset < init_packet_size_) {
		uint32_t want = init_packet_size_ - offset;
		if (want > payload_size_) {
			want = payload_size_;
		}

		int n = fw_.init_packet->read(offset, buffer_, want);
		if (n < 0 || static_cast<uint32_t>(n) != want) {
			LOG_ERR("init packet read failed at %u (rc %d)", offset, n);
			return Failure::of(Result::FileError, n < 0 ? n : -EIO);
		}

		link_.clear_response();
		Failure f = write_packet_sync(buffer_, static_cast<uint16_t>(n));
		if (f.failed()) {
			return f;
		}
		offset += static_cast<uint32_t>(n);
	}

	return Failure::ok();
}

void Session::send_reset()
{
	if (!link_.connected() || link_.handles().control_point == 0) {
		return;
	}
	const uint8_t reset[] = {OP_RESET};

	LOG_INF("sending Reset (Op Code = 6)");
	link_.clear_response();
	(void)link_.write_control_point(reset, sizeof(reset), true);
}

/* ------------------------------------------------------------------ */
/* Setup and mode detection                                            */
/* ------------------------------------------------------------------ */

/*
 * The Legacy subset of DfuServiceProvider.getServiceImpl(): discover the
 * DFU service, require the Control Point and its CCCD, read the DFU
 * Version characteristic, and decide between the buttonless application
 * and the bootloader.
 */
Failure Session::open(bt_conn *conn, PeerMode *mode)
{
	*mode = PeerMode::Unsupported;

	int rc = link_.attach(conn);
	if (rc != 0) {
		return map_gatt(rc);
	}

	rc = link_.discover();
	if (rc == -ENOENT) {
		LOG_WRN("no DFU service on the peer");
		return Failure::of(Result::ServiceNotFound);
	}
	if (rc != 0) {
		return map_gatt(rc);
	}

	const internal::Handles &h = link_.handles();

	if (h.control_point == 0 || h.control_point_ccc == 0) {
		LOG_WRN("DFU service without a usable Control Point");
		return Failure::of(Result::CharacteristicNotFound);
	}

	/*
	 * LegacyButtonlessDfuImpl.isClientCompatible() reads the version
	 * before notifications are enabled and before any MTU request, and
	 * LegacyDfuImpl.readVersion() then reuses the value.
	 */
	rc = link_.read_version(&version_);
	if (rc != 0) {
		return map_gatt(rc);
	}

	if (h.version != 0) {
		LOG_INF("DFU Version %u.%u", version_ >> 8, version_ & 0x0f);
	} else {
		LOG_INF("no DFU Version characteristic");
	}

	/*
	 * version == 1                              → application, jump needed
	 * version == 0 and more than three services → SDK 6.1 application
	 *                                             (Generic Access, Generic
	 *                                             Attribute and DFU alone
	 *                                             mean bootloader)
	 * anything else                             → bootloader
	 *
	 * assume_dfu_mode disables the service-count heuristic, which is what
	 * DfuServiceInitiator.setForceDfu(true) does.
	 */
	const bool more_services = h.primary_service_count > 3;

	if (version_ == VERSION_APP_WITH_BUTTONLESS ||
	    (!params_.assume_dfu_mode && version_ == 0 && more_services)) {
		*mode = PeerMode::ApplicationButtonless;
	} else if (h.packet != 0) {
		*mode = PeerMode::Bootloader;
	} else {
		LOG_WRN("DFU service without a Packet characteristic");
		return Failure::of(Result::CharacteristicNotFound);
	}

	/* LegacyDfuImpl/LegacyButtonlessDfuImpl.performDfu(): MTU first,
	 * then notifications. */
	if (params_.mtu != 0) {
		rc = link_.exchange_mtu(params_.mtu);
		if (rc != 0) {
			LOG_WRN("MTU exchange failed (%d), continuing at the current MTU", rc);
		}
	}
	payload_size_ = link_.packet_payload_size();
	LOG_INF("packet payload %u bytes", payload_size_);

	rc = link_.subscribe_control_point();
	if (rc != 0) {
		LOG_ERR("could not enable Control Point notifications (%d)", rc);
		return map_gatt(rc);
	}

	return Failure::ok();
}

PeerMode Session::detect(bt_conn *conn, Report *report)
{
	PeerMode mode = PeerMode::Unsupported;
	Failure f = open(conn, &mode);

	if (report != nullptr) {
		report->result = f.result;
		report->remote = f.remote;
		report->err = f.err;
		report->version = version_;
	}
	link_.unsubscribe_control_point();
	link_.detach();
	return f.failed() ? PeerMode::Unsupported : mode;
}

/* ------------------------------------------------------------------ */
/* Buttonless jump                                                     */
/* ------------------------------------------------------------------ */

/*
 * LegacyButtonlessDfuImpl.performDfu(): write Start DFU with the
 * application bit set. The target reboots into its bootloader, so the
 * write is a "reset" write whose failure is expected and ignored.
 */
Report Session::jump_to_bootloader()
{
	Report report;

	set_state(State::EnablingDfuMode);
	LOG_INF("application with legacy buttonless update: jumping to bootloader");

	const uint8_t enter_bootloader[] = {OP_START_DFU, IMAGE_APPLICATION};

	link_.clear_response();
	(void)link_.write_control_point(enter_bootloader, sizeof(enter_bootloader), true);

	/*
	 * A bootloader from SDK 6.1 (no DFU Version characteristic) may
	 * advertise with the address incremented by one, so there is nothing
	 * to wait for and the link is dropped immediately. A version 1
	 * application keeps its address, and reconnecting before the old link
	 * is gone would fail, so wait for the disconnect.
	 */
	if (version_ == 0) {
		link_.disconnect();
		(void)link_.wait_disconnected(CONFIG_NORDIC_LEGACY_DFU_GATT_TIMEOUT_MS);
	} else {
		int rc = link_.wait_disconnected(params_.reset_timeout_ms);
		if (rc != 0) {
			LOG_WRN("target did not disconnect after the jump; closing the link");
			link_.disconnect();
			(void)link_.wait_disconnected(CONFIG_NORDIC_LEGACY_DFU_GATT_TIMEOUT_MS);
		}
	}

	report.result = Result::JumpedToBootloader;
	report.version = version_;
	report.address_may_change = (version_ == 0);
	return report;
}

/* ------------------------------------------------------------------ */
/* Start DFU, with the full fallback chain                             */
/* ------------------------------------------------------------------ */

/*
 * One attempt at the Start DFU handshake: the op code on the Control
 * Point, then the sizes on the Packet characteristic, then the response.
 */
Failure Session::send_start_request(uint8_t file_type, uint32_t sd, uint32_t bl, uint32_t app,
				    bool v1, uint8_t *status)
{
	Failure f;

	if (v1) {
		/* DFU v.1 knows only an application update and takes no
		 * upload-mode byte. */
		const uint8_t start[] = {OP_START_DFU};

		LOG_INF("sending Start DFU (Op Code = 1), DFU v.1");
		f = write_op_code(start, sizeof(start));
		if (f.failed()) {
			return f;
		}
		f = write_image_size(app);
	} else {
		const uint8_t start[] = {OP_START_DFU, file_type};

		LOG_INF("sending Start DFU (Op Code = 1, Upload Mode = %u)", file_type);
		f = write_op_code(start, sizeof(start));
		if (f.failed()) {
			return f;
		}
		LOG_INF("sending image sizes (%u, %u, %u)", sd, bl, app);
		f = write_image_size(sd, bl, app);
	}
	if (f.failed()) {
		return f;
	}

	return read_notification_response(OP_START_DFU, status);
}

Failure Session::start_dfu()
{
	/*
	 * Sizes: when the caller did not fill them in, derive them from the
	 * type and the image size, which is what LegacyDfuImpl does for a
	 * source that is not a distribution ZIP.
	 */
	uint32_t sd = fw_.softdevice_size;
	uint32_t bl = fw_.bootloader_size;
	uint32_t app = fw_.application_size;

	if (sd == 0 && bl == 0 && app == 0) {
		/*
		 * Only unambiguous for a single-image bundle. With two or more
		 * type bits set, the split cannot be recovered from one total
		 * and the caller has to state it.
		 */
		if ((file_type_ & (file_type_ - 1)) != 0) {
			LOG_ERR("a multi-image bundle needs explicit sizes in Firmware");
			return Failure::of(Result::FileError, -EINVAL);
		}
		sd = (file_type_ & IMAGE_SOFT_DEVICE) ? image_size_ : 0;
		bl = (file_type_ & IMAGE_BOOTLOADER) ? image_size_ : 0;
		app = (file_type_ & IMAGE_APPLICATION) ? image_size_ : 0;
	} else if (sd + bl + app != image_size_) {
		/*
		 * The target is told how many bytes to expect and then counts
		 * them; a disagreement here always ends as OPERATION FAILED or
		 * a stalled upload, so say so now rather than twenty seconds in.
		 */
		LOG_WRN("declared sizes (%u + %u + %u) do not add up to the image (%u bytes)", sd, bl,
			app, image_size_);
	}

	uint8_t status = 0;
	Failure f = send_start_request(file_type_, sd, bl, app, false, &status);
	if (f.failed()) {
		return f;
	}

	if (status == REMOTE_INVALID_STATE) {
		/*
		 * LegacyDfuImpl.resetAndRestart(): an upload was interrupted in
		 * an earlier connection. Resuming is not safe because there is
		 * no guarantee it was the same firmware, so reset and start
		 * over on a fresh connection.
		 */
		LOG_WRN("target in invalid state; resetting and restarting");
		set_state(State::Disconnecting);
		send_reset();
		(void)link_.wait_disconnected(params_.reset_timeout_ms);
		return Failure::of(Result::RestartRequired);
	}

	if (status == DFU_STATUS_SUCCESS) {
		return Failure::ok();
	}

	if (status != REMOTE_NOT_SUPPORTED) {
		return Failure::remote_error(status);
	}

	/*
	 * NOT_SUPPORTED. Two fallbacks, in the order LegacyDfuImpl tries
	 * them.
	 */
	if ((file_type_ & IMAGE_APPLICATION) != 0 &&
	    (file_type_ & (IMAGE_SOFT_DEVICE | IMAGE_BOOTLOADER)) != 0) {
		/*
		 * The target cannot take (SD/BL)+App in one go. Send the system
		 * components now and let the caller send the application over
		 * the next connection.
		 */
		LOG_WRN("target does not support (SD/BL)+App update; sending SD/BL only");
		file_type_ = static_cast<uint8_t>(file_type_ & ~IMAGE_APPLICATION);
		app = 0;
		application_pending_ = true;

		/*
		 * The image now ends after the Bootloader. ArchiveInputStream
		 * stops yielding the application here too (setContentType()
		 * unhooks it from startNextFile()), but LegacyDfuImpl does not
		 * update mImageSizeInBytes to match, so the Java keeps trying
		 * to read past the end of its own stream and the upload
		 * stalls. Truncating the size is what the Java meant to do.
		 */
		image_size_ = sd + bl;

		f = send_start_request(file_type_, sd, bl, app, false, &status);
		if (f.failed()) {
			return f;
		}
		if (status == REMOTE_INVALID_STATE) {
			LOG_WRN("target in invalid state; resetting and restarting");
			set_state(State::Disconnecting);
			send_reset();
			(void)link_.wait_disconnected(params_.reset_timeout_ms);
			return Failure::of(Result::RestartRequired);
		}
		if (status != DFU_STATUS_SUCCESS) {
			/* file_type_ is no longer APPLICATION alone, so the v.1
			 * fallback does not apply: this is terminal. */
			return Failure::remote_error(status);
		}
		return Failure::ok();
	}

	if (file_type_ == IMAGE_APPLICATION) {
		/*
		 * The target speaks DFU v.1 only (SDK 4.3 - 6.0): no upload
		 * mode byte, a single application size, and no extended init
		 * packet.
		 */
		LOG_WRN("target does not support DFU v.2; switching to DFU v.1");
		extended_init_packet_supported_ = false;

		f = send_start_request(file_type_, 0, 0, image_size_, true, &status);
		if (f.failed()) {
			return f;
		}
		if (status == REMOTE_INVALID_STATE) {
			LOG_WRN("target in invalid state; resetting and restarting");
			set_state(State::Disconnecting);
			send_reset();
			(void)link_.wait_disconnected(params_.reset_timeout_ms);
			return Failure::of(Result::RestartRequired);
		}
		if (status != DFU_STATUS_SUCCESS) {
			return Failure::remote_error(status);
		}
		return Failure::ok();
	}

	return Failure::remote_error(status);
}

/* ------------------------------------------------------------------ */
/* Init packet                                                         */
/* ------------------------------------------------------------------ */

Failure Session::send_init_packet()
{
	if (fw_.init_packet == nullptr || init_packet_size_ == 0) {
		return Failure::ok();
	}

	Failure f;

	if (extended_init_packet_supported_) {
		const uint8_t init_start[] = {OP_INIT_DFU_PARAMS, 0x00};
		const uint8_t init_complete[] = {OP_INIT_DFU_PARAMS, 0x01};

		LOG_INF("sending Init DFU Parameters START (Op Code = 2, Value = 0)");
		f = write_op_code(init_start, sizeof(init_start));
		if (f.failed()) {
			return f;
		}

		LOG_INF("sending %u bytes of init packet", init_packet_size_);
		f = write_init_data();
		if (f.failed()) {
			return f;
		}

		LOG_INF("sending Init DFU Parameters COMPLETE (Op Code = 2, Value = 1)");
		f = write_op_code(init_complete, sizeof(init_complete));
		if (f.failed()) {
			return f;
		}
	} else {
		/*
		 * SDK 4.3 - 6.0: the init packet was two bytes of CRC16 and
		 * there were no START/COMPLETE markers, just op code 2 followed
		 * by the data.
		 */
		const uint8_t init[] = {OP_INIT_DFU_PARAMS};

		LOG_INF("sending Init DFU Parameters (Op Code = 2)");
		f = write_op_code(init, sizeof(init));
		if (f.failed()) {
			return f;
		}
		f = write_init_data();
		if (f.failed()) {
			return f;
		}
	}

	uint8_t status = 0;
	f = read_notification_response(OP_INIT_DFU_PARAMS, &status);
	if (f.failed()) {
		return f;
	}

	if (status == REMOTE_OPERATION_FAILED && init_packet_size_ > 14) {
		LOG_WRN("hint: this init packet is probably not supported by the target. "
			"A file from a newer SDK (Secure DFU) will fail like this.");
	}
	if (status != DFU_STATUS_SUCCESS) {
		return Failure::remote_error(status);
	}
	return Failure::ok();
}

/* ------------------------------------------------------------------ */
/* Packet Receipt Notifications                                        */
/* ------------------------------------------------------------------ */

Failure Session::set_packet_receipt_notifications()
{
	uint16_t prn = params_.packets_before_notification;

	if (!extended_init_packet_supported_ && !(prn > 0 && prn <= MAX_PRN_FOR_OLD_BOOTLOADER)) {
		prn = MAX_PRN_FOR_OLD_BOOTLOADER;
	}
	packets_before_notification_ = prn;

	if (prn == 0) {
		return Failure::ok();
	}

	const uint8_t request[] = {OP_PACKET_RECEIPT_NOTIF_REQ, static_cast<uint8_t>(prn & 0xff),
				   static_cast<uint8_t>(prn >> 8)};

	LOG_INF("sending PRN request (Op Code = 8, Value = %u)", prn);
	/* No response is read here: the legacy target does not answer op 8. */
	return write_op_code(request, sizeof(request));
}

/* ------------------------------------------------------------------ */
/* Firmware upload                                                     */
/* ------------------------------------------------------------------ */

/*
 * BaseCustomDfuImpl.uploadFirmwareImage() plus the onCharacteristicWrite
 * and handlePacketReceiptNotification callbacks that drive it.
 *
 * Android writes one packet, and writes the next only when the stack
 * reports the previous one as sent — unless a Packet Receipt Notification
 * is due, in which case it waits for that instead. That is exactly the
 * loop below; keeping one write outstanding at a time is what stops a
 * central from overrunning the target, and it is the behaviour the DFU
 * app has in the field.
 *
 * Note that the receipt-due check comes before the end-of-image check, so
 * a final packet that lands on a receipt boundary is acknowledged before
 * the upload is considered done. The Java does the same, in that order.
 */
Failure Session::upload_firmware()
{
	uint16_t packets_since_notification = 0;

	bytes_sent_ = 0;
	last_percent_ = 0xff;
	link_.clear_response();
	link_.clear_receipts();
	report_progress();

	/* Absolute deadline for the next packet write, so pacing does not drift
	 * with the time each write itself takes. Zero until the first write. */
	int64_t next_write_ticks = 0;

	/* Highest target flash page this upload has already written into. A
	 * packet reaching beyond it is the one that makes the bootloader erase,
	 * and so the one worth waiting behind. */
	uint32_t highest_page = 0;
	bool     any_page_seen = false;

	/* Absolute end of the erase window opened by the last boundary packet,
	 * and how many packets have gone out into it. Zero deadline = no erase
	 * outstanding. */
	int64_t  erase_deadline_ticks = 0;
	uint32_t sent_into_erase = 0;
	uint32_t packet_index = 0;

	while (bytes_sent_ < image_size_) {
		uint32_t want = image_size_ - bytes_sent_;
		if (want > payload_size_) {
			want = payload_size_;
		}

		int n = fw_.image->read(bytes_sent_, buffer_, want);
		if (n < 0 || static_cast<uint32_t>(n) != want) {
			LOG_ERR("firmware read failed at %u (rc %d)", bytes_sent_, n);
			return Failure::of(Result::FileError, n < 0 ? n : -EIO);
		}

		if (erase_deadline_ticks != 0 &&
		    sent_into_erase >= params_.erase_inflight_packets) {
			/* The target's buffer has taken all we dare give it;
			 * wait out whatever is left of the erase. */
			k_sleep(K_TIMEOUT_ABS_TICKS(erase_deadline_ticks));
			erase_deadline_ticks = 0;
		} else if (next_write_ticks != 0) {
			k_sleep(K_TIMEOUT_ABS_TICKS(next_write_ticks));
		}

		/* Does this packet reach into a page the target has not written
		 * yet? If so it triggers a lazy erase and everything behind it
		 * queues up in the pending ring. */
		bool triggers_erase = false;
		if (params_.erase_page_size > 0) {
			uint32_t end_page =
				(bytes_sent_ + static_cast<uint32_t>(n) - 1) /
				params_.erase_page_size;
			if (!any_page_seen || end_page > highest_page) {
				highest_page = end_page;
				any_page_seen = true;
				triggers_erase = true;
			}
		}

		Failure f = write_packet_sync(buffer_, static_cast<uint16_t>(n));
		if (f.failed()) {
			return f;
		}

		/* Deadlines are measured from the moment this write landed: an
		 * erase only starts once the target actually has the packet. */
		int64_t now_ticks = k_uptime_ticks();
		/* The early pages are where every observed failure happens, and
		 * the model says they should not. Log enough of the start to see
		 * which packet triggered which erase and where the target's
		 * error actually lands. */
		if (packet_index < 40) {
			uint32_t off = bytes_sent_;
			LOG_INF("pkt %u off=%u page=%u%s", packet_index, off,
				params_.erase_page_size
					? (off + static_cast<uint32_t>(n) - 1) /
						params_.erase_page_size : 0u,
				triggers_erase ? "  <- erase" : "");
		}
		packet_index++;
		if (triggers_erase && params_.erase_pause_us > 0) {
			erase_deadline_ticks =
				now_ticks + k_us_to_ticks_ceil64(params_.erase_pause_us);
			sent_into_erase = 0;
		} else if (erase_deadline_ticks != 0) {
			sent_into_erase++;
		}
		next_write_ticks = (params_.packet_interval_us > 0)
			? (now_ticks + k_us_to_ticks_ceil64(params_.packet_interval_us))
			: 0;

		bytes_sent_ += static_cast<uint32_t>(n);
		packets_since_notification++;
		report_progress();

		const bool notification_expected =
			packets_before_notification_ > 0 &&
			packets_since_notification >= packets_before_notification_;

		if (notification_expected) {
			int rc = link_.wait_receipt(params_.operation_timeout_ms);
			if (rc == -EPROTO) {
				/*
				 * A Control Point response arrived instead of a
				 * receipt. The target has rejected something and
				 * the upload stops here; the caller reads the
				 * latched response. Mirrors
				 * mRemoteErrorOccurred / handleNotification().
				 */
				LOG_WRN("target responded during upload at %u bytes", bytes_sent_);
				return Failure::ok();
			}
			if (rc != 0) {
				return map_gatt(rc);
			}
			packets_since_notification = 0;
		}

		if (link_.has_response()) {
			LOG_WRN("target responded during upload at %u bytes", bytes_sent_);
			return Failure::ok();
		}
	}

	return Failure::ok();
}

/* ------------------------------------------------------------------ */
/* Validate and activate                                               */
/* ------------------------------------------------------------------ */

Failure Session::finish()
{
	uint8_t status = 0;

	/* The response to Receive Firmware Image arrives once the target has
	 * taken the whole image. */
	Failure f = read_notification_response(OP_RECEIVE_FIRMWARE_IMAGE, &status);
	if (f.failed()) {
		return f;
	}
	if (status == REMOTE_OPERATION_FAILED &&
	    (packets_before_notification_ == 0 ||
	     packets_before_notification_ > MAX_PRN_FOR_OLD_BOOTLOADER)) {
		LOG_WRN("hint: OPERATION FAILED here usually means the data were sent faster "
			"than the target could handle. Reduce packets_before_notification to "
			"10 or less.");
	}
	if (status != DFU_STATUS_SUCCESS) {
		return Failure::remote_error(status);
	}

	LOG_INF("upload complete, %u bytes", bytes_sent_);

	set_state(State::Validating);
	const uint8_t validate[] = {OP_VALIDATE};

	LOG_INF("sending Validate request (Op Code = 4)");
	f = write_op_code(validate, sizeof(validate));
	if (f.failed()) {
		return f;
	}
	f = read_notification_response(OP_VALIDATE, &status);
	if (f.failed()) {
		return f;
	}
	if (status != DFU_STATUS_SUCCESS) {
		return Failure::remote_error(status);
	}

	/*
	 * Activate and Reset. The target reboots, so the write is a reset
	 * write and the disconnection that follows is the success signal.
	 * The link is deliberately not closed from this side: doing so can
	 * cut a target off mid-erase.
	 */
	set_state(State::Disconnecting);
	const uint8_t activate[] = {OP_ACTIVATE_AND_RESET};

	LOG_INF("sending Activate and Reset request (Op Code = 5)");
	f = write_op_code(activate, sizeof(activate), true);
	if (f.failed()) {
		return f;
	}

	int rc = link_.wait_disconnected(params_.reset_timeout_ms);
	if (rc != 0) {
		LOG_ERR("target did not reset after Activate");
		return map_gatt(rc);
	}

	LOG_INF("target disconnected: DFU complete");
	return Failure::ok();
}

/* ------------------------------------------------------------------ */
/* Session driver                                                      */
/* ------------------------------------------------------------------ */

/*
 * Every failure path in LegacyDfuImpl.performDfu() sends Reset before
 * terminating the connection, so the next attempt finds a clean
 * bootloader rather than one stuck waiting for more data.
 */
Report Session::terminate(const Failure &failure)
{
	Report report;

	report.result = failure.result;
	report.remote = failure.remote;
	report.err = failure.err;
	report.version = version_;
	report.bytes_sent = bytes_sent_;

	switch (failure.result) {
	case Result::Aborted:
	case Result::InvalidResponse:
	case Result::RemoteError:
	case Result::FileError:
		send_reset();
		(void)link_.wait_disconnected(CONFIG_NORDIC_LEGACY_DFU_GATT_TIMEOUT_MS);
		break;
	default:
		break;
	}

	if (failure.result == Result::RemoteError) {
		LOG_ERR("remote DFU error: %s", remote_status_str(failure.remote));
	} else {
		LOG_ERR("DFU failed: %s (err %d)", result_str(failure.result), failure.err);
	}

	set_state(failure.result == Result::Aborted ? State::Aborted : State::Disconnecting);
	return report;
}

Report Session::run(bt_conn *conn)
{
	Report report;
	PeerMode mode = PeerMode::Unsupported;

	set_state(State::Starting);

	Failure f = open(conn, &mode);
	if (f.failed()) {
		report.result = f.result;
		report.remote = f.remote;
		report.err = f.err;
		report.version = version_;
		link_.unsubscribe_control_point();
		link_.detach();
		if (observer_ != nullptr) {
			observer_->on_finished(report);
		}
		return report;
	}

	if (mode == PeerMode::ApplicationButtonless) {
		report = jump_to_bootloader();
		link_.detach();
		if (observer_ != nullptr) {
			observer_->on_finished(report);
		}
		return report;
	}

	file_type_ = fw_.type;
	image_size_ = (fw_.image != nullptr) ? fw_.image->size() : 0;
	init_packet_size_ = (fw_.init_packet != nullptr) ? fw_.init_packet->size() : 0;

	/*
	 * From DFU Version 5 the extended init packet is mandatory. Without
	 * one the target would answer INVALID STATE to the first data packet,
	 * so fail early — LegacyDfuImpl terminates with
	 * ERROR_INIT_PACKET_REQUIRED here.
	 */
	if (version_ >= VERSION_EXTENDED_INIT_PACKET_REQUIRED && init_packet_size_ == 0) {
		LOG_ERR("the init packet is required by DFU bootloader version %u", version_);
		f = Failure::of(Result::InitPacketRequired);
	} else if (image_size_ == 0) {
		LOG_ERR("no firmware image");
		f = Failure::of(Result::FileError, -EINVAL);
	} else {
		f = start_dfu();
		if (!f.failed()) {
			f = send_init_packet();
		}
		if (!f.failed()) {
			f = set_packet_receipt_notifications();
		}
		if (!f.failed()) {
			const uint8_t receive[] = {OP_RECEIVE_FIRMWARE_IMAGE};

			LOG_INF("sending Receive Firmware Image request (Op Code = 3)");
			f = write_op_code(receive, sizeof(receive));
		}
		if (!f.failed()) {
			set_state(State::Uploading);
			LOG_INF("uploading %u bytes", image_size_);
			f = upload_firmware();
		}
		if (!f.failed()) {
			f = finish();
		}
	}

	if (f.failed()) {
		report = terminate(f);
	} else {
		report.result = application_pending_ ? Result::ApplicationPending : Result::Success;
		report.version = version_;
		report.bytes_sent = bytes_sent_;
		set_state(State::Completed);
	}

	link_.unsubscribe_control_point();
	link_.detach();
	if (observer_ != nullptr) {
		observer_->on_finished(report);
	}
	return report;
}

} /* namespace */

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

PeerMode LegacyDfuClient::detect(bt_conn *conn, const Parameters &params, Report *report)
{
	Firmware empty;
	Session session(observer_, empty, params);

	session_ = &session;
	PeerMode mode = session.detect(conn, report);
	session_ = nullptr;
	return mode;
}

Report LegacyDfuClient::run(bt_conn *conn, const Firmware &firmware, const Parameters &params)
{
	Session session(observer_, firmware, params);

	session_ = &session;
	Report report = session.run(conn);
	session_ = nullptr;
	return report;
}

void LegacyDfuClient::abort()
{
	Session *session = static_cast<Session *>(session_);

	if (session != nullptr) {
		session->abort();
	}
}

const char *result_str(Result result)
{
	switch (result) {
	case Result::Success:
		return "SUCCESS";
	case Result::JumpedToBootloader:
		return "JUMPED TO BOOTLOADER";
	case Result::ApplicationPending:
		return "APPLICATION PENDING";
	case Result::RestartRequired:
		return "RESTART REQUIRED";
	case Result::Aborted:
		return "ABORTED";
	case Result::ServiceNotFound:
		return "SERVICE NOT FOUND";
	case Result::CharacteristicNotFound:
		return "CHARACTERISTIC NOT FOUND";
	case Result::InitPacketRequired:
		return "INIT PACKET REQUIRED";
	case Result::InvalidResponse:
		return "INVALID RESPONSE";
	case Result::RemoteError:
		return "REMOTE ERROR";
	case Result::DeviceDisconnected:
		return "DEVICE DISCONNECTED";
	case Result::FileError:
		return "FILE ERROR";
	case Result::GattError:
		return "GATT ERROR";
	case Result::Timeout:
		return "TIMEOUT";
	}
	return "UNKNOWN";
}

const char *remote_status_str(uint8_t status)
{
	switch (status) {
	case REMOTE_SUCCESS:
		return "SUCCESS";
	case REMOTE_INVALID_STATE:
		return "INVALID STATE";
	case REMOTE_NOT_SUPPORTED:
		return "NOT SUPPORTED";
	case REMOTE_DATA_SIZE_EXCEEDS_LIMIT:
		return "DATA SIZE EXCEEDS LIMIT";
	case REMOTE_CRC_ERROR:
		return "INVALID CRC ERROR";
	case REMOTE_OPERATION_FAILED:
		return "OPERATION FAILED";
	default:
		return "UNKNOWN";
	}
}

} /* namespace dfu */
} /* namespace nordic */
