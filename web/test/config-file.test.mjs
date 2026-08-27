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
  retry_cooldown: 5, wedge_cooldown: 10, tx_power: 8, scan_timeout: 0,
  scan_debug: false, pkt_gap_ms: 4, erase_pause_ms: 100, erase_inflight: 0,
};
const d = defaults();
t("schema has exactly the firmware keys",
  JSON.stringify(Object.keys(d).sort()) === JSON.stringify(Object.keys(FIRMWARE_DEFAULTS).sort()),
  Object.keys(d).join(","));
for (const [k, v] of Object.entries(FIRMWARE_DEFAULTS)) {
  t(`default ${k} = ${JSON.stringify(v)}`, d[k] === v, `got ${JSON.stringify(d[k])}`);
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
const vals = { ...d, ble_name: "RAK4631_OTA|4631_DFU", prn: 1, pkt_gap_ms: 35, tx_power: 0 };
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

/* tx_power must only ever default to a level the nRF54L implements — an
 * off-list default is one the SoftDevice silently clips, so the radio never
 * actually runs at it. (It defaulted to 4, which is off-list, until it was
 * changed to 6.) */
t("tx_power default is an implemented level", !validateField(FIELDS.tx_power, FIELDS.tx_power.def));
t("tx_power=0 accepted", !validateField(FIELDS.tx_power, 0));
t("tx_power=8 accepted", !validateField(FIELDS.tx_power, 8));
t("tx_power=4 rejected (off-list)", !!validateField(FIELDS.tx_power, 4));
t("tx_power=5 rejected", !!validateField(FIELDS.tx_power, 5));

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

console.log(bad ? `\n${bad} FAILURES` : "\nall config-file tests passed");
process.exit(bad ? 1 : 0);
