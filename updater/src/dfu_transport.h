#pragma once

/*
 * How the updater reaches a target.
 *
 * There are two, and they are not variations on one theme:
 *
 *   ble-legacy-dfu   BLE central -> Nordic Legacy DFU. nRF52 MeshCore
 *                    repeaters, which advertise a per-variant name
 *                    ("XIAO_NRF52_OTA", "MESH_SOLAR_OTA") once the operator
 *                    has sent `start ota` over the mesh.
 *   wifi-elegantota  WiFi station -> multipart POST. ESP32 MeshCore
 *                    repeaters, which raise an AP on the same command.
 *                    ESP32 updater hardware only — nRF has no WiFi, so no nRF
 *                    build can ever reach an ESP32 repeater.
 *
 * ---- What the two have in common, and where they differ ------------------
 *
 * Both end up handing the runner **a peer and a name**, and the name is what
 * firmware_map matches to choose a bundle. That much is symmetric.
 *
 * What is not symmetric is when the name exists:
 *
 *   BLE   the name is in the advertisement       -> known before connecting
 *   WiFi  every repeater's AP is "MeshCore-OTA"  -> known only after
 *         associating and asking, GET /update/identity
 *
 * So find() is allowed to leave a connection open, and release() cleans up
 * whatever it made. The BLE driver connects inside run() and releases nothing;
 * the WiFi driver has to associate inside find() and hold the association
 * through run(). Both look the same from the runner.
 *
 * (The runner already resolves the bundle *after* the target is named, so
 * nothing about its sequencing had to change for this — the WiFi driver just
 * does more work inside find().)
 *
 * ---- Adding one ----------------------------------------------------------
 *
 * Implement the three functions, export a `const struct dfu_transport`, and
 * add it to the table in dfu_transport.c. The table is a plain array rather
 * than a linker section because its **order is the scan order**, and that is
 * worth being able to read.
 */

#include <stddef.h>
#include <stdint.h>
#include <stdbool.h>

#include "ble_scanner.h"
#include "firmware_zip.h"
#include "config.h"
#include "dfu_client.h"     /* enum dfu_result — the shared result vocabulary */

#ifdef __cplusplus
extern "C" {
#endif

/* Long enough for an ElegantOTA identity string, which is the longest thing
 * that lands here: "<node name> (Seeed SenseCAP MeshTracker X1)". A BLE
 * advertised name is at most BLE_SCANNER_NAME_MAX and fits easily. */
#define DFU_TARGET_NAME_MAX 64

struct dfu_transport;

/* One found peer, plus whatever its transport needs to talk to it again. */
struct dfu_target {
	const struct dfu_transport *tp;
	/* What firmware_map matches on. For BLE the advertised name; for WiFi
	 * the `id` field of GET /update/identity, which carries the board in
	 * parentheses — "MyRepeater (Heltec V3)". */
	char name[DFU_TARGET_NAME_MAX];

	union {
		struct ble_scanner_target ble;
		/* wifi goes here with the ESP32 driver */
	};
};

/*
 * What a transport is asked to send.
 *
 * The two transports do not carry the same thing, and pretending otherwise
 * was the seam's one wrong assumption. A Legacy DFU peer takes a *packaged*
 * update — an image plus its init packet, out of a zip. An ElegantOTA peer
 * takes a bare application binary and nothing else. So the runner resolves a
 * path, works out which of the two it is, and hands over whichever shape the
 * file actually has.
 *
 * A transport reads only its own arm and should assert on the other: a BLE
 * driver handed a raw .bin has been given a file no Legacy DFU peer could
 * accept, and failing loudly beats streaming a headerless image at one.
 */
enum dfu_payload_kind {
	DFU_PAYLOAD_ZIP = 0,   /* legacy nrfutil package — ble-legacy-dfu */
	DFU_PAYLOAD_RAW = 1,   /* bare application image — wifi-elegantota */
};

struct dfu_payload {
	enum dfu_payload_kind kind;
	/* Absolute path on the filesystem, for logging and for RAW, which has
	 * nothing else to read from. */
	const char *path;
	union {
		struct firmware_bundle zip;   /* KIND_ZIP: open, streamable */
		uint32_t               size;  /* KIND_RAW: bytes on flash */
	};
};

struct dfu_transport {
	const char *name;

	/* NULL means "always". Non-NULL lets a transport bow out at runtime —
	 * e.g. WiFi with no SSID configured — without being compiled out. */
	bool (*available)(const struct app_config *cfg);

	/* Look for a peer this transport can reach. 0 on success, -ETIMEDOUT
	 * if the window expired with no match, another negative errno if the
	 * radio itself failed. May leave a connection open; release() is what
	 * closes it.
	 *
	 * `pin` is NULL or "" for the usual search — take whatever matches the
	 * configured filters. Otherwise it names one specific peer the operator
	 * picked out of a scan, and the transport must reach that one or fail;
	 * `ble_name` and `min_rssi` do not apply, because a deliberate choice
	 * is not something a filter should be allowed to overrule.
	 *
	 * **The string is opaque to the runner**, which never learns what an
	 * address is: it arrives from the client, is carried through unread,
	 * and is parsed by whichever transport claims it. That is what lets a
	 * MAC and a future "192.168.1.50" share one field. A transport that
	 * cannot make sense of the pin it is handed returns -EINVAL, which the
	 * runner reports as this file being unable to reach that target.
	 */
	int (*find)(struct dfu_target *out, const struct app_config *cfg,
		    uint32_t timeout_ms, const char *pin);

	/* Flash `bundle` into the peer find() reported. Blocks for the whole
	 * transfer — the runner has its own thread for exactly this. */
	enum dfu_result (*run)(const struct dfu_target *t,
			       const struct dfu_payload *payload,
			       const struct app_config *cfg);

	/* Which payload shape this transport can send. The runner checks
	 * before calling run(), so a mismatch is reported as "this updater
	 * cannot flash that file" rather than discovered mid-transfer. */
	enum dfu_payload_kind payload_kind;

	/* Optional. Make a find() or run() that is currently blocked give up
	 * as soon as it can, so an operator can stop a run without waiting out
	 * a K_FOREVER scan or a 500 KB transfer.
	 *
	 * Called from *another* thread than the one inside find()/run(), and
	 * possibly when neither is running — so it must be safe to call at any
	 * time and must not block. It does not have to make anything stop
	 * immediately; the runner checks its own cancel flag as well, and this
	 * only shortens the wait.
	 *
	 * NULL means the transport cannot be interrupted, and the runner will
	 * still stop — at the next point it looks, which may be a whole scan
	 * timeout away.
	 */
	void (*abort)(void);

	/* Optional second opinion on a run() that returned DFU_OK.
	 *
	 * A transport's own success only means "the peer took every byte and
	 * acknowledged the last one". Whether it is *running* the image is a
	 * separate question, and on some peers it has a different answer —
	 * a Nordic bootloader that fails its own CRC check re-arms DFU rather
	 * than booting, so the transfer succeeds and the update does not.
	 *
	 * Called after release(), so the link is down and the peer has been
	 * left to reboot; it is free to take a few seconds. Return DFU_OK to
	 * confirm, DFU_TARGET_REJECTED to overturn, or any other result to
	 * report a failure of the check itself.
	 *
	 * NULL means the transport cannot tell, and run()'s answer stands.
	 */
	enum dfu_result (*verify)(const struct dfu_target *t,
				  const struct app_config *cfg);

	/* Tear down whatever find() and run() left open. Always called, on
	 * every path out, including failures. */
	void (*release)(struct dfu_target *t);
};

extern const struct dfu_transport dfu_transport_ble;
#ifdef CONFIG_WIFI
extern const struct dfu_transport dfu_transport_wifi_elegantota;
#endif

/* The transports compiled into this build, in scan order. */
const struct dfu_transport *const *dfu_transport_list(size_t *count);

#ifdef __cplusplus
}
#endif
