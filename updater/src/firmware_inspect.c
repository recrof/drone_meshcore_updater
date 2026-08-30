/*
 * Implementation notes — see firmware_inspect.h for why this exists.
 *
 * The whole file is read once, in CHUNK-sized pieces, and never held in RAM:
 * these boards have a 500 KB image and nowhere to put it. Both checksums are
 * therefore incremental, and the ESP32 probe reads only the few dozen bytes
 * it needs at each offset it is interested in.
 */

#include "firmware_inspect.h"
#include "firmware_zip.h"
#include "dfu_transport.h"
#include "dfu_runner.h"

#include <zephyr/kernel.h>
#include <zephyr/fs/fs.h>
#include <zephyr/logging/log.h>
#include <string.h>
#include <stdio.h>

LOG_MODULE_REGISTER(fw_inspect, LOG_LEVEL_INF);

/* Big enough to amortise the per-call filesystem overhead, small enough to
 * live on the caller's stack alongside everything else mcumgr has already
 * put there. */
#define CHUNK 256

/* ---- checksums --------------------------------------------------------
 *
 * Both are anchored to their published check values by dfu-inspect.test.mjs
 * ("123456789" -> 0xCBF43926 and 0x29B1). There are several CRC-16 variants
 * in circulation differing only in seed and bit order, and one of them is
 * what the init packet is NOT.
 */

static uint32_t crc32_update(uint32_t crc, const uint8_t *p, size_t n)
{
	crc = ~crc;
	while (n--) {
		crc ^= *p++;
		for (int k = 0; k < 8; k++) {
			crc = (crc >> 1) ^ (0xEDB88320u & (uint32_t)(-(int32_t)(crc & 1)));
		}
	}
	return ~crc;
}

static uint16_t crc16_update(uint16_t crc, const uint8_t *p, size_t n)
{
	while (n--) {
		crc ^= (uint16_t)(*p++) << 8;
		for (int k = 0; k < 8; k++) {
			crc = (crc & 0x8000u) ? (uint16_t)((crc << 1) ^ 0x1021u)
					      : (uint16_t)(crc << 1);
		}
	}
	return crc;
}

/* CRC a byte range of an open file without holding it in memory. */
static int crc_range(struct fs_file_t *f, uint32_t off, uint32_t len,
		     uint32_t *crc32_out, uint16_t *crc16_out)
{
	uint8_t buf[CHUNK];
	uint32_t c32 = 0;
	uint16_t c16 = 0xFFFF;

	int rc = fs_seek(f, off, FS_SEEK_SET);
	if (rc < 0) return rc;
	while (len) {
		uint32_t n = len > sizeof(buf) ? sizeof(buf) : len;
		rc = fs_read(f, buf, n);
		if (rc < 0) return rc;
		if ((uint32_t)rc != n) return -EIO;
		if (crc32_out) c32 = crc32_update(c32, buf, n);
		if (crc16_out) c16 = crc16_update(c16, buf, n);
		len -= n;
	}
	if (crc32_out) *crc32_out = c32;
	if (crc16_out) *crc16_out = c16;
	return 0;
}

/* ---- transports this build has ---------------------------------------- */

uint32_t firmware_transports(void)
{
	uint32_t mask = 0;
	size_t count = 0;
	const struct dfu_transport *const *list = dfu_transport_list(&count);

	/* Read off the table rather than listed here. A transport that is
	 * compiled out is one this build genuinely cannot use, and saying
	 * otherwise would have the client accept an upload for a flash that
	 * can never start. */
	for (size_t i = 0; i < count; i++) {
		if (!list[i] || !list[i]->name) continue;
		if (!strcmp(list[i]->name, "ble-legacy-dfu")) mask |= FW_TRANSPORT_BLE;
		else if (!strcmp(list[i]->name, "wifi-elegantota")) mask |= FW_TRANSPORT_WIFI;
	}
	return mask;
}

/* ---- names we refuse without reading ---------------------------------- */

static bool ends_with_ci(const char *s, const char *suffix)
{
	size_t sn = strlen(s), su = strlen(suffix);
	if (sn < su) return false;
	const char *t = s + sn - su;
	for (size_t i = 0; i < su; i++) {
		char a = t[i], b = suffix[i];
		if (a >= 'A' && a <= 'Z') a += 32;
		if (b >= 'A' && b <= 'Z') b += 32;
		if (a != b) return false;
	}
	return true;
}

bool firmware_name_acceptable(const char *name, const char **why)
{
	static const struct { const char *ext; const char *why; } rejected[] = {
		{ ".uf2", "a .uf2 is for a bootloader's mass-storage drive, not for "
			  "any transport this updater speaks" },
		{ ".hex", "Intel HEX is a probe format; a DFU target takes a packaged "
			  ".zip or a raw application .bin" },
		{ ".elf", "an .elf is an unlinked debug artifact, not a flashable image" },
		{ ".img", "unrecognised container; upload the .zip or the application .bin" },
	};

	if (!name) return true;
	for (size_t i = 0; i < ARRAY_SIZE(rejected); i++) {
		if (ends_with_ci(name, rejected[i].ext)) {
			if (why) *why = rejected[i].why;
			return false;
		}
	}
	if (why) *why = NULL;
	return true;
}

/* ---- ESP32 image probing ---------------------------------------------- */

#define ESP_IMAGE_MAGIC     0xE9u
#define ESP_APP_DESC_MAGIC  0xABCD5432u
#define ESP_APP_DESC_OFF    0x20u

static const struct { uint16_t id; const char *name; } esp_chips[] = {
	{ 0x0000, "ESP32" },   { 0x0002, "ESP32-S2" }, { 0x0005, "ESP32-C3" },
	{ 0x0009, "ESP32-S3" }, { 0x000C, "ESP32-C2" }, { 0x000D, "ESP32-C6" },
	{ 0x0010, "ESP32-H2" },
};

/* Copy a fixed-width, possibly unterminated field out of a descriptor. */
static void copy_field(char *dst, size_t dst_sz, const uint8_t *src, size_t n)
{
	size_t i = 0;
	for (; i < n && i < dst_sz - 1 && src[i]; i++) {
		dst[i] = (src[i] >= 0x20 && src[i] < 0x7F) ? (char)src[i] : '?';
	}
	dst[i] = '\0';
}

/* Read an esp_app_desc_t at `at`. Returns true when the magic matches. */
static bool esp_app_desc(struct fs_file_t *f, uint32_t at, struct fw_inspect *out)
{
	uint8_t d[144];
	if (firmware_zip_read_at(f, at, d, sizeof(d)) < 0) return false;
	uint32_t magic = d[0] | ((uint32_t)d[1] << 8) | ((uint32_t)d[2] << 16) |
			 ((uint32_t)d[3] << 24);
	if (magic != ESP_APP_DESC_MAGIC) return false;
	if (out) {
		copy_field(out->version, sizeof(out->version), &d[16], 32);
		copy_field(out->name, sizeof(out->name), &d[48], 32);
	}
	return true;
}

/* Offsets an application is merged to: 0x10000 is the Arduino/PlatformIO
 * default that MeshCore's own ESP32 builds use, 0x20000 is this project's
 * MCUboot layout. */
static const uint32_t esp_merged_offsets[] = { 0x10000u, 0x20000u };

static void inspect_esp(struct fs_file_t *f, uint32_t size, struct fw_inspect *out)
{
	uint8_t hdr[24];
	if (firmware_zip_read_at(f, 0, hdr, sizeof(hdr)) < 0 || hdr[0] != ESP_IMAGE_MAGIC) {
		out->kind = FW_KIND_UNKNOWN;
		snprintf(out->reason, sizeof(out->reason),
			 "not a ZIP and not an ESP32 image");
		return;
	}

	uint16_t chip_id = hdr[12] | ((uint16_t)hdr[13] << 8);
	for (size_t i = 0; i < ARRAY_SIZE(esp_chips); i++) {
		if (esp_chips[i].id == chip_id) {
			strncpy(out->chip, esp_chips[i].name, sizeof(out->chip) - 1);
			break;
		}
	}
	if (!out->chip[0]) snprintf(out->chip, sizeof(out->chip), "chip id 0x%02x", chip_id);

	if (esp_app_desc(f, ESP_APP_DESC_OFF, out)) {
		out->kind = FW_KIND_ESP_APP;
		out->transport = FW_TRANSPORT_WIFI;
		out->image_bytes = size;
		out->ok = true;
		return;
	}

	/* No application descriptor at the front: whatever is at offset 0 is
	 * not an application, and on a file this size that means a bootloader. */
	out->kind = FW_KIND_ESP_MERGED;
	for (size_t i = 0; i < ARRAY_SIZE(esp_merged_offsets); i++) {
		uint32_t at = esp_merged_offsets[i];
		if (at + ESP_APP_DESC_OFF + 144 > size) continue;
		if (!esp_app_desc(f, at + ESP_APP_DESC_OFF, out)) continue;
		snprintf(out->reason, sizeof(out->reason),
			 "merged image: bootloader at 0, application at 0x%x — "
			 "upload the application alone", (unsigned)at);
		return;
	}
	snprintf(out->reason, sizeof(out->reason),
		 "ESP32 image with no application descriptor — a bootloader alone");
}

/* ---- legacy init packet ------------------------------------------------
 *
 *   u16 device_type, u16 device_revision, u32 application_version,
 *   u16 softdevice_count, u16 softdevice[count], u16 firmware_crc16
 *
 * The length is fully determined by the count, so a buffer that does not
 * match exactly is a different format — an extended packet, which carries a
 * hash — rather than a corrupt one. That is reported, not failed.
 */
static bool parse_init_packet(struct fs_file_t *f, const struct zip_entry *dat,
			      uint16_t *device_type, uint16_t *crc16_out)
{
	uint8_t b[64];
	if (dat->size < 12 || dat->size > sizeof(b)) return false;
	if (firmware_zip_read_at(f, dat->data_offset, b, dat->size) < 0) return false;
	uint16_t count = b[8] | ((uint16_t)b[9] << 8);
	if (dat->size != (uint32_t)(10 + count * 2 + 2)) return false;
	*device_type = b[0] | ((uint16_t)b[1] << 8);
	*crc16_out = b[10 + count * 2] | ((uint16_t)b[11 + count * 2] << 8);
	return true;
}

/* ---- the ZIP path ------------------------------------------------------ */

static void inspect_zip(struct fs_file_t *f, const char *path,
			struct fw_inspect *out)
{
	struct zip_entry e;
	struct zip_entry manifest = { 0 }, bin = { 0 }, dat = { 0 };
	bool have_manifest = false;
	uint32_t cursor = 0;
	int entries = 0;

	/* One pass to find and verify everything. The CRC is the expensive
	 * part and is what makes this O(size). */
	while (entries < 32) {
		uint32_t next;
		int rc = firmware_zip_next(f, cursor, &e, &next);
		if (rc < 0) {
			snprintf(out->reason, sizeof(out->reason),
				 "unreadable at offset %u", (unsigned)cursor);
			return;
		}
		if (rc == 1) break;
		entries++;

		if (e.streamed) {
			snprintf(out->reason, sizeof(out->reason),
				 "%.40s: size is in a trailing descriptor, not "
				 "the header", e.name);
			return;
		}
		if (e.method != 0) {
			snprintf(out->reason, sizeof(out->reason),
				 "%.40s: compressed (method %u); this reader is "
				 "STORE-only", e.name, e.method);
			return;
		}
		if (e.name_len >= ZIP_NAME_MAX) {
			snprintf(out->reason, sizeof(out->reason),
				 "a file name is %u chars; the limit here is %u",
				 e.name_len, ZIP_NAME_MAX - 1);
			return;
		}

		uint32_t crc = 0;
		if (crc_range(f, e.data_offset, e.size, &crc, NULL) < 0) {
			snprintf(out->reason, sizeof(out->reason),
				 "%.40s: could not be read to the end", e.name);
			return;
		}
		if (crc != e.crc32) {
			snprintf(out->reason, sizeof(out->reason),
				 "%.40s fails its CRC-32 — the archive is damaged",
				 e.name);
			return;
		}

		if (!strcmp(e.name, "manifest.json")) { manifest = e; have_manifest = true; }
		cursor = next;
	}

	if (!entries) {
		snprintf(out->reason, sizeof(out->reason), "no ZIP entries found");
		return;
	}
	if (!have_manifest) {
		snprintf(out->reason, sizeof(out->reason), "no manifest.json in the archive");
		return;
	}

	/* Which of the two kinds of .zip is this? The legacy package has a
	 * "manifest" object; this project's own MCUboot bundle has a "files"
	 * array. Same extension, same conventional name, unrelated schema. */
	char mbuf[512];
	uint32_t mlen = manifest.size < sizeof(mbuf) - 1 ? manifest.size : sizeof(mbuf) - 1;
	if (firmware_zip_read_at(f, manifest.data_offset, mbuf, mlen) < 0) {
		snprintf(out->reason, sizeof(out->reason), "manifest.json unreadable");
		return;
	}
	mbuf[mlen] = '\0';
	if (!strstr(mbuf, "\"manifest\"") && strstr(mbuf, "\"files\"")) {
		out->kind = FW_KIND_NCS_ZIP;
		snprintf(out->reason, sizeof(out->reason),
			 "an MCUboot bundle for this device, not target firmware — "
			 "use the Bluetooth update route");
		return;
	}

	/* Beyond here the streaming parser is the authority, so ask it rather
	 * than keeping a second copy of section detection and bin/dat
	 * resolution — the point of validating is to agree with the thing that
	 * will actually read the file.
	 *
	 * It uses the module's single archive handle, which is why the caller
	 * refuses to run while a DFU does. */
	struct firmware_bundle bundle;
	char err[64];
	int rc = firmware_zip_open(path, &bundle, err, sizeof(err));
	if (rc < 0) {
		snprintf(out->reason, sizeof(out->reason), "%s", err);
		firmware_zip_close();
		return;
	}
	bin = bundle.bin;
	dat = bundle.dat;
	firmware_zip_close();

	out->kind = FW_KIND_NORDIC_ZIP;
	out->transport = FW_TRANSPORT_BLE;
	out->image_bytes = bin.size;

	/* The check nothing else makes: does the init packet describe the
	 * image sitting beside it? Everything above passes on a package whose
	 * .dat and .bin came from different builds, and the target only finds
	 * out after receiving all of it. */
	uint16_t want = 0, dev = 0;
	if (parse_init_packet(f, &dat, &dev, &want)) {
		uint16_t got = 0;
		out->device_type = dev;
		if (crc_range(f, bin.data_offset, bin.size, NULL, &got) < 0) {
			snprintf(out->reason, sizeof(out->reason), "image unreadable");
			return;
		}
		if (got != want) {
			snprintf(out->reason, sizeof(out->reason),
				 "init packet expects image CRC 0x%04x, image is "
				 "0x%04x — .dat and .bin are from different builds",
				 want, got);
			return;
		}
	}
	out->ok = true;
}

/* ---- entry point ------------------------------------------------------- */

int firmware_inspect(const char *path, struct fw_inspect *out)
{
	struct fs_file_t f;
	struct fs_dirent st;

	memset(out, 0, sizeof(*out));
	out->kind = FW_KIND_UNKNOWN;

	const char *why = NULL;
	if (!firmware_name_acceptable(path, &why)) {
		snprintf(out->reason, sizeof(out->reason), "%s", why);
		return 0;
	}

	/* inspect_zip() borrows firmware_zip.c's single archive handle for the
	 * manifest half, and that handle belongs to a running transfer. Refuse
	 * rather than reposition it: a DFU that fails because something asked
	 * an unrelated question is a bug with no visible cause. */
	if (dfu_runner_busy()) {
		snprintf(out->reason, sizeof(out->reason),
			 "a DFU is running — ask again when it finishes");
		return -EBUSY;
	}

	int rc = fs_stat(path, &st);
	if (rc < 0) {
		snprintf(out->reason, sizeof(out->reason), "not found");
		return rc;
	}

	fs_file_t_init(&f);
	rc = fs_open(&f, path, FS_O_READ);
	if (rc < 0) {
		snprintf(out->reason, sizeof(out->reason), "open failed (%d)", rc);
		return rc;
	}

	uint8_t magic[4] = { 0 };
	(void)firmware_zip_read_at(&f, 0, magic, sizeof(magic));
	bool zipish = magic[0] == 'P' && magic[1] == 'K' && magic[2] == 0x03 && magic[3] == 0x04;

	if (zipish) {
		inspect_zip(&f, path, out);
	} else {
		inspect_esp(&f, st.size, out);
	}
	fs_close(&f);

	uint32_t have = firmware_transports();
	out->flashable = out->ok && out->transport && (have & out->transport);
	if (out->ok && !out->flashable) {
		snprintf(out->reason, sizeof(out->reason),
			 out->transport == FW_TRANSPORT_WIFI
				 ? "needs the WiFi/ElegantOTA transport, which this build does not have"
				 : "needs a transport this build does not have");
	}

	LOG_INF("inspect %s: kind=%u ok=%d flashable=%d%s%s", path, out->kind,
		out->ok, out->flashable, out->reason[0] ? " — " : "", out->reason);
	return 0;
}
