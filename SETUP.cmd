@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Install Node.js 22 or newer from https://nodejs.org/ and run this again.
  pause
  exit /b 1
)
set "PUPPETEER_CACHE_DIR=%~dp0.browser-cache"
echo Installing packages. Setup can take 2-5 minutes if a browser download is needed.
if exist package-lock.json (
  call npm.cmd ci --ignore-scripts --no-fund --no-audit
) else (
  call npm.cmd install --ignore-scripts --no-fund --no-audit
)
if errorlevel 1 (
  echo Setup failed. Check your internet connection and the error above.
  pause
  exit /b 1
)
node src\install-browser.js
if errorlevel 1 (
  echo Browser setup failed. Check the error above and run SETUP.cmd again.
  pause
  exit /b 1
)
echo Setup complete. Open START.cmd to link WhatsApp.
pause
