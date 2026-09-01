#!/usr/bin/env bash
# Thin build wrapper for drone_meshcore_updater.
#
# Assumes this repo has already been west-initialized (see README §Development).
# Repo root == west workspace root; the app lives in ./updater/.
#
# Usage:
#   ./build.sh [<board>] [<command>] [west args...]
#
# The board is an optional FIRST argument. Leave it out and you get the
# default, which is what every bare `./build.sh` in the notes still means:
#
#   ./build.sh                    build the default board (nrf54)
#   ./build.sh mg24               build the XIAO MG24
#   ./build.sh all                build every board this repo supports
#   ./build.sh boards             list the board names it accepts
#
#   ./build.sh mg24 flash         flash that board, however that board flashes
#   ./build.sh esp32s3 -p         pristine rebuild
#   ./build.sh all -p             pristine rebuild of everything
#   ./build.sh mg24 menuconfig
#   ./build.sh merge              rebuild merged.hex (+ restage web/firmware/)
#   ./build.sh bump               bump VERSION_TWEAK + rebuild (for OTA testing)
#   ./build.sh nrf52 clean
#
# A fully-qualified target works too (`./build.sh xiao_ble/nrf52840 flash`),
# which is what the short names expand to.
#
# BOARD=... still works and means the same thing, because the notes, the
# README and several years of muscle memory use it. The positional form is
# the documented one now: it is one fewer moving part, it makes `all`
# expressible at all, and an env var that silently persists in a shell is a
# way to build the wrong board and not notice.

set -euo pipefail

# Captured before anything assigns BOARD, so the legacy `BOARD=... ./build.sh`
# form keeps working alongside the positional one.
BOARD_ENV="${BOARD:-}"

APP="updater"

# ---- The boards ------------------------------------------------------------
#
# Short name -> fully-qualified Zephyr HW-model-v2 target. This is the fourth
# place in the repo that enumerates boards (the others are build.yml's two
# matrices, updater/sysbuild/, and USB_METHODS in stage-firmware.mjs), so it
# is *checked* against them rather than trusted: stage-firmware.test.mjs fails
# if this table and build.yml disagree. Adding a board here without adding it
# to CI is the drift that matters — a board you can build locally and that no
# release ever contains.
#
# The order is the order `all` builds in, and it is deliberate: the default
# board first, so the common failure shows up soonest.
BOARDS="
nrf54:xiao_nrf54lm20a/nrf54lm20a/cpuapp
nrf52:xiao_ble/nrf52840
mg24:xiao_mg24/efr32mg24b220f1536im48
esp32s3:xiao_esp32s3/esp32s3/procpu
esp32c5:xiao_esp32c5/esp32c5/hpcore
"

DEFAULT_BOARD="xiao_nrf54lm20a/nrf54lm20a/cpuapp"

board_slugs() { printf '%s\n' "${BOARDS}" | sed -n 's/^\([a-z0-9]*\):.*/\1/p'; }
board_target() { printf '%s\n' "${BOARDS}" | sed -n "s/^$1://p"; }

# Is this token a board rather than a command? A short name, `all`, or
# anything with a `/` in it (a fully-qualified target). Checked by table
# lookup and not by pattern, so a mistyped board name is a clear error
# instead of a mysterious west failure.
is_board_token() {
  case "$1" in
    all) return 0 ;;
    */*) return 0 ;;
  esac
  [ -n "$(board_target "$1")" ]
}

resolve_board() {
  case "$1" in
    */*) printf '%s' "$1" ;;
    *)   local t; t="$(board_target "$1")"
         if [ -z "${t}" ]; then
           echo "error: unknown board '$1'" >&2
           echo "known: $(board_slugs | tr '\n' ' ')all" >&2
           exit 1
         fi
         printf '%s' "${t}" ;;
  esac
}

# One build directory per board. West refuses to reconfigure an existing
# directory for a different board, and sharing one would otherwise mean a
# pristine rebuild every time you switch — or worse, merging a bootloader
# built for one part with an application built for the other. The default
# board keeps the plain `updater/build` path that every note and command in
# this repo already refers to.
set_build_dir() {
  if [ "${BOARD}" = "${DEFAULT_BOARD}" ]; then
    BUILD_DIR="${APP}/build"
  else
    # Underscores, not hyphens: .gitignore already carries `build_*/`, and a
    # build tree that is not ignored turns up in `git status` as hundreds of
    # untracked files the first time anyone builds for a second board.
    BUILD_DIR="${APP}/build_$(printf '%s' "${BOARD}" | tr '/' '_')"
  fi
  BUILD_DIR="${BUILD_DIR_OVERRIDE:-${BUILD_DIR}}"
}

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

run_one() {
  case "${1:-build}" in
    build)
      shift || true
      ensure_esptool
      # `|| return 1` is load-bearing. `set -e` is suspended for everything
      # inside `if ! run_one`, which is how `all` keeps going past one board —
      # so a failed compile falls straight through to merge_hex, which
      # succeeds, restages the *previous* build's artifacts under a fresh
      # manifest entry, and returns 0. The board then reports ok. Seen: the
      # ESP32-S3 failed to link and `./build.sh all` printed "all boards ok".
      # A stale artifact served by a UI insisting it is the newest is the one
      # failure staging exists to prevent.
      west build -b "${BOARD}" "${APP}" --build-dir "${BUILD_DIR}" "$@" || return 1
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
      west build -b "${BOARD}" "${APP}" --build-dir "${BUILD_DIR}" || return 1
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

      # Silabs: a CMSIS-DAP probe like the nRF54L's, and a stock OpenOCD that
      # cannot program the part.
      #
      # The XIAO MG24 carries the same on-board SAMD11 arrangement as the
      # nRF54LM20A — SWD on PA01/PA02, console UART on PA08/PA09 — and Zephyr's
      # board.cmake already wires the openocd runner with a support/openocd.cfg
      # that selects the interface itself, so none of the nRF54L's argument
      # patching is needed here.
      #
      # What IS needed is a different openocd. That config does
      # `source [find target/efm32s2_g23.cfg]`, and **release OpenOCD 0.12.0 does
      # not ship it** — it has only the Series-0/1 `efm32.cfg`, whose flash
      # driver does not know this part. Zephyr's own board documentation says so
      # in as many words: flashing "requires a version of OpenOCD that includes
      # support for the flash on the MG24 MCU", the Arduino/Silabs fork.
      #
      # The failure is at least loud — openocd exits with "Can't find
      # target/efm32s2_g23.cfg" before touching the chip — but the fix is a path,
      # not a flag, so it is found here rather than left to the operator.
      #
      # Searched in order: $OPENOCD if set, then the Arduino Silabs core's copy.
      # A stock openocd is used only as a last resort, with a warning, because
      # "no such file" is a better outcome than a silent half-program.
      if [ "${BOARD#xiao_mg24}" != "${BOARD}" ] && [ "${RUNNER}" = "openocd" ]; then
        MG24_OCD="${OPENOCD:-}"
        if [ -z "${MG24_OCD}" ]; then
          for c in "${HOME}"/Library/Arduino15/packages/SiliconLabs/tools/openocd/*/bin/openocd \
                   "${HOME}"/.arduino15/packages/SiliconLabs/tools/openocd/*/bin/openocd; do
            [ -x "${c}" ] && { MG24_OCD="${c}"; break; }
          done
        fi
        if [ -z "${MG24_OCD}" ]; then
          echo "warning: no Silabs OpenOCD found; falling back to whatever is on PATH." >&2
          echo "         Release OpenOCD has no target/efm32s2_g23.cfg and cannot" >&2
          echo "         program this part. Install the Arduino Silicon Labs core," >&2
          echo "         or set OPENOCD=/path/to/openocd." >&2
          west flash --build-dir "${BUILD_DIR}" --runner openocd --verify "$@"
        else
          MG24_OCD_SEARCH="$(cd "$(dirname "${MG24_OCD}")/../share/openocd/scripts" && pwd)"
          echo "openocd: ${MG24_OCD}"

          # Erase the whole of slot0 before programming it, not just the pages
          # the image lands on.
          #
          # openocd's `auto erase` erases exactly the sectors it is about to
          # write, and our image ends around 0x0805c000 while slot0 runs to
          # 0x080c6000. Everything between is left holding whatever was there
          # before — and **the MCUboot image trailer is the last 16 bytes of the
          # slot**, so a factory image's leftovers land precisely on it.
          #
          # Observed on the first flash of a shop-fresh XIAO MG24:
          #
          #   MCUboot:  I: Primary image: magic=bad, ...
          #   app:      <err> selfconfirm: could not confirm this image (rc=4)
          #             — it will REVERT on the next reset unless confirmed
          #
          # rc=4 is boot_set_next() falling off the end of its
          # `switch (slot_state.magic)`: it handles GOOD and UNSET, and BAD is
          # neither. Nothing actually reverts (with nothing valid in the
          # secondary slot there is nowhere to revert *to*), so it is a false
          # alarm — but it is a false alarm on the one message an operator must
          # be able to trust, and src/selfconfirm.c is this project's whole
          # answer to a bad wireless update.
          #
          # **This board makes it certain rather than likely**, which is why the
          # erase lives here: mg24_partitions.dtsi *moves* slot0 from 0xc000 to
          # 0x10000 to make room for an RSA bootloader, so the new trailer is
          # guaranteed to sit on address space the previous firmware used. Any
          # board whose slot boundaries move inherits the same problem.
          #
          # Erasing rather than padding the image (imgtool --pad --confirmed, via
          # CONFIG_MCUBOOT_GENERATE_CONFIRMED_IMAGE) because a *padded* image is a
          # different artifact from the one merge_hex.py stages and releases, and
          # having the thing you flash over SWD differ from the thing you ship is
          # a worse trade than one extra second here. An erased trailer reads as
          # magic=unset, which boot_set_next() does handle.
          #
          # Slot bounds are read out of the build, never written here — same rule
          # as the Espressif offsets above.
          MG24_SLOT0_OFF=$(sed -n 's/^CONFIG_FLASH_LOAD_OFFSET=\(.*\)/\1/p' \
                            "${BUILD_DIR}/updater/zephyr/.config")
          MG24_SLOT0_BASE=$(sed -n 's/^CONFIG_FLASH_BASE_ADDRESS=\(.*\)/\1/p' \
                             "${BUILD_DIR}/updater/zephyr/.config")
          MG24_SLOT0_SIZE=$(sed -n 's/^CONFIG_FLASH_LOAD_SIZE=\(.*\)/\1/p' \
                             "${BUILD_DIR}/updater/zephyr/.config")
          if [ -n "${MG24_SLOT0_OFF}" ] && [ -n "${MG24_SLOT0_BASE}" ] \
             && [ -n "${MG24_SLOT0_SIZE}" ] && [ "${MG24_SLOT0_SIZE}" != "0" ]; then
            MG24_SLOT0_ADDR=$(printf '0x%x' $(( MG24_SLOT0_BASE + MG24_SLOT0_OFF )))
            echo "erasing slot0: ${MG24_SLOT0_ADDR} + ${MG24_SLOT0_SIZE} bytes"
            "${MG24_OCD}" -s "${MG24_OCD_SEARCH}" \
              -f zephyr/boards/seeed/xiao_mg24/support/openocd.cfg \
              -c "init; reset halt; flash erase_address ${MG24_SLOT0_ADDR} ${MG24_SLOT0_SIZE}; shutdown" \
              >/dev/null 2>&1 || echo "warning: slot0 erase failed; continuing" >&2
          else
            echo "warning: could not read slot0 bounds from the build; skipping" >&2
            echo "         the pre-erase. A stale image trailer may make MCUboot" >&2
            echo "         report 'magic=bad' and selfconfirm fail with rc=4." >&2
          fi

          # --verify for the same reason as the nRF54L: a read-back is the
          # difference between a loud flash-time error and a board that boots
          # into whatever landed in the bytes that did not get written.
          west flash --build-dir "${BUILD_DIR}" --runner openocd \
            --openocd "${MG24_OCD}" --openocd-search "${MG24_OCD_SEARCH}" \
            --verify "$@"
        fi
        exit 0
      fi

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
      # `|| return 1` for the same reason as the `build` case above: a failure
      # here would otherwise stage the previous build's artifacts and report
      # success. This is the path `./build.sh all -p` takes.
      west build -b "${BOARD}" "${APP}" --build-dir "${BUILD_DIR}" "$@" || return 1
      merge_hex
      ;;
  esac
}

# ---- Argument handling -----------------------------------------------------

# `boards` is answered before anything else: it needs no workspace, no board
# and no build directory, and it is the thing to reach for when you have
# forgotten what the short names are.
if [ "${1:-}" = "boards" ]; then
  printf 'known boards (first is the default):\n\n'
  board_slugs | while read -r slug; do
    [ -z "${slug}" ] && continue
    printf '  %-9s %s\n' "${slug}" "$(board_target "${slug}")"
  done
  printf '\n  all       every board above, in that order\n'
  exit 0
fi

# Everything run_one knows how to dispatch on. Listed here so that a first
# argument which is neither a board nor one of these can be *rejected* rather
# than passed through to west — `./build.sh mg42` used to reach
# `west build ... mg42`, which west accepts as a stray source path and warns
# about in the middle of a successful-looking build for the wrong board.
is_command() {
  case "$1" in
    build|merge|bump|flash|menuconfig|guiconfig|clean|boards) return 0 ;;
    -*) return 0 ;;   # west passthrough: -p, -t <target>, ...
  esac
  return 1
}

# An optional leading board token. Anything else is left for run_one, so
# `./build.sh flash` and `./build.sh -p` keep meaning what they always did.
SELECTED=""
if [ $# -gt 0 ]; then
  if is_board_token "$1"; then
    SELECTED="$1"
    shift
  elif ! is_command "$1"; then
    echo "error: '$1' is neither a board nor a command." >&2
    echo "       boards:   $(board_slugs | tr '\n' ' ')all" >&2
    echo "       commands: build merge bump flash menuconfig clean boards" >&2
    exit 1
  fi
fi

if [ "${SELECTED}" = "all" ]; then
  # Flashing five boards over one USB port is not a thing, and neither is
  # `menuconfig` for five configurations. Refuse rather than do the first one
  # and look like it worked.
  case "${1:-build}" in
    flash|menuconfig|guiconfig)
      echo "error: '$1' needs one board, not 'all'." >&2
      echo "       try: ./build.sh <board> $1     (./build.sh boards)" >&2
      exit 1
      ;;
  esac

  # Keep going after a failure and report at the end. One board's toolchain
  # being absent — the Espressif blobs, an Xtensa compiler — is the normal
  # reason a build of everything fails, and it says nothing about the other
  # four. Same reasoning as `fail-fast: false` in build.yml.
  failed=""
  for slug in $(board_slugs); do
    BOARD="$(resolve_board "${slug}")"
    set_build_dir
    printf '\n=== %s (%s) ===\n' "${slug}" "${BOARD}"
    if ! run_one "$@"; then
      failed="${failed} ${slug}"
    fi
  done
  if [ -n "${failed}" ]; then
    printf '\nFAILED:%s\n' "${failed}" >&2
    exit 1
  fi
  printf '\nall boards ok\n'
  exit 0
fi

# BOARD= still works, and an explicit board argument beats it.
BOARD="${SELECTED:+$(resolve_board "${SELECTED}")}"
BOARD="${BOARD:-${BOARD_ENV:-${DEFAULT_BOARD}}}"
set_build_dir
run_one "$@"
