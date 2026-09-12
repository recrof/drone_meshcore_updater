#pragma once
#include <zephyr/kernel.h>
typedef struct { uint8_t val[6]; } bt_addr_t;
typedef struct { uint8_t type; bt_addr_t a; } bt_addr_le_t;
#define BT_ADDR_LE_STR_LEN 32
#define BT_ADDR_STR_LEN 18
static const bt_addr_le_t fake_none = {0, {{0}}};
#define BT_ADDR_LE_NONE (&fake_none)
static inline bool bt_addr_le_eq(const bt_addr_le_t *a, const bt_addr_le_t *b)
{ return memcmp(a, b, sizeof(*a)) == 0; }
static inline int bt_addr_le_to_str(const bt_addr_le_t *a, char *out, size_t n)
{
  return snprintf(out, n, "%02X:%02X:%02X:%02X:%02X:%02X (%s)",
    a->a.val[5], a->a.val[4], a->a.val[3], a->a.val[2], a->a.val[1], a->a.val[0],
    a->type ? "random" : "public");
}
static inline int bt_addr_le_from_str(const char *s, const char *type, bt_addr_le_t *out)
{
  unsigned b[6];
  if (sscanf(s, "%x:%x:%x:%x:%x:%x", &b[5], &b[4], &b[3], &b[2], &b[1], &b[0]) != 6)
    return -EINVAL;
  for (unsigned i = 0; i < 6; i++) out->a.val[i] = (uint8_t)b[i];
  out->type = !strcmp(type, "random") || !strcmp(type, "(random)");
  return 0;
}
