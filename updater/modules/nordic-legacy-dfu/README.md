# Nordic Legacy DFU client for Zephyr

A C++ implementation of Nordic's **Legacy DFU** protocol (nRF5 SDK 4.3 – 11)
for Zephyr, ported directly from the Android DFU Library in this repository.

The goal is behavioural equivalence with the nRF Connect / DFU app: the same
op-code sequence, the same fallback chain, the same flow control, and the same
failure handling. Where the Java could not be followed literally, the
difference is listed under [Deviations](#deviations-from-the-java) — there are
five, and all of them are transport-level.

Secure DFU and the SDK 12+ buttonless services are **not** implemented. Legacy
buttonless (the `[0x01, 0x04]` jump on the legacy control point) **is**.

## Scope

Protocol only. Scanning, connecting and reconnecting stay with the
application — pass in a connected `bt_conn`. In the Java library those live in
`DfuBaseService` because it also owns bonding and the bootloader scan; neither
belongs in a Zephyr library, and both are things a specific product wants to
control.

## Source mapping

| This module | Android DFU Library |
| --- | --- |
| `LegacyDfuClient::run()` | `LegacyDfuImpl.performDfu()` |
| `Session::open()` | `DfuServiceProvider.getServiceImpl()`, legacy subset |
| `Session::jump_to_bootloader()` | `LegacyButtonlessDfuImpl.performDfu()` |
| `Session::start_dfu()` | the Start DFU try/catch chain in `performDfu()` |
| `Session::upload_firmware()` | `BaseCustomDfuImpl.uploadFirmwareImage()` + its GATT callbacks |
| `Session::write_op_code()` | `BaseDfuImpl.writeOpCode()` |
| `Session::read_notification_response()` | `BaseDfuImpl.readNotificationResponse()` + `LegacyDfuImpl.getStatusCode()` |
| `internal::GattLink` | `BaseDfuImpl`'s lock, flags and `BluetoothGattCallback` |
| `Result` / `remote_status_str()` | `DfuBaseService.ERROR_*` / `LegacyDfuError` |

## Using it

```cpp
#include "nordic_dfu/legacy_dfu.hpp"

using namespace nordic::dfu;

MemoryStream image(fw_bytes, fw_len);
MemoryStream init_packet(dat_bytes, dat_len);   // the .dat from the ZIP

Firmware firmware;
firmware.type        = IMAGE_APPLICATION;
firmware.image       = &image;
firmware.init_packet = &init_packet;

Parameters params;                              // defaults mirror DfuServiceInitiator
LegacyDfuClient client;

Report report = client.run(conn, firmware, params);
```

`run()` blocks for the whole transfer. Call it from your own thread or a
workqueue — never from the Bluetooth RX thread or from a GATT callback.

### Driving the result

A complete update can take more than one connection, exactly as it does on
Android, where `DfuBaseService` restarts itself. The caller reconnects and
calls `run()` again:

| `Result` | What to do |
| --- | --- |
| `Success` | Done. The target rebooted into the new image. |
| `JumpedToBootloader` | The peer was an application. Rescan and reconnect to the bootloader, then `run()` again. Check `Report::address_may_change`: an SDK 6.1 target advertises at *address + 1*. |
| `ApplicationPending` | The SoftDevice/Bootloader went over, but the target refused to take the application in the same connection. Reconnect and `run()` again with `IMAGE_APPLICATION` alone. |
| `RestartRequired` | The target reported `INVALID STATE` — an earlier upload was interrupted. A Reset was sent; reconnect and `run()` again. |
| anything else | Terminal for this attempt. `Report::remote` holds the target's status byte when the result is `RemoteError`. |

### Firmware sources

`Stream` is the byte source. `MemoryStream` covers RAM and memory-mapped
flash; implement the interface yourself for a filesystem or an external chip.
`ConcatStream` presents a SoftDevice and a Bootloader as the one contiguous
image the protocol expects, with the sizes announced separately:

```cpp
ConcatStream combined(&softdevice, &bootloader);

Firmware firmware;
firmware.type            = IMAGE_SOFT_DEVICE_BOOTLOADER | IMAGE_APPLICATION;
firmware.image           = &combined;
firmware.softdevice_size = softdevice.size();
firmware.bootloader_size = bootloader.size();
firmware.application_size = 0;
```

There is no ZIP or Intel-HEX parsing here — `ArchiveInputStream` and
`HexInputStream` have no place on a target that may not have a filesystem.
Unpack the distribution ZIP wherever it makes sense for your product and hand
the client the `.bin` and `.dat` contents.

## The protocol, as implemented

```
                    Control Point (0x1531)          Packet (0x1532)
  discover + read DFU Version (0x1534)
  exchange MTU, enable notifications

  version == 1, or version == 0 with >3 services:
      [01 04]  ────────────────────────────►      (target reboots)

  otherwise, bootloader mode:
      [01 <type>] ─────────────────────────►
                                                   sd/bl/app sizes, 3× u32le ──►
      ◄──────────────────────── [10 01 <status>]
      [02 00] ─────────────────────────────►
                                                   init packet, MTU-sized ──►
      [02 01] ─────────────────────────────►
      ◄──────────────────────── [10 02 <status>]
      [08 <prn u16le>] ────────────────────►      (no response)
      [03] ────────────────────────────────►
                                                   firmware, MTU-sized ──►
      ◄──────────────────────── [11 <received u32le>]   every <prn> packets
      ◄──────────────────────── [10 03 <status>]
      [04] ────────────────────────────────►
      ◄──────────────────────── [10 04 <status>]
      [05] ────────────────────────────────►      (target reboots)
```

### Flow control

One packet write is outstanding at a time. The next is written only once the
host reports the previous one as sent — unless a Packet Receipt Notification
is due, in which case the client waits for that instead. This is exactly what
Android does by writing the next packet from `onCharacteristicWrite`, and it
is what stops a fast central from overrunning the target.

The receipt-due check happens **before** the end-of-image check, so a final
packet that lands on a receipt boundary is acknowledged before the upload is
considered complete. The Java does the same, in that order.

The client does **not** compare the receipt's byte count against what it sent,
and does not retransmit. Neither does the Java: Legacy DFU has no per-packet
acknowledgement, so a gap in the middle of a burst is indistinguishable from a
gap at the end, and "resuming" from the reported offset writes good data past
already-corrupt flash. A loss shows up as `OPERATION FAILED` from
`Receive Firmware Image` or as a validation failure, and the fix is to restart
the whole image with a lower `packets_before_notification`.

## Deviations from the Java

1. **Exceptions.** Zephyr builds with `-fno-exceptions`, so each step returns a
   `Failure` and the driver short-circuits on the first one. Same control flow,
   no `throw`.
2. **`-ENOMEM` on a packet write.** Android's stack queues the write and never
   refuses; Zephyr returns `-ENOMEM` when no TX buffer is free. The client
   retries (`CONFIG_NORDIC_LEGACY_DFU_TX_RETRY_COUNT` times, 5 ms apart) rather
   than failing the transfer.
3. **MTU.** `bt_gatt_exchange_mtu()` offers `CONFIG_BT_L2CAP_TX_MTU`; there is
   no per-request MTU as with Android's `requestMtu(int)`. `Parameters::mtu` is
   therefore only a switch for whether to do the exchange at all. Payload per
   packet is `min(ATT_MTU - 3, CONFIG_NORDIC_LEGACY_DFU_MAX_PACKET_SIZE)`.
4. **Timeouts.** The Java blocks indefinitely on every response, relying on the
   user to cancel. `Parameters::operation_timeout_ms` defaults to `0`, which is
   the same behaviour; set it if a headless device should fail rather than
   hang. GATT-level operations (discovery, subscribe, read, single write
   completion) do use `CONFIG_NORDIC_LEGACY_DFU_GATT_TIMEOUT_MS`.
5. **Reset on a file error.** The Java sends `Reset` on a remote error, an
   invalid response and an abort, but lets a file-read failure fall through to
   `DfuBaseService` without one — the next attempt then gets `INVALID STATE`
   and recovers through `resetAndRestart`. This client sends `Reset` in that
   case too, reaching the same end state one connection earlier.
6. **Image size when the application bit is dropped.** When a target answers
   `NOT SUPPORTED` to a combined (SD/BL)+App update, `LegacyDfuImpl` calls
   `ArchiveInputStream.setContentType()` — which stops the stream yielding the
   application — but never updates `mImageSizeInBytes` to match. The Java then
   keeps reading past the end of its own stream, `writePacket()` is handed
   `size == -1` and returns without writing or notifying, and the upload stalls
   until the link drops. This client truncates the image to
   `softdevice_size + bootloader_size` at that point, which is what the Java
   meant to do.

Everything else — the order of operations, the `NOT_SUPPORTED` fallback chain,
the DFU v.1 downgrade, the PRN clamp for pre-SDK-7 bootloaders, the
`INVALID STATE` reset, the version-5 init packet requirement, the `Reset`
before terminating, and not disconnecting after `Activate and Reset` — follows
the Java.

## Configuration

| Kconfig | Default | |
| --- | --- | --- |
| `NORDIC_LEGACY_DFU` | `n` | Enable the client. Needs `BT_CENTRAL` and `BT_GATT_CLIENT`. |
| `NORDIC_LEGACY_DFU_MAX_PACKET_SIZE` | `20` | Upper bound on the Packet write payload, and the size of the client's static buffer. 20 matches every legacy bootloader: DFU before SDK 14.1 only supports an ATT MTU of 23. |
| `NORDIC_LEGACY_DFU_GATT_TIMEOUT_MS` | `15000` | Discovery, subscribe, read, single write completion. |
| `NORDIC_LEGACY_DFU_TX_RETRY_COUNT` | `200` | Retries when no TX buffer is available. |
| `NORDIC_LEGACY_DFU_TX_RETRY_DELAY_MS` | `5` | Delay between those retries. |
| `NORDIC_LEGACY_DFU_LOG_LEVEL` | `INF` | Log module `nordic_dfu`. |

`Parameters` carries the per-run settings that `DfuServiceInitiator` carries on
Android: `packets_before_notification` (12, as
`DfuServiceInitiator.DEFAULT_PRN_VALUE`), `mtu`, `assume_dfu_mode`
(`setForceDfu()`), `operation_timeout_ms` and `reset_timeout_ms`.

## Building

This lives in the workspace at `updater/modules/nordic-legacy-dfu/` and is
already wired into `updater/CMakeLists.txt`:

```cmake
list(APPEND ZEPHYR_EXTRA_MODULES ${CMAKE_CURRENT_SOURCE_DIR}/modules/nordic-legacy-dfu)
```

`updater/prj.conf` turns it on with `CONFIG_NORDIC_LEGACY_DFU=y` and sets
`CONFIG_NORDIC_LEGACY_DFU_MAX_PACKET_SIZE=244` to match the ATT MTU 247 the
app already negotiates. Note that the app's `project()` needs `CXX` in its
`LANGUAGES` list.

The sample builds on its own against any workspace:

```
west build -b <board> modules/nordic-legacy-dfu/samples/legacy_dfu -- \
    -DZEPHYR_EXTRA_MODULES=$PWD/updater/modules/nordic-legacy-dfu
```

The sample scans for a peer advertising the Legacy DFU service, connects, and
runs the client, handling all four continuation results. It needs
`CONFIG_CPP=y`; C++17 is used but nothing beyond C++11 is required of the
library itself, and no exceptions, RTTI, heap or standard library.

Compiled size on Cortex-M4, `-Os`: about 9 KB of text, 29 bytes of BSS, plus
`NORDIC_LEGACY_DFU_MAX_PACKET_SIZE` bytes of stack for the session buffer.
