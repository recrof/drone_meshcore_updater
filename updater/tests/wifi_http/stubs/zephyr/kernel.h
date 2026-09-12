#pragma once
#include "../../../../modules/nordic-legacy-dfu/test/stubs/zephyr/kernel.h"
static inline int64_t k_uptime_get(void) { return fake_now; }
#define SYS_INIT(fn, level, priority) static int (*const test_init)(void) = fn
