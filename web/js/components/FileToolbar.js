import { ref, computed } from "../vue.js";
import {
  connected, refresh, uploadFiles, openConfig, autoFlash, reboot, openFlash,
  openLogView,
} from "../store.js";
import Icon from "./Icon.js";

/*
 * Folder controls (up, path entry, Go, New folder) were removed: every file
 * this device cares about lives directly in /lfs1, so the navigation was
 * clutter that could only ever take you somewhere with nothing in it.
 *
 * Every action carries an icon *and* a label. Icon-only was compact and
 * unreadable: five unlabelled glyphs is a memory test, and on a phone they
 * were also too small to hit reliably.
 *
 * "Flash updater" comes first on purpose. It is the only action that works
 * with nothing connected, so on a cold open — no device paired, everything
 * else greyed out — it is the one enabled control and the obvious place to
 * start.
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
      openFlash, openLogView, flashTitle,
    };
  },
  template: /* html */ `
    <div class="toolbar">
      <!-- First, and enabled when nothing is connected: it runs over USB and
           is where a new user starts. Disabled *while* connected because
           flashing halts the CPU and drops the Bluetooth link. -->
      <button class="icon-btn" :disabled="connected" @click="openFlash"
              :title="flashTitle" aria-label="Flash updater">
        <Icon name="memory"/><span class="label">Flash updater</span>
      </button>

      <span class="tb-sep" aria-hidden="true"></span>

      <button class="icon-btn" :disabled="!connected" @click="refresh"
              title="Refresh the file list" aria-label="Refresh">
        <Icon name="refresh"/><span class="label">Refresh</span>
      </button>
      <button class="icon-btn" :disabled="!connected" @click="picker.click()"
              title="Upload files to the device" aria-label="Upload">
        <Icon name="upload"/><span class="label">Upload</span>
      </button>
      <button class="icon-btn" :disabled="!connected" @click="openConfig"
              title="Edit config.txt" aria-label="Config">
        <Icon name="settings"/><span class="label">Config</span>
      </button>
      <button class="icon-btn" :disabled="!connected" @click="openLogView()"
              title="View the device log" aria-label="Device log">
        <Icon name="description"/><span class="label">Log</span>
      </button>
      <button class="icon-btn" :disabled="!connected" @click="reboot"
              title="Reboot the updater" aria-label="Reboot">
        <Icon name="restart_alt"/><span class="label">Reboot</span>
      </button>

      <span class="grow"></span>

      <button class="icon-btn primary" :disabled="!connected" @click="autoFlash"
              title="Scan for a target and flash the bundle ble_firmware_mapping selects"
              aria-label="Auto flash">
        <Icon name="bolt"/><span class="label">Auto flash</span>
      </button>
      <input type="file" ref="picker" multiple @change="onPick">
    </div>
  `,
};
