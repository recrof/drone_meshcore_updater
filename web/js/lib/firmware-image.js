/*
 * What is this firmware file, is it intact, and can this device flash it?
 *
 * Three questions the updater used to answer only by trying. A wrong file
 * costs a 500 KB upload at BLE speed, and then fails at flash time with a
 * message about whatever detail the parser tripped over first — which is
 * rarely the thing the user got wrong.
 *
 * Everything here works on bytes and returns findings. No DOM, no device, no
 * network: `web/test/firmware-image.test.mjs` builds each archive and image
 * byte by byte and asserts on the verdict.
 *
 * ---- The two firmware kinds are not variations on one theme --------------
 *
 *   nordic-dfu-zip   A legacy nrfutil package: manifest.json + <x>.bin +
 *                    <x>.dat, STORED. Flashed over BLE by Nordic Legacy DFU.
 *   esp-app          A bare ESP32 application image. Flashed over WiFi by
 *                    POSTing it to ElegantOTA, which hands it to Arduino's
 *                    `Update` — that writes it to the *next OTA slot*, so it
 *                    must be the application alone.
 *
 * A merged ESP32 binary is the third thing users have, and it is the one that
 * looks right and is not: same 0xE9 magic, plausible size, and ElegantOTA
 * will accept it and write a bootloader into an OTA slot. Hence `esp-merged`
 * as its own kind rather than a flavour of `esp-app`.
 *
 * ---- Why the checks are the checks ---------------------------------------
 *
 * Each one exists because the failure it catches is otherwise mute, expensive,
 * or misattributed — not because it was cheap to add:
 *
 *   STORE-only      updater/src/firmware_zip.h walks local file headers and
 *                   does not decompress. A DEFLATE archive from a generic zip
 *                   tool opens fine everywhere else and fails only on device.
 *   CRC-32          the only real integrity check a zip carries.
 *   dat vs bin      the legacy init packet ends with a CRC-16 of the image
 *                   beside it, so "the manifest matches the firmware" is a
 *                   thing that can actually be verified rather than assumed.
 *   NCS package     `dfu_application.zip` is this project's *own* update
 *                   bundle and has nothing to do with legacy DFU. Same file
 *                   extension, same conventional name, unrelated schema.
 *                   Confusing the two is a documented trap.
 *   name length     ZIP_NAME_MAX in firmware_zip.h is 64. A longer name is
 *                   truncated on device and then does not match the manifest.
 */

/* ---- CRC-32 (IEEE 802.3), which is what a ZIP stores -------------------- */

const CRC32_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC32_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/* CRC-16/CCITT-FALSE — the one the legacy init packet carries. Same variant
 * as nordic-dfu-serial.js; duplicated rather than imported because that module
 * is the *serial* flasher and this one has no business depending on it. The
 * shared check value below is what stops them drifting into two variants. */
export function crc16(bytes) {
  let crc = 0xffff;
  for (let i = 0; i < bytes.length; i++) {
    crc ^= bytes[i] << 8;
    for (let b = 0; b < 8; b++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc & 0xffff;
}

/* ---- transports, and which board has which ----------------------------- */

export const TRANSPORT = {
  BLE: "ble-legacy-dfu",
  WIFI: "wifi-elegantota",
};

/*
 * Which transports the device has — asked, not tabulated.
 *
 * This module used to keep a board -> transports table mirroring
 * dfu_transport.c, held honest by a test. The device now answers for itself
 * (`fsxCaps`), so the copy is gone: a fact that exists once cannot drift, and
 * that is strictly better than a fact checked in two places.
 *
 * `null` means we have not asked or the device is too old to answer. Every
 * build ever shipped has had BLE, so that is the assumption — it produces a
 * warning on an ESP32 image rather than a false green.
 */
export const TRANSPORT_BIT = { [TRANSPORT.BLE]: 1, [TRANSPORT.WIFI]: 2 };

export function transportsFromMask(mask) {
  if (mask === null || mask === undefined) return [TRANSPORT.BLE];
  return Object.entries(TRANSPORT_BIT)
    .filter(([, bit]) => (mask & bit) !== 0)
    .map(([name]) => name);
}

/*
 * Which transport a file's *name* implies, before anything has read a byte of
 * it. Null when the name says nothing.
 *
 * This is the same rule as `mapping_kind_mask()` in updater/src/dfu_runner.c,
 * which narrows auto-flash the same way and for the same reason: an extension
 * decides a transport, so the other radio never has to be brought up. Kept in
 * step by dfu-inspect.test.mjs.
 *
 * Deliberately *not* the same question as `inspectFirmware()`'s. That one
 * reads the bytes and can tell an application image from a merged one; this
 * one only has to be right about which button to offer, and has to answer for
 * a file this browser never uploaded.
 */
export function transportForName(name) {
  const n = String(name ?? "").toLowerCase();
  if (n.endsWith(".zip")) return TRANSPORT.BLE;
  if (n.endsWith(".bin")) return TRANSPORT.WIFI;
  return null;
}

/* ---- ZIP ---------------------------------------------------------------- */

const LFH_SIG = 0x04034b50;
const ZIP_NAME_MAX = 64;   /* firmware_zip.h */

/** Walk local file headers from offset 0. Returns entries, or throws. */
export function walkZip(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = [];
  let p = 0;
  while (p + 30 <= bytes.length) {
    if (dv.getUint32(p, true) !== LFH_SIG) break;
    const flags = dv.getUint16(p + 6, true);
    const method = dv.getUint16(p + 8, true);
    const crc = dv.getUint32(p + 14, true);
    const csize = dv.getUint32(p + 18, true);
    const usize = dv.getUint32(p + 22, true);
    const nameLen = dv.getUint16(p + 26, true);
    const extraLen = dv.getUint16(p + 28, true);
    const nameAt = p + 30;
    if (nameAt + nameLen > bytes.length) throw new Error("truncated file name");
    const name = new TextDecoder().decode(bytes.subarray(nameAt, nameAt + nameLen));
    const dataAt = nameAt + nameLen + extraLen;
    if (dataAt + csize > bytes.length) throw new Error(`truncated data for ${name}`);
    out.push({
      name, method, crc, size: usize, offset: dataAt,
      /* Bit 3 puts the sizes in a trailing descriptor, leaving the header's
       * copies as zero. Nordic's packager does not do this; a file that does
       * cannot be walked header-to-header, which is exactly how the device
       * reads it. */
      streamed: (flags & 0x08) !== 0,
      data: bytes.subarray(dataAt, dataAt + csize),
    });
    p = dataAt + csize;
  }
  if (!out.length) throw new Error("no ZIP local file header at offset 0");
  return out;
}

/* ---- ESP32 images ------------------------------------------------------- */

export const ESP_IMAGE_MAGIC = 0xe9;
export const ESP_APP_DESC_MAGIC = 0xabcd5432;
/** Offset of esp_app_desc_t: a 24-byte image header plus one 8-byte segment
 *  header. Only an *application* has one — a bootloader does not, which is
 *  what makes merged-vs-app a fact rather than a guess. */
export const ESP_APP_DESC_OFFSET = 0x20;

/* Espressif's ESP_CHIP_ID values. Deliberately partial: an id that is not
 * here is reported as unknown rather than guessed at, because the whole point
 * of reading it is to refuse a mismatch. */
export const ESP_CHIP_IDS = {
  0x0000: "ESP32", 0x0002: "ESP32-S2", 0x0005: "ESP32-C3", 0x0009: "ESP32-S3",
  0x000c: "ESP32-C2", 0x000d: "ESP32-C6", 0x0010: "ESP32-H2",
};

/* Where an application is found inside a merged binary. 0x10000 is the
 * Arduino/PlatformIO default that MeshCore's own ESP32 builds use; 0x20000 is
 * what this project's MCUboot layout uses. Both are searched so the report can
 * say where the application actually is. */
const MERGED_APP_OFFSETS = [0x10000, 0x20000];

const cstr = (bytes, at, len) => {
  const end = bytes.indexOf(0, at) === -1 ? at + len : Math.min(bytes.indexOf(0, at), at + len);
  return new TextDecoder().decode(bytes.subarray(at, end)).replace(/[^\x20-\x7e]/g, "");
};

/** Read an esp_app_desc_t at `at`, or null if there isn't one. */
export function readAppDesc(bytes, at) {
  if (at + 176 > bytes.length) return null;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (dv.getUint32(at, true) !== ESP_APP_DESC_MAGIC) return null;
  return {
    version: cstr(bytes, at + 16, 32),
    project: cstr(bytes, at + 48, 32),
    date: cstr(bytes, at + 96, 16),
    idf: cstr(bytes, at + 112, 32),
  };
}

/** Read an esp_image_header_t at `at`, or null. */
export function readEspHeader(bytes, at = 0) {
  if (at + 24 > bytes.length || bytes[at] !== ESP_IMAGE_MAGIC) return null;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const chipId = dv.getUint16(at + 12, true);
  return {
    segments: bytes[at + 1],
    entry: dv.getUint32(at + 4, true),
    chipId,
    chip: ESP_CHIP_IDS[chipId] ?? null,
  };
}

/* ---- the report --------------------------------------------------------- */

export const KIND = {
  NORDIC_ZIP: "nordic-dfu-zip",
  NCS_ZIP: "ncs-mcuboot-zip",
  ESP_APP: "esp-app",
  ESP_MERGED: "esp-merged",
  UNKNOWN: "unknown",
};

/** Which transport can carry each kind. Null means nothing can. */
export const KIND_TRANSPORT = {
  [KIND.NORDIC_ZIP]: TRANSPORT.BLE,
  [KIND.ESP_APP]: TRANSPORT.WIFI,
  [KIND.NCS_ZIP]: null,
  [KIND.ESP_MERGED]: null,
  [KIND.UNKNOWN]: null,
};

const mk = () => {
  const findings = [];
  return {
    findings,
    add: (level, code, message) => findings.push({ level, code, message }),
  };
};

/*
 * Formats no transport here can send, refused by name alone.
 *
 * Mirrors the table in updater/src/firmware_inspect.c, which is where the
 * refusal actually bites — the device turns these away at the first chunk, on
 * both upload paths, so a file that reaches flash by any route has passed it.
 * The copy here exists only to say so before the upload starts, and
 * dfu-inspect.test.mjs fails if the two lists diverge.
 */
export const REJECTED_EXTENSIONS = {
  ".uf2": "a .uf2 is for a bootloader's mass-storage drive, not for any " +
          "transport this updater speaks",
  ".hex": "Intel HEX is a probe format; a DFU target takes a packaged .zip " +
          "or a raw application .bin",
  ".elf": "an .elf is an unlinked debug artifact, not a flashable image",
  ".img": "unrecognised container; upload the .zip or the application .bin",
};

/** Why this file cannot be uploaded at all, or null if it can. */
export function unsupportedReason(name) {
  const n = String(name ?? "").toLowerCase();
  for (const [ext, why] of Object.entries(REJECTED_EXTENSIONS)) {
    if (n.endsWith(ext)) return why;
  }
  return null;
}

/** Does this file's name suggest we should have an opinion about it at all? */
export function isFirmwareName(name) {
  return /\.(zip|bin)$/i.test(String(name ?? ""));
}

function inspectZip(bytes, r) {
  let entries;
  try {
    entries = walkZip(bytes);
  } catch (e) {
    r.add("error", "zip-unreadable",
      `not a readable ZIP (${e.message}). The device walks local file headers ` +
      `from offset 0 and never reads the central directory, so an archive that ` +
      `other tools open can still be unreadable here.`);
    return { kind: KIND.UNKNOWN, details: {} };
  }

  const byName = new Map(entries.map(e => [e.name, e]));
  const manifest = byName.get("manifest.json");

  /* ---- integrity, for whatever kind this turns out to be ---- */
  for (const e of entries) {
    if (e.streamed) {
      r.add("error", "zip-streamed",
        `${e.name} stores its size in a trailing descriptor rather than in its ` +
        `header. The device reads sizes from the header, so it would read zero ` +
        `bytes for this entry.`);
      continue;
    }
    if (e.method !== 0) {
      r.add("error", "zip-compressed",
        `${e.name} is compressed (method ${e.method}); the device's ZIP reader ` +
        `is STORE-only and does not decompress. Repack with no compression — ` +
        `nrfutil does this by default, generic zip tools do not.`);
    }
    const actual = crc32(e.data);
    if (e.method === 0 && actual !== e.crc) {
      r.add("error", "zip-crc",
        `${e.name} fails its CRC-32 — the archive is damaged ` +
        `(header 0x${e.crc.toString(16)}, data 0x${actual.toString(16)}).`);
    }
    if (e.name.length >= ZIP_NAME_MAX) {
      r.add("error", "zip-name-too-long",
        `"${e.name}" is ${e.name.length} characters; the device truncates ` +
        `names at ${ZIP_NAME_MAX - 1} and would then fail to match it against ` +
        `the manifest.`);
    }
  }

  if (!manifest) {
    r.add("error", "zip-no-manifest",
      "no manifest.json in the archive, so nothing says which file is the " +
      "firmware and which is the init packet.");
    return { kind: KIND.UNKNOWN, details: { entries: entries.map(e => e.name) } };
  }

  let doc;
  try {
    doc = JSON.parse(new TextDecoder().decode(manifest.data));
  } catch (e) {
    r.add("error", "manifest-unparsable", `manifest.json is not valid JSON (${e.message}).`);
    return { kind: KIND.UNKNOWN, details: { entries: entries.map(e => e.name) } };
  }

  /* This project's own OTA bundle, which shares the extension and the
   * conventional filename with a legacy package and is otherwise unrelated. */
  if (Array.isArray(doc.files) && !doc.manifest) {
    const boards = [...new Set(doc.files.map(f => f.board).filter(Boolean))];
    r.add("error", "ncs-package",
      `this is an NCS/MCUboot update package${boards.length ? ` for ${boards.join(", ")}` : ""}, ` +
      `not a Nordic Legacy DFU package. It updates *this* device over ` +
      `Bluetooth — use "Update over Bluetooth", not the target firmware ` +
      `folder. The two share a file extension and nothing else.`);
    return { kind: KIND.NCS_ZIP, details: { boards } };
  }

  if (!doc.manifest || typeof doc.manifest !== "object") {
    r.add("error", "manifest-shape",
      'manifest.json has no "manifest" object — this is not a legacy nrfutil package.');
    return { kind: KIND.UNKNOWN, details: {} };
  }

  const sections = Object.keys(doc.manifest);
  const section = doc.manifest[sections[0]] ?? {};
  const details = { sections, binFile: section.bin_file, datFile: section.dat_file };

  for (const [key, file] of [["bin_file", section.bin_file], ["dat_file", section.dat_file]]) {
    if (!file) {
      r.add("error", "manifest-incomplete", `manifest.json names no ${key}.`);
    } else if (!byName.has(file)) {
      r.add("error", "manifest-missing-file",
        `manifest.json names ${key}="${file}", which is not in the archive. ` +
        `It holds: ${entries.map(e => e.name).join(", ")}.`);
    }
  }

  const bin = byName.get(section.bin_file);
  const dat = byName.get(section.dat_file);
  if (bin) details.imageBytes = bin.size;

  /* The init packet's own account of the image beside it. This is the only
   * check that ties the two together; everything above would pass on a
   * package whose .dat came from a different build than its .bin. */
  if (bin && dat) {
    const init = parseLegacyInitPacket(dat.data);
    if (init) {
      details.deviceType = init.deviceType;
      details.appVersion = init.appVersion;
      const want = crc16(bin.data);
      if (want !== init.crc16) {
        r.add("error", "dat-bin-mismatch",
          `the init packet's image CRC-16 is 0x${init.crc16.toString(16)} but ` +
          `${section.bin_file} hashes to 0x${want.toString(16)}. The .dat and ` +
          `the .bin are from different builds; the target would reject the ` +
          `image after the whole transfer.`);
      } else {
        r.add("info", "dat-bin-match",
          `init packet matches the image (CRC-16 0x${want.toString(16)}).`);
      }
    } else {
      /* Extended init packets carry a hash instead and have a different
       * length. Not an error — just not something we can verify. */
      r.add("info", "dat-unverified",
        `${section.dat_file} is ${dat.size} bytes, which is not the classic ` +
        `init-packet layout, so its image CRC could not be checked.`);
    }
  }

  return { kind: KIND.NORDIC_ZIP, details };
}

/**
 * Parse the classic legacy init packet, or null if it is some other shape.
 *
 *   u16 device_type, u16 device_revision, u32 application_version,
 *   u16 softdevice_count, u16 softdevice[count], u16 firmware_crc16
 *
 * The length is fully determined by `softdevice_count`, so a buffer that does
 * not match exactly is a different format (an extended packet, which carries
 * a hash) rather than a corrupt one — hence null and not an error.
 */
export function parseLegacyInitPacket(bytes) {
  if (bytes.length < 12) return null;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = dv.getUint16(8, true);
  if (bytes.length !== 10 + count * 2 + 2) return null;
  return {
    deviceType: dv.getUint16(0, true),
    deviceRev: dv.getUint16(2, true),
    appVersion: dv.getUint32(4, true),
    softdevices: Array.from({ length: count }, (_, i) => dv.getUint16(10 + i * 2, true)),
    crc16: dv.getUint16(10 + count * 2, true),
  };
}

function inspectEsp(bytes, r) {
  const head = readEspHeader(bytes, 0);
  if (!head) {
    r.add("error", "not-an-image",
      `does not begin with an ESP32 image header (0x${ESP_IMAGE_MAGIC.toString(16)}), ` +
      `and is not a ZIP either.`);
    return { kind: KIND.UNKNOWN, details: {} };
  }

  const details = { chip: head.chip, chipId: head.chipId, entry: head.entry };
  if (!head.chip) {
    r.add("warn", "unknown-chip",
      `the image header names chip id 0x${head.chipId.toString(16)}, which this ` +
      `client does not have a name for. It may still be valid.`);
  }

  const desc = readAppDesc(bytes, ESP_APP_DESC_OFFSET);
  if (desc) {
    Object.assign(details, { project: desc.project, version: desc.version, idf: desc.idf });
    r.add("info", "esp-app",
      `ESP32 application image${desc.project ? ` — ${desc.project}` : ""}` +
      `${desc.version ? ` ${desc.version}` : ""}${head.chip ? ` for ${head.chip}` : ""}.`);
    return { kind: KIND.ESP_APP, details };
  }

  /* No application descriptor at the front means the thing at offset 0 is not
   * an application. On a file this size that is a bootloader, i.e. a merged
   * image — so say where the application it contains actually starts. */
  for (const at of MERGED_APP_OFFSETS) {
    const inner = readAppDesc(bytes, at + ESP_APP_DESC_OFFSET);
    if (!inner) continue;
    Object.assign(details, {
      appOffset: at, project: inner.project, version: inner.version, idf: inner.idf,
    });
    r.add("error", "esp-merged",
      `this is a merged image — a bootloader at offset 0 with the application ` +
      `at 0x${at.toString(16)}${inner.project ? ` (${inner.project}` : ""}` +
      `${inner.version ? ` ${inner.version})` : inner.project ? ")" : ""}. ` +
      `ElegantOTA writes what it is given into the next OTA slot, so it needs ` +
      `the application on its own; given this, it would write a bootloader ` +
      `there instead. Upload the application-only .bin.`);
    return { kind: KIND.ESP_MERGED, details };
  }

  r.add("error", "esp-no-app",
    `has an ESP32 image header but no application descriptor, at offset 0 or ` +
    `at any offset an application is normally merged to ` +
    `(${MERGED_APP_OFFSETS.map(o => "0x" + o.toString(16)).join(", ")}). ` +
    `A bootloader on its own looks like this.`);
  return { kind: KIND.ESP_MERGED, details };
}

/**
 * Inspect a firmware file.
 *
 * `board` is optional: without it the report says what the file is and
 * whether it is intact, but nothing about whether this device can flash it.
 *
 * Returns { kind, transport, ok, findings, details }. `ok` is false when any
 * finding is an error — a file the device cannot use, whatever the reason.
 */
export function inspectFirmware(bytes, { name = "", transports = null } = {}) {
  const r = mk();
  const zipish = bytes.length >= 4 &&
    bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;

  const { kind, details } = zipish ? inspectZip(bytes, r) : inspectEsp(bytes, r);
  const transport = KIND_TRANSPORT[kind] ?? null;

  /* A name that disagrees with the content is worth saying out loud, but the
   * content wins — renaming a file does not change it. */
  if (name && /\.zip$/i.test(name) && !zipish) {
    r.add("warn", "extension-mismatch",
      `named .zip but its contents are not an archive.`);
  }
  if (name && /\.bin$/i.test(name) && zipish) {
    r.add("warn", "extension-mismatch",
      `named .bin but its contents are a ZIP archive.`);
  }

  /* `transports` is what the device said it has. Without it — not asked, or
   * firmware too old to answer — no compatibility claim is made at all,
   * rather than one based on a guess about the board. */
  if (transports && transport && !transports.includes(transport)) {
    r.add("error", "transport-unavailable",
      transport === TRANSPORT.WIFI
        ? `this image is flashed over WiFi (ElegantOTA), and the updater does ` +
          `not have that transport — it can reach Bluetooth targets only.`
        : `this image needs the ${transport} transport, which the updater ` +
          `does not have.`);
  }

  return {
    kind, transport, details,
    findings: r.findings,
    ok: !r.findings.some(f => f.level === "error"),
  };
}
