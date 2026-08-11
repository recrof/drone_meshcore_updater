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
t("Config button present",          [...app.querySelectorAll("button")].some(b => b.textContent.includes("Config")));
t("listing table rendered",         !!app.querySelector("table thead th"));
t("footer rendered",                !!app.querySelector("footer"));
t("log pane rendered",              !!app.querySelector("#log"));
t("drop overlay rendered",          !!app.querySelector("#drop-overlay"));
t("config dialog closed initially", !app.querySelector("#cfg-overlay"));
t("no-bluetooth notice logged",     /does not support Web Bluetooth/.test(text));

/* Open the dialog (the button is disabled until connected, so force it). */
const btn = [...app.querySelectorAll("button")].find(b => b.textContent.includes("Config"));
btn.disabled = false;
btn.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
await new Promise(r => setTimeout(r, 600));

const dlg = app.querySelector("#cfg-overlay");
const dlgText = dlg ? dlg.textContent.replace(/\s+/g, " ") : "";

t("config dialog opens",     !!dlg);
t("one row per schema key",  dlg?.querySelectorAll(".cfg-row").length === 11);
t("sections rendered",       dlg?.querySelectorAll(".cfg-section").length >= 3);
t("every row has a description", dlg?.querySelectorAll(".cfg-row .desc").length === 11);
t("every row has a default chip", dlg?.querySelectorAll(".cfg-def").length === 11);
t("ble_name is a text input", dlg?.querySelector("#cfg-ble_name")?.type === "text");
t("high_mtu is a checkbox",   dlg?.querySelector("#cfg-high_mtu")?.type === "checkbox");
t("tx_power is a select",     dlg?.querySelector("#cfg-tx_power")?.tagName === "SELECT");
t("size budget shown",        /\/ 1023 B/.test(dlgText));

if (errors.length) {
  console.log("\n--- console/window errors ---");
  for (const e of [...new Set(errors)]) console.log("  " + e.slice(0, 400));
}
console.log(bad || errors.length ? "\nFAILED" : "\nall render tests passed");
process.exit(bad || errors.length ? 1 : 0);
