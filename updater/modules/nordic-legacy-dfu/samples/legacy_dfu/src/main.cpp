/*
 * Nordic Legacy DFU client — minimal sample.
 *
 * Scans for a peer advertising the Legacy DFU service, connects, and runs
 * the client against it. The firmware here is a placeholder array; replace
 * it with a Stream over whatever your application actually holds (a file,
 * an external flash region, a buffer received over the air).
 *
 * SPDX-License-Identifier: BSD-3-Clause
 */

#include <zephyr/kernel.h>
#include <zephyr/bluetooth/bluetooth.h>
#include <zephyr/bluetooth/conn.h>
#include <zephyr/bluetooth/uuid.h>
#include <zephyr/logging/log.h>

#include <string.h>

#include "nordic_dfu/legacy_dfu.hpp"

LOG_MODULE_REGISTER(sample, LOG_LEVEL_INF);

using namespace nordic::dfu;

/* Replace with the real image and its init packet (.dat from the ZIP). */
static const uint8_t kFirmware[256] = {0};
static const uint8_t kInitPacket[14] = {0};

static K_SEM_DEFINE(connected_sem, 0, 1);
static K_SEM_DEFINE(scan_sem, 0, 1);
static bt_conn *g_conn;
static bt_addr_le_t g_target;

/* The 16-bit form of the Legacy DFU service, as advertised by the
 * bootloader: 00001530-1212-EFDE-1523-785FEABCD123. */
static const bt_uuid_128 kDfuServiceUuid = {
	{BT_UUID_TYPE_128},
	{0x23, 0xD1, 0xBC, 0xEA, 0x5F, 0x78, 0x23, 0x15, 0xDE, 0xEF, 0x12, 0x12, 0x30, 0x15, 0x00,
	 0x00}};

static bool ad_has_dfu_service(bt_data *data, void *user_data)
{
	bool *found = static_cast<bool *>(user_data);

	if (data->type != BT_DATA_UUID128_ALL && data->type != BT_DATA_UUID128_SOME) {
		return true;
	}
	for (uint8_t i = 0; i + 16 <= data->data_len; i += 16) {
		if (memcmp(&data->data[i], kDfuServiceUuid.val, 16) == 0) {
			*found = true;
			return false;
		}
	}
	return true;
}

static void scan_cb(const bt_addr_le_t *addr, int8_t rssi, uint8_t type,
		    struct net_buf_simple *ad)
{
	ARG_UNUSED(rssi);

	if (type != BT_GAP_ADV_TYPE_ADV_IND && type != BT_GAP_ADV_TYPE_ADV_DIRECT_IND) {
		return;
	}

	bool found = false;
	bt_data_parse(ad, ad_has_dfu_service, &found);
	if (!found) {
		return;
	}

	bt_addr_le_copy(&g_target, addr);
	bt_le_scan_stop();
	k_sem_give(&scan_sem);
}

static void connected(bt_conn *conn, uint8_t err)
{
	if (conn != g_conn) {
		return;
	}
	if (err != 0) {
		LOG_ERR("connect failed: 0x%02x", err);
	}
	k_sem_give(&connected_sem);
}

static bt_conn_cb conn_callbacks;

class Logger : public Observer {
public:
	void on_state(State state) override { LOG_INF("state %d", static_cast<int>(state)); }

	void on_progress(uint8_t percent, uint32_t sent, uint32_t total) override
	{
		if (percent % 10 == 0) {
			LOG_INF("progress %u%% (%u / %u)", percent, sent, total);
		}
	}

	void on_finished(const Report &report) override
	{
		LOG_INF("finished: %s", result_str(report.result));
		if (report.result == Result::RemoteError) {
			LOG_ERR("target said: %s", remote_status_str(report.remote));
		}
	}
};

static int connect_to_target()
{
	bt_le_conn_param param = *BT_LE_CONN_PARAM_DEFAULT;
	bt_conn_le_create_param create = *BT_CONN_LE_CREATE_CONN;

	k_sem_reset(&connected_sem);
	int rc = bt_conn_le_create(&g_target, &create, &param, &g_conn);
	if (rc != 0) {
		LOG_ERR("bt_conn_le_create: %d", rc);
		return rc;
	}
	if (k_sem_take(&connected_sem, K_SECONDS(10)) != 0) {
		LOG_ERR("connect timed out");
		bt_conn_disconnect(g_conn, BT_HCI_ERR_REMOTE_USER_TERM_CONN);
		bt_conn_unref(g_conn);
		g_conn = nullptr;
		return -ETIMEDOUT;
	}
	return 0;
}

int main()
{
	int rc = bt_enable(nullptr);
	if (rc != 0) {
		LOG_ERR("bt_enable: %d", rc);
		return 0;
	}

	memset(&conn_callbacks, 0, sizeof(conn_callbacks));
	conn_callbacks.connected = connected;
	bt_conn_cb_register(&conn_callbacks);

	MemoryStream image(kFirmware, sizeof(kFirmware));
	MemoryStream init_packet(kInitPacket, sizeof(kInitPacket));

	Firmware firmware;
	firmware.type = IMAGE_APPLICATION;
	firmware.image = &image;
	firmware.init_packet = &init_packet;

	Parameters params;
	Logger logger;
	LegacyDfuClient client;
	client.set_observer(&logger);

	/*
	 * A full update can need up to three connections: one to ask a
	 * running application to jump to its bootloader, one that turns out
	 * to need a restart, and one that does the transfer.
	 */
	for (int attempt = 0; attempt < 4; attempt++) {
		k_sem_reset(&scan_sem);
		rc = bt_le_scan_start(BT_LE_SCAN_ACTIVE, scan_cb);
		if (rc != 0) {
			LOG_ERR("scan start: %d", rc);
			return 0;
		}
		if (k_sem_take(&scan_sem, K_SECONDS(30)) != 0) {
			LOG_ERR("no DFU target found");
			bt_le_scan_stop();
			return 0;
		}

		if (connect_to_target() != 0) {
			continue;
		}

		Report report = client.run(g_conn, firmware, params);

		bt_conn_unref(g_conn);
		g_conn = nullptr;

		switch (report.result) {
		case Result::Success:
			LOG_INF("DFU complete");
			return 0;
		case Result::JumpedToBootloader:
			LOG_INF("target is rebooting into its bootloader%s",
				report.address_may_change ? " (address may change)" : "");
			k_sleep(K_SECONDS(1));
			continue;
		case Result::ApplicationPending:
			LOG_INF("system components sent; sending the application next");
			firmware.type = IMAGE_APPLICATION;
			k_sleep(K_SECONDS(1));
			continue;
		case Result::RestartRequired:
			LOG_INF("target was reset; retrying");
			k_sleep(K_SECONDS(1));
			continue;
		default:
			LOG_ERR("DFU failed: %s", result_str(report.result));
			return 0;
		}
	}

	LOG_ERR("giving up after too many attempts");
	return 0;
}
