/*
 * The two GitHub Actions workflows, held to the properties that fail silently.
 *
 *   node web/test/workflows.test.mjs
 *
 * Dependency-free, so the YAML is read with anchored regexes rather than a
 * parser — the same way stage-firmware.test.mjs already reads build.yml.
 *
 * Every assertion here exists because the v2.3 release produced four runs and
 * one useful one. What made that expensive is that none of the three defects
 * announced itself:
 *
 *   - a Web client run fired by a *cancelled* firmware build ran the whole
 *     test suite, skipped every deploy step on a condition twenty steps
 *     later, and finished **green** while publishing nothing;
 *   - the real deploy was cancelled 44 s in because a test-only run held the
 *     same `pages` concurrency slot;
 *   - and the release's draft state was inferred from `github.event_name`,
 *     which is a coin toss, because publishing a release fires `push` and
 *     `release` in the same second.
 *
 * A green run that deploys nothing is the shape this file is guarding: there
 * is no failing step to notice, so only an assertion about the *conditions*
 * can see it.
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

const web = readFileSync(join(ROOT, ".github/workflows/web.yml"), "utf8");
const build = readFileSync(join(ROOT, ".github/workflows/build.yml"), "utf8");

/* --- a small evaluator for the GitHub expression subset used here -------
 *
 * Asserting that a condition *mentions* `workflow_run.conclusion` is the
 * mistake Trap 10 records — naming a function is not exercising it. The
 * realistic bug in a `((A || B) && 'pages' || format(...))` group is operator
 * precedence, which no substring check can see and which silently puts a
 * test-only run back in the deploy slot. So the expressions are evaluated.
 *
 * `&&`, `||`, `==`, `!=`, `!` and parentheses have JS semantics for these
 * operand types, so the expression body is evaluated as JS with `github` and
 * `format` in scope.
 */
const evalExpr = (expr, github) => {
  const format = (fmt, ...args) => fmt.replace(/\{(\d+)\}/g, (_, i) => String(args[i]));
  // eslint-disable-next-line no-new-func
  return new Function("github", "format", `"use strict"; return (${expr});`)(github, format);
};

const ctx = (event_name, extra = {}) => ({
  event_name,
  ref: extra.ref ?? "refs/heads/main",
  event: { workflow_run: extra.conclusion ? { conclusion: extra.conclusion } : {} },
});

const unwrap = (s) => {
  const m = /^\s*\$\{\{([\s\S]*)\}\}\s*$/.exec(s.trim());
  return m ? m[1].trim() : null;
};

/* Pull a `key:` out of a named job block, where the job is at two spaces and
 * its keys at four. */
const jobKey = (yaml, job, key) => {
  /* `\Z` is not a JS anchor — it matches a literal Z — so the last job in a
   * file would silently extract nothing. A sentinel gives every block a
   * terminator. */
  const block = new RegExp(`^  ${job}:\\n([\\s\\S]*?)(?=^  \\S)`, "m").exec(yaml + "\n  ~:\n");
  if (!block) return null;
  const m = new RegExp(`^    ${key}:\\s*(.+)$`, "m").exec(block[1]);
  return m ? m[1].trim() : null;
};

/* --- web.yml: the pages concurrency group ------------------------------ */
{
  const g = /^concurrency:\n(?:\s*#.*\n)*\s+group:\s*(.+)$/m.exec(web);
  t("web.yml declares a concurrency group", !!g);

  if (g) {
    const expr = unwrap(g[1]);
    t("the group is an expression, not the bare `pages` literal", expr !== null,
      g[1].trim());

    if (expr) {
      const group = (name, extra) => evalExpr(expr, ctx(name, extra));

      /* The two runs that deploy must share one slot: GitHub Pages cannot
       * publish two deployments at once, so the newer must cancel the older. */
      t("a successful firmware build takes the pages slot",
        group("workflow_run", { conclusion: "success" }) === "pages");
      t("a manual dispatch takes the pages slot",
        group("workflow_dispatch") === "pages");

      /* And nothing else may, or it cancels a deploy that was about to work.
       * This is what killed run 33644728309. */
      for (const [name, extra] of [
        ["push", {}],
        ["pull_request", { ref: "refs/pull/7/merge" }],
        ["workflow_run", { conclusion: "cancelled" }],
        ["workflow_run", { conclusion: "failure" }],
      ]) {
        const got = group(name, extra);
        t(`a ${name}${extra.conclusion ? ` (${extra.conclusion})` : ""} run cannot cancel a deploy`,
          got !== "pages" && typeof got === "string" && got.length > 0, String(got));
      }

      /* Distinct refs must not collapse into each other, or a PR cancels a
       * push to main for no reason. */
      t("test-only runs are keyed on their own ref",
        evalExpr(expr, ctx("push", { ref: "refs/heads/main" })) !==
        evalExpr(expr, ctx("pull_request", { ref: "refs/pull/7/merge" })));

      /* ...and on their event. A `workflow_run` that skips because the build
       * did not succeed is still a run on `main`: keyed on the ref alone it
       * would cancel an in-flight push-to-main test run on its way past. */
      t("a skipped workflow_run does not share a slot with a push to main",
        group("workflow_run", { conclusion: "cancelled" }) !== group("push"));
    }
  }
}

/* --- web.yml: the two jobs' conditions --------------------------------- */
{
  const tif = jobKey(web, "test", "if");
  t("the test job is gated", !!tif);
  if (tif) {
    const on = (name, extra) => !!evalExpr(unwrap(tif) ?? tif, ctx(name, extra));

    /* The whole point: a build that did not succeed must not produce a run
     * that tests, skips the deploy and reports success. */
    t("a cancelled firmware build does not run the test job",
      !on("workflow_run", { conclusion: "cancelled" }));
    t("a failed firmware build does not run the test job",
      !on("workflow_run", { conclusion: "failure" }));

    /* ...but pushes and PRs must still be tested. Losing that to remove a
     * redundant deploy would be the bad half of the trade. */
    t("a push to main still runs the tests", on("push"));
    t("a pull request still runs the tests", on("pull_request"));
    t("a successful firmware build runs the tests",
      on("workflow_run", { conclusion: "success" }));
    t("a manual dispatch runs the tests", on("workflow_dispatch"));
  }

  const dif = jobKey(web, "deploy", "if");
  t("the deploy job is gated", !!dif);
  if (dif) {
    const on = (name, extra) => !!evalExpr(unwrap(dif) ?? dif, ctx(name, extra));
    t("deploy runs after a successful firmware build",
      on("workflow_run", { conclusion: "success" }));
    t("deploy runs on a manual dispatch", on("workflow_dispatch"));
    t("deploy does not run on a push", !on("push"));
    t("deploy does not run on a pull request", !on("pull_request"));
    t("deploy does not run after a cancelled build",
      !on("workflow_run", { conclusion: "cancelled" }));
  }

  t("deploy waits for the tests", /^  deploy:\n(?:.*\n)*?    needs: test$/m.test(web));
}

/* --- the workflow_run trigger names the build workflow exactly ---------- */
{
  const name = /^name:\s*(.+)$/m.exec(build)?.[1].trim();
  const wanted = /^\s+workflows:\s*\[(.+)\]$/m.exec(web)?.[1].trim().replace(/^["']|["']$/g, "");
  t("web.yml waits on the workflow build.yml actually declares",
    !!name && name === wanted, `${wanted} vs ${name}`);
}

/* --- build.yml: both release triggers stay ----------------------------- */
{
  /* Neither is redundant, and the file's own comment was wrong about why for
   * six releases. `release` alone misses `git push --tags`; `push` alone
   * misses a release cut from a tag already on the remote, which is exactly
   * how v1.1 failed to build. */
  t("build.yml still builds on a tag push", /^  push:\n\s+tags:/m.test(build));
  t("build.yml still builds on a published release",
    /^  release:\n\s+types:\s*\[published\]/m.test(build));
}

/* --- build.yml: the draft state is asked, not inferred ------------------ */
{
  const step = /- name: Attach artifacts to the release\n([\s\S]*?)(?=\n\s*- name:)/.exec(build + "\n      - name: ~");
  t("build.yml attaches artifacts to the release", !!step);

  if (step) {
    const draft = /^\s+draft:\s*(.+)$/m.exec(step[1])?.[1].trim();
    t("the attach step sets a draft state", !!draft, String(draft));

    /* The defect: `github.event_name != 'release'` reads as "a push means the
     * release does not exist yet". It does not, because publishing a release
     * whose tag is new fires both events in the same second and the survivor
     * is arbitrary — so half of all releases so far were patched with
     * draft:true while already published. */
    t("draft is not inferred from the triggering event",
      !!draft && !/github\.event_name/.test(draft), String(draft));
    t("draft comes from a step that looked the release up",
      !!draft && /^\$\{\{\s*steps\.\w+\.outputs\.\w+\s*\}\}$/.test(draft), String(draft));
  }

  const lookup = /- name: Decide the release's draft state\n([\s\S]*?)(?=\n\s*- name:)/.exec(build + "\n      - name: ~");
  t("build.yml queries the release's current draft state", !!lookup);
  if (lookup) {
    t("...via `gh release view --json isDraft`",
      /gh release view[\s\S]*isDraft/.test(lookup[1]));
    t("...and defaults to a draft when the release does not exist yet",
      /state=true/.test(lookup[1]));
    t("...writing the answer to a step output",
      /draft=\$\{state\}"?\s*>>\s*"?\$GITHUB_OUTPUT/.test(lookup[1]));
  }
}

/* --- build.yml: the toolchain must hand git back before the post steps ---
 *
 * `Put the toolchain on PATH` exports PATH through $GITHUB_ENV, which reaches
 * node actions and post steps too — so actions/checkout's cleanup resolved
 * Nordic's git, which has no `git-submodule`, threw, and aborted `removeAuth()`
 * before it reached `removeToken()`. The last step hands `/usr/bin` back.
 *
 * The regression is a step appended after it, which is invisible: the build
 * still passes and the warning simply returns. So the assertion is about
 * *position*, not presence.
 */
{
  const job = /^  build:\n([\s\S]*?)(?=^  \S)/m.exec(build + "\n  ~:\n")?.[1] ?? "";
  const steps = [...job.matchAll(/^      - (?:name: (.+)|uses: (.+))$/gm)]
    .map(m => (m[1] ?? m[2]).trim());

  t("the container job still exports the toolchain PATH",
    /echo "PATH=\$PATH" >> "\$GITHUB_ENV"/.test(job));
  t("...and hands /usr/bin back afterwards",
    /echo "PATH=\/usr\/bin:\$PATH" >> "\$GITHUB_ENV"/.test(job));

  const idx = steps.findIndex(n => /Hand git back/.test(n));
  t("the handback step exists", idx >= 0);
  t("the handback step is the last step in the job", idx === steps.length - 1,
    idx < 0 ? "absent" : `step ${idx + 1} of ${steps.length}: ${steps[steps.length - 1]}`);

  /* A failed build still runs the cleanup, and a spurious warning is worst on
   * the run someone is actually reading. */
  const hb = /- name: Hand git back[\s\S]*?\n((?:        .*\n)+)/.exec(job + "\n");
  t("the handback runs even when the build failed",
    !!hb && /^\s+if: always\(\)$/m.test(hb[1]));
}

console.log(bad ? `\n${bad} FAILURES` : "\nall workflow tests passed");
process.exit(bad ? 1 : 0);
