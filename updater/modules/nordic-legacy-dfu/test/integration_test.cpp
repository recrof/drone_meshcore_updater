/* SPDX-License-Identifier: BSD-3-Clause
 * Real app adapter, both clients, GattLink and BLE verifier. Only the OS,
 * filesystem, Bluetooth and app-service boundaries are test doubles. */
#include "dfu_client.h"
#include "dfu_transport.h"
#include "dfu_status.h"
#include "app.h"
#include "gatt_link.hpp"
#if defined(CONFIG_NORDIC_SECURE_DFU)
#include "secure_target_fixture.hpp"
#endif
#include <cassert>
#include <vector>
#include <string>
using namespace nordic::dfu;
uint32_t fake_now;
static bool stopped, secure_peer, pending_connect;
static unsigned writes, creates, discoveries, service_passes;
static std::string stop_at;
static bt_conn peer{};
static bt_addr_le_t address{};
static std::vector<bt_conn_cb *> callbacks;
static std::vector<uint8_t> init;
static int scan_result;
static bool scan_dfu;
static bool scan_secure, complete_secure;
static unsigned secure_notification_fault;
#if defined(CONFIG_NORDIC_SECURE_DFU)
static Target secure_receiver;
static bt_gatt_subscribe_params *secure_subscription;

static void notify_secure(bt_conn *c)
{
	while (!secure_receiver.replies.empty()) {
		auto response = secure_receiver.replies.front();
		secure_receiver.replies.pop_front();
		if (secure_notification_fault == 3 && secure_receiver.selected == 2 &&
		    secure_receiver.committed == 1024 && response[1] == 4) continue;
		if (secure_notification_fault == 2) response.resize(21, 0);
		secure_subscription->notify(c, secure_subscription, response.data(), uint16_t(response.size()));
		if (secure_notification_fault == 1)
			secure_subscription->notify(c, secure_subscription, response.data(), uint16_t(response.size()));
	}
}
#endif
enum class MtuOutcome { Disabled, Success, Rejected, Timeout, Cancelled, Disconnected };
static MtuOutcome mtu_outcome;
static bt_gatt_exchange_params *pending_mtu;
static unsigned mtu_calls, subscriptions, subscription_completions;
static const bt_uuid_16 secure_service = {{BT_UUID_TYPE_16}, 0xfe59};
static const bt_uuid_128 legacy_service = {{BT_UUID_TYPE_128},
	{0x23,0xd1,0xbc,0xea,0x5f,0x78,0x23,0x15,0xde,0xef,0x12,0x12,0x30,0x15,0,0}};
static const bt_uuid_128 secure_control = {{BT_UUID_TYPE_128},
	{0x50,0xea,0xda,0x30,0x88,0x83,0xb8,0x9f,0x60,0x4f,0x15,0xf3,1,0,0xc9,0x8e}};

extern "C" {
bool test_cancelled() { return stopped; }
void fake_event(const char *name) {
	if (stop_at == name) { stopped = true; dfu_client_abort(); }
	if (pending_connect && !strcmp(name, "wait")) {
		pending_connect = false;
		peer.state = BT_CONN_STATE_CONNECTED;
		for (auto *cb : callbacks) if (cb->connected) cb->connected(&peer, 0);
	}
}
int bt_conn_cb_register(bt_conn_cb *cb) { callbacks.push_back(cb); return 0; }
bt_conn *bt_conn_ref(bt_conn *c) { fake_event("before-attach"); return c; }
void bt_conn_unref(bt_conn *) { fake_event("handoff"); }
int bt_conn_get_info(bt_conn *c, bt_conn_info *i) {
	fake_event("info"); *i = {}; i->state = c->state;
	i->type = BT_CONN_TYPE_LE; i->le.dst = &address; return 0;
}
int bt_conn_disconnect(bt_conn *c, uint8_t reason) {
	pending_connect = false; c->state = BT_CONN_STATE_DISCONNECTED;
	for (auto *cb : callbacks) if (cb->disconnected) cb->disconnected(c, reason);
	if (pending_mtu) {
		auto *p = pending_mtu; pending_mtu = nullptr;
		p->func(c, 0x0e, p); // The outstanding ATT request is released on teardown.
	}
	return 0;
}
int bt_conn_le_create(const bt_addr_le_t *, const bt_conn_le_create_param *,
		      const bt_le_conn_param *, bt_conn **out) {
	++creates; peer.state = 0; *out = &peer; pending_connect = true;
	fake_event("create"); return 0;
}
const bt_addr_le_t *bt_conn_get_dst(bt_conn *) { return &address; }
void bt_conn_foreach(int, void (*)(bt_conn *, void *), void *) {}
int bt_gatt_discover(bt_conn *c, bt_gatt_discover_params *p) {
	++discoveries;
	if (p->type == BT_GATT_DISCOVER_PRIMARY) {
		++service_passes;
		bt_gatt_service_val service{secure_peer ? &secure_service.uuid : &legacy_service.uuid, 10};
		bt_gatt_attr a{1, &service}; p->func(c, &a, p);
	} else if (p->type == BT_GATT_DISCOVER_CHARACTERISTIC) {
		for (unsigned n = 0; n < (secure_peer ? 2u : 3u); ++n) {
			bt_uuid_128 uuid = secure_peer ? secure_control : legacy_service;
			uuid.val[12] = uint8_t(secure_peer ? n + 1 : n == 2 ? 0x34 : 0x31 + n);
			bt_gatt_chrc ch{&uuid.uuid, uint16_t(3 + n * 2)};
			bt_gatt_attr a{uint16_t(2 + n * 2), &ch}; p->func(c, &a, p);
		}
	} else {
		bt_gatt_attr a{4, nullptr}; p->func(c, &a, p);
	}
	p->func(c, nullptr, p);
	fake_event("discovery"); return 0;
}
int bt_gatt_subscribe(bt_conn *c, bt_gatt_subscribe_params *p) {
	++subscriptions;
#if defined(CONFIG_NORDIC_SECURE_DFU)
	secure_subscription = p;
#endif
	if (pending_mtu) {
		// Reproduce the old race: MTU completes only after the client has
		// moved on to CCC. Its semaphore signal must not authorize START.
		auto *mtu = pending_mtu; pending_mtu = nullptr;
		mtu->func(c, 0, mtu);
		return 0; // The subscription's own CCC response has not arrived.
	}
	++subscription_completions; p->subscribe(c,0,p); return 0;
}
int bt_gatt_unsubscribe(bt_conn *, bt_gatt_subscribe_params *) { return 0; }
int bt_gatt_write(bt_conn *c, bt_gatt_write_params *p) {
	++writes;
#if defined(CONFIG_NORDIC_SECURE_DFU)
	if (complete_secure) {
		const uint8_t *command = static_cast<const uint8_t *>(p->data);
		assert(secure_receiver.control(command, p->length) == 0);
		p->func(c, 0, p);
		notify_secure(c);
		if (command[0] == 4 && secure_receiver.selected == 2 && secure_receiver.committed == 1024)
			bt_conn_disconnect(c, BT_HCI_ERR_REMOTE_USER_TERM_CONN);
		return 0;
	}
#endif
	// Positive controls stop at the first DFU command. No receiver model
	// here: the separate SecureTransfer suite checks object semantics.
	stopped = true; dfu_client_abort(); p->func(c,0,p); return 0;
}
int bt_gatt_read(bt_conn *c, bt_gatt_read_params *p) {
	const uint8_t v[] = {5,0}; p->func(c,0,p,v,2); p->func(c,0,p,nullptr,0); return 0;
}
int bt_gatt_exchange_mtu(bt_conn *c, bt_gatt_exchange_params *p) {
	++mtu_calls;
	switch (mtu_outcome) {
	case MtuOutcome::Timeout:
		pending_mtu = p; return 0;
	case MtuOutcome::Cancelled:
		stopped = true; dfu_client_abort(); return 0;
	case MtuOutcome::Disconnected:
		bt_conn_disconnect(c, BT_HCI_ERR_REMOTE_USER_TERM_CONN); return 0;
	case MtuOutcome::Rejected:
		p->func(c, 0x06, p); return 0; // Completed ATT Request Not Supported.
	default:
		p->func(c, 0, p); return 0;
	}
}
uint16_t bt_gatt_get_mtu(bt_conn *) { return 247; }
int bt_gatt_write_without_response_cb(bt_conn *c, uint16_t, const void *data, uint16_t size,
				    bool, void (*cb)(bt_conn *, void *), void *u) {
	ARG_UNUSED(data); ARG_UNUSED(size);
	++writes; cb(c,u);
#if defined(CONFIG_NORDIC_SECURE_DFU)
	if (complete_secure) {
		assert(secure_receiver.packet(static_cast<const uint8_t *>(data), size) == 0);
		notify_secure(c);
	}
#endif
	return 0;
}
int firmware_zip_read(const zip_entry *e, uint32_t off, void *out, uint32_t n) {
	if (off > e->size || n > e->size - off) return -EIO;
	if (e->data_offset == 1) memcpy(out,init.data() + off,n);
	else memset(out,0,n);
	return int(n);
}
void dfu_status_set_state(dfu_status_state) {}
void dfu_status_progress(uint8_t, uint32_t, uint32_t) {}
void led_set_progress(uint8_t) {}
void led_set_state(led_state) {}
int ble_scanner_seen_at_cancellable(const bt_addr_le_t *, uint32_t, ble_scanner_target *out, bool (*)(void)) {
	*out = {}; out->legacy_dfu_uuid = scan_dfu; out->secure_dfu_uuid = scan_secure; return scan_result;
}
int ble_scanner_find_first_cancellable(ble_scanner_target *, uint32_t, const char *, int8_t, const bt_addr_le_t *, bool (*)(void)) { return -ETIMEDOUT; }
int ble_scanner_find_pinned_cancellable(ble_scanner_target *, uint32_t, const bt_addr_le_t *, bool (*)(void)) { return -ETIMEDOUT; }
void ble_scanner_cancel() {}
}

static dfu_result run(bool secure_package, bool secure_target, const char *stage = "",
		      MtuOutcome mtu = MtuOutcome::Disabled, unsigned layout = 0,
		      bool complete = false, unsigned notification_fault = 0)
{
	stopped = false; stop_at = stage; writes = creates = discoveries = 0; secure_peer = secure_target;
	service_passes = 0; complete_secure = complete;
	secure_notification_fault = notification_fault;
#if defined(CONFIG_NORDIC_SECURE_DFU)
	secure_receiver = Target{};
	secure_receiver.image_size = 1024;
#endif
	mtu_outcome = mtu; pending_mtu = nullptr;
	mtu_calls = subscriptions = subscription_completions = 0;
	// Unsigned Secure Packet(Command(INIT, InitCommand(app_size=1024))).
	init = secure_package ? std::vector<uint8_t>{10,7,8,1,18,3,56,128,8} : std::vector<uint8_t>(12,0);
	firmware_bundle b{}; b.type = FW_TYPE_APPLICATION; b.bin.size = 1024;
	if (layout) {
		b.type = FW_TYPE_SOFTDEVICE | FW_TYPE_BOOTLOADER;
		b.sd_size = 512; b.bl_size = layout == 1 ? 512 : 511;
		if (layout == 3) { b.sd_size = UINT32_MAX; b.bl_size = 1025; }
	}
	b.dat.size = uint32_t(init.size()); b.dat.data_offset = 1;
	ble_scanner_target target{}; app_config cfg{};
	cfg.high_mtu = mtu != MtuOutcome::Disabled;
	if (stop_at == "before-run") stopped = true;
	return dfu_client_run(&target,&b,&cfg,test_cancelled);
}

static void test_mtu_setup(bool secure)
{
	// An unfinished MTU exchange must end this attempt before a CCC write,
	// even if its late completion would wake the shared ATT semaphore.
	assert(run(secure,secure,"",MtuOutcome::Timeout) == DFU_TIMEOUT);
	assert(mtu_calls == 1 && subscriptions == 0 && writes == 0);
	assert(run(secure,secure,"",MtuOutcome::Cancelled) == DFU_DISCONNECTED_EARLY);
	assert(mtu_calls == 1 && subscriptions == 0 && writes == 0);
	assert(run(secure,secure,"",MtuOutcome::Disconnected) == DFU_DISCONNECTED_EARLY);
	assert(mtu_calls == 1 && subscriptions == 0 && writes == 0);
	// Both a negotiated MTU and a completed rejection may proceed, but
	// only after receiving the subscription's own successful completion.
	for (MtuOutcome outcome : {MtuOutcome::Success, MtuOutcome::Rejected}) {
		assert(run(secure,secure,"",outcome) == DFU_DISCONNECTED_EARLY); // Stop at first DFU command.
		assert(mtu_calls == 1 && subscriptions == 1 && subscription_completions == 1);
		assert(writes == 1);
	}
}
int main()
{
	for (unsigned layout : {2u, 3u}) {
		assert(run(false,false,"",MtuOutcome::Disabled,layout) == DFU_BAD_PACKAGE);
		assert(creates == 0 && writes == 0);
	}
	assert(run(false,false,"",MtuOutcome::Disabled,1) == DFU_DISCONNECTED_EARLY);
	assert(creates == 1 && writes == 1); // Valid split still reaches START.
	test_mtu_setup(false);
#if defined(CONFIG_NORDIC_SECURE_DFU)
	test_mtu_setup(true);
#endif
#if defined(CONFIG_NORDIC_SECURE_DFU)
	assert(run(true,false) == DFU_SERVICE_MISSING); assert(writes == 0 && service_passes == 1);
	assert(run(false,true) == DFU_SERVICE_MISSING); assert(writes == 0 && service_passes == 1);
	assert(run(true,true) == DFU_DISCONNECTED_EARLY); assert(writes == 1); // positive control
	assert(service_passes == 1);
	assert(run(true,true,"",MtuOutcome::Success,0,true) == DFU_BOOT_UNVERIFIED);
	assert(secure_receiver.image == std::vector<uint8_t>(1024, 0) && service_passes == 1);
	for (unsigned fault : {1u, 2u, 3u}) {
		assert(run(true,true,"",MtuOutcome::Success,0,true,fault) == DFU_DISCONNECTED_EARLY);
		assert(secure_receiver.data_packets == (fault == 3 ? 5u : 0u));
		/* A duplicate/oversized notification is never accepted; a missing
		 * final Execute response cannot claim Secure acceptance either. */
	}
#else
	assert(run(true,false) == DFU_BAD_PACKAGE); assert(writes == 0 && creates == 0);
#endif
	assert(run(false,false) == DFU_DISCONNECTED_EARLY); assert(writes == 1);
	assert(service_passes == 1); // No Secure attach/discover/detach tax for Legacy.
	for (const char *stage : {"before-run", "create", "wait", "settle", "before-attach", "info", "discovery"}) {
		assert(run(false,false,stage) == DFU_DISCONNECTED_EARLY); assert(writes == 0);
	}
#if defined(CONFIG_NORDIC_SECURE_DFU)
	for (const char *stage : {"create", "wait", "settle", "before-attach", "discovery"}) {
		assert(run(true,true,stage) == DFU_DISCONNECTED_EARLY); assert(writes == 0);
	}
#endif
	// The same physical adapter works again on a fresh run, not permanently
	// aborted by a previous Stop, while attach cannot clear run-wide Stop.
	assert(run(false,false) == DFU_DISCONNECTED_EARLY); assert(writes == 1);
	stopped = true; stop_at.clear();
	internal::GattLink link;
	assert(link.attach(&peer,test_cancelled) == -ECANCELED);
	stopped = false; peer.state = BT_CONN_STATE_CONNECTED;
	assert(link.attach(&peer,test_cancelled) == 0);
	stop_at = "wait";
	assert(link.wait_response(nullptr,nullptr,30000) == -ECANCELED);
	link.detach(); stop_at.clear(); stopped = false;
	dfu_target target{}; app_config cfg{};
	for (int rc : {-ETIMEDOUT, -EIO, 0}) {
		for (bool dfu : {false,true}) {
			scan_result = rc; scan_dfu = dfu;
			for (bool fe59 : {false,true}) {
				scan_secure = fe59;
				assert(dfu_transport_ble.verify(&target,&cfg,test_cancelled) ==
					(rc == 0 && dfu ? DFU_TARGET_REJECTED : DFU_OK));
			}
		}
	}
	scan_result = -ECANCELED;
	assert(dfu_transport_ble.verify(&target,&cfg,test_cancelled) == DFU_OK);
	puts("Real adapter/GATT: MTU timeout/rejection, wrong packages, setup Stop races, fresh run and boot verification passed");
}
