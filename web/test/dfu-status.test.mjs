/*
 * The client's view of the DFU status record, checked against the firmware's.
 * No dependencies — run with:  node web/test/dfu-status.test.mjs
 *
 * This file exists for one failure mode: the firmware and the web client
 * disagreeing about a wire format, silently. Nothing at run time would catch
 * a state renumbered in dfu_status.h — the payload still parses, the banner
 * still renders, and it says "Validating" while the device is uploading. So
 * the enums, the constants and the service UUIDs are all read back out of
 * updater/src/dfu_status.[ch] and compared, the same way config-file.test.mjs
 * reads config.h and log-file.test.mjs reads prj.conf.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import {
  STATE, RESULT, STATE_LABEL, RESULT_LABEL, PAYLOAD_VERSION, HEADER_LEN,
  DFU_STATUS_SERVICE, DFU_STATUS_CHAR, parseDfuStatus, idleStatus,
  isActive, isTerminal,
} from "../js/lib/dfu-status.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const header = readFileSync(join(ROOT, "updater/src/dfu_status.h"), "utf8");
const source = readFileSync(join(ROOT, "updater/src/dfu_status.c"), "utf8");

let bad = 0;
const t = (name, cond, extra = "") => {
  console.log(`${cond ? "  ok  " : "  FAIL"} ${name}${cond ? "" : "  " + extra}`);
  if (!cond) bad++;
};

/* --- constants ---------------------------------------------------------- */

const define = (name) => {
  const m = header.match(new RegExp(`^#define\\s+${name}\\s+(\\d+)`, "m"));
  return m ? Number(m[1]) : null;
};

const cVersion = define("DFU_STATUS_PAYLOAD_VERSION");
const cHeaderLen = define("DFU_STATUS_HEADER_LEN");
const cNameMax = define("DFU_STATUS_NAME_MAX");
const cFileMax = define("DFU_STATUS_FILE_MAX");

t("header defines the payload version", cVersion !== null);
t("payload version agrees", cVersion === PAYLOAD_VERSION,
  `header ${cVersion}, client ${PAYLOAD_VERSION}`);
t("header length agrees", cHeaderLen === HEADER_LEN,
  `header ${cHeaderLen}, client ${HEADER_LEN}`);

/* The firmware's own buffer sizing has to hold everything it can emit. A
 * name cap raised in one constant and not the other would truncate on the
 * wire with nothing to show for it. */
t("firmware sizes its buffer for header + both names",
  /STATUS_MAX_LEN \(DFU_STATUS_HEADER_LEN \+ DFU_STATUS_NAME_MAX/.test(source) &&
  source.includes("DFU_STATUS_FILE_MAX)"),
  "STATUS_MAX_LEN in dfu_status.c");

/* --- enums -------------------------------------------------------------- */

/* Values are explicit in the header precisely so they can be read back. An
 * implicit sequence would make this test a transcription of the ordering
 * rather than a check of the numbers that go on the wire. */
function cEnum(name, prefix) {
  const body = header.match(new RegExp(`enum ${name} \\{([^}]*)\\}`, "s"))?.[1];
  if (!body) return null;
  const out = {};
  for (const line of body.split("\n")) {
    const m = line.match(new RegExp(`${prefix}([A-Z0-9_]+)\\s*=\\s*(\\d+)`));
    if (m) out[m[1]] = Number(m[2]);
  }
  return out;
}

const cState = cEnum("dfu_status_state", "DFU_STATUS_");
const cResult = cEnum("dfu_status_result", "DFU_STATUS_RESULT_");

t("parsed enum dfu_status_state", cState && Object.keys(cState).length > 5,
  JSON.stringify(cState));
t("parsed enum dfu_status_result", cResult && Object.keys(cResult).length > 5,
  JSON.stringify(cResult));

const sameMap = (a, b) =>
  JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());

t("STATE matches the firmware enum exactly", sameMap(cState, STATE),
  `firmware ${JSON.stringify(cState)} vs client ${JSON.stringify(STATE)}`);
t("RESULT matches the firmware enum exactly", sameMap(cResult, RESULT),
  `firmware ${JSON.stringify(cResult)} vs client ${JSON.stringify(RESULT)}`);

/* Every value the device can send has to render as words. A missing label
 * falls back to "state 7", which is the device speaking its own vocabulary at
 * a user — the thing this whole record exists to avoid. */
for (const [name, v] of Object.entries(STATE)) {
  t(`STATE_LABEL covers ${name}`, typeof STATE_LABEL[v] === "string" && STATE_LABEL[v]);
}
for (const [name, v] of Object.entries(RESULT)) {
  t(`RESULT_LABEL covers ${name}`,
    typeof RESULT_LABEL[v] === "string" && (v === RESULT.NONE || RESULT_LABEL[v]));
}

/* --- service UUIDs ------------------------------------------------------ */

/* BT_UUID_128_ENCODE(0x8d53dc20, 0x1db7, 0x4cd3, 0x868b, 0x8a527460aa84)
 * is the canonical 8-4-4-4-12 string with the dashes removed. */
function encodedUuids(src) {
  const out = [];
  const re = /BT_UUID_128_ENCODE\(0x([0-9a-f]{8}),\s*0x([0-9a-f]{4}),\s*0x([0-9a-f]{4}),\s*0x([0-9a-f]{4}),\s*0x([0-9a-f]{12})\)/g;
  for (const m of src.matchAll(re)) out.push(m.slice(1).join("-"));
  return out;
}
const uuids = encodedUuids(source);
t("firmware declares two UUIDs", uuids.length === 2, uuids.join(", "));
t("service UUID agrees", uuids[0] === DFU_STATUS_SERVICE,
  `firmware ${uuids[0]}, client ${DFU_STATUS_SERVICE}`);
t("characteristic UUID agrees", uuids[1] === DFU_STATUS_CHAR,
  `firmware ${uuids[1]}, client ${DFU_STATUS_CHAR}`);

/* --- the layout, built the way encode() builds it ----------------------- */

function build({
  version = PAYLOAD_VERSION, state = STATE.UPLOADING, percent = 47,
  result = RESULT.NONE, attempt = 2, retries = 5, sent = 240000,
  total = 511472, elapsedMs = 31500, target = "RAK4631_OTA",
  file = "rak4631.zip",
} = {}) {
  const enc = new TextEncoder();
  const name = enc.encode(target);
  const bundle = enc.encode(file);
  const b = new Uint8Array(HEADER_LEN + name.length + bundle.length);
  const dv = new DataView(b.buffer);
  b[0] = version; b[1] = state; b[2] = percent; b[3] = result;
  b[4] = attempt; b[5] = retries; b[6] = bundle.length; b[7] = name.length;
  dv.setUint32(8, sent, true);
  dv.setUint32(12, total, true);
  dv.setUint32(16, elapsedMs, true);
  b.set(name, HEADER_LEN);
  b.set(bundle, HEADER_LEN + name.length);
  return b;
}

const p = parseDfuStatus(build());
t("state", p.state === STATE.UPLOADING);
t("percent", p.percent === 47);
t("attempt/retries", p.attempt === 2 && p.retries === 5);
t("sent is little-endian", p.sent === 240000, String(p.sent));
t("total is little-endian", p.total === 511472, String(p.total));
t("elapsed", p.elapsedMs === 31500, String(p.elapsedMs));
t("target name", p.target === "RAK4631_OTA", p.target);
t("bundle name", p.file === "rak4631.zip", p.file);
t("uploading is active", p.active === true);
t("uploading is not terminal", p.terminal === false);

/* The two names are adjacent and length-prefixed by separate bytes. Getting
 * their order or their lengths crossed would still produce two plausible
 * strings, so assert one that is not a prefix of the other. */
const swapped = parseDfuStatus(build({ target: "AAA", file: "BBBBBB" }));
t("names do not bleed into each other",
  swapped.target === "AAA" && swapped.file === "BBBBBB",
  `${swapped.target} / ${swapped.file}`);

const empty = parseDfuStatus(build({ target: "", file: "" }));
t("empty names parse", empty.target === "" && empty.file === "");
t("a header-only payload is legal", build({ target: "", file: "" }).length === HEADER_LEN);

/* --- terminal states ---------------------------------------------------- */

const done = parseDfuStatus(build({ state: STATE.DONE, result: RESULT.OK }));
t("DONE is terminal", done.terminal === true);
t("DONE is not active", done.active === false);
t("DONE reports ok", done.ok === true);
t("DONE carries a result sentence", done.resultLabel.length > 10, done.resultLabel);

const failed = parseDfuStatus(build({ state: STATE.FAILED, result: RESULT.NO_TARGET }));
t("FAILED is terminal", failed.terminal === true);
t("FAILED is not ok", failed.ok === false);
t("a no-target failure names what to check",
  /ble_name/.test(failed.resultLabel), failed.resultLabel);

/* COOLDOWN is between attempts and the device is still working — treating it
 * as finished would hide a run that is about to retry. */
t("COOLDOWN counts as active", isActive(STATE.COOLDOWN) === true);
t("IDLE is not active", isActive(STATE.IDLE) === false);
t("DONE is not active", isActive(STATE.DONE) === false);
t("only DONE and FAILED are terminal",
  Object.values(STATE).filter(isTerminal).length === 2);

/* --- refusals ----------------------------------------------------------- */

const throws = (fn) => { try { fn(); return null; } catch (e) { return e.message; } };

const verr = throws(() => parseDfuStatus(build({ version: 2 })));
t("a future version is refused", !!verr, "parsed instead of throwing");
t("the refusal names both versions", /2/.test(verr) && /1/.test(verr), verr);

t("a truncated payload is refused",
  !!throws(() => parseDfuStatus(build().subarray(0, HEADER_LEN - 1))));
t("an empty payload is refused", !!throws(() => parseDfuStatus(new Uint8Array(0))));

/* A name length that overruns the buffer is a corrupt payload, not a reason
 * to throw: the header is what matters and a short read just means a short
 * name. Throwing here would take the banner down over a truncated ATT read. */
const short = new Uint8Array(HEADER_LEN + 2);
short[0] = PAYLOAD_VERSION; short[1] = STATE.SCANNING; short[7] = 40;
t("an over-long name_len is clamped, not fatal",
  parseDfuStatus(short).target.length === 2);

/* --- idleStatus --------------------------------------------------------- */

const idle = idleStatus();
t("idleStatus has the same shape as a parsed record",
  JSON.stringify(Object.keys(idle).sort()) === JSON.stringify(Object.keys(p).sort()),
  Object.keys(idle).join(","));
t("idleStatus is not active", idle.active === false);
t("idleStatus is not terminal", idle.terminal === false);

console.log(bad === 0 ? "\nall dfu-status tests passed" : `\n${bad} FAILED`);
process.exit(bad === 0 ? 0 : 1);
