import { ref, computed, watch, onUnmounted } from "../vue.js";
import Icon from "./Icon.js";
import { probeTargetFor } from "../lib/probe-targets.js";
import { parseIntelHex, totalBytes, lowAddress, highAddress } from "../lib/intel-hex.js";
import { fmtSize } from "../lib/format.js";
import { assetUrl } from "../lib/firmware-manifest.js";
import { useFlashRun, fetchChecked } from "../flash-run.js";

/*
 * The `cmsis-dap` flasher: SWD through the XIAO nRF54LM20A's on-board SAMD11.
 *
 * Split out of FlashDialog when the other two boards got flashers of their
 * own. Nothing here changed in the move; what it stopped being is the *only*
 * thing the dialog knew how to do.
 *
 * It stays visibly different from the two serial flashers, because it is: the
 * probe is a separate piece of silicon that is always awake, so attaching to
 * it is its own step with its own diagnosis (APPROTECT is recoverable from
 * here and from no other GUI tool this hardware has). The serial flashers have
 * nothing to attach *to* until the user has put the target in bootloader mode,
 * so they are one button.
 *
 * ---- Two boards, and the DPIDR does not tell them apart -----------------
 *
 * The XIAO nRF54LM20A and the XIAO MG24 both arrive here: same probe, same
 * API, same merged hex, same "nothing to press". Their flash controllers are
 * completely different, and **they answer the same DPIDR** (0x6ba02477 is a
 * generic ARM debug-port ID). So the algorithm is selected from the board the
 * manifest names, in probe-targets.js, and this component refuses a board it
 * has no profile for rather than falling back to one — the fallback would
 * write one part's flash-controller registers into the other's peripheral
 * space. See that file for the whole argument.
 *
 * The DPIDR is still shown and still checked, because "no SWD response" and
 * "something answered but it is not what we expect" are different problems.
 * It just is not what decides anything.
 */

const hex8 = (n) => (n >>> 0).toString(16).padStart(8, "0");

export default {
  name: "ProbeFlash",
  components: { Icon },
  props: {
    entry: { type: Object, default: null },   // the manifest entry for this board
    blocked: { type: String, default: "" },   // non-empty = why we must not run
  },
  /* The dialog refuses to close while a write is running — see FlashDialog. */
  emits: ["busy"],
  setup(props, { emit }) {
    const { busy, error, lines, progress, log, guard, track } = useFlashRun();
    watch(busy, (v) => emit("busy", v));
    const flasher = ref(null);
    const dpidr = ref(0);
    const protectedPart = ref(false);

    /* The profile for the board this entry is for, or null. Everything below
     * that touches hardware goes through it. */
    const target = computed(() => probeTargetFor(props.entry?.board));
    const partName = computed(() => target.value?.flasher.PART ?? "");
    const expectedDpidr = computed(() => target.value?.flasher.EXPECTED_DPIDR ?? 0);
    /* Only the nRF54L has an unlock path (CTRL-AP). Asked of the class rather
     * than of a board list, so a part that gains one gets the button by
     * implementing massErase() and not by being remembered here. */
    const canUnlock = computed(() => !!target.value?.flasher.CAN_UNLOCK);

    const attached = computed(() => !!flasher.value && dpidr.value !== 0);
    const recognised = computed(() => dpidr.value === expectedDpidr.value);
    const ready = computed(() =>
      attached.value && !busy.value && !props.blocked && !!target.value);

    /*
     * Returns { fatal: [], warn: [] }. Fatal aborts the write.
     *
     * No longer reachable by picking the wrong file — the image comes from the
     * manifest — so what this now catches is a *staging* bug, which is the more
     * dangerous version of the same mistake: published to everyone rather than
     * chosen by one person.
     */
    function inspect(chunks) {
      const g = target.value.geometry;
      const lo = lowAddress(chunks), hi = highAddress(chunks);
      const fatal = [], warn = [];

      /* `g.base` is not decoration. The nRF54L maps its program memory at 0
       * and the EFR32 at 0x08000000, so "starts at 0" is the *correct* image
       * on one board and the wrong one on the other — which makes this check
       * also a check that the right board's image is in front of us. */
      if (lo !== g.base) {
        fatal.push(`starts at 0x${hex8(lo)}, not 0x${hex8(g.base)} — no reset vector. ` +
                   `The staged image looks bootloader-relative (a zephyr.hex rather ` +
                   `than a merged.hex), or built for a different board; the device ` +
                   `would not boot from it. This is a build or staging fault, not ` +
                   `something to retry.`);
      }
      if (hi >= g.base + g.size) {
        fatal.push(`runs to 0x${hex8(hi)}, past the end of the ${fmtSize(g.size)} ${g.memory}.`);
      } else if (hi >= g.base + g.storage) {
        warn.push(`overlaps storage_partition at 0x${hex8(g.base + g.storage)} — ` +
                  `settings will be overwritten.`);
      }
      if (lo === g.base && hi < g.base + g.slot0) {
        warn.push("bootloader only, no application — the device will boot MCUboot and stop there.");
      }
      return { fatal, warn };
    }

    /** Parse, check, halt, write, verify, reset. */
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

      await f.program(chunks, track("Writing"));
      log(`wrote ${totalBytes(chunks)} bytes`, "ok");

      await f.verify(chunks, track("Verifying"));
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
          const url = assetUrl(props.entry, props.entry.file);
          log(`fetching ${props.entry.tag ?? "newest"} (${url})…`);
          const buf = await fetchChecked(url, props.entry.sha256, log);
          await writeImage(props.entry.file, new TextDecoder().decode(buf));
        });
      } catch { /* reported */ }
    }

    async function connect() {
      try {
        await guard("connecting", async () => {
          if (!target.value) {
            /* Refuse rather than default. See the header, and probe-targets.js. */
            throw new Error(
              `no flash algorithm for board '${props.entry?.board ?? "(none)"}'. ` +
              `This client can write ${Object.values(
                (await import("../lib/probe-targets.js")).PROBE_TARGETS)
                .map(t => t.label).join(" and ")} over a probe.`);
          }
          log(`target: ${partName.value}`);
          const f = await target.value.flasher.connect(log);
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
      if (!canUnlock.value) return;
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

    onUnmounted(() => { if (flasher.value) flasher.value.close(); });

    return {
      busy, error, lines, progress,
      dpidr, protectedPart, attached, recognised, ready,
      target, partName, expectedDpidr, canUnlock,
      connect, disconnect, flashNewest, massErase,
      hex: hex8, fmtSize,
    };
  },
  template: /* html */ `
    <div class="cfg-section-sub">Probe</div>
    <div class="flash-step">
      <button v-if="!attached" class="primary" :disabled="!!busy" @click="connect">
        {{ busy === "connecting" ? "Connecting…" : "Connect probe" }}
      </button>
      <template v-else>
        <span class="flash-ok">▲</span>
        <span class="mono">DPIDR 0x{{ hex(dpidr) }}</span>
        <span class="flash-note" v-if="recognised">{{ partName }}</span>
        <span class="flash-note warn" v-else>
          unrecognised debug port — expected 0x{{ hex(expectedDpidr) }}
        </span>
        <span class="grow"></span>
        <button class="small" :disabled="!!busy" @click="disconnect">Release</button>
      </template>
    </div>

    <div class="cfg-banner err" v-if="protectedPart && canUnlock">
      The debug port answers but memory access is blocked (APPROTECT).
      A mass erase is the only way in, and it wipes the chip.
      <button class="small danger" :disabled="!!busy" @click="massErase">
        {{ busy === "erasing" ? "Erasing…" : "Mass erase & unlock" }}
      </button>
    </div>

    <div class="cfg-section-sub">Write</div>
    <div class="flash-step">
      <button class="primary" :disabled="!ready || !entry" @click="flashNewest">
        <Icon name="bolt_boost" :size="18"/>{{ busy === "flashing" ? "Flashing…" : "Flash newest" }}
      </button>
      <span class="flash-note" v-if="entry">
        <strong v-if="entry.version">v{{ entry.version }}</strong><template
          v-if="entry.bytes"> · {{ fmtSize(entry.bytes) }}</template><template
          v-if="entry.published"> · {{ entry.published.slice(0, 10) }}</template>
      </span>
    </div>

    <div class="flash-step" v-if="!attached || blocked || !target">
      <span class="flash-note err" v-if="blocked">{{ blocked }}</span>
      <span class="flash-note err" v-else-if="!target">
        This client has no flash algorithm for {{ entry ? entry.board : "this board" }},
        so it cannot be written over the probe. Bluetooth is unaffected.
      </span>
      <span class="flash-note" v-else>connect the probe first</span>
    </div>

    <div class="flash-progress" v-if="progress.shown">
      <div class="bar"><div class="fill" :style="{ width: progress.pct + '%' }"></div></div>
      <span class="mono">{{ progress.label }} {{ progress.pct }}%</span>
    </div>

    <pre class="flash-log" v-if="lines.length"><span v-for="l in lines" :key="l.id"
      :class="l.cls">{{ l.msg }}\n</span></pre>

    <div class="cfg-status err" v-if="error">{{ error }}</div>
  `,
};
