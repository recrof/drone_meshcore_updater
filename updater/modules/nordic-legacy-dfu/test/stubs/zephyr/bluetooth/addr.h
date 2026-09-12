#pragma once
#include <zephyr/kernel.h>
typedef struct { uint8_t val[6]; } bt_addr_t;
typedef struct { uint8_t type; bt_addr_t a; } bt_addr_le_t;
#define BT_ADDR_LE_STR_LEN 32
#define BT_ADDR_STR_LEN 18
static const bt_addr_le_t fake_none = {0, {{0}}};
#define BT_ADDR_LE_NONE (&fake_none)
static inline bool bt_addr_le_eq(const bt_addr_le_t *a, const bt_addr_le_t *b) { return memcmp(a,b,sizeof(*a)) == 0; }
static inline int bt_addr_le_to_str(const bt_addr_le_t *a, char *b, size_t n) { (void)a; return snprintf(b,n,"test"); }
static inline int bt_addr_le_from_str(const char *a, const char *t, bt_addr_le_t *b) { (void)a; (void)t; memset(b,0,sizeof(*b)); return 0; }
