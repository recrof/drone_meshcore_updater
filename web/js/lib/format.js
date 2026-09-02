/* Small shared formatting helpers. */

export const fmtSize = (b) => {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1024 / 1024).toFixed(2)} MB`;
};

export const fmtRate = (bytes, seconds) =>
  `${(bytes / 1024 / seconds).toFixed(1)} KB/s`;

/*
 * HH:MM:SS in the viewer's own timezone.
 *
 * This used to slice `toISOString()`, which is **UTC** — the comment here
 * claimed "local-ish" and was simply wrong, so every line in the status log
 * was an hour or more away from the clock on the wall next to it. That
 * matters more here than in most apps: these timestamps get compared against
 * the device's own log (`LOG.NNNN`) and against when someone remembers
 * unplugging something.
 *
 * Built from the local getters rather than `toLocaleTimeString`, which varies
 * by locale in ways this format must not: some produce a 12-hour clock with a
 * suffix, and `hour12: false` renders midnight as "24:00:00" in a few. The
 * output is fixed-width HH:MM:SS everywhere.
 *
 * Note the config-file header still writes UTC in full ISO 8601, deliberately:
 * a config.txt is copied across a fleet and read anywhere, so an absolute
 * instant is the right thing there. This is for one person watching one
 * screen.
 */
const pad2 = (n) => String(n).padStart(2, "0");
export const timestamp = (d = new Date()) =>
  `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;

/* Join a directory and a name without doubling slashes. */
export const joinPath = (dir, name) =>
  `${dir.replace(/\/+$/, "")}/${name}`;
