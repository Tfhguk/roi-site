@echo off
setlocal
cd /d "%~dp0"
set "SIM_PY=.lan-tls\mujoco-venv\Scripts\python.exe"
if not exist "%SIM_PY%" (
  py -3 -m venv .lan-tls\mujoco-venv
  if errorlevel 1 goto failed
  "%SIM_PY%" -m pip install -r mujoco_sim\requirements.txt
  if errorlevel 1 goto failed
)
"%SIM_PY%" mujoco_sim\simulate.py %*
if errorlevel 1 goto failed
exit /b 0
:failed
echo Simulation could not start. See the message above.
pause
exit /b 1
