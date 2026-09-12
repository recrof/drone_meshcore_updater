# Logic-fix regression verification

Date: 2026-09-11. Branch: `feature/secure-dfu`. Baseline: `dd17cd0`.
No PR submitted. These changes have not been flashed to hardware.

## Fixes and regression evidence

1. Retain the selected peer, transport and bundle throughout a run. Ordinary
   BLE retries are exact-address searches. Only a protocol report authorizing
   a buttonless address change permits the original pin or pin+1, once; a
   subsequent retry cannot drift to pin+2. Same-address jumps and invalid-state
   restarts have a separate internal result; the status wire enum is unchanged.
   Seven tests compile the real runner and BLE transport. All seven fail with
   an isolated original runner and pass with the fix; competing-device cases
   fail at the wrong-target assertion on the original code.
2. Preserve run-wide Stop after the scanner's last semaphore/local-flag reset.
   A later Stop wakes the now-initialized semaphore. The original code reaches
   the test watchdog for an unwoken infinite wait; the fixed code returns
   cancellation. Coverage includes first initialization, reset, lock acquisition,
   local-flag clearing, scan start, waiting, and a Stop racing a match. Fresh
   runs, ordinary timeouts, successful matches and radio release still work.
3. Stop Legacy setup on unresolved MTU timeout, cancellation or disconnect.
   Completed ATT rejection still permits MTU fallback. Both integration
   variants fail the new timeout case before the fix and pass afterward.
   Five MTU scenarios per supported client produce 15 scenario executions
   across Secure-enabled and Legacy-only builds, checking CCC/DFU write counts.
4. Bound ZIP arithmetic by actual file size, enforce STORE size consistency,
   reject unsafe skipped entries, and cap walks at 32 entries. Fix manifest
   end bounds and overflow-safe streaming reads. The initial suite fails
   7/13 cases on the old code; its cycle fixture hits a 10,000-read watchdog.
   The final expanded suite passes all 16 cases, including direct lookup and
   inspector limits, exactly 32 entries, and valid STORE archives.

WiFi currently has no identity-safe reacquisition callback. A failed WiFi
transfer stops after its first attempt; automatic retries cannot safely return
until the transport retains and verifies a physical target identity. A new
user-initiated run may make a new selection.

## Final verification

- Windows GCC 16.1: all 29 CTest entries pass.
- Linux GCC with AddressSanitizer and UndefinedBehaviorSanitizer: all 29 pass.
- CI now configures `updater/tests`, including the new safety suites.
- Linux Node 22.23.2: all 28 web test files pass with jsdom and a freshly
  generated UI bundle. Optional checks requiring staged release artifacts or
  the default `updater/build` directory are skipped; these firmware builds use
  named build directories. No UI source changes were needed.
- Windows web tooling is not qualified by this run: the single-file builder
  cannot launch `npx` directly there, and scanner shell-fixture checks expect
  Unix line endings. The complete web run was performed on Linux instead.
- NCS 3.4.0 Linux XIAO nRF52840 builds both configurations:

| Configuration | Application flash | RAM |
| --- | ---: | ---: |
| Secure + Legacy | 370,596 B | 120,880 B |
| Legacy only | 367,344 B | 120,624 B |

Application `zephyr.bin` SHA-256 values:

- Secure + Legacy: `dc49fe220e0d2bff77a9674d46280816f084cf0fc7b3f0388608c6de20da7b4b`
- Legacy only: `7572b9dbbeade140d8db67b95f25399f58f8f759db4bf8659ff44611840b360f`

The tests compile production code but stub OS, radio, filesystem and other
boundaries. They are not real scheduler, filesystem-driver or RF tests.
Earlier hardware results in the [safety qualification](secure-dfu-safety-tests.md)
remain evidence for that earlier build only, not this revision.
