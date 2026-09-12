#pragma once
#include <stdint.h>
struct bt_uuid_128 { uint8_t val[16]; };
#define BT_UUID_INIT_128(...) { { __VA_ARGS__ } }
