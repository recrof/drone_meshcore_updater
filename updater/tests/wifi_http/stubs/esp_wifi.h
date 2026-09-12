#pragma once
#include <stdint.h>
typedef int esp_err_t;
#define ESP_OK 0
static inline int esp_wifi_set_max_tx_power(int8_t power) { (void)power; return 0; }
static inline int esp_wifi_get_max_tx_power(int8_t *power) { *power = 20; return 0; }
