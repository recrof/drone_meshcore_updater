/*
 * Reader for the device's live DFU status record — updater/src/dfu_status.h.
 *
 * The firmware publishes one small fixed-layout snapshot over its own GATT
 * service: what step a transfer is on, which attempt, how far through, and
 * which peer it is talking to. This module turns those bytes into something
 * renderable and nothing else — no BLE, no DOM — so the layout can be tested
 * against the C header without a browser or a device.
 *
 * The layout is transcribed from dfu_status.h and `dfu-status.test.mjs` reads
 * that header back to check every constant here still matches. A silent
 * disagreement between firmware and client is the failure mode that check
 * exists to prevent — the same reason config-file.test.mjs reads config.h.
 */

/* Service 8d53dc20 is SMP's UUID +3; the characteristic is SMP's char +4. */
export const DFU_STATUS_SERVICE = "8d53dc20-1db7-4cd3-868b-8a527460aa84";
export const DFU_STATUS_CHAR    = "da2e782c-fbce-4e01-ae9e-261174997c48";

export const PAYLOAD_VERSION = 1;
export const HEADER_LEN = 20;

/* enum dfu_status_state */
export const STATE = {
  IDLE: 0,
  SCANNING: 1,
  CONNECTING: 2,
  STARTING: 3,
  ENABLING: 4,
  UPLOADING: 5,
  VALIDATING: 6,
  DISCONNECTING: 7,
  COOLDOWN: 8,
  DONE: 9,
  FAILED: 10,
};

/* enum dfu_status_result */
export const RESULT = {
  NONE: 0,
  OK: 1,
  NO_TARGET: 2,
  SCAN_ERROR: 3,
  BAD_BUNDLE: 4,
  CONNECT_FAILED: 5,
  SERVICE_MISSING: 6,
  CHAR_MISSING: 7,
  DISCONNECTED: 8,
  TIMEOUT: 9,
  REMOTE_ERROR: 10,
  FS_ERROR: 11,
  RETRIES_EXHAUSTED: 12,
};

/* Present tense, and phrased as what the device is doing rather than as the
 * enum name — this is the line a user reads to answer "is it working?". */
export const STATE_LABEL = {
  [STATE.IDLE]: "Idle",
  [STATE.SCANNING]: "Scanning for the target",
  [STATE.CONNECTING]: "Connecting",
  [STATE.STARTING]: "Starting DFU",
  [STATE.ENABLING]: "Rebooting the target into its bootloader",
  [STATE.UPLOADING]: "Uploading firmware",
  [STATE.VALIDATING]: "Validating",
  [STATE.DISCONNECTING]: "Activating and resetting",
  [STATE.COOLDOWN]: "Waiting before the next attempt",
  [STATE.DONE]: "Complete",
  [STATE.FAILED]: "Failed",
};

/* Each of these is a real dead end someone has to act on, so they name the
 * thing to go and change where there is one. */
export const RESULT_LABEL = {
  [RESULT.NONE]: "",
  [RESULT.OK]: "the target was flashed and rebooted",
  [RESULT.NO_TARGET]: "no matching device was found — check ble_name and min_rssi",
  [RESULT.SCAN_ERROR]: "the scanner could not start",
  [RESULT.BAD_BUNDLE]: "the bundle could not be read, or ble_firmware_mapping " +
    "matched nothing",
  [RESULT.CONNECT_FAILED]: "could not connect to the target",
  [RESULT.SERVICE_MISSING]: "the target does not expose Nordic Legacy DFU",
  [RESULT.CHAR_MISSING]: "the target's DFU service is missing a characteristic",
  [RESULT.DISCONNECTED]: "the link dropped mid-transfer",
  [RESULT.TIMEOUT]: "the target stopped responding",
  [RESULT.REMOTE_ERROR]: "the target rejected the transfer",
  [RESULT.FS_ERROR]: "the bundle could not be read from flash",
  [RESULT.RETRIES_EXHAUSTED]: "every attempt failed",
};

/* States in which the device is actively working. DONE and FAILED are sticky
 * — they stay until the next run — so "is a DFU happening" cannot be "is the
 * state non-idle". */
export function isActive(state) {
  return state >= STATE.SCANNING && state <= STATE.COOLDOWN;
}

export function isTerminal(state) {
  return state === STATE.DONE || state === STATE.FAILED;
}

/* `bytes` is a Uint8Array of the notification or read value.
 *
 * Throws on a payload this client cannot read. Refusing is the point: the
 * version byte exists so a mismatch produces one clear message instead of a
 * plausible-looking record assembled out of fields that moved.
 */
export function parseDfuStatus(bytes) {
  if (!bytes || bytes.length < HEADER_LEN) {
    throw new Error(`DFU status payload is ${bytes?.length ?? 0} B, ` +
                    `expected at least ${HEADER_LEN}`);
  }
  const version = bytes[0];
  if (version !== PAYLOAD_VERSION) {
    throw new Error(`DFU status payload version ${version}; this client ` +
                    `understands version ${PAYLOAD_VERSION}. Update the ` +
                    `web app, or the firmware.`);
  }
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const state = bytes[1];
  const result = bytes[3];
  const fileLen = bytes[6];
  const nameLen = bytes[7];

  /* Names follow the header in declaration order: target, then bundle. A
   * short read is treated as an empty name rather than throwing — the header
   * is the part worth being strict about. */
  const dec = new TextDecoder("utf-8", { fatal: false });
  const nameEnd = Math.min(HEADER_LEN + nameLen, bytes.length);
  const fileEnd = Math.min(nameEnd + fileLen, bytes.length);
  const target = dec.decode(bytes.subarray(HEADER_LEN, nameEnd));
  const file = dec.decode(bytes.subarray(nameEnd, fileEnd));

  return {
    version,
    state,
    stateLabel: STATE_LABEL[state] ?? `state ${state}`,
    percent: bytes[2],
    result,
    resultLabel: RESULT_LABEL[result] ?? `result ${result}`,
    attempt: bytes[4],
    retries: bytes[5],
    sent: dv.getUint32(8, true),
    total: dv.getUint32(12, true),
    elapsedMs: dv.getUint32(16, true),
    target,
    file,
    active: isActive(state),
    terminal: isTerminal(state),
    ok: state === STATE.DONE,
  };
}

/* The record a client shows before the device has said anything — a firmware
 * without the service, or a connection where nothing has run yet. Same shape
 * as a parsed record so the UI never has to null-check its fields. */
export function idleStatus() {
  return {
    version: PAYLOAD_VERSION,
    state: STATE.IDLE,
    stateLabel: STATE_LABEL[STATE.IDLE],
    percent: 0,
    result: RESULT.NONE,
    resultLabel: "",
    attempt: 0,
    retries: 0,
    sent: 0,
    total: 0,
    elapsedMs: 0,
    target: "",
    file: "",
    active: false,
    terminal: false,
    ok: false,
  };
}
