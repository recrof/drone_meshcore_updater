/*
 * The three primitives meshcore_grp.c needs, and nothing else.
 *
 * Why a shim rather than calling PSA directly: this encoder has to be
 * verifiable on a workstation. Its output is either byte-identical to what a
 * MeshCore node produces or it is undecryptable noise on the air, and there is
 * no middle ground to debug from a drone. So the packet builder stays free of
 * Zephyr, and the crypto arrives through this interface — meshcore_crypto_psa.c
 * on the target, tests/meshcore_grp/crypto_openssl.c on the host.
 *
 * All three are one-shot and synchronous. Nothing here holds state between
 * calls, so a caller on a work queue needs no locking of its own.
 *
 * SPDX-License-Identifier: BSD-3-Clause
 */

#ifndef MESHCORE_CRYPTO_H
#define MESHCORE_CRYPTO_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/* SHA-256 over `len` bytes. `out` is 32 bytes. Returns 0 or -EIO. */
int mc_sha256(const uint8_t *in, size_t len, uint8_t out[32]);

/* HMAC-SHA256, full 32-byte tag. The caller truncates.
 *
 * `key_len` is 32 here, always: MeshCore keys the channel HMAC with
 * GroupChannel::secret, which is PUB_KEY_SIZE (32) bytes wide and holds the
 * 16-byte channel key zero-extended. Passing the 16-byte key alone produces a
 * different tag and a packet every node drops.
 */
int mc_hmac_sha256(const uint8_t *key, size_t key_len,
		   const uint8_t *in, size_t len, uint8_t out[32]);

/* AES-128 in ECB, encrypt only, no padding of its own.
 *
 * `len` is a multiple of 16 and meshcore_grp.c has already zero-padded to it.
 * ECB is not a defensible choice in general; it is what MeshCore does
 * (Utils.cpp:85, block at a time with a zero-filled final block) and the job
 * here is to match it, not to improve on it.
 */
int mc_aes128_ecb_encrypt(const uint8_t key[16], const uint8_t *in,
			  uint8_t *out, size_t len);

#ifdef __cplusplus
}
#endif

#endif /* MESHCORE_CRYPTO_H */
