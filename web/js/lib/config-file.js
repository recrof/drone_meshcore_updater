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

/* Inverse of parseMapping. Rows that are entirely blank are dropped; a row
 * with only one half filled is kept, so the editor's own validation is what
 * reports it rather than the value quietly changing under the operator.
 *
 * No spaces around the separator: firmware_map.c trims, so they would parse,
 * but the whole file has to fit 1023 bytes and this key is the longest one.
 */
export function serializeMapping(rules) {
  return (rules ?? [])
    .map(r => ({ name: String(r.name ?? "").trim(), file: String(r.file ?? "").trim() }))
    .filter(r => r.name || r.file)
    .map(r => `${r.name}:${r.file}`)
    .join("|");
}

/* config.h: the union of every radio's BLE TX ladder, because one device
 * schema serves four boards on two vendors' silicon and the ladders differ.
 *
 *   nRF54L     -40, -20, -16, -12, -8, -4, 0, 3, 6, 8
 *   Espressif  -15, -12, -9, -6, -3, 0, 3, 6, 9, 12, 15, 18, 20
 *
 * **A level in this list is not necessarily reachable on the device in front
 * of you.** An nRF part tops out at +8 and its SoftDevice clips silently;
 * Espressif's driver rounds *down* to its nearest level, so a request of 8
 * lands at 6. The firmware reads the selected level back out of the HCI
 * response and logs `requested X -> adv Y`, warning when they differ, so the
 * over-ask is reported rather than believed. Offering the union beats
 * offering the intersection: capping the list at +8 would put the ESP32's top
 * 12 dB out of reach of the only UI that sets this.
 */
export const TX_POWER_LEVELS =
  [-40, -20, -16, -15, -12, -9, -8, -6, -4, -3, 0, 3, 6, 8, 9, 12, 15, 18, 20];

/* The ESP32's WiFi ladder, in dBm. `esp_wifi_set_max_tx_power()` takes
 * quarter-dBm and rounds *down* to one of these, silently — its own docs give
 * the mapping as {8,20,28,34,44,52,56,60,66,72,80} quarter-dBm. Offering the
 * ladder rather than a free number means the value that comes back from the
 * device is the value that was asked for. */
export const WIFI_TX_POWER_LEVELS = [2, 5, 7, 8, 11, 13, 14, 15, 16, 18, 20];

/* ---- per-platform pacing defaults -------------------------------------
 *
 * Mirrors updater/src/dfu_tuning.h, which is where the reasoning lives. The
 * short version: `erase_pause_ms` is anchored to a write-completion callback
 * from the *updater's* controller, and completion does not mean the same
 * thing on every controller, so the same target needs different numbers
 * depending on which board is doing the flashing.
 *
 * Keyed on the SoC family rather than the board, for the same reason the
 * firmware is: two boards on one part share a controller and would otherwise
 * be two copies of one measurement.
 *
 * `measured` records whether the *failure boundaries* were established on
 * this platform, not whether the defaults were. Both platforms' defaults are
 * measured working points; only the nRF has had the edges mapped, and the
 * advisories below say less where less is known rather than restating the
 * nRF's numbers as though they were general.
 */
export const TUNING_PLATFORMS = {
  nordic: {
    label: "Nordic nRF5x",
    pkt_gap_ms: 4,
    erase_pause_ms: 100,
    measured: true,
    /* Uniform pacing failed at 11 ms and at 15 ms, completed at 18, all at
     * 244 B/packet. */
    uniformFloorMs: 18,
  },
  espressif: {
    label: "Espressif ESP32",
    pkt_gap_ms: 7,
    erase_pause_ms: 150,
    measured: false,
    uniformFloorMs: null,
  },
  /* The ESP32-C5 does NOT want the ESP32-S3's numbers — measured on hardware,
   * 2026-08-30: erase_pause 100 (not 150) covers the target's page erase here,
   * and the gap can come down a long way. See updater/src/dfu_tuning.h, which
   * carries the measurement and the reason this ships 4 rather than the 2 that
   * completed. Sharing a vendor is not sharing a controller's timing. */
  espressif_c5: {
    label: "Espressif ESP32-C5",
    pkt_gap_ms: 4,
    erase_pause_ms: 100,
    measured: false,
    uniformFloorMs: null,
  },
};

/* Which platform is a board target on? Derived from the target string the
 * device reports over os_mgmt ("xiao_esp32s3/esp32s3/procpu"), because that
 * is already on the wire and a new part gets classified without a firmware
 * change — an ESP32-C6 lands on `espressif` the first time one boots.
 *
 * Null for anything unrecognised, and for firmware too old to report a board
 * at all. Callers treat null as `nordic`: board reporting predates none of
 * the ESP32 work, so a device that cannot name itself is an nRF.
 */
export function platformFor(board) {
  const s = String(board ?? "");
  /* Before the general esp32 test, or the C5 inherits the S3's pacing — which
   * is measurably wrong for it. Order matters here. */
  if (/esp32c5/i.test(s)) return "espressif_c5";
  if (/esp32/i.test(s)) return "espressif";
  if (/nrf5/i.test(s)) return "nordic";
  return null;
}

export const tuningFor = (board) => TUNING_PLATFORMS[platformFor(board) ?? "nordic"];

/* The default for one field on one board. Fields without a `defByPlatform`
 * are the same everywhere, which is most of them. */
export function defFor(field, board) {
  const per = field.defByPlatform;
  if (!per) return field.def;
  return tuningFor(board)[field.key] ?? field.def;
}

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
    /* Rendered by MappingEditor rather than as a raw string. The stored type
     * is still plain text — this only tells the dialog which control to use. */
    editor: "mapping",
    desc: `Lets one updater carry several bundles and pick per target. Rules are
           "name:fileglob", separated by "|" and tried in order; the first whose
           name part appears in the peer's advertised name wins, and its glob is
           resolved against /lfs1 (if several files match, the last by name wins,
           so v2 beats v1). Only used by Auto flash — flashing a specific zip from
           the list always sends exactly that zip.`,
    check: (v) => {
      const { bad } = parseMapping(v);
      return bad.length
        ? `incomplete rule(s): ${bad.join(", ")} — each needs both a name ` +
          `fragment and a file pattern, or the firmware discards it silently`
        : null;
    },
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
    def: 32,
    min: 0,
    max: 65535,
    desc: `Firmware packets between packet-receipt notifications. Each receipt
           lets the updater compare the peer's byte count against its own and
           abort early rather than discovering a divergence at VALIDATE. It is
           not the flow control — pkt_gap_ms is — because the peer emits a
           receipt as soon as a packet is buffered, not when flash catches up.
           0 disables receipts entirely (the official app's default), leaving no
           check until the image is validated.`,
    /* Legacy DFU data packets carry no offset, so the bootloader appends
     * blindly; a dropped packet corrupts the image from that point on while
     * its byte counter keeps advancing. Only prn=1 can resume, but with
     * high_mtu off the peer's accumulator makes loss rare enough that the
     * throughput of a high cadence is the better trade.
     */
    note: (v) => {
      const n = Number(v);
      if (n === 0) return "prn=0 disables flow control entirely — no loss detection until VALIDATE fails";
      if (n === 1) return "prn=1 enables mid-image resume, but one receipt per packet is slow — prefer 300 unless a target is dropping packets";
      return "any loss aborts the attempt and retries the whole image (resume only works at prn=1)";
    },
  },
  {
    key: "wifi_ota",
    label: "wifi_ota",
    title: "Try WiFi/ElegantOTA targets",
    type: "bool",
    def: true,
    desc: `MeshCore's ESP32 repeaters do not do Bluetooth DFU at all — they
           raise a WiFi AP called MeshCore-OTA and take an upload over HTTP.
           This lets the updater try that as well as Bluetooth, and has no
           effect on hardware with no WiFi radio — which is every nRF board.
           Rarely needs changing: flashing a named file picks the transport
           from the file itself (.zip is Bluetooth, .bin is WiFi) and never
           scans for the other, and auto-flash narrows the same way from the
           mapping rules. This only decides the cases that remain genuinely
           ambiguous.`,
    note: (v) => (v
      ? "only consulted when the updater cannot tell which transport a run needs"
      : "Bluetooth only, whatever the hardware can do"),
  },
  {
    key: "pkt_gap_ms",
    label: "pkt_gap_ms",
    title: "Inter-packet gap",
    type: "int",
    /* Per platform — see TUNING_PLATFORMS. `def` is the fallback used when
     * the device has not said which board it is. */
    def: 4,
    defByPlatform: true,
    min: 0,
    max: 1000,
    unit: "ms",
    desc: `Gap after each ordinary firmware packet. With erase_pause_ms set,
           this only has to cover the target's flash write rate (~2.5 ms per
           244 B store), so it can be small. With erase_pause_ms at 0 it must
           instead cover a whole page erase, and the measured floor is 18 ms.
           Actual spacing runs ~2.7 ms above this value — that is the
           write-completion latency, and it is why 15 ms measured 17.9 and
           still failed.`,
    note: (v) => {
      const n = Number(v);
      const actual = n + 2.7;
      return `~${actual.toFixed(1)} ms per packet in practice`;
    },
  },
  {
    key: "erase_pause_ms",
    label: "erase_pause_ms",
    title: "Pause at each flash-page boundary",
    type: "int",
    def: 100,
    defByPlatform: true,
    min: 0,
    max: 1000,
    unit: "ms",
    desc: `The target erases each 4 KB page lazily, on the first write that
           touches it, and stalls for ~100 ms while it does — buffering only 8
           packets meanwhile. This waits out that stall after the one packet per
           page that triggers it, so the other ~16 can go at full speed. 0
           disables it and paces every packet as if it were the expensive one,
           which is correct but costs about half the throughput. The value
           needed is per-board: it is timed from a write-completion callback,
           and completion means something different on each controller — the
           nRF wants 100, the ESP32 wants 150 for the same target.`,
    note: (v, board) => {
      const n = Number(v);
      const p = tuningFor(board);
      if (n === 0) {
        return p.uniformFloorMs
          ? `uniform pacing — pkt_gap_ms must then be at least ${p.uniformFloorMs}`
          : "uniform pacing — the floor for it has never been measured on this board";
      }
      if (n < p.erase_pause_ms * 0.9) {
        return `${n} ms is below the ${p.erase_pause_ms} ms that works on ` +
               `${p.label}, and may not cover the target's page erase`;
      }
      return "erase-aware pacing: one expensive packet per 4 KB, the rest cheap";
    },
  },
  {
    key: "erase_inflight",
    label: "erase_inflight",
    title: "Packets sent into a page erase",
    type: "int",
    def: 0,
    min: 0,
    max: 8,
    desc: `How many packets to send during the erase before waiting out the
           rest of it. 0 stops dead at the boundary, which is safe but wasteful:
           the erase pauses measured 44% of a transfer with the target's 8-slot
           buffer sitting empty. Raising this overlaps packets with the erase.
           Measured, 6 fails every time: the ring is still draining the previous
           erase when the next begins, so the overflow lands on the second page
           and the failure point drifts. 2-3 is the usable range.`,
    note: (v) => {
      const n = Number(v);
      if (n === 0) return "no overlap — the full erase pause is dead air";
      if (n > 3) return `${n} is above the measured-safe range; 6 failed every attempt`;
      return `overlaps ${n} packet(s) with each erase`;
    },
  },
  {
    key: "high_mtu",
    label: "high_mtu",
    title: "Negotiate 247-byte MTU",
    type: "bool",
    def: true,
    desc: `Request an ATT MTU of up to 247 B instead of the 23 B default, making
           each packet 244 B. Worth having: the peer buffers one packet per slot
           during a page erase regardless of size, so large packets carry far
           more data through the same 8 slots. Some older bootloaders don't
           honour MTU exchange — turn this off if a target stalls right after
           connect.`,
    note: (v) => (v
      ? "244 B/packet — 8 pending slots hold ~1952 B across a page erase"
      : "20 B/packet — the peer's accumulator coalesces them to 240 B before flashing"),
  },
  {
    key: "ble_tx_power",
    label: "ble_tx_power",
    title: "Bluetooth transmit power",
    type: "select",
    def: 8,
    options: TX_POWER_LEVELS.map(v => ({ value: v, label: `${v > 0 ? "+" : ""}${v} dBm` })),
    desc: `Bluetooth TX power, applied to advertising, scanning and every
           connection. Only the levels listed here are implemented; the radio
           rounds anything else to a neighbour, and the boot log prints what
           it actually selected.

           More is not always better. At very short range a strong signal
           saturates the receiver and the link gets *worse*, so a target on
           the same desk may need less power rather than more. Turn it down
           before assuming the problem is distance.

           Was called \`tx_power\`. The device still accepts the old name and
           says so in its log, so an existing config.txt keeps working.`,
  },

  {
    key: "wifi_tx_power",
    label: "wifi_tx_power",
    title: "WiFi transmit power",
    type: "select",
    def: 20,
    options: WIFI_TX_POWER_LEVELS.map(v => ({ value: v, label: `+${v} dBm` })),
    desc: `WiFi TX power for the ElegantOTA transport, applied once the
           updater has joined the target's access point. The default is the
           chip's own maximum, so leaving it alone changes nothing.

           Only meaningful on a board with a WiFi radio — the nRF boards
           ignore it. The same "more is not always better" caveat applies:
           this radio and Bluetooth share one antenna, and a target a metre
           away does not need 20 dBm.`,
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
    def: 10,
    min: 0,
    max: 600,
    unit: "s",
    desc: `Pause after a response timeout, protocol error, or mid-stream link
           drop. A target that has genuinely wedged only unsticks when its own
           inactivity watchdog fires — 60–120 s on stock SDK 11-era Adafruit
           bootloaders — so raise this if failures repeat immediately. The
           default is short because most post-connect failures here are not
           wedges: the peer reboots and re-advertises within seconds, and
           waiting a minute for it wastes most of a retry budget.`,
  },
];

/* Flat key → descriptor lookup. */
export const FIELDS = Object.fromEntries(CONFIG_SCHEMA.map(f => [f.key, f]));

export function defaults(board = null) {
  return Object.fromEntries(CONFIG_SCHEMA.map(f => [f.key, defFor(f, board)]));
}

/* config.c parse_bool(): only the first character is inspected. */
function parseBool(v) {
  return /^[1tTyY]/.test(v);
}

/* Per-field validation, mirroring apply_kv()'s range checks. Returns an
 * error string, or null when the value would be accepted by the firmware.
 */
export function validateField(field, value, board = null) {
  if (field.type === "text") {
    const len = new TextEncoder().encode(String(value ?? "")).length;
    if (len > field.maxLength) {
      return `too long — ${len} B, firmware truncates at ${field.maxLength}`;
    }
    /* Structured text keys carry their own grammar. A rule the firmware
     * cannot parse is discarded silently, which is the same failure mode as
     * an out-of-range number, so it is blocked the same way. */
    return field.check ? field.check(value) : null;
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
           `and keep ${defFor(field, board)}`;
  }
  return null;
}

/* Cross-field advisories: correct per-key, but a combination the measured
 * data says will bite. Non-blocking — these are warnings, not errors.
 */
export function advisories(values, board = null) {
  const out = [];
  const prn = Number(values.prn);
  const gap = Number(values.pkt_gap_ms);
  const plat = tuningFor(board);

  /* Two regimes, and the failure mode differs between them.
   *
   * The target erases each 4 KB page on first touch (~100 ms) and buffers only
   * 8 packets meanwhile — 7 once the triggering packet takes its own slot.
   * Either wait out that erase once per page, or price every packet as though
   * it were the one that triggers it.
   *
   * The thresholds below split into two kinds, and it matters which is which:
   *
   *  - **Target properties** — the ~2.5 ms store, and so the ~3.5 ms floor
   *    under the steady send rate — hold whatever board is doing the sending.
   *    A slower controller cannot make the target's flash faster, so 3.5 ms is
   *    a floor everywhere and is applied everywhere.
   *  - **Anchored values** — anything timed from our own write-completion
   *    callback — do not transfer, because completion does not mean the same
   *    thing on every controller. Those scale off the platform's own
   *    measured-good number instead of the nRF's.
   */
  const WRITE_RATE_MS = 3.5;
  const erasePause = Number(values.erase_pause_ms);

  if (erasePause === 0) {
    if (plat.uniformFloorMs === null) {
      /* Saying "18" here would be inventing a measurement. The uniform-pacing
       * floor was established on the nRF and nowhere else; on a controller
       * that needed 50% more erase pause it is very unlikely to be smaller,
       * and there is no basis for naming a number. */
      out.push(`erase_pause_ms=0 paces every packet uniformly, and the floor ` +
               `for that has never been measured on ${plat.label} — only on ` +
               `the nRF, where it is 18 ms. Erase-aware pacing is both faster ` +
               `and the only setting this board has been tested at.`);
    } else {
      /* The 18 ms floor was measured at 244 B, where each packet is its own
       * store. Without high_mtu the target's accumulator coalesces ~12 packets
       * into one 240 B store, so each packet costs a twelfth of the ring. */
      const packetsPerStore = values.high_mtu ? 1 : 12;
      const floor = plat.uniformFloorMs / packetsPerStore;
      if (gap < floor) {
        out.push(`pkt_gap_ms=${gap} with erase_pause_ms=0 paces every packet ` +
                 `uniformly, and ${gap} ms is below the ${floor.toFixed(1)} ms ` +
                 `floor at ${values.high_mtu ? "244" : "20"} B/packet. Overflowing ` +
                 `the target's pending-write ring fails the attempt with NO_MEM, ` +
                 `or stalls the packet write outright. Setting erase_pause_ms ` +
                 `instead is roughly twice as fast.`);
      }
    }
  } else {
    if (erasePause < plat.erase_pause_ms * 0.9) {
      out.push(`erase_pause_ms=${erasePause} is below the ${plat.erase_pause_ms} ms ` +
               `that covers the target's ~100 ms page erase on ${plat.label}; the ` +
               `packets behind it would land while the ring is still full. The ` +
               `number is larger than the erase because it is timed from a ` +
               `write-completion callback, not from the wire.`);
    }
    if (Number(values.erase_inflight) > 3) {
      out.push(`erase_inflight=${values.erase_inflight} is above the measured ` +
               `safe range. The ring is still draining the previous erase when ` +
               `the next one starts, so it holds fewer than its 8 slots suggest ` +
               `— 6 failed every attempt, on the second page.`);
    }
    if (gap + 0.5 < WRITE_RATE_MS) {
      out.push(`pkt_gap_ms=${gap} sends the cheap packets faster than the ` +
               `target writes them (~${WRITE_RATE_MS} ms per 244 B store), so ` +
               `the ring fills gradually across each page.`);
    } else if (!plat.measured && gap < plat.pkt_gap_ms) {
      /* Above the target's own floor, so not wrong — but on this platform the
       * only thing known is the working point, and where it stops working has
       * never been found. Say exactly that. */
      out.push(`pkt_gap_ms=${gap} is below the ${plat.pkt_gap_ms} ms measured ` +
               `good on ${plat.label}. Lower values are untested there rather ` +
               `than known bad, and the failure would be a mid-image NO_MEM.`);
    }
  }

  /* Auto-flash across two transports.
   *
   * Mirrors mapping_kind_mask() in dfu_runner.c, which does the same
   * classification for real: a rule whose pattern ends .zip can only be a
   * Bluetooth job, .bin can only be WiFi, and anything else could be either.
   *
   * The firmware is the authority — this only decides whether to say
   * something. When the rules span both, auto-flash cannot know which kind of
   * target it is looking for until it has found one, so every scan cycle has
   * to try Bluetooth *and* attempt a WiFi association. On a board with one
   * 2.4 GHz radio that is not two searches in parallel; it is two searches in
   * turn, each slower for the other's presence.
   */
  const patterns = String(values.ble_firmware_mapping ?? "")
    .split("|").map(r => r.split(":").slice(1).join(":").trim()).filter(Boolean);
  if (patterns.length) {
    const zip = patterns.some(p => /\.zip$/i.test(p));
    const raw = patterns.some(p => /\.bin$/i.test(p));
    const vague = patterns.filter(p => !/\.(zip|bin)$/i.test(p));

    if (zip && raw) {
      out.push(`ble_firmware_mapping names both .zip and .bin bundles, so ` +
               `auto-flash has to look for a Bluetooth target and a WiFi one ` +
               `on every cycle — it cannot tell which it needs until it finds ` +
               `something. One radio serves both, so the two searches take ` +
               `turns and each scan gets slower. Prefer one updater per ` +
               `target family, or flash a specific file instead of ` +
               `auto-flashing.`);
    }
    if (vague.length) {
      out.push(`ble_firmware_mapping rule${vague.length > 1 ? "s" : ""} ` +
               `${vague.map(p => `"${p}"`).join(", ")} do not end in .zip or ` +
               `.bin, so the updater cannot tell which transport they need ` +
               `and has to try both. Ending the pattern in an extension lets ` +
               `it skip the one that cannot apply.`);
    }
  }

  if (prn === 1) {
    out.push(`prn=1 requests a receipt for every packet — it enables mid-image ` +
             `resume but adds a round-trip per packet. Receipts are not what ` +
             `protects the peer's buffer; pkt_gap_ms is.`);
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
export function parseConfig(text, board = null) {
  const values = defaults(board);
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
    "# config.txt — drone_meshcore_updater",
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
