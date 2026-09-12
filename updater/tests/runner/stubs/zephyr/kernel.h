#pragma once
#include "../../../../modules/nordic-legacy-dfu/test/stubs/zephyr/kernel.h"
#include <zephyr/sys/atomic.h>
#include <assert.h>
#define K_SEM_DEFINE(n, initial, limit) struct k_sem n = {initial}
#define K_THREAD_STACK_DEFINE(n, size) char n[size]
#define K_PRIO_PREEMPT(n) (n)
struct k_thread {
  bool initialized, entry_returned, terminated;
  void (*entry)(void *, void *, void *);
  void *a, *b, *c;
};
typedef struct k_thread *k_tid_t;
extern unsigned fake_thread_joins;
static inline void k_thread_start(k_tid_t t)
{
  t->entry(t->a, t->b, t->c);
  /* Deliberately leave the kernel-termination tail pending. Application
   * completion is not permission to reuse its thread object or stack. */
  t->entry_returned = true;
}
static inline int k_thread_join(k_tid_t t, k_timeout_t timeout)
{
  (void)timeout;
  assert(t->initialized && t->entry_returned);
  t->terminated = true;
  fake_thread_joins++;
  return 0;
}
static inline void k_mutex_init(struct k_mutex *m) { m->unused = 0; }
static inline k_tid_t k_thread_create(struct k_thread *t, char *stack, size_t size,
  void (*entry)(void *, void *, void *), void *a, void *b, void *c,
  int priority, unsigned options, k_timeout_t delay)
{
  (void)stack; (void)size; (void)priority; (void)options;
  assert(!t->initialized || t->terminated);
  t->initialized = true;
  t->entry_returned = false;
  t->terminated = false;
  t->entry = entry; t->a = a; t->b = b; t->c = c;
  if (delay != K_FOREVER) k_thread_start(t);
  return t;
}
static inline void k_thread_name_set(k_tid_t t, const char *name) { (void)t; (void)name; }
