/*
 * The USB flasher's UI, with WebUSB and Web Serial present and a manifest to
 * read.
 *
 *   node web/tools/build-single.mjs
 *   node web/test/flash-dialog.test.mjs web/dist/updater.html
 *
 * Split from render.test.mjs because it needs *stubbed* browser APIs. jsdom
 * has neither `navigator.usb` nor `navigator.serial`, so render.test.mjs only
 * ever exercises the "this browser cannot flash" branch — the entire flashing
 * UI, which is what actually ships to Chrome users, went unrendered by any
 * test.
 *
 * It also serves a manifest. Without one the dialog quite correctly says there
 * is nothing to flash and renders none of the rest, so a harness with no
 * manifest tests the empty case three times over and the real one never.
 *
 * The class of bug this exists to catch: a control that sets a ref nothing is
 * listening to. That produces no console error and no visible effect, so only
 * an assertion that the *next thing appears* catches it — which is why the
 * board chooser is driven by clicking it rather than by reading the source.
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

/* One entry per board, shaped like what stage-firmware.mjs writes — including
 * the ESP32-S3's `parts`, which is the entry with no single-file artifact and
 * therefore the one most likely to be mishandled. */
const MANIFEST = {
  format: 2,
  published: "2026-08-01T00:00:00Z",
  boards: [
    {
      board: "xiao_nrf54lm20a/nrf54lm20a/cpuapp", usb: "cmsis-dap",
      dir: "xiao_nrf54lm20a_nrf54lm20a_cpuapp", tag: "v1.0.0",
      published: "2026-08-01T00:00:00Z",
      file: "merged.hex", bytes: 908344, sha256: "a".repeat(64), version: "1.0.0",
      dfu: "dfu_application.zip", dfuVersion: "1.0.0",
    },
    {
      board: "xiao_ble/nrf52840", usb: "nordic-serial-dfu",
      dir: "xiao_ble_nrf52840", tag: "v1.0.0",
      published: "2026-08-01T00:00:00Z",
      file: "merged.hex", bytes: 912414, sha256: "b".repeat(64), version: "1.0.0",
      uf2: "merged.uf2",
    },
    {
      board: "xiao_esp32s3/esp32s3/procpu", usb: "esptool",
      dir: "xiao_esp32s3_esp32s3_procpu", tag: "v1.0.0",
      published: "2026-08-01T00:00:00Z",
      dfuVersion: "1.0.0",
      parts: [
        { file: "mcuboot.bin", offset: 0, bytes: 55408, sha256: "c".repeat(64) },
        { file: "app.signed.bin", offset: 131072, bytes: 437232, sha256: "d".repeat(64) },
      ],
    },
  ],
};

const dom = new JSDOM(readFileSync(file, "utf8"), {
  runScripts: "dangerously",
  pretendToBeVisual: true,
  url: "https://example.org/",
  beforeParse(win) {
    /* Both choosers reject the way a real one does when the user dismisses
     * the prompt, so the failure path renders too. */
    Object.defineProperty(win.navigator, "usb", {
      configurable: true,
      value: {
        requestDevice: async () => { throw new Error("No device selected."); },
        getDevices: async () => [],
      },
    });
    Object.defineProperty(win.navigator, "serial", {
      configurable: true,
      value: {
        requestPort: async () => { throw new Error("No port selected."); },
        getPorts: async () => [],
      },
    });
    win.fetch = async (url) => {
      if (String(url).endsWith("firmware/manifest.json")) {
        return { ok: true, status: 200, json: async () => MANIFEST };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    };
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
const btn = app.querySelector('button[aria-label="Update updater"]');
t("WebUSB is stubbed", !!w.navigator.usb);
t("Web Serial is stubbed", !!w.navigator.serial);
t("toolbar has the Update-updater button", !!btn);

click(btn);
await wait(400);

const dlg = () => app.querySelector("#flash-overlay");
t("clicking opens the dialog", !!dlg());

const text = () => (dlg()?.textContent || "").replace(/\s+/g, " ");
const buttons = () => [...dlg().querySelectorAll("button")];
const findButton = (re) => buttons().find(b => re.test(b.textContent));

/* Two routes, and exactly one is usable at a time: Bluetooth needs a
   connection, USB needs there not to be one. */
{
  const sections = [...dlg().querySelectorAll(".cfg-section")].map(s => s.textContent.trim());
  t("offers both update routes",
    sections.includes("Over Bluetooth") && sections.includes("Over USB"), sections.join(" | "));
  t("Bluetooth route renders", !!dlg().querySelector(".upd"));
  /* Nothing is connected in the harness, so it must say so rather than
     offering a button that cannot work. */
  t("Bluetooth route explains it needs a connection", /Not connected/.test(text()));
  t("USB route is presented as the fallback when Bluetooth is not an option",
    /unable to advertise/.test(text()));
}
t("no 'cannot flash' notice with the APIs present", !/has no WebUSB/.test(text()));

/* --- the board chooser -------------------------------------------------- */

const boardButtons = () => [...dlg().querySelectorAll(".flash-board")];

t("every published board is offered", boardButtons().length === 3,
  boardButtons().map(b => b.textContent.trim()).join(" | "));
t("boards are named for humans, not as Zephyr targets",
  boardButtons().map(b => b.textContent.trim()).join("|") ===
  "XIAO ESP32-S3|XIAO nRF52840|XIAO nRF54LM20A",
  boardButtons().map(b => b.textContent.trim()).join("|"));
t("no board is pre-selected",
  boardButtons().every(b => b.getAttribute("aria-checked") === "false"));
/* A pre-selected board sits next to a button that writes to hardware; the
 * user must have made the choice, not inherited it from a sort order. */
t("nothing is flashable until a board is chosen", !findButton(/Flash newest/));
t("and it says why", /Pick the board you are flashing/.test(text()));

/* --- the probe board ---------------------------------------------------- */

click(boardButtons().find(b => /nRF54LM20A/.test(b.textContent)));
await wait(300);
{
  t("choosing the nRF54L board shows the probe panel", !!findButton(/Connect probe/));
  t("it offers one flash button", !!findButton(/Flash newest/));
  t("flashing is blocked before a probe is attached",
    findButton(/Flash newest/)?.disabled === true);
  t("and says what is missing", /connect the probe first/.test(text()));
  t("no bootloader button-dance for a board that has a probe",
    !/double-tap|hold the BOOT/i.test(text()));
}

/* --- the ESP32-S3, which has no other way in ---------------------------- */

click(boardButtons().find(b => /ESP32-S3/.test(b.textContent)));
await wait(300);
{
  t("choosing the ESP32-S3 shows the ROM-loader panel", /ROM loader/.test(text()));
  t("it offers one flash button", !!findButton(/Flash newest/));
  t("the flash button is live — there is nothing to attach first",
    findButton(/Flash newest/)?.disabled === false);
  /* Flashing resets the board itself and the port survives it on this chip,
   * so there is no button dance in the happy path — and no separate reboot
   * button either. The BOOT/RESET fallback lives in `recovery`, which is
   * shown when something fails. */
  t("it does not make the user press anything", !/Hold the BOOT button/.test(text()));
  t("it says the port is all that is needed", /the board is put into download mode/.test(text()));
  t("no separate reboot button — flashing does it", !findButton(/download mode/i));
  t("the probe panel is gone", !findButton(/Connect probe/));
  /* The entry has no `file`, only `parts` — the size shown must be their sum
   * rather than an undefined that renders as blank or NaN. */
  t("it sizes the write from the parts", /481\.1 KB|482 KB|0\.5 MB|481/.test(text()),
    (text().match(/v1\.0\.0[^·]*·[^·]*/) ?? [""])[0]);
}

/* --- the nRF52840 ------------------------------------------------------- */

click(boardButtons().find(b => /nRF52840/.test(b.textContent)));
await wait(300);
{
  t("choosing the nRF52840 shows the serial-DFU panel", /Nordic serial DFU|Adafruit/.test(text()));
  t("it says how to reach the bootloader", /Double-tap the RESET button/.test(text()));
  t("it offers one flash button", !!findButton(/Flash newest/));
  /* This board *does* keep a reboot button: its application and its
   * bootloader are different USB devices, so the port cannot survive. */
  t("and a reboot button, because its port does not survive the reset",
    !!findButton(/Reboot into bootloader/));
}

/* A dismissed port chooser must surface, not vanish. */
click(findButton(/Flash newest/));
await wait(400);
t("a refused port chooser is reported", /No port selected/.test(text()), text().slice(-160));
t("and the recovery advice comes with it",
  /double-tap RESET again|drop the \.uf2/i.test(text()));

/* --- what is deliberately absent ---------------------------------------- */

/* Asserted absent, not merely unmentioned — this is the kind of affordance
 * that gets added back as a convenience. */
t("offers no file chooser at all", !dlg().querySelector("input[type=file]"));
t("does not invite the user to pick a file",
  !/custom|choose a file|pick a file/i.test(text()));
/* The line this whole change removed: two boards published, listed, and then
 * disowned by the UI that listed them. */
t("no board is published and then disowned",
  !/not flashable through a probe|that board's own bootloader/i.test(text()));

{
  const src = (f) => readFileSync(join(WEB, "js/components", f), "utf8");
  for (const f of ["FlashDialog.js", "ProbeFlash.js", "SerialFlash.js", "BleUpdate.js"]) {
    t(`${f} declares no file input`, !/type="file"/.test(src(f)));
    t(`${f} has no custom-image handler`, !/(flash|update)Custom/.test(src(f)));
  }

  /* The update screen reports an outcome, not MCUboot's bookkeeping. A table
   * of slot / pending / confirmed is an accurate picture of the bootloader
   * and answers a question almost nobody has; slot state is still read, it is
   * just not the interface. */
  const ble = src("BleUpdate.js");
  t("BleUpdate renders no slot table", !/upd-slots|v-for="s in slots"/.test(ble));
  t("BleUpdate states where the device stands in one line", /statusLine/.test(ble));
  t("BleUpdate says whether the update landed", /outcome/.test(ble));
  /* Still read internally — it is what the trial-state banner and the
   * identical-image check are computed from. */
  t("BleUpdate still reads image state", /imgState\(\)/.test(ble));
}

const close = [...dlg().querySelectorAll(".cfg-foot button")].find(b => /Close/.test(b.textContent));
click(close);
await wait(300);
t("dialog closes", !app.querySelector("#flash-overlay"));

if (errors.length) {
  console.log("\n--- console/window errors ---");
  for (const e of [...new Set(errors)]) console.log("  " + e.slice(0, 400));
}
console.log(bad || errors.length ? "\nFAILED" : "\nall flash-dialog tests passed");
process.exit(bad || errors.length ? 1 : 0);
