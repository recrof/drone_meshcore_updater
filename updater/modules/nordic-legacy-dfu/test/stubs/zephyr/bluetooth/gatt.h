#pragma once
#include <zephyr/bluetooth/conn.h>
#include <zephyr/bluetooth/uuid.h>
#include <zephyr/sys/atomic.h>
#define BT_GATT_ITER_STOP 0
#define BT_GATT_ITER_CONTINUE 1
#define BT_GATT_DISCOVER_PRIMARY 1
#define BT_GATT_DISCOVER_CHARACTERISTIC 2
#define BT_GATT_DISCOVER_DESCRIPTOR 3
#define BT_GATT_CCC_NOTIFY 1
#define BT_GATT_SUBSCRIBE_FLAG_VOLATILE 0
#define BT_GATT_SUBSCRIBE_FLAG_WRITE_PENDING 1
#define BT_GATT_SUBSCRIBE_FLAG_SENT 2
struct bt_gatt_attr { uint16_t handle; const void *user_data; };
struct bt_gatt_service_val { const struct bt_uuid *uuid; uint16_t end_handle; };
struct bt_gatt_chrc { const struct bt_uuid *uuid; uint16_t value_handle; };
struct bt_gatt_discover_params;
typedef uint8_t (*bt_gatt_discover_func_t)(struct bt_conn *, const struct bt_gatt_attr *, struct bt_gatt_discover_params *);
struct bt_gatt_discover_params { const struct bt_uuid *uuid; bt_gatt_discover_func_t func; uint16_t start_handle, end_handle; uint8_t type; };
struct bt_gatt_subscribe_params {
	uint8_t (*notify)(struct bt_conn *, struct bt_gatt_subscribe_params *, const void *, uint16_t);
	void (*subscribe)(struct bt_conn *, uint8_t, struct bt_gatt_subscribe_params *);
	uint16_t value, value_handle, ccc_handle; atomic_t flags[1];
};
struct bt_gatt_write_params { void (*func)(struct bt_conn *, uint8_t, struct bt_gatt_write_params *); uint16_t handle, offset, length; const void *data; };
struct bt_gatt_read_params {
	uint8_t (*func)(struct bt_conn *, uint8_t, struct bt_gatt_read_params *, const void *, uint16_t);
	uint8_t handle_count; struct { uint16_t handle, offset; } single;
};
struct bt_gatt_exchange_params { void (*func)(struct bt_conn *, uint8_t, struct bt_gatt_exchange_params *); };
#ifdef __cplusplus
extern "C" {
#endif
int bt_gatt_discover(struct bt_conn *, struct bt_gatt_discover_params *);
int bt_gatt_subscribe(struct bt_conn *, struct bt_gatt_subscribe_params *);
int bt_gatt_unsubscribe(struct bt_conn *, struct bt_gatt_subscribe_params *);
int bt_gatt_write(struct bt_conn *, struct bt_gatt_write_params *);
int bt_gatt_read(struct bt_conn *, struct bt_gatt_read_params *);
int bt_gatt_exchange_mtu(struct bt_conn *, struct bt_gatt_exchange_params *);
uint16_t bt_gatt_get_mtu(struct bt_conn *);
int bt_gatt_write_without_response_cb(struct bt_conn *, uint16_t, const void *, uint16_t, bool, void (*)(struct bt_conn *, void *), void *);
#ifdef __cplusplus
}
#endif
