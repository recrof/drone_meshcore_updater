/*
 * Tests for the config.txt schema/parser against updater/src/config.c.
 * No dependencies — run with:  node web/test/config-file.test.mjs
 *
 * The FIRMWARE_DEFAULTS table below is a transcription of apply_defaults()
 * and the range checks in apply_kv(). If you change a default or a bound in
 * config.c, this file should fail until you update it too — that's the point.
 */
import { readFileSync } from "node:fs";
import {
  CONFIG_SCHEMA, CONFIG_MAX_BYTES, CONFIG_PATH, FIELDS,
  isConfigPath, canonicalUploadPath, parseMapping, serializeMapping,
  parseConfig, serializeConfig, encodedSize, defaults, validateField, advisories,
  TUNING_PLATFORMS, platformFor, tuningFor, defFor,
} from "../js/lib/config-file.js";

let bad = 0;
const t = (name, cond, extra = "") => {
  console.log(`${cond ? "  ok  " : "  FAIL"} ${name}${cond ? "" : "  " + extra}`);
  if (!cond) bad++;
};

/* --- defaults must match updater/src/config.c apply_defaults() --- */
const FIRMWARE_DEFAULTS = {
  ble_name: "OTA | DFU", ble_firmware_mapping: "",
  prn: 32, high_mtu: true, retries: 5, min_rssi: -75,
  retry_cooldown: 5, wedge_cooldown: 10, ble_tx_power: 8, wifi_tx_power: 20,
  scan_timeout: 0,
  scan_debug: false, wifi_ota: true, pkt_gap_ms: 4, erase_pause_ms: 100,
  erase_inflight: 0,
};
const d = defaults();
t("schema has exactly the firmware keys",
  JSON.stringify(Object.keys(d).sort()) === JSON.stringify(Object.keys(FIRMWARE_DEFAULTS).sort()),
  Object.keys(d).join(","));
for (const [k, v] of Object.entries(FIRMWARE_DEFAULTS)) {
  t(`default ${k} = ${JSON.stringify(v)}`, d[k] === v, `got ${JSON.stringify(d[k])}`);
}

/* --- per-platform pacing, against updater/src/dfu_tuning.h ----------------
 *
 * Two of the defaults are not one number any more: pkt_gap_ms and
 * erase_pause_ms are set per SoC family, because erase_pause_ms is timed from
 * a write-completion callback and completion does not mean the same thing on
 * every controller.
 *
 * That makes a third copy of these values — config.c, dfu_tuning.h, and this
 * client — and the copy most likely to be forgotten is this one: a firmware
 * change is compiled and flashed, while a stale number here only shows up as
 * a "reset to default" button that quietly sets the wrong thing on one board.
 * So the header is parsed rather than transcribed.
 *
 * `#if defined(CONFIG_SOC_FAMILY_X)` maps to a platform key here. If a branch
 * is added to the header for a new family, this test fails until the client
 * learns about it too — which is the point.
 */
{
  const FAMILY_TO_PLATFORM = {
    CONFIG_SOC_SERIES_ESP32C5: "espressif_c5",
    CONFIG_SOC_FAMILY_ESPRESSIF_ESP32: "espressif",
    CONFIG_SOC_FAMILY_NORDIC_NRF: "nordic",
  };
  const src = new URL("../../updater/src/dfu_tuning.h", import.meta.url);
  let header = null;
  try { header = readFileSync(src, "utf8"); } catch { /* outside the repo */ }

  if (!header) {
    console.log("  skip  dfu_tuning.h not readable; per-platform defaults not cross-checked");
  } else {
    /* Split on the #if/#elif/#else chain and read the two #defines out of
     * each arm. Deliberately crude: if the header grows a shape this cannot
     * read, that should fail here rather than silently match nothing. */
    const arms = header.split(/^#(?:el)?if\s+defined\(/m).slice(1);
    const fromHeader = {};
    for (const arm of arms) {
      const family = arm.match(/^(CONFIG_[A-Z0-9_]+)\)/)?.[1];
      const plat = FAMILY_TO_PLATFORM[family];
      const gap = arm.match(/#define\s+DFU_PKT_GAP_MS_DEFAULT\s+(\d+)/)?.[1];
      const pause = arm.match(/#define\s+DFU_ERASE_PAUSE_MS_DEFAULT\s+(\d+)/)?.[1];
      if (!family) continue;
      t(`dfu_tuning.h's ${family} branch is known to the client`, !!plat,
        "add it to FAMILY_TO_PLATFORM and to TUNING_PLATFORMS");
      if (!plat) continue;
      t(`dfu_tuning.h defines both knobs for ${plat}`, !!gap && !!pause);
      fromHeader[plat] = { pkt_gap_ms: Number(gap), erase_pause_ms: Number(pause) };
    }

    t("every platform the client knows has a branch in dfu_tuning.h",
      Object.keys(TUNING_PLATFORMS).every(k => k in fromHeader),
      Object.keys(fromHeader).join(","));

    for (const [plat, want] of Object.entries(fromHeader)) {
      const got = TUNING_PLATFORMS[plat];
      t(`${plat} pkt_gap_ms = ${want.pkt_gap_ms}`, got?.pkt_gap_ms === want.pkt_gap_ms,
        `client has ${got?.pkt_gap_ms}`);
      t(`${plat} erase_pause_ms = ${want.erase_pause_ms}`,
        got?.erase_pause_ms === want.erase_pause_ms, `client has ${got?.erase_pause_ms}`);
    }

    /* The header refuses to build for silicon it has no numbers for. That is
     * load-bearing — a silent fallback to the nRF's values would present as a
     * DFU that aborts mid-image on a board nobody has measured. */
    t("dfu_tuning.h refuses to guess for an unknown family", /#error/.test(header));
  }
}

/* --- board target -> platform ---
 *
 * Derived from the string the device reports over os_mgmt, so a new part is
 * classified without a firmware change. The C6 case is the reason it is a
 * pattern and not a table: that part does not exist here yet, and should land
 * on the ESP32's numbers rather than the nRF's the first time one boots.
 *
 * **The C5 no longer falls through, and that is the point of these cases.**
 * It was measured on hardware and wants `erase_pause_ms` 100 where the S3
 * wants 150, so it has its own entry — and because `platformFor` is a regex
 * chain, the specific test has to run before the general one. Reordering
 * those two lines silently gives every C5 the S3's pacing again, which is a
 * throughput regression no other test would notice. Hence a case for each. */
{
  const cases = [
    ["xiao_nrf54lm20a/nrf54lm20a/cpuapp", "nordic"],
    ["xiao_ble/nrf52840", "nordic"],
    ["xiao_ble/nrf52840/sense", "nordic"],
    ["xiao_esp32s3/esp32s3/procpu", "espressif"],
    ["xiao_esp32c6/esp32c6/hpcore", "espressif"],
    ["xiao_esp32c5/esp32c5/hpcore", "espressif_c5"],
  ];
  for (const [board, want] of cases) {
    t(`${board} is ${want}`, platformFor(board) === want, `got ${platformFor(board)}`);
  }
  /* Firmware predating the board report can only be an nRF — the ESP32 port
   * is newer than the report — so an unknown board resolves to nordic rather
   * than to nothing. */
  t("an unreported board is not classified", platformFor(null) === null);
  t("...but resolves to the nRF's numbers", tuningFor(null) === TUNING_PLATFORMS.nordic);
  t("...and so does a board this client has never heard of",
    tuningFor("some_future_board/riscv") === TUNING_PLATFORMS.nordic);

  const esp = defaults("xiao_esp32s3/esp32s3/procpu");
  t("the ESP32's defaults are the ESP32's", esp.pkt_gap_ms === 7 && esp.erase_pause_ms === 150,
    JSON.stringify({ gap: esp.pkt_gap_ms, pause: esp.erase_pause_ms }));
  t("and nothing else moves with the board",
    Object.entries(esp).every(([k, v]) =>
      ["pkt_gap_ms", "erase_pause_ms"].includes(k) || v === d[k]),
    Object.entries(esp).filter(([k, v]) => v !== d[k]).map(([k]) => k).join(","));
  t("only the keys marked defByPlatform move",
    CONFIG_SCHEMA.filter(f => f.defByPlatform).map(f => f.key).sort().join(",") ===
    "erase_pause_ms,pkt_gap_ms");
  t("defFor falls back to f.def for keys that do not move",
    defFor(FIELDS.prn, "xiao_esp32s3/esp32s3/procpu") === FIELDS.prn.def);
}

/* --- advisories must not fight the board's own defaults -------------------
 *
 * The nRF's numbers on an ESP32 (and the reverse) are the mistake this whole
 * change exists to prevent, so both directions are asserted: a board's own
 * defaults are silent, and the other board's are not. */
{
  const ESP = "xiao_esp32s3/esp32s3/procpu";
  const NRF = "xiao_nrf54lm20a/nrf54lm20a/cpuapp";
  t("the ESP32's defaults raise nothing on an ESP32",
    advisories(defaults(ESP), ESP).length === 0, advisories(defaults(ESP), ESP).join(" | "));
  t("the nRF's defaults raise nothing on an nRF",
    advisories(defaults(NRF), NRF).length === 0, advisories(defaults(NRF), NRF).join(" | "));
  t("the nRF's erase_pause_ms is flagged on an ESP32",
    advisories({ ...defaults(ESP), erase_pause_ms: 100 }, ESP).some(s => /150 ms/.test(s)));
  t("the nRF's pkt_gap_ms is flagged on an ESP32",
    advisories({ ...defaults(ESP), pkt_gap_ms: 4 }, ESP).some(s => /untested/.test(s)));
  /* The other way round is *not* a warning: 150 on an nRF is generous, not
   * dangerous, and warning about a safe value trains people to ignore the
   * banner. */
  t("the ESP32's erase_pause_ms is not flagged on an nRF",
    advisories({ ...defaults(NRF), erase_pause_ms: 150 }, NRF).length === 0);
  /* Uniform pacing has only ever been measured on the nRF. Naming 18 ms on an
   * ESP32 would be inventing a measurement. */
  t("uniform pacing on an ESP32 says the floor is unmeasured",
    advisories({ ...defaults(ESP), erase_pause_ms: 0 }, ESP)
      .some(s => /never been measured/.test(s)));
  t("uniform pacing on an nRF still names its measured floor",
    advisories({ ...defaults(NRF), erase_pause_ms: 0, pkt_gap_ms: 0 }, NRF)
      .some(s => /18\.0 ms floor/.test(s)));
}

/* --- the seeded starter file must agree with apply_defaults() -------------
 *
 * updater/src/storage.c writes a config.txt on a fresh filesystem, so it is a
 * second, independent copy of the defaults. These two have drifted before
 * (storage.c seeded retries=5 while config.c compiled 3), which makes a fresh
 * device behave differently from one whose config was deleted.
 *
 * Keys the seeded file omits are fine — parseConfig fills them from the
 * defaults, which is exactly what the firmware does. Only a key that is
 * present *and disagrees* fails here.
 */
{
  const src = new URL("../../updater/src/storage.c", import.meta.url);
  let seeded = null;
  try {
    const text = readFileSync(src, "utf8");
    const block = text.match(/kDefaultConfig\[\]\s*=\s*([\s\S]*?);/)?.[1] ?? "";
    seeded = [...block.matchAll(/"((?:[^"\\]|\\.)*)"/g)]
      .map(m => m[1].replace(/\\n/g, "\n").replace(/\\t/g, "\t").replace(/\\"/g, '"'))
      .join("");
  } catch { /* outside the repo — skip */ }

  if (!seeded) {
    console.log("  skip  storage.c not readable; seeded config not cross-checked");
  } else {
    const seededValues = parseConfig(seeded).values;
    const drift = CONFIG_SCHEMA
      .filter(f => JSON.stringify(seededValues[f.key]) !== JSON.stringify(d[f.key]))
      .map(f => `${f.key}: seeded ${JSON.stringify(seededValues[f.key])} vs default ${JSON.stringify(d[f.key])}`);
    t("storage.c's seeded config.txt agrees with apply_defaults()",
      drift.length === 0, drift.join("; "));
  }
}

/* --- serialize → parse round trip --- */
const vals = { ...d, ble_name: "RAK4631_OTA|4631_DFU", prn: 1, pkt_gap_ms: 35, ble_tx_power: 0 };
const text = serializeConfig(vals, []);
const back = parseConfig(text);
t("round-trips unchanged", JSON.stringify(back.values) === JSON.stringify(vals),
  JSON.stringify(back.values));
t("default file fits the 1023 B buffer", encodedSize(serializeConfig(d, [])) <= CONFIG_MAX_BYTES,
  `${encodedSize(serializeConfig(d, []))} B`);
t("realistic file fits", encodedSize(text) <= CONFIG_MAX_BYTES, `${encodedSize(text)} B`);

/* --- parser mirrors config.c --- */
const p = parseConfig([
  "# comment", "; other comment", "", "   ",
  "  prn = 1  ",                    // whitespace trimmed both sides
  "high_mtu=yes",                   // parse_bool: first char
  "scan_debug=T",
  "no_equals_here",                 // skipped
  "key_from_a_newer_build=42",      // unknown → preserved verbatim
  "retries=999",                    // out of range → firmware ignores
].join("\n"));
t("trims whitespace around key and value", p.values.prn === 1, String(p.values.prn));
t("parse_bool accepts 'yes'", p.values.high_mtu === true);
t("parse_bool accepts 'T'", p.values.scan_debug === true);
t("preserves unknown keys", p.unknown.length === 1 && p.unknown[0] === "key_from_a_newer_build=42",
  JSON.stringify(p.unknown));
t("out-of-range key reported as ignored", p.ignored.length === 1 && p.ignored[0].key === "retries",
  JSON.stringify(p.ignored));
t("out-of-range key keeps firmware default",
  p.values.retries === FIRMWARE_DEFAULTS.retries, String(p.values.retries));
t("unknown keys survive re-serialization",
  serializeConfig(p.values, p.unknown).includes("key_from_a_newer_build=42"));

/* --- bool false must serialize as 0, not "" --- */
t("bool false serializes as 0", serializeConfig({ ...d, high_mtu: false }, []).includes("high_mtu=0"));
t("bool true serializes as 1", serializeConfig(d, []).includes("high_mtu=1"));

/* --- validation mirrors apply_kv range checks --- */
const cases = [
  ["prn", 65536, true], ["prn", 65535, false], ["prn", 0, false], ["prn", -1, true],
  ["retries", 0, true], ["retries", 1, false], ["retries", 255, false], ["retries", 256, true],
  ["min_rssi", -128, true], ["min_rssi", -127, false], ["min_rssi", 0, false], ["min_rssi", 1, true],
  ["retry_cooldown", 601, true], ["retry_cooldown", 600, false],
  ["wedge_cooldown", 601, true], ["wedge_cooldown", 600, false],
  ["scan_timeout", 65536, true], ["scan_timeout", 65535, false],
  ["pkt_gap_ms", 1001, true], ["pkt_gap_ms", 1000, false],
  ["prn", 1.5, true], ["prn", "", true], ["prn", "abc", true],
];
for (const [key, v, shouldFail] of cases) {
  const err = validateField(FIELDS[key], v);
  t(`validate ${key}=${JSON.stringify(v)} ${shouldFail ? "rejected" : "accepted"}`,
    shouldFail ? !!err : !err, err || "");
}

/* ble_tx_power must only ever default to a level the nRF54L implements — an
 * off-list default is one the SoftDevice silently clips, so the radio never
 * actually runs at it. (It defaulted to 4, which is off-list, until it was
 * changed to 6.) */
t("ble_tx_power default is an implemented level", !validateField(FIELDS.ble_tx_power, FIELDS.ble_tx_power.def));
t("ble_tx_power=0 accepted", !validateField(FIELDS.ble_tx_power, 0));
t("ble_tx_power=8 accepted", !validateField(FIELDS.ble_tx_power, 8));
t("ble_tx_power=4 rejected (off-list)", !!validateField(FIELDS.ble_tx_power, 4));
t("ble_tx_power=5 rejected", !!validateField(FIELDS.ble_tx_power, 5));

/* The WiFi radio has its own ladder and its own units — esp_wifi_set_max_tx_power()
 * takes quarter-dBm and rounds down. Offering only implemented levels is what
 * keeps "what the device reports" equal to "what was asked for". */
t("wifi_tx_power default is an implemented level",
  !validateField(FIELDS.wifi_tx_power, FIELDS.wifi_tx_power.def));
t("wifi_tx_power=20 accepted", !validateField(FIELDS.wifi_tx_power, 20));
t("wifi_tx_power=2 accepted", !validateField(FIELDS.wifi_tx_power, 2));
t("wifi_tx_power=0 rejected (below the chip's floor)",
  !!validateField(FIELDS.wifi_tx_power, 0));
t("wifi_tx_power=21 rejected (above the chip's ceiling)",
  !!validateField(FIELDS.wifi_tx_power, 21));
t("wifi_tx_power=10 rejected (off-list)", !!validateField(FIELDS.wifi_tx_power, 10));

/* The old name still works on the device, and the client must not resurrect
 * it as a schema key — a file with both would otherwise round-trip two keys
 * that set the same thing. */
t("tx_power is no longer a schema key", FIELDS.tx_power === undefined);
t("a legacy tx_power line is dropped on parse",
  parseConfig("tx_power=0\nble_tx_power=6\n").values.ble_tx_power === 6);

/* ble_name length cap (APP_CONFIG_NAME_MAX 24 → 23 usable) */
t("ble_name 23 chars accepted", !validateField(FIELDS.ble_name, "x".repeat(23)));
t("ble_name 24 chars rejected", !!validateField(FIELDS.ble_name, "x".repeat(24)));
t("ble_name truncated on parse",
  parseConfig("ble_name=" + "x".repeat(40)).values.ble_name.length === 23);

/* --- advisories --- */
/* The defaults are the measured-good configuration and must not trip any
 * advisory — an advisory that fires on a fresh device is just noise. */
t("shipped defaults raise no advisories", advisories(d).length === 0,
  JSON.stringify(advisories(d)));
/* Calibrated on hardware. Uniform pacing (erase_pause_ms=0): gap=11 failed at
 * 10 KB, gap=15 failed at 127 KB, gap=18 completed 511 KB at 11.8 KB/s.
 * Erase-aware pacing splits the cost instead: one expensive packet per 4 KB. */
const uniform = { ...d, erase_pause_ms: 0 };
t("uniform pacing at 0 ms warns",
  advisories({ ...uniform, pkt_gap_ms: 0 }).some(s => /NO_MEM/.test(s)));
t("uniform pacing at 12 ms warns (it failed on hardware)",
  advisories({ ...uniform, pkt_gap_ms: 12 }).some(s => /NO_MEM/.test(s)));
t("uniform pacing at 15 ms warns (it failed at 25%)",
  advisories({ ...uniform, pkt_gap_ms: 15 }).some(s => /NO_MEM/.test(s)));
t("uniform pacing at 18 ms, the measured-good value, does not warn",
  !advisories({ ...uniform, pkt_gap_ms: 18 }).some(s => /NO_MEM/.test(s)));
/* gap=2 put packets on the wire every ~2.2-2.8 ms, at or below the target's
 * own ~2.5 ms write rate, and was rejected at the first page boundary. */
t("erase-aware pacing warns below the target's write rate",
  advisories({ ...d, pkt_gap_ms: 2 }).some(s => /write/.test(s)));
t("the shipped gap of 4 ms is clear of it",
  advisories({ ...d, pkt_gap_ms: 4 }).length === 0);
/* 6 was tried on hardware and failed every attempt, on the second page. */
t("erase_inflight=6 warns (measured to fail)",
  advisories({ ...d, erase_inflight: 6 }).some(s => /ring/.test(s)));
t("erase_inflight=3 does not warn",
  !advisories({ ...d, erase_inflight: 3 }).some(s => /ring/.test(s)));
t("erase_inflight range matches apply_kv (0..8)",
  !validateField(FIELDS.erase_inflight, 8) && !!validateField(FIELDS.erase_inflight, 9));
t("too short an erase pause warns",
  advisories({ ...d, erase_pause_ms: 40 }).some(s => /page erase/.test(s)));
t("erase_pause_ms range matches apply_kv (0..1000)",
  !validateField(FIELDS.erase_pause_ms, 1000) && !!validateField(FIELDS.erase_pause_ms, 1001));

/* Uniform pacing without high_mtu: the accumulator coalesces ~12 packets per
 * store, so each packet costs a twelfth of the ring and 5 ms is plenty. */
t("uniform pacing tolerates a tighter gap with small packets",
  !advisories({ ...uniform, high_mtu: false, pkt_gap_ms: 5 }).some(s => /NO_MEM/.test(s)));
t("uniform pacing with small packets and no gap still warns",
  advisories({ ...uniform, high_mtu: false, pkt_gap_ms: 0 }).some(s => /NO_MEM/.test(s)));
t("uniform pacing at 5 ms with 244 B packets warns",
  advisories({ ...uniform, pkt_gap_ms: 5 }).some(s => /NO_MEM/.test(s)));
t("prn=1 warns it is the slow path", advisories({ ...d, prn: 1 }).some(s => /round-trip/.test(s)));
t("prn=0 warns", advisories({ ...d, prn: 0 }).some(s => /receipts/.test(s)));

/* --- canonical path is lowercase, matching APP_CONFIG_PATH in config.h ---
 *
 * Read the firmware header and compare literally. A silent disagreement here
 * is the exact failure this rename exists to prevent: the client would write
 * a file the firmware never opens, and nothing would report an error.
 */
t("canonical path is lowercase", CONFIG_PATH === "/lfs1/config.txt", CONFIG_PATH);

{
  const hdr = new URL("../../updater/src/config.h", import.meta.url);
  let firmwarePath = null;
  try {
    const src = readFileSync(hdr, "utf8");
    firmwarePath = src.match(/#define\s+APP_CONFIG_PATH\s+"([^"]+)"/)?.[1] ?? null;
  } catch { /* running outside the repo — skip rather than fail */ }

  if (firmwarePath === null) {
    console.log("  skip  config.h not readable; firmware path not cross-checked");
  } else {
    t("client path matches APP_CONFIG_PATH in config.h",
      firmwarePath === CONFIG_PATH, `config.h says ${firmwarePath}`);
  }
}
/* isConfigPath: the one file the firmware opens, nothing else. */
t("matches the canonical path",          isConfigPath(CONFIG_PATH));
t("rejects the uppercase spelling",      !isConfigPath("/lfs1/CONFIG.TXT"));
t("rejects a copy in another directory", !isConfigPath("/lfs1/backup/config.txt"));
t("rejects a similar name",              !isConfigPath("/lfs1/config.txt.bak"));
t("rejects the bare filename",           !isConfigPath("config.txt"));
t("rejects a mixed-case variant",        !isConfigPath("/lfs1/Config.txt"));

/* canonicalUploadPath: every config upload is forced to lowercase. */
t("redirects uppercase upload",
  canonicalUploadPath("/lfs1/CONFIG.TXT") === CONFIG_PATH);
t("redirects mixed-case upload",
  canonicalUploadPath("/lfs1/Config.Txt") === CONFIG_PATH);
t("leaves an already-canonical upload alone",
  canonicalUploadPath(CONFIG_PATH) === null);
t("ignores config.txt in another directory",
  canonicalUploadPath("/lfs1/backup/CONFIG.TXT") === null);
t("ignores unrelated uploads",
  canonicalUploadPath("/lfs1/firmware.zip") === null);
t("ignores a similar name",
  canonicalUploadPath("/lfs1/config.txt.bak") === null);

/* --- ble_firmware_mapping parsing, mirroring firmware_map.c ------------- */
{
  const m = parseMapping("RAK:rak4631*.zip | XIAO : xiao_*.zip ");
  t("splits rules on '|'", m.rules.length === 2, JSON.stringify(m.rules));
  t("trims whitespace around both halves",
    m.rules[1].name === "XIAO" && m.rules[1].file === "xiao_*.zip",
    JSON.stringify(m.rules[1]));
  t("no malformed rules", m.bad.length === 0);
}
{
  const m = parseMapping("good:a.zip | missing-colon | :nofile | noglob: | ");
  t("keeps the usable rule", m.rules.length === 1 && m.rules[0].name === "good");
  t("flags rules with no colon",     m.bad.includes("missing-colon"));
  t("flags rules with an empty half", m.bad.includes(":nofile") && m.bad.includes("noglob:"));
  t("ignores empty segments",        m.rules.length + m.bad.length === 4,
    JSON.stringify(m));
}
{
  /* A file glob may legitimately contain a colon-free path; only the FIRST
   * colon splits, so a name containing ':' would break — check the split
   * point matches firmware_map.c's strchr(rule, ':'). */
  const m = parseMapping("a:b:c.zip");
  t("splits on the first colon only",
    m.rules[0].name === "a" && m.rules[0].file === "b:c.zip",
    JSON.stringify(m.rules[0]));
}
/* serializeMapping is the editor's half of the round trip: the UI works on
 * rows and the file stores one packed string, so anything parseMapping
 * accepts has to survive being written back out. */
{
  const src = "RAK:rak4631*.zip|XIAO:xiao_*.zip|4631_DFU:rak*.zip";
  t("serialize(parse(x)) === x",
    serializeMapping(parseMapping(src).rules) === src,
    serializeMapping(parseMapping(src).rules));
  t("normalises spacing away",
    serializeMapping(parseMapping(" RAK : a.zip | XIAO : b.zip ").rules)
      === "RAK:a.zip|XIAO:b.zip");
  t("drops entirely blank rows",
    serializeMapping([{ name: "", file: "" }, { name: "A", file: "a.zip" }]) === "A:a.zip");
  t("keeps a half-filled row so validation can report it",
    serializeMapping([{ name: "A", file: "" }]) === "A:");
  t("empty list serializes to the empty default",
    serializeMapping([]) === FIELDS.ble_firmware_mapping.def);
  t("tolerates undefined", serializeMapping(undefined) === "");
}

/* A rule the firmware can't parse is discarded silently — the same failure
 * mode as an out-of-range int, so the editor blocks it the same way. */
t("half-filled rule rejected",
  !!validateField(FIELDS.ble_firmware_mapping, "RAK:"));
t("colon-less rule rejected",
  !!validateField(FIELDS.ble_firmware_mapping, "RAK"));
t("well-formed rules accepted",
  !validateField(FIELDS.ble_firmware_mapping, "RAK:rak*.zip|XIAO:xiao*.zip"));
t("empty mapping accepted (it is the default)",
  !validateField(FIELDS.ble_firmware_mapping, ""));

t("mapping field is a text input", FIELDS.ble_firmware_mapping.type === "text");
t("mapping field asks for the rule editor",
  FIELDS.ble_firmware_mapping.editor === "mapping");
t("mapping default is empty (auto-flash refuses rather than guesses)",
  FIELDS.ble_firmware_mapping.def === "");
t("mapping length cap matches APP_CONFIG_MAPPING_MAX-1",
  FIELDS.ble_firmware_mapping.maxLength === 191);
t("over-long mapping rejected",
  !!validateField(FIELDS.ble_firmware_mapping, "x".repeat(192)));

/* A realistic two-rule config must still fit the parse buffer. */
{
  const withMap = { ...d, ble_firmware_mapping: "RAK:rak4631*.zip | XIAO:xiao_*.zip" };
  const size = encodedSize(serializeConfig(withMap, []));
  t("config with mapping fits the 1023 B buffer", size <= CONFIG_MAX_BYTES, `${size} B`);
}

/* --- oversize guard --- */
const huge = Array.from({ length: 60 }, (_, i) => `unknown_key_${i}=some_value_here`);
t("oversize file detected", encodedSize(serializeConfig(d, huge)) > CONFIG_MAX_BYTES);

/* --- auto-flash across two transports -----------------------------------
 *
 * The rule mirrors mapping_kind_mask() in dfu_runner.c, which is the half
 * that matters: it decides which transports actually get a scan slice. This
 * side only decides whether to warn, so a divergence makes the warning wrong
 * rather than the flashing — but it is still a pair that has to agree, and
 * the source check below is the cheapest way to notice.
 */
{
  const withMap = (m) => advisories({ ...d, ble_firmware_mapping: m });
  const mapNotes = (m) => withMap(m).filter(s => /ble_firmware_mapping/.test(s));

  t("a zip-only mapping raises nothing", mapNotes("RAK:rak*.zip").length === 0,
    mapNotes("RAK:rak*.zip").join(" | "));
  t("a bin-only mapping raises nothing", mapNotes("Heltec:heltec*.bin").length === 0);
  t("a mapping spanning both transports is flagged",
    mapNotes("RAK:rak*.zip | Heltec:heltec*.bin").some(s => /both \.zip and \.bin/.test(s)));
  t("...and says why it costs, rather than just that it does",
    mapNotes("RAK:rak*.zip | Heltec:h*.bin").some(s => /One radio serves both/.test(s)));
  /* A pattern with no extension cannot be classified, and the firmware then
   * has to try everything — which is worth saying, because adding the
   * extension is a one-character fix. */
  t("an unclassifiable pattern is flagged",
    mapNotes("RAK:rak*").some(s => /do not end in \.zip or \.bin/.test(s)));
  t("...naming the rule at fault", mapNotes("RAK:rak*").some(s => /"rak\*"/.test(s)));
  t("an empty mapping raises nothing", mapNotes("").length === 0);
  /* Whitespace around the pattern is cosmetic everywhere else in this file,
   * and must be here too or the advisory fires on a well-formed rule. */
  t("spacing does not change the verdict", mapNotes("RAK : rak*.zip ").length === 0,
    mapNotes("RAK : rak*.zip ").join(" | "));

  /* The firmware half, checked at source level. Compiling dfu_runner.c here
   * is not possible — it pulls in Zephyr — so this asserts only that the
   * classification exists and keys on the same two extensions. */
  const runner = (() => {
    try { return readFileSync(new URL("../../updater/src/dfu_runner.c", import.meta.url), "utf8"); }
    catch { return null; }
  })();
  if (!runner) {
    console.log("  skip  dfu_runner.c not readable; transport narrowing not cross-checked");
  } else {
    t("the firmware narrows transports from the mapping",
      /mapping_kind_mask/.test(runner));
    t("...keying on the same two extensions",
      /"\.zip"/.test(runner) && /"\.bin"/.test(runner));
    t("...and an unclassifiable pattern falls back to trying both",
      /return KIND_ANY;\s*\/\* unclassifiable/.test(runner));
    /* The explicit path must not guess at all: an open bundle already knows
     * its shape, and that is the case the user actually presses a button for. */
    t("an explicit flash picks the transport from the file",
      /bundle_open \? KIND_BIT\(payload\.kind\)/.test(runner));
  }
}

console.log(bad ? `\n${bad} FAILURES` : "\nall config-file tests passed");
process.exit(bad ? 1 : 0);
