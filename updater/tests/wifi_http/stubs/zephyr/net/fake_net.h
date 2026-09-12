#pragma once
#include <stddef.h>
#include <stdint.h>
struct net_if { int unused; };
struct net_mgmt_event_callback { const void *info; };
struct net_if *net_if_get_first_wifi(void);
int net_mgmt(uint32_t request, struct net_if *iface, void *data, size_t size);
static inline void net_mgmt_init_event_callback(struct net_mgmt_event_callback *cb,
  void (*fn)(struct net_mgmt_event_callback *, uint64_t, struct net_if *), uint64_t mask)
{ (void)cb; (void)fn; (void)mask; }
static inline void net_mgmt_add_event_callback(struct net_mgmt_event_callback *cb) { (void)cb; }
#define NET_EVENT_WIFI_CONNECT_RESULT 1
#define NET_EVENT_WIFI_DISCONNECT_RESULT 2
#define NET_EVENT_WIFI_SCAN_RESULT 4
#define NET_EVENT_WIFI_SCAN_DONE 8
#define NET_EVENT_IPV4_ADDR_ADD 16
#define NET_REQUEST_WIFI_CONNECT 1
#define NET_REQUEST_WIFI_DISCONNECT 2
#define NET_REQUEST_WIFI_SCAN 3
#define WIFI_SECURITY_TYPE_NONE 0
#define WIFI_CHANNEL_ANY 0
#define WIFI_FREQ_BAND_2_4_GHZ 0
#define WIFI_MFP_OPTIONAL 0
struct wifi_status { int status; };
struct wifi_scan_result { uint8_t ssid[33]; size_t ssid_length; };
struct wifi_connect_req_params {
  const uint8_t *ssid; size_t ssid_length; int security, channel, band, mfp;
};
#define AF_INET 2
#define SOCK_STREAM 1
#define IPPROTO_TCP 6
#define ZSOCK_SOL_SOCKET 1
#define ZSOCK_SO_SNDTIMEO 2
#define ZSOCK_SO_RCVTIMEO 3
#define ZSOCK_POLLOUT 4
#define ZSOCK_POLLIN 1
struct in_addr { uint32_t s_addr; };
struct sockaddr { uint16_t sa_family; };
struct sockaddr_in { uint16_t sin_family, sin_port; struct in_addr sin_addr; };
struct zsock_timeval { long tv_sec, tv_usec; };
struct zsock_pollfd { int fd; short events, revents; };
static inline uint16_t htons(uint16_t n) { return (uint16_t)((n >> 8) | (n << 8)); }
static inline int zsock_inet_pton(int af, const char *src, void *dst)
{ (void)af; (void)src; (void)dst; return 1; }
int zsock_socket(int af, int type, int proto);
int zsock_setsockopt(int fd, int level, int option, const void *value, size_t size);
int zsock_connect(int fd, const struct sockaddr *addr, size_t size);
int zsock_close(int fd);
int zsock_poll(struct zsock_pollfd *fds, size_t count, int timeout);
int zsock_send(int fd, const void *data, size_t size, int flags);
int zsock_recv(int fd, void *data, size_t size, int flags);
