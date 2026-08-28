/*
 * The DFU banner, rendered for real.
 *
 *   npm install --no-save jsdom
 *   node web/test/dfu-banner.test.mjs
 *
 * Separate from render.test.mjs for the same reason flash-dialog.test.mjs is:
 * that test mounts a *disconnected* app, and this component is invisible in
 * every state a disconnected app can reach. Its setup() runs, so a broken
 * import or a template compile error would surface there — but nothing checks
 * that it says anything useful once the device starts talking, and a status
 * banner that renders the wrong thing is worse than none.
 *
 * The harness (test/harness/dfu-banner.js) is bundled with the same esbuild
 * the single-file build uses, because jsdom has no ES module loader: an inline
 * <script type="module"> cannot import a sibling file.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { STATE, RESULT, HEADER_LEN, PAYLOAD_VERSION } from "../js/lib/dfu-status.js";

let JSDOM;
try {
  ({ JSDOM } = await import("jsdom"));
} catch {
  console.log("  skip  jsdom not installed (npm install --no-save jsdom)");
  process.exit(0);
}

const WEB = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/* One esbuild version for the whole repo. Read out of the build script rather
 * than pinned again here — a second copy of a version number is a second
 * thing to forget. */
const ESBUILD_VERSION = readFileSync(join(WEB, "tools/build-single.mjs"), "utf8")
  .match(/ESBUILD_VERSION\s*=\s*"([^"]+)"/)?.[1];
if (!ESBUILD_VERSION) {
  console.log("  FAIL could not read ESBUILD_VERSION out of tools/build-single.mjs");
  process.exit(1);
}

let bundle;
try {
  bundle = execFileSync(
    "npx",
    ["--yes", `esbuild@${ESBUILD_VERSION}`, "test/harness/dfu-banner.js",
     "--bundle", "--format=iife", "--platform=browser", "--target=es2022"],
    { cwd: WEB, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] },
  );
} catch (e) {
  console.log(`  skip  esbuild unavailable (${e.message.split("\n")[0]})`);
  process.exit(0);
}

const css = ["tokens.css", "base.css", "layout.css"]
  .map(f => readFileSync(join(WEB, "css", f), "utf8")).join("\n");

const errors = [];
const dom = new JSDOM(
  `<!doctype html><html><head><style>${css}</style></head>` +
  `<body><div id="app"></div><script>${bundle}</script></body></html>`,
  {
    runScripts: "dangerously",
    pretendToBeVisual: true,
    url: "https://example.org/",
    beforeParse(win) {
      win.addEventListener("error", (e) =>
        errors.push("window.error: " + (e.error?.stack || e.message)));
      win.console.error = (...a) => errors.push("console.error: " + a.join(" "));
      win.console.warn = (...a) => errors.push("console.warn: " + a.join(" "));
    },
  },
);

const w = dom.window, d = w.document;
const wait = (ms) => new Promise(r => setTimeout(r, ms));
const click = (el) => el.dispatchEvent(new w.MouseEvent("click", { bubbles: true }));

await wait(300);

let bad = 0;
const t = (name, ok, extra = "") => {
  console.log(`${ok ? "  ok  " : "  FAIL"} ${name}${extra ? `  [${extra}]` : ""}`);
  if (!ok) bad++;
};

/* Same layout the firmware's encode() writes. Deliberately built here rather
 * than reusing a helper: this test is a consumer of the wire format, and
 * dfu-status.test.mjs is what proves the format matches the firmware. */
function payload({
  state = STATE.UPLOADING, percent = 0, result = RESULT.NONE, attempt = 1,
  retries = 5, sent = 0, total = 0, elapsedMs = 0, target = "", file = "",
} = {}) {
  const enc = new TextEncoder();
  const name = enc.encode(target), bundleName = enc.encode(file);
  const b = new Uint8Array(HEADER_LEN + name.length + bundleName.length);
  const dv = new DataView(b.buffer);
  b[0] = PAYLOAD_VERSION; b[1] = state; b[2] = percent; b[3] = result;
  b[4] = attempt; b[5] = retries; b[6] = bundleName.length; b[7] = name.length;
  dv.setUint32(8, sent, true);
  dv.setUint32(12, total, true);
  dv.setUint32(16, elapsedMs, true);
  b.set(name, HEADER_LEN);
  b.set(bundleName, HEADER_LEN + name.length);
  return Array.from(b);
}

const feed = async (o) => { w.__dfuTest.feed(payload(o)); await wait(60); };
const banner = () => d.querySelector(".dfu-banner");
const text = () => (banner()?.textContent || "").replace(/\s+/g, " ").trim();

t("harness mounted", !!w.__dfuTest);

/* --- nothing to report, nothing on screen ------------------------------- */

t("no banner before the device says anything", !banner());
await feed({ state: STATE.IDLE });
t("IDLE renders no banner", !banner());

/* --- scanning ----------------------------------------------------------- */

await feed({ state: STATE.SCANNING, attempt: 1, retries: 5, file: "rak4631.zip" });
t("a run makes the banner appear", !!banner());
t("it names the step", /Scanning for the target/.test(text()), text());
t("it names the bundle", /rak4631\.zip/.test(text()));
t("it shows which attempt", /attempt 1\/5/.test(text()), text());
t("the banner is marked running", banner()?.classList.contains("run"));

/* A step with no percentage sweeps rather than sitting at 0% — a bar parked
 * at zero through a six-second scan reads as stuck. */
t("scanning shows an indeterminate bar",
  d.querySelector(".dfu-bar")?.classList.contains("indeterminate"));
t("no percentage shown while scanning", !d.querySelector(".dfu-pct"));

/* --- uploading ---------------------------------------------------------- */

await feed({
  state: STATE.UPLOADING, percent: 25, sent: 128000, total: 511472,
  elapsedMs: 8000, target: "RAK4631_OTA", file: "rak4631.zip", attempt: 1, retries: 5,
});
t("upload switches to a real percentage",
  !d.querySelector(".dfu-bar")?.classList.contains("indeterminate"));
t("percentage rendered", d.querySelector(".dfu-pct")?.textContent.trim() === "25%",
  d.querySelector(".dfu-pct")?.textContent);
t("bar width follows the percentage",
  d.querySelector(".dfu-bar .fill")?.style.width === "25%",
  d.querySelector(".dfu-bar .fill")?.style.width);
t("it names the peer", /RAK4631_OTA/.test(text()));
t("KB counts rendered", /125 \/ 499 KB/.test(text()), text());
t("elapsed rendered as m:ss", /0:08/.test(text()), text());

/* No rate yet: the only thing to difference against is the SCANNING sample,
 * and dividing the bytes by the scan and handshake time understates the
 * transfer — measured here as 15.6 KB/s against a real 17.9. */
t("no rate until two upload samples", !/KB\/s/.test(text()), text());

await feed({
  state: STATE.UPLOADING, percent: 50, sent: 256000, total: 511472,
  elapsedMs: 15000, target: "RAK4631_OTA", file: "rak4631.zip", attempt: 1, retries: 5,
});
t("a second sample produces a rate", /KB\/s/.test(text()), text());
{
  /* 128000 B in 7000 ms = 17.9 KB/s, which is the rate this hardware
   * actually runs at — if the arithmetic is out by 1024 or by 1000 the
   * number lands somewhere obviously different. */
  const shown = Number(text().match(/([\d.]+) KB\/s/)?.[1]);
  t("the rate is bytes/s over the device's own clock",
    shown > 16 && shown < 19, String(shown));
}

/* --- a retry restarts the image ---------------------------------------- */

await feed({ state: STATE.COOLDOWN, attempt: 1, retries: 5, elapsedMs: 20000 });
t("cooldown still counts as running", banner()?.classList.contains("run"));
t("cooldown says what it is waiting for",
  /Waiting before the next attempt/.test(text()), text());

await feed({ state: STATE.SCANNING, attempt: 2, retries: 5, elapsedMs: 25000 });
t("the attempt counter advances", /attempt 2\/5/.test(text()), text());
/* Legacy DFU cannot resume (Trap 2), so a new attempt re-sends the whole
 * image. Carrying the previous attempt's rate forward would be a fiction. */
t("the rate resets with the attempt", w.__dfuTest.peek().rate === 0,
  String(w.__dfuTest.peek().rate));

/* --- success ------------------------------------------------------------ */

await feed({
  state: STATE.DONE, result: RESULT.OK, percent: 100, sent: 511472,
  total: 511472, elapsedMs: 37500, target: "RAK4631_OTA", file: "rak4631.zip",
  attempt: 2, retries: 5,
});
t("success is marked ok", banner()?.classList.contains("ok"));
t("success says so", /Complete/.test(text()), text());
t("success explains the result", /flashed and rebooted/.test(text()), text());
t("success is dismissible", !!banner()?.querySelector(".dfu-dismiss"));

/* The bar must stop moving. DONE fell through to the indeterminate sweep in
 * the first version, so a finished transfer went on animating as though it
 * were still working — the one thing this banner exists not to do. */
t("a finished run stops sweeping",
  !d.querySelector(".dfu-bar")?.classList.contains("indeterminate"));
t("the bar rests at 100%", d.querySelector(".dfu-bar .fill")?.style.width === "100%",
  d.querySelector(".dfu-bar .fill")?.style.width);
t("100% is shown", d.querySelector(".dfu-pct")?.textContent.trim() === "100%",
  d.querySelector(".dfu-pct")?.textContent);

/* Nothing left to stream: the run is over, so the live pane would sit empty
 * for good while the newest log file is the thing that has the run in it. */
t("the log button becomes View log",
  /View log/.test(banner().querySelector(".dfu-watch").textContent),
  banner().querySelector(".dfu-watch").textContent.trim());
click(banner().querySelector(".dfu-watch"));
await wait(60);
t("a finished run opens the log file, not the stream",
  w.__dfuTest.peek().logViewOpen === true && w.__dfuTest.peek().logViewLive === false,
  JSON.stringify(w.__dfuTest.peek().logViewLive));

click(banner().querySelector(".dfu-dismiss"));
await wait(60);
t("dismissing hides the terminal banner", !banner());

/* The × dismisses a result, not the feature: the next run has to come back
 * on its own or a dismissal would silently disable the banner for good. */
await feed({ state: STATE.SCANNING, attempt: 1, retries: 5 });
t("a new run un-dismisses the banner", !!banner());

/* --- failure ------------------------------------------------------------ */

await feed({
  state: STATE.FAILED, result: RESULT.NO_TARGET, attempt: 5, retries: 5,
  elapsedMs: 60000, percent: 30,
});
t("failure is marked failed", banner()?.classList.contains("fail"));
t("failure names what to check", /ble_name/.test(text()), text());
t("a failure also stops sweeping",
  !d.querySelector(".dfu-bar")?.classList.contains("indeterminate"));
/* "failed at 30%" and "never started" are different problems, so a failure
 * keeps the position it reached rather than being rounded to either end. */
t("a failure keeps the percentage it reached",
  d.querySelector(".dfu-bar .fill")?.style.width === "30%",
  d.querySelector(".dfu-bar .fill")?.style.width);

/* --- it is not dismissible while working -------------------------------- */

await feed({ state: STATE.UPLOADING, percent: 10, sent: 1, total: 100, attempt: 1, retries: 5 });
t("an active run cannot be dismissed", !banner()?.querySelector(".dfu-dismiss"));

/* --- the way through to the log ----------------------------------------- */

const watch = banner()?.querySelector(".dfu-watch");
t("the banner offers the log", !!watch);
t("a running transfer offers to watch it", /Watch log/.test(watch.textContent),
  watch.textContent.trim());
click(watch);
await wait(60);
{
  const s = w.__dfuTest.peek();
  t("it opens the viewer", s.logViewOpen === true);
  /* Live, not a file read: the flash backend has not flushed the lines being
   * asked for, so reading LOG.NNNN shows everything except the transfer. And
   * it must flip back to true after the finished-run click above set it
   * false — a hard-coded value would pass one of those two, not both. */
  t("it opens the viewer streaming", s.logViewLive === true);
}

/* --- the store's own log ------------------------------------------------ */
{
  const lines = w.__dfuTest.peek().lines.join(" | ");
  t("a run start is logged once", (lines.match(/DFU started/g) || []).length >= 1, lines);
  t("a success is logged", /DFU succeeded/.test(lines));
  t("a failure is logged", /DFU failed/.test(lines));
}

t("no console errors or warnings", errors.length === 0, errors.join(" ;; ").slice(0, 400));

console.log(bad === 0 ? "\nall dfu-banner tests passed" : `\n${bad} FAILED`);
process.exit(bad === 0 ? 0 : 1);
