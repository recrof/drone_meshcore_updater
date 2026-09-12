#pragma once
#include <stdint.h>
struct bt_uuid { int type; };
struct bt_uuid_128 { struct bt_uuid uuid; uint8_t val[16]; };
#define BT_UUID_INIT_128(...) { { 128 }, { __VA_ARGS__ } }
