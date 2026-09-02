/*
 * Reader for the device's battery record — updater/src/battery_status.h.
 *
 * The firmware publishes six fixed bytes over its own GATT service and
 * notifies when they actually change: a charger going in or out, or a voltage
 * step big enough not to be noise. This module turns those bytes into an
 * object and nothing else — no BLE, no DOM — so the layout can be tested
 * against the C header without a browser or a device.
 *
 * `battery.test.mjs` reads battery_status.h back and checks every constant
 * here still matches it. Same reasoning as dfu-status.js: a silent
 * disagreement between firmware and client is the whole failure mode.
 */

/* Service 8d53dc21 is SMP's UUID +4; the characteristic is SMP's char +5. */
export const BATTERY_SERVICE = "8d53dc21-1db7-4cd3-868b-8a527460aa84";
export const BATTERY_CHAR    = "da2e782d-fbce-4e01-ae9e-261174997c48";

export const PAYLOAD_VERSION = 1;
export const PAYLOAD_LEN = 6;

/* flags byte. Each fact is a *pair*: the value, and whether the board can
 * tell at all. Absent is not false — a bare resistor divider reads a full
 * cell on USB exactly like a full cell running itself flat — so a client that
 * ignores the _KNOWN bit will confidently display "not charging" for a device
 * that is plugged in. */
export const FLAG = {
  CHARGING:       0x01,
  CHARGING_KNOWN: 0x02,
  EXTERNAL:       0x04,
  EXTERNAL_KNOWN: 0x08,
};

/* enum battery_source, mirrored from battery.h via smp-client.js. Repeated
 * here only as a name; the numbers live in one place. */
export { BATTERY_SOURCE } from "./smp-client.js";

/*
 * Decode one notification or read.
 *
 * Returns null for a record this client cannot trust: too short, an unknown
 * version, or `source` of 0 meaning the board has no way to measure a
 * battery. All three render the same way — no indicator — and none of them is
 * an error worth putting in front of anyone.
 *
 * A *longer* payload is accepted on purpose. battery_status.h allows fields
 * to be appended without a version bump, so refusing extra bytes would make
 * this client fail against firmware newer than itself for no reason.
 */
export function parseBattery(dv) {
  const view = dv instanceof DataView ? dv : new DataView(dv.buffer ?? dv);
  if (view.byteLength < PAYLOAD_LEN) return null;
  if (view.getUint8(0) !== PAYLOAD_VERSION) return null;

  const src = view.getUint8(1);
  if (src === 0) return null;

  const flags = view.getUint8(3);
  const out = {
    src,
    pct: view.getUint8(2),
    mv: view.getUint16(4, true),
  };
  /* Left undefined rather than set false where the board cannot tell, so the
   * shape matches fsxBattery()'s CBOR response exactly and the UI has one
   * thing to render either way. */
  if (flags & FLAG.CHARGING_KNOWN) out.chg = !!(flags & FLAG.CHARGING);
  if (flags & FLAG.EXTERNAL_KNOWN) out.ext = !!(flags & FLAG.EXTERNAL);
  return out;
}
