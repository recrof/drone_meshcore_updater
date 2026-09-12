# Transport and upload reliability follow-up

Date: 2026-09-11 (local). Baseline: `a89d6ac`, branch `feature/secure-dfu`.
This follow-up includes the
preceding [lifecycle fixes](secure-dfu-lifecycle-tests.md). No hardware was
flashed and no changes were pushed as part of this verification.

## Changes

- WiFi accepts an upload only after a complete HTTP 200 status line. A timeout,
  EOF or socket error leaves acceptance unconfirmed and reports a transport
  failure; it does not claim `BOOT_UNVERIFIED` acceptance. WiFi still cannot
  automatically retry without identity-safe reacquisition.
- HTTP status lines and identity bodies accumulate across arbitrary receive
  boundaries with fixed bounds. Identity requires a complete HTTP 200 body and
  an unambiguous, non-truncated name. The supported JSON shape is the flat
  plain-string object emitted by AsyncElegantOTA; malformed/escaped names fail
  closed. Early payload EOF cannot be reported as a complete upload.
- Every successful target acquisition is released exactly once, including
  Stop, failed automatic mapping and failure to open the mapped bundle.
  Failed WiFi acquisition cancels both active and pending connections, even
  before the driver's connect/DHCP event. Stop just before transport entry
  survives the local cancellation-hint reset.
- The upload service checks session ownership while holding its mutex, rejects
  excess/short writes, validates the final byte count, and checks file-close
  errors. Failed, cancelled and disconnected uploads are discarded (unlink
  failures are logged). Only a complete, successfully closed file can report
  completion. Empty files remain supported.
- GATT list membership and outstanding CCC requests have separate ownership.
  Delayed unsubscribe callbacks cannot complete a new subscription. A retained
  connection reference identifies the previous owner across detach. The pinned
  NCS 3.4 host can omit both callbacks on an unsubscribe error; the actual
  matching-peer disconnect callback follows ATT/GATT cleanup and safely releases
  the slot. A live library caller may need to reconnect, not reboot the updater.
  SDK upgrades must requalify this cleanup ordering.

## Regression evidence

Native tests compile the production runner, upload handlers, WiFi transport and
GattLink with deterministic OS/filesystem/radio boundaries. Before the fixes:

- Four new runner cleanup cases failed; six cleanup controls passed.
- Eleven HTTP cases failed; four rejection/success controls passed.
- Four failed-acquisition/early-Stop cases failed; identity-failure and normal
  release controls passed. All 21 WiFi HTTP/acquisition cases now pass.
- Five new CCC lifetime cases failed.
- Upload truncation, short write, close failure, oversize data and foreign
  FINISH/ABORT tests failed; complete/empty and foreign DATA controls passed.

The web source guards now check CCC ownership and safe disconnect recovery,
instead of requiring the old forced-reuse behavior. Native tests exercise the
actual callback interleavings; source guards are supplemental.

## Final verification

- Windows GCC 16.1: all 105 aggregated CTest entries pass.
- Linux GCC with AddressSanitizer/UndefinedBehaviorSanitizer: all 105 pass.
- Linux Node 22.23.2: all 28 web test files pass, with jsdom and a freshly
  generated UI bundle. Four optional staged-artifact/default-build-directory
  checks remain skipped; release staging was not performed.
- All three firmware configurations below build. The 52 changed/new updater
  and web files checked by SHA-256 match between Windows and the Linux builder.
- `git diff --check` passes.

| XIAO nRF52840 configuration | Application flash | RAM |
| --- | ---: | ---: |
| Secure + Legacy | 372,184 B | 121,008 B |
| Legacy only | 368,900 B | 120,688 B |

XIAO ESP32-S3 Secure+Legacy/WiFi build: FLASH 821,112 B;
`iram0_0_seg` 66,592 B; `dram0_0_seg` 256,848 B; external DRAM 1,793,280 B.
These are linker-region figures, not a runtime free-memory measurement.

Application `zephyr.bin` SHA-256:

- nRF52840 Secure + Legacy: `efcc8177fdedad7c80e39ba2f5d7783778f53c9897f179ead73634109987ef5c`
- nRF52840 Legacy only: `641b57839be8a680971676e0773c9baa7782267dc9b9c54c2db856c4fa31087b`
- ESP32-S3: `b63288b85f0b4085337088fdc490036bc8d2ac6a7d6759a07c2bd66baae3bc39`

## Verification scope

Windows verification is native testing, not a Windows Zephyr firmware build.
Linux firmware targets are XIAO nRF52840 with Secure+Legacy, the same board with
Secure disabled, and XIAO ESP32-S3 with WiFi and both BLE protocols enabled.
NCS is pinned to 3.4.0; ESP32 uses Zephyr SDK 1.0.1 and esptool 5.4.0.

No physical BLE/WiFi transfer, filesystem fault injection, or scheduler stress
test was performed for this follow-up. Earlier hardware evidence applies only
to the builds identified in those records.
