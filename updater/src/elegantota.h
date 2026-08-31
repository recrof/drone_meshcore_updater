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
