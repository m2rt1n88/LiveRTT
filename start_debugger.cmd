@echo off
setlocal
cd /d "%~dp0"
where python >nul 2>&1
if errorlevel 1 (
  echo Python 3.10 or newer is required. Install Python and enable Add to PATH.
  pause
  exit /b 1
)
if exist ".deps\elftools\__init__.py" goto bundled
if not exist ".venv\Scripts\python.exe" (
  python -m venv .venv
  if errorlevel 1 goto failed
)
".venv\Scripts\python.exe" -c "import elftools" >nul 2>&1
if errorlevel 1 (
  ".venv\Scripts\python.exe" -m pip install -r requirements.txt
  if errorlevel 1 goto failed
)
".venv\Scripts\python.exe" -m backend.app %*
if errorlevel 1 goto failed
exit /b 0
:bundled
python -m backend.app %*
if errorlevel 1 goto failed
exit /b 0
:failed
echo.
echo Debugger startup failed. Read the error above. If port 8765 is busy, try:
echo start_debugger.cmd --port 8766
pause
exit /b 1
