/*
 * DFU run -> MeshCore channel messages.
 *
 * A second subscriber to dfu_status, alongside the GATT one. Everything worth
 * announcing already passes through dfu_status.c's setters — the target's
 * name, the percentage, the VERIFYING state, and a 15-way result enum — so
 * this file adds no instrumentation to the runner or the DFU client. It hooks
 * the same five calls and decides which transitions are worth a quarter-second
 * of air time.
 *
 * ---- The rate policy is the design ------------------------------------
 *
 * `retries` defaults to 6 and is set as high as 60 for a flight. A naive
 * "message on every event" would put sixty "found RepeaterX" lines and a
 * hundred progress updates onto a shared channel that other people's traffic
 * has to get through. So:
 *
 *   - the target is announced once per run, not once per attempt;
 *   - progress uses a **high-water mark across the whole run**, so a retry
 *     that gets further than any before it reports, and one that covers the
 *     same ground again is silent. The interesting number from a drone is
 *     "how far has this ever got", which is exactly what that yields;
 *   - only the terminal outcome is announced, never a per-attempt failure;
 *   - a hard minimum gap between transmissions backstops all of it.
 *
 * ---- Nothing here transmits ---------------------------------------------
 *
 * The hooks run on whatever thread moved the DFU along — usually the DFU
 * worker, sometimes the Bluetooth RX thread — and lora_tx_send() blocks for
 * the whole air time. So a hook only formats a small event and drops it in a
 * queue; a dedicated low-priority thread does the encoding and the radio. On
 * a full queue the *oldest* event is dropped: an overtaken progress update is
 * stale, and the newest is always the one worth having.
 *
 * SPDX-License-Identifier: BSD-3-Clause
 */

#ifndef LORA_STATUS_H
#define LORA_STATUS_H

#include "dfu_status.h"

/* BIT() and ARG_UNUSED(). Included here rather than relied on from the
 * translation unit: config.c includes this header before <zephyr/kernel.h>,
 * and a header that only compiles in a particular include order is a trap for
 * the next file that picks it up. */
#include <zephyr/sys/util.h>
#include <zephyr/toolchain.h>

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/* Bits for app_config::lora_events, parsed from config.txt's comma-separated
 * `lora_events=` list. Named so a missing key means "everything", which is
 * what someone who has just set lora_channel expects. */
#define LORA_EVT_TARGET   BIT(0)
#define LORA_EVT_PROGRESS BIT(1)
#define LORA_EVT_VERIFY   BIT(2)
#define LORA_EVT_DONE     BIT(3)
#define LORA_EVT_ALL      (LORA_EVT_TARGET | LORA_EVT_PROGRESS | LORA_EVT_VERIFY | LORA_EVT_DONE)

#if defined(CONFIG_APP_LORA_STATUS)

/* Bind the radio and, if lora_hello is set, announce that the device is up.
 * Call once after the config is loaded — the channel name comes from it. */
void lora_status_boot(void);

void lora_status_begin(uint8_t retries);
void lora_status_attempt(uint8_t attempt);
void lora_status_state(enum dfu_status_state state);
void lora_status_target(const char *name);
void lora_status_progress(uint8_t percent, uint32_t sent, uint32_t total);
void lora_status_finish(enum dfu_status_result result);

#else /* !CONFIG_APP_LORA_STATUS */

/* Empty on the five boards with no LoRa radio, so dfu_status.c carries the
 * calls unconditionally and stays free of #ifdefs. */
static inline void lora_status_boot(void) { }
static inline void lora_status_begin(uint8_t retries) { ARG_UNUSED(retries); }
static inline void lora_status_attempt(uint8_t attempt) { ARG_UNUSED(attempt); }
static inline void lora_status_state(enum dfu_status_state s) { ARG_UNUSED(s); }
static inline void lora_status_target(const char *name) { ARG_UNUSED(name); }
static inline void lora_status_progress(uint8_t p, uint32_t s, uint32_t t)
{
	ARG_UNUSED(p); ARG_UNUSED(s); ARG_UNUSED(t);
}
static inline void lora_status_finish(enum dfu_status_result r) { ARG_UNUSED(r); }

#endif /* CONFIG_APP_LORA_STATUS */

#ifdef __cplusplus
}
#endif

#endif /* LORA_STATUS_H */
