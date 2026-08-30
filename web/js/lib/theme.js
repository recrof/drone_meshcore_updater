/*
 * Appearance: a light/dark mode and an accent palette, both remembered.
 *
 * Deliberately small. It owns two `localStorage` keys and two attributes on
 * `<html>`; every colour decision lives in css/tokens.css, which is where a
 * colour belongs.
 *
 * ---- Why the values are duplicated in index.html -------------------------
 *
 * There is a copy of the read-and-apply in an inline `<script>` at the top of
 * index.html, and it has to be there: this module is an ES module, so it runs
 * after the document has parsed and the browser is free to paint the default
 * light background first. On a dark-themed device that is a white flash on
 * every load, which is worse than the feature is good.
 *
 * The duplication is the price, and it is *checked* rather than commented:
 * render.test.mjs asserts that index.html mentions both storage keys and both
 * attribute names. Change one here and that test fails until the other moves.
 *
 * ---- Storage can throw, not just return null -----------------------------
 *
 * A private window, cleared site data, or a browser configured to block site
 * data can make `localStorage` *throw* on access rather than return nothing.
 * Every read and write here is wrapped, and every failure falls back to the
 * defaults, because appearance is the last thing that should stop the page
 * that flashes hardware from loading.
 */

/** Storage keys. Mirrored in index.html's inline bootstrap — see above. */
export const KEY_MODE = "dmu.theme.mode";
export const KEY_PALETTE = "dmu.theme.palette";

/** `system` follows the OS; the other two override it. */
export const MODES = ["system", "light", "dark"];

export const MODE_LABEL = {
  system: "Auto",
  light: "Light",
  dark: "Dark",
};

/** Material Symbols names, resolved by components/Icon.js. */
export const MODE_ICON = {
  system: "light_mode_auto",
  light: "light_mode",
  dark: "dark_mode",
};

/*
 * Ids only — no colours. Each id has a `--pal-<id>` in tokens.css defined in
 * both modes, so a swatch paints itself with `var(--pal-yellow)` and shows the
 * colour the user would actually get. Carrying a hex here would mean picking
 * one of the pair, and the swatch would then lie in the other mode.
 */
export const PALETTES = [
  { id: "green",  label: "Signal green" },
  { id: "blue",   label: "Blue" },
  { id: "violet", label: "Violet" },
  { id: "amber",  label: "Amber" },
  { id: "red",    label: "Red" },
  { id: "yellow", label: "Yellow" },
  { id: "slate",  label: "Slate" },
];

export const DEFAULT_MODE = "system";
export const DEFAULT_PALETTE = "green";

function read(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}

function write(key, value) {
  try { localStorage.setItem(key, value); } catch { /* nothing to do */ }
}

/** The stored appearance, or the defaults. Never throws; never returns a
 *  value outside the lists above, so a hand-edited key cannot leave the page
 *  with an attribute no stylesheet answers. */
export function loadTheme() {
  const mode = read(KEY_MODE);
  const palette = read(KEY_PALETTE);
  return {
    mode: MODES.includes(mode) ? mode : DEFAULT_MODE,
    palette: PALETTES.some(p => p.id === palette) ? palette : DEFAULT_PALETTE,
  };
}

/**
 * Put the choice on `<html>`, where the stylesheet can see it.
 *
 * `system` *removes* the attribute rather than setting a value: the media
 * query in tokens.css is the system answer, and a third attribute value would
 * mean writing the whole neutral ramp a fourth time.
 */
export function applyTheme({ mode, palette }) {
  const root = document.documentElement;
  if (mode === "light" || mode === "dark") {
    root.dataset.theme = mode;
  } else {
    delete root.dataset.theme;
  }
  root.dataset.palette = palette;
}

export function saveTheme({ mode, palette }) {
  write(KEY_MODE, mode);
  write(KEY_PALETTE, palette);
}

/** Auto -> Light -> Dark -> Auto. Three states in one control, because the
 *  interesting one is "follow the system" and a two-state toggle cannot say
 *  it. */
export function nextMode(mode) {
  const i = MODES.indexOf(mode);
  return MODES[(i + 1) % MODES.length];
}
