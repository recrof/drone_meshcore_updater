/*
 * Nordic Legacy DFU client for Zephyr — firmware byte sources.
 *
 * Direct port of the protocol implemented by
 * no.nordicsemi.android.dfu.LegacyDfuImpl (Android-DFU-Library).
 *
 * SPDX-License-Identifier: BSD-3-Clause
 */
#pragma once

#include <stdint.h>
#include <string.h>
#include <errno.h>

namespace nordic {
namespace dfu {

/**
 * A read-only view of firmware bytes.
 *
 * The Java implementation reads from an InputStream and relies on
 * mark()/reset() to rewind. Since Legacy DFU never rewinds mid-transfer
 * (unlike Secure DFU, which retries objects on CRC mismatch), this
 * interface is offset-addressed: it removes the stream-position state
 * entirely without changing any observable protocol behaviour.
 *
 * Implementations are called only from the DFU thread.
 */
class Stream {
public:
	virtual ~Stream() = default;

	/** Total number of bytes this stream can produce. */
	virtual uint32_t size() const = 0;

	/**
	 * Read up to @p len bytes starting at @p offset.
	 *
	 * @return number of bytes read (short only at end-of-stream), or a
	 *         negative errno. A short read where bytes were expected is
	 *         reported by the client as Result::FileError, matching
	 *         DfuBaseService.ERROR_FILE_IO_EXCEPTION.
	 */
	virtual int read(uint32_t offset, uint8_t *dst, uint32_t len) const = 0;
};

/** A Stream over a buffer in RAM or memory-mapped flash. */
class MemoryStream final : public Stream {
public:
	MemoryStream() = default;
	MemoryStream(const uint8_t *data, uint32_t len) : data_(data), len_(len) {}

	void assign(const uint8_t *data, uint32_t len)
	{
		data_ = data;
		len_ = len;
	}

	uint32_t size() const override { return len_; }

	int read(uint32_t offset, uint8_t *dst, uint32_t len) const override
	{
		if (data_ == nullptr || offset > len_) {
			return -EINVAL;
		}
		uint32_t avail = len_ - offset;
		uint32_t n = (len < avail) ? len : avail;
		memcpy(dst, data_ + offset, n);
		return static_cast<int>(n);
	}

private:
	const uint8_t *data_ = nullptr;
	uint32_t len_ = 0;
};

/**
 * Two streams presented as one contiguous image.
 *
 * A SoftDevice+Bootloader update is sent as a single byte stream with the
 * SoftDevice first, while the two sizes are announced separately in the
 * Start DFU packet. This is what ArchiveInputStream does when it
 * concatenates softdevice.bin and bootloader.bin.
 */
class ConcatStream final : public Stream {
public:
	ConcatStream() = default;
	ConcatStream(const Stream *first, const Stream *second)
		: first_(first), second_(second) {}

	void assign(const Stream *first, const Stream *second)
	{
		first_ = first;
		second_ = second;
	}

	uint32_t size() const override
	{
		return (first_ ? first_->size() : 0) + (second_ ? second_->size() : 0);
	}

	int read(uint32_t offset, uint8_t *dst, uint32_t len) const override
	{
		const uint32_t first_len = first_ ? first_->size() : 0;
		uint32_t done = 0;

		if (offset < first_len) {
			uint32_t want = first_len - offset;
			if (want > len) {
				want = len;
			}
			int rc = first_->read(offset, dst, want);
			if (rc < 0) {
				return rc;
			}
			done += static_cast<uint32_t>(rc);
			if (static_cast<uint32_t>(rc) < want) {
				return static_cast<int>(done);
			}
		}

		if (done < len && second_ != nullptr) {
			const uint32_t second_off =
				(offset + done > first_len) ? (offset + done - first_len) : 0;
			int rc = second_->read(second_off, dst + done, len - done);
			if (rc < 0) {
				return (done > 0) ? static_cast<int>(done) : rc;
			}
			done += static_cast<uint32_t>(rc);
		}

		return static_cast<int>(done);
	}

private:
	const Stream *first_ = nullptr;
	const Stream *second_ = nullptr;
};

} /* namespace dfu */
} /* namespace nordic */
