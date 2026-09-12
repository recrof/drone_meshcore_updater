#pragma once
#include <zephyr/kernel.h>
#define BT_UUID_TYPE_16 0
#define BT_UUID_TYPE_128 2
struct bt_uuid { uint8_t type; };
struct bt_uuid_16 { struct bt_uuid uuid; uint16_t val; };
struct bt_uuid_128 { struct bt_uuid uuid; uint8_t val[16]; };
static const struct bt_uuid_16 fake_ccc = {{BT_UUID_TYPE_16}, 0x2902};
#define BT_UUID_GATT_CCC (&fake_ccc.uuid)
static inline int bt_uuid_cmp(const struct bt_uuid *a, const struct bt_uuid *b) {
	if (a->type != b->type) return 1;
	if (a->type == BT_UUID_TYPE_16) return ((const struct bt_uuid_16 *)a)->val != ((const struct bt_uuid_16 *)b)->val;
	return memcmp(((const struct bt_uuid_128 *)a)->val, ((const struct bt_uuid_128 *)b)->val, 16);
}
