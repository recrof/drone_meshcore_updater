/* Exercise the actual GATT handlers; only OS, filesystem and radio are stubbed. */
#include <assert.h>
#include <errno.h>
#include <stdio.h>
#include <string.h>
#include "../../src/fsx_stream.c"

static struct bt_conn owner = { 1 }, other = { 2 };
static uint8_t reply[8];
static struct bt_conn *recipient;
static unsigned close_calls, unlink_calls, write_calls, completed;
static int close_result, write_result = -999;
static bool stored;
static void (*before_lock)(void);

void k_mutex_init(struct k_mutex *lock) { lock->locked = false; }
int k_mutex_lock(struct k_mutex *lock, int timeout)
{
	(void)timeout;
	if (before_lock) {
		void (*fn)(void) = before_lock;
		before_lock = NULL;
		fn();
	}
	assert(!lock->locked);
	lock->locked = true;
	return 0;
}
int k_mutex_unlock(struct k_mutex *lock)
{
	assert(lock->locked);
	lock->locked = false;
	return 0;
}
void fs_file_t_init(struct fs_file_t *file) { file->open = false; }
int fs_open(struct fs_file_t *file, const char *path, int flags)
{
	assert(path[0] && flags == (FS_O_CREATE | FS_O_WRITE | FS_O_TRUNC));
	file->open = stored = true;
	return 0;
}
int fs_close(struct fs_file_t *file)
{
	assert(s_sess.lock.locked && file->open);
	file->open = false;
	++close_calls;
	return close_result;
}
int fs_unlink(const char *path)
{
	assert(path[0]);
	++unlink_calls;
	stored = false;
	return 0;
}
ssize_t fs_write(struct fs_file_t *file, const void *buffer, size_t size)
{
	assert(s_sess.lock.locked && file->open && buffer);
	++write_calls;
	return write_result == -999 ? (ssize_t)size : write_result;
}
int bt_gatt_notify(struct bt_conn *conn, const struct bt_gatt_attr *attr,
		   const void *data, uint16_t len)
{
	assert(attr && len <= sizeof(reply));
	memset(reply, 0, sizeof(reply));
	memcpy(reply, data, len);
	recipient = conn;
	return 0;
}
uint16_t bt_gatt_get_mtu(struct bt_conn *conn) { (void)conn; return 247; }
bool firmware_name_acceptable(const char *path, const char **why)
{
	(void)path; (void)why;
	return true;
}
void arm_dfu_from_upload(const char *path) { assert(path[0]); ++completed; }

static void start(uint32_t size)
{
	const char path[] = "/lfs1/test.zip";
	uint8_t frame[2 + sizeof(path) - 1 + 4] = { OP_START, sizeof(path) - 1 };
	memcpy(frame + 2, path, sizeof(path) - 1);
	for (unsigned i = 0; i < 4; ++i) frame[sizeof(frame) - 4 + i] = (uint8_t)(size >> (8 * i));
	assert(on_ctrl_write(&owner, NULL, frame, sizeof(frame), 0, 0) == sizeof(frame));
	assert(reply[0] == OP_READY && reply[1] == RC_OK && s_sess.active);
}
static void control(struct bt_conn *conn, uint8_t op)
{
	assert(on_ctrl_write(conn, NULL, &op, 1, 0, 0) == 1);
}
static void data(struct bt_conn *conn, uint16_t len)
{
	uint8_t bytes[8] = { 0 };
	assert(len <= sizeof(bytes));
	assert(on_data_write(conn, NULL, bytes, len, 0, 0) == len);
}
static void discarded(void)
{
	assert(!s_sess.active && !stored && !completed);
	assert(close_calls == 1 && unlink_calls == 1);
}
static void abort_owner(void) { control(&owner, OP_ABORT); }

int main(int argc, char **argv)
{
	assert(argc == 2);
	assert(fsx_stream_setup() == 0);
	const char *test = argv[1];
	if (!strcmp(test, "complete") || !strcmp(test, "empty")) {
		bool empty = !strcmp(test, "empty");
		start(empty ? 0 : 4);
		if (!empty) data(&owner, 4);
		control(&owner, OP_FINISH);
		assert(reply[0] == OP_DONE && reply[1] == RC_OK);
		assert(reply[2] == (empty ? 0 : 4));
		assert(stored && completed == 1 && close_calls == 1 && unlink_calls == 0);
	} else if (!strcmp(test, "truncated") || !strcmp(test, "close_error")) {
		start(4);
		bool short_file = !strcmp(test, "truncated");
		data(&owner, short_file ? 2 : 4);
		if (!short_file) close_result = -EIO;
		control(&owner, OP_FINISH);
		assert(reply[0] == OP_DONE && reply[1] == RC_WRITE_FAILED);
		discarded();
	} else if (!strcmp(test, "short_write") || !strcmp(test, "write_error") || !strcmp(test, "oversize")) {
		start(4);
		if (!strcmp(test, "short_write")) write_result = 2;
		if (!strcmp(test, "write_error")) write_result = -ENOSPC;
		data(&owner, !strcmp(test, "oversize") ? 5 : 4);
		assert(reply[0] == OP_ERROR && reply[1] == RC_WRITE_FAILED);
		if (!strcmp(test, "oversize")) assert(write_calls == 0);
		discarded();
	} else if (!strncmp(test, "foreign_", 8)) {
		start(4);
		if (!strcmp(test, "foreign_data")) data(&other, 2);
		else control(&other, !strcmp(test, "foreign_finish") ? OP_FINISH : OP_ABORT);
		assert(reply[0] == OP_ERROR && reply[1] == RC_NO_SESSION && recipient == &other);
		assert(s_sess.active && stored && close_calls == 0 && write_calls == 0);
		data(&owner, 4);
		control(&owner, OP_FINISH);
		assert(reply[1] == RC_OK && completed == 1 && unlink_calls == 0);
	} else if (!strcmp(test, "owner_abort") || !strcmp(test, "disconnect")) {
		start(4);
		data(&owner, 2);
		if (!strcmp(test, "disconnect")) {
			on_disconnected(&other, 0);
			assert(s_sess.active);
			on_disconnected(&owner, 0);
		} else abort_owner();
		discarded();
	} else if (!strcmp(test, "stale_data")) {
		start(4);
		/* Close between entry and locking: validation must happen after lock. */
		before_lock = abort_owner;
		data(&owner, 4);
		assert(write_calls == 0 && reply[1] == RC_NO_SESSION);
		discarded();
	} else if (!strcmp(test, "bounds")) {
		start(UINT32_MAX);
		s_sess.written = UINT32_MAX - 1;
		data(&owner, 2);
		assert(write_calls == 0 && reply[1] == RC_WRITE_FAILED);
		discarded();
	} else if (!strcmp(test, "invalid_frame")) {
		uint8_t frame[] = { OP_START, 1, 'x', 1, 0, 0, 0, 99 };
		on_ctrl_write(&owner, NULL, frame, sizeof(frame), 0, 0);
		assert(reply[1] == RC_INVALID && !stored);
		frame[2] = 0;
		on_ctrl_write(&owner, NULL, frame, sizeof(frame) - 1, 0, 0);
		assert(reply[1] == RC_INVALID && !stored);
		start(4);
		assert(on_data_write(&owner, NULL, frame, 1, 1, 0) < 0);
		assert(on_ctrl_write(&owner, NULL, frame, 1, 1, 0) < 0);
		assert(write_calls == 0 && s_sess.active);
		abort_owner();
	} else assert(!"unknown test");
	assert(!s_sess.lock.locked);
	printf("PASS %s\n", test);
	return 0;
}
