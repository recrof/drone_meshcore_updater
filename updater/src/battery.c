/*
 * Battery monitoring. See battery.h for the devicetree contract and for why
 * the percentage is approximate on every board here.
 */

#include "battery.h"

#include <zephyr/kernel.h>
#include <zephyr/devicetree.h>
#include <zephyr/logging/log.h>

#include <errno.h>
#include <string.h>

LOG_MODULE_REGISTER(battery, LOG_LEVEL_INF);

/* ------------------------------------------------------------------ *
 * Which shape of hardware this board declared
 * ------------------------------------------------------------------ */

#define BATT_DIVIDER_NODE DT_ALIAS(battery_voltage)

#if DT_HAS_COMPAT_STATUS_OKAY(nordic_npm1300_charger)
#define HAVE_PMIC 1
#elif DT_NODE_EXISTS(BATT_DIVIDER_NODE)
#define HAVE_DIVIDER 1
#endif

#if defined(HAVE_PMIC) || defined(HAVE_DIVIDER)
#define HAVE_BATTERY 1
#include <zephyr/drivers/sensor.h>
#endif

#ifdef HAVE_PMIC
#include <zephyr/drivers/sensor/npm13xx_charger.h>
static const struct device *const s_batt = DEVICE_DT_GET_ONE(nordic_npm1300_charger);
#endif

#ifdef HAVE_DIVIDER
static const struct device *const s_batt = DEVICE_DT_GET(BATT_DIVIDER_NODE);
#endif

/* Optional charge-status input, for a board whose charger IC exposes one but
 * which reads its voltage through a plain divider. */
#define BATT_USER_NODE DT_PATH(zephyr_user)
#if defined(HAVE_BATTERY) && DT_NODE_HAS_PROP(BATT_USER_NODE, charging_gpios)
#define HAVE_CHARGING_GPIO 1
#include <zephyr/drivers/gpio.h>
/* Asserted (logical 1) means charging — the board's phandle flags say which
 * physical level that is. On the XIAO nRF52840 the BQ25100's ~CHG pin pulls
 * low while charging, so that board declares GPIO_ACTIVE_LOW and nothing here
 * has to know it. */
static const struct gpio_dt_spec s_charging =
	GPIO_DT_SPEC_GET(BATT_USER_NODE, charging_gpios);
#endif

/* Optional two-state charge-current control. Independent of whether the board
 * can *measure* a battery: the RAK4631 charges on its base board and reads a
 * divider, and a board could perfectly well offer the pin and no divider. */
#if DT_NODE_HAS_PROP(BATT_USER_NODE, charge_high_gpios)
#define HAVE_CHARGE_SELECT 1
#include <zephyr/drivers/gpio.h>
/* Asserted (logical 1) selects the *higher* current — the board's phandle
 * flags say which physical level that is. */
static const struct gpio_dt_spec s_charge_high =
	GPIO_DT_SPEC_GET(BATT_USER_NODE, charge_high_gpios);
#endif

bool battery_charge_current_selectable(void)
{
#ifdef HAVE_CHARGE_SELECT
	return true;
#else
	return false;
#endif
}

int battery_charge_current_apply(bool high)
{
#ifdef HAVE_CHARGE_SELECT
	if (!gpio_is_ready_dt(&s_charge_high)) {
		LOG_ERR("charge-current GPIO not ready — leaving the charger at "
			"its default");
		return -ENODEV;
	}
	/*
	 * The low setting is *not* the inactive output level, it is the pin
	 * left alone. On the BQ25100 the current-select input is sampled
	 * against a resistor and driving it inactive is not the same as
	 * releasing it, so the two states are "output asserted" and
	 * "disconnected" rather than a simple high/low pair.
	 */
	int rc = high ? gpio_pin_configure_dt(&s_charge_high, GPIO_OUTPUT_ACTIVE)
		      : gpio_pin_configure_dt(&s_charge_high, GPIO_DISCONNECTED);

	if (rc != 0) {
		LOG_ERR("could not set the charge current (%d)", rc);
		return rc;
	}
	LOG_INF("charge current: %s", high ? "high" : "board default");
	return 0;
#else
	ARG_UNUSED(high);
	return -ENOTSUP;
#endif
}

/* ------------------------------------------------------------------ *
 * Voltage -> percentage
 * ------------------------------------------------------------------ */

/* The voltage -> percentage curve lives in battery_curve.c, which includes
 * no Zephyr headers so that battery.test.mjs can compile it on the host and
 * exercise the interpolation directly. Same arrangement, for the same
 * reason, as pin_addr.c and Trap 10: asserting that two sides mention a
 * function is not a test of what the function computes. */

/* ------------------------------------------------------------------ *
 * Reading
 * ------------------------------------------------------------------ */

bool battery_present(void)
{
#ifdef HAVE_BATTERY
	return true;
#else
	return false;
#endif
}

#ifdef HAVE_PMIC
/*
 * nPM1300 BCHGCHARGESTATUS, from the product specification. Bit 0 says a
 * battery was detected at all and bit 1 that charging *finished*; the four in
 * between are the states in which current is actually flowing.
 *
 * "Completed" is deliberately not counted as charging. It is the state a full
 * cell sits in for as long as USB stays attached, and reporting that as
 * "charging" would mean the indicator never settles — which is precisely the
 * question someone glances at it to answer.
 */
#define CHG_STAT_BATTERY_DETECTED BIT(0)
#define CHG_STAT_COMPLETED        BIT(1)
#define CHG_STAT_TRICKLE          BIT(2)
#define CHG_STAT_CONST_CURRENT    BIT(3)
#define CHG_STAT_CONST_VOLTAGE    BIT(4)
#define CHG_STAT_RECHARGE         BIT(5)

#define CHG_STAT_ACTIVE (CHG_STAT_TRICKLE | CHG_STAT_CONST_CURRENT | \
			 CHG_STAT_CONST_VOLTAGE | CHG_STAT_RECHARGE)

/* VBUSINSTATUS bit 0 — the driver's own STATUS_PRESENT_MASK. */
#define VBUS_STAT_PRESENT BIT(0)
#endif

int battery_read(struct battery_status *out)
{
	if (out == NULL) {
		return -EINVAL;
	}
	memset(out, 0, sizeof(*out));

#ifndef HAVE_BATTERY
	out->source = BATTERY_SOURCE_NONE;
	return -ENOTSUP;
#else
	if (!device_is_ready(s_batt)) {
		/*
		 * "Not ready" here means the driver's own init returned an
		 * error, and neither Zephyr's npm13xx charger nor its MFD
		 * parent logs a single line when that happens — mfd_npm13xx.c
		 * contains no LOG_* at all. So this message has to carry the
		 * diagnosis, because the next person will have exactly one
		 * line of evidence and a board they cannot reach.
		 *
		 * On the PMIC path the charger writes to the chip in its very
		 * first init step, so a failure means the part did not answer:
		 * either its rail is down (see `power_en` in this board's
		 * .conf — that was the cause the first time) or the bus
		 * itself is wrong.
		 */
#ifdef HAVE_PMIC
		LOG_ERR("battery: the PMIC (%s) did not answer during init — "
			"its rail or its I2C bus is wrong, not this code",
			s_batt->name);
		LOG_ERR("battery: check that power_en is asserted "
			"(CONFIG_REGULATOR + CONFIG_REGULATOR_FIXED) and that "
			"the pmic_i2c pins match the board");
#else
		LOG_ERR("battery: the ADC divider (%s) is not ready",
			s_batt->name);
#endif
		return -ENODEV;
	}

	int rc = sensor_sample_fetch(s_batt);
	if (rc != 0) {
		LOG_ERR("battery sample failed (%d)", rc);
		return rc;
	}

	struct sensor_value val;

#ifdef HAVE_PMIC
	out->source = BATTERY_SOURCE_PMIC;
	rc = sensor_channel_get(s_batt, SENSOR_CHAN_GAUGE_VOLTAGE, &val);
#else
	out->source = BATTERY_SOURCE_DIVIDER;
	/* The driver has already multiplied by full-ohms/output-ohms, so this
	 * is the battery terminal voltage and not the voltage at the pin. */
	rc = sensor_channel_get(s_batt, SENSOR_CHAN_VOLTAGE, &val);
#endif
	if (rc != 0) {
		LOG_ERR("battery voltage unreadable (%d)", rc);
		return rc;
	}

	int64_t mv = sensor_value_to_milli(&val);
	if (mv < 0) {
		mv = 0;
	} else if (mv > UINT16_MAX) {
		mv = UINT16_MAX;
	}
	out->millivolts = (uint16_t)mv;
	out->percent = battery_percent_from_mv(out->millivolts);

#ifdef HAVE_PMIC
	struct sensor_value st;

	if (sensor_channel_get(s_batt, SENSOR_CHAN_NPM13XX_CHARGER_STATUS, &st) == 0) {
		out->charging = (st.val1 & CHG_STAT_ACTIVE) != 0;
		out->charging_known = true;
	}
	if (sensor_channel_get(s_batt, SENSOR_CHAN_NPM13XX_CHARGER_VBUS_STATUS, &st) == 0) {
		out->external_power = (st.val1 & VBUS_STAT_PRESENT) != 0;
		out->external_power_known = true;
	}
#endif

#ifdef HAVE_CHARGING_GPIO
	/* Configured on every read rather than once at init, and with no bias
	 * added here: the pin is an open-drain status output on a charger IC
	 * powered from the USB rail it reports on, so it floats when the board
	 * is running on the cell alone and *needs* a pull — but which one is a
	 * board fact, so it travels in the devicetree flags with the polarity
	 * rather than being assumed to be a pull-up here. */
	if (gpio_is_ready_dt(&s_charging) &&
	    gpio_pin_configure_dt(&s_charging, GPIO_INPUT) == 0) {
		int lvl = gpio_pin_get_dt(&s_charging);

		if (lvl >= 0) {
			out->charging = (lvl != 0);
			out->charging_known = true;
		}
	}
#endif

	return 0;
#endif /* HAVE_BATTERY */
}

void battery_log_state(const char *when)
{
	struct battery_status st;
	int rc = battery_read(&st);

	if (rc == -ENOTSUP) {
		/* Only at boot. Repeating it per DFU would put a line about
		 * absent hardware into the middle of every transfer log. */
		if (when != NULL && strcmp(when, "boot") == 0) {
			LOG_INF("battery: no measuring hardware on this board");
		}
		return;
	}
	if (rc != 0) {
		LOG_WRN("battery [%s]: unreadable (%d)", when ? when : "?", rc);
		return;
	}

	/* The voltage first, because it is the measured one — see battery.h on
	 * why the percentage is the softer number of the two. */
	LOG_INF("battery [%s]: %u mV (~%u%%)%s%s", when ? when : "?",
		st.millivolts, st.percent,
		st.charging_known ? (st.charging ? ", charging" : ", not charging") : "",
		st.external_power_known ? (st.external_power ? ", on external power" : ", on battery")
					: "");
}

/* ------------------------------------------------------------------ *
 * Change monitor
 * ------------------------------------------------------------------ */

/*
 * How often the hardware is asked. A cell moves over tens of minutes, so this
 * is not about tracking the level — the client's own slow poll does that. It
 * is about noticing the two things that happen in an instant: a charger going
 * in, and a charger coming out.
 *
 * 10 s is the compromise. Faster buys nothing a human would notice on a
 * charger, and every sample on the PMIC boards is a bit-banged I2C
 * transaction that runs on the system workqueue.
 */
#define BATTERY_SAMPLE_MS 10000

/*
 * What counts as a real move rather than noise.
 *
 * This is the *only* signal on a board with no charge sensing, which is two
 * of the three, so it has to be chosen for that case rather than as an
 * afterthought. Attaching a charger to a single-cell LiPo lifts the terminal
 * voltage by well over a hundred millivolts as the charger drives it; the
 * sampling spread on a settled cell is a few millivolts on the PMIC and a bit
 * more across a megohm divider.
 *
 * 50 mV sits between those with room on both sides. Lower would report the
 * radio keying up as an event; much higher would miss a charger attached to
 * an already-full cell, where the step is smallest.
 *
 * Note this is compared against the value last *reported*, not the previous
 * sample. A slow drift that crosses the threshold one millivolt at a time
 * still gets reported exactly once, rather than never.
 */
#define BATTERY_STEP_MV 50

#ifdef HAVE_BATTERY
static battery_change_cb s_cb;
static struct battery_status s_last;      /* most recent sample */
static struct battery_status s_reported;  /* what the callback last saw */
static bool s_have_last;
static bool s_have_reported;

static void sample_fn(struct k_work *work);
static K_WORK_DELAYABLE_DEFINE(sample_work, sample_fn);

static bool worth_reporting(const struct battery_status *now)
{
	if (!s_have_reported) {
		return true;
	}
	/* A state change is the event; report it whatever the voltage did.
	 * `*_known` is compared too, so a board that gains or loses the
	 * ability to tell is itself a change worth passing on. */
	if (now->charging_known != s_reported.charging_known ||
	    now->charging != s_reported.charging ||
	    now->external_power_known != s_reported.external_power_known ||
	    now->external_power != s_reported.external_power) {
		return true;
	}
	int delta = (int)now->millivolts - (int)s_reported.millivolts;

	if (delta < 0) {
		delta = -delta;
	}
	return delta >= BATTERY_STEP_MV;
}

static void sample_fn(struct k_work *work)
{
	ARG_UNUSED(work);

	struct battery_status now;

	if (battery_read(&now) == 0) {
		s_last = now;
		s_have_last = true;

		if (worth_reporting(&now)) {
			s_reported = now;
			s_have_reported = true;
			/* Logged as well as pushed. The device's own log is the
			 * only account of an unattended run, and "the charger
			 * came out at 00:41:12" is exactly the line that
			 * explains a transfer that stopped. */
			LOG_INF("battery: %u mV (~%u%%)%s", now.millivolts, now.percent,
				now.charging_known
					? (now.charging ? " — charging" : " — not charging")
					: "");
			if (s_cb != NULL) {
				s_cb(&now);
			}
		}
	}

	k_work_reschedule(&sample_work, K_MSEC(BATTERY_SAMPLE_MS));
}
#endif /* HAVE_BATTERY */

void battery_monitor_start(battery_change_cb cb)
{
#ifdef HAVE_BATTERY
	s_cb = cb;
	/* First sample immediately, so a client connecting seconds after boot
	 * has something real to read rather than an empty record. */
	k_work_reschedule(&sample_work, K_NO_WAIT);
#else
	ARG_UNUSED(cb);
#endif
}

bool battery_last(struct battery_status *out)
{
#ifdef HAVE_BATTERY
	if (!s_have_last || out == NULL) {
		return false;
	}
	*out = s_last;
	return true;
#else
	ARG_UNUSED(out);
	return false;
#endif
}
