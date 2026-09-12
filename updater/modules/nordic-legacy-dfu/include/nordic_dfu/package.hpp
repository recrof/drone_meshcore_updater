/* SPDX-License-Identifier: BSD-3-Clause */
#pragma once
#include "nordic_dfu/legacy_dfu.hpp"

namespace nordic::dfu {
enum class PackageProtocol { Unknown, Legacy, Secure };

/** Strict format/size preflight, not signature authentication. Unknown,
 * ambiguous and unsupported init layouts fail closed. No target I/O. */
PackageProtocol package_protocol(const Firmware &firmware);
}
