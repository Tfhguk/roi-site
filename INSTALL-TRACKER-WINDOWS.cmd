@echo off
setlocal
cd /d "%~dp0"
if not exist "local\requirements-tracker.txt" (
  echo local\requirements-tracker.txt is missing. Extract the ROI local software archive into this folder.
  pause
  exit /b 1
)
where py >nul 2>nul
if errorlevel 1 (
  where python >nul 2>nul
  if errorlevel 1 goto no_python
  python -c "import sys; raise SystemExit(0 if sys.version_info >= (3,11) else 1)"
  if errorlevel 1 goto old_python
  if not exist ".venv\Scripts\python.exe" python -m venv .venv
) else (
  py -3 -c "import sys; raise SystemExit(0 if sys.version_info >= (3,11) else 1)"
  if errorlevel 1 goto old_python
  if not exist ".venv\Scripts\python.exe" py -3 -m venv .venv
)
if errorlevel 1 (
  echo Could not create the Python environment.
  pause
  exit /b 1
)
echo Installing camera-tracker libraries. This may take several minutes.
".venv\Scripts\python.exe" -m pip install --upgrade pip
if errorlevel 1 goto failed
".venv\Scripts\python.exe" -m pip install -r "local\requirements-tracker.txt"
if errorlevel 1 goto failed
echo.
echo Tracker software installed successfully.
pause
exit /b 0
:failed
echo.
echo Installation failed. Check the Python installation and internet connection.
pause
exit /b 1
