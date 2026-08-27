/*
 * Service worker — makes the client work offline.
 *
 * This app is useful precisely where connectivity isn't: next to hardware, in
 * a field, on a laptop that has never seen this URL's network. Web Bluetooth
 * needs a secure context, which a cached page still satisfies, so once the
 * shell is installed the whole tool runs with no server at all.
 *
 * Design notes:
 *
 *  - PRECACHE is written out by hand and checked by web/test/pwa.test.mjs,
 *    which walks web/ and fails when a shipped source file is missing here.
 *    A file left out would be fetched from the network at run time and the
 *    app would simply not start offline — silent, and exactly the kind of
 *    drift a test should catch.
 *
 *  - Bump CACHE when anything in PRECACHE changes. The version is part of the
 *    cache name, so activate() dropping every other cache is the whole
 *    upgrade path.
 *
 *  - Stale-while-revalidate: the cached copy answers immediately (that is the
 *    offline guarantee), and a background fetch refreshes it for next load.
 *    A reload after an update therefore lands on the new version.
 */

const CACHE = "xiao-nrf54-updater-v2";

const PRECACHE = [
  "./",
  "index.html",
  "manifest.webmanifest",

  "css/tokens.css",
  "css/base.css",
  "css/layout.css",
  "css/config.css",

  "js/main.js",
  "js/App.js",
  "js/store.js",
  "js/vue.js",
  "js/lib/cbor.js",
  "js/lib/config-file.js",
  "js/lib/format.js",
  "js/lib/pwa.js",
  "js/lib/smp-client.js",
  "js/components/AppHeader.js",
  "js/components/ConfigDialog.js",
  "js/components/DropOverlay.js",
  "js/components/FileListing.js",
  "js/components/FileToolbar.js",
  "js/components/Icon.js",
  "js/components/LogPane.js",
  "js/components/MappingEditor.js",
  "js/components/ProgressBar.js",

  "vendor/vue.esm-browser.prod.js",

  "icons/icon-192.png",
  "icons/icon-512.png",
  "icons/icon-maskable-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    /* addAll is atomic — one 404 and nothing is cached, which would leave a
     * half-installed worker claiming to work offline. Fail loudly instead. */
    await cache.addAll(PRECACHE);
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key !== CACHE) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

self.addEventListener("message", (event) => {
  if (event.data === "skip-waiting") self.skipWaiting();
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE);

    /* A navigation to any in-scope URL is the app shell. Deep links and
     * "?utm_..." variants must not miss the cache and take the page offline. */
    const key = req.mode === "navigate" ? "./" : req;
    const hit = await cache.match(key, { ignoreSearch: req.mode === "navigate" });

    const network = fetch(req).then((res) => {
      if (res && res.ok && res.type === "basic") cache.put(key, res.clone());
      return res;
    }).catch(() => null);

    if (hit) {
      event.waitUntil(network);      // refresh in the background
      return hit;
    }
    const res = await network;
    if (res) return res;
    return new Response("offline and not cached", {
      status: 504, statusText: "Offline",
      headers: { "Content-Type": "text/plain" },
    });
  })());
});
