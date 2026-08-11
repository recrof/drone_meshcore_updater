import { ref, onMounted, onUnmounted } from "../vue.js";
import { connected, currentPath, uploadFiles, log } from "../store.js";

/* Chrome fires a stream of dragenter/dragover events as the pointer moves; we
 * count them so the overlay only hides on the LAST dragleave (not the first —
 * which fires whenever the pointer crosses any child element). Setting
 * dropEffect on dragover is what lets Chrome show the "copy" cursor and, more
 * importantly, keeps the browser from treating the file as a navigation.
 */
export default {
  name: "DropOverlay",
  setup() {
    const shown = ref(false);
    const dropPath = ref("");
    let depth = 0;

    const hasFiles = (e) =>
      !!e.dataTransfer && [...(e.dataTransfer.types || [])].includes("Files");

    const onEnter = (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth++;
      dropPath.value = currentPath() + "/";
      shown.value = true;
    };
    const onOver = (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = connected.value ? "copy" : "none";
    };
    const onLeave = (e) => {
      if (!hasFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) shown.value = false;
    };
    const onDrop = async (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      shown.value = false;
      depth = 0;
      if (!connected.value) {
        log("drop: not connected — connect a device first", "err");
        return;
      }
      /* dataTransfer.items → prefer file entries; skip anything else (URLs,
       * text drags). Works for files-only drops from Finder, Explorer, and
       * web pages.
       */
      const files = [];
      if (e.dataTransfer.items) {
        for (const it of e.dataTransfer.items) {
          if (it.kind === "file") {
            const f = it.getAsFile();
            if (f) files.push(f);
          }
        }
      } else {
        for (const f of e.dataTransfer.files) files.push(f);
      }
      await uploadFiles(files);
    };

    const bind = [
      ["dragenter", onEnter], ["dragover", onOver],
      ["dragleave", onLeave], ["drop", onDrop],
    ];
    onMounted(()   => bind.forEach(([n, h]) => window.addEventListener(n, h)));
    onUnmounted(() => bind.forEach(([n, h]) => window.removeEventListener(n, h)));

    return { shown, dropPath, connected };
  },
  template: /* html */ `
    <div id="drop-overlay" :class="{ shown, reject: !connected }">
      <div class="frame">
        <div class="frame-inner">
          <div class="frame-title">{{ connected ? "Drop to upload" : "Not connected" }}</div>
          <div class="frame-sub" v-if="connected">
            Files will be written to <span>{{ dropPath }}</span>
          </div>
          <div class="frame-sub" v-else>Connect to a device before dropping files.</div>
        </div>
      </div>
    </div>
  `,
};
