/*
 * MD5, against RFC 1321's own test suite.
 *
 *   node web/test/md5.test.mjs
 *
 * Used for exactly one thing: comparing what the ESP32-S3's ROM says is in
 * flash against what we meant to put there. That makes it a *verification*
 * primitive, so it is anchored to published vectors rather than to numbers
 * this implementation produced — an implementation checked against itself
 * agrees with itself and proves nothing.
 *
 * The million-a case is the one with teeth: it is the only vector long enough
 * to exercise the 64-bit bit-count in the padding, which is the part of MD5
 * that is easy to write plausibly and wrongly.
 */
import { md5Hex } from "../js/lib/md5.js";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";

const WEB = resolve(dirname(fileURLToPath(import.meta.url)), "..");

let bad = 0;
const t = (name, ok, extra = "") => {
  console.log(`${ok ? "  ok  " : "  FAIL"} ${name}${extra ? `  [${extra}]` : ""}`);
  if (!ok) bad++;
};

const enc = (s) => new TextEncoder().encode(s);

/* RFC 1321, appendix A.5. */
const VECTORS = [
  ["", "d41d8cd98f00b204e9800998ecf8427e"],
  ["a", "0cc175b9c0f1b6a831c399e269772661"],
  ["abc", "900150983cd24fb0d6963f7d28e17f72"],
  ["message digest", "f96b697d7cb7938d525a2f31aaf161d0"],
  ["abcdefghijklmnopqrstuvwxyz", "c3fcd3d76192e4007dfb496cca67e13b"],
  ["ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789",
   "d174ab98d277d9f5a5611c2c9f419d9f"],
  ["12345678901234567890123456789012345678901234567890123456789012345678901234567890",
   "57edf4a22be3c955ac49da2e2107b67a"],
];

for (const [input, want] of VECTORS) {
  const got = md5Hex(enc(input));
  t(`RFC 1321: ${JSON.stringify(input).slice(0, 34)}`, got === want, got);
}

/* Every length either side of a block boundary. Padding is the only part of
 * MD5 that depends on length, and 55/56 is where it changes behaviour — a
 * message of 56 bytes needs a whole extra block for its own length. */
{
  const bytes = Uint8Array.from({ length: 200 }, (_, i) => i & 0xff);
  const lengths = [0, 1, 54, 55, 56, 57, 63, 64, 65, 119, 120, 128];
  const digests = new Set(lengths.map(n => md5Hex(bytes.subarray(0, n))));
  t("every length around a block boundary hashes distinctly",
    digests.size === lengths.length);
  t("all digests are 32 hex characters",
    [...digests].every(d => /^[0-9a-f]{32}$/.test(d)));
}

/* The bit-count field. Nothing this project flashes is anywhere near 512 MB,
 * but a length written into the wrong half of that field is invisible below
 * 512 KB and catastrophic above it, so it is checked once here rather than
 * discovered on an 8 MB part. */
t("the million-'a' vector, which exercises the length field",
  md5Hex(new Uint8Array(1000000).fill(0x61)) === "7707d6ae4e027c70eea2a935c2296f21");

/* --- the firmware's MD5, against the same vectors ------------------------
 *
 * updater/src/md5.c is a second implementation of the same function, and it
 * is the one that matters: ElegantOTA verifies the digest at Update.end(), so
 * a wrong one is discovered only after the entire image has been uploaded.
 *
 * It is compiled and run here rather than trusted, against the same VECTORS
 * table the JS is held to — one source of truth for what MD5 is. Skipped
 * where no compiler is available; CI runners have one.
 *
 * Writing this caught nothing in the C. It did catch a wrong expectation in
 * the throwaway harness it replaced, which had a 90-character literal where
 * RFC 1321's vector is 80 — a good argument for the table living in exactly
 * one place.
 */
{
  const { execFileSync } = await import("node:child_process");
  const { mkdtempSync, writeFileSync, existsSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");

  const SRC = resolve(WEB, "..", "updater", "src");
  let cc = null;
  for (const candidate of ["cc", "gcc", "clang"]) {
    try {
      execFileSync(candidate, ["--version"], { stdio: "ignore" });
      cc = candidate;
      break;
    } catch { /* try the next */ }
  }

  if (!cc || !existsSync(join(SRC, "md5.c"))) {
    console.log("  skip  no C compiler or no md5.c; firmware MD5 not cross-checked");
  } else {
    const dir = mkdtempSync(join(tmpdir(), "md5-"));
    const harness = join(WEB, "test", "harness", "md5-vectors.c");
    try {
      execFileSync(cc, ["-O1", "-I", SRC, "-o", join(dir, "t"),
                        harness, join(SRC, "md5.c")], { stdio: "pipe" });
      const enc = new TextEncoder();
      const input = VECTORS.map(([inp, want]) =>
        [...enc.encode(inp)].map(b => b.toString(16).padStart(2, "0")).join("") +
        "\t" + want).join("\n") + "\n";
      const out = execFileSync(join(dir, "t"), { input }).toString().trim().split("\n");
      t("the firmware MD5 ran over every vector", out.length === VECTORS.length,
        `${out.length} of ${VECTORS.length}`);
      out.forEach((line, i) => {
        t(`firmware MD5, vector ${i}`, line.startsWith("ok"), line);
      });
    } catch (e) {
      t("the firmware MD5 compiles and matches RFC 1321", false,
        (e.stderr?.toString() || e.message).slice(0, 300));
    }
  }
}

console.log(bad ? `\n${bad} FAILURES` : "\nall md5 tests passed");
process.exit(bad ? 1 : 0);
