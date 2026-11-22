#pragma once
// Missing wiring is not a passed self-test. Replace this adapter only after
// selecting the actual motor driver, encoders, emergency stop and power sensor.
// No movement is enabled by this template.
inline void hardwareStop() {}
inline bool hardwareBegin() { return false; }
// Return 0 for healthy, 5 low voltage, 6 encoder/stall, 7 hardware/emergency stop.
inline int hardwareSelfTest() { return 7; }
// value: metres for forward/backward, degrees for left/right; closed-loop only.
inline bool hardwareStart(const char* kind,float value) { return false; }
// Nonblocking: 0 running, 1 complete, -1 failed. Check encoder progress here.
inline int hardwareTick() { return -1; }
