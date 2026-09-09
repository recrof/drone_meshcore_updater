#!/usr/bin/env sh
#
# Re-apply the out-of-tree patches this firmware needs.
#
# Both live in west-managed trees (zephyr/, modules/) which are gitignored here
# and rewritten wholesale by `west update`. Nothing warns when they go missing:
# the build succeeds, the firmware boots, the radio configures — and every
# message is dropped with "Unsupported bandwidth: 62". That failure reads as a
# radio or antenna fault and is neither.
#
# **Run this after every `west update`.** Idempotent: already-applied patches
# are detected and skipped, so running it twice is harmless.
#
# SPDX-License-Identifier: BSD-3-Clause
set -eu
cd "$(dirname "$0")/.."

fail=0

# `marker` must be text the patch ADDS and that upstream does not already
# contain. A marker that also matches upstream reports "already applied" and
# silently skips the patch — which is exactly the silent failure this script
# exists to prevent. (LORA_BW_062 looked like a good marker and is not: it is
# already in radio.c's RadioGetLoRaBandwidthInHz switch at line 897.)
check_apply() {
	target="$1"; patch="$2"; marker="$3"; what="$4"
	if [ ! -f "$target" ]; then
		echo "MISSING  $target — has \`west update\` run?"; fail=1; return
	fi
	if grep -q "$marker" "$target"; then
		echo "ok       $what (already applied)"; return
	fi
	if patch -p1 --forward --silent < "$patch"; then
		echo "APPLIED  $what"
	else
		echo "FAILED   $what — $patch did not apply to $target"; fail=1
	fi
}

# 1. loramac-node's Bandwidths[] is a LoRaWAN-shaped index table with only
#    125/250/500 in it. LORA_BW_062 already exists in the SX126x driver
#    (sx126x.h); it is just not reachable. Appended as index 3.
check_apply modules/lib/loramac-node/src/radio/sx126x/radio.c \
	patches/loramac-node-bw62.patch "LORA_BW_500, LORA_BW_062" \
	"loramac-node: 62.5 kHz in Bandwidths[]"

# 2. Zephyr's backend maps enum -> that index table, and had no case for
#    BW_62_KHZ even though the enum defines it.
check_apply zephyr/drivers/lora/loramac-node/sx12xx_common.c \
	patches/zephyr-lora-bw62.patch "case BW_62_KHZ" \
	"zephyr lora driver: BW_62_KHZ -> index 3"

if [ "$fail" -ne 0 ]; then
	echo
	echo "One or more patches are not in place. A build from here will"
	echo "transmit nothing at 62.5 kHz. Fix before flashing."
	exit 1
fi
echo
echo "All out-of-tree patches present."
