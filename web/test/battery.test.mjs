/*
 * Battery monitoring: the pairs that have to agree, and the one number that
 * nothing can check.
 * No dependencies — run with:  node web/test/battery.test.mjs
 *
 * Three separate drift risks, and none of them fails loudly on its own:
 *
 *  1. `enum battery_source` travels as a bare int, so a renumber shows up as
 *     a device reporting the wrong *kind* of measurement — a plausible number
 *     with the wrong caveat attached to it.
 *  2. A board that declares battery hardware in its overlay but never asks
 *     for the driver in its .conf builds clean and reports -ENODEV at run
 *     time, which reads as broken hardware.
 *  3. The divider ratios are the one part of this feature that no test can
 *     verify — they are physical resistors. What *can* be checked is that
 *     each board states one, in devicetree, where a correction is a one-line
 *     edit; the failure this prevents is a ratio migrating into C as a
 *     constant, which is how it stops being correctable.
 */
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { BATTERY_SOURCE, FSX_ID } from "../js/lib/smp-client.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (p) => readFileSync(join(ROOT, p), "utf8");

/* Comments here explain what the code deliberately does *not* do, so a naive
 * grep finds the prose and passes over a regression. Same precedent as
 * dfu-loop and ble-pairing. */
const codeOf = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "");

let bad = 0;
const t = (name, cond, extra = "") => {
  console.log(`${cond ? "  ok  " : "  FAIL"} ${name}${cond ? "" : "  " + extra}`);
  if (!cond) bad++;
};

const batteryH = read("updater/src/battery.h");
const batteryC = read("updater/src/battery.c");
const fsxH     = read("updater/src/fsx_mgmt.h");
const fsxC     = read("updater/src/fsx_mgmt.c");

/* --- 1. enum battery_source <-> the client's copy ------------------------ */

const fw = {};
for (const m of batteryH.matchAll(/BATTERY_SOURCE_([A-Z]+)\s*=\s*(\d+)/g)) {
  fw[m[1]] = Number(m[2]);
}
t("firmware declares the three sources",
  Object.keys(fw).length === 3, JSON.stringify(fw));
t("the client's BATTERY_SOURCE matches it exactly",
  JSON.stringify(fw) === JSON.stringify(BATTERY_SOURCE),
  `firmware=${JSON.stringify(fw)} client=${JSON.stringify(BATTERY_SOURCE)}`);
/* Zero has to stay zero specifically: it is the value the client tests for
 * truthiness to decide whether to render the indicator at all. */
t("NONE is 0, which is what the client tests for", fw.NONE === 0);

/* --- 2. the wire keys the handler writes <-> the keys the client reads ---- */

const handler = fsxC.slice(fsxC.indexOf("static int fsx_battery"));
const emitted = new Set(
  [...codeOf(handler).matchAll(/zcbor_tstr_put_lit\(zse,\s*"(\w+)"\)/g)].map((m) => m[1]));

for (const key of ["src", "mv", "pct", "chg", "ext"]) {
  t(`the handler emits "${key}"`, emitted.has(key));
}

const gauge = read("web/js/components/BatteryGauge.js");
const store = read("web/js/store.js");
const consumed = new Set(
  [...(gauge + store).matchAll(/\bv\.(\w+)|\bb\.(\w+)|battery\.value\?\.(\w+)|b\.value\?\.(\w+)/g)]
    .flatMap((m) => m.slice(1).filter(Boolean)));
for (const key of ["mv", "pct", "chg", "ext", "src"]) {
  t(`the client reads "${key}"`, consumed.has(key), `saw ${[...consumed]}`);
}

/* --- 3. "unknown" must survive all the way to the screen ----------------- */

/*
 * The property this whole feature turns on. A resistor divider sees a voltage
 * and nothing else: a full cell on USB reads exactly like a full cell running
 * itself flat. So `chg`/`ext` are *omitted* rather than sent false, and the
 * client must test for undefined rather than falsiness — `if (v.chg)` would
 * render "not charging" for a board that has no idea, which is the one
 * statement an operator would act on.
 */
t("the firmware omits chg/ext rather than sending false",
  /if \(ok && st\.charging_known\)/.test(codeOf(handler)) &&
  /if \(ok && st\.external_power_known\)/.test(codeOf(handler)));
t("...and battery.h keeps a *_known flag for each",
  /bool charging_known;/.test(batteryH) && /bool external_power_known;/.test(batteryH));
t("the gauge distinguishes undefined from false",
  /v\.chg !== undefined/.test(codeOf(gauge)) && /v\.ext !== undefined/.test(codeOf(gauge)));
/* A bolt drawn from a value the device never sent is an invented fact. */
t("the charging bolt renders only on a device that answered",
  /const charging = computed\(\(\) => b\.value\?\.chg\);/.test(codeOf(gauge)));

/* --- 4. -ENOTSUP is an answer, not an error ----------------------------- */

t("no battery hardware comes back as a successful response",
  /rc == -ENOTSUP/.test(codeOf(handler)) &&
  /BATTERY_SOURCE_NONE/.test(codeOf(handler)));
/* And any *other* failure must not be flattened into it: a broken sensor and
 * an absent one would otherwise be indistinguishable from outside. */
t("...while any other failure is reported as one",
  /smp_add_cmd_err\(zse, FSX_MGMT_GROUP_ID/.test(codeOf(handler)));

/* --- 5. each board that declares the hardware also enables the driver ---- */

const boardsDir = join(ROOT, "updater/boards");
const overlays = readdirSync(boardsDir).filter((f) => f.endsWith(".overlay"));

/* Follow #include, so a variant that inherits its overlay is judged on what
 * it actually gets rather than on its own two lines. */
const overlayText = (name, depth = 0) => {
  let src = read(`updater/boards/${name}`);
  if (depth > 3) return src;
  for (const m of src.matchAll(/^#include\s+"([\w./-]+\.overlay)"/gm)) {
    const inc = m[1].replace(/^\.\.\//, "");
    if (overlays.includes(inc)) src += overlayText(inc, depth + 1);
  }
  return src;
};

let declaring = 0;
for (const ov of overlays) {
  const dts = codeOf(overlayText(ov));
  if (!/compatible\s*=\s*"voltage-divider"/.test(dts)) continue;
  declaring++;
  const board = ov.replace(/\.overlay$/, "");

  t(`${board}: the divider node is reachable through the battery-voltage alias`,
    /battery-voltage\s*=\s*&\w+/.test(dts));
  /* The ratio lives here or it lives nowhere correctable. */
  t(`${board}: states output-ohms and full-ohms`,
    /output-ohms\s*=\s*<\s*\d+\s*>/.test(dts) && /full-ohms\s*=\s*<\s*\d+\s*>/.test(dts));
  /* Megohm dividers cannot charge the SAADC's sampling capacitor in the 10 us
     default, and the failure is a low reading with nothing to say why. */
  t(`${board}: overrides the default ADC acquisition time`,
    /acquisition-time\s*=\s*<\s*ADC_ACQ_TIME\(/.test(dts));

  const confName = `${board}.conf`;
  const conf = readdirSync(boardsDir).includes(confName)
    ? codeOf(read(`updater/boards/${confName}`)) : "";
  t(`${board}: asks for CONFIG_SENSOR, or the driver is never built`,
    /^CONFIG_SENSOR=y$/m.test(conf), `in ${confName}`);
}
t("at least two boards declare a divider", declaring >= 2, `found ${declaring}`);

/* The PMIC board is the other shape, and its .conf carries the whole chain. */
const pmicConf = codeOf(read("updater/boards/xiao_nrf54lm20a_nrf54lm20a_cpuapp.conf"));
for (const sym of ["CONFIG_SENSOR", "CONFIG_I2C", "CONFIG_I2C_GPIO",
                   "CONFIG_MFD", "CONFIG_NPM13XX_CHARGER"]) {
  t(`nRF54LM20A: ${sym}=y`, new RegExp(`^${sym}=y$`, "m").test(pmicConf));
}
/*
 * And the regulator subsystem, which the first version of this file asserted
 * must stay *off* — exactly backwards, and worth an assertion in the other
 * direction so it cannot swing back.
 *
 * The board declares `power_en`, a `regulator-fixed` on P1.12 marked
 * `regulator-boot-on`, gating the rail its I2C peripherals sit on. Without
 * CONFIG_REGULATOR the fixed-regulator driver is not built, nothing drives
 * P1.12, and the rail stays down: on hardware the charger came back
 * "not ready" (-ENODEV) and the IMU logged "Failed to initialize chip" — two
 * devices on two different buses, which is the shape of a power fault, not a
 * bus one.
 *
 * It had been left out because enabling it breaks the link with
 * `'__device_dts_ord_164' undeclared`. That is an upstream defect, not a
 * reason to avoid the symbol: NRF_USBHS_WRAPPER is `default y` on
 * DT_HAS_NORDIC_NRF_USBHS_WRAPPER_ENABLED && REGULATOR and hard-references a
 * VREGUSB node that ships `status = "disabled"`. This board uses no USB, so
 * the wrapper is what gets turned off.
 */
for (const sym of ["CONFIG_REGULATOR", "CONFIG_REGULATOR_FIXED"]) {
  t(`nRF54LM20A: ${sym}=y, so power_en is actually driven`,
    new RegExp(`^${sym}=y$`, "m").test(pmicConf));
}
t("nRF54LM20A: the USB HS wrapper is disabled instead",
  /^CONFIG_NRF_USBHS_WRAPPER=n$/m.test(pmicConf));
/* The board file has to keep declaring it, or there is nothing to enable. */
t("...and the board still declares power_en as boot-on",
  /regulator-boot-on/.test(
    read("updater/boards/seeed/xiao_nrf54lm20a/nrf54lm20a_cpuapp_common.dtsi")));

/* --- 5b. the nRF54LM20A's PMIC pins are overridden, not inherited -------- */

/*
 * The vendored board file bit-bangs the PMIC bus on P1.15/P1.16; upstream
 * Zephyr's own copy of this board says P1.18 (SDA) / P1.17 (SCL), and the
 * charger NAKs on the vendored pair — `charger is not ready`, on hardware.
 *
 * No pin-conflict check could have found it: P1.15/P1.16 are used by nothing
 * else here, so the bus simply talked to two idle GPIOs. What *is* checkable
 * is that the correction lives in the overlay rather than the board file, so
 * that refreshing the vendored directory cannot silently undo it — the same
 * rule Trap 1b established for the LED polarity, and the reason that one has
 * survived.
 */
{
  const ov = codeOf(read("updater/boards/xiao_nrf54lm20a_nrf54lm20a_cpuapp.overlay"));
  const pmic = ov.slice(ov.indexOf("&pmic_i2c"));
  t("nRF54LM20A: the overlay overrides &pmic_i2c", ov.includes("&pmic_i2c"));
  t("...with SDA on P1.18", /sda-gpios\s*=\s*<&gpio1 18/.test(pmic), pmic.slice(0, 160));
  t("...and SCL on P1.17", /scl-gpios\s*=\s*<&gpio1 17/.test(pmic), pmic.slice(0, 160));
  /* If the vendored file is ever refreshed to upstream's values the override
     becomes a no-op rather than a mistake, so this only asserts that the
     override exists — not that the board file still disagrees. */
}

/* --- 5c. the charge-current control ------------------------------------- */

/*
 * Two states, not a milliamp figure, because HICHG is a pin with two
 * positions. And the *off* state has to be GPIO_DISCONNECTED rather than an
 * inactive output: the BQ25100 samples that input against a resistor, so
 * driving it inactive and releasing it are different things — the wrong one
 * would leave the charger at whatever driving it inactive happens to select,
 * which is not the documented default and would never announce itself.
 */
{
  const bat = codeOf(batteryC);
  t("the board declares charge-high-gpios, the code does not name a pin",
    /charge_high_gpios/.test(bat) && !/gpio0 13|GPIO_DT_SPEC_GET\(DT_NODELABEL/.test(bat));
  t("asserting the pin selects the higher current",
    /gpio_pin_configure_dt\(&s_charge_high, GPIO_OUTPUT_ACTIVE\)/.test(bat));
  t("...and the low setting releases the pin rather than driving it",
    /gpio_pin_configure_dt\(&s_charge_high, GPIO_DISCONNECTED\)/.test(bat));
  t("a board without the property reports -ENOTSUP",
    /return -ENOTSUP;/.test(bat) && /battery_charge_current_selectable/.test(bat));

  const ov = codeOf(read("updater/boards/xiao_ble.overlay"));
  t("the XIAO declares HICHG on P0.13, active low",
    /charge-high-gpios\s*=\s*<&gpio0 13 GPIO_ACTIVE_LOW>/.test(ov));
  /* Independent of the divider: a board could offer the pin and no way to
     measure, or the reverse (the RAK does). */
  t("...and no other board overlay claims one",
    ["rak4631.overlay", "xiao_mg24.overlay",
     "xiao_nrf54lm20a_nrf54lm20a_cpuapp.overlay"].every(
      (f) => !/charge-high-gpios/.test(codeOf(read(`updater/boards/${f}`)))));

  /* Applied from config, and before the first reading is taken. */
  const mainC = codeOf(read("updater/src/main.c"));
  t("main() applies it from config.txt",
    /battery_charge_current_apply\(cfg->fast_charge\)/.test(mainC));
  t("...before the battery is first read",
    mainC.indexOf("battery_charge_current_apply") < mainC.indexOf('battery_log_state("boot")'));
  /* The default is the status quo: nothing drove HICHG before this existed,
     so the XIAO has always charged at 50 mA. Flipping the default would
     change hardware behaviour on every deployed device as a side effect. */
  t("fast_charge defaults off in the firmware",
    /c->fast_charge\s*=\s*false;/.test(codeOf(read("updater/src/config.c"))));
  t("...and in the client schema",
    /key: "fast_charge"[\s\S]{0,300}?def: false/.test(read("web/js/lib/config-file.js")));
}

/* --- 6. the ratio must not migrate into C ------------------------------- */

/*
 * The single most important property here. Zephyr's voltage-divider driver
 * applies full-ohms/output-ohms itself, so battery.c never sees a ratio — and
 * must not acquire one. A multiplier copied into C is a number that can only
 * be corrected by a firmware change, on a board whose reading disagrees with
 * a multimeter, which is precisely the situation this feature has to survive.
 */
const code = codeOf(batteryC);
t("battery.c contains no divider ratio or resistor value",
  !/\b(15100|1510000|510000|1711000|\d\.\d+f)\b/i.test(code) &&
  !/output_ohms|full_ohms|DT_PROP\([^)]*ohms/.test(code));
/* It reads a scaled voltage, which is the whole reason it needs no ratio. */
t("...because the driver reports the terminal voltage already scaled",
  /SENSOR_CHAN_VOLTAGE/.test(code));

/* --- 7. the percentage curve, compiled and run -------------------------- */

const curveC = read("updater/src/battery_curve.c");
const curve = [...curveC.matchAll(/\{\s*(\d{4}),\s*(\d{1,3})\s*\}/g)]
  .map((m) => [Number(m[1]), Number(m[2])]);
t("the LiPo curve has entries", curve.length >= 10, `${curve.length}`);
t("...and descends in both voltage and percentage, so the search terminates",
  curve.every(([mv, pct], i) =>
    i === 0 || (mv < curve[i - 1][0] && pct < curve[i - 1][1])));
t("...spanning a full cell down to empty",
  curve[0][1] === 100 && curve[curve.length - 1][1] === 0);

/* The table being well-formed says nothing about the arithmetic over it, and
 * the arithmetic is the part with a rounding term and a division in it. So the
 * real file is compiled on the host and asked — battery_curve.c includes no
 * Zephyr headers precisely so this can happen (Trap 10's lesson). */
{
  const { execFileSync } = await import("node:child_process");
  const { mkdtempSync, writeFileSync, existsSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const SRC = join(ROOT, "updater/src");

  let cc = null;
  for (const c of ["cc", "gcc", "clang"]) {
    try { execFileSync(c, ["--version"], { stdio: "ignore" }); cc = c; break; } catch {}
  }

  if (!cc || !existsSync(join(SRC, "battery_curve.c"))) {
    console.log("  skip  no host C compiler for the curve");
  } else {
    const dir = mkdtempSync(join(tmpdir(), "battcurve-"));
    const main = join(dir, "main.c");
    writeFileSync(main, `
      #include <stdio.h>
      #include "battery.h"
      int main(void) {
        for (int mv = 0; mv <= 5000; mv += 1) printf("%d %u\\n", mv, battery_percent_from_mv((unsigned short)mv));
        return 0;
      }
    `);
    execFileSync(cc, ["-O1", "-I", SRC, "-o", join(dir, "t"),
                      main, join(SRC, "battery_curve.c")]);
    const out = execFileSync(join(dir, "t"), { encoding: "utf8" });
    const pct = new Map();
    for (const line of out.trim().split("\n")) {
      const [mv, p] = line.split(" ").map(Number);
      pct.set(mv, p);
    }

    /* Every table point must return exactly its own percentage. An
       interpolation that is one entry out still looks monotonic and still
       spans 0-100 — this is the assertion that would catch it. */
    let exact = true, off = "";
    for (const [mv, want] of curve) {
      if (pct.get(mv) !== want) { exact = false; off = `${mv} mV -> ${pct.get(mv)}, want ${want}`; break; }
    }
    t("every table point returns its own percentage", exact, off);

    /* Never decreases as the cell fills. */
    let mono = true, where = "";
    for (let mv = 1; mv <= 5000; mv++) {
      if (pct.get(mv) < pct.get(mv - 1)) { mono = false; where = `${mv} mV`; break; }
    }
    t("the curve never falls as voltage rises", mono, where);

    /* Both ends clamp rather than wrapping or overflowing — mv is a uint16_t
       and pct a uint8_t, so an unclamped subtraction would come back huge. */
    t("above a full cell reads 100", pct.get(4200) === 100 && pct.get(5000) === 100);
    t("below the last entry reads 0", pct.get(3270) === 0 && pct.get(0) === 0);
    t("nothing ever exceeds 100", [...pct.values()].every((v) => v >= 0 && v <= 100));

    /* Interpolation actually happens: between two table points the answer has
       to be strictly between them, or the curve is a staircase and a slowly
       draining cell sits on one number and then jumps. */
    const between = curve.slice(1).some(([lo], i) => {
      const hi = curve[i][0], mid = Math.floor((lo + hi) / 2);
      return pct.get(mid) > curve[i + 1][1] && pct.get(mid) < curve[i][1];
    });
    t("...and interpolates between them rather than stepping", between);

    /* A couple of readings a person would recognise, as a sanity anchor on
       the table itself rather than on the code. */
    t("3.7 V is a middling cell", pct.get(3700) >= 10 && pct.get(3700) <= 25, `${pct.get(3700)}`);
    t("4.0 V is a healthy one", pct.get(4000) >= 70 && pct.get(4000) <= 85, `${pct.get(4000)}`);
  }
}

/* --- 8. it is logged where the log is the only witness ------------------ */

/*
 * A DFU that dies of a flat cell can leave a single-bank target with no
 * application (Trap 2), on a mast, and the log read afterwards is the only
 * account of it that exists. The level therefore has to be recorded *before*
 * the transfer, not merely displayed to somebody who is not there.
 */
t("the runner records the battery at the start of every run",
  /battery_log_state\("dfu"\)/.test(codeOf(read("updater/src/dfu_runner.c"))));
t("...and main() records it at boot",
  /battery_log_state\("boot"\)/.test(codeOf(read("updater/src/main.c"))));
/* Recording it is not gating on it: the device is out of reach precisely
 * because nobody can go and plug it in, so refusing to try is its own
 * failure. The operator decides, from the number on screen. */
t("nothing refuses a DFU over the battery level",
  !/battery[\w_]*\([^)]*\)\s*[<>]=?|battery_read[\s\S]{0,200}?return -E/
    .test(codeOf(read("updater/src/dfu_runner.c"))));

/* --- 9. the command is declared and wired ------------------------------- */

t("FSX_MGMT_ID_BATTERY is a read handler",
  /\[FSX_MGMT_ID_BATTERY\]\s*=\s*\{\s*\.mh_read = fsx_battery/.test(fsxC));
t("...documented in the header", /FSX_MGMT_ID_BATTERY\s*=\s*11/.test(fsxH));
t("...and the client agrees on 11", FSX_ID.BATTERY === 11);

/* --- 10. the header contract is stated where it is implemented ---------- */

t("battery.h documents the devicetree contract",
  /battery-voltage/.test(batteryH) && /voltage-divider/.test(batteryH) &&
  /npm1300-charger/.test(batteryH));
t("...and says the percentage is inferred, not measured",
  /approximate/i.test(batteryH));

/* ---------------------------------------------------------------------- *
 * Everything below imports the components themselves, so the DOM has to
 * exist *first*.
 *
 * Not a detail: `web/js/vue.js` and the modules under it capture `document`
 * when they are first imported. Import a component before jsdom is installed
 * and the capture is of `null` — every later mount then dies inside minified
 * Vue with "Cannot read properties of null (reading 'createElement')", whose
 * node stack trace prints the whole bundle as its source line. The import
 * order is the fix; there is nothing to catch.
 * ---------------------------------------------------------------------- */
let JSDOM;
try {
  ({ JSDOM } = await import("jsdom"));
} catch {
  console.log("  skip  jsdom not installed (npm install --no-save jsdom)");
  console.log(bad === 0 ? "\nall battery tests passed" : `\n${bad} failure(s)`);
  process.exit(bad === 0 ? 0 : 1);
}

const dom = new JSDOM("<!doctype html><div id=app></div>", { pretendToBeVisual: true });
/* defineProperty rather than assignment: modern node ships a real
 * globalThis.navigator with only a getter, so a plain assign throws. Same
 * shape as scanner.test.mjs. */
for (const k of ["window", "document", "navigator", "HTMLElement", "SVGElement",
                 "Node", "Element", "MouseEvent", "requestAnimationFrame"]) {
  Object.defineProperty(globalThis, k, {
    configurable: true, writable: true, value: dom.window[k],
  });
}

const Vue = await import("../js/vue.js");
const storeMod = await import("../js/store.js");
const { ICON_PATHS } = await import("../js/components/Icon.js");
const gaugeMod = await import("../js/components/BatteryGauge.js");
const Gauge = gaugeMod.default;
const batteryIcon = gaugeMod.batteryIcon;

/* --- 10b. the push service: UUIDs, layout and flags ---------------------- */

/*
 * A second copy of a wire format, so a second drift pair. Same shape as
 * dfu-status.test.mjs, and the same failure if it drifts: the client
 * subscribes successfully, decodes garbage, and shows a confident wrong
 * number — worse than showing nothing.
 */
const bstH = read("updater/src/battery_status.h");
const bstC = read("updater/src/battery_status.c");
const bstJs = read("web/js/lib/battery-status.js");

/* UUIDs. The C side spells them as BT_UUID_128_ENCODE groups; normalise both
 * to a plain dashed string before comparing. */
const uuidFromC = (src, label) => {
  const m = src.match(
    new RegExp(`${label}[\\s\\S]{0,200}?BT_UUID_128_ENCODE\\(\\s*0x([0-9a-f]+),\\s*0x([0-9a-f]+),\\s*0x([0-9a-f]+),\\s*0x([0-9a-f]+),\\s*0x([0-9a-f]+)\\)`, "i"));
  return m ? `${m[1]}-${m[2]}-${m[3]}-${m[4]}-${m[5]}` : null;
};
const jsConst = (src, name) => (src.match(new RegExp(`${name}\\s*=\\s*"([0-9a-f-]+)"`)) || [])[1];

t("the battery service UUID matches on both sides",
  uuidFromC(bstC, "svc_uuid") === jsConst(bstJs, "BATTERY_SERVICE"),
  `${uuidFromC(bstC, "svc_uuid")} vs ${jsConst(bstJs, "BATTERY_SERVICE")}`);
t("the battery characteristic UUID matches on both sides",
  uuidFromC(bstC, "batt_uuid") === jsConst(bstJs, "BATTERY_CHAR"),
  `${uuidFromC(bstC, "batt_uuid")} vs ${jsConst(bstJs, "BATTERY_CHAR")}`);

/* Version and length. */
const cNum = (src, name) => {
  const m = src.match(new RegExp(`#define\\s+${name}\\s+(\\w+)`));
  return m ? Number(m[1]) : null;
};
const jsNum = (src, name) => {
  const m = src.match(new RegExp(`export const ${name} = (\\d+)`));
  return m ? Number(m[1]) : null;
};
t("payload version agrees",
  cNum(bstH, "BATTERY_STATUS_PAYLOAD_VERSION") === jsNum(bstJs, "PAYLOAD_VERSION"));
t("payload length agrees",
  cNum(bstH, "BATTERY_STATUS_LEN") === jsNum(bstJs, "PAYLOAD_LEN"));
/* Six bytes is a property, not a coincidence: it has to fit the 23-byte
   default ATT MTU with no fragmentation. */
t("...and still fits the default ATT MTU unfragmented",
  cNum(bstH, "BATTERY_STATUS_LEN") <= 20);

/* Flags, name by name. */
const cFlags = Object.fromEntries(
  [...bstH.matchAll(/#define\s+BATTERY_ST_(\w+)\s+0x([0-9a-fA-F]+)/g)]
    .map((m) => [m[1], parseInt(m[2], 16)]));
const jsFlags = Object.fromEntries(
  [...bstJs.matchAll(/^\s{2}(\w+):\s*0x([0-9a-fA-F]+),/gm)]
    .map((m) => [m[1], parseInt(m[2], 16)]));
t("the flag set matches name for name and bit for bit",
  JSON.stringify(cFlags) === JSON.stringify(jsFlags),
  `C=${JSON.stringify(cFlags)} JS=${JSON.stringify(jsFlags)}`);
t("...and there are four of them (value + known, twice)",
  Object.keys(cFlags).length === 4);

/*
 * The property the whole pairing exists for: the firmware must only set a
 * value bit when it also sets the matching _KNOWN bit, and the client must
 * leave the field *undefined* rather than false when _KNOWN is clear.
 */
const enc = codeOf(bstC.slice(bstC.indexOf("static uint16_t encode")));
t("the firmware gates CHARGING behind CHARGING_KNOWN",
  /charging_known[\s\S]{0,200}?BATTERY_ST_CHARGING_KNOWN[\s\S]{0,200}?st\.charging[\s\S]{0,120}?BATTERY_ST_CHARGING\b/.test(enc));
t("...and EXTERNAL behind EXTERNAL_KNOWN",
  /external_power_known[\s\S]{0,200}?BATTERY_ST_EXTERNAL_KNOWN[\s\S]{0,200}?st\.external_power[\s\S]{0,120}?BATTERY_ST_EXTERNAL\b/.test(enc));
t("the client only defines chg/ext when the KNOWN bit is set",
  /if \(flags & FLAG\.CHARGING_KNOWN\) out\.chg/.test(bstJs) &&
  /if \(flags & FLAG\.EXTERNAL_KNOWN\) out\.ext/.test(bstJs));

/* Round-trip the encoder's own bit assignments through the real parser. */
{
  const { parseBattery, FLAG } = await import("../js/lib/battery-status.js");
  const rec = (src, pct, flags, mv) => {
    const b = new Uint8Array(6);
    b[0] = 1; b[1] = src; b[2] = pct; b[3] = flags;
    b[4] = mv & 0xff; b[5] = mv >> 8;
    return parseBattery(new DataView(b.buffer));
  };
  const pmic = rec(2, 70, FLAG.CHARGING | FLAG.CHARGING_KNOWN | FLAG.EXTERNAL_KNOWN, 3950);
  t("a PMIC record decodes to charging, on battery", pmic.chg === true && pmic.ext === false);
  t("...with the millivolts little-endian", pmic.mv === 3950);
  const div = rec(1, 20, 0, 3730);
  t("a divider record leaves both unknown",
    div.chg === undefined && div.ext === undefined, JSON.stringify(div));
  t("...which is not the same as false", !("chg" in div) && !("ext" in div));
  t("source 0 decodes as no battery hardware", rec(0, 0, 0, 0) === null);
  t("a short record is refused",
    parseBattery(new DataView(new Uint8Array([1, 2, 70]).buffer)) === null);
  t("an unknown version is refused", rec.call(null, 2, 70, 0, 3950) !== null &&
    parseBattery(new DataView(new Uint8Array([99, 2, 70, 0, 0, 0]).buffer)) === null);
  /* Fields may be appended without a version bump, so a longer record must
     still parse — refusing it would break this client against newer firmware
     for no reason. */
  t("a longer record still parses",
    parseBattery(new DataView(new Uint8Array([1, 2, 70, 0, 0x6e, 0x0f, 9, 9]).buffer))?.mv === 3950);
}

/* --- 10c. it only notifies on a real change ------------------------------ */

/*
 * The point of the service. A notification per sample would be a poll with
 * extra steps, competing with the DFU for the same TX buffers (Trap 4).
 */
const batC = codeOf(batteryC);
t("the monitor compares against the last *reported* value, not the last sample",
  /s_reported/.test(batC) && /worth_reporting/.test(batC));
/*
 * And the sample path must actually *branch* on it. Asserting the predicate
 * exists is not asserting it is consulted — Trap 16 shipped for months
 * because `dfu_uuid` was collected, printed, and never branched on. Replacing
 * this condition with `if (true)` turns the service back into a poll and every
 * other assertion here still passes.
 */
t("...and the sample path branches on it",
  /if \(worth_reporting\(&now\)\)/.test(batC));
t("...before touching the reported snapshot or firing the callback",
  /if \(worth_reporting\(&now\)\)\s*\{[\s\S]{0,400}?s_cb\(&now\)/.test(batC));
t("...and reports any change of charge or external-power state",
  /now->charging != s_reported\.charging/.test(batC) &&
  /now->external_power != s_reported\.external_power/.test(batC));
t("...including a change in whether the board can tell",
  /charging_known != s_reported\.charging_known/.test(batC));
t("...or a voltage step past a named threshold",
  /BATTERY_STEP_MV/.test(batC) && /delta >= BATTERY_STEP_MV/.test(batC));
/* Chosen for the boards that have no charge sensing, where it is the only
   signal; a plugged charger lifts a LiPo by well over 100 mV. */
t("the threshold sits between sampling noise and a charger's step",
  (() => { const m = batC.match(/#define BATTERY_STEP_MV\s+(\d+)/);
           return m && Number(m[1]) >= 20 && Number(m[1]) <= 100; })());
t("the GATT layer notifies from the change callback, not on a timer",
  /on_battery_change[\s\S]{0,200}?k_work_submit\(&push_work\)/.test(codeOf(bstC)) &&
  /battery_monitor_start\(on_battery_change\)/.test(codeOf(bstC)));
/* dfu_status.c's discipline, and for the same reason: BT_BUF_ACL_TX_COUNT is
   3 and those buffers are shared with the DFU stream. */
t("at most one notification is in flight",
  /atomic_cas\(&in_flight, 0, 1\)/.test(bstC));
/* Against the comment-stripped source: the explanation of *why* it re-queues
   sits between the two statements and is longer than any sane window. */
t("...and a failed send is re-queued rather than dropped",
  /bt_gatt_notify_cb[\s\S]{0,120}?atomic_set\(&dirty, 1\)/.test(codeOf(bstC)));
/* A GATT read runs inside the Bluetooth stack; a fresh PMIC read there would
   be a bit-banged I2C transaction on that thread. */
t("the read handler uses the cached sample rather than touching hardware",
  /battery_last\(&st\)/.test(enc) && !/battery_read\(/.test(enc));

/* --- 10d. the client prefers the push and keeps a fallback --------------- */

const storeSrc = codeOf(read("web/js/store.js"));
t("the client subscribes on connect", /startBatteryStatus\(\)/.test(storeSrc));
t("...and only polls when the device has no such service",
  /if \(!batteryPushed\) await readBattery\(\)/.test(storeSrc));
t("...but never stops polling entirely, so a dead subscription cannot freeze it",
  /BATTERY_POLL_PUSHED_MS/.test(storeSrc) &&
  /batteryPushed \? BATTERY_POLL_PUSHED_MS : BATTERY_POLL_MS/.test(storeSrc));
t("a pushed record replaces the displayed one",
  /addEventListener\("battery"/.test(storeSrc));

/* --- 11. the glyphs the gauge names <-> the glyphs Icon.js has ----------- */

/*
 * A new drift pair, same shape as the scanner's RSSI band icons. `Icon.d()`
 * looks its name up in ICON_PATHS; a name that is not there renders an
 * *empty path*, which is a valid <svg> with nothing in it. No error, no
 * warning, and the percentage beside it still updates — so the indicator goes
 * on working while the battery itself becomes invisible.
 */
const wanted = new Set();
for (let pct = 0; pct <= 100; pct++) {
  wanted.add(batteryIcon(pct, false));
  wanted.add(batteryIcon(pct, true));
}
for (const name of [...wanted].sort()) {
  t(`Icon.js has "${name}"`, typeof ICON_PATHS[name] === "string" && ICON_PATHS[name].length > 20);
}
/* Every level the set offers is reachable — an off-by-one in the bucket
   arithmetic would silently retire one glyph and no assertion above notices,
   because they only check that what *is* asked for exists. */
for (const n of [0, 1, 2, 3, 4, 5, 6]) {
  t(`battery_${n}_bar is reachable from some percentage`, wanted.has(`battery_${n}_bar`));
}
t("a full cell reads as battery_full", batteryIcon(100, false) === "battery_full");
t("an empty one reads as battery_0_bar", batteryIcon(0, false) === "battery_0_bar");
/* Charging replaces the level rather than being blended into it, so it must
   win at every percentage — including 100, where the glyph would otherwise
   be battery_full and the charger invisible. */
t("charging overrides every level",
  [0, 42, 95, 100].every((p) => batteryIcon(p, true) === "battery_charging_full"));
/* Monotonic: the glyph may never go *down* as the reading goes up. */
const order = (n) => (n === "battery_full" ? 7 : Number(n.match(/_(\d)_bar/)[1]));
let mono = true;
for (let pct = 1; pct <= 100; pct++) {
  if (order(batteryIcon(pct, false)) < order(batteryIcon(pct - 1, false))) mono = false;
}
t("...and the level never falls as the percentage rises", mono);

/* --- 12. it actually renders ------------------------------------------- */

/*
 * A Vue template error is a blank element, not an exception: the header would
 * simply have no battery in it, and every grep above would still pass. The
 * specific trap this caught while being written is that a template expression
 * is evaluated against the component instance, where `Math` does not exist —
 * so `:width="Math.max(...)"` renders nothing at all and logs nothing.
 */
{
  /* Caught rather than allowed to propagate: a template fault must show up as
   * a FAIL line here, not as a node stack trace whose "source line" is the
   * whole of the minified Vue bundle. */
  const render = (value) => {
    storeMod.battery.value = value;
    const host = dom.window.document.createElement("div");
    dom.window.document.body.appendChild(host);
    const app = Vue.createApp(Gauge);
    app.config.warnHandler = () => {};
    let html;
    try {
      app.mount(host);
      html = host.innerHTML;
      app.unmount();
    } catch (e) {
      return `THREW: ${e && e.message}`;
    }
    return html;
  };

  const pmic = render({ src: 2, mv: 3950, pct: 70, chg: true, ext: true });
  t("renders on a PMIC board", /<span[^>]*class="[^"]*battery/.test(pmic), pmic);
  /* Any real glyph, not one specific prefix: the charging override starts
   * "M660-80" while every level starts "M320-80", and pinning the wrong one
   * makes this assertion about which state was rendered rather than about
   * whether a path was found at all. */
  t("...draws a glyph with real path data",
    /<path[^>]+d="M[-\d][^"]{60,}"/.test(pmic), pmic);
  t("...shows the percentage", /70%/.test(pmic), pmic);
  t("...and shows the charger while charging",
    /battery_charging_full|M660-80v-120/.test(pmic) || /d="M660-80/.test(pmic), pmic);

  const divider = render({ src: 1, mv: 3730, pct: 20 });
  t("renders on a divider board", /20%/.test(divider), divider);
  t("...in the low band", /class="[^"]*danger/.test(divider), divider);
  /* The tooltip is where "this board cannot tell" is said, and it is the only
     place it is said, so an empty one is a silent loss of the caveat. */
  t("...and says so in the tooltip",
    /cannot tell whether it is charging/.test(divider), divider);

  const good = render({ src: 1, mv: 4100, pct: 88 });
  t("a healthy cell is in the ok band", /class="[^"]*\bok\b/.test(good), good);

  /* v-if leaves an empty comment placeholder rather than an empty string,
   * so the claim is "no battery element", not "no output". */
  const none = render(null);
  t("renders nothing at all with no battery",
    !/class="[^"]*battery/.test(none) && !/<svg/.test(none), JSON.stringify(none));
  storeMod.battery.value = null;
}

console.log(bad === 0 ? "\nall battery tests passed" : `\n${bad} failure(s)`);
process.exit(bad === 0 ? 0 : 1);
