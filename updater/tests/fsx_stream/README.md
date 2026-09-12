# Stream upload completion tests

These native tests include the production `fsx_stream.c` GATT handlers with
deterministic OS, filesystem and notification boundaries. They check complete
and empty uploads, truncated/oversized data, short writes, write/close errors,
connection ownership for FINISH/ABORT/DATA, disconnect/abort cleanup, validation
under the session lock, counter bounds and malformed control frames.

Run through `cmake -S updater/tests -B build_logic_test` and CTest, or configure
this directory independently. Driver durability and real BLE scheduling still
need hardware qualification; these tests do not simulate either.
