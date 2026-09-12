/* Real runner + BLE transport, deterministic radio/filesystem boundaries.
 * The competing peer is always available to broad scans after attempt one. */
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

enum scenario { AUTO_RETRY, BUTTONLESS_RETRY, PIN_NO_DRIFT, TARGET_GONE, WIFI_RETRY, EXACT_RESTART, TRANSPORT_STAYS,
  RESTART_BUDGET, BUTTONLESS_BUDGET, CONFIG_ON_RESTART, THREAD_REUSE, ONE_BUTTONLESS, MAX_RESTART_BUDGET,
  LOWER_RESTART_BUDGET };
static enum scenario scenario;
static struct app_config config;
static unsigned broad_scans, pinned_scans, exact_scans, runs, maps, zip_opens;
static unsigned list_reads, other_finds, wifi_finds;
static unsigned config_loads;
unsigned fake_thread_joins;
static enum dfu_status_state state;
static enum dfu_status_result finished;
static const bt_addr_le_t app = {1, {{0x10, 0, 0, 0, 0, 0xC0}}};
static const bt_addr_le_t boot = {1, {{0x11, 0, 0, 0, 0, 0xC0}}};
static const bt_addr_le_t other = {1, {{0x80, 0, 0, 0, 0, 0xC0}}};
uint32_t fake_now;

void fake_event(const char *name) { (void)name; }
bool app_config_load(void)
{
  config_loads++;
  if (scenario == CONFIG_ON_RESTART && config_loads > 1) config.prn = 7;
  if (scenario == LOWER_RESTART_BUDGET && config_loads > 2) config.retries = 1;
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
void dfu_status_set_state(enum dfu_status_state s) { state = s; }
void dfu_status_finish(enum dfu_status_result result) { finished = result; }
void dfu_status_reset(void) { finished = DFU_STATUS_RESULT_NONE; }
enum dfu_status_result dfu_status_from_dfu_result(int result)
{ return result == DFU_TIMEOUT ? DFU_STATUS_RESULT_TIMEOUT : DFU_STATUS_RESULT_DISCONNECTED; }

int fs_stat(const char *path, struct fs_dirent *out)
{ (void)path; out->size = 1024; return 0; }
int firmware_zip_open(const char *path, struct firmware_bundle *bundle, char *err, size_t n)
{
  (void)err; (void)n;
  assert(!strcmp(path, "/lfs1/rak.zip"));
  memset(bundle, 0, sizeof(*bundle));
  bundle->type = FW_TYPE_APPLICATION;
  bundle->bin.size = 1024;
  zip_opens++;
  return 0;
}
void firmware_zip_close(void) {}
int firmware_map_resolve(const char *peer, const char *mapping, const char *dir,
  char *path, size_t n, char *err, size_t err_n)
{
  (void)mapping; (void)dir; (void)err; (void)err_n;
  assert(!strcmp(peer, "RAK_OTA"));
  maps++;
  snprintf(path, n, "/lfs1/rak.zip");
  return 0;
}

static void fill(struct ble_scanner_target *out, const bt_addr_le_t *addr)
{
  memset(out, 0, sizeof(*out));
  out->addr = *addr;
  snprintf(out->name, sizeof(out->name), "%s", bt_addr_le_eq(addr, &app) ? "RAK_OTA" :
    bt_addr_le_eq(addr, &boot) ? "RAK_DFU" : "XIAO_DFU");
  out->rssi = -40;
  out->dfu_uuid = true;
}
int ble_scanner_find_first(struct ble_scanner_target *out, uint32_t timeout,
  const char *filter, int8_t rssi, const bt_addr_le_t *preferred)
{
  (void)timeout; (void)filter; (void)rssi;
  assert(preferred == NULL);
  fill(out, broad_scans++ == 0 ? &app : &other);
  return 0;
}
int ble_scanner_find_pinned(struct ble_scanner_target *out, uint32_t timeout,
  const bt_addr_le_t *addr)
{
  (void)timeout;
  /* Explicit app pin already matching +1 must never be rebased to +1. */
  assert(bt_addr_le_eq(addr, &app));
  pinned_scans++;
  fill(out, &boot);
  return 0;
}
int ble_scanner_seen_at(const bt_addr_le_t *addr, uint32_t timeout,
  struct ble_scanner_target *out)
{
  assert(timeout != 0);
  const bt_addr_le_t *expected = scenario == BUTTONLESS_RETRY || scenario == PIN_NO_DRIFT ||
    scenario == BUTTONLESS_BUDGET || scenario == ONE_BUTTONLESS ? &boot : &app;
  assert(bt_addr_le_eq(addr, expected));
  exact_scans++;
  if (scenario == TARGET_GONE && state != DFU_STATUS_VERIFYING) {
    fake_now += timeout;
    return -ETIMEDOUT; /* Only an unrelated matching advertiser remains. */
  }
  fill(out, expected);
  return 0;
}
void ble_scanner_cancel(void) {}
void dfu_client_abort(void) {}
enum dfu_result dfu_client_run(const struct ble_scanner_target *target,
  const struct firmware_bundle *bundle, const struct app_config *cfg)
{
  assert(bundle->bin.size == 1024);
  const bt_addr_le_t *expected = scenario == PIN_NO_DRIFT ||
    ((scenario == BUTTONLESS_RETRY || scenario == BUTTONLESS_BUDGET || scenario == ONE_BUTTONLESS) && runs > 0) ? &boot : &app;
  assert(bt_addr_le_eq(&target->addr, expected));
  runs++;
  assert(runs <= 300); /* Bound the red test itself if the runner loops forever. */
  if (scenario == RESTART_BUDGET || scenario == MAX_RESTART_BUDGET || scenario == LOWER_RESTART_BUDGET)
    return DFU_RESTART_REQUIRED;
  if (scenario == BUTTONLESS_BUDGET) return DFU_BUTTONLESS_TRIGGERED;
  if (scenario == ONE_BUTTONLESS) return runs == 1 ? DFU_BUTTONLESS_TRIGGERED : DFU_OK;
  if (scenario == CONFIG_ON_RESTART) {
    if (runs == 1) return DFU_RESTART_REQUIRED;
    assert(cfg->prn == 7);
    return DFU_OK;
  }
  if (scenario == BUTTONLESS_RETRY) return runs == 1 ? DFU_BUTTONLESS_TRIGGERED : runs == 2 ? DFU_TIMEOUT : DFU_OK;
  if (scenario == PIN_NO_DRIFT) return runs <= 2 ? DFU_BUTTONLESS_TRIGGERED : DFU_OK;
  if (scenario == EXACT_RESTART) return runs == 1 ? DFU_RESTART_REQUIRED : DFU_OK;
  return runs == 1 ? DFU_TIMEOUT : DFU_OK;
}
int bt_conn_get_info(struct bt_conn *c, struct bt_conn_info *info) { (void)c; (void)info; return -ENOTCONN; }
int bt_conn_disconnect(struct bt_conn *c, uint8_t reason) { (void)c; (void)reason; return -ENOTCONN; }
void bt_conn_foreach(int type, void (*fn)(struct bt_conn *, void *), void *arg)
{ (void)type; (void)fn; (void)arg; }

static int other_find(struct dfu_target *out, const struct app_config *cfg, uint32_t timeout, const char *pin)
{ (void)out; (void)cfg; (void)timeout; (void)pin; other_finds++; assert(false); return -EINVAL; }
static const struct dfu_transport other_transport = {
  .name = "competing-zip-transport", .find = other_find, .payload_kind = DFU_PAYLOAD_ZIP,
};
static int wifi_find(struct dfu_target *out, const struct app_config *cfg, uint32_t timeout, const char *pin)
{ (void)cfg; (void)timeout; (void)pin; wifi_finds++; snprintf(out->name, sizeof(out->name), "wifi-A"); return 0; }
static enum dfu_result wifi_run(const struct dfu_target *t, const struct dfu_payload *p, const struct app_config *cfg)
{ (void)t; (void)p; (void)cfg; runs++; return DFU_TIMEOUT; }
static void wifi_release(struct dfu_target *t) { (void)t; }
static const struct dfu_transport wifi_transport = {
  .name = "wifi-without-identity-reacquisition", .find = wifi_find, .run = wifi_run,
  .payload_kind = DFU_PAYLOAD_RAW, .release = wifi_release,
};
const struct dfu_transport *const *dfu_transport_list(size_t *count)
{
  static const struct dfu_transport *normal[] = {&dfu_transport_ble, &wifi_transport};
  static const struct dfu_transport *changed[] = {&other_transport, &dfu_transport_ble, &wifi_transport};
  /* A registry/availability change must not choose a new transport mid-run. */
  if (list_reads++ == 0 || scenario != TRANSPORT_STAYS) { *count = ARRAY_SIZE(normal); return normal; }
  *count = ARRAY_SIZE(changed); return changed;
}

static void test(enum scenario which, const char *path, const char *pin)
{
  scenario = which;
  broad_scans = pinned_scans = exact_scans = runs = maps = zip_opens = 0;
  list_reads = other_finds = wifi_finds = fake_now = config_loads = 0;
  finished = DFU_STATUS_RESULT_NONE;
  memset(&config, 0, sizeof(config));
  config.retries = which == RESTART_BUDGET || which == BUTTONLESS_BUDGET || which == ONE_BUTTONLESS ? 1 :
    which == MAX_RESTART_BUDGET ? 255 : 3;
  config.scan_timeout = which == TARGET_GONE ? 1 : 0;
  snprintf(config.ble_firmware_mapping, sizeof(config.ble_firmware_mapping), "RAK:rak.zip|XIAO:xiao.zip");
  assert(dfu_runner_start(path, pin, NULL) == 0);
  assert(!dfu_runner_busy());
  assert(other_finds == 0 && list_reads == 1);
  if (which == RESTART_BUDGET || which == BUTTONLESS_BUDGET || which == MAX_RESTART_BUDGET ||
      which == LOWER_RESTART_BUDGET) {
    assert(finished == DFU_STATUS_RESULT_RETRIES_EXHAUSTED);
    assert(runs == (which == MAX_RESTART_BUDGET ? 256u : 2u));
    assert(config_loads == (which == LOWER_RESTART_BUDGET ? runs + 1 : runs));
    return;
  }
  if (which == WIFI_RETRY) {
    assert(runs == 1 && wifi_finds == 1 && finished == DFU_STATUS_RESULT_TIMEOUT);
  } else {
    assert(zip_opens == 1);
    assert(maps == (path == NULL ? 1u : 0u));
    if (which == TARGET_GONE) assert(runs == 1 && finished == DFU_STATUS_RESULT_NO_TARGET);
    else assert(finished == DFU_STATUS_RESULT_BOOT_UNVERIFIED);
    if (which == AUTO_RETRY || which == TRANSPORT_STAYS) assert(runs == 2 && broad_scans == 1 && pinned_scans == 0);
    if (which == EXACT_RESTART) assert(runs == 2 && broad_scans == 1 && pinned_scans == 0);
    if (which == BUTTONLESS_RETRY) assert(runs == 3 && broad_scans == 1 && pinned_scans == 1);
    if (which == PIN_NO_DRIFT) assert(runs == 3 && broad_scans == 0 && pinned_scans == 2);
    if (which == ONE_BUTTONLESS) assert(runs == 2 && pinned_scans == 1 && config.retries == 1);
    if (which == CONFIG_ON_RESTART) assert(runs == 2 && config_loads == 2);
    assert(exact_scans > 0);
  }
}
static void run_case(enum scenario which)
{
  if (which == THREAD_REUSE) {
    unsigned before = fake_thread_joins;
    test(AUTO_RETRY, NULL, NULL);
    test(AUTO_RETRY, NULL, NULL);
    assert(fake_thread_joins > before);
    return;
  }
  test(which, which == PIN_NO_DRIFT ? "/lfs1/rak.zip" : which == WIFI_RETRY ? "/lfs1/wifi.bin" : NULL,
    which == PIN_NO_DRIFT ? "C0:00:00:00:00:10 (random)" : NULL);
}
int main(int argc, char **argv)
{
  if (argc > 1) {
    int which = atoi(argv[1]);
    assert(which >= AUTO_RETRY && which <= LOWER_RESTART_BUDGET);
    run_case((enum scenario)which);
  } else {
    for (int which = AUTO_RETRY; which <= LOWER_RESTART_BUDGET; which++) run_case((enum scenario)which);
  }
  puts("real-runner identity and lifecycle checks passed");
  return 0;
}
