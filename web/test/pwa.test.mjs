/*
 * PWA wiring checks. Dependency-free — run with plain node:
 *
 *   node web/test/pwa.test.mjs
 *
 * The one that matters is the precache cross-check. sw.js lists the app shell
 * by hand, and a file left off that list is not an error anywhere: the page
 * loads fine online and simply fails to start offline, which is the one
 * condition nobody tests by accident. So walk web/ and compare.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join, relative } from "node:path";

const WEB = resolve(dirname(fileURLToPath(import.meta.url)), "..");

let bad = 0;
const t = (name, cond, extra = "") => {
  console.log(`${cond ? "  ok  " : "  FAIL"} ${name}${extra ? `  [${extra}]` : ""}`);
  if (!cond) bad++;
};

const sw = readFileSync(join(WEB, "sw.js"), "utf8");

/* --- precache list vs what actually ships ------------------------------ */

/* The list is a plain array literal; pull the quoted entries out of it
 * rather than importing sw.js, which references `self` and `caches`. */
const block = sw.match(/const PRECACHE = \[([^\]]*)\]/s);
t("sw.js declares PRECACHE", !!block);
const precache = new Set([...(block?.[1] ?? "").matchAll(/"([^"]+)"/g)].map(m => m[1]));

/* Everything under these directories is loaded by the running app. dist/,
 * test/ and tools/ are build-time only and must NOT be cached. */
const SHIPPED_DIRS = ["css", "js", "vendor", "icons"];
const shipped = [];
const walk = (dir) => {
  for (const name of readdirSync(join(WEB, dir))) {
    const rel = `${dir}/${name}`;
    if (statSync(join(WEB, rel)).isDirectory()) walk(rel);
    else if (!name.startsWith(".")) shipped.push(rel);
  }
};
for (const d of SHIPPED_DIRS) walk(d);
shipped.push("index.html", "manifest.webmanifest");

const missing = shipped.filter(f => !precache.has(f));
t("every shipped file is precached", missing.length === 0, missing.join(", "));

const stale = [...precache].filter(f => f !== "./" && !shipped.includes(f));
t("no precached file has been deleted", stale.length === 0, stale.join(", "));

t("the app shell itself is precached", precache.has("./") && precache.has("index.html"));
t("build-only directories are not precached",
  ![...precache].some(f => /^(dist|test|tools)\//.test(f)));

/* --- manifest ---------------------------------------------------------- */
const manifest = JSON.parse(readFileSync(join(WEB, "manifest.webmanifest"), "utf8"));

t("manifest has a name", !!manifest.name && !!manifest.short_name);
t("start_url and scope are relative",
  manifest.start_url === "./" && manifest.scope === "./",
  `${manifest.start_url} / ${manifest.scope}`);
t("display is standalone", manifest.display === "standalone");

/* Chrome's installability bar: an icon of at least 192px, plus a maskable
 * one so Android doesn't letterbox the mark inside its own circle. */
const sizeOf = (i) => parseInt(String(i.sizes).split("x")[0], 10);
t("has an icon >= 192px", manifest.icons.some(i => sizeOf(i) >= 192));
t("has a 512px icon",     manifest.icons.some(i => sizeOf(i) >= 512));
t("has a maskable icon",  manifest.icons.some(i => String(i.purpose).includes("maskable")));

for (const icon of manifest.icons) {
  let head = null;
  try { head = readFileSync(join(WEB, icon.src)).subarray(0, 24); } catch { /* reported below */ }
  t(`icon exists: ${icon.src}`, !!head);
  /* PNG signature, then IHDR's width/height — the declared `sizes` has to
   * match the file or Chrome ignores the icon. */
  if (head) {
    const isPng = head.subarray(0, 8).toString("hex") === "89504e470d0a1a0a";
    const w = head.readUInt32BE(16), h = head.readUInt32BE(20);
    t(`icon is a PNG of the declared size: ${icon.src}`,
      isPng && w === sizeOf(icon) && h === sizeOf(icon), `${w}x${h}`);
  }
}

/* theme_color drives the Android status bar; a mismatch with the meta tag
 * shows up as a colour change on launch. */
const index = readFileSync(join(WEB, "index.html"), "utf8");
const meta = index.match(/<meta name="theme-color" content="([^"]+)">/)?.[1];
t("index.html declares theme-color", !!meta, String(meta));
t("theme-color matches the manifest", meta === manifest.theme_color,
  `${meta} vs ${manifest.theme_color}`);
t("index.html links the manifest", /<link rel="manifest" href="manifest\.webmanifest">/.test(index));

/* --- the single-file build must not reference siblings ----------------- */
let single = null;
try { single = readFileSync(join(WEB, "dist", "updater.html"), "utf8"); } catch { /* optional */ }
if (single === null) {
  console.log("  skip  dist/updater.html not built (node web/tools/build-single.mjs)");
} else {
  /* pwa.js keys off the manifest link, so stripping it is what keeps the
   * single-file build from registering a worker it has no sw.js for. */
  /* Match the tag, not the string: pwa.js's own querySelector('link[rel=
   * "manifest"]') is bundled into the page and would match a looser test. */
  t("single-file build drops the manifest link", !/<link rel="manifest"/.test(single));
  t("single-file build drops the icon links",    !/<link rel="(apple-touch-)?icon"/.test(single));
  t("single-file build has no sibling refs",
    !/(href|src)="(?!data:|#)[^"]*\.(css|js|png|webmanifest)"/.test(single));
}

console.log(bad ? `\n${bad} FAILURES` : "\nall pwa tests passed");
process.exit(bad ? 1 : 0);
