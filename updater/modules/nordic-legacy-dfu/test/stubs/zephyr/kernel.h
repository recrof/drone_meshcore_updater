/* Test-only deterministic Zephyr boundary; never linked into firmware. */
#pragma once
#include <stdint.h>
#include <stddef.h>
#include <stdbool.h>
#include <string.h>
#include <stdio.h>
#include <errno.h>
#define ARG_UNUSED(x) (void)(x)
#define MIN(a,b) ((a) < (b) ? (a) : (b))
#define MAX(a,b) ((a) > (b) ? (a) : (b))
#define ARRAY_SIZE(x) (sizeof(x)/sizeof((x)[0]))
#define CONTAINER_OF(p,t,m) ((t *)((char *)(p) - offsetof(t,m)))
#define K_MSEC(n) (n)
#define K_SECONDS(n) ((n)*1000)
#define K_FOREVER (-1)
#define K_NO_WAIT 0
#define K_TIMEOUT_ABS_TICKS(n) MAX(0, (n) - (int64_t)fake_now)
#define K_MUTEX_DEFINE(n) struct k_mutex n = {0}
typedef int64_t k_timeout_t;
struct k_mutex { int unused; };
struct k_spinlock { int unused; };
typedef int k_spinlock_key_t;
struct k_sem { int count; };
#ifdef __cplusplus
extern "C" {
#endif
void fake_event(const char *name);
extern uint32_t fake_now;
static inline void k_sem_init(struct k_sem *s, unsigned initial, unsigned limit) { s->count = initial; (void)limit; }
static inline void k_sem_give(struct k_sem *s) { s->count = 1; }
static inline void k_sem_reset(struct k_sem *s) { s->count = 0; }
static inline int k_sem_take(struct k_sem *s, k_timeout_t timeout) {
	fake_event("wait");
	if (s->count) { s->count = 0; return 0; }
	fake_now += timeout > 0 ? (uint32_t)timeout : 100;
	return -EAGAIN;
}
static inline void k_sleep(k_timeout_t t) { fake_now += (uint32_t)t; fake_event(t == 300 ? "settle" : "sleep"); }
static inline void k_usleep(int64_t t) { fake_now += (uint32_t)(t / 1000); }
static inline uint32_t k_uptime_get_32(void) { return fake_now; }
static inline int64_t k_uptime_ticks(void) { return fake_now; }
static inline int64_t k_us_to_ticks_ceil64(uint64_t us) { return (int64_t)((us + 999) / 1000); }
static inline void k_mutex_lock(struct k_mutex *m, k_timeout_t t) { (void)m; (void)t; }
static inline void k_mutex_unlock(struct k_mutex *m) { (void)m; }
static inline k_spinlock_key_t k_spin_lock(struct k_spinlock *s) { (void)s; return 0; }
static inline void k_spin_unlock(struct k_spinlock *s, k_spinlock_key_t key) { (void)s; (void)key; }
#ifdef __cplusplus
}
#endif
