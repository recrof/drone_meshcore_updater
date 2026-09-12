#pragma once
#include <stdint.h>
typedef long atomic_t;
typedef long atomic_val_t;
#define ATOMIC_INIT(n) (n)
static inline long atomic_get(const atomic_t *a) { return *a; }
static inline void atomic_set(atomic_t *a, long n) { *a = n; }
static inline void atomic_clear(atomic_t *a) { *a = 0; }
static inline void atomic_set_bit(atomic_t *a, unsigned n) { *a |= 1L << n; }
static inline void atomic_clear_bit(atomic_t *a, unsigned n) { *a &= ~(1L << n); }
