import { ref, computed } from "../vue.js";
import {
  scannerOpen, scanEntries, scanning, scanError, closeScanner,
  scanKind, scanKinds, setScanKind, scanAuto, setScanAuto, refreshScan,
  scanRefreshing,
  entries, path, fileInfo, inspectFile, flashToTarget, dfuActive,
} from "../store.js";
import { rssiBand, RSSI_BANDS, SURVEY_KIND, SURVEY_FLAG } from "../lib/smp-client.js";
import { transportForName, TRANSPORT } from "../lib/firmware-image.js";
import { fmtSize, joinPath } from "../lib/format.js";
import { onEscape } from "../lib/dialog.js";
import Icon from "./Icon.js";
import IconCycle from "./IconCycle.js";

/*
 * What the radios can hear, and how well.
 *
 * ---- Why this screen exists ------------------------------------------
 *
 * Every other view here reports on a transfer that has already been decided.
 * When one fails at range there is nothing to look at: "no target found" is
 * the same message whether the target is switched off, out of range, named
 * something the filter does not match, or perfectly audible to a radio whose
 * antenna is not connected. Those have completely different fixes and the
 * device already knew which it was — it simply had no way to say so.
 *
 * So the survey filters nothing (see updater/src/survey.h). A device below
 * `min_rssi` is the interesting one, and hearing nothing but a stranger's
 * phone still answers the first question, which is whether the receiver works.
 *
 * ---- Two tabs, because there are two radios and one of them --------------
 *
 * Bluetooth and WiFi cannot be surveyed at once. On the ESP32 parts they are
 * physically the same 2.4 GHz radio, time-sliced by the coexistence layer, so
 * running both does not fail — it makes each slower and less complete, which
 * reads as "the scanner misses things" and is nearly impossible to attribute.
 * Tabs make that constraint visible instead of pretending it is not there.
 *
 * The WiFi tab appears only where the device reports a WiFi radio. That comes
 * from the device (`kinds`), not from a board table kept here: a fact that
 * exists once cannot drift from a copy of itself.
 *
 * ---- Why the bands are what they are ---------------------------------
 *
 * The thresholds live in smp-client.js so this file cannot drift from what the
 * tests assert. They are stricter than a phone's bars because they describe
 * something harsher: Legacy DFU streams hundreds of KB with **no resume**, so
 * a loss part-way costs the whole image (Trap 2). The bar is set where a
 * transfer completes first time, not where a link merely establishes.
 *
 * Each band gets a distinct *glyph* as well as a colour — three bars, two,
 * one. Colour alone excludes anyone who cannot separate the red from the
 * green, on a screen whose entire output is a judgement about quality.
 *
 * ---- Manual mode -----------------------------------------------------
 *
 * The same list doubles as the way to flash one specific device. That is not a
 * convenience bolted on: the reason to be looking at this screen is usually
 * that automatic selection picked the wrong device or none, and the useful
 * next step is to point at the right one. Flashing from here bypasses
 * `ble_name` and `min_rssi` on the device, which is the whole point — the
 * operator has overruled both by choosing.
 *
 * Only the Bluetooth tab offers it. A WiFi row is an access point, and this
 * updater reaches an ElegantOTA peer by joining its AP and posting to a fixed
 * endpoint — there is no "flash that BSSID" to offer.
 */
export default {
  name: "ScannerDialog",
  components: { Icon, IconCycle },
  setup() {
    /* Which device's file picker is open, by id. One at a time: two open
     * pickers side by side invite flashing the wrong row. */
    onEscape(() => scannerOpen.value, closeScanner);

    const picking = ref("");
    const isBle = computed(() => scanKind.value === SURVEY_KIND.BLE);

    /* **One setting per tab, not one shared between them.** They are different
     * questions — "hide anonymous beacons" and "show only the ElegantOTA access
     * point" — and a single ref made unticking one silently untick the other,
     * so a tab came back filtered differently from how it was left.
     *
     * Both start on. A survey filters nothing, which is right for the device
     * and wrong as an opening view: in any populated place the list is mostly
     * anonymous beacons, and the device the operator came to look at is
     * somewhere among them. The unfiltered view stays one click away, and the
     * count of what is hidden is always shown so it is never a silent
     * omission. */
    const bleTargetsOnly = ref(true);
    const wifiTargetsOnly = ref(true);

    /* One binding for the template, resolving to whichever tab is showing.
     * Writable so v-model still works — the alternative was two near-identical
     * checkbox blocks differing only in their ref. */
    const targetsOnly = computed({
      get: () => (isBle.value ? bleTargetsOnly.value : wifiTargetsOnly.value),
      set: (v) => {
        if (isBle.value) bleTargetsOnly.value = v;
        else wifiTargetsOnly.value = v;
      },
    });


    /* Until the device answers, assume Bluetooth only — every build ever
     * shipped has had it, and that assumption hides a tab rather than
     * offering one that cannot work. */
    const hasWifi = computed(() =>
      ((scanKinds.value ?? (1 << SURVEY_KIND.BLE)) & (1 << SURVEY_KIND.WIFI)) !== 0);

    /* Sorted here rather than on the device. The firmware returns insertion
     * order on purpose — signal moves between polls, and a list that reordered
     * itself server-side would make `off` pagination skip and repeat rows. */
    const rows = computed(() => {
      const all = scanEntries.value.map((e) => {
        const band = rssiBand(e.rssi);
        return {
          ...e,
          band: band.id,
          bandLabel: band.label,
          bandIcon: band.icon,
          label: e.name || "(unnamed)",
          dfu: (e.fl & SURVEY_FLAG.DFU) !== 0,
          secure: (e.fl & SURVEY_FLAG.SECURE) !== 0,
          /* Computed on the device: `ble_name`'s pipe-delimited grammar and
           * the ElegantOTA AP's name both live there, and reproducing either
           * here would be a drift pair with nothing checking it. */
          match: (e.fl & SURVEY_FLAG.MATCH) !== 0,
          /* Either counts. A peer already in its bootloader advertises the
           * DFU service under a name `ble_name` may not match, and is still
           * exactly what the operator is looking for. */
          interesting: (e.fl & (SURVEY_FLAG.MATCH | SURVEY_FLAG.DFU)) !== 0,
        };
      });
      const shown = targetsOnly.value
        ? all.filter((e) => (isBle.value ? (e.dfu || e.name) : e.match))
        : all;
      /* Interesting rows first, then by signal. Sorting on signal alone put
       * the actual target below whatever happened to be closest, which on a
       * screen you are about to click is the wrong thing to reward. */
      return shown.sort((a, b) =>
        (b.interesting - a.interesting) || (b.rssi - a.rssi));
    });

    const hidden = computed(() => scanEntries.value.length - rows.value.length);

    /* Files this device holds that could go out over Bluetooth.
     *
     * Named from the extension, the same rule `mapping_kind_mask()` uses in
     * the firmware. A .bin is excluded because it is a WiFi payload and a MAC
     * address cannot mean anything to an HTTP endpoint — the device would
     * refuse it, and offering it here would only move the refusal later. */
    const candidates = computed(() =>
      entries.value
        .filter((e) => e.type !== 1 && transportForName(e.name) === TRANSPORT.BLE)
        .map((e) => {
          const full = joinPath(path.value, e.name);
          return { name: e.name, full, size: e.size, info: fileInfo[full] ?? null };
        }));

    function togglePick(id) {
      picking.value = picking.value === id ? "" : id;
      /* Ask about each candidate as the picker opens, not on every refresh:
       * the device reads the whole file to checksum it, about a second per
       * 500 KB. Cached by inspectFile() until the size changes. */
      if (picking.value) {
        for (const c of candidates.value) inspectFile(c.full, c.size);
      }
    }

    async function pick(row, cand) {
      const ok = await flashToTarget(cand.full, row.id, row.label);
      if (ok) picking.value = "";
    }

    return {
      scannerOpen, scanning, scanError, closeScanner, rows, hidden,
      picking, togglePick, candidates, pick, targetsOnly, fmtSize,
      RSSI_BANDS, dfuActive, isBle, hasWifi, scanKind, setScanKind,
      SURVEY_KIND, scanAuto, setScanAuto, refreshScan, scanRefreshing,
      bleTargetsOnly, wifiTargetsOnly,
    };
  },
  template: /* html */ `
    <div id="scanner-overlay" v-if="scannerOpen" @click.self="closeScanner">
      <div class="cfg-modal" role="dialog" aria-modal="true" aria-label="Nearby devices">

        <div class="cfg-head">
          <span class="title">NEARBY DEVICES</span>
          <span class="scan-state" :class="{ live: scanning }">
            {{ scanning ? "scanning…" : "idle" }}
          </span>
          <span class="grow"></span>
          <!-- Same place and same glyph as every other dialog here. The Close
               in the footer stays: it is the one a pointer reaches for, and
               the ✕ is the one an eye looks for. -->
          <button title="Close" @click="closeScanner">✕</button>
        </div>

        <div class="cfg-body">
          <!-- Tabs, not a toggle: one radio at a time is a real constraint of
               the device and this is the honest way to show it. -->
          <!-- Each tab's icon plays while ITS OWN radio is sweeping, which is
               why the playing flag is gated on the tab being selected as well
               as on scanning — an animating icon on the inactive tab would
               claim two radios were surveying at once, the one thing this
               device cannot do. (No backticks in here: the template is a JS
               template literal and one would close it.) -->
          <div class="scan-tabs" role="tablist">
            <button role="tab" :aria-selected="isBle"
                    :class="{ on: isBle }"
                    @click="setScanKind(SURVEY_KIND.BLE)">
              <IconCycle :names="['bluetooth_searching', 'bluetooth']" :size="18"
                         :playing="isBle && scanning"/>
              Bluetooth
            </button>
            <button v-if="hasWifi" role="tab" :aria-selected="!isBle"
                    :class="{ on: !isBle }"
                    @click="setScanKind(SURVEY_KIND.WIFI)">
              <IconCycle :names="['wifi_1_bar', 'wifi_2_bar', 'wifi']" :size="18"
                         :playing="!isBle && scanning"/>
              WiFi
            </button>
          </div>

          <!-- Never hidden, unlike the per-key help in the config editor: this
               is the one line that explains why a number the operator can see
               is being called bad. -->
          <p class="scan-legend">
            Signal is measured for a firmware transfer, which has no resume —
            a drop part-way costs the whole image.
            <span class="band excellent">Excellent</span> is −70 dBm or better,
            <span class="band good">Good</span> down to −75,
            <span class="band poor">Poor</span> below that.
          </p>

          <div class="cfg-banner warn" v-if="scanError">{{ scanError }}</div>

          <label class="scan-filter">
            <input type="checkbox" v-model="targetsOnly">
            {{ isBle ? "Only named devices and DFU targets"
                     : "Only MeshCore-OTA access points" }}
            <span v-if="targetsOnly && hidden > 0" class="muted">
              ({{ hidden }} hidden)
            </span>
          </label>

          <table class="scan-table">
            <thead>
              <!-- Name first, signal second. The name is what the operator
                   is looking *for* — they came here with a device in mind and
                   scan down the list matching a word. The signal is what they
                   check once they have found the row, so it reads better as
                   the answer to the name than as the thing standing in front
                   of it. It also puts the two variable-width columns at the
                   ends rather than sandwiching the name. -->
              <tr>
                <th>{{ isBle ? "Device" : "Network" }}</th>
                <th>Signal</th>
                <th>{{ isBle ? "Address" : "Channel" }}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              <tr v-if="!rows.length">
                <!-- An empty table during a refresh must say it is working.
                     Silence here reads as "nothing is out there", which is a
                     factual claim we have not yet earned. -->
                <td colspan="4" class="empty">
                  {{ scanError ? "—"
                     : scanRefreshing ? "Scanning…"
                     : scanning ? "Listening… nothing heard yet."
                     : "Not scanning." }}
                </td>
              </tr>
              <template v-else v-for="r in rows" :key="r.id">
                <tr class="scan-row" :class="[r.band, { hit: r.interesting }]">
                  <td class="scan-name">
                    {{ r.label }}
                    <span class="scan-badge" v-if="r.dfu"
                          title="Advertises the Nordic Legacy DFU service">DFU</span>
                    <span class="scan-badge lock" v-if="!isBle && r.secure"
                          title="Encrypted network">🔒</span>
                  </td>
                  <td class="scan-sig-cell" :title="r.bandLabel + ' — best ' + r.best + ' dBm over ' + r.n + ' sightings'">
                    <!-- The flex box is this span and not the <td>. A cell
                         given display:flex stops being a table-cell, so it
                         no longer stretches to the row's height or shares the
                         column's width — which showed up as this column's
                         bottom border sitting higher than the rest of the
                         row's and stopping short of the next column. -->
                    <span class="scan-sig">
                      <Icon :name="r.bandIcon" :size="18"/>
                      <span class="scan-dbm">{{ r.rssi }}</span>
                    </span>
                  </td>
                  <td class="scan-id">
                    <code v-if="isBle">{{ r.id }}</code>
                    <span v-else>ch {{ r.ch }}</span>
                  </td>
                  <td class="actions">
                    <!-- The glyph belongs to the Flash state only. Carrying
                         it into Cancel would label the way out with the icon
                         for the thing being backed out of. -->
                    <button v-if="isBle" class="small" :disabled="dfuActive"
                            @click="togglePick(r.id)">
                      <Icon v-if="picking !== r.id" name="bolt_boost" :size="16"/>
                      {{ picking === r.id ? "Cancel" : "Flash…" }}
                    </button>
                  </td>
                </tr>
                <tr v-if="picking === r.id" class="scan-pick-row">
                  <td colspan="4">
                    <p class="muted" v-if="!candidates.length">
                      No Bluetooth-flashable files on the device. Upload a .zip first.
                    </p>
                    <button v-for="c in candidates" :key="c.full"
                            class="scan-file" @click="pick(r, c)"
                            :disabled="c.info && c.info.flashable === false">
                      <span class="scan-file-name">{{ c.name }}</span>
                      <span class="muted">
                        {{ fmtSize(c.size) }}<template v-if="c.info && c.info.pending"> · checking…</template>
                        <template v-else-if="c.info && c.info.flashable === false"> · {{ c.info.reason || "cannot be flashed" }}</template>
                        <template v-else-if="c.info && c.info.version"> · {{ c.info.version }}</template>
                      </span>
                    </button>
                  </td>
                </tr>
              </template>
            </tbody>
          </table>
        </div>

        <div class="cfg-foot">
          <!-- Live updates are what the screen is for, but they are also what
               makes it hard to click: rows re-sort under the pointer. Turning
               them off freezes the list; Refresh then takes one sweep on
               demand. -->
          <label class="scan-auto">
            <input type="checkbox" :checked="scanAuto"
                   @change="setScanAuto($event.target.checked)">
            Auto-refresh
          </label>
          <!-- Disabled while a sweep is in progress. Pressing again mid-sweep
               only restarts it, which looks like the button doing nothing. -->
          <button class="small" :disabled="dfuActive || scanRefreshing"
                  @click="refreshScan">
            <Icon name="refresh" :size="16"/>
            {{ scanRefreshing ? "Scanning…" : "Refresh" }}
          </button>
          <span class="grow"></span>
          <button @click="closeScanner">Close</button>
        </div>
      </div>
    </div>
  `,
};
