import { onMounted } from "./vue.js";
import { fsInfo, mtuInfo, log, bluetoothAvailable, configOpen } from "./store.js";

import AppHeader    from "./components/AppHeader.js";
import ProgressBar  from "./components/ProgressBar.js";
import FileToolbar  from "./components/FileToolbar.js";
import FileListing  from "./components/FileListing.js";
import LogPane      from "./components/LogPane.js";
import DropOverlay  from "./components/DropOverlay.js";
import ConfigDialog from "./components/ConfigDialog.js";

export default {
  name: "App",
  components: {
    AppHeader, ProgressBar, FileToolbar, FileListing,
    LogPane, DropOverlay, ConfigDialog,
  },
  setup() {
    onMounted(() => {
      if (!bluetoothAvailable.value) {
        log("This browser does not support Web Bluetooth. Use Chrome / Edge " +
            "on desktop or Android. iOS Safari is not supported.", "err");
      } else {
        log("ready — click Connect to pick a device");
      }
    });

    return { configOpen, fsInfo, mtuInfo };
  },
  template: /* html */ `
    <AppHeader />
    <ProgressBar />
    <FileToolbar />
    <FileListing />
    <footer>
      <span>{{ fsInfo }}</span>
      <span>{{ mtuInfo }}</span>
    </footer>
    <LogPane />
    <DropOverlay />
    <ConfigDialog :open="configOpen" @close="configOpen = false" />
  `,
};
