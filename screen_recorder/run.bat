@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0\.."

set "PYCMD="
call :try_cmd pyw -3
if defined PYCMD goto :launch
call :try_cmd pythonw
if defined PYCMD goto :launch
call :try_cmd py -3
if defined PYCMD goto :launch
call :try_cmd python
if defined PYCMD goto :launch

echo Python 3.9 or newer was not found.
echo Install it from https://www.python.org/downloads/windows/ and tick
echo "Add python.exe to PATH" during setup, then run this again.
pause
goto :end

:launch
REM pythonw keeps a console window from sitting behind the floating bar.
start "" !PYCMD! -m screen_recorder
goto :end

:try_cmd
%* -c "import sys;sys.exit(0 if sys.version_info[:2]>=(3,9) else 1)" >nul 2>&1
if !errorlevel! equ 0 set "PYCMD=%*"
goto :eof

:end
endlocal
