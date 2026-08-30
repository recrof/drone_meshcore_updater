/*
 * See ble_tx_power.h for why this file exists — in short, `ble_tx_power` in config.txt
 * had never been connected to the radio.
 */

#include "ble_tx_power.h"

#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>
#include <zephyr/bluetooth/bluetooth.h>
#include <zephyr/bluetooth/hci.h>
#include <zephyr/bluetooth/hci_vs.h>
#include <zephyr/net_buf.h>
#include <zephyr/sys/byteorder.h>

LOG_MODULE_REGISTER(ble_tx_power, LOG_LEVEL_INF);

/*
 * Latched once the controller refuses the command.
 *
 * This is a **vendor-specific** opcode (0xFC0E), and which controllers answer
 * it is not something the host can look up. CONFIG_BT_HCI_VS is y on every
 * board here, because it describes the host's willingness to *send* VS
 * commands rather than any controller's willingness to answer them.
 *
 * Nordic's SoftDevice Controller answers it only when
 * CONFIG_BT_CTLR_TX_PWR_DYNAMIC_CONTROL is set (see the comment on that line
 * in prj.conf: it had never been set, so this whole file was inert on the nRF
 * boards too, and the warning below was wrongly read as "that must be the
 * ESP32"). Espressif's controller does not implement it at all, and the symbol
 * that would enable it does not exist on that board — it lives under
 * `if BT_CTLR`, and the ESP32-S3 uses an HCI driver instead.
 *
 * So the only way to know is still to ask, and the only sane thing to do with
 * the answer is remember it.
 *
 * Without this the warning fires on every connection: twice at boot and once
 * per DFU link, for the whole life of a board that will never support it. Said
 * once, naming the config key, it is information; said thirty times it is
 * noise that hides the log lines a failing transfer actually needs.
 *
 * Note what is *not* being claimed: that the radio is at 0 dBm. It is at
 * whatever CONFIG_BT_CTLR_TX_PWR_DBM or the controller's own default says,
 * which is exactly the state this whole file exists because nobody had checked.
 */
static bool s_unsupported;

/* Returns the level the controller selected, or INT8_MIN if the command
 * failed. The selected level is the interesting half: the radio implements a
 * ladder (-40, -20, -16, -12, -8, -4, 0, 3, 6, 8 on these parts) and rounds
 * silently, so "requested 4, got 3" is a thing only this readback can show. */
static int set_one(uint8_t handle_type, uint16_t handle, int8_t dbm,
		   const char *what)
{
	struct bt_hci_cp_vs_write_tx_power_level *cp;
	struct bt_hci_rp_vs_write_tx_power_level *rp;
	struct net_buf *buf, *rsp = NULL;
	int err;

	/* bt_hci_cmd_alloc(), not the bt_hci_cmd_create() every older example
	 * shows — the opcode and parameter length are attached by
	 * bt_hci_cmd_send_sync() in this Zephyr. */
	if (s_unsupported) {
		return INT8_MIN;
	}

	buf = bt_hci_cmd_alloc(K_FOREVER);
	if (!buf) {
		LOG_ERR("%s: out of command buffers", what);
		return INT8_MIN;
	}
	cp = net_buf_add(buf, sizeof(*cp));
	cp->handle_type = handle_type;
	cp->handle = sys_cpu_to_le16(handle);
	cp->tx_power_level = dbm;

	err = bt_hci_cmd_send_sync(BT_HCI_OP_VS_WRITE_TX_POWER_LEVEL, buf, &rsp);
	if (err) {
		/* Not fatal: a controller that does not implement the command
		 * simply refuses, and the radio keeps running at whatever level
		 * it was built with. Say so rather than leaving `tx_power` in
		 * config.txt looking as though it took — and say it once. */
		s_unsupported = true;
		LOG_WRN("%s: HCI VS write-tx-power (0x%04x) refused (err %d). "
			"This controller does not implement it, so `tx_power` in "
			"config.txt has no effect on this board; the radio runs "
			"at its built-in level. Not reported again.",
			what, BT_HCI_OP_VS_WRITE_TX_POWER_LEVEL, err);
		return INT8_MIN;
	}

	rp = (void *)rsp->data;
	int selected = rp->selected_tx_power;
	net_buf_unref(rsp);
	return selected;
}

void ble_tx_power_apply_global(int8_t dbm)
{
	int adv = set_one(BT_HCI_VS_LL_HANDLE_TYPE_ADV, 0, dbm, "adv");
	int scan = set_one(BT_HCI_VS_LL_HANDLE_TYPE_SCAN, 0, dbm, "scan");

	if (adv == INT8_MIN && scan == INT8_MIN) {
		return;
	}
	LOG_INF("tx power: requested %d dBm -> adv %d dBm, scan %d dBm",
		dbm, adv, scan);
	/* The ladder is coarse and the rounding is silent, which is exactly how
	 * a config value can look applied and not be. Worth one line. */
	if (adv != INT8_MIN && adv != dbm) {
		LOG_WRN("tx power %d dBm is not a level this radio implements — "
			"it is running at %d dBm", dbm, adv);
	}
}

void ble_tx_power_apply_conn(struct bt_conn *conn, int8_t dbm)
{
	uint16_t handle;

	if (bt_hci_get_conn_handle(conn, &handle) != 0) {
		return;
	}
	/* Per connection, deliberately. A connection does not inherit the
	 * advertising or scanning power, so the DFU link — the one whose range
	 * actually matters — would otherwise stay at the default however this
	 * is configured. */
	int selected = set_one(BT_HCI_VS_LL_HANDLE_TYPE_CONN, handle, dbm, "conn");
	if (selected != INT8_MIN) {
		LOG_INF("tx power: conn handle %u at %d dBm (requested %d)",
			handle, selected, dbm);
	}
}
