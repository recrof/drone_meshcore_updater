/* Host harness for pin_addr.c. Reads one pin per line on stdin, prints
 * "<mac>|<type>" or "ERR". Compiled against the real src/pin_addr.c — not a
 * copy — so this test cannot pass while the firmware's own splitter is wrong. */
#include <stdio.h>
#include <string.h>
#include "pin_addr.h"

int main(void)
{
	char line[256];
	while (fgets(line, sizeof(line), stdin)) {
		size_t n = strlen(line);
		while (n && (line[n - 1] == '\n' || line[n - 1] == '\r')) line[--n] = '\0';

		char mac[18], type[16];
		if (pin_addr_split(line, mac, sizeof(mac), type, sizeof(type)) < 0) {
			printf("ERR\n");
		} else {
			printf("%s|%s\n", mac, type);
		}
	}
	return 0;
}
