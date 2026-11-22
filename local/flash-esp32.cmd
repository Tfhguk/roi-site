@echo off
setlocal
if "%~1"=="" (
  echo Usage: flash-esp32.cmd COM4 [C:\path\to\roi_robot]
  exit /b 2
)
set PORT=%~1
set SKETCH=%~dp0..\roi_robot
if not "%~2"=="" set SKETCH=%~2
where arduino-cli >nul 2>&1
if errorlevel 1 (
  echo Install Arduino CLI and esp32:esp32 core first.
  exit /b 1
)
echo ATTENTION: Fill config.h and hardware-config.h; disconnect wheels for first test.
choice /M "Continue to compile and upload on %PORT%"
if errorlevel 2 exit /b 1
arduino-cli compile --fqbn esp32:esp32:esp32 "%SKETCH%"
if errorlevel 1 exit /b 1
arduino-cli upload --fqbn esp32:esp32:esp32 -p "%PORT%" "%SKETCH%"
