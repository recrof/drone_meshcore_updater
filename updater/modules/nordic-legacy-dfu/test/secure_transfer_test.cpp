/* SPDX-License-Identifier: BSD-3-Clause */
#include "secure_transfer.hpp"
#include <algorithm>
#include <cassert>
#include <cstdio>
#include <deque>
#include <vector>

using namespace nordic::dfu;
using namespace nordic::dfu::internal;

#include "secure_target_fixture.hpp"
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
	/* Command SELECT does not report the allocated object length. Recreate
	 * both mismatched commands and matching partial prefixes with a different
	 * length, resetting old data progress before sending the new image. */
	for (uint32_t length : {1, 100, 158, 159, 200}) {
		Target t;
		t.init.assign(init.begin(), init.begin() + std::min<size_t>(length, init.size()));
		t.init.resize(length, 0x5a);
		if (length == init.size()) t.init[0] ^= 1;
		t.init_executed = true;
		t.image.assign(5000, 0xa5);
		t.committed = 4096;
		t.object_end = 8192;
		SecureTransfer transfer(t, nullptr, 244, 8);
		auto r = transfer.run(fw);
		assert(r.result == Result::Success && r.bytes_sent == image.size());
		assert(t.init_creates == 1 && transfer.resumed_from() == 0);
		assert(t.init == init && t.image == image);
		++tests;
	}
	/* Recover each unexecuted-object shape, including a full page and the
	 * short final page. A corrupted retained packet must be replaced, not
	 * appended to or executed. CREATE's rollback CRC is checked first. */
	for (uint8_t error : {5, 8}) {
		Target t;
		t.init = init;
		t.object_end = 200; // Complete local init, incomplete remote object.
		t.incomplete_init_error = error;
		SecureTransfer recovery(t, nullptr, 244, 8);
		assert(recovery.run(fw).result == Result::Success);
		assert(t.init_creates == 1 && t.init == init && t.image == image);
		++tests;
	}
	Target rejected_init;
	rejected_init.init = init;
	rejected_init.object_end = uint32_t(init.size());
	rejected_init.reject_opcode = 4; // Extended validation failure, not object state.
	SecureTransfer reject_validation(rejected_init, nullptr, 244, 8);
	auto rejected = reject_validation.run(fw);
	assert(rejected.result == Result::RemoteError && rejected.remote == 0x0b && rejected.err == 7);
	assert(rejected_init.init_creates == 0 && rejected_init.data_packets == 0);
	++tests;
	for (uint32_t offset : {1, 20, 244, 4095, 4096, 4097, 8192, 10003}) {
		Target t;
		t.drop_at = offset;
		SecureTransfer first(t, nullptr, 244, 8);
		assert(first.run(fw).result == Result::DeviceDisconnected);
		t.image.back() ^= 1;
		t.reconnect();
		Progress p;
		SecureTransfer recovery(t, &p, 20, 12);
		auto r = recovery.run(fw);
		uint32_t boundary = ((offset - 1) / t.maximum) * t.maximum;
		assert(r.result == Result::Success && r.bytes_sent == image.size() - boundary);
		assert(recovery.resumed_from() == boundary && p.first == boundary);
		assert(t.init_creates == 1 && t.image == image);
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
	/* A bad live PRN is never executed. A subsequent attempt can CREATE
	 * the unexecuted object, but only after verifying its rollback boundary. */
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
	assert(mismatch.data_creates == creates + 1 && mismatch.data_packets == writes);
	++tests;
	/* A mismatch in an already executed page cannot be fixed by discarding
	 * its successor. Do not append at a guessed earlier boundary. */
	Target committed_bad;
	committed_bad.drop_execute = 8192;
	SecureTransfer committed_first(committed_bad, nullptr, 244, 8);
	assert(committed_first.run(fw).result == Result::DeviceDisconnected);
	committed_bad.reconnect();
	committed_bad.image.back() ^= 1;
	writes = committed_bad.data_packets;
	SecureTransfer committed_refuse(committed_bad, nullptr, 244, 8);
	/* The receiver is already at the short final object. A proposed full
	 * previous-page CREATE is invalid there and must not write anything. */
	assert(committed_refuse.run(fw).result == Result::RemoteError);
	assert(committed_bad.data_packets == writes);
	++tests;
	/* Receiver contract guards: only the exact final-object length is
	 * accepted, and CREATE cannot reuse a failed or completed session. */
	for (uint32_t size : {0, 1, 1810, 1811, 1812, 4096}) {
		Target guard;
		guard.selected = 2;
		guard.init_executed = true;
		guard.committed = 8192;
		guard.image.assign(image.begin(), image.begin() + 8192);
		std::vector<uint8_t> command{1, 2};
		append32(command, size);
		assert(guard.control(command.data(), uint16_t(command.size())) == 0);
		assert(guard.replies.front()[2] == (size == 1811 ? 1 : 3));
		assert(guard.data_creates == (size == 1811 ? 1u : 0u));
		assert(guard.data_packets == 0 && guard.image.size() == 8192);
		++tests;
	}
	for (bool completed : {false, true}) for (uint8_t type : {1, 2}) {
		Target guard;
		guard.selected = type;
		guard.completed = completed;
		guard.failed = !completed;
		std::vector<uint8_t> command{1, type};
		append32(command, type == 1 ? uint32_t(init.size()) : guard.maximum);
		assert(guard.control(command.data(), uint16_t(command.size())) == 0);
		assert(guard.replies.front()[2] == 8);
		assert(guard.init_creates == 0 && guard.data_creates == 0 && guard.data_packets == 0);
		++tests;
	}
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
