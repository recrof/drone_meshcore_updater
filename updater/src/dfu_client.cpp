/*
 * Adapter between the app (C) and modules/nordic-legacy-dfu (C++).
 *
 * This is the only DFU client. An earlier one lived in dfu_legacy.c, evolved
 * by hand against this hardware; it was removed once the ported client had
 * been measured as reliable and faster.
 *
 * Three jobs, and nothing else:
 *   1. own the connection, since the library takes a connected bt_conn;
 *   2. present firmware_zip entries as nordic::dfu::Stream;
 *   3. translate app_config -> Parameters and Report -> dfu_result.
 *
 * Deliberately no protocol logic: every behavioural question is answered by
 * the library, which follows LegacyDfuImpl.java. If something here starts
 * looking like protocol, it belongs upstream in the module instead.
 */

#include "dfu_client.h"

#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>
#include <zephyr/bluetooth/bluetooth.h>
#include <zephyr/bluetooth/conn.h>
#include <zephyr/bluetooth/hci.h>

#include "nordic_dfu/legacy_dfu.hpp"

LOG_MODULE_REGISTER(dfu_client, LOG_LEVEL_INF);

using namespace nordic::dfu;

namespace {

/* ---- connection ownership -------------------------------------------- */

struct Link {
	bt_conn *conn = nullptr;
	bool connected = false;
	k_sem sem{};
};

Link s_link;
bool s_cb_registered;
bt_conn_cb s_conn_cb{};

void on_connected(bt_conn *conn, uint8_t err)
{
	/* The SMP client shares this callback slot; only react to our link. */
	if (conn != s_link.conn) {
		return;
	}
	if (err) {
		LOG_WRN("connect err=0x%02x", err);
		s_link.connected = false;
	} else {
		char a[BT_ADDR_LE_STR_LEN];
		bt_addr_le_to_str(bt_conn_get_dst(conn), a, sizeof(a));
		LOG_INF("connected to %s", a);
		s_link.connected = true;
	}
	k_sem_give(&s_link.sem);
}

void log_conn_params(bt_conn *conn, const char *when)
{
	bt_conn_info info{};
	if (bt_conn_get_info(conn, &info) != 0 || info.type != BT_CONN_TYPE_LE) {
		return;
	}
	/* The interval is the real rate limiter for this client: one packet
	 * write is outstanding at a time and its completion callback fires when
	 * the packet actually goes out, i.e. at a connection event. */
	/* interval_us, not the deprecated 1.25 ms-unit `interval`. */
	LOG_INF("conn params %s: interval=%u.%03u ms latency=%u timeout=%u ms",
		when, info.le.interval_us / 1000u, info.le.interval_us % 1000u,
		info.le.latency, info.le.timeout * 10u);
}

void on_le_param_updated(bt_conn *conn, uint16_t interval, uint16_t latency,
			 uint16_t timeout)
{
	ARG_UNUSED(interval); ARG_UNUSED(latency); ARG_UNUSED(timeout);
	if (conn != s_link.conn) {
		return;
	}
	log_conn_params(conn, "updated");
}

void on_disconnected(bt_conn *conn, uint8_t reason)
{
	if (conn != s_link.conn) {
		return;
	}
	LOG_INF("disconnected reason=0x%02x", reason);
	s_link.connected = false;
	k_sem_give(&s_link.sem);
}

/* Registered at runtime rather than with BT_CONN_CB_DEFINE: that macro uses
 * designated initialisers, which are not standard C++17.
 */
void ensure_callbacks(void)
{
	if (s_cb_registered) {
		return;
	}
	k_sem_init(&s_link.sem, 0, 1);
	s_conn_cb.connected = on_connected;
	s_conn_cb.disconnected = on_disconnected;
	s_conn_cb.le_param_updated = on_le_param_updated;
	bt_conn_cb_register(&s_conn_cb);
	s_cb_registered = true;
}

/* ---- firmware_zip -> Stream ------------------------------------------ */

class ZipStream final : public Stream {
public:
	explicit ZipStream(const zip_entry *entry) : entry_(entry) {}

	uint32_t size() const override { return entry_ ? entry_->size : 0; }

	int read(uint32_t offset, uint8_t *dst, uint32_t len) const override
	{
		if (entry_ == nullptr) {
			return -EINVAL;
		}
		return firmware_zip_read(entry_, offset, dst, len);
	}

private:
	const zip_entry *entry_;
};

/* ---- progress -------------------------------------------------------- */

class LogObserver final : public Observer {
public:
	void on_state(State state) override
	{
		/* Reset the clock when streaming actually begins: discovery and
		 * the Start DFU handshake took ~1 s in measured runs and were
		 * dragging the reported KB/s well below the real rate. */
		if (state == State::Uploading) {
			t0_ = k_uptime_get_32();
			next_ = 10;
		}
		static const char *const names[] = {
			"starting", "enabling-dfu-mode", "uploading",
			"validating", "disconnecting", "completed", "aborted",
		};
		unsigned i = static_cast<unsigned>(state);
		LOG_INF("state: %s", i < ARRAY_SIZE(names) ? names[i] : "?");
	}

	void on_progress(uint8_t percent, uint32_t sent, uint32_t total) override
	{
		/* One line per 10% — the transfer is minutes long and the log
		 * backend writes to flash. */
		if (percent >= next_ || percent == 100) {
			uint32_t ms = k_uptime_get_32() - t0_;
			LOG_INF("upload %u%% (%u/%u B, %u.%u KB/s)", percent, sent, total,
				ms ? (sent / ms) : 0u, ms ? ((sent * 10u / ms) % 10u) : 0u);
			next_ = static_cast<uint8_t>(percent + 10);
		}
	}

	void start() { t0_ = k_uptime_get_32(); next_ = 10; }

private:
	uint32_t t0_ = 0;
	uint8_t next_ = 10;
};

/* ---- result translation ---------------------------------------------- */

dfu_result to_dfu_result(const Report &r)
{
	switch (r.result) {
	case Result::Success:
		return DFU_OK;

	/* All three mean "the target rebooted, find it again and re-run".
	 * dfu_runner treats DFU_BUTTONLESS_TRIGGERED as a rescan that does
	 * not consume a retry, which is what each of these wants.
	 *
	 * ApplicationPending strictly wants the next run to send the
	 * application alone. Our bundles are single-image in practice, so
	 * the distinction never arises; if combined SD+BL+App bundles are
	 * ever used, this is the place that needs to remember it.
	 */
	case Result::JumpedToBootloader:
	case Result::RestartRequired:
	case Result::ApplicationPending:
		return DFU_BUTTONLESS_TRIGGERED;

	case Result::ServiceNotFound:        return DFU_SERVICE_MISSING;
	case Result::CharacteristicNotFound: return DFU_CHAR_MISSING;
	case Result::RemoteError:            return DFU_REMOTE_ERROR;
	case Result::InvalidResponse:        return DFU_REMOTE_ERROR;
	case Result::DeviceDisconnected:     return DFU_DISCONNECTED_EARLY;
	case Result::GattError:              return DFU_DISCONNECTED_EARLY;
	case Result::Timeout:                return DFU_TIMEOUT;
	case Result::FileError:              return DFU_FS_ERROR;
	case Result::InitPacketRequired:     return DFU_FS_ERROR;
	case Result::Aborted:                return DFU_DISCONNECTED_EARLY;
	}
	return DFU_REMOTE_ERROR;
}

void disconnect_and_release(void)
{
	if (s_link.conn == nullptr) {
		return;
	}
	if (s_link.connected) {
		bt_conn_disconnect(s_link.conn, BT_HCI_ERR_REMOTE_USER_TERM_CONN);
		/* Give the link a moment to actually go away. Trap 3: a pending
		 * ATT request can hold it open well past this, which is why
		 * CONFIG_BT_MAX_CONN carries a slack slot. */
		k_sem_take(&s_link.sem, K_SECONDS(2));
	}
	bt_conn_unref(s_link.conn);
	s_link.conn = nullptr;
	s_link.connected = false;
}

} /* namespace */

extern "C" enum dfu_result dfu_client_run(const struct ble_scanner_target *target,
					   const struct firmware_bundle *bundle,
					   const struct app_config *cfg)
{
	if (target == nullptr || bundle == nullptr || cfg == nullptr) {
		return DFU_FS_ERROR;
	}

	ensure_callbacks();

	/* ---- connect ---- */
	/* 7.5-15 ms. The interval is NOT what limits the packet rate — measured,
	 * several packets leave per connection event once Data Length Extension
	 * is up, because the write-completion callback fires when the controller
	 * takes the buffer, not when the peer acknowledges. Rate limiting is
	 * Parameters::packet_interval_us below. A short interval is still wanted
	 * here: it sets the round-trip cost of every Control Point response and
	 * packet receipt.
	 */
	/* Pinned to 7.5 ms, min == max. Asking for a 6-12 range got us 15 ms:
	 * the controller simply takes the top of the window, and measured that
	 * cost ~11 ms per packet — the client keeps one packet write
	 * outstanding, so the interval, not pkt_gap_ms, sets the cheap-packet
	 * floor. Halving it should roughly halve that. */
	bt_le_conn_param conn_param{};
	conn_param.interval_min = 6;    /* 7.5 ms */
	conn_param.interval_max = 6;    /* 7.5 ms */
	conn_param.latency = 0;
	/* 6 s, not 30. The target reboots silently after a buttonless jump or a
	 * Reset — it never sends a disconnect — so we only notice at supervision
	 * timeout, and 30 s was most of the ~70 s it took to get a transfer
	 * going. The longest legitimate stall is a ~100 ms page erase, so 6 s is
	 * still a wide margin. (The ATT 30 s timeout is separate and unaffected;
	 * it only bites when the link stays up but the peer stops answering.) */
	conn_param.timeout = 600;       /* 6 s supervision */

	bt_conn_le_create_param create_param{};
	create_param.options = BT_CONN_LE_OPT_NONE;
	create_param.interval = BT_GAP_SCAN_FAST_INTERVAL;
	create_param.window = BT_GAP_SCAN_FAST_WINDOW;

	/* A link to this peer from a previous attempt can still be tearing down
	 * (Trap 3: a pending ATT request holds it open past our own disconnect),
	 * and bt_conn_le_create then refuses with -EINVAL because a conn object
	 * for the address already exists. Measured: one whole retry burned on
	 * "bt_conn_le_create rc=-22" immediately after a failed attempt. Wait it
	 * out rather than counting it as a failure. */
	int rc = -EINVAL;
	for (int attempt = 0; attempt < 12; attempt++) {
		k_sem_reset(&s_link.sem);
		rc = bt_conn_le_create(&target->addr, &create_param, &conn_param,
				       &s_link.conn);
		if (rc != -EINVAL) {
			break;
		}
		if (attempt == 0) {
			LOG_WRN("connect: a previous link to this peer is still "
				"disconnecting — waiting for it to go");
		}
		k_sleep(K_MSEC(500));
	}
	if (rc) {
		LOG_ERR("bt_conn_le_create rc=%d", rc);
		return DFU_CONNECT_FAILED;
	}
	if (k_sem_take(&s_link.sem, K_SECONDS(10)) < 0 || !s_link.connected) {
		LOG_ERR("connect timed out or failed");
		disconnect_and_release();
		return DFU_CONNECT_FAILED;
	}

	/* The LL can report success then drop with 0x3E on a weak link. */
	k_sleep(K_MSEC(300));
	log_conn_params(s_link.conn, "at connect");
	if (!s_link.connected) {
		LOG_WRN("link dropped immediately after connect");
		disconnect_and_release();
		return DFU_CONNECT_FAILED;
	}

	/* ---- describe the firmware ---- */
	ZipStream image(&bundle->bin);
	ZipStream init_packet(&bundle->dat);

	Firmware firmware;
	firmware.type = bundle->type;
	firmware.image = &image;
	firmware.init_packet = (bundle->dat.size > 0) ? &init_packet : nullptr;

	/* Only a multi-image bundle has to state the split; for a single type
	 * the library derives the sizes from type + image->size(). */
	if ((bundle->type & (bundle->type - 1)) != 0) {
		firmware.softdevice_size = bundle->sd_size;
		firmware.bootloader_size = bundle->bl_size;
		uint32_t combined = bundle->sd_size + bundle->bl_size;
		firmware.application_size =
			(bundle->bin.size > combined) ? (bundle->bin.size - combined) : 0;
	}

	/* ---- map config -> Parameters ---- */
	Parameters params;
	params.packets_before_notification = cfg->prn;
	/* Parameters::mtu is only "exchange or not"; the payload is capped by
	 * CONFIG_NORDIC_LEGACY_DFU_MAX_PACKET_SIZE either way. */
	params.mtu = cfg->high_mtu ? 517 : 0;
	/* config.txt's pkt_gap_ms, in microseconds. This is the throttle that
	 * keeps us under the peer's 8-pending-write ring during a page erase
	 * (Trap 4). Without it a Zephyr central sends ~9.4 ms/packet at 244 B
	 * and the target answers OPERATION FAILED a few KB in — measured. */
	params.packet_interval_us = (uint32_t)cfg->pkt_gap_ms * 1000u;
	/* Erase-aware pacing. 4096 is the nRF51/nRF52 flash page; the target
	 * erases one lazily per page and stalls while it does. Zero pause means
	 * uniform pacing, which needs a much larger pkt_gap_ms. */
	if (cfg->erase_pause_ms > 0) {
		params.erase_page_size = 4096;
		params.erase_pause_us = (uint32_t)cfg->erase_pause_ms * 1000u;
		params.erase_inflight_packets = cfg->erase_inflight;
	}
	params.assume_dfu_mode = false;
	/* The Java blocks forever waiting on a notification and relies on a
	 * user to cancel. There is nobody to cancel here, so bound it. */
	params.operation_timeout_ms = 30000;
	params.reset_timeout_ms = 20000;

	LOG_INF("run: type=0x%02x image=%u B init=%u B prn=%u mtu=%s gap=%u ms "
		"erase_pause=%u ms inflight=%u", firmware.type, image.size(),
		init_packet.size(), params.packets_before_notification,
		cfg->high_mtu ? "exchange" : "default", cfg->pkt_gap_ms,
		cfg->erase_pause_ms, cfg->erase_inflight);
	if (cfg->erase_pause_ms == 0 && cfg->pkt_gap_ms < 18) {
		LOG_WRN("uniform pacing with pkt_gap_ms=%u is below the measured "
			"floor of 18 ms — expect OPERATION FAILED or a stalled "
			"packet write within the first few pages",
			cfg->pkt_gap_ms);
	}

	LogObserver observer;
	observer.start();

	LegacyDfuClient client;
	client.set_observer(&observer);
	Report report = client.run(s_link.conn, firmware, params);

	if (report.result == Result::RemoteError) {
		LOG_ERR("result=%s remote=0x%02x (%s) sent=%u",
			result_str(report.result), report.remote,
			remote_status_str(report.remote), report.bytes_sent);
	} else {
		LOG_INF("result=%s err=%d version=%u sent=%u",
			result_str(report.result), report.err,
			report.version, report.bytes_sent);
	}

	/* Activate-and-Reset and the buttonless jump both leave the target
	 * rebooting; the library does not disconnect after them, matching the
	 * Java. Tear the link down here either way so the next scan has a
	 * free connection slot. */
	disconnect_and_release();

	if (report.result == Result::JumpedToBootloader && report.address_may_change) {
		LOG_INF("target may re-advertise at address+1 (SDK 6.1 style)");
	}

	return to_dfu_result(report);
}
