# PR draft: add application-only Nordic Secure BLE DFU

Status: **prepared locally; not pushed or submitted**. Full transfer and
disconnect/resume are verified on the XIAO nRF52840 → RAK3401 test setup.

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

The Secure-enabled XIAO application uses 368,096 bytes of flash and 120,880
bytes of RAM with NCS 3.4.0. Firmware was built on Linux; the Windows check is
the native protocol suite, not a Windows Zephyr build. Other sender boards
and stock Nordic signed receivers have not been hardware-qualified here.

See the [qualification record](secure-dfu-qualification.md): the final build
resumed at byte 135,168 (23.19%), sent only the remaining 447,660 bytes, and
produced an exact application readback. Receiver power loss and physical
out-of-range behavior were not tested in this qualification.
