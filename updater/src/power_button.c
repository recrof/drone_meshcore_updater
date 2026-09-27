/*
 * Hold-to-power-off. See power_button.h for the devicetree contract and for
 * when a hold is refused.
 */

#include "power_button.h"

#include <zephyr/kernel.h>
#include <zephyr/devicetree.h>
#include <zephyr/logging/log.h>

LOG_MODULE_REGISTER(power_button, LOG_LEVEL_INF);

#define PB_USER_NODE DT_PATH(zephyr_user)

#if DT_NODE_HAS_PROP(PB_USER_NODE, power_button_gpios)
#define HAVE_POWER_BUTTON 1
#endif

#ifdef HAVE_POWER_BUTTON

#ifndef CONFIG_SOC_FAMILY_ESPRESSIF_ESP32
#error "power-button-gpios is only implemented for ESP32 (deep sleep + EXT0 wake)"
#endif

#include <zephyr/drivers/gpio.h>
#include <zephyr/sys/poweroff.h>
#include <zephyr/logging/log_ctrl.h>

#include <esp_sleep.h>
#include <driver/rtc_io.h>
#include <soc/soc.h>
#include <soc/usb_serial_jtag_reg.h>

#include "app.h"
#include "dfu_runner.h"

/*
 * The gpio_dt_spec's pin is an index into its controller, and EXT0 wants the
 * chip's GPIO number. They agree only on the first controller, and a button
 * on gpio1 would be a board this has never seen, so that one is required
 * rather than translated.
 */
BUILD_ASSERT(DT_SAME_NODE(DT_GPIO_CTLR(PB_USER_NODE, power_button_gpios),
			  DT_NODELABEL(gpio0)),
	     "power-button-gpios must be on gpio0, so its pin is the GPIO number");

static const struct gpio_dt_spec s_btn =
	GPIO_DT_SPEC_GET(PB_USER_NODE, power_button_gpios);

/*
 * 4 s, because every shorter hold is already taken on this board. A tap on B
 * does nothing at run time, and B held *through a reset* is the ROM's
 * download-mode strap. A deliberate four-second hold is not something a
 * pocket or a finger resting on the board produces by accident.
 */
#define POWER_BUTTON_HOLD_MS 4000

/* Polled rather than interrupt-driven. The button is on GPIO0, a strapping
 * pin, and 50 ms is both the debounce and a resolution nobody holding a
 * button for four seconds will notice. */
#define POWER_BUTTON_POLL_MS 50

/*
 * Between the release and the sleep. It covers two things: contact bounce on
 * the release, which would otherwise wake the chip the instant it slept (the
 * wake source is level-low), and the deferred log thread. That thread runs
 * every CONFIG_LOG_PROCESS_THREAD_SLEEP_MS and writes the "powering off" line
 * to the filesystem log, which is the only record of why the device went
 * dark.
 */
#define POWER_BUTTON_SETTLE_MS 250

enum pb_phase {
	PB_WATCHING,   /* counting how long the button has been held */
	PB_REFUSED,    /* hold reached but refused; waiting for a release */
	PB_RELEASING,  /* accepted; LED dark, waiting for the finger to lift */
	PB_SETTLING,   /* released; one last check, then sleep */
};

static enum pb_phase s_phase;
static uint32_t s_held_ms;

static void poll_fn(struct k_work *work);
static K_WORK_DELAYABLE_DEFINE(poll_work, poll_fn);

/*
 * Whether a USB host is talking to the USB-Serial-JTAG peripheral.
 *
 * A host sends a start-of-frame every millisecond and the peripheral latches
 * its 11-bit frame number. The peripheral is clocked whether or not anything
 * is plugged in, so a counter that moves across a few milliseconds is a host.
 * One that stands still is either no cable or a cable with only power on it,
 * and both of those are "on battery" for this purpose (see power_button.h).
 */
static bool usb_host_present(void)
{
	uint32_t a = REG_READ(USB_SERIAL_JTAG_FRAM_NUM_REG) & USB_SERIAL_JTAG_SOF_FRAME_INDEX;

	k_msleep(3);

	uint32_t b = REG_READ(USB_SERIAL_JTAG_FRAM_NUM_REG) & USB_SERIAL_JTAG_SOF_FRAME_INDEX;

	return a != b;
}

static bool pressed(void)
{
	return gpio_pin_get_dt(&s_btn) == 1;
}

static void power_off(void)
{
	/*
	 * EXT0 watches one RTC-capable pin from the RTC domain, which
	 * z_sys_poweroff() already keeps powered for exactly this. The pull-up
	 * is restated in RTC terms: the digital pad's pull does not survive
	 * into deep sleep, and a floating wake pin is a board that wakes up
	 * again by itself.
	 *
	 * The strap is not a problem on the way back. GPIO0 is latched only on
	 * a chip reset, not on a deep-sleep wake, so pressing B to wake boots
	 * this application and not the ROM downloader.
	 */
	gpio_num_t io = (gpio_num_t)s_btn.pin;

	rtc_gpio_pullup_en(io);
	rtc_gpio_pulldown_dis(io);

	int err = esp_sleep_enable_ext0_wakeup(io, 0);

	if (err != 0) {
		/* Sleeping anyway would leave RESET as the only way back. That
		 * works, but it isn't what the button promised, so refuse. */
		LOG_ERR("power button: GPIO%d cannot be a wake source (%d) — "
			"staying on", io, err);
		led_set_state(LED_STATE_IDLE);
		s_phase = PB_WATCHING;
		s_held_ms = 0;
		k_work_reschedule(&poll_work, K_MSEC(POWER_BUTTON_POLL_MS));
		return;
	}

	sys_poweroff();
}

static void poll_fn(struct k_work *work)
{
	ARG_UNUSED(work);

	bool down = pressed();

	switch (s_phase) {
	case PB_WATCHING:
		if (!down) {
			s_held_ms = 0;
			break;
		}
		s_held_ms += POWER_BUTTON_POLL_MS;
		if (s_held_ms < POWER_BUTTON_HOLD_MS) {
			break;
		}
		if (dfu_runner_busy()) {
			LOG_WRN("power button: a DFU run is in progress — "
				"ignoring; stop the run first");
			s_phase = PB_REFUSED;
		} else if (usb_host_present()) {
			LOG_INF("power button: USB host attached — ignoring");
			s_phase = PB_REFUSED;
		} else {
			/* The LED going dark *while still held* is the cue to
			 * let go; the sleep itself waits for the release. */
			LOG_INF("power button: powering off, press B to wake");
			led_set_state(LED_STATE_OFF);
			s_phase = PB_RELEASING;
		}
		break;

	case PB_REFUSED:
		if (!down) {
			s_held_ms = 0;
			s_phase = PB_WATCHING;
		}
		break;

	case PB_RELEASING:
		if (!down) {
			s_phase = PB_SETTLING;
			k_work_reschedule(&poll_work, K_MSEC(POWER_BUTTON_SETTLE_MS));
			return;
		}
		break;

	case PB_SETTLING:
		if (down) {
			/* Bounced, or pressed again: the wake source is a low
			 * level, so sleeping now would wake at once. */
			s_phase = PB_RELEASING;
			break;
		}
		/* Anything still queued gets one last chance to reach the
		 * filesystem log, bounded so a stuck backend cannot keep the
		 * device awake. */
		for (int i = 0; i < 20 && log_data_pending(); i++) {
			k_msleep(10);
		}
		power_off();
		return;
	}

	k_work_reschedule(&poll_work, K_MSEC(POWER_BUTTON_POLL_MS));
}

static void log_wake_cause(void)
{
	/* hwinfo already reports "low-power wake" in the reset-cause line.
	 * This says which source did it, which is the part that tells a
	 * button press from anything else. */
	esp_sleep_wakeup_cause_t cause = esp_sleep_get_wakeup_cause();

	if (cause == ESP_SLEEP_WAKEUP_EXT0) {
		LOG_INF("power button: woken from deep sleep by the button");
	} else if (cause != ESP_SLEEP_WAKEUP_UNDEFINED) {
		LOG_INF("power button: woken from deep sleep (cause %d)", cause);
	}
}

#endif /* HAVE_POWER_BUTTON */

bool power_button_present(void)
{
#ifdef HAVE_POWER_BUTTON
	return true;
#else
	return false;
#endif
}

void power_button_start(void)
{
#ifdef HAVE_POWER_BUTTON
	log_wake_cause();

	if (!gpio_is_ready_dt(&s_btn) ||
	    gpio_pin_configure_dt(&s_btn, GPIO_INPUT) != 0) {
		LOG_ERR("power button: GPIO not usable — hold-to-power-off "
			"is disabled");
		return;
	}
	s_phase = PB_WATCHING;
	s_held_ms = 0;
	k_work_reschedule(&poll_work, K_MSEC(POWER_BUTTON_POLL_MS));
#endif
}
