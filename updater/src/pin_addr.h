#pragma once

/*
 * Split a pinned-target string into the two arguments Zephyr actually takes.
 *
 * ---- The bug this exists to prevent ------------------------------------
 *
 * `bt_addr_le_to_str()` renders one string:
 *
 *     "E9:52:9F:23:87:4A (random)"
 *
 * `bt_addr_le_from_str()` does **not** parse that. It takes the address and
 * the type as *two* arguments, and its first thing is a hard length check —
 * `bt_addr_from_str()` refuses anything that is not exactly 17 characters. So
 * handing it the whole rendered string fails with -EINVAL before the type is
 * even looked at.
 *
 * That shipped once. The scanner sent a device its own rendering back, the
 * parse failed, and the run died as "the scanner could not start" — a message
 * about the radio, for a string-handling mistake, on the one path where the
 * operator had done everything right. It survived a test that asserted both
 * sides *named* bt_addr_le_to_str, which was true and proved nothing.
 *
 * So the split lives here, in a file with no Zephyr dependency, and
 * scanner.test.mjs compiles it on the host and round-trips every form
 * bt_addr_le_to_str can emit through it.
 *
 * ---- What it accepts ----------------------------------------------------
 *
 *   "AA:BB:CC:DD:EE:FF (random)"   -> mac, "(random)"
 *   "AA:BB:CC:DD:EE:FF random"     -> mac, "random"
 *   "AA:BB:CC:DD:EE:FF"            -> mac, "random"
 *
 * The parenthesised form is passed through untouched because
 * bt_addr_le_from_str() accepts both spellings of every type it knows —
 * stripping the brackets here would be a second thing to keep in step for no
 * gain.
 *
 * A bare address defaults to *random*, which is what a Nordic DFU peer
 * advertises with. Guessing is only reached when a client sends something this
 * firmware did not render, and a wrong guess fails as "target not found"
 * rather than as anything dangerous.
 *
 * ---- And the same job for a WiFi BSSID ----------------------------------
 *
 * A pinned WiFi row is an access point, and survey.c renders its BSSID with
 * plain "%02X:%02X:..." — no type, because a BSSID has none. Zephyr's
 * `wifi_connect_req_params.bssid` is six raw octets, so something has to turn
 * one into the other, and that something belongs here for exactly the reason
 * the splitter above does: it is the one place a client's string meets a
 * Zephyr API, it is where Trap 10 happened, and a host test can compile this
 * file and round-trip every form the renderer emits.
 *
 * pin_addr_bssid() is deliberately *stricter* than pin_addr_split(). A pin
 * carrying a trailing address type — "E9:52:9F:23:87:4A (random)" — is a
 * **Bluetooth** row's id, and accepting it would send the WiFi driver hunting
 * for an access point whose BSSID happens to equal a BLE device's address.
 * That fails as "no such network" several seconds later, blaming the radio for
 * a picked-the-wrong-tab mistake. Refusing it up front says what happened.
 */

#include <stddef.h>

/* 0 on success, -22 (-EINVAL) if `pin` holds no 17-character address.
 * `mac` needs 18 bytes; `type` needs 16. */
int pin_addr_split(const char *pin, char *mac, size_t mac_sz,
		   char *type, size_t type_sz);

/* Parse exactly "AA:BB:CC:DD:EE:FF" (either case) into six octets. Surrounding
 * spaces are trimmed; anything else after the address is a refusal, including
 * the "(random)" a Bluetooth id carries. 0 on success, -22 (-EINVAL)
 * otherwise. */
int pin_addr_bssid(const char *pin, unsigned char out[6]);
