/*
 * WiFi -> AsyncElegantOTA, for MeshCore's ESP32 repeaters.
 *
 * They do not do BLE DFU at all: the operator sends `start ota` over the
 * mesh, the repeater raises an open softAP called `MeshCore-OTA`, and the
 * update is a multipart POST. No nRF part has WiFi, so this file only ever
 * builds on the ESP32 board — which is the reason that board exists.
 *
 * The protocol was read out of MeshCore's own source; notes/transports.md has
 * the citations. The parts that fail hard, all of them silent when wrong:
 *
 *  1. **`MD5` is a mandatory form field and must precede the file part.**
 *     The handler checks for it at `if (!index)` — the moment the first file
 *     chunk arrives — and AsyncWebServer parses multipart sequentially, so an
 *     MD5 written after the file has not been seen yet. `400 MD5 parameter
 *     missing`, after the upload.
 *  2. **The file part's filename selects the partition.** `"filesystem"`
 *     means SPIFFS; anything else means the application slot. Get it wrong
 *     and the image lands on the filesystem.
 *  3. **Success looks like a failure.** The reply is `200 OK` with
 *     `Connection: close`, and then `ESP.restart()` about a second later. The
 *     AP vanishes. That is the shape of a completed update, not a dropped
 *     link, and reading it the other way would turn every success into a
 *     retry — which on this protocol means uploading the whole image again.
 *
 * ---- Why find() holds a connection --------------------------------------
 *
 * Every repeater's AP is `MeshCore-OTA`. The SSID identifies nothing, so
 * unlike BLE — where the advertised name arrives in the advertisement, before
 * any connection — the target's identity is only readable *after*
 * associating, from `GET /update/identity`. So find() associates, reads the
 * identity, and leaves the association up for run(); release() tears it down
 * on every path. The seam was built for this.
 */

#include "dfu_transport.h"
#include "md5.h"
#include "dfu_status.h"

#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>
#include <zephyr/fs/fs.h>
#include <zephyr/net/net_if.h>
#include <zephyr/net/net_mgmt.h>
#include <zephyr/net/wifi_mgmt.h>
#include <zephyr/net/socket.h>
#include <zephyr/net/http/client.h>
/* Espressif's own WiFi API, for the one thing Zephyr's net_mgmt does not
 * expose: transmit power. See apply_tx_power(). */
#include <esp_wifi.h>
#include <errno.h>
#include <stdio.h>
#include <string.h>

LOG_MODULE_REGISTER(wifi_ota, LOG_LEVEL_INF);

/* Fixed by MeshCore: `WiFi.softAP("MeshCore-OTA", NULL)` — open, no PSK, the
 * same on every repeater. */
/* Moved to elegantota.h once the scanner also needed it: the panel marks the
 * one network this updater could actually flash through, and a second copy of
 * the name here would be a drift pair with nothing checking it. */
#include "elegantota.h"
/* Arduino's softAP is always 192.168.4.1, and its DHCP server hands us
 * something on that /24. The address is a property of the AP, not a guess. */
#define OTA_HOST      "192.168.4.1"
#define OTA_PORT      80

/* One association *attempt*. Not the budget for finding a target: the runner
 * passes 0 for `scan_timeout=0` ("look until told to stop", the drone
 * default), and wifi_find() then repeats attempts of this length forever. It
 * is bounded only so a driver that never reports a result cannot wedge the
 * search, and so a stop can be noticed between tries. */
#define ASSOC_ATTEMPT_MS    5000
/* A scan is how "is the AP there yet?" is answered. Bounded well above what a
 * 2.4 GHz sweep costs, because this is a backstop against a scan that never
 * reports done, not the expected duration. */
#define SCAN_TIMEOUT_MS    10000
#define DHCP_TIMEOUT_MS    15000
#define HTTP_TIMEOUT_MS    30000

/* Socket timeouts. Short, and looped around, rather than long and blocking:
 * every one of these is also how quickly the Stop button can be noticed,
 * because the runner's abort flag can only be read between calls. */
#define SOCK_SLICE_MS       2000
/* How long a send may make no progress at all before the peer is declared
 * gone. AsyncWebServer stops reading while it erases a flash sector, so
 * short stalls are normal and only a long one means anything. */
#define SEND_STALL_MS      30000
/* How long to wait for the reply after the whole body is out.
 *
 * This is the fix for a hang that looked like the transport had died. On
 * success the peer answers `200` and restarts about a second later, taking
 * its AP with it — so the *documented* good path ends with the network
 * vanishing underneath an open socket. Nothing is left to deliver a FIN or an
 * RST, so a `recv` with no timeout waits for a packet that can never arrive:
 * the run stops at "validating", logs nothing, and cannot be stopped. The
 * peer either answers quickly or is already rebooting. */
#define REPLY_WAIT_MS      15000
/* The POST carries the whole image and the peer erases as it goes. */
#define UPLOAD_TIMEOUT_MS  300000

#define BOUNDARY "----dronemeshcoreupdater7b3f1a"
#define CHUNK 512

struct wifi_state {
	struct net_mgmt_event_callback wifi_cb;
	struct net_mgmt_event_callback ipv4_cb;
	struct k_sem assoc;
	struct k_sem got_ip;
	struct k_sem scan_done;
	bool  ap_seen;      /* OTA_SSID was in the last scan's results */
	bool  connected;
	volatile bool abort;
	int   sock;
};

static struct wifi_state s;

/* ---- association -------------------------------------------------------- */

static void wifi_evt(struct net_mgmt_event_callback *cb, uint64_t event,
		     struct net_if *iface)
{
	ARG_UNUSED(iface);

	switch (event) {
	case NET_EVENT_WIFI_CONNECT_RESULT: {
		const struct wifi_status *st = (const struct wifi_status *)cb->info;
		if (st->status) {
			LOG_ERR("association failed (%d)", st->status);
		} else {
			s.connected = true;
		}
		k_sem_give(&s.assoc);
		break;
	}
	case NET_EVENT_WIFI_DISCONNECT_RESULT:
		/* Expected at the end of a successful update — the repeater
		 * reboots and takes its AP with it. */
		s.connected = false;
		break;
	case NET_EVENT_WIFI_SCAN_RESULT: {
		const struct wifi_scan_result *r =
			(const struct wifi_scan_result *)cb->info;
		if (r->ssid_length == sizeof(OTA_SSID) - 1 &&
		    !memcmp(r->ssid, OTA_SSID, sizeof(OTA_SSID) - 1)) {
			s.ap_seen = true;
		}
		break;
	}
	case NET_EVENT_WIFI_SCAN_DONE:
		k_sem_give(&s.scan_done);
		break;
	default:
		break;
	}
}

static void ipv4_evt(struct net_mgmt_event_callback *cb, uint64_t event,
		     struct net_if *iface)
{
	ARG_UNUSED(cb); ARG_UNUSED(iface);
	if (event == NET_EVENT_IPV4_ADDR_ADD) {
		k_sem_give(&s.got_ip);
	}
}

/*
 * Is `MeshCore-OTA` on the air right now?
 *
 * Returns 1 if it was seen, 0 if the scan completed without it, or a negative
 * errno if scanning is not usable — in which case the caller falls back to
 * trying to associate blind, which is what this code did exclusively before.
 *
 * The reason this step exists: `net_mgmt(NET_REQUEST_WIFI_CONNECT)` against an
 * SSID that is not there produces *no event at all* on this driver. It does
 * not fail and it does not report, so the only thing that ends the attempt is
 * our own timeout — which made the interval between tries the interval at
 * which a newly-appeared AP could be noticed. An operator who sends
 * `start ota` one second after the updater begins looking then waits out the
 * rest of the window for no reason.
 *
 * A scan answers the same question in a few seconds and answers it
 * definitely, so the wait becomes "until the AP exists", not "until the next
 * blind retry happens to overlap it".
 */
static int scan_for_ap(void)
{
	struct net_if *iface = net_if_get_first_wifi();
	if (!iface) return -ENODEV;

	s.ap_seen = false;
	k_sem_reset(&s.scan_done);

	int rc = net_mgmt(NET_REQUEST_WIFI_SCAN, iface, NULL, 0);
	if (rc) return rc;

	if (k_sem_take(&s.scan_done, K_MSEC(SCAN_TIMEOUT_MS)) != 0) {
		LOG_WRN("scan did not report done within %d ms", SCAN_TIMEOUT_MS);
		return -ETIMEDOUT;
	}
	if (s.abort) return -ECANCELED;
	return s.ap_seen ? 1 : 0;
}

/*
 * `wifi_tx_power`, applied to the radio we just brought up.
 *
 * There is no Zephyr `net_mgmt` request for this — `wifi_mgmt.h` has no TX
 * power at all in this version — so it goes straight to Espressif's HAL, which
 * is why this lives in the one file that is already ESP32-only rather than
 * beside ble_tx_power.c.
 *
 * Three things the API's own documentation insists on, and each is a way to
 * get nothing while looking correct:
 *
 *   - **After WiFi start.** It answers ESP_ERR_WIFI_NOT_STARTED otherwise, so
 *     it is called here, once the association has actually completed, rather
 *     than at boot where there is no radio yet.
 *   - **Quarter-dBm units**, range [8, 84] = 2..20 dBm. `wifi_tx_power` is in
 *     whole dBm because that is what the BLE key next to it uses and a config
 *     file is not the place to explain a scaling factor.
 *   - **It rounds down to a ladder** ({8,20,28,34,44,52,56,60,66,72,80} in
 *     quarter-dBm), silently. So the level is read back and logged, exactly as
 *     the BLE side does — "requested 17, got 15" is a thing only the readback
 *     can show.
 */
static void apply_tx_power(void)
{
	const struct app_config *cfg = app_config_current();
	const int8_t want_q = (int8_t)(cfg->wifi_tx_power * 4);
	int8_t got_q = 0;

	esp_err_t err = esp_wifi_set_max_tx_power(want_q);

	if (err != ESP_OK) {
		LOG_WRN("wifi tx power: %d dBm refused (esp_err %d) — the radio "
			"runs at its default", cfg->wifi_tx_power, (int)err);
		return;
	}
	if (esp_wifi_get_max_tx_power(&got_q) != ESP_OK) {
		LOG_INF("wifi tx power: requested %d dBm", cfg->wifi_tx_power);
		return;
	}
	LOG_INF("wifi tx power: requested %d dBm -> %d.%02d dBm",
		cfg->wifi_tx_power, got_q / 4, (got_q % 4) * 25);
	if (got_q / 4 != cfg->wifi_tx_power) {
		LOG_WRN("wifi tx power %d dBm is not a level this radio "
			"implements — it is running at %d.%02d dBm",
			cfg->wifi_tx_power, got_q / 4, (got_q % 4) * 25);
	}
}

static int associate(uint32_t timeout_ms)
{
	struct net_if *iface = net_if_get_first_wifi();
	if (!iface) {
		LOG_ERR("no WiFi interface");
		return -ENODEV;
	}

	struct wifi_connect_req_params p = {
		.ssid = (const uint8_t *)OTA_SSID,
		.ssid_length = sizeof(OTA_SSID) - 1,
		.security = WIFI_SECURITY_TYPE_NONE,
		.channel = WIFI_CHANNEL_ANY,
		.band = WIFI_FREQ_BAND_2_4_GHZ,
		.mfp = WIFI_MFP_OPTIONAL,
	};

	k_sem_reset(&s.assoc);
	k_sem_reset(&s.got_ip);
	s.connected = false;

	int rc = net_mgmt(NET_REQUEST_WIFI_CONNECT, iface, &p, sizeof(p));
	if (rc) {
		/* -EALREADY means we are already on it, which is fine. */
		if (rc != -EALREADY) {
			LOG_ERR("connect request rc=%d", rc);
			return rc;
		}
		s.connected = true;
	} else if (k_sem_take(&s.assoc, K_MSEC(timeout_ms)) != 0) {
		LOG_WRN("no association result within %u ms", timeout_ms);
		return -ETIMEDOUT;
	}

	if (s.abort) return -ECANCELED;
	if (!s.connected) return -ECONNREFUSED;

	/* The AP runs a DHCP server; wait for a lease rather than assuming an
	 * address, because sending from 0.0.0.0 fails in a way that looks like
	 * the server is down. */
	if (k_sem_take(&s.got_ip, K_MSEC(DHCP_TIMEOUT_MS)) != 0) {
		LOG_WRN("associated but no DHCP lease");
		return -ETIMEDOUT;
	}
	if (s.abort) return -ECANCELED;
	LOG_INF("associated with %s", OTA_SSID);
	apply_tx_power();
	return 0;
}

static void disassociate(void)
{
	struct net_if *iface = net_if_get_first_wifi();
	if (iface && s.connected) {
		(void)net_mgmt(NET_REQUEST_WIFI_DISCONNECT, iface, NULL, 0);
	}
	s.connected = false;
}

/* ---- sockets ------------------------------------------------------------ */

static int open_sock(void)
{
	struct sockaddr_in addr = {
		.sin_family = AF_INET,
		.sin_port = htons(OTA_PORT),
	};
	zsock_inet_pton(AF_INET, OTA_HOST, &addr.sin_addr);

	int fd = zsock_socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
	if (fd < 0) return -errno;

	/*
	 * Timeouts as well as the poll() below, and the return values are
	 * checked rather than discarded.
	 *
	 * They were `(void)` here, which is a bad way to write a safety net:
	 * if the option is not honoured the call underneath goes back to
	 * blocking forever and nothing says so — the exact failure the
	 * timeouts were added to prevent, now silent. Readiness is decided by
	 * poll(), which needs no option to work; these only bound the window
	 * between poll saying ready and the call being made.
	 */
	struct zsock_timeval tv = {
		.tv_sec = SOCK_SLICE_MS / 1000,
		.tv_usec = (SOCK_SLICE_MS % 1000) * 1000,
	};
	if (zsock_setsockopt(fd, ZSOCK_SOL_SOCKET, ZSOCK_SO_SNDTIMEO, &tv, sizeof(tv)) < 0 ||
	    zsock_setsockopt(fd, ZSOCK_SOL_SOCKET, ZSOCK_SO_RCVTIMEO, &tv, sizeof(tv)) < 0) {
		LOG_WRN("socket timeouts unavailable (%d) — relying on poll()", errno);
	}

	if (zsock_connect(fd, (struct sockaddr *)&addr, sizeof(addr)) < 0) {
		int e = -errno;
		zsock_close(fd);
		return e;
	}
	return fd;
}

/** True when `errno` from a socket call means "try again", not "it failed". */
static inline bool sock_would_block(int e)
{
	return e == EAGAIN || e == EWOULDBLOCK || e == ETIMEDOUT || e == EINTR;
}

/*
 * Wait for `fd` to be readable or writable, up to `ms`.
 *
 * Returns 1 ready, 0 timed out, negative errno on a real failure. This, not
 * SO_RCVTIMEO, is what actually bounds every wait here: poll() takes its
 * timeout as an argument, so it cannot be quietly not-supported the way a
 * socket option can.
 */
static int sock_wait(int fd, short events, int ms)
{
	struct zsock_pollfd p = { .fd = fd, .events = events };
	int rc = zsock_poll(&p, 1, ms);
	return rc < 0 ? -errno : rc;
}

/*
 * Send it all, or say why not. Returns 0, -ECANCELED on stop, or -ETIMEDOUT
 * if the peer stopped reading for SEND_STALL_MS.
 *
 * A short SO_SNDTIMEO makes a partial write and a stalled write look the
 * same, so progress is what is measured, not elapsed time: the peer pausing
 * to erase a flash sector is normal and must not be mistaken for a peer that
 * has gone away.
 */
static int send_all(int fd, const void *data, size_t len)
{
	const uint8_t *p = data;
	size_t off = 0;
	int64_t last_progress = k_uptime_get();

	while (off < len) {
		if (s.abort) return -ECANCELED;

		const int ready = sock_wait(fd, ZSOCK_POLLOUT, SOCK_SLICE_MS);
		if (ready < 0) return ready;
		if (ready == 0) {
			if (k_uptime_get() - last_progress > SEND_STALL_MS) {
				LOG_ERR("peer stopped reading for %d ms with %u of %u bytes left",
					SEND_STALL_MS, (unsigned)(len - off), (unsigned)len);
				return -ETIMEDOUT;
			}
			continue;
		}

		int w = zsock_send(fd, p + off, len - off, 0);
		if (w > 0) {
			off += (size_t)w;
			last_progress = k_uptime_get();
			continue;
		}
		if (w < 0 && !sock_would_block(errno)) return -errno;
		if (k_uptime_get() - last_progress > SEND_STALL_MS) {
			LOG_ERR("peer stopped reading for %d ms with %u of %u bytes left",
				SEND_STALL_MS, (unsigned)(len - off), (unsigned)len);
			return -ETIMEDOUT;
		}
	}
	return 0;
}

/* ---- GET /update/identity ---------------------------------------------- */

static int identity_cb(struct http_response *rsp, enum http_final_call final,
		       void *user)
{
	ARG_UNUSED(final);
	char *out = user;

	if (!rsp->body_frag_start || !rsp->body_frag_len) return 0;

	/* {"id":"<name> (<Manufacturer>)","hardware":"ESP32"} — matched by
	 * hand rather than with a JSON parser: one key, known shape, and the
	 * whole reply is well under a hundred bytes. */
	const char *p = strstr(rsp->body_frag_start, "\"id\"");
	if (!p) return 0;
	p = strchr(p + 4, ':');
	if (!p) return 0;
	p = strchr(p, '"');
	if (!p) return 0;
	p++;
	const char *end = strchr(p, '"');
	if (!end) return 0;

	size_t n = (size_t)(end - p);
	if (n >= DFU_TARGET_NAME_MAX) n = DFU_TARGET_NAME_MAX - 1;
	memcpy(out, p, n);
	out[n] = '\0';
	return 0;
}

static int read_identity(char *name_out)
{
	static uint8_t buf[512];
	int fd = open_sock();
	if (fd < 0) return fd;

	struct http_request req = {
		.method = HTTP_GET,
		.url = "/update/identity",
		.host = OTA_HOST,
		.protocol = "HTTP/1.1",
		.response = identity_cb,
		.recv_buf = buf,
		.recv_buf_len = sizeof(buf),
	};

	name_out[0] = '\0';
	int rc = http_client_req(fd, &req, HTTP_TIMEOUT_MS, name_out);
	zsock_close(fd);
	if (rc < 0) return rc;
	if (!name_out[0]) return -ENOENT;
	return 0;
}

/* ---- the upload --------------------------------------------------------- */

/* Read the payload once to hash it. The image is on flash and never held in
 * RAM, and ElegantOTA verifies this digest at Update.end() — so a wrong one
 * costs the entire upload before it is discovered. */
static int hash_payload(const struct dfu_payload *pl, char hex_out[33])
{
	struct fs_file_t f;
	struct md5_ctx ctx;
	uint8_t buf[CHUNK];
	uint8_t digest[16];

	fs_file_t_init(&f);
	int rc = fs_open(&f, pl->path, FS_O_READ);
	if (rc < 0) return rc;

	md5_init(&ctx);
	for (;;) {
		int n = fs_read(&f, buf, sizeof(buf));
		if (n < 0) { fs_close(&f); return n; }
		if (n == 0) break;
		md5_update(&ctx, buf, (size_t)n);
	}
	fs_close(&f);

	md5_final(&ctx, digest);
	md5_hex(digest, hex_out);
	return 0;
}

/*
 * The POST, written directly rather than through http_client_req().
 *
 * Zephyr's client can stream a payload, but it wants either a fixed
 * Content-Length with a callback that fills a buffer, or chunked encoding —
 * and AsyncWebServer's multipart parser wants a plain Content-Length body.
 * Building the request by hand is fewer moving parts than bending the client
 * into that shape, and every byte of it is a documented requirement.
 */
static int post_firmware(const struct dfu_payload *pl, const char *md5_hex,
			 int *http_status)
{
	char pre[320];
	char post[64];
	uint8_t buf[CHUNK];
	struct fs_file_t f;
	int rc = 0;

	int pre_len = snprintf(pre, sizeof(pre),
		"--" BOUNDARY "\r\n"
		"Content-Disposition: form-data; name=\"MD5\"\r\n\r\n"
		"%s\r\n"
		"--" BOUNDARY "\r\n"
		"Content-Disposition: form-data; name=\"firmware\"; "
		"filename=\"firmware.bin\"\r\n"
		"Content-Type: application/octet-stream\r\n\r\n",
		md5_hex);
	int post_len = snprintf(post, sizeof(post), "\r\n--" BOUNDARY "--\r\n");

	uint32_t content_len = (uint32_t)pre_len + pl->size + (uint32_t)post_len;

	char hdr[256];
	int hdr_len = snprintf(hdr, sizeof(hdr),
		"POST /update HTTP/1.1\r\n"
		"Host: " OTA_HOST "\r\n"
		"Content-Type: multipart/form-data; boundary=" BOUNDARY "\r\n"
		"Content-Length: %u\r\n"
		"Connection: close\r\n"
		"\r\n", content_len);

	int fd = open_sock();
	if (fd < 0) return fd;

	fs_file_t_init(&f);
	rc = fs_open(&f, pl->path, FS_O_READ);
	if (rc < 0) { zsock_close(fd); return rc; }

	rc = send_all(fd, hdr, hdr_len);
	if (rc == 0) rc = send_all(fd, pre, pre_len);
	if (rc < 0) goto out;

	uint32_t sent = 0;
	/* Logged as well as reported over BLE. The web client sees
	 * dfu_status_progress(), but the serial console and /lfs1/LOG.* saw
	 * nothing at all between "uploading" and the end — which is the half
	 * hour of a bring-up run where knowing whether anything is moving
	 * matters most, and the only record that survives losing the link. */
	const int64_t t0 = k_uptime_get();
	uint32_t next_log = 0;
	dfu_status_set_state(DFU_STATUS_UPLOADING);

	while (sent < pl->size) {
		if (s.abort) { rc = -ECANCELED; goto out; }

		int n = fs_read(&f, buf, sizeof(buf));
		if (n < 0) { rc = n; goto out; }
		if (n == 0) break;

		rc = send_all(fd, buf, (size_t)n);
		if (rc < 0) goto out;

		sent += (uint32_t)n;
		dfu_status_progress((uint8_t)((uint64_t)sent * 100 / pl->size),
				    sent, pl->size);

		if (sent >= next_log || sent == pl->size) {
			const int64_t ms = k_uptime_get() - t0;
			LOG_INF("upload %u%% (%u/%u B, %u KB/s)",
				(unsigned)((uint64_t)sent * 100 / pl->size),
				sent, pl->size,
				(unsigned)(ms > 0 ? (uint64_t)sent / (uint64_t)ms : 0));
			next_log = sent + pl->size / 10;
		}
	}

	rc = send_all(fd, post, post_len);
	if (rc < 0) goto out;

	{
		const int64_t ms = k_uptime_get() - t0;
		LOG_INF("body sent: %u B in %u ms (%u KB/s) — awaiting reply",
			sent, (unsigned)ms,
			(unsigned)(ms > 0 ? (uint64_t)sent / (uint64_t)ms : 0));
	}

	/*
	 * Wait for the reply, but not forever.
	 *
	 * `200 OK` then the AP disappears about a second later, so on the good
	 * path the network is torn down while this socket is still open. There
	 * is nothing left to send a FIN or an RST — the peer is not refusing
	 * the connection, it has ceased to exist — so a `recv` that waits for
	 * a definite answer waits for one that can never come. Silence here is
	 * therefore *evidence*, not an absence of it, and is read the same way
	 * as a 200.
	 */
	dfu_status_set_state(DFU_STATUS_VALIDATING);
	char rsp[256];
	const int64_t deadline = k_uptime_get() + REPLY_WAIT_MS;
	int got = -1;

	while (k_uptime_get() < deadline) {
		if (s.abort) { rc = -ECANCELED; goto out; }

		const int ready = sock_wait(fd, ZSOCK_POLLIN, SOCK_SLICE_MS);
		if (ready < 0) { got = ready; break; }
		if (ready == 0) continue;

		got = zsock_recv(fd, rsp, sizeof(rsp) - 1, 0);
		if (got < 0 && sock_would_block(errno)) continue;
		break;    /* data, an orderly close, or a real error */
	}

	if (got > 0) {
		rsp[got] = '\0';
		int code = 0;
		if (sscanf(rsp, "HTTP/1.%*d %d", &code) == 1) *http_status = code;
		/* The status line verbatim: ElegantOTA's body is "OK" or
		 * "FAIL", and on anything unexpected the line itself is the
		 * only thing that says what happened. */
		char *eol = strpbrk(rsp, "\r\n");
		if (eol) *eol = '\0';
		LOG_INF("peer replied: %s", rsp);
	} else {
		LOG_WRN("no reply within %d ms — the peer restarting without "
			"answering is what a successful flash looks like, so "
			"this is being read as success",
			REPLY_WAIT_MS);
		*http_status = 0;
	}

out:
	fs_close(&f);
	zsock_close(fd);
	return rc;
}

/* ---- the transport ------------------------------------------------------ */

static bool wifi_available(const struct app_config *cfg)
{
	/* Two gates, and they answer different questions. The radio decides
	 * whether this is even possible; the config decides whether it is
	 * wanted, because trying costs an association attempt on every scan
	 * cycle that finds no BLE target. */
	if (!cfg->wifi_ota) return false;
	return net_if_get_first_wifi() != NULL;
}

static int wifi_find(struct dfu_target *out, const struct app_config *cfg,
		     uint32_t timeout_ms, const char *pin)
{
	ARG_UNUSED(cfg);

	/* No pinning here yet. The field is deliberately transport-opaque so
	 * this could one day take an IP or a hostname, but today the only
	 * thing that produces a pin is the BLE scanner, and a MAC address
	 * means nothing to an HTTP endpoint. Refusing is what turns "flash
	 * this .bin at that Bluetooth device" into an error the operator can
	 * read, instead of a scan that silently ignores their choice and
	 * flashes whatever ElegantOTA peer answered first. */
	if (pin != NULL && pin[0] != '\0') {
		LOG_ERR("wifi-elegantota cannot target a pinned address ('%s')", pin);
		return -EINVAL;
	}

	memset(out, 0, sizeof(*out));
	out->tp = &dfu_transport_wifi_elegantota;
	s.abort = false;

	/*
	 * `timeout_ms == 0` is the runner's word for "keep looking until you
	 * are stopped" — the same contract the BLE scanner honours, and the
	 * default (`scan_timeout=0`) a drone flies with.
	 *
	 * It used to read `timeout_ms ? timeout_ms : ASSOC_TIMEOUT_MS`, which
	 * inverts exactly that: the value meaning "forever" was the one value
	 * treated as "20 seconds". A target whose operator had not yet sent
	 * `start ota` was given one 20 s window and then reported as absent.
	 *
	 * Association is polled rather than waited on in one long call, so an
	 * AP that appears later is still found, and so a stop lands within an
	 * attempt rather than at the end of the budget.
	 */
	const bool forever = (timeout_ms == 0);
	uint32_t spent = 0;
	int rc;

	bool can_scan = true;

	for (;;) {
		if (s.abort) return -ECANCELED;

		uint32_t attempt = ASSOC_ATTEMPT_MS;
		if (!forever) {
			const uint32_t left = (spent < timeout_ms) ? timeout_ms - spent : 0;
			if (left == 0) return -ETIMEDOUT;
			attempt = MIN(left, (uint32_t)ASSOC_ATTEMPT_MS);
		}

		/* Look before joining. A scan that cannot run is not a reason
		 * to give up — fall back to the blind attempt permanently, so
		 * a driver without scan support behaves as it did before. */
		if (can_scan) {
			const int seen = scan_for_ap();
			if (seen == -ECANCELED) return -ECANCELED;
			if (seen < 0) {
				LOG_WRN("scan unusable (%d) — associating blind from here on",
					seen);
				can_scan = false;
			} else if (seen == 0) {
				/* The expected state while waiting for an
				 * operator to send `start ota`. Not logged per
				 * cycle: at a few seconds each that is a wall
				 * of text in the file log for "nothing yet". */
				spent += SCAN_TIMEOUT_MS;
				if (!forever && spent >= timeout_ms) return -ETIMEDOUT;
				continue;
			} else {
				LOG_INF("%s is on the air — joining", OTA_SSID);
			}
		}

		rc = associate(attempt);
		if (rc == 0) break;
		if (s.abort) return -ECANCELED;
		if (rc != -ETIMEDOUT && rc != -ECONNREFUSED) return rc;

		/* Leave no half-open association behind: the driver refuses a
		 * fresh connect while it thinks one is in progress. */
		disassociate();
		spent += attempt;
	}

	rc = read_identity(out->name);
	if (rc < 0) {
		LOG_ERR("associated but /update/identity did not answer (%d) — "
			"this AP may not be a MeshCore repeater in OTA mode", rc);
		disassociate();
		return -ETIMEDOUT;
	}
	LOG_INF("target: %s", out->name);
	return 0;
}

static enum dfu_result wifi_run(const struct dfu_target *t,
				const struct dfu_payload *payload,
				const struct app_config *cfg)
{
	ARG_UNUSED(t); ARG_UNUSED(cfg);

	if (payload->kind != DFU_PAYLOAD_RAW) return DFU_FS_ERROR;

	char md5[33];
	dfu_status_set_state(DFU_STATUS_STARTING);
	int rc = hash_payload(payload, md5);
	if (rc < 0) {
		LOG_ERR("could not hash %s (%d)", payload->path, rc);
		return DFU_FS_ERROR;
	}
	LOG_INF("uploading %s (%u B), MD5 %s", payload->path, payload->size, md5);

	int status = -1;
	rc = post_firmware(payload, md5, &status);
	if (rc == -ECANCELED) return DFU_DISCONNECTED_EARLY;
	if (rc < 0) {
		LOG_ERR("upload failed (%d)", rc);
		return rc == -ETIMEDOUT ? DFU_TIMEOUT : DFU_DISCONNECTED_EARLY;
	}

	/* 200, or no reply at all: both mean the peer took it. A peer that
	 * accepted the image restarts about a second later, and the reply can
	 * be lost to that. 500 is ElegantOTA's own "FAIL", which is a genuine
	 * rejection — usually the MD5. */
	if (status == 200 || status == 0) return DFU_OK;
	if (status == 500) {
		LOG_ERR("peer rejected the image (500) — MD5 mismatch, or the "
			"image did not fit its OTA slot");
		return DFU_REMOTE_ERROR;
	}
	LOG_ERR("unexpected HTTP status %d", status);
	return DFU_REMOTE_ERROR;
}

static void wifi_abort(void)
{
	s.abort = true;
	/* Waking both waits is the point. The flag alone only takes effect at
	 * the next place something looks at it, and association spends its
	 * whole time inside k_sem_take() — so a stop pressed during a scan did
	 * nothing at all until the attempt expired on its own. Every taker
	 * re-checks s.abort immediately after waking, so a spurious give
	 * cannot be mistaken for an event. */
	k_sem_give(&s.assoc);
	k_sem_give(&s.got_ip);
	k_sem_give(&s.scan_done);
}

static void wifi_release(struct dfu_target *t)
{
	ARG_UNUSED(t);
	disassociate();
}

static int wifi_ota_init(void)
{
	struct net_if *iface = net_if_get_first_wifi();

	k_sem_init(&s.assoc, 0, 1);
	k_sem_init(&s.got_ip, 0, 1);
	k_sem_init(&s.scan_done, 0, 1);

	net_mgmt_init_event_callback(&s.wifi_cb, wifi_evt,
				     NET_EVENT_WIFI_CONNECT_RESULT |
				     NET_EVENT_WIFI_DISCONNECT_RESULT |
				     NET_EVENT_WIFI_SCAN_RESULT |
				     NET_EVENT_WIFI_SCAN_DONE);
	net_mgmt_add_event_callback(&s.wifi_cb);

	net_mgmt_init_event_callback(&s.ipv4_cb, ipv4_evt, NET_EVENT_IPV4_ADDR_ADD);
	net_mgmt_add_event_callback(&s.ipv4_cb);

	LOG_INF("wifi-elegantota transport ready (iface %s)",
		iface ? "present" : "MISSING");
	return 0;
}
SYS_INIT(wifi_ota_init, APPLICATION, CONFIG_APPLICATION_INIT_PRIORITY);

const struct dfu_transport dfu_transport_wifi_elegantota = {
	.name = "wifi-elegantota",
	.available = wifi_available,
	.find = wifi_find,
	.run = wifi_run,
	.payload_kind = DFU_PAYLOAD_RAW,
	.abort = wifi_abort,
	.release = wifi_release,
};
