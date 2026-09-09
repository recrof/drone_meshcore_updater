/*
 * MeshCore GRP_TXT encoder. See meshcore_grp.h for the frame layout and the
 * sources every constant here was read from.
 *
 * Deliberately free of Zephyr headers: this file is compiled unchanged by the
 * host test in tests/meshcore_grp/, which is the only place its output can be
 * checked against an independent decoder before it reaches the air.
 *
 * SPDX-License-Identifier: BSD-3-Clause
 */

#include "meshcore_grp.h"
#include "meshcore_crypto.h"

#include <errno.h>
#include <string.h>

/* Packet.h header bit layout: route in bits 0-1, payload type in bits 2-5,
 * payload version in bits 6-7 (PAYLOAD_VER_1 == 0, so it contributes nothing
 * and is not written explicitly). */
#define PH_ROUTE_FLOOD 0x01 /* ROUTE_TYPE_FLOOD */
#define PH_ROUTE_TRANSPORT_FLOOD 0x00 /* ROUTE_TYPE_TRANSPORT_FLOOD */
#define TRANSPORT_CODES_LEN 4 /* two little-endian uint16 */
#define PH_TYPE_GRP_TXT 0x05 /* PAYLOAD_TYPE_GRP_TXT */
#define PH_TYPE_SHIFT 2

/* helpers/TxtDataHelpers.h. BaseChatMesh.cpp:490 writes this flags byte as a
 * bare 0 for a group message; the sensor example ORs an attempt counter into
 * the low bits for direct messages, which does not apply to a channel. */
#define TXT_TYPE_PLAIN 0x00

/* MeshCore.h: CIPHER_BLOCK_SIZE, CIPHER_MAC_SIZE, PATH_HASH_SIZE. */
#define CIPHER_BLOCK_SIZE 16
#define CIPHER_MAC_SIZE 2
#define PATH_HASH_SIZE 1

/* MeshCore.h: PUB_KEY_SIZE. GroupChannel::secret is this wide and holds the
 * 16-byte channel key zero-extended; the HMAC is keyed with all 32 bytes. */
#define MESHCORE_SECRET_LEN 32

/* 4-byte timestamp + 1 flags byte, ahead of the text. */
#define PLAIN_PREFIX_LEN 5

int meshcore_channel_key_from_name(const char *name, uint8_t key[MESHCORE_KEY_LEN])
{
	char buf[64];
	uint8_t digest[32];
	size_t len;
	int err;

	if (name == NULL) {
		return -EINVAL;
	}
	/* Tolerate a name given without its '#'. MeshCore does the same when a
	 * region name arrives bare (RegionMap.cpp:180), and config.txt is typed
	 * by hand. */
	if (name[0] == '#') {
		len = strlen(name);
		if (len == 1U || len >= sizeof(buf)) {
			return -EINVAL;
		}
		memcpy(buf, name, len);
	} else {
		len = strlen(name);
		if (len == 0U || len + 1U >= sizeof(buf)) {
			return -EINVAL;
		}
		buf[0] = '#';
		memcpy(&buf[1], name, len);
		len += 1U;
	}

	err = mc_sha256((const uint8_t *)buf, len, digest);
	if (err != 0) {
		return err;
	}
	memcpy(key, digest, MESHCORE_KEY_LEN);
	return 0;
}

int meshcore_region_key_from_name(const char *name, uint8_t key[MESHCORE_KEY_LEN])
{
	/* Identical to a channel key, '#' included — MeshCore's
	 * getAutoKeyFor() hashes the '#'-prefixed name for a region too, and
	 * getTransportKeysFor() supplies the '#' when the stored name lacks
	 * one. So a region shown as "YVR" in the app is sha256("#YVR"). */
	return meshcore_channel_key_from_name(name, key);
}

/*
 * MeshCore's TransportKey::calcTransportCode(), reproduced.
 *
 * HMAC-SHA256 over the payload type byte then the payload, keyed by the region
 * key, first two bytes read as a little-endian uint16. 0x0000 and 0xFFFF are
 * reserved and nudged aside, as upstream does. The code covers the payload, so
 * it differs per message and a repeater recomputes it from its own key.
 */
static int calc_transport_code(const uint8_t region_key[MESHCORE_KEY_LEN], uint8_t payload_type,
			       const uint8_t *payload, size_t payload_len, uint16_t *out)
{
	uint8_t buf[1 + MESHCORE_GRP_MAX_FRAME];
	uint8_t mac[32];
	uint16_t code;
	int err;

	if (payload_len + 1U > sizeof(buf)) {
		return -ENOMEM;
	}
	buf[0] = payload_type;
	memcpy(&buf[1], payload, payload_len);

	err = mc_hmac_sha256(region_key, MESHCORE_KEY_LEN, buf, payload_len + 1U, mac);
	if (err != 0) {
		return err;
	}
	code = (uint16_t)mac[0] | (uint16_t)((uint16_t)mac[1] << 8);
	if (code == 0x0000U) {
		code++;
	} else if (code == 0xFFFFU) {
		code--;
	}
	*out = code;
	return 0;
}

uint8_t meshcore_channel_hash(const uint8_t key[MESHCORE_KEY_LEN])
{
	uint8_t digest[32];

	if (mc_sha256(key, MESHCORE_KEY_LEN, digest) != 0) {
		return 0;
	}
	return digest[0];
}

int meshcore_grp_txt_encode(const uint8_t key[MESHCORE_KEY_LEN], uint32_t timestamp,
			    const char *sender, const char *text, uint8_t path_hash,
			    const uint8_t *region_key, uint8_t *out, size_t out_cap)
{
	/* Plaintext, then padded in place. PLAIN_PREFIX_LEN + MAX_TEXT_LEN is
	 * 165; rounded up to a whole block that is 176. */
	uint8_t plain[PLAIN_PREFIX_LEN + MESHCORE_MAX_TEXT_LEN + CIPHER_BLOCK_SIZE];
	uint8_t secret[MESHCORE_SECRET_LEN] = {0};
	uint8_t mac[32];
	size_t sender_len, text_len, text_room, plain_len, padded_len;
	size_t hdr_len, payload_len;
	uint8_t *ct, *payload;
	uint8_t chash;
	int err;

	if (key == NULL || sender == NULL || text == NULL || out == NULL) {
		return -EINVAL;
	}
	/* Refused rather than clamped: 4 is what MeshCore reserves, and a
	 * silently-narrowed path is the kind of thing that is only noticed
	 * much later, in someone else's attribution data. */
	if (path_hash < MESHCORE_PATH_HASH_MIN || path_hash > MESHCORE_PATH_HASH_MAX) {
		return -EINVAL;
	}

	/* "<sender>: " — the colon and space are MeshCore's, not a display
	 * convention: sendGroupMessage() sprintf's them into the encrypted
	 * bytes, and clients split the message back apart on them. */
	sender_len = strlen(sender);
	text_len = strlen(text);
	if (sender_len + 2U >= MESHCORE_MAX_TEXT_LEN) {
		return -EINVAL;
	}
	text_room = MESHCORE_MAX_TEXT_LEN - (sender_len + 2U);
	if (text_len > text_room) {
		text_len = text_room; /* truncate, as BaseChatMesh.cpp does */
	}

	plain[0] = (uint8_t)(timestamp & 0xFFU);
	plain[1] = (uint8_t)((timestamp >> 8) & 0xFFU);
	plain[2] = (uint8_t)((timestamp >> 16) & 0xFFU);
	plain[3] = (uint8_t)((timestamp >> 24) & 0xFFU);
	plain[4] = TXT_TYPE_PLAIN;

	memcpy(&plain[PLAIN_PREFIX_LEN], sender, sender_len);
	plain[PLAIN_PREFIX_LEN + sender_len] = ':';
	plain[PLAIN_PREFIX_LEN + sender_len + 1U] = ' ';
	memcpy(&plain[PLAIN_PREFIX_LEN + sender_len + 2U], text, text_len);

	/* The NUL that sendGroupMessage() writes after the text is *not* part
	 * of the length it passes on (BaseChatMesh.cpp:497). Counting it would
	 * shift nothing on the wire in most cases — the zero padding below
	 * supplies one anyway — but it would change the length on a message
	 * that lands exactly on a block boundary. */
	plain_len = PLAIN_PREFIX_LEN + sender_len + 2U + text_len;

	/* Zero-pad to a whole block. Utils::encrypt() copies the remaining
	 * bytes into a zeroed 16-byte buffer and encrypts that, so the padding
	 * is zeros and its length is never recorded anywhere; a decoder finds
	 * the end of the text by its NUL or by exhausting the buffer. */
	padded_len = ((plain_len + CIPHER_BLOCK_SIZE - 1U) / CIPHER_BLOCK_SIZE) * CIPHER_BLOCK_SIZE;
	memset(&plain[plain_len], 0, padded_len - plain_len);

	/* Checked, unlike every other caller of this helper: it reports a crypto
	 * failure as the byte 0x00, which is a perfectly plausible channel hash.
	 * Unchecked, a transient PSA error would yield a positive return length
	 * and a well-formed frame addressed to a channel nobody is on — sent,
	 * and discarded by every node, with nothing logged. */
	{
		uint8_t digest[32];

		err = mc_sha256(key, MESHCORE_KEY_LEN, digest);
		if (err != 0) {
			return err;
		}
		chash = digest[0];
	}

	/* Scoping shifts everything after the header by four bytes, so the
	 * payload is laid down at its final offset and the header written
	 * afterwards: the transport code is a function of the payload and
	 * cannot be computed before it exists. */
	hdr_len = (region_key != NULL) ? (1U + TRANSPORT_CODES_LEN + 1U) : 2U;
	payload = &out[hdr_len];
	payload_len = PATH_HASH_SIZE + CIPHER_MAC_SIZE + padded_len;

	if (out_cap < hdr_len + payload_len) {
		return -ENOMEM;
	}

	payload[0] = chash;

	ct = &payload[PATH_HASH_SIZE + CIPHER_MAC_SIZE];
	err = mc_aes128_ecb_encrypt(key, plain, ct, padded_len);
	if (err != 0) {
		return err;
	}

	/* encrypt-then-MAC over the ciphertext only, keyed with the 32-byte
	 * zero-extended secret, truncated to 2 bytes (Utils.cpp:127). */
	memcpy(secret, key, MESHCORE_KEY_LEN);
	err = mc_hmac_sha256(secret, sizeof(secret), ct, padded_len, mac);
	if (err != 0) {
		return err;
	}
	memcpy(&payload[PATH_HASH_SIZE], mac, CIPHER_MAC_SIZE);

	if (region_key != NULL) {
		uint16_t code;

		err = calc_transport_code(region_key, PH_TYPE_GRP_TXT, payload, payload_len,
					  &code);
		if (err != 0) {
			return err;
		}
		out[0] = (uint8_t)((PH_TYPE_GRP_TXT << PH_TYPE_SHIFT) |
				   PH_ROUTE_TRANSPORT_FLOOD);
		out[1] = (uint8_t)(code & 0xFFU);
		out[2] = (uint8_t)(code >> 8);
		/* transport_codes[1]: upstream sets it to 0 and nothing reads
		 * it (simple_repeater/MyMesh.cpp, sendFloodScoped). */
		out[3] = 0U;
		out[4] = 0U;
	} else {
		out[0] = (uint8_t)((PH_TYPE_GRP_TXT << PH_TYPE_SHIFT) | PH_ROUTE_FLOOD);
	}

	/* path_len: hash size in the top two bits, hop count in the low six.
	 * We originate the packet, so the count is zero and the size is our
	 * instruction to whoever relays it (Packet.h:83). */
	out[hdr_len - 1U] = (uint8_t)((path_hash - 1U) << 6);

	return (int)(hdr_len + payload_len);
}
