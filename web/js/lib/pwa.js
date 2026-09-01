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

/* ---- Installing the app -------------------------------------------------
 *
 * "There is no install prompt on Android Chrome" is the expected behaviour,
 * not a bug in the manifest. Chrome removed the automatic install banner: an
 * installable page now gets a `beforeinstallprompt` event, and if the page
 * does nothing with it the only remaining affordance is an "Install app" item
 * buried in the ⋮ menu. Most people never find it.
 *
 * So the prompt is ours to raise. The browser still decides *whether* it is
 * offered — the event only fires when the install criteria are met and the app
 * is not already installed — but once it has fired, prompt() shows the real
 * system dialog. Two rules the API enforces and this file has to respect:
 * prompt() must be called from a user gesture, and each event is good for
 * exactly one call.
 *
 * **This is a Chromium-only path.** Firefox does not implement it at all, and
 * on iOS installing is Share → Add to Home Screen with no API to trigger or
 * even detect it — so there the button correctly never appears, because there
 * is nothing it could do.
 */

let installEvent = null;

/* True when the page is already running as an installed app, in which case
 * there is nothing to offer. Two spellings because iOS predates the standard
 * one and still answers only to its own. */
export function runningInstalled() {
  if (typeof window === "undefined") return false;
  return !!window.matchMedia?.("(display-mode: standalone)").matches
      || window.navigator?.standalone === true;
}

/*
 * Start listening. `onAvailable(bool)` is called when an install becomes
 * offerable and again when it stops being — installing the app is the usual
 * reason, and Chrome fires `appinstalled` for installs done from its own menu
 * too, so a button raised by us still disappears when the user goes around it.
 */
export function watchInstall({ onAvailable = () => {}, onInstalled = () => {} } = {}) {
  if (typeof window === "undefined") return;

  window.addEventListener("beforeinstallprompt", (e) => {
    /* Suppresses Chrome's own mini-infobar, which is the thing users are not
     * seeing anyway, in favour of a control that sits still and can be found
     * twice. */
    e.preventDefault();
    installEvent = e;
    onAvailable(true);
  });

  window.addEventListener("appinstalled", () => {
    installEvent = null;
    onAvailable(false);
    onInstalled();
  });
}

/* Show the system install dialog. Must be called from a user gesture.
 * Resolves to "accepted", "dismissed", or null when there was nothing to
 * show. The event is discarded either way: it is single-use, and Chrome fires
 * a fresh one if the page becomes installable again. */
export async function promptInstall() {
  const e = installEvent;
  if (!e) return null;
  installEvent = null;
  e.prompt();
  const { outcome } = await e.userChoice;
  return outcome;
}
