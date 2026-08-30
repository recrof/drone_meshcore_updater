/*
 * ZIP walker + manifest.json extractor.
 *
 * Two layers here:
 *
 *   1. zip_walk / zip_find — a minimal STORE-only ZIP reader. Walks Local
 *      File Headers from offset 0 in the archive; doesn't touch the
 *      central directory. Sufficient because nrfutil always writes STORE
 *      and puts every entry in a single contiguous LFH sequence.
 *
 *   2. manifest.json parsing — the file is small (typically <1 KB), highly
 *      regular, and machine-generated. Rather than pull in a full JSON
 *      library, we do targeted key-value extraction via string search.
 *      Robust enough for nrfutil's output; would not survive user-authored
 *      JSON but nothing here has to.
 */

#include "firmware_zip.h"

#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>
#include <zephyr/fs/fs.h>
#include <string.h>
#include <stdlib.h>
#include <ctype.h>

LOG_MODULE_REGISTER(firmware_zip, LOG_LEVEL_INF);

/* ZIP Local File Header signature "PK\x03\x04". Little-endian u32. */
#define ZIP_LFH_SIG  0x04034B50u
/* Central Directory Header signature — we stop when we see this. */
#define ZIP_CD_SIG   0x02014B50u

/* Single open archive. Not re-entrant: one DFU runs at a time. */
static struct fs_file_t s_file;
static bool             s_file_open;

/* ---- low-level LE readers -------------------------------------------- */
/* Read from an explicitly named handle.
 *
 * Parameterised rather than tied to `s_file` so the walk below can run over a
 * caller's own handle. firmware_inspect.c needs exactly that: it validates a
 * file that may not be the one a DFU is streaming from, and an inspection
 * that repositioned the streaming archive's cursor would corrupt a transfer
 * in a way nothing would attribute to it.
 */
int firmware_zip_read_at(struct fs_file_t *f, uint32_t off, void *buf, uint32_t len)
{
	int rc = fs_seek(f, off, FS_SEEK_SET);
	if (rc < 0) return rc;
	rc = fs_read(f, buf, len);
	if (rc < 0) return rc;
	if ((uint32_t)rc != len) return -EIO;
	return 0;
}

static int read_at(uint32_t off, void *buf, uint32_t len)
{
	return firmware_zip_read_at(&s_file, off, buf, len);
}

static uint16_t rd_u16(const uint8_t *p) { return p[0] | ((uint16_t)p[1] << 8); }
static uint32_t rd_u32(const uint8_t *p)
{
	return  (uint32_t)p[0]
	     | ((uint32_t)p[1] << 8)
	     | ((uint32_t)p[2] << 16)
	     | ((uint32_t)p[3] << 24);
}

/* ---- ZIP walk / find ------------------------------------------------- */
/* Read the next Local File Header at `cursor` and populate `out`.
 * Returns 0 on success, 1 on end-of-LFH-sequence (hit CD or unknown sig),
 * negative errno on IO error or unsupported compression.
 */
int firmware_zip_next(struct fs_file_t *f, uint32_t cursor,
		      struct zip_entry *out, uint32_t *next_cursor)
{
	/* LFH header is 30 bytes; read it in one shot. */
	uint8_t hdr[30];
	int rc = firmware_zip_read_at(f, cursor, hdr, sizeof(hdr));
	if (rc < 0) return rc;

	uint32_t sig = rd_u32(&hdr[0]);
	if (sig == ZIP_CD_SIG) return 1;    /* end of LFHs */
	if (sig != ZIP_LFH_SIG) return 1;   /* corrupt / unknown */

	uint16_t flags    = rd_u16(&hdr[6]);
	uint16_t method   = rd_u16(&hdr[8]);
	uint32_t crc      = rd_u32(&hdr[14]);
	uint32_t csize    = rd_u32(&hdr[18]);
	uint32_t usize    = rd_u32(&hdr[22]);
	uint16_t namelen  = rd_u16(&hdr[26]);
	uint16_t extralen = rd_u16(&hdr[28]);

	/* Compression is *reported*, not rejected here. firmware_zip_open()
	 * still refuses anything but STORE — see below — but an inspector has
	 * to be able to walk an archive in order to say what is wrong with it,
	 * and a walker that stops at the first unsupported entry can only ever
	 * report "unreadable". */
	out->method = method;
	out->crc32  = crc;
	/* Bit 3: sizes live in a trailing data descriptor, so the header's
	 * copies are zero. Nothing that walks headers can read such an entry. */
	out->streamed = (flags & 0x0008u) != 0;

	/* Filename directly follows the header. `name_len` keeps the real
	 * length after truncation, because a name too long to store is a fault
	 * to report rather than one to silently accept. */
	uint16_t nread = namelen;
	if (nread >= sizeof(out->name)) nread = sizeof(out->name) - 1;
	rc = firmware_zip_read_at(f, cursor + 30, out->name, nread);
	if (rc < 0) return rc;
	out->name[nread] = '\0';
	out->name_len = namelen;

	out->data_offset = cursor + 30 + namelen + extralen;
	out->size        = usize;
	out->comp_size   = csize;
	*next_cursor     = out->data_offset + csize;
	return 0;
}

/* Locate an entry by exact filename (case-sensitive). */
static int zip_find(const char *name, struct zip_entry *out)
{
	uint32_t cursor = 0;
	while (true) {
		uint32_t next;
		int rc = firmware_zip_next(&s_file, cursor, out, &next);
		if (rc < 0) return rc;
		if (rc == 1) return -ENOENT;    /* end reached */
		if (strcmp(out->name, name) == 0) {
			/* The check that used to live in the walker. Kept on
			 * this path because streaming is what cannot cope. */
			if (out->method != 0) {
				LOG_ERR("%s uses compression method %u "
					"(only STORE=0 supported)", name, out->method);
				return -ENOTSUP;
			}
			if (out->streamed) {
				LOG_ERR("%s stores its size in a trailing "
					"descriptor; header size is unusable", name);
				return -ENOTSUP;
			}
			return 0;
		}
		cursor = next;
	}
}

/* ---- manifest.json micro-parser -------------------------------------- */
/* Locate `"<key>"` inside `buf` and return a pointer to the character
 * immediately after the closing quote. Returns NULL if not found.
 * Skips over escaped quotes trivially: manifest.json has no escaped
 * chars in nrfutil's output.
 */
static const char *find_quoted_key(const char *buf, size_t buf_len, const char *key)
{
	size_t klen = strlen(key);
	for (size_t i = 0; i + klen + 2 < buf_len; i++) {
		if (buf[i] != '"') continue;
		if (memcmp(&buf[i + 1], key, klen) != 0) continue;
		if (buf[i + 1 + klen] != '"') continue;
		return &buf[i + 1 + klen + 1];
	}
	return NULL;
}

static const char *skip_ws_colon(const char *p, const char *end)
{
	while (p < end && (*p == ' ' || *p == '\t' || *p == '\n' || *p == '\r')) p++;
	if (p >= end || *p != ':') return NULL;
	p++;
	while (p < end && (*p == ' ' || *p == '\t' || *p == '\n' || *p == '\r')) p++;
	return p;
}

/* Find "<key>": "<string>" anywhere in [buf, buf+buf_len). Extracts the
 * string value into `out` (null-terminated). Returns true on success.
 */
static bool json_get_str(const char *buf, size_t buf_len, const char *key,
			 char *out, size_t out_sz)
{
	const char *p   = find_quoted_key(buf, buf_len, key);
	const char *end = buf + buf_len;
	if (!p) return false;
	p = skip_ws_colon(p, end);
	if (!p || p >= end || *p != '"') return false;
	p++;
	size_t o = 0;
	while (p < end && *p != '"' && o + 1 < out_sz) {
		out[o++] = *p++;
	}
	out[o] = '\0';
	return (p < end && *p == '"');
}

/* Find "<key>": <uint>. Accepts an unsigned decimal integer value. */
static bool json_get_uint(const char *buf, size_t buf_len, const char *key,
			  uint32_t *out)
{
	const char *p   = find_quoted_key(buf, buf_len, key);
	const char *end = buf + buf_len;
	if (!p) return false;
	p = skip_ws_colon(p, end);
	if (!p || p >= end || !isdigit((int)*p)) return false;
	uint32_t v = 0;
	while (p < end && isdigit((int)*p)) {
		v = v * 10u + (uint32_t)(*p - '0');
		p++;
	}
	*out = v;
	return true;
}

/* Section detection: return the fw_type bitmask and the substring of
 * `buf` where that section's body starts (so subsequent key lookups
 * only see keys inside the right section, not the sibling sections).
 * Returns 0 (invalid type) if no known section is present.
 */
static uint8_t detect_section(const char *buf, size_t buf_len,
			      const char **section_body_start,
			      size_t *section_body_len)
{
	static const struct { const char *name; uint8_t type; } sections[] = {
		/* Order matters: check the multi-section names first so a
		 * substring match doesn't false-positive on a shorter name.
		 */
		{ "softdevice_bootloader_application",
		  FW_TYPE_SOFTDEVICE | FW_TYPE_BOOTLOADER | FW_TYPE_APPLICATION },
		{ "softdevice_bootloader",
		  FW_TYPE_SOFTDEVICE | FW_TYPE_BOOTLOADER },
		{ "application", FW_TYPE_APPLICATION },
		{ "bootloader",  FW_TYPE_BOOTLOADER },
		{ "softdevice",  FW_TYPE_SOFTDEVICE },
	};

	for (size_t i = 0; i < ARRAY_SIZE(sections); i++) {
		const char *p = find_quoted_key(buf, buf_len, sections[i].name);
		if (!p) continue;
		p = skip_ws_colon(p, buf + buf_len);
		if (!p || *p != '{') continue;

		/* Scope subsequent key lookups to this section's braces. */
		int depth = 1;
		const char *end = p + 1;
		while (end < buf + buf_len && depth > 0) {
			if (*end == '{') depth++;
			else if (*end == '}') depth--;
			end++;
		}
		*section_body_start = p;
		*section_body_len   = (size_t)(end - p);
		return sections[i].type;
	}
	return 0;
}

/* ---- public API ------------------------------------------------------ */
int firmware_zip_open(const char *zip_path, struct firmware_bundle *out,
		      char *err, size_t err_len)
{
	memset(out, 0, sizeof(*out));
	if (err && err_len) err[0] = '\0';

	firmware_zip_close();     /* idempotent */
	fs_file_t_init(&s_file);
	int rc = fs_open(&s_file, zip_path, FS_O_READ);
	if (rc < 0) {
		if (err) snprintf(err, err_len, "open %s rc=%d", zip_path, rc);
		return rc;
	}
	s_file_open = true;

	/* Find manifest.json first. */
	struct zip_entry man;
	rc = zip_find("manifest.json", &man);
	if (rc < 0) {
		if (err) snprintf(err, err_len, "manifest.json not in zip (rc=%d)", rc);
		goto fail;
	}
	if (man.size == 0 || man.size > 2048) {
		if (err) snprintf(err, err_len, "manifest.json size %u out of range", man.size);
		rc = -EINVAL;
		goto fail;
	}

	char mbuf[2048];
	rc = read_at(man.data_offset, mbuf, man.size);
	if (rc < 0) {
		if (err) snprintf(err, err_len, "manifest.json read rc=%d", rc);
		goto fail;
	}

	/* Identify section, extract bin/dat filenames, resolve them. */
	const char *sec_start;
	size_t      sec_len;
	uint8_t type = detect_section(mbuf, man.size, &sec_start, &sec_len);
	if (type == 0) {
		if (err) snprintf(err, err_len, "no recognized firmware section in manifest");
		rc = -EINVAL;
		goto fail;
	}
	/* SD+BL+App is a two-connection flow we don't implement: the target
	 * takes SoftDevice+Bootloader, reboots, and only then accepts the
	 * application. Reject up front rather than failing halfway.
	 */
	if (type == (FW_TYPE_SOFTDEVICE | FW_TYPE_BOOTLOADER | FW_TYPE_APPLICATION)) {
		if (err) snprintf(err, err_len, "softdevice_bootloader_application not supported");
		rc = -ENOTSUP;
		goto fail;
	}

	char bin_name[ZIP_NAME_MAX];
	char dat_name[ZIP_NAME_MAX];
	if (!json_get_str(sec_start, sec_len, "bin_file", bin_name, sizeof(bin_name))) {
		if (err) snprintf(err, err_len, "manifest missing bin_file");
		rc = -EINVAL;
		goto fail;
	}
	if (!json_get_str(sec_start, sec_len, "dat_file", dat_name, sizeof(dat_name))) {
		if (err) snprintf(err, err_len, "manifest missing dat_file");
		rc = -EINVAL;
		goto fail;
	}

	rc = zip_find(bin_name, &out->bin);
	if (rc < 0) {
		if (err) snprintf(err, err_len, "%s not in zip", bin_name);
		goto fail;
	}
	rc = zip_find(dat_name, &out->dat);
	if (rc < 0) {
		if (err) snprintf(err, err_len, "%s not in zip", dat_name);
		goto fail;
	}
	out->type = type;

	if (type & FW_TYPE_SOFTDEVICE && type & FW_TYPE_BOOTLOADER) {
		/* Look for sd_size / bl_size either at the section's top
		 * level (older nrfutil) or nested under info_read_only_metadata
		 * (newer). find_quoted_key doesn't care about depth — the
		 * key names are unique enough to find either way.
		 */
		if (!json_get_uint(sec_start, sec_len, "sd_size", &out->sd_size) ||
		    !json_get_uint(sec_start, sec_len, "bl_size", &out->bl_size) ||
		    out->sd_size == 0 || out->bl_size == 0) {
			if (err) snprintf(err, err_len,
				"softdevice_bootloader missing sd_size / bl_size");
			rc = -EINVAL;
			goto fail;
		}
	}

	LOG_INF("parsed %s: type=0x%02x bin=%s(%u B) dat=%s(%u B)%s",
		zip_path, out->type, out->bin.name, out->bin.size,
		out->dat.name, out->dat.size,
		(out->type & FW_TYPE_SOFTDEVICE) ? " [SD+BL combo]" : "");
	return 0;

fail:
	firmware_zip_close();
	return rc;
}

int firmware_zip_read(const struct zip_entry *entry, uint32_t offset,
		      void *buf, uint32_t len)
{
	if (!s_file_open) return -EINVAL;
	if (offset >= entry->size) return 0;
	if (offset + len > entry->size) len = entry->size - offset;
	int rc = fs_seek(&s_file, entry->data_offset + offset, FS_SEEK_SET);
	if (rc < 0) return rc;
	return fs_read(&s_file, buf, len);
}

void firmware_zip_close(void)
{
	if (!s_file_open) return;
	fs_close(&s_file);
	s_file_open = false;
}
