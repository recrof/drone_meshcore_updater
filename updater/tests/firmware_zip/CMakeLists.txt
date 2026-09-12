cmake_minimum_required(VERSION 3.16)
project(firmware_zip_test LANGUAGES C)
enable_testing()
add_executable(firmware_zip_test firmware_zip_test.c
  ../../src/firmware_zip.c ../../src/firmware_inspect.c)
target_include_directories(firmware_zip_test PRIVATE stubs ../../src)
target_compile_features(firmware_zip_test PRIVATE c_std_11)
if(CMAKE_C_COMPILER_ID MATCHES "GNU|Clang")
  target_compile_options(firmware_zip_test PRIVATE -Wall -Wextra -Werror -UNDEBUG)
elseif(MSVC)
  target_compile_options(firmware_zip_test PRIVATE /W4 /UNDEBUG)
endif()
foreach(case valid cycle wrapped_size payload_bounds header_bounds store_sizes unknown_signature
    truncated_directory compressed streamed long_name entry_limit exact_entry_limit lookup_entry_limit
    manifest_bounds inspection_handle inspection_handle_failure multiple_sections duplicate_section size_overflow
    size_fraction valid_split read_bounds)
  add_test(NAME zip_${case} COMMAND firmware_zip_test ${case})
  set_tests_properties(zip_${case} PROPERTIES TIMEOUT 5)
endforeach()

add_executable(firmware_zip_probe firmware_zip_probe.c ../../src/firmware_zip.c)
target_include_directories(firmware_zip_probe PRIVATE stubs ../../src)
target_compile_features(firmware_zip_probe PRIVATE c_std_11)
if(CMAKE_C_COMPILER_ID MATCHES "GNU|Clang")
  target_compile_options(firmware_zip_probe PRIVATE -Wall -Wextra -Werror)
endif()
