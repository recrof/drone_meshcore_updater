/* SPDX-License-Identifier: BSD-3-Clause
 * Real app adapter, both clients, GattLink and BLE verifier. Only the OS,
 * filesystem, Bluetooth and app-service boundaries are test doubles. */
#include "dfu_client.h"
#include "dfu_transport.h"
#include "dfu_status.h"
#include "dfu_runner.h"
#include "app.h"
#include "gatt_link.hpp"
#include <cassert>
#include <vector>
#include <string>
using namespace nordic::dfu;
uint32_t fake_now;
static bool stopped, secure_peer, pending_connect;
static unsigned writes, creates, discoveries;
static std::string stop_at;
static bt_conn peer{};
static bt_addr_le_t address{};
static std::vector<bt_conn_cb *> callbacks;
static std::vector<uint8_t> init;
static int scan_result;
static bool scan_dfu;
static const bt_uuid_16 secure_service = {{BT_UUID_TYPE_16}, 0xfe59};
static const bt_uuid_128 legacy_service = {{BT_UUID_TYPE_128},
	{0x23,0xd1,0xbc,0xea,0x5f,0x78,0x23,0x15,0xde,0xef,0x12,0x12,0x30,0x15,0,0}};
static const bt_uuid_128 secure_control = {{BT_UUID_TYPE_128},
	{0x50,0xea,0xda,0x30,0x88,0x83,0xb8,0x9f,0x60,0x4f,0x15,0xf3,1,0,0xc9,0x8e}};

extern "C" {
bool dfu_runner_cancelled() { return stopped; }
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
int bt_gatt_subscribe(bt_conn *c, bt_gatt_subscribe_params *p) { p->subscribe(c,0,p); return 0; }
int bt_gatt_unsubscribe(bt_conn *, bt_gatt_subscribe_params *) { return 0; }
int bt_gatt_write(bt_conn *c, bt_gatt_write_params *p) {
	++writes;
	// Positive controls stop at the first DFU command. No receiver model
	// here: the separate SecureTransfer suite checks object semantics.
	stopped = true; dfu_client_abort(); p->func(c,0,p); return 0;
}
int bt_gatt_read(bt_conn *c, bt_gatt_read_params *p) {
	const uint8_t v[] = {5,0}; p->func(c,0,p,v,2); p->func(c,0,p,nullptr,0); return 0;
}
int bt_gatt_exchange_mtu(bt_conn *c, bt_gatt_exchange_params *p) { p->func(c,0,p); return 0; }
uint16_t bt_gatt_get_mtu(bt_conn *) { return 247; }
int bt_gatt_write_without_response_cb(bt_conn *c, uint16_t, const void *, uint16_t,
				    bool, void (*cb)(bt_conn *, void *), void *u) {
	++writes; cb(c,u); return 0;
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
int ble_scanner_seen_at(const bt_addr_le_t *, uint32_t, ble_scanner_target *out) {
	*out = {}; out->dfu_uuid = scan_dfu; return scan_result;
}
int ble_scanner_find_first(ble_scanner_target *, uint32_t, const char *, int8_t, const bt_addr_le_t *) { return -ETIMEDOUT; }
int ble_scanner_find_pinned(ble_scanner_target *, uint32_t, const bt_addr_le_t *) { return -ETIMEDOUT; }
void ble_scanner_cancel() {}
}

static dfu_result run(bool secure_package, bool secure_target, const char *stage = "")
{
	stopped = false; stop_at = stage; writes = creates = discoveries = 0; secure_peer = secure_target;
	// Unsigned Secure Packet(Command(INIT, InitCommand(app_size=1024))).
	init = secure_package ? std::vector<uint8_t>{10,7,8,1,18,3,56,128,8} : std::vector<uint8_t>(12,0);
	firmware_bundle b{}; b.type = FW_TYPE_APPLICATION; b.bin.size = 1024;
	b.dat.size = uint32_t(init.size()); b.dat.data_offset = 1;
	ble_scanner_target target{}; app_config cfg{};
	if (stop_at == "before-run") stopped = true;
	return dfu_client_run(&target,&b,&cfg);
}
int main()
{
	assert(run(true,false) == DFU_BAD_PACKAGE); assert(writes == 0);
#if defined(CONFIG_NORDIC_SECURE_DFU)
	assert(run(false,true) == DFU_BAD_PACKAGE); assert(writes == 0);
	assert(run(true,true) == DFU_CANCELLED); assert(writes == 1); // positive control
#endif
	assert(run(false,false) == DFU_CANCELLED); assert(writes == 1);
	for (const char *stage : {"before-run", "create", "wait", "settle", "before-attach", "info", "discovery"}) {
		assert(run(false,false,stage) == DFU_CANCELLED); assert(writes == 0);
	}
#if defined(CONFIG_NORDIC_SECURE_DFU)
	assert(run(false,false,"handoff") == DFU_CANCELLED); assert(writes == 0);
	for (const char *stage : {"create", "wait", "settle", "before-attach", "discovery"}) {
		assert(run(true,true,stage) == DFU_CANCELLED); assert(writes == 0);
	}
#endif
	// The same physical adapter works again on a fresh run, not permanently
	// aborted by a previous Stop, while attach cannot clear run-wide Stop.
	assert(run(false,false) == DFU_CANCELLED); assert(writes == 1);
	stopped = true; stop_at.clear();
	internal::GattLink link;
	assert(link.attach(&peer,dfu_runner_cancelled) == -ECANCELED);
	stopped = false; peer.state = BT_CONN_STATE_CONNECTED;
	assert(link.attach(&peer,dfu_runner_cancelled) == 0);
	stop_at = "wait";
	assert(link.wait_response(nullptr,nullptr,30000) == -ECANCELED);
	link.detach(); stop_at.clear(); stopped = false;
	dfu_target target{}; app_config cfg{};
	for (int rc : {-ETIMEDOUT, -EIO, 0}) {
		for (bool dfu : {false,true}) {
			scan_result = rc; scan_dfu = dfu;
			assert(dfu_transport_ble.verify(&target,&cfg) == DFU_BOOT_UNVERIFIED);
		}
	}
	scan_result = -ECANCELED;
	assert(dfu_transport_ble.verify(&target,&cfg) == DFU_CANCELLED);
	puts("Real adapter/GATT: wrong packages, setup Stop races, fresh run and boot verification passed");
}
