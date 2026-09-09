#pragma once

/*
 * DFU-target configuration loaded from /lfs1/config.txt.
 *
 * See the per-field comments below for what each key does. Read the moment
 * storage is mounted and applied to the BLE scanner, the DFU retry loop, and
 * tx-power on init. Runtime edits (upload a new config.txt via
 * SMP / fsx_stream) take effect at the *next* DFU sequence.
 */

#include <zephyr/kernel.h>
#include <stdbool.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif


/* Canonical config path. Deliberately lowercase, and lowercase everywhere
 * that creates or updates it: LittleFS is case-sensitive, so a file uploaded
 * as "config.txt" is one this firmware silently never reads. One agreed
 * spelling is what prevents that. `web/test/config-file.test.mjs` reads this
 * line and fails if the web client disagrees with it.
 */
#define APP_CONFIG_PATH   "/lfs1/config.txt"
#define APP_CONFIG_NAME_MAX 24

/* Room for more than a passkey can legally be, which is the point.
 *
 * A Bluetooth passkey is 0..999999, so six digits plus a terminator would fit
 * every valid value — and would silently turn an invalid one into a valid
 * lookalike, because snprintf() would clip a hand-typed "1234567" to "123456"
 * and hand ble_pairing.c a PIN nobody chose. Sized to let a wrong value
 * survive the parser intact so it can be *refused*, with a message, instead of
 * failing later as an authentication error that reads like a typo. */
#define APP_CONFIG_PIN_MAX  12

/* ble_firmware_mapping holds several "name:file" rules, so it needs far more
 * room than a single name. Bounded well under the 1023-byte parse buffer so a
 * long mapping can't push other keys off the end of the file.
 */
#define APP_CONFIG_MAPPING_MAX 192

/* "#drone-updater" and a little room. MeshCore hashes the name as typed, so a
 * trailing space or a smart quote is a different channel — the length is not
 * the thing to be generous about. */
#define APP_CONFIG_CHANNEL_MAX 32

/* The name shown before the colon in every message. Kept well under the 50
 * characters MeshCore clients will accept as a sender prefix; anything longer
 * is displayed as part of the message instead of as a name. */
#define APP_CONFIG_SENDER_MAX 24

struct app_config {
	/* Substring filter for advertised BLE name. Empty = accept any peer
	 * that exposes the Legacy DFU service. Multiple substrings may be
	 * OR'd with '|', useful when an app and its bootloader advertise
	 * under different names (e.g. "RAK4631_OTA | 4631_DFU").
	 */
	char     ble_name[APP_CONFIG_NAME_MAX];

	/* Rules mapping an advertised BLE name to the firmware bundle to send
	 * it, so one updater can carry several zips and pick per target.
	 *
	 *   ble_firmware_mapping=RAK:rak4631*.zip | XIAO:xiao_*.zip
	 *
	 * Rules are '|'-separated and tried in order; the first whose name
	 * part is a substring of the peer's advertised name wins. The file
	 * part is a filename glob ('*' and '?') resolved against /lfs1.
	 * Whitespace around either part is trimmed.
	 *
	 * Only consulted by the auto-flash path (trigger_dfu with no path).
	 * Flashing a specific zip still sends exactly that zip.
	 */
	char     ble_firmware_mapping[APP_CONFIG_MAPPING_MAX];

	/* The PIN used when a target refuses to talk over an unencrypted link.
	 *
	 * MeshCore's firmware is the case this exists for: its characteristics
	 * require authentication, so an unpaired central is answered with ATT
	 * "Insufficient Authentication" and — before this — the run failed
	 * reporting a missing DFU characteristic.
	 *
	 * Empty (the default) does **not** mean "do not pair". Nothing is ever
	 * offered up front either way: the link is raised only when a peer
	 * refuses something, and Zephyr's BT_ATT_RETRY_ON_SEC_ERR then retries
	 * the request by itself. What this key changes is whether we can
	 * *answer* when that happens. Set empty, a target that wants a PIN is
	 * reported as needing one instead of failing obscurely — which is the
	 * whole improvement, and it applies with the key unset.
	 *
	 * A fleet default. One specific target can be flashed with a different
	 * PIN from the scanner without touching this file; see fsx_mgmt.h's
	 * TRIGGER_DFU.
	 *
	 * Digits only, one to six of them. See ble_pairing.h for why the name
	 * says `pin` while everything inside the firmware says `passkey`.
	 */
	char     ble_pin[APP_CONFIG_PIN_MAX];

	/* Packet Receipt Notification cadence (writes between PRN callbacks).
	 * 10 is safe for SDK 6.0 bootloaders; modern ones tolerate ~32. 0
	 * disables PRNs entirely — faster but no flow control (risky).
	 */
	uint16_t prn;

	/* Negotiate ATT MTU up to 247 B after connect. When false, falls back
	 * to the default MTU of 23. Some older bootloaders may not honour MTU
	 * exchange — set to false if a target stalls immediately after connect.
	 */
	bool     high_mtu;

	/* Number of DFU attempts before giving up. */
	uint8_t  retries;

	/* Minimum RSSI (dBm, negative). Ads weaker than this are rejected
	 * during scan. -127 = no minimum. Refuses flashing when the signal
	 * isn't strong enough to reliably stream.
	 */
	int8_t   min_rssi;

	/* Cooldown between failed attempts (seconds). The DFU bootloader
	 * needs time to settle after a reset before it'll accept another
	 * START_DFU.
	 */
	uint16_t retry_cooldown;

	/* Extended cooldown used after a *post-connect* failure (response
	 * timeout, protocol error, mid-stream link drop). SDK 11-era stock
	 * Adafruit bootloaders that wedge mid-DFU only unstick when their
	 * internal inactivity watchdog fires — usually 60-120 s. Pre-connect
	 * failures use the short retry_cooldown.
	 */
	uint16_t wedge_cooldown;

	/* BLE transmit power in dBm. **The ladder is per radio**, and the
	 * accepted range spans all of them (-40..20):
	 *
	 *   nRF54L    -40, -20, -16, -12, -8, -4, 0, 3, 6, 8   (fewer than
	 *             the nRF52840's; the SoftDevice clips silently)
	 *   Espressif -15, -12, -9, -6, -3, 0, 3, 6, 9, 12, 15, 18, 20
	 *             (ESP_PWR_LVL_*; hci_esp32.c rounds *down* to a level,
	 *             so a request of 8 lands at 6)
	 *
	 * So the same number means different things on different boards, and
	 * an nRF part cannot reach the top of this range at all. That is why
	 * ble_tx_power.c reads the selected level back out of the command
	 * response and warns when it is not what was asked for — the config
	 * value is a request, and the boot log is the fact.
	 */
	int8_t   ble_tx_power;
	/* WiFi radio power in dBm, for the ElegantOTA transport. Separate from
	 * ble_tx_power because they are different radios with different ladders
	 * and different legal ranges — and because one config key named for
	 * neither of them is a key nobody can reason about. */
	int8_t   wifi_tx_power;

	/* Per-scan timeout (seconds). 0 = scan forever (default, intended for
	 * drone use). Non-zero caps the wait; on expiry the sequence gives up
	 * without consuming a DFU retry.
	 */
	uint16_t scan_timeout;

	/* If true, log every rejected advertisement (weak / name / UUID
	 * mismatch). Useful when diagnosing why a target isn't picked up.
	 * Off by default to keep the field log quiet.
	 */
	bool     scan_debug;

	/* Start an auto-flash as soon as the radio is up, with no client and
	 * nobody to press anything.
	 *
	 * This is the drone case in one key. Until now every DFU began with a
	 * TRIGGER_DFU write from the web client, which means a browser had to
	 * be in Bluetooth range of the updater — and the whole point of the
	 * device is to go somewhere a browser cannot follow. With this set,
	 * power-on is the trigger: scan, match ble_firmware_mapping, flash,
	 * retry per `retries`.
	 *
	 * **It needs ble_firmware_mapping**, because auto-flash chooses the
	 * bundle by target name and an empty mapping gives it nothing to
	 * choose from. Set without one, the run is refused and main() says so
	 * at boot rather than leaving a device that looks armed and is not.
	 *
	 * Off by default. It arms the device the moment it has power, and a
	 * default that flashes whatever it finds is not a default anyone
	 * should get by accident.
	 *
	 * Consequence worth knowing: with the default scan_timeout of 0 the
	 * search never ends, so the device stays dfu_runner_busy() until it
	 * succeeds or is stopped. Surveys refuse to start while that is true
	 * (see survey.h), so the scanner panel will be unavailable until you
	 * press Stop. That is the correct trade for an unattended device and
	 * the UI explains it rather than just greying out.
	 */
	bool     auto_flash;

	/* Select the external antenna connector rather than the on-board one.
	 *
	 * Only meaningful on hardware with an antenna switch, which is a
	 * property of the *board*, not the SoC: the board's devicetree
	 * declares `antenna-gpios` under `zephyr,user` and boards that do not
	 * have one compile antenna.c's body away entirely. Setting this on
	 * such a board logs once and changes nothing — the same contract
	 * ble_tx_power has on the MG24, and for the same reason: a key that
	 * silently does nothing is worse than one that says so.
	 *
	 * False = on-board antenna, which is what every board here ships
	 * selecting and the only choice that works with nothing plugged in.
	 * Switching to `external` with no antenna attached will make the link
	 * *worse*, not better, so this is opt-in.
	 */
	bool     ext_antenna;

	/* Charge the battery at the higher of the two currents the board's
	 * charger IC offers, where it offers a choice.
	 *
	 * Off by default, which is the charger's own default and what this
	 * firmware has always done — nothing here drove the pin at all, so the
	 * XIAO nRF52840 has been charging at 50 mA. On is 100 mA there.
	 *
	 * A key rather than an unconditional boot-time write, which is what the
	 * previous Arduino updater did: the right current depends on the cell
	 * somebody actually fitted, and doubling it for every existing device
	 * is not a decision firmware should take on its own. Accepted on every
	 * board and reported as unsupported where there is no such control, for
	 * the same reason as `ext_antenna` — one config.txt is copied across a
	 * fleet of mixed boards. */
	bool     fast_charge;

	/* Try the WiFi/ElegantOTA transport as well as BLE.
	 *
	 * On by default, but it is not free: a scan cycle that finds no BLE
	 * target then tries to associate with `MeshCore-OTA`, which costs
	 * seconds. An operator flashing only nRF targets from an ESP32
	 * updater can turn it off and get the BLE-only cadence back.
	 *
	 * Ignored on hardware with no WiFi radio, where the transport's own
	 * available() returns false regardless — which is every nRF board. */
	bool     wifi_ota;

	/* Idle gap inserted between consecutive firmware packets, in
	 * milliseconds. 0 = send back-to-back.
	 *
	 * This is the single most important reliability knob when streaming
	 * with a negotiated 247 B MTU. ATT Write Commands carry no flow
	 * control, so a burst fired back-to-back arrives faster than an
	 * SDK 11-era bootloader can drain it: while it is committing to
	 * flash, its SoftDevice has no free RX buffer and silently discards
	 * whatever lands. Nothing surfaces at the link layer — the loss only
	 * shows up as a missing packet receipt, by which point the peer's
	 * image is already corrupt (it wrote the surviving packets of the
	 * burst into the hole left by the dropped ones).
	 *
	 * Legacy DFU has no in-session resume, so a dropped packet costs a
	 * full restart. Spacing packets out is far cheaper than retrying a
	 * 500 KB transfer. Raise this if a target keeps failing mid-stream.
	 */
	uint16_t pkt_gap_ms;

	/* Pause inserted after the one packet per flash page that makes the
	 * target erase, in milliseconds. 0 disables erase-aware pacing, and
	 * then pkt_gap_ms alone has to be large enough for the worst packet
	 * (measured floor 18 ms, ~12 KB/s).
	 *
	 * With it set, pkt_gap_ms only has to cover the target's flash *write*
	 * rate for the other ~16 packets in the page, so it can be small. That
	 * is where the throughput is: one expensive packet per 4 KB instead of
	 * pricing every packet as if it were the expensive one.
	 */
	uint16_t erase_pause_ms;

	/* Packets allowed into the target's buffer during a page erase before
	 * waiting out the rest of it. 0 stops dead at the boundary.
	 *
	 * The erase pauses are the single biggest cost once the connection
	 * interval is tuned — measured at 44% of a transfer, with the target's
	 * 8-slot ring sitting empty throughout. Overlapping a few packets with
	 * the erase reclaims most of that. Measured, 6 is too many: the ring is
	 * still draining the previous erase, so the failure lands on the second
	 * page and drifts. 2-3 is the usable range.
	 */
	uint8_t  erase_inflight;

	/* ---- MeshCore status messages over LoRa (RAK4631 only) -----------
	 *
	 * See lora_status.h for what is sent and when, and meshcore_grp.h for
	 * the packet. These keys do nothing on a board with no radio.
	 */

	/* Hashtag channel to transmit on, e.g. "#drone-updater". The key is
	 * derived from the name — sha256(name)[0:16] — so this is the whole
	 * configuration: there is no separate secret to distribute.
	 *
	 * ⚠ Empty is the off switch. Nothing is derived, nothing is queued and
	 * the radio is never keyed, which is the right default for the five
	 * boards that have no LoRa and for anyone who has not chosen a channel.
	 *
	 * A leading '#' is added if absent, matching MeshCore's own handling of
	 * a bare region name.
	 */
	char     lora_channel[APP_CONFIG_CHANNEL_MAX];

	/* The "<sender>: " prefix inside each message. Clients split on the
	 * first ": ", so a name containing a colon loses its attribution and
	 * the whole line renders as an unattributed message. */
	char     lora_sender[APP_CONFIG_SENDER_MAX];

	/* Carrier frequency in Hz. config.txt takes MHz — `lora_freq=910.425`
	 * — because that is the unit every MeshCore client displays.
	 *
	 * ⚠ 0 means UNSET, and unset means silent: lora_tx_send() refuses it,
	 * so a device nobody has configured never transmits. There is
	 * deliberately no default, because the right carrier depends on a
	 * region and a mesh that the firmware cannot know. */
	uint32_t lora_freq_hz;

	/* Bandwidth in kHz, as clients show it: 7, 10, 15, 20, 31, 41, 62,
	 * 125, 250 or 500. 62 means 62.5. */
	uint16_t lora_bw_khz;

	/* Spreading factor, 5-12. */
	uint8_t  lora_sf;

	/* Coding-rate denominator, 5-8, for the 4/N MeshCore shows. */
	uint8_t  lora_cr;

	/* TX power in dBm. The RAK4631's SX1262 goes to +22. */
	int8_t   lora_tx_power;

	/* Which events transmit; see the LORA_EVT_* bits in lora_status.h.
	 * config.txt takes a comma-separated list:
	 *   lora_events=target,progress,verify,done
	 * An absent key means all four. `lora_events=` with nothing after it
	 * means none, which is a quieter off switch than clearing the channel.
	 */
	uint8_t  lora_events;

	/* Hard minimum between transmissions, milliseconds. A backstop under
	 * the per-event rules in lora_status.c, so that no combination of
	 * retries and progress edges can monopolise a shared channel. At
	 * SF7/62.5 kHz one message is ~255 ms of air time. */
	uint16_t lora_min_gap_ms;

	/* How many bytes of its own hash each relaying repeater appends to the
	 * packet's path, 1 to 3.
	 *
	 * This is the sender's call and it rides in the packet, so it needs no
	 * agreement with the mesh — MeshCore nodes expose the same thing as
	 * their `hash_mode` CLI setting, where mode N means N+1 bytes.
	 *
	 * 2 by default. One byte is MeshCore's own default and is enough to
	 * route, but it collides often enough that a listener cannot always
	 * say *which* repeater relayed a packet; the second byte buys that
	 * attribution for one extra byte per hop. 4 is reserved by MeshCore
	 * (isValidPathLen) and refused here.
	 */
	uint8_t  lora_path_hash;

	/* Unix seconds at boot, or 0. There is no RTC on this board, so
	 * message timestamps are this plus uptime.
	 *
	 * ⚠ An earlier version of this comment said the messages "still work"
	 * with it left at 0. That was wrong and cost a long debugging session.
	 * MeshCore hashes a packet over its payload alone (Packet.cpp,
	 * calculatePacketHash) and every node suppresses a hash it has already
	 * seen — so with no epoch the boot message, always sent at an uptime of
	 * ~0, was byte-identical every time and delivered exactly once, ever.
	 * It looked like a radio fault and was an identity collision.
	 *
	 * lora_status.c now substitutes a random per-boot base when this is 0,
	 * which restores delivery at the cost of a meaningless displayed date.
	 * Set this to get real timestamps as well; the web client knows the
	 * time and can write it whenever it saves the config.
	 */
	uint32_t lora_epoch;

	/* Transmit one "online" message at boot.
	 *
	 * On the bench this is the whole bring-up test: it proves the channel
	 * name, the key derivation, the modem settings and the antenna in one
	 * shot, with no DFU target and no second board involved. If this lands
	 * in a client, everything downstream of it is a formatting question.
	 *
	 * Left on by default because it is just as useful in flight — it is
	 * the only positive signal that the updater powered up and reached the
	 * mesh, and silence otherwise means "no target found yet", which looks
	 * identical to a device that never booted.
	 */
	bool     lora_hello;
};

/* Reset to compile-time defaults, then overlay whatever config.txt
 * exists on the filesystem. Returns true if config.txt was found +
 * parsed (any subset of keys), false if defaults were used unmodified.
 * Never fails destructively.
 */
bool app_config_load(void);

/* Read-only handle to the currently loaded config. Valid for the
 * lifetime of the process; safe to keep pointers into it.
 */
const struct app_config *app_config_current(void);

#ifdef __cplusplus
}
#endif
