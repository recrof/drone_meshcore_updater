# Transport completion and retry policy — discussion

No runtime changes are proposed here. This separates policy decisions from
lifetime/bounds hardening and the opt-in Secure DFU client. The baseline is
`4789fbf`; the superseded combined PR is `5facbe2`.

## Legacy BLE completion

The baseline waits two seconds, then watches the transfer address for five
seconds. A Legacy DFU service advertisement returns `TARGET_REJECTED` and
permits a retry. Silence, a non-DFU advertisement, or a scanner error preserves
success. The source embeds a RAK4631 log explaining why testing the address
alone previously caused a successful update to loop.

The combined PR instead made every non-cancelled result terminal
`DONE / BOOT_UNVERIFIED`, including a persistent Legacy DFU advertisement.
The split retains Legacy rejection detection and separates Legacy and Secure
service flags; Secure acceptance alone does not prove application boot.
Whether silence should mean successful boot or merely an accepted transfer
remains a policy question.

## Wi-Fi acknowledgement and retries

The baseline accepts HTTP 200 or no response after the complete POST body,
reflecting its documented reboot behavior. Failures use the configured retry
loop. The combined PR required a complete 200 status line and inadvertently
disabled retries after acquisition because Wi-Fi had no same-target hook.
The split preserves the baseline policy.

Neither silence nor a missing 200 proves acceptance or rejection. Options are
to preserve the existing behavior, add an explicitly unconfirmed result, and
reacquire by the original BSSID plus matching node identity before retrying.
BSSID/name matching reduces accidental target switching; it is not
authenticated identity. Retries before any upload and retries after an
ambiguous completed POST should be decided separately.

## BLE retry identity

The baseline rescans using the original operator pin, or configured filters
when no pin was selected. The combined PR remembered a selected target,
permitted one buttonless transition, then required its exact last address.
An application at A that moved to DFU at A+1 and returned to A could therefore
be missed indefinitely with `scan_timeout=0`.

A fixed original `{A, A+1}` set covers reversal without cumulative drift to
A+2. It is still an address heuristic, not authenticated identity. Before
adopting it for automatic target selection, test both addresses advertising
alongside a second matching receiver. The split does not adopt the combined
PR's exact-last-address policy.

## Evidence and decisions still needed

The [historical hardware report](dfu-hardware-2026-09-12.md) covers production
source `9ad8d64` on a XIAO nRF52840 sender and an SWD-controlled RAK3401:
Legacy/Secure delivery, retained resume, cancellation, receiver reset/retry,
and independent image readback. It does not establish that the disputed
completion policy distinguishes rejected images from unknown boots, nor
qualify the new split's changes.

Wi-Fi, a second sender board, a distractor receiver, and the Legacy
application → bootloader → application retry case were not qualified in that
run. The review's ignored `CLAUDE.md` and `notes/` captures are absent from
this checkout; the baseline source's embedded log is available. Compare those
original captures with targeted ambiguous-outcome tests before choosing new
defaults. Successful transfer tests alone do not settle these decisions.
