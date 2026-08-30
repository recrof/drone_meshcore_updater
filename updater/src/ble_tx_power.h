#pragma once

/*
 * Radio transmit power.
 *
 * config.txt's `ble_tx_power` key existed from the first commit — parsed,
 * range-checked, seeded into the starter file, logged at boot, mirrored in the
 * web client's schema, and covered by a test asserting the default stays on
 * the list of levels the hardware implements. It was never applied to
 * anything. The radio ran at CONFIG_BT_CTLR_TX_PWR_DBM, which is 0 on both
 * boards, for every measurement this project has ever taken.
 *
 * There is no portable Zephyr API for this, which is presumably how it was
 * missed: it is the vendor-specific HCI command 0xFC0E, which the Nordic
 * SoftDevice Controller implements (SDC_HCI_OPCODE_CMD_VS_ZEPHYR_WRITE_TX_POWER)
 * and Zephyr declares as BT_HCI_OP_VS_WRITE_TX_POWER_LEVEL.
 *
 * Power is set per *handle type*, not once for the radio: advertising,
 * scanning and each connection are separate. This device is peripheral and
 * central at the same time, so all three matter — setting only the
 * advertising power would leave the DFU link, the one that actually needs the
 * range, at the default.
 */

#include <stdint.h>
#include <zephyr/bluetooth/conn.h>

#ifdef __cplusplus
extern "C" {
#endif

/* Apply `dbm` to advertising and scanning. Call after bt_enable(). Logs the
 * level the controller actually selected, which is the only way to see the
 * clipping: the hardware implements a fixed ladder of levels and quietly
 * rounds anything else to a neighbour. */
void ble_tx_power_apply_global(int8_t dbm);

/* Apply `dbm` to one connection. A connection's power is not inherited from
 * the advertising or scanning setting. */
void ble_tx_power_apply_conn(struct bt_conn *conn, int8_t dbm);

#ifdef __cplusplus
}
#endif
