import { ref, reactive, computed, watch } from "../vue.js";
import { loadConfig, saveConfig, log } from "../store.js";
import {
  CONFIG_SCHEMA, CONFIG_PATH, CONFIG_MAX_BYTES,
  validateField, advisories, serializeConfig, encodedSize, defaults,
} from "../lib/config-file.js";
import MappingEditor from "./MappingEditor.js";

export default {
  name: "ConfigDialog",
  components: { MappingEditor },
  props: { open: Boolean },
  emits: ["close"],
  setup(props, { emit }) {
    const values   = reactive(defaults());
    const unknown  = ref([]);
    const ignored  = ref([]);
    const loaded   = ref(null);      // pristine copy, for the dirty check
    const exists   = ref(false);
    const loading  = ref(false);
    const saving   = ref(false);
    const error    = ref("");
    const showRaw  = ref(false);

    /* Per-key help, collapsed by default.
     *
     * Every description here is load-bearing — the tuning keys are actively
     * counter-intuitive and were each paid for with a hardware run. But
     * fourteen paragraphs at once turn the dialog into a document, and the
     * operator who already knows what pkt_gap_ms does has to scroll past all
     * of it. So the text stays, one (i) away.
     */
    const helpFor = reactive({});
    const helpOpen = (f) => !!helpFor[f.key];
    const toggleHelp = (f) => { helpFor[f.key] = !helpFor[f.key]; };
    const allHelp = computed(() => CONFIG_SCHEMA.every(f => helpFor[f.key]));
    const toggleAllHelp = () => {
      const on = !allHelp.value;
      for (const f of CONFIG_SCHEMA) helpFor[f.key] = on;
    };

    const apply = (src) => { for (const k of Object.keys(src)) values[k] = src[k]; };

    async function reload() {
      loading.value = true;
      error.value = "";
      try {
        const r = await loadConfig();
        apply(r.values);
        unknown.value = r.unknown;
        ignored.value = r.ignored;
        exists.value  = r.exists;
        loaded.value  = { ...r.values };
      } catch (e) {
        error.value = e.message;
      } finally {
        loading.value = false;
      }
    }

    watch(() => props.open, (isOpen) => { if (isOpen) reload(); });

    /* ---- validation ---- */
    const errors = computed(() => {
      const out = {};
      for (const f of CONFIG_SCHEMA) {
        const msg = validateField(f, values[f.key]);
        if (msg) out[f.key] = msg;
      }
      return out;
    });
    const hasErrors = computed(() => Object.keys(errors.value).length > 0);
    const notes     = computed(() => advisories(values));

    /* ---- serialized form + size budget ---- */
    const text = computed(() => serializeConfig(values, unknown.value));
    const size = computed(() => encodedSize(text.value));
    const overSize = computed(() => size.value > CONFIG_MAX_BYTES);

    const dirty = computed(() =>
      !loaded.value || CONFIG_SCHEMA.some(f => values[f.key] !== loaded.value[f.key]));

    const isModified = (f) => loaded.value && values[f.key] !== loaded.value[f.key];
    const isDefault  = (f) => values[f.key] === f.def;
    const resetField = (f) => { values[f.key] = f.def; };
    const resetAll   = () => apply(defaults());

    /* A value outside the allowed set still has to be displayed. The nRF54L
     * implements only a handful of TX levels and the SoftDevice clips
     * anything else silently, so a file carrying an off-list tx_power (older
     * builds seeded 4) describes a level the radio never runs at. Surface
     * that rather than snapping the dropdown to something the device isn't
     * using.
     */
    const optionsFor = (f) => {
      const cur = Number(values[f.key]);
      const known = f.options.some(o => o.value === cur);
      return known
        ? f.options
        : [...f.options, { value: cur, label: `${cur} dBm (clipped by SoftDevice)` }]
            .sort((a, b) => a.value - b.value);
    };

    const fieldNote = (f) => (typeof f.note === "function" ? f.note(values[f.key]) : null);

    /* An empty-string default resets to nothing, and "default " reads as a
     * truncation. Say what the button does instead. */
    const defLabel = (f) => {
      if (f.type === "bool") return `default ${f.def ? "on" : "off"}`;
      if (f.def === "") return "clear";
      return `default ${f.def}`;
    };

    async function save() {
      saving.value = true;
      error.value = "";
      try {
        await saveConfig(values, unknown.value);
        loaded.value = { ...values };
        emit("close");
      } catch (e) {
        error.value = e.message;
      } finally {
        saving.value = false;
      }
    }

    function close() {
      if (dirty.value && !confirm("Discard unsaved configuration changes?")) return;
      emit("close");
    }

    return {
      schema: CONFIG_SCHEMA, CONFIG_PATH, CONFIG_MAX_BYTES,
      values, unknown, ignored, exists, loading, saving, error, showRaw,
      errors, hasErrors, notes, text, size, overSize, dirty,
      isModified, isDefault, resetField, resetAll, optionsFor, fieldNote,
      helpOpen, toggleHelp, allHelp, toggleAllHelp, defLabel,
      save, close, reload,
    };
  },
  template: /* html */ `
    <div id="cfg-overlay" :class="{ shown: open }" v-if="open" @click.self="close">
      <div class="cfg-modal" role="dialog" aria-modal="true" aria-label="Updater configuration">

        <div class="cfg-head">
          <span class="title">CONFIGURATION</span>
          <span class="path">{{ CONFIG_PATH }}</span>
          <span class="grow"></span>
          <button class="small" @click="toggleAllHelp"
                  :title="allHelp ? 'Collapse every description' : 'Expand every description'">
            {{ allHelp ? "Hide all help" : "Show all help" }}
          </button>
          <button title="Close without saving" @click="close">✕</button>
        </div>

        <div class="cfg-body">
          <p class="cfg-lede">
            Re-read before <em>every</em> DFU attempt, so a corrected file uploaded
            mid-run applies to the next one. Values the firmware would reject are
            blocked here, because
            <code>apply_kv()</code> ignores them silently and keeps its default.
          </p>

          <p class="cfg-status" v-if="loading">reading {{ CONFIG_PATH }}…</p>
          <p class="cfg-status" v-else-if="!exists">
            No {{ CONFIG_PATH }} on the device — showing the firmware's built-in
            defaults. Saving creates the file.
          </p>

          <div class="cfg-banner err" v-for="ig in ignored" :key="ig.key">
            <code>{{ ig.key }}={{ ig.value }}</code> in the file is being ignored by
            the firmware — {{ ig.reason }}. The value shown below is what the device
            is actually running.
          </div>

          <template v-for="f in schema" :key="f.key">
            <div class="cfg-section" v-if="f.section">{{ f.section }}</div>

            <div class="cfg-row"
                 :class="{ invalid: errors[f.key], modified: isModified(f),
                           wide: !!f.editor, open: helpOpen(f) }">
              <div class="cfg-name">
                <!-- Custom editors are a group of inputs, not one labelable
                     control, so they get an aria-label instead of a for=. -->
                <label :for="f.editor ? null : 'cfg-' + f.key">
                  {{ f.title }}
                  <span class="key">{{ f.label }}</span>
                </label>
                <button class="cfg-info" @click="toggleHelp(f)"
                        :aria-expanded="helpOpen(f) ? 'true' : 'false'"
                        :aria-controls="'help-' + f.key"
                        :title="(helpOpen(f) ? 'Hide' : 'Show') + ' what ' + f.label + ' does'">
                  i
                </button>
              </div>

              <div class="ctl">
                <button class="cfg-def" :disabled="isDefault(f)" @click="resetField(f)"
                        :title="'Reset to the firmware default (' + (f.def === '' ? 'empty' : f.def) + ')'">
                  {{ defLabel(f) }}
                </button>

                <template v-if="!f.editor">
                  <input v-if="f.type === 'text'" type="text" :id="'cfg-' + f.key"
                         v-model="values[f.key]" :maxlength="f.maxLength"
                         :placeholder="f.placeholder" spellcheck="false">

                  <input v-else-if="f.type === 'int'" type="number" :id="'cfg-' + f.key"
                         v-model.number="values[f.key]" :min="f.min" :max="f.max" step="1">

                  <input v-else-if="f.type === 'bool'" type="checkbox" :id="'cfg-' + f.key"
                         v-model="values[f.key]">

                  <select v-else-if="f.type === 'select'" :id="'cfg-' + f.key"
                          v-model.number="values[f.key]">
                    <option v-for="o in optionsFor(f)" :key="o.value" :value="o.value">
                      {{ o.label }}
                    </option>
                  </select>

                  <span class="unit" v-if="f.unit">{{ f.unit }}</span>
                </template>
              </div>

              <div class="cfg-wide" v-if="f.editor === 'mapping'">
                <MappingEditor :id="'cfg-' + f.key" role="group" :aria-label="f.title"
                               v-model="values[f.key]" :max-length="f.maxLength" />
              </div>

              <!-- Errors show unconditionally: a blocked save must say why
                   without the operator having to go looking for it. Only the
                   explanatory text hides. -->
              <div class="note err" v-if="errors[f.key]">{{ errors[f.key] }}</div>

              <div class="cfg-help" :id="'help-' + f.key" v-show="helpOpen(f)">
                <div class="desc">{{ f.desc.replace(/\\s+/g, " ").trim() }}</div>
                <div class="note" v-if="fieldNote(f)">{{ fieldNote(f) }}</div>
              </div>
            </div>
          </template>

          <div class="cfg-section" v-if="notes.length || unknown.length">Notes</div>
          <div class="cfg-banner warn" v-for="(n, i) in notes" :key="'n' + i">{{ n }}</div>

          <div class="cfg-banner" v-if="unknown.length">
            {{ unknown.length }} key(s) in the file aren't known to this client and
            will be written back unchanged:
            <code>{{ unknown.join(", ") }}</code>
          </div>

          <div class="cfg-raw">
            <button class="small" @click="showRaw = !showRaw">
              {{ showRaw ? "Hide" : "Show" }} file preview
            </button>
            <pre class="cfg-extra" :class="{ shown: showRaw }">{{ text }}</pre>
          </div>
        </div>

        <div class="cfg-foot">
          <span class="cfg-status" :class="{ err: overSize }">
            {{ size }} / {{ CONFIG_MAX_BYTES }} B
          </span>
          <span class="cfg-status err" v-if="error">{{ error }}</span>
          <span class="grow"></span>
          <button @click="reload" :disabled="loading || saving">Reload</button>
          <button @click="resetAll" :disabled="saving">Reset all</button>
          <button class="primary" @click="save"
                  :disabled="hasErrors || overSize || saving || loading">
            {{ saving ? "Saving…" : "Save to device" }}
          </button>
        </div>

      </div>
    </div>
  `,
};
