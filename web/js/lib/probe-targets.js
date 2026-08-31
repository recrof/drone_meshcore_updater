/*
 * Which flash algorithm belongs to which board.
 *
 * ---- Why this table has to exist ----------------------------------------
 *
 * Two boards in this repo are reached the same way — SWD through an on-board
 * SAMD11 running CMSIS-DAP — so they share one `usb` method in the manifest
 * (`cmsis-dap`), one browser API, one artifact, and one set of instructions.
 * They do not share a flash controller.
 *
 * **And they cannot be told apart on the wire.** The XIAO nRF54LM20A and the
 * XIAO MG24 both answer DPIDR 0x6ba02477, which is a generic ARM debug-port
 * ID, not a part number. So the obvious implementation — attach, read the
 * IDCODE, pick an algorithm — is not available, and something that looks very
 * like it would appear to work while being wrong.
 *
 * What that costs if it goes wrong is worth stating plainly, because it is not
 * "the flash fails". The nRF54L algorithm's first act is to write 0x101 to
 * 0x5004e500, which on an EFR32 is inside a live peripheral window. It would
 * be an arbitrary poke at unrelated hardware, followed by 78,000 more.
 *
 * So the algorithm is chosen from the **board target the manifest names**,
 * which the staging step wrote from the build that produced the image, and
 * which the device also reports over SMP. An unknown board is refused rather
 * than defaulted: a board this client has never heard of is exactly the case
 * where guessing is worst.
 *
 * stage-firmware.test.mjs holds this table to the same board list as
 * `USB_METHODS`, so a fifth CMSIS-DAP board cannot arrive without one.
 */

import { Nrf54lFlasher } from "./nrf54l-flash.js";
import { Efr32Flasher, FLASH_BASE as EFR32_FLASH_BASE, FLASH_SIZE as EFR32_FLASH_SIZE }
  from "./efr32-flash.js";

/*
 * `geometry` is used only to sanity-check an image before writing it — the
 * device stays the authority on what it will accept. The numbers come from
 * the partition fragments named beside each one, and a test holds them there.
 */
export const PROBE_TARGETS = {
  xiao_nrf54lm20a: {
    label: "XIAO nRF54LM20A",
    flasher: Nrf54lFlasher,
    /* updater/rram_partitions.dtsi */
    geometry: {
      base: 0,
      size: 2036 * 1024,
      slot0: 0x10000,
      storage: 0x1d1000,
      memory: "RRAM",
      dtsi: "updater/rram_partitions.dtsi",
    },
  },

  xiao_mg24: {
    label: "XIAO MG24",
    flasher: Efr32Flasher,
    /* updater/mg24_partitions.dtsi. Note `base`: this part's flash is mapped
     * at 0x08000000, not at 0, so every address in its hex is offset — an
     * image starting at 0 would be the *wrong* one here, where on the nRF54L
     * it is the only right one. */
    geometry: {
      base: EFR32_FLASH_BASE,
      size: EFR32_FLASH_SIZE,
      slot0: 0x10000,
      storage: 0x17c000,
      memory: "flash",
      dtsi: "updater/mg24_partitions.dtsi",
    },
  },
};

/** The board *name* out of a full target: "xiao_mg24/efr32…" -> "xiao_mg24". */
export const boardName = (target) => String(target ?? "").split("/")[0];

/** The profile for a board target, or null if this client has no algorithm
 *  for it. Callers must treat null as "refuse", never as "use the default". */
export const probeTargetFor = (target) => PROBE_TARGETS[boardName(target)] ?? null;

/** Board names this client can write over a CMSIS-DAP probe. */
export const PROBE_BOARDS = Object.keys(PROBE_TARGETS);
