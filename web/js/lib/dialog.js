import { onMounted, onUnmounted } from "../vue.js";

/*
 * Escape closes a dialog.
 *
 * ---- Why this is shared rather than six lines per component -------------
 *
 * Because it was zero lines per component for a long time, and nobody noticed
 * until a fifth dialog arrived without it. Escape worked on exactly one thing
 * in this app — the theme menu — so "the scanner ignores Escape" was true and
 * so was "every dialog ignores Escape". Putting the behaviour in one place is
 * what makes the next dialog get it by default instead of by remembering.
 *
 * ---- Two things it deliberately does not do -----------------------------
 *
 * **It does not close the dialog itself.** It calls the component's own
 * `close`, which is where the guards already live: ConfigDialog confirms
 * unsaved changes, FlashDialog refuses outright while a write is in flight
 * (unmounting mid-write drops the probe handle or the serial port and leaves
 * a half-written board). A helper that emitted `close` directly would quietly
 * route around both.
 *
 * **It does not track which dialog is on top.** Every dialog here is modal
 * over the whole page and only one is open at a time, so `isOpen` is the whole
 * test. If that ever stops being true, this is the place to add a stack rather
 * than the components.
 *
 * The listener lives on `document` for the component's whole lifetime, not
 * just while the dialog is open: these components stay mounted and toggle an
 * inner `v-if`, so there is no mount to hang it on. `isOpen` is therefore
 * checked on every keypress rather than assumed.
 */
export function onEscape(isOpen, close) {
  const onKey = (e) => {
    if (e.key !== "Escape" || !isOpen()) return;
    /* Stops a single press from also reaching anything behind the modal —
     * the theme menu keeps its own listener and would otherwise act too. */
    e.stopPropagation();
    close();
  };
  onMounted(() => document.addEventListener("keydown", onKey));
  onUnmounted(() => document.removeEventListener("keydown", onKey));
}
