/*
 * Carry a fatal error across the reset that follows it.
 *
 * See crash_record.c for why this is needed at all — in short, the fault dump
 * *cannot* reach the filesystem, on any board, and never could.
 */

#ifndef CRASH_RECORD_H_
#define CRASH_RECORD_H_

#ifdef __cplusplus
extern "C" {
#endif

/**
 * Log the previous run's fatal error, if there was one, and forget it.
 *
 * Call once at boot, from main(), after the logging subsystem exists. Silent
 * when the last run ended cleanly, which is every boot that is not a crash.
 */
void crash_record_report(void);

#ifdef __cplusplus
}
#endif

#endif /* CRASH_RECORD_H_ */
