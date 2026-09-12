/* Compile the real scanner and inject Stop at each scheduler boundary. */
#include "ble_scanner.h"
#include <zephyr/bluetooth/bluetooth.h>

static bool run_cancelled, radio_active, send_match;
static const char *cancel_at;
static int starts, stops, start_error;
static bt_le_scan_cb_t *scan_cb;
static const bt_addr_le_t peer = { .type = 1, .a = { .val = {42} } };

static bool cancelled(void) { return run_cancelled; }

static int find(struct ble_scanner_target *out)
{
	return ble_scanner_find_first_cancellable(out, 0, NULL, -127, NULL, cancelled);
}

static void stop_run(void)
{
	run_cancelled = true;
	ble_scanner_cancel();
}

void fake_event(const char *event)
{
	if (cancel_at && !strcmp(cancel_at, event)) {
		cancel_at = NULL;
		stop_run();
	}
	if (send_match && !strcmp(event, "wait")) {
		send_match = false;
		uint8_t uuid[] = {0x23, 0xd1, 0xbc, 0xea, 0x5f, 0x78, 0x23, 0x15,
			0xde, 0xef, 0x12, 0x12, 0x30, 0x15, 0x00, 0x00};
		struct bt_data field = {BT_DATA_UUID128_ALL, sizeof(uuid), uuid};
		struct net_buf_simple ad = {&field, 1};
		assert(radio_active && scan_cb);
		scan_cb(&peer, -40, 0, &ad);
	}
}

int bt_le_scan_start(const struct bt_le_scan_param *params, bt_le_scan_cb_t *cb)
{
	ARG_UNUSED(params);
	assert(!radio_active);
	starts++;
	if (start_error) return start_error;
	radio_active = true;
	scan_cb = cb;
	fake_event("start");
	return 0;
}

int bt_le_scan_stop(void)
{
	assert(radio_active);
	radio_active = false;
	stops++;
	fake_event("stop");
	return 0;
}

static void reset_test(void)
{
	assert(!radio_active);
	run_cancelled = false;
	cancel_at = NULL;
	send_match = false;
	start_error = 0;
	starts = stops = 0;
}

int main(int argc, char **argv)
{
	struct ble_scanner_target out;
	ARG_UNUSED(argv);
	if (argc > 1) {
		reset_test();
		cancel_at = "init";
		assert(find(&out) == -ECANCELED);
		assert(cancel_at == NULL && starts == 0);
		puts("PASS: Stop during first semaphore initialization");
		return 0;
	}
	/* First use: Stop before a semaphore has ever existed. */
	reset_test();
	stop_run();
	assert(find(&out) == -ECANCELED);
	assert(starts == 0);

	const char *phases[] = {"reset", "lock", "clear", "start", "wait", "stop"};
	for (size_t i = 0; i < ARRAY_SIZE(phases); i++) {
		reset_test();
		cancel_at = phases[i];
		/* Reach stop through an actual match, then race its result. */
		send_match = !strcmp(phases[i], "stop");
		assert(find(&out) == -ECANCELED);
		assert(cancel_at == NULL);
		assert(starts == stops);
	}

	reset_test();
	stop_run();
	assert(ble_scanner_find_pinned_cancellable(&out, 0, &peer, cancelled) == -ECANCELED);
	assert(ble_scanner_seen_at_cancellable(&peer, 100, &out, cancelled) == -ECANCELED);
	assert(starts == 0);
	/* A survey/standalone query does not inherit a previous run's latch. */
	send_match = true;
	assert(ble_scanner_find_first(&out, 0, NULL, -127, NULL) == 0);
	assert(run_cancelled);
	send_match = true;
	assert(ble_scanner_seen_at(&peer, 100, &out) == 0);
	assert(ble_scanner_survey_start() == 0);
	ble_scanner_survey_stop();

	/* A new run resets the authoritative latch; stale scan-local Stop
	 * must not poison it. Also prove success and timeout still release radio. */
	reset_test();
	send_match = true;
	assert(ble_scanner_find_first(&out, 0, NULL, -127, NULL) == 0);
	assert(bt_addr_le_eq(&out.addr, &peer));
	assert(starts == 1 && stops == 1);
	reset_test();
	assert(ble_scanner_find_first(&out, 10, NULL, -127, NULL) == -ETIMEDOUT);
	assert(starts == 1 && stops == 1);
	reset_test();
	start_error = -EIO;
	assert(ble_scanner_find_first(&out, 10, NULL, -127, NULL) == -EIO);
	assert(starts == 1 && stops == 0);
	start_error = 0;
	assert(ble_scanner_survey_start() == 0);
	ble_scanner_survey_stop();
	puts("PASS: scanner Stop boundaries, fresh run, timeout, match, radio release");
	return 0;
}
