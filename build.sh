#!/usr/bin/env bash
# Thin build wrapper for drone_meshcore_updater.
#
# Assumes this repo has already been west-initialized (see README §Development).
# Repo root == west workspace root; the app lives in ./updater/.
#
# Usage:
#   ./build.sh               # build for xiao_nrf54lm20a (default)
#   ./build.sh -p            # clean rebuild (pristine)
#   BOARD=xiao_ble/nrf52840 ./build.sh      # build for the XIAO nRF52840
#   BOARD=xiao_esp32s3/esp32s3/procpu ./build.sh   # build for the XIAO ESP32S3
#   ./build.sh merge         # rebuild merged.hex (+ restage web/firmware/)
#   ./build.sh bump          # bump VERSION_TWEAK + rebuild (for OTA testing)
#   ./build.sh flash         # flash the last build
#   ./build.sh menuconfig    # open Kconfig menuconfig

set -euo pipefail

# Full Zephyr HW-model-v2 board identifier: <board>/<soc>/<variant>.
# The `xiao_nrf54lm20a` board hosts a single SoC (nrf54lm20a) with two CPU
# cores (cpuapp + cpuflpr); this project targets the application core only.
BOARD="${BOARD:-xiao_nrf54lm20a/nrf54lm20a/cpuapp}"
DEFAULT_BOARD="xiao_nrf54lm20a/nrf54lm20a/cpuapp"
APP="updater"

# One build directory per board. West refuses to reconfigure an existing
# directory for a different board, and sharing one would otherwise mean a
# pristine rebuild every time you switch — or worse, merging a bootloader
# built for one part with an application built for the other. The default
# board keeps the plain `updater/build` path that every note and command in
# this repo already refers to.
if [ "${BOARD}" = "${DEFAULT_BOARD}" ]; then
  BUILD_DIR="${APP}/build"
else
  # Underscores, not hyphens: .gitignore already carries `build_*/`, and a
  # build tree that is not ignored turns up in `git status` as hundreds of
  # untracked files the first time anyone builds for a second board.
  BUILD_DIR="${APP}/build_$(printf '%s' "${BOARD}" | tr '/' '_')"
fi
BUILD_DIR="${BUILD_DIR_OVERRIDE:-${BUILD_DIR}}"

# Sanity check: west workspace must be initialized in this repo root.
if [ ! -d ".west" ]; then
  echo "error: no .west/ at repo root — this workspace hasn't been initialized." >&2
  echo "run:   west init -l ${APP} && west update" >&2
  exit 1
fi

# Espressif boards need esptool >= 5.0.2 on PATH, and will not say so clearly.
#
# zephyr/soc/espressif/common/CMakeLists.txt does `find_program(ESPTOOL_EXECUTABLE
# esptool)` and then, in the post-build step, invokes the bare name `esptool`
# from PATH — so a *wrong version* passes the check and fails at the last step
# of the build, after both images have linked:
#
#   esptool: error: unrecognized arguments: --flash-mode --flash-freq 80m ...
#
# which is esptool 4.x being handed 5.x's hyphenated options. Anyone with
# PlatformIO installed has exactly that on PATH.
#
# So we keep our own, in a venv at the repo root, and put it first. Deliberately
# not `pip install` into whatever Python happens to be active: esptool 4.x is
# PlatformIO's pinned dependency and upgrading it out from under a working
# toolchain to build a different project is not ours to do.
#
# Board-name matching rather than reading the build's .config, unlike merge_uf2
# below — this has to run *before* the first configure, when there is no .config
# to read.
ESPTOOL_VENV=".venv-esptool"

is_espressif() {
  case "${BOARD}" in *esp32*) return 0 ;; *) return 1 ;; esac
}

ensure_esptool() {
  is_espressif || return 0
  if [ ! -x "${ESPTOOL_VENV}/bin/esptool" ]; then
    echo "note: creating ${ESPTOOL_VENV} (esptool >= 5.0.2, required by the Espressif build)"
    python3 -m venv "${ESPTOOL_VENV}" || {
      echo "error: could not create ${ESPTOOL_VENV}; install esptool>=5.0.2 yourself" >&2
      exit 1
    }
    "${ESPTOOL_VENV}/bin/pip" install --quiet --upgrade "esptool>=5.0.2" || {
      echo "error: could not install esptool into ${ESPTOOL_VENV}" >&2
      exit 1
    }
  fi
  PATH="$(cd "${ESPTOOL_VENV}/bin" && pwd):${PATH}"
  export PATH
}

# Sysbuild emits one image per domain and no combined file — `west flash`
# walks domains.yaml instead. That is fine here and useless everywhere else,
# so build a single merged.hex for release artifacts, for a browser-based
# flasher, and for anyone with a plain SWD probe.
#
# Skipped silently when MCUboot is not in the build (SB_CONFIG_BOOTLOADER_MCUBOOT
# off), because then zephyr.hex already is the whole image.
merge_hex() {
  # Not on Espressif, where a flat address->byte merge is meaningless.
  #
  # An ESP32 image is not a flash image. Its ELF (and therefore its hex) carries
  # *virtual* addresses — the MCUboot image lands at 0x3fcb7300..0x403d61c7,
  # which is IRAM and DRAM — and the flashable artifact is the .bin that
  # esptool's elf2image builds from it, written at an offset esptool is told
  # separately. Merging the two hexes produced a "merged.hex" spanning a
  # gigabyte of address space, which is not wrong so much as meaningless: no
  # tool would ever load it.
  #
  # So this board has no single-file artifact and the browser flasher cannot
  # reach it either (that one speaks CMSIS-DAP to the nRF54L carrier's SAMD11).
  # `./build.sh flash` says what to do instead.
  if is_espressif; then
    # Offsets are READ OUT OF THE BUILD, never written here.
    #
    # They are not the same on every Espressif part: the ESP32-S3 loads its
    # second-stage bootloader from 0x0, the ESP32-C5 from 0x2000, because the
    # C5's ROM reserves the first two sectors for the Key Manager. This block
    # printed a hard-coded 0x0 for both until the C5 arrived, which is a
    # comfortable way to hand someone the wrong number: it is only a message,
    # but it is the message a person copies into an esptool command line.
    #
    # Each image records where it links in its own .config, so ask it. Same
    # pattern as merge_uf2 above, and the same reason — a second copy of a
    # number the build already knows is a number that drifts.
    esp_offset() {
      local cfg="${BUILD_DIR}/$1/zephyr/.config"
      [ -f "${cfg}" ] && sed -n 's/^CONFIG_FLASH_LOAD_OFFSET=\(.*\)/\1/p' "${cfg}"
    }
    echo "  ${BUILD_DIR}/mcuboot/zephyr/zephyr.bin        -> flash at $(esp_offset mcuboot)"
    echo "  ${BUILD_DIR}/updater/zephyr/zephyr.signed.bin -> flash at $(esp_offset updater) (slot0)"
    echo "  (no merged.hex on Espressif — ./build.sh flash)"
    # Still stage: this board has no merged.hex, but it does produce an OTA
    # zip for the Bluetooth route and two flashable .bin images, and the
    # manifest describes those as `parts`. Returning before restage() is why
    # an ESP32-S3 build used to leave web/firmware/ untouched and silent.
    restage
    return 0
  fi
  local mcuboot="${BUILD_DIR}/mcuboot/zephyr/zephyr.hex"
  local app="${BUILD_DIR}/updater/zephyr/zephyr.signed.hex"
  [ -f "${mcuboot}" ] && [ -f "${app}" ] || return 0
  python3 "${APP}/tools/merge_hex.py" "${BUILD_DIR}/merged.hex" "${mcuboot}" "${app}"
  merge_uf2
  restage
}

# On a board whose bootloader takes UF2 — the XIAO nRF52840 and its Adafruit
# bootloader — the merged hex is not the flashable artifact; a .uf2 is. Drag
# it onto the mass-storage device the board exposes after a double-tap of
# reset and that is the whole install procedure, no tooling at all.
#
# Both facts are read out of the build rather than hard-coded per board:
# Zephyr already knows whether the board wants UF2 and which family ID its
# bootloader accepts. A wrong family ID is rejected by the bootloader rather
# than half-written, but a *missing* one silently produces a file that no
# bootloader will take.
merge_uf2() {
  local cfg="${BUILD_DIR}/updater/zephyr/.config"
  [ -f "${cfg}" ] && [ -f "${BUILD_DIR}/merged.hex" ] || return 0
  grep -q '^CONFIG_BUILD_OUTPUT_UF2=y' "${cfg}" || return 0

  local family
  family=$(sed -n 's/^CONFIG_BUILD_OUTPUT_UF2_FAMILY_ID="\(.*\)"/\1/p' "${cfg}")
  if [ -z "${family}" ]; then
    echo "warning: board wants UF2 but declares no family ID — skipping merged.uf2" >&2
    return 0
  fi
  python3 zephyr/scripts/build/uf2conv.py "${BUILD_DIR}/merged.hex" \
    -f "${family}" -c -o "${BUILD_DIR}/merged.uf2" >/dev/null
  echo "  ${BUILD_DIR}/merged.uf2: $(wc -c < "${BUILD_DIR}/merged.uf2" | tr -d ' ') bytes, family ${family}"
}

# Keep web/firmware/ in step with the build.
#
# Staging once is opting in to local testing through the web client; from then
# on, a build that did not refresh it serves *yesterday's* firmware from a UI
# that says it is the newest — with a version number to match, because the
# manifest is generated from the stale artifact too. That cost a full
# debugging round: an image staged six minutes before a feature was written
# was uploaded, and the missing feature looked like a bug in the feature.
#
# Only ever refreshes a directory that already exists, so it cannot surprise
# anyone who is not using it.
#
# Every board stages, into its own subdirectory and its own manifest entry.
# This used to refuse anything but the default board, because the manifest
# described exactly one board and the client had no way to tell which device
# it was talking to — so staging an nRF52840 build would offer it to an nRF54L.
# Both halves of that have since changed: the client reads the device's board
# target over os_mgmt, and the manifest now carries one entry per board, so
# the client selects the matching image rather than being handed the only one
# there is. Cross-board staging is no longer a hazard; it is the feature.
restage() {
  local dir="web/firmware"
  [ -d "${dir}" ] || return 0
  command -v node >/dev/null 2>&1 || {
    echo "warning: ${dir} exists but node is missing — it is now STALE" >&2
    return 0
  }
  node web/tools/stage-firmware.mjs \
    --board "${BOARD}" --build-dir "${BUILD_DIR}" --out "${dir}"
}

case "${1:-build}" in
  build)
    shift || true
    ensure_esptool
    west build -b "${BOARD}" "${APP}" --build-dir "${BUILD_DIR}" "$@"
    merge_hex
    ;;

  merge)
    merge_hex
    ;;

  bump)
    # Increment VERSION_TWEAK and rebuild.
    #
    # This exists for testing over-the-air updates. img_mgmt identifies images
    # by hash, so uploading the image already running is refused
    # (IMG_MGMT_ERR_IMAGE_SETTING_TEST_TO_ACTIVE_DENIED) — you need two
    # genuinely different builds, and the version is in the signed header, so
    # bumping it is enough to make one.
    V="${APP}/VERSION"
    old=$(sed -n 's/^VERSION_TWEAK = \([0-9]*\).*/\1/p' "${V}")
    new=$(( old + 1 ))
    sed -i.bak "s/^VERSION_TWEAK = ${old}/VERSION_TWEAK = ${new}/" "${V}" && rm -f "${V}.bak"
    echo "VERSION_TWEAK ${old} -> ${new}"
    ensure_esptool
    west build -b "${BOARD}" "${APP}" --build-dir "${BUILD_DIR}"
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
    # Espressif: the board declares the `esp32` runner (esptool over the S3's
    # native USB), and sysbuild's domains.yaml already knows both images and
    # their offsets. Nothing to arrange — but esptool has to be the right one,
    # same as at build time.
    if is_espressif; then
      ensure_esptool
      echo "Put the board in download mode if it does not respond:"
      echo "  hold BOOT, tap RESET, release BOOT"
      west flash --build-dir "${BUILD_DIR}" "$@"
      exit 0
    fi
    RUNNER="${FLASH_RUNNER:-openocd}"
    # The openocd path below is entirely specific to the nRF54L carrier and
    # its SAMD11 probe. The nRF52840 XIAO has no probe at all — USB-C goes
    # straight to the SoC — so it is flashed by copying a file.
    if [ "${BOARD}" != "${DEFAULT_BOARD}" ] && [ -f "${BUILD_DIR}/merged.uf2" ]; then
      echo "This board flashes by UF2, not SWD:"
      echo "  1. double-tap RESET — a USB drive appears"
      echo "  2. cp ${BUILD_DIR}/merged.uf2 /Volumes/<that drive>/"
      echo "The board reboots into the new firmware on its own."
      exit 0
    fi
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
    ensure_esptool
    west build -b "${BOARD}" "${APP}" --build-dir "${BUILD_DIR}" "$@"
    merge_hex
    ;;
esac
