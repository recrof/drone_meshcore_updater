/*
 * Passkey entry for DFU targets that require an encrypted link.
 *
 * See ble_pairing.h for why this file is so short: Zephyr's
 * BT_ATT_RETRY_ON_SEC_ERR does the elevating and the retrying, and all that is
 * left for the application is to answer the passkey prompt when one arrives.
 */

#include "ble_pairing.h"
#include "dfu_status.h"

#include <zephyr/kernel.h>
#include <zephyr/bluetooth/bluetooth.h>
#include <zephyr/bluetooth/conn.h>
#include <zephyr/sys/atomic.h>
#include <zephyr/logging/log.h>
#include <ctype.h>
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

LOG_MODULE_REGISTER(ble_pairing, LOG_LEVEL_INF);

/* prj.conf asks for this, and a Kconfig line in prj.conf is a request rather
 * than a fact — an unmet dependency is dropped without a word. Without SMP the
 * callbacks below do not exist and a protected target fails as though its DFU
 * characteristic were missing, which is exactly the misdiagnosis this file was
 * written to end. Same insurance as usb_dfu_touch.c's BUILD_ASSERT. */
BUILD_ASSERT(IS_ENABLED(CONFIG_BT_SMP),
	     "ble_pairing.c needs CONFIG_BT_SMP; without it a target that "
	     "requires authentication cannot be reached at all");
/* The other half is Zephyr's, and it is the half that does the work. */
BUILD_ASSERT(IS_ENABLED(CONFIG_BT_ATT_RETRY_ON_SEC_ERR),
	     "without BT_ATT_RETRY_ON_SEC_ERR an ATT request refused for "
	     "security is failed rather than retried, so supplying a passkey "
	     "would change nothing");

/* The passkey for the run in flight, or -1 for "we have none".
 *
 * A single atomic rather than a value plus a `have` flag: the two are read
 * from the BT RX thread while the runner writes them, and a torn read between
 * them would either offer a stale passkey or refuse one we hold. -1 cannot
 * collide with a real value, which is 0..999999.
 */
static atomic_t s_passkey = ATOMIC_INIT(-1);

/* DFU_STATUS_RESULT_NONE, _AUTH_REQUIRED or _AUTH_FAILED. */
static atomic_t s_verdict = ATOMIC_INIT(DFU_STATUS_RESULT_NONE);

/*
 * The pairing parked waiting for an operator, and the lock that owns it.
 *
 * A mutex rather than an atomic because two threads touch this from opposite
 * ends: passkey_entry() parks it on the BT RX thread, and ble_pairing_submit()
 * answers from whichever thread mcumgr's SMP handler runs on. Both the
 * reference and the "still waiting" decision have to move together, or a
 * pairing that times out between the two hands bt_conn_auth_passkey_entry() a
 * connection nobody is pairing on any more.
 */
static K_MUTEX_DEFINE(s_wait_lock);
static struct bt_conn *s_waiting;

/*
 * First writer wins, and that ordering is the point.
 *
 * When a peer asks for a passkey we do not have, we cancel — and our own
 * cancel then comes back through pairing_failed() as AUTH_FAIL a moment later.
 * Letting that overwrite would turn "this target needs a PIN" into "that PIN
 * was wrong", which sends the operator off to re-type a PIN they never entered.
 */
static void record(int verdict)
{
	if (atomic_cas(&s_verdict, DFU_STATUS_RESULT_NONE, verdict)) {
		return;
	}
	LOG_DBG("verdict %d not recorded; %ld already stands",
		verdict, (long)atomic_get(&s_verdict));
}

/*
 * Is this link one of ours to authenticate?
 *
 * We are central for every DFU target and peripheral for exactly one thing:
 * the browser's SMP link. Role is therefore the discriminator, as it is in
 * transport_ble.c's stale-link sweep — and for the same reason, that it needs
 * no address to be remembered anywhere. A browser that decided to pair with us
 * gets a cancel and leaves no verdict behind: nothing on this device requires
 * an encrypted link, so such a request is not about a DFU at all and must not
 * be reported as one.
 */
static bool is_target_link(struct bt_conn *conn)
{
	struct bt_conn_info info;

	if (bt_conn_get_info(conn, &info) < 0) {
		return false;
	}
	return info.type == BT_CONN_TYPE_LE &&
	       info.role == BT_CONN_ROLE_CENTRAL;
}

static const char *addr_of(struct bt_conn *conn, char *buf, size_t len)
{
	struct bt_conn_info info;

	if (bt_conn_get_info(conn, &info) < 0) {
		snprintf(buf, len, "?");
		return buf;
	}
	bt_addr_le_to_str(info.le.dst, buf, len);
	return buf;
}

/* Caller holds s_wait_lock. */
static void forget_waiting(void)
{
	if (s_waiting != NULL) {
		bt_conn_unref(s_waiting);
		s_waiting = NULL;
	}
}

static void on_passkey_entry(struct bt_conn *conn)
{
	char addr[BT_ADDR_LE_STR_LEN];

	if (!is_target_link(conn)) {
		LOG_WRN("passkey asked for on a link we did not open (%s) — "
			"declining; nothing here requires an encrypted link",
			addr_of(conn, addr, sizeof(addr)));
		bt_conn_auth_cancel(conn);
		return;
	}

	atomic_val_t key = atomic_get(&s_passkey);

	if (key < 0) {
		/*
		 * Parked, not cancelled — and the difference is the whole
		 * feature.
		 *
		 * bt_conn_auth_cancel() here ends the pairing, and the target
		 * stops displaying the passkey the moment it does. So the old
		 * code destroyed the number at the exact instant it asked
		 * somebody to read it, and the retry that followed showed a
		 * different one, because a displayed passkey belongs to its
		 * pairing. Reported from the field as "the PIN goes away too
		 * quickly", which is precisely right.
		 *
		 * Leaving it open costs nothing: SMP times the pairing out on
		 * its own after 30 s and pairing_failed() then records the
		 * verdict, so nothing is stuck if no one is listening.
		 */
		k_mutex_lock(&s_wait_lock, K_FOREVER);
		forget_waiting();
		s_waiting = bt_conn_ref(conn);
		k_mutex_unlock(&s_wait_lock);

		LOG_WRN("%s is displaying a PIN and none is configured — "
			"waiting up to 30 s for one. Type it in the browser, "
			"or set `ble_pin` in config.txt to answer without "
			"being asked",
			addr_of(conn, addr, sizeof(addr)));
		/* Published so a client can prompt while the target is still
		 * showing the digits. Nothing else drives the status here: the
		 * DFU client is blocked inside a GATT operation waiting for
		 * this pairing to resolve. */
		dfu_status_set_state(DFU_STATUS_AWAITING_PIN);
		return;
	}

	LOG_INF("%s asked for a PIN — answering",
		addr_of(conn, addr, sizeof(addr)));
	int rc = bt_conn_auth_passkey_entry(conn, (unsigned int)key);
	if (rc) {
		LOG_ERR("bt_conn_auth_passkey_entry rc=%d", rc);
		record(DFU_STATUS_RESULT_AUTH_FAILED);
	}
}

static void on_cancel(struct bt_conn *conn)
{
	char addr[BT_ADDR_LE_STR_LEN];

	/* Required to be non-NULL for the rest of the set to be accepted, and
	 * it is also the only notice we get that the *peer* walked away
	 * mid-pairing. */
	LOG_WRN("pairing with %s was cancelled",
		addr_of(conn, addr, sizeof(addr)));
}

/* Only passkey_entry and cancel, which is what fixes our IO capability at
 * KeyboardOnly — the right claim for a device with no display: a peer that
 * shows six digits gets Passkey Entry, and one with nothing to show falls back
 * to Just Works rather than refusing. Setting passkey_display as well would
 * claim a screen this thing does not have. */
static struct bt_conn_auth_cb s_auth_cb = {
	.passkey_entry = on_passkey_entry,
	.cancel        = on_cancel,
};

static const char *sec_err_str(enum bt_security_err reason)
{
	switch (reason) {
	case BT_SECURITY_ERR_SUCCESS:            return "success";
	case BT_SECURITY_ERR_AUTH_FAIL:          return "authentication failed (wrong PIN?)";
	case BT_SECURITY_ERR_PIN_OR_KEY_MISSING: return "PIN or key missing";
	case BT_SECURITY_ERR_OOB_NOT_AVAILABLE:  return "OOB data not available";
	case BT_SECURITY_ERR_AUTH_REQUIREMENT:   return "authentication requirements not met";
	case BT_SECURITY_ERR_PAIR_NOT_SUPPORTED: return "peer does not support pairing";
	case BT_SECURITY_ERR_PAIR_NOT_ALLOWED:   return "peer refused to pair";
	case BT_SECURITY_ERR_INVALID_PARAM:      return "invalid parameter";
	case BT_SECURITY_ERR_KEY_REJECTED:       return "key rejected";
	default:                                 return "unspecified";
	}
}

static void on_pairing_complete(struct bt_conn *conn, bool bonded)
{
	char addr[BT_ADDR_LE_STR_LEN];

	k_mutex_lock(&s_wait_lock, K_FOREVER);
	forget_waiting();
	k_mutex_unlock(&s_wait_lock);

	/* `bonded` is normally true — CONFIG_BT_BONDABLE is left at its
	 * default, see prj.conf. It does *not* mean anything reached flash:
	 * CONFIG_BT_SETTINGS is off, so the key lives in the bt_keys pool and
	 * is gone at the next reboot. The two are separate settings and
	 * treating them as one is what broke the first hardware run. */
	LOG_INF("paired with %s%s", addr_of(conn, addr, sizeof(addr)),
		bonded ? " (bonded, in RAM only)" : "");
}

static void on_pairing_failed(struct bt_conn *conn, enum bt_security_err reason)
{
	char addr[BT_ADDR_LE_STR_LEN];

	k_mutex_lock(&s_wait_lock, K_FOREVER);
	forget_waiting();
	k_mutex_unlock(&s_wait_lock);

	if (!is_target_link(conn)) {
		return;
	}
	LOG_ERR("pairing with %s failed: %s (%d)",
		addr_of(conn, addr, sizeof(addr)), sec_err_str(reason),
		(int)reason);

	/*
	 * Which of the two verdicts this is depends on whether we had anything
	 * to offer, and *not* on whether passkey_entry() ran.
	 *
	 * Pairing can fail before a method is ever chosen — the feature
	 * exchange settles bonding, MITM and SC first, and any of those can end
	 * it. That is what happened on the first hardware run: the peer offered
	 * legacy pairing, we were compiled to refuse it, and the run reported
	 * "the target rejected the PIN" for a PIN that had never been sent.
	 * Reading the passkey we hold answers the question that message is
	 * actually making a claim about.
	 */
	if (atomic_get(&s_passkey) < 0) {
		record(DFU_STATUS_RESULT_AUTH_REQUIRED);
	} else {
		record(DFU_STATUS_RESULT_AUTH_FAILED);
	}
}

static struct bt_conn_auth_info_cb s_auth_info_cb = {
	.pairing_complete = on_pairing_complete,
	.pairing_failed   = on_pairing_failed,
};

/* Purely so a log reads as a sequence rather than a mystery: the elevation is
 * Zephyr's, started from inside att.c, and without this line the only trace of
 * it is a request that failed once and then suddenly succeeded. */
static void on_security_changed(struct bt_conn *conn, bt_security_t level,
				enum bt_security_err err)
{
	char addr[BT_ADDR_LE_STR_LEN];

	if (!is_target_link(conn)) {
		return;
	}
	if (err != BT_SECURITY_ERR_SUCCESS) {
		LOG_WRN("security with %s stayed at L%d: %s",
			addr_of(conn, addr, sizeof(addr)), (int)level,
			sec_err_str(err));
		return;
	}
	LOG_INF("link to %s is now L%d", addr_of(conn, addr, sizeof(addr)),
		(int)level);
}

static struct bt_conn_cb s_conn_cb = {
	.security_changed = on_security_changed,
};

int ble_pairing_init(void)
{
	int rc = bt_conn_auth_cb_register(&s_auth_cb);

	if (rc) {
		LOG_ERR("bt_conn_auth_cb_register rc=%d", rc);
		return rc;
	}
	rc = bt_conn_auth_info_cb_register(&s_auth_info_cb);
	if (rc) {
		LOG_ERR("bt_conn_auth_info_cb_register rc=%d", rc);
		return rc;
	}
	rc = bt_conn_cb_register(&s_conn_cb);
	if (rc) {
		LOG_ERR("bt_conn_cb_register rc=%d", rc);
		return rc;
	}
	return 0;
}

void ble_pairing_set_passkey(const char *passkey)
{
	atomic_set(&s_verdict, DFU_STATUS_RESULT_NONE);

	if (passkey == NULL || passkey[0] == '\0') {
		atomic_set(&s_passkey, -1);
		/* Said out loud, because its absence was ambiguous in the first
		 * field log: this function used to log only when a PIN *was*
		 * set, so "no PIN configured" and "these lines were scrolled
		 * past" looked identical, and that is the first thing anyone
		 * reading a pairing failure needs to know. */
		LOG_INF("no PIN configured for this run (config.txt `ble_pin` "
			"is empty and none was typed) — a target that asks for "
			"one will be reported, not answered");
		return;
	}

	size_t len = strlen(passkey);
	bool digits = len <= 6;

	for (size_t i = 0; digits && i < len; i++) {
		digits = isdigit((unsigned char)passkey[i]);
	}
	/* Refused rather than truncated or partially parsed. atoi("12x") is 12
	 * and snprintf into a 7-byte field turns "1234567" into "123456" —
	 * both produce a *wrong* PIN, which fails as an authentication error
	 * and reads as the operator mistyping something they typed correctly. */
	if (!digits) {
		LOG_ERR("ble_pin is not one to six digits — ignoring it; this "
			"device will report that a PIN is needed rather than "
			"offer a wrong one");
		atomic_set(&s_passkey, -1);
		return;
	}

	long val = strtol(passkey, NULL, 10);

	atomic_set(&s_passkey, (atomic_val_t)val);
	/* Never the digits themselves: config.txt is readable over SMP by
	 * anyone already connected, but the log is streamed live *and* written
	 * to flash, and a PIN that leaks into three places instead of one is a
	 * PIN nobody can reason about. */
	LOG_INF("a %u-digit PIN is available for this run", (unsigned)len);
}

int ble_pairing_verdict(void)
{
	return (int)atomic_get(&s_verdict);
}

bool ble_pairing_awaiting(char *addr, size_t len)
{
	bool waiting;

	k_mutex_lock(&s_wait_lock, K_FOREVER);
	waiting = s_waiting != NULL;
	if (waiting && addr != NULL && len > 0) {
		(void)addr_of(s_waiting, addr, len);
	}
	k_mutex_unlock(&s_wait_lock);
	return waiting;
}

int ble_pairing_submit(const char *passkey)
{
	int rc;

	k_mutex_lock(&s_wait_lock, K_FOREVER);

	if (s_waiting == NULL) {
		/* Not an error the operator did anything about: the 30 s
		 * window closed, or the peer walked away, between the prompt
		 * going up and an answer coming back. */
		k_mutex_unlock(&s_wait_lock);
		LOG_WRN("a PIN arrived with no pairing waiting for one");
		return -EALREADY;
	}

	if (passkey == NULL || passkey[0] == '\0') {
		LOG_WRN("PIN entry cancelled — ending the pairing");
		record(DFU_STATUS_RESULT_AUTH_REQUIRED);
		rc = bt_conn_auth_cancel(s_waiting);
		if (rc) {
			LOG_ERR("bt_conn_auth_cancel rc=%d", rc);
		}
		forget_waiting();
		k_mutex_unlock(&s_wait_lock);
		return 0;
	}

	size_t len = strlen(passkey);
	bool digits = len <= 6;

	for (size_t i = 0; digits && i < len; i++) {
		digits = isdigit((unsigned char)passkey[i]);
	}
	if (!digits) {
		/* Refused without touching the pairing, so the operator gets
		 * another go inside the same 30 s rather than having to start
		 * a whole run again for a typo. */
		k_mutex_unlock(&s_wait_lock);
		LOG_ERR("submitted PIN is not one to six digits — ignoring it");
		return -EINVAL;
	}

	LOG_INF("answering the parked pairing with a %u-digit PIN",
		(unsigned)len);
	rc = bt_conn_auth_passkey_entry(s_waiting,
					(unsigned int)strtol(passkey, NULL, 10));
	if (rc) {
		LOG_ERR("bt_conn_auth_passkey_entry rc=%d", rc);
		record(DFU_STATUS_RESULT_AUTH_FAILED);
	}
	forget_waiting();
	k_mutex_unlock(&s_wait_lock);
	return rc;
}
