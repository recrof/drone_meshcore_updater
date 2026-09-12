/* Real GattLink with delayed ATT completion. Zephyr may re-encode a write
 * after authentication, so both its params and data must survive a timeout. */
#include "gatt_link.hpp"
#include <cassert>
#include <cstring>
#include <cstdio>

using nordic::dfu::internal::GattLink;
uint32_t fake_now;
static bt_conn peer{};
static unsigned peer_refs = 1;
static bt_gatt_write_params *held_write;
static unsigned writes;
static int immediate_error;
static bool immediate_completion;
static GattLink *abort_on_wait;
static bt_conn_cb *conn_callbacks;
static bt_gatt_subscribe_params *held_ccc;
static bt_gatt_subscribe_params *host_subscription;
static bool hold_enable;
static bool sync_unsubscribe;
static int unsubscribe_error;
static uint8_t enable_error;
static unsigned enables;
static unsigned unsubscribes;
static GattLink *probe_after_removal;
static GattLink *probe_before_disconnect;
static const bt_uuid_128 service_uuid = {{BT_UUID_TYPE_128},
	{0x23,0xd1,0xbc,0xea,0x5f,0x78,0x23,0x15,0xde,0xef,0x12,0x12,0x30,0x15,0,0}};

extern "C" {
void fake_event(const char *event)
{
	if (abort_on_wait && !strcmp(event, "wait")) {
		auto *link = abort_on_wait; abort_on_wait = nullptr;
		link->abort();
	}
}
int bt_conn_cb_register(bt_conn_cb *cb) { conn_callbacks = cb; return 0; }
bt_conn *bt_conn_ref(bt_conn *c) { if (c == &peer) ++peer_refs; return c; }
void bt_conn_unref(bt_conn *c) { if (c == &peer) { assert(peer_refs > 1); --peer_refs; } }
int bt_conn_get_info(bt_conn *c, bt_conn_info *out) { *out = {}; out->state = c->state; return 0; }
int bt_conn_disconnect(bt_conn *, uint8_t) { return 0; }
int bt_gatt_discover(bt_conn *c, bt_gatt_discover_params *p)
{
	if (p->type == BT_GATT_DISCOVER_PRIMARY) {
		bt_gatt_service_val value{&service_uuid.uuid, 10};
		bt_gatt_attr attr{1, &value}; p->func(c, &attr, p);
	} else if (p->type == BT_GATT_DISCOVER_CHARACTERISTIC) {
		for (unsigned n = 0; n < 2; ++n) {
			bt_uuid_128 uuid = service_uuid; uuid.val[12] = uint8_t(0x31 + n);
			bt_gatt_chrc value{&uuid.uuid, uint16_t(3 + 2 * n)};
			bt_gatt_attr attr{uint16_t(2 + 2 * n), &value}; p->func(c, &attr, p);
		}
	} else {
		bt_gatt_attr attr{4, nullptr}; p->func(c, &attr, p);
	}
	p->func(c, nullptr, p);
	return 0;
}
int bt_gatt_subscribe(bt_conn *c, bt_gatt_subscribe_params *p)
{
	++enables;
	assert(!held_ccc && !host_subscription);
	host_subscription = p;
	atomic_set_bit(p->flags, BT_GATT_SUBSCRIBE_FLAG_WRITE_PENDING);
	if (hold_enable) held_ccc = p;
	else {
		atomic_clear_bit(p->flags, BT_GATT_SUBSCRIBE_FLAG_WRITE_PENDING);
		if (enable_error) {
			host_subscription = nullptr;
			p->notify(c, p, nullptr, 0);
		}
		p->subscribe(c, enable_error, p);
	}
	return 0;
}
int bt_gatt_unsubscribe(bt_conn *c, bt_gatt_subscribe_params *p)
{
	++unsubscribes;
	assert(!held_ccc); // Never cancel/rewrite a still-pending enable in place.
	if (host_subscription != p) return -EINVAL;
	if (sync_unsubscribe) {
		host_subscription = nullptr;
		p->notify(c, p, nullptr, 0);
		return 0;
	}
	p->value = 0;
	if (unsubscribe_error) return unsubscribe_error;
	atomic_set_bit(p->flags, BT_GATT_SUBSCRIBE_FLAG_WRITE_PENDING);
	held_ccc = p;
	host_subscription = nullptr; // Last subscriber: unlink now, complete later.
	return 0;
}
int bt_gatt_write(bt_conn *c, bt_gatt_write_params *p)
{
	++writes;
	if (immediate_error) return immediate_error;
	assert(held_write == nullptr); // A second request must not overwrite the first.
	if (immediate_completion) p->func(c, 0, p);
	else held_write = p;
	return 0;
}
int bt_gatt_read(bt_conn *c, bt_gatt_read_params *p) { p->func(c, 0, p, nullptr, 0); return 0; }
int bt_gatt_exchange_mtu(bt_conn *c, bt_gatt_exchange_params *p) { p->func(c, 0, p); return 0; }
uint16_t bt_gatt_get_mtu(bt_conn *) { return 23; }
int bt_gatt_write_without_response_cb(bt_conn *c, uint16_t, const void *, uint16_t,
	bool, void (*cb)(bt_conn *, void *), void *user) { cb(c, user); return 0; }
}

static void complete_write(uint8_t err = 0)
{
	assert(held_write);
	auto *p = held_write; held_write = nullptr;
	p->func(&peer, err, p);
}

/* Match ncs-v3.4.0 gatt_write_ccc_rsp, including its early return without
 * callbacks on an error after the last subscription list was removed. */
static void complete_ccc(uint8_t err = 0)
{
	assert(held_ccc);
	auto *p = held_ccc; held_ccc = nullptr;
	atomic_clear_bit(p->flags, BT_GATT_SUBSCRIBE_FLAG_WRITE_PENDING);
	if (err) {
		if (!host_subscription) return;
		host_subscription = nullptr;
		p->notify(&peer, p, nullptr, 0);
	} else if (!p->value) {
		p->notify(&peer, p, nullptr, 0);
		if (probe_after_removal) {
			assert(probe_after_removal->attach(&peer) == -EBUSY);
			probe_after_removal = nullptr;
		}
	}
	p->subscribe(&peer, err, p);
}

static void host_disconnect()
{
	peer.state = 0;
	/* Pinned conn.c cleans L2CAP/ATT/GATT before the public disconnect
	 * callback. A local link-state change alone is not a release fence. */
	if (held_ccc) complete_ccc(0x0e);
	if (host_subscription) {
		auto *p = host_subscription; host_subscription = nullptr;
		p->value = 0;
		p->notify(&peer, p, nullptr, 0);
	}
	if (probe_before_disconnect) {
		assert(probe_before_disconnect->attach(&peer) == -EBUSY);
		probe_before_disconnect = nullptr;
	}
	conn_callbacks->disconnected(&peer, 0x13);
}

int main(int argc, char **argv)
{
	assert(argc == 2);
	const char *which = argv[1];
	static GattLink link;
	peer.state = BT_CONN_STATE_CONNECTED;
	assert(link.attach(&peer) == 0);
	assert(link.discover() == 0);
	uint8_t command[] = {1, 4};
	if (!strncmp(which, "ccc_", 4)) {
		if (!strcmp(which, "ccc_enable_error")) {
			enable_error = 0x0e;
			assert(link.subscribe_control_point() == -EIO);
			link.detach(); enable_error = 0;
			assert(link.attach(&peer) == 0);
			assert(link.discover() == 0);
			assert(link.subscribe_control_point() == 0);
		} else if (!strcmp(which, "ccc_enable_timeout") ||
			   !strcmp(which, "ccc_enable_disconnect")) {
			hold_enable = true;
			assert(link.subscribe_control_point() == -ETIMEDOUT);
			link.unsubscribe_control_point();
			assert(unsubscribes == 0);
			link.detach();
			assert(link.attach(&peer) == -EBUSY);
			if (!strcmp(which, "ccc_enable_disconnect")) {
				host_disconnect(); peer.state = BT_CONN_STATE_CONNECTED;
			} else complete_ccc(0x0e);
			hold_enable = false;
			assert(link.attach(&peer) == 0);
			assert(link.discover() == 0);
			assert(link.subscribe_control_point() == 0);
		} else {
			assert(link.subscribe_control_point() == 0);
			if (!strcmp(which, "ccc_sync_unsubscribe")) sync_unsubscribe = true;
			if (!strcmp(which, "ccc_immediate_error")) unsubscribe_error = -ENOMEM;
			link.unsubscribe_control_point();
			link.detach();
			if (!strcmp(which, "ccc_delayed_unsubscribe")) {
				assert(held_ccc && held_ccc->value == 0);
				assert(link.attach(&peer) == -EBUSY);
				assert(enables == 1 && held_ccc->value == 0);
				probe_after_removal = &link;
				complete_ccc();
			} else if (!strcmp(which, "ccc_disconnect")) {
				assert(link.attach(&peer) == -EBUSY);
				probe_before_disconnect = &link;
				host_disconnect(); peer.state = BT_CONN_STATE_CONNECTED;
			} else if (!strcmp(which, "ccc_unsubscribe_error")) {
				assert(link.attach(&peer) == -EBUSY);
				complete_ccc(0x0e); // No notify or subscribe callback in pinned host.
				assert(link.attach(&peer) == -EBUSY);
				bt_conn other{};
				conn_callbacks->disconnected(&other, 0x13);
				assert(link.attach(&peer) == -EBUSY); // Another peer cannot release us.
				assert(peer_refs == 2); // Retain identity until the real cleanup fence.
				host_disconnect(); peer.state = BT_CONN_STATE_CONNECTED;
			} else if (!strcmp(which, "ccc_immediate_error")) {
				assert(host_subscription && !held_ccc);
				host_disconnect(); peer.state = BT_CONN_STATE_CONNECTED;
			} else assert(!strcmp(which, "ccc_sync_unsubscribe"));
			assert(link.attach(&peer) == 0);
			assert(link.discover() == 0);
			if (!strcmp(which, "ccc_delayed_unsubscribe")) {
				hold_enable = true;
				assert(link.subscribe_control_point() == -ETIMEDOUT);
				assert(enables == 2 && held_ccc);
				complete_ccc();
			} else assert(link.subscribe_control_point() == 0);
		}
		link.detach();
		host_disconnect();
		assert(peer_refs == 1);
		printf("PASS %s\n", which);
		return 0;
	}
	const bool reset = !strcmp(which, "reset_timeout");
	const bool cancel = !strcmp(which, "cancelled_data");
	if (!strcmp(which, "length_bounds")) {
		uint8_t oversized[4]{};
		assert(link.write_control_point(nullptr, 1, false) == -EINVAL);
		assert(link.write_control_point(command, 0, false) == -EINVAL);
		assert(link.write_control_point(oversized, sizeof(oversized), false) == -EINVAL);
		assert(writes == 0);
		immediate_completion = true;
		assert(link.write_control_point(oversized, 3, false) == 0);
	} else if (!strcmp(which, "immediate_error")) {
		immediate_error = -ENOMEM;
		assert(link.write_control_point(command, sizeof(command), false) == -ENOMEM);
		immediate_error = 0; immediate_completion = true;
		assert(link.write_control_point(command, sizeof(command), false) == 0);
		assert(writes == 2);
	} else {
		if (cancel) abort_on_wait = &link;
		const int expected_result = reset ? 0 : cancel ? -ECANCELED : -ETIMEDOUT;
		assert(link.write_control_point(command, sizeof(command), reset) == expected_result);
		if (!strcmp(which, "timeout_data") || reset || cancel) {
			// The caller's stack buffer may be gone or reused when ATT
			// retries after authentication; simulate that reuse explicitly.
			memset(command, 0xa5, sizeof(command));
			const uint8_t expected[] = {1, 4};
			assert(!memcmp(held_write->data, expected, sizeof(expected)));
			complete_write();
		} else if (!strcmp(which, "pending_reuse")) {
			assert(link.write_control_point(command, sizeof(command), true) == -EBUSY);
			assert(writes == 1);
			complete_write();
			immediate_completion = true;
			assert(link.write_control_point(command, sizeof(command), false) == 0);
		} else if (!strcmp(which, "detached_completion") || !strcmp(which, "delayed_error")) {
			link.detach();
			assert(link.attach(&peer) == -EBUSY);
			// Must retire the owner even with no active session, including
			// an ATT error when the previous request is torn down.
			complete_write(!strcmp(which, "delayed_error") ? 0x0e : 0);
			assert(link.attach(&peer) == 0);
			assert(link.discover() == 0);
			immediate_completion = true;
			assert(link.write_control_point(command, sizeof(command), false) == 0);
		} else {
			assert(!"unknown test case");
		}
	}
	link.detach();
	assert(peer_refs == 1);
	printf("PASS %s\n", which);
}
