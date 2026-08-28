import { ref, reactive, computed, watch, onUnmounted } from "../vue.js";
import { smp, entries, log as appLog } from "../store.js";
import { fmtSize } from "../lib/format.js";
import {
  parseLog, parseLogLine, filterLog, levelCounts, isLogPath, logIndex, LEVELS,
  createLineAssembler,
} from "../lib/log-file.js";

/*
 * Viewer for /lfs1/LOG.NNNN.
 *
 * The device has no console once it is off USB, which is exactly when it is
 * doing the thing you want to know about — a DFU in the field, on battery.
 * These files are the only record, and downloading a 32 KB blob to open in a
 * text editor is a poor substitute for reading it here.
 *
 * Levels are colourised and filterable because the interesting lines are a
 * handful of <err>/<wrn> in a few thousand <inf>.
 */
export default {
  name: "LogViewer",
  /* `startLive` opens straight into the stream instead of reading a file.
   * Named apart from the internal `live` ref so the template cannot resolve
   * one when it means the other. */
  props: { open: Boolean, path: String, startLive: Boolean },
  emits: ["close"],
  setup(props, { emit }) {
    const lines = ref([]);
    const loading = ref(false);
    const error = ref("");
    const bytes = ref(0);
    const pct = ref(0);
    const filter = reactive({ level: "dbg", text: "" });
    const pane = ref(null);

    /* --- live stream ---------------------------------------------------
     *
     * The firmware only emits while something is subscribed, so this toggle
     * is the on/off switch for the whole feature — including its cost to the
     * radio, which matters because the DFU stream and this share three TX
     * buffers. Off by default for that reason.
     */
    const live = ref(false);
    const liveSupported = ref(true);
    const follow = ref(true);
    const asm = createLineAssembler();   // notifications split mid-line

    const atBottom = () => {
      const el = pane.value;
      return !el || el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    };

    /* Notifications are cut at whatever fits an ATT payload, not at line
     * boundaries, so the tail of one is the head of the next. */
    function ingest(text) {
      const parts = asm.push(text);
      if (!parts.length) return;
      const stick = follow.value && atBottom();
      let id = lines.value.length;
      const add = parts.map(raw => ({ id: id++, ...parseLogLine(raw) }));
      /* Cap the buffer: a long DFU emits thousands of lines and an unbounded
       * array makes the pane slower the longer you watch it. */
      const next = [...lines.value, ...add];
      lines.value = next.length > 5000 ? next.slice(next.length - 5000) : next;
      bytes.value += text.length;
      if (stick) {
        requestAnimationFrame(() => {
          if (pane.value) pane.value.scrollTop = pane.value.scrollHeight;
        });
      }
    }

    async function toggleLive() {
      error.value = "";
      if (live.value) {
        live.value = false;
        await smp.stopLogStream();
        return;
      }
      try {
        const ok = await smp.startLogStream(ingest);
        if (!ok) {
          liveSupported.value = false;
          error.value = "this firmware has no live log service — reflash to use it";
          return;
        }
        /* A live view starts from now. Mixing it into a file read would put
         * two different time bases in one pane. */
        lines.value = [];
        bytes.value = 0;
        asm.reset();
        live.value = true;
      } catch (e) {
        error.value = e.message;
      }
    }

    watch(() => props.open, (isOpen) => {
      if (!isOpen && live.value) toggleLive();
      /* Opened from the DFU banner: the transfer is happening now, and the
       * file on flash is missing exactly the lines being asked for. */
      if (isOpen && props.startLive && !live.value) toggleLive();
    });
    onUnmounted(() => { if (live.value) smp.stopLogStream(); });

    /* Every log file on the device, oldest first. The backend numbers them in
     * write order, so ascending index is chronological. */
    const files = computed(() =>
      entries.value
        .map(e => `/lfs1/${e.name}`)
        .filter(isLogPath)
        .sort((a, b) => logIndex(a) - logIndex(b)));

    const current = ref("");
    watch(() => [props.open, props.path], ([isOpen, p]) => {
      /* props.startLive, not just live.value: toggleLive() is async and this
       * watcher can run before it has flipped the ref, which would load a
       * file underneath the stream that is about to start. */
      if (!isOpen || live.value || props.startLive) return;
      current.value = p && isLogPath(p) ? p : (files.value[files.value.length - 1] || "");
      if (current.value) load(current.value);
    }, { immediate: true });

    async function load(path) {
      loading.value = true;
      error.value = "";
      pct.value = 0;
      try {
        const buf = await smp.readFile(path, (f) => { pct.value = Math.floor(f * 100); });
        bytes.value = buf.length;
        /* A rotated file can be cut mid-line and a partial UTF-8 sequence at
         * the tail must not throw away the whole read. */
        lines.value = parseLog(new TextDecoder("utf-8", { fatal: false }).decode(buf));
        current.value = path;
      } catch (e) {
        error.value = e.message;
        lines.value = [];
        bytes.value = 0;
      } finally {
        loading.value = false;
        pct.value = 0;
        /* Newest lines are at the bottom, which is where you want to land. */
        requestAnimationFrame(() => {
          if (pane.value) pane.value.scrollTop = pane.value.scrollHeight;
        });
      }
    }

    const shown = computed(() => filterLog(lines.value, filter));
    const counts = computed(() => levelCounts(lines.value));

    function download() {
      const text = lines.value.map(l => l.raw).join("\n") + "\n";
      const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = current.value.split("/").pop() + ".txt";
      a.click();
      URL.revokeObjectURL(url);
      appLog(`saved ${current.value}`, "ok");
    }

    async function copy() {
      try {
        await navigator.clipboard.writeText(shown.value.map(l => l.raw).join("\n"));
        appLog(`copied ${shown.value.length} log line(s)`, "ok");
      } catch (e) {
        error.value = `copy failed: ${e.message}`;
      }
    }

    return {
      lines, shown, counts, files, current, loading, error, bytes, pct,
      filter, pane, LEVELS, fmtSize,
      live, liveSupported, follow, toggleLive,
      load, download, copy,
      shortName: (p) => p.split("/").pop(),
      close: () => emit("close"),
    };
  },
  template: /* html */ `
    <div id="log-overlay" v-if="open" @click.self="close">
      <div class="cfg-modal" role="dialog" aria-modal="true" aria-label="Device log">

        <div class="cfg-head">
          <span class="title">DEVICE LOG</span>
          <span class="path">{{ live ? "live from the device" : (current || "no log files") }}</span>
          <span class="grow"></span>
          <button title="Close" @click="close">✕</button>
        </div>

        <div class="logv-bar">
          <button class="icon-btn" :class="{ primary: live }" @click="toggleLive"
                  :disabled="!liveSupported"
                  :title="live ? 'Stop the live stream'
                               : 'Stream log lines from the device as they happen'"
                  aria-label="Live">
            <span class="live-dot" :class="{ on: live }"></span>
            <span class="label">{{ live ? "Live" : "Go live" }}</span>
          </button>

          <select v-model="current" @change="load(current)"
                  :disabled="loading || live" aria-label="Log file">
            <option v-for="f in files" :key="f" :value="f">{{ shortName(f) }}</option>
          </select>

          <select v-model="filter.level" aria-label="Minimum level">
            <option value="err">errors</option>
            <option value="wrn">warnings +</option>
            <option value="inf">info +</option>
            <option value="dbg">everything</option>
          </select>

          <input class="logv-find" type="search" v-model="filter.text"
                 placeholder="filter…" spellcheck="false" aria-label="Filter text">

          <span class="grow"></span>
          <label class="logv-follow" v-if="live" title="Scroll to the newest line">
            <input type="checkbox" v-model="follow"> follow
          </label>
          <button class="small" @click="load(current)" :disabled="loading || !current || live">
            {{ loading ? "Reading…" : "Reload" }}
          </button>
          <button class="small" @click="copy" :disabled="!shown.length">Copy</button>
          <button class="small" @click="download" :disabled="!lines.length">Save</button>
        </div>

        <div class="logv-status">
          <template v-if="live">
            live · {{ lines.length }} lines · {{ fmtSize(bytes) }} received
            <span class="err" v-if="counts.err">· {{ counts.err }} err</span>
            <span class="warn" v-if="counts.wrn">· {{ counts.wrn }} wrn</span>
            <template v-if="shown.length !== lines.length"> · showing {{ shown.length }}</template>
          </template>
          <template v-else-if="loading">reading {{ current }}… {{ pct }}%</template>
          <template v-else-if="error"><span class="err">{{ error }}</span></template>
          <template v-else-if="!files.length">
            No log files on the device. They appear as
            <code>/lfs1/LOG.0000</code> once the firmware has written something.
          </template>
          <template v-else>
            {{ fmtSize(bytes) }} · {{ lines.length }} lines
            <span class="err" v-if="counts.err">· {{ counts.err }} err</span>
            <span class="warn" v-if="counts.wrn">· {{ counts.wrn }} wrn</span>
            <template v-if="shown.length !== lines.length">
              · showing {{ shown.length }}
            </template>
          </template>
        </div>

        <pre class="logv-body" ref="pane"><template v-for="l in shown" :key="l.id"><span
          class="logv-line" :class="'lv-' + (l.level || 'raw')"><span class="ts"
          v-if="l.ts">{{ l.ts }}</span><span class="lvl" v-if="l.level">{{ l.level }}</span><span
          class="mod" v-if="l.module">{{ l.module }}</span>{{ l.msg }}</span>\n</template></pre>

        <div class="cfg-foot">
          <span class="cfg-status" v-if="live">
            the device only emits while this is open — dropped lines are marked inline
          </span>
          <span class="cfg-status" v-else-if="files.length > 1">
            {{ files.length }} files, oldest first — the firmware rotates them
          </span>
          <span class="grow"></span>
          <button @click="close">Close</button>
        </div>

      </div>
    </div>
  `,
};
