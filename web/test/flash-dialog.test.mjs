/*
 * The USB flasher's UI, with WebUSB present.
 *
 *   node web/tools/build-single.mjs
 *   node web/test/flash-dialog.test.mjs web/dist/updater.html
 *
 * Split from render.test.mjs because it needs a *stubbed* navigator.usb.
 * jsdom has none, so render.test.mjs only ever exercised the "this browser
 * cannot flash" branch — the entire probe UI, which is what actually ships to
 * Chrome users, went unrendered by any test.
 *
 * The class of bug this exists to catch: a toolbar button that sets a ref
 * nothing is listening to. That produces no console error and no visible
 * effect, so only an assertion that the *dialog appears* catches it.
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
const errors = [];

const dom = new JSDOM(readFileSync(file, "utf8"), {
  runScripts: "dangerously",
  pretendToBeVisual: true,
  url: "https://example.org/",
  beforeParse(win) {
    /* Pretend to be Chrome. requestDevice rejects the way a real one does
     * when the user dismisses the chooser, so the failure path renders too. */
    Object.defineProperty(win.navigator, "usb", {
      configurable: true,
      value: {
        requestDevice: async () => { throw new Error("No device selected."); },
        getDevices: async () => [],
      },
    });
    win.addEventListener("error", (e) =>
      errors.push("window.error: " + (e.error?.stack || e.message)));
    win.console.error = (...a) => errors.push("console.error: " + a.join(" "));
    win.console.warn  = (...a) => errors.push("console.warn: "  + a.join(" "));
  },
});

const w = dom.window, d = w.document;
const wait = (ms) => new Promise(r => setTimeout(r, ms));
const click = (el) => el.dispatchEvent(new w.MouseEvent("click", { bubbles: true }));

await wait(1500);

let bad = 0;
const t = (name, ok, extra = "") => {
  console.log(`${ok ? "  ok  " : "  FAIL"} ${name}${extra ? `  [${extra}]` : ""}`);
  if (!ok) bad++;
};

const app = d.getElementById("app");
const btn = app.querySelector('button[aria-label="Flash updater"]');
t("WebUSB is stubbed", !!w.navigator.usb);
t("toolbar has the Flash-updater button", !!btn);

click(btn);
await wait(400);

const dlg = app.querySelector("#flash-overlay");
/* This is the assertion that would have caught the shipped bug: the button
 * existed and the ref flipped, but no dialog was mounted to observe it. */
t("clicking opens the dialog", !!dlg);

const text = () => (app.querySelector("#flash-overlay")?.textContent || "").replace(/\s+/g, " ");

t("probe controls render when WebUSB exists", !!dlg?.querySelector(".flash-step"));
t("no 'cannot flash' notice with WebUSB present", !/has no WebUSB/.test(text()));
t("names merged.hex as the file to use", /merged\.hex/.test(text()));

const buttons = [...dlg.querySelectorAll("button")];
const connectBtn = buttons.find(b => /Connect probe/.test(b.textContent));
t("offers a Connect probe button", !!connectBtn);

/* Two one-click paths, not a choose-then-write sequence. */
const newestBtn = buttons.find(b => /Flash newest/.test(b.textContent));
t("offers Flash newest", !!newestBtn);
t("Flash newest blocked before a probe is attached", newestBtn?.disabled === true);
t("says why it is blocked", /connect the probe first/.test(text()));

const custom = dlg.querySelector('input[type=file][accept=".hex"]');
t("offers a custom .hex chooser", !!custom);
t("custom chooser disabled before a probe is attached", custom?.disabled === true);
t("custom flash is described as immediate", /straight away/.test(text()));
/* zephyr.hex links at 0x10000 once MCUboot is in the build and will not boot
   alone; the write refuses it, but saying so up front is cheaper. */
t("points the custom path at merged.hex", /merged\.hex/.test(text()));
t("warns off zephyr.hex", /zephyr\.hex/.test(text()));

/* No manifest is served in the harness, so the newest build is unavailable
 * and must say so rather than offering a dead button. */
t("reports that no published build is available",
  /no published build available/.test(text()));

/* A dismissed WebUSB chooser must surface, not vanish. */
click(connectBtn);
await wait(400);
t("a refused device chooser is reported",
  /No device selected/.test(text()), text().slice(-160));
t("still no probe attached after a refusal",
  !!app.querySelector("#flash-overlay")?.querySelector(".flash-step"));

const close = [...dlg.querySelectorAll(".cfg-foot button")].find(b => /Close/.test(b.textContent));
click(close);
await wait(300);
t("dialog closes", !app.querySelector("#flash-overlay"));

if (errors.length) {
  console.log("\n--- console/window errors ---");
  for (const e of [...new Set(errors)]) console.log("  " + e.slice(0, 400));
}
console.log(bad || errors.length ? "\nFAILED" : "\nall flash-dialog tests passed");
process.exit(bad || errors.length ? 1 : 0);
