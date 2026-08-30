#pragma once

/*
 * Per-platform defaults for the two DFU pacing knobs.
 *
 * `pkt_gap_ms` and `erase_pause_ms` are the throttle that keeps a Legacy DFU
 * target's 8-slot pending-write ring from overflowing (Trap 4). Both are
 * config.txt keys and both can be set per device — this is only what they
 * start at on a fresh install.
 *
 * ---- Why these are not one number ---------------------------------------
 *
 * The thing being paced is the *target's* flash: a ~100 ms page erase on first
 * touch, then ~2.5 ms per 244 B store. That part does not vary with the board
 * we run on. What varies is where our own clock starts.
 *
 * `erase_pause_ms` is anchored to a write-completion callback from our
 * controller, and completion does not mean the same thing on every controller.
 * On the ESP32-S3 it fires earlier relative to the bytes actually reaching the
 * peer, so a nominal 100 ms pause covers materially less than 100 ms of the
 * target's erase — which is why this board wants 150 to buy the same silence.
 * `CONFIG_BT_CONN_TX_MAX` is 10 there against the nRF54L's 3, and that
 * difference in queue depth is what moves the anchor.
 *
 * The sequence that produced the ESP32 numbers, including the two wrong
 * answers, is in notes/dfu-tuning.md. The rule it left behind:
 *
 *   **No timing value transfers to a new part until BT_CONN_TX_MAX has been
 *   checked.**
 *
 * ---- Why it keys on the SoC family, not the board -----------------------
 *
 * Two boards on the same silicon have the same controller and want the same
 * numbers — xiao_ble and xiao_ble_sense would otherwise be two copies of one
 * measurement, free to drift apart. Keying on the family also means an
 * ESP32-C6 or -C5 inherits the ESP32-S3's numbers rather than the nRF's, which
 * is the better guess of the two by a wide margin.
 *
 * It is still only a guess. When a C6 or C5 is actually measured, give it a
 * `CONFIG_SOC_SERIES_*` branch above the family one rather than editing the
 * family default — the S3's numbers were paid for on an S3.
 *
 * ---- Why unknown silicon is a build error -------------------------------
 *
 * Falling back to the nRF numbers would ship a value that has never been near
 * the part, and the failure it produces is a DFU that aborts with NO_MEM part
 * way through an image — days from here, and nothing about it points back to
 * this file. Same reasoning as led.c's missing-alias error: a new board should
 * cost one deliberate line, not one silent surprise.
 */

#if defined(CONFIG_SOC_SERIES_ESP32C5)

/*
 * Measured on the XIAO ESP32-C5 against a XIAO nRF52 repeater, 2026-08-30.
 * **The family default was wrong for this part in both directions**, which is
 * why this branch exists — the header predicted a C5 would want its own and
 * said to add one rather than edit the family value. It does.
 *
 *     gap=7 erase=150 (the S3's)   38.4 s   9.9 KB/s   completed
 *     gap=2 erase=100 (Nordic's)   26.4 s  14.4 KB/s   completed
 *
 * `erase_pause_ms` 100, not the S3's 150: the S3 needed 150 because its
 * write-completion callback fires early relative to bytes reaching the peer.
 * On the C5 100 ms covers the target's ~100 ms page erase, same as on the
 * nRF — so the anchor behaves like Nordic's here despite sharing Espressif's
 * BT_CONN_TX_MAX of 10. **Do not assume the two Espressif parts agree.**
 *
 * ---- Why 4 and not the 2 that was measured -----------------------------
 *
 * Because the interesting number in that run is neither knob. Subtract the
 * page erases and divide by the 1589 packets and a *fixed floor* appears that
 * `pkt_gap_ms` does not touch:
 *
 *     gap=7 -> 15.21 ms/packet on the wire   floor 8.21 ms
 *     gap=2 -> 10.61 ms/packet on the wire   floor 8.61 ms
 *
 * ~8.4 ms of every packet is something else entirely, and the gap merely adds
 * to it. Against a 7.5 ms connection interval that is 2.03 intervals per
 * packet at gap=7 and 1.41 at gap=2 — the gap is rounding the transfer up to
 * the next connection event, and the floor is what actually paces it.
 *
 * **That floor was measured with a browser SMP link open at a 15 ms interval
 * for the whole transfer**, which is the long-standing radio-contention
 * thread. So the floor is not known to be a property of this part, and
 * shipping gap=2 would be shipping a value whose safety margin is currently
 * being provided by *contention*. Disconnect the browser, the floor may fall,
 * the real on-wire spacing with it, and gap=2 then has to hold the target's
 * 8-slot ring on its own — which is exactly how gap=2 failed on the nRF54L
 * (Trap 4), intermittently and only on the fastest attempt.
 *
 * 4 ms is the nRF54L's proven value and costs ~1.2 KB/s against the 2 that was
 * measured here. When someone repeats this with the browser disconnected and
 * the floor is still there, drop it to 2 and take the throughput.
 */
#define DFU_PKT_GAP_MS_DEFAULT     4
#define DFU_ERASE_PAUSE_MS_DEFAULT 100

#elif defined(CONFIG_SOC_FAMILY_ESPRESSIF_ESP32)

/* Measured on the XIAO ESP32-S3 against a RAK4631. 6 ms was the first value
 * that completed an image; 7 is what ships, for margin. */
#define DFU_PKT_GAP_MS_DEFAULT     7
#define DFU_ERASE_PAUSE_MS_DEFAULT 150

#elif defined(CONFIG_SOC_FAMILY_NORDIC_NRF)

/* Measured on the nRF54L, and unchanged since. Per-packet tracing put gap=2 on
 * the wire every ~2.2-2.8 ms — at or below the target's own write rate — so
 * its queue crept up across a page and the boundary packet found no free ring
 * slot. That failed at the *first* page boundary, and only on the attempt that
 * happened to run fastest:
 *
 *     page-0 spacing 2.78 ms/packet -> rejected at 4392 B
 *     page-0 spacing 3.49 ms/packet -> completed the whole image
 *
 * 4 ms sits clear of that threshold, at ~22 ms per 4 KB.
 *
 * The nRF52840 has never been measured separately. It shares the family
 * default because it shares the controller, which is the thing that matters
 * here — not because anyone has run the numbers on it.
 */
#define DFU_PKT_GAP_MS_DEFAULT     4
#define DFU_ERASE_PAUSE_MS_DEFAULT 100

#else

#error "No DFU pacing defaults for this SoC family. Do not guess: measure the \
part against a real target (notes/dfu-tuning.md has the procedure and the two \
wrong answers it produced on the ESP32-S3), then add a branch above. Start \
from the family whose CONFIG_BT_CONN_TX_MAX is closest."

#endif
