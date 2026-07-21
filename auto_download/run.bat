@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0\.."

set "ERRLOG=%TEMP%\stuff-grabber-install-error.log"
set "PYCMD="

call :find_python
if defined PYCMD goto :launch

call :offer_install
if defined PYCMD goto :launch
goto :end

:launch
echo Using Python: !PYCMD!
echo.
!PYCMD! -m auto_download
if errorlevel 1 (
  echo.
  echo Auto Download exited with an error.
  pause
)
goto :end

:find_python
set "PYCMD="
call :try_cmd py -3
if defined PYCMD goto :eof
call :try_cmd python
if defined PYCMD goto :eof
call :try_cmd python3
if defined PYCMD goto :eof
for /d %%D in ("%LOCALAPPDATA%\Programs\Python\Python3*") do (
  if exist "%%D\python.exe" call :try_exe "%%D\python.exe"
)
goto :eof

:try_cmd
%* -c "import sys;sys.exit(0 if sys.version_info[:2]>=(3,9) else 1)" >nul 2>&1
if !errorlevel! equ 0 set "PYCMD=%*"
goto :eof

:try_exe
"%~1" -c "import sys;sys.exit(0 if sys.version_info[:2]>=(3,9) else 1)" >nul 2>&1
if !errorlevel! equ 0 set PYCMD="%~1"
goto :eof

:offer_install
echo.
echo Python 3.9 or newer was not found on this computer.
echo Stuff Grabber needs Python to run.
echo.

where winget >nul 2>&1
if errorlevel 1 (
  echo winget is not available, so Python cannot be installed automatically.
  call :manual_help "winget was not found on this system."
  goto :eof
)

REM Probe ascending so the last one that exists is the newest available.
REM winget returns a negative code for a missing package, so compare against 0.
set "PYID="
for %%V in (3.12 3.13 3.14 3.15 3.16) do (
  winget show --id Python.Python.%%V -e --source winget --disable-interactivity >nul 2>&1
  if !errorlevel! equ 0 set "PYID=Python.Python.%%V"
)
if not defined PYID set "PYID=Python.Python.3.13"

echo This can install the latest Python for you using winget:
echo.
echo    winget install --id !PYID! -e --silent --accept-source-agreements --accept-package-agreements
echo.
set "ANSWER="
set /p "ANSWER=Install Python now? [y/N] "
if /i not "!ANSWER!"=="y" (
  echo.
  echo Nothing was installed.
  call :manual_help "You chose not to install Python."
  goto :eof
)

echo.
echo Installing !PYID!. Approve the Windows permission prompt if it appears...
echo.
winget install --id !PYID! -e --source winget --silent --accept-source-agreements --accept-package-agreements --disable-interactivity
set "RC=!errorlevel!"
if not "!RC!"=="0" (
  call :manual_help "winget failed to install !PYID!. Exit code: !RC!"
  goto :eof
)

echo.
echo Testing the new Python install...
call :find_python
if not defined PYCMD (
  call :manual_help "Python installed but is not visible yet in this window. Close this window and open a new one."
  goto :eof
)
echo Python test passed: !PYCMD!
echo.
goto :eof

:manual_help
echo.
echo ---------------------------------------------------------------
echo  Python could not be installed automatically.
echo  Reason: %~1
echo.
echo  Install Python yourself:
echo    1. Open https://www.python.org/downloads/windows/
echo    2. Download the latest stable Windows installer (64 bit).
echo    3. Run it and tick "Add python.exe to PATH" on the first screen.
echo    4. Close every terminal, open a new one, then run:
echo         python --version
echo    5. Run this file again.
echo ---------------------------------------------------------------
echo.
> "%ERRLOG%" echo Stuff Grabber install error
>>"%ERRLOG%" echo Reason: %~1
>>"%ERRLOG%" echo.
>>"%ERRLOG%" echo Install Python from https://www.python.org/downloads/windows/
>>"%ERRLOG%" echo Tick "Add python.exe to PATH" during setup, then run auto_download\run.bat again.
echo Error log saved to: %ERRLOG%
echo.
pause
goto :eof

:end
endlocal
