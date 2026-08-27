import { ref } from "../vue.js";
import {
  connected, refresh, uploadFiles, openConfig, autoFlash, reboot,
} from "../store.js";
import Icon from "./Icon.js";

/*
 * Folder controls (up, path entry, Go, New folder) were removed: every file
 * this device cares about lives directly in /lfs1, so the navigation was
 * clutter that could only ever take you somewhere with nothing in it.
 *
 * The three utility actions are icon-only; each keeps a title and an
 * aria-label, because an icon with neither is unusable with a screen reader
 * and unguessable without one. "Auto flash" stays a text button on purpose —
 * it is the destructive primary action and deserves to be spelled out.
 */
export default {
  name: "FileToolbar",
  components: { Icon },
  setup() {
    const picker = ref(null);

    const onPick = async (e) => {
      await uploadFiles([...e.target.files]);
      e.target.value = "";
    };

    return { connected, refresh, picker, onPick, openConfig, autoFlash, reboot };
  },
  template: /* html */ `
    <div class="toolbar">
      <button class="icon-btn" :disabled="!connected" @click="refresh"
              title="Refresh the file list" aria-label="Refresh">
        <Icon name="refresh"/>
      </button>
      <button class="icon-btn" :disabled="!connected" @click="picker.click()"
              title="Upload files to the device" aria-label="Upload">
        <Icon name="upload"/>
      </button>
      <button class="icon-btn" :disabled="!connected" @click="openConfig"
              title="Edit config.txt" aria-label="Config">
        <Icon name="settings"/>
      </button>
      <button class="icon-btn" :disabled="!connected" @click="reboot"
              title="Reboot the updater" aria-label="Reboot">
        <Icon name="restart_alt"/>
      </button>
      <span class="grow"></span>
      <button :disabled="!connected" @click="autoFlash"
              title="Scan for a target and flash the bundle ble_firmware_mapping selects">
        Auto flash
      </button>
      <input type="file" ref="picker" multiple @change="onPick">
    </div>
  `,
};
