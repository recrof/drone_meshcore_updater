/* Deterministic scheduler boundary, never linked into firmware. */
#pragma once
#include <assert.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <errno.h>
#define ARG_UNUSED(x) (void)(x)
#define ARRAY_SIZE(x) (sizeof(x) / sizeof((x)[0]))
#define K_MSEC(x) ((int64_t)(x))
#define K_FOREVER INT64_C(-1)
#define K_MUTEX_DEFINE(n) struct k_mutex n = {0}
#define K_WORK_DELAYABLE_DEFINE(n, f) struct k_work_delayable n = {f}
typedef int64_t k_timeout_t;
typedef int atomic_t;
#define ATOMIC_INIT(x) (x)
void fake_event(const char *event);
static inline int atomic_get(const atomic_t *a) { return *a; }
static inline void atomic_set(atomic_t *a, int v) { *a = v; }
static inline void atomic_clear(atomic_t *a) { *a = 0; fake_event("clear"); }
static inline bool atomic_cas(atomic_t *a, int old, int v) {
	if (*a != old) return false;
	*a = v;
	return true;
}
struct k_sem { unsigned count; };
struct k_mutex { int unused; };
struct k_work { int unused; };
struct k_work_delayable { void (*fn)(struct k_work *); };
struct k_spinlock { int unused; };
typedef int k_spinlock_key_t;
static inline void k_sem_init(struct k_sem *s, unsigned n, unsigned limit) {
	ARG_UNUSED(limit); s->count = n; fake_event("init");
}
static inline void k_sem_reset(struct k_sem *s) { s->count = 0; fake_event("reset"); }
static inline void k_sem_give(struct k_sem *s) { s->count = 1; }
static inline int k_sem_take(struct k_sem *s, k_timeout_t timeout) {
	fake_event("wait");
	/* An unwoken infinite wait is the defect under test. Fail promptly. */
	assert(s->count || timeout != K_FOREVER);
	if (s->count) { s->count = 0; return 0; }
	return -EAGAIN;
}
static inline void k_mutex_lock(struct k_mutex *m, k_timeout_t t) {
	ARG_UNUSED(m); ARG_UNUSED(t); fake_event("lock");
}
static inline void k_mutex_unlock(struct k_mutex *m) { ARG_UNUSED(m); }
static inline k_spinlock_key_t k_spin_lock(struct k_spinlock *l) { ARG_UNUSED(l); return 0; }
static inline void k_spin_unlock(struct k_spinlock *l, k_spinlock_key_t k) { ARG_UNUSED(l); ARG_UNUSED(k); }
static inline void k_work_cancel_delayable(struct k_work_delayable *w) { ARG_UNUSED(w); }
static inline void k_work_reschedule(struct k_work_delayable *w, k_timeout_t t) { ARG_UNUSED(w); ARG_UNUSED(t); }
