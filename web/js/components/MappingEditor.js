import { ref, computed, watch } from "../vue.js";
import { parseMapping, serializeMapping } from "../lib/config-file.js";
import { entries, currentPath } from "../store.js";

/*
 * Rule editor for ble_firmware_mapping.
 *
 * The stored value is one packed string ("RAK:rak4631*.zip|XIAO:xiao_*.zip")
 * because config.c's parser is line-oriented and the whole file has to fit in
 * 1023 bytes. That is a fine wire format and a terrible thing to type: the
 * separator, the colon split and the glob semantics are all invisible, and a
 * malformed rule is discarded by the firmware without a word.
 *
 * So the string is only ever a serialisation here. The editor works on rows,
 * and the model value is regenerated from them on every change.
 */
export default {
  name: "MappingEditor",
  props: {
    modelValue: { type: String, default: "" },
    maxLength: { type: Number, default: 191 },
  },
  emits: ["update:modelValue"],
  setup(props, { emit }) {
    const rows = ref([]);

    /* A malformed rule still has to be editable — dropping it would silently
     * destroy whatever the operator was in the middle of typing. Split it as
     * best we can and let the empty half show as the error it is. */
    const rowFor = (raw) => {
      const i = raw.indexOf(":");
      return i < 0
        ? { name: raw.trim(), file: "" }
        : { name: raw.slice(0, i).trim(), file: raw.slice(i + 1).trim() };
    };

    /* Only rebuild from the prop when it actually says something different
     * from what we already hold, or every keystroke would reset the cursor. */
    watch(() => props.modelValue, (v) => {
      if (serializeMapping(rows.value) === (v ?? "")) return;
      const { rules, bad } = parseMapping(v);
      rows.value = [...rules.map(r => ({ ...r })), ...bad.map(rowFor)];
    }, { immediate: true });

    const push = () => emit("update:modelValue", serializeMapping(rows.value));

    const add = () => { rows.value.push({ name: "", file: "" }); push(); };
    const remove = (i) => { rows.value.splice(i, 1); push(); };
    const move = (i, d) => {
      const j = i + d;
      if (j < 0 || j >= rows.value.length) return;
      const [r] = rows.value.splice(i, 1);
      rows.value.splice(j, 0, r);
      push();
    };

    /* Suggest what is actually on the device. Globbing a versioned filename
     * is the thing an operator most wants and least wants to hand-write, so
     * offer both the literal name and a wildcard for its version suffix. */
    const suggestions = computed(() => {
      if (currentPath() !== "/lfs1") return [];
      const out = new Set();
      for (const e of entries.value) {
        if (e.type === 1) continue;                 // 1 = directory
        if (!/\.zip$/i.test(e.name)) continue;
        out.add(e.name);
        const stem = e.name.replace(/[-_.]?v?\d[\d._-]*\.zip$/i, "");
        if (stem && stem + ".zip" !== e.name) out.add(`${stem}*.zip`);
      }
      return [...out].sort();
    });

    const packed = computed(() => serializeMapping(rows.value));
    const size = computed(() => new TextEncoder().encode(packed.value).length);
    const incomplete = computed(() =>
      rows.value.filter(r => !r.name.trim() || !r.file.trim()).length);

    return {
      rows, add, remove, move, push, suggestions, packed, size, incomplete,
    };
  },
  template: /* html */ `
    <div class="map-editor">
      <p class="map-empty" v-if="!rows.length">
        No rules. Auto flash has nothing to choose from and will refuse to run —
        add one, or flash a specific bundle from the file list instead.
      </p>

      <div class="map-rule" v-for="(r, i) in rows" :key="i"
           :class="{ incomplete: !r.name.trim() || !r.file.trim() }">
        <span class="lead">name contains</span>
        <input class="map-name" type="text" v-model="r.name" @input="push"
               spellcheck="false" placeholder="RAK"
               :aria-label="'Rule ' + (i + 1) + ' — BLE name fragment'">
        <span class="arrow">→</span>
        <!-- The arrow's replacement when the rule stacks. An arrow says
             "these two, in this direction" and needs them side by side; once
             each field is on its own line it points at nothing. Both are in
             the markup and CSS picks one, rather than a v-if on a width. -->
        <span class="lead lead-file">flash</span>
        <input class="map-file" type="text" v-model="r.file" @input="push"
               spellcheck="false" placeholder="rak4631*.zip"
               :list="suggestions.length ? 'map-files' : null"
               :aria-label="'Rule ' + (i + 1) + ' — firmware file pattern'">
        <span class="map-ops">
          <button class="small" @click="move(i, -1)" :disabled="i === 0"
                  title="Earlier — rules are tried in order, first match wins">↑</button>
          <button class="small" @click="move(i, 1)" :disabled="i === rows.length - 1"
                  title="Later">↓</button>
          <button class="small danger" @click="remove(i)" title="Remove this rule">✕</button>
        </span>
      </div>

      <datalist id="map-files" v-if="suggestions.length">
        <option v-for="s in suggestions" :key="s" :value="s"></option>
      </datalist>

      <div class="map-foot">
        <button class="small" @click="add">+ Add rule</button>
        <span class="grow"></span>
        <span class="map-hint" v-if="incomplete">
          {{ incomplete }} incomplete rule(s) — the firmware discards these silently
        </span>
        <span class="map-hint" v-else-if="rows.length">
          tried in order, first match wins · latest matching file wins
        </span>
        <span class="map-size" :class="{ err: size > maxLength }">{{ size }} / {{ maxLength }} B</span>
      </div>
    </div>
  `,
};
