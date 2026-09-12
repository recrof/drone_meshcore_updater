/* Compile the production ZIP walker and inspector against an in-memory FS.
 * The read budget turns a cyclic archive walk into a deterministic failure,
 * rather than hanging the test process like the device would hang. */
#include "firmware_zip.h"
#include "firmware_inspect.h"
#include "dfu_transport.h"
#include <assert.h>
#include <string.h>
#include <stdlib.h>

static uint8_t archive[16384];
static uint32_t archive_size;
static unsigned reads;
static bool start_dfu_on_read;
static struct firmware_bundle active_bundle;
static uint8_t active_archive[sizeof(archive)];
static uint32_t active_archive_size;
static struct { uint32_t offset; uint16_t name_size; } entries[64];
static unsigned entry_count;

void fs_file_t_init(struct fs_file_t *f) { memset(f, 0, sizeof(*f)); }
int fs_open(struct fs_file_t *f, const char *path, int flags)
{
	(void)flags;
	f->open = 1;
	f->position = 0;
	f->data = !strcmp(path, "active.zip") ? active_archive : archive;
	f->size = !strcmp(path, "active.zip") ? active_archive_size : archive_size;
	return 0;
}
int fs_close(struct fs_file_t *f) { f->open = 0; return 0; }
int fs_seek(struct fs_file_t *f, off_t offset, int whence)
{
	int64_t position = (int64_t)offset + (whence == FS_SEEK_END ? f->size : 0);
	if (!f->open || position < 0 || (uint64_t)position > UINT32_MAX) return -EINVAL;
	f->position = (uint32_t)position;
	return 0;
}
off_t fs_tell(struct fs_file_t *f) { return f->open ? (off_t)f->position : -EBADF; }
ssize_t fs_read(struct fs_file_t *f, void *buf, size_t n)
{
	/* A malformed archive must be rejected without an unbounded walk. */
	assert(++reads < 10000);
	if (start_dfu_on_read) {
		/* A run starts after inspection's idle check but before manifest
		 * resolution. Its singleton must survive the rest of inspection. */
		start_dfu_on_read = false;
		char error[128];
		assert(firmware_zip_open("active.zip", &active_bundle, error, sizeof(error)) == 0);
	}
	if (!f->open) return -EBADF;
	if (f->position >= f->size) return 0;
	if (n > f->size - f->position) n = f->size - f->position;
	memcpy(buf, f->data + f->position, n);
	f->position += (uint32_t)n;
	return (ssize_t)n;
}
int fs_stat(const char *path, struct fs_dirent *out)
{
	(void)path;
	out->size = archive_size;
	return 0;
}
bool dfu_runner_busy(void) { return false; }
const struct dfu_transport *const *dfu_transport_list(size_t *count)
{
	static const struct dfu_transport ble = { .name = "ble-legacy-dfu" };
	static const struct dfu_transport *const list[] = { &ble };
	*count = ARRAY_SIZE(list);
	return list;
}

static void put16(uint32_t at, uint16_t value)
{
	archive[at] = (uint8_t)value;
	archive[at + 1] = (uint8_t)(value >> 8);
}
static void put32(uint32_t at, uint32_t value)
{
	for (unsigned i = 0; i < 4; ++i) archive[at + i] = (uint8_t)(value >> (8 * i));
}
static uint32_t crc32(const void *data, size_t len)
{
	const uint8_t *p = data;
	uint32_t crc = UINT32_MAX;
	while (len--) {
		crc ^= *p++;
		for (unsigned bit = 0; bit < 8; ++bit) {
			crc = (crc >> 1) ^ (0xedb88320u & (uint32_t)-(int32_t)(crc & 1));
		}
	}
	return ~crc;
}
static uint32_t append(const char *name, const void *data, uint32_t size)
{
	uint32_t at = archive_size;
	uint16_t name_size = (uint16_t)strlen(name);
	assert(at + 30 + name_size + size <= sizeof(archive));
	memset(archive + at, 0, 30);
	put32(at, 0x04034b50);
	put16(at + 4, 10); /* ZIP 1.0 (STORE). */
	put32(at + 14, crc32(data, size));
	put32(at + 18, size);
	put32(at + 22, size);
	put16(at + 26, name_size);
	memcpy(archive + at + 30, name, name_size);
	if (size) memcpy(archive + at + 30 + name_size, data, size);
	assert(entry_count < ARRAY_SIZE(entries));
	entries[entry_count].offset = at;
	entries[entry_count++].name_size = name_size;
	archive_size += 30 + name_size + size;
	return at;
}
static uint32_t finish(void)
{
	uint32_t directory = archive_size;
	for (unsigned i = 0; i < entry_count; ++i) {
		uint32_t at = archive_size;
		uint32_t local = entries[i].offset;
		uint16_t name_size = entries[i].name_size;
		assert(at + 46 + name_size + 22 <= sizeof(archive));
		memset(archive + at, 0, 46);
		put32(at, 0x02014b50);
		put16(at + 4, 10);
		memcpy(archive + at + 6, archive + local + 4, 24);
		put32(at + 42, local);
		memcpy(archive + at + 46, archive + local + 30, name_size);
		archive_size += 46 + name_size;
	}
	uint32_t end = archive_size;
	memset(archive + end, 0, 22);
	put32(end, 0x06054b50);
	put16(end + 8, (uint16_t)entry_count);
	put16(end + 10, (uint16_t)entry_count);
	put32(end + 12, end - directory);
	put32(end + 16, directory);
	archive_size += 22;
	return directory;
}
static const char manifest[] =
	"{\"manifest\":{\"application\":{\"bin_file\":\"app.bin\",\"dat_file\":\"app.dat\"}}}";
static const uint8_t payload[] = { 1, 2, 3, 4, 5, 6 };
static void bundle(void)
{
	append("manifest.json", manifest, sizeof(manifest) - 1);
	append("app.bin", payload, sizeof(payload));
	/* Extended/Secure init packet shape is checked by the DFU client. */
	append("app.dat", "init", 4);
}
static int open_bundle(struct firmware_bundle *out)
{
	char error[128];
	int rc = firmware_zip_open("test.zip", out, error, sizeof(error));
	if (rc < 0) printf("rejected: %s\n", error);
	return rc;
}
static void invalid_entry(uint32_t cursor)
{
	struct fs_file_t f;
	struct zip_entry entry;
	uint32_t next = 0;
	fs_file_t_init(&f);
	assert(fs_open(&f, "test.zip", FS_O_READ) == 0);
	assert(firmware_zip_next(&f, cursor, &entry, &next) < 0);
	assert(fs_close(&f) == 0);
}
static void invalid_archive(void)
{
	struct firmware_bundle out;
	struct fw_inspect inspection;
	assert(open_bundle(&out) < 0);
	assert(firmware_inspect("test.zip", &inspection) == 0);
	assert(!inspection.ok && !inspection.flashable);
	assert(inspection.reason[0]);
}
static void accepted_archive(void)
{
	struct firmware_bundle out;
	struct fw_inspect inspection;
	uint8_t buf[sizeof(payload)];
	assert(open_bundle(&out) == 0);
	assert(out.type == FW_TYPE_APPLICATION);
	assert(out.bin.size == sizeof(payload) && out.dat.size == 4);
	assert(firmware_zip_read(&out.bin, 0, buf, sizeof(buf)) == sizeof(buf));
	assert(memcmp(buf, payload, sizeof(buf)) == 0);
	firmware_zip_close();
	assert(firmware_inspect("test.zip", &inspection) == 0);
	assert(inspection.ok && inspection.flashable);
}

int main(int argc, char **argv)
{
	assert(argc == 2);
	const char *name = argv[1];
	if (!strcmp(name, "valid")) {
		bundle(); finish(); accepted_archive();
	} else if (!strcmp(name, "cycle")) {
		/* The old walker returns next == current: an infinite zip_find. */
		append("manifest.json", manifest, sizeof(manifest) - 1);
		uint32_t at = append("x", NULL, 0);
		put32(at + 18, UINT32_MAX - 30);
		finish(); invalid_archive();
	} else if (!strcmp(name, "wrapped_size")) {
		append("x", NULL, 0);
		put32(18, UINT32_MAX - 30); put32(22, UINT32_MAX - 30);
		finish(); invalid_entry(0); invalid_archive();
	} else if (!strcmp(name, "payload_bounds")) {
		uint32_t at = append("manifest.json", manifest, sizeof(manifest) - 1);
		put32(at + 18, 10000); put32(at + 22, 10000);
		finish(); invalid_entry(0); invalid_archive();
	} else if (!strcmp(name, "header_bounds")) {
		append("x", NULL, 0); put16(28, UINT16_MAX);
		finish(); invalid_entry(0); invalid_archive();
	} else if (!strcmp(name, "store_sizes")) {
		bundle(); put32(18, 0); finish(); invalid_entry(0); invalid_archive();
	} else if (!strcmp(name, "unknown_signature")) {
		bundle(); uint32_t directory = finish(); put32(directory, 0x12345678);
		struct fw_inspect inspection;
		assert(firmware_inspect("test.zip", &inspection) == 0);
		assert(!inspection.ok);
	} else if (!strcmp(name, "truncated_directory")) {
		bundle(); uint32_t directory = finish(); archive_size = directory + 4;
		invalid_entry(directory);
		struct fw_inspect inspection;
		assert(firmware_inspect("test.zip", &inspection) == 0);
		assert(!inspection.ok);
	} else if (!strcmp(name, "compressed") || !strcmp(name, "streamed")) {
		/* Even an unmatched entry must not redirect the walker into data. */
		append("extra", NULL, 0);
		put16(!strcmp(name, "compressed") ? 8 : 6, 8);
		bundle(); finish(); invalid_archive();
	} else if (!strcmp(name, "long_name")) {
		char long_name[ZIP_NAME_MAX + 1];
		memset(long_name, 'a', sizeof(long_name) - 1);
		long_name[sizeof(long_name) - 1] = 0;
		append(long_name, NULL, 0); bundle(); finish(); invalid_archive();
	} else if (!strcmp(name, "lookup_entry_limit")) {
		for (unsigned i = 0; i < 33; ++i) append("extra", NULL, 0);
		bundle(); finish(); invalid_archive();
	} else if (!strcmp(name, "entry_limit") || !strcmp(name, "exact_entry_limit")) {
		bundle();
		unsigned total = !strcmp(name, "entry_limit") ? 33 : 32;
		for (unsigned i = 3; i < total; ++i) append("extra", NULL, 0);
		finish();
		if (total == 32) accepted_archive();
		else {
			struct fw_inspect inspection;
			assert(firmware_inspect("test.zip", &inspection) == 0);
			assert(!inspection.ok);
		}
	} else if (!strcmp(name, "manifest_bounds")) {
		char text[2048];
		memset(text, ' ', sizeof(text));
		memcpy(text, "\"application\":", 14);
		append("manifest.json", text, sizeof(text)); finish(); invalid_archive();
	} else if (!strcmp(name, "inspection_handle") || !strcmp(name, "inspection_handle_failure")) {
		bundle(); finish();
		memcpy(active_archive, archive, archive_size);
		active_archive_size = archive_size;
		bool bad_manifest = !strcmp(name, "inspection_handle_failure");
		if (bad_manifest) {
			archive_size = 0;
			entry_count = 0;
			const char invalid[] = "{\"manifest\":{}}";
			append("manifest.json", invalid, sizeof(invalid) - 1);
			finish();
		}
		start_dfu_on_read = true;
		struct fw_inspect inspection;
		uint8_t buf[sizeof(payload)];
		assert(firmware_inspect("test.zip", &inspection) == 0);
		assert(inspection.ok == !bad_manifest);
		assert(firmware_zip_read(&active_bundle.bin, 0, buf, sizeof(buf)) == sizeof(buf));
		assert(memcmp(buf, payload, sizeof(buf)) == 0);
		firmware_zip_close();
	} else if (!strcmp(name, "multiple_sections") || !strcmp(name, "duplicate_section")) {
		char text[512];
		snprintf(text, sizeof(text),
			 "{\"manifest\":{\"application\":{\"bin_file\":\"app.bin\",\"dat_file\":\"app.dat\"},"
			 "\"%s\":{\"bin_file\":\"app.bin\",\"dat_file\":\"app.dat\",\"sd_size\":2,\"bl_size\":4}}}",
			 !strcmp(name, "multiple_sections") ? "softdevice_bootloader" : "application");
		append("manifest.json", text, (uint32_t)strlen(text));
		append("app.bin", payload, sizeof(payload)); append("app.dat", "init", 4);
		finish(); invalid_archive();
	} else if (!strcmp(name, "size_overflow") || !strcmp(name, "size_fraction") ||
		   !strcmp(name, "valid_split")) {
		char text[512];
		const char *sd_size = !strcmp(name, "size_overflow") ? "4294967298" :
			(!strcmp(name, "size_fraction") ? "2.0" : "2");
		snprintf(text, sizeof(text),
			 "{\"manifest\":{\"softdevice_bootloader\":{\"bin_file\":\"app.bin\",\"dat_file\":\"app.dat\","
			 "\"sd_size\":%s,\"bl_size\":4}}}", sd_size);
		append("manifest.json", text, (uint32_t)strlen(text));
		append("app.bin", payload, sizeof(payload)); append("app.dat", "init", 4);
		finish();
		if (!strcmp(name, "valid_split")) {
			struct firmware_bundle out;
			assert(open_bundle(&out) == 0);
			assert(out.sd_size == 2 && out.bl_size == 4);
			firmware_zip_close();
		} else invalid_archive();
	} else if (!strcmp(name, "read_bounds")) {
		bundle(); finish();
		struct firmware_bundle out;
		uint8_t buf[sizeof(payload)];
		assert(open_bundle(&out) == 0);
		assert(firmware_zip_read(&out.bin, 1, buf, UINT32_MAX) == sizeof(payload) - 1);
		assert(memcmp(buf, payload + 1, sizeof(payload) - 1) == 0);
		firmware_zip_close();
	} else {
		assert(!"unknown test case");
	}
	printf("PASS %s (%u reads)\n", name, reads);
	return 0;
}
