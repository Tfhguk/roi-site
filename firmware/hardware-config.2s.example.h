#pragma once
// ILLUSTRATION ONLY. Calibrate all values for the actual robot before enabling motion.
// Original GPIO12 may interfere with ESP32 strapping during startup; verify the driver wiring.
const int MOTOR_PINS[4] = {25,26,27,12};
const int MOTOR_SIGN[2] = {1,1};
const int MOTOR_PWM = 90;
const bool ALLOW_TIMED_MOTION = false; // Set true only after real measurements.
const float METRES_PER_SECOND = 0.0f, DEGREES_PER_SECOND = 0.0f;
// 2S Li-ion example: 100k upper / 47k lower, ADC1 GPIO34; actual wiring required.
const int BATTERY_ADC_PIN = 34;
const float DIVIDER_TOP_OHM = 100000.0f, DIVIDER_BOTTOM_OHM = 47000.0f;
const float BATTERY_MIN_V = 6.6f, BATTERY_MAX_V = 8.5f;
// Wire nFAULT with external 3.3 V pullup if exposed by the DRV8833 carrier.
const int DRIVER_FAULT_PIN = -1;
const int RGB_LAYOUT = 1;
const int RGB_DATA_PIN = 18;
const int RGB_LED_COUNT = 12; // 12 pixels, grouped as 3 logical sections of 4 pixels each.
