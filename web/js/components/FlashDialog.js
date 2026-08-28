import { ref, reactive, computed, watch, onUnmounted } from "../vue.js";
import { webUsbAvailable } from "../lib/cmsis-dap.js";
import { Nrf54lFlasher, EXPECTED_DPIDR } from "../lib/nrf54l-flash.js";
import { parseIntelHex, totalBytes, lowAddress, highAddress } from "../lib/intel-hex.js";
import { fmtSize } from "../lib/format.js";
import { connected } from "../store.js";
import BleUpdate from "./BleUpdate.js";

/* Staged by CI from the newest published release — see web.yml. Relative, so
 * it works under a GitHub Pages sub-path and from a local checkout alike. */
const FIRMWARE_DIR = "firmware/";
const MANIFEST_URL = `${FIRMWARE_DIR}manifest.json`;

/* Partition geometry, from updater/rram_partitions.dtsi. Used only to check an
 * image before writing it — the device remains the authority. */
const RRAM_SIZE = 2036 * 1024;
const SLOT0 = 0x10000;
const STORAGE = 0x1d1000;

const hex8 = (n) => (n >>> 0).toString(16).padStart(8, "0");

/*
 * Flash the updater itself, over USB, from the browser.
 *
 * Two steps, not three: attach a probe, then press one button. Choosing a file
 * and writing it used to be separate stages, which made the common case (flash
 * the current release) a three-click errand for no benefit — the checks that
 * used to gate the write now run as part of it and abort with a reason.
 */
export default {
  name: "FlashDialog",
  components: { BleUpdate },
  props: { open: Boolean },
  emits: ["close"],
  setup(props, { emit }) {
    const flasher = ref(null);
    const dpidr = ref(0);
    const protectedPart = ref(false);
    const busy = ref("");
    const error = ref("");
    const lines = reactive([]);
    const progress = reactive({ shown: false, pct: 0, label: "" });
    const newest = ref(null);          // manifest.json, or null when none published
    const newestError = ref("");

    const log = (msg, cls = "") => {
      lines.push({ msg, cls, id: lines.length });
      if (lines.length > 200) lines.splice(0, lines.length - 200);
    };

    const attached = computed(() => !!flasher.value && dpidr.value !== 0);
    const recognised = computed(() => dpidr.value === EXPECTED_DPIDR);
    const ready = computed(() => attached.value && !busy.value && !connected.value);

    /* --- what the release published ------------------------------------ */

    async function loadManifest() {
      newest.value = null;
      newestError.value = "";
      try {
        const res = await fetch(MANIFEST_URL, { cache: "no-cache" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const m = await res.json();
        if (!m.file) throw new Error("manifest names no file");
        newest.value = m;
      } catch (e) {
        /* Entirely normal on a local checkout, and before the first release is
         * published — build.yml creates releases as drafts, whose assets are
         * not downloadable until someone publishes them. */
        newestError.value = e.message;
      }
    }
    watch(() => props.open, (isOpen) => { if (isOpen) loadManifest(); }, { immediate: true });

    /* --- image checks --------------------------------------------------- */

    /* Returns { fatal: [], warn: [] }. Fatal aborts the write; the old UI made
     * these banners next to a disabled button, which only worked because
     * choosing a file was its own step. */
    function inspect(chunks) {
      const lo = lowAddress(chunks), hi = highAddress(chunks);
      const fatal = [], warn = [];

      if (lo !== 0) {
        fatal.push(`starts at 0x${hex8(lo)}, not 0 — no reset vector. This looks like a ` +
                   `bootloader-relative application image (zephyr.hex); the device will not ` +
                   `boot from it. Use merged.hex.`);
      }
      if (hi >= RRAM_SIZE) {
        fatal.push(`runs to 0x${hex8(hi)}, past the end of the ${fmtSize(RRAM_SIZE)} RRAM.`);
      } else if (hi >= STORAGE) {
        warn.push(`overlaps storage_partition at 0x${hex8(STORAGE)} — settings will be overwritten.`);
      }
      if (lo === 0 && hi < SLOT0) {
        warn.push("bootloader only, no application — the device will boot MCUboot and stop there.");
      }
      return { fatal, warn };
    }

    /* --- the write ------------------------------------------------------ */

    async function guard(label, fn) {
      busy.value = label;
      error.value = "";
      try {
        return await fn();
      } catch (e) {
        error.value = e.message;
        log(e.message, "err");
        throw e;
      } finally {
        busy.value = "";
        progress.shown = false;
      }
    }

    /** Parse, check, halt, write, verify, reset. The whole of step 2. */
    async function writeImage(name, text) {
      const chunks = parseIntelHex(text);
      const { fatal, warn } = inspect(chunks);
      log(`${name}: ${totalBytes(chunks)} bytes, ` +
          `0x${hex8(lowAddress(chunks))}..0x${hex8(highAddress(chunks))}`);
      for (const w of warn) log(w, "warn");
      if (fatal.length) throw new Error(`${name} ${fatal[0]}`);

      const f = flasher.value;
      log("halting core…");
      await f.halt();

      progress.shown = true;
      progress.label = "Writing";
      progress.pct = 0;
      const written = await f.program(chunks, (done, total) => {
        progress.pct = Math.floor((done / total) * 100);
      });
      log(`wrote ${written} bytes`, "ok");

      progress.label = "Verifying";
      progress.pct = 0;
      await f.verify(chunks, (done, total) => {
        progress.pct = Math.floor((done / total) * 100);
      });
      log("verified — every byte reads back as written", "ok");

      progress.shown = false;
      log("resetting…");
      await f.resetAndRun();
      log("done. The device is running the new firmware.", "ok");
      /* The part drops the debug connection on reset; a stale handle only
       * produces confusing errors on the next click. */
      dpidr.value = 0;
    }

    async function flashNewest() {
      try {
        await guard("flashing", async () => {
          const url = FIRMWARE_DIR + newest.value.file;
          log(`fetching ${newest.value.tag ?? "newest"} (${url})…`);
          const res = await fetch(url, { cache: "no-cache" });
          if (!res.ok) throw new Error(`could not fetch ${url}: HTTP ${res.status}`);
          const buf = await res.arrayBuffer();

          /* The manifest carries a digest; a truncated or substituted download
           * should fail here rather than as a verify mismatch after the write
           * has already replaced the bootloader. */
          if (newest.value.sha256) {
            const got = await sha256Hex(buf);
            if (got !== newest.value.sha256) {
              throw new Error(`downloaded image does not match the manifest digest ` +
                              `(expected ${newest.value.sha256.slice(0, 16)}…, got ${got.slice(0, 16)}…)`);
            }
            log("digest matches the manifest", "ok");
          }
          await writeImage(newest.value.file, new TextDecoder().decode(buf));
        });
      } catch { /* reported */ }
    }

    async function flashCustom(e) {
      const file = e.target.files?.[0];
      e.target.value = "";
      if (!file) return;
      try {
        await guard("flashing", async () => writeImage(file.name, await file.text()));
      } catch { /* reported */ }
    }

    /* --- probe ---------------------------------------------------------- */

    async function connect() {
      try {
        await guard("connecting", async () => {
          const f = await Nrf54lFlasher.connect(log);
          flasher.value = f;
          dpidr.value = await f.attach();
          protectedPart.value = await f.isProtected();
          if (protectedPart.value) {
            log("MEM-AP is locked (APPROTECT) — mass erase is required before flashing", "warn");
            return;
          }
          const csw = await f.setupMemAp();
          log(`MEM-AP ready, CSW=0x${hex8(csw)} (secure access)`);
          await f.checkSystemBus();
          log("debug port up, system bus reachable", "ok");
        });
      } catch { /* reported */ }
    }

    async function disconnect() {
      if (!flasher.value) return;
      await flasher.value.close();
      flasher.value = null;
      dpidr.value = 0;
      protectedPart.value = false;
      log("probe released");
    }

    async function massErase() {
      if (!confirm("Mass erase?\n\nThis destroys everything in the chip's internal " +
                   "memory — firmware and settings — and unlocks the debug port. " +
                   "Files on the external flash (/lfs1) are not touched.")) return;
      try {
        await guard("erasing", async () => {
          log("mass erasing via CTRL-AP…");
          await flasher.value.massErase();
          dpidr.value = await flasher.value.attach();
          protectedPart.value = await flasher.value.isProtected();
          await flasher.value.setupMemAp();
          await flasher.value.checkSystemBus();
          log("erased and unlocked", "ok");
        });
      } catch { /* reported */ }
    }

    function close() {
      if (busy.value) return;
      disconnect();
      emit("close");
    }

    onUnmounted(() => { if (flasher.value) flasher.value.close(); });

    return {
      webUsbAvailable: webUsbAvailable(), EXPECTED_DPIDR, connected,
      flasher, dpidr, protectedPart, busy, error, lines, progress,
      newest, newestError,
      attached, recognised, ready,
      connect, disconnect, flashNewest, flashCustom, massErase, close,
      hex: hex8, fmtSize,
    };
  },
  template: /* html */ `
    <div id="flash-overlay" v-if="open" @click.self="close">
      <div class="cfg-modal" role="dialog" aria-modal="true" aria-label="Update updater firmware">

        <div class="cfg-head">
          <span class="title">UPDATE UPDATER</span>
          <span class="path">Bluetooth or USB</span>
          <span class="grow"></span>
          <button :disabled="!!busy" title="Close" @click="close">✕</button>
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
            Programs through the on-board debug probe — nothing to install. This is
            also the way back if a Bluetooth update ever leaves the device unable
            to advertise.
          </p>

          <div class="cfg-banner err" v-if="connected">
            Still connected over Bluetooth. Flashing over USB halts the CPU, which
            takes the Bluetooth link down with it — disconnect first, or use the
            Bluetooth route above.
          </div>

          <div class="cfg-banner err" v-if="!webUsbAvailable">
            This browser has no WebUSB. Chrome or Edge on desktop can flash;
            Firefox, Safari and every browser on iOS cannot.
          </div>

          <template v-else>
            <div class="cfg-section-sub">Probe</div>
            <div class="flash-step">
              <button v-if="!attached" class="primary" :disabled="!!busy" @click="connect">
                {{ busy === "connecting" ? "Connecting…" : "Connect probe" }}
              </button>
              <template v-else>
                <span class="flash-ok">▲</span>
                <span class="mono">DPIDR 0x{{ hex(dpidr) }}</span>
                <span class="flash-note" v-if="recognised">nRF54L</span>
                <span class="flash-note warn" v-else>
                  unrecognised part — expected 0x{{ hex(EXPECTED_DPIDR) }}
                </span>
                <span class="grow"></span>
                <button class="small" :disabled="!!busy" @click="disconnect">Release</button>
              </template>
            </div>

            <div class="cfg-banner err" v-if="protectedPart">
              The debug port answers but memory access is blocked (APPROTECT).
              A mass erase is the only way in, and it wipes the chip.
              <button class="small danger" :disabled="!!busy" @click="massErase">
                {{ busy === "erasing" ? "Erasing…" : "Mass erase & unlock" }}
              </button>
            </div>

            <div class="cfg-section-sub">Write</div>

            <!-- Each button is the whole operation: fetch or pick, check, halt,
                 write, verify, reset. -->
            <div class="flash-step">
              <button class="primary" :disabled="!ready || !newest" @click="flashNewest">
                {{ busy === "flashing" ? "Flashing…" : "Flash newest" }}
              </button>
              <span class="flash-note" v-if="newest">
                <strong v-if="newest.version">v{{ newest.version }}</strong><template
                  v-if="newest.version && newest.tag"> · </template><template
                  v-if="newest.tag">{{ newest.tag }}</template><template
                  v-if="newest.bytes"> · {{ fmtSize(newest.bytes) }}</template><template
                  v-if="newest.published"> · {{ newest.published.slice(0, 10) }}</template>
              </span>
              <span class="flash-note warn" v-else>
                no published build available{{ newestError ? " (" + newestError + ")" : "" }}
              </span>
            </div>

            <div class="flash-step">
              <label class="btn" :class="{ disabled: !ready }">
                {{ busy === "flashing" ? "Flashing…" : "Flash custom .hex…" }}
                <input type="file" accept=".hex" :disabled="!ready" @change="flashCustom">
              </label>
              <span class="flash-note">
                writes the file you choose, straight away — use <code>merged.hex</code>,
                not <code>zephyr.hex</code>
              </span>
            </div>

            <div class="flash-step" v-if="!attached || connected">
              <span class="flash-note err" v-if="connected">disconnect Bluetooth first</span>
              <span class="flash-note" v-else>connect the probe first</span>
            </div>

            <div class="flash-progress" v-if="progress.shown">
              <div class="bar"><div class="fill" :style="{ width: progress.pct + '%' }"></div></div>
              <span class="mono">{{ progress.label }} {{ progress.pct }}%</span>
            </div>

            <pre class="flash-log" v-if="lines.length"><span v-for="l in lines" :key="l.id"
              :class="l.cls">{{ l.msg }}\n</span></pre>
          </template>
        </div>

        <div class="cfg-foot">
          <span class="cfg-status err" v-if="error">{{ error }}</span>
          <span class="grow"></span>
          <button :disabled="!!busy" @click="close">Close</button>
        </div>

      </div>
    </div>
  `,
};

async function sha256Hex(buf) {
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
}
