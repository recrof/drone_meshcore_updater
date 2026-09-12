/* See pin_addr.h. Deliberately free of Zephyr headers so the host test can
 * compile this exact file rather than a copy of it. */

#include "pin_addr.h"

#include <string.h>

#define ADDR_STR_LEN 17   /* "AA:BB:CC:DD:EE:FF", bt_addr_from_str's hard cap */

int pin_addr_split(const char *pin, char *mac, size_t mac_sz,
		   char *type, size_t type_sz)
{
	if (pin == NULL || mac == NULL || type == NULL ||
	    mac_sz <= ADDR_STR_LEN || type_sz < 2) {
		return -22;
	}

	while (*pin == ' ') {
		pin++;
	}

	const char *sp = strchr(pin, ' ');
	size_t alen = sp ? (size_t)(sp - pin) : strlen(pin);
	if (alen != ADDR_STR_LEN) {
		return -22;
	}
	memcpy(mac, pin, alen);
	mac[alen] = '\0';

	/* No type given: assume the one a Nordic DFU peer uses. */
	if (sp == NULL) {
		strncpy(type, "random", type_sz - 1);
		type[type_sz - 1] = '\0';
		return 0;
	}

	while (*sp == ' ') {
		sp++;
	}
	if (*sp == '\0') {
		strncpy(type, "random", type_sz - 1);
		type[type_sz - 1] = '\0';
		return 0;
	}

	size_t tlen = strlen(sp);
	if (tlen >= type_sz) {
		tlen = type_sz - 1;
	}
	memcpy(type, sp, tlen);
	type[tlen] = '\0';
	return 0;
}

static int hex_nib(char c)
{
	if (c >= '0' && c <= '9') return c - '0';
	if (c >= 'a' && c <= 'f') return c - 'a' + 10;
	if (c >= 'A' && c <= 'F') return c - 'A' + 10;
	return -1;
}

int pin_addr_bssid(const char *pin, unsigned char out[6])
{
	if (pin == NULL || out == NULL) {
		return -22;
	}

	while (*pin == ' ') {
		pin++;
	}

	/* Walk the six pairs rather than checking a length and then parsing.
	 * A length check alone accepts "AA:BB:CC:DD:EE:FG" and every other
	 * 17-character string with the right shape and the wrong contents. */
	for (int i = 0; i < 6; i++) {
		const int hi = hex_nib(pin[0]);
		const int lo = (hi < 0) ? -1 : hex_nib(pin[1]);
		if (lo < 0) {
			return -22;
		}
		out[i] = (unsigned char)((hi << 4) | lo);
		pin += 2;
		if (i < 5) {
			if (*pin != ':') {
				return -22;
			}
			pin++;
		}
	}

	/* Nothing but spaces may follow. A trailing "(random)" means this is a
	 * Bluetooth row's id — see pin_addr.h for why that is refused rather
	 * than tolerated. */
	while (*pin == ' ') {
		pin++;
	}
	return (*pin == '\0') ? 0 : -22;
}
