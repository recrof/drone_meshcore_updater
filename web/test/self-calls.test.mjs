/*
 * Static check: every `this.foo(...)` resolves to something that exists.
 *
 *   node web/test/self-calls.test.mjs
 *
 * These modules drive real hardware — Web Bluetooth, WebUSB — so jsdom cannot
 * execute them and their error paths only run when a device misbehaves. A
 * mistyped method name therefore survives every other test and surfaces as
 * "this.emit is not a function" in front of a user, which is exactly what
 * happened to SmpClient.startLogStream: it called `this.emit(...)` on a class
 * whose method is `log(...)`, on the one code path nothing else touches.
 *
 * This is deliberately crude — a regex, not a parser. It only has to catch
 * names that do not exist anywhere in the class, which is the whole failure
 * mode.
 */
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";

const WEB = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LIB = join(WEB, "js", "lib");

let bad = 0;
const t = (name, cond, extra = "") => {
  console.log(`${cond ? "  ok  " : "  FAIL"} ${name}${extra ? `  [${extra}]` : ""}`);
  if (!cond) bad++;
};

/* Inherited from EventTarget / Object, so never declared in the file. */
const INHERITED = new Set([
  "dispatchEvent", "addEventListener", "removeEventListener",
  "toString", "valueOf", "hasOwnProperty", "constructor",
]);

/* Base classes that are built in rather than imported from a sibling. A name
 * not here and not importable from js/lib/ fails, on purpose — see
 * withBases(). */
const GLOBAL_BASES = new Set(["EventTarget", "Error", "Array", "Object"]);

const files = readdirSync(LIB).filter(f => f.endsWith(".js"));
t("found modules to check", files.length > 0, files.join(", "));

/* What one file declares on `this`, ignoring inheritance. */
function declaredInFile(src) {
  const out = new Set();
  /* Method and getter definitions: `foo(`, `async foo(`, `get foo(`,
   * `static foo(` at class-body indentation. */
  for (const m of src.matchAll(/^\s{2,4}(?:static\s+)?(?:async\s+)?(?:get\s+|set\s+)?([A-Za-z_$][\w$]*)\s*\(/gm)) {
    out.add(m[1]);
  }
  /* Properties assigned anywhere, including arrow functions stored on the
   * instance (`this._onLogValue = (e) => ...`), and class fields
   * (`static PART = ...`, `#x = ...`). */
  for (const m of src.matchAll(/\bthis\.([A-Za-z_$][\w$]*)\s*=/g)) out.add(m[1]);
  for (const m of src.matchAll(/^\s{2,4}(?:static\s+)?([A-Za-z_$][\w$]*)\s*=/gm)) out.add(m[1]);
  return out;
}

/*
 * Follow `class A extends B` into the file B is imported from.
 *
 * Added when swd-target.js appeared: nrf54l-flash.js and efr32-flash.js are
 * both subclasses now, and without this every inherited call — writeWord,
 * selectAp, writeSameWord — reads as missing. That is the *right* direction
 * for this check to fail in, so it failed rather than quietly passing, but a
 * base class is not an error.
 *
 * **An unresolvable base is a failure, not a skip.** The whole value of this
 * file is that it cannot pass vacuously; silently treating an unknown parent
 * as "declares everything" would turn a real typo in a subclass into a green
 * run.
 */
function withBases(file, seen = new Set()) {
  if (seen.has(file)) return new Set();          // cycles cannot happen, but
  seen.add(file);
  const src = readFileSync(join(LIB, file), "utf8");
  const declared = declaredInFile(src);

  for (const m of src.matchAll(/\bclass\s+[A-Za-z_$][\w$]*\s+extends\s+([A-Za-z_$][\w$]*)/g)) {
    const base = m[1];
    /* Where does `base` come from? Only a sibling in js/lib/ is followable;
     * anything else (a global like EventTarget, or a cross-directory import)
     * has to be declared safe by name. */
    const imp = [...src.matchAll(/import\s*\{([^}]*)\}\s*from\s*"\.\/([\w.-]+\.js)"/g)]
      .find(i => i[1].split(",").map(x => x.trim().split(/\s+as\s+/).pop()).includes(base));
    if (imp) {
      for (const n of withBases(imp[2], seen)) declared.add(n);
    } else if (!GLOBAL_BASES.has(base)) {
      t(`${file}: base class ${base} is resolvable`, false,
        "not imported from a sibling in js/lib/, and not a known global — " +
        "this check would otherwise pass vacuously");
    }
  }
  return declared;
}

for (const file of files) {
  const src = readFileSync(join(LIB, file), "utf8");
  if (!/\bclass\s+\w/.test(src)) continue;      // plain-function modules

  const declared = new Set([...INHERITED, ...withBases(file)]);

  /* Call sites: `this.foo(` and `this.foo?.(`. */
  const called = new Map();
  for (const m of src.matchAll(/\bthis\.([A-Za-z_$][\w$]*)\s*(\?\.)?\(/g)) {
    if (!called.has(m[1])) {
      called.set(m[1], src.slice(0, m.index).split("\n").length);
    }
  }

  const missing = [...called].filter(([name]) => !declared.has(name));
  t(`${file}: every this.x() call exists`,
    missing.length === 0,
    missing.map(([n, line]) => `${n}() at line ${line}`).join(", "));
}

/* Prove the check is not vacuous: the real bug must be detectable. */
{
  const declared = new Set(["log"]);
  const src = 'class X { log(m) {} go() { this.emit("log", m); } }';
  const called = [...src.matchAll(/\bthis\.([A-Za-z_$][\w$]*)\s*(\?\.)?\(/g)].map(m => m[1]);
  t("the check would have caught this.emit()",
    called.includes("emit") && !declared.has("emit"));
}

/* --- every suite in web/test/ actually runs in CI ------------------------
 *
 * A test file nobody runs is worse than no test file: it reads as coverage on
 * the file listing, it goes green locally on the one machine that remembers
 * to run it, and it rots. Adding a suite means adding a step, and there is
 * nothing in the shape of `web/test/*.test.mjs` that makes CI notice a new
 * one — so this notices instead.
 *
 * Grepping for the filename rather than parsing the YAML on purpose: a suite
 * is "run" if the workflow mentions it at all, however it is invoked. Several
 * are run from a multi-line `run:` block rather than their own step.
 */
{
  const wf = join(WEB, "..", ".github", "workflows", "web.yml");
  let text = null;
  try { text = readFileSync(wf, "utf8"); } catch { /* not checked out */ }

  if (!text) {
    console.log("  skip  web.yml not readable; CI suite coverage not checked");
  } else {
    const suites = readdirSync(join(WEB, "test"))
      .filter(f => f.endsWith(".test.mjs")).sort();
    const missing = suites.filter(f => !text.includes(f));
    t("every test suite is run by web.yml", missing.length === 0,
      missing.join(", ") + " — add a step, or the suite only ever runs locally");
    /* And the converse: a step naming a file that no longer exists fails the
     * whole workflow on the next push, which is a worse way to find out. */
    const named = [...text.matchAll(/web\/test\/([\w.-]+\.test\.mjs)/g)].map(m => m[1]);
    const gone = [...new Set(named)].filter(f => !suites.includes(f));
    t("web.yml names no suite that has been removed", gone.length === 0, gone.join(", "));
  }
}

/* --- no backtick inside a component template ---------------------------
 *
 * Every component here writes its markup as
 *
 *     template: /* html *\/ `  ...  `
 *
 * so a stray backtick in the markup — nearly always inside an HTML comment
 * quoting a prop or a variable name — closes the literal early. The result is
 * a SyntaxError naming whatever word happened to follow it, which points at a
 * line of prose and says nothing about the real cause.
 *
 * This has now been introduced three separate times by someone writing an
 * explanatory comment, which is exactly the kind of mistake worth spending a
 * test on rather than a convention. AppHeader.js already carries a warning in
 * prose; this is the version that fails the build.
 */
{
  const dir = join(WEB, "js", "components");
  const open = /template:\s*\/\* html \*\/\s*`/;
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".js")).sort()) {
    const src = readFileSync(join(dir, f), "utf8");
    const m = open.exec(src);
    if (!m) continue;
    const body = src.slice(m.index + m[0].length);
    const end = body.indexOf("\n  `,");
    if (end < 0) {
      t(`${f}: template literal is terminated`, false, "no closing backtick found");
      continue;
    }
    const inner = body.slice(0, end);
    const at = inner.indexOf("`");
    t(`${f}: no backtick inside its template`, at < 0,
      at < 0 ? "" : "near: " + inner.slice(Math.max(0, at - 50), at + 20)
                      .replace(/\s+/g, " "));
  }
}

/*
 * --- every path a test opens, spelled the way the file is spelled ---------
 *
 * **macOS cannot catch this and CI is the first thing that can.**
 * The developer filesystem here is case-insensitive, so
 * `read("web/js/app.js")` opens `App.js` quite happily and every local run is
 * green. On the Linux runner it is ENOENT, and the suite does not fail a
 * check — it dies mid-file with a stack trace, after the passing lines have
 * already scrolled past, which reads like a broken runner rather than a typo.
 *
 * So the comparison cannot be "does this open": it has to walk the path one
 * component at a time against readdirSync() and insist on an exact match.
 * That check gives the same answer on both platforms, which is the only kind
 * worth having here.
 *
 * The repo already has this rule for a device: `config.txt` is lowercase
 * everywhere because LittleFS is case-sensitive and a mis-cased file is one
 * the firmware silently never reads. This is the same rule for the host.
 */
{
  const ROOT = resolve(WEB, "..");
  const testDir = join(WEB, "test");

  /* Any quoted string that looks like a repo-relative file. Crude on purpose,
   * in the same spirit as the regex above: a name that resolves case-exactly
   * is fine however it was written, and one that does not is the bug. */
  const CANDIDATE = /["'`]((?:\.\.?\/)?[A-Za-z0-9_./-]+\.(?:mjs|js|json|css|html|c|h|cpp|hpp|conf|dtsi|overlay|txt|yml|S))["'`]/g;

  /* Where a test's paths are resolved from: read() takes repo-relative,
   * dynamic import() takes test-relative. Try both, and only complain when a
   * path resolves under exactly one of them modulo case. */
  const BASES = [ROOT, testDir];

  const exactUnder = (base, rel) => {
    let cur = base;
    for (const part of rel.split("/")) {
      if (part === "." || part === "") continue;
      if (part === "..") { cur = dirname(cur); continue; }
      let entries;
      try { entries = readdirSync(cur); } catch { return null; }
      if (entries.includes(part)) { cur = join(cur, part); continue; }
      const near = entries.filter((e) => e.toLowerCase() === part.toLowerCase());
      return near.length ? { wrong: part, right: near[0] } : null;
    }
    return { ok: true };
  };

  /* Comments are stripped first, the same reason ble-pairing.test.mjs and
   * dfu-loop.test.mjs strip them: prose about a path is not a path. Without
   * this, the block above fails on its own worked example — which it did on
   * the first run, and is a fair demonstration that the check works. */
  const codeOf = (src) => src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

  for (const f of readdirSync(testDir).filter((n) => n.endsWith(".mjs")).sort()) {
    const src = codeOf(readFileSync(join(testDir, f), "utf8"));
    const wrong = [];
    for (const m of src.matchAll(CANDIDATE)) {
      const rel = m[1];
      const tries = BASES.map((b) => exactUnder(b, rel));
      /* Resolved exactly somewhere: fine. Nowhere at all: not a repo path
       * (a generated name, a fixture written at run time, a URL fragment) and
       * not this test's business. Only a case-near miss counts. */
      if (tries.some((r) => r && r.ok)) continue;
      const near = tries.find((r) => r && r.wrong);
      if (near) wrong.push(`${rel} -> ${near.right}`);
    }
    t(`${f}: paths match the files on a case-sensitive filesystem`,
      wrong.length === 0, wrong.join(", "));
  }
}

console.log(bad ? `\n${bad} FAILURES` : "\nall self-call checks passed");
process.exit(bad ? 1 : 0);
