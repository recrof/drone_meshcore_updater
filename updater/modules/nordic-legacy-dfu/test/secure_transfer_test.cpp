/* SPDX-License-Identifier: BSD-3-Clause */
#include "secure_transfer.hpp"
#include <algorithm>
#include <cassert>
#include <cstdio>
#include <deque>
#include <vector>

using namespace nordic::dfu;
using namespace nordic::dfu::internal;

static uint32_t read32(const uint8_t *p)
{
	return uint32_t(p[0]) | uint32_t(p[1]) << 8 | uint32_t(p[2]) << 16 | uint32_t(p[3]) << 24;
}
static void append32(std::vector<uint8_t> &v, uint32_t n)
{
	for (unsigned i = 0; i < 4; ++i) v.push_back(uint8_t(n >> (8 * i)));
}
static uint32_t crc(const std::vector<uint8_t> &v)
{
	return secure_crc32(0, v.data(), uint32_t(v.size()));
}

/* Model of the wire contract, deliberately retaining state across Channel
 * disconnections. It forbids writes outside an open object and activation
 * before both object CRC and Execute have been requested. */
struct Target final : SecureChannel {
	std::vector<uint8_t> init, image;
	std::deque<std::vector<uint8_t>> replies;
	std::vector<uint8_t> commands;
	uint8_t selected = 1;
	uint32_t maximum = 4096, object_end = 0, committed = 0;
	uint32_t drop_at = 0, drop_execute = 0, bad_receipt = 0;
	uint16_t prn = 0, packets = 0;
	bool disconnected = false, cancelled = false, bad_select = false;
	bool init_executed = false, crc_checked = false, malformed = false;
	bool reject_duplicate_execute = false, corrupt_data_receipt = false;
	unsigned data_creates = 0, data_packets = 0;
	uint32_t reported_offset = UINT32_MAX;
	uint8_t reject_opcode = 0;

	std::vector<uint8_t> &bytes() { return selected == 1 ? init : image; }
	void reply(uint8_t op) { replies.push_back({0x60, op, 1}); }
	void receipt()
	{
		reply(3);
		append32(replies.back(), uint32_t(bytes().size()));
		append32(replies.back(), crc(bytes()) ^ ((bad_receipt || (selected == 2 && corrupt_data_receipt)) ? 1 : 0));
		bad_receipt = 0;
	}
	int control(const uint8_t *p, uint16_t n) override
	{
		if (cancelled) return -ECANCELED;
		if (disconnected) return -ENOTCONN;
		commands.push_back(p[0]);
		assert(replies.empty());
		if (p[0] == reject_opcode) {
			replies.push_back({0x60, p[0], 0x0B, 7});
			return 0;
		}
		switch (p[0]) {
		case 6:
			assert(n == 2 && (p[1] == 1 || p[1] == 2));
			selected = p[1];
			reply(6);
			append32(replies.back(), selected == 1 ? 256 : maximum);
			append32(replies.back(), reported_offset != UINT32_MAX ? reported_offset : uint32_t(bytes().size()));
			append32(replies.back(), crc(bytes()) ^ (bad_select ? 1 : 0));
			break;
		case 2:
			assert(n == 3);
			prn = uint16_t(p[1]) | uint16_t(p[2]) << 8;
			packets = 0;
			reply(2);
			break;
		case 1:
			assert(n == 6 && p[1] == selected);
			if (selected == 1) { init.clear(); init_executed = false; }
			else { assert(init_executed); image.resize(committed); ++data_creates; }
			object_end = uint32_t(bytes().size()) + read32(p + 2);
			assert(read32(p + 2) > 0 && read32(p + 2) <= (selected == 1 ? 256 : maximum));
			crc_checked = false;
			/* Counter intentionally survives CREATE. */
			reply(1);
			break;
		case 3:
			assert(n == 1);
			crc_checked = true;
			receipt();
			break;
		case 4:
			assert(n == 1);
			if (selected == 1) {
				assert(!init.empty() && (init_executed || (crc_checked && init.size() == object_end)));
				init_executed = true;
			} else {
				assert(!image.empty() && (committed == image.size() || image.size() == object_end));
				if (reject_duplicate_execute && committed == image.size()) {
					replies.push_back({0x60, 4, 8});
					return 0;
				}
				committed = uint32_t(image.size());
				if (drop_execute == committed) { disconnected = true; return -ENOTCONN; }
			}
			reply(4);
			break;
		default: assert(false && "unexpected opcode, especially RESET/ABORT");
		}
		return 0;
	}
	int packet(const uint8_t *p, uint16_t n) override
	{
		if (cancelled) return -ECANCELED;
		if (disconnected) return -ENOTCONN;
		assert(n && n <= 244 && bytes().size() + n <= object_end);
		if (selected == 2) {
			++data_packets;
			if (drop_at && image.size() < drop_at && image.size() + n >= drop_at) {
				image.insert(image.end(), p, p + drop_at - image.size());
				disconnected = true;
				return -ENOTCONN;
			}
		}
		bytes().insert(bytes().end(), p, p + n);
		if (prn && ++packets == prn) { packets = 0; receipt(); }
		return 0;
	}
	int receive(uint8_t *p, uint8_t *n) override
	{
		if (cancelled) return -ECANCELED;
		if (disconnected) return -ENOTCONN;
		if (replies.empty()) return -ETIMEDOUT;
		auto r = replies.front(); replies.pop_front();
		if (malformed) r = {0x60, 6};
		*n = uint8_t(r.size());
		std::copy(r.begin(), r.end(), p);
		return 0;
	}
	bool aborted() const override { return cancelled; }
	void reconnect() { disconnected = false; drop_at = drop_execute = 0; replies.clear(); }
};

struct Progress : Observer {
	uint32_t first = UINT32_MAX, last = 0;
	void on_progress(uint8_t percent, uint32_t offset, uint32_t total) override
	{
		assert(offset <= total && percent == uint64_t(offset) * 100 / total);
		if (first == UINT32_MAX) first = offset;
		assert(offset >= last);
		last = offset;
	}
};

int main()
{
	const uint8_t check[] = "123456789";
	assert(secure_crc32(0, check, 9) == 0xCBF43926);
	assert(secure_crc32(secure_crc32(0, check, 4), check + 4, 5) == 0xCBF43926);
	std::vector<uint8_t> image(10003), init(159);
	for (size_t i = 0; i < image.size(); ++i) image[i] = uint8_t(i * 37 + i / 7);
	for (size_t i = 0; i < init.size(); ++i) init[i] = uint8_t(i * 19 + 3);
	MemoryStream image_stream(image.data(), uint32_t(image.size()));
	MemoryStream init_stream(init.data(), uint32_t(init.size()));
	Firmware fw;
	fw.image = &image_stream;
	fw.init_packet = &init_stream;
	unsigned tests = 2;
	for (uint16_t payload : {20, 244}) for (uint16_t prn : {0, 1, 8, 12, 65535}) {
		Target t;
		Progress p;
		SecureTransfer transfer(t, &p, payload, prn);
		auto r = transfer.run(fw);
		assert(r.result == Result::Success && r.bytes_sent == image.size());
		assert(t.init == init && t.image == image && p.last == image.size());
		++tests;
	}
	for (uint32_t offset : {1, 20, 244, 4095, 4096, 4097, 8192, 10003}) {
		Target t;
		t.drop_at = offset;
		SecureTransfer first(t, nullptr, 244, 8);
		assert(first.run(fw).result == Result::DeviceDisconnected);
		assert(t.image.size() == offset);
		t.reconnect();
		Progress p;
		SecureTransfer resume(t, &p, 20, 12);
		auto r = resume.run(fw);
		assert(r.result == Result::Success && r.bytes_sent == image.size() - offset);
		assert(resume.resumed_from() == offset && p.first == offset && t.image == image);
		++tests;
	}
	for (uint32_t offset : {4096, 8192, 10003}) {
		Target t;
		t.drop_execute = offset;
		SecureTransfer first(t, nullptr, 244, 8);
		assert(first.run(fw).result == Result::DeviceDisconnected);
		t.reconnect();
		SecureTransfer resume(t, nullptr, 244, 8);
		assert(resume.run(fw).result == Result::Success && t.image == image);
		++tests;
	}
	for (uint32_t offset : {4096, 8192, 10003}) {
		Target t;
		t.drop_execute = offset;
		SecureTransfer first(t, nullptr, 244, 8);
		assert(first.run(fw).result == Result::DeviceDisconnected);
		t.reconnect();
		t.reject_duplicate_execute = true;
		SecureTransfer resume(t, nullptr, 244, 8);
		auto r = resume.run(fw);
		/* SDK duplicate Execute quirk is not permission to ignore a
		 * rejected final activation. */
		assert(r.result == (offset == image.size() ? Result::RemoteError : Result::Success));
		++tests;
	}
	for (uint32_t offset : {1, 158, 159}) {
		Target t;
		t.init.assign(init.begin(), init.begin() + offset);
		t.object_end = uint32_t(init.size());
		SecureTransfer transfer(t, nullptr, 20, 8);
		assert(transfer.run(fw).result == Result::Success && t.init == init && t.image == image);
		++tests;
	}
	for (int fault = 0; fault < 8; ++fault) {
		Target t;
		Firmware invalid = fw;
		if (fault == 0) t.bad_select = true;
		if (fault == 1) t.reported_offset = 0xFFFFFFFE;
		if (fault == 2) t.maximum = 0;
		if (fault == 3) t.malformed = true;
		if (fault == 4) t.reject_opcode = 1;
		if (fault == 5) t.cancelled = true;
		if (fault == 6) invalid.type = IMAGE_BOOTLOADER;
		if (fault == 7) invalid.init_packet = nullptr;
		SecureTransfer transfer(t, nullptr, 244, 8);
		auto r = transfer.run(invalid);
		assert(r.result != Result::Success && t.data_packets == 0 && t.data_creates == 0);
		if (fault == 4) assert(r.remote == 0x0B && r.err == 7);
		++tests;
	}
	/* A bad PRN is never executed. The caller can disconnect/retry, but the
	 * core does not silently overwrite a possibly different image. */
	Target t;
	t.bad_receipt = 1; // corrupt the command checksum first
	SecureTransfer transfer(t, nullptr, 244, 8);
	assert(transfer.run(fw).result == Result::InvalidResponse && !t.init_executed);
	++tests;
	Target bad_prn;
	bad_prn.corrupt_data_receipt = true;
	SecureTransfer prn_transfer(bad_prn, nullptr, 244, 1);
	assert(prn_transfer.run(fw).result == Result::InvalidResponse && bad_prn.committed == 0);
	++tests;
	Target mismatch;
	mismatch.drop_at = 5000;
	SecureTransfer interrupted(mismatch, nullptr, 244, 8);
	assert(interrupted.run(fw).result == Result::DeviceDisconnected);
	mismatch.reconnect();
	mismatch.image[0] ^= 1;
	unsigned creates = mismatch.data_creates, writes = mismatch.data_packets;
	SecureTransfer refuse(mismatch, nullptr, 244, 8);
	assert(refuse.run(fw).result == Result::InvalidResponse);
	assert(mismatch.data_creates == creates && mismatch.data_packets == writes);
	++tests;
	class ShortStream final : public Stream {
	public:
		uint32_t size() const override { return 10003; }
		int read(uint32_t, uint8_t *, uint32_t) const override { return 0; }
	} short_stream;
	Target short_target;
	Firmware short_fw = fw;
	short_fw.image = &short_stream;
	SecureTransfer short_transfer(short_target, nullptr, 244, 8);
	assert(short_transfer.run(short_fw).result == Result::FileError && short_target.data_packets == 0);
	++tests;
	std::printf("PASS: %u Secure DFU protocol cases\n", tests);
}
