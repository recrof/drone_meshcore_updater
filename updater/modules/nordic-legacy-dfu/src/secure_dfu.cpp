/* SPDX-License-Identifier: BSD-3-Clause */
#include "nordic_dfu/secure_dfu.hpp"
#include "nordic_dfu/package.hpp"
#include "secure_transfer.hpp"
#include "gatt_link.hpp"
#include <zephyr/logging/log.h>

LOG_MODULE_REGISTER(nordic_secure_dfu, CONFIG_NORDIC_LEGACY_DFU_LOG_LEVEL);

namespace nordic::dfu {
namespace {
/* Static lifetime is required: Zephyr may retain callback parameters after
 * disconnect. Do not move this link or its ATT write buffer onto run's stack. */
class Channel final : public internal::SecureChannel {
public:
	internal::GattLink link;
	uint32_t timeout = 30000;
	uint32_t gap_us = 0;
	uint8_t command[6]{};

	int control(const uint8_t *data, uint16_t len) override
	{
		if (len > sizeof(command)) return -EINVAL;
		/* No clear_response(): an unexpected notification is an error, not
		 * something to erase before it can be validated. */
		if (link.has_response()) return -EPROTO;
		memcpy(command, data, len);
		int rc = link.write_control_point(command, len, false);
		/* An Execute notification can precede the ATT write completion and
		 * reboot. Still require the actual Secure success response below. */
		return rc == -ENOTCONN && link.has_response() ? 0 : rc;
	}
	int packet(const uint8_t *data, uint16_t len) override
	{
		int rc = link.write_packet(data, len);
		if (rc == 0 && gap_us) k_usleep(gap_us);
		return rc;
	}
	int receive(uint8_t *data, uint8_t *len) override
	{
		return link.wait_response(data, len, timeout);
	}
	bool aborted() const override { return link.aborted(); }
};
Channel channel;

Report transport_error(int rc)
{
	Report report;
	report.err = rc;
	if (rc == -ECANCELED) report.result = Result::Aborted;
	else if (rc == -ENOTCONN) report.result = Result::DeviceDisconnected;
	else if (rc == -ETIMEDOUT) report.result = Result::Timeout;
	else report.result = Result::GattError;
	return report;
}
}

Report SecureDfuClient::run(bt_conn *conn, const Firmware &firmware, const Parameters &params)
{
	if (observer_) observer_->on_state(State::Starting);
	Report report;
	int rc = channel.link.attach(conn, params.cancelled);
	if (rc == 0) rc = channel.link.discover(true);
	if (rc != 0) {
		report = transport_error(rc);
		if (rc == -ENOENT) report.result = Result::ServiceNotFound;
	} else if (!channel.link.handles().control_point || !channel.link.handles().packet ||
		   !channel.link.handles().control_point_ccc) {
		report.result = Result::CharacteristicNotFound;
	} else if (package_protocol(firmware) != PackageProtocol::Secure) {
		report.result = Result::PackageMismatch;
	} else {
		LOG_INF("Secure DFU service found; application-only, CRC-checked resume");
		channel.timeout = params.operation_timeout_ms ? params.operation_timeout_ms : 30000;
		channel.gap_us = params.packet_interval_us;
		if (params.mtu) {
			rc = channel.link.exchange_mtu(params.mtu);
			/* A completed rejection can use the default MTU. A timeout,
			 * cancellation or disconnect must not reuse the shared ATT
			 * completion semaphore while that exchange is still pending. */
			if (rc != -ETIMEDOUT && rc != -ECANCELED && rc != -ENOTCONN) {
				if (rc) LOG_WRN("MTU exchange failed (%d); using negotiated payload", rc);
				rc = 0;
			}
		}
		if (rc == 0) rc = channel.link.subscribe_control_point();
		if (rc != 0) {
			report = transport_error(rc);
		} else {
			internal::SecureTransfer transfer(channel, observer_,
				channel.link.packet_payload_size(), params.packets_before_notification);
			report = transfer.run(firmware);
			LOG_INF("Secure result=%s resume=%u sent=%u remote=0x%02x detail=%d",
				result_str(report.result), transfer.resumed_from(), report.bytes_sent,
				report.remote, report.err);
			if (report.result == Result::Success) {
				if (observer_) observer_->on_state(State::Disconnecting);
				rc = channel.link.wait_disconnected(params.reset_timeout_ms ?
					params.reset_timeout_ms : 20000);
				if (rc != 0) {
					auto error = transport_error(rc);
					error.bytes_sent = report.bytes_sent;
					report = error;
				}
			}
		}
	}
	/* Never send Legacy RESET/ACTIVATE or Secure ABORT on a failed link.
	 * Disconnect alone preserves the receiver's resumable session. */
	channel.link.unsubscribe_control_point();
	channel.link.detach();
	if (observer_) {
		if (report.result == Result::Success) observer_->on_state(State::Completed);
		if (report.result == Result::Aborted) observer_->on_state(State::Aborted);
		observer_->on_finished(report);
	}
	return report;
}

void SecureDfuClient::abort() { channel.link.abort(); }

} // namespace nordic::dfu
