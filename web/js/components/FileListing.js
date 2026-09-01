import { computed } from "../vue.js";
import {
  connected, deviceTransports, entries, listError, path,
  activateEntry, rename, remove, flashFile, fileInfo, inspectFile,
} from "../store.js";
import { fmtSize, joinPath } from "../lib/format.js";
import { isConfigPath } from "../lib/config-file.js";
import { isLogPath } from "../lib/log-file.js";
import { TRANSPORT, transportForName, transportsFromMask } from "../lib/firmware-image.js";
import Icon from "./Icon.js";

/* Said in the tooltip of a disabled flash button. Names the transport the
 * file wants, because "this updater cannot flash it" invites the reader to
 * suspect the file. */
const BLOCKED = {
  [TRANSPORT.BLE]:
    "this updater has no Bluetooth DFU transport, so it cannot send a .zip",
  [TRANSPORT.WIFI]:
    "this updater has no WiFi transport, so it cannot send a raw .bin — " +
    "that route is built only for boards with a WiFi radio",
};

/*
 * The order the listing is read in, top to bottom.
 *
 * Alphabetical was the obvious order and the wrong one, because it sorts by
 * the least interesting thing a file has. On a device holding a config, a
 * bundle and three rotated logs it interleaved all three kinds and buried
 * config.txt in the middle — the one file that is always present, always the
 * same name, and the reason most people open this screen.
 *
 * So: the file you edit, then the files you flash, then the files you read
 * when a flash went wrong. That is the order of the work, and it is also
 * roughly the order of how often each is touched.
 *
 * Directories rank above the files rather than below because they contain
 * them; there are none in practice — nothing this device reads lives below
 * the root — but a listing that put a folder after its own siblings would
 * read as a bug the first time one appeared. OTHER is everything that is not
 * one of the four: an upload that failed halfway, a file put there by hand.
 * It sits above the logs because it is unexplained, and unexplained things
 * are worth seeing.
 */
const GROUP = { CONFIG: 0, DIR: 1, FIRMWARE: 2, OTHER: 3, LOG: 4 };

const groupOf = (r) =>
  r.isCfg      ? GROUP.CONFIG
  : r.isDir    ? GROUP.DIR
  : r.isFirmware ? GROUP.FIRMWARE
  : r.isLog    ? GROUP.LOG
  : GROUP.OTHER;

export default {
  name: "FileListing",
  components: { Icon },
  setup() {
    const rows = computed(() => {
      /* transportsFromMask(null) is [BLE]: every build ever shipped has had
       * it, so firmware too old to answer fsxCaps still offers .zip. */
      const have = deviceTransports.value ?? transportsFromMask(null);
      return entries.value.map(e => {
        const full = joinPath(path.value, e.name);
        const isDir = e.type === 1;
        const isCfg = !isDir && isConfigPath(full);
        const isLog = !isDir && isLogPath(full);
        /* Which radio this file would need, from its name alone — the device
         * has not necessarily been asked about it, and may never be. */
        const needs = isDir ? null : transportForName(e.name);
        return {
          ...e,
          isDir,
          /* Anything the device can have an opinion about: a .zip for the
           * Bluetooth transport, a .bin for the WiFi one. Both get a "flash"
           * action — it is the primary reason files land on this device — and
           * both get "check", because "what is this file" is a useful answer
           * even when the answer is that it cannot be sent. */
          isFirmware: needs !== null,
          needs,
          /* Asked of the device at connect (fsxCaps) rather than inferred
           * from the board, so a build without the WiFi transport says so
           * itself instead of the client guessing from a table. */
          canFlash: needs !== null && have.includes(needs),
          isCfg,
          isLog,
          full,
          hint: isDir ? "Folder"
              : isCfg ? "Edit configuration"
              : isLog ? "View log"
              : "Download",
        };
      })
      /* Grouped here rather than in store.js's fetch, because the grouping
       * needs isCfg / isFirmware / isLog and those are decided above — the
       * store sees names and a type flag and nothing else. */
      .sort((a, b) => groupOf(a) - groupOf(b) ||
        /* numeric so LOG.0009 comes before LOG.0010, and a v1.9 bundle before
         * a v1.10 one. Plain string order gets both backwards. */
        a.name.localeCompare(b.name, undefined, { numeric: true }));
    });

    const empty = computed(() => {
      if (!connected.value) return listError.value || "Connect to a device to browse files.";
      if (listError.value) return listError.value;
      if (rows.value.length === 0) return "(empty directory)";
      return null;
    });

    const activate = (row) => activateEntry(row.full, row.isDir);

    /* Why the flash button is greyed out, for its tooltip. Empty when it is
     * not — a title on a live button is noise. */
    const whyBlocked = (row) =>
      row.canFlash ? "" : (BLOCKED[row.needs] ?? "");

    /* One line describing what the device found, or null while nothing has
     * been asked. Deliberately terse: the full reason is the tooltip, because
     * a listing row is not the place for a paragraph. */
    const verdict = (row) => {
      const info = fileInfo[row.full];
      if (!info || info.size !== row.size) return null;
      if (info.pending) return { cls: "", text: "checking…" };
      if (info.unavailable) return { cls: "warn", text: "could not check", full: info.unavailable };
      const label = [info.name, info.version].filter(Boolean).join(" ");
      if (info.flashable) {
        return { cls: "ok", text: label ? `ok — ${label}` : "ok", full: info.reason };
      }
      return { cls: "err", text: info.reason || "not flashable", full: info.reason };
    };

    return {
      rows, empty, fmtSize, activate, rename, remove, flashFile,
      verdict, check: (row) => inspectFile(row.full, row.size),
      whyBlocked,
    };
  },
  template: /* html */ `
    <main>
      <table class="file-table">
        <thead>
          <tr><th>Name</th><th>Size</th><th></th></tr>
        </thead>
        <tbody>
          <tr v-if="empty">
            <td colspan="3" class="empty">{{ empty }}</td>
          </tr>
          <tr v-else v-for="row in rows" :key="row.name">
            <td class="name" :class="[row.isDir ? 'dir' : 'file',
                                      { cfg: row.isCfg, log: row.isLog }]"
                :title="row.hint" @click="activate(row)">
              {{ row.name }}
              <div v-if="verdict(row)" class="file-verdict" :class="verdict(row).cls"
                   :title="verdict(row).full || ''">{{ verdict(row).text }}</div>
            </td>
            <td class="size">{{ row.isDir ? "" : fmtSize(row.size) }}</td>
            <td class="actions">
              <!-- Shown disabled rather than hidden when this updater has
                   no transport for the file. An absent button is
                   indistinguishable from a bug, and the reason it is absent
                   is the single most useful thing to say here. -->
              <button v-if="row.isFirmware" class="primary small"
                      :disabled="!row.canFlash" :title="whyBlocked(row)"
                      @click.stop="flashFile(row.full)">
                <Icon name="bolt_boost" :size="16"/>Flash
              </button>
              <button v-if="row.isFirmware" class="small"
                      @click.stop="check(row)">
                <Icon name="search_check_2" :size="16"/>Check
              </button>
              <!-- Icon-only, unlike flash/check beside them. These two are
                   universal file operations with settled glyphs, so a label
                   buys nothing; flash and check are this project's own verbs
                   and would be a guessing game as pictures. The accessible
                   name is on aria-label, and the tooltip repeats the file so
                   a mis-aimed click is recoverable before it happens. -->
              <button class="icon-only" :title="'Rename ' + row.name"
                      :aria-label="'Rename ' + row.name"
                      @click.stop="rename(row.full)">
                <Icon name="drive_file_rename" :size="18"/>
              </button>
              <button class="icon-only danger" :title="'Delete ' + row.name"
                      :aria-label="'Delete ' + row.name"
                      @click.stop="remove(row.full, row.isDir)">
                <Icon name="trash" :size="18"/>
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </main>
  `,
};
