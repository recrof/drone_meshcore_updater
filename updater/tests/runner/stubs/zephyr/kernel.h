#pragma once
#include "../../../../modules/nordic-legacy-dfu/test/stubs/zephyr/kernel.h"
#include <zephyr/sys/atomic.h>
#define K_SEM_DEFINE(n, initial, limit) struct k_sem n = {initial}
#define K_THREAD_STACK_DEFINE(n, size) char n[size]
#define K_PRIO_PREEMPT(n) (n)
struct k_thread { int unused; };
typedef struct k_thread *k_tid_t;
static inline void k_mutex_init(struct k_mutex *m) { m->unused = 0; }
static inline k_tid_t k_thread_create(struct k_thread *t, char *stack, size_t size,
  void (*entry)(void *, void *, void *), void *a, void *b, void *c,
  int priority, unsigned options, k_timeout_t delay)
{
  (void)stack; (void)size; (void)priority; (void)options; (void)delay;
  entry(a, b, c);
  return t;
}
static inline void k_thread_name_set(k_tid_t t, const char *name) { (void)t; (void)name; }
