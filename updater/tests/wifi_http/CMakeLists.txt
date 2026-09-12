cmake_minimum_required(VERSION 3.16)
project(wifi_http_test LANGUAGES C)
enable_testing()
set(WIFI_TRANSPORT_SOURCE "${CMAKE_CURRENT_SOURCE_DIR}/../../src/transport_wifi_elegantota.c" CACHE FILEPATH "WiFi transport under test")
add_executable(wifi_http_test wifi_http_test.c ../../src/md5.c)
target_include_directories(wifi_http_test PRIVATE stubs ../firmware_zip/stubs
  ../../modules/nordic-legacy-dfu/test/stubs ../../src)
target_compile_definitions(wifi_http_test PRIVATE CONFIG_WIFI=1
  WIFI_TRANSPORT_SOURCE="${WIFI_TRANSPORT_SOURCE}")
target_compile_features(wifi_http_test PRIVATE c_std_11)
if(CMAKE_C_COMPILER_ID MATCHES "GNU|Clang")
  target_compile_options(wifi_http_test PRIVATE -Wall -Wextra -Werror -UNDEBUG)
endif()
set(cases identity_split identity_status identity_span identity_long identity_oversize
  identity_missing status_split reply_timeout reply_eof reply_error reply_invalid
  reply_long reply_reject upload_short success find_cancel_pending find_cancel_dhcp
  find_assoc_timeout find_identity_fail find_release find_cancel_before)
set(index 0)
foreach(name IN LISTS cases)
  add_test(NAME wifi_http_${name} COMMAND wifi_http_test ${index})
  math(EXPR index "${index} + 1")
endforeach()
