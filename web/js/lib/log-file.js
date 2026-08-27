/*
 * /lfs1/LOG.NNNN — recognising and rendering the firmware's log files.
 *
 * Mirrors CONFIG_LOG_BACKEND_FS_DIR + CONFIG_LOG_BACKEND_FS_FILE_PREFIX in
 * updater/prj.conf, and log_backend_fs.c's own naming:
 *
 *     snprintf(buf, len, "%s/%s%04d", DIR, FILE_PREFIX, num);
 *
 * The prefix is a FILE NAME, not a path. Getting that wrong is Trap 5 — it
 * produced "/lfs1//lfs1/LOG0000" and meant no log was ever written, silently.
 * log-file.test.mjs reads both values back out of prj.conf and fails if this
 * file disagrees, because a client that looks for the wrong name just shows
 * an empty list and blames the device.
 */

export const LOG_DIR = "/lfs1";
export const LOG_PREFIX = "LOG.";

/* log_backend_fs.c formats the index with %04d. */
const LOG_RE = new RegExp(`^${LOG_DIR}/${LOG_PREFIX.replace(".", "\\.")}(\\d{4})$`);

/** Is this the full path of a firmware log file? */
export const isLogPath = (p) => LOG_RE.test(p);

/** Its rotation index, or -1. Files are numbered in the order written. */
export function logIndex(p) {
  const m = LOG_RE.exec(p);
  return m ? parseInt(m[1], 10) : -1;
}

export const logName = (index) =>
  `${LOG_DIR}/${LOG_PREFIX}${String(index).padStart(4, "0")}`;

/*
 * Zephyr's text log format:
 *
 *   [00:01:23.456,789] <inf> module_name: the message
 *
 * The level tag is what makes a long log readable at a glance, so it is worth
 * pulling out. Anything unparsed is kept verbatim rather than dropped — a
 * truncated tail or a raw printk is exactly when you most want to see it.
 */
const LINE_RE = /^\[([0-9:.,]+)\]\s+<(err|wrn|inf|dbg)>\s+([^:]+):\s?([\s\S]*)$/;

export const LEVELS = ["err", "wrn", "inf", "dbg"];

export function parseLogLine(raw) {
  const m = LINE_RE.exec(raw);
  if (!m) return { ts: "", level: "", module: "", msg: raw, raw };
  return { ts: m[1], level: m[2], module: m[3], msg: m[4], raw };
}

/** Split a log file into parsed lines, dropping a trailing empty line. */
export function parseLog(text) {
  const lines = text.split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines.map((raw, i) => ({ id: i, ...parseLogLine(raw) }));
}

/**
 * Filter by level and substring.
 *
 * `minLevel` is inclusive and ordered err < wrn < inf < dbg, so "wrn" shows
 * warnings and errors. Lines with no recognised level always pass: they are
 * usually the interesting ones (faults, raw output, a truncated tail).
 */
export function filterLog(lines, { minLevel = "dbg", text = "" } = {}) {
  const cap = LEVELS.indexOf(minLevel);
  const needle = text.trim().toLowerCase();
  return lines.filter((l) => {
    if (l.level && cap >= 0 && LEVELS.indexOf(l.level) > cap) return false;
    return !needle || l.raw.toLowerCase().includes(needle);
  });
}

/** Per-level counts, for the summary line. */
export function levelCounts(lines) {
  const out = { err: 0, wrn: 0, inf: 0, dbg: 0, other: 0 };
  for (const l of lines) out[l.level || "other"]++;
  return out;
}
