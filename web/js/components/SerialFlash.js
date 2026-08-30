import { ref, computed, watch } from "../vue.js";
import { SerialLink } from "../lib/serial.js";
import { NordicSerialDfu, touchReset, APP_START, DFU_BAUD } from "../lib/nordic-dfu-serial.js";
import { EspRomLoader, enterDownloadMode, USB_JTAG_SERIAL, chipForBoard } from "../lib/esptool.js";
import { parseIntelHex, flatten, lowAddress, highAddress } from "../lib/intel-hex.js";
import { fmtSize } from "../lib/format.js";
import { assetUrl } from "../lib/firmware-manifest.js";
import { flasherFor } from "../lib/usb-flashers.js";
import { useFlashRun, fetchChecked, consoleTracer } from "../flash-run.js";

/*
 * The two Web Serial flashers: `nordic-serial-dfu` and `esptool`.
 *
 * One component for both, unlike the probe, because the *shape* is identical
 * and only the protocol differs: the user puts the board into its bootloader
 * by hand, picks a port, and one button does fetch, check, write, verify,
 * restart. There is nothing to attach to beforehand and no state to hold
 * between clicks, which is exactly what makes the CMSIS-DAP panel a separate
 * component rather than a third branch in here.
 *
 * ---- Why the board is chosen and not detected ---------------------------
 *
 * The browser will not tell us what is plugged in until permission has been
 * granted for a specific device, and the permission prompt differs per API —
 * `navigator.usb.requestDevice` against `navigator.serial.requestPort`. So
 * something has to be known *before* anything can be detected, and the honest
 * version of that is asking. Detection still happens, immediately after: the
 * ESP32-S3 loader reads the chip magic and refuses anything that is not an
 * S3, and the nRF52840's image is checked against the address its bootloader
 * will write it to. Neither of those can be wrong quietly.
 *
 * ---- The failure that matters -------------------------------------------
 *
 * "Nothing answers" almost always means the board is not in bootloader mode,
 * and almost never means the protocol is broken. Both flashers therefore
 * capture whatever the device said before the first frame — for the ESP32-S3
 * that is either the ROM banner or the application's boot log, which settles
 * the question outright — and both say the button dance again in the error
 * rather than only in the instructions above it, where it has already been
 * read and dismissed.
 */
export default {
  name: "SerialFlash",
  props: {
    entry: { type: Object, required: true },
    blocked: { type: String, default: "" },
  },
  /* The dialog refuses to close while a write is running — see FlashDialog. */
  emits: ["busy"],
  setup(props, { emit }) {
    const { busy, error, lines, progress, log, guard, track } = useFlashRun();
    /* Empty until a run finishes; the sentence to show when one has. */
    const outcome = ref("");

    const hex4 = (n) => "0x" + (n >>> 0).toString(16).padStart(4, "0");

    /* Wrapped because the single-file build also runs from file://, where a
     * malformed location should disable tracing rather than break flashing. */
    const traceRequested = () => {
      try { return new URL(location.href).searchParams.has("trace"); }
      catch { return false; }
    };

    watch(busy, (v) => emit("busy", v));

    const flasher = computed(() => flasherFor(props.entry.usb));
    const ready = computed(() => !busy.value && !props.blocked);

    /*
     * The drag-and-drop route, for a board whose bootloader also exposes a
     * mass-storage drive. Offered alongside rather than instead: it needs a
     * file manager and a second window, so it is the worse default — but it
     * goes through the bootloader's own UF2 writer rather than the serial DFU
     * path, and it has none of that path's size limits or timing hazards.
     * When serial DFU refuses an image, this is what it refers the user to.
     */
    const uf2Url = computed(() => (props.entry.uf2 ? assetUrl(props.entry, props.entry.uf2) : ""));

    /** Total bytes across every image this board needs written. */
    const payloadBytes = computed(() => props.entry.parts
      ? props.entry.parts.reduce((n, p) => n + (p.bytes ?? 0), 0)
      : props.entry.bytes ?? 0);

    async function openPort() {
      const link = await SerialLink.request();
      /* Reported, not enforced — see esptool.js. A user who picked the wrong
       * port gets a name for what they picked instead of a silent timeout. */
      const info = link.getInfo();
      if (info.usbVendorId != null) {
        log(`port ${hex4(info.usbVendorId)}:${hex4(info.usbProductId ?? 0)}` +
            (props.entry.usb === "esptool" && info.usbVendorId !== USB_JTAG_SERIAL.vendorId
              ? " — not Espressif's USB-Serial-JTAG; this may be the wrong port"
              : ""));
      }
      /*
       * Off by default; `?trace` in the URL turns it on.
       *
       * Kept rather than deleted because it is what actually found the
       * nRF52840 bug: three rounds of reading the bootloader's source
       * narrowed it to the wrong cause twice, and one run with the frames
       * visible settled it — the board acknowledged the init packet, which
       * ruled out everything that happens before it. Both devices on the
       * other end of this file are opaque when they fail, so if there is ever
       * a next time, the exchange is again the only evidence there is.
       */
      if (traceRequested()) link.trace = consoleTracer(props.entry.usb);
      await link.open({ baudRate: DFU_BAUD });
      return link;
    }

    /* --- nRF52840: Nordic Legacy DFU through the Adafruit bootloader ---- */

    async function flashNordic(link) {
      const url = assetUrl(props.entry, props.entry.file);
      log(`fetching ${props.entry.file}…`);
      const buf = await fetchChecked(url, props.entry.sha256, log);
      const chunks = parseIntelHex(new TextDecoder().decode(buf));

      /*
       * The bootloader writes wherever *it* decides — the protocol carries no
       * addresses at all — so the only defence against a mismatch is to check
       * that the image begins where the bootloader is going to put it. An
       * image starting anywhere else would be written shifted, flash cleanly,
       * and boot nothing.
       */
      const lo = lowAddress(chunks);
      if (lo !== APP_START) {
        throw new Error(
          `the staged image starts at 0x${lo.toString(16)}, but this bootloader writes ` +
          `the application at 0x${APP_START.toString(16)}. Flashing it would put every ` +
          `byte at the wrong address. This is a build or staging fault, not something ` +
          `to retry.`);
      }
      const image = flatten(chunks, APP_START);
      log(`${fmtSize(image.length)} spanning 0x${lo.toString(16)}..` +
          `0x${highAddress(chunks).toString(16)}`);

      const dfu = new NordicSerialDfu(link, log);
      const onProgress = track("Writing");
      await dfu.flash(image, onProgress);
      log("bootloader accepted the image and is validating it", "ok");
      return "The board is restarting into the new firmware.";
    }

    /* --- ESP32-S3: the ROM loader --------------------------------------- */

    async function flashEsp(link) {
      const loader = new EspRomLoader(link, log);
      log("resetting into download mode…");
      /* The board target says which chip this must turn out to be. Passing it
       * rather than letting the loader assume an S3 is what makes a second
       * Espressif board flashable at all — and it still refuses a mismatch,
       * which is the point of checking. */
      const chip = await loader.connect({ expect: chipForBoard(props.entry.board) });
      log(`${chip} in download mode`, "ok");
      await loader.spiAttach();

      /* Offsets ascending, so the log reads like a memory map and an overlap
       * is visible in it rather than only in the check below. */
      const parts = [...props.entry.parts].sort((a, b) => a.offset - b.offset);
      for (let i = 1; i < parts.length; i++) {
        const prev = parts[i - 1];
        if (prev.offset + (prev.bytes ?? 0) > parts[i].offset) {
          throw new Error(
            `staged images overlap: ${prev.file} runs past 0x${parts[i].offset.toString(16)} ` +
            `where ${parts[i].file} starts. This is a staging fault.`);
        }
      }

      let written = 0;
      const total = payloadBytes.value || 1;
      const onProgress = track("Writing");
      for (const part of parts) {
        const buf = await fetchChecked(assetUrl(props.entry, part.file), part.sha256, log);
        const bytes = new Uint8Array(buf);
        const base = written;
        await loader.writeImage(part.offset, bytes,
                                (dn) => onProgress(base + dn, total));
        written += bytes.length;
      }

      log("leaving the loader…");
      await loader.runUserCode();
      return "The board is restarting into the new firmware. If it does not come " +
             "back, tap RESET.";
    }

    /* --- getting there without touching the board ----------------------- */

    /*
     * Both routes end by resetting the device, which re-enumerates USB and
     * kills the port. So neither can report success: there is nothing left to
     * ask. The honest thing is to say what was sent and what to look for.
     */
    async function reboot() {
      outcome.value = "";
      let link = null;
      try {
        await guard("rebooting", async () => {
          link = await SerialLink.request();
          if (props.entry.usb === "esptool") {
            await link.open({ baudRate: DFU_BAUD });
            await enterDownloadMode(link);
            outcome.value = "Sent the reset. The board should now be in download " +
                            "mode — pick its port again to flash. Nothing visible " +
                            "happens on the board itself.";
          } else {
            /* Not opened through `link` at all: the touch *is* the open and
             * close, at a rate nothing else uses. */
            await touchReset(link.port);
            outcome.value = "Asked the board to restart into its bootloader. If the " +
                            "LED is pulsing, it worked — pick the port again to flash. " +
                            "If nothing happened, double-tap RESET instead.";
          }
        });
      } catch { /* reported */ } finally {
        if (link) { try { await link.close(); } catch { /* already gone */ } }
      }
    }

    /* --- the button ----------------------------------------------------- */

    async function flash() {
      outcome.value = "";
      let link = null;
      try {
        await guard("flashing", async () => {
          link = await openPort();
          outcome.value = props.entry.usb === "esptool"
            ? await flashEsp(link)
            : await flashNordic(link);
        });
      } catch { /* reported */ } finally {
        /* Always let the port go. The device is about to re-enumerate anyway,
         * and a port this tab still holds is one the next attempt cannot open
         * — which presents as "the board disappeared". */
        if (link) { try { await link.close(); } catch { /* already gone */ } }
      }
    }

    return {
      busy, error, lines, progress, outcome, flasher, ready, uf2Url,
      fmtSize, payloadBytes, flash, reboot,
    };
  },
  template: /* html */ `
    <p class="cfg-lede">{{ flasher.summary }}</p>

    <ol class="flash-steps">
      <li v-for="(step, i) in flasher.prepare" :key="i">{{ step }}</li>
    </ol>

    <!-- The software route to the same place. Offered second, because it
         resets the device and cannot confirm that it worked — where the
         buttons are something the user can see the result of. -->
    <div class="flash-step" v-if="flasher.reboot">
      <button class="small" :disabled="!ready" @click="reboot">
        {{ busy === "rebooting" ? "Rebooting…" : flasher.reboot.label }}
      </button>
      <span class="flash-note">{{ flasher.reboot.note }}</span>
    </div>

    <div class="flash-step">
      <button class="primary" :disabled="!ready" @click="flash">
        {{ busy === "flashing" ? "Flashing…" : "Flash newest" }}
      </button>
      <span class="flash-note">
        <strong v-if="entry.version || entry.dfuVersion">v{{ entry.version || entry.dfuVersion }}</strong><template
          v-if="payloadBytes"> · {{ fmtSize(payloadBytes) }}</template><template
          v-if="entry.published"> · {{ entry.published.slice(0, 10) }}</template>
      </span>
    </div>

    <div class="flash-step" v-if="blocked">
      <span class="flash-note err">{{ blocked }}</span>
    </div>

    <div class="flash-step" v-if="uf2Url">
      <a class="flash-note" :href="uf2Url" :download="entry.uf2">
        or download {{ entry.uf2 }}
      </a>
      <span class="flash-note">and drop it on the drive the bootloader shows —
        slower to do, but it has none of the size limits serial DFU has.</span>
    </div>

    <div class="flash-progress" v-if="progress.shown">
      <div class="bar"><div class="fill" :style="{ width: progress.pct + '%' }"></div></div>
      <span class="mono">{{ progress.label }} {{ progress.pct }}%</span>
    </div>

    <div class="cfg-banner ok" v-if="outcome">{{ outcome }}</div>

    <!-- Said after a failure, not only before the attempt: by the time it has
         failed, the instructions above have been read once and dismissed. -->
    <div class="cfg-banner err" v-if="error">
      {{ error }}
      <template v-if="flasher.recovery"><br>{{ flasher.recovery }}</template>
    </div>

    <pre class="flash-log" v-if="lines.length"><span v-for="l in lines" :key="l.id"
      :class="l.cls">{{ l.msg }}\n</span></pre>
  `,
};
