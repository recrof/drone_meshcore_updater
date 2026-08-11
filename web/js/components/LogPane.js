import { ref, watch, nextTick } from "../vue.js";
import { logLines } from "../store.js";

export default {
  name: "LogPane",
  setup() {
    const pane = ref(null);
    /* Keep the newest line visible without stealing focus. */
    watch(() => logLines.length, async () => {
      await nextTick();
      if (pane.value) pane.value.scrollTop = pane.value.scrollHeight;
    });
    return { logLines, pane };
  },
  template: /* html */ `
    <pre id="log" ref="pane"><div v-for="line in logLines" :key="line.id" :class="line.cls"><span class="ts">{{ line.ts }}</span>{{ line.msg }}</div></pre>
  `,
};
