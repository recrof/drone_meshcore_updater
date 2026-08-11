import { ref } from "../vue.js";
import {
  connected, path, refresh, goUp, mkdir, uploadFiles, openConfig, autoFlash,
} from "../store.js";

export default {
  name: "FileToolbar",
  setup() {
    const picker = ref(null);

    const onPick = async (e) => {
      await uploadFiles([...e.target.files]);
      e.target.value = "";
    };

    return {
      connected, path, refresh, goUp, mkdir, picker, onPick,
      openConfig, autoFlash,
    };
  },
  template: /* html */ `
    <div class="toolbar">
      <button title="Go up one directory" :disabled="!connected" @click="goUp">↑</button>
      <input class="path" v-model="path" spellcheck="false" @keydown.enter="refresh">
      <button :disabled="!connected" @click="refresh">Go</button>
      <button :disabled="!connected" @click="refresh">Refresh</button>
      <button :disabled="!connected" @click="mkdir">New folder</button>
      <button :disabled="!connected" @click="picker.click()">Upload…</button>
      <button :disabled="!connected" @click="openConfig">Config…</button>
      <button :disabled="!connected" @click="autoFlash"
              title="Scan for a target and flash the bundle ble_firmware_mapping selects">
        Auto flash
      </button>
      <input type="file" ref="picker" multiple @change="onPick">
    </div>
  `,
};
