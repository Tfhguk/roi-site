#pragma once
// ESP32 DevKit V1 / DRV8833: AIN1, AIN2, BIN1, BIN2.
const int MOTOR_PINS[4] = {25,26,27,12};
const int MOTOR_SIGN[2] = {1,1}; // -1 reverses the corresponding wheel.
const int MOTOR_PWM = 100; // 8-bit, 0..255. Calibrate at THIS duty.
// No encoder information yet. Explicit opt-in to approximate timed movement.
const bool ALLOW_TIMED_MOTION = false;
const float METRES_PER_SECOND = 0, DEGREES_PER_SECOND = 0;
// Mandatory voltage measurement: ADC1 only while Wi-Fi is active.
const int BATTERY_ADC_PIN = -1;
const float DIVIDER_TOP_OHM = 0, DIVIDER_BOTTOM_OHM = 0;
const float BATTERY_MIN_V = 0, BATTERY_MAX_V = 0;
// Optional DRV8833 nFAULT input, with external pull-up to 3.3 V.
const int DRIVER_FAULT_PIN = -1;
// 0 unconfirmed/off; 1 three WS2812 pixels, one data wire each.
const int RGB_LAYOUT = 0;
const int RGB_PINS[3] = {2,4,19};
