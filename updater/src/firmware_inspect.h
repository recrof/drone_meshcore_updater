#pragma once

/*
 * What is this file, is it intact, and can *this* build flash it?
 *
 * The web client asks the same three questions before it uploads, which is
 * the only place they can be answered cheaply enough to refuse a bad file
 * before spending the transfer. This module is the authority for everything
 * afterwards, and it exists because the browser is not the only way a file
 * gets here — nRF Connect Device Manager uploads over plain SMP and will
 * never run our JavaScript, and a file may predate any of these checks.
 *
 * It is also the only side that knows which transports were *built*. The
 * client used to keep a table mirroring dfu_transport.c; asking instead
 * removes the copy rather than testing it.
 *
 * ---- What can be decided from bytes on flash ---------------------------
 *
 * A legacy DFU package carries a real integrity check (CRC-32 per entry) and,
 * better, a cross-check: the init packet ends with a CRC-16 of the image
 * beside it. Everything else about a package can be consistent while the .dat
 * and the .bin came from different builds — and the target only discovers
 * that after receiving the whole image, which Trap 2 says costs a full retry.
 *
 * An ESP32 application is told from a merged image by the absence of an
 * `esp_app_desc_t` at offset 0x20: a bootloader has none. That matters
 * because ElegantOTA hands what it is given to Arduino's `Update`, which
 * writes it into the next OTA slot — a merged image puts a bootloader there.
 */

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/* Kept numerically stable: these values go on the wire to the client, and
 * dfu-inspect.test.mjs holds the two lists together. */
enum fw_kind {
	FW_KIND_UNKNOWN     = 0,
	FW_KIND_NORDIC_ZIP  = 1,   /* legacy nrfutil package — BLE */
	FW_KIND_NCS_ZIP     = 2,   /* this project's own MCUboot bundle */
	FW_KIND_ESP_APP     = 3,   /* bare ESP32 application — WiFi/ElegantOTA */
	FW_KIND_ESP_MERGED  = 4,   /* bootloader at 0, application further in */
};

enum fw_transport_id {
	FW_TRANSPORT_NONE = 0,
	FW_TRANSPORT_BLE  = 1,     /* ble-legacy-dfu */
	FW_TRANSPORT_WIFI = 2,     /* wifi-elegantota */
};

#define FW_INSPECT_REASON_MAX 128
#define FW_INSPECT_TEXT_MAX   32

struct fw_inspect {
	uint8_t kind;              /* enum fw_kind */
	uint8_t transport;         /* enum fw_transport_id — what it needs */

	/* Intact and understood. False means `reason` says what is wrong. */
	bool ok;
	/* ok, AND this build has the transport it needs. The distinction
	 * matters to a user: a good file this board cannot flash is a
	 * different problem from a damaged one, with a different fix. */
	bool flashable;

	char reason[FW_INSPECT_REASON_MAX];

	uint32_t image_bytes;      /* the payload that would be sent */
	uint16_t device_type;      /* legacy init packet, 0 if unknown */
	char     name[FW_INSPECT_TEXT_MAX];     /* ESP: project name */
	char     version[FW_INSPECT_TEXT_MAX];  /* ESP: application version */
	char     chip[FW_INSPECT_TEXT_MAX];     /* ESP: chip from the header */
};

/* Inspect the file at `path`. Always fills `out` — a failure to read is
 * reported through `ok`/`reason` like any other verdict. Returns 0 when the
 * file could be examined at all, negative errno when it could not be opened.
 *
 * Reads the whole file to checksum it, so this is O(size) in flash reads:
 * about a second per 500 KB. Call it once, when a file arrives.
 */
int firmware_inspect(const char *path, struct fw_inspect *out);

/* Bitmask of enum fw_transport_id this build actually carries, taken from the
 * transport table rather than from a list kept here. */
uint32_t firmware_transports(void);

/* Would this name be accepted at all? Rejects the formats users reach for
 * that no transport can send — .uf2, .hex, .elf — by name alone, which is
 * what lets an upload be refused before its first byte. `why` is optional. */
bool firmware_name_acceptable(const char *name, const char **why);

#ifdef __cplusplus
}
#endif
