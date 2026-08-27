import {
  connected, deviceName, connect, disconnect, bluetoothAvailable,
  updateReady, reloadForUpdate,
} from "../store.js";

export default {
  name: "AppHeader",
  setup() {
    return {
      connected, deviceName, connect, disconnect, bluetoothAvailable,
      updateReady, reloadForUpdate,
    };
  },
  template: /* html */ `
    <header :class="{ connected }">
      <span class="title">FSX FILE MANAGER</span>
      <span class="device">
        <span class="dot"></span>{{ connected ? deviceName : "not connected" }}
      </span>
      <span class="grow"></span>
      <!-- A newer service worker is installed and waiting. Reloading is the
           user's call: this page may be driving a DFU right now. -->
      <button class="update" v-if="updateReady" @click="reloadForUpdate"
              title="A newer version has been downloaded. Reload to use it.">
        Update ready — reload
      </button>
      <button class="primary" :disabled="connected || !bluetoothAvailable" @click="connect">
        Connect
      </button>
      <button :disabled="!connected" @click="disconnect">Disconnect</button>
    </header>
  `,
};
