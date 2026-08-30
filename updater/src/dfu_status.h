#pragma once

/*
 * Live DFU progress, published over its own GATT service.
 *
 * Why this exists: everything the runner and the client know about a transfer
 * used to reach a human only through the log — the serial console, or the
 * live log stream, or LOG.NNNN after the fact. That is the right level of
 * detail for debugging and the wrong one for "is it working?". A browser that
 * triggered a DFU and then watched a static file listing had no way to tell a
 * running transfer from a wedged one.
 *
 * So this is deliberately *not* a second log. It is one small fixed-layout
 * record — state, attempt, percent, bytes, target name — that is always
 * current and always readable. The log stream stays the place to go for
 * detail; this is the thing that tells you whether you need it.
 *
 * ---- Design notes ------------------------------------------------------
 *
 * **Its own service, not another characteristic on log_stream's.** A client
 * subscribes to this on connect and keeps it for the whole session, whereas
 * the log stream is switched on only while someone is looking (it is a log
 * *backend*: subscribing turns logging on). Different lifetimes, and an
 * older firmware missing one should not make the other undiscoverable.
 *
 * **Latest value wins.** The log stream buffers a byte stream and reports
 * what it had to drop, because a log with a silent hole in it is worse than
 * no log. Status has the opposite property: an intermediate update that never
 * went out is not missing information, it is stale information nobody needs.
 * So there is no ring buffer here — one snapshot, overwritten in place, sent
 * when the radio next has room.
 *
 * **Readable as well as notified.** A browser that connects halfway through a
 * transfer has to learn the state without waiting for the next change, which
 * during a 30 s upload could be a while.
 *
 * TX-buffer discipline is the same as log_stream.c and for the same reason
 * (CONFIG_BT_BUF_ACL_TX_COUNT=3, shared with the DFU link): at most one
 * notification in flight, and progress updates are throttled rather than sent
 * per percent.
 *
 * ---- Service UUIDs -----------------------------------------------------
 *   Service : 8d53dc20-1db7-4cd3-868b-8a527460aa84   (SMP UUID +3)
 *   STATUS  : da2e782c-fbce-4e01-ae9e-261174997c48   (SMP char +4)
 *
 * ---- Wire format (little-endian) ---------------------------------------
 *
 *   off  size  field
 *    0    1    version        DFU_STATUS_PAYLOAD_VERSION
 *    1    1    state          enum dfu_status_state
 *    2    1    percent        0..100, meaningful while UPLOADING
 *    3    1    result         enum dfu_status_result (NONE until terminal)
 *    4    1    attempt        1-based; 0 before the first scan
 *    5    1    retries        configured attempt budget
 *    6    1    file_len       bytes of bundle name after the target name
 *    7    1    name_len       bytes of target name that follow the header
 *    8    4    sent           bytes streamed this attempt
 *   12    4    total          image size, 0 until known
 *   16    4    elapsed_ms     since the run began
 *   20    ..   target name, then bundle basename; neither NUL-terminated
 *
 * The version byte is the compatibility hinge: a client that does not
 * recognise it should say so rather than guess at the fields. Fields may be
 * appended without a bump — a client is expected to tolerate a longer
 * payload — but never reordered or resized.
 */

#include <stdint.h>
#include <stdbool.h>

#ifdef __cplusplus
extern "C" {
#endif

#define DFU_STATUS_PAYLOAD_VERSION 1
#define DFU_STATUS_HEADER_LEN      20
/* Sized for the longest thing a transport can name a target: an ElegantOTA
 * identity string, "<node name> (Seeed SenseCAP MeshTracker X1)". It was 24 —
 * BLE_SCANNER_NAME_MAX — which is fine for an advertised name and would have
 * silently cut the board out of a WiFi one, leaving the banner showing
 * "MyRepeater (Seeed SenseCA". Matches DFU_TARGET_NAME_MAX; duplicated rather
 * than included so this header stays dependency-free for the C++ side and for
 * the test that parses it. */
#define DFU_STATUS_NAME_MAX        64
/* Basename only. A full /lfs1/... path is all prefix and no information, and
 * the whole point of this record is that it stays small. */
#define DFU_STATUS_FILE_MAX        32

/* Where the run currently is. Ordered roughly as they occur, but a run can
 * revisit earlier states — a buttonless jump goes back to SCANNING, and so
 * does a retry after COOLDOWN. */
enum dfu_status_state {
	DFU_STATUS_IDLE          = 0,  /* nothing has run since boot */
	DFU_STATUS_SCANNING      = 1,
	DFU_STATUS_CONNECTING    = 2,
	DFU_STATUS_STARTING      = 3,  /* discovery + Start DFU handshake */
	DFU_STATUS_ENABLING      = 4,  /* buttonless jump into the bootloader */
	DFU_STATUS_UPLOADING     = 5,
	DFU_STATUS_VALIDATING    = 6,
	DFU_STATUS_DISCONNECTING = 7,  /* activate + reset */
	DFU_STATUS_COOLDOWN      = 8,  /* waiting between attempts */
	DFU_STATUS_DONE          = 9,  /* terminal, sticky until the next run */
	DFU_STATUS_FAILED        = 10, /* terminal, sticky until the next run */
	/* Out of narrative order on purpose: it belongs after DISCONNECTING,
	 * but these values are on the wire and renumbering them would make an
	 * older client render a running transfer as "Complete". New states are
	 * appended, and clients must not assume the working states are a
	 * contiguous range below DONE. */
	DFU_STATUS_VERIFYING     = 11, /* peer reset; checking that it took */
};

/* Why the run ended.
 *
 * A superset of enum dfu_result rather than the same enum: dfu_result answers
 * "what did the DFU client return", and several ways a run can end never
 * reach the client at all (no target found, unreadable bundle, mapping rules
 * that select nothing). Squeezing those into dfu_result would either mislabel
 * them or push scan concerns into the protocol client's vocabulary.
 */
enum dfu_status_result {
	DFU_STATUS_RESULT_NONE               = 0,  /* still running */
	DFU_STATUS_RESULT_OK                 = 1,
	DFU_STATUS_RESULT_NO_TARGET          = 2,  /* scan timed out */
	DFU_STATUS_RESULT_SCAN_ERROR         = 3,
	DFU_STATUS_RESULT_BAD_BUNDLE         = 4,  /* zip parse or mapping failure */
	DFU_STATUS_RESULT_CONNECT_FAILED     = 5,
	DFU_STATUS_RESULT_SERVICE_MISSING    = 6,
	DFU_STATUS_RESULT_CHAR_MISSING       = 7,
	DFU_STATUS_RESULT_DISCONNECTED       = 8,
	DFU_STATUS_RESULT_TIMEOUT            = 9,
	DFU_STATUS_RESULT_REMOTE_ERROR       = 10,
	DFU_STATUS_RESULT_FS_ERROR           = 11,
	DFU_STATUS_RESULT_RETRIES_EXHAUSTED  = 12,
	DFU_STATUS_RESULT_TARGET_REJECTED    = 13, /* sent whole, peer would not run it */
};

/* Start a new run: clears the snapshot, starts the elapsed clock, and enters
 * SCANNING. `retries` is the configured attempt budget. */
void dfu_status_begin(uint8_t retries);

/* Which bundle is being flashed. Stores the basename of `path`; NULL or ""
 * clears it, which is the honest state for an auto-flash run that has not
 * resolved its bundle yet. */
void dfu_status_bundle(const char *path);

/* Which attempt is about to run, 1-based. */
void dfu_status_attempt(uint8_t attempt);

/* Move to `state`. Cheap and idempotent — a repeat of the current state is
 * dropped rather than notified. */
void dfu_status_set_state(enum dfu_status_state state);

/* The peer this attempt is talking to. Empty or NULL clears it. */
void dfu_status_target(const char *name);

/* Upload progress. Throttled internally; call it as often as you like. */
void dfu_status_progress(uint8_t percent, uint32_t sent, uint32_t total);

/* Terminal. Sets DONE or FAILED from `result` and stops the clock; the
 * snapshot stays readable until the next dfu_status_begin(). */
void dfu_status_finish(enum dfu_status_result result);

/* Back to the state the device was in before anything ran: IDLE, result NONE,
 * attempt 0, timers zeroed, target and bundle names cleared.
 *
 * This is what "Stop" reports. Deliberately not a terminal state: DONE and
 * FAILED are sticky so the last run's outcome survives for the operator to
 * read, and a stop is the operator saying they have read enough and want a
 * clean slate to retry from. Leaving a sticky FAILED behind would mean the
 * next run's progress bar starts under a red banner from a run that was never
 * allowed to finish.
 *
 * Notifies subscribers, so a client sees IDLE arrive rather than having to
 * poll for the absence of something.
 */
void dfu_status_reset(void);

/* Translate a DFU client result. Runner-level failures have no dfu_result and
 * use the DFU_STATUS_RESULT_* constants directly. */
enum dfu_status_result dfu_status_from_dfu_result(int dfu_result);

#ifdef __cplusplus
}
#endif
