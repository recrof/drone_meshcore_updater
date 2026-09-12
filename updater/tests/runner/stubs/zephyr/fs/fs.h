#pragma once
#include <stddef.h>
struct fs_file_t { int unused; };
struct fs_dirent { size_t size; };
int fs_stat(const char *path, struct fs_dirent *out);
