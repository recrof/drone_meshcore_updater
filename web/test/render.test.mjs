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
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";

let JSDOM;
try {
  ({ JSDOM } = await import("jsdom"));
} catch {
  console.log("  skip  jsdom not installed (npm install --no-save jsdom)");
  process.exit(0);
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
t("toolbar actions are icon-only",  app.querySelectorAll(".toolbar .icon-btn svg.icon").length === 5);
t("listing table rendered",         !!app.querySelector("table thead th"));
t("footer rendered",                !!app.querySelector("footer"));
t("log pane rendered",              !!app.querySelector("#log"));
t("drop overlay rendered",          !!app.querySelector("#drop-overlay"));
t("config dialog closed initially", !app.querySelector("#cfg-overlay"));
t("flash dialog closed initially",  !app.querySelector("#flash-overlay"));
t("Flash-updater button present",   !!app.querySelector('button[aria-label="Flash updater"]'));
/* Enabled with nothing connected — it runs over USB, which is the whole point
   of it. It becomes disabled once a BLE link is up (flashing halts the CPU). */
t("Flash-updater button enabled while disconnected",
  app.querySelector('button[aria-label="Flash updater"]')?.disabled === false);
t("no-bluetooth notice logged",     /does not support Web Bluetooth/.test(text));

/* Open the dialog (the button is disabled until connected, so force it). */
const btn = app.querySelector('button[aria-label="Config"]');
btn.disabled = false;
btn.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
await new Promise(r => setTimeout(r, 600));

const dlg = app.querySelector("#cfg-overlay");
const dlgText = dlg ? dlg.textContent.replace(/\s+/g, " ") : "";

t("config dialog opens",     !!dlg);
t("one row per schema key",  dlg?.querySelectorAll(".cfg-row").length === 14);
t("sections rendered",       dlg?.querySelectorAll(".cfg-section").length >= 3);
t("every row has a description", dlg?.querySelectorAll(".cfg-row .desc").length === 14);
t("every row has a default chip", dlg?.querySelectorAll(".cfg-def").length === 14);
t("ble_name is a text input", dlg?.querySelector("#cfg-ble_name")?.type === "text");
t("high_mtu is a checkbox",   dlg?.querySelector("#cfg-high_mtu")?.type === "checkbox");
t("tx_power is a select",     dlg?.querySelector("#cfg-tx_power")?.tagName === "SELECT");
t("size budget shown",        /\/ 1023 B/.test(dlgText));

/* --- per-key help is collapsed until asked for ------------------------- */

/* The descriptions stay in the DOM (v-show, so they are findable and the
 * aria-controls target always exists) but must not be visible on open — the
 * whole point of the (i) is that the dialog opens as a settings screen. */
const helpBlocks = [...(dlg?.querySelectorAll(".cfg-help") ?? [])];
t("every row has a help block",   helpBlocks.length === 14);
t("help hidden on open",          helpBlocks.every(h => h.style.display === "none"));
t("every row has an (i) button",  dlg?.querySelectorAll(".cfg-info").length === 14);
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
  const btn = app.querySelector('button[aria-label="Flash updater"]');
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

console.log(bad || errors.length ? "\nFAILED" : "\nall render tests passed");
process.exit(bad || errors.length ? 1 : 0);
