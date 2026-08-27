/*
 * Intel HEX parsing + write chunking. Dependency-free:
 *
 *   node web/test/intel-hex.test.mjs
 *
 * This is the half of the USB flasher that can be tested without a probe, so
 * it is tested hard. The rest — CMSIS-DAP, SWD, RRAM — needs hardware.
 *
 * The last block cross-checks against a real merged.hex if one has been built,
 * which is the only place the browser parser and updater/tools/merge_hex.py
 * are held to the same answer.
 */
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import {
  parseIntelHex, totalBytes, lowAddress, highAddress, splitForWrite, padToWords,
} from "../js/lib/intel-hex.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

let bad = 0;
const t = (name, cond, extra = "") => {
  console.log(`${cond ? "  ok  " : "  FAIL"} ${name}${extra ? `  [${extra}]` : ""}`);
  if (!cond) bad++;
};
const throws = (name, fn, re) => {
  try { fn(); t(name, false, "did not throw"); }
  catch (e) { t(name, re.test(e.message), e.message); }
};

/* Build a record with a correct checksum, so the fixtures stay readable. */
function rec(type, addr, bytes) {
  const b = [bytes.length, (addr >> 8) & 0xff, addr & 0xff, type, ...bytes];
  const sum = (-b.reduce((a, x) => a + x, 0)) & 0xff;
  return ":" + [...b, sum].map(x => x.toString(16).padStart(2, "0")).join("").toUpperCase();
}
const EOF_REC = ":00000001FF";

/* --- basics ------------------------------------------------------------ */
{
  const hex = [rec(0x00, 0x0000, [1, 2, 3, 4]), EOF_REC].join("\n");
  const c = parseIntelHex(hex);
  t("one contiguous chunk", c.length === 1);
  t("address preserved", c[0].address === 0);
  t("bytes preserved", [...c[0].bytes].join() === "1,2,3,4");
  t("end is exclusive", c[0].end === 4);
  t("totalBytes", totalBytes(c) === 4);
}
{
  /* A gap must split, not be padded — the flasher writes only what the file
   * actually contains. */
  const hex = [rec(0x00, 0x0000, [1, 2]), rec(0x00, 0x0010, [3, 4]), EOF_REC].join("\n");
  const c = parseIntelHex(hex);
  t("a gap starts a new chunk", c.length === 2, JSON.stringify(c.map(x => x.address)));
  t("second chunk keeps its address", c[1].address === 0x10);
  t("gap is not filled", totalBytes(c) === 4);
}
{
  /* Type 04 sets the upper 16 bits — this is how anything above 64K is
   * addressed, and getting it wrong silently writes to the wrong place. */
  const hex = [
    rec(0x04, 0, [0x00, 0x01]),          // base = 0x00010000
    rec(0x00, 0x0000, [0xaa, 0xbb]),
    EOF_REC,
  ].join("\n");
  const c = parseIntelHex(hex);
  t("extended linear address applied", c[0].address === 0x10000, c[0].address.toString(16));
}
{
  const hex = [
    rec(0x02, 0, [0x10, 0x00]),          // base = 0x1000 * 16 = 0x10000
    rec(0x00, 0x0000, [0xaa]),
    EOF_REC,
  ].join("\n");
  t("extended segment address applied", parseIntelHex(hex)[0].address === 0x10000);
}
{
  const hex = [rec(0x05, 0, [0, 1, 2, 3]), rec(0x00, 0, [7]), EOF_REC].join("\n");
  t("start-address records carry no data", totalBytes(parseIntelHex(hex)) === 1);
}
{
  const hex = [rec(0x00, 0, [1]), EOF_REC, rec(0x00, 0x100, [2])].join("\n");
  t("records after EOF are ignored", totalBytes(parseIntelHex(hex)) === 1);
}
t("CRLF tolerated", totalBytes(parseIntelHex([rec(0x00, 0, [1, 2]), EOF_REC].join("\r\n"))) === 2);
t("blank lines tolerated", totalBytes(parseIntelHex(`\n${rec(0x00, 0, [1])}\n\n${EOF_REC}\n`)) === 1);

/* --- refusals ---------------------------------------------------------- */
/* :0100000001FE is the *correct* checksum for that record (-(1+0+0+0+1) & 0xff),
 * so corrupt it deliberately rather than by eye. */
throws("bad checksum rejected", () => parseIntelHex(":0100000001FF\n" + EOF_REC), /checksum/);
t("the same record with a good checksum parses",
  totalBytes(parseIntelHex(":0100000001FE\n" + EOF_REC)) === 1);
throws("missing EOF rejected", () => parseIntelHex(rec(0x00, 0, [1])), /truncated/);
throws("non-record line rejected", () => parseIntelHex("hello\n" + EOF_REC), /not an Intel HEX/);
throws("empty file rejected", () => parseIntelHex(EOF_REC), /no data/);
throws("unknown record type rejected",
  () => parseIntelHex([rec(0x07, 0, [1]), EOF_REC].join("\n")), /unsupported record type/);
throws("length byte disagreement rejected", () => parseIntelHex(":02000000010203F7\n" + EOF_REC), /length byte/);
throws("overlapping data rejected",
  () => parseIntelHex([rec(0x00, 0, [1, 2]), rec(0x00, 1, [3]), EOF_REC].join("\n")), /written twice/);

/* --- splitForWrite: the MEM-AP 1 KB auto-increment window --------------- */
{
  /* This is the one that silently corrupts memory if it is wrong: TAR
   * auto-increment wraps inside its window, so a write that runs past a
   * boundary lands back at the start of the window. */
  const chunk = { address: 0, bytes: new Uint8Array(4096), end: 4096 };
  const parts = splitForWrite([chunk], 1024, 1024);
  t("splits into window-sized pieces", parts.length === 4, String(parts.length));
  t("no piece crosses a boundary",
    parts.every(p => Math.floor(p.address / 1024) === Math.floor((p.end - 1) / 1024)));
  t("split loses nothing", totalBytes(parts) === 4096);
  t("addresses stay contiguous",
    parts.every((p, i) => p.address === i * 1024));
}
{
  /* An unaligned start must be cut short at the first boundary, not after a
   * full window. */
  const chunk = { address: 1000, bytes: new Uint8Array(100), end: 1100 };
  const parts = splitForWrite([chunk], 1024, 1024);
  t("unaligned start cut at the boundary",
    parts.length === 2 && parts[0].bytes.length === 24 && parts[1].address === 1024,
    JSON.stringify(parts.map(p => [p.address, p.bytes.length])));
}

/* --- padToWords -------------------------------------------------------- */
{
  const p = padToWords({ address: 0, bytes: Uint8Array.from([1, 2, 3]), end: 3 });
  t("pads up to a word", p.bytes.length === 4);
  t("pads with the erased value", p.bytes[3] === 0xff);
  t("keeps the data", [...p.bytes.subarray(0, 3)].join() === "1,2,3");
  const q = { address: 0, bytes: new Uint8Array(8), end: 8 };
  t("already aligned is untouched", padToWords(q) === q);
}

/* --- against a real build ---------------------------------------------- */
const merged = join(ROOT, "updater", "build", "merged.hex");
if (!existsSync(merged)) {
  console.log("  skip  updater/build/merged.hex not built (./build.sh)");
} else {
  const c = parseIntelHex(readFileSync(merged, "utf8"));
  const lo = lowAddress(c), hi = highAddress(c);
  console.log(`        merged.hex: ${totalBytes(c)} bytes, ` +
              `0x${lo.toString(16)}..0x${hi.toString(16)}, ${c.length} chunk(s)`);
  t("real image parses", totalBytes(c) > 0);
  t("starts at 0 (has a reset vector)", lo === 0, `0x${lo.toString(16)}`);
  t("reaches slot0 (has an application)", hi >= 0x10000);
  t("stays clear of storage_partition", hi < 0x1d1000, `0x${hi.toString(16)}`);
  t("every write piece is word-aligned in length",
    splitForWrite(c, 1024, 1024).map(padToWords).every(p => p.bytes.length % 4 === 0));
}

console.log(bad ? `\n${bad} FAILURES` : "\nall intel-hex tests passed");
process.exit(bad ? 1 : 0);
