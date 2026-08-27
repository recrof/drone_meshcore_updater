import { onMounted } from "./vue.js";
import {
  fsInfo, mtuInfo, log, bluetoothAvailable, configOpen, flashOpen,
  logViewOpen, logViewPath,
} from "./store.js";

import AppHeader    from "./components/AppHeader.js";
import ProgressBar  from "./components/ProgressBar.js";
import FileToolbar  from "./components/FileToolbar.js";
import FileListing  from "./components/FileListing.js";
import LogPane      from "./components/LogPane.js";
import DropOverlay  from "./components/DropOverlay.js";
import ConfigDialog from "./components/ConfigDialog.js";
import FlashDialog  from "./components/FlashDialog.js";
import LogViewer    from "./components/LogViewer.js";

export default {
  name: "App",
  components: {
    AppHeader, ProgressBar, FileToolbar, FileListing,
    LogPane, DropOverlay, ConfigDialog, FlashDialog, LogViewer,
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

    return { configOpen, flashOpen, logViewOpen, logViewPath, fsInfo, mtuInfo };
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
    <FlashDialog :open="flashOpen" @close="flashOpen = false" />
    <LogViewer :open="logViewOpen" :path="logViewPath" @close="logViewOpen = false" />
  `,
};
