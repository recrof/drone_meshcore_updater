import {
  connected, deviceName, connect, disconnect, bluetoothAvailable,
  updateReady, reloadForUpdate,
} from "../store.js";
import ThemePicker from "./ThemePicker.js";
import Icon from "./Icon.js";

export default {
  name: "AppHeader",
  components: { ThemePicker, Icon },
  setup() {
    return {
      connected, deviceName, connect, disconnect, bluetoothAvailable,
      updateReady, reloadForUpdate,
    };
  },
  template: /* html */ `
    <header :class="{ connected }">
      <!-- Named for what the tool is now. "FSX file manager" was accurate
           when browsing /lfs1 was the whole app; flashing targets, updating
           itself over USB and BLE, and reading the device log all arrived
           afterwards, and file management is the smallest of them.

           Written in sentence case and uppercased by the "header .title"
           rule in layout.css, so this string stays greppable against the
           same name in index.html's title and the manifest. (No backticks
           in here: the template is a JS template literal, and one closes it.) The shouted literal that
           used to be here carried "MCU", an intermediate name that was
           dropped before release and survived only because grepping for
           "Drone MCU Updater" does not match it. -->
      <span class="title">Drone MeshCore Updater</span>
      <!-- The state indicator is the icon now, not an abstract dot. A dot
           says "something is on"; bluetooth_connected says what, and
           bluetooth_disabled says what is missing rather than leaving the
           reader to infer it from a grey circle. It still pulses when
           connected — the pulse moved from a box-shadow ring onto the glyph
           itself. -->
      <span class="device">
        <Icon class="dot-icon" :size="16"
              :name="connected ? 'bluetooth_connected' : 'bluetooth_disabled'"/>
        {{ connected ? deviceName : "not connected" }}
      </span>
      <span class="grow"></span>
      <!-- Appearance sits left of the actions, not right of them: Connect and
           Disconnect are what people reach for on every visit, and putting a
           colour picker between them and the edge of the window would cost
           that every time to save it once. -->
      <ThemePicker />
      <!-- A newer service worker is installed and waiting. Reloading is the
           user's call: this page may be driving a DFU right now. -->
      <button class="update" v-if="updateReady" @click="reloadForUpdate"
              title="A newer version has been downloaded. Reload to use it.">
        Update ready — reload
      </button>
      <button class="primary" :disabled="connected || !bluetoothAvailable" @click="connect">
        <Icon name="bluetooth" :size="18"/>Connect
      </button>
      <button :disabled="!connected" @click="disconnect">
        <Icon name="bluetooth_disabled" :size="18"/>Disconnect
      </button>
    </header>
  `,
};
