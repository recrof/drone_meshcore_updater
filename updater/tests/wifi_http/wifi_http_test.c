/* The real WiFi transport, including its HTTP callbacks and socket loops. */
#include <assert.h>
#include <stdlib.h>
#include WIFI_TRANSPORT_SOURCE

enum scenario {
  IDENTITY_SPLIT, IDENTITY_STATUS, IDENTITY_SPAN, IDENTITY_LONG, IDENTITY_OVERSIZE,
  IDENTITY_MISSING, STATUS_SPLIT, REPLY_TIMEOUT, REPLY_EOF, REPLY_ERROR,
  REPLY_INVALID, REPLY_LONG, REPLY_REJECT, UPLOAD_SHORT, SUCCESS,
  FIND_CANCEL_PENDING, FIND_CANCEL_DHCP, FIND_ASSOC_TIMEOUT, FIND_IDENTITY_FAIL,
  FIND_RELEASE, FIND_CANCEL_BEFORE,
};
static enum scenario scenario;
uint32_t fake_now;
static struct app_config config;
static struct net_if iface;
static uint8_t firmware[64];
static size_t firmware_size, response_at, split_at;
static unsigned sockets_open, files_open;
static unsigned connect_calls, disconnect_calls;
static bool driver_owns_link, runner_cancel;
static char response[512], identity[1024];

void fake_event(const char *event)
{
  if (scenario == FIND_CANCEL_DHCP && !strcmp(event, "wait") && s.connected && !s.assoc.count)
    wifi_abort();
}
bool dfu_runner_cancelled(void) { return runner_cancel; }
const struct app_config *app_config_current(void) { return &config; }
void dfu_status_set_state(enum dfu_status_state state) { (void)state; }
void dfu_status_progress(uint8_t percent, uint32_t sent, uint32_t total)
{ assert(percent <= 100 && sent <= total); }
struct net_if *net_if_get_first_wifi(void) { return &iface; }
int net_mgmt(uint32_t request, struct net_if *n, void *data, size_t size)
{
  (void)n; (void)data; (void)size;
  if (request == NET_REQUEST_WIFI_SCAN) {
    s.ap_seen = true;
    k_sem_give(&s.scan_done);
  } else if (request == NET_REQUEST_WIFI_CONNECT) {
    assert(!driver_owns_link);
    driver_owns_link = true;
    connect_calls++;
    if (scenario == FIND_CANCEL_PENDING) wifi_abort();
    else if (scenario != FIND_ASSOC_TIMEOUT) {
      s.connected = true;
      k_sem_give(&s.assoc);
      if (scenario != FIND_CANCEL_DHCP) k_sem_give(&s.got_ip);
    }
  } else if (request == NET_REQUEST_WIFI_DISCONNECT) {
    driver_owns_link = false;
    s.connected = false;
    disconnect_calls++;
  }
  return 0;
}
int zsock_socket(int af, int type, int proto)
{ (void)af; (void)type; (void)proto; sockets_open++; return 1; }
int zsock_setsockopt(int fd, int level, int option, const void *value, size_t size)
{ (void)fd; (void)level; (void)option; (void)value; (void)size; return 0; }
int zsock_connect(int fd, const struct sockaddr *addr, size_t size)
{ (void)fd; (void)addr; (void)size; return 0; }
int zsock_close(int fd) { (void)fd; assert(sockets_open); sockets_open--; return 0; }
int zsock_poll(struct zsock_pollfd *fds, size_t count, int timeout)
{
  assert(count == 1);
  if (fds->events == ZSOCK_POLLIN && scenario == REPLY_TIMEOUT) {
    fake_now += (uint32_t)timeout;
    return 0;
  }
  fake_now++;
  return 1;
}
int zsock_send(int fd, const void *data, size_t size, int flags)
{ (void)fd; (void)data; (void)flags; return (int)size; }
int zsock_recv(int fd, void *data, size_t size, int flags)
{
  (void)fd; (void)flags;
  if (scenario == REPLY_EOF) return 0;
  if (scenario == REPLY_ERROR) { errno = ECONNRESET; return -1; }
  size_t n = MIN(size, strlen(response) - response_at);
  if (scenario == STATUS_SPLIT && response_at == 0) n = MIN(n, split_at);
  memcpy(data, response + response_at, n);
  response_at += n;
  return (int)n;
}
int http_client_req(int fd, struct http_request *req, int32_t timeout, void *user)
{
  (void)fd; (void)timeout;
  size_t len = strlen(identity), at = 0;
  do {
    size_t n = len - at;
    if (scenario == IDENTITY_SPLIT && at == 0) n = split_at;
    n = MIN(n, (size_t)256);
    uint8_t fragment[300];
    memset(fragment, 'x', sizeof(fragment));
    memcpy(fragment, identity + at, n);
    /* Poison bytes are outside the fragment and must never be parsed. */
    memcpy(fragment + n, "{\"id\":\"WRONG\"}", 15);
    fragment[n + 15] = 0;
    at += n;
    struct http_response rsp = {
      .body_frag_start = fragment, .body_frag_len = n,
      .http_status_code = scenario == IDENTITY_STATUS || scenario == FIND_IDENTITY_FAIL ? 404 : 200,
    };
    int rc = req->response(&rsp, at == len ? HTTP_DATA_FINAL : HTTP_DATA_MORE, user);
    if (rc < 0) return rc;
  } while (at < len);
  return 1;
}
void fs_file_t_init(struct fs_file_t *file) { memset(file, 0, sizeof(*file)); }
int fs_open(struct fs_file_t *file, const char *path, int flags)
{ (void)path; (void)flags; file->open = 1; files_open++; return 0; }
int fs_close(struct fs_file_t *file)
{ assert(file->open && files_open); file->open = 0; files_open--; return 0; }
ssize_t fs_read(struct fs_file_t *file, void *data, size_t size)
{
  assert(file->open);
  size_t n = MIN(size, firmware_size - file->position);
  memcpy(data, firmware + file->position, n);
  file->position += (uint32_t)n;
  return (ssize_t)n;
}

int main(int argc, char **argv)
{
  assert(argc == 2);
  scenario = (enum scenario)atoi(argv[1]);
  assert(scenario >= IDENTITY_SPLIT && scenario <= FIND_CANCEL_BEFORE);
  assert(test_init() == 0);
  snprintf(identity, sizeof(identity), "{\"id\":\"My repeater (Heltec V3)\",\"hardware\":\"ESP32\"}");
  snprintf(response, sizeof(response), "HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nOK");
  firmware_size = scenario == UPLOAD_SHORT ? 32 : sizeof(firmware);
  if (scenario <= IDENTITY_MISSING) {
    if (scenario == IDENTITY_SPAN) snprintf(identity, sizeof(identity), "{}");
    if (scenario == IDENTITY_LONG) {
      memset(identity, 'a', 80); memcpy(identity, "{\"id\":\"", 7);
      memcpy(identity + 80, "\"}", 3);
    }
    if (scenario == IDENTITY_OVERSIZE) {
      memset(identity, ' ', 600); memcpy(identity + 600, "{\"id\":\"oversize\"}", 18);
      identity[618] = 0;
    }
    if (scenario == IDENTITY_MISSING) snprintf(identity, sizeof(identity), "{\"hardware\":\"ESP32\"}");
    for (split_at = 1; split_at < strlen(identity); split_at++) {
      char name[DFU_TARGET_NAME_MAX] = {0};
      int rc = read_identity(name);
      if (scenario == IDENTITY_SPLIT) {
        assert(rc == 0 && !strcmp(name, "My repeater (Heltec V3)"));
      } else assert(rc < 0 && !name[0]);
      assert(sockets_open == 0);
      if (scenario != IDENTITY_SPLIT) break;
    }
  } else if (scenario >= FIND_CANCEL_PENDING) {
    struct dfu_target target;
    if (scenario == FIND_CANCEL_BEFORE) {
      runner_cancel = true;
      wifi_abort();
    }
    int rc = wifi_find(&target, &config, 500, NULL);
    if (scenario == FIND_RELEASE) {
      assert(rc == 0 && driver_owns_link && disconnect_calls == 0);
      wifi_release(&target);
    } else {
      assert(rc == (scenario == FIND_ASSOC_TIMEOUT || scenario == FIND_IDENTITY_FAIL ? -ETIMEDOUT : -ECANCELED));
    }
    assert(!driver_owns_link && !s.connected);
    assert(connect_calls == (scenario == FIND_CANCEL_BEFORE ? 0u : 1u));
    assert(disconnect_calls == connect_calls);
    assert(sockets_open == 0 && files_open == 0);
  } else {
    if (scenario == REPLY_INVALID) snprintf(response, sizeof(response), "garbage\r\n");
    if (scenario == REPLY_LONG) { memset(response, 'A', 400); memcpy(response + 400, "\r\n", 3); }
    if (scenario == REPLY_REJECT) snprintf(response, sizeof(response), "HTTP/1.1 500 FAIL\r\n\r\nFAIL");
    struct dfu_payload payload = {.kind = DFU_PAYLOAD_RAW, .path = "/lfs1/wifi.bin", .size = sizeof(firmware)};
    for (split_at = 1; split_at < 18; split_at++) {
      response_at = 0;
      enum dfu_result result = wifi_run(NULL, &payload, &config);
      if (scenario == STATUS_SPLIT || scenario == SUCCESS) assert(result == DFU_OK);
      else assert(result != DFU_OK && result != DFU_BOOT_UNVERIFIED);
      if (scenario == REPLY_TIMEOUT) assert(result == DFU_TIMEOUT);
      if (scenario == REPLY_EOF || scenario == REPLY_ERROR) assert(result == DFU_DISCONNECTED_EARLY);
      if (scenario == REPLY_REJECT) assert(result == DFU_REMOTE_ERROR);
      assert(sockets_open == 0 && files_open == 0);
      if (scenario != STATUS_SPLIT) break;
    }
  }
  puts("real WiFi HTTP boundary checks passed");
  return 0;
}
