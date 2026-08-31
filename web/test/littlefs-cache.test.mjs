/*
 * The littlefs cache size is one decision written in two files, and the two
 * are different settings with different jobs. Dependency-free:
 *
 *   node web/test/littlefs-cache.test.mjs
 *
 * `cache-size` in updater/common.dtsi decides how big each per-file cache is
 * — and therefore how many SPI transactions a firmware bundle costs, which is
 * the whole of this device's flash throughput. `CONFIG_FS_LITTLEFS_CACHE_SIZE`
 * in updater/prj.conf decides how much heap those caches are allocated *from*
 * (Zephyr sizes the heap to NUM_FILES blocks of that many bytes).
 *
 * Raising the devicetree alone is the dangerous direction, and it is the one
 * someone tuning throughput will reach for first. It compiles, links, boots,
 * mounts the filesystem, and then fails every fs_open() with -ENOMEM — which
 * reaches the console as
 *
 *   <inf> app_config: /lfs1/config.txt not present (rc=-12) — using defaults
 *
 * i.e. a device that appears healthy and has silently reverted to default DFU
 * tuning. That was observed on the XIAO MG24 at cache-size 512, and it is
 * exactly the class of failure this project detects rather than documents.
 *
 * Also checked: the constraints littlefs itself imposes, since violating them
 * fails at mount time on hardware and nowhere earlier.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

let bad = 0;
const t = (name, cond, extra = "") => {
  console.log(`${cond ? "  ok  " : "  FAIL"} ${name}${extra ? `  [${extra}]` : ""}`);
  if (!cond) bad++;
};

const dtsi = readFileSync(join(ROOT, "updater", "common.dtsi"), "utf8");
const prj = readFileSync(join(ROOT, "updater", "prj.conf"), "utf8");

/* Strip C comments first: both files explain these numbers at length, and the
 * explanations quote the values they reject. Matching those would make the
 * test pass or fail on prose. */
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "");

const dtProp = (name) => {
  const m = new RegExp(`^\\s*${name}\\s*=\\s*<\\s*(\\d+)\\s*>\\s*;`, "m").exec(strip(dtsi));
  return m ? Number(m[1]) : null;
};
const kconfig = (key) => {
  const m = new RegExp(`^${key}=(\\d+)\\s*$`, "m").exec(prj.replace(/^#.*$/gm, ""));
  return m ? Number(m[1]) : null;
};

const cacheDt = dtProp("cache-size");
const cacheKc = kconfig("CONFIG_FS_LITTLEFS_CACHE_SIZE");
const readSz = dtProp("read-size");
const progSz = dtProp("prog-size");
const lookahead = dtProp("lookahead-size");

t("common.dtsi declares cache-size", cacheDt !== null, String(cacheDt));
t("prj.conf declares CONFIG_FS_LITTLEFS_CACHE_SIZE", cacheKc !== null, String(cacheKc));
t("common.dtsi declares read-size", readSz !== null, String(readSz));
t("common.dtsi declares prog-size", progSz !== null, String(progSz));

/* The one that matters. */
t("devicetree cache-size == CONFIG_FS_LITTLEFS_CACHE_SIZE",
  cacheDt !== null && cacheDt === cacheKc,
  `dts ${cacheDt} vs Kconfig ${cacheKc}`);

/* littlefs's own rules (lfs.c: lfs_init asserts these). Each fails at mount,
 * on hardware, with a return code and no explanation of which rule broke. */
t("cache-size is a multiple of read-size",
  cacheDt % readSz === 0, `${cacheDt} % ${readSz}`);
t("cache-size is a multiple of prog-size",
  cacheDt % progSz === 0, `${cacheDt} % ${progSz}`);
t("lookahead-size is a multiple of 8",
  lookahead % 8 === 0, String(lookahead));

/* Every board's lfs_partition must be a whole number of cache blocks, or the
 * tail of the partition is unusable in a way nothing reports. The block size
 * is the erase-block size, which is 64 KB on the parts here; check divisibility
 * rather than the specific value so a new board does not need editing in. */
t("cache-size divides a 64 KB erase block",
  (64 * 1024) % cacheDt === 0, String(cacheDt));

/*
 * Measured floor, not a style rule. At 64 bytes the XIAO MG24 wrote a 379 KB
 * bundle at 24 KB/s and read it at 467 KB/s; at 256 it is 95 KB/s and
 * 830 KB/s. Dropping back below 256 gives up roughly 4x on the upload path
 * without anything failing, so it is worth failing here instead.
 */
t("cache-size is at least 256 (measured 4x on writes)", cacheDt >= 256, String(cacheDt));

console.log(bad ? `\n${bad} FAILED` : "\nall ok");
process.exit(bad ? 1 : 0);
