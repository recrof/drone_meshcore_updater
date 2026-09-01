import { onMounted } from "./vue.js";
import {
  fsInfo, mtuInfo, log, bluetoothAvailable, configOpen, flashOpen,
  logViewOpen, logViewPath, logViewLive,
} from "./store.js";

import AppHeader    from "./components/AppHeader.js";
import ProgressBar  from "./components/ProgressBar.js";
import FileToolbar  from "./components/FileToolbar.js";
import DfuStatus    from "./components/DfuStatus.js";
import FileListing  from "./components/FileListing.js";
import LogPane      from "./components/LogPane.js";
import DropOverlay  from "./components/DropOverlay.js";
import ConfigDialog from "./components/ConfigDialog.js";
import FlashDialog  from "./components/FlashDialog.js";
import LogViewer    from "./components/LogViewer.js";
import ScannerDialog from "./components/ScannerDialog.js";
import PinDialog from "./components/PinDialog.js";

export default {
  name: "App",
  components: {
    AppHeader, ProgressBar, FileToolbar, DfuStatus, FileListing,
    LogPane, DropOverlay, ConfigDialog, FlashDialog, LogViewer, ScannerDialog,
    PinDialog,
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

    return {
      configOpen, flashOpen, logViewOpen, logViewPath, logViewLive,
      fsInfo, mtuInfo,
    };
  },
  template: /* html */ `
    <AppHeader />
    <ProgressBar />
    <FileToolbar />
    <!-- Directly under the toolbar: the DFU it reports is the thing the
         toolbar's Auto flash / flash-a-zip actions started. -->
    <DfuStatus />
    <FileListing />
    <footer>
      <span>{{ fsInfo }}</span>
      <span>{{ mtuInfo }}</span>
    </footer>
    <LogPane />
    <DropOverlay />
    <ConfigDialog :open="configOpen" @close="configOpen = false" />
    <FlashDialog :open="flashOpen" @close="flashOpen = false" />
    <!-- Owns its own visibility, unlike the dialogs above it. The poll loop
         that keeps the device-side scan alive is started and stopped by
         openScanner/closeScanner, so an "open" prop here would be a second
         source of truth for the same thing and could leave the radio
         scanning after the panel had gone. (No backticks in this file: the
         template is a JS template literal and one would close it.) -->
    <ScannerDialog />
    <!-- No "open" prop, for the same reason ScannerDialog has none: the
         device owns this state. The target is displaying digits for a pairing
         it is holding open, so what decides whether to ask is the status on
         the wire, not anything this page remembers.
         (Quotes, not backticks: this whole template is a template literal and
         a backtick in a comment ends it. esbuild says "Expected } but found
         open", which names neither the file's real problem nor the character.) -->
    <PinDialog />
    <LogViewer :open="logViewOpen" :path="logViewPath" :start-live="logViewLive"
               @close="logViewOpen = false" />
  `,
};
