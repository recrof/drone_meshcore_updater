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
   Advertising service FE59 now counts as DFU for discovery. Existing address
   pinning rules are unchanged. Advertising is diagnostic, not proof of boot.
4. If the link drops, retry the same package. The client selects the retained
   command/data objects and compares their reported offset and CRC32 against
   the local files before sending the remaining bytes. Progress starts at the
   verified offset. No phone/web-client protocol change is required.

The new GATT path is tried first. Legacy fallback is allowed **only when FE59
is absent**. A malformed response, wrong package, missing Secure characteristic,
remote error or CRC mismatch must not cause Legacy commands to be sent.
Both clients validate the init-packet format before any DFU write. A Secure
package offered to a Legacy target is refused before Legacy START can erase
application flash; the inverse mismatch is refused as well. Unsupported or
ambiguous formats fail once with BAD_BUNDLE, without retries.

## Scope and safety

- Application images only. No Secure SoftDevice/bootloader or combined-image
  update support, bonded Secure buttonless entry, or multi-part packages.
- `.dat` bytes, including signatures, are forwarded unchanged. The receiver
  authenticates the init command and validates the image. The name “Secure
  DFU” describes Nordic's wire protocol; it does not make an unsigned target
  require signatures or imply that its BLE link is encrypted.
- Preflight accepts classic CRC16 and Nordic hash/signed Legacy layouts, and
  unsigned/signed Nordic Secure protobuf application commands. It validates
  envelope structure and Secure application type/size, not cryptographic
  authenticity or board compatibility. Init packets are limited to 512 bytes;
  absent init packets, custom/unknown fields, duplicate singular fields and
  unsupported layouts are refused rather than guessed to be Legacy.
- Stop is latched by the runner until a new run starts. Connection waits,
  GATT attachment, protocol fallback and writes consult that same flag. An
  operation already queued to the controller may finish; Stop prevents the
  following DFU operation and disconnects without clearing Secure resume state.
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

## Transfer accepted versus boot verified

A successful protocol exchange is not proof that the expected application is
running. BLE transfers now finish with `DONE / BOOT_UNVERIFIED` (result 16),
displayed as **Transfer accepted — boot unverified**. Neither silence, a scan
error, an advertisement without DFU, nor FE59 alone identifies the installed
application/version. This terminal outcome does **not** retry or reflash; the
operator should check the target. The sender LED returns to idle rather than
claiming verified success. There is no image-specific BLE boot verifier yet.

Use the matching updated web client (offline cache v23) to see this result's
label. The wire layout and all previous enum values are unchanged.

## Native protocol and safety tests

No Zephyr SDK, Bluetooth adapter or hardware is needed:

```sh
cmake -S updater/tests -B build_safety_test
cmake --build build_safety_test
ctest --test-dir build_safety_test --output-on-failure
```

The test target models the object protocol and retains state across simulated
disconnections. Cases cover 20/244-byte packets, multiple PRN intervals,
partial command/data objects, object boundaries, a lost Execute reply, invalid
offsets/CRC/responses, remote errors, cancellation and unsupported image types.
Hardware qualification is recorded separately; a model pass alone is not
evidence of successful radio transfer.
The same CTest command also runs package preflight tests and both Secure-enabled
and Legacy-only integration builds of the real adapter, clients, GATT link and
BLE verifier against deterministic OS/Bluetooth stubs. They inject Stop during
connection, attach, discovery and fallback, check mismatches produce zero DFU
writes, and exercise uncertain post-upload scan outcomes. These are not radio
or Zephyr scheduler tests.
The aggregated suite also compiles the real runner, BLE reacquisition logic,
scanner, ZIP walker and inspector against deterministic boundaries. It covers
same-device retries, Stop during scanner initialization, pending MTU failures,
and malformed ZIP bounds/loop prevention. See the
[logic-fix verification record](secure-dfu-logic-tests.md).
See the [XIAO/RAK3401 qualification record](secure-dfu-qualification.md) for
the tested setup, results and remaining coverage limits.

Protocol references: Nordic's [Android Secure DFU client](https://github.com/NordicSemiconductor/Android-DFU-Library/blob/main/lib/dfu/src/main/java/no/nordicsemi/android/dfu/SecureDfuImpl.java)
and [init-packet schema](https://github.com/NordicSemiconductor/pc-nrfutil/blob/master/nordicsemi/dfu/dfu-cc.proto).
