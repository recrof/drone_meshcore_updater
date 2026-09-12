# PR draft: add application-only Nordic Secure BLE DFU

Status: **prepared locally; not pushed or submitted**. Earlier builds verified
full transfer and disconnect/resume on XIAO nRF52840 → RAK3401. The latest
reliability fixes have software/build verification but have not been flashed.

## Summary

- Add an independently testable Secure object-protocol client with streaming
  CRC32, init/data object selection, PRNs and verified-offset resume.
- Detect Secure GATT before Legacy. Preserve Legacy fallback only when FE59
  is absent; never issue Legacy RESET after a Secure error.
- Recognize FE59 advertisements for target discovery and verification.
- Preserve asynchronous GATT callback storage, reject stale callbacks from
  other connections, and reject overflowing Secure notification responses.
- Document package requirements, application-only scope and the distinction
  between the Secure protocol and a target's signature-enforcement policy.
- Reject incompatible/unknown init packets before destructive DFU commands;
  verify Secure .dat application type and size, not just manifest labels.
- Preserve run-wide Stop through connection setup, attach and protocol fallback.
- Report accepted transfers as boot-unverified unless the expected application
  is positively verified; never reflash based only on advertising or silence.
- Add native integration tests for both protocol configurations and update the
  status display, wire result mapping and offline web cache together.
- Retain the selected target and transport across retries; allow only one
  protocol-authorized application/bootloader address transition. Stop unsafe
  WiFi retries until that transport supports identity-safe reacquisition.
- Preserve Stop across scanner initialization, abort Legacy setup on pending
  MTU failures, and reject ZIP offset overflow, invalid bounds and entry loops.
- Bound protocol restart loops and join the previous worker before reusing its
  storage. Retain ATT command bytes/parameters until their completion callback.
- Isolate inspection from the active transfer file handle; reject ambiguous
  manifests and invalid component sizes before connecting or issuing START.
- Track CCC request ownership independently from subscription-list membership,
  retaining safe recovery after callback-less unsubscribe errors.
- Reject incomplete/failed uploads and foreign session controls; release every
  acquired target on Stop and bundle errors. Require a complete WiFi response
  before claiming acceptance, and handle fragmented HTTP responses safely.

## Verification checklist

- [x] Windows native protocol tests: 41 cases.
- [x] Linux ASan/UBSan protocol tests: 41 cases.
- [x] Existing web suite: 28 suites passed with Node 22 and generated UI bundle.
- [x] Final Linux XIAO nRF52840 firmware build; flash/RAM fit and image-address checks.
- [x] Rebuild and sanitize the final revised source and 41-case suite.
- [x] Final Linux build with Secure DFU disabled; generated configuration
  confirmed Legacy enabled and Secure disabled.
- [x] XIAO-to-RAK3401 full Secure BLE transfer.
- [x] Deliberate interrupted transfer and verified-offset resume using the XIAO.
- [x] Post-transfer target application verification and final idle state.
- [x] Safety follow-up: four native test executables on Windows and Linux
  (Linux ASan/UBSan), plus all 28 web test files and both Linux firmware configurations.
- [x] Revised hardware: full transfer, Stop during CONNECTING with unchanged
  flash, interruption and CRC-verified resume from byte 139,264; independent
  application/bootloader readbacks and running-application checks passed.

The latest reliability build uses 372,184 bytes of flash and 121,008 bytes of RAM
on nRF52840 with NCS 3.4.0. All 105 aggregated native tests pass on Windows and
Linux (ASan/UBSan), both nRF52840 configurations and ESP32-S3/WiFi build, and all
28 Linux web test files pass (optional release-artifact checks remain skipped).
These latest fixes have not been flashed or hardware-qualified;
the hardware results above apply to the preceding safety-follow-up build.
See the [transport reliability record](secure-dfu-transport-tests.md) and preceding
[lifecycle-fix record](secure-dfu-lifecycle-tests.md). Windows verification is
native testing, not a Windows Zephyr build. Other sender boards and stock
Nordic signed receivers have not been hardware-qualified here.

See the [qualification record](secure-dfu-qualification.md): the final build
resumed at byte 135,168 (23.19%), sent only the remaining 447,660 bytes, and
produced an exact application readback. Receiver power loss and physical
out-of-range behavior were not tested in this qualification.

The [safety follow-up record](secure-dfu-safety-tests.md) supersedes the initial
build identity and records the additional package, cancellation and verification
regressions. Its BLE terminal result is deliberately `BOOT_UNVERIFIED`; independent
hardware readback/serial checks supply the positive evidence of application boot.
