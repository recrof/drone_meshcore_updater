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
