/*
 * Known-answer and structural tests for the GRP_TXT encoder.
 *
 * The known answers are not this project's: they come from MeshCore's own
 * documentation and source, which is the only thing that makes them worth
 * anything. A test that checks the encoder against itself would pass on a
 * packet no node can read.
 *
 * `./test --emit` prints a frame as hex for the Go cross-check, which decodes
 * it with an independently written decoder rather than by running this code
 * backwards.
 *
 * SPDX-License-Identifier: BSD-3-Clause
 */

#include "meshcore_grp.h"
#include "meshcore_crypto.h"

#include <stdio.h>
#include <string.h>

static int failures;

static void hex(const uint8_t *b, size_t n, char *out)
{
	static const char d[] = "0123456789abcdef";

	for (size_t i = 0; i < n; i++) {
		out[i * 2] = d[b[i] >> 4];
		out[i * 2 + 1] = d[b[i] & 0x0F];
	}
	out[n * 2] = '\0';
}

static void check(const char *what, int ok)
{
	printf("%s %s\n", ok ? "ok  " : "FAIL", what);
	if (!ok) {
		failures++;
	}
}

static void check_key(const char *name, const char *expect_hex)
{
	uint8_t key[MESHCORE_KEY_LEN];
	char got[MESHCORE_KEY_LEN * 2 + 1];
	char label[128];

	if (meshcore_channel_key_from_name(name, key) != 0) {
		snprintf(label, sizeof(label), "key(\"%s\") derives", name);
		check(label, 0);
		return;
	}
	hex(key, sizeof(key), got);
	snprintf(label, sizeof(label), "key(\"%s\") == %s", name, expect_hex);
	if (strcmp(got, expect_hex) != 0) {
		printf("     got %s\n", got);
	}
	check(label, strcmp(got, expect_hex) == 0);
}

int main(int argc, char **argv)
{
	uint8_t key[MESHCORE_KEY_LEN];
	uint8_t frame[MESHCORE_GRP_MAX_FRAME];
	char buf[MESHCORE_GRP_MAX_FRAME * 2 + 1];
	int len;
	int emit = (argc > 1 && strcmp(argv[1], "--emit") == 0);

	/* Handled before anything prints: `make vec` pipes this straight into the
	 * Go cross-check, so the hex frame has to be the only thing on stdout. */
	if (emit) {
		if (meshcore_channel_key_from_name("#drone-updater", key) != 0) {
			return 1;
		}
		/* `make vec MSG="..."` emits any message, so a vector can be
		 * produced for the longest line the formatter can build. */
		len = meshcore_grp_txt_encode(key, 1757116800U, "drone-updater",
					      (argc > 2) ? argv[2] : "found RepeaterX", 2,
					      frame, sizeof(frame));
		if (len < 0) {
			return 1;
		}
		hex(frame, (size_t)len, buf);
		printf("%s\n", buf);
		return 0;
	}

	/* MeshCore docs/companion_protocol.md:441-442 states the hashtag rule
	 * and gives this exact pair. It is the one external known answer that
	 * pins the '#'-is-hashed question. */
	check_key("#test", "9cd8fcf22a47333b591d96a2b848b73f");
	/* Same channel, name typed without its '#'. */
	check_key("test", "9cd8fcf22a47333b591d96a2b848b73f");
	/* This project's default channel. */
	check_key("#drone-updater", "fbab2ea202bea0ac3482096b8b095071");

	if (meshcore_channel_key_from_name("#drone-updater", key) != 0) {
		printf("FAIL cannot derive default channel key\n");
		return 1;
	}
	check("channel hash == 0x26", meshcore_channel_hash(key) == 0x26);

	len = meshcore_grp_txt_encode(key, 1757116800U, "drone-updater",
				      "found RepeaterX @ -69dBm", 2, frame, sizeof(frame));
	if (len < 0) {
		printf("FAIL encode returned %d\n", len);
		return 1;
	}

	/* (PAYLOAD_TYPE_GRP_TXT << 2) | ROUTE_TYPE_FLOOD */
	check("header == 0x15", frame[0] == 0x15);
	/* path_len: hash size - 1 in the top two bits, hop count in the low six.
	 * 2-byte hashes with no hops is 0x40 (MeshCore Packet.h:83). */
	check("path_len == 0x40 (2-byte hash, 0 hops)", frame[1] == 0x40);
	check("channel hash in frame", frame[2] == 0x26);
	/* 2 header + 1 hash + 2 MAC, then whole cipher blocks. */
	check("ciphertext is block-aligned", ((len - 5) % 16) == 0);
	check("inside MAX_PACKET_PAYLOAD", (len - 2) <= 184);

	/* Every width MeshCore accepts, and the two it does not. 4 is reserved
	 * by isValidPathLen(); 0 would underflow the shift. */
	for (uint8_t sz = 1; sz <= 3; sz++) {
		char label[64];
		int n = meshcore_grp_txt_encode(key, 1U, "u", "x", sz, frame, sizeof(frame));

		snprintf(label, sizeof(label), "hash width %u encodes path_len 0x%02x", sz,
			 (sz - 1) << 6);
		check(label, n > 0 && frame[1] == (uint8_t)((sz - 1) << 6));
	}
	check("hash width 4 refused (reserved)",
	      meshcore_grp_txt_encode(key, 1U, "u", "x", 4, frame, sizeof(frame)) < 0);
	check("hash width 0 refused",
	      meshcore_grp_txt_encode(key, 1U, "u", "x", 0, frame, sizeof(frame)) < 0);

	/* An over-long message must be truncated, not rejected and not
	 * overflowed: the sender name is paid for out of the same 160 bytes. */
	char big[512];
	memset(big, 'x', sizeof(big) - 1);
	big[sizeof(big) - 1] = '\0';
	len = meshcore_grp_txt_encode(key, 1U, "drone-updater", big, 2, frame, sizeof(frame));
	check("over-long text truncates", len > 0 && len <= MESHCORE_GRP_MAX_FRAME);

	/* A caller's buffer that is too small must be refused, not written. */
	len = meshcore_grp_txt_encode(key, 1U, "drone-updater", "hello", 2, frame, 8);
	check("short buffer refused", len < 0);

	printf("\n%s\n", failures == 0 ? "all passed" : "FAILURES");
	return failures == 0 ? 0 : 1;
}
