Run from the repository root:

```sh
cmake -S updater/tests -B build/native
cmake --build build/native
ctest --test-dir build/native --output-on-failure
```

Tests compile production sources against deterministic host boundaries. They
complement, but do not replace, hardware validation. On GCC/Clang, sanitizers
can be enabled with CMake's `CMAKE_C_FLAGS` and `CMAKE_CXX_FLAGS`.

Set `DFU_ZIP_PROBE` to the built `firmware_zip/firmware_zip_probe` executable
when running the web ZIP parity test; both implementations then inspect the
same generated archive bytes.
