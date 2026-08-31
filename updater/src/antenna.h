#pragma once

/*
 * Antenna path selection, for boards that have a switch.
 *
 * A board declares one by putting an `antenna-gpios` property on the
 * `zephyr,user` node, asserted for the *external* connector:
 *
 *     / {
 *             zephyr,user {
 *                     antenna-gpios = <&gpiob 4 GPIO_ACTIVE_HIGH>;
 *             };
 *     };
 *
 * Which physical level means which antenna is a fact about the board's RF
 * layout, so the flag in that phandle is where it belongs — the code below
 * only ever asks for "external" or "internal" and never for a level.
 *
 * On a board with no such property the whole implementation compiles away and
 * antenna_apply() reports that the setting cannot be honoured. That is
 * deliberate: `ext_antenna` is accepted in config.txt everywhere, because a
 * config file is often written once and copied across a fleet of mixed
 * boards, and a key that is an error on three of them is a file nobody can
 * share.
 */

#include <stdbool.h>

#ifdef __cplusplus
extern "C" {
#endif

/* Point the switch at the external connector or the on-board antenna.
 *
 * Returns 0 if the switch was set, -ENOTSUP if this board has none. Safe to
 * call before Bluetooth is up, and that is where it belongs: the path should
 * already be right when the radio first keys up, not corrected afterwards.
 */
int antenna_apply(bool external);

/* True if this board declares an antenna switch. For the boot log and for the
 * capability the client reads, so a UI can grey out a control that would do
 * nothing rather than offering it and quietly failing. */
bool antenna_switchable(void);

#ifdef __cplusplus
}
#endif
