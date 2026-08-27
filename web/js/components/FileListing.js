import { computed } from "../vue.js";
import {
  connected, entries, listError, path,
  activateEntry, rename, remove, flashZip,
} from "../store.js";
import { fmtSize, joinPath } from "../lib/format.js";
import { isConfigPath } from "../lib/config-file.js";

export default {
  name: "FileListing",
  setup() {
    const rows = computed(() => entries.value.map(e => {
      const full = joinPath(path.value, e.name);
      const isDir = e.type === 1;
      const isCfg = !isDir && isConfigPath(full);
      return {
        ...e,
        isDir,
        /* .zip files get a "flash" action first — it's the primary reason
         * files land on this device.
         */
        isZip: !isDir && /\.zip$/i.test(e.name),
        isCfg,
        full,
        hint: isDir ? "Folder"
            : isCfg ? "Edit configuration"
            : "Download",
      };
    }));

    const empty = computed(() => {
      if (!connected.value) return listError.value || "Connect to a device to browse files.";
      if (listError.value) return listError.value;
      if (rows.value.length === 0) return "(empty directory)";
      return null;
    });

    const activate = (row) => activateEntry(row.full, row.isDir);

    return { rows, empty, fmtSize, activate, rename, remove, flashZip };
  },
  template: /* html */ `
    <main>
      <table>
        <thead>
          <tr><th>Name</th><th>Size</th><th></th></tr>
        </thead>
        <tbody>
          <tr v-if="empty">
            <td colspan="3" class="empty">{{ empty }}</td>
          </tr>
          <tr v-else v-for="row in rows" :key="row.name">
            <td class="name" :class="[row.isDir ? 'dir' : 'file', { cfg: row.isCfg }]"
                :title="row.hint" @click="activate(row)">
              {{ row.name }}
            </td>
            <td class="size">{{ row.isDir ? "" : fmtSize(row.size) }}</td>
            <td class="actions">
              <button v-if="row.isZip" class="primary small"
                      @click.stop="flashZip(row.full)">flash</button>
              <button @click.stop="rename(row.full)">rename</button>
              <button class="danger" @click.stop="remove(row.full, row.isDir)">delete</button>
            </td>
          </tr>
        </tbody>
      </table>
    </main>
  `,
};
