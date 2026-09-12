# WiFi HTTP regression tests

The fixture includes the production `transport_wifi_elegantota.c` unchanged and
links the real MD5 implementation. Zephyr HTTP/socket/radio and filesystem calls
are deterministic stubs; the transport callback, status parser, upload loop, and
result mapping are the actual firmware code.

```sh
cmake -S updater/tests/wifi_http -B build-wifi-http
cmake --build build-wifi-http
ctest --test-dir build-wifi-http --output-on-failure
```

Fifteen cases cover every split boundary in the identity body and HTTP status
line, non-NUL body fragments with poisoned bytes outside their declared span,
HTTP identity errors, overlong/missing identities, oversized bodies, response
timeout/EOF/reset, malformed/oversized/rejected status lines, short firmware
reads, and normal success. Socket/file handles must close on every tested exit.

Before the fix, eleven cases failed against the actual transport. Four controls
(malformed/oversized/500 status and normal success) already passed. The old source
also needed `-Wno-error=pointer-sign` solely for its unsigned HTTP body pointer
passed to `strstr`; the fixed source passes all warnings as errors.

`WIFI_TRANSPORT_SOURCE` can select an isolated pre-fix source for qualification.
HTTP 200 still confirms acceptance, not a separately verified application boot.
Missing acknowledgement yields timeout/disconnection, never accepted/unverified
success. Identity parsing deliberately accepts AsyncElegantOTA's flat plain-string
object; malformed or escaped identity data fails closed instead of changing the
target-to-firmware mapping through truncation.

Six acquisition-lifecycle cases also exercise the actual `wifi_find`: Stop while
connecting, Stop during DHCP, pending-connect timeout, identity failure, normal
release, and Stop immediately before transport entry. Before the cleanup change,
the first three leaked the driver-owned association, and the last lost Stop;
identity failure and normal release already passed. The fixture distinguishes
driver ownership from the transport's connected-event flag, matching the ESP32
driver's separate CONNECTING state. Failed find self-cleans; successful find
passes ownership to the runner. Disconnect refusal is logged, not silently lost.
