#pragma once
#define LOG_MODULE_REGISTER(...)
#define LOG_LEVEL_INF 3
static inline void test_log(const char *fmt, ...) { (void)fmt; }
#define LOG_INF(...) test_log(__VA_ARGS__)
#define LOG_WRN(...) test_log(__VA_ARGS__)
#define LOG_ERR(...) test_log(__VA_ARGS__)
#define LOG_DBG(...) test_log(__VA_ARGS__)
