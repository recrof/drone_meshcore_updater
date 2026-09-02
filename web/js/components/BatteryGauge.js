import { computed } from "../vue.js";
import { battery } from "../store.js";
import { BATTERY_SOURCE } from "../lib/smp-client.js";
import Icon from "./Icon.js";

/*
 * The updater's own battery, in the header.
 *
 * ---- The glyph -----------------------------------------------------------
 *
 * Material Symbols, like every other icon here, so the path data stays
 * verbatim from google/material-design-icons and nothing in this repo is a
 * drawing somebody made up. The set gives eight levels — battery_0_bar
 * (depleted) through battery_6_bar (nearly full) plus battery_full — and one
 * override, battery_charging_full.
 *
 * Charging replaces the level rather than decorating it. That is the state in
 * which the exact reading matters least: the number is rising, it is being
 * measured through a charger, and "it is on the charger" is the whole answer
 * somebody wants. It also avoids stacking a bolt on top of a glyph that is
 * already carrying a quantity.
 *
 * ---- Bands, and why they are not the scanner's ---------------------------
 *
 * `RSSI_BANDS` describes whether a *link* will carry a transfer. This
 * describes whether the *updater* will survive one, which is a different
 * question with a different cost: a marginal link fails the DFU and you try
 * again, while a flat cell mid-transfer can leave a single-bank target with
 * no application at all (Trap 2). Hence the low band starts high, at 30%.
 *
 * The colour comes from --ok / --warn / --danger and never from --accent, for
 * the reason tokens.css gives at --ok: the accent is a preference with seven
 * settings, one of which is red, and a battery meter that paints "full" in
 * the user's red is worse than one with no colour at all.
 */
const BANDS = [
  { min: 60, cls: "ok",     label: "good" },
  { min: 30, cls: "warn",   label: "getting low" },
  { min: 0,  cls: "danger", label: "low" },
];

/* Seven buckets across battery_0_bar..battery_6_bar, with battery_full kept
 * for a cell that really is full — a device on the charger showing anything
 * but a full battery is the sort of small wrongness that costs trust in the
 * whole indicator. */
export function batteryIcon(pct, charging) {
  if (charging) return "battery_charging_full";
  if (pct >= 95) return "battery_full";
  return `battery_${Math.min(6, Math.max(0, Math.floor((pct / 100) * 7)))}_bar`;
}

export default {
  name: "BatteryGauge",
  components: { Icon },
  setup() {
    const b = computed(() => battery.value);

    const pct = computed(() => Math.max(0, Math.min(100, b.value?.pct ?? 0)));
    const band = computed(() => BANDS.find((x) => pct.value >= x.min) ?? BANDS[2]);

    /* Absent is not false: only a PMIC board answers this at all, and a
     * divider board that is plugged in reads exactly like one that is not.
     * `undefined` therefore stays undefined the whole way to the glyph — a
     * charging bolt drawn from a value the device never sent is an invented
     * fact, and it is the one an operator would act on. */
    const charging = computed(() => b.value?.chg);
    const icon = computed(() => batteryIcon(pct.value, charging.value === true));

    const title = computed(() => {
      const v = b.value;
      if (!v) return "";
      const bits = [`${v.mv} mV (about ${v.pct}%, ${band.value.label})`];
      if (v.chg !== undefined) bits.push(v.chg ? "charging" : "not charging");
      if (v.ext !== undefined) bits.push(v.ext ? "on external power" : "running on the battery");
      /* Said out loud on the boards that cannot tell, rather than left as an
       * absence the reader has to notice for themselves. */
      if (v.chg === undefined) bits.push("this board cannot tell whether it is charging");
      bits.push(v.src === BATTERY_SOURCE.PMIC
        ? "measured by the on-board PMIC"
        : "measured across a resistor divider");
      /* The percentage is inferred from the voltage against a LiPo curve and
       * sags under load — the same cell reads lower mid-transfer. Saying so
       * is cheap, and stops the number being trusted further than it earns. */
      bits.push("percentage is estimated from voltage and reads low under load");
      return bits.join(" — ");
    });

    const label = computed(() => {
      const v = b.value;
      if (!v) return "";
      return `Updater battery about ${pct.value} percent, ${band.value.label}` +
             (v.chg === true ? ", charging" : "");
    });

    return { b, pct, band, icon, title, label };
  },
  template: /* html */ `
    <span v-if="b" class="battery" :class="band.cls" :title="title"
          role="img" :aria-label="label">
      <Icon :name="icon" :size="18"/>
      <span class="pct">{{ pct }}%</span>
    </span>
  `,
};
