/* Small shared formatting helpers. */

export const fmtSize = (b) => {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1024 / 1024).toFixed(2)} MB`;
};

export const fmtRate = (bytes, seconds) =>
  `${(bytes / 1024 / seconds).toFixed(1)} KB/s`;

/* HH:MM:SS in local-ish terms — matches the old log prefix exactly. */
export const timestamp = () =>
  new Date().toISOString().split("T")[1].split(".")[0];

/* Join a directory and a name without doubling slashes. */
export const joinPath = (dir, name) =>
  `${dir.replace(/\/+$/, "")}/${name}`;
