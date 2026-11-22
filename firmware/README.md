# ESP32 + local dispatcher + Supabase for roi-site

## Starting point

This folder upgrades the already-existing roi-site project, not a separate web app.
The ESP32 source is an Arduino sketch (NOT a compiled .bin). Arduino-ESP32 3.x,
ArduinoJson 7.x and Adafruit NeoPixel are required.

- Garage: each equipment UUID has an ESP32 download button and a separate control dialog.
- Cloud: authenticated user creates a robot_jobs record in the existing Supabase project.
- Local PC: cloud-bridge.cjs performs authenticated HTTPS GET for queued jobs, then sends them to local robot-server.cjs.
- Robot: ESP32 performs HTTP GET /api/robots/<UUID>/command every ~140ms over trusted Wi-Fi.
- Local server: persists commands.json/state.json/telemetry.json/errors.jsonl separately per UUID.
- ArUco tracker: pushes measured pose into the local server; autonomous movement requires calibrated physical meter coordinates.

GitHub Pages does not execute server-side code. Do not direct ESP32 to https://tfhguk.github.io/roi-site as an API endpoint.

## Electrical connections

DRV8833 AIN1/AIN2=GPIO25/26, BIN1/BIN2=GPIO27/12.
GPIO12 is a strapping pin: make sure the motor carrier does not pull it HIGH at boot.
WS2812B 3 pixels on GPIO18 with a separate 5V supply and common ground.
ADC1 GPIO34 for voltage via a divider; example 100k upper / 47k lower for a calibrated 2S battery.
The ADC input MUST NOT receive raw battery voltage or voltage above its safe range.
The DRV8833 nSLEEP pin must be in a valid enabled state. nFAULT is optional with pullup to 3.3V.

The provided hardware-config.2s.example.h is NOT automatically activated. Hardware calibration
remains mandatory: original hardware-config.h sets ALLOW_TIMED_MOTION=false and zero speeds.
Only after wiring, measuring battery voltage with a multimeter and measuring real motion per PWM
should you set the limits, motor signs, distance/s and angle/s and enable time-based movement.
The local model's linear_m_s and angular_rad_s must reflect the same physical calibration.
Set model.calibrated=true only after these measurements. Until then autonomous motion is rejected.
Without encoders, distance/angle are approximate; ArUco confirms each autonomous segment.

## Installation and cloud link

1. Apply `supabase/robot-cloud-migration.sql` in the EXISTING Supabase project.
2. Use the garage's actual equipment UUID, polygon UUID, and ArUco marker ID in the private JSON examples.
3. Generate a random 32-byte operator token and a separate token per ESP32. Keep them private.
4. Create `local/robot-private.json` from the example. Populate arena polygon measured in METERS.
5. Configure `cloud.url`, public publishableKey, and a regular owner's Supabase refreshToken.
   Never use the service_role or secret key. The bridge refreshes the owner's access token.
6. Run `node robot-server.cjs local/robot-private.json 0.0.0.0 8766` on the local computer.
7. Open the garage, download the personal sketch and use Arduino IDE or arduino-cli to flash.
   Its SERVER_URL must be the computer's LAN IP, not localhost. Its DEVICE_TOKEN must match
   the corresponding device entry in robot-private.json.
8. Wire and calibrate the overhead camera and four known fixed marker positions using
   `local/tracker-private.json`. Then `python local/aruco-tracker.py local/tracker-private.json`.
9. Open the garage's "Управление" dialog. Try STOP and status with motors disconnected first.
10. Only then test 2 cm motion in a lifted-wheel fixture and on a guarded floor.

The refresh token is sensitive. Prefer a separate limited robot operator account that owns the
relevant equipment; never paste the token into public Git files. The local runtime directory,
robot-private.json and tracker-private.json must remain outside version control.

## Endpoints

Device token: GET /api/robots/:uuid/command?boot=X&ready=1&error=0&battery_v=7.5,
POST /api/robots/:uuid/telemetry, POST /api/robots/:uuid/error, POST /api/robots/:uuid/ack.
Operator token: POST /commands, /mission, /manual, /stop, /reset, GET /status.
Tracker token: POST /pose; all coordinates are in meters and heading in radians.
Prior POST /poll remains supported for compatibility.

Possible mission actions are MOVE_TO, STOP and DUMP. DUMP is intentionally REJECTED until
an independent dumper actuator and its hardware adapter are provided. Driving motors are not
silently repurposed as a bucket actuator. Manual control needs explicit operator confirmation.

## Emergency behavior

Unknown/out-of-bounds position, model divergence, ArUco timeout, low or invalid battery voltage,
DRV8833 nFAULT and Wi-Fi outage stop the drive. A server or MCU reboot does not resume an
unfinished command. A fresh inspection and operator reset are needed for latched faults.
No software stop guarantees zero stopping distance. Use a physical power-interrupt E-stop,
protective arena, and real sensors for unattended operation.

LED patterns: green-green-green ready; cyan-cyan-cyan driving; red blinking network;
red-red blinking low voltage; red-yellow timer; red-purple ADC fault;
red-yellow-yellow driver; all-red blinking boundary; alternating reds model;
purple blink ArUco missing; all-red blinking otherwise.

## Development checks

`node --test test_oneshot.cjs`
`npm run build`
`npm run test:firmware`

Tests validate the local protocol and safety state transitions, not a compiled Arduino binary,
camera calibration, physical DRV8833 direction, or real emergency stopping distance.
