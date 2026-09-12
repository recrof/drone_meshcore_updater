#pragma once
#include "conn.h"
#include <stddef.h>
#include <sys/types.h>
struct bt_gatt_attr {
  const void *uuid;
  ssize_t (*write)(struct bt_conn *, const struct bt_gatt_attr *, const void *, uint16_t, uint16_t, uint8_t);
  void (*ccc)(const struct bt_gatt_attr *, uint16_t);
};
#define BT_GATT_ERR(err) (-(err))
#define BT_ATT_ERR_INVALID_ATTRIBUTE_LEN 13
#define BT_ATT_ERR_INVALID_OFFSET 7
#define BT_GATT_PRIMARY_SERVICE(u) { .uuid = (u) }
#define BT_GATT_CHARACTERISTIC(u, properties, perm, read, write_fn, data) \
  { .uuid = (u) }, { .uuid = (u), .write = (write_fn) }
#define BT_GATT_CCC(fn, perm) { .ccc = (fn) }
#define BT_GATT_SERVICE_DEFINE(name, ...) \
  static const struct { struct bt_gatt_attr attrs[6]; } name = { { __VA_ARGS__ } }
int bt_gatt_notify(struct bt_conn *conn, const struct bt_gatt_attr *attr, const void *data, uint16_t len);
uint16_t bt_gatt_get_mtu(struct bt_conn *conn);
