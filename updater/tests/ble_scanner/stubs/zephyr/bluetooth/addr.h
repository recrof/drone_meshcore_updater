#pragma once
#include <zephyr/kernel.h>
typedef struct { uint8_t val[6]; } bt_addr_t;
typedef struct { uint8_t type; bt_addr_t a; } bt_addr_le_t;
#define BT_ADDR_LE_STR_LEN 32
static inline bool bt_addr_eq(const bt_addr_t *a, const bt_addr_t *b) { return memcmp(a, b, sizeof(*a)) == 0; }
static inline bool bt_addr_le_eq(const bt_addr_le_t *a, const bt_addr_le_t *b) { return a->type == b->type && bt_addr_eq(&a->a, &b->a); }
static inline void bt_addr_le_copy(bt_addr_le_t *a, const bt_addr_le_t *b) { *a = *b; }
static inline int bt_addr_le_to_str(const bt_addr_le_t *a, char *buf, size_t n) { return snprintf(buf, n, "peer-%u", a->a.val[0]); }
