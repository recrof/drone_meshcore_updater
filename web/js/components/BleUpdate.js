import { ref, computed, watch } from "../vue.js";
import { smp, connected, log as appLog, deviceBoard } from "../store.js";
import { fmtSize } from "../lib/format.js";
import {
  loadIndex, entryForBoard, entriesWithDfu, assetUrl,
} from "../lib/firmware-manifest.js";
import {
  readUpdateImage, versionString, normalizeVersion, sameVersion,
} from "../lib/mcuboot-image.js";

/* CBOR byte strings arrive as Uint8Array; compare by value, not identity. */
function sameHash(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/*
 * Update the updater over Bluetooth.
 *
 * MCUboot is not itself a BLE DFU mechanism — it is a bootloader that swaps
 * slots at reset. The wireless half is mcumgr's img_mgmt group over the SMP
 * transport this app already speaks, which the firmware has had enabled all
 * along (CONFIG_MCUMGR_GRP_IMG, pulled in by MCUBOOT_IMG_MANAGER).
 *
 * The flow is deliberately not one button:
 *
 *     upload -> mark "test" -> reboot -> reconnect -> CONFIRM
 *
 * MCUboot is in SWAP_USING_MOVE mode, so an image that is marked test and
 * never confirmed is **reverted on the next reset**. That is the entire
 * safety net for updating a device whose only link is the thing being
 * updated: if the new firmware comes up too broken to reconnect, powering it
 * off and on puts the old one back. Confirming automatically would throw that
 * away, so this component makes confirmation a separate, deliberate act and
 * says what happens if you skip it.
 *
 * The image is always the one staged for this device's board — there is no
 * "upload a file you choose". Over Bluetooth that choice was the sharpest
 * edge in the app: the right file is dfu_application.zip or
 * zephyr.signed.bin, merged.hex is wrong and MCUboot cannot tell you so
 * (it validates a signature, not an architecture), and the device this runs
 * against is by definition one nobody can reach to recover. The index now
 * carries an entry per board and the device reports which board it is, so
 * the correct image is a lookup rather than a decision.
 */
export default {
  name: "BleUpdate",
  setup() {
    const busy = ref("");
    const error = ref("");
    const progress = ref(0);
    const slots = ref([]);
    const newest = ref(null);
    /* Every board the release published, so the UI can say "this board is not
     * among them" rather than the older, wronger "no build available". */
    const publishedBoards = ref([]);

    /* The running image, once it is testing but not yet permanent. This is
     * what survives a reboot and is why the UI is state-driven rather than a
     * wizard: you come back to a disconnected page and it still knows. */
    const active = computed(() => slots.value.find(s => s.active));
    const needsConfirm = computed(() => !!active.value && active.value.confirmed === false);
    const staged = computed(() => slots.value.find(s => !s.active));

    /*
     * img_mgmt only lists slots holding a valid image header, so "one entry"
     * is itself the answer to "did the upload land?" — a device that has
     * never been updated over the air reports slot 0 alone. Saying that out
     * loud beats making someone infer it from a table with one row.
     */
    /* What the manifest says is on offer, and how it compares to what is
     * running. Known before the download, because stage-firmware.mjs reads
     * the header at publish time — the alternative is fetching 280 KB to find
     * out you already have it. */
    const availableVersion = computed(() =>
      newest.value?.dfuVersion ? normalizeVersion(newest.value.dfuVersion) : null);
    const runningVersion = computed(() =>
      active.value?.version ? normalizeVersion(active.value.version) : null);
    const alreadyOnLatest = computed(() =>
      sameVersion(availableVersion.value, runningVersion.value));

    /* Is the offered image even for this board?
     *
     * MCUboot cannot answer this. It validates a signature, not an
     * architecture, and every board this project builds for signs with the
     * same key — so an nRF54L image pushed to an nRF52840 verifies, swaps in
     * on reboot, and then does not boot. (Recoverable: the board's own USB
     * bootloader is still there. Alarming all the same, after a multi-minute
     * transfer.)
     *
     * Both halves are optional and each absence means something different, so
     * they are distinguished rather than lumped into one falsy check: a
     * manifest staged before board fields existed, or firmware predating
     * os_mgmt info. Either way the answer is "cannot tell", which warns; only
     * a positive mismatch blocks. */
    const boardMismatch = computed(() => {
      const want = newest.value?.board;
      const have = deviceBoard.value;
      if (!want || !have) return null;
      return want === have ? null : { want, have };
    });
    const boardUnknown = computed(() =>
      !!newest.value && (!newest.value.board || !deviceBoard.value));

    /* The device says which board it is, and the index has an entry per board,
     * so the common case is now a *selection* rather than a refusal. This is
     * only null when the release genuinely published nothing for this part —
     * which is a different sentence, and it gets one. */
    const noBuildForBoard = computed(() =>
      !newest.value && !!deviceBoard.value && publishedBoards.value.length > 0);

    /*
     * One line saying where the device stands.
     *
     * This replaced a table of MCUboot slots — slot number, version, active,
     * pending, confirmed. That is an accurate picture of what the bootloader
     * is doing and it answers a question almost nobody has. What someone
     * holding a repeater wants to know is whether the thing is up to date,
     * and if not, what it would become. Slot state is still read (it is what
     * `needsConfirm` and the identical-image check are computed from); it is
     * just no longer the interface.
     */
    const statusLine = computed(() => {
      if (!connected.value) return "";
      if (!runningVersion.value) return "";
      if (alreadyOnLatest.value) return `Up to date — running v${runningVersion.value}`;
      if (availableVersion.value) {
        return `Running v${runningVersion.value} · v${availableVersion.value} available`;
      }
      return `Running v${runningVersion.value}`;
    });

    /* What just happened, in one sentence. Set on a successful update and
     * cleared when anything else starts, so the screen answers "did it work?"
     * without the reader reconstructing it from a progress bar that has
     * finished and a device that has gone away to reboot. */
    const outcome = ref("");

    async function refreshState() {
      if (!connected.value) { slots.value = []; return; }
      try {
        const r = await smp.imgState();
        slots.value = (r.images || []).map(i => ({
          slot: i.slot, version: i.version, hash: i.hash,
          active: !!i.active, confirmed: !!i.confirmed,
          pending: !!i.pending, bootable: !!i.bootable,
        }));
      } catch (e) {
        /* Firmware without img_mgmt, or an older build. Not fatal — the USB
         * route below still works. */
        slots.value = [];
        error.value = `image state unavailable: ${e.message}`;
      }
    }

    async function loadManifest() {
      try {
        const index = await loadIndex();
        const withDfu = entriesWithDfu(index);
        publishedBoards.value = withDfu.map(b => b.board);

        /* Select the entry for the board the device reports. Falling back to
         * "the only one there is" when the device does not report a board
         * keeps firmware predating os_mgmt info updatable — the boardUnknown
         * warning below still fires, so the choice is visible rather than
         * silent. With several boards published and no way to tell them
         * apart, there is no safe pick and we offer none. */
        const forBoard = entryForBoard(index, deviceBoard.value);
        newest.value = forBoard?.dfu ? forBoard
                     : (!deviceBoard.value && withDfu.length === 1 ? withDfu[0] : null);
      } catch {
        newest.value = null;
        publishedBoards.value = [];
      }
    }
    /* The board arrives with the first state fetch, after the manifest has
     * already been read once — so re-select when it does, or a device that
     * reported late would be told there is nothing for it. */
    watch(deviceBoard, () => { if (connected.value) loadManifest(); });

    /*
     * Read twice on connect. The firmware confirms a freshly swapped image
     * the moment a peer connects (selfconfirm.c), which races this very
     * read — connect and the first state fetch happen together, so the
     * device may still say "unconfirmed" and then confirm a millisecond
     * later. Without the second read the banner sits there claiming a trial
     * that has already ended.
     */
    watch(connected, async (isConnected) => {
      await refreshState();
      if (!isConnected) return;
      setTimeout(() => { if (connected.value) refreshState(); }, 1500);
    }, { immediate: true });
    loadManifest();

    async function guard(label, fn) {
      busy.value = label;
      error.value = "";
      try { return await fn(); }
      catch (e) { error.value = e.message; appLog(`update: ${e.message}`, "err"); throw e; }
      finally { busy.value = ""; progress.value = 0; }
    }

    /* Upload, mark for test, reboot. Stops there on purpose. */
    async function apply(bytes, name) {
      const img = readUpdateImage(bytes, name);
      appLog(`update image: ${img.source}, ${fmtSize(img.bytes.length)}, ` +
             `v${versionString(img.header)}`, "ok");

      await smp.imgUpload(img.bytes, (f) => { progress.value = Math.floor(f * 100); });
      appLog("image uploaded to the spare slot", "ok");

      const st = await smp.imgState();
      const spare = (st.images || []).find(i => !i.active);
      const running = (st.images || []).find(i => i.active);
      if (!spare) throw new Error("uploaded, but the device reports no second slot");

      /*
       * img_mgmt identifies images by hash, and two byte-identical images
       * have the same hash — so find_by_hash() resolves to whichever slot it
       * reaches first, which is the active one. Marking the *running* slot
       * for test is then denied, and the upload was wasted.
       *
       * Catching it here says something true and useful instead of surfacing
       * the device's refusal for an operation that was never meaningful:
       * re-uploading what is already running is a no-op by definition.
       */
      if (running && sameHash(running.hash, spare.hash)) {
        throw new Error(
          "this image is byte-identical to the one already running, so there is " +
          "nothing to swap. Build or download a different version to test an update.");
      }
      await smp.imgSetPending(spare.hash);
      appLog("marked for test — rebooting", "ok");

      await smp.osReset();
      appLog("device rebooting into the new image", "ok");
      outcome.value =
        `Updated to v${normalizeVersion(spare.version) ?? "?"}. The device is restarting; ` +
        `reconnect to check it came back. It confirms itself once it does.`;
    }

    async function updateNewest() {
      outcome.value = "";
      try {
        await guard("uploading", async () => {
          /* Checked here as well as in the template's :disabled, because a
           * disabled button is a hint and this is the actual guarantee. */
          if (boardMismatch.value) {
            throw new Error(
              `this build is for ${boardMismatch.value.want} and the device is ` +
              `${boardMismatch.value.have} — it would install and then fail to boot`);
          }
          const url = assetUrl(newest.value, newest.value.dfu);
          const res = await fetch(url, { cache: "no-cache" });
          if (!res.ok) throw new Error(`could not fetch ${url}: HTTP ${res.status}`);
          await apply(new Uint8Array(await res.arrayBuffer()), newest.value.dfu);
        });
      } catch { /* reported */ }
    }

    async function confirm() {
      if (active.value?.confirmed) {
        error.value = "this image is already confirmed — nothing to do";
        return;
      }
      try {
        await guard("confirming", async () => {
          await smp.imgConfirm();
          await refreshState();
          appLog("update confirmed — it is now permanent", "ok");
        });
      } catch { /* reported */ }
    }

    return {
      /* `slots`, `active` and `staged` are deliberately not exposed: they are
       * how needsConfirm / alreadyOnLatest are computed, not something the
       * template renders any more. */
      connected, busy, error, progress, newest,
      boardMismatch, boardUnknown, deviceBoard, publishedBoards, noBuildForBoard,
      needsConfirm, statusLine, outcome, fmtSize,
      availableVersion, runningVersion, alreadyOnLatest,
      updateNewest, confirm, refreshState,
    };
  },
  template: /* html */ `
    <div class="upd">
      <div class="cfg-banner err" v-if="!connected">
        Not connected. Press <strong>Connect</strong> in the toolbar to update
        over Bluetooth, or use USB below.
      </div>

      <!-- The state that matters most, so it goes first and stays until acted
           on. A device sitting unconfirmed will silently revert. -->
      <!-- The firmware normally confirms itself once a connection proves it
           works, so seeing this for more than a moment means that did not
           happen — worth saying, since the manual button is then the only
           thing standing between the update and a revert. -->
      <div class="cfg-banner warn" v-else-if="needsConfirm">
        <strong>This update is still on trial.</strong> It normally confirms
        itself a second or two after connecting; if this stays, keep it — or the
        device goes back to the previous version next time it restarts.
        <button class="small primary" :disabled="!!busy" @click="confirm">
          {{ busy === "confirming" ? "Keeping…" : "Keep this update" }}
        </button>
        <button class="small" :disabled="!!busy" @click="refreshState">Re-check</button>
      </div>

      <template v-if="connected && !needsConfirm">
        <!-- Uploading what is already running is refused by the device after
             the whole transfer, so say it before rather than after. -->
        <div class="cfg-banner" v-if="alreadyOnLatest">
          Already running <strong>v{{ runningVersion }}</strong>, which is the
          newest published build. Nothing to do.
        </div>

        <div class="flash-step">
          <button class="primary" :disabled="!!busy || !newest || alreadyOnLatest || !!boardMismatch"
                  @click="updateNewest">
            {{ busy === "uploading" ? "Uploading…" : "Update over Bluetooth" }}
          </button>
          <!-- Version and size only. The release tag duplicates the version,
               the running version is in the status line below, and the board
               is only worth saying when it is *wrong* — which has its own
               banner. -->
          <span class="flash-note" v-if="newest">
            <strong v-if="availableVersion">v{{ availableVersion }}</strong><template
              v-if="newest.dfuBytes"> · {{ fmtSize(newest.dfuBytes) }}</template>
          </span>
          <span class="flash-note warn" v-else-if="!noBuildForBoard">no published build available</span>
          <span class="flash-note warn" v-else>
            nothing published for <strong>{{ deviceBoard }}</strong>
          </span>
        </div>

        <!-- The index carries an entry per board, so "no build" now has two
             distinct causes and they read very differently to someone holding
             the device: nothing was released at all, or this particular part
             was not among what was released. -->
        <div class="flash-note warn" v-if="noBuildForBoard">
          This release published {{ publishedBoards.join(", ") }} — but nothing for
          <strong>{{ deviceBoard }}</strong>, which is what this device reports.
        </div>

        <!-- A positive mismatch blocks; "cannot tell" only warns. MCUboot
             checks the signature and not the architecture, and every board
             here signs with the same key, so nothing downstream catches
             this. -->
        <div class="flash-note err" v-if="boardMismatch">
          This build is for <strong>{{ boardMismatch.want }}</strong> and the device
          reports <strong>{{ boardMismatch.have }}</strong>. It would verify, install,
          and then fail to boot — recover with USB. Update blocked.
        </div>
        <div class="flash-note warn" v-else-if="boardUnknown">
          Cannot tell whether this build matches the device
          <template v-if="!deviceBoard">(this firmware does not report its board)</template>
          <template v-else>(the published build does not say which board it is for)</template>.
          Check before updating.
        </div>

      </template>

      <div class="flash-progress" v-if="busy === 'uploading'">
        <div class="bar"><div class="fill" :style="{ width: progress + '%' }"></div></div>
        <span class="mono">Uploading {{ progress }}%</span>
      </div>

      <p class="cfg-status err" v-if="error">{{ error }}</p>
      <div class="cfg-banner ok" v-if="outcome">{{ outcome }}</div>

      <p class="upd-status" v-if="statusLine">{{ statusLine }}</p>
    </div>
  `,
};
