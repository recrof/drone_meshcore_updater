/* Real scanner: FE59 is not evidence of bootloader mode or auto eligibility. */
#include "ble_scanner.h"
#include <zephyr/bluetooth/bluetooth.h>

static bt_le_scan_cb_t *scan_cb;
static bool radio_active, advertise_legacy, advertise_secure;
static const bt_addr_le_t peer = { .type = 1, .a = { .val = {42} } };

static void advertise(void)
{
	static const uint8_t legacy[] = {0x23,0xd1,0xbc,0xea,0x5f,0x78,0x23,0x15,
		0xde,0xef,0x12,0x12,0x30,0x15,0,0};
	static const uint8_t secure[] = {0x59,0xfe};
	static const uint8_t name[] = "explicit-target";
	struct bt_data fields[3];
	size_t count = 0;
	if (advertise_legacy) fields[count++] = (struct bt_data){BT_DATA_UUID128_ALL, sizeof(legacy), legacy};
	if (advertise_secure) fields[count++] = (struct bt_data){BT_DATA_UUID16_ALL, sizeof(secure), secure};
	fields[count++] = (struct bt_data){BT_DATA_NAME_COMPLETE, sizeof(name) - 1, name};
	struct net_buf_simple ad = {fields, count};
	assert(radio_active && scan_cb);
	scan_cb(&peer, -40, 0, &ad);
}

void fake_event(const char *event)
{
	if (!strcmp(event, "wait")) advertise();
}
int bt_le_scan_start(const struct bt_le_scan_param *p, bt_le_scan_cb_t *cb)
{
	ARG_UNUSED(p);
	assert(!radio_active);
	radio_active = true; scan_cb = cb; return 0;
}
int bt_le_scan_stop(void)
{
	assert(radio_active);
	radio_active = false; return 0;
}

int main(void)
{
	struct ble_scanner_target out;
	advertise_secure = true;
	assert(ble_scanner_find_first(&out, 100, NULL, -127, NULL) == -ETIMEDOUT);
	assert(!radio_active);
	assert(ble_scanner_find_first(&out, 100, "explicit-target", -127, NULL) == 0);
	assert(!out.legacy_dfu_uuid);
#if defined(CONFIG_NORDIC_SECURE_DFU)
	assert(out.secure_dfu_uuid);
#else
	assert(!out.secure_dfu_uuid);
#endif
	assert(ble_scanner_find_pinned(&out, 100, &peer) == 0);
	assert(!out.legacy_dfu_uuid);
	assert(ble_scanner_seen_at(&peer, 100, &out) == 0);
	assert(!out.legacy_dfu_uuid);
	assert(ble_scanner_survey_start() == 0);
	advertise();
	struct ble_scanner_seen seen;
	size_t total;
	assert(ble_scanner_survey_get(&seen, 1, 0, &total) == 1 && total == 1);
	assert(!seen.legacy_dfu_uuid); /* the survey's public DFU flag stays clear */
#if defined(CONFIG_NORDIC_SECURE_DFU)
	assert(seen.secure_dfu_uuid);
#endif
	ble_scanner_survey_stop();
	advertise_legacy = true;
	assert(ble_scanner_find_first(&out, 100, NULL, -127, NULL) == 0);
	assert(out.legacy_dfu_uuid);
#if defined(CONFIG_NORDIC_SECURE_DFU)
	assert(out.secure_dfu_uuid); /* neither service overwrites the other */
#endif
	advertise_secure = false;
	assert(ble_scanner_find_first(&out, 100, NULL, -127, NULL) == 0);
	assert(out.legacy_dfu_uuid && !out.secure_dfu_uuid);
	puts("PASS: distinct Legacy/Secure UUIDs, explicit Secure selection, Legacy-only auto/survey eligibility");
}
