#pragma once
#include <zephyr/bluetooth/addr.h>
#include <zephyr/bluetooth/hci.h>
#define BT_CONN_STATE_CONNECTED 1
#define BT_CONN_STATE_DISCONNECTED 2
#define BT_CONN_STATE_DISCONNECTING 3
#define BT_CONN_TYPE_LE 1
#define BT_CONN_ROLE_CENTRAL 0
#define BT_CONN_LE_OPT_NONE 0
struct bt_conn { int state; };
struct bt_conn_info { int state, type, role; struct { uint32_t interval_us; uint16_t latency, timeout; const bt_addr_le_t *dst; } le; };
struct bt_conn_cb {
	void (*connected)(struct bt_conn *, uint8_t);
	void (*disconnected)(struct bt_conn *, uint8_t);
	void (*le_param_updated)(struct bt_conn *, uint16_t, uint16_t, uint16_t);
};
struct bt_le_conn_param { uint16_t interval_min, interval_max, latency, timeout; };
struct bt_conn_le_create_param { uint32_t options; uint16_t interval, window; };
#ifdef __cplusplus
extern "C" {
#endif
int bt_conn_cb_register(struct bt_conn_cb *);
struct bt_conn *bt_conn_ref(struct bt_conn *);
void bt_conn_unref(struct bt_conn *);
int bt_conn_get_info(struct bt_conn *, struct bt_conn_info *);
int bt_conn_disconnect(struct bt_conn *, uint8_t);
int bt_conn_le_create(const bt_addr_le_t *, const struct bt_conn_le_create_param *, const struct bt_le_conn_param *, struct bt_conn **);
const bt_addr_le_t *bt_conn_get_dst(struct bt_conn *);
void bt_conn_foreach(int, void (*)(struct bt_conn *, void *), void *);
#ifdef __cplusplus
}
#endif
