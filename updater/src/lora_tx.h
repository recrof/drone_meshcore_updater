/*
 * The LoRa radio, as one blocking send.
 *
 * Separate from lora_status.c so that "what goes on the air" and "when to say
 * something" stay apart: this file knows the modem and nothing about DFU, and
 * lora_status.c knows the run and nothing about SX1262 registers.
 *
 * RAK4631 only. It is the sole board here carrying a LoRa radio, and Zephyr's
 * own board file already describes it (lora0 = &lora, an sx1262 on spi1 with
 * RXEN, DIO2-as-TXEN and a 3V3 TCXO), so there is no devicetree work to do
 * beyond leaving that node enabled.
 *
 * SPDX-License-Identifier: BSD-3-Clause
 */

#ifndef LORA_TX_H
#define LORA_TX_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/*
 * The modem settings for one transmission.
 *
 * Passed by value rather than read from app_config inside the send, because
 * the caller runs on its own thread and app_config_load() — which the DFU
 * runner calls before *every* attempt — begins by memset'ing the live config
 * to defaults before re-parsing it. A pointer held across that window can be
 * read mid-wipe: tx_power reads back 0 and the status message goes out at
 * 0 dBm instead of +22, which from a drone is indistinguishable from being
 * out of range.
 */
struct lora_tx_params {
	uint32_t freq_hz;
	uint16_t bw_khz;
	uint8_t sf;
	uint8_t cr;
	int8_t tx_power;
};

/* Bind the radio device. Returns 0, -ENODEV if the node is missing or the
 * driver did not come up. Safe to call more than once. */
int lora_tx_init(void);

/*
 * Configure the modem from the current app_config and transmit one frame.
 *
 * ⚠ Blocks for the whole air time — at SF7/62.5 kHz a 53-byte frame is about
 * 255 ms, and a bigger message or a slower SF is proportionally worse. Call it
 * only from the status TX thread. Calling it from a Bluetooth callback stalls
 * the host stack long enough to lose the DFU link.
 *
 * The modem is reconfigured on every send rather than once at boot, because
 * config.txt is re-read before every DFU attempt and a frequency edited
 * mid-run should take effect without a reboot. It costs a few SPI writes
 * against a quarter-second transmission.
 *
 * Returns 0, or a negative errno from the driver.
 */
int lora_tx_send(const struct lora_tx_params *p, const uint8_t *frame, size_t len);

#ifdef __cplusplus
}
#endif

#endif /* LORA_TX_H */
