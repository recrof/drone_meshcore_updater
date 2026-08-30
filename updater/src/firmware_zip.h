#pragma once

/*
 * STORED-only ZIP walker + manifest.json extractor for Nordic DFU bundles.
 *
 * nrfutil pkg generate always writes with STORE (no compression), which
 * lets us stream firmware bytes straight from the on-flash file without
 * a decompressor. Central directory is ignored; we walk Local File Headers
 * from offset 0 and pick out `manifest.json`, `<something>.bin`, and
 * `<something>.dat` based on the manifest contents.
 *
 * Deliberately narrow: resolve bin/dat to absolute offsets once, then hand
 * out bytes. The DFU client never needs to know it is reading from a ZIP.
 */

#include <zephyr/kernel.h>
#include <zephyr/fs/fs.h>
#include <stdbool.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif


#define ZIP_NAME_MAX 64

/* Bit flags matching the Nordic Legacy DFU "Start" opcode's mode byte
 * (see LegacyDfuImpl.java). Combined images set multiple bits.
 */
enum fw_type {
	FW_TYPE_SOFTDEVICE  = 0x01,
	FW_TYPE_BOOTLOADER  = 0x02,
	FW_TYPE_APPLICATION = 0x04,
};

/* A file inside the ZIP, resolved to its absolute byte offset in the
 * archive so streaming reads don't need to re-walk headers.
 */
struct zip_entry {
	char     name[ZIP_NAME_MAX];
	uint16_t name_len;       /* as stored, before truncation into `name` */
	uint32_t data_offset;    /* absolute offset of the raw bytes */
	uint32_t size;           /* uncompressed size, same as compressed for STORE */
	uint32_t comp_size;      /* as stored; equal to `size` for STORE */
	uint32_t crc32;          /* from the local file header */
	uint16_t method;         /* 0 = STORE, which is all we can stream */
	bool     streamed;       /* sizes are in a trailing descriptor, not the header */
};

/* Everything the DFU state machine needs to know about a firmware bundle. */
struct firmware_bundle {
	uint8_t          type;         /* bitmask of fw_type */
	struct zip_entry bin;          /* firmware image */
	struct zip_entry dat;          /* init packet (.dat) */
	uint32_t         sd_size;      /* SD+BL combos only, else 0 */
	uint32_t         bl_size;      /* SD+BL combos only, else 0 */
};

/* Open the zip at `zip_path`, parse manifest.json, and resolve bin/dat
 * entries. On success the archive stays open under the hood — call
 * firmware_zip_close() when streaming is done. Only one archive open at
 * a time.
 *
 * `err` receives a short human-readable failure reason on error.
 * Returns 0 on success, negative errno otherwise.
 */
int firmware_zip_open(const char *zip_path, struct firmware_bundle *out,
		      char *err, size_t err_len);

/* Stream `len` bytes from `entry` starting at byte `offset` within the
 * entry. Returns bytes read (0 = past end), or negative errno on error.
 */
int firmware_zip_read(const struct zip_entry *entry, uint32_t offset,
		      void *buf, uint32_t len);

/* Release the archive file handle. Safe to call when nothing is open. */
void firmware_zip_close(void);

/* ---- primitives, for a second reader over its own handle ---------------
 *
 * firmware_inspect.c validates archives, which means walking one to the end
 * and reporting what is wrong with it — including entries this module refuses
 * to stream. It uses these rather than a second copy of the walker, and its
 * own `struct fs_file_t` rather than the singleton above, so inspecting a
 * file cannot move the cursor of an archive a DFU is streaming from.
 */

/* Read exactly `len` bytes at `off`. Returns 0, or negative errno (-EIO on a
 * short read, which for a seekable file means past the end). */
int firmware_zip_read_at(struct fs_file_t *f, uint32_t off, void *buf, uint32_t len);

/* Read the local file header at `cursor`. Returns 0 and fills `out` and
 * `next_cursor`; 1 at the end of the header sequence; negative errno on IO
 * error. Unlike the streaming path this does NOT reject compressed or
 * streamed entries — it reports them, so a caller can say which entry is the
 * problem instead of only that there is one. */
int firmware_zip_next(struct fs_file_t *f, uint32_t cursor,
		      struct zip_entry *out, uint32_t *next_cursor);

#ifdef __cplusplus
}
#endif
