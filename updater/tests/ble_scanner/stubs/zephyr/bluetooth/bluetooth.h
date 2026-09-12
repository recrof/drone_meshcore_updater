#pragma once
#include <zephyr/bluetooth/addr.h>
#define BT_LE_SCAN_TYPE_ACTIVE 1
#define BT_LE_SCAN_OPT_NONE 0
#define BT_DATA_NAME_COMPLETE 9
#define BT_DATA_NAME_SHORTENED 8
#define BT_DATA_UUID128_ALL 7
#define BT_DATA_UUID128_SOME 6
#define BT_DATA_UUID16_ALL 3
#define BT_DATA_UUID16_SOME 2
struct bt_le_scan_param { uint8_t type, options; uint16_t interval, window; };
struct bt_data { uint8_t type, data_len; const uint8_t *data; };
struct net_buf_simple { struct bt_data *fields; size_t count; };
typedef void bt_le_scan_cb_t(const bt_addr_le_t *, int8_t, uint8_t, struct net_buf_simple *);
int bt_le_scan_start(const struct bt_le_scan_param *params, bt_le_scan_cb_t *cb);
int bt_le_scan_stop(void);
static inline void bt_data_parse(struct net_buf_simple *ad, bool (*cb)(struct bt_data *, void *), void *ctx) {
	for (size_t i = 0; i < ad->count; i++) if (!cb(&ad->fields[i], ctx)) break;
}
