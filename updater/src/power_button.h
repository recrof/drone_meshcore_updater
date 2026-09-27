#pragma once

/*
 * Hold-to-power-off, for boards that have a button to spare and no switch.
 *
 * ---- Why ------------------------------------------------------------------
 *
 * The XIAO ESP32-S3 has no power switch, and in the field it runs from a LiPo
 * soldered to its BAT pads. Without this, the only way to stop it draining the
 * cell is to unsolder or unplug the cell. Holding the button for
 * POWER_BUTTON_HOLD_MS puts the chip into deep sleep, and a short press brings
 * it back.
 *
 * "Off" is deep sleep and not literally off: the XIAO has no load switch it
 * can open on itself, so the RTC domain stays powered to watch the button.
 * That costs tens of microamps rather than the tens of milliamps of an
 * advertising radio, which is the difference this is for.
 *
 * ---- The board declares the button, in devicetree -------------------------
 *
 * Same contract as antenna.h: a `power-button-gpios` property on
 * `zephyr,user`, asserted while the button is pressed:
 *
 *     / { zephyr,user { power-button-gpios = <&gpio0 0 GPIO_ACTIVE_LOW>; }; };
 *
 * A board without it compiles the implementation away. The deep-sleep entry
 * and the wake source are Espressif-specific, so a non-ESP32 board that
 * declares the property gets a build error instead of a button that does
 * nothing.
 *
 * ---- When the hold is refused ----------------------------------------------
 *
 * Only on battery, and only while idle:
 *
 *   - **A USB host is attached.** The board then has power it is not paying
 *     for, and sleeping would only drop the serial console someone is
 *     probably reading. "Host" is judged by SOF frames on the
 *     USB-Serial-JTAG peripheral, so a charger or power bank that supplies
 *     VBUS but no data counts as battery. That is intended: it's the case of a
 *     device in a bag on a power bank.
 *   - **A DFU/OTA run is in progress** (dfu_runner_busy()). A Legacy DFU has no
 *     resume, and some targets are single-bank, so cutting one off midway can
 *     leave the target with no application at all. Stop the run first.
 *
 * Either refusal is logged and needs a fresh press. Continuing to hold does
 * not retry.
 */

#include <stdbool.h>

#ifdef __cplusplus
extern "C" {
#endif

/* True if this board declares a power button. For the boot log. */
bool power_button_present(void);

/* Begin watching the button. Safe to call on a board without one, where it
 * does nothing. Call once, after led_init(); on an ESP32 it also logs what
 * woke the chip, so a wake by the button is visible in the boot log. */
void power_button_start(void);

#ifdef __cplusplus
}
#endif
