#pragma once
#include <stdbool.h>
#include <stddef.h>
#include <sys/types.h>
#define FS_O_CREATE 1
#define FS_O_WRITE 2
#define FS_O_TRUNC 4
struct fs_file_t { bool open; };
void fs_file_t_init(struct fs_file_t *file);
int fs_open(struct fs_file_t *file, const char *path, int flags);
int fs_close(struct fs_file_t *file);
int fs_unlink(const char *path);
ssize_t fs_write(struct fs_file_t *file, const void *buffer, size_t size);
