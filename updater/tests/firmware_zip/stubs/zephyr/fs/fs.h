#pragma once
#include <stdint.h>
#include <stddef.h>
#include <sys/types.h>
#define FS_O_READ 1
#define FS_SEEK_SET 0
#define FS_SEEK_END 2
struct fs_file_t { uint32_t position; int open; };
struct fs_dirent { size_t size; };
void fs_file_t_init(struct fs_file_t *file);
int fs_open(struct fs_file_t *file, const char *path, int flags);
int fs_close(struct fs_file_t *file);
int fs_seek(struct fs_file_t *file, off_t offset, int whence);
off_t fs_tell(struct fs_file_t *file);
ssize_t fs_read(struct fs_file_t *file, void *buffer, size_t size);
int fs_stat(const char *path, struct fs_dirent *out);
