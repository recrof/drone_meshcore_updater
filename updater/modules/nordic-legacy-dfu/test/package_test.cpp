/* SPDX-License-Identifier: BSD-3-Clause */
#include "nordic_dfu/package.hpp"
#include <cassert>
#include <cstdio>
#include <cstring>
#include <vector>
using namespace nordic::dfu;
using Vec = std::vector<uint8_t>;

struct Memory : Stream {
	Vec data;
	bool short_read = false;
	uint32_t size() const override { return uint32_t(data.size()); }
	int read(uint32_t off, uint8_t *dst, uint32_t n) const override {
		if (off > size() || n > size() - off) return -1;
		memcpy(dst, data.data() + off, n);
		return int(n) - (short_read ? 1 : 0);
	}
};
Vec join(Vec a, const Vec &b) { a.insert(a.end(), b.begin(), b.end()); return a; }
Vec scalar(unsigned key, unsigned value) {
	Vec v{uint8_t(key << 3)};
	do { v.push_back(uint8_t(value & 127) | (value > 127 ? 128 : 0)); value >>= 7; } while (value);
	return v;
}
Vec message(unsigned key, const Vec &v) {
	Vec b = scalar(key, unsigned(v.size())); b[0] |= 2; return join(b, v);
}
int main()
{
	Memory image, dat; image.data.resize(1024);
	Firmware fw; fw.image = &image; fw.init_packet = &dat;
	const Vec init = join(scalar(4, 0), scalar(7, image.size()));
	const Vec cmd = join(scalar(1, 1), message(2, init));
	const Vec good = message(1, cmd);
	dat.data = good; assert(package_protocol(fw) == PackageProtocol::Secure);
	dat.data = message(2, join(join(message(1, cmd), scalar(2, 0)), message(3, Vec(64, 3))));
	assert(package_protocol(fw) == PackageProtocol::Secure);
	dat.data = message(1, join(scalar(1, 1), message(2, scalar(7, image.size()))));
	assert(package_protocol(fw) == PackageProtocol::Secure); // default application enum
	for (unsigned n = 0; n < good.size(); ++n) {
		dat.data = Vec(good.begin(), good.begin() + n);
		assert(package_protocol(fw) == PackageProtocol::Unknown);
	}
	for (unsigned type : {1u, 2u, 3u, 4u}) {
		dat.data = message(1, join(scalar(1, 1), message(2, join(scalar(4, type), scalar(7, image.size())))));
		assert(package_protocol(fw) == PackageProtocol::Unknown);
	}
	dat.data = message(1, join(scalar(1, 1), message(2, join(init, scalar(7, image.size())))));
	assert(package_protocol(fw) == PackageProtocol::Unknown); // duplicate app_size
	dat.data = message(1, join(scalar(1, 1), message(2, scalar(7, image.size() + 1))));
	assert(package_protocol(fw) == PackageProtocol::Unknown);
	dat.data = join(good, good); assert(package_protocol(fw) == PackageProtocol::Unknown);
	dat.data = {0x0a, 0xff, 0xff, 0xff, 0xff, 0xff};
	assert(package_protocol(fw) == PackageProtocol::Unknown);
	dat.data = good; dat.short_read = true;
	assert(package_protocol(fw) == PackageProtocol::Unknown); dat.short_read = false;
	dat.data = good; fw.type = IMAGE_BOOTLOADER;
	assert(package_protocol(fw) == PackageProtocol::Unknown); fw.type = IMAGE_APPLICATION;
	dat.data = Vec(12, 0); assert(package_protocol(fw) == PackageProtocol::Legacy);
	dat.data = Vec(14, 0); dat.data[8] = 1;
	assert(package_protocol(fw) == PackageProtocol::Legacy);
	dat.data[8] = 255; assert(package_protocol(fw) == PackageProtocol::Unknown);
	for (unsigned tail : {40u, 104u}) {
		dat.data = Vec(10 + tail, 0); dat.data[10] = tail == 40 ? 1 : 2;
		dat.data[15] = 4; // little-endian image size 1024
		assert(package_protocol(fw) == PackageProtocol::Legacy);
		dat.data[15] = 5; assert(package_protocol(fw) == PackageProtocol::Unknown);
	}
	dat.data = Vec(513, 0); assert(package_protocol(fw) == PackageProtocol::Unknown);
	// A structurally valid init packet must not authorize an invalid START
	// layout. In particular, uint32 component sums must not wrap into size().
	dat.data = Vec(12, 0);
	for (uint8_t type : {uint8_t(0), uint8_t(8), uint8_t(IMAGE_APPLICATION | 8)}) {
		fw.type = type; assert(package_protocol(fw) == PackageProtocol::Unknown);
	}
	for (uint8_t type : {uint8_t(IMAGE_APPLICATION), uint8_t(IMAGE_SOFT_DEVICE), uint8_t(IMAGE_BOOTLOADER)}) {
		fw.type = type; assert(package_protocol(fw) == PackageProtocol::Legacy);
	}
	fw.type = IMAGE_SOFT_DEVICE | IMAGE_BOOTLOADER;
	assert(package_protocol(fw) == PackageProtocol::Unknown); // missing split
	fw.softdevice_size = 512; fw.bootloader_size = 512;
	assert(package_protocol(fw) == PackageProtocol::Legacy);
	fw.bootloader_size = 511;
	assert(package_protocol(fw) == PackageProtocol::Unknown);
	fw.softdevice_size = UINT32_MAX; fw.bootloader_size = 1025;
	assert(package_protocol(fw) == PackageProtocol::Unknown);
	fw.softdevice_size = 0; fw.bootloader_size = 1024;
	assert(package_protocol(fw) == PackageProtocol::Unknown);
	fw.softdevice_size = 511; fw.bootloader_size = 512; fw.application_size = 1;
	assert(package_protocol(fw) == PackageProtocol::Unknown); // unselected component
	fw.type = IMAGE_APPLICATION; fw.softdevice_size = fw.bootloader_size = 0;
	fw.application_size = 1024;
	assert(package_protocol(fw) == PackageProtocol::Legacy);
	fw.application_size = 1023;
	assert(package_protocol(fw) == PackageProtocol::Unknown);
	puts("Package format, truncation, duplicate, size/type and signed-envelope tests passed");
}
