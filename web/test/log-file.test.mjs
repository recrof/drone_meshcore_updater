/*
 * Log file naming + parsing. Dependency-free:
 *
 *   node web/test/log-file.test.mjs
 *
 * The load-bearing part is the cross-check against updater/prj.conf. A client
 * that looks for the wrong file name shows an empty list and blames the
 * device — the same silent-disagreement failure the config.txt path test
 * exists to prevent, and the same one that made Trap 5 invisible for months.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import {
  LOG_DIR, LOG_PREFIX, isLogPath, logIndex, logName,
  parseLogLine, parseLog, filterLog, levelCounts, LEVELS,
  createLineAssembler,
} from "../js/lib/log-file.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

let bad = 0;
const t = (name, cond, extra = "") => {
  console.log(`${cond ? "  ok  " : "  FAIL"} ${name}${extra ? `  [${extra}]` : ""}`);
  if (!cond) bad++;
};

/* --- agreement with the firmware --------------------------------------- */
{
  const prj = readFileSync(join(ROOT, "updater", "prj.conf"), "utf8");
  const val = (key) => {
    const m = new RegExp(`^${key}="([^"]*)"`, "m").exec(prj);
    return m ? m[1] : null;
  };
  const dir = val("CONFIG_LOG_BACKEND_FS_DIR");
  const prefix = val("CONFIG_LOG_BACKEND_FS_FILE_PREFIX");

  t("prj.conf sets the log directory", dir !== null, String(dir));
  t("prj.conf sets the log file prefix", prefix !== null, String(prefix));
  t("client agrees with CONFIG_LOG_BACKEND_FS_DIR", LOG_DIR === dir, `${LOG_DIR} vs ${dir}`);
  t("client agrees with CONFIG_LOG_BACKEND_FS_FILE_PREFIX",
    LOG_PREFIX === prefix, `${LOG_PREFIX} vs ${prefix}`);

  /* Trap 5: the prefix is a file NAME. log_backend_fs.c builds
   * "<DIR>/<PREFIX><NNNN>", so a '/' in the prefix yields a path under a
   * directory that does not exist and nothing is ever logged. */
  t("prefix contains no path separator — Trap 5",
    prefix !== null && !prefix.includes("/"), String(prefix));
  t("directory is the LittleFS mount point", dir === "/lfs1", String(dir));
}

/* --- path shape --------------------------------------------------------- */
t("matches the first log file", isLogPath("/lfs1/LOG.0000"));
t("matches a rotated file",     isLogPath("/lfs1/LOG.0002"));
t("rejects LOG.TXT (what the README used to promise)", !isLogPath("/lfs1/LOG.TXT"));
t("rejects a 3-digit index",    !isLogPath("/lfs1/LOG.000"));
t("rejects a 5-digit index",    !isLogPath("/lfs1/LOG.00000"));
t("rejects a bare file name",   !isLogPath("LOG.0000"));
t("rejects another directory",  !isLogPath("/lfs1/logs/LOG.0000"));
t("rejects config.txt",         !isLogPath("/lfs1/config.txt"));
t("rejects a lowercase prefix", !isLogPath("/lfs1/log.0000"));

t("index parses", logIndex("/lfs1/LOG.0007") === 7);
t("index of a non-log is -1", logIndex("/lfs1/config.txt") === -1);
t("logName round-trips", logName(2) === "/lfs1/LOG.0002" && isLogPath(logName(2)));
t("logName pads to four digits", logName(0) === "/lfs1/LOG.0000");

/* Rotation order: the backend numbers files in write order, so ascending
 * index is chronological and the viewer must not sort them as strings only
 * by accident. */
{
  const shuffled = ["/lfs1/LOG.0002", "/lfs1/LOG.0000", "/lfs1/LOG.0001"];
  const sorted = [...shuffled].sort((a, b) => logIndex(a) - logIndex(b));
  t("files sort oldest-first by index",
    sorted.join() === "/lfs1/LOG.0000,/lfs1/LOG.0001,/lfs1/LOG.0002");
}

/* --- line parsing ------------------------------------------------------- */
{
  const l = parseLogLine("[00:01:23.456,789] <inf> dfu_client: interval=7.500 ms");
  t("timestamp extracted", l.ts === "00:01:23.456,789", l.ts);
  t("level extracted",     l.level === "inf", l.level);
  t("module extracted",    l.module === "dfu_client", l.module);
  t("message extracted",   l.msg === "interval=7.500 ms", l.msg);
}
{
  /* A message containing a colon must not be re-split — plenty do. */
  const l = parseLogLine("[00:00:00.001,000] <err> fs: file open error (-2)");
  t("splits on the first colon after the module",
    l.module === "fs" && l.msg === "file open error (-2)", `${l.module} | ${l.msg}`);
}
for (const lvl of LEVELS) {
  t(`recognises <${lvl}>`, parseLogLine(`[00:00:00.000,000] <${lvl}> m: x`).level === lvl);
}
{
  /* Unparsed lines are kept verbatim: a fault dump or a truncated tail is
   * usually the line you opened the log to find. */
  const l = parseLogLine("*** Booting Zephyr OS build v3.4.0 ***");
  t("keeps an unparsed line", l.msg === "*** Booting Zephyr OS build v3.4.0 ***");
  t("unparsed line has no level", l.level === "");
}

{
  const text = "[00:00:00.000,000] <inf> a: one\n" +
               "[00:00:00.001,000] <err> b: two\n" +
               "[00:00:00.002,000] <dbg> c: three\n";
  const lines = parseLog(text);
  t("parses every line", lines.length === 3, String(lines.length));
  t("drops the trailing blank", lines[2].msg === "three");

  const counts = levelCounts(lines);
  t("counts levels", counts.inf === 1 && counts.err === 1 && counts.dbg === 1,
    JSON.stringify(counts));

  t("filter to errors only", filterLog(lines, { minLevel: "err" }).length === 1);
  t("filter to warnings and above keeps errors",
    filterLog(lines, { minLevel: "wrn" }).length === 1);
  t("filter to info and above drops debug",
    filterLog(lines, { minLevel: "inf" }).length === 2);
  t("everything shows everything", filterLog(lines, { minLevel: "dbg" }).length === 3);

  t("text filter matches the message", filterLog(lines, { text: "two" }).length === 1);
  t("text filter matches the module",  filterLog(lines, { text: "c:" }).length === 1);
  t("text filter is case-insensitive", filterLog(lines, { text: "TWO" }).length === 1);
  t("empty filter passes everything",  filterLog(lines, { text: "  " }).length === 3);

  /* An unparsed line has no level and must survive level filtering — it is
   * exactly the line a level filter would otherwise hide. */
  const withRaw = parseLog(text + "ZEPHYR FATAL ERROR\n");
  t("level filter keeps unparsed lines",
    filterLog(withRaw, { minLevel: "err" }).some(l => l.msg === "ZEPHYR FATAL ERROR"));
}

/* --- notification reassembly -------------------------------------------
 *
 * log_stream.c drains its ring into notifications sized to the ATT payload,
 * with no regard for line boundaries — so a notification routinely ends
 * mid-line. Getting this wrong shows half a line and then a line that starts
 * in the middle, which looks like corrupted firmware output rather than a
 * client bug.
 */
{
  const asm = createLineAssembler();
  t("a whole line in one chunk",
    asm.push("hello\n").join("|") === "hello");
  t("nothing emitted for a partial line", asm.push("wor").length === 0);
  t("the partial is held", asm.pending() === "wor");
  t("the rest completes it", asm.push("ld\n").join("|") === "world");
  t("buffer is empty again", asm.pending() === "");

  t("several lines in one chunk",
    asm.push("a\nb\nc\n").join("|") === "a|b|c");
  t("trailing partial after several lines",
    asm.push("d\ne\nf").join("|") === "d|e");
  t("f is still pending", asm.pending() === "f");
  t("flush emits the tail", asm.flush().join("|") === "f");
  t("flush empties the buffer", asm.pending() === "" && asm.flush().length === 0);
}
{
  /* A line split at every possible offset must reassemble identically. */
  const src = "[00:00:01.000,000] <inf> dfu: 40% (204800/511472)\n" +
              "[00:00:01.500,000] <wrn> dfu: 6 TX-buffer retries\n";
  for (let cut = 1; cut < src.length; cut++) {
    const asm = createLineAssembler();
    const got = [...asm.push(src.slice(0, cut)), ...asm.push(src.slice(cut))];
    if (got.join("\n") !== src.trimEnd()) {
      t(`reassembles across a split at ${cut}`, false, JSON.stringify(got));
      break;
    }
    if (cut === src.length - 1) t("reassembles across every possible split", true);
  }
}
{
  /* An empty line is a line — blank separators appear in Zephyr output and
   * dropping them would silently reflow the log. */
  const asm = createLineAssembler();
  t("blank lines survive", asm.push("a\n\nb\n").join("|") === "a||b");
}
{
  /* Byte-level splitting means a multi-byte character can straddle two
   * notifications. The client decodes with fatal:false, so the halves arrive
   * as replacement characters rather than throwing — assert we still frame
   * the lines correctly around them. */
  const asm = createLineAssembler();
  t("framing survives a replacement character",
    asm.push("ok \uFFFD").length === 0 && asm.push("\uFFFD done\n").join("|") === "ok \uFFFD\uFFFD done");
}

console.log(bad ? `\n${bad} FAILURES` : "\nall log-file tests passed");
process.exit(bad ? 1 : 0);
