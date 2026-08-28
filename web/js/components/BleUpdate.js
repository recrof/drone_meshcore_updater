import { ref, computed, watch } from "../vue.js";
import { smp, connected, log as appLog } from "../store.js";
import { fmtSize } from "../lib/format.js";
import {
  readUpdateImage, versionString, normalizeVersion, sameVersion,
} from "../lib/mcuboot-image.js";

const FIRMWARE_DIR = "firmware/";

/* CBOR byte strings arrive as Uint8Array; compare by value, not identity. */
function sameHash(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
const MANIFEST_URL = `${FIRMWARE_DIR}manifest.json`;

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
 */
export default {
  name: "BleUpdate",
  setup() {
    const busy = ref("");
    const error = ref("");
    const progress = ref(0);
    const slots = ref([]);
    const newest = ref(null);
    const picker = ref(null);

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

    const slotSummary = computed(() => {
      if (!slots.value.length) return "";
      if (slots.value.length === 1) {
        return "only one image on the device — nothing is staged in the spare slot";
      }
      return staged.value?.pending
        ? "an update is staged and will be swapped in on the next reboot"
        : "the spare slot holds the previous image";
    });

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
        const res = await fetch(MANIFEST_URL, { cache: "no-cache" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const m = await res.json();
        newest.value = m.dfu ? m : null;
      } catch {
        newest.value = null;
      }
    }

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
      appLog("device rebooting into the new image. Reconnect, then Confirm.", "ok");
    }

    async function updateNewest() {
      try {
        await guard("uploading", async () => {
          const url = FIRMWARE_DIR + newest.value.dfu;
          const res = await fetch(url, { cache: "no-cache" });
          if (!res.ok) throw new Error(`could not fetch ${url}: HTTP ${res.status}`);
          await apply(new Uint8Array(await res.arrayBuffer()), newest.value.dfu);
        });
      } catch { /* reported */ }
    }

    async function updateCustom(e) {
      const file = e.target.files?.[0];
      e.target.value = "";
      if (!file) return;
      try {
        await guard("uploading", async () =>
          apply(new Uint8Array(await file.arrayBuffer()), file.name));
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
      connected, busy, error, progress, slots, newest, picker,
      active, needsConfirm, staged, slotSummary, fmtSize,
      availableVersion, runningVersion, alreadyOnLatest, normalizeVersion,
      updateNewest, updateCustom, confirm, refreshState,
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
        <strong>This firmware is running on trial.</strong> It confirms itself
        once a Bluetooth connection proves it works, so this should clear on its
        own within a second or two. If it persists, confirm it here — otherwise
        MCUboot puts the previous version back on the next reset.
        <button class="small primary" :disabled="!!busy" @click="confirm">
          {{ busy === "confirming" ? "Confirming…" : "Confirm this update" }}
        </button>
        <button class="small" :disabled="!!busy" @click="refreshState">Re-check</button>
      </div>

      <template v-if="connected && !needsConfirm">
        <!-- Uploading what is already running is refused by the device after
             the whole transfer, so say it before rather than after. -->
        <div class="cfg-banner" v-if="alreadyOnLatest">
          Already running <strong>v{{ runningVersion }}</strong> — the available
          build is the same version. Uploading it would be refused: the device
          identifies images by hash, and cannot mark the running slot for test.
        </div>

        <div class="flash-step">
          <button class="primary" :disabled="!!busy || !newest || alreadyOnLatest"
                  @click="updateNewest">
            {{ busy === "uploading" ? "Uploading…" : "Update over Bluetooth" }}
          </button>
          <span class="flash-note" v-if="newest">
            <strong v-if="availableVersion">v{{ availableVersion }}</strong><template
              v-if="availableVersion && newest.tag"> · </template><template
              v-if="newest.tag">{{ newest.tag }}</template><template
              v-if="newest.dfuBytes"> · {{ fmtSize(newest.dfuBytes) }}</template><template
              v-if="runningVersion && !alreadyOnLatest">
              · running v{{ runningVersion }}</template>
          </span>
          <span class="flash-note warn" v-else>no published build available</span>
        </div>

        <div class="flash-step">
          <label class="btn" :class="{ disabled: !!busy }">
            Upload custom image…
            <input type="file" accept=".zip,.bin" :disabled="!!busy" @change="updateCustom">
          </label>
          <span class="flash-note">
            <code>dfu_application.zip</code> or <code>zephyr.signed.bin</code> —
            not <code>merged.hex</code>
          </span>
        </div>
      </template>

      <div class="flash-progress" v-if="busy === 'uploading'">
        <div class="bar"><div class="fill" :style="{ width: progress + '%' }"></div></div>
        <span class="mono">Uploading {{ progress }}%</span>
      </div>

      <p class="cfg-status err" v-if="error">{{ error }}</p>

      <div class="upd-slots" v-if="slots.length">
        <span v-for="s in slots" :key="s.slot" class="upd-slot">
          slot {{ s.slot }}: v{{ normalizeVersion(s.version) }}<template v-if="s.active"> · running</template><template
            v-if="s.pending"> · pending</template><template
            v-if="s.active && !s.confirmed"> · unconfirmed</template><template
            v-if="s.active && s.confirmed"> · confirmed</template>
        </span>
        <span class="upd-summary">{{ slotSummary }}</span>
      </div>
    </div>
  `,
};
