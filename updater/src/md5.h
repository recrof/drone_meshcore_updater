#pragma once

/*
 * MD5, for ElegantOTA's mandatory integrity field.
 *
 * Not a security choice — MD5 is not one — but a protocol requirement:
 * AsyncElegantOTA takes an `MD5` form field and verifies it at
 * `Update.end()`, so an upload without a correct one is rejected after the
 * whole image has been sent.
 *
 * Standalone rather than PSA. The build has mbedTLS and `PSA_WANT_ALG_MD5`
 * exists, but Trap 6 on this same board was PSA reaching for an allocator
 * nothing had selected, and the failure was a bootloader that ran, verified
 * nothing, and said nothing. A hundred lines with no Kconfig surface is the
 * cheaper risk, and it can be anchored to RFC 1321's own test vectors — which
 * md5.test.mjs does, against the client's independent implementation.
 *
 * Streaming: the image is up to half a megabyte on flash and is never held in
 * RAM, so this is init/update/final rather than a one-shot.
 */

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

struct md5_ctx {
	uint32_t state[4];
	uint64_t count;        /* message length in bytes */
	uint8_t  buf[64];
};

void md5_init(struct md5_ctx *ctx);
void md5_update(struct md5_ctx *ctx, const void *data, size_t len);
/* Writes 16 raw bytes. */
void md5_final(struct md5_ctx *ctx, uint8_t out[16]);

/* Lower-case hex, 32 characters plus a terminator: `out` must be >= 33 bytes.
 * ElegantOTA compares the field as text, and Arduino's `Update` produces
 * lower case — an upper-case digest is rejected with no useful message. */
void md5_hex(const uint8_t digest[16], char *out);

#ifdef __cplusplus
}
#endif
