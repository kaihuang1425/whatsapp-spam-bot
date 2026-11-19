@echo off
setlocal
cd /d "%~dp0"
if not exist node_modules\whatsapp-web.js\package.json (
  echo Open SETUP.cmd first, then run this again.
  pause
  exit /b 1
)
node src\cli.js setup
pause
