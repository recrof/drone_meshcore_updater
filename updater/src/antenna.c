/*
 * Antenna path selection. See antenna.h for the devicetree contract.
 */

#include "antenna.h"

#include <zephyr/kernel.h>
#include <zephyr/devicetree.h>
#include <zephyr/logging/log.h>

LOG_MODULE_REGISTER(antenna, LOG_LEVEL_INF);

#define ANT_NODE DT_PATH(zephyr_user)

#if DT_NODE_EXISTS(ANT_NODE) && DT_NODE_HAS_PROP(ANT_NODE, antenna_gpios)
#define HAVE_ANTENNA_SWITCH 1
#include <zephyr/drivers/gpio.h>

/* Asserted (logical 1) selects the external connector — the board's phandle
 * flags decide what that is physically. */
static const struct gpio_dt_spec s_ant = GPIO_DT_SPEC_GET(ANT_NODE, antenna_gpios);
#endif

bool antenna_switchable(void)
{
#ifdef HAVE_ANTENNA_SWITCH
	return true;
#else
	return false;
#endif
}

int antenna_apply(bool external)
{
#ifdef HAVE_ANTENNA_SWITCH
	if (!gpio_is_ready_dt(&s_ant)) {
		LOG_ERR("antenna switch GPIO not ready — leaving it as the "
			"board file set it");
		return -ENODEV;
	}

	/*
	 * Configured every time rather than once at init, because on the boards
	 * that have a switch the pin usually arrives here already claimed by a
	 * `gpio-hog` in the board's own devicetree. The hog sets the power-on
	 * default and is what runs if this firmware never calls in; taking the
	 * pin back is a plain re-configure, and doing it as OUTPUT_ACTIVE /
	 * OUTPUT_INACTIVE sets the direction and the level in one go so the
	 * pin never passes through the wrong state.
	 */
	int rc = gpio_pin_configure_dt(&s_ant,
				       external ? GPIO_OUTPUT_ACTIVE : GPIO_OUTPUT_INACTIVE);
	if (rc) {
		LOG_ERR("antenna switch: gpio_pin_configure rc=%d", rc);
		return rc;
	}

	LOG_INF("antenna: %s", external ? "external connector" : "on-board");
	return 0;
#else
	if (external) {
		/* Only worth a word when the operator asked for something this
		 * board cannot do. Staying on the on-board antenna is what a
		 * board with one antenna does anyway, so the false case is not
		 * a warning, it is just the truth. */
		LOG_WRN("`ext_antenna` is set, but this board declares no "
			"antenna switch (no antenna-gpios under zephyr,user), "
			"so the setting has no effect.");
	}
	return -ENOTSUP;
#endif
}
