/* SPDX-License-Identifier: BSD-3-Clause */
#pragma once

#include "nordic_dfu/legacy_dfu.hpp"

namespace nordic::dfu::internal {

/* Synchronous transport seam, also used by the native protocol tests.
 * One request/receipt is outstanding at a time. Implementations must not
 * discard notifications between a Packet write and receive(). */
class SecureChannel {
public:
	virtual ~SecureChannel() = default;
	virtual int control(const uint8_t *data, uint16_t len) = 0;
	virtual int packet(const uint8_t *data, uint16_t len) = 0;
	virtual int receive(uint8_t *data, uint8_t *len) = 0;
	virtual bool aborted() const = 0;
};

uint32_t secure_crc32(uint32_t crc, const uint8_t *data, uint32_t len);

/* Application-only Secure DFU. No heap, resets, signature rewriting or
 * transport reconnects. The caller owns the connection and retries. */
class SecureTransfer {
public:
	SecureTransfer(SecureChannel &channel, Observer *observer, uint16_t payload,
		       uint16_t prn) : channel_(channel), observer_(observer),
		payload_(payload), prn_(prn) {}
	Report run(const Firmware &firmware);
	uint32_t resumed_from() const { return resumed_from_; }

private:
	bool io(int rc);
	bool response(uint8_t opcode, uint8_t length);
	bool request(const uint8_t *data, uint8_t len, uint8_t response_len = 3);
	bool select(uint8_t type, uint32_t &maximum, uint32_t &offset, uint32_t &crc);
	bool create(uint8_t type, uint32_t size);
	bool set_prn(uint16_t count);
	bool execute();
	bool checksum(uint32_t offset, uint32_t crc, bool receipt = false);
	bool prefix(const Stream &stream, uint32_t length, uint32_t &crc);
	bool send(const Stream &stream, uint32_t &offset, uint32_t end,
		  uint32_t &crc, uint16_t prn, bool progress);
	bool fail(Result result, int err);
	void progress(uint32_t offset, uint32_t total);

	SecureChannel &channel_;
	Observer *observer_;
	uint16_t payload_;
	uint16_t prn_;
	uint16_t packets_ = 0;
	uint32_t resumed_from_ = 0;
	Report report_{};
	uint8_t response_[20]{};
	uint8_t buffer_[244]{};
};

} // namespace nordic::dfu::internal
