# Lifecycle and package follow-up verification

Date: 2026-09-11. Baseline: `a89d6ac`, branch `feature/secure-dfu`.
This record describes the follow-up working tree; no hardware was flashed.

## Changes and regression evidence

- Bounded mode/protocol restarts with a separate `retries` budget, refreshing
  config on every rescan. Normal buttonless entry still works with retries=1;
  counter overflow at retries=255 and lowered budgets are covered.
- Statically initialized the runner lock and joined the previous kernel thread
  before reusing its object/stack. Creation, naming and start are serialized.
  Six new runner negatives failed on the baseline; all 14 runner cases pass.
- Retained Control Point command bytes in GattLink-owned storage and blocked
  write-parameter reuse/reattachment until the host callback retires them. A
  spinlock orders completion publication before a new session can reset it.
  Four original lifetime negatives failed before the fix; eight cases now pass.
- Validated image type/component layout with 64-bit size arithmetic before
  connection and START. Package and both integration tests failed before the
  fix; invalid splits now cause zero connections/writes and valid splits proceed.
- Parsed inspection requests using caller-owned file handles so a DFU starting
  during inspection keeps its streaming archive. Rejected multiple/duplicate
  firmware sections and overflowing/fractional size metadata. Five new negative
  ZIP tests failed before the fix; all 23 ZIP cases now pass, including both
  successful and failed inspection/transfer interleavings.

## Final checks

- Windows GCC 16.1: all 51 aggregated CTest entries pass.
- Linux GCC with AddressSanitizer/UndefinedBehaviorSanitizer: all 51 pass.
- Linux Node 22.23.2: all 28 web test files pass with jsdom and a freshly built
  bundle. Optional staged-artifact/default-build-directory checks remain skipped
  as recorded in the preceding [logic verification](secure-dfu-logic-tests.md).
- Both NCS 3.4.0 Linux XIAO nRF52840 configurations build:

| Configuration | Application flash | RAM |
| --- | ---: | ---: |
| Secure + Legacy | 371,228 B | 120,944 B |
| Legacy only | 367,980 B | 120,624 B |

Application `zephyr.bin` SHA-256:

- Secure + Legacy: `f77e0b75987447b09ec8275c4283ba8167cc9d4490ac7e49ebcff85b9d64b921`
- Legacy only: `ed950d6978debbc6b32379c90426acee5dea57b48ed75a99c472d093ff116129`

Native tests use production modules with deterministic boundary stubs. They do
not replace real scheduler, filesystem-driver or RF qualification. Earlier
hardware evidence applies only to the earlier build identified in its record.
