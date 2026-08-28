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

/* The release firmware is staged by CI and does not exist in the repo, so it
 * must NOT be in PRECACHE — cache.addAll is atomic, and one 404 there fails
 * the install and takes the whole PWA down. It gets its own runtime cache. */
t("staged firmware is not precached",
  ![...precache].some(f => f.startsWith("firmware/")));
t("firmware has a cache that survives activate",
  /FIRMWARE_CACHE/.test(sw) && /key !== CACHE && key !== FIRMWARE_CACHE/.test(sw));
t("firmware is network-first, unlike the shell",
  /Firmware is network-first/.test(sw));

/* --- the staged firmware manifest --------------------------------------
 *
 * manifest.json is generated, never committed, so there is no fixture to
 * compare against — instead hold the producer and the consumer together:
 * every key stage-firmware.mjs writes must be a key FlashDialog.js reads,
 * and every key the dialog depends on must be one the tool emits.
 */
{
  const { buildManifest, MANIFEST_KEYS } =
    await import("../tools/stage-firmware.mjs");
  const m = buildManifest(Buffer.from(":00000001FF\n"), { tag: "v1.23", file: "merged.hex" });

  /* The hex fields are always written; the OTA ones only when a
   * dfu_application.zip exists, since a release predating MCUboot has none. */
  const REQUIRED = ["tag", "file", "bytes", "sha256", "published"];
  t("manifest always writes the required keys",
    REQUIRED.every(k => k in m), Object.keys(m).join(", "));
  t("manifest writes no undeclared keys",
    Object.keys(m).every(k => MANIFEST_KEYS.includes(k)));
  t("every required key is declared",
    REQUIRED.every(k => MANIFEST_KEYS.includes(k)));
  t("manifest carries a sha256 of the image",
    /^[0-9a-f]{64}$/.test(m.sha256), m.sha256);
  t("manifest byte count matches the image", m.bytes === 12, String(m.bytes));
  t("manifest timestamp is ISO-8601 Z",
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(m.published), m.published);

  const dfu = buildManifest(Buffer.from("x"), { tag: "v1", file: "merged.hex" },
                            { name: "dfu_application.zip", bytes: Buffer.from("yy") });
  t("manifest records the OTA image separately from the hex",
    dfu.dfu === "dfu_application.zip" && dfu.file === "merged.hex" && dfu.dfuBytes === 2);
  t("the OTA fields are optional", !("dfu" in m));
  /* The version is what the UI shows before downloading 280 KB, so it has to
   * survive into the manifest. */
  t("manifest carries the OTA image version",
    buildManifest(Buffer.from("x"), { tag: "v1", file: "merged.hex" },
                  { name: "d.zip", bytes: Buffer.from("y"), version: "1.0.0+2" })
      .dfuVersion === "1.0.0+2");
  t("manifest carries the hex image version",
    buildManifest(Buffer.from("x"), { tag: "v1", file: "merged.hex", version: "1.0.0" })
      .version === "1.0.0");

  const dialog = readFileSync(join(WEB, "js/components/FlashDialog.js"), "utf8") +
                 readFileSync(join(WEB, "js/components/BleUpdate.js"), "utf8");
  /* `file` is dereferenced to build the URL and `sha256` gates the write, so
   * those two are load-bearing rather than cosmetic. */
  for (const key of ["file", "sha256", "tag", "bytes", "published", "dfu", "dfuVersion"]) {
    t(`FlashDialog reads manifest.${key}`,
      new RegExp(`newest(\\.value)?\\.${key}\\b`).test(dialog));
  }
  t("the dialog fetches firmware/manifest.json",
    /firmware\/`?\s*\}?\s*manifest\.json|MANIFEST_URL/.test(dialog));
}
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
