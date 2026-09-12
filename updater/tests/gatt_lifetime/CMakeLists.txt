cmake_minimum_required(VERSION 3.16)
project(gatt_lifetime_test LANGUAGES CXX)
enable_testing()
add_executable(gatt_lifetime_test gatt_lifetime_test.cpp
  ../../modules/nordic-legacy-dfu/src/gatt_link.cpp)
target_include_directories(gatt_lifetime_test PRIVATE
  ../../modules/nordic-legacy-dfu/test/stubs ../../modules/nordic-legacy-dfu/src)
target_compile_features(gatt_lifetime_test PRIVATE cxx_std_17)
target_compile_definitions(gatt_lifetime_test PRIVATE
  CONFIG_NORDIC_LEGACY_DFU_LOG_LEVEL=3 CONFIG_NORDIC_LEGACY_DFU_GATT_TIMEOUT_MS=15000
  CONFIG_NORDIC_LEGACY_DFU_MAX_PACKET_SIZE=244 CONFIG_NORDIC_LEGACY_DFU_TX_RETRY_COUNT=10
  CONFIG_NORDIC_LEGACY_DFU_TX_RETRY_DELAY_MS=10)
if(CMAKE_CXX_COMPILER_ID MATCHES "GNU|Clang")
  target_compile_options(gatt_lifetime_test PRIVATE -Wall -Wextra -Werror -UNDEBUG)
elseif(MSVC)
  target_compile_options(gatt_lifetime_test PRIVATE /W4 /UNDEBUG)
endif()
foreach(case timeout_data pending_reuse detached_completion reset_timeout immediate_error
    cancelled_data delayed_error length_bounds ccc_delayed_unsubscribe ccc_disconnect
    ccc_unsubscribe_error ccc_immediate_error ccc_sync_unsubscribe ccc_enable_error
    ccc_enable_timeout ccc_enable_disconnect)
  add_test(NAME gatt_${case} COMMAND gatt_lifetime_test ${case})
  set_tests_properties(gatt_${case} PROPERTIES TIMEOUT 5)
endforeach()
