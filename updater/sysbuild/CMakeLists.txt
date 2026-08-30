#
# Sysbuild entry point.
#
# `west build` in NCS defaults to sysbuild — needed so MCUboot and this
# application get configured, signed, and packaged as a single build.
# Sysbuild resolves BOARD (and therefore expects to find our vendored
# xiao_nrf54lm20a board files under BOARD_ROOT) BEFORE it delegates to
# the application's own CMakeLists.txt — so if we only extend BOARD_ROOT
# there, it's too late and we get "No board named 'xiao_nrf54lm20a'".
#
# The fix is this file: if `<APP_DIR>/sysbuild/CMakeLists.txt` exists,
# sysbuild uses it as its entry point instead of Zephyr's default
# `share/sysbuild/CMakeLists.txt`. We take the chance to inject
# BOARD_ROOT *before* find_package(Sysbuild), then hand off to the
# default behaviour via the `find_package` call — everything downstream
# (mcuboot, app image, DFU packaging) continues as normal.
#
# Pattern borrowed from https://github.com/liquidraver/zephcore.

cmake_minimum_required(VERSION 3.20.0)

# APP_DIR points at the actual application source (i.e. this repo's
# updater/ folder). Force-inject into cache so downstream Zephyr /
# module discovery sees it during its very first board sweep.
set(BOARD_ROOT "${APP_DIR}" CACHE STRING "" FORCE)

# MCUboot's partition table is per board — RRAM slots on the nRF54L, a
# chainloaded bootloader inside the UF2 application region on the nRF52840 —
# but sysbuild only ever looks for ONE file name per image
# (sysbuild/<image>.overlay, sysbuild_extensions.cmake). So the selection
# happens here, before find_package() adds the mcuboot image and runs its
# `if(NOT mcuboot_DTC_OVERLAY_FILE)` lookup.
#
# The hard error matters. Without an overlay MCUboot inherits the board's own
# `zephyr,code-partition` and links wherever that points — on top of slot0 on
# the nRF54L, on top of the UF2 bootloader here. Both images still build
# cleanly; the only thing that noticed last time was merge_hex.py's overlap
# check, and only because the merge happens to be part of the build. A new
# board must not be able to reach that state by omission.
string(REGEX REPLACE "/.*" "" APP_BOARD_NAME "${BOARD}")
set(APP_MCUBOOT_OVERLAY "${CMAKE_CURRENT_LIST_DIR}/mcuboot_${APP_BOARD_NAME}.overlay")
if(NOT EXISTS "${APP_MCUBOOT_OVERLAY}")
  message(FATAL_ERROR
    "No MCUboot devicetree overlay for board '${APP_BOARD_NAME}'.\n"
    "Expected ${APP_MCUBOOT_OVERLAY}. Porting to a new board means telling "
    "the bootloader image where its slots are and where it links; without "
    "that it silently links over something else."
  )
endif()
set(mcuboot_DTC_OVERLAY_FILE "${APP_MCUBOOT_OVERLAY}" CACHE INTERNAL
    "MCUboot partition geometry, selected per board")

# Optional companion Kconfig fragment, same per-board naming. Unlike the
# overlay this one is genuinely optional: a board only needs it when the
# bootloader's environment differs from the application's. On xiao_ble it does
# — the console is a USB CDC port that only exists once the application has
# brought up the USB stack, so MCUboot has no console at all and must not be
# built expecting one.
set(APP_MCUBOOT_CONF "${CMAKE_CURRENT_LIST_DIR}/mcuboot_${APP_BOARD_NAME}.conf")
if(EXISTS "${APP_MCUBOOT_CONF}")
  set(mcuboot_EXTRA_CONF_FILE "${APP_MCUBOOT_CONF}" CACHE INTERNAL
      "MCUboot Kconfig fragment, selected per board")
endif()

# Optional per-board *sysbuild* Kconfig, same naming again.
#
# Distinct from mcuboot_<board>.conf above: that one configures the MCUboot
# image, this one configures sysbuild itself, and some decisions are only
# expressible at the sysbuild level. Image signing is the one that forced this
# to exist — SB_CONFIG_BOOT_SIGNATURE_TYPE_* is written into every image's
# forced .config.sysbuild, which is merged last, so an image-level fragment
# cannot override it.
#
# Merged *after* sysbuild.conf (EXTRA_CONF_FILE is appended to CONF_FILE in
# sysbuild_kconfig.cmake), so a board fragment overrides the repo-wide default
# rather than fighting it.
set(APP_SB_CONF "${CMAKE_CURRENT_LIST_DIR}/sysbuild_${APP_BOARD_NAME}.conf")
if(EXISTS "${APP_SB_CONF}")
  set(SB_EXTRA_CONF_FILE "${APP_SB_CONF}" CACHE INTERNAL
      "Sysbuild Kconfig fragment, selected per board")
endif()

find_package(Sysbuild REQUIRED HINTS $ENV{ZEPHYR_BASE})
project(sysbuild LANGUAGES)
