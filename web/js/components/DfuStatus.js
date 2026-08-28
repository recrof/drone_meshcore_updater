import { ref, computed, watch } from "../vue.js";
import { dfuStatus, dfuRate, openLogView } from "../store.js";
import { STATE } from "../lib/dfu-status.js";
import Icon from "./Icon.js";

/*
 * The banner that answers "is this thing doing anything?".
 *
 * Before this, a browser that triggered a DFU got one log line and then
 * nothing: the transfer happens entirely between the updater and its target,
 * and the only evidence was the LED on a device that is usually not in the
 * room. The device now publishes a small status record over GATT
 * (src/dfu_status.c) and this renders it.
 *
 * Two deliberate choices:
 *
 *   - **It is not dismissible while a run is active.** Its whole job is to be
 *     the thing you cannot miss; a hidden progress banner is a status line
 *     nobody reads. Terminal states get an × because a "Complete" that never
 *     goes away is just clutter.
 *
 *   - **It offers the log rather than containing detail.** Steps, retries and
 *     per-packet timing are all in the device log, which has a viewer already.
 *     Duplicating any of that here would mean two places to keep true.
 */
export default {
  name: "DfuStatus",
  components: { Icon },
  setup() {
    const dismissed = ref(false);

    /* A new run un-dismisses: the × applies to the result you dismissed, not
     * to the feature. */
    watch(() => dfuStatus.value.state, (state, prev) => {
      if (state !== prev && state !== STATE.IDLE && !dfuStatus.value.terminal) {
        dismissed.value = false;
      }
    });

    const s = dfuStatus;
    const show = computed(() =>
      s.value.state !== STATE.IDLE && !(s.value.terminal && dismissed.value));

    /* A handshake of unknown duration gets the sweeping bar — one sitting at
     * 0% through a 6 s scan reads as "stuck" rather than "busy". Everything
     * else has a real number: the upload has its percentage, and a finished
     * run has its outcome. Leaving the sweep running after DONE was the
     * original bug — a completed transfer animating as though it were still
     * working is the one thing this banner exists not to do. */
    const determinate = computed(() =>
      s.value.state === STATE.UPLOADING || s.value.terminal);

    /* DONE is 100% by definition. A failure keeps whatever it reached, which
     * is worth seeing — "failed at 30%" and "never started" are different
     * problems. */
    const barPercent = computed(() => {
      if (s.value.state === STATE.DONE) return 100;
      if (!determinate.value) return 100;      // width is set by the animation
      return s.value.percent;
    });

    const tone = computed(() => {
      if (s.value.state === STATE.DONE) return "ok";
      if (s.value.state === STATE.FAILED) return "fail";
      return "run";
    });

    const elapsed = computed(() => {
      const total = Math.floor(s.value.elapsedMs / 1000);
      const m = Math.floor(total / 60);
      return `${m}:${String(total % 60).padStart(2, "0")}`;
    });

    /* Everything that is true right now, in one line, in the order someone
     * scanning it would want: how far, how fast, which try, how long. Parts
     * that are not yet known are left out rather than shown as zero. */
    const detail = computed(() => {
      const parts = [];
      if (s.value.total) {
        parts.push(`${(s.value.sent / 1024).toFixed(0)} / ` +
                   `${(s.value.total / 1024).toFixed(0)} KB`);
      }
      if (dfuRate.value > 0 && s.value.state === STATE.UPLOADING) {
        parts.push(`${(dfuRate.value / 1024).toFixed(1)} KB/s`);
      }
      if (s.value.attempt > 0 && s.value.retries > 0) {
        parts.push(`attempt ${s.value.attempt}/${s.value.retries}`);
      }
      parts.push(elapsed.value);
      return parts.join(" · ");
    });

    /* Target and bundle: which peer, which file. Empty early in a run and
     * for an auto-flash that has not resolved its bundle yet. */
    const subject = computed(() =>
      [s.value.target, s.value.file].filter(Boolean).join(" · "));

    /* Streaming only while there is something to stream. During a transfer
     * the file on flash is missing exactly the lines being asked for, so the
     * live view is the only useful one; afterwards it is an empty pane that
     * will never fill, and the newest log file is what has the run in it. */
    const openLog = () => openLogView("", s.value.active);
    const logLabel = computed(() => s.value.active ? "Watch log" : "View log");
    const logTitle = computed(() => s.value.active
      ? "Open the device log, streaming live"
      : "Open the device log for this run");

    return {
      status: s, show, determinate, barPercent, tone, detail, subject,
      dismissed, openLog, logLabel, logTitle, STATE,
    };
  },
  template: /* html */ `
    <div v-if="show" class="dfu-banner" :class="tone" role="status" aria-live="polite">
      <div class="dfu-row">
        <span class="dfu-dot" aria-hidden="true"></span>
        <span class="dfu-state">{{ status.stateLabel }}</span>
        <span class="dfu-subject" v-if="subject">{{ subject }}</span>
        <span class="grow"></span>
        <button class="icon-btn dfu-watch" @click="openLog"
                :title="logTitle" aria-label="Open the device log">
          <Icon name="description"/><span class="label">{{ logLabel }}</span>
        </button>
        <button v-if="status.terminal" class="dfu-dismiss" @click="dismissed = true"
                title="Dismiss" aria-label="Dismiss">&times;</button>
      </div>

      <div class="dfu-bar" :class="{ indeterminate: !determinate }"
           role="progressbar" :aria-valuenow="determinate ? barPercent : null"
           aria-valuemin="0" aria-valuemax="100">
        <div class="fill" :style="{ width: barPercent + '%' }"></div>
      </div>

      <div class="dfu-row dfu-detail">
        <span v-if="determinate" class="dfu-pct">{{ barPercent }}%</span>
        <span>{{ detail }}</span>
        <span class="grow"></span>
        <span v-if="status.terminal" class="dfu-result">{{ status.resultLabel }}</span>
      </div>
    </div>
  `,
};
