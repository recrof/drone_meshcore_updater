/* Compile the real runner with a resource-owning transport boundary. */
#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <zephyr/kernel.h>
#include <zephyr/fs/fs.h>
#include "dfu_runner.h"
#include "dfu_transport.h"
#include "dfu_status.h"
#include "app.h"

enum scenario {
  MAP_FAIL, OPEN_FAIL, CANCEL_FIND, SUCCESS, KIND_MISMATCH,
  RUN_FAIL, CANCEL_RUN, FIND_FAIL, PREOPEN_FAIL, CANCEL_REFIND,
};
uint32_t fake_now;
unsigned fake_thread_joins;
static enum scenario scenario;
static unsigned finds, releases, runs, zip_closes;
static bool associated;
static struct app_config config;
static enum dfu_status_result finished;

void fake_event(const char *name) { (void)name; }
bool app_config_load(void) { return true; }
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
enum dfu_status_result dfu_status_from_dfu_result(int result)
{ (void)result; return DFU_STATUS_RESULT_TIMEOUT; }
int fs_stat(const char *path, struct fs_dirent *out)
{ (void)path; out->size = 1024; return scenario == OPEN_FAIL || scenario == PREOPEN_FAIL ? -ENOENT : 0; }
int firmware_zip_open(const char *path, struct firmware_bundle *bundle, char *err, size_t n)
{
  (void)path; (void)err; (void)n;
  assert(scenario == KIND_MISMATCH);
  memset(bundle, 0, sizeof(*bundle));
  bundle->bin.size = 1024;
  return 0;
}
void firmware_zip_close(void) { zip_closes++; }
int firmware_map_resolve(const char *peer, const char *mapping, const char *dir,
  char *path, size_t n, char *err, size_t err_n)
{
  (void)peer; (void)mapping; (void)dir; (void)err; (void)err_n;
  if (scenario == MAP_FAIL) return -ENOENT;
  snprintf(path, n, "%s", scenario == KIND_MISMATCH ? "/lfs1/rak.zip" : "/lfs1/wifi.bin");
  return 0;
}

static int resource_find(struct dfu_target *out, const struct app_config *cfg,
  uint32_t timeout, const char *pin)
{
  (void)cfg; (void)timeout; (void)pin;
  assert(!associated);
  finds++;
  if (scenario == FIND_FAIL) return -ETIMEDOUT;
  associated = true;
  snprintf(out->name, sizeof(out->name), "wifi-A");
  /* An acquisition-specific token detects releasing a stale target. */
  out->retry_pin[0] = (char)finds;
  if (scenario == CANCEL_FIND || (scenario == CANCEL_REFIND && finds == 2))
    assert(dfu_runner_stop() == 0);
  return 0;
}
static int resource_find_same(struct dfu_target *out, const struct dfu_target *previous,
  const struct app_config *cfg, uint32_t timeout, bool transition)
{
  assert(scenario == CANCEL_REFIND && !transition);
  assert(previous->retry_pin[0] == 1);
  return resource_find(out, cfg, timeout, NULL);
}
static enum dfu_result resource_run(const struct dfu_target *t,
  const struct dfu_payload *p, const struct app_config *cfg)
{
  (void)p; (void)cfg;
  assert(associated && t->retry_pin[0] == (char)finds);
  runs++;
  if (scenario == CANCEL_REFIND) return DFU_RESTART_REQUIRED;
  if (scenario == RUN_FAIL) return DFU_TIMEOUT;
  if (scenario == CANCEL_RUN) {
    assert(dfu_runner_stop() == 0);
    return DFU_CANCELLED;
  }
  return DFU_OK;
}
static void resource_release(struct dfu_target *t)
{
  assert(associated && t->retry_pin[0] == (char)finds);
  releases++;
  associated = false;
}
static const struct dfu_transport resource_transport = {
  .name = "resource-owning", .find = resource_find, .find_same = resource_find_same,
  .run = resource_run, .payload_kind = DFU_PAYLOAD_RAW, .release = resource_release,
};
const struct dfu_transport *const *dfu_transport_list(size_t *count)
{
  static const struct dfu_transport *all[] = {&resource_transport};
  *count = 1; return all;
}
int main(int argc, char **argv)
{
  assert(argc == 2);
  scenario = (enum scenario)atoi(argv[1]);
  assert(scenario >= MAP_FAIL && scenario <= CANCEL_REFIND);
  config.retries = 1;
  snprintf(config.ble_firmware_mapping, sizeof(config.ble_firmware_mapping), "wifi:*");
  assert(dfu_runner_start(scenario == PREOPEN_FAIL ? "/lfs1/wifi.bin" : NULL, NULL, NULL) == 0);
  assert(!dfu_runner_busy());
  assert(!associated);
  assert(finds == (scenario == PREOPEN_FAIL ? 0u : scenario == CANCEL_REFIND ? 2u : 1u));
  assert(releases == (scenario == FIND_FAIL || scenario == PREOPEN_FAIL ? 0u : finds));
  assert(runs == (scenario == SUCCESS || scenario == RUN_FAIL || scenario == CANCEL_RUN ||
    scenario == CANCEL_REFIND ? 1u : 0u));
  assert(zip_closes == (scenario == KIND_MISMATCH ? 1u : 0u));
  if (scenario == MAP_FAIL || scenario == OPEN_FAIL || scenario == KIND_MISMATCH || scenario == PREOPEN_FAIL)
    assert(finished == DFU_STATUS_RESULT_BAD_BUNDLE);
  if (scenario == CANCEL_FIND || scenario == CANCEL_RUN || scenario == CANCEL_REFIND)
    assert(finished == DFU_STATUS_RESULT_NONE);
  if (scenario == SUCCESS) assert(finished == DFU_STATUS_RESULT_OK);
  if (scenario == RUN_FAIL) assert(finished == DFU_STATUS_RESULT_TIMEOUT);
  if (scenario == FIND_FAIL) assert(finished == DFU_STATUS_RESULT_NO_TARGET);
  puts("real-runner resource ownership checks passed");
  return 0;
}
