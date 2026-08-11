import { progress } from "../store.js";

/* Top-of-viewport 2px bar plus a small right-aligned label. */
export default {
  name: "ProgressBar",
  setup() { return { progress }; },
  template: /* html */ `
    <div id="progress" :class="{ indeterminate: progress.indeterminate }">
      <div class="fill" :style="{ width: progress.pct + '%' }"></div>
    </div>
    <div id="progress-label" :class="{ shown: progress.shown }">{{ progress.label }}</div>
  `,
};
