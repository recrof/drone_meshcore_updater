/*
 * The voltage -> percentage curve, and nothing else.
 *
 * Split out of battery.c and deliberately free of Zephyr headers, so that
 * web/test/battery.test.mjs can compile *this exact file* on the host and run
 * the interpolation against known points. The precedent is pin_addr.c: Trap 10
 * shipped past a test that asserted both sides named the same function, which
 * was true and proved nothing.
 *
 * Nothing here needs the kernel — it is arithmetic over a constant table — so
 * there is no cost to the split beyond one file.
 */

#include "battery.h"

#include <stddef.h>

#define BATT_ARRAY_SIZE(a) (sizeof(a) / sizeof((a)[0]))

/*
 * A single-cell LiPo, at rest, lightly loaded. Deliberately a table and not a
 * formula: the curve's whole character is that it is flat across the middle
 * and falls off a cliff at both ends, which no cheap polynomial reproduces
 * and which matters here — the interesting readings are all near the bottom.
 *
 * Descending, so the search can stop at the first entry at or below the
 * measurement. Between two entries the result is interpolated, which is what
 * keeps a slowly-draining cell from appearing to sit at one number for an
 * hour and then jump five points.
 *
 * These are open-circuit figures. Under the load of a transmitting radio the
 * same cell reads lower, so a percentage taken mid-DFU is pessimistic — which
 * is the safe direction to be wrong in, and is why no attempt is made to
 * compensate for it. See battery.h.
 */
static const struct {
	uint16_t mv;
	uint8_t  pct;
} k_lipo_curve[] = {
	{ 4200, 100 }, { 4150, 95 }, { 4110, 90 }, { 4080, 85 },
	{ 4020,  80 }, { 3980, 75 }, { 3950, 70 }, { 3910, 65 },
	{ 3870,  60 }, { 3850, 55 }, { 3840, 50 }, { 3820, 45 },
	{ 3800,  40 }, { 3790, 35 }, { 3770, 30 }, { 3750, 25 },
	{ 3730,  20 }, { 3710, 15 }, { 3690, 10 }, { 3610,  5 },
	{ 3270,   0 },
};

uint8_t battery_percent_from_mv(uint16_t mv)
{
	if (mv >= k_lipo_curve[0].mv) {
		return 100;
	}
	for (size_t i = 1; i < BATT_ARRAY_SIZE(k_lipo_curve); i++) {
		if (mv >= k_lipo_curve[i].mv) {
			/* Linear between this entry and the one above it. */
			const uint16_t lo_mv = k_lipo_curve[i].mv;
			const uint16_t hi_mv = k_lipo_curve[i - 1].mv;
			const uint8_t  lo_p  = k_lipo_curve[i].pct;
			const uint8_t  hi_p  = k_lipo_curve[i - 1].pct;
			const uint32_t span  = hi_mv - lo_mv;

			return (uint8_t)(lo_p + ((uint32_t)(mv - lo_mv) *
						 (hi_p - lo_p) + span / 2U) / span);
		}
	}
	return 0;
}

