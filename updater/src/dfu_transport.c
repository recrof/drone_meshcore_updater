/*
 * The transport table. See dfu_transport.h for the interface.
 *
 * A plain array, not a Zephyr iterable section: the order here is the order
 * the runner scans in, and an ordering that matters should be readable in one
 * place rather than assembled by the linker from whatever happens to be
 * compiled in.
 */

#include "dfu_transport.h"

static const struct dfu_transport *const s_transports[] = {
	&dfu_transport_ble,
#ifdef CONFIG_WIFI
	/* ESP32 builds only — no nRF part has a WiFi radio. Second in the
	 * table and therefore second in the scan order: BLE names arrive in
	 * the advertisement and cost nothing to reject, while identifying a
	 * WiFi target means associating with it first. */
	&dfu_transport_wifi_elegantota,
#endif
};

const struct dfu_transport *const *dfu_transport_list(size_t *count)
{
	*count = ARRAY_SIZE(s_transports);
	return s_transports;
}
