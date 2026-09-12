# GATT operation lifetime tests

This suite compiles the production `GattLink`. The Bluetooth boundary holds a
write's parameter and data pointers until an explicit completion, as Zephyr may
do when a request times out locally or is retried after authentication.

It covers caller-buffer reuse after timeout, cancellation, and reset; rejection
of a second command or attachment while the host still owns the first request;
late success/error completion after detach; immediate queue failure recovery;
and Control Point command-length bounds.

The CCC cases additionally model `sdk-zephyr` **ncs-v3.4.0** subscription
boundaries: last-subscriber removal precedes the disable reply, successful
disable calls `notify(NULL)` before `subscribe`, and a failed disable with no
remaining subscription list calls neither callback. They verify that a delayed
disable cannot complete a new enable, including the gap between the two success
callbacks; enable errors/timeouts and disconnects preserve parameter ownership;
immediate disable failure and synchronous removal recover safely; and a silent
disable error requires the old peer's real disconnect before reuse. An unrelated
peer's disconnect cannot release the owner. Reference counts check that the old
connection stays identifiable across detach and is released after cleanup.

The disconnect boundary follows the pinned host order: `conn.c` calls
`bt_l2cap_disconnected()` before the public connection callback; `att.c` retires
ATT requests and calls `bt_gatt_disconnected()`, which removes volatile
subscriptions. Tests do not substitute a local connection-state change for that
cleanup fence. A library caller retrying `detect()`/`run()` on a still-connected
peer may receive `-EBUSY` and must wait or reconnect; a missing host unsubscribe
callback does not require rebooting the updater.

```sh
cmake -S updater/tests/gatt_lifetime -B build-gatt-lifetime
cmake --build build-gatt-lifetime
ctest --test-dir build-gatt-lifetime --output-on-failure
```

The initial timeout-data, pending-reuse, detached-completion, and reset-timeout
regressions failed against `a89d6ac` before the production fix.
The delayed-unsubscribe, disconnect, unsubscribe-error, enable-error, and
enable-timeout cases failed against the subsequent Control Point lifetime fix
before CCC ownership tracking was added. These are host-boundary regressions
using the production GattLink, not a physical-radio test or the full Zephyr host.
