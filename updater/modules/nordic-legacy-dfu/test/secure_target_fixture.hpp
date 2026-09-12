/* SPDX-License-Identifier: BSD-3-Clause */
#pragma once
#include "secure_transfer.hpp"
#include <algorithm>
#include <cassert>
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
	uint32_t maximum = 4096, image_size = 10003, object_end = 0, committed = 0;
	uint32_t drop_at = 0, drop_execute = 0, bad_receipt = 0;
	uint16_t prn = 0, packets = 0;
	bool disconnected = false, cancelled = false, bad_select = false;
	bool init_executed = false, crc_checked = false, malformed = false;
	bool failed = false, completed = false;
	bool reject_duplicate_execute = false, corrupt_data_receipt = false;
	unsigned init_creates = 0, data_creates = 0, data_packets = 0;
	uint32_t reported_offset = UINT32_MAX;
	uint8_t reject_opcode = 0;
	uint8_t incomplete_init_error = 5;

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
			if (failed || completed) {
				replies.push_back({0x60, 1, 8});
				return 0;
			}
			if (selected == 2) {
				assert(committed <= image_size);
				if (!init_executed) {
					replies.push_back({0x60, 1, 8});
					return 0;
				}
				const uint32_t expected = std::min(maximum, image_size - committed);
				if (!read32(p + 2) || read32(p + 2) != expected) {
					replies.push_back({0x60, 1, 3});
					return 0;
				}
			}
			if (selected == 1) {
				init.clear(); init_executed = false; ++init_creates;
				image.clear(); committed = 0;
			}
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
			if (failed) {
				replies.push_back({0x60, 4, 10});
				return 0;
			}
			if (selected == 1) {
				if (!init_executed && init.size() != object_end) {
					replies.push_back({0x60, 4, incomplete_init_error});
					return 0;
				}
				assert(!init.empty() && (init_executed || (crc_checked && init.size() == object_end)));
				init_executed = true;
			} else {
				assert(!image.empty() && (committed == image.size() || image.size() == object_end));
				if (reject_duplicate_execute && committed == image.size()) {
					replies.push_back({0x60, 4, 8});
					return 0;
				}
				committed = uint32_t(image.size());
				completed = committed == image_size;
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
		assert(!failed && !completed && n && n <= 244 && bytes().size() + n <= object_end);
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
