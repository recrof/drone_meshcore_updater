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
 *  - **The shell is served cache-only, and only a new worker replaces it.**
 *    This used to be stale-while-revalidate, which was a bug: each file
 *    revalidated on its own schedule, so one reload after a deploy could mix
 *    generations. An app made of ES modules does not survive that. The
 *    observed failure was a new FileToolbar.js (renders the Flash button)
 *    against a cached older App.js (never mounts FlashDialog) — the click set
 *    a ref nothing was listening to and produced no error anywhere. Anything
 *    that changes together must be replaced together, which is the entire
 *    reason the precache is versioned.
 */

const CACHE = "xiao-nrf54-updater-v5";

/*
 * The release firmware staged by CI at firmware/. Kept in its own cache,
 * outside the versioned shell: it changes on a release cadence rather than a
 * deploy cadence, and re-downloading 900 KB of Intel HEX every time a CSS file
 * moves would be silly. Survives activate() for the same reason.
 *
 * This is what makes "Flash newest" work with no network — which is the whole
 * premise of the tool being a PWA.
 */
const FIRMWARE_CACHE = "xiao-nrf54-firmware";
const FIRMWARE_PREFIX = new URL("firmware/", self.location.href).href;

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
  "js/lib/cmsis-dap.js",
  "js/lib/config-file.js",
  "js/lib/format.js",
  "js/lib/intel-hex.js",
  "js/lib/log-file.js",
  "js/lib/nrf54l-flash.js",
  "js/lib/pwa.js",
  "js/lib/smp-client.js",
  "js/components/AppHeader.js",
  "js/components/ConfigDialog.js",
  "js/components/DropOverlay.js",
  "js/components/FileListing.js",
  "js/components/FileToolbar.js",
  "js/components/FlashDialog.js",
  "js/components/Icon.js",
  "js/components/LogPane.js",
  "js/components/LogViewer.js",
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
      if (key !== CACHE && key !== FIRMWARE_CACHE) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

self.addEventListener("message", (event) => {
  if (event.data === "skip-waiting") self.skipWaiting();
});

/* Absolute URLs of everything in PRECACHE, resolved once against the worker's
 * own location so a sub-path deploy (GitHub Pages) matches too. */
const SHELL = new Set(PRECACHE.map(p => new URL(p, self.location.href).href));

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  /* Any navigation in scope is the app shell — deep links and "?utm_..."
   * variants must not miss the cache and take the page offline. */
  /* Firmware is network-first: a newer release should be picked up as soon as
   * there is a network to pick it up from, and the cached copy is the offline
   * fallback rather than the preferred answer. Opposite of the shell, which
   * must never mix versions. */
  if (url.href.startsWith(FIRMWARE_PREFIX)) {
    event.respondWith((async () => {
      const cache = await caches.open(FIRMWARE_CACHE);
      try {
        const res = await fetch(req);
        if (res && res.ok) {
          await cache.put(url.href, res.clone());
          return res;
        }
      } catch { /* offline — fall through */ }
      const hit = await cache.match(url.href);
      if (hit) return hit;
      return new Response("no firmware cached", {
        status: 504, statusText: "Offline",
        headers: { "Content-Type": "text/plain" },
      });
    })());
    return;
  }

  const isNavigation = req.mode === "navigate";
  const key = isNavigation ? new URL("./", self.location.href).href : url.href;

  if (!isNavigation && !SHELL.has(key)) {
    /* Not part of the shell: let it go to the network untouched, and do not
     * accumulate it in the versioned cache. */
    return;
  }

  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(key);
    if (hit) return hit;

    /* A shell file missing from the cache means the install did not complete.
     * Fall back to the network rather than failing outright, but do not cache
     * the result — mixing it with a different generation is the bug above. */
    try {
      const res = await fetch(req);
      if (res && res.ok) return res;
    } catch { /* offline */ }

    return new Response("offline and not cached", {
      status: 504, statusText: "Offline",
      headers: { "Content-Type": "text/plain" },
    });
  })());
});
