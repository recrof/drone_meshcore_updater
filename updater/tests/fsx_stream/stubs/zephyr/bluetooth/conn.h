#pragma once
#include <stdint.h>
struct bt_conn { int id; };
struct bt_conn_cb { void (*disconnected)(struct bt_conn *, uint8_t); };
#define BT_CONN_CB_DEFINE(name) struct bt_conn_cb name
