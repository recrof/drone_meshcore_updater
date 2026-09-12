# Add resumable Secure BLE DFU and harden updater reliability

- Add application-only Nordic Secure DFU with CRC-verified resume; retain Legacy
  fallback only when the Secure service is absent.
- Harden package/ZIP validation, target selection, retries, cancellation,
  GATT/thread lifetimes, upload integrity, and Wi-Fi response handling/cleanup.
- Report accepted BLE transfers as `BOOT_UNVERIFIED`; Wi-Fi requires HTTP 200
  confirmation and does not automatically retry.

Secure updates require STORE-only application ZIPs and a target already in DFU
mode; Secure buttonless entry is not supported. See [usage and scope](secure-dfu.md).

Earlier builds were hardware-tested with SWD debugging cables for receiver
control/readback, with controlled cancellation and disconnection to simulate
interrupted updates and verify recovery. Latest hardening has not been hardware-retested.
