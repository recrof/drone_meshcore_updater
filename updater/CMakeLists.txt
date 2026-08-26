cmake_minimum_required(VERSION 3.20.0)

# Boards live under BOARD_ROOT so we can carry a local xiao_nrf54lm20a
# definition until (and after) it ships in the upstream NCS board tree.
list(APPEND BOARD_ROOT ${CMAKE_CURRENT_SOURCE_DIR})

# In-tree Zephyr modules. nordic-legacy-dfu is the C++ Legacy DFU client
# ported from the Android DFU Library; it compiles in only when
# CONFIG_NORDIC_LEGACY_DFU=y.
list(APPEND ZEPHYR_EXTRA_MODULES ${CMAKE_CURRENT_SOURCE_DIR}/modules/nordic-legacy-dfu)

find_package(Zephyr REQUIRED HINTS $ENV{ZEPHYR_BASE})

project(xiao_nrf54_updater LANGUAGES C CXX VERSION 0.1.0)

target_sources(app PRIVATE
  src/main.c
  src/led.c
  src/storage.c
  src/upload_hook.c
  src/fsx_mgmt.c
  src/fsx_stream.c
  src/config.c
  src/ble_scanner.c
  src/firmware_zip.c
  src/firmware_map.c
  src/dfu_client.cpp
  src/dfu_runner.c
)

target_include_directories(app PRIVATE src)
