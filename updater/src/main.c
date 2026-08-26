/*
 * xiao_nrf54_updater — application entry point.
 *
 * Responsibility split:
 *   main.c       — boot, subsystem init, top-level state machine, LED tick
 *   led.c        — LED patterns, driven off enum led_state
 *   storage.c    — LittleFS bring-up + first-boot config.txt seeding
 *   upload_hook.c — SMP fs_mgmt upload-complete callback that arms DFU
 *
 * The DFU client + BLE central scanner are placeholders in this
 * first commit — this skeleton is intended to boot, expose SMP over BLE,
 * accept file uploads, and log to /lfs/LOG*. The Nordic Legacy DFU
 * client from the nRF52 project ports on top of Zephyr's bt_gatt in a
 * later change.
 */

#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>
#include <zephyr/bluetooth/bluetooth.h>
#include <zephyr/bluetooth/conn.h>
#include <zephyr/bluetooth/gatt.h>
#include <zephyr/bluetooth/hci.h>
#include <zephyr/bluetooth/uuid.h>
#include <zephyr/mgmt/mcumgr/transport/smp_bt.h>

#include "app.h"
#include "config.h"

LOG_MODULE_REGISTER(app, LOG_LEVEL_INF);

/*
 * Advertising payload split into ad (primary) + sd (scan response):
 *   ad = flags + SMP service UUID     — matched by nRF Connect Device
 *                                       Manager's filter; without the
 *                                       UUID here the app never shows
 *                                       our peripheral in its list.
 *   sd = complete local name          — moved out of ad so the 128-bit
 *                                       UUID fits comfortably.
 *
 * SMP service UUID (little-endian byte order):
 *   8D53DC1D-1DB7-4CD3-868B-8A527460AA84
 */
static const struct bt_data ad[] = {
	BT_DATA_BYTES(BT_DATA_FLAGS, (BT_LE_AD_GENERAL | BT_LE_AD_NO_BREDR)),
	BT_DATA_BYTES(BT_DATA_UUID128_ALL,
		0x84, 0xaa, 0x60, 0x74, 0x52, 0x8a, 0x8b, 0x86,
		0xd3, 0x4c, 0xb7, 0x1d, 0x1d, 0xdc, 0x53, 0x8d),
};

static const struct bt_data sd[] = {
	BT_DATA(BT_DATA_NAME_COMPLETE, CONFIG_BT_DEVICE_NAME,
		sizeof(CONFIG_BT_DEVICE_NAME) - 1),
};

/* Target connection parameters we actively request after connect.
 *
 * Empirically macOS negotiates to the *upper* end of any range we offer, so
 * the range should be pushed as low as the central will accept. 6-12 units
 * (7.5-15 ms) is what Apple's own Bluetooth Accessory Design Guidelines list
 * as the acceptable fast range for peripherals. Unlike the "advertised
 * preferred params" mechanism (CONFIG_BT_PERIPHERAL_PREF_*), an active
 * bt_conn_le_param_update() request goes through L2CAP signaling with a
 * proper accept/reject/negotiate handshake — a rejection is safe and doesn't
 * drop the link.
 *
 * Latency 0 = no slave-latency (we always listen every event).
 * Timeout 400 (4 s) = long enough that a distant peer briefly out of range
 * doesn't kill the link.
 */
/* 6-12 range (7.5-15 ms) — empirically the fastest interval macOS will
 * agree to. Asking for anything tighter (e.g. 6-6) causes macOS to
 * reject and counter-negotiate up to 30 ms instead of down. Keep the
 * lower bound at 6 so an Android central (which routinely accepts
 * 7.5 ms) gets the fastest possible interval without a code change.
 */
static const struct bt_le_conn_param s_fast_param =
	BT_LE_CONN_PARAM_INIT(6, 12, 0, 400);

static void on_connected(struct bt_conn *conn, uint8_t err)
{
	if (err) {
		LOG_WRN("connect failed err=0x%02x", err);
		return;
	}
	LOG_INF("peer connected");

	/* Only nudge peripheral-role connections (phone / SMP client) —
	 * requesting a param update on the CENTRAL link (our DFU target)
	 * would trigger an LL negotiation mid-way through firmware
	 * streaming, and the transient state during negotiation was
	 * dropping ~24 packets and killing the PRN sync (observed on
	 * RAK4631_OTA). The DFU client sets its own params on the target link
	 * via bt_conn_le_create's `conn_param`; it doesn't want ours.
	 */
	struct bt_conn_info info;
	if (bt_conn_get_info(conn, &info) != 0 ||
	    info.role != BT_CONN_ROLE_PERIPHERAL) {
		return;
	}
	int rc = bt_conn_le_param_update(conn, &s_fast_param);
	if (rc && rc != -EALREADY) {
		LOG_WRN("conn param update rc=%d", rc);
	}
}

static void on_disconnected(struct bt_conn *conn, uint8_t reason)
{
	/* This callback fires for *every* connection tear-down, including
	 * when we (as central) end our own connection to the DFU target.
	 * Only re-advertise when it was the peripheral link (a client
	 * connected to us) that dropped, otherwise we spam adv-restart
	 * errors while our peripheral advertising is still running.
	 */
	struct bt_conn_info info;
	if (bt_conn_get_info(conn, &info) == 0 &&
	    info.role != BT_CONN_ROLE_PERIPHERAL) {
		return;
	}
	LOG_INF("peer disconnected reason=0x%02x", reason);
	int rc = bt_le_adv_start(BT_LE_ADV_CONN_FAST_1, ad, ARRAY_SIZE(ad), sd, ARRAY_SIZE(sd));
	if (rc && rc != -EALREADY) {
		LOG_ERR("adv restart failed rc=%d", rc);
	}
}

/* Called when the negotiated LE connection parameters (interval, latency,
 * timeout) actually change — either as a result of our bt_conn_le_param_update
 * request or a spontaneous update from the central. `interval` is in units of
 * 1.25 ms — divide by 0.8 to get ms, e.g. 24 → 30 ms.
 */
static void on_le_param_updated(struct bt_conn *conn, uint16_t interval,
				uint16_t latency, uint16_t timeout)
{
	/* Tag the role: with two links up (SMP client + DFU target) an
	 * untagged line is ambiguous, and a mid-stream renegotiation on the
	 * *central* link is a prime suspect whenever firmware streaming
	 * hiccups. Worth being able to tell them apart at a glance.
	 */
	struct bt_conn_info info;
	const char *who = "?";
	if (bt_conn_get_info(conn, &info) == 0) {
		who = (info.role == BT_CONN_ROLE_PERIPHERAL) ? "peripheral/SMP"
							     : "central/DFU-target";
	}
	LOG_INF("LE conn params updated [%s]: interval=%u (%u.%u ms), latency=%u, timeout=%u ms",
		who, interval, interval * 125 / 100, (interval * 125 / 10) % 10,
		latency, timeout * 10);
}

/* Fires when the ATT MTU is negotiated (usually right after the client
 * connects and sends an ATT_EXCHANGE_MTU_REQ). Prints what we ended up
 * with — 244 is our declared max, but the client's OS caps this and we
 * can't force it higher. Chunk size on the fast-upload path scales
 * directly with (MTU - 3), so this is the second-biggest throughput
 * knob after connection interval.
 */
static void on_att_mtu_updated(struct bt_conn *conn, uint16_t tx, uint16_t rx)
{
	ARG_UNUSED(conn);
	LOG_INF("ATT MTU updated: tx=%u rx=%u (max data per write = %u B)",
		tx, rx, (tx > 3 ? tx - 3 : 0));
}

/* PHY and Data Length are the two knobs that decide how many connection
 * events a 244 B firmware packet costs. Log both: "tx=251" here means one
 * ATT packet fits in a single link-layer PDU, "tx=27" means it fragments
 * into ~10 and DLE didn't take.
 */
static void on_le_phy_updated(struct bt_conn *conn,
			      struct bt_conn_le_phy_info *param)
{
	ARG_UNUSED(conn);
	LOG_INF("LE PHY updated: tx=%uM rx=%uM", param->tx_phy, param->rx_phy);
}

static void on_le_data_len_updated(struct bt_conn *conn,
				   struct bt_conn_le_data_len_info *info)
{
	ARG_UNUSED(conn);
	LOG_INF("LE data len updated: tx=%u B/%u us rx=%u B/%u us",
		info->tx_max_len, info->tx_max_time,
		info->rx_max_len, info->rx_max_time);
}

static struct bt_gatt_cb gatt_callbacks = {
	.att_mtu_updated = on_att_mtu_updated,
};

BT_CONN_CB_DEFINE(conn_callbacks) = {
	.connected           = on_connected,
	.disconnected        = on_disconnected,
	.le_param_updated    = on_le_param_updated,
	.le_phy_updated      = on_le_phy_updated,
	.le_data_len_updated = on_le_data_len_updated,
};

static int bt_ready(void)
{
	int rc = bt_enable(NULL);
	if (rc) {
		LOG_ERR("bt_enable rc=%d", rc);
		return rc;
	}
	bt_gatt_cb_register(&gatt_callbacks);
	rc = bt_le_adv_start(BT_LE_ADV_CONN_FAST_1, ad, ARRAY_SIZE(ad), sd, ARRAY_SIZE(sd));
	if (rc) {
		LOG_ERR("adv start rc=%d", rc);
		return rc;
	}
	LOG_INF("BLE up, advertising as '%s'", CONFIG_BT_DEVICE_NAME);
	return 0;
}

int main(void)
{
	LOG_INF("xiao_nrf54_updater booting");

	led_init();
	led_set_state(LED_STATE_IDLE);

	int rc = storage_init();
	if (rc) {
		LOG_ERR("storage_init rc=%d — halting", rc);
		led_set_state(LED_STATE_DONE_FAIL);
		return rc;
	}

	/* Config lives on the FS storage bring-up just mounted; load it
	 * before BLE so tx_power etc. can be applied to init later.
	 */
	bool cfg_loaded = app_config_load();
	const struct app_config *cfg = app_config_current();
	LOG_INF("cfg %s: ble_name='%s' prn=%u high_mtu=%d retries=%u "
		"min_rssi=%d retry_cooldown=%u wedge_cooldown=%u tx_power=%d "
		"scan_timeout=%u scan_debug=%d pkt_gap_ms=%u",
		cfg_loaded ? "loaded" : "(defaults)",
		cfg->ble_name, cfg->prn, cfg->high_mtu, cfg->retries,
		cfg->min_rssi, cfg->retry_cooldown, cfg->wedge_cooldown,
		cfg->tx_power, cfg->scan_timeout, cfg->scan_debug, cfg->pkt_gap_ms);

	rc = bt_ready();
	if (rc) {
		led_set_state(LED_STATE_DONE_FAIL);
		return rc;
	}

	/* All work now happens off the main thread:
	 *   - SMP + fsx_stream run in their own transports and workqueues
	 *   - DFU sequence runs on dfu_runner's dedicated thread, kicked
	 *     off by an explicit TRIGGER_DFU write from the client
	 * Main just idles — Zephyr's cooperative scheduler makes an
	 * infinite sleep loop the standard "nothing to do here" pattern.
	 */
	while (true) {
		k_sleep(K_SECONDS(60));
	}
	return 0;
}
