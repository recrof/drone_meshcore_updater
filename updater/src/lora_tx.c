/*
 * See lora_tx.h.
 *
 * The modem settings that are *not* configurable, and why:
 *
 *   sync word   MeshCore calls RadioLib's begin() with
 *               RADIOLIB_SX126X_SYNC_WORD_PRIVATE (CustomSX1262.h), which
 *               RadioLib writes to the SX126x as 0x1424. That is exactly what
 *               Zephyr emits for `public_network = false`, so the two agree
 *               without an explicit sync_word override — and the override is
 *               documented as backend-dependent, so not using it is the safer
 *               of two ways to reach the same register value.
 *
 *   CRC         on. MeshCore's wrapper calls setCRC(1); a frame sent without
 *               one is dropped by every receiver before the header is even
 *               looked at. Hence packet_crc_disable stays false.
 *
 *   preamble    32 symbols at SF<=8, 16 above it — MeshCore's
 *               preambleLengthForSF() (RadioLibWrappers.h:56), applied by
 *               RadioLibWrapper::begin(). ⚠ It is 32 at SF7, not the 16 a
 *               reasonable person would assume from the higher spreading
 *               factors, and a preamble mismatch costs sensitivity rather than
 *               failing outright — which is the kind of loss that gets blamed
 *               on antennas.
 *
 *   IQ          not inverted, as MeshCore leaves it.
 *
 * SPDX-License-Identifier: BSD-3-Clause
 */

#include "lora_tx.h"

#include <zephyr/device.h>
#include <zephyr/drivers/lora.h>
#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>
#include <errno.h>

LOG_MODULE_REGISTER(lora_tx, LOG_LEVEL_INF);

static const struct device *s_dev;

int lora_tx_init(void)
{
	if (s_dev != NULL) {
		return 0;
	}
	s_dev = DEVICE_DT_GET(DT_ALIAS(lora0));
	if (!device_is_ready(s_dev)) {
		LOG_ERR("lora0 not ready — no status messages will be sent");
		s_dev = NULL;
		return -ENODEV;
	}
	return 0;
}

/* config.txt carries the bandwidth in kHz because that is how every MeshCore
 * client shows it. Zephyr's enum is keyed by the same numbers, but only for
 * the values it defines — anything else has to be refused rather than rounded,
 * since a silently-shifted bandwidth is a radio that hears nothing and reports
 * no error. */
static int bw_from_khz(uint16_t khz, enum lora_signal_bandwidth *out)
{
	switch (khz) {
	case 7: *out = BW_7_KHZ; return 0;
	case 10: *out = BW_10_KHZ; return 0;
	case 15: *out = BW_15_KHZ; return 0;
	case 20: *out = BW_20_KHZ; return 0;
	case 31: *out = BW_31_KHZ; return 0;
	case 41: *out = BW_41_KHZ; return 0;
	case 62: *out = BW_62_KHZ; return 0;
	case 125: *out = BW_125_KHZ; return 0;
	case 250: *out = BW_250_KHZ; return 0;
	case 500: *out = BW_500_KHZ; return 0;
	default: return -EINVAL;
	}
}

static int cr_from_denom(uint8_t denom, enum lora_coding_rate *out)
{
	switch (denom) {
	case 5: *out = CR_4_5; return 0;
	case 6: *out = CR_4_6; return 0;
	case 7: *out = CR_4_7; return 0;
	case 8: *out = CR_4_8; return 0;
	default: return -EINVAL;
	}
}

int lora_tx_send(const struct lora_tx_params *p, const uint8_t *frame, size_t len)
{
	struct lora_modem_config mc = {0};
	int err;

	if (p == NULL || frame == NULL || len == 0U) {
		return -EINVAL;
	}
	err = lora_tx_init();
	if (err != 0) {
		return err;
	}

	mc.frequency = p->freq_hz;
	err = bw_from_khz(p->bw_khz, &mc.bandwidth);
	if (err != 0) {
		LOG_ERR("lora_bw=%u is not a bandwidth this radio has", p->bw_khz);
		return err;
	}
	if (p->sf < 5U || p->sf > 12U) {
		LOG_ERR("lora_sf=%u out of range", p->sf);
		return -EINVAL;
	}
	mc.datarate = (enum lora_datarate)p->sf;
	err = cr_from_denom(p->cr, &mc.coding_rate);
	if (err != 0) {
		LOG_ERR("lora_cr=%u is not 5..8", p->cr);
		return err;
	}

	mc.preamble_len = (p->sf <= 8U) ? 32U : 16U;
	mc.tx_power = p->tx_power;
	mc.tx = true;
	mc.public_network = false; /* private sync word 0x1424 — see header */
	mc.iq_inverted = false;
	mc.packet_crc_disable = false;
	mc.cad.mode = LORA_CAD_MODE_NONE;

	err = lora_config(s_dev, &mc);
	if (err != 0) {
		LOG_ERR("lora_config: %d", err);
		return err;
	}

	/* lora_send() takes a non-const pointer in this API revision but does
	 * not modify the buffer. */
	err = lora_send(s_dev, (uint8_t *)frame, len);
	if (err != 0) {
		LOG_ERR("lora_send: %d", err);
	}
	return err;
}
