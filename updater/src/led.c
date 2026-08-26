/*
 * LED driver — the Seeed XIAO nRF54LM20A carrier exposes three onboard LEDs
 * (blue / red / green, all active-high on gpio1) via the standard Zephyr
 * gpio-leds bindings. Aliases from the board DTS:
 *   led0 = blue_led   (gpio1 pin 23)
 *   led1 = red_led    (gpio1 pin 22)
 *   led2 = green_led  (gpio1 pin 24)
 *
 * Patterns are chosen so the device's state is readable across a room:
 *   IDLE          BLUE slow blink (~1 Hz)
 *   SMP_ACTIVE    BLUE fast blink (~4 Hz)   — file upload in progress
 *   DFU_RUNNING   GREEN blink period shrinks 600 ms → 30 ms with progress
 *   DONE_OK       GREEN solid
 *   DONE_FAIL     RED solid
 */

#include <zephyr/kernel.h>
#include <zephyr/drivers/gpio.h>
#include <zephyr/logging/log.h>
#include "app.h"

LOG_MODULE_REGISTER(led, LOG_LEVEL_INF);

static const struct gpio_dt_spec s_blue  = GPIO_DT_SPEC_GET(DT_ALIAS(led0), gpios);
static const struct gpio_dt_spec s_red   = GPIO_DT_SPEC_GET(DT_ALIAS(led1), gpios);
static const struct gpio_dt_spec s_green = GPIO_DT_SPEC_GET(DT_ALIAS(led2), gpios);

static atomic_t s_state    = ATOMIC_INIT(LED_STATE_IDLE);
static atomic_t s_progress = ATOMIC_INIT(0);

static void led_thread(void *a, void *b, void *c);
K_THREAD_DEFINE(led_tid, 512, led_thread, NULL, NULL, NULL, 7, 0, 0);

static void configure(const struct gpio_dt_spec *g)
{
	if (!gpio_is_ready_dt(g)) {
		LOG_ERR("led gpio not ready: port %s pin %u",
			g->port ? g->port->name : "?", g->pin);
		return;
	}
	gpio_pin_configure_dt(g, GPIO_OUTPUT_INACTIVE);
}

void led_init(void)
{
	configure(&s_blue);
	configure(&s_red);
	configure(&s_green);
}

void led_set_state(enum led_state s)  { atomic_set(&s_state, s); }
void led_set_progress(uint8_t pct)     { atomic_set(&s_progress, pct); }

static void write_all(bool r, bool g, bool b)
{
	gpio_pin_set_dt(&s_red,   r);
	gpio_pin_set_dt(&s_green, g);
	gpio_pin_set_dt(&s_blue,  b);
}

static void led_thread(void *a, void *b, void *c)
{
	ARG_UNUSED(a); ARG_UNUSED(b); ARG_UNUSED(c);
	bool phase = false;

	while (true) {
		enum led_state st = (enum led_state)atomic_get(&s_state);
		uint32_t half_ms;

		switch (st) {
		case LED_STATE_IDLE:
			half_ms = 500;
			write_all(false, false, phase);
			break;

		case LED_STATE_SMP_ACTIVE:
			half_ms = 125;
			write_all(false, false, phase);
			break;

		case LED_STATE_DFU_RUNNING: {
			uint8_t pct = (uint8_t)atomic_get(&s_progress);
			if (pct >= 100) {
				half_ms = 1000;
				write_all(false, true, false);
				break;
			}
			half_ms = 600 - ((uint32_t)pct * (600 - 30)) / 100;
			write_all(false, phase, false);
			break;
		}

		case LED_STATE_DONE_OK:
			half_ms = 1000;
			write_all(false, true, false);
			break;

		case LED_STATE_DONE_FAIL:
			half_ms = 1000;
			write_all(true, false, false);
			break;

		default:
			half_ms = 500;
			write_all(false, false, false);
			break;
		}

		k_sleep(K_MSEC(half_ms));
		phase = !phase;
	}
}
