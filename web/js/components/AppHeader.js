import { connected, deviceName, connect, disconnect, bluetoothAvailable } from "../store.js";

export default {
  name: "AppHeader",
  setup() {
    return { connected, deviceName, connect, disconnect, bluetoothAvailable };
  },
  template: /* html */ `
    <header :class="{ connected }">
      <span class="title">FSX FILE MANAGER</span>
      <span class="device">
        <span class="dot"></span>{{ connected ? deviceName : "not connected" }}
      </span>
      <span class="grow"></span>
      <button class="primary" :disabled="connected || !bluetoothAvailable" @click="connect">
        Connect
      </button>
      <button :disabled="!connected" @click="disconnect">Disconnect</button>
    </header>
  `,
};
