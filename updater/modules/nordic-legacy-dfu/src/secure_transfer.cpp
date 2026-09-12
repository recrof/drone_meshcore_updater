/* Nordic Secure DFU object protocol. SPDX-License-Identifier: BSD-3-Clause */
#include "secure_transfer.hpp"
#include <errno.h>

namespace nordic::dfu::internal {
namespace {
uint32_t le32(const uint8_t *p)
{
	return uint32_t(p[0]) | (uint32_t(p[1]) << 8) |
	       (uint32_t(p[2]) << 16) | (uint32_t(p[3]) << 24);
}
void put32(uint8_t *p, uint32_t n)
{
	for (unsigned i = 0; i < 4; ++i) p[i] = uint8_t(n >> (8 * i));
}
}

uint32_t secure_crc32(uint32_t crc, const uint8_t *data, uint32_t len)
{
	crc = ~crc;
	while (len--) {
		crc ^= *data++;
		for (unsigned bit = 0; bit < 8; ++bit)
			crc = (crc >> 1) ^ (0xEDB88320u & (0u - (crc & 1u)));
	}
	return ~crc;
}

bool SecureTransfer::fail(Result result, int err)
{
	report_.result = result;
	report_.err = err;
	return false;
}

bool SecureTransfer::io(int rc)
{
	if (rc == 0) return true;
	if (rc == -ECANCELED) return fail(Result::Aborted, rc);
	if (rc == -ETIMEDOUT) return fail(Result::Timeout, rc);
	if (rc == -ENOTCONN) return fail(Result::DeviceDisconnected, rc);
	return fail(Result::GattError, rc);
}

bool SecureTransfer::response(uint8_t opcode, uint8_t length)
{
	uint8_t n = 0;
	if (!io(channel_.receive(response_, &n))) return false;
	if (n < 3 || response_[0] != 0x60 || response_[1] != opcode)
		return fail(Result::InvalidResponse, -EPROTO);
	if (response_[2] != 1) {
		report_.remote = response_[2];
		/* Preserve the Secure extended error, not a Legacy status. */
		if ((response_[2] == 0x0B && n != 4) ||
		    (response_[2] != 0x0B && n != 3))
			return fail(Result::InvalidResponse, -EPROTO);
		return fail(Result::RemoteError, n == 4 ? response_[3] : 0);
	}
	return n == length || fail(Result::InvalidResponse, -EPROTO);
}

bool SecureTransfer::request(const uint8_t *data, uint8_t len, uint8_t response_len)
{
	return io(channel_.control(data, len)) && response(data[0], response_len);
}

bool SecureTransfer::select(uint8_t type, uint32_t &maximum, uint32_t &offset,
			    uint32_t &crc)
{
	const uint8_t cmd[] = {6, type};
	if (!request(cmd, sizeof(cmd), 15)) return false;
	maximum = le32(response_ + 3);
	offset = le32(response_ + 7);
	crc = le32(response_ + 11);
	return maximum != 0 || fail(Result::InvalidResponse, -ERANGE);
}

bool SecureTransfer::create(uint8_t type, uint32_t size)
{
	uint8_t cmd[] = {1, type, 0, 0, 0, 0};
	put32(cmd + 2, size);
	return request(cmd, sizeof(cmd));
}

bool SecureTransfer::set_prn(uint16_t count)
{
	const uint8_t cmd[] = {2, uint8_t(count), uint8_t(count >> 8)};
	packets_ = 0;
	return request(cmd, sizeof(cmd));
}

bool SecureTransfer::execute()
{
	const uint8_t cmd[] = {4};
	return request(cmd, sizeof(cmd));
}

bool SecureTransfer::checksum(uint32_t offset, uint32_t crc, bool receipt)
{
	const uint8_t cmd[] = {3};
	if (!(receipt ? response(3, 11) : request(cmd, sizeof(cmd), 11))) return false;
	if (le32(response_ + 3) != offset || le32(response_ + 7) != crc)
		return fail(Result::InvalidResponse, -EBADMSG);
	return true;
}

bool SecureTransfer::prefix(const Stream &stream, uint32_t length, uint32_t &crc)
{
	if (length > stream.size()) return fail(Result::InvalidResponse, -ERANGE);
	crc = 0;
	for (uint32_t pos = 0; pos < length;) {
		if (channel_.aborted()) return fail(Result::Aborted, -ECANCELED);
		uint32_t n = length - pos;
		if (n > sizeof(buffer_)) n = sizeof(buffer_);
		int rc = stream.read(pos, buffer_, n);
		if (rc != int(n)) return fail(Result::FileError, rc < 0 ? rc : -EIO);
		crc = secure_crc32(crc, buffer_, n);
		pos += n;
	}
	return true;
}

void SecureTransfer::progress(uint32_t offset, uint32_t total)
{
	if (observer_) observer_->on_progress(uint8_t(uint64_t(offset) * 100 / total),
					    offset, total);
}

bool SecureTransfer::send(const Stream &stream, uint32_t &offset, uint32_t end,
			  uint32_t &crc, uint16_t prn, bool show_progress)
{
	while (offset < end) {
		if (channel_.aborted()) return fail(Result::Aborted, -ECANCELED);
		uint32_t n = end - offset;
		if (n > payload_) n = payload_;
		int rc = stream.read(offset, buffer_, n);
		if (rc != int(n)) return fail(Result::FileError, rc < 0 ? rc : -EIO);
		if (!io(channel_.packet(buffer_, uint16_t(n)))) return false;
		crc = secure_crc32(crc, buffer_, n);
		offset += n;
		if (show_progress) report_.bytes_sent += n;
		if (prn && ++packets_ == prn) {
			packets_ = 0;
			if (!checksum(offset, crc, true)) return false;
		}
		if (show_progress) progress(offset, stream.size());
	}
	return true;
}

Report SecureTransfer::run(const Firmware &firmware)
{
	report_ = Report{};
	resumed_from_ = 0;
	packets_ = 0;
	if (!payload_ || payload_ > sizeof(buffer_) ||
	    firmware.type != IMAGE_APPLICATION || !firmware.image || !firmware.image->size()) {
		fail(Result::FileError, -EINVAL);
		return report_;
	}
	if (!firmware.init_packet || !firmware.init_packet->size()) {
		fail(Result::InitPacketRequired, -EINVAL);
		return report_;
	}
	const Stream &init = *firmware.init_packet;
	const Stream &image = *firmware.image;
	uint32_t maximum, offset, crc, local;
	if (!select(1, maximum, offset, crc)) return report_;
	if (init.size() > maximum) {
		fail(Result::FileError, -EFBIG);
		return report_;
	}
	/* CREATE replaces an interrupted/different command and resets its data
	 * progress, as in Nordic's Secure clients. SELECT does not expose the
	 * allocated command length: even a matching partial prefix can belong to
	 * a different-size init packet. Only reuse a complete, CRC-checked init. */
	bool same_init = false;
	if (offset == init.size()) {
		if (!prefix(init, offset, local)) return report_;
		same_init = crc == local;
	}
	if (!set_prn(0)) return report_;
	if (!same_init) {
		if (!create(1, init.size())) return report_;
		offset = crc = 0;
	}
	if (!send(init, offset, init.size(), crc, 0, false) ||
	    !checksum(offset, crc)) return report_;
	if (!execute()) {
		/* The retained bytes may exactly match this init while belonging
		 * to a longer, still-incomplete command object. On an object-state
		 * rejection only, recreate once with our known length. Validation
		 * and signature failures, I/O errors and cancellation still stop. */
		if (!same_init || report_.result != Result::RemoteError ||
		    (report_.remote != 5 && report_.remote != 8)) return report_;
		report_ = Report{};
		if (!create(1, init.size())) return report_;
		offset = crc = 0;
		if (!send(init, offset, init.size(), crc, 0, false) ||
		    !checksum(offset, crc) || !execute()) return report_;
	}

	if (!select(2, maximum, offset, crc) || !prefix(image, offset, local)) return report_;
	bool object_created = false;
	if (crc != local) {
		if (!offset) {
			fail(Result::InvalidResponse, -EBADMSG);
			return report_;
		}
		/* Nordic recovery discards the unexecuted object. A full object
		 * may not have been executed, so roll back one object at an exact
		 * boundary too. CREATE must actually return us to that boundary:
		 * verify its cumulative CRC before appending any replacement data.
		 * Never assume an executed prefix is correct merely because the
		 * target once accepted it (it may belong to another image). */
		offset = ((offset - 1) / maximum) * maximum;
		uint32_t size = image.size() - offset;
		if (size > maximum) size = maximum;
		if (!prefix(image, offset, local) || !create(2, size) ||
		    !checksum(offset, local)) return report_;
		crc = local;
		object_created = true;
	}
	resumed_from_ = offset;
	if (observer_) observer_->on_state(State::Uploading);
	progress(offset, image.size());
	/* SELECT cannot distinguish a complete unexecuted object from one whose
	 * Execute reply was lost. Re-execution is the protocol's recovery step. */
	if (!object_created && offset && (offset % maximum == 0 || offset == image.size())) {
		if (!execute()) {
			/* SDK 15-17 return OPERATION_NOT_PERMITTED for an already
			 * executed data object. Accept it only at a CRC-verified,
			 * non-final boundary, never for a fresh/final Execute. */
			if (offset == image.size() || report_.result != Result::RemoteError ||
			    report_.remote != 8) return report_;
			report_ = Report{};
		}
	}
	while (offset < image.size()) {
		uint32_t remaining = maximum - offset % maximum;
		if (remaining > image.size() - offset) remaining = image.size() - offset;
		if (!object_created && offset % maximum == 0 && !create(2, remaining)) return report_;
		object_created = false;
		/* Reset the PRN counter explicitly, including on a partial-object
		 * reconnect. Do not assume every Nordic receiver resets it on CREATE. */
		if (!set_prn(prn_) || !send(image, offset, offset + remaining, crc, prn_, true) ||
		    !checksum(offset, crc)) return report_;
		if (offset == image.size() && observer_) observer_->on_state(State::Validating);
		if (!execute()) return report_;
	}
	return report_;
}

} // namespace nordic::dfu::internal
