/*
 * CMSIS-DAP / SWD bit-twiddling, tested without a probe.
 *
 *   node web/test/cmsis-dap.test.mjs
 *
 * Everything here is a constant or a piece of arithmetic that decides what
 * goes on the wire. None of it is checkable by reading it — the CSW bug that
 * cost a hardware round trip was `0x22` where `0x12` was meant, which looks
 * entirely plausible and requests an optional MEM-AP mode this part does not
 * implement. So the fields get decoded, not compared.
 */
import {
  CSW_SIZE32, CSW_ADDRINC_SINGLE, CSW_LOW_BITS, CSW_LOW_MASK, TAR_WRAP,
  CSW_VALUE, CSW_HNONSEC, CSW_DBGSWENABLE, CSW_MASTERTYPE_DBG,
  CSW_HPROT_PRIV, CSW_HPROT_DATA, CSW_PROT_MASK,
  DP, AP, APnDP, RnW, ACK_OK, CmsisDap, ackMessage, describeTransfer,
} from "../js/lib/cmsis-dap.js";

let bad = 0;
const t = (name, cond, extra = "") => {
  console.log(`${cond ? "  ok  " : "  FAIL"} ${name}${extra ? `  [${extra}]` : ""}`);
  if (!cond) bad++;
};

/* --- CSW ---------------------------------------------------------------- */
const size = CSW_LOW_BITS & 0x07;
const inc  = (CSW_LOW_BITS >> 4) & 0x03;

t("CSW Size is 32-bit (0b010)", size === 0b010, `got 0b${size.toString(2)}`);
/* 0b10 here is *packed* increment — optional, unimplemented on this part, and
 * the exact mistake that produced "FAULT after 1 transfer". */
t("CSW AddrInc is increment-single (0b01), not packed (0b10)",
  inc === 0b01, `got 0b${inc.toString(2).padStart(2, "0")}`);
t("CSW_LOW_BITS is the two fields combined",
  CSW_LOW_BITS === (CSW_SIZE32 | CSW_ADDRINC_SINGLE));
t("CSW low mask covers exactly bits 5..0", CSW_LOW_MASK === 0b111111);
t("mask and value agree", (CSW_LOW_BITS & ~CSW_LOW_MASK) === 0);

/* --- CSW.Prot: the Secure-access bit ------------------------------------
 *
 * HNONSEC is 1 = Non-secure. The nRF54L's RRAM controller is Secure-only
 * (NRF_RRAMC_S_BASE with no _NS_ alias, where 188 other peripherals have
 * one), so a Non-secure AP write to 0x5004E500 is refused by the SPU as
 * STICKYERR. Inheriting this bit from the CSW reset value is what left it
 * set; it is now written explicitly, and asserted here by *name* because
 * "bit 30 must be clear" is not something anyone reads out of 0xA3000012.
 */
t("CSW requests Secure access (HNONSEC clear)",
  (CSW_VALUE & CSW_HNONSEC) === 0,
  `CSW=0x${(CSW_VALUE >>> 0).toString(16)}`);
t("CSW enables debug software access", (CSW_VALUE & CSW_DBGSWENABLE) !== 0);
t("CSW masters as debug", (CSW_VALUE & CSW_MASTERTYPE_DBG) !== 0);
t("CSW requests privileged access", (CSW_VALUE & CSW_HPROT_PRIV) !== 0);
t("CSW requests a data access", (CSW_VALUE & CSW_HPROT_DATA) !== 0);
t("CSW carries the size/increment fields too",
  (CSW_VALUE & CSW_LOW_MASK) === CSW_LOW_BITS);
t("Prot and low-bit fields do not overlap",
  (CSW_PROT_MASK & CSW_LOW_MASK) === 0);
t("CSW_VALUE is exactly 0xA3000012", (CSW_VALUE >>> 0) === 0xa3000012,
  `0x${(CSW_VALUE >>> 0).toString(16)}`);

/* --- request encoding ---------------------------------------------------- */
t("AP read DRW encodes as 0x0F", (APnDP | RnW | (AP.DRW & 0x0c)) === 0x0f);
t("AP write DRW encodes as 0x0D", (APnDP | (AP.DRW & 0x0c)) === 0x0d);
t("AP write TAR encodes as 0x05", (APnDP | (AP.TAR & 0x0c)) === 0x05);
t("DP read CTRL/STAT encodes as 0x06", (RnW | (DP.CTRL_STAT & 0x0c)) === 0x06);
t("DP write SELECT encodes as 0x08", (DP.SELECT & 0x0c) === 0x08);
t("AP CSW is bank offset 0", (AP.CSW & 0x0c) === 0x00);
/* IDR is 0xFC — bank 0xF, offset 0xC — so it shares an encoding with DRW and
 * is only reachable with SELECT's bank field set. */
t("AP IDR lands at offset 0x0C", (AP.IDR & 0x0c) === 0x0c);
t("AP IDR needs bank 0x0F", ((AP.IDR >> 4) & 0x0f) === 0x0f);

/* --- error messages ------------------------------------------------------ */
t("OK produces no message", ackMessage(ACK_OK, 1, "x") === null);
t("FAULT names the operation",
  /FAULT on write AP DRW/.test(ackMessage(0x04, 1, describeTransfer(0x0d))),
  ackMessage(0x04, 1, describeTransfer(0x0d)));
t("WAIT is distinct from FAULT", /WAIT/.test(ackMessage(0x02, 3, "x")));
t("transfer count is pluralised", /after 1 transfer\)/.test(ackMessage(0x04, 1, "x")));
t("transfer count pluralises correctly", /after 3 transfers\)/.test(ackMessage(0x04, 3, "x")));
t("describes DP registers too", describeTransfer(0x06) === "read DP CTRL/STAT",
  describeTransfer(0x06));

/* --- block splitting ----------------------------------------------------- */
/*
 * DAP_TransferBlock cannot exceed the probe's command buffer. Overrunning it
 * on a *write* silently drops the tail, which reappears much later as a verify
 * mismatch indistinguishable from the Trap 1 RRAM write-buffer bug — so the
 * limit is arithmetic worth pinning down.
 */
{
  const dap = new CmsisDap(null);
  dap.dapPacketSize = 64;
  t("64 B buffer: 14 words per write", dap.maxBlockWords(true) === 14, String(dap.maxBlockWords(true)));
  t("64 B buffer: 15 words per read", dap.maxBlockWords(false) === 15, String(dap.maxBlockWords(false)));
  t("write header is 5 bytes", 5 + dap.maxBlockWords(true) * 4 <= 64);
  t("read header is 4 bytes", 4 + dap.maxBlockWords(false) * 4 <= 64);

  dap.dapPacketSize = 1024;
  t("1 KB buffer: 254 words per write", dap.maxBlockWords(true) === 254, String(dap.maxBlockWords(true)));
  t("a full TAR window needs splitting even at 1 KB",
    TAR_WRAP / 4 > dap.maxBlockWords(true), `${TAR_WRAP / 4} words vs ${dap.maxBlockWords(true)}`);

  dap.dapPacketSize = 8;                      // absurd, but must not return 0
  t("never returns a zero-word limit", dap.maxBlockWords(true) >= 1);
}

/* Splitting must actually happen, and must cover every word exactly once. */
{
  const sent = [];
  const dap = new CmsisDap(null);
  dap.dapPacketSize = 64;
  dap.transferBlockRaw = async (_req, words) => { sent.push([...words]); return null; };

  const words = Uint32Array.from({ length: 256 }, (_, i) => i);
  await dap.transferBlock(APnDP | (AP.DRW & 0x0c), words);

  const limit = dap.maxBlockWords(true);
  t("write split into buffer-sized pieces", sent.length === Math.ceil(256 / limit),
    `${sent.length} pieces of <= ${limit}`);
  t("no piece exceeds the buffer", sent.every(p => p.length <= limit));
  t("split write loses nothing", sent.flat().join() === [...words].join());
}
{
  const dap = new CmsisDap(null);
  dap.dapPacketSize = 64;
  let cursor = 0;
  dap.transferBlockRaw = async (_req, count) =>
    Uint32Array.from({ length: count }, () => cursor++);

  const got = await dap.transferBlock(APnDP | RnW | (AP.DRW & 0x0c), 100);
  t("split read returns the full count", got.length === 100);
  t("split read reassembles in order", got.every((v, i) => v === i));
}

console.log(bad ? `\n${bad} FAILURES` : "\nall cmsis-dap tests passed");
process.exit(bad ? 1 : 0);
