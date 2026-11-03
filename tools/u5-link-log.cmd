@echo off
rem Double-click to log a Pixelhue U5 mini's links beside a running LivePremier
rem Plus. u5-link-log.mjs, beside this file, says what it records and why it
rem never connects to the console itself.
rem
rem It runs with the Node that LivePremier Plus installs beside itself, so there
rem is nothing to install; failing that, any node on the PATH. Ctrl-C stops it.
rem Windows then asks "Terminate batch job (Y/N)?": answer N to keep the window
rem open and read the file's name off it. The log is written either way.

setlocal
set "NODE=%LOCALAPPDATA%\LivePremier Plus\node.exe"
if exist "%NODE%" goto run
set "NODE=%ProgramFiles%\LivePremier Plus\node.exe"
if exist "%NODE%" goto run
set "NODE=node"
where node >nul 2>nul
if not errorlevel 1 goto run

echo Could not find LivePremier Plus's own Node, or any other.
echo Install LivePremier Plus, or run u5-link-log.mjs with Node 20 or later.
goto done

:run
"%NODE%" "%~dp0u5-link-log.mjs" %*

:done
echo.
pause
