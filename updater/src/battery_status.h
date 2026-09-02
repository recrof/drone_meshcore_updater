#pragma once

/*
 * The battery, published over GATT so a change reaches a client at once.
 *
 * ---- Why this is not just a faster poll ---------------------------------
 *
 * The client can already ask (`FSX_MGMT_ID_BATTERY`), and does, on a slow
 * timer. That is right for the level, which moves over tens of minutes.
 * It is wrong for the two things that happen in an instant — a charger going
 * in, and a charger coming out — because those are exactly the events someone
 * is standing in front of the device waiting to see confirmed. Polling turns
 * a yes/no answer into "somewhere in the next minute".
 *
 * Making the poll fast enough to feel immediate is the alternative and it is
 * worse: every poll is an SMP round trip over the radio the DFU is using
 * (Trap 4), spent almost always to learn that nothing changed.
 *
 * ---- Its own service, like dfu_status ------------------------------------
 *
 * Not a characteristic bolted onto the DFU status service. That one is
 * documented as, and tested as, live progress for a transfer; the battery is
 * unrelated to whether a DFU is running and outlives every one of them. Same
 * reasoning dfu_status.h gives for not living on log_stream's service.
 *
 * Not Zephyr's standard Battery Service (0x180F) either, and that is worth
 * saying because it looks like the obvious fit. BAS carries a *percentage*
 * and notifies when the percentage changes — but the event this exists for
 * often does not change the percentage at all. A charger attached to a cell
 * already reading 100% is the case where the notification matters most and
 * where BAS is silent. It also cannot carry the millivolts, which is the
 * number that can be checked against a meter, or the "this board cannot tell"
 * distinction that two of the three boards depend on.
 *
 * ---- Service UUIDs -------------------------------------------------------
 *   Service : 8d53dc21-1db7-4cd3-868b-8a527460aa84   (SMP UUID +4)
 *   BATTERY : da2e782d-fbce-4e01-ae9e-261174997c48   (SMP char +5)
 *
 * ---- Wire format (little-endian) -----------------------------------------
 *
 *   off  size  field
 *    0    1    version     BATTERY_STATUS_PAYLOAD_VERSION
 *    1    1    source      enum battery_source (0 = this board cannot measure)
 *    2    1    percent     0..100, inferred from the voltage
 *    3    1    flags       BATTERY_ST_* below
 *    4    2    millivolts  terminal voltage
 *
 * **`flags` carries both the value and whether it is known**, because absent
 * is not false: a board reading a bare divider sees a full cell on USB and a
 * full cell running itself flat as the same voltage. A client must render an
 * unknown as unknown, never as "not charging".
 *
 * Six bytes, so it fits any ATT MTU including the 23-byte default — no
 * fragmentation, no reassembly, and readable in one go by a client that
 * connects without subscribing.
 */

#include <stdint.h>
#include "battery.h"

#ifdef __cplusplus
extern "C" {
#endif

#define BATTERY_STATUS_PAYLOAD_VERSION 1
#define BATTERY_STATUS_LEN             6

/* flags */
#define BATTERY_ST_CHARGING       0x01  /* value: is charging */
#define BATTERY_ST_CHARGING_KNOWN 0x02  /* ...and the board can actually tell */
#define BATTERY_ST_EXTERNAL       0x04  /* value: external power attached */
#define BATTERY_ST_EXTERNAL_KNOWN 0x08  /* ...and the board can actually tell */

/* Start sampling and publishing. Safe on a board with no battery hardware:
 * the service still exists and reads back source 0, so a client gets a
 * definite "this board cannot measure one" instead of a timeout. */
void battery_status_init(void);

#ifdef __cplusplus
}
#endif
