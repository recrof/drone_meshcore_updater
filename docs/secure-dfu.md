# Nordic Secure DFU

`CONFIG_NORDIC_SECURE_DFU=y` adds a Secure DFU client alongside Legacy DFU.
The updater enables it by default. The existing module/transport identifiers
remain unchanged to preserve configuration and web-client compatibility.

## Using it

1. Put the target into its Secure DFU bootloader. This change does not add
   Secure buttonless entry to an application.
2. Load an **application-only Nordic Secure DFU ZIP**, containing the original
   `manifest.json`, application `.bin` and protobuf init `.dat`. ZIP entries must
   use **STORE**, not DEFLATE (the existing embedded ZIP reader is unchanged).
   A Legacy init packet is not a Secure init packet. An MCUboot/SMP ZIP used to
   update the updater itself is not a target DFU package either.
3. Select the actual bootloader address in the scanner and flash the package.
   Advertising service FE59 now counts as DFU for discovery and post-upload
   verification. Existing address pinning rules are unchanged.
4. If the link drops, retry the same package. The client selects the retained
   command/data objects and compares their reported offset and CRC32 against
   the local files before sending the remaining bytes. Progress starts at the
   verified offset. No phone/web-client protocol change is required.

The new GATT path is tried first. Legacy fallback is allowed **only when FE59
is absent**. A malformed response, wrong package, missing Secure characteristic,
remote error or CRC mismatch must not cause Legacy commands to be sent.

## Scope and safety

- Application images only. No Secure SoftDevice/bootloader or combined-image
  update support, bonded Secure buttonless entry, or multi-part packages.
- `.dat` bytes, including signatures, are forwarded unchanged. The receiver
  authenticates the init command and validates the image. The name “Secure
  DFU” describes Nordic's wire protocol; it does not make an unsigned target
  require signatures or imply that its BLE link is encrypted.
- No reset/abort command is sent on cancellation, timeout or disconnection.
  The updater releases its link; the receiver retains whatever resumable state
  its bootloader supports. A target timeout, reboot or power loss can invalidate
  that state. This client does not promise persistence across resets.
- A mismatching retained command/image CRC is refused rather than silently
  replacing an unrelated pending update. Restart the target's DFU session before
  installing a different package. There is no automatic CRC rollback/retransmit
  within an object in this initial implementation.
- Packet receipts and every completed object are checked for exact offset and
  cumulative CRC32 before Execute. The SDK 15–17 already-executed-object status
  is tolerated only at a matching, non-final data-object boundary. Final success
  requires the actual Execute acknowledgement and target disconnection.
- No image-sized RAM allocation: file reads and prefix CRC calculation use a
  fixed 244-byte buffer. GATT callback objects have static lifetime, matching
  Zephyr's asynchronous ownership requirements.
- The existing transport identifier `ble-legacy-dfu` intentionally still names
  the BLE ZIP transport on the wire, even when it negotiates Secure DFU.

## Native protocol tests

No Zephyr SDK, Bluetooth adapter or hardware is needed:

```sh
cmake -S updater/modules/nordic-legacy-dfu/test -B build_secure_test
cmake --build build_secure_test
ctest --test-dir build_secure_test --output-on-failure
```

The test target models the object protocol and retains state across simulated
disconnections. Cases cover 20/244-byte packets, multiple PRN intervals,
partial command/data objects, object boundaries, a lost Execute reply, invalid
offsets/CRC/responses, remote errors, cancellation and unsupported image types.
Hardware qualification is recorded separately; a model pass alone is not
evidence of successful radio transfer.
See the [XIAO/RAK3401 qualification record](secure-dfu-qualification.md) for
the tested setup, results and remaining coverage limits.

Protocol references: Nordic's [Android Secure DFU client](https://github.com/NordicSemiconductor/Android-DFU-Library/blob/main/lib/dfu/src/main/java/no/nordicsemi/android/dfu/SecureDfuImpl.java)
and [init-packet schema](https://github.com/NordicSemiconductor/pc-nrfutil/blob/master/nordicsemi/dfu/dfu-cc.proto).
