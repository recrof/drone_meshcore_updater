/*
 * Target implementation of meshcore_crypto.h, over PSA Crypto.
 *
 * PSA rather than raw Mbed TLS because that is what NCS builds by default and
 * what routes to the CryptoCell on parts that have one. The RAK4631's nRF52840
 * does not, so all three of these land in software — which is fine at this
 * volume: a status message is ~48 bytes of AES and one HMAC, a handful of
 * times per flight.
 *
 * Requires, in prj.conf (or a board fragment):
 *   CONFIG_PSA_WANT_ALG_SHA_256=y
 *   CONFIG_PSA_WANT_ALG_HMAC=y
 *   CONFIG_PSA_WANT_KEY_TYPE_HMAC=y
 *   CONFIG_PSA_WANT_ALG_ECB_NO_PADDING=y
 *   CONFIG_PSA_WANT_KEY_TYPE_AES=y
 *
 * ⚠ ECB_NO_PADDING is the one to double-check when this first builds: some PSA
 * configurations omit it precisely because ECB is a foot-gun, and the symptom
 * is PSA_ERROR_NOT_SUPPORTED at run time rather than a link error.
 *
 * SPDX-License-Identifier: BSD-3-Clause
 */

#include "meshcore_crypto.h"

#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>
#include <psa/crypto.h>
#include <errno.h>

LOG_MODULE_REGISTER(mc_crypto, LOG_LEVEL_INF);

/* psa_crypto_init() is idempotent but not free, and it can be called from more
 * than one thread here (the status work queue, and whatever first derives the
 * channel key at config load). One-shot it. */
static bool s_ready;
static K_MUTEX_DEFINE(s_lock);

static int ensure_init(void)
{
	int rc = 0;

	k_mutex_lock(&s_lock, K_FOREVER);
	if (!s_ready) {
		psa_status_t st = psa_crypto_init();

		if (st == PSA_SUCCESS) {
			s_ready = true;
		} else {
			LOG_ERR("psa_crypto_init failed: %d", (int)st);
			rc = -EIO;
		}
	}
	k_mutex_unlock(&s_lock);
	return rc;
}

int mc_sha256(const uint8_t *in, size_t len, uint8_t out[32])
{
	size_t out_len = 0;
	int rc = ensure_init();

	if (rc != 0) {
		return rc;
	}
	if (psa_hash_compute(PSA_ALG_SHA_256, in, len, out, 32U, &out_len) != PSA_SUCCESS ||
	    out_len != 32U) {
		return -EIO;
	}
	return 0;
}

int mc_hmac_sha256(const uint8_t *key, size_t key_len, const uint8_t *in, size_t len,
		   uint8_t out[32])
{
	psa_key_attributes_t attr = PSA_KEY_ATTRIBUTES_INIT;
	psa_key_id_t id = PSA_KEY_ID_NULL;
	size_t out_len = 0;
	int rc = ensure_init();

	if (rc != 0) {
		return rc;
	}

	psa_set_key_usage_flags(&attr, PSA_KEY_USAGE_SIGN_MESSAGE);
	psa_set_key_algorithm(&attr, PSA_ALG_HMAC(PSA_ALG_SHA_256));
	psa_set_key_type(&attr, PSA_KEY_TYPE_HMAC);
	psa_set_key_bits(&attr, key_len * 8U);

	if (psa_import_key(&attr, key, key_len, &id) != PSA_SUCCESS) {
		return -EIO;
	}
	rc = (psa_mac_compute(id, PSA_ALG_HMAC(PSA_ALG_SHA_256), in, len, out, 32U, &out_len) ==
		      PSA_SUCCESS &&
	      out_len == 32U)
		     ? 0
		     : -EIO;
	/* Volatile keys leak a slot per call if this is skipped, and there are
	 * only a handful of slots. */
	(void)psa_destroy_key(id);
	return rc;
}

int mc_aes128_ecb_encrypt(const uint8_t key[16], const uint8_t *in, uint8_t *out, size_t len)
{
	psa_key_attributes_t attr = PSA_KEY_ATTRIBUTES_INIT;
	psa_key_id_t id = PSA_KEY_ID_NULL;
	size_t out_len = 0;
	int rc = ensure_init();

	if (rc != 0) {
		return rc;
	}
	if ((len % 16U) != 0U) {
		return -EINVAL;
	}

	psa_set_key_usage_flags(&attr, PSA_KEY_USAGE_ENCRYPT);
	psa_set_key_algorithm(&attr, PSA_ALG_ECB_NO_PADDING);
	psa_set_key_type(&attr, PSA_KEY_TYPE_AES);
	psa_set_key_bits(&attr, 128U);

	if (psa_import_key(&attr, key, 16U, &id) != PSA_SUCCESS) {
		return -EIO;
	}
	/* ECB has no IV, so psa_cipher_encrypt() prepends nothing and the
	 * output is exactly `len` bytes — unlike CBC/CTR, where it would emit
	 * the IV first and shift the whole ciphertext. */
	rc = (psa_cipher_encrypt(id, PSA_ALG_ECB_NO_PADDING, in, len, out, len, &out_len) ==
		      PSA_SUCCESS &&
	      out_len == len)
		     ? 0
		     : -EIO;
	(void)psa_destroy_key(id);
	return rc;
}
