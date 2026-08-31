import {
  connected, connecting, deviceName, connect, disconnect, bluetoothAvailable,
  updateReady, reloadForUpdate,
} from "../store.js";
import ThemePicker from "./ThemePicker.js";
import Icon from "./Icon.js";

export default {
  name: "AppHeader",
  components: { ThemePicker, Icon },
  setup() {
    return {
      connected, connecting, deviceName, bluetoothAvailable,
      updateReady, reloadForUpdate,
      /* One handler, because there is one button. Whichever it is, it is
       * never both — `connected` decides, and connect() refuses a second
       * press while the first is still in flight. */
      toggle: () => (connected.value ? disconnect() : connect()),
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
      <!-- Appearance sits left of the action, not right of it: Connect is what
           people reach for on every visit, and putting a colour picker between
           it and the edge of the window would cost that every time to save it
           once. On a phone the header wraps and this lands at the left of the
           second row, which is why the menu opens leftward there — see
           .theme-menu in layout.css. -->
      <ThemePicker />
      <!-- A newer service worker is installed and waiting. Reloading is the
           user's call: this page may be driving a DFU right now. -->
      <button class="update" v-if="updateReady" @click="reloadForUpdate"
              title="A newer version has been downloaded. Reload to use it.">
        Update ready — reload
      </button>
      <!-- One button, not two.
           It used to be a pair, on the argument that they are a *radio state*
           and read as opposites at a glance. That holds on a desktop and
           breaks on a phone: the header wraps, and two buttons where one would
           do is the difference between the actions fitting on the second row
           and crowding it. Half of the pair was always disabled anyway — a
           permanently dead control is not information, it is furniture.

           The state is not lost with it. It is in the header already, twice
           over: the bluetooth glyph beside the device name, and the name
           itself where "not connected" would be. This button says what
           pressing it *does*, which is the one thing neither of those says. -->
      <button class="conn" :class="{ primary: !connected }"
              :disabled="connecting || (!connected && !bluetoothAvailable)"
              :title="connected ? 'Disconnect from ' + deviceName
                                : 'Choose a device and connect over Bluetooth'"
              @click="toggle">
        <Icon :name="connected ? 'bluetooth_disabled' : 'bluetooth'" :size="18"/>{{
          connecting ? "Connecting…" : connected ? "Disconnect" : "Connect" }}
      </button>
    </header>
  `,
};
