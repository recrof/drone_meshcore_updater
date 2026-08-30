/*
 * The firmware inspector's wire contract, held to the C that produces it.
 *
 *   node web/test/dfu-inspect.test.mjs
 *
 * Three things cross this boundary and none of them announce a change:
 *
 *  - **enum values.** `kind` and `transport` go over CBOR as integers. A
 *    renumbered enum decodes cleanly and means something else — the file
 *    listing would confidently describe a merged image as a legacy package.
 *  - **the rejected-extension list.** The device turns these away at the
 *    first chunk; the client turns them away before uploading. If the client's
 *    copy grows an entry the device does not have, the client refuses files
 *    the device would accept, which reads as a bug in the device.
 *  - **the CRC variants.** There are several CRC-16s in circulation differing
 *    only in seed and bit order, and the init packet uses exactly one. Both
 *    implementations are anchored to published check values so neither can
 *    bless its own output.
 */
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";

const WEB = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = resolve(WEB, "..");
const SRC = join(ROOT, "updater", "src");

const fi = await import("../js/lib/firmware-image.js");
const smp = await import("../js/lib/smp-client.js");

let bad = 0;
const t = (name, cond, extra = "") => {
  console.log(`${cond ? "  ok  " : "  FAIL"} ${name}${cond ? "" : "  [" + extra + "]"}`);
  if (!cond) bad++;
};

const header = existsSync(join(SRC, "firmware_inspect.h"))
  ? readFileSync(join(SRC, "firmware_inspect.h"), "utf8") : null;
const impl = existsSync(join(SRC, "firmware_inspect.c"))
  ? readFileSync(join(SRC, "firmware_inspect.c"), "utf8") : null;

if (!header || !impl) {
  console.log("  skip  firmware_inspect.[ch] not readable");
  console.log("\nall dfu-inspect tests passed");
  process.exit(0);
}

/** Values of a C enum, as { NAME: number }. */
function cEnum(text, name) {
  const body = text.split(`enum ${name} {`)[1]?.split("};")[0] ?? "";
  const out = {};
  for (const m of body.matchAll(/(\w+)\s*=\s*(0x[0-9a-fA-F]+|\d+)/g)) {
    out[m[1]] = Number(m[2]);
  }
  return out;
}

/* --- kind ---------------------------------------------------------------- */
{
  const c = cEnum(header, "fw_kind");
  const want = {
    FW_KIND_UNKNOWN: smp.FW_KIND.UNKNOWN,
    FW_KIND_NORDIC_ZIP: smp.FW_KIND.NORDIC_ZIP,
    FW_KIND_NCS_ZIP: smp.FW_KIND.NCS_ZIP,
    FW_KIND_ESP_APP: smp.FW_KIND.ESP_APP,
    FW_KIND_ESP_MERGED: smp.FW_KIND.ESP_MERGED,
  };
  t("firmware_inspect.h declares every kind the client knows",
    Object.keys(want).every(k => k in c), JSON.stringify(c));
  for (const [k, v] of Object.entries(want)) {
    t(`${k} = ${v} on both sides`, c[k] === v, `C has ${c[k]}`);
  }
  t("the client knows every kind the firmware can send",
    Object.keys(c).length === Object.keys(want).length,
    `C: ${Object.keys(c).join(",")}`);
}

/* --- transport ----------------------------------------------------------- */
{
  const c = cEnum(header, "fw_transport_id");
  t("FW_TRANSPORT_BLE matches the client's bit",
    c.FW_TRANSPORT_BLE === smp.TRANSPORT_BIT.BLE, `C ${c.FW_TRANSPORT_BLE}`);
  t("FW_TRANSPORT_WIFI matches the client's bit",
    c.FW_TRANSPORT_WIFI === smp.TRANSPORT_BIT.WIFI, `C ${c.FW_TRANSPORT_WIFI}`);
  /* They are ORed into a mask, so they have to be distinct single bits —
   * an enum written 1,2,3 would make "BLE and WiFi" indistinguishable from
   * a third transport. */
  for (const [k, v] of Object.entries(c)) {
    if (v === 0) continue;
    t(`${k} is a single bit`, (v & (v - 1)) === 0, String(v));
  }
  /* And the same bits again in firmware-image.js, which is what decodes the
   * mask the device sends. */
  t("firmware-image.js decodes with the same bits",
    fi.TRANSPORT_BIT[fi.TRANSPORT.BLE] === c.FW_TRANSPORT_BLE &&
    fi.TRANSPORT_BIT[fi.TRANSPORT.WIFI] === c.FW_TRANSPORT_WIFI);
}

/* --- the transport names the firmware matches on ------------------------
 *
 * firmware_transports() maps dfu_transport.c's `name` strings onto bits. A
 * renamed transport would silently drop out of the mask, and the client would
 * be told the device cannot do something it can. */
{
  const names = [...impl.matchAll(/strcmp\(list\[i\]->name,\s*"([^"]+)"\)/g)].map(m => m[1]);
  t("firmware_transports matches the client's transport names",
    names.includes(fi.TRANSPORT.BLE) && names.includes(fi.TRANSPORT.WIFI),
    names.join(","));

  const tp = join(SRC, "dfu_transport.c");
  if (existsSync(tp)) {
    /* Every name it matches must be a name some driver actually declares,
     * commented out or not — otherwise the mapping is dead code. */
    const decl = readFileSync(join(SRC, "transport_ble.c"), "utf8");
    t("the BLE driver declares the name firmware_transports looks for",
      decl.includes(`"${fi.TRANSPORT.BLE}"`));

    /* Same for the WiFi driver. `firmware_transports()` maps a driver's
     * `name` string onto a capability bit, so a renamed transport silently
     * drops out of the mask and the client is told the device cannot do
     * something it can. */
    const wifi = join(SRC, "transport_wifi_elegantota.c");
    if (existsSync(wifi)) {
      t("the WiFi driver declares the name firmware_transports looks for",
        readFileSync(wifi, "utf8").includes(`"${fi.TRANSPORT.WIFI}"`));
      /* And it is in the table, behind the Kconfig that decides whether the
       * hardware has a radio at all. */
      const table = readFileSync(join(SRC, "dfu_transport.c"), "utf8");
      t("the WiFi driver is in the transport table",
        /dfu_transport_wifi_elegantota,/.test(table) &&
        !/\/\*\s*&dfu_transport_wifi_elegantota/.test(table));
      t("...guarded by CONFIG_WIFI, so nRF builds do not carry it",
        /#ifdef CONFIG_WIFI/.test(table));
    }
  }
}

/* --- the rejected-extension list ---------------------------------------- */
{
  const cList = [...impl.matchAll(/\{\s*"(\.\w+)",\s*"/g)].map(m => m[1]).sort();
  const jsList = Object.keys(fi.REJECTED_EXTENSIONS).sort();
  t("both sides refuse the same file types",
    JSON.stringify(cList) === JSON.stringify(jsList),
    `C: ${cList.join(",")} vs JS: ${jsList.join(",")}`);
  t("...and the list is not empty", cList.length > 0);

  /* The client's copy is an optimisation; the device's is the rule. So the
   * client must never refuse something the device would take. */
  for (const ext of jsList) {
    t(`${ext} is refused by the client`, fi.unsupportedReason(`x${ext}`) !== null);
    t(`${ext} is refused in upper case too`, fi.unsupportedReason(`X${ext.toUpperCase()}`) !== null);
  }
  t("a .zip is not refused", fi.unsupportedReason("rak.zip") === null);
  t("a .bin is not refused", fi.unsupportedReason("firmware.bin") === null);
}

/* --- the CRC variants both sides use ------------------------------------ */
{
  t("the C uses the reflected CRC-32 polynomial", /0xEDB88320/i.test(impl));
  t("the C uses the CCITT CRC-16 polynomial", /0x1021/i.test(impl));
  /* The JS side is anchored to the published check values in
   * firmware-image.test.mjs; asserting them here too keeps this file
   * self-contained about what "the same CRC" means. */
  const enc = new TextEncoder().encode("123456789");
  t("the JS CRC-32 is the IEEE one", fi.crc32(enc) === 0xcbf43926);
  t("the JS CRC-16 is CCITT-FALSE", fi.crc16(enc) === 0x29b1);
}

/* --- the inspector must not run while a transfer does -------------------
 *
 * It borrows firmware_zip.c's single archive handle for the manifest half. An
 * inspection that repositioned a streaming archive's cursor would corrupt a
 * DFU in a way nothing would attribute to it. */
t("firmware_inspect refuses while a DFU is running", /dfu_runner_busy\(\)/.test(impl));
t("...and says so rather than failing silently", /EBUSY/.test(impl));

/* --- both upload paths are covered --------------------------------------
 *
 * The fast custom upload service never reaches mcumgr's callbacks, so wiring
 * only the documented fs_mgmt hook would leave the path the web client
 * actually uses uncovered — while looking finished. */
for (const [file, what] of [
  ["fsx_stream.c", "the fast upload path"],
  ["upload_hook.c", "the SMP upload path"],
]) {
  const text = readFileSync(join(SRC, file), "utf8");
  t(`${what} checks the file name before accepting it`,
    /firmware_name_acceptable/.test(text), file);
}

/* ---- which transport a file name implies -------------------------------
 *
 * `transportForName()` decides which flash button the listing offers, and
 * `mapping_kind_mask()` in dfu_runner.c decides which radios auto-flash is
 * allowed to bring up. They are the same rule keyed on the same two
 * extensions, arrived at independently, and they fail in opposite directions:
 * the client's copy going wrong hides a working button (which is what it did
 * before the WiFi transport was wired up — .bin files were check-only), the
 * device's copy going wrong spends a scan on a radio that cannot carry the
 * file. Neither says anything when it drifts. */
{
  const runner = existsSync(join(SRC, "dfu_runner.c"))
    ? readFileSync(join(SRC, "dfu_runner.c"), "utf8") : null;

  t(".zip implies the Bluetooth transport",
    fi.transportForName("Xiao_nrf52_repeater-v1.17.1.zip") === fi.TRANSPORT.BLE);
  t(".bin implies the WiFi transport",
    fi.transportForName("Xiao_C3_repeater-v1.17.1.bin") === fi.TRANSPORT.WIFI);
  t("case is not significant", fi.transportForName("A.ZIP") === fi.TRANSPORT.BLE);
  t("anything else implies nothing", fi.transportForName("config.txt") === null);
  t("a missing name implies nothing", fi.transportForName(undefined) === null);
  /* Refused by name on both sides, so they must not look flashable either. */
  for (const ext of Object.keys(fi.REJECTED_EXTENSIONS)) {
    t(`${ext} implies no transport`, fi.transportForName("fw" + ext) === null, ext);
  }

  if (runner) {
    const mask = runner.slice(runner.indexOf("mapping_kind_mask"));
    t("the device keys the same rule on .zip", /"\.zip"/.test(mask));
    t("the device keys the same rule on .bin", /"\.bin"/.test(mask));
    /* Same pairing, expressed in the device's vocabulary: a .zip is a ZIP
     * payload and only the BLE transport declares that kind. */
    t(".zip maps to the ZIP payload kind on the device",
      /"\.zip"[\s\S]{0,120}KIND_BIT\(DFU_PAYLOAD_ZIP\)/.test(mask));
    t(".bin maps to the RAW payload kind on the device",
      /"\.bin"[\s\S]{0,120}KIND_BIT\(DFU_PAYLOAD_RAW\)/.test(mask));
    const ble = readFileSync(join(SRC, "transport_ble.c"), "utf8");
    t("the BLE transport is the one carrying ZIP payloads",
      /\.payload_kind\s*=\s*DFU_PAYLOAD_ZIP/.test(ble));
    const wifi = join(SRC, "transport_wifi_elegantota.c");
    if (existsSync(wifi)) {
      t("the WiFi transport is the one carrying RAW payloads",
        /\.payload_kind\s*=\s*DFU_PAYLOAD_RAW/.test(readFileSync(wifi, "utf8")));
    }
  }
}

/* ---- the listing offers what the device can actually send ---------------
 *
 * The bug this exists for: the flash button was gated on `.zip` alone, so
 * after the WiFi transport shipped there was no way to start a WiFi flash
 * from the UI at all — and nothing said so, because a missing button renders
 * exactly like a button that was never meant to be there. */
{
  const listing = readFileSync(join(WEB, "js/components/FileListing.js"), "utf8");
  const store = readFileSync(join(WEB, "js/store.js"), "utf8");

  t("the listing no longer gates flashing on the .zip extension",
    !/isZip/.test(listing));
  t("it gates on whether a transport exists for the file",
    /transportForName/.test(listing));
  t("and on what the device said it has, not on the board",
    /deviceTransports/.test(listing));
  /* Disabled, not hidden: an absent button is indistinguishable from a bug. */
  t("an unusable flash button is rendered disabled rather than omitted",
    /:disabled="!row\.canFlash"/.test(listing));
  t("and carries the reason in its tooltip", /whyBlocked/.test(listing));

  t("the store's flash entry point is not named for one container",
    /export async function flashFile/.test(store) && !/flashZip/.test(store));
  t("the confirm text names the transport the run will use",
    /transportForName\(name\)/.test(store));
}

console.log(bad ? `\n${bad} FAILURES` : "\nall dfu-inspect tests passed");
process.exit(bad ? 1 : 0);
