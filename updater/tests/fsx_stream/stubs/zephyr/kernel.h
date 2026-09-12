#pragma once
#include <assert.h>
#include <stdbool.h>
#include <stdint.h>
#include <sys/types.h>
#define ARG_UNUSED(x) (void)(x)
#define K_FOREVER 0
#define SYS_INIT(fn, level, priority)
struct k_mutex { bool locked; };
void k_mutex_init(struct k_mutex *lock);
int k_mutex_lock(struct k_mutex *lock, int timeout);
int k_mutex_unlock(struct k_mutex *lock);
