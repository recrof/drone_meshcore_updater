import { ref, computed } from "../vue.js";
import {
  connected, refresh, uploadFiles, openConfig, autoFlash, reboot, openFlash,
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

    /* Built here rather than inline in the template: the disconnected text
     * contains an apostrophe, and an escaped quote inside a Vue expression
     * attribute does not survive HTML attribute parsing — it compiles to
     * "Unexpected identifier 's'" and takes the whole toolbar down with it. */
    const flashTitle = computed(() => connected.value
      ? "Disconnect first — flashing halts the CPU and drops the Bluetooth link"
      : "Flash this updater's own firmware over USB");

    return {
      connected, refresh, picker, onPick, openConfig, autoFlash, reboot,
      openFlash, flashTitle,
    };
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
      <!-- Enabled when nothing is connected — it runs over USB, and is what
           you reach for when the device cannot be talked to over BLE at all.
           Disabled *while* connected because flashing halts the CPU, which
           takes the BLE stack down with it: the link would drop mid-operation
           and the app would be left describing a device that no longer
           exists. The title says so, since a disabled icon with no
           explanation is a dead end. -->
      <button class="icon-btn" :disabled="connected" @click="openFlash"
              :title="flashTitle" aria-label="Flash updater">
        <Icon name="memory"/>
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
