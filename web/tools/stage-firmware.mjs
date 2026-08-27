#!/usr/bin/env node
/*
 * Stage a firmware image where the web client's "Flash newest" can find it.
 *
 *   node web/tools/stage-firmware.mjs [hexfile] [--out DIR] [--tag NAME]
 *
 * Defaults: hexfile = updater/build/merged.hex, DIR = web/firmware,
 * tag = "local".
 *
 * Writes DIR/merged.hex and DIR/manifest.json. Both CI and a local checkout
 * call this same script, so the manifest has exactly one producer — the
 * schema used to be inline shell in web.yml, which is precisely the kind of
 * second copy that drifts away from its reader.
 *
 * web/firmware/ is gitignored: the deployed copy comes from a release, and a
 * stale hex committed next to the sources would be flashed by anyone who
 * pressed the button.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, resolve, join, basename } from "node:path";
import { fileURLToPath } from "node:url";

const WEB = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = resolve(WEB, "..");

/* The exact keys FlashDialog.js reads. Exported so a test can hold the two
 * sides together. */
export const MANIFEST_KEYS = ["tag", "file", "bytes", "sha256", "published"];

export function buildManifest(bytes, { tag, file }) {
  return {
    tag,
    file,
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    published: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
  };
}

function main(argv) {
  let hex = null, out = join(WEB, "firmware"), tag = "local";
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--out") out = resolve(argv[++i]);
    else if (argv[i] === "--tag") tag = argv[++i];
    else hex = resolve(argv[i]);
  }
  hex ??= join(ROOT, "updater", "build", "merged.hex");

  if (!existsSync(hex)) {
    console.error(`error: ${hex} does not exist.`);
    console.error("Build it first:  ./build.sh   (produces updater/build/merged.hex)");
    process.exit(1);
  }

  const bytes = readFileSync(hex);
  /* Always land as merged.hex regardless of the source name: the release
   * asset is xiao_nrf54_updater-<tag>-merged.hex, and the client should not
   * have to guess a filename. The manifest names it either way. */
  const file = "merged.hex";

  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, file), bytes);
  const manifest = buildManifest(bytes, { tag, file });
  writeFileSync(join(out, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");

  console.error(`staged ${basename(hex)} -> ${join(out, file)}`);
  console.error(`  tag    ${manifest.tag}`);
  console.error(`  bytes  ${manifest.bytes}`);
  console.error(`  sha256 ${manifest.sha256}`);
}

/* Importable for tests; runs only when invoked directly. */
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}
