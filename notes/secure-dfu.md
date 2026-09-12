# Opt-in Nordic Secure DFU

`CONFIG_NORDIC_SECURE_DFU` defaults off. To enable it for a qualified board,
add `CONFIG_NORDIC_SECURE_DFU=y` to that board's application configuration,
or pass `-Dupdater_CONFIG_NORDIC_SECURE_DFU=y` to a sysbuild configuration.
No board is enabled automatically by this change.

Measured with NCS 3.4 on `xiao_ble/nrf52840`: the hardening-only application
uses 366,640 flash bytes; this client uses 368,128 with Secure off and 371,848
with it on (of 388,970). Enabling the engine adds 3,720 flash and 320 RAM
bytes. The off build still carries 1,488 bytes of package-classification and
validation overhead compared with hardening alone. These are build results,
not hardware qualification or a budget for other boards.

Put the target into its Secure DFU bootloader and select its address in the
scanner (or configure a specific name filter). FE59 alone is not proof that
an advertiser is a bootloader: buttonless applications also use it. The
unfiltered automatic scan continues to require the Legacy DFU service.

Use an application-only Nordic Secure DFU ZIP with its original manifest,
binary and protobuf init packet. ZIP entries must be STORE-only, at most 32,
with names shorter than 64 UTF-8 bytes. The package selects the protocol:
a Legacy package never incurs a Secure discovery attempt, and a Secure
failure never falls through to destructive Legacy commands.

Retry the same package after a disconnection. Matching retained data resumes
at its CRC-verified offset. A mismatching init object is recreated. A
mismatching unexecuted data object is recreated from the last executed
boundary, and that rollback offset and prefix CRC are checked before any
replacement bytes are sent. A committed prefix that still disagrees is
refused. Starting a different package does not require a phone to clear the
old init object.

The accepted Secure transfer reports `BOOT_UNVERIFIED`: the protocol cannot
identify the running application/version. The browser presents this as a
warning, not verified boot, and does not automatically retry it. Existing
Legacy rejection detection and Wi-Fi completion/retry policy are unchanged.

Secure buttonless entry, Secure bootloader/SoftDevice updates and multi-stage
updates are not implemented. Init packet signatures pass through unchanged;
the receiver is responsible for authentication. The protocol name does not
make an unsigned receiver require signed firmware. Resume persistence across
target reset or power loss depends on the receiver and is not promised here.

Run `cmake -S updater/tests -B build/native`, `cmake --build build/native`,
and `ctest --test-dir build/native --output-on-failure`. Use `ctest -N` for the
current test inventory. The earlier combined PR's hardware results do not
qualify the new CREATE recovery and split changes; fresh hardware testing is
still required before enabling a board by default.
