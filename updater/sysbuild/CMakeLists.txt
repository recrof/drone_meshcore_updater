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

find_package(Sysbuild REQUIRED HINTS $ENV{ZEPHYR_BASE})
project(sysbuild LANGUAGES)
