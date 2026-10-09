@echo off
setlocal
rem ZCode Web launcher for the packaged distribution.
rem Place this file NEXT TO the extracted "zcode" folder, then double-click.

cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Node.js 24+ is required. Install it from https://nodejs.org
    pause
    exit /b 1
)

set "PORT=3030"
if exist "%~dp0port.txt" set /p PORT=<"%~dp0port.txt"

if not exist "%~dp0zcode\bin\zcode.mjs" (
    echo [ERROR] zcode\bin\zcode.mjs not found next to this script.
    echo Expected layout: start-web.bat + zcode\ folder from the tarball.
    pause
    exit /b 1
)

if not exist "%~dp0workspace" mkdir "%~dp0workspace"

echo Starting ZCode Web at http://127.0.0.1:%PORT%/
echo Workspace: %~dp0workspace
echo Keep this window open; press Ctrl+C here to stop.
rem No explicit browser launch here: zcode.mjs opens it once the server
rem is actually ready, avoiding a duplicate tab and a blank first load.
call node "%~dp0zcode\bin\zcode.mjs" --web --workspace "%~dp0workspace" --port %PORT%
pause
