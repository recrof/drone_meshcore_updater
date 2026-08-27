/*
 * Service-worker registration — the offline half of the PWA.
 *
 * Kept out of main.js so the whole "is this installable here?" decision lives
 * in one readable place. Three environments have to be handled, and only one
 * of them wants a worker:
 *
 *   web/index.html over https  → register; this is the installable app
 *   dist/updater.html          → no sw.js next to it, and none is wanted:
 *                                the single-file build is already offline by
 *                                construction
 *   file:// or an old browser  → registration is unavailable or throws
 *
 * The manifest link is the discriminator. build-single.mjs strips it, so the
 * single-file build takes the no-op path without needing to know anything
 * about service workers.
 */

/* The registration, once we have one — applyUpdate() needs it. */
let registration = null;
let reloading = false;

export function serviceWorkerWanted() {
  return typeof navigator !== "undefined"
    && "serviceWorker" in navigator
    && typeof document !== "undefined"
    && !!document.querySelector('link[rel="manifest"]');
}

/*
 * `onUpdate` fires when a newer worker has installed and is waiting. It is
 * only meaningful when one was already in control: on the very first visit
 * the "waiting" worker is the initial install, which is not an update the
 * user needs to act on.
 */
export async function registerServiceWorker({ onLog = () => {}, onUpdate = () => {} } = {}) {
  if (!serviceWorkerWanted()) return null;

  try {
    registration = await navigator.serviceWorker.register("sw.js", { scope: "./" });
  } catch (e) {
    onLog(`offline cache unavailable: ${e.message}`);
    return null;
  }

  const hadController = !!navigator.serviceWorker.controller;

  const check = (worker) => {
    if (!worker) return;
    const report = () => {
      if (worker.state !== "installed") return;
      if (hadController) onUpdate();
      else onLog("offline cache ready — this page now works with no network", "ok");
    };
    report();
    worker.addEventListener("statechange", report);
  };

  check(registration.waiting);
  check(registration.installing);
  registration.addEventListener("updatefound", () => check(registration.installing));

  /* An activated new worker replaces the controller. Reload once so the page
   * and its modules come from the same version — mixing them is how you get
   * a component importing a helper that no longer exists. */
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (reloading) return;
    reloading = true;
    location.reload();
  });

  return registration;
}

/* Take the waiting worker live. The controllerchange handler above does the
 * reload, so this returns immediately. */
export function applyUpdate() {
  const waiting = registration?.waiting;
  if (!waiting) { location.reload(); return; }
  waiting.postMessage("skip-waiting");
}
