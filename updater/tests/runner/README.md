# Runner identity and lifecycle regression tests

These tests compile the production `dfu_runner.c`, `transport_ble.c`, and
`pin_addr.c`. Only the Zephyr scheduler, scanner, filesystem, protocol client,
and status/LED boundaries are deterministic stubs; the retry and BLE
reacquisition logic are not copied into the tests.

```sh
cmake -S updater/tests/runner -B build-runner
cmake --build build-runner
ctest --test-dir build-runner --output-on-failure
```

The first seven scenarios cover auto-retry with another matching board present,
buttonless address transition followed by exact retry, explicit pin/+1 without
address drift, original target disappearance, identity-unsafe transport retry
refusal, exact protocol restart, and transport selection retention. Scans use
the infinite configured budget except for the disappearance test.

Seven more cover bounded protocol restarts, bounded buttonless loops, config
reload during attempt-zero restarts, thread-storage reuse, a normal buttonless
update with `retries=1`, the `retries=255` counter boundary, and lowering the
restart budget while running. The thread stub leaves kernel termination pending
after the worker entry returns; a second creation fails unless the runner joins
the previous thread first.

The resource-cleanup fixture compiles the same production runner with a
resource-owning transport. Ten cases cover mapping/open failures, cancellation
after find and find_same, successful transfer, payload-kind mismatch, failed and
cancelled transfers, failed acquisition, and failure before discovery. Every
successful acquisition must be released exactly once; failed acquisition must
not release an unowned target. Per-acquisition tokens catch stale-target cleanup.
This also protects future transports whose find_same holds resources, without
enabling unsafe WiFi retries.

WiFi currently has no identity-safe `find_same` implementation. A failed WiFi
transfer therefore stops after its first attempt instead of associating with
an arbitrary same-SSID repeater and sending the retained image there. Adding
WiFi retries requires retaining and verifying a physical peer identity first.

For red/green qualification, `DFU_RUNNER_SOURCE` may point at an isolated
pre-fix copy. The first seven scenarios fail against the original `dd17cd0` runner;
the auto-retry/buttonless/disappearance cases fail at the wrong-target assertion.
Before the lifecycle fix, six new regression cases failed against `a89d6ac`:
unbounded restart cases reached the test's 300-operation safety limit, config
remained stale, and thread reuse occurred before kernel termination. The normal
single-buttonless test already passed and protects that supported flow.
Before the cleanup fix, the map/open/cancel-find/cancel-refind cases failed with
the transport still associated after the runner returned; the other six cleanup
cases already passed and protect against double-release and unowned cleanup.
