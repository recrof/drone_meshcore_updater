/*
 * Host implementation of meshcore_crypto.h, over OpenSSL.
 *
 * Test-only. The target build uses src/meshcore_crypto_psa.c; this exists so
 * meshcore_grp.c can be compiled and its output compared against an
 * independent decoder without a board or a cross-toolchain in the way.
 *
 * SPDX-License-Identifier: BSD-3-Clause
 */

#include "meshcore_crypto.h"

#include <errno.h>
#include <openssl/evp.h>
#include <openssl/hmac.h>
#include <string.h>

int mc_sha256(const uint8_t *in, size_t len, uint8_t out[32])
{
	unsigned int out_len = 0;

	if (EVP_Digest(in, len, out, &out_len, EVP_sha256(), NULL) != 1 || out_len != 32U) {
		return -EIO;
	}
	return 0;
}

int mc_hmac_sha256(const uint8_t *key, size_t key_len, const uint8_t *in, size_t len,
		   uint8_t out[32])
{
	unsigned int out_len = 0;

	if (HMAC(EVP_sha256(), key, (int)key_len, in, len, out, &out_len) == NULL ||
	    out_len != 32U) {
		return -EIO;
	}
	return 0;
}

int mc_aes128_ecb_encrypt(const uint8_t key[16], const uint8_t *in, uint8_t *out, size_t len)
{
	EVP_CIPHER_CTX *ctx;
	int written = 0;
	int rc = -EIO;

	if ((len % 16U) != 0U) {
		return -EINVAL;
	}

	ctx = EVP_CIPHER_CTX_new();
	if (ctx == NULL) {
		return -EIO;
	}
	/* Padding off: meshcore_grp.c has already zero-padded, and OpenSSL's
	 * default PKCS#7 would append a whole extra block that MeshCore does
	 * not produce and no node expects. */
	if (EVP_EncryptInit_ex(ctx, EVP_aes_128_ecb(), NULL, key, NULL) == 1 &&
	    EVP_CIPHER_CTX_set_padding(ctx, 0) == 1 &&
	    EVP_EncryptUpdate(ctx, out, &written, in, (int)len) == 1 && (size_t)written == len) {
		rc = 0;
	}
	EVP_CIPHER_CTX_free(ctx);
	return rc;
}
