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
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
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

/* The staged firmware manifest moved to its own suite when it grew a board
 * dimension — see stage-firmware.test.mjs, which holds stage-firmware.mjs,
 * firmware-manifest.js and both consuming components together. */

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

/* The description is written twice — once as a meta tag for a link preview,
 * once in the manifest for the install prompt. Two copies of one sentence
 * drift, and the half that goes stale is whichever one you are not looking
 * at. Same reasoning as the theme-color check above. */
{
  const desc = index.match(/<meta name="description" content="([^"]+)">/)?.[1];
  t("index.html declares a description", !!desc);
  t("description matches the manifest", desc === manifest.description,
    `${desc} vs ${manifest.description}`);
}

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

/* --- installability ------------------------------------------------------
 *
 * "No install prompt on Android Chrome" is what an installable page looks
 * like when it ignores `beforeinstallprompt`: Chrome dropped the automatic
 * banner, so the only remaining affordance is an item in the ⋮ menu. The
 * manifest half of the criteria is checked here too, because a missing 192px
 * icon or a display mode of "browser" fails silently — the event simply never
 * fires, and there is nothing to see anywhere.
 */
{
  const mf = JSON.parse(readFileSync(join(WEB, "manifest.webmanifest"), "utf8"));
  const sizes = (mf.icons || []).map((i) => i.sizes);
  t("manifest has a name and a short_name", !!mf.name && !!mf.short_name);
  t("...a start_url and a scope", !!mf.start_url && !!mf.scope);
  t("...an installable display mode",
    ["standalone", "fullscreen", "minimal-ui"].includes(mf.display), mf.display);
  t("...a 192px icon", sizes.includes("192x192"), sizes.join(" "));
  t("...a 512px icon", sizes.includes("512x512"));
  t("...and a maskable one, or Android crops it into a circle",
    (mf.icons || []).some((i) => (i.purpose || "").split(/\s+/).includes("maskable")));
  for (const i of mf.icons || []) {
    t(`  ${i.src} exists`, existsSync(join(WEB, i.src)));
  }

  /* Chrome requires a fetch handler, not merely a registered worker. */
  t("the service worker handles fetch", /addEventListener\("fetch"/.test(sw));

  const pwa = readFileSync(join(WEB, "js", "lib", "pwa.js"), "utf8");
  t("the app captures beforeinstallprompt", /"beforeinstallprompt"/.test(pwa));
  t("...keeps the event for a later gesture", /installEvent = e/.test(pwa));
  t("...calls prompt() on it", /\be\.prompt\(\)/.test(pwa));
  t("...and drops it after one use, because it is single-use",
    /installEvent = null;\s*\n\s*e\.prompt\(\)/.test(pwa));
  t("...and stands down when the app is installed", /"appinstalled"/.test(pwa));

  const hdr = readFileSync(join(WEB, "js", "components", "AppHeader.js"), "utf8");
  t("the header offers the install only when the browser has",
    /v-if="installReady"/.test(hdr) && /@click="installApp"/.test(hdr));
}

/* --- the cache version must move when the shell does --------------------- */

/*
 * sw.js has always said "bump CACHE when anything in PRECACHE changes", and
 * that stayed a comment until it was broken in the obvious way: a component
 * was added to PRECACHE, CACHE was not bumped, and an already-installed
 * worker kept serving the shell it had. The new file was fetched from the
 * network *because it was absent from the old cache*, so it rendered — and
 * asked its cached, older Icon.js for a glyph that did not exist there yet.
 * The result was `<path d="">`: an empty SVG, no error, no warning, and the
 * text beside it updating normally.
 *
 * The shell is served cache-only precisely so that generations cannot mix
 * (see sw.js), which means nothing self-heals on a later reload either. So
 * the digest below covers every precached file's *contents*, not just the
 * list of names — a changed Icon.js has to move it, or the check is only
 * watching the half of the problem that was visible this time.
 */
{
  const { createHash } = await import("node:crypto");

  const listed = [...block[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  const h = createHash("sha256");
  for (const rel of listed.slice().sort()) {
    /* "./" is the navigation entry; it resolves to index.html, which is
       listed separately, and hashing it twice adds nothing. */
    if (rel === "./") continue;
    h.update(rel); h.update("\0");
    h.update(readFileSync(join(WEB, rel))); h.update("\0");
  }
  const want = h.digest("hex").slice(0, 16);
  const got = (sw.match(/const SHELL_DIGEST = "([0-9a-f]*)"/) || [])[1];

  t("sw.js records a shell digest", typeof got === "string" && got.length === 16);
  /* The hint is passed only on failure: this file's t() prints `extra`
   * whatever the verdict, unlike the other suites'. */
  t("...and it matches the files actually in the precache", got === want,
    got === want ? "" :
      `the shell changed — bump CACHE, then set: const SHELL_DIGEST = "${want}";`);
}

console.log(bad ? `\n${bad} FAILURES` : "\nall pwa tests passed");
process.exit(bad ? 1 : 0);
