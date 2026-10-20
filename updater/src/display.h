/*
 * display.h — optional status display (CONFIG_UPDATER_DISPLAY).
 *
 * SPDX-License-Identifier: Apache-2.0
 *
 * The display only observes: it reads dfu_status, the battery and the bundle
 * store on its own thread. The one thing it cannot observe is a file upload
 * in progress, because the two upload paths (mcumgr fs_mgmt and fsx_stream)
 * report nothing until the file is complete. They call this instead.
 *
 * Without CONFIG_UPDATER_DISPLAY it compiles to nothing, so the call sites
 * need no #ifdef.
 */

#pragma once

#ifdef __cplusplus
extern "C" {
#endif

#ifdef CONFIG_UPDATER_DISPLAY
/* A chunk of an upload was accepted. Cheap: one atomic store. */
void display_upload_activity(void);
#else
static inline void display_upload_activity(void) {}
#endif

#ifdef __cplusplus
}
#endif
