@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 20 or newer is required. Install it from https://nodejs.org/
  pause
  exit /b 1
)
for /f %%V in ('node -p "Number(process.versions.node.split('.')[0])"') do set NODE_MAJOR=%%V
if not defined NODE_MAJOR (
  echo Could not determine Node.js version.
  pause
  exit /b 1
)
if %NODE_MAJOR% LSS 20 (
  echo Node.js 20 or newer is required. Current major version: %NODE_MAJOR%
  pause
  exit /b 1
)
if not exist "robot-server.cjs" (
  echo robot-server.cjs is missing. Extract the ROI local software archive into this folder.
  pause
  exit /b 1
)
if not exist "local\cloud-bridge.cjs" (
  echo local\cloud-bridge.cjs is missing. Extract the ROI local software archive into this folder.
  pause
  exit /b 1
)
if not exist "local\robot-private.json" (
  echo local\robot-private.json is missing. Extract roi-robot-local-config.zip into this folder first.
  pause
  exit /b 1
)
echo Starting ROI Robot Server. Cloud Bridge starts automatically when cloud settings are present.
echo Keep this window open while robots are in use.
node robot-server.cjs "local\robot-private.json" 0.0.0.0 8766
pause
