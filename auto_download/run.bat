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
  echo Auto Download stopped with an error.
  pause
)
goto :end

:find_python
set "PYCMD="
REM Prefer newest official install. Folder names look like Python313.
for %%V in (316 315 314 313 312 311 310 39) do (
  if exist "%LOCALAPPDATA%\Programs\Python\Python%%V\python.exe" (
    call :try_exe "%LOCALAPPDATA%\Programs\Python\Python%%V\python.exe"
    if defined PYCMD goto :eof
  )
)
call :try_cmd py -3
if defined PYCMD goto :eof
call :try_cmd python
if defined PYCMD goto :eof
call :try_cmd python3
if defined PYCMD goto :eof
goto :eof

:try_cmd
%* -c "import sys,tkinter;sys.exit(0 if sys.version_info[:2]>=(3,9) else 1)" >nul 2>&1
if !errorlevel! equ 0 set "PYCMD=%*"
goto :eof

:try_exe
"%~1" -c "import sys,tkinter;sys.exit(0 if sys.version_info[:2]>=(3,9) else 1)" >nul 2>&1
if !errorlevel! equ 0 set PYCMD="%~1"
goto :eof

:offer_install
echo.
echo No usable Python was found.
echo Stuff Grabber needs Python 3.9 or newer with tkinter so the window can open.
echo Some minimal Python installs on PATH do not include that.
echo.

where winget >nul 2>&1
if errorlevel 1 (
  call :manual_help "winget is not available on this PC."
  goto :eof
)

set "PYID="
for %%V in (3.12 3.13 3.14 3.15 3.16) do (
  winget show --id Python.Python.%%V -e --source winget --disable-interactivity >nul 2>&1
  if !errorlevel! equ 0 set "PYID=Python.Python.%%V"
)
if not defined PYID set "PYID=Python.Python.3.13"

echo I can install a full Python for you with winget:
echo.
echo    winget install --id !PYID! -e --silent --accept-source-agreements --accept-package-agreements
echo.
set "ANSWER="
set /p "ANSWER=Install Python now? [y/N] "
if /i not "!ANSWER!"=="y" (
  echo.
  echo Okay, nothing was installed.
  call :manual_help "You chose not to install Python."
  goto :eof
)

echo.
echo Installing !PYID!. Approve the Windows prompt if it appears...
echo.
winget install --id !PYID! -e --source winget --silent --accept-source-agreements --accept-package-agreements --disable-interactivity
set "RC=!errorlevel!"
if not "!RC!"=="0" (
  call :manual_help "winget could not install !PYID!. Exit code: !RC!"
  goto :eof
)

echo.
echo Checking the new Python install...
call :find_python
if not defined PYCMD (
  call :manual_help "Python installed, but this window cannot see it yet. Close this window, open a new one, and run the launcher again."
  goto :eof
)
echo Python looks good: !PYCMD!
echo.
goto :eof

:manual_help
echo.
echo ---------------------------------------------------------------
echo  Could not set up Python automatically.
echo  Reason: %~1
echo.
echo  You can install it yourself:
echo    1. Open https://www.python.org/downloads/windows/
echo    2. Download the latest stable Windows installer (64 bit).
echo    3. On the first screen, turn on "Add python.exe to PATH".
echo    4. Finish setup, close this window, open a new one, then run:
echo         auto_download\run.bat
echo ---------------------------------------------------------------
echo.
> "%ERRLOG%" echo Stuff Grabber install error
>>"%ERRLOG%" echo Reason: %~1
>>"%ERRLOG%" echo.
>>"%ERRLOG%" echo Install Python from https://www.python.org/downloads/windows/
>>"%ERRLOG%" echo Turn on Add python.exe to PATH, then run auto_download\run.bat again.
echo Error log saved to: %ERRLOG%
echo.
pause
goto :eof

:end
endlocal
