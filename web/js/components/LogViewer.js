import { ref, reactive, computed, watch } from "../vue.js";
import { smp, entries, log as appLog } from "../store.js";
import { fmtSize } from "../lib/format.js";
import {
  parseLog, filterLog, levelCounts, isLogPath, logIndex, LEVELS,
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
  props: { open: Boolean, path: String },
  emits: ["close"],
  setup(props, { emit }) {
    const lines = ref([]);
    const loading = ref(false);
    const error = ref("");
    const bytes = ref(0);
    const pct = ref(0);
    const filter = reactive({ level: "dbg", text: "" });
    const pane = ref(null);

    /* Every log file on the device, oldest first. The backend numbers them in
     * write order, so ascending index is chronological. */
    const files = computed(() =>
      entries.value
        .map(e => `/lfs1/${e.name}`)
        .filter(isLogPath)
        .sort((a, b) => logIndex(a) - logIndex(b)));

    const current = ref("");
    watch(() => [props.open, props.path], ([isOpen, p]) => {
      if (!isOpen) return;
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
          <span class="path">{{ current || "no log files" }}</span>
          <span class="grow"></span>
          <button title="Close" @click="close">✕</button>
        </div>

        <div class="logv-bar">
          <select v-model="current" @change="load(current)" :disabled="loading"
                  aria-label="Log file">
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
          <button class="small" @click="load(current)" :disabled="loading || !current">
            {{ loading ? "Reading…" : "Reload" }}
          </button>
          <button class="small" @click="copy" :disabled="!shown.length">Copy</button>
          <button class="small" @click="download" :disabled="!lines.length">Save</button>
        </div>

        <div class="logv-status">
          <template v-if="loading">reading {{ current }}… {{ pct }}%</template>
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
          <span class="cfg-status" v-if="files.length > 1">
            {{ files.length }} files, oldest first — the firmware rotates them
          </span>
          <span class="grow"></span>
          <button @click="close">Close</button>
        </div>

      </div>
    </div>
  `,
};
