/*
 * SLIP framing and the serial read loop.
 *
 *   node web/test/serial.test.mjs
 *
 * Two flashers sit on top of this file and neither can be debugged on the
 * hardware it targets — one of them, the ESP32-S3, cannot show a console at
 * all while it is in download mode (Trap 6). So the framing gets tested where
 * the failures are visible.
 *
 * The bugs this exists to catch are the ones that only appear against real
 * timing: a frame split across two USB packets, a reply that arrived before
 * anyone asked for it, an escape sequence straddling a chunk boundary. All
 * three are trivially reproducible here and effectively unreproducible on a
 * board.
 */
import {
  slipEncode, slipDecode, SerialLink, SerialTimeout,
  SLIP_END, SLIP_ESC, SLIP_ESC_END, SLIP_ESC_ESC,
} from "../js/lib/serial.js";
import { FakePort } from "./harness/fake-serial.mjs";

let bad = 0;
const t = (name, ok, extra = "") => {
  console.log(`${ok ? "  ok  " : "  FAIL"} ${name}${extra ? `  [${extra}]` : ""}`);
  if (!ok) bad++;
};
const eq = (a, b) => a.length === b.length && [...a].every((v, i) => v === b[i]);

/* --- encoding ---------------------------------------------------------- */

t("a frame is delimited at both ends",
  (() => { const f = slipEncode([1, 2, 3]); return f[0] === SLIP_END && f[f.length - 1] === SLIP_END; })());

t("0xC0 in the payload is escaped",
  eq(slipEncode([SLIP_END]), [SLIP_END, SLIP_ESC, SLIP_ESC_END, SLIP_END]));

t("0xDB in the payload is escaped",
  eq(slipEncode([SLIP_ESC]), [SLIP_END, SLIP_ESC, SLIP_ESC_ESC, SLIP_END]));

/* Both flashers send blocks of arbitrary firmware, so every byte value
 * appears in a payload sooner or later — and the two that need escaping are
 * common ones (0xC0 shows up in Thumb branches, 0xDB in Xtensa). */
{
  const all = Uint8Array.from({ length: 256 }, (_, i) => i);
  const body = slipEncode(all).slice(1, -1);
  t("every byte value survives a round trip", eq(slipDecode(body), all));
}

t("a bad escape is rejected rather than guessed at",
  (() => { try { slipDecode([SLIP_ESC, 0x00]); return false; } catch { return true; } })());

/* --- the read loop ----------------------------------------------------- */

const linkOver = (handle) => {
  const port = new FakePort(handle);
  const link = new SerialLink(port);
  return { port, link };
};

/* One frame delivered a byte at a time. This is not a contrived case: a USB
 * CDC read can return any number of bytes, and the ESP32-S3's ROM in
 * particular dribbles its banner out. */
{
  const { port, link } = linkOver(() => {});
  await link.open();
  const frame = slipEncode([0xaa, 0xbb, 0xcc]);
  for (const b of frame) port.push([b]);
  const got = await link.readFrame(1000);
  t("a frame split byte-by-byte reassembles", eq(got, [0xaa, 0xbb, 0xcc]));
  await link.close();
}

/* An escape landing on a chunk boundary. Split *inside* the two-byte
 * sequence, which is the only split that can go wrong. */
{
  const { port, link } = linkOver(() => {});
  await link.open();
  const frame = slipEncode([0x01, SLIP_END, 0x02]);
  const cut = [...frame].indexOf(SLIP_ESC);
  port.push(frame.slice(0, cut + 1));
  port.push(frame.slice(cut + 1));
  const got = await link.readFrame(1000);
  t("an escape split across chunks reassembles", eq(got, [0x01, SLIP_END, 0x02]));
  await link.close();
}

/* Two frames in one chunk — the ROM answers SYNC eight times in a burst. */
{
  const { port, link } = linkOver(() => {});
  await link.open();
  port.push(Uint8Array.from([...slipEncode([1]), ...slipEncode([2])]));
  const a = await link.readFrame(1000);
  const b = await link.readFrame(1000);
  t("two frames in one chunk are read separately", eq(a, [1]) && eq(b, [2]));
  await link.close();
}

/* A reply that arrived before anyone asked for it must still be there. This
 * is the bug the persistent read loop exists to prevent: a reader taken per
 * request drops whatever the stream had already buffered. */
{
  const { port, link } = linkOver(() => {});
  await link.open();
  port.push(slipEncode([0x42]));
  await new Promise(r => setTimeout(r, 20));
  const got = await link.readFrame(1000);
  t("a reply that arrived early is not lost", eq(got, [0x42]));
  await link.close();
}

/* Anything before the first delimiter is a boot banner, not a frame — and it
 * is usually the entire diagnosis, so it must survive rather than be dropped
 * on the way to the frame that follows it. */
{
  const { port, link } = linkOver(() => {});
  await link.open();
  port.push(new TextEncoder().encode("ESP-ROM:esp32s3-20210327\nwaiting for download"));
  port.push(slipEncode([0x01]));
  const got = await link.readFrame(1000);
  t("a frame after a boot banner still reads", eq(got, [0x01]));
  t("the banner is kept for the error message",
    /waiting for download/.test(link.takeNoise()));
  await link.close();
}

/* Silence has to end, and end as a timeout rather than a hang: "nothing
 * answered" is the single most common failure both flashers have, because it
 * is what a board that is not in bootloader mode looks like. */
{
  const { link } = linkOver(() => {});
  await link.open();
  const started = Date.now();
  let err = null;
  try { await link.readFrame(80, "the ACK"); } catch (e) { err = e; }
  t("silence times out", err instanceof SerialTimeout);
  t("the timeout names what was expected", /the ACK/.test(err?.message ?? ""), err?.message);
  t("it waits roughly the requested time", Date.now() - started >= 70);
  await link.close();
}

/* A port pulled mid-transfer must surface, not hang for the full timeout. */
{
  const { port, link } = linkOver(() => {});
  await link.open();
  const pending = link.readFrame(5000).catch(e => e);
  await port.close();
  const err = await pending;
  t("a closed port fails the pending read", err instanceof Error);
  await link.close();
}

/* writeFrame is what every protocol above this uses; it must frame, not just
 * write. */
{
  const { port, link } = linkOver(() => {});
  await link.open();
  await link.writeFrame([SLIP_END]);
  t("writeFrame escapes and delimits",
    eq(port.written[0], [SLIP_END, SLIP_ESC, SLIP_ESC_END, SLIP_END]));
  await link.close();
}

console.log(bad ? `\n${bad} FAILURES` : "\nall serial tests passed");
process.exit(bad ? 1 : 0);
