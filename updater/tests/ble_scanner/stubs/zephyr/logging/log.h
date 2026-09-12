#pragma once
#define LOG_LEVEL_INF 3
#define LOG_MODULE_REGISTER(...)
static inline void fake_log(const char *format, ...) { (void)format; }
#define LOG_INF(...) fake_log(__VA_ARGS__)
#define LOG_WRN(...) fake_log(__VA_ARGS__)
#define LOG_ERR(...) fake_log(__VA_ARGS__)
