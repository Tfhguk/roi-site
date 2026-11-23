@echo off
setlocal
cd /d "%~dp0"
if not exist "local\tracker-private.json" (
  echo local\tracker-private.json is missing. Extract roi-robot-local-config.zip into this folder first.
  pause
  exit /b 1
)
if not exist ".venv\Scripts\python.exe" (
  echo Camera-tracker libraries are not installed yet. Starting the installer...
  call "INSTALL-TRACKER-WINDOWS.cmd"
  if errorlevel 1 exit /b 1
)
echo Starting ROI ArUco Tracker. Keep this window open while camera tracking is needed.
echo The tracker needs at least four measured fixed ArUco anchors in local\tracker-private.json.
".venv\Scripts\python.exe" "local\aruco-tracker.py" "local\tracker-private.json"
pause
