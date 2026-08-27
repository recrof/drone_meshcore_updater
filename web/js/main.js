import { createApp } from "./vue.js";
import App from "./App.js";
import { initOffline } from "./store.js";

createApp(App).mount("#app");

/* After mount, so the "offline cache ready" line has a log pane to land in.
 * A no-op in the single-file build and anywhere without a service worker. */
initOffline();
