# Secure DFU qualification — XIAO nRF52840

Date: 2026-09-11. Upstream base: `4789fbf55517ec69b928a40efce3334ef70d6b1e`.
Branch: `feature/secure-dfu`. PR has not been submitted.

The initial qualification below predates the PR safety follow-up. Current
follow-up verification is recorded in [secure-dfu-safety-tests.md](secure-dfu-safety-tests.md).

## Build and host checks

- NCS 3.4.0 on Linux: Secure-enabled XIAO firmware builds; application flash
  368,096 bytes, RAM 120,880 bytes. MCUboot: flash 33,892 bytes, RAM 16,512 bytes.
- The same source builds with `CONFIG_NORDIC_SECURE_DFU=n`; generated Kconfig
  retains Legacy DFU and excludes Secure DFU.
- 41 native object-protocol cases pass on Windows (GCC 16.1) and Linux
  (GCC with AddressSanitizer and UndefinedBehaviorSanitizer).
- Existing web suite: 28 test files pass on Linux with Node 22.23.2.
- Windows native tests are not a Windows Zephyr firmware build.

## Hardware setup and scope

Sender: XIAO nRF52840 running this updater, with packages on its QSPI flash.
Receiver: RAK3401 running the experimental OTAFIX Secure DFU profile
`0x02040704`. It accepts application-only Nordic Secure DFU and retains an
interrupted transfer across BLE disconnects while powered.

The Pi stages a ZIP and issues ordinary SMP commands to the XIAO. The XIAO,
not a Pi DFU client, must perform the receiver transfer. Receiver DFU entry
and independent post-transfer verification use identity-gated SWD.

Test package: STORE-compressed application ZIP, 583,316 bytes. Repacking
preserves the original manifest, protobuf init packet and application bytes.

- ZIP SHA-256: `5521705fd9923a24cd6f012b964b79ce0ae5ad90411edb3d5582cc5f6424f220`
- Application: 582,828 bytes; SHA-256
  `5212fbbfafa579897a604f20e10f976907bb1307c146514e4c23ab6a68a22ca0`

Final sender artifacts:

- Installed application-region image: 438,272 bytes, `0x27000..0x92000`;
  SHA-256 `89c74f4d039975073ab77a6dbd9bb1c533890f6467a5304c9a0f3c13b64fae62`.
- MCUboot application hash reported over SMP:
  `9b09650841f38498e929a925f7a36d0b0a79b6024f7f47511a652c6796e18eb7`.

## Hardware results

Both final-build runs passed with PRN 8, negotiated ATT MTU 247 (244-byte
packets) and a 4 ms packet gap:

| Run | Verified starting offset | Newly sent image bytes | Runner time | Result |
| --- | ---: | ---: | ---: | --- |
| Full transfer | 0 | 582,828 | 69.764 s | PASS |
| Retry after Stop/disconnect | 135,168 | 447,660 | 54.885 s | PASS |

Runner time includes connection/setup and the post-transfer advertising check;
it is not a pure payload-throughput measurement. The interrupted receiver was
not reset or power-cycled. Its retained offset was 23.19% of the image, and
the first upload status on retry reported that same offset. The Secure client
verified its prefix CRC and transmitted only the remainder.

After **each** completed run, direct SWD memory readback matched all 582,828
application bytes and the existing 40 KiB bootloader exactly. These readbacks
did not halt/reset the CPU or run a target-side checksum algorithm. Serial
checks confirmed the expected Companion version, application body hash, saved
name, radio settings and OTA seeder status. This does not claim a byte-for-byte
comparison of the complete filesystem or UICR.

The final sender reports the expected MCUboot application hash, active and
confirmed. A clean reboot was verified during provisioning. Final state:
XIAO idle with `auto_flash=0`, RAK back in its MeshCore application, and the
Pi's ModemManager and MeshCore-to-MQTT services active.

Earlier runs also passed a full transfer and a retry from byte 139,264. The
final runs above were repeated after scoping a Legacy-specific pacing warning
to the Legacy path; their exact sender artifact is recorded above.

## Provisioning notes

These are initial sender-installation issues, not Secure DFU protocol failures:

- The XIAO's retained S140 7.3.0 requires SoftDevice FWID `0x0123`, or the
  application-only wildcard `0xFFFE`. A serial DFU transport acknowledgement
  alone does not prove that the bootloader accepted an incompatible init packet.
- BlueZ can cache the prior application's GATT services under the same address.
  Clear that exact replaced device's stale cache before checking the new service.
- When replacing a different application with the MCUboot merged image, stale
  bytes in the primary-slot trailer can cause `BOOT_EBADVECT` during confirmation.
  The lab application install is padded with erased bytes through `0x92000`,
  clearing that trailer. Its write range is `0x27000..0x92000`; MBR, SoftDevice
  and the recovery bootloader are outside it. The QSPI package store is separate.
- Post-transfer proof uses direct readback, not merely a successful serial
  uploader exit or an OpenOCD process exit. The initial lab checksum helper
  produced errors on a running CPU and was replaced before the final checks.

## Not qualified by these tests

Other sender boards, stock Nordic signed bootloaders, Legacy radio regression,
Secure buttonless entry, SoftDevice/bootloader updates, and recovery across
receiver power loss. A controlled cancellation/reconnect is not a physical
out-of-range test. The receiver used here does not require signatures; passing
this test does not demonstrate signature enforcement. Sender MCUboot/SMP
self-update is a separate path and is not covered by target Secure DFU tests.
