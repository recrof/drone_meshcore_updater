import { ref, computed, watch, onUnmounted } from "../vue.js";
import { onEscape } from "../lib/dialog.js";
import { dfuStatus, submitPin, cancelPin, pinRequest, submitRetryPin, cancelRetryPin }
  from "../store.js";
import { STATE } from "../lib/dfu-status.js";

/*
 * "The target is showing a PIN. Type it."
 *
 * ---- Two questions, one dialog -----------------------------------------
 *
 * There are two moments a PIN is wanted and they are not the same question:
 *
 *  - **live** — the firmware has parked a pairing and is holding it open.
 *    Answering feeds `FSX_MGMT_ID_SUBMIT_PIN` into a pairing that is still
 *    running, and there is a clock, because SMP's own 30 s is spending.
 *  - **retry** — a run ended with the target refusing an unencrypted link.
 *    Nothing is being held open, so there is no clock; answering re-triggers
 *    the whole flash with the PIN attached.
 *
 * The retry ask used to be a `prompt()`, and it went on firing after the live
 * path stopped using one — so a target that displayed a PIN and then gave up
 * produced this dialog *and*, at a moment of the browser's choosing, a native
 * modal asking the same thing. Reported as the prompt appearing "randomly",
 * which is exactly what a modal scheduled by the browser rather than the page
 * looks like from the outside.
 *
 * ---- Why this is a component and not prompt() --------------------------
 *
 * It was prompt(), and prompt() is the wrong tool for a question with a
 * deadline. Three reasons, and the first one is what was reported:
 *
 *  - **The browser decides when to show it.** A native modal from a tab that
 *    is not frontmost is deferred until the tab is, so the sequence observed
 *    in the field was: the target displays a PIN, no prompt, the PIN times
 *    out, *then* the prompt appears — asking for a number that had already
 *    expired. Nothing in the page can hurry that along.
 *  - **It blocks the main thread**, so nothing behind it updates: no
 *    countdown, and no way for the dialog to notice that the window has
 *    already closed.
 *  - **It cannot show the clock**, and this question has one. The pairing is
 *    held open for SMP's 30 s and not a moment longer, which is the single
 *    most useful thing to tell someone squinting at another device's screen.
 *
 * ---- The window ---------------------------------------------------------
 *
 * `SMP_TIMEOUT` in Zephyr's smp.c is 30 s, measured from the pairing, not
 * from this dialog opening — the notification takes some of it. The countdown
 * therefore starts from when we heard, and is deliberately shown as
 * "about", because being a second or two optimistic here is worse than being
 * vague: it would have someone still typing into a pairing that is gone.
 */
const WINDOW_MS = 30000;

export default {
  name: "PinDialog",
  setup() {
    const pin = ref("");
    const error = ref("");
    const sending = ref(false);
    const left = ref(WINDOW_MS);

    /* Driven by the device's own state, not by a local flag: another client,
     * or the device itself, can end the pairing, and a dialog that outlived
     * it would be collecting digits nothing is waiting for. */
    const live = computed(() => dfuStatus.value.state === STATE.AWAITING_PIN);
    /* The live ask wins if both are somehow set: store.js clears the retry on
     * AWAITING_PIN, and this is the second line of that same defence — digits
     * on a screen right now belong to the pairing that is open. */
    const retry = computed(() => !live.value && pinRequest.value);
    const open = computed(() => live.value || !!retry.value);

    const target = computed(() =>
      retry.value ? retry.value.label
                  : (dfuStatus.value.name || dfuStatus.value.file || "the target"));
    const rejected = computed(() => !!retry.value?.rejected);
    const secs = computed(() => Math.max(0, Math.ceil(left.value / 1000)));

    let timer = null;
    const stopTimer = () => { if (timer) { clearInterval(timer); timer = null; } };

    watch(open, (isOpen) => {
      /* A rejected PIN comes back pre-filled: the likeliest correction is one
       * digit, and retyping six from memory is how the second attempt gets
       * spent on the same mistake. */
      pin.value = (retry.value && retry.value.pin) || "";
      error.value = rejected.value ? "the target rejected that PIN" : "";
      sending.value = false;
      stopTimer();
      /* No clock on the retry ask, because nothing is counting down: the run
       * is over and the next one starts when this is answered. A countdown
       * there would be an invented deadline. */
      if (!isOpen || !live.value) return;
      const started = Date.now();
      left.value = WINDOW_MS;
      timer = setInterval(() => {
        left.value = WINDOW_MS - (Date.now() - started);
        if (left.value <= 0) stopTimer();
      }, 250);
    }, { immediate: true });

    onUnmounted(stopTimer);

    /* Escape cancels rather than merely hiding: leaving the pairing open with
     * nobody answering it would keep the target displaying a PIN into a
     * timeout for no reason. Same as the Cancel button. */
    const cancel = async () => {
      stopTimer();
      if (retry.value) {
        cancelRetryPin();
        return;
      }
      await cancelPin();
    };
    onEscape(() => open.value, () => cancel());

    const submit = async () => {
      const v = pin.value.trim();
      /* Checked here as well as on the device, because a round trip spends
       * part of a 30 s budget and a typo should not cost any of it. */
      if (!/^[0-9]{1,6}$/.test(v)) {
        error.value = "one to six digits";
        return;
      }
      sending.value = true;
      error.value = "";
      if (retry.value) {
        await submitRetryPin(v);
        sending.value = false;
        return;
      }
      const r = await submitPin(v);
      sending.value = false;
      /* `taken: false` is the window having closed under us. Saying so beats
       * the dialog just vanishing, which reads as the PIN having been wrong. */
      if (r && r.taken === false) error.value = "too late — the target stopped waiting";
    };

    return { open, live, pin, error, sending, secs, target, submit, cancel };
  },
  template: /* html */ `
    <div id="pin-overlay" :class="{ shown: open }" v-if="open" @click.self="cancel">
      <div class="cfg-modal pin-modal" role="dialog" aria-modal="true"
           aria-label="Enter the target's PIN">
        <div class="cfg-head">
          <span class="title">PAIRING PIN</span>
          <span class="grow"></span>
          <button class="icon-only"
                  :aria-label="live ? 'Cancel pairing' : 'Do not retry'"
                  @click="cancel">✕</button>
        </div>
        <div class="cfg-body">
          <p class="pin-lead" v-if="live">
            <strong>{{ target }}</strong> is showing a PIN. Type the digits on
            its screen.
          </p>
          <p class="pin-lead" v-else>
            <strong>{{ target }}</strong> will not accept an unencrypted
            connection. Enter its Bluetooth PIN to flash it again.
          </p>
          <input class="pin-input" type="text" inputmode="numeric"
                 autocomplete="one-time-code" maxlength="6" v-model="pin"
                 :disabled="sending" placeholder="––––––"
                 aria-label="PIN shown on the target"
                 @keyup.enter="submit" v-focus>
          <p class="pin-err" v-if="error">{{ error }}</p>
          <!-- The clock is the point. These digits belong to this pairing and
               are regenerated by the target on the next attempt, so a stale
               reading is worse than none. -->
          <p class="pin-clock" v-if="live" :class="{ urgent: secs <= 10 }">
            about {{ secs }}s left before the target stops waiting
          </p>
          <p class="pin-note" v-else>
            Used for this run only — set <code>ble_pin</code> under Config… to
            make it the default for every target.
          </p>
        </div>
        <div class="cfg-foot">
          <span class="grow"></span>
          <button class="small" @click="cancel" :disabled="sending">Cancel</button>
          <button class="small primary" @click="submit" :disabled="sending || !pin">
            {{ sending ? "Sending…" : (live ? "Send PIN" : "Flash again") }}
          </button>
        </div>
      </div>
    </div>
  `,
  directives: {
    /* Focus on open, so the digits can be typed without a click — this dialog
     * exists to be answered in seconds. */
    focus: { mounted: (el) => el.focus() },
  },
};
