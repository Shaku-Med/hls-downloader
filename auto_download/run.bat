@echo off
setlocal
cd /d "%~dp0\.."
python -m auto_download
if errorlevel 1 (
  echo.
  echo If that failed, try:  py -3 -m auto_download
  pause
)
