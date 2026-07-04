@echo off
REM =====================================================================
REM  CareerBoost Console — local dev launcher
REM  Double-click this file to:
REM    1. Start the auto-rebuilder (rebuilds bundle.min.js on every save)
REM    2. Open the Console in your browser
REM    3. Serve the app at http://localhost:5173 (no-cache: refresh = fresh)
REM
REM  Daily use: keep this window open, work happens, press F5 in the
REM  browser to see changes. Close this window (or Ctrl+C) to stop.
REM
REM  URLs:
REM    http://localhost:5173/#/console            -> the REAL console
REM       (sign in with email+password, then your 6-digit MFA code)
REM    http://localhost:5173/console-harness.html -> instant preview,
REM       sample data, no sign-in (visual checks only)
REM =====================================================================
cd /d "%~dp0"

REM Build watcher in its own window — rebuilds the bundle on every source save.
start "CareerBoost build watcher" cmd /k "cd /d "%~dp0v2" && npm run build:watch"

REM Give the first build a moment, then open the browser.
timeout /t 3 /nobreak >nul
start "" "http://localhost:5173/#/console"

echo.
echo  CareerBoost dev server running at http://localhost:5173
echo  Console:  http://localhost:5173/#/console
echo  Harness:  http://localhost:5173/console-harness.html  (sample data)
echo  Press Ctrl+C (or close this window) to stop.
echo.
python "v2\.claude\nocache-server.py" 5173 v2
