/* Host harness for pin_addr.c. Reads one pin per line on stdin, prints
 * "<mac>|<type>" or "ERR". Compiled against the real src/pin_addr.c — not a
 * copy — so this test cannot pass while the firmware's own splitter is wrong.
 *
 * A line beginning "B " asks the other parser instead: pin_addr_bssid(), which
 * turns an access point's rendered BSSID into the six octets Zephyr's connect
 * request wants. It prints them back in the renderer's own format, so the test
 * is a round trip rather than a "did not return an error". */
#include <stdio.h>
#include <string.h>
#include "pin_addr.h"

int main(void)
{
	char line[256];
	while (fgets(line, sizeof(line), stdin)) {
		size_t n = strlen(line);
		while (n && (line[n - 1] == '\n' || line[n - 1] == '\r')) line[--n] = '\0';

		if (line[0] == 'B' && line[1] == ' ') {
			unsigned char b[6];
			if (pin_addr_bssid(line + 2, b) < 0) {
				printf("ERR\n");
			} else {
				/* survey.c's own format string, so a change to
				 * either side shows up as a failed round trip. */
				printf("%02X:%02X:%02X:%02X:%02X:%02X\n",
				       b[0], b[1], b[2], b[3], b[4], b[5]);
			}
			continue;
		}

		char mac[18], type[16];
		if (pin_addr_split(line, mac, sizeof(mac), type, sizeof(type)) < 0) {
			printf("ERR\n");
		} else {
			printf("%s|%s\n", mac, type);
		}
	}
	return 0;
}
