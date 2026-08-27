#!/usr/bin/env bash
# Thin build wrapper for xiao_nrf54_updater.
#
# Assumes this repo has already been west-initialized (see README §Development).
# Repo root == west workspace root; the app lives in ./updater/.
#
# Usage:
#   ./build.sh               # build for xiao_nrf54lm20a (default)
#   ./build.sh -p            # clean rebuild (pristine)
#   ./build.sh -b <board>    # build for a specific board
#   ./build.sh merge         # rebuild updater/build/merged.hex only
#   ./build.sh flash         # flash the last build
#   ./build.sh menuconfig    # open Kconfig menuconfig

set -euo pipefail

# Full Zephyr HW-model-v2 board identifier: <board>/<soc>/<variant>.
# The `xiao_nrf54lm20a` board hosts a single SoC (nrf54lm20a) with two CPU
# cores (cpuapp + cpuflpr); this project targets the application core only.
BOARD="${BOARD:-xiao_nrf54lm20a/nrf54lm20a/cpuapp}"
APP="updater"
BUILD_DIR="${APP}/build"

# Sanity check: west workspace must be initialized in this repo root.
if [ ! -d ".west" ]; then
  echo "error: no .west/ at repo root — this workspace hasn't been initialized." >&2
  echo "run:   west init -l ${APP} && west update" >&2
  exit 1
fi

# Sysbuild emits one image per domain and no combined file — `west flash`
# walks domains.yaml instead. That is fine here and useless everywhere else,
# so build a single merged.hex for release artifacts, for a browser-based
# flasher, and for anyone with a plain SWD probe.
#
# Skipped silently when MCUboot is not in the build (SB_CONFIG_BOOTLOADER_MCUBOOT
# off), because then zephyr.hex already is the whole image.
merge_hex() {
  local mcuboot="${BUILD_DIR}/mcuboot/zephyr/zephyr.hex"
  local app="${BUILD_DIR}/updater/zephyr/zephyr.signed.hex"
  [ -f "${mcuboot}" ] && [ -f "${app}" ] || return 0
  python3 "${APP}/tools/merge_hex.py" "${BUILD_DIR}/merged.hex" "${mcuboot}" "${app}"
}

case "${1:-build}" in
  build)
    shift || true
    west build -b "${BOARD}" "${APP}" --build-dir "${BUILD_DIR}" "$@"
    merge_hex
    ;;

  merge)
    merge_hex
    ;;
  flash)
    # Flashing on the XIAO nRF54LM20A goes through the on-board SAMD11
    # running Free-DAP-style CMSIS-DAP firmware. Three runner options:
    #
    #   openocd  - default. Seeed's board.cmake wires the openocd runner
    #              but forgets to declare the adapter driver; without
    #              `-c "adapter driver cmsis-dap"` up front, openocd
    #              bails with "adapter driver has to be specified". We
    #              inject that + a conservative 1 MHz clock here.
    #   nrfutil  - Nordic's own tool. Only works with Nordic's DevKit
    #              CMSIS-DAP variant, NOT Seeed's SAMD11 flavour — it
    #              enumerates the port but can't program.
    #   jlink    - external J-Link probe, if you've wired one to SWD.
    #
    # Override with FLASH_RUNNER=<name> to switch.
    shift || true
    RUNNER="${FLASH_RUNNER:-openocd}"
    if [ "${RUNNER}" = "openocd" ]; then
      # Point openocd at Seeed's own config for this carrier. It configures
      # the CMSIS-DAP interface, forces SWD transport, creates the
      # nrf54lm20a target/DAP nodes, and defines the `nrf54lm20a-load`
      # procedure that Seeed's board.cmake references. Without this
      # config, openocd's built-in scripts (no nRF54L target support
      # until 0.13+) can't program the chip.
      #
      # --verify is not optional here. openocd's default flow programs
      # without reading back, and the nRF54L RRAM controller silently
      # drops the trailing partial 128-bit line of the image (see the
      # nrf54lm20a-load proc in that config for the full story). A
      # corrupt-tail image boots and then faults in whatever happened to
      # land in the last 16 bytes — days were lost chasing that as a
      # Kconfig problem. Read-back verification turns it into a loud
      # flash-time error instead.
      SEEED_CFG="${APP}/boards/seeed/xiao_nrf54lm20a/support/openocd.cfg"
      west flash --build-dir "${BUILD_DIR}" --runner openocd \
        --config "${SEEED_CFG}" --verify "$@"
    else
      west flash --build-dir "${BUILD_DIR}" --runner "${RUNNER}" "$@"
    fi
    ;;
  menuconfig|guiconfig)
    west build -t "$1" --build-dir "${BUILD_DIR}"
    ;;
  clean)
    rm -rf "${BUILD_DIR}"
    ;;
  *)
    # Pass-through for `-p`, `-t <target>`, etc.
    west build -b "${BOARD}" "${APP}" --build-dir "${BUILD_DIR}" "$@"
    merge_hex
    ;;
esac
