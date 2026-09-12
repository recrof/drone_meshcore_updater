/* Production runner + BLE transport; policy remains the original Legacy policy. */
#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <zephyr/bluetooth/conn.h>
#include "dfu_runner.h"
#include "dfu_transport.h"
#include "dfu_status.h"
#include "firmware_map.h"
#include "app.h"

enum scenario { RETRY, BUTTONLESS, RESTART_BUDGET, MAX_RESTART_BUDGET,
  CONFIG_RELOAD, LOWER_BUDGET, THREAD_REUSE, WIFI_RETRY, VERIFY_REJECT,
  PIN_RETRY, SECURE_ACCEPTED, BAD_PACKAGE };
static enum scenario scenario;
static struct app_config config;
static unsigned runs, finds, maps, opens, config_loads, verifies;
static enum dfu_status_result finished;
unsigned fake_thread_joins;
uint32_t fake_now;
static const bt_addr_le_t app = {1, {{0x10, 0, 0, 0, 0, 0xC0}}};

void fake_event(const char *name) { (void)name; }
bool app_config_load(void) {
  config_loads++;
  if (scenario == CONFIG_RELOAD && config_loads > 1) config.prn = 7;
  if (scenario == LOWER_BUDGET && config_loads > 2) config.retries = 1;
  return true;
}
const struct app_config *app_config_current(void) { return &config; }
void ble_pairing_set_passkey(const char *p) { (void)p; }
int ble_pairing_verdict(void) { return DFU_STATUS_RESULT_NONE; }
void battery_log_state(const char *s) { (void)s; }
void survey_stop(void) {}
void led_set_state(enum led_state s) { (void)s; }
void dfu_status_begin(uint8_t retries) { (void)retries; }
void dfu_status_bundle(const char *p) { (void)p; }
void dfu_status_attempt(uint8_t n) { (void)n; }
void dfu_status_target(const char *s) { (void)s; }
void dfu_status_set_state(enum dfu_status_state s) { (void)s; }
void dfu_status_finish(enum dfu_status_result result) { finished = result; }
void dfu_status_reset(void) { finished = DFU_STATUS_RESULT_NONE; }
enum dfu_status_result dfu_status_from_dfu_result(int r)
{ (void)r; return DFU_STATUS_RESULT_TIMEOUT; }
int fs_stat(const char *path, struct fs_dirent *out)
{ (void)path; out->size = 1024; return 0; }
int firmware_zip_open(const char *path, struct firmware_bundle *bundle, char *err, size_t n)
{
  (void)err; (void)n; assert(!strcmp(path, "/lfs1/rak.zip"));
  memset(bundle, 0, sizeof(*bundle)); bundle->bin.size = 1024; opens++; return 0;
}
void firmware_zip_close(void) {}
int firmware_map_resolve(const char *peer, const char *mapping, const char *dir,
  char *path, size_t n, char *err, size_t err_n)
{
  (void)peer; (void)mapping; (void)dir; (void)err; (void)err_n;
  maps++; snprintf(path, n, "/lfs1/rak.zip"); return 0;
}
static int found(struct ble_scanner_target *out, bool (*cancelled)(void))
{
  assert(cancelled && !cancelled()); finds++;
  memset(out, 0, sizeof(*out)); out->addr = app;
  snprintf(out->name, sizeof(out->name), "RAK_OTA"); return 0;
}
int ble_scanner_find_first_cancellable(struct ble_scanner_target *out, uint32_t timeout,
  const char *filter, int8_t rssi, const bt_addr_le_t *preferred, bool (*cancelled)(void))
{ (void)timeout; (void)filter; (void)rssi; assert(!preferred); return found(out, cancelled); }
int ble_scanner_find_pinned_cancellable(struct ble_scanner_target *out, uint32_t timeout,
  const bt_addr_le_t *addr, bool (*cancelled)(void))
{ (void)timeout; assert(bt_addr_le_eq(addr, &app)); return found(out, cancelled); }
int ble_scanner_seen_at_cancellable(const bt_addr_le_t *addr, uint32_t timeout,
  struct ble_scanner_target *out, bool (*cancelled)(void))
{
  assert(timeout && cancelled && !cancelled());
  assert(bt_addr_le_eq(addr, &app)); verifies++;
  memset(out, 0, sizeof(*out));
  out->legacy_dfu_uuid = scenario == VERIFY_REJECT && verifies == 1;
  return 0;
}
void ble_scanner_cancel(void) {}
void dfu_client_abort(void) {}
enum dfu_result dfu_client_run(const struct ble_scanner_target *target,
  const struct firmware_bundle *bundle, const struct app_config *cfg, bool (*cancelled)(void))
{
  assert(bt_addr_le_eq(&target->addr, &app));
  assert(bundle->bin.size == 1024 && cancelled && !cancelled());
  runs++; assert(runs <= 300);
  if (scenario == SECURE_ACCEPTED) return DFU_BOOT_UNVERIFIED;
  if (scenario == BAD_PACKAGE) return DFU_BAD_PACKAGE;
  if (scenario == RESTART_BUDGET || scenario == MAX_RESTART_BUDGET || scenario == LOWER_BUDGET)
    return DFU_BUTTONLESS_TRIGGERED;
  if (scenario == BUTTONLESS || scenario == CONFIG_RELOAD) {
    if (runs == 1) return DFU_BUTTONLESS_TRIGGERED;
    if (scenario == CONFIG_RELOAD) assert(cfg->prn == 7);
    return DFU_OK;
  }
  if (scenario == VERIFY_REJECT) return DFU_OK;
  return runs == 1 ? DFU_TIMEOUT : DFU_OK;
}
int bt_conn_get_info(struct bt_conn *c, struct bt_conn_info *info) { (void)c; (void)info; return -ENOTCONN; }
int bt_conn_disconnect(struct bt_conn *c, uint8_t reason) { (void)c; (void)reason; return -ENOTCONN; }
void bt_conn_foreach(int type, void (*fn)(struct bt_conn *, void *), void *arg)
{ (void)type; (void)fn; (void)arg; }
static int wifi_find(struct dfu_target *out, const struct app_config *cfg,
  uint32_t timeout, const char *pin, bool (*cancelled)(void))
{
  (void)cfg; (void)timeout; (void)pin; assert(cancelled && !cancelled());
  finds++; snprintf(out->name, sizeof(out->name), "wifi-A"); return 0;
}
static enum dfu_result wifi_run(const struct dfu_target *t, const struct dfu_payload *p,
  const struct app_config *cfg, bool (*cancelled)(void))
{ (void)t; (void)p; (void)cfg; assert(cancelled && !cancelled()); runs++; return DFU_TIMEOUT; }
static void wifi_release(struct dfu_target *t) { (void)t; }
static const struct dfu_transport wifi = {
  .name = "wifi", .find = wifi_find, .run = wifi_run,
  .payload_kind = DFU_PAYLOAD_RAW, .release = wifi_release,
};
const struct dfu_transport *const *dfu_transport_list(size_t *count)
{
  static const struct dfu_transport *all[] = {&dfu_transport_ble, &wifi};
  *count = ARRAY_SIZE(all); return all;
}
static void test(enum scenario which)
{
  scenario = which; runs = finds = maps = opens = config_loads = verifies = fake_now = 0;
  finished = DFU_STATUS_RESULT_NONE; memset(&config, 0, sizeof(config));
  config.retries = which == MAX_RESTART_BUDGET ? 255 :
    which == RESTART_BUDGET || which == BUTTONLESS ? 1 : 3;
  snprintf(config.ble_firmware_mapping, sizeof(config.ble_firmware_mapping), "RAK:rak.zip");
  const char *path = which == WIFI_RETRY ? "/lfs1/wifi.bin" : NULL;
  const char *pin = which == PIN_RETRY ? "C0:00:00:00:00:10 (random)" : NULL;
  assert(dfu_runner_start(path, pin, NULL) == 0);
  assert(!dfu_runner_busy());
  if (which == RESTART_BUDGET || which == MAX_RESTART_BUDGET || which == LOWER_BUDGET) {
    assert(finished == DFU_STATUS_RESULT_RETRIES_EXHAUSTED);
    assert(runs == (which == MAX_RESTART_BUDGET ? 256u : 2u));
    assert(config_loads == (which == LOWER_BUDGET ? runs + 1 : runs));
  } else if (which == SECURE_ACCEPTED || which == BAD_PACKAGE) {
    assert(runs == 1 && finds == 1 && maps == 1 && opens == 1 && verifies == 0);
    assert(finished == (which == SECURE_ACCEPTED ? DFU_STATUS_RESULT_BOOT_UNVERIFIED : DFU_STATUS_RESULT_BAD_BUNDLE));
  } else if (which == WIFI_RETRY) {
    assert(runs == 3 && finds == 3 && finished == DFU_STATUS_RESULT_TIMEOUT);
  } else {
    assert(runs == 2 && finds == 2 && maps == 1 && opens == 1);
    assert(finished == DFU_STATUS_RESULT_OK);
    assert(verifies == (which == VERIFY_REJECT ? 2u : 1u));
    if (which == CONFIG_RELOAD) assert(config_loads == 2);
  }
}
int main(int argc, char **argv)
{
  assert(argc == 2);
  enum scenario which = (enum scenario)atoi(argv[1]);
  assert(which >= RETRY && which <= BAD_PACKAGE);
  if (which == THREAD_REUSE) {
    unsigned before = fake_thread_joins; test(RETRY); test(RETRY);
    assert(fake_thread_joins > before);
  } else test(which);
  puts("PASS: runner lifecycle and unchanged Legacy/Wi-Fi policies");
  return 0;
}
