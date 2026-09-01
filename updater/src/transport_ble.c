/*
 * BLE central -> Nordic Legacy DFU, behind the dfu_transport interface.
 *
 * Deliberately thin. All the scanning lives in ble_scanner.c and all the
 * protocol in dfu_client.cpp + modules/nordic-legacy-dfu; this file exists
 * only to present them in the shape dfu_runner now speaks.
 *
 * Note what it does NOT do: find() does not connect. The advertised name is in
 * the advertisement, so BLE can name a peer without touching it, and
 * dfu_client_run() opens and closes its own link. That is the half of the
 * interface the WiFi driver will use differently, and it is why find() is
 * merely *allowed* to leave a connection open rather than required to.
 */

#include <zephyr/kernel.h>
#include <zephyr/bluetooth/conn.h>
#include <zephyr/bluetooth/hci_types.h>
#include <errno.h>
#include <zephyr/logging/log.h>
#include <stdio.h>

#include "dfu_transport.h"
#include "pin_addr.h"
#include <zephyr/sys/__assert.h>

LOG_MODULE_REGISTER(transport_ble, LOG_LEVEL_INF);

/*
 * Tear down any link this updater still holds as a central, before looking for
 * a target.
 *
 * ---- The deadlock this exists to break ---------------------------------
 *
 * A BLE peripheral in a connection does not advertise. So if a run ends with
 * the *target* still believing the link is up — our side gave up, timed out, or
 * lost its handle — that target goes quiet, our next scan cannot see it, and
 * every retry fails at the scan rather than at the thing that actually broke.
 * The transfer can never be repaired, because the two ends disagree about
 * whether they are talking. On a repeater up a mast that means a trip.
 *
 * The specific leak that produced it is fixed in dfu_client.cpp
 * (disconnect_and_release now always terminates, not only when it believes the
 * link came up). **This is the net underneath that**, and it is worth having
 * separately: any future path that drops a handle without terminating,
 * anywhere in the client, is repaired at the start of the next attempt instead
 * of bricking the run.
 *
 * ---- Why role is the discriminator -------------------------------------
 *
 * We are central for every DFU target — we are the one that connects — and
 * peripheral for exactly one thing: the browser holding the SMP link that
 * triggered this run. Sweeping by role therefore cleans up every target link
 * and cannot touch the operator's own connection, which needs no special case
 * and no address to be remembered anywhere.
 *
 * Nothing legitimate is open as a central at this point: the client holds its
 * link inside run(), never across find(). A central link here is stale by
 * definition.
 */
struct stale_sweep {
	int seen;
};

static void sweep_one(struct bt_conn *conn, void *user_data)
{
	struct stale_sweep *sw = user_data;
	struct bt_conn_info info;

	if (bt_conn_get_info(conn, &info) < 0 || info.type != BT_CONN_TYPE_LE) {
		return;
	}
	/* The browser's SMP link. Never ours to close. */
	if (info.role != BT_CONN_ROLE_CENTRAL) {
		return;
	}

	/*
	 * ---- Not every conn object is a link -----------------------------
	 *
	 * `bt_conn_foreach()` walks every slot in `acl_conns[]` and hands over
	 * anything with a non-zero reference count. It does **not** filter on
	 * state, so the enumeration includes objects that are not connections
	 * at all — and one of them is ours.
	 *
	 * `le_adv_start_add_conn()` reserves a conn for a connectable
	 * advertiser before any peer exists:
	 *
	 *     conn = bt_conn_add_le(adv->id, BT_ADDR_LE_NONE);
	 *     bt_conn_set_state(conn, BT_CONN_ADV_CONNECTABLE);
	 *
	 * `bt_conn_add_le()` never assigns `role`, and the slot is zeroed, so
	 * it reads back as **BT_CONN_ROLE_CENTRAL (0)** — a value nothing ever
	 * wrote. Its `dst` is BT_ADDR_LE_NONE. So the sweep saw "a central
	 * link to FF:FF:FF:FF:FF:FF", tried to disconnect it, got -ENOTCONN
	 * (that state falls to the `default` arm of bt_conn_disconnect), found
	 * it again on the next poll, and burned its full 20 x 100 ms — every
	 * DFU attempt, with 22 identical warnings in front of the scan:
	 *
	 *     stale link to FF:FF:FF:FF:FF:FF (public) still open — closing it
	 *
	 * This was written down as suspected `CONFIG_BT_EXT_ADV` fallout
	 * because the MG24 is the only board with it and the MG24 is where it
	 * was first seen. **That was wrong**: a user's log has it on an
	 * nRF52840, which has no extended advertising. It is the ordinary
	 * connectable advertiser, on every board, and the role reading CENTRAL
	 * — the detail that argued *against* the advertising theory — turns
	 * out to be the strongest evidence for it, because an advertiser's
	 * placeholder is the one conn object whose role is never set.
	 *
	 * The address is the discriminator, not the state: a stuck *initiator*
	 * is also "connecting" and is exactly what Trap 11 needs this sweep to
	 * cancel, but it always has a peer address, because nothing here uses
	 * `bt_conn_le_create_auto()` or directed advertising. A conn with no
	 * peer is not something we opened.
	 */
	if (bt_addr_le_eq(info.le.dst, BT_ADDR_LE_NONE)) {
		return;
	}
	/* Already gone, or already going. Disconnecting these returns
	 * -ENOTCONN or 0 forever and they leave on their own. */
	if (info.state == BT_CONN_STATE_DISCONNECTED ||
	    info.state == BT_CONN_STATE_DISCONNECTING) {
		return;
	}

	char addr[BT_ADDR_LE_STR_LEN];
	bt_addr_le_to_str(info.le.dst, addr, sizeof(addr));
	LOG_WRN("stale link to %s still open — closing it so the peer can "
		"advertise again", addr);

	/* Also cancels an initiator that never completed, which is the state
	 * that stops a peer advertising without either side being connected. */
	int rc = bt_conn_disconnect(conn, BT_HCI_ERR_REMOTE_USER_TERM_CONN);
	if (rc && rc != -ENOTCONN) {
		LOG_WRN("stale link disconnect rc=%d", rc);
	}
	sw->seen++;
}

static void ble_reset_stale_links(void)
{
	struct stale_sweep sw = { 0 };

	bt_conn_foreach(BT_CONN_TYPE_LE, sweep_one, &sw);
	if (sw.seen == 0) {
		return;
	}

	/*
	 * Wait for the disconnects to land, then for the peer to start
	 * advertising again.
	 *
	 * Polled rather than waited on a callback because this is a sweep over
	 * connections we deliberately hold no handle to — there is nothing to
	 * hang a semaphore on. Trap 3 is why the budget is seconds and not
	 * milliseconds: a pending ATT request can hold a link open well past
	 * our own disconnect.
	 */
	for (int i = 0; i < 20; i++) {
		k_sleep(K_MSEC(100));
		struct stale_sweep again = { 0 };
		bt_conn_foreach(BT_CONN_TYPE_LE, sweep_one, &again);
		if (again.seen == 0) {
			break;
		}
	}

	/* A peripheral does not resume advertising the instant the link drops —
	 * it has to notice, and then wait out its own advertising interval.
	 * Scanning through that costs nothing but makes the first sweep of the
	 * scan useless, and on a `scan_timeout` of a few seconds that is the
	 * difference between finding the target and reporting no target. */
	k_sleep(K_MSEC(500));
}

static int ble_find(struct dfu_target *out, const struct app_config *cfg,
		    uint32_t timeout_ms, const char *pin)
{
	int rc;

	/* Before anything else: a link we failed to close would keep the target
	 * silent, and no amount of scanning finds a peripheral that is already
	 * in a connection. */
	ble_reset_stale_links();

	if (pin != NULL && pin[0] != '\0') {
		bt_addr_le_t addr;
		char mac[BT_ADDR_STR_LEN];
		char type[16];

		/* **bt_addr_le_to_str() and bt_addr_le_from_str() are not
		 * inverses.** The renderer produces one string; the parser
		 * takes the address and the type as two arguments and rejects
		 * anything but exactly 17 characters for the first. Passing
		 * the rendered string straight back shipped once and failed as
		 * "the scanner could not start" — see pin_addr.h. */
		if (pin_addr_split(pin, mac, sizeof(mac), type, sizeof(type)) < 0 ||
		    bt_addr_le_from_str(mac, type, &addr) < 0) {
			/* The operator's client sending nonsense, not a missing
			 * peer: -EINVAL rather than -ETIMEDOUT, because
			 * retrying cannot help. */
			LOG_ERR("cannot parse pinned address '%s'", pin);
			return -EINVAL;
		}
		rc = ble_scanner_find_pinned(&out->ble, timeout_ms, &addr);
	} else {
		rc = ble_scanner_find_first(&out->ble, timeout_ms, cfg->ble_name,
					    cfg->min_rssi, NULL);
	}
	if (rc < 0) {
		return rc;
	}
	snprintf(out->name, sizeof(out->name), "%s", out->ble.name);
	return 0;
}

static enum dfu_result ble_run(const struct dfu_target *t,
			       const struct dfu_payload *payload,
			       const struct app_config *cfg)
{
	/* The runner checks payload_kind before calling, so this is a
	 * programming error rather than a bad file. Streaming a bare image at
	 * a Legacy DFU peer would send it a headerless blob it cannot refuse
	 * until VALIDATE. */
	__ASSERT(payload->kind == DFU_PAYLOAD_ZIP,
		 "BLE transport handed a non-zip payload");
	return dfu_client_run(&t->ble, &payload->zip, cfg);
}

/*
 * Did the image actually take?
 *
 * ACTIVATE-and-Reset is acknowledged by the bootloader *before* it validates
 * anything, so a clean DFU_OK means "every byte arrived", not "the target is
 * running it". The bootloader checks the image's CRC on the way back up, and
 * if it fails there is no application to boot — oltaco's OTAFIX bootloader
 * re-arms BLE DFU instead, so the operator can simply try again. That is a
 * good behaviour and it makes our success report a lie: the peer is sitting in
 * DFU mode and we have gone home saying it is updated.
 *
 * ---- The tell is the DFU service, not the address ----------------------
 *
 * **This keyed on the address alone and that was wrong**, on the reasoning
 * that a Nordic bootloader advertises at MAC+1 (or at its own address when it
 * was already in DFU mode), so anything advertising *there* must be the
 * bootloader. Some targets are like that. The one that found this is not: a
 * RAK4631 running MeshCore keeps the same address in both modes —
 *
 *   pinned match: C1:DB:7B:EB:7A:0C (random) name='AdaDFU'   <- bootloader
 *   ... 494176 bytes uploaded, result=SUCCESS ...
 *   C1:DB:7B:EB:7A:0C (random) is advertising: name='' dfu_service=no
 *
 * — and that last line is the *new application*, up and running, which this
 * function called a rejection. The runner then reflashed a target that had
 * already succeeded, and again, and again: an **update loop against a device
 * that was finished the first time**.
 *
 * It is a race, which is why it did not surface sooner. The same log has an
 * earlier transfer to the same board pass verification, for no better reason
 * than that the target had not finished rebooting inside the 5 s window.
 * Whether a successful DFU got reported as success depended on how fast the
 * peer came back up.
 *
 * The discriminator is `dfu_uuid`: whether the advertisement carries the
 * Legacy DFU service. A bootloader in DFU mode advertises it — it must, or
 * find_first() could never discover one at all — and an application does not.
 * The flag was already collected, already *logged* in the failure message
 * below, and simply never consulted. An address answers "is something there",
 * which is not the question being asked.
 *
 * Two numbers, both deliberately generous, because the cost of being wrong is
 * asymmetric. A false "rejected" costs one retry against a target that is
 * already fine; a false "confirmed" is the bug this exists to catch.
 *
 *   SETTLE  the peer has to reset, check the CRC and decide. Nothing useful
 *           can be concluded before it has.
 *   WATCH   how long to look. Scanning runs at a 50% duty cycle and a
 *           bootloader in DFU mode advertises continuously, so this is many
 *           times what it takes to see one.
 */
#define VERIFY_SETTLE_MS 2000
#define VERIFY_WATCH_MS  5000

static enum dfu_result ble_verify(const struct dfu_target *t,
				  const struct app_config *cfg)
{
	struct ble_scanner_target seen;

	ARG_UNUSED(cfg);

	k_sleep(K_MSEC(VERIFY_SETTLE_MS));

	int rc = ble_scanner_seen_at(&t->ble.addr, VERIFY_WATCH_MS, &seen);

	if (rc == -ETIMEDOUT) {
		LOG_INF("verify: %s is off the air — the new image is running",
			t->name);
		return DFU_OK;
	}
	if (rc == -ECANCELED) {
		/* Stopped by the operator. Not evidence either way, and the
		 * runner is about to unwind anyway. */
		return DFU_OK;
	}
	if (rc < 0) {
		/* The check failed, not the update. Saying "rejected" here
		 * would throw away a transfer that may well have worked. */
		LOG_WRN("verify: could not scan (%d) — leaving the transfer's "
			"own verdict alone", rc);
		return DFU_OK;
	}

	/* Something is at that address. Which something is the whole question. */
	if (!seen.dfu_uuid) {
		LOG_INF("verify: %s is advertising without the DFU service "
			"(name='%s') — that is the application, so the new "
			"image is running", t->name, seen.name);
		return DFU_OK;
	}

	LOG_ERR("verify: the DFU service is still advertised at the target's "
		"address (name='%s') — it rejected the image, most likely on "
		"its own CRC check, and has re-armed DFU", seen.name);
	return DFU_TARGET_REJECTED;
}

/* Both halves, unconditionally: a stop can land while we are scanning, while
 * a transfer is running, or in the gap between them, and the caller has no way
 * to know which. Each is a no-op when its half is idle. */
static void ble_abort(void)
{
	ble_scanner_cancel();
	dfu_client_abort();
}

static void ble_release(struct dfu_target *t)
{
	ARG_UNUSED(t);
	/* dfu_client_run() disconnects on every path out of itself, including
	 * the buttonless jump and Reset-after-error. Nothing is left open. */
}

const struct dfu_transport dfu_transport_ble = {
	.name = "ble-legacy-dfu",
	.available = NULL,           /* the radio is always there */
	.find = ble_find,
	.run = ble_run,
	.payload_kind = DFU_PAYLOAD_ZIP,
	.verify = ble_verify,
	.abort = ble_abort,
	.release = ble_release,
};
