import Icon from "./Icon.js";

/*
 * A small stack of glyphs that plays as a loop.
 *
 * Used where an icon has to say "this is happening now" rather than "this is
 * what it is": the scanner's two tabs, where the difference between a live
 * survey and a stopped one is the single most useful thing on the screen and
 * was previously carried only by a word.
 *
 * ---- Why every frame is rendered, and only opacity moves ----------------
 *
 * The obvious implementation is a timer that swaps `name`. That re-renders on
 * every frame forever, for decoration, on a page that is often mid-DFU — and
 * it keeps running whether or not anyone can see it. Stacking the frames and
 * animating opacity in CSS costs one paint per step, no JS, and stops dead
 * under `prefers-reduced-motion`.
 *
 * It only reads as motion because the frames are *related*: wifi_1_bar,
 * wifi_2_bar and wifi are nested subsets of one shape, and the two bluetooth
 * glyphs differ only by the search arcs. A cycle of unrelated icons would be a
 * flicker, not an animation.
 *
 * ---- The resting frame is the last one ----------------------------------
 *
 * When it is not playing, the final frame shows — the complete glyph, the one
 * that means the plain thing (`bluetooth`, `wifi`). So a stopped scanner shows
 * a normal icon rather than a partial one frozen mid-sweep, which would read
 * as a broken signal rather than as an idle radio.
 */
export default {
  name: "IconCycle",
  components: { Icon },
  props: {
    /* Weakest/emptiest first, complete last — see the resting-frame note. */
    names: { type: Array, required: true },
    size: { type: Number, default: 20 },
    playing: { type: Boolean, default: false },
  },
  setup(props) {
    /* The keyframes cannot be parameterised on frame count — a CSS variable
     * cannot set a keyframe percentage — so there is one class per length and
     * config.css defines the two we use. An unexpected length still renders,
     * it simply does not animate, which is the right way to fail here. */
    return { cls: () => `cycle-${props.names.length}` };
  },
  template: /* html */ `
    <span class="icon-cycle" :class="[cls(), { playing }]"
          :style="{ width: size + 'px', height: size + 'px' }"
          aria-hidden="true">
      <Icon v-for="(n, i) in names" :key="n" :name="n" :size="size"
            :style="{ '--i': i }"/>
    </span>
  `,
};
