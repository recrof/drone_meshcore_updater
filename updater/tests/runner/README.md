# Runner identity regression tests

These tests compile the production `dfu_runner.c`, `transport_ble.c`, and
`pin_addr.c`. Only the Zephyr scheduler, scanner, filesystem, protocol client,
and status/LED boundaries are deterministic stubs; the retry and BLE
reacquisition logic are not copied into the tests.

```sh
cmake -S updater/tests/runner -B build-runner
cmake --build build-runner
ctest --test-dir build-runner --output-on-failure
```

The seven scenarios cover auto-retry with another matching board present,
buttonless address transition followed by exact retry, explicit pin/+1 without
address drift, original target disappearance, identity-unsafe transport retry
refusal, exact protocol restart, and transport selection retention. Scans use
the infinite configured budget except for the disappearance test.

WiFi currently has no identity-safe `find_same` implementation. A failed WiFi
transfer therefore stops after its first attempt instead of associating with
an arbitrary same-SSID repeater and sending the retained image there. Adding
WiFi retries requires retaining and verifying a physical peer identity first.

For red/green qualification, `DFU_RUNNER_SOURCE` may point at an isolated
pre-fix copy. All seven scenarios fail against the original `dd17cd0` runner;
the auto-retry/buttonless/disappearance cases fail at the wrong-target assertion.
