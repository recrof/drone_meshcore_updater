/*
 * Runs updater/src/md5.c over vectors fed on stdin, one per line as
 * `<hex of input><TAB><expected digest>`.
 *
 * A real file rather than a string inside the .mjs: C escapes inside a
 * JavaScript template literal inside a generator go through two layers of
 * backslash handling, and the first attempt at this emitted a C source whose
 * string constants had real newlines in them. This is also readable.
 *
 * The vector *table* stays in md5.test.mjs, so both implementations are held
 * to one list.
 */
#include "md5.h"
#include <stdio.h>
#include <string.h>

int main(void)
{
	char line[8192];
	int bad = 0;

	while (fgets(line, sizeof(line), stdin)) {
		char *tab = strchr(line, '\t');
		if (!tab) continue;
		*tab = '\0';

		char *want = tab + 1;
		want[strcspn(want, "\r\n")] = '\0';

		size_t n = strlen(line) / 2;
		static unsigned char buf[2 * 1024 * 1024];
		if (n > sizeof(buf)) { printf("FAIL input too large\n"); bad++; continue; }
		for (size_t i = 0; i < n; i++) {
			unsigned v = 0;
			sscanf(line + i * 2, "%2x", &v);
			buf[i] = (unsigned char)v;
		}

		struct md5_ctx c;
		unsigned char d[16];
		char hex[33];

		md5_init(&c);
		/* Fed in 7-byte pieces on purpose. The real caller streams from
		 * flash in chunks, and a buffering bug that one big update()
		 * hides is exactly the one that would ship. 7 is coprime with
		 * 64, so block boundaries land mid-chunk. */
		for (size_t o = 0; o < n; o += 7) {
			md5_update(&c, buf + o, (n - o < 7) ? (n - o) : 7);
		}
		md5_final(&c, d);
		md5_hex(d, hex);

		printf("%s %s\n", strcmp(hex, want) ? "FAIL" : "ok", hex);
		if (strcmp(hex, want)) bad++;
	}
	return bad ? 1 : 0;
}
