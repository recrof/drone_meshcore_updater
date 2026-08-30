/*
 * RFC 1321, transcribed. See md5.h for why this is here rather than PSA.
 *
 * Deliberately the plain reference construction: no table tricks, no
 * unrolling. It runs over half a megabyte of flash reads, which dominate it
 * by orders of magnitude, so the only property worth optimising for is being
 * obviously correct against the published vectors.
 */

#include "md5.h"
#include <string.h>

#define F(x, y, z) (((x) & (y)) | (~(x) & (z)))
#define G(x, y, z) (((x) & (z)) | ((y) & ~(z)))
#define H(x, y, z) ((x) ^ (y) ^ (z))
#define I(x, y, z) ((y) ^ ((x) | ~(z)))
#define ROL(x, n)  (((x) << (n)) | ((x) >> (32 - (n))))

static const uint32_t K[64] = {
	0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee,
	0xf57c0faf, 0x4787c62a, 0xa8304613, 0xfd469501,
	0x698098d8, 0x8b44f7af, 0xffff5bb1, 0x895cd7be,
	0x6b901122, 0xfd987193, 0xa679438e, 0x49b40821,
	0xf61e2562, 0xc040b340, 0x265e5a51, 0xe9b6c7aa,
	0xd62f105d, 0x02441453, 0xd8a1e681, 0xe7d3fbc8,
	0x21e1cde6, 0xc33707d6, 0xf4d50d87, 0x455a14ed,
	0xa9e3e905, 0xfcefa3f8, 0x676f02d9, 0x8d2a4c8a,
	0xfffa3942, 0x8771f681, 0x6d9d6122, 0xfde5380c,
	0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70,
	0x289b7ec6, 0xeaa127fa, 0xd4ef3085, 0x04881d05,
	0xd9d4d039, 0xe6db99e5, 0x1fa27cf8, 0xc4ac5665,
	0xf4292244, 0x432aff97, 0xab9423a7, 0xfc93a039,
	0x655b59c3, 0x8f0ccc92, 0xffeff47d, 0x85845dd1,
	0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1,
	0xf7537e82, 0xbd3af235, 0x2ad7d2bb, 0xeb86d391,
};

static const uint8_t S[64] = {
	7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
	5,  9, 14, 20, 5,  9, 14, 20, 5,  9, 14, 20, 5,  9, 14, 20,
	4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
	6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
};

static void md5_block(uint32_t state[4], const uint8_t block[64])
{
	uint32_t m[16];

	/* Little-endian, and read byte by byte rather than cast: the buffer is
	 * filled from arbitrary offsets in a stream and is not guaranteed to
	 * be aligned, which on Xtensa is a fault and not a slow path. */
	for (int i = 0; i < 16; i++) {
		m[i] =  (uint32_t)block[i * 4]
		     | ((uint32_t)block[i * 4 + 1] << 8)
		     | ((uint32_t)block[i * 4 + 2] << 16)
		     | ((uint32_t)block[i * 4 + 3] << 24);
	}

	uint32_t a = state[0], b = state[1], c = state[2], d = state[3];

	for (int i = 0; i < 64; i++) {
		uint32_t f;
		int g;

		if (i < 16)      { f = F(b, c, d); g = i; }
		else if (i < 32) { f = G(b, c, d); g = (5 * i + 1) & 15; }
		else if (i < 48) { f = H(b, c, d); g = (3 * i + 5) & 15; }
		else             { f = I(b, c, d); g = (7 * i) & 15; }

		uint32_t tmp = d;
		d = c;
		c = b;
		b = b + ROL(a + f + K[i] + m[g], S[i]);
		a = tmp;
	}

	state[0] += a;
	state[1] += b;
	state[2] += c;
	state[3] += d;
}

void md5_init(struct md5_ctx *ctx)
{
	ctx->state[0] = 0x67452301;
	ctx->state[1] = 0xefcdab89;
	ctx->state[2] = 0x98badcfe;
	ctx->state[3] = 0x10325476;
	ctx->count = 0;
	memset(ctx->buf, 0, sizeof(ctx->buf));
}

void md5_update(struct md5_ctx *ctx, const void *data, size_t len)
{
	const uint8_t *p = data;
	size_t have = (size_t)(ctx->count & 63);

	ctx->count += len;

	if (have) {
		size_t need = 64 - have;
		if (len < need) {
			memcpy(ctx->buf + have, p, len);
			return;
		}
		memcpy(ctx->buf + have, p, need);
		md5_block(ctx->state, ctx->buf);
		p += need;
		len -= need;
	}
	while (len >= 64) {
		md5_block(ctx->state, p);
		p += 64;
		len -= 64;
	}
	if (len) memcpy(ctx->buf, p, len);
}

void md5_final(struct md5_ctx *ctx, uint8_t out[16])
{
	uint64_t bits = ctx->count * 8;
	size_t have = (size_t)(ctx->count & 63);

	/* 0x80, then zeros, then the length — with a second block when the
	 * length would not fit in this one. */
	ctx->buf[have++] = 0x80;
	if (have > 56) {
		memset(ctx->buf + have, 0, 64 - have);
		md5_block(ctx->state, ctx->buf);
		have = 0;
	}
	memset(ctx->buf + have, 0, 56 - have);
	for (int i = 0; i < 8; i++) {
		ctx->buf[56 + i] = (uint8_t)(bits >> (8 * i));
	}
	md5_block(ctx->state, ctx->buf);

	for (int i = 0; i < 4; i++) {
		out[i * 4]     = (uint8_t)(ctx->state[i]);
		out[i * 4 + 1] = (uint8_t)(ctx->state[i] >> 8);
		out[i * 4 + 2] = (uint8_t)(ctx->state[i] >> 16);
		out[i * 4 + 3] = (uint8_t)(ctx->state[i] >> 24);
	}
}

void md5_hex(const uint8_t digest[16], char *out)
{
	static const char hex[] = "0123456789abcdef";

	for (int i = 0; i < 16; i++) {
		out[i * 2]     = hex[digest[i] >> 4];
		out[i * 2 + 1] = hex[digest[i] & 15];
	}
	out[32] = '\0';
}
