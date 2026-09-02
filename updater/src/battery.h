#pragma once

/*
 * Battery monitoring, for boards that can measure one.
 *
 * ---- Why a device that is usually on USB cares ---------------------------
 *
 * Because the case this project exists for is the one where it is not. The
 * updater is flown or carried to a repeater on a mast precisely because a
 * person with a laptop cannot get there, and at that moment nothing else can
 * answer "will this last long enough to finish". A Legacy DFU has no resume
 * (Trap 2) and some targets are single-bank, so an updater that runs out of
 * charge partway through does not merely fail — it can leave the target with
 * no application at all, on a roof, until someone climbs up.
 *
 * ---- The board declares the hardware, in devicetree ----------------------
 *
 * Same contract as antenna.h, and for the same reason: which resistors are
 * fitted and which pin gates them is a fact about a board's layout, so it
 * belongs in that board's overlay rather than in a table here keyed on board
 * name. Two shapes are recognised, and a board may provide either:
 *
 *  1. **A fuel-gauge-ish PMIC.** Any `nordic,npm1300-charger` node. Gives the
 *     terminal voltage and, unlike a bare divider, says honestly whether the
 *     cell is charging and whether USB is attached. This is the XIAO
 *     nRF54LM20A, whose nPM1300 was already in its devicetree.
 *
 *  2. **A resistor divider on an ADC**, declared with Zephyr's own
 *     `voltage-divider` binding and pointed at by a `battery-voltage` alias:
 *
 *         / {
 *                 vbatt: vbatt {
 *                         compatible = "voltage-divider";
 *                         io-channels = <&adc 7>;
 *                         output-ohms = <510000>;
 *                         full-ohms   = <1510000>;
 *                         power-gpios = <&gpio0 14 GPIO_ACTIVE_LOW>;
 *                 };
 *                 aliases { battery-voltage = &vbatt; };
 *         };
 *
 *     The divider ratio is `full-ohms / output-ohms` and the driver applies
 *     it, so **no ratio is written down in C anywhere**. That is the whole
 *     point: these two numbers are the only part of this feature that cannot
 *     be checked from source, and putting them in the overlay makes a
 *     correction a one-line edit against a multimeter rather than a patch.
 *
 *     `power-gpios` is optional and its *polarity flag* carries which level
 *     enables the divider — on the XIAO nRF52840 that is active-low, which is
 *     exactly the kind of fact that would otherwise become an inverted
 *     constant somebody rediscovers later (Trap 1b).
 *
 *  Optionally, either shape may add a charge-status input:
 *
 *         / { zephyr,user { charging-gpios = <&gpio0 17 GPIO_ACTIVE_LOW>; }; };
 *
 *  A board that declares neither shape compiles the whole implementation away
 *  and reports `-ENOTSUP`. Three of the six boards here are in that state and
 *  it is a hardware fact, not an omission — see notes/boards.md.
 *
 * ---- What the numbers are worth -----------------------------------------
 *
 * `millivolts` is measured. `percent` is **inferred from voltage against a
 * single-cell LiPo curve** and is therefore approximate on any board: it sags
 * under load and recovers afterwards, so the same cell reads lower while the
 * radio is transmitting than it does a second later. Neither backend here has
 * a coulomb-counting fuel gauge, so this is the honest ceiling, and it is why
 * the millivolts are reported alongside rather than hidden behind the
 * percentage — the voltage is the number you can check, and the one you need
 * if a divider ratio ever turns out to be wrong.
 */

#include <stdbool.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/* Where a reading came from. On the wire as an int, so the client can say
 * "measured" rather than implying a precision no board here has. */
enum battery_source {
	BATTERY_SOURCE_NONE    = 0,  /* this board cannot measure a battery */
	BATTERY_SOURCE_DIVIDER = 1,  /* resistor divider on an ADC */
	BATTERY_SOURCE_PMIC    = 2,  /* charger/PMIC, also reports charge state */
};

struct battery_status {
	/* Terminal voltage. Always valid when battery_read() returns 0. */
	uint16_t millivolts;

	/* 0-100, from the LiPo curve. Approximate; see the header comment. */
	uint8_t percent;

	/* Whether the cell is being charged right now, and whether this board
	 * can tell. A divider with no charge-status input cannot: it sees a
	 * voltage and nothing else, and *guessing* from a high reading would
	 * call a full battery on USB the same as a full battery on its own.
	 * Reporting "unknown" is the only truthful answer there. */
	bool charging;
	bool charging_known;

	/* Whether external power is attached. Same reasoning as above: known
	 * on a PMIC, unknown on a bare divider. */
	bool external_power;
	bool external_power_known;

	enum battery_source source;
};

/* True if this board declares battery-measuring hardware. For the boot log
 * and for the capability the client reads, so a UI can omit the indicator
 * rather than showing a permanently empty one. */
bool battery_present(void);

/* Take a reading.
 *
 * Returns 0 on success, -ENOTSUP if this board has no battery hardware, or a
 * negative errno if the sensor refused. Blocking: the divider path waits out
 * `power-on-sample-delay-us` and the PMIC path waits for four conversions, so
 * it is a handful of milliseconds either way. Do not call it from an ISR.
 */
int battery_read(struct battery_status *out);

/*
 * ---- Charge current, where the board lets you pick -----------------------
 *
 * A board declares a two-state charge-current control by putting a
 * `charge-high-gpios` property on `zephyr,user`, **asserted for the higher
 * current**:
 *
 *     / { zephyr,user { charge-high-gpios = <&gpio0 13 GPIO_ACTIVE_LOW>; }; };
 *
 * Which physical level means which current is a fact about the charger IC, so
 * it lives in the phandle flag — on the XIAO nRF52840 the BQ25100's HICHG pin
 * selects 100 mA when driven *low* and falls back to 50 mA when left alone,
 * so that board declares GPIO_ACTIVE_LOW and nothing here knows it.
 *
 * Deliberately two states and not a milliamp figure. This is a pin with two
 * positions, not a setting: a key that accepted "80" would have to silently
 * round it, and a rounded charge current is the kind of number someone later
 * quotes as fact. Boards whose charger is programmable express it in their own
 * devicetree instead — the nRF54LM20A's nPM1300 carries `current-microamp`
 * on its charger node.
 *
 * A board with no such property compiles the implementation away and reports
 * -ENOTSUP; the config key is still accepted everywhere, because a config.txt
 * is written once and copied across a fleet of mixed boards.
 */

/* True if this board can choose its charge current at run time. */
bool battery_charge_current_selectable(void);

/* Select the higher current, or the board's default. Returns 0 if the pin was
 * set, -ENOTSUP if this board has no such control. */
int battery_charge_current_apply(bool high);

/*
 * ---- Watching for change --------------------------------------------------
 *
 * Nothing about a battery pushes: both backends have to be asked. So a client
 * that only polls learns about a charger being plugged in whenever its timer
 * next happens to fire, which is the one battery event that is *instant* and
 * the one someone is standing there waiting to see.
 *
 * battery_monitor_start() samples on a slow timer and reports only when the
 * reading has actually moved — a change of charge or external-power state, or
 * a voltage step big enough not to be noise. On a board with no charge
 * sensing the voltage step is the only signal there is, and it is a good one:
 * attaching a charger lifts the terminal voltage immediately and by far more
 * than the sampling noise.
 *
 * The callback runs on the system workqueue. Keep it short; it must not block.
 */
typedef void (*battery_change_cb)(const struct battery_status *now);

/* Begin sampling. Safe to call on a board with no battery hardware — it does
 * nothing and the callback is never invoked. Call once, after the filesystem
 * and the radio are up. */
void battery_monitor_start(battery_change_cb cb);

/* The most recent sample, without touching the hardware. Returns false before
 * the first one, or where there is nothing to sample. Cheap: this is what the
 * GATT read handler uses, so that a read cannot block on an I2C transaction
 * inside the Bluetooth stack. */
bool battery_last(struct battery_status *out);

/* Log one line describing the battery, tagged with `when` ("boot", "dfu").
 *
 * Centralised rather than formatted at each call site so that every report of
 * the battery in the log reads identically — these logs are read after the
 * fact, from a device nobody could reach at the time, and two spellings of
 * the same fact is one more thing to reconcile. A board with no battery
 * hardware says so once at boot and is silent afterwards.
 */
void battery_log_state(const char *when);

/* The percentage a given voltage corresponds to, exposed for tests. Pure. */
uint8_t battery_percent_from_mv(uint16_t mv);

#ifdef __cplusplus
}
#endif
