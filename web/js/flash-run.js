/*
 * The bookkeeping every USB flasher does: a busy flag, an error, a scrolling
 * log, and a progress bar.
 *
 * Lives here rather than in js/lib/ because it imports Vue and holds UI
 * state; everything under lib/ is deliberately free of both so node can test
 * it. Lives here rather than in a component because there are three flashers
 * and they are otherwise unrelated — a probe, a bootloader and a ROM loader —
 * and the one thing they must agree on is what the user sees while they run.
 *
 * `guard` is the point of it. Every operation is "set busy, do the thing, and
 * on failure put the reason somewhere the user can read it": doing that by
 * hand at each call site is how a flasher ends up with one path that fails
 * silently, which on this hardware means a half-written image and no clue.
 */
import { ref, reactive } from "./vue.js";

export function useFlashRun({ maxLines = 200 } = {}) {
  const busy = ref("");
  const error = ref("");
  const lines = reactive([]);
  const progress = reactive({ shown: false, pct: 0, label: "" });

  const log = (msg, cls = "") => {
    lines.push({ msg, cls, id: lines.length });
    if (lines.length > maxLines) lines.splice(0, lines.length - maxLines);
  };

  /**
   * Run `fn` with `busy` set to `label`.
   *
   * Rethrows after recording, so a caller that has cleanup to do still gets
   * its `catch` — but every caller in the UI swallows it, because the error
   * has already been put on screen and a second report would be noise.
   */
  async function guard(label, fn) {
    busy.value = label;
    error.value = "";
    try {
      return await fn();
    } catch (e) {
      error.value = e.message;
      log(e.message, "err");
      throw e;
    } finally {
      busy.value = "";
      progress.shown = false;
    }
  }

  /** A progress callback shaped for the byte-counting flashers. */
  const track = (label) => {
    progress.shown = true;
    progress.label = label;
    progress.pct = 0;
    return (done, total) => { progress.pct = Math.floor((done / total) * 100); };
  };

  return { busy, error, lines, progress, log, guard, track };
}

/**
 * A console tracer for the serial protocols, capped so a 700-packet transfer
 * does not drown the console.
 *
 * Wired up only when the URL carries `?trace` — see SerialFlash.js for why it
 * is kept at all. `console.debug` rather than `log` so that even with tracing
 * on it stays behind Chrome's "Verbose" level. The elapsed time is the useful
 * column: on this hardware, *when* a board stopped answering is most of the
 * diagnosis.
 */
export function consoleTracer(tag, limit = 24) {
  const started = Date.now();
  let n = 0;
  return (dir, bytes) => {
    if (n++ > limit) return;
    if (n === limit + 1) return console.debug(`[${tag}] … further frames not traced`);
    const at = ((Date.now() - started) / 1000).toFixed(3).padStart(7);
    const hex = [...bytes].map(b => b.toString(16).padStart(2, "0")).join(" ");
    console.debug(`[${tag}] ${at}s ${dir === "tx" ? "->" : "<-"} ${bytes.length.toString().padStart(4)}  ` +
                  (hex.length > 240 ? hex.slice(0, 240) + " …" : hex));
  };
}

/**
 * SHA-256 of a downloaded artifact, as hex.
 *
 * Every flasher checks the manifest digest before it writes anything: a
 * truncated or substituted download should fail while the device is still
 * intact, not as a verify mismatch after the bootloader has been replaced.
 */
export async function sha256Hex(buf) {
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Fetch one artifact named by a manifest entry and check it against the
 * digest the entry carries.
 *
 * `field` is which digest to compare — entries carry `sha256` for the single
 * image and one per part, so the caller says which. An entry with no digest
 * is fetched anyway rather than refused: older staging did not record one,
 * and refusing would turn a missing *check* into a missing *build*.
 */
export async function fetchChecked(url, expected, log = () => {}) {
  const res = await fetch(url, { cache: "no-cache" });
  if (!res.ok) throw new Error(`could not fetch ${url}: HTTP ${res.status}`);
  const buf = await res.arrayBuffer();
  if (expected) {
    const got = await sha256Hex(buf);
    if (got !== expected) {
      throw new Error(`downloaded ${url.split("/").pop()} does not match the manifest ` +
                      `digest (expected ${expected.slice(0, 16)}…, got ${got.slice(0, 16)}…)`);
    }
    log("digest matches the manifest", "ok");
  }
  return buf;
}
