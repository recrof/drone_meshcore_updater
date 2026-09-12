/* SPDX-License-Identifier: BSD-3-Clause */
#pragma once
#include "nordic_dfu/legacy_dfu.hpp"

namespace nordic::dfu {

/* Nordic Secure DFU (FE59), application images only. The peer must already
 * be in DFU mode. Uses the same connection/Stream/Observer contract as Legacy.
 * Resume is possible only while the receiver retains its update state.
 * Signed init packets are passed through unchanged; the target verifies them.
 * Like LegacyDfuClient, only one run may be active process-wide. */
class SecureDfuClient {
public:
	void set_observer(Observer *observer) { observer_ = observer; }
	Report run(bt_conn *conn, const Firmware &firmware, const Parameters &params);
	void abort();

private:
	Observer *observer_ = nullptr;
};

} // namespace nordic::dfu
