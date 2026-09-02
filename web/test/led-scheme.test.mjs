/*
 * The status LED means the same thing on every board. No dependencies:
 *
 *   node web/test/led-scheme.test.mjs
 *
 * ---- what this is defending -------------------------------------------
 *
 * `src/led.c` has three renderers — RGB, two-colour, and one LED — picked at
 * build time from the aliases a board overlay supplies. They are supposed to
 * agree: blue is the device waiting, green is the device working, and the only
 * state a fallback has to invent is DONE_FAIL, because red is the thing those
 * boards do not have.
 *
 * **Nothing enforces that agreement at build time and nothing at run time
 * either.** Every combination compiles, and every combination lights an LED,
 * so the failure is a device that is working correctly and saying so in a
 * vocabulary the person holding it does not know. The RAK4631 shipped exactly
 * that once: it used the single-LED renderer on its green pin, which was
 * unambiguous on its own and meant that the same firmware on two boards in
 * the same room said "idle" in two different colours.
 *
 * A header comment in led.c carries the three-column table this asserts. That
 * comment is the thing most likely to drift, which is why the assertions are
 * made against the code and not against it.
 */
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (p) => readFileSync(join(ROOT, p), "utf8");

/* Prose about an alias is not an alias. rak4631.overlay's header discusses
 * `red-led` and `status-led` at length while declaring neither, which is
 * exactly the false positive this strips. Same reason as ble-pairing and
 * dfu-loop. */
const codeOf = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "");

let bad = 0;
const t = (name, cond, extra = "") => {
  console.log(`${cond ? "  ok  " : "  FAIL"} ${name}${extra ? `  [${extra}]` : ""}`);
  if (!cond) bad++;
};

const led = codeOf(read("updater/src/led.c"));

/* --- every board declares a set led.c actually implements --------------- */

const OVERLAYS = "updater/boards";
const files = readdirSync(join(ROOT, OVERLAYS)).filter(n => n.endsWith(".overlay")).sort();

/** The aliases a board ends up with, following the one-line `#include` a
 *  variant overlay uses to inherit its base's. */
function aliasesOf(name, seen = new Set()) {
  if (seen.has(name)) return new Set();
  seen.add(name);
  const src = codeOf(read(`${OVERLAYS}/${name}`));
  const found = new Set();
  const block = /aliases\s*\{([\s\S]*?)\}/.exec(src);
  if (block) {
    for (const m of block[1].matchAll(/(red|green|blue|status)-led\s*=/g)) found.add(m[1]);
  }
  for (const m of src.matchAll(/#include\s+"([a-z0-9_]+\.overlay)"/g)) {
    for (const a of aliasesOf(m[1], seen)) found.add(a);
  }
  return found;
}

/* The three shapes, spelled the way led.c's #if gating spells them. A fourth
 * combination is not a smaller version of one of these — it is a board whose
 * LED renders as `default:`, i.e. dark. */
const SHAPES = {
  rgb: ["blue", "green", "red"],
  duo: ["blue", "green"],
  mono: ["status"],
};
const shapeOf = (set) => {
  const have = [...set].sort().join(",");
  for (const [name, cols] of Object.entries(SHAPES)) {
    if ([...cols].sort().join(",") === have) return name;
  }
  return null;
};

for (const f of files) {
  const set = aliasesOf(f);
  const shape = shapeOf(set);
  t(`${f}: declares a set led.c implements`, shape !== null,
    shape ?? `has {${[...set].sort().join(",") || "nothing"}}`);
}

/* And led.c really does gate on those three, so the table above cannot quietly
 * describe a version of the file that no longer exists. */
t("led.c selects on red+green+blue",
  /LED_HAVE_RGB \(DT_NODE_EXISTS\(DT_ALIAS\(red_led\)\)/.test(led) &&
  /DT_ALIAS\(green_led\)[\s\S]{0,80}DT_ALIAS\(blue_led\)/.test(led));
t("...on green+blue without a red", /LED_HAVE_DUO \(!LED_HAVE_RGB/.test(led));
t("...and refuses a board with none of them",
  /#error "This board supplies no LED aliases/.test(led));

/* --- the two-colour renderer says what the RGB one says ----------------- */

/*
 * The point of having a two-colour renderer at all rather than reusing the
 * mono one. Every state but DONE_FAIL must drive green and blue identically
 * to the RGB board, at the same rate — that is what lets a person read a
 * RAK4631 and a XIAO with one vocabulary.
 */
/* Anchored on the write helper's *definition*, not on the `#elif` above it:
 * `LED_HAVE_DUO` appears twice, once to declare the gpio_dt_specs and once to
 * open the renderer, and indexOf() finds the declarations. The helper name is
 * unique to its renderer. */
function renderer(helperDef) {
  const at = led.indexOf(helperDef);
  if (at < 0) return null;
  const body = led.slice(at);
  const end = body.indexOf("\n#e");        /* #elif / #else / #endif */
  return end < 0 ? body : body.slice(0, end);
}

/** state -> "<green>,<blue>@<ms>" for each `case`, from whichever write
 *  helper the renderer uses. Ignores the red argument, which is the whole
 *  reason the two differ at all. */
function columnOf(src, helper, redArg) {
  const out = {};
  const cases = src.split(/case (LED_STATE_[A-Z_]+):/).slice(1);
  for (let i = 0; i < cases.length; i += 2) {
    const state = cases[i];
    const body = cases[i + 1];
    const writes = [...body.matchAll(new RegExp(`${helper}\\(([^)]*)\\)`, "g"))]
      .map(m => {
        const args = m[1].split(",").map(a => a.trim());
        return (redArg ? args.slice(1) : args).join(",");
      });
    const rates = [...body.matchAll(/return\s+([^;]+);/g)].map(m => m[1].trim());
    out[state] = `${writes.join("|")}@${rates.join("|")}`;
  }
  return out;
}

const rgb = renderer("static void write_all");
const duo = renderer("static void write_gb");

t("both renderers were found", !!rgb && !!duo);

if (rgb && duo) {
  const a = columnOf(rgb, "write_all", true);
  const b = columnOf(duo, "write_gb", false);

  for (const state of ["LED_STATE_IDLE", "LED_STATE_SMP_ACTIVE",
                       "LED_STATE_DFU_RUNNING", "LED_STATE_DONE_OK"]) {
    t(`${state}: two-colour matches RGB on green/blue and rate`,
      a[state] !== undefined && a[state] === b[state],
      `rgb ${a[state]} vs duo ${b[state]}`);
  }

  /* The one that must differ, and must not borrow green: green already means
   * "this went well" in the two states either side of it. */
  t("DONE_FAIL is the only state that diverges",
    a.LED_STATE_DONE_FAIL !== b.LED_STATE_DONE_FAIL,
    `${a.LED_STATE_DONE_FAIL} vs ${b.LED_STATE_DONE_FAIL}`);
  t("...and it drives both LEDs, which no other state does",
    /write_gb\(on, on\)/.test(duo));
  t("...on the same double-flash pattern the mono board uses",
    /k_fail_pattern\[step % ARRAY_SIZE\(k_fail_pattern\)\]/.test(duo));
}

/* Blue is idle on every board that has a blue. Asserted separately from the
 * comparison above because it is the specific thing that was reported. */
if (duo) {
  const idle = /case LED_STATE_IDLE:\s*write_gb\(false, phase\);/.test(duo);
  t("standby blinks blue, not green", idle);
}

console.log(bad ? `\n${bad} FAILURES` : "\nall led-scheme checks passed");
process.exit(bad ? 1 : 0);
