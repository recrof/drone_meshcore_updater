/*
 * Test harness: mounts DfuStatus.js on its own and exposes a way to push
 * status payloads at it.
 *
 * Bundled by web/test/dfu-banner.test.mjs, never shipped. It exists because
 * the banner is invisible in every state the full app can reach in jsdom —
 * render.test.mjs mounts a disconnected app, so the component's setup() runs
 * but its template never does. Rendering it hidden proves it compiles and
 * nothing more, and "the feature rendered nothing and no test noticed" is a
 * bug this project has actually shipped.
 *
 * Payloads go in as raw bytes rather than as parsed objects, so one call
 * exercises parseDfuStatus, the store's rate/logging wiring, and the template
 * together — which is the path a real notification takes.
 */
import { createApp } from "../../js/vue.js";
import DfuStatus from "../../js/components/DfuStatus.js";
import {
  smp, dfuStatus, dfuRate, logViewOpen, logViewLive, logLines,
} from "../../js/store.js";

createApp(DfuStatus).mount("#app");

window.__dfuTest = {
  /* `bytes` is a plain array: it crosses from node into the jsdom realm, and
   * a Uint8Array built out there is not this realm's Uint8Array. */
  feed(bytes) {
    smp._emitDfuStatus(new DataView(new Uint8Array(bytes).buffer));
  },
  peek: () => ({
    state: dfuStatus.value.state,
    rate: dfuRate.value,
    logViewOpen: logViewOpen.value,
    logViewLive: logViewLive.value,
    lines: logLines.map(l => l.msg),
  }),
};
