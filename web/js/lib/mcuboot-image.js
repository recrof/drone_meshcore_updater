/*
 * MCUboot image headers, and the DFU zip that wraps one.
 *
 * This exists to answer one question before anything is written to the
 * device's spare slot: **is this actually an MCUboot application image?**
 *
 * The failure it prevents is specific. This project publishes two artifacts
 * that both look like "the firmware": `merged.hex` (bootloader + app, for the
 * USB flasher) and `dfu_application.zip` (the signed app, for OTA). Feeding
 * merged.hex to an image upload writes a bootloader into slot 1, MCUboot
 * finds no valid header, and the update silently does nothing — after a
 * multi-minute transfer over BLE. The header check turns that into an
 * immediate, readable refusal.
 */

/* boot/bootutil/include/bootutil/image.h */
export const IMAGE_MAGIC = 0x96f3b83d;
export const IMAGE_HEADER_SIZE = 32;

/*
 * struct image_header — little-endian throughout.
 *
 *   0  u32 ih_magic
 *   4  u32 ih_load_addr
 *   8  u16 ih_hdr_size
 *  10  u16 ih_protect_tlv_size
 *  12  u32 ih_img_size
 *  16  u32 ih_flags
 *  20  struct image_version { u8 major, u8 minor, u16 revision, u32 build }
 *  28  u32 _pad
 */
export function parseImageHeader(bytes) {
  if (bytes.length < IMAGE_HEADER_SIZE) {
    throw new Error(`too short to be an MCUboot image (${bytes.length} bytes)`);
  }
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = v.getUint32(0, true);
  if (magic !== IMAGE_MAGIC) {
    throw new Error(
      `not an MCUboot image: header magic is 0x${magic.toString(16).padStart(8, "0")}, ` +
      `expected 0x${IMAGE_MAGIC.toString(16)}. A merged.hex or a raw zephyr.bin ` +
      `will look like this — use dfu_application.zip or zephyr.signed.bin.`);
  }
  return {
    magic,
    loadAddr: v.getUint32(4, true),
    hdrSize: v.getUint16(8, true),
    protectTlvSize: v.getUint16(10, true),
    imgSize: v.getUint32(12, true),
    flags: v.getUint32(16, true),
    version: {
      major: v.getUint8(20),
      minor: v.getUint8(21),
      revision: v.getUint16(22, true),
      build: v.getUint32(24, true),
    },
  };
}

/** "1.2.3+4", or "1.2.3" when the build number is zero. */
export function versionString(h) {
  const { major, minor, revision, build } = h.version;
  return `${major}.${minor}.${revision}` + (build ? `+${build}` : "");
}

/* --- the DFU zip -------------------------------------------------------- */

const LOCAL_SIG = 0x04034b50;

/*
 * Minimal ZIP reader for what Zephyr's dfu_application.zip actually is: two
 * STORED entries, no compression, no encryption. Verified against a real
 * build — `unzip -v` reports Method=Stored for both members.
 *
 * Deliberately not a general ZIP implementation. If a future build starts
 * deflating, this throws a clear error rather than returning garbage, and the
 * fix is DecompressionStream("deflate-raw").
 */
export function readZipEntries(bytes) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const entries = [];
  let off = 0;

  while (off + 30 <= bytes.length && v.getUint32(off, true) === LOCAL_SIG) {
    const method = v.getUint16(off + 8, true);
    const compressed = v.getUint32(off + 18, true);
    const uncompressed = v.getUint32(off + 22, true);
    const nameLen = v.getUint16(off + 26, true);
    const extraLen = v.getUint16(off + 28, true);
    const nameStart = off + 30;
    const name = new TextDecoder().decode(bytes.subarray(nameStart, nameStart + nameLen));
    const dataStart = nameStart + nameLen + extraLen;

    if (method !== 0) {
      throw new Error(`${name} is compressed (method ${method}); only STORED entries are supported`);
    }
    if (dataStart + compressed > bytes.length) {
      throw new Error(`${name} runs past the end of the archive — truncated download?`);
    }
    entries.push({ name, bytes: bytes.subarray(dataStart, dataStart + compressed), size: uncompressed });
    off = dataStart + compressed;
  }

  if (!entries.length) throw new Error("not a ZIP archive, or it has no entries");
  return entries;
}

/**
 * Accept whatever the user picked and return an uploadable image.
 *
 * `dfu_application.zip` (what CI publishes) or a bare `.bin` both work; the
 * header is validated either way, so the wrong file fails here rather than
 * after a long upload.
 */
export function readUpdateImage(bytes, filename = "") {
  let image = bytes;
  let source = filename;

  const looksZip = bytes.length > 4 &&
    new DataView(bytes.buffer, bytes.byteOffset).getUint32(0, true) === LOCAL_SIG;

  if (looksZip) {
    const entries = readZipEntries(bytes);
    const bin = entries.find(e => /\.bin$/i.test(e.name));
    if (!bin) {
      throw new Error(`no .bin inside the archive (found ${entries.map(e => e.name).join(", ")})`);
    }
    image = bin.bytes;
    source = `${filename} → ${bin.name}`;
  }

  const header = parseImageHeader(image);
  return { bytes: image, header, source };
}

/*
 * Normalise a version string so the two spellings compare equal.
 *
 * imgtool (and this file) writes the build number after a "+"; mcumgr's
 * img_mgmt_ver_str() writes it after a "." and omits it entirely when zero:
 *
 *     img_mgmt_util.c:  "%hu.%hu.%hu"  then  ".%u"  if iv_build_num != 0
 *
 * So the same firmware is "1.0.0+1" in a manifest and "1.0.0.1" from the
 * device. Comparing raw strings reports a difference that is not there, which
 * would wave through exactly the identical-image upload the comparison exists
 * to prevent.
 */
export function normalizeVersion(value) {
  const raw = String(value ?? "").trim();
  const m = /^(\d+)\.(\d+)\.(\d+)(?:[.+](\d+))?$/.exec(raw);
  if (!m) return raw;
  const build = Number(m[4] ?? 0);
  return `${+m[1]}.${+m[2]}.${+m[3]}` + (build ? `+${build}` : "");
}

/** True when both name the same version, in either spelling. */
export function sameVersion(a, b) {
  if (!a || !b) return false;
  return normalizeVersion(a) === normalizeVersion(b);
}
