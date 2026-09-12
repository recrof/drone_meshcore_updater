# ZIP parser native regression tests

Compiles the production ZIP walker and firmware inspector against a small
in-memory filesystem boundary. No Zephyr SDK or hardware is required.

```sh
cmake -S updater/tests/firmware_zip -B build_zip -G Ninja
cmake --build build_zip
ctest --test-dir build_zip --output-on-failure
```

The 23 cases cover valid STORE archives, a wrapped cursor that previously made
manifest lookup loop forever, oversized headers/payloads, inconsistent STORE
sizes, invalid/truncated terminators, unsupported skipped entries, filename
limits, inspector and lookup entry limits (including exactly 32 entries),
manifest buffer boundaries, ambiguous/duplicate firmware sections, overflow and
non-integer image sizes, and overflow-safe streaming reads. Two interleaving
cases start a DFU after inspection's idle check and verify both successful and
failed inspections leave the transfer archive open and unchanged. Fixture archives
include local headers, a central directory, and an end-of-directory record.

The read-budget assertion makes the old infinite loop fail deterministically.
These are host boundary tests, not hardware or filesystem-driver qualification.
