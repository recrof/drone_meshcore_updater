import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

const dir = new URL("../../.github/workflows/", import.meta.url);
assert.deepEqual(readdirSync(dir).filter(n => n.endsWith(".yml")).sort(), ["build.yml", "web.yml"]);
for (const name of ["build.yml", "web.yml"]) {
  const text = readFileSync(new URL(name, dir), "utf8");
  assert.match(text, /^concurrency:\s*\n(?:\s*#.*\n)*\s+group:.+\n\s+cancel-in-progress: true/m);
}
const build = readFileSync(new URL("build.yml", dir), "utf8");
assert.match(build, /^  pull_request:/m);
assert.match(build, /^  native:/m);
assert.match(build, /os: \[ubuntu-latest, macos-latest\]/);
assert.match(build, /-fsanitize=address,undefined/);
assert.match(build, /DFU_ZIP_PROBE: build_native\/firmware_zip\/firmware_zip_probe/);
assert.match(build, /node web\/test\/zip-parity.test.mjs/);
assert.match(build, /needs: \[native, build, build-esp32\]/);
assert.match(build, /needs\.native\.result == 'success'/);
for (const name of ["build", "build-esp32"]) {
  const job = build.split(`\n  ${name}:`)[1].split(/\n  [a-z][\w-]*:/)[0];
  assert.match(job, /if: github.event_name != 'pull_request'/);
}
const web = readFileSync(new URL("web.yml", dir), "utf8");
assert.match(web, /group:.*'pages'.*'web-tests-\{0\}'/);
const publishGuards = web.split("\n").filter(line => /if:.*workflow_run\.conclusion/.test(line));
assert.equal(publishGuards.length, 4);
for (const guard of publishGuards) assert.match(guard, /workflow_run\.event != 'pull_request'/);
console.log("Workflow coverage, concurrency and PR publication guards pass.");
