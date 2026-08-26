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
	uint32_t data_offset;    /* absolute offset of the raw bytes */
	uint32_t size;           /* uncompressed size, same as compressed for STORE */
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

#ifdef __cplusplus
}
#endif
