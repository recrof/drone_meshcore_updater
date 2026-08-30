/*
 * The fsx_mgmt command table, checked against the client's copy of it.
 * No dependencies — run with:  node web/test/fsx-mgmt.test.mjs
 *
 * This file exists for one failure mode, and it is the quiet kind. The command
 * IDs are written down twice: `enum` in updater/src/fsx_mgmt.h and `FSX_ID` in
 * web/js/lib/smp-client.js. Nothing at run time reconciles them. Renumber one
 * side and the client does not fail to connect, does not log an error, and does
 * not get a wrong answer — it sends `statvfs` and the device runs `move`, or it
 * sends a command the device never registered and waits out the 15 s timeout.
 *
 * Adding STOP_DFU as ID 6 is what made this worth writing: it was the first
 * time a command was added to both files in one change, which is exactly when
 * a mismatch is easiest to introduce and hardest to notice.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { FSX_ID, GRP } from "../js/lib/smp-client.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const header = readFileSync(join(ROOT, "updater/src/fsx_mgmt.h"), "utf8");
const source = readFileSync(join(ROOT, "updater/src/fsx_mgmt.c"), "utf8");

let bad = 0;
const t = (name, cond, extra = "") => {
  console.log(`${cond ? "  ok  " : "  FAIL"} ${name}${cond ? "" : "  " + extra}`);
  if (!cond) bad++;
};

/* --- the enum, as the firmware declares it ------------------------------ */

const fw = {};
for (const m of header.matchAll(/FSX_MGMT_ID_([A-Z_]+)\s*=\s*(\d+)\s*,/g)) {
  fw[m[1]] = Number(m[2]);
}

t("firmware declares at least the six original commands",
  Object.keys(fw).length >= 6, `found ${Object.keys(fw).length}`);

/* --- both sides name the same commands ---------------------------------- */

const fwNames = Object.keys(fw).sort();
const jsNames = Object.keys(FSX_ID).sort();
t("client and firmware declare the same command names",
  JSON.stringify(fwNames) === JSON.stringify(jsNames),
  `firmware=[${fwNames}] client=[${jsNames}]`);

/* --- ...at the same numbers --------------------------------------------- */

for (const name of fwNames) {
  t(`FSX_MGMT_ID_${name} = ${fw[name]} on both sides`,
    FSX_ID[name] === fw[name], `client has ${FSX_ID[name]}`);
}

/* --- no duplicate IDs on either side ------------------------------------ */

const fwIds = Object.values(fw);
t("firmware IDs are unique", new Set(fwIds).size === fwIds.length, fwIds.join(","));
const jsIds = Object.values(FSX_ID);
t("client IDs are unique", new Set(jsIds).size === jsIds.length, jsIds.join(","));

/* --- every declared command is actually registered ----------------------
 *
 * The handler table is sparse-indexed by ID, so an enum entry with no
 * corresponding [FSX_MGMT_ID_X] = { ... } row is a command the client can send
 * and the device will answer MGMT_ERR_ENOTSUP to. Catching that here is the
 * difference between a failing test and a 15 s client timeout. */

for (const name of fwNames) {
  t(`FSX_MGMT_ID_${name} has a handler registered`,
    new RegExp(`\\[FSX_MGMT_ID_${name}\\]\\s*=`).test(source));
}

/* Each row must supply at least one of read/write, or it is registered and
 * still unusable. */
for (const m of source.matchAll(/\[FSX_MGMT_ID_([A-Z_]+)\]\s*=\s*\{([^}]*)\}/g)) {
  const body = m[2];
  const hasRead = /\.mh_read\s*=\s*(?!NULL)\w+/.test(body);
  const hasWrite = /\.mh_write\s*=\s*(?!NULL)\w+/.test(body);
  t(`FSX_MGMT_ID_${m[1]} supplies a read or a write handler`, hasRead || hasWrite);
}

/* --- the group ID -------------------------------------------------------
 *
 * The firmware writes it as a symbol, not a number:
 *
 *     #define FSX_MGMT_GROUP_ID MGMT_GROUP_ID_PERUSER
 *
 * so checking it against the client's literal 64 means resolving the symbol.
 * Zephyr's header is the authority, but it only exists after `west update` —
 * and the CI job that runs these tests is a bare checkout with no west
 * workspace. So the strong check runs when the tree is there and is skipped,
 * loudly, when it is not. The weak check runs everywhere. */

t("firmware defines FSX_MGMT_GROUP_ID as MGMT_GROUP_ID_PERUSER",
  /#define\s+FSX_MGMT_GROUP_ID\s+MGMT_GROUP_ID_PERUSER/.test(header));

const ZEPHYR_DEFS = join(ROOT, "zephyr/include/zephyr/mgmt/mcumgr/mgmt/mgmt_defines.h");
let peruser = null;
try {
  const m = readFileSync(ZEPHYR_DEFS, "utf8")
    .match(/MGMT_GROUP_ID_PERUSER\s*=\s*(\d+)/);
  if (m) peruser = Number(m[1]);
} catch { /* no west workspace — see above */ }

if (peruser === null) {
  console.log("  skip  MGMT_GROUP_ID_PERUSER lookup (no zephyr/ tree; run after `west update`)");
  t("client's GRP.FSX is the documented PERUSER base", GRP.FSX === 64, `is ${GRP.FSX}`);
} else {
  t(`MGMT_GROUP_ID_PERUSER (${peruser}) matches the client's GRP.FSX`,
    peruser === GRP.FSX, `client has ${GRP.FSX}`);
}

/* --- the registration log line counts, rather than stating, the total ----
 *
 * It used to read "(6 cmds)" as a literal and would have gone on saying so
 * after a seventh was added. */
t("the registration log line derives the command count",
  /ARRAY_SIZE\(fsx_handlers\)/.test(source));

console.log(bad === 0 ? "\nall fsx-mgmt tests passed" : `\n${bad} FAILED`);
process.exit(bad === 0 ? 0 : 1);
