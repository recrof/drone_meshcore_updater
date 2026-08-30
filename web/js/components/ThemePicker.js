import { ref, onMounted, onBeforeUnmount } from "../vue.js";
import Icon from "./Icon.js";
import {
  PALETTES, MODE_LABEL, MODE_ICON,
  loadTheme, applyTheme, saveTheme, nextMode,
} from "../lib/theme.js";

/*
 * The appearance controls: a mode button and a palette menu.
 *
 * Both apply immediately and write to localStorage in the same breath — there
 * is no Save. A preference you have to confirm is one you cannot try, and
 * trying is the entire way anyone picks a colour.
 *
 * ---- Why the palette is behind a button ---------------------------------
 *
 * Seven swatches in the header is seven controls competing with Connect and
 * Disconnect, which are what people are actually here for. Behind one icon it
 * is a thing you go and find once and then never see again — which is the
 * correct weight for a colour preference.
 *
 * ---- What the menu has to get right -------------------------------------
 *
 * A popup that only closes by clicking its own button is a popup that gets
 * stuck over the thing you were trying to reach. This one closes on Escape,
 * on a click anywhere outside it, and on choosing something. The outside-click
 * listener is added on mount and removed on unmount rather than added when the
 * menu opens: an open menu whose listener leaked would keep closing menus that
 * no longer exist.
 */
export default {
  name: "ThemePicker",
  components: { Icon },
  setup() {
    const state = ref(loadTheme());
    const open = ref(false);
    const root = ref(null);

    /* Applied on mount as well as on change: index.html's inline bootstrap has
     * already done this, but that copy exists to beat the first paint, not to
     * be the only one. If it were removed, or the page embedded somewhere
     * without it, the app would still come up right. */
    applyTheme(state.value);

    const set = (next) => {
      state.value = next;
      applyTheme(next);
      saveTheme(next);
    };

    const onDocPointer = (e) => {
      if (open.value && root.value && !root.value.contains(e.target)) {
        open.value = false;
      }
    };
    const onKey = (e) => { if (e.key === "Escape") open.value = false; };

    onMounted(() => {
      document.addEventListener("pointerdown", onDocPointer);
      document.addEventListener("keydown", onKey);
    });
    onBeforeUnmount(() => {
      document.removeEventListener("pointerdown", onDocPointer);
      document.removeEventListener("keydown", onKey);
    });

    return {
      PALETTES, MODE_LABEL, MODE_ICON,
      state, open, root,
      label: () => PALETTES.find(p => p.id === state.value.palette)?.label ?? "",
      pick: (palette) => { set({ ...state.value, palette }); open.value = false; },
      cycle: () => set({ ...state.value, mode: nextMode(state.value.mode) }),
    };
  },
  template: /* html */ `
    <div class="theme-ctl" ref="root">
      <!-- Says what the appearance *is*, not what clicking does. A button
           labelled "Dark" that switches to dark is ambiguous in exactly the way
           a light/dark toggle always is, so the icon carries the state and the
           title carries the action. -->
      <button class="icon-only"
              :title="'Appearance: ' + MODE_LABEL[state.mode] +
                      (state.mode === 'system' ? ' (follows your device)' : '') +
                      ' — click to change'"
              :aria-label="'Appearance: ' + MODE_LABEL[state.mode] + '. Click to change.'"
              @click="cycle">
        <Icon :name="MODE_ICON[state.mode]"/>
      </button>

      <button class="icon-only"
              aria-haspopup="true"
              :aria-expanded="open ? 'true' : 'false'"
              :title="'Accent colour: ' + label()"
              :aria-label="'Accent colour: ' + label() + '. Click to change.'"
              @click="open = !open">
        <Icon name="palette"/>
      </button>

      <!-- v-if, not v-show: nothing here needs to be found while closed, and a
           menu left in the DOM is a menu that can take a click through the
           header. -->
      <div class="theme-menu" v-if="open" role="menu" aria-label="Accent colour">
        <button v-for="p in PALETTES" :key="p.id"
                class="theme-opt" role="menuitemradio"
                :aria-checked="state.palette === p.id ? 'true' : 'false'"
                :class="{ on: state.palette === p.id }"
                @click="pick(p.id)">
          <span class="swatch" :style="{ '--sw': 'var(--pal-' + p.id + ')' }"></span>
          <span class="opt-label">{{ p.label }}</span>
        </button>
      </div>
    </div>
  `,
};
