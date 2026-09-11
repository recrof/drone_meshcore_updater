# PR safety follow-up verification

Date: 2026-09-11. Branch: `feature/secure-dfu`. No PR submitted.

## Scope

1. Package/protocol preflight before destructive DFU commands. Unknown and
   incompatible layouts fail once; no Legacy START or failure-path RESET.
2. Runner-wide cancellation through connection setup, attach and fallback.
3. Explicit accepted-but-boot-unverified outcome; no retry based on silence
   or advertisements, and no green verified-success claim in the web banner.

## Host and build tests

- Windows GCC 16.1: all four CTest executables pass (41 existing Secure object
  cases, package-format checks, Secure-enabled integration, Legacy-only integration).
- Linux GCC with AddressSanitizer and UndefinedBehaviorSanitizer: the same
  four executables pass.
- Integration tests compile the production app adapter, both clients, GATT
  link and BLE verifier. OS, filesystem, Bluetooth and app services (including
  the runner's cancellation source) are stubbed. Mismatched packages produce zero DFU writes. Stop is injected before
  a run, during connect/wait/settle/attach/discovery/fallback; a fresh run still
  works. Timeouts, scan errors, DFU and non-DFU advertisements remain unverified.
- Web: all 28 test files pass under Node 22.23.2, with jsdom and the generated
  single-file bundle. Includes result-enum parity, neutral terminal banner,
  no-retry source contracts and offline-cache digest/version checks.
- NCS 3.4.0 Linux XIAO firmware builds with Secure enabled and disabled:

| Configuration | Application flash | RAM |
| --- | ---: | ---: |
| Secure + Legacy | 369,792 B | 120,880 B |
| Legacy only | 366,556 B | 120,624 B |

Windows verification is native testing, not a Windows Zephyr firmware build.
The deterministic integration tests are not a test of Zephyr's real scheduler.

## Revised sender identity

XIAO nRF52840 USB serial `B35E71C1C3726CE7`, on the MercerWoodMesh Pi.
Application-region install was limited to `0x27000..0x92000`, retaining MBR,
SoftDevice, recovery bootloader and the QSPI package store. The sender booted
with `auto_flash=0`; its active MCUboot image is confirmed.

- Installed region SHA-256:
  `8dae434e6cdb1dbfeddd91bcbded780274e23b7a26970fa6aa6da80fa61e0338`
- Active MCUboot image hash:
  `d848a3b6191911878089e1898e5aa31232148977a83907ffe9c1f9ca6a1707cb`

Receiver/package identities and the independent SWD/serial verification method
are unchanged from the [initial qualification](secure-dfu-qualification.md).

## Hardware results

- Full transfer: 582,828 bytes, first attempt, 66.706 s runner time. Terminal
  status was `DONE / BOOT_UNVERIFIED` (16), not verified success. Independent
  SWD readback matched the application and bootloader exactly, and serial
  queries confirmed the expected running application/version and settings.
- Stop during `CONNECTING`: acknowledged and returned to IDLE, with zero
  image bytes reported. Subsequent identity-gated SWD readback matched the
  entire application and bootloader before resetting for the next test.
- Interrupted upload/resume: Stop was acknowledged around 23%. Without a
  receiver reset, retry verified offset 139,264 and sent only the remaining
  443,564 bytes. Runner time was 53.430 s, first attempt, terminal result 16.
  Independent SWD application/bootloader readback and running-application
  serial checks passed again.
- One initial setup-Stop attempt was discarded: the lab helper read the
  previous run's sticky DONE notification. The helper was corrected to clear
  terminal status, require a new active state and require an actual Stop for
  interruption tests. Only the repeated `review-setup-stop02` run is counted.

The built sender image hash matches the active/confirmed MCUboot hash, and
the Windows working-tree production sources match the Linux build sources.
Final hardware state: sender idle with `auto_flash=0`, receiver running its
original Companion image and settings. ModemManager was restored.

The Pi MQTT relay was restarted but is retrying a device-name query: its
`RealSerialConnection` sends repeater text commands and expects `-> >`, while
the unchanged lab RAK image is Companion firmware. This is outside the updater
PR; no relay configuration or receiver role was changed to hide the mismatch.
This qualification does not claim a healthy MQTT relay.

Unqualified here: stock signed Secure receivers, Legacy RF regression, other
sender boards, physical out-of-range recovery and receiver power loss. Wrong-
protocol refusal and fine-grained callback race injection use native tests;
hardware Stop was exercised during CONNECTING and during an upload.
