/*
 * The 1200-baud touch: reboot into the Adafruit bootloader when the host asks.
 *
 * Only the XIAO nRF52840 has anything to gain from this, and only because of
 * how that board is reached. Its USB-C goes straight to the SoC, so the
 * browser flasher talks to the *bootloader's* CDC port — which means the
 * bootloader has to already be running before flashing can start. Without
 * this, the only way in is physical: double-tap RESET. That is fine on a desk
 * and impossible on a mast.
 *
 * Arduino established the convention and Adafruit's bootloader plays along:
 * the host opens the port at 1200 baud and closes it again, and the
 * *application* is expected to notice and reboot into DFU. Nothing in Zephyr
 * does that for us — the only user of the CDC line-coding hook in the whole
 * tree is `soc/atmel/sam0/common/bossa.c`, which is for SAM0 boards — so it
 * lives here.
 *
 * Modelled on ZephCore's `adapters/usb/ZephyrUSBCDC.cpp`, which solves the
 * same problem on the same silicon.
 *
 * ---- Why it hooks a context it does not own -----------------------------
 *
 * `CONFIG_CDC_ACM_SERIAL_INITIALIZE_AT_BOOT=y` means Zephyr builds and enables
 * the USB device itself, in `subsys/usb/device_next/app/cdc_acm_serial.c`.
 * That context is `static`, so it cannot be named from here — but
 * `USBD_DEVICE_DEFINE` declares it `STRUCT_SECTION_ITERABLE`, so it can be
 * *found*. Registering the message callback needs nothing but the pointer and
 * takes a lock, so doing it after `usbd_init()` has already run is fine;
 * `usbd_msg_register_cb()` refuses with `-EALREADY` rather than clobbering an
 * existing callback, which is exactly the behaviour to want if Zephyr ever
 * starts registering one of its own.
 *
 * ---- What the magic byte does -------------------------------------------
 *
 * GPREGRET survives a soft reset, and the bootloader reads it on the way up.
 * `0x57` is `DFU_MAGIC_UF2_RESET` — "come up with CDC *and* MSC" — so the
 * board lands in exactly the state a double-tap of RESET produces: the
 * drag-and-drop drive appears, and the serial DFU port this project's flasher
 * uses is on the same device. `0x4E` would give a CDC-only bootloader, which
 * is a strictly worse answer: it would work for the flasher and quietly
 * remove the recovery route a user falls back to when the flasher fails.
 */

#include <zephyr/init.h>
#include <zephyr/kernel.h>
#include <zephyr/drivers/uart.h>
#include <zephyr/logging/log.h>
#include <zephyr/sys/reboot.h>
#include <zephyr/usb/usbd.h>

#include <hal/nrf_power.h>

LOG_MODULE_REGISTER(usb_dfu_touch, LOG_LEVEL_INF);

/* `DFU_MAGIC_UF2_RESET`, read out of the bootloader's own src/main.c. */
#define BOOTLOADER_MAGIC_UF2 0x57

/* The rate that means "reboot into DFU" rather than "talk to me at 1200 baud".
 * Nothing legitimately opens a USB CDC port at 1200: the rate is meaningless
 * on a link with no UART behind it, which is what makes it usable as a signal. */
#define TOUCH_BAUD 1200

static void reboot_to_bootloader(void)
{
	LOG_WRN("1200-baud touch — rebooting into the bootloader");
	nrf_power_gpregret_set(NRF_POWER, 0, BOOTLOADER_MAGIC_UF2);
	/* Let the host see the port close, and give the log backend a moment to
	 * reach flash. A reset that beats its own explanation out the door is
	 * how a board acquires a reputation for rebooting at random. */
	k_msleep(50);
	sys_reboot(SYS_REBOOT_COLD);
}

/*
 * `uart_line_ctrl_get()` is a *routed* call: the CDC ACM driver only fills in
 * `.line_ctrl_get` under `#ifdef CONFIG_UART_LINE_CTRL`, and without it every
 * query answers -ENOSYS. That is how this feature shipped broken and looked
 * fine — the host's SET_LINE_CODING arrived, the message was published, this
 * callback ran, and it returned having learnt nothing. Asserted here so the
 * Kconfig cannot be dropped without the build saying so.
 */
BUILD_ASSERT(IS_ENABLED(CONFIG_UART_LINE_CTRL),
	     "usb_dfu_touch needs CONFIG_UART_LINE_CTRL: without it "
	     "uart_line_ctrl_get() always returns -ENOSYS and the touch is a no-op");

static void on_usbd_msg(struct usbd_context *const ctx, const struct usbd_msg *const msg)
{
	uint32_t baudrate = 0;

	ARG_UNUSED(ctx);

	if (msg->type != USBD_MSG_CDC_ACM_LINE_CODING) {
		return;
	}

	int rc = uart_line_ctrl_get(msg->dev, UART_LINE_CTRL_BAUD_RATE, &baudrate);

	if (rc != 0) {
		/* Once. A driver that cannot answer will not answer the next
		 * time either, and this is on the host's open/close path. */
		static bool said;

		if (!said) {
			said = true;
			LOG_ERR("cannot read the line coding (%d) — the "
				"1200-baud reboot into the bootloader will "
				"never fire on this build", rc);
		}
		return;
	}
	/* Acted on at SET_LINE_CODING rather than waiting for DTR to drop:
	 * `adafruit-nrfutil --touch 1200` closes the port immediately after
	 * setting the rate, and a host that has already gone away will not
	 * produce the DTR transition to wait for. */
	if (baudrate == TOUCH_BAUD) {
		reboot_to_bootloader();
	}
}

static int usb_dfu_touch_init(void)
{
	int registered = 0;

	/* Zephyr owns the context and keeps it static; the section is the only
	 * handle on it. There is exactly one in this build, but the loop costs
	 * nothing and does the right thing if that ever stops being true. */
	STRUCT_SECTION_FOREACH(usbd_context, ctx) {
		int err = usbd_msg_register_cb(ctx, on_usbd_msg);

		if (err == -EALREADY) {
			LOG_WRN("%s already has a message callback — the 1200-baud "
				"touch will not work on it", ctx->name);
			continue;
		}
		if (err) {
			LOG_ERR("could not hook %s (%d)", ctx->name, err);
			continue;
		}
		registered++;
	}

	if (registered == 0) {
		LOG_WRN("no USB device context to hook — reboot-to-bootloader "
			"is unavailable, use a double-tap of RESET");
	}

	return 0;
}

/* After Zephyr's own CDC ACM initialiser, which sits at the same level and
 * priority — registration only needs the context to exist, not to be idle. */
SYS_INIT(usb_dfu_touch_init, APPLICATION, CONFIG_APPLICATION_INIT_PRIORITY);
