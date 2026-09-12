#pragma once

/*
 * The one name shared between the ElegantOTA transport and the scanner.
 *
 * MeshCore's firmware brings up this access point when an operator sends it
 * `start ota`; joining it is the whole of how transport_wifi_elegantota.c
 * reaches a target. The scanner marks it in the WiFi list for the same reason,
 * so the two must agree — hence one definition rather than two spellings of a
 * literal that would never be checked against each other.
 */

#define OTA_SSID "MeshCore-OTA"

/*
 * **The access point is always open, and this is not a limitation of ours.**
 *
 * MeshCore raises it with `WiFi.softAP("MeshCore-OTA", NULL)` — a NULL
 * password, which is Arduino's open-network form. There is no setting on the
 * repeater to change it, so an encrypted network is not a MeshCore OTA access
 * point that we happen to be unable to join: it is not one at all, whatever it
 * calls itself.
 *
 * That is why nothing in this project has anywhere to put a WPA passphrase,
 * and why adding one would be the wrong fix for "it will not join that
 * network". `wifi_connect_req_params.security` is therefore
 * `WIFI_SECURITY_TYPE_NONE` on every path and `psk` / `sae_password` are never
 * populated — asserted by scanner.test.mjs, so a passphrase cannot be wired in
 * quietly on the way to solving something else.
 */
