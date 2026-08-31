/*
 * The scanner: signal bands, the SCAN wire format, and the rule that only one
 * radio surveys at a time.
 *
 *   node web/test/scanner.test.mjs
 *
 * Pairs that have to agree and are checked nowhere else:
 *
 *   1. The RSSI thresholds and the sentence that explains them. The bands are
 *      the operator-facing point of the screen, and a legend that has drifted
 *      from the meter is worse than no legend — it teaches the wrong number
 *      with full confidence.
 *   2. The keys fsx_scan() encodes and the keys ScannerDialog reads. A client
 *      reading a field the firmware never sends renders `undefined` forever,
 *      silently, on a screen whose whole job is to report facts.
 *   3. `enum survey_kind` / `SURVEY_F_*` and the client's copies. These cross
 *      the wire as bare integers, so a renumber is invisible until a WiFi tab
 *      starts scanning Bluetooth.
 *   4. The page size the firmware caps a response at and the one the client
 *      asks for. Asking for more is harmless; asking while *believing* the
 *      answer is complete is how a device goes missing from a list that looks
 *      finished.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { RSSI_BANDS, rssiBand, SURVEY_KIND, SURVEY_FLAG }
  from "../js/lib/smp-client.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (p) => readFileSync(join(ROOT, p), "utf8");

let bad = 0;
const t = (name, ok, extra = "") => {
  console.log(`${ok ? "  ok  " : "  FAIL"} ${name}${extra ? `  [${extra}]` : ""}`);
  if (!ok) bad++;
};

const dialog  = read("web/js/components/ScannerDialog.js");
const store   = read("web/js/store.js");
const client  = read("web/js/lib/smp-client.js");
const icons   = read("web/js/components/Icon.js");
const toolbar = read("web/js/components/FileToolbar.js");
const listing = read("web/js/components/FileListing.js");
const fsxC    = read("updater/src/fsx_mgmt.c");
const fsxH    = read("updater/src/fsx_mgmt.h");
const scanH   = read("updater/src/ble_scanner.h");
const scanC   = read("updater/src/ble_scanner.c");
const survH   = read("updater/src/survey.h");
const survC   = read("updater/src/survey.c");
const wifiC   = read("updater/src/wifi_survey.c");
const runnerC = read("updater/src/dfu_runner.c");

/* --- 1. the bands ------------------------------------------------------- */

t("three bands, weakest last",
  RSSI_BANDS.length === 3 && RSSI_BANDS[2].min === -Infinity,
  RSSI_BANDS.map((b) => `${b.id}>=${b.min}`).join(" "));

/* The numbers themselves, pinned. Chosen for a transfer that cannot resume,
 * not copied from a phone's bars, so a later "-80 is fine really" has to be a
 * deliberate edit here rather than a quiet slide. */
t("excellent starts at -70 dBm", RSSI_BANDS[0].min === -70, `${RSSI_BANDS[0].min}`);
t("good starts at -75 dBm",      RSSI_BANDS[1].min === -75, `${RSSI_BANDS[1].min}`);
t("bands are ordered strongest first",
  RSSI_BANDS.every((b, i) => i === 0 || b.min < RSSI_BANDS[i - 1].min));

for (const [dbm, want] of [
  [-30, "excellent"], [-70, "excellent"], [-70.5, "good"],
  [-71, "good"], [-75, "good"], [-75.1, "poor"], [-90, "poor"],
]) {
  t(`${dbm} dBm is ${want}`, rssiBand(dbm).id === want, rssiBand(dbm).id);
}

/* The trap this hit during development: Number(null) and Number("") are both
 * 0, which is finite and stronger than every threshold — so a device nobody
 * had heard from rendered as an excellent signal. */
for (const v of [null, undefined, "", NaN, "-50", {}]) {
  t(`${JSON.stringify(v) ?? String(v)} is not treated as a signal`,
    rssiBand(v).id === "poor", rssiBand(v).id);
}

/* Each band has its own glyph, not only its own colour. Colour alone excludes
 * anyone who cannot separate red from green, on the one screen whose entire
 * output is a judgement about quality, so bar count carries it independently. */
t("every band has a distinct icon",
  new Set(RSSI_BANDS.map((b) => b.icon)).size === RSSI_BANDS.length,
  RSSI_BANDS.map((b) => b.icon).join(","));
for (const b of RSSI_BANDS) {
  t(`Icon.js defines ${b.icon}`, new RegExp(`\\n  ${b.icon}:`).test(icons), b.icon);
}
t("more signal means more bars",
  RSSI_BANDS[0].icon === "signal_cellular_alt" &&
  RSSI_BANDS[1].icon === "signal_cellular_alt_2_bar" &&
  RSSI_BANDS[2].icon === "signal_cellular_alt_1_bar");

/* --- the legend quotes the same numbers -------------------------------- */

const legend = dialog.slice(dialog.indexOf("scan-legend"));
for (const b of RSSI_BANDS.filter((x) => Number.isFinite(x.min))) {
  /* The UI writes a real minus sign; the source of truth writes ASCII. */
  t(`the legend names ${b.min}`,
    legend.includes(String(Math.abs(b.min))), `looking for ${Math.abs(b.min)}`);
}
t("the legend names every band",
  RSSI_BANDS.every((b) => new RegExp(b.label, "i").test(legend)));

/* --- 2. the wire format ------------------------------------------------- */

const handler = fsxC.slice(fsxC.indexOf("static int fsx_scan("));
const emitted = new Set(
  [...handler.matchAll(/zcbor_tstr_put_lit\(zse,\s*"([a-z_]+)"\)/g)].map((m) => m[1]));

for (const k of ["kind", "kinds", "scanning", "total", "entries", "truncated",
                 "id", "name", "rssi", "best", "n", "ch", "fl"]) {
  t(`fsx_scan emits "${k}"`, emitted.has(k), [...emitted].join(","));
}
t("fsx_scan no longer emits the pre-WiFi key names",
  !emitted.has("addr") && !emitted.has("dfu"));

for (const k of ["id", "name", "rssi", "best", "n", "ch", "fl"]) {
  t(`ScannerDialog reads "${k}"`, new RegExp(`\\b(e|r)\\.${k}\\b`).test(dialog), k);
}
t("the store reads scanning/entries/kinds",
  /\.scanning\b/.test(store) && /\.entries\b/.test(store) && /\.kinds\b/.test(store));

/* The id is the firmware's own rendering and goes back untouched. A client
 * that reformatted it would be a second address format to keep in step, and
 * bt_addr_le_from_str() would reject the result. */
t("fsx_scan renders Bluetooth ids with bt_addr_le_to_str",
  /bt_addr_le_to_str/.test(survC));
t("the client sends the id back verbatim",
  /fsxTriggerDfu\(\s*[A-Za-z.]+\s*,\s*[A-Za-z.]+\s*\)/.test(store) &&
  !/\b(addr|id)\s*\.\s*(replace|toUpperCase|toLowerCase|split)/.test(dialog + store));

/* --- 3. two radios, one at a time --------------------------------------- */

t("survey.h declares both kinds",
  /SURVEY_BLE\s*=\s*1/.test(survH) && /SURVEY_WIFI\s*=\s*2/.test(survH));
t("the client agrees on the kind numbers",
  SURVEY_KIND.BLE === 1 && SURVEY_KIND.WIFI === 2);
t("the flag bits agree",
  /SURVEY_F_DFU\s+BIT\(0\)/.test(survH) && SURVEY_FLAG.DFU === 1 &&
  /SURVEY_F_SECURE\s+BIT\(1\)/.test(survH) && SURVEY_FLAG.SECURE === 2 &&
  /SURVEY_F_MATCH\s+BIT\(2\)/.test(survH) && SURVEY_FLAG.MATCH === 4);

/* "Would auto-flash have gone for this?" is answered on the device, because
 * both rules live there: ble_name's pipe-delimited grammar, and the AP name.
 * A client that reproduced either would be a drift pair nothing checks. */
t("the match flag is computed on the device",
  /SURVEY_F_MATCH/.test(survC) && /ble_scanner_name_matches/.test(survC));
t("the client never re-implements the name grammar",
  !/split\(\s*["'`]\|["'`]\s*\)/.test(dialog + store));
t("OTA_SSID has exactly one definition",
  /#define OTA_SSID/.test(read("updater/src/elegantota.h")) &&
  !/#define OTA_SSID/.test(read("updater/src/transport_wifi_elegantota.c")));

/* Switching kinds must stop the other radio. Both sweeping at once does not
 * fail — on the ESP32 parts it is one radio time-sliced, so each just makes
 * the other slower and less complete, which is close to unattributable. */
t("switching kinds stops the previous survey",
  /s_kind != SURVEY_NONE && s_kind != kind[\s\S]{0,120}survey_stop\(\)/.test(survC));
t("survey_active asks the radios rather than a variable",
  /ble_scanner_survey_active\(\)/.test(survC) && /wifi_survey_active\(\)/.test(survC));
t("the WiFi tab comes from what the device reports",
  /scanKinds/.test(dialog) && /survey_kinds_available/.test(survC));
t("a WiFi sweep re-issues so the list stays live",
  /NET_EVENT_WIFI_SCAN_DONE/.test(wifiC) && /start_sweep\(\)/.test(wifiC));
t("the WiFi survey is built only where there is a radio",
  /if\(CONFIG_WIFI\)[\s\S]{0,300}wifi_survey\.c/.test(read("updater/CMakeLists.txt")));

/* --- not during a DFU --------------------------------------------------- */

t("survey_start refuses while a run is in flight",
  /dfu_runner_busy\(\)[\s\S]{0,120}-EBUSY/.test(survC));
t("and the runner stops a survey that beat it to the radio",
  /survey_stop\(\)/.test(runnerC));
/* --- pacing and the manual controls ------------------------------------ */

/* Polling IS the keep-alive (survey.h), so the period must stay under the
 * firmware's idle timeout or the scan stops between refreshes. */
const pollMs = Number(/const SCAN_POLL_MS = (\d+)/.exec(store)?.[1]);
const bleIdle = Number(/#define SURVEY_IDLE_TIMEOUT_MS (\d+)/.exec(scanC)?.[1]);
t("the poll is paced for clicking, not just watching",
  pollMs >= 2000 && pollMs <= 3000, `${pollMs} ms`);
t("and stays under the firmware's idle timeout",
  pollMs < bleIdle, `poll=${pollMs} idle=${bleIdle}`);

t("auto-refresh can be turned off", /setScanAuto/.test(store) && /scanAuto/.test(dialog));
/* One press must produce results. The first poll only arms the survey, so
 * without a second the operator sees an empty table and presses again. */
t("a manual refresh polls twice",
  /export function refreshScan[\s\S]{0,900}pollScan\(\{ reset: true \}\)[\s\S]{0,200}setTimeout/.test(store));
t("the reset reaches the wire format",
  /"reset"/.test(fsxC) && /reset/.test(survH) &&
  /survey_start\(enum survey_kind kind, bool reset\)/.test(survC));
t("a page request never carries reset",
  /fsxScan\(true, kind, entries\.length, 12, false\)/.test(client));
t("both tabs' filters default to on",
  /bleTargetsOnly = ref\(true\)/.test(dialog) &&
  /wifiTargetsOnly = ref\(true\)/.test(dialog));
t("interesting rows sort above merely close ones",
  /b\.interesting - a\.interesting/.test(dialog));
t("matching rows are highlighted",
  /hit: r\.interesting/.test(dialog) && /\.scan-row\.hit/.test(read("web/css/config.css")));

/* --- no <td> may be turned into a flex or grid box -----------------------
 *
 * A table cell given `display: flex` stops being a table-cell. It no longer
 * stretches to the row's height and no longer takes the column's width, so it
 * draws its own bottom border higher than the rest of the row's and stopping
 * short of the next column — a hairline misalignment that reads as a
 * rendering glitch and that no functional test can see. It shipped on the
 * signal column, where the flex was on the <td> itself.
 *
 * The fix is always the same: put the flex on a wrapper *inside* the cell. So
 * the rule worth enforcing is structural — collect the classes this component
 * puts on a <td>, and require none of them to be given an inner display type.
 */
{
  const css = read("web/css/config.css");
  const cellClasses = new Set();
  for (const m of dialog.matchAll(/<td\b[^>]*\bclass="([^"{}]+)"/g)) {
    for (const c of m[1].split(/\s+/)) if (c) cellClasses.add(c);
  }
  t("the scanner table has classed cells to check", cellClasses.size > 0,
    [...cellClasses].join(","));

  const offenders = [...cellClasses].filter((c) => {
    /* The rule block for `.c`, ignoring rules where it is only an ancestor. */
    const re = new RegExp(`(^|[,}])\\s*[^{}]*\\.${c}\\s*\\{([^}]*)\\}`, "g");
    for (const m of css.matchAll(re)) {
      if (/display:\s*(flex|grid|inline-flex|inline-grid)/.test(m[2])) return true;
    }
    return false;
  });
  t("no class used on a <td> is given display:flex/grid",
    offenders.length === 0,
    `${offenders.join(",")} — put the flex on a wrapper inside the cell`);
}

t("the toolbar button is disabled during a run",
  /disabled="!connected \|\| dfuActive"/.test(toolbar));
t("the disabled button says why", /scanTitle/.test(toolbar));
t("an open panel closes when a run starts",
  /watch\(dfuActive[\s\S]{0,500}closeScanner\(\)/.test(store));
t("the scan button uses the radar icon", /name="radar"/.test(toolbar));
t("Icon.js defines radar", /\n  radar:/.test(icons));

/* --- the icon stacks are pure CSS -------------------------------------
 *
 * The obvious way to animate an icon is a timer that swaps its name. That
 * re-renders forever, for decoration, on a page that is often mid-DFU — and
 * keeps running whether or not anyone is looking. Every frame is rendered
 * instead and only opacity moves, which also means it stops dead under
 * prefers-reduced-motion rather than merely looking calmer.
 */
{
  const cyc = read("web/js/components/IconCycle.js");
  const css = read("web/css/base.css");
  t("IconCycle runs no timer",
    !/setInterval|setTimeout|requestAnimationFrame/.test(cyc));
  t("it renders every frame and animates opacity",
    /v-for/.test(cyc) && /opacity/.test(css));
  t("it rests on the complete glyph, not a partial one",
    /\.icon:last-child \{ opacity: 1/.test(css));
  t("reduced motion stops it", /prefers-reduced-motion[\s\S]{0,200}icon-cycle/.test(css));
  /* A keyframe percentage cannot come from a custom property, so each frame
     count needs its own set. Only two exist; anything else must render
     static rather than wrong. */
  for (const n of [2, 3]) {
    t(`a ${n}-frame cycle has keyframes`, new RegExp(`cycle-${n}[\\s\\S]{0,200}cyc${n}`).test(css));
  }
  const header = read("web/js/components/AppHeader.js");
  t("Connect and Disconnect carry opposite bluetooth glyphs",
    /name="bluetooth"[\s\S]{0,200}Connect/.test(header) &&
    /name="bluetooth_disabled"[\s\S]{0,200}Disconnect/.test(header));
  t("the connection indicator is a glyph, not a dot",
    /bluetooth_connected/.test(header) && !/class="dot"/.test(header));
  t("and it still pulses when connected",
    /header\.connected \.dot-icon[\s\S]{0,120}animation: pulse/.test(read("web/css/layout.css")));
}

/* --- every dialog closes the same three ways ---------------------------
 *
 * The scanner shipped with a footer Close and nothing else: no ✕ where the
 * other dialogs put one, and no Escape — which turned out to be true of all of
 * them. Checked across the whole set rather than on the one that was reported,
 * because fixing a consistency complaint on a single component is how the next
 * inconsistency gets made.
 */
{
  const DIALOGS = ["ConfigDialog", "FlashDialog", "LogViewer", "ScannerDialog"];
  for (const name of DIALOGS) {
    const src = read(`web/js/components/${name}.js`);
    t(`${name} has a ✕ in its header`,
      /cfg-head[\s\S]{0,600}✕/.test(src));
    t(`${name} closes on Escape`, /onEscape\(/.test(src));
    /* Through the component's own close, never by emitting past it: that is
     * where "discard unsaved changes?" and "not while a flash is running"
     * live, and a helper that bypassed them would be worse than no Escape. */
    /* `[^)]*` does not work here: the first argument is an arrow function and
     * contains its own parenthesis, so it never reaches the second. */
    t(`${name} routes Escape through its own close`,
      /onEscape\([^;]*?,\s*(?:\(\)\s*=>\s*)?(close\(\)|closeScanner|emit\()/.test(src),
      name);
  }
  const helper = read("web/js/lib/dialog.js");
  t("the Escape helper checks the dialog is open", /isOpen\(\)/.test(helper));
  t("and removes its listener again", /removeEventListener/.test(helper));
}

/* --- the file listing's icon actions ------------------------------------ */

for (const [icon, verb] of [["trash", "remove"], ["drive_file_rename", "rename"]]) {
  t(`Icon.js defines ${icon}`, new RegExp(`\\n  ${icon}:`).test(icons));
  t(`the listing uses ${icon} for ${verb}`,
    new RegExp(`name="${icon}"`).test(listing));
}
t("both are icon-only", (listing.match(/class="icon-only/g) ?? []).length >= 2);
/* An icon with no text needs a name for anything that is not a pair of eyes. */
t("icon-only actions carry an accessible name",
  (listing.match(/:aria-label="'(Rename|Delete) '/g) ?? []).length === 2);

/* --- 4. paging ---------------------------------------------------------- */

const cap = Number(/#define\s+FSX_SCAN_MAX_ENTRIES\s+(\d+)/.exec(fsxC)?.[1]);
/* Matched loosely on purpose: pinning the whole parameter list meant adding
 * `reset` silently turned this check into `NaN === 12`, which fails noisily —
 * but the same shape of edit could just as easily have made it vacuous. */
const asked = Number(/fsxScan\([^)]*\bcount = (\d+)/.exec(client)?.[1]);
t("firmware declares a per-response cap", Number.isFinite(cap), `${cap}`);
t("the client asks for exactly the cap", asked === cap, `client=${asked} firmware=${cap}`);
t("the client follows `truncated` rather than assuming one page",
  /fsxScanAll/.test(client) && /truncated/.test(client));

/* --- the survey cannot outlive the client ------------------------------- */

/* Both halves matter and they fail differently: without the firmware timeout
 * a closed tab leaves the radio scanning until reboot; without the client's
 * stop the panel closes and the scan runs on for the timeout. */
t("the BLE survey stops when nobody polls",
  /SURVEY_IDLE_TIMEOUT_MS/.test(scanC) && /k_work_reschedule/.test(scanC));
t("the WiFi survey stops when nobody polls",
  /SURVEY_IDLE_TIMEOUT_MS/.test(wifiC) && /k_work_reschedule/.test(wifiC));
t("closing the panel stops the poll timer",
  /clearInterval/.test(store) && /closeScanner/.test(store));
t("disconnecting stops it too", /disconnected[\s\S]{0,700}closeScanner\(\)/.test(store));
t("a DFU and a BLE survey cannot share the radio",
  /RADIO_SURVEY/.test(scanC) && /EBUSY/.test(scanH + scanC));

/* --- manual mode -------------------------------------------------------- */

t("TRIGGER_DFU accepts an optional addr", /"addr"/.test(fsxC));
t("the contract documents it", /addr:tstr\?/.test(fsxH));
t("a pinned run bypasses the name and signal filters",
  /pinned/i.test(scanH) && /min_rssi/.test(scanH));
/* An access point is not a DFU target: this updater reaches an ElegantOTA
 * peer by joining its AP, so there is no "flash that BSSID" to offer. */
t("only the Bluetooth tab offers a flash button", /v-if="isBle"[\s\S]{0,200}Flash/.test(dialog));

/* --- the pinned address actually round-trips ---------------------------
 *
 * The bug this section exists for: bt_addr_le_to_str() renders
 * "E9:52:9F:23:87:4A (random)" and bt_addr_le_from_str() does NOT parse that
 * — it takes the address and type as two arguments and rejects anything but
 * exactly 17 characters for the first. Handing it the rendered string failed
 * with -EINVAL, which surfaced as "the scanner could not start": a message
 * about the radio, for a string-handling mistake.
 *
 * It survived a test asserting both sides *named* bt_addr_le_to_str. That was
 * true and proved nothing, so this compiles the firmware's own splitter and
 * checks the two constants Zephyr actually enforces, read out of Zephyr.
 */
{
  const { execFileSync } = await import("node:child_process");
  const { mkdtempSync, existsSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");

  let cc = null;
  for (const c of ["cc", "gcc", "clang"]) {
    try { execFileSync(c, ["--version"], { stdio: "ignore" }); cc = c; break; } catch {}
  }
  const SRC = join(ROOT, "updater/src");
  const main = join(ROOT, "web/test/harness/pin-addr-main.c");
  if (!cc || !existsSync(join(SRC, "pin_addr.c"))) {
    console.log("  skip  no C compiler for the pin-address round trip");
  } else {
    const dir = mkdtempSync(join(tmpdir(), "pinaddr-"));
    execFileSync(cc, ["-O1", "-I", SRC, "-o", join(dir, "t"),
                      main, join(SRC, "pin_addr.c")]);
    const run = (lines) =>
      execFileSync(join(dir, "t"), { input: lines.join("\n") + "\n" })
        .toString().trim().split("\n");

    /* Zephyr is the authority on both halves, so both are read from it —
     * when it is there. `zephyr/` is a west sibling, not part of this repo, so
     * a plain checkout (which is what CI does for a node job) has none of it.
     *
     * The two halves degrade differently on purpose. The round trip below is
     * the half that catches Trap 10, it needs nothing but a C compiler, and it
     * runs either way. Only the cross-check *of the spellings themselves*
     * needs Zephyr, so that one is skipped and the list falls back to the four
     * we know — stated here as an assumption rather than as a fact. */
    let addrC = null;
    try { addrC = read("zephyr/subsys/bluetooth/host/addr.c"); } catch { /* no tree */ }

    const KNOWN = ["public", "random", "public-id", "random-id"];
    let accepted;
    if (addrC === null) {
      console.log("  skip  zephyr/ not checked out; address spellings not " +
                  "cross-checked (run after `west update`)");
      accepted = new Set(KNOWN);
    } else {
      accepted = new Set([...addrC.matchAll(/strcmp\(type,\s*"\(?([a-z-]+)\)?"\)/g)]
                         .map((m) => m[1]));
      t("Zephyr accepts the four address types we expect",
        KNOWN.every((x) => accepted.has(x)), [...accepted].join(","));
      t("Zephyr enforces a fixed address length",
        /len != BT_ADDR_STR_LEN - 1/.test(addrC));
    }

    /* Every form bt_addr_le_to_str() can emit. */
    const MAC = "E9:52:9F:23:87:4A";
    const rendered = [...accepted].map((ty) => `${MAC} (${ty})`);
    const got = run([...rendered, MAC, `${MAC} random`, "", "nonsense",
                     "E9:52:9F:23:87 (random)", `${MAC}`]);

    rendered.forEach((pin, i) => {
      const [mac, type] = (got[i] ?? "").split("|");
      t(`splits ${JSON.stringify(pin)}`, mac === MAC, got[i]);
      /* Passed through with brackets on purpose — bt_addr_le_from_str takes
       * either spelling, and stripping them here would be one more thing to
       * keep in step. */
      t(`  and Zephyr accepts its type ${type}`,
        accepted.has(String(type).replace(/[()]/g, "")), String(type));
      t(`  address is exactly 17 chars`, mac?.length === 17, String(mac?.length));
    });

    const n = rendered.length;
    t("a bare address defaults to random", got[n] === `${MAC}|random`, got[n]);
    t("a space-separated type works too", got[n + 1] === `${MAC}|random`, got[n + 1]);
    t("an empty pin is refused", got[n + 2] === "ERR", got[n + 2]);
    t("nonsense is refused", got[n + 3] === "ERR", got[n + 3]);
    t("a short address is refused", got[n + 4] === "ERR", got[n + 4]);

    /* The regression itself: the whole rendered string must never reach
     * bt_addr_le_from_str as its first argument. */
    const tb = read("updater/src/transport_ble.c");
    t("transport_ble splits before parsing",
      /pin_addr_split\(pin[\s\S]{0,200}bt_addr_le_from_str\(mac,\s*type/.test(tb));
    t("and never passes the raw pin to the parser",
      !/bt_addr_le_from_str\(\s*pin\b/.test(tb));
  }
}

/* --- the template actually renders -------------------------------------
 *
 * Everything above is grep, which proves both sides use the same words and
 * nothing about whether the screen works. A Vue template is compiled at
 * runtime, so a mistyped directive is not a syntax error here — it is a blank
 * panel and a console warning no source check can see.
 *
 * Rendered with fixture rows and a stubbed setup, because the real one needs
 * the store and a live connection. That still exercises the part most likely
 * to break: every binding name in the markup must exist on what setup()
 * returns, which is exactly the pair that drifts when a field is renamed. */
let JSDOM;
try {
  ({ JSDOM } = await import("jsdom"));
} catch {
  console.log("  skip  jsdom not installed (npm install --no-save jsdom)");
  console.log(bad ? `\n${bad} FAILURES` : "\nall scanner tests passed");
  process.exit(bad ? 1 : 0);
}

async function renderWith(over) {
  const dom = new JSDOM("<!doctype html><div id=app></div>", { pretendToBeVisual: true });
  /* defineProperty rather than assignment: modern node ships a real
   * globalThis.navigator with only a getter, so a plain assign throws. */
  for (const k of ["window", "document", "navigator", "HTMLElement", "SVGElement",
                   "Node", "Element", "MouseEvent", "requestAnimationFrame"]) {
    Object.defineProperty(globalThis, k, {
      configurable: true, writable: true, value: dom.window[k],
    });
  }
  const warnings = [];
  const realWarn = console.warn, realErr = console.error;
  console.warn = (...a) => warnings.push(a.join(" "));
  console.error = (...a) => warnings.push(a.join(" "));

  const Vue = await import("../js/vue.js");
  const Comp = (await import("../js/components/ScannerDialog.js")).default;

  const base = {
    scannerOpen: true, scanning: true, scanError: "", dfuActive: false,
    targetsOnly: false, picking: "", hidden: 0,
    closeScanner() {}, togglePick() {}, pick() {}, setScanKind() {},
    setScanAuto() {}, refreshScan() {}, scanAuto: true,
    fmtSize: (n) => `${n} B`, RSSI_BANDS, SURVEY_KIND,
    isBle: true, hasWifi: true, scanKind: SURVEY_KIND.BLE,
    candidates: [{ name: "fw.zip", full: "/lfs1/fw.zip", size: 100, info: null }],
    rows: [],
  };
  const app = Vue.createApp({ ...Comp, setup: () => ({ ...base, ...over }) });
  let err = null;
  try { app.mount(dom.window.document.getElementById("app")); }
  catch (e) { err = e; }
  console.warn = realWarn; console.error = realErr;
  return { html: dom.window.document.getElementById("app").innerHTML, warnings, err };
}

const bleRows = [
  { id: "E9:52:9F:23:87:4A (random)", name: "XIAO_DFU", label: "XIAO_DFU",
    rssi: -49, best: -47, n: 12, ch: 0, fl: 5, dfu: true, secure: false,
    match: true, interesting: true,
    band: "excellent", bandLabel: "Excellent", bandIcon: "signal_cellular_alt" },
  { id: "C1:02:03:04:05:06 (public)", name: "", label: "(unnamed)",
    rssi: -88, best: -85, n: 3, ch: 0, fl: 0, dfu: false, secure: false,
    match: false, interesting: false,
    band: "poor", bandLabel: "Poor", bandIcon: "signal_cellular_alt_1_bar" },
];

{
  const { html, warnings, err } = await renderWith({ rows: bleRows });
  t("the dialog compiles and mounts", !err, err?.message ?? "");
  t("no Vue warnings while rendering", warnings.length === 0, warnings[0] ?? "");
  t("one table row per device",
    (html.match(/class="scan-row/g) ?? []).length === 2,
    String((html.match(/class="scan-row/g) ?? []).length));
  t("the named device is shown", html.includes("XIAO_DFU"));
  t("an unnamed device still gets a label", html.includes("(unnamed)"));
  t("the DFU badge renders only for the DFU advertiser",
    (html.match(/scan-badge/g) ?? []).length === 1);
  t("signal is printed in dBm", html.includes("-49") && html.includes("-88"));
  t("the band reaches the row class",
    /scan-row[^"]*excellent/.test(html) && /scan-row[^"]*poor/.test(html));
  t("a signal glyph is drawn per row", (html.match(/<svg/g) ?? []).length >= 2);
  t("the Bluetooth address is shown", html.includes("E9:52:9F:23:87:4A"));
  t("both tabs are offered when the device has WiFi",
    html.includes("Bluetooth") && html.includes("WiFi"));
  /* Each tab carries its radio's glyph, and only the *selected* tab's may
     animate — two playing at once would claim both radios were surveying,
     which is the one thing this device cannot do. */
  t("each tab has an icon stack",
    (html.match(/icon-cycle/g) ?? []).length === 2,
    String((html.match(/icon-cycle/g) ?? []).length));
  t("the scanning Bluetooth tab animates",
    /icon-cycle[^"]*cycle-2[^"]*playing/.test(html), "");
  t("the idle WiFi tab does not",
    !/icon-cycle[^"]*cycle-3[^"]*playing/.test(html), "");
  t("the Bluetooth tab offers a flash button", html.includes("Flash"));
}

{
  /* The WiFi tab: different columns, and no flash button anywhere. */
  const wifiRows = [{
    id: "AA:BB:CC:DD:EE:FF", name: "MeshCore-OTA", label: "MeshCore-OTA",
    rssi: -61, best: -58, n: 4, ch: 6, fl: 6, dfu: false, secure: true,
    match: true, interesting: true,
    band: "excellent", bandLabel: "Excellent", bandIcon: "signal_cellular_alt",
  }];
  const { html, warnings, err } = await renderWith({
    rows: wifiRows, isBle: false, scanKind: SURVEY_KIND.WIFI,
  });
  t("the WiFi tab compiles and mounts", !err, err?.message ?? "");
  t("no Vue warnings on the WiFi tab", warnings.length === 0, warnings[0] ?? "");
  t("the SSID is shown", html.includes("MeshCore-OTA"));
  t("the channel is shown instead of an address", html.includes("ch 6"));
  t("no BSSID column on the WiFi tab", !html.includes("AA:BB:CC:DD:EE:FF"));
  t("an access point offers no flash button", !html.includes("Flash"));
  t("on the WiFi tab it is the WiFi icon that animates",
    /icon-cycle[^"]*cycle-3[^"]*playing/.test(html) &&
    !/icon-cycle[^"]*cycle-2[^"]*playing/.test(html), "");
  t("the WiFi filter names the ElegantOTA network",
    html.includes("MeshCore-OTA"));
}

{
  /* A board with no WiFi radio must not be offered a tab that cannot work. */
  const { html } = await renderWith({ rows: bleRows, hasWifi: false });
  t("no WiFi tab where the device has no WiFi radio",
    !/role="tab"[^>]*>\s*WiFi/.test(html));
}

/* Runs after the render section on purpose. Vue's runtime-dom resolves
 * `document` when it is first imported, so importing it before jsdom has
 * installed the globals leaves it holding null and every later mount fails
 * with "Cannot read properties of null". */
/* --- the file row's four actions render as asked ------------------------
 *
 * flash and check keep their words and gain a glyph; rename and delete are
 * glyph-only. Rendered rather than grepped, because "keep the label" is a
 * claim about what reaches the screen — a source check would pass just as
 * happily on a label the template had stopped emitting.
 */
{
  const dom = new JSDOM("<!doctype html><div id=app></div>", { pretendToBeVisual: true });
  for (const k of ["window", "document", "navigator", "HTMLElement", "SVGElement",
                   "Node", "Element", "MouseEvent", "requestAnimationFrame"]) {
    Object.defineProperty(globalThis, k, {
      configurable: true, writable: true, value: dom.window[k],
    });
  }
  const Vue = await import("../js/vue.js");
  const store = await import("../js/store.js");
  const fw = await import("../js/lib/firmware-image.js");
  const FileListing = (await import("../js/components/FileListing.js")).default;

  /* The listing renders an empty-state row unless it believes there is a
   * device, so all three have to be set or nothing below exists to inspect. */
  store.connected.value = true;
  store.listError.value = "";
  store.path.value = "/lfs1";
  store.deviceTransports.value = [fw.TRANSPORT.BLE];
  store.entries.value = [{ name: "repeater.zip", size: 1024, type: 0 }];

  const app = Vue.createApp(FileListing);
  app.mount(dom.window.document.getElementById("app"));
  const html = dom.window.document.getElementById("app").innerHTML;
  const btns = [...dom.window.document.querySelectorAll("td.actions button")];
  const byText = (re) => btns.find((b) => re.test(b.textContent));

  t("the row offers all four actions", btns.length === 4, String(btns.length));

  for (const [label, icon] of [["flash", "bolt_boost"], ["check", "search_check_2"]]) {
    const b = byText(new RegExp(`^\\s*${label}\\s*$`));
    t(`${label} keeps its label`, !!b, btns.map((x) => x.textContent.trim()).join("|"));
    t(`${label} also carries an icon`, !!b?.querySelector("svg"));
    t(`${label} uses ${icon}`,
      new RegExp(icon === "bolt_boost" ? "m520-120" : "M570-390").test(b?.innerHTML ?? ""),
      icon);
  }

  /* The other two are the opposite call and must stay wordless — a label
     there would undo the icon-only decision without anything noticing. */
  const wordless = btns.filter((b) => b.textContent.trim() === "");
  t("rename and delete stay icon-only", wordless.length === 2, String(wordless.length));
  t("...and still carry accessible names",
    wordless.every((b) => /^(Rename|Delete) /.test(b.getAttribute("aria-label") ?? "")),
    wordless.map((b) => b.getAttribute("aria-label")).join("|"));

  t("every action button has exactly one glyph",
    btns.every((b) => b.querySelectorAll("svg").length === 1));

  store.entries.value = [];
  store.connected.value = false;
}

/* --- the two tabs' filters are independent ------------------------------
 *
 * They ask different questions — "hide anonymous beacons" and "show only the
 * ElegantOTA access point" — and shipped sharing one ref, so unticking on one
 * tab silently unticked the other and a tab came back filtered differently
 * from how it was left.
 *
 * Driven through the component's real setup() rather than by reading the
 * source: the binding the template uses is a writable computed that proxies to
 * whichever tab is showing, and only exercising it proves the proxy sends
 * writes to the right ref. Vue's ref/computed work outside a mounted
 * component, so no DOM is needed for this part.
 */
{
  const Vue = await import("../js/vue.js");
  const store = await import("../js/store.js");
  const Comp = (await import("../js/components/ScannerDialog.js")).default;

  store.scanKind.value = SURVEY_KIND.BLE;
  const api = Comp.setup();

  t("the shared binding starts on for Bluetooth", api.targetsOnly.value === true);
  api.targetsOnly.value = false;
  t("unticking on the Bluetooth tab takes effect",
    api.bleTargetsOnly.value === false);
  t("...and leaves the WiFi setting alone",
    api.wifiTargetsOnly.value === true, String(api.wifiTargetsOnly.value));

  store.scanKind.value = SURVEY_KIND.WIFI;
  t("switching to WiFi shows the WiFi setting, still on",
    api.targetsOnly.value === true, String(api.targetsOnly.value));
  api.targetsOnly.value = false;
  t("unticking on the WiFi tab takes effect",
    api.wifiTargetsOnly.value === false);
  t("...and does not resurrect or clobber the Bluetooth one",
    api.bleTargetsOnly.value === false);

  api.bleTargetsOnly.value = true;
  store.scanKind.value = SURVEY_KIND.BLE;
  t("each tab keeps what it was left at",
    api.targetsOnly.value === true && api.wifiTargetsOnly.value === false);

  store.scanKind.value = SURVEY_KIND.BLE;
  Vue.nextTick?.();
}

/* --- Refresh actually refreshes ----------------------------------------
 *
 * The bug: pressing Refresh left the previous rows on screen for a second or
 * two and then replaced them with the device's *accumulated* table — which
 * keeps everything heard since the survey began, none of it ageing out, each
 * row showing the signal it had when it was last heard. Pressing twice quickly
 * was worse: the first press's settle timer landed after the second had
 * cleared the table and refilled it with the earlier sweep.
 *
 * None of that is visible to a source grep, so this drives the real store
 * against a fake device and watches what goes out on the wire.
 */
{
  const store = await import("../js/store.js");
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const calls = [];
  const stale = [{ id: "OLD", name: "gone", rssi: -95, best: -60, n: 40, ch: 0, fl: 0 }];
  store.smp.fsxScanAll = async (on, kind, reset) => {
    calls.push({ on, kind, reset });
    await sleep(30);
    return {
      kind, kinds: 1, scanning: true, total: 1, truncated: false,
      entries: [{ id: "NEW", name: "here", rssi: -50, best: -50, n: 1, ch: 0, fl: 0 }],
    };
  };
  store.connected.value = true;
  store.scannerOpen.value = true;
  store.scanEntries.value = stale;

  store.refreshScan();
  /* Synchronously, before any await: the press has to change the screen at
   * once or it reads as having done nothing. */
  t("Refresh empties the table immediately",
    store.scanEntries.value.length === 0, String(store.scanEntries.value.length));
  t("Refresh says it is working", store.scanRefreshing.value === true);

  await sleep(60);
  t("the first request tells the device to reset",
    calls[0]?.reset === true, JSON.stringify(calls[0]));

  await sleep(1700);
  t("the settle poll does not reset again",
    calls[1]?.reset === false, JSON.stringify(calls[1]));
  t("Refresh reports finished", store.scanRefreshing.value === false);
  t("the table holds only what the new sweep found",
    store.scanEntries.value.length === 1 && store.scanEntries.value[0].id === "NEW",
    JSON.stringify(store.scanEntries.value.map((e) => e.id)));

  /* Two presses, the second while the first's settle poll is still pending.
   *
   * The gap matters. Twenty milliseconds apart, a stale timer and a cancelled
   * one produce the *same* sequence of requests — the second settle poll is
   * dropped as a duplicate either way — so the bug hides. Spacing the presses
   * past the settle delay is what makes the uncancelled timer observable: it
   * fires on its own, and its completion clears `scanRefreshing` while the
   * second sweep is still running, re-enabling the button mid-scan. */
  calls.length = 0;
  store.refreshScan();
  await sleep(1200);
  store.refreshScan();
  t("a second press empties the table again",
    store.scanEntries.value.length === 0, String(store.scanEntries.value.length));

  await sleep(800);   /* past when the *first* press's settle would have fired */
  t("the first press's settle poll was cancelled",
    calls.filter((c) => c.reset === false).length === 0, JSON.stringify(calls));
  t("and Refresh is still reported as running",
    store.scanRefreshing.value === true, String(store.scanRefreshing.value));

  await sleep(1200);  /* past the second press's settle */
  t("both resets reached the device, neither dropped",
    calls.filter((c) => c.reset === true).length === 2, JSON.stringify(calls));
  t("exactly one settle poll ran",
    calls.filter((c) => c.reset === false).length === 1, JSON.stringify(calls));
  t("Refresh reports finished once, at the end",
    store.scanRefreshing.value === false);

  store.closeScanner();
  store.connected.value = false;
}

console.log(bad ? `\n${bad} FAILURES` : "\nall scanner tests passed");
process.exit(bad ? 1 : 0);
