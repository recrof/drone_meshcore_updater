# SPDX-License-Identifier: BSD-3-Clause

if(CONFIG_NORDIC_LEGACY_DFU)
  zephyr_library_named(nordic_legacy_dfu)

  zephyr_library_sources(
    src/legacy_dfu.cpp
    src/gatt_link.cpp
  )

  zephyr_include_directories(include)
  zephyr_library_include_directories(src)
endif()
