#pragma once

/*
 * fsx_mgmt — SMP "filesystem extensions" group.
 *
 * A custom mcumgr group that fills the gaps left by stock fs_mgmt
 * (group 8) — specifically: directory listing, mkdir, rmdir, move,
 * and statvfs. Runs alongside fs_mgmt; both are safe to enable at
 * the same time. Existing SMP clients (nRF Connect Device Manager,
 * AuTerm, mcumgr CLI) that don't know this group are unaffected —
 * they keep using fs_mgmt for upload/download as normal.
 *
 * Group ID: MGMT_GROUP_ID_PERUSER (64) — the canonical starting
 * point Zephyr reserves for vendor/application groups.
 *
 * Wire format is CBOR, same as every other SMP group.
 *
 * ---- Command reference ---------------------------------------
 *
 *   ID 0  READ   list      { path:tstr, off:uint?, count:uint? }
 *                      ->  { entries: [ { name:tstr, size:uint,
 *                                         type:uint }, ... ],
 *                            truncated:bool }
 *                          type: 0 = regular file, 1 = directory
 *                          `off`/`count` paginate large directories.
 *
 *   ID 1  WRITE  mkdir     { path:tstr }
 *                      ->  {}
 *
 *   ID 2  WRITE  rmdir     { path:tstr, recursive:bool? }
 *                      ->  {}
 *                          recursive=true also unlinks children
 *                          (equivalent to rm -rf).
 *
 *   ID 3  WRITE  move      { src:tstr, dst:tstr }
 *                      ->  {}
 *                          rename or move; both paths on same FS.
 *
 *   ID 4  READ   statvfs   { path:tstr }
 *                      ->  { bsize:uint, frsize:uint,
 *                            blocks:uint, bfree:uint }
 *                          bytes_free = frsize * bfree
 *                          bytes_total = frsize * blocks
 *
 * All handlers return standard MGMT_ERR_* codes for framing errors;
 * filesystem errors surface as an "rc" field via smp_add_cmd_err()
 * with the negated Zephyr errno as the value (matches how stock
 * fs_mgmt reports errors so clients handle them uniformly).
 */

#include <zephyr/mgmt/mcumgr/mgmt/mgmt_defines.h>

#define FSX_MGMT_GROUP_ID MGMT_GROUP_ID_PERUSER

enum fsx_mgmt_cmd {
	FSX_MGMT_ID_LIST        = 0,
	FSX_MGMT_ID_MKDIR       = 1,
	FSX_MGMT_ID_RMDIR       = 2,
	FSX_MGMT_ID_MOVE        = 3,
	FSX_MGMT_ID_STATVFS     = 4,
	/* WRITE { path:tstr, addr:tstr?, pin:tstr? } — arm the DFU state machine to flash
	 * the zip at `path`. Handler returns immediately after queueing; the
	 * actual scan → connect → discover → stream runs on a dedicated
	 * workqueue. Progress is via serial log; the LED state indicates
	 * running / done / fail.
	 *
	 * `addr` is optional and turns the run into **manual mode**: instead of
	 * taking the first peer that passes `ble_name` and `min_rssi`, the run
	 * reaches exactly the peer at that address (or its bootloader one MAC
	 * above) and fails if it cannot. Pass back an `addr` verbatim from a
	 * SCAN response. Neither filter applies — the operator chose this one,
	 * and a weak target is usually why they went looking.
	 *
	 * `pin` is optional and is the *passkey* for a target that will not
	 * talk over an unencrypted link — one to six digits. Absent, the run
	 * falls back to config.txt's `ble_pin`; present, it wins for this run
	 * only and is never written to the config file. Nothing is offered to
	 * a peer that does not ask, so sending it costs nothing when the
	 * target turns out not to need one.
	 *
	 * **`addr` and `pin` are unrelated despite the firmware calling an
	 * address a "pin" everywhere else.** The wire names are the
	 * operator's: an address and a PIN. See ble_pairing.h.
	 *
	 * A run that ends because of authentication reports
	 * DFU_STATUS_RESULT_AUTH_REQUIRED (nothing was offered) or
	 * _AUTH_FAILED (one was, and the peer refused it) and does **not**
	 * consume the retry budget — the answer would not change.
	 */
	FSX_MGMT_ID_TRIGGER_DFU = 5,

	/* STOP_DFU (write): end the run in progress and clear the status back
	 * to IDLE.
	 *
	 *   req: {}                     (no fields)
	 *   rsp: { "stopped": bool }    true if a run was actually ended
	 *
	 * `stopped: false` means nothing was running. That is not an error —
	 * the sticky DONE/FAILED from the previous run was still cleared — so
	 * a client may send this unconditionally whenever it wants a clean
	 * slate, without first asking whether a run is in flight.
	 */
	FSX_MGMT_ID_STOP_DFU    = 6,

	/* READ { path:tstr } — say what a file is, whether it is intact, and
	 * whether this build could flash it.
	 *
	 *   rsp: { "kind":uint, "transport":uint, "ok":bool, "flashable":bool,
	 *          "reason":tstr, "bytes":uint,
	 *          "devtype":uint,            (legacy packages)
	 *          "name":tstr, "version":tstr, "chip":tstr }   (ESP32 images)
	 *
	 * The client asks the same questions before uploading, because that is
	 * the only place a bad file can be refused before the transfer is
	 * spent. This is the authority afterwards: files also arrive over
	 * plain SMP from nRF Connect Device Manager, which will never run the
	 * web client's checks, and a file may predate them entirely.
	 *
	 * Reads the whole file to checksum it — roughly a second per 500 KB —
	 * and returns MGMT_ERR_EBUSY while a DFU is running, because it
	 * borrows the same archive handle the transfer is using.
	 */
	FSX_MGMT_ID_INSPECT     = 7,

	/* READ {} — what this build can do.
	 *
	 *   rsp: { "transports":uint }   bitmask of enum fw_transport_id
	 *
	 * Exists so the client does not keep its own copy of the transport
	 * table. It had one, kept honest by a test; asking removes the copy
	 * instead of testing it, and a copy that cannot exist cannot drift.
	 */
	FSX_MGMT_ID_CAPS        = 8,

	/* SCAN (write): survey the air and report what the radio can hear.
	 *
	 *   req: { "on":bool, "kind":uint?, "reset":bool?, "off":uint?,
	 *          "count":uint? }
	 *   rsp: { "kind":uint, "kinds":uint, "scanning":bool, "total":uint,
	 *          "truncated":bool,
	 *          "entries": [ { "id":tstr, "name":tstr, "rssi":int,
	 *                         "best":int, "n":uint, "ch":uint,
	 *                         "fl":uint }, ... ] }
	 *
	 * `kind` is enum survey_kind: 1 = Bluetooth advertisers, 2 = WiFi
	 * access points. `kinds` is the bitmask of kinds this build has a
	 * radio for, so a client offers a WiFi tab only where one exists
	 * rather than keeping its own board table — same reasoning as CAPS.
	 *
	 * **At most one survey runs, and none during a DFU.** Asking for the
	 * other kind switches, which clears the table; asking during a run
	 * returns EBUSY. survey.h has the three reasons, of which the
	 * expensive one is that Bluetooth and WiFi are one radio on the ESP32
	 * parts and a scan alongside a transfer costs the whole image.
	 *
	 * `reset` empties the table before scanning. A poll must not do that —
	 * `best` and the sighting count are accumulated history — but a manual
	 * refresh must, or it answers "what is out there now" with everything
	 * heard since the survey began, none of which ever ages out.
	 *
	 * A **write**, not a read, because asking is what starts the radio.
	 * One command arms, polls and disarms: `on:true` starts or refreshes,
	 * `on:false` stops. A running survey also stops itself if nobody polls
	 * for a few seconds, so a browser tab that closes cannot leave the
	 * radio scanning until the next reboot.
	 *
	 * Nothing is filtered. `min_rssi` and `ble_name` exist to pick a
	 * target automatically; a survey exists because that found nothing and
	 * someone needs to see why — at which point the device below the
	 * threshold is the interesting one, and hearing only a stranger's
	 * phone still proves the receiver works.
	 *
	 * `rssi` is the latest sighting and `best` the strongest of the
	 * survey: the first moves while an antenna is aimed, the second
	 * answers "did it ever get good". `n` counts sightings — advertisements
	 * for Bluetooth, completed sweeps for WiFi. `ch` is the WiFi channel
	 * (0 for Bluetooth) and `fl` is SURVEY_F_DFU / SURVEY_F_SECURE.
	 *
	 * Entries come back in **insertion order** and the client sorts them;
	 * see survey_get() for why signal order would corrupt pagination.
	 */
	FSX_MGMT_ID_SCAN        = 9,

	/* SUBMIT_PIN (write): answer a pairing that is waiting for one.
	 *
	 *   req: { "pin": tstr }        empty or absent cancels the pairing
	 *   rsp: { "taken": bool }      false if nothing was waiting
	 *
	 * Only meaningful while the status is DFU_STATUS_AWAITING_PIN. The
	 * target is displaying the digits *now*, for this pairing and no other,
	 * which is why this is a separate command rather than an argument to
	 * TRIGGER_DFU: by the time a run could be re-triggered the number on
	 * the screen has changed, and declining the first one is what cleared
	 * the screen.
	 *
	 * `taken: false` is not an error — SMP times a pairing out after 30 s,
	 * so a prompt the operator left sitting simply misses the window.
	 */
	FSX_MGMT_ID_SUBMIT_PIN  = 10,

	/* READ {} — the battery, on a board that can measure one.
	 *
	 *   rsp: { "src":uint, "mv":uint, "pct":uint,
	 *          "chg":bool?, "ext":bool? }
	 *
	 * `src` is enum battery_source: 0 none, 1 resistor divider, 2 PMIC. Zero
	 * is the whole answer — `mv` and `pct` are absent — and it is a hardware
	 * fact rather than a failure, so it comes back as a successful response
	 * and not an error. Three of the six boards are in that state.
	 *
	 * `chg` (charging now) and `ext` (external power attached) are **absent
	 * when the board cannot tell**, which is not the same as false and must
	 * not be rendered as it. A bare divider sees a voltage and nothing else:
	 * a full cell on USB and a full cell on its own read identically, so
	 * guessing would put a plug icon on a device that is running itself flat.
	 * Only the nPM1300 boards answer these.
	 *
	 * `pct` is inferred from `mv` against a LiPo curve and sags under load —
	 * see battery.h. Both are sent because the voltage is the one a
	 * multimeter can contradict, and a divider ratio is the one part of this
	 * that no test can check.
	 *
	 * A read, and cheap: a few milliseconds of ADC or I2C. Safe to poll, but
	 * there is nothing to poll *for* during a DFU — the client asks on
	 * connect and on a timer, not per progress notification.
	 */
	FSX_MGMT_ID_BATTERY     = 11,
};

/* Directory entry type constants used in `list` response. */
enum fsx_entry_type {
	FSX_ENTRY_FILE = 0,
	FSX_ENTRY_DIR  = 1,
};
