/* Compare the browser with compiled firmware_zip.c on the same bytes.
 * CI always supplies DFU_ZIP_PROBE; standalone web runs still check expected
 * browser verdicts. No firmware-source regex can substitute for this test. */
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { inspectFirmware, crc32, ZIP_NAME_MAX, ZIP_ENTRY_MAX } from "../js/lib/firmware-image.js";

const encode = s => new TextEncoder().encode(s);
const u16 = n => [n & 255, (n >>> 8) & 255];
const u32 = n => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255];
function archive(files) {
  const out = [];
  for (const [name, data] of files) {
    const n = encode(name);
    out.push(...u32(0x04034b50), ...u16(20), ...u16(0), ...u16(0), ...u32(0),
      ...u32(crc32(data)), ...u32(data.length), ...u32(data.length),
      ...u16(n.length), ...u16(0), ...n, ...data);
  }
  return Uint8Array.from([...out, ...u32(0x06054b50), ...Array(18).fill(0)]);
}
const section = (stem = "app", extra = {}) => ({ bin_file: `${stem}.bin`, dat_file: `${stem}.dat`, ...extra });
const body = [["app.bin", new Uint8Array(8)], ["app.dat", new Uint8Array(40)]];
const manifest = sections => ["manifest.json", encode(JSON.stringify({ manifest: sections }))];
const plain = [manifest({ application: section() }), ...body];
const filler = n => Array.from({ length: n }, (_, i) => [`extra${i}`, new Uint8Array()]);
const cases = [];
const add = (name, files, ok, selected = "app.bin", type = 4) =>
  cases.push({ name, bytes: archive(files), ok, selected, type });
add("application", plain, true);
add("duplicate filename keeps first entry", [...plain, ["app.bin", new Uint8Array(9)]], true);
add("32 entries", [...plain, ...filler(ZIP_ENTRY_MAX - plain.length)], true);
add("33 entries after payload", [...plain, ...filler(ZIP_ENTRY_MAX - plain.length + 1)], false);
add("33 entries before payload", [...filler(30), ...plain], false);
add("63-byte unrelated name", [...plain, ["x".repeat(ZIP_NAME_MAX - 1), new Uint8Array()]], true);
add("64-byte unrelated name", [...plain, ["x".repeat(ZIP_NAME_MAX), new Uint8Array()]], false);
add("UTF-8 byte limit", [...plain, ["é".repeat(32), new Uint8Array()]], false);
add("manifest priority ignores object order", [manifest({
  application: section(), softdevice_bootloader: section("combo", { sd_size: 4, bl_size: 4 }),
}), ...body, ["combo.bin", new Uint8Array(8)], ["combo.dat", new Uint8Array(40)]], true, "combo.bin", 3);
add("unknown section before known", [manifest({ metadata: {}, application: section() }), ...body], true);
add("unsupported combined flow", [manifest({ softdevice_bootloader_application: section() }), ...body], false);
add("overflowing integer", [manifest({ softdevice_bootloader: section("app", { sd_size: 4294967296, bl_size: 4 }) }), ...body], false);
add("fractional integer", [manifest({ softdevice_bootloader: section("app", { sd_size: 4.5, bl_size: 4 }) }), ...body], false);
for (const [name, mutate] of [
  ["STORE size mismatch", bytes => new DataView(bytes.buffer).setUint32(22, 1, true)],
  ["wrapped payload offset", bytes => new DataView(bytes.buffer).setUint32(18, 0xffffffff, true)],
  ["unknown trailing signature", bytes => new DataView(bytes.buffer).setUint32(bytes.length - 22, 0x12345678, true)],
]) {
  const bytes = archive(plain);
  mutate(bytes);
  cases.push({ name, bytes, ok: false });
}
cases.push({ name: "truncated header", bytes: Uint8Array.from([0x50, 0x4b, 3, 4, 0]), ok: false });
cases.push({ name: "truncated terminator", bytes: archive(plain).slice(0, -1), ok: false });

const probe = process.env.DFU_ZIP_PROBE && resolve(process.env.DFU_ZIP_PROBE);
const dir = mkdtempSync(join(tmpdir(), "dfu-zip-parity-"));
try {
  for (const [i, c] of cases.entries()) {
    const browser = inspectFirmware(c.bytes, { name: "fixture.zip" });
    assert.equal(browser.ok, c.ok, `${c.name}: browser ${JSON.stringify(browser.findings)}`);
    if (c.ok) {
      assert.equal(browser.details.binFile, c.selected, `${c.name}: browser selection`);
      assert.equal(browser.details.imageBytes, 8, `${c.name}: first matching image`);
    }
    if (probe) {
      const path = join(dir, `${i}.zip`);
      writeFileSync(path, c.bytes);
      const run = spawnSync(probe, [path], { encoding: "utf8" });
      assert.equal(run.status, 0, `${c.name}: native probe ${run.error ?? run.stderr}`);
      const native = JSON.parse(run.stdout);
      assert.equal(native.ok, browser.ok, `${c.name}: firmware/browser verdict drift`);
      if (c.ok) {
        assert.equal(native.binFile, browser.details.binFile, `${c.name}: firmware/browser selection drift`);
        assert.equal(native.type, c.type, `${c.name}: firmware section type`);
      }
    }
    console.log(`ok ${c.name}${probe ? " (firmware + browser)" : " (browser)"}`);
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
if (!probe) console.log("Native parity not run: set DFU_ZIP_PROBE to the built firmware_zip_probe executable.");
