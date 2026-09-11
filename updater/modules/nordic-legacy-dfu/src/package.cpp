/* SPDX-License-Identifier: BSD-3-Clause */
#include "nordic_dfu/package.hpp"
#include <stddef.h>

namespace nordic::dfu {
namespace {
struct Bytes { const uint8_t *p; size_t n; };
uint32_t le(const uint8_t *p, unsigned n)
{
	uint32_t v = 0;
	for (unsigned i = 0; i < n; ++i) v |= uint32_t(p[i]) << (8 * i);
	return v;
}

bool varint(Bytes &b, uint32_t &v)
{
	v = 0;
	for (unsigned i = 0; i < 5 && b.n; ++i) {
		uint8_t c = *b.p++; --b.n;
		if (i == 4 && c > 15) return false;
		v |= uint32_t(c & 127) << (7 * i);
		if (!(c & 128)) return true;
	}
	return false;
}

/* The small, bounded subset of Nordic's dfu-cc.proto needed for preflight.
 * Reject duplicate singular/unknown fields instead of guessing which value
 * the receiver would use. Signatures and hashes are still checked there. */
struct Field { unsigned id, wire; uint32_t value; Bytes bytes; };
bool field(Bytes &b, Field &f)
{
	uint32_t key;
	if (!varint(b, key) || key < 8) return false;
	f = {key >> 3, key & 7, 0, {nullptr, 0}};
	if (f.wire == 0) return varint(b, f.value);
	if (f.wire != 2 || !varint(b, f.value) || f.value > b.n) return false;
	f.bytes = {b.p, f.value}; b.p += f.value; b.n -= f.value;
	return true;
}
bool unique(uint32_t &seen, unsigned id)
{
	if (id >= 32 || (seen & (1u << id))) return false;
	seen |= 1u << id;
	return true;
}
bool pair_message(Bytes b, unsigned max_type, bool hash)
{
	uint32_t seen = 0, type = 0; size_t len = 0;
	while (b.n) {
		Field f;
		if (!field(b, f) || !unique(seen, f.id)) return false;
		if (f.id == 1 && f.wire == 0) type = f.value;
		else if (f.id == 2 && f.wire == 2) len = f.bytes.n;
		else return false;
	}
	static const unsigned hash_sizes[] = {0, 4, 16, 32, 64};
	return seen == 6 && type <= max_type && (!hash || len == hash_sizes[type]);
}
bool init_message(Bytes b, const Firmware &fw)
{
	uint32_t seen = 0, type = 0, sd = 0, bl = 0, app = 0;
	while (b.n) {
		Field f;
		if (!field(b, f)) return false;
		if (f.id != 3 && f.id != 10 && !unique(seen, f.id)) return false;
		if (f.id == 3) {
			if (f.wire == 0) continue;
			if (f.wire != 2) return false;
			uint32_t value;
			while (f.bytes.n) if (!varint(f.bytes, value)) return false;
		} else if (f.id == 8 && f.wire == 2) {
			if (!pair_message(f.bytes, 4, true)) return false;
		} else if (f.id == 10 && f.wire == 2) {
			if (!pair_message(f.bytes, 3, false)) return false;
		} else if (f.wire == 0) {
			switch (f.id) {
			case 1: case 2: break;
			case 4: type = f.value; break;
			case 5: sd = f.value; break;
			case 6: bl = f.value; break;
			case 7: app = f.value; break;
			case 9: if (f.value > 1) return false; break;
			default: return false;
			}
		} else return false;
	}
	/* Only application Secure updates are supported. Check the .dat too:
	 * manifest type alone cannot prevent a mislabeled bootloader update. */
	return fw.type == IMAGE_APPLICATION && type == 0 && sd == 0 && bl == 0 &&
	       app == fw.image->size() && (seen & (1u << 7));
}
bool command(Bytes b, const Firmware &fw)
{
	uint32_t seen = 0, op = 0; bool init = false;
	while (b.n) {
		Field f;
		if (!field(b, f) || !unique(seen, f.id)) return false;
		if (f.id == 1 && f.wire == 0) op = f.value;
		else if (f.id == 2 && f.wire == 2) init = init_message(f.bytes, fw);
		else return false;
	}
	return op == 1 && init;
}
bool signed_command(Bytes b, const Firmware &fw)
{
	uint32_t seen = 0; bool valid = false;
	while (b.n) {
		Field f;
		if (!field(b, f) || !unique(seen, f.id)) return false;
		if (f.id == 1 && f.wire == 2) valid = command(f.bytes, fw);
		else if (f.id == 2 && f.wire == 0 && f.value <= 1) {}
		else if (f.id == 3 && f.wire == 2 && f.bytes.n == 64) {}
		else return false;
	}
	return valid && seen == 14;
}
bool secure(Bytes b, const Firmware &fw)
{
	Field f;
	if (!field(b, f) || b.n || f.wire != 2) return false;
	return (f.id == 1 && command(f.bytes, fw)) ||
	       (f.id == 2 && signed_command(f.bytes, fw));
}
bool legacy(Bytes b, const Firmware &fw)
{
	if (b.n < 12) return false;
	size_t base = 10 + 2 * le(b.p + 8, 2);
	if (base > b.n) return false;
	size_t tail = b.n - base;
	if (tail == 2) return true; // classic CRC16 init
	// Nordic proprietary hash/signed Legacy extensions, not protobuf.
	return (tail == 40 || tail == 104) &&
	       le(b.p + base, 4) == (tail == 40 ? 1u : 2u) &&
	       le(b.p + base + 4, 4) == fw.image->size();
}
}

PackageProtocol package_protocol(const Firmware &fw)
{
	/* Larger/custom layouts are unsupported, never assumed to be Legacy. */
	uint8_t data[512];
	if (!fw.image || !fw.image->size() || !fw.init_packet) return PackageProtocol::Unknown;
	uint32_t n = fw.init_packet->size();
	if (!n || n > sizeof(data) || fw.init_packet->read(0, data, n) != int(n))
		return PackageProtocol::Unknown;
	bool l = legacy({data, n}, fw), s = secure({data, n}, fw);
	if (l == s) return PackageProtocol::Unknown; // reject ambiguity as well
	return s ? PackageProtocol::Secure : PackageProtocol::Legacy;
}
}
