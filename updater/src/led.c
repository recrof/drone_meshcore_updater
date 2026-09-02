/*
 * Status LED.
 *
 * Asked for by colour, not by led0/led1/led2: the numbering is not the same
 * between boards. On xiao_nrf54lm20a led0 is blue; on xiao_ble it is red.
 * Each board overlay supplies blue-led / red-led / green-led aliases, so
 * swapping boards cannot silently swap the colours — which would turn
 * "DONE_FAIL red" into "DONE_FAIL blue" with nothing failing to build.
 *
 * ---- Three boards' worth of LED, and they are not the same shape -------
 *
 * Both XIAO nRF parts carry an RGB LED as three gpio-leds, common-anode, so
 * the pin sinks and physical LOW is lit. The RAK4631 has **two**, green and
 * blue, and no red. The XIAO ESP32S3 has **one**. Those are not smaller
 * versions of the same thing: colour is what separates DONE_OK from
 * DONE_FAIL, and on one LED both are simply "on".
 *
 * So there are three renderers, chosen at build time by which aliases the
 * board supplies:
 *
 *   state          RGB board                two-colour            mono board
 *   IDLE           blue, slow ~1 Hz         blue, slow ~1 Hz      slow ~1 Hz
 *   SMP_ACTIVE     blue, fast ~4 Hz         blue, fast ~4 Hz      fast ~4 Hz
 *   DFU_RUNNING    green, 600 -> 30 ms      green, 600 -> 30 ms   600 -> 30 ms
 *   DONE_OK        green solid              green solid           solid
 *   DONE_FAIL      red solid                BOTH, blink-blink-    blink-blink-
 *                                           pause                 pause
 *
 * **DONE_FAIL is the only thing either fallback has to invent**, and that is
 * deliberate. Everything above it is already distinguishable by rate; only the
 * two terminal states collide, and they are exactly the two you read the LED
 * to tell apart. A repeating double flash is the conventional way to say
 * "fault" with one indicator and cannot be confused with any of the even-duty
 * patterns above it.
 *
 * The two-colour board keeps the RGB column verbatim everywhere it can, so a
 * RAK4631 and a XIAO sitting side by side read the same — blue is waiting,
 * green is working, and nobody has to learn a second vocabulary. Lighting
 * *both* for a failure is the one appearance no other state produces. Green
 * was available and was not used: it already means "this went well" in the two
 * states either side, and a failure indicator borrowing the success colour is
 * the one confusion worth spending a pattern to avoid.
 *
 * **An earlier version of this board used the mono renderer on its green LED
 * and left the blue unclaimed.** Nothing was ambiguous about it, and it was
 * still wrong: it made the same firmware on two boards in the same room say
 * "idle" in two different colours. Consistency across boards is worth more
 * than a spare pin.
 *
 * A board supplying no usable set of aliases is a build error rather than a
 * device with a dark LED: a silently unlit status indicator on a device that
 * is usually not in the room is indistinguishable from a device that is not
 * running.
 */

#include <zephyr/kernel.h>
#include <zephyr/drivers/gpio.h>
#include <zephyr/logging/log.h>
#include "app.h"

LOG_MODULE_REGISTER(led, LOG_LEVEL_INF);

#define LED_HAVE_RGB (DT_NODE_EXISTS(DT_ALIAS(red_led)) &&   \
		      DT_NODE_EXISTS(DT_ALIAS(green_led)) && \
		      DT_NODE_EXISTS(DT_ALIAS(blue_led)))

/* Green and blue but no red — the RAK4631. See the header. */
#define LED_HAVE_DUO (!LED_HAVE_RGB &&                       \
		      DT_NODE_EXISTS(DT_ALIAS(green_led)) && \
		      DT_NODE_EXISTS(DT_ALIAS(blue_led)))

#if !LED_HAVE_RGB && !LED_HAVE_DUO && !DT_NODE_EXISTS(DT_ALIAS(status_led))
#error "This board supplies no LED aliases. Give the board overlay \
red-led/green-led/blue-led (RGB), green-led/blue-led (two-colour), or \
status-led (single LED)."
#endif

#if LED_HAVE_RGB
static const struct gpio_dt_spec s_blue  = GPIO_DT_SPEC_GET(DT_ALIAS(blue_led), gpios);
static const struct gpio_dt_spec s_red   = GPIO_DT_SPEC_GET(DT_ALIAS(red_led), gpios);
static const struct gpio_dt_spec s_green = GPIO_DT_SPEC_GET(DT_ALIAS(green_led), gpios);
#elif LED_HAVE_DUO
static const struct gpio_dt_spec s_blue  = GPIO_DT_SPEC_GET(DT_ALIAS(blue_led), gpios);
static const struct gpio_dt_spec s_green = GPIO_DT_SPEC_GET(DT_ALIAS(green_led), gpios);
#else
static const struct gpio_dt_spec s_status = GPIO_DT_SPEC_GET(DT_ALIAS(status_led), gpios);
#endif

static atomic_t s_state    = ATOMIC_INIT(LED_STATE_IDLE);
static atomic_t s_progress = ATOMIC_INIT(0);

/*
 * Stack for the blink thread, which does nothing but read an atomic, poke a
 * GPIO and sleep — so this is not sized for what the *thread* does. It is
 * sized for what lands on it.
 *
 * 512 was chosen when the nRF boards were the only ones, and it is fine there.
 * On Xtensa it is not, and the arch's own numbers say so: Zephyr gives its
 * **idle** thread 1024 bytes on this part against 320 on the nRF52840. An
 * Xtensa exception or interrupt frame is pushed onto whichever thread was
 * running — a base save area plus up to three four-register blocks — and the
 * windowed ABI spills through the same space, so the arriving frame is large
 * and its size is not something this thread controls.
 *
 * **And there is no net on that board.** `HW_STACK_PROTECTION` needs
 * `ARCH_HAS_STACK_PROTECTION`, which Xtensa does not select — so an overflow
 * there is not a fault, it is silent corruption of whatever lies below,
 * surfacing later as an unrelated exception somewhere innocent. That is
 * exactly what a crash record from this thread looked like: reason 0, a
 * plausible stack pointer, and 224 bytes apparently still free.
 * `CONFIG_STACK_SENTINEL` (see prj.conf) is the partial answer; a stack that
 * is not marginal in the first place is the rest of it.
 */
/*
 * Keyed on the *guard*, not on the architecture.
 *
 * This was `#if defined(CONFIG_XTENSA)` when only the ESP32-S3 needed the
 * larger stack, and that read as though Xtensa frames were the problem. They
 * are part of it, but the reason 512 was survivable on both nRF parts and not
 * on the S3 is that the nRF parts trap an overflow at the instruction that
 * causes it and the S3 does not.
 *
 * The XIAO ESP32C5 is what made the distinction matter. It is RISC-V, so the
 * architecture test would have given it 512 — and RISC-V *does* offer
 * ARCH_HAS_STACK_PROTECTION. But that is selected by RISCV_PMP, which is not
 * set on this SoC (it spends its PMP entries on the IRAM/DRAM split), so
 * CONFIG_HW_STACK_PROTECTION comes out unset and an overflow here is silent
 * corruption that surfaces later somewhere innocent — exactly the S3's
 * situation, reached by a completely different route.
 *
 * So: a board with no hardware stack guard gets the headroom, whatever it is
 * built out of. A board with one gets 512 and a loud fault if that is wrong.
 */
#if defined(CONFIG_HW_STACK_PROTECTION)
#define LED_STACK_SIZE 512
#else
#define LED_STACK_SIZE 2048
#endif

static void led_thread(void *a, void *b, void *c);
K_THREAD_DEFINE(led_tid, LED_STACK_SIZE, led_thread, NULL, NULL, NULL, 7, 0, 0);

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
#if LED_HAVE_RGB
	configure(&s_blue);
	configure(&s_red);
	configure(&s_green);
#elif LED_HAVE_DUO
	configure(&s_blue);
	configure(&s_green);
#else
	configure(&s_status);
#endif
}

void led_set_state(enum led_state s)  { atomic_set(&s_state, s); }
void led_set_progress(uint8_t pct)     { atomic_set(&s_progress, pct); }

/*
 * The blink rate for DFU_RUNNING, shared by both renderers: the half-period
 * shrinks from 600 ms to 30 ms across the transfer, so the LED visibly speeds
 * up as the image goes out. 100% holds solid — the transfer is done and the
 * peer is validating.
 */
static uint32_t dfu_half_ms(uint8_t pct)
{
	return 600 - ((uint32_t)pct * (600 - 30)) / 100;
}

#if LED_HAVE_RGB

static void write_all(bool r, bool g, bool b)
{
	gpio_pin_set_dt(&s_red,   r);
	gpio_pin_set_dt(&s_green, g);
	gpio_pin_set_dt(&s_blue,  b);
}

static uint32_t render(enum led_state st, uint32_t step)
{
	bool phase = step & 1U;

	switch (st) {
	case LED_STATE_IDLE:
		write_all(false, false, phase);
		return 500;

	case LED_STATE_SMP_ACTIVE:
		write_all(false, false, phase);
		return 125;

	case LED_STATE_DFU_RUNNING: {
		uint8_t pct = (uint8_t)atomic_get(&s_progress);
		if (pct >= 100) {
			write_all(false, true, false);
			return 1000;
		}
		write_all(false, phase, false);
		return dfu_half_ms(pct);
	}

	case LED_STATE_DONE_OK:
		write_all(false, true, false);
		return 1000;

	case LED_STATE_DONE_FAIL:
		write_all(true, false, false);
		return 1000;

	default:
		write_all(false, false, false);
		return 500;
	}
}

#elif LED_HAVE_DUO

/*
 * Green and blue, no red.
 *
 * **Every state renders exactly as it does on an RGB board except the one
 * that cannot.** That is the whole design goal: someone who knows what a XIAO
 * looks like should not have to learn a second vocabulary to read a RAK4631
 * sitting next to it. Blue is the device waiting, green is the device working
 * — same colours, same rates, same meaning.
 *
 * DONE_FAIL is the exception, because red is the thing this board does not
 * have. It lights **both** LEDs in the mono renderer's double-flash pattern,
 * which is the one appearance nothing else here produces — no other state
 * drives both pins at once. Reusing green would have been worse than a new
 * pattern: green already means "this went well" in the two states either side
 * of it, and a failure indicator that borrows the success colour is the one
 * confusion worth spending a pattern to avoid.
 */
static void write_gb(bool g, bool b)
{
	gpio_pin_set_dt(&s_green, g);
	gpio_pin_set_dt(&s_blue,  b);
}

/* Shared with the mono renderer below — see the comment there for the timing. */
static const bool k_fail_pattern[] = { true, false, true, false, false, false };

static uint32_t render(enum led_state st, uint32_t step)
{
	bool phase = step & 1U;

	switch (st) {
	case LED_STATE_IDLE:
		write_gb(false, phase);
		return 500;

	case LED_STATE_SMP_ACTIVE:
		write_gb(false, phase);
		return 125;

	case LED_STATE_DFU_RUNNING: {
		uint8_t pct = (uint8_t)atomic_get(&s_progress);
		if (pct >= 100) {
			write_gb(true, false);
			return 1000;
		}
		write_gb(phase, false);
		return dfu_half_ms(pct);
	}

	case LED_STATE_DONE_OK:
		write_gb(true, false);
		return 1000;

	case LED_STATE_DONE_FAIL: {
		bool on = k_fail_pattern[step % ARRAY_SIZE(k_fail_pattern)];

		write_gb(on, on);
		return 150;
	}

	default:
		write_gb(false, false);
		return 500;
	}
}

#else /* single LED */

/* blink, blink, pause — read at the 150 ms tick below, so the whole cycle is
 * 900 ms and the pause is half of it. */
static const bool k_fail_pattern[] = { true, false, true, false, false, false };

static uint32_t render(enum led_state st, uint32_t step)
{
	bool phase = step & 1U;

	switch (st) {
	case LED_STATE_IDLE:
		gpio_pin_set_dt(&s_status, phase);
		return 500;

	case LED_STATE_SMP_ACTIVE:
		gpio_pin_set_dt(&s_status, phase);
		return 125;

	case LED_STATE_DFU_RUNNING: {
		uint8_t pct = (uint8_t)atomic_get(&s_progress);
		if (pct >= 100) {
			gpio_pin_set_dt(&s_status, 1);
			return 1000;
		}
		gpio_pin_set_dt(&s_status, phase);
		return dfu_half_ms(pct);
	}

	case LED_STATE_DONE_OK:
		gpio_pin_set_dt(&s_status, 1);
		return 1000;

	case LED_STATE_DONE_FAIL:
		gpio_pin_set_dt(&s_status,
				k_fail_pattern[step % ARRAY_SIZE(k_fail_pattern)]);
		return 150;

	default:
		gpio_pin_set_dt(&s_status, 0);
		return 500;
	}
}

#endif /* LED_HAVE_RGB / LED_HAVE_DUO */

static void led_thread(void *a, void *b, void *c)
{
	ARG_UNUSED(a); ARG_UNUSED(b); ARG_UNUSED(c);
	/* A free-running counter rather than a bool: the mono DONE_FAIL
	 * pattern is six steps long, so a two-state phase cannot express it. */
	uint32_t step = 0;

	while (true) {
		enum led_state st = (enum led_state)atomic_get(&s_state);

		k_sleep(K_MSEC(render(st, step)));
		step++;
	}
}
