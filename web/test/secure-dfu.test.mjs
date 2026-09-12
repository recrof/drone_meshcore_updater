import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { RESULT, STATE, parseDfuStatus, HEADER_LEN, PAYLOAD_VERSION } from "../js/lib/dfu-status.js";

const root = new URL("../../", import.meta.url);
const read = path => readFileSync(new URL(path, root), "utf8");
const option = read("updater/modules/nordic-legacy-dfu/Kconfig")
  .split("config NORDIC_SECURE_DFU")[1]?.split("\nconfig ")[0];
assert.ok(option, "Secure option is declared");
assert.match(option, /default n/);
assert.doesNotMatch(read("updater/prj.conf"), /^CONFIG_NORDIC_SECURE_DFU=y/m);
const scanner = read("updater/src/ble_scanner.h");
assert.match(scanner, /bool\s+legacy_dfu_uuid;/);
assert.match(scanner, /bool\s+secure_dfu_uuid;/);
const css = read("web/css/layout.css");
assert.match(css, /\.dfu-banner\.unverified\s*\{[^}]*background:[^}]*var\(--warn\)/);
assert.match(css, /\.dfu-banner\.unverified \.dfu-result\s*\{[^}]*var\(--warn\)/);
const bytes = new Uint8Array(HEADER_LEN);
bytes[0] = PAYLOAD_VERSION;
bytes[1] = STATE.DONE;
bytes[3] = RESULT.BOOT_UNVERIFIED;
const status = parseDfuStatus(bytes);
assert.equal(status.bootUnverified, true);
assert.match(status.stateLabel, /boot unverified/i);
assert.equal(status.active, false);
console.log("Secure opt-in configuration, UUID distinction and warning presentation pass.");
