# Hardware follow-up for updater hardening

Date: 2026-09-12. Production source: `9ad8d64`; checkout `676795c` adds documentation only.
This is physical verification of the latest sender, not a restatement of earlier
hardware results or of the 105 native regression entries.

## Fixture and image identity

The XIAO nRF52840 on the MercerWoodMesh Pi performs the actual BLE transfer to
the RAK3401. The Pi only stages packages, issues management commands and uses
the receiver's SWD debugging cables for controlled resets and independent
readback. Both devices are identity-gated before installation/control.

The verified Linux build was installed only at `0x27000..0x92000` on the XIAO,
retaining its recovery bootloader, SoftDevice and external package store. The
active MCUboot image reports confirmed. The 52 checked source files match the
Windows checkout.

- Application `zephyr.bin`: `efcc8177fdedad7c80e39ba2f5d7783778f53c9897f179ead73634109987ef5c`
- Installed primary region: `487ac6441ccd4aab65c44e683321a0463f534a82bef167f5b32b3445f64d52a4`
- Active MCUboot hash: `485386fe9655e45ea17ce65669ae6bdb943407745580c00e6734f0c33e4bb04e`
- Receiver application: 617,216 bytes, SHA-256 `5d0c3cc8fa49bb57cfd451b3c1a434246fb71edf9b5d89a280d952935d99376c`
- Receiver Secure07 bootloader: `92bdbcd57852868a1446ad4fde277b62770d3f6b9f0db506bcb7e6717228d871`
- Temporary Legacy07 bootloader: `826f438b35471dc54b005bbc258eac17a8fec61514286282be3d8d9d5681ec6d`

## Completed physical checks

| Check | Result |
| --- | --- |
| Raw stream upload | Ten cases pass: complete (8,448 bytes), empty, truncated, oversized, owner abort, owner disconnect after ACK, embedded-NUL START, trailing-byte START, malformed FINISH preserving the session, and healthy reuse. Stored bytes are read back; failed partials are absent. |
| Actual storage write failure | During a full-sized stream upload, LittleFS returns `-ENOSPC` at offset 469,944. The board emits ERROR/WRITE_FAILED, retires the session, discards the partial file and remains IDLE; no success or DFU is reported. |
| Full-sized raw stream and recovery | A clean retry streams all 618,019 package bytes with 4,096-byte ACK flow control, reports exact DONE/ACK counts, and passes complete readback and package inspection without rebooting the sender. |
| Malformed ZIP/manifest | Eight cases pass: duplicate/mixed sections, overflowing/fractional SD size, more than 32 preceding entries, wrapping offset, truncated header and out-of-file payload bounds. Every explicit run reports BAD_BUNDLE with attempt/sent/total zero, before target acquisition. |
| Repeated cancellation | Five indefinite-scan stops, three CONNECTING stops and three mid-upload stops pass without rebooting the sender. Observed stop-to-IDLE latency is approximately 46–321 ms. |
| Retained resume | After three upload stops, the final run verifies offset 398,532 and sends only 218,684 remaining bytes. It finishes in 32.868 seconds; neither board was reset between those partial transfers. |
| Receiver reset during upload | An identity-gated SWD reset interrupts the real BLE transfer. The sender observes loss, reacquires the same receiver on attempt two and sends the whole image from offset zero. Completion takes 80.949 seconds. This is restart recovery, not persistence across reset. |
| Inspection while busy | Six public INSPECT requests correctly return busy while a full transfer continues. Completion and independent flash readback pass. This tests the public busy guard, not forced concurrent internal ZIP-handle access. |
| Protocol mismatch | Legacy package to Secure receiver and Secure package to Legacy receiver both report BAD_BUNDLE with zero image bytes sent. Application, bootloader and protected-region readbacks remain unchanged. |
| Legacy fallback | With the known Legacy07 receiver profile, the same sender transfers all 617,216 application bytes on attempt one in 68.563 seconds, reports BOOT_UNVERIFIED, and passes independent application/bootloader/protected-region readback. |
| Independent receiver verification | Complete application and bootloader readbacks match; MBR, SoftDevice, application tail/filesystem, MBR parameters and UICR remain unchanged. These reads do not halt/reset the receiver or execute a target CRC routine. |

Accepted transfers report `DONE / BOOT_UNVERIFIED` (16), as intended. The separate
SWD checks establish image identity; they do not change that protocol verdict.
One full run also recovers normally from an initial connection-establishment
failure. No sender firmware change was required by these completed checks.

## Qualification notes

Two lab-helper assumptions were corrected and retested: the public inspector
refuses active DFU rather than inspecting concurrently, and offset-based
directory enumeration is not a snapshot while logs rotate. The package helper
now retries changing inventories; its original fixtures were verified and
removed, followed by a clean eight-case repeat. These are not claimed as
production-code fixes.

The initial slow SMP staging attempt for the Legacy package was intentionally
stopped by the host before switching to full-sized raw stream qualification;
it was not a target DFU failure.
The full-sized raw-stream attempt encountered `-ENOSPC`. The firmware correctly
returned ERROR/WRITE_FAILED and removed the
partial file. The lab sender reported an ACK timeout because it did not yet
surface queued ERROR notifications; that timeout is not the firmware's verdict.

During temporary Legacy bootloader setup, OpenOCD's RAM flash algorithm timed
out after a plain halt. Readback confined changes to the intended bootloader
region; reset-before-programming recovered the exact Legacy artifact, with
all other flash and UICR unchanged. A subsequent transient SWD parity error
was excluded from qualification; a lower debug clock and fresh readback passed.
These setup failures are not OTA-transfer failures or production-code fixes.

## Final state and evidence

The receiver's original Secure07 bootloader and Companion application are
restored and verified. Serial queries confirm the original application version,
name and radio settings. The latest XIAO image remains active/confirmed and
IDLE, with its original configuration restored byte-for-byte and `auto_flash=0`.
Temporary stream/package fixtures are removed; existing firmware packages are
retained. The Pi's paused MQTT and ModemManager services are returned to their
previous active state. This does not claim end-to-end MQTT service health.

Detailed captures are retained in private lab run `drone-current-hil.GtL6Uk`.
The evidence archive contains JSON and logs, not raw flash/UICR dumps. No
production firmware code was changed, committed or pushed for this follow-up.
Archive SHA-256: `a0846441dfea598b1d1e6d3e7d578d9bd38f83768fbb72ac67269f9a7fac2577`.

## Remaining coverage limits

Wi-Fi hardware verification is pending: the identified XIAO ESP32-S3 is occupied
by a separate memory-soak test and was not interrupted. nRF52840 results do not
exercise the ESP32 Wi-Fi transport.

Precise delayed/silent GATT callbacks, authentication-after-timeout and
thread-exit races, filesystem short-write/close-failure injection, and foreign
stream ownership from two independent centrals remain deterministic native
tests, not physically reproduced cases here. Neither stock signed Secure
targets nor a second matching distractor receiver was qualified. Physical
out-of-range and receiver power-loss resume are not claimed.
