/*
 * What each board needs, physically and in the browser, to be flashed by USB.
 *
 * `manifest.json` gives every board a `usb` method string — `cmsis-dap`,
 * `nordic-serial-dfu`, `esptool` — written by web/tools/stage-firmware.mjs.
 * This is the client's other half of that agreement: for each method, which
 * browser API it needs, what the user has to do to the hardware first, and
 * which artifact out of the entry it writes.
 *
 * It is one table rather than three `if` chains in three components because
 * the three boards genuinely have nothing in common here — different API,
 * different button dance, different artifact — and the thing most likely to
 * go wrong is one of those places being updated and another not.
 * web/test/stage-firmware.test.mjs holds this table and `USB_METHODS` in the
 * stager to the same set of names.
 *
 * **Whether reaching the bootloader is part of flashing depends on whether the
 * port survives the reset**, and the two boards differ:
 *
 *  - **ESP32-S3: it survives**, so flashing does it and the user presses
 *    nothing. The USB device is implemented by the USB-Serial-JTAG peripheral,
 *    which stays enumerated across a CPU reset — measured, not assumed.
 *  - **nRF52840: it does not.** The application and the bootloader are
 *    different USB devices (PID 0x8045 against 0x0045), so the port is
 *    genuinely gone and a fresh one has to be chosen. That one keeps a button
 *    of its own, and the button only works on firmware that implements the
 *    1200-baud touch.
 *
 * The physical route stays documented either way, as the fallback for a port
 * with no control lines or a board running something else.
 */

/** Artifact kinds an entry can offer. `parts` is a list of image+offset
 *  pairs, which is what a board with no single-file image needs. */
export const ARTIFACT = { HEX: "file", PARTS: "parts" };

export const FLASHERS = {
  "cmsis-dap": {
    label: "CMSIS-DAP probe",
    api: "webusb",
    artifact: ARTIFACT.HEX,
    /* The SAMD11 on the board is always a probe; there is no mode to enter. */
    prepare: [],
    reboot: null,
    summary: "Programs through the on-board debug probe. Nothing to install, " +
             "no buttons to press.",
  },

  "nordic-serial-dfu": {
    label: "Nordic serial DFU",
    api: "webserial",
    artifact: ARTIFACT.HEX,
    /* Deliberately says "a USB drive" and not which one.
     *
     * Two boards use this method now and neither the LED colour nor the drive
     * name is shared: the XIAO's bootloader pulses an orange LED and mounts
     * XIAO-BOOT (XIAO-SENSE on the sense variant), the RAK4631's pulses green
     * and mounts RAK4631. The old text named one of the three, which was
     * wrong for two of the boards it was shown to — and a precise instruction
     * that does not match what is in front of you is worse than a general one,
     * because it reads as "you are looking at the wrong thing".
     *
     * The board's own name is already on the screen beside this list, from
     * BOARD_LABELS, so nothing is lost. */
    prepare: [
      "Double-tap the RESET button. The bootloader's LED starts pulsing " +
      "slowly and a USB drive appears — that is it waiting.",
      "Pick the board's serial port when the browser asks.",
    ],
    reboot: {
      label: "Reboot into bootloader",
      /* Honest about the precondition. The touch is implemented by the
       * *application*, in updater/src/usb_dfu_touch.c, so it only works on a
       * board already running this firmware. */
      note: "Opens the port at 1200 baud, which asks firmware built from this " +
            "repo to restart into the bootloader. A board running anything else " +
            "will ignore it — double-tap RESET instead.",
      needs: "the port the board is running on now, not the bootloader's",
    },
    summary: "Writes through the Adafruit bootloader the board ships with. " +
             "Same bootloader as the drag-and-drop UF2 route, without the drag.",
    recovery: "If anything goes wrong the bootloader is untouched: double-tap " +
              "RESET again and either retry, or drop the .uf2 onto the drive.",
  },

  esptool: {
    label: "ESP32 ROM loader",
    api: "webserial",
    artifact: ARTIFACT.PARTS,
    prepare: [
      "Pick the board's serial port when the browser asks. That is the whole " +
      "of it — the board is put into download mode over the same port.",
    ],
    /* No button: flashing resets the board itself, and the port survives it.
     * See the note at the top of this file. */
    reboot: null,
    summary: "Talks to the ROM loader burned into the chip, which is the same " +
             "thing esptool.py talks to. It is the only way in on this board.",
    recovery: "The ROM loader is in silicon and cannot be erased, so it is always " +
              "there. If the reset does not reach it, put the board in download " +
              "mode by hand — hold BOOT, tap RESET, release BOOT — and try again.",
  },
};

/** Every method string this client can actually speak. */
export const SUPPORTED_METHODS = Object.keys(FLASHERS);

export const flasherFor = (method) => FLASHERS[method] ?? null;

/**
 * Can this browser drive the given method at all?
 *
 * Both answers are the same browsers in practice — Chrome and Edge on
 * desktop — but they are separate permissions and separate feature flags, so
 * they are asked separately rather than assumed to move together.
 */
export function apiAvailable(api) {
  if (typeof navigator === "undefined") return false;
  if (api === "webusb") return !!navigator.usb;
  if (api === "webserial") return !!navigator.serial;
  return false;
}

/** True when an entry names an artifact its method knows how to write. */
export function entryIsFlashable(entry) {
  const f = flasherFor(entry?.usb);
  if (!f) return false;
  return f.artifact === ARTIFACT.PARTS ? !!entry.parts?.length : !!entry.file;
}
