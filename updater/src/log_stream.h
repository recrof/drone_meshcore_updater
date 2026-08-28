#pragma once

#include <stdbool.h>

#ifdef __cplusplus
extern "C" {
#endif

struct log_backend;

/* The backend this module implements. Exposed only so its own CCC handler can
 * enable and disable it; nothing else should touch it. */
const struct log_backend *log_stream_backend_get(void);

/* True while a GATT client has notifications enabled. Cheap enough to call on
 * a hot path — it is a single atomic read. */
bool log_stream_active(void);

#ifdef __cplusplus
}
#endif
