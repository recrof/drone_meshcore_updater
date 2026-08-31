import { ref, computed, watch } from "../vue.js";
import { onEscape } from "../lib/dialog.js";
import { loadIndex, usbEntries, boardLabel } from "../lib/firmware-manifest.js";
import {
  SUPPORTED_METHODS, flasherFor, apiAvailable, entryIsFlashable,
} from "../lib/usb-flashers.js";
import { connected } from "../store.js";
import BleUpdate from "./BleUpdate.js";
import ProbeFlash from "./ProbeFlash.js";
import SerialFlash from "./SerialFlash.js";

/*
 * Update the updater's own firmware — over Bluetooth, or over USB.
 *
 * This file used to *be* the USB flasher. It is now the part that decides
 * which one to show: three boards ship from this repo and no two of them are
 * reached the same way — a CMSIS-DAP probe on the nRF54L, the Adafruit
 * bootloader on the nRF52840, the ROM loader on the ESP32-S3 — so the flashers
 * live in ProbeFlash.js and SerialFlash.js and this dispatches on the `usb`
 * field the manifest gives each board.
 *
 * Until that dispatch existed, two of the three boards were staged, listed,
 * and then explicitly disowned by a line of UI telling the user to go and find
 * another tool. The ESP32-S3 had no other tool that a non-developer would
 * find: no probe, no drag-and-drop bootloader, and Bluetooth OTA cannot
 * install the bootloader it needs before it can work at all.
 *
 * ---- There is deliberately no "flash a file you choose" ------------------
 *
 * Picking the wrong one is easy and the consequences are not obvious:
 * zephyr.hex instead of merged.hex leaves a device with no reset vector, and a
 * hex for another board flashes happily and then does not boot — MCUboot
 * validates a signature, not an architecture, and every board here signs with
 * the same key. Every one of those needs a probe to undo, which is the very
 * thing a user in that position is least likely to have. The staged image is
 * checked, digest-matched and named with its board, and a local build restages
 * itself on every `./build.sh`, so a developer's own image is already what
 * these buttons write.
 */
export default {
  name: "FlashDialog",
  components: { BleUpdate, ProbeFlash, SerialFlash },
  props: { open: Boolean },
  emits: ["close"],
  setup(props, { emit }) {
    /* Routed through close(), which refuses while a write is in flight —
     * unmounting mid-flash drops the probe handle or the serial port. */
    onEscape(() => props.open, () => close());
    const entries = ref([]);          // every board this client can flash by USB
    const manifestError = ref("");
    /*
     * The chosen board target, empty until the user picks one.
     *
     * Deliberately not defaulted when there is more than one board. There is
     * no honest default available: `deviceBoard` in the store would be the
     * right answer, but it is cleared on disconnect and USB flashing requires
     * there to be no connection, so it is null exactly when it would be
     * useful. Anything else — first alphabetically, first in the manifest — is
     * a pre-selection the user did not make, sitting next to a button that
     * writes to their hardware.
     */
    const board = ref("");
    /*
     * Whichever flasher is mounted, reported up so the dialog can refuse to
     * close. Unmounting mid-write drops the probe handle or the serial port
     * with the device halted and half-written, and nothing downstream would
     * ever say so.
     */
    const running = ref("");

    async function loadManifest() {
      entries.value = [];
      manifestError.value = "";
      try {
        const index = await loadIndex();
        /* Two filters, and the second is not redundant: `usbEntries` asks
         * whether the entry has *anything* to write, `entryIsFlashable` asks
         * whether it has what its own method needs — a `parts` list for the
         * ESP32-S3, a single file for the other two. An entry staged with the
         * wrong one would otherwise be offered, and fail after the user had
         * committed to a write. */
        entries.value = usbEntries(index, SUPPORTED_METHODS).filter(entryIsFlashable);
        if (!entries.value.length) throw new Error("no published build for any board");
        /* One board is not a choice, so do not stage it as one. */
        if (entries.value.length === 1) board.value = entries.value[0].board;
        else if (!entries.value.some(e => e.board === board.value)) board.value = "";
      } catch (e) {
        /* Entirely normal on a local checkout, and before the first release is
         * published — build.yml creates releases as drafts, whose assets are
         * not downloadable until someone publishes them. */
        manifestError.value = e.message;
      }
    }
    watch(() => props.open, (isOpen) => { if (isOpen) loadManifest(); }, { immediate: true });

    const entry = computed(() => entries.value.find(e => e.board === board.value) ?? null);
    const flasher = computed(() => (entry.value ? flasherFor(entry.value.usb) : null));

    /*
     * Two capability questions, asked in this order on purpose.
     *
     * `anyUsb` is about the *browser* and is true of Chrome and Edge on
     * desktop and nothing else. It is asked before the manifest is consulted
     * because it is the more fundamental answer: on Firefox or an iPhone,
     * "there is no published build" would be beside the point and would send
     * the reader looking for a problem that is not theirs.
     *
     * `usable` is about the *board*, and can differ: WebUSB and Web Serial are
     * separate permissions and separate flags, so a browser can plausibly have
     * one and not the other.
     */
    const anyUsb = computed(() => apiAvailable("webusb") || apiAvailable("webserial"));
    const usable = computed(() => (flasher.value ? apiAvailable(flasher.value.api) : false));

    /*
     * Why the USB half is unavailable, as a sentence, or "".
     *
     * A live Bluetooth link is the interesting case: flashing halts or resets
     * the CPU, which takes the link down with it, so the app would be left
     * describing a device that no longer exists. It is re-checked here rather
     * than only when the dialog opened, because a link can come up after.
     */
    const blocked = computed(() => connected.value
      ? "Disconnect Bluetooth first — flashing over USB restarts the CPU, which drops the link."
      : "");

    function close() {
      if (running.value) return;
      emit("close");
    }

    return {
      connected, entries, manifestError, board, entry, flasher, anyUsb, usable, blocked,
      running, boardLabel, close,
    };
  },
  template: /* html */ `
    <div id="flash-overlay" v-if="open" @click.self="close">
      <div class="cfg-modal" role="dialog" aria-modal="true" aria-label="Update updater firmware">

        <div class="cfg-head">
          <span class="title">UPDATE UPDATER</span>
          <span class="path">Bluetooth or USB</span>
          <span class="grow"></span>
          <button :disabled="!!running" title="Close" @click="close">✕</button>
        </div>

        <div class="cfg-body">
          <p class="cfg-lede">
            Updates this XIAO's own firmware. This is not the DFU target; it is the
            updater itself. Two routes, and exactly one is usable at a time:
            Bluetooth needs a connection, USB needs there not to be one.
          </p>

          <div class="cfg-section">Over Bluetooth</div>
          <BleUpdate />

          <div class="cfg-section">Over USB</div>
          <p class="cfg-lede">
            The way in when Bluetooth is not an option — including when a Bluetooth
            update has left the device unable to advertise.
          </p>

          <div class="cfg-banner err" v-if="connected">{{ blocked }}</div>

          <div class="cfg-banner err" v-if="!anyUsb">
            This browser has no WebUSB or Web Serial, so it cannot flash over USB.
            Chrome or Edge on desktop can; Firefox, Safari and every browser on
            iOS cannot.
          </div>

          <div class="cfg-banner err" v-else-if="manifestError">
            No firmware to flash: {{ manifestError }}.
          </div>

          <template v-else>
            <!-- Which board is in front of the user. The browser cannot say
                 until permission has been granted for one specific device, and
                 the prompt differs per API, so this is asked rather than
                 detected — after which each flasher does detect, and refuses a
                 mismatch. -->
            <template v-if="entries.length > 1">
              <div class="cfg-section-sub">Which board</div>
              <div class="flash-boards" role="radiogroup" aria-label="Board to flash">
                <button v-for="e in entries" :key="e.board"
                        class="flash-board" :class="{ on: e.board === board }"
                        role="radio" :aria-checked="e.board === board"
                        :disabled="!!running" @click="board = e.board">
                  {{ boardLabel(e.board) }}
                </button>
              </div>
            </template>

            <p class="flash-note" v-if="!entry">
              Pick the board you are flashing. Each one is reached a different
              way, and the steps below change with it.
            </p>

            <template v-else>
            <div class="cfg-banner err" v-if="!usable">
              This board is flashed through {{ flasher.label }}, which needs
              {{ flasher.api === 'webusb' ? 'WebUSB' : 'Web Serial' }} — and this
              browser has not got it.
            </div>

            <template v-else>
              <ProbeFlash v-if="entry.usb === 'cmsis-dap'" :entry="entry" :blocked="blocked"
                          @busy="running = $event" />
              <SerialFlash v-else :key="entry.board" :entry="entry" :blocked="blocked"
                           @busy="running = $event" />
            </template>
            </template>
          </template>
        </div>

        <div class="cfg-foot">
          <span class="grow"></span>
          <button :disabled="!!running" @click="close">Close</button>
        </div>

      </div>
    </div>
  `,
};
