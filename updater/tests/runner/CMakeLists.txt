cmake_minimum_required(VERSION 3.16)
project(dfu_runner_test LANGUAGES C)
enable_testing()
set(DFU_RUNNER_SOURCE "${CMAKE_CURRENT_SOURCE_DIR}/../../src/dfu_runner.c" CACHE FILEPATH "Runner under test")
add_executable(runner_test runner_test.c ${DFU_RUNNER_SOURCE}
  ../../src/transport_ble.c ../../src/pin_addr.c)
target_include_directories(runner_test PRIVATE stubs
  ../../modules/nordic-legacy-dfu/test/stubs ../../src)
target_compile_features(runner_test PRIVATE c_std_11)
if(CMAKE_C_COMPILER_ID MATCHES "GNU|Clang")
  target_compile_options(runner_test PRIVATE -Wall -Wextra -Werror -UNDEBUG)
endif()
set(identity_cases auto_retry buttonless_retry pin_no_drift target_gone wifi_fail_closed exact_restart transport_stays
  restart_budget buttonless_budget config_on_restart thread_reuse one_buttonless max_restart_budget lower_restart_budget)
set(case_index 0)
foreach(case_name IN LISTS identity_cases)
  add_test(NAME runner_${case_name} COMMAND runner_test ${case_index})
  math(EXPR case_index "${case_index} + 1")
endforeach()

add_executable(runner_cleanup_test cleanup_test.c ${DFU_RUNNER_SOURCE})
target_include_directories(runner_cleanup_test PRIVATE stubs
  ../../modules/nordic-legacy-dfu/test/stubs ../../src)
target_compile_features(runner_cleanup_test PRIVATE c_std_11)
if(CMAKE_C_COMPILER_ID MATCHES "GNU|Clang")
  target_compile_options(runner_cleanup_test PRIVATE -Wall -Wextra -Werror -UNDEBUG)
endif()
set(cleanup_cases map_fail open_fail cancel_find success kind_mismatch run_fail
  cancel_run find_fail preopen_fail cancel_refind)
set(case_index 0)
foreach(case_name IN LISTS cleanup_cases)
  add_test(NAME runner_cleanup_${case_name} COMMAND runner_cleanup_test ${case_index})
  math(EXPR case_index "${case_index} + 1")
endforeach()
