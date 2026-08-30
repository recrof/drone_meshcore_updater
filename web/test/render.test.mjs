/*
 * Mounts the bundled app in jsdom and asserts it rendered.
 *
 * This is the only check that catches Vue *template* errors — templates are
 * compiled at runtime, so `node --check` and the bundler both pass happily on
 * a broken one.
 *
 * Needs a bundle and jsdom:
 *   node web/tools/build-single.mjs
 *   npm install --no-save jsdom
 *   node web/test/render.test.mjs web/dist/updater.html
 */
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";

const WEB0 = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/* --- round buttons vs the global tap-target floor ------------------------
 *
 * Runs before the jsdom gate below, because it needs no browser and must not
 * be skipped along with the render tests.
 *
 * base.css floors every <button> at --minhit so a thumb has something to hit.
 * **min-height beats height in the cascade**, so a button asking for
 * `width: 17px; height: 17px; border-radius: 50%` is used at 17x36 and draws
 * an ellipse. That is what happened to the config dialog's (i) button: it
 * looked right in every rule you would think to read, and wrong on screen.
 *
 * Nothing at run time catches it, and the next round icon button will hit the
 * same wall, so: any CSS rule that rounds a <button> to a circle must also
 * neutralise the floor. */
let cssBad = 0;
{
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "");
  const cssDir = join(WEB0, "css");
  const css = readdirSync(cssDir).filter(f => f.endsWith(".css"))
    .map(f => ({ f, text: strip(readFileSync(join(cssDir, f), "utf8")) }));

  /* The guard is only meaningful while the floor exists. If base.css stops
   * setting it, this test should be deleted rather than quietly passing. */
  const floor = css.find(c => c.f === "base.css")?.text ?? "";
  if (!/button[^{}]*\{[^{}]*min-height\s*:/.test(floor)) {
    console.log("  FAIL base.css no longer floors button min-height — this guard is stale");
    cssBad++;
  }

  /* Classes that appear on a <button> in any component template. */
  const compDir = join(WEB0, "js", "components");
  const buttonClasses = new Set();
  for (const f of readdirSync(compDir).filter(f => f.endsWith(".js"))) {
    const src = readFileSync(join(compDir, f), "utf8");
    for (const m of src.matchAll(/<button\b[^>]*?\bclass="([^"]*)"/g)) {
      for (const c of m[1].split(/\s+/)) if (c) buttonClasses.add(c);
    }
  }

  /* Innermost blocks only: `[^{}]*` in the body cannot span a nested rule, so
   * @media wrappers are stepped over rather than mis-parsed. */
  for (const { f, text } of css) {
    for (const m of text.matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
      const sel = m[1].trim(), body = m[2];
      if (!/border-radius\s*:\s*50%/.test(body)) continue;
      if (!/\bheight\s*:\s*[\d.]+px/.test(body)) continue;
      const classes = (sel.match(/\.([A-Za-z0-9_-]+)/g) ?? []).map(s => s.slice(1));
      const onButton = classes.filter(c => buttonClasses.has(c));
      if (onButton.length === 0) continue;          // a span or a div — unaffected
      const ok = /min-height\s*:/.test(body);
      console.log(`${ok ? "  ok  " : "  FAIL"} ${f}: ${sel} is a round <button> ` +
                  `(.${onButton.join(", .")})${ok ? " and clears min-height" : ""}`);
      if (!ok) {
        console.log("        add 'min-height: 0' — base.css's --minhit floor " +
                    "overrides its height and makes it an ellipse");
        cssBad++;
      }
    }
  }
}

let JSDOM;
try {
  ({ JSDOM } = await import("jsdom"));
} catch {
  console.log("  skip  jsdom not installed (npm install --no-save jsdom)");
  /* The CSS guard above still counts — it needs no browser. */
  process.exit(cssBad ? 1 : 0);
}

const WEB = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const file = process.argv[2] ?? join(WEB, "dist", "updater.html");
const html = readFileSync(file, "utf8");
const errors = [];

const dom = new JSDOM(html, {
  runScripts: "dangerously",
  pretendToBeVisual: true,
  url: "https://example.org/",
  beforeParse(win) {
    win.addEventListener("error", (e) =>
      errors.push("window.error: " + (e.error?.stack || e.message)));
    win.console.error = (...a) => errors.push("console.error: " + a.join(" "));
    win.console.warn  = (...a) => errors.push("console.warn: "  + a.join(" "));
  },
});

await new Promise(r => setTimeout(r, 1500));

const app = dom.window.document.getElementById("app");
const text = app.textContent.replace(/\s+/g, " ").trim();

let bad = 0;
const t = (name, ok) => {
  console.log(`${ok ? "  ok  " : "  FAIL"} ${name}`);
  if (!ok) bad++;
};

t("app mounted",                    app.children.length > 0);
t("header rendered",                !!app.querySelector("header"));
t("toolbar rendered",               !!app.querySelector(".toolbar"));
t("Config button present",          !!app.querySelector('button[aria-label="Config"]'));
/* Every toolbar action carries an icon AND a readable label. Counting icons
   alone let a stale bundle pass once — assert the text too. */
{
  const btns = [...app.querySelectorAll(".toolbar button")];
  t("every toolbar action has an icon",
    btns.length > 0 && btns.every(b => b.querySelector("svg.icon")));
  t("every toolbar action has a visible label",
    btns.every(b => b.querySelector(".label")?.textContent.trim()),
    btns.map(b => b.textContent.trim()).join(" | "));
  t("every toolbar action has an aria-label",
    btns.every(b => b.getAttribute("aria-label")));

  /* Update updater is first and, on a cold open, the only thing you can press
     — that is the whole point of its position. */
  t("Update updater is the first action",
    btns[0]?.getAttribute("aria-label") === "Update updater",
    btns[0]?.getAttribute("aria-label"));
  t("it is the only action enabled while disconnected",
    btns.filter(b => !b.disabled).length === 1 &&
    btns.find(b => !b.disabled)?.getAttribute("aria-label") === "Update updater",
    btns.filter(b => !b.disabled).map(b => b.textContent.trim()).join(", "));

  /* And it must never be disabled at all. Checked against the source rather
     than the DOM because the bundle renders disconnected, which is exactly
     the state where the bug hides: the button was once disabled *while
     connected*, which is the only state the Bluetooth update route works in —
     so the whole OTA path became unreachable and nothing rendered wrong. */
  const toolbarSrc = readFileSync(join(WEB, "js/components/FileToolbar.js"), "utf8");
  const updateBtn = toolbarSrc.match(/<button[^>]*aria-label="Update updater"[^>]*>/s)?.[0] ?? "";
  t("Update updater button exists in source", !!updateBtn);
  t("Update updater is never disabled",
    !!updateBtn && !/:disabled/.test(updateBtn), updateBtn.replace(/\s+/g, " ").slice(0, 110));
}
t("Device-log button present",      !!app.querySelector('button[aria-label="Device log"]'));

/* --- the DFU banner ---------------------------------------------------- *
 *
 * It renders nothing here, which is correct: no device, so no run. What this
 * checks is that App actually *mounts* it — a component imported and never
 * placed is the exact shape of bug that took the flash button down once, and
 * it produces no error anywhere. Its behaviour when there is something to
 * report is dfu-banner.test.mjs; that needs a driven store, which this
 * whole-app mount has no way to reach.
 */
t("no DFU banner while nothing is running", !app.querySelector(".dfu-banner"));
{
  const appSrc = readFileSync(join(WEB, "js/App.js"), "utf8");
  t("App mounts DfuStatus", /<DfuStatus\s*\/>/.test(appSrc));
  t("DfuStatus is registered", /components: \{[^}]*DfuStatus/s.test(appSrc));

  /* The Log button is the fallback route once the banner has been dismissed,
   * so it has to be marked while a run is going and open the live view. */
  const tbSrc = readFileSync(join(WEB, "js/components/FileToolbar.js"), "utf8");
  const logBtn = tbSrc.match(/<button[^>]*aria-label="Device log"[^>]*>/s)?.[0] ?? "";
  t("Log button exists in source", !!logBtn);
  t("Log button is marked while a DFU runs", /attention: dfuActive/.test(logBtn), logBtn);
  t("Log button opens the live view during a run",
    /openLogView\('', dfuActive\)/.test(logBtn), logBtn);
}
t("listing table rendered",         !!app.querySelector("table thead th"));
t("footer rendered",                !!app.querySelector("footer"));
t("log pane rendered",              !!app.querySelector("#log"));
t("drop overlay rendered",          !!app.querySelector("#drop-overlay"));
t("config dialog closed initially", !app.querySelector("#cfg-overlay"));
t("flash dialog closed initially",  !app.querySelector("#flash-overlay"));
t("log viewer closed initially",    !app.querySelector("#log-overlay"));
t("Update-updater button present",  !!app.querySelector('button[aria-label="Update updater"]'));
/* Enabled always: USB when nothing is connected, Bluetooth when something is.
   It is the only route to the OTA update, so disabling it while connected —
   as it briefly was — makes that route unreachable. */
t("Update updater is enabled while disconnected",
  app.querySelector('button[aria-label="Update updater"]')?.disabled === false);
t("no-bluetooth notice logged",     /does not support Web Bluetooth/.test(text));

/* Open the dialog (the button is disabled until connected, so force it). */
const btn = app.querySelector('button[aria-label="Config"]');
btn.disabled = false;
btn.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
await new Promise(r => setTimeout(r, 600));

const dlg = app.querySelector("#cfg-overlay");
const dlgText = dlg ? dlg.textContent.replace(/\s+/g, " ") : "";

t("config dialog opens",     !!dlg);

/* Counted against the schema, not against a number written here. This used to
 * be a literal 14, which meant adding a config key failed three assertions
 * that had nothing to say about the key — the form is generated, so the only
 * thing worth asserting is that it generated one of everything. */
const { CONFIG_SCHEMA } = await import("../js/lib/config-file.js");
const KEYS = CONFIG_SCHEMA.length;

t(`one row per schema key (${KEYS})`,
  dlg?.querySelectorAll(".cfg-row").length === KEYS,
  String(dlg?.querySelectorAll(".cfg-row").length));
t("sections rendered",       dlg?.querySelectorAll(".cfg-section").length >= 3);
t("every row has a description",
  dlg?.querySelectorAll(".cfg-row .desc").length === KEYS,
  String(dlg?.querySelectorAll(".cfg-row .desc").length));
t("every row has a default chip",
  dlg?.querySelectorAll(".cfg-def").length === KEYS,
  String(dlg?.querySelectorAll(".cfg-def").length));
t("ble_name is a text input", dlg?.querySelector("#cfg-ble_name")?.type === "text");
t("high_mtu is a checkbox",   dlg?.querySelector("#cfg-high_mtu")?.type === "checkbox");
t("ble_tx_power is a select",  dlg?.querySelector("#cfg-ble_tx_power")?.tagName === "SELECT");
t("wifi_tx_power is a select", dlg?.querySelector("#cfg-wifi_tx_power")?.tagName === "SELECT");
/* The rename has to reach the DOM, not just the schema: a stale id here is a
   control that renders and edits a key the firmware no longer reads. */
t("the old tx_power key is gone from the form",
  !dlg?.querySelector("#cfg-tx_power"));
t("size budget shown",        /\/ 1023 B/.test(dlgText));

/* --- per-key help is collapsed until asked for ------------------------- */

/* The descriptions stay in the DOM (v-show, so they are findable and the
 * aria-controls target always exists) but must not be visible on open — the
 * whole point of the (i) is that the dialog opens as a settings screen. */
const helpBlocks = [...(dlg?.querySelectorAll(".cfg-help") ?? [])];
t("every row has a help block",   helpBlocks.length === KEYS,
  String(helpBlocks.length));
t("help hidden on open",          helpBlocks.every(h => h.style.display === "none"));
t("every row has an (i) button",  dlg?.querySelectorAll(".cfg-info").length === KEYS,
  String(dlg?.querySelectorAll(".cfg-info").length));
t("(i) reports collapsed state",
  [...dlg.querySelectorAll(".cfg-info")].every(b => b.getAttribute("aria-expanded") === "false"));

{
  const info = dlg.querySelector(".cfg-row .cfg-info");
  info.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  await new Promise(r => setTimeout(r, 100));
  const first = dlg.querySelector(".cfg-row .cfg-help");
  t("(i) reveals that row's help", first.style.display !== "none");
  t("(i) reveals only that row",
    [...dlg.querySelectorAll(".cfg-help")].filter(h => h.style.display !== "none").length === 1);
  info.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  await new Promise(r => setTimeout(r, 100));
  t("(i) toggles back closed", first.style.display === "none");
}

{
  const all = [...dlg.querySelectorAll(".cfg-head button")]
    .find(b => /Show all help/.test(b.textContent));
  t("show-all-help button present", !!all);
  all.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  await new Promise(r => setTimeout(r, 150));
  t("show all reveals every row",
    [...dlg.querySelectorAll(".cfg-help")].every(h => h.style.display !== "none"));
  all.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  await new Promise(r => setTimeout(r, 150));
  t("hide all collapses every row",
    [...dlg.querySelectorAll(".cfg-help")].every(h => h.style.display === "none"));
}

/* --- ble_firmware_mapping gets a rule editor, not a raw string --------- */
{
  const ed = dlg.querySelector("#cfg-ble_firmware_mapping");
  t("mapping row renders the editor", !!ed && ed.classList.contains("map-editor"));
  t("mapping row is full-width",
    !!ed?.closest(".cfg-row")?.classList.contains("wide"));
  t("empty mapping shows the empty state", !!ed?.querySelector(".map-empty"));
  t("no rule rows when empty", ed?.querySelectorAll(".map-rule").length === 0);

  const add = [...ed.querySelectorAll("button")].find(b => /Add rule/.test(b.textContent));
  t("add-rule button present", !!add);
  add.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  await new Promise(r => setTimeout(r, 120));
  t("add creates a rule row", ed.querySelectorAll(".map-rule").length === 1);
  t("rule row has both halves",
    !!ed.querySelector(".map-rule .map-name") && !!ed.querySelector(".map-rule .map-file"));

  /* A half-filled rule is discarded by the firmware without a word, so the
   * editor has to block the save rather than let it look accepted. */
  const nameIn = ed.querySelector(".map-rule .map-name");
  nameIn.value = "RAK";
  nameIn.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  await new Promise(r => setTimeout(r, 120));
  const saveBtn = [...dlg.querySelectorAll(".cfg-foot button")]
    .find(b => /Save to device/.test(b.textContent));
  t("incomplete rule blocks save", saveBtn?.disabled === true);

  const fileIn = ed.querySelector(".map-rule .map-file");
  fileIn.value = "rak4631*.zip";
  fileIn.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  await new Promise(r => setTimeout(r, 120));
  t("completed rule unblocks save", saveBtn?.disabled === false);
  t("rule serializes into the file preview",
    /ble_firmware_mapping=RAK:rak4631\*\.zip/.test(dlg.querySelector(".cfg-extra").textContent));

  const del = [...ed.querySelectorAll(".map-rule button")].find(b => b.textContent.includes("✕"));
  del.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  await new Promise(r => setTimeout(r, 120));
  t("remove deletes the rule", ed.querySelectorAll(".map-rule").length === 0);
}

if (errors.length) {
  console.log("\n--- console/window errors ---");
  for (const e of [...new Set(errors)]) console.log("  " + e.slice(0, 400));
}
/* --- USB flasher ------------------------------------------------------- */
{
  const btn = app.querySelector('button[aria-label="Update updater"]');
  btn.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  await new Promise(r => setTimeout(r, 400));
  const dlg = app.querySelector("#flash-overlay");
  const text = dlg ? dlg.textContent.replace(/\s+/g, " ") : "";

  t("flash dialog opens", !!dlg);
  /* jsdom has no navigator.usb, which is the same situation as Firefox or
   * Safari — the dialog must say so instead of offering a dead button. */
  t("no-WebUSB notice shown", /has no WebUSB/.test(text));
  /* Filename guidance lives inside the WebUSB branch, which jsdom never
     renders — flash-dialog.test.mjs stubs navigator.usb and asserts it there. */
  t("no probe controls without WebUSB", !dlg?.querySelector(".flash-step"));

  const close = [...dlg.querySelectorAll(".cfg-foot button")]
    .find(b => /Close/.test(b.textContent));
  close.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  await new Promise(r => setTimeout(r, 200));
  t("flash dialog closes", !app.querySelector("#flash-overlay"));
}

/* --- device log viewer -------------------------------------------------- */
{
  const btn = app.querySelector('button[aria-label="Device log"]');
  btn.disabled = false;                     // gated on a connection
  btn.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  await new Promise(r => setTimeout(r, 400));

  const v = app.querySelector("#log-overlay");
  const vt = v ? v.textContent.replace(/\s+/g, " ") : "";
  t("log viewer opens", !!v);
  /* Nothing is connected, so there are no entries and therefore no log files.
     It must say so rather than showing a blank pane. */
  t("empty state explains where logs come from", /LOG\.0000/.test(vt), vt.slice(0, 160));
  t("has a level filter", !!v?.querySelector('select[aria-label="Minimum level"]'));
  t("has a text filter",  !!v?.querySelector('input[aria-label="Filter text"]'));
  t("has a log pane",     !!v?.querySelector(".logv-body"));
  /* Live streaming is opt-in: the firmware backend only runs while something
     is subscribed, and it shares three TX buffers with the DFU stream. */
  const liveBtn = v?.querySelector('button[aria-label="Live"]');
  t("offers a live-stream toggle", !!liveBtn);
  t("live is off until asked for", /Go live/.test(liveBtn?.textContent ?? ""),
    liveBtn?.textContent.trim());
  t("live has a status indicator", !!v?.querySelector(".live-dot"));
  t("follow control hidden until live", !v?.querySelector(".logv-follow"));

  const close = [...v.querySelectorAll(".cfg-foot button")].find(b => /Close/.test(b.textContent));
  close.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  await new Promise(r => setTimeout(r, 200));
  t("log viewer closes", !app.querySelector("#log-overlay"));
}

/* --- appearance: mode + accent, and both remembered ---------------------
 *
 * The persistence is the part worth testing. Applying a colour is visible the
 * instant you click it; a preference that silently fails to save looks
 * identical until the next visit, which is the wrong place to find out.
 *
 * The menu's *closing* is worth testing for a different reason: a popup that
 * only closes via its own button is one that sits over the controls you were
 * reaching for, and nothing about that shows up as an error.
 */
{
  const root = dom.window.document.documentElement;
  const store = dom.window.localStorage;
  const ctl = app.querySelector(".theme-ctl");
  const click = (el) => el.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  const settle = () => new Promise(r => setTimeout(r, 100));

  t("header has the appearance controls", !!ctl);

  const themeSrc = readFileSync(join(WEB, "js/lib/theme.js"), "utf8");
  const ids = [...themeSrc.matchAll(/\{ id: "([a-z]+)"/g)].map(m => m[1]);
  const tokens = readFileSync(join(WEB, "css/tokens.css"), "utf8");
  const iconSrc = readFileSync(join(WEB, "js/components/Icon.js"), "utf8");

  /* Every palette needs a `--pal-<id>` (the swatch paints itself with it) and
     a `[data-palette="<id>"]` rule (or picking it leaves the accent on the
     previous one — a control that appears to do nothing). */
  for (const id of ids) {
    t(`tokens.css selects the ${id} palette`, tokens.includes(`[data-palette="${id}"]`));
    t(`tokens.css defines --pal-${id}`, tokens.includes(`--pal-${id}:`));
  }
  t("every palette token is defined in both modes",
    ids.every(id => (tokens.match(new RegExp(`--pal-${id}:`, "g")) ?? []).length >= 3),
    "each needs a light, a dark and a prefers-color-scheme value");

  /* An icon name theme.js asks for and Icon.js does not have renders an empty
     <path> — a button with nothing in it, and no error anywhere. */
  const iconNames = [...themeSrc.matchAll(/: "([a-z_]+)",/g)].map(m => m[1])
    .filter(n => /mode|palette/.test(n));
  t("theme.js names three mode icons", iconNames.length === 3, iconNames.join(","));
  for (const n of [...iconNames, "palette"]) {
    t(`Icon.js has the ${n} glyph`, new RegExp(`\\b${n}:\\s*\n?\\s*"M`).test(iconSrc));
  }

  /* --- the mode button: Auto -> Light -> Dark -> Auto --- */
  const mode = ctl?.querySelector("button.icon-only");
  t("mode control is an icon button", !!mode?.querySelector("svg.icon"));
  t("starts on Auto", /Appearance: Auto/.test(mode?.getAttribute("title") ?? ""),
    mode?.getAttribute("title"));
  /* `system` must *remove* the attribute, not set a third value: the media
     query in tokens.css is the system answer. */
  t("Auto sets no data-theme", root.dataset.theme === undefined, root.dataset.theme);

  for (const [label, attr] of [["Light", "light"], ["Dark", "dark"], ["Auto", undefined]]) {
    click(mode);
    await settle();
    t(`cycles to ${label}`,
      new RegExp("Appearance: " + label).test(mode.getAttribute("title")),
      mode.getAttribute("title"));
    t(`...and data-theme is ${attr ?? "absent"}`, root.dataset.theme === attr,
      String(root.dataset.theme));
    t(`...and ${label} is remembered`,
      store.getItem("dmu.theme.mode") === (attr ?? "system"),
      store.getItem("dmu.theme.mode"));
  }

  /* --- the palette menu --- */
  const palBtn = [...ctl.querySelectorAll("button.icon-only")][1];
  t("palette control is a second icon button", !!palBtn?.querySelector("svg.icon"));
  t("menu is closed to begin with", !ctl.querySelector(".theme-menu"));
  t("...and says so", palBtn?.getAttribute("aria-expanded") === "false");

  click(palBtn);
  await settle();
  const menu = ctl.querySelector(".theme-menu");
  t("clicking it opens a menu", !!menu);
  t("...and says so", palBtn?.getAttribute("aria-expanded") === "true");

  const opts = [...(menu?.querySelectorAll(".theme-opt") ?? [])];
  t("one row per palette", opts.length === ids.length, `${opts.length} vs ${ids.length}`);
  t("rows are named", opts.every(o => (o.textContent ?? "").trim().length > 2));
  t("exactly one row is checked",
    opts.filter(o => o.getAttribute("aria-checked") === "true").length === 1);

  /* Pick the last one: never the default, so a no-op would show. */
  click(opts[opts.length - 1]);
  await settle();
  t("choosing sets data-palette",
    root.dataset.palette === ids[ids.length - 1], root.dataset.palette);
  t("...and remembers it",
    store.getItem("dmu.theme.palette") === ids[ids.length - 1]);
  t("...and closes the menu", !ctl.querySelector(".theme-menu"));

  /* Escape, and a click anywhere else, both have to work — see the note above. */
  click(palBtn); await settle();
  t("menu reopens", !!ctl.querySelector(".theme-menu"));
  dom.window.document.dispatchEvent(
    new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await settle();
  t("Escape closes it", !ctl.querySelector(".theme-menu"));

  click(palBtn); await settle();
  t("menu reopens again", !!ctl.querySelector(".theme-menu"));
  /* jsdom has no PointerEvent constructor; a bubbling Event of the same type
     reaches the document listener the same way a real one would. */
  app.dispatchEvent(new dom.window.Event("pointerdown", { bubbles: true }));
  await settle();
  t("a click outside closes it", !ctl.querySelector(".theme-menu"));
}

/* --- the inline bootstrap in index.html must agree with theme.js ---------
 *
 * index.html carries a duplicate read-and-apply so the page does not paint
 * light before the module loads. Duplication that cannot be removed gets
 * checked instead: a key renamed in one file and not the other produces a
 * white flash on every load and nothing else — no error, no failure, just a
 * preference that appears to be ignored until the app finishes booting.
 */
{
  const indexHtml = readFileSync(join(WEB, "index.html"), "utf8");
  const themeSrc = readFileSync(join(WEB, "js/lib/theme.js"), "utf8");
  const keys = [...themeSrc.matchAll(/= "(dmu\.theme\.[a-z]+)"/g)].map(m => m[1]);
  t("theme.js declares two storage keys", keys.length === 2, keys.join(","));
  for (const k of keys) {
    t(`index.html bootstraps ${k}`, indexHtml.includes(k));
  }
  t("index.html sets data-theme", /dataset\.theme/.test(indexHtml));
  t("index.html sets data-palette", /dataset\.palette/.test(indexHtml));
  /* It must not throw where storage does. */
  t("index.html guards storage access", /try\s*\{[\s\S]*catch/.test(indexHtml));
}

console.log(bad || errors.length || cssBad ? "\nFAILED" : "\nall render tests passed");
process.exit(bad || errors.length || cssBad ? 1 : 0);
