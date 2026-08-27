#pragma once

#include <zephyr/kernel.h>
#include <stdbool.h>

/* dfu_client.cpp is C++; everything declared here is defined in C. */
#ifdef __cplusplus
extern "C" {
#endif

/*
 * Shared app-level types + prototypes across the small src/ tree.
 * Deliberately no third-party headers here — this file gets included from
 * the SMP file-upload hook callback which runs from mcumgr's workqueue and
 * we want it cheap.
 */

/* LED state driven by the main state machine. */
enum led_state {
	LED_STATE_IDLE,        /* slow blink, waiting for host */
	LED_STATE_SMP_ACTIVE,  /* mid-file upload, fast blink */
	LED_STATE_DFU_RUNNING, /* central-role stream in progress */
	LED_STATE_DONE_OK,     /* last DFU succeeded, LED solid */
	LED_STATE_DONE_FAIL,   /* last DFU failed, LED pulses */
};

void led_init(void);
void led_set_state(enum led_state s);
/* Called at high rate from the DFU stream loop; pct is 0..100. */
void led_set_progress(uint8_t pct);

/* Storage bring-up: mount LittleFS, ensure /lfs1/config.txt exists with
 * defaults on first boot. Returns 0 on success, negative errno otherwise.
 */
int storage_init(void);

/* Called from the fs_mgmt upload hook when a file transfer completes.
 * If `path` looks like a firmware zip (.zip suffix, under /lfs/), we arm
 * the main state machine to kick off DFU on the next loop tick. Never
 * blocks — the SMP workqueue must return promptly to ACK the last chunk.
 */
void arm_dfu_from_upload(const char *path);

/* Polled from main(); returns non-NULL if a zip is armed and clears the
 * flag atomically. Caller becomes owner of the path buffer contents.
 */
const char *pending_dfu_zip(char *out, size_t out_len);

#ifdef __cplusplus
}
#endif
