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

const files = readdirSync(LIB).filter(f => f.endsWith(".js"));
t("found modules to check", files.length > 0, files.join(", "));

for (const file of files) {
  const src = readFileSync(join(LIB, file), "utf8");
  if (!/\bclass\s+\w/.test(src)) continue;      // plain-function modules

  const declared = new Set(INHERITED);

  /* Method and getter definitions: `foo(`, `async foo(`, `get foo(`,
   * `static foo(` at class-body indentation. */
  for (const m of src.matchAll(/^\s{2,4}(?:static\s+)?(?:async\s+)?(?:get\s+|set\s+)?([A-Za-z_$][\w$]*)\s*\(/gm)) {
    declared.add(m[1]);
  }
  /* Properties assigned anywhere, including arrow functions stored on the
   * instance (`this._onLogValue = (e) => ...`). */
  for (const m of src.matchAll(/\bthis\.([A-Za-z_$][\w$]*)\s*=/g)) {
    declared.add(m[1]);
  }

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

console.log(bad ? `\n${bad} FAILURES` : "\nall self-call checks passed");
process.exit(bad ? 1 : 0);
