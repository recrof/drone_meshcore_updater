/*
 * /lfs1/config.txt — schema, parser, and serializer.
 *
 * This mirrors updater/src/config.c exactly. When you add a knob there
 * ("extend struct app_config + one line in apply_kv()"), add one entry to
 * CONFIG_SCHEMA here and the form builds itself.
 *
 * Two firmware behaviours drive the whole design of this file:
 *
 *  1. Out-of-range values are *silently ignored*. apply_kv() range-checks
 *     each key and simply doesn't assign when the check fails, so the
 *     firmware keeps the compile-time default. A bad value therefore looks
 *     identical to a missing one. We refuse to save instead.
 *
 *  2. The parser reads the file into a 1024-byte buffer (`read_all`, which
 *     caps at dst_sz - 1), so anything past 1023 bytes is truncated away
 *     without a word. Keys that fall off the end silently revert to
 *     defaults. We hard-check the encoded size before uploading.
 *
 * Unknown keys are preserved verbatim on save — config.c ignores them, and
 * planned future keys (e.g. ble_firmware_mapping) shouldn't be destroyed by
 * a round-trip through this editor.
 */

/* Canonical config path — lowercase, matching APP_CONFIG_PATH in config.h.
 * Everything that creates or updates the file uses this spelling and only
 * this spelling, so a case mismatch can't leave settings in a file the
 * firmware never reads.
 */
export const CONFIG_PATH = "/lfs1/config.txt";

/* config.c: `char blob[1024]` + read_all()'s `dst_sz - 1` cap. */
export const CONFIG_MAX_BYTES = 1023;

/* Is this path *the* config file — the one app_config_load() opens?
 *
 * An exact match rather than a loose basename test: a config.txt in some
 * other directory is an inert file the updater never reads, and routing it to
 * the editor would be a lie, since the editor loads and saves CONFIG_PATH
 * regardless of what was clicked.
 */
export const isConfigPath = (p) => p === CONFIG_PATH;

/* Would this upload land on the config file under the wrong spelling?
 * Returns the corrected path, or null when the upload isn't a config file.
 * Forces every config upload to the canonical lowercase name — dropping a
 * file named "CONFIG.TXT" (or any other casing) onto /lfs1 would otherwise
 * create a second file that the firmware ignores, with no error anywhere to
 * explain why the settings did nothing.
 */
export function canonicalUploadPath(dstPath) {
  if (dstPath === CONFIG_PATH) return null;                   // already right
  const slash = dstPath.lastIndexOf("/");
  const dir  = dstPath.slice(0, slash);
  const name = dstPath.slice(slash + 1);
  if (dir !== "/lfs1") return null;                           // not the config dir
  return name.toLowerCase() === "config.txt" ? CONFIG_PATH : null;
}

/* config.h: APP_CONFIG_NAME_MAX 24, written with snprintf → 23 usable. */
const BLE_NAME_MAX = 23;

/* config.h: APP_CONFIG_MAPPING_MAX 192, snprintf → 191 usable. */
const MAPPING_MAX = 191;

/* Split a ble_firmware_mapping value the way firmware_map.c does: '|' between
 * rules, first ':' splitting name pattern from file glob, whitespace trimmed.
 * Returns { rules: [{name, file}], bad: [rawRule] }.
 */
export function parseMapping(value) {
  const rules = [];
  const bad = [];
  for (const raw of String(value ?? "").split("|")) {
    const rule = raw.trim();
    if (!rule) continue;
    const i = rule.indexOf(":");
    if (i < 0) { bad.push(rule); continue; }
    const name = rule.slice(0, i).trim();
    const file = rule.slice(i + 1).trim();
    if (!name || !file) { bad.push(rule); continue; }
    rules.push({ name, file });
  }
  return { rules, bad };
}

/* config.h: the nRF54L radio has fewer allowed TX levels than the nRF52840.
 * Anything not in this list is silently clipped by the SoftDevice.
 */
export const TX_POWER_LEVELS = [-40, -20, -16, -12, -8, -4, 0, 3, 6, 8];

export const CONFIG_SCHEMA = [
  {
    section: "Target selection",
    key: "ble_name",
    label: "ble_name",
    title: "BLE name filter",
    type: "text",
    def: "OTA | DFU",
    maxLength: BLE_NAME_MAX,
    placeholder: "(any device with the DFU service)",
    desc: `Substring filter for the advertised BLE name. Empty accepts any peer
           exposing the Legacy DFU service. Multiple substrings may be OR'd with
           "|" — useful when an app and its bootloader advertise under different
           names, e.g. RAK4631_OTA|4631_DFU.`,
  },
  {
    key: "ble_firmware_mapping",
    label: "ble_firmware_mapping",
    title: "Per-target firmware rules",
    type: "text",
    def: "",
    maxLength: MAPPING_MAX,
    placeholder: "RAK:rak4631*.zip | XIAO:xiao_*.zip",
    desc: `Lets one updater carry several bundles and pick per target. Rules are
           "name:fileglob", separated by "|" and tried in order; the first whose
           name part appears in the peer's advertised name wins, and its glob is
           resolved against /lfs1 (if several files match, the last by name wins,
           so v2 beats v1). Only used by Auto flash — flashing a specific zip from
           the list always sends exactly that zip.`,
    note: (v) => {
      const { rules, bad } = parseMapping(v);
      if (bad.length) return `unusable rule(s) ignored by the firmware: ${bad.join(", ")} — each needs "name:fileglob"`;
      if (!rules.length) return "empty — Auto flash has nothing to choose from and will refuse to run";
      return `${rules.length} rule(s): ` +
             rules.map(r => `"${r.name}" → ${r.file}`).join(", ");
    },
  },
  {
    key: "min_rssi",
    label: "min_rssi",
    title: "Minimum signal strength",
    type: "int",
    def: -75,
    min: -127,
    max: 0,
    unit: "dBm",
    desc: `Advertisements weaker than this are rejected during the scan. -127
           disables the check. Refuses to start flashing when the link isn't
           strong enough to stream reliably — a weak link fails mid-image, which
           costs a full retry.`,
  },
  {
    key: "scan_timeout",
    label: "scan_timeout",
    title: "Scan timeout",
    type: "int",
    def: 0,
    min: 0,
    max: 65535,
    unit: "s",
    desc: `How long to wait for a matching target. 0 scans forever (the default,
           intended for drone use). On expiry the sequence gives up without
           consuming a DFU retry.`,
    note: (v) => (Number(v) === 0 ? "0 = scan forever" : null),
  },
  {
    key: "scan_debug",
    label: "scan_debug",
    title: "Log rejected advertisements",
    type: "bool",
    def: false,
    desc: `Log every advertisement rejected for weak signal, name mismatch, or
           missing DFU service UUID. Useful when diagnosing why a target isn't
           being picked up; noisy in the field, so off by default.`,
  },

  {
    section: "Transfer tuning",
    key: "prn",
    label: "prn",
    title: "Packet receipt cadence",
    type: "int",
    def: 1,
    min: 0,
    max: 65535,
    desc: `Firmware packets sent between packet-receipt notifications. This is
           flow control, not a speed knob — raising it removes back-pressure
           rather than adding tolerance. 0 disables receipts entirely (risky).`,
    /* The single least obvious property of the whole protocol — see
     * CLAUDE.md "Trap 2". Legacy DFU data packets carry no offset, so the
     * bootloader appends blindly; a dropped packet corrupts the image from
     * that point on while its byte counter keeps advancing.
     */
    note: (v) => {
      const n = Number(v);
      if (n === 1) return "prn=1 — mid-image resume is available (measured: 0 loss in 2074 packets)";
      if (n === 0) return "prn=0 disables flow control entirely — no loss detection until VALIDATE fails";
      return "any loss aborts the attempt and retries the whole image — resume only works at prn=1";
    },
  },
  {
    key: "pkt_gap_ms",
    label: "pkt_gap_ms",
    title: "Inter-packet gap",
    type: "int",
    def: 5,
    min: 0,
    max: 1000,
    unit: "ms",
    desc: `Idle gap inserted between consecutive firmware packets. This is the
           reliability lever. ATT Write Commands have no flow control, so a
           back-to-back burst arrives faster than an SDK 11-era bootloader can
           drain it: while committing to flash it has no free RX buffer and
           silently discards whatever lands. Nothing surfaces at the link layer.
           The peer needs roughly 35–50 ms between packets regardless of how
           often it reports receipts. Raise this if a target keeps failing
           mid-stream.`,
  },
  {
    key: "high_mtu",
    label: "high_mtu",
    title: "Negotiate 247-byte MTU",
    type: "bool",
    def: true,
    desc: `Request an ATT MTU of up to 247 B after connecting, instead of the
           23 B default. Some older bootloaders don't honour MTU exchange — turn
           this off if a target stalls immediately after connect.`,
  },
  {
    key: "tx_power",
    label: "tx_power",
    title: "Transmit power",
    type: "select",
    def: 6,
    options: TX_POWER_LEVELS.map(v => ({ value: v, label: `${v > 0 ? "+" : ""}${v} dBm` })),
    desc: `Radio TX power. The nRF54L only implements the levels listed here;
           any other value is silently clipped by the SoftDevice.`,
  },

  {
    section: "Retry behaviour",
    key: "retries",
    label: "retries",
    title: "DFU attempts",
    type: "int",
    def: 5,
    min: 1,
    max: 255,
    desc: `How many times to attempt the DFU before giving up. config.txt is
           re-read before every attempt, so a corrected file uploaded mid-run
           applies to the next one.`,
  },
  {
    key: "retry_cooldown",
    label: "retry_cooldown",
    title: "Cooldown after a pre-connect failure",
    type: "int",
    def: 5,
    min: 0,
    max: 600,
    unit: "s",
    desc: `Pause after an attempt that failed before connecting. The bootloader
           needs a moment to settle after a reset before it will accept another
           START_DFU.`,
  },
  {
    key: "wedge_cooldown",
    label: "wedge_cooldown",
    title: "Cooldown after a post-connect failure",
    type: "int",
    def: 60,
    min: 0,
    max: 600,
    unit: "s",
    desc: `Longer pause used after a response timeout, protocol error, or
           mid-stream link drop. Stock SDK 11-era Adafruit bootloaders that wedge
           mid-DFU only unstick when their internal inactivity watchdog fires,
           usually 60–120 s.`,
  },
];

/* Flat key → descriptor lookup. */
export const FIELDS = Object.fromEntries(CONFIG_SCHEMA.map(f => [f.key, f]));

export function defaults() {
  return Object.fromEntries(CONFIG_SCHEMA.map(f => [f.key, f.def]));
}

/* config.c parse_bool(): only the first character is inspected. */
function parseBool(v) {
  return /^[1tTyY]/.test(v);
}

/* Per-field validation, mirroring apply_kv()'s range checks. Returns an
 * error string, or null when the value would be accepted by the firmware.
 */
export function validateField(field, value) {
  if (field.type === "text") {
    const len = new TextEncoder().encode(String(value ?? "")).length;
    if (len > field.maxLength) {
      return `too long — ${len} B, firmware truncates at ${field.maxLength}`;
    }
    return null;
  }
  if (field.type === "bool") return null;

  const n = Number(value);
  if (value === "" || value === null || !Number.isFinite(n)) {
    return "not a number — firmware would fall back to the default";
  }
  if (!Number.isInteger(n)) {
    return "must be a whole number (atoi truncates)";
  }
  if (field.type === "select") {
    if (!field.options.some(o => o.value === n)) {
      return `not an allowed level — the SoftDevice would clip it silently`;
    }
    return null;
  }
  if (n < field.min || n > field.max) {
    return `out of range ${field.min}…${field.max} — firmware would ignore it ` +
           `and keep ${field.def}`;
  }
  return null;
}

/* Cross-field advisories: correct per-key, but a combination the measured
 * data says will bite. Non-blocking — these are warnings, not errors.
 */
export function advisories(values) {
  const out = [];
  const prn = Number(values.prn);
  const gap = Number(values.pkt_gap_ms);

  if (prn > 1 && gap < 35) {
    out.push(`prn=${prn} with pkt_gap_ms=${gap}: above prn=1 there is no ` +
             `mid-image resume, and the peer needs ~35–50 ms between packets. ` +
             `Measured, prn=8 failed 3 of 5 attempts. Prefer prn=1, or raise ` +
             `pkt_gap_ms to 35.`);
  }
  if (prn === 0) {
    out.push(`prn=0 removes packet receipts altogether: a dropped packet is ` +
             `only discovered when RECEIVE_FW or VALIDATE fails at the end of ` +
             `the image.`);
  }
  if (Number(values.min_rssi) === -127) {
    out.push(`min_rssi=-127 accepts any signal strength, including links too ` +
             `weak to complete a transfer.`);
  }
  return out;
}

/* Parse config.txt text into { values, unknown, ignored }.
 *
 *  values   every schema key, defaults overlaid with what the file supplied
 *  unknown  verbatim "key=value" lines this build doesn't know about, kept
 *           so a save doesn't destroy them
 *  ignored  keys present in the file whose value the firmware would reject
 *           (so the UI can say "this line is doing nothing")
 */
export function parseConfig(text) {
  const values = defaults();
  const unknown = [];
  const ignored = [];

  for (const rawLine of text.split("\n")) {
    /* config.c trims whitespace and CR, then skips blanks and #/; comments. */
    const line = rawLine.trim();
    if (line === "" || line[0] === "#" || line[0] === ";") continue;

    const eq = line.indexOf("=");
    if (eq < 0) continue;              // no '=' → config.c skips the line
    const key = line.slice(0, eq).trim();
    const val = line.slice(eq + 1).trim();

    const field = FIELDS[key];
    if (!field) { unknown.push(`${key}=${val}`); continue; }

    if (field.type === "text") {
      values[key] = val.slice(0, field.maxLength);
    } else if (field.type === "bool") {
      values[key] = parseBool(val);
    } else {
      const n = parseInt(val, 10);
      const err = validateField(field, Number.isNaN(n) ? val : n);
      if (err) {
        /* Firmware would leave the default in place — reflect that here so
         * the form shows what the device is actually running.
         */
        ignored.push({ key, value: val, reason: err });
      } else {
        values[key] = n;
      }
    }
  }
  return { values, unknown, ignored };
}

/* Render values back to config.txt.
 *
 * Deliberately terse: with a 1023-byte parse ceiling, a per-key comment
 * block would push the tail keys off the end of the buffer and silently
 * revert them to defaults.
 */
export function serializeConfig(values, unknown = []) {
  const lines = [
    "# config.txt — xiao_nrf54_updater",
    `# written by the web client ${new Date().toISOString().replace(/\.\d+Z$/, "Z")}`,
    "",
  ];
  for (const field of CONFIG_SCHEMA) {
    const v = values[field.key];
    if (field.type === "bool")      lines.push(`${field.key}=${v ? 1 : 0}`);
    else if (field.type === "text") lines.push(`${field.key}=${v ?? ""}`);
    else                            lines.push(`${field.key}=${v}`);
  }
  if (unknown.length) {
    lines.push("", "# keys this client doesn't know — preserved verbatim");
    lines.push(...unknown);
  }
  return lines.join("\n") + "\n";
}

export function encodedSize(text) {
  return new TextEncoder().encode(text).length;
}
